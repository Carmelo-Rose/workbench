import path from "node:path";
import { actorFromWorkbenchRequest, MonoHttpError, monoErrorResponse } from "@/lib/mono/http";
import { getJob } from "@/lib/mono/service";
import {
  DETAIL_SLOT_IDS,
  resolveProductFolder,
  resolveProductPipelineSlotImage,
} from "@/lib/mono/product-pipeline";
import { buildZip, type ZipEntry } from "@/lib/zip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/**
 * Bundles every produced slot into one zip. The per-slot route's bare
 * filenames ("01", no Content-Disposition) meant "下载全部" fired eleven
 * anonymous downloads back to back — the browser blocks that as a multi-
 * download prompt after the first couple, and whatever got through landed
 * with no extension and colliding names across products. One archive with
 * real filenames sidesteps both.
 */
export async function GET(request: Request, context: Context) {
  try {
    const actor = actorFromWorkbenchRequest(request, "image.product-set.use");
    const { id } = await context.params;
    const job = getJob(actor, id);
    if (!job || job.kind !== "product_pipeline") throw new MonoHttpError(404, "任务不存在或无权访问");

    const folder = resolveProductFolder(String(job.input.folderId ?? ""));
    const baseName = path.basename(folder.absolutePath);

    const entries: ZipEntry[] = [];
    for (const slot of DETAIL_SLOT_IDS) {
      const data = await resolveProductPipelineSlotImage(actor, job, slot);
      if (data) entries.push({ name: `${baseName}_${slot}.jpg`, data });
    }
    if (!entries.length) throw new MonoHttpError(404, "还没有可下载的成品图");

    const zip = buildZip(entries);
    const encodedName = encodeURIComponent(`${baseName}.zip`);
    return new Response(new Uint8Array(zip), {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="download.zip"; filename*=UTF-8''${encodedName}`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) { return monoErrorResponse(error); }
}
