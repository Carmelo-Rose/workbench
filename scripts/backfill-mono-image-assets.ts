/**
 * Recover legacy Image2 result URLs into durable object storage.
 *
 * This is intentionally separate from startup migrations: it performs network
 * I/O, never calls the paid generation endpoint, and is safe to run again.
 */
import sharp from "sharp";
import { saveObjectBuffer } from "../src/lib/storage";
import { getDb } from "../src/lib/server/db";
import { createMonoAsset, linkMonoJobAsset } from "../src/lib/mono/store";

type JobRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  trace_id: string;
  result_json: string | null;
};

type LegacySlot = {
  index: number;
  status: string;
  assetId?: string;
  imageUrl?: string;
  error?: string;
  persistenceUnavailable?: boolean;
};

async function main(): Promise<void> {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, workspace_id, user_id, trace_id, result_json
     FROM mono_jobs
     WHERE kind = 'image_generation' AND result_json IS NOT NULL
     ORDER BY created_at ASC`,
  ).all() as JobRow[];
  let recovered = 0;
  let expired = 0;

  for (const row of rows) {
    const result = JSON.parse(row.result_json ?? "{}") as Record<string, unknown> & { slots?: LegacySlot[] };
    if (!Array.isArray(result.slots)) continue;
    let changed = false;
    const actor = {
      userId: row.user_id,
      workspaceId: row.workspace_id,
      traceId: row.trace_id,
    };

    for (const slot of result.slots) {
      if (slot.status !== "succeeded" || slot.assetId || slot.persistenceUnavailable) continue;
      const existing = db.prepare(
        `SELECT asset_id FROM mono_job_assets
         WHERE job_id = ? AND role = 'image-generation' AND slot_key = ?`,
      ).get(row.id, String(slot.index)) as { asset_id: string } | undefined;
      if (existing) {
        slot.assetId = existing.asset_id;
        delete slot.imageUrl;
        changed = true;
        continue;
      }
      if (!slot.imageUrl) continue;
      try {
        const response = await fetch(slot.imageUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        const metadata = await sharp(buffer).metadata();
        if (!metadata.width || !metadata.height) throw new Error("invalid image");
        const mimeType = response.headers.get("content-type")?.split(";")[0] || "image/png";
        const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1] || "png";
        const filename = `image2-${row.id}-${slot.index + 1}.${extension}`;
        const stored = await saveObjectBuffer(buffer, filename);
        const asset = createMonoAsset(actor, {
          sourceUrl: `storage:${stored.key}`,
          storageKey: stored.key,
          location: "local-storage",
          mimeType,
          name: filename,
        });
        linkMonoJobAsset(actor, row.id, asset.id, "image-generation", String(slot.index));
        slot.assetId = asset.id;
        delete slot.imageUrl;
        delete slot.error;
        recovered += 1;
        changed = true;
      } catch {
        slot.error = "历史图片已失效";
        slot.persistenceUnavailable = true;
        expired += 1;
        changed = true;
      }
    }
    if (changed) {
      db.prepare("UPDATE mono_jobs SET result_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(result), Date.now(), row.id);
    }
  }

  console.log(JSON.stringify({ scannedJobs: rows.length, recovered, expired }));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
