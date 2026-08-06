import sharp from "sharp";
import { actorFromWorkbenchRequest, MonoHttpError, monoErrorResponse } from "@/lib/mono/http";
import { getJob } from "@/lib/mono/service";
import { resolveProductPipelineSlotImage } from "@/lib/mono/product-pipeline";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; slot: string }> };

/** Caps `?w=` so a crafted request can't force an oversized resize on the server. */
const MAX_THUMBNAIL_WIDTH = 2000;

export async function GET(request: Request, context: Context) {
  try {
    const actor = actorFromWorkbenchRequest(request, "image.product-set.use");
    const { id, slot } = await context.params;
    if (!/^\d{2}$/u.test(slot)) throw new MonoHttpError(404, "成品图不存在");
    const job = getJob(actor, id);
    if (!job || job.kind !== "product_pipeline") throw new MonoHttpError(404, "任务不存在或无权访问");

    // A slot can legitimately have no file yet: still generating, failed this
    // run, or skipped by an `onlySlots` retry. That is normal state, not a
    // server error.
    const original = await resolveProductPipelineSlotImage(actor, job, slot);
    if (!original) throw new MonoHttpError(404, "成品图不存在");

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
