import path from "node:path";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { actorFromWorkbenchRequest, MonoHttpError, monoErrorResponse } from "@/lib/mono/http";
import { getJob } from "@/lib/mono/service";
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

    const requestedWidth = Number(new URL(request.url).searchParams.get("w"));
    const body: BodyInit = Number.isFinite(requestedWidth) && requestedWidth > 0
      ? Buffer.from(await sharp(original).resize({ width: Math.min(Math.round(requestedWidth), MAX_THUMBNAIL_WIDTH) }).jpeg({ quality: 85 }).toBuffer())
      : original;
    return new Response(body, { headers: { "content-type": "image/jpeg", "cache-control": "private, no-store" } });
  } catch (error) { return monoErrorResponse(error); }
}
