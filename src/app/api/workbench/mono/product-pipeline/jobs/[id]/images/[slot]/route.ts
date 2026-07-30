import path from "node:path";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { actorFromWorkbenchRequest, MonoHttpError, monoErrorResponse } from "@/lib/mono/http";
import { getJob } from "@/lib/mono/service";
import { getMonoAsset } from "@/lib/mono/store";
import { readObjectBuffer } from "@/lib/storage";
import { productPipelineStagingRoot, resolveDetailPageFolder, resolveProductFolder } from "@/lib/mono/product-pipeline";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; slot: string }> };

/** Caps `?w=` so a crafted request can't force an oversized resize on the server. */
const MAX_THUMBNAIL_WIDTH = 2000;

export async function GET(request: Request, context: Context) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    const { id, slot } = await context.params;
    if (!/^\d{2}$/u.test(slot)) throw new MonoHttpError(404, "成品图不存在");
    const job = getJob(actor, id);
    if (!job || job.kind !== "product_pipeline") throw new MonoHttpError(404, "任务不存在或无权访问");
    const deliverables = (job.result as {
      deliverables?: Array<{ assetId: string; role: string; slotKey: string }>;
    } | null)?.deliverables ?? [];
    const deliverable = deliverables.find((item) => item.role === "product-detail" && item.slotKey === slot);
    if (deliverable) {
      const asset = getMonoAsset(actor, deliverable.assetId);
      if (asset?.storageKey) {
        return imageResponse(await readObjectBuffer(asset.storageKey), request, asset.mimeType ?? "image/jpeg");
      }
    }
    const folder = resolveProductFolder(String(job.input.folderId ?? ""));
    const imagesDir = path.resolve(resolveDetailPageFolder(folder.relativePath), "images");
    const baseName = path.basename(folder.absolutePath);
    const fileName = `${baseName}_${slot}.jpg`;
    const target = path.resolve(imagesDir, fileName);
    if (path.dirname(target) !== imagesDir) throw new MonoHttpError(404, "成品图不存在");

    // Published first, then this run's staging directory. A run publishes once,
    // atomically, at the very end — so between "slot 04 finished" and "job
    // finished" there are minutes in which the image exists, is already paid
    // for, and is nowhere the progress board can see it. Reading staging as a
    // fallback is what lets finished slots appear while the run continues.
    // Built from the stored `job.id`, not the `id` route parameter: `slot` is
    // already constrained to two digits, but the job id would otherwise be an
    // unvalidated caller-supplied segment inside a filesystem path.
    const stagingDir = path.resolve(productPipelineStagingRoot(job.id), "images");
    // A slot can legitimately have no file in either place: still generating,
    // failed this run, or skipped by an `onlySlots` retry. That is normal
    // state, not a server error.
    const original = await readFile(target)
      .catch(() => readFile(path.resolve(stagingDir, fileName)))
      .catch((): never => { throw new MonoHttpError(404, "成品图不存在"); });

    return imageResponse(original, request, "image/jpeg");
  } catch (error) { return monoErrorResponse(error); }
}

async function imageResponse(original: Buffer, request: Request, mimeType: string): Promise<Response> {
  const requestedWidth = Number(new URL(request.url).searchParams.get("w"));
  const body = Number.isFinite(requestedWidth) && requestedWidth > 0
    ? await sharp(original).resize({ width: Math.min(Math.round(requestedWidth), MAX_THUMBNAIL_WIDTH) }).jpeg({ quality: 85 }).toBuffer()
    : original;
  return new Response(new Uint8Array(body), {
    headers: { "content-type": requestedWidth > 0 ? "image/jpeg" : mimeType, "cache-control": "private, no-store" },
  });
}
