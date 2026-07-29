import path from "node:path";
import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import sharp from "sharp";
import { monoErrorResponse, MonoHttpError } from "@/lib/mono/http";
import { productPipelineStagingRoot, resolveDetailPageFolder, resolveProductFolder } from "@/lib/mono/product-pipeline";
import { productPipelineTrialContext, trialProductPipelineJob, withProductPipelineTrialCookie } from "@/lib/try/product-pipeline-trial";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; slot: string }> };
const MAX_THUMBNAIL_WIDTH = 2000;

export async function GET(request: Request, context: Context) {
  try {
    const trial = productPipelineTrialContext(request);
    const { id, slot } = await context.params;
    if (!/^\d{2}$/u.test(slot)) throw new MonoHttpError(404, "成品图不存在");
    const job = trialProductPipelineJob(trial.actor, id);
    if (!job) throw new MonoHttpError(404, "任务不存在或已无权访问");

    const folder = resolveProductFolder(String(job.input.folderId ?? ""));
    const imagesDir = path.resolve(resolveDetailPageFolder(folder.relativePath), "images");
    const fileName = `${path.basename(folder.absolutePath)}_${slot}.jpg`;
    const target = path.resolve(imagesDir, fileName);
    if (path.dirname(target) !== imagesDir) throw new MonoHttpError(404, "成品图不存在");

    const stagingDir = path.resolve(productPipelineStagingRoot(job.id), "images");
    const original = await readFile(target)
      .catch(() => readFile(path.resolve(stagingDir, fileName)))
      .catch((): never => { throw new MonoHttpError(404, "成品图不存在"); });
    const requestedWidth = Number(new URL(request.url).searchParams.get("w"));
    const body: BodyInit = Number.isFinite(requestedWidth) && requestedWidth > 0
      ? Buffer.from(await sharp(original).resize({ width: Math.min(Math.round(requestedWidth), MAX_THUMBNAIL_WIDTH) }).jpeg({ quality: 85 }).toBuffer())
      : original;
    const response = new NextResponse(body, {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "private, no-store",
        "x-robots-tag": "noindex, nofollow, noarchive",
      },
    });
    return withProductPipelineTrialCookie(response, trial.cookieValue);
  } catch (error) {
    return monoErrorResponse(error);
  }
}
