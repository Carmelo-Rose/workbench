import { actorFromWorkbenchRequest, MonoHttpError, monoErrorResponse } from "@/lib/mono/http";
import { getJob } from "@/lib/mono/service";
import { monoImageGenerationResultSchema } from "@/lib/mono/contracts";
import { getMonoAsset } from "@/lib/mono/store";
import { openObjectStream, statObject } from "@/lib/storage";
import sharp from "sharp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; index: string }> };

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const MAX_THUMBNAIL_WIDTH = 640;

/**
 * 生成结果图存放在图片服务的域上，浏览器对跨域地址会忽略 <a download>，
 * 点「下载」只会新开标签页。这里按 jobId + slot 取回已存下来的地址再转发，
 * 既能强制 attachment，也不会变成任意 URL 的开放代理。
 */
export async function GET(request: Request, context: Context) {
  try {
    const actor = actorFromWorkbenchRequest(request, "resources.tasks.export");
    const { id, index } = await context.params;
    const job = getJob(actor, id);
    if (!job) throw new MonoHttpError(404, "任务不存在或已无权访问");

    const result = monoImageGenerationResultSchema.safeParse(job.result);
    const slot = result.success
      ? result.data.slots.find((item) => item.index === Number(index))
      : undefined;
    if (slot?.assetId) {
      const asset = getMonoAsset(actor, slot.assetId);
      if (!asset?.storageKey) throw new MonoHttpError(404, "这张图片的持久化文件不存在");
      const info = await statObject(asset.storageKey);
      if (!info) throw new MonoHttpError(404, "这张图片的持久化文件已丢失");
      const source = openObjectStream(asset.storageKey);
      const requestedWidth = thumbnailWidth(request);
      if (requestedWidth) {
        return thumbnailResponse(await streamToBuffer(source), requestedWidth);
      }
      return attachment(
        Readable.toWeb(source) as ReadableStream,
        asset.mimeType ?? "image/png",
        id,
        slot.index,
      );
    }
    const imageUrl = slot?.imageUrl;
    if (!imageUrl) throw new MonoHttpError(404, "这张图还没有生成结果");

    const dataUrl = imageUrl.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/u);
    if (dataUrl) {
      const body = dataUrl[2]
        ? Buffer.from(dataUrl[3], "base64")
        : Buffer.from(decodeURIComponent(dataUrl[3]), "utf8");
      const requestedWidth = thumbnailWidth(request);
      if (requestedWidth) return thumbnailResponse(body, requestedWidth);
      return attachment(body, dataUrl[1] || "image/png", id, slot!.index);
    }
    if (!/^https?:\/\//iu.test(imageUrl)) throw new MonoHttpError(400, "图片地址格式无效");

    const upstream = await fetch(imageUrl);
    const requestedWidth = thumbnailWidth(request);
    if (upstream.ok && upstream.body && requestedWidth) {
      return thumbnailResponse(Buffer.from(await upstream.arrayBuffer()), requestedWidth);
    }
    if (!upstream.ok || !upstream.body) throw new MonoHttpError(502, "图片下载失败，请稍后重试");
    return attachment(
      upstream.body,
      upstream.headers.get("content-type") ?? "image/png",
      id,
      slot!.index,
    );
  } catch (error) {
    return monoErrorResponse(error);
  }
}

function thumbnailWidth(request: Request): number | undefined {
  const value = Number(new URL(request.url).searchParams.get("w"));
  return Number.isFinite(value) && value > 0
    ? Math.min(Math.round(value), MAX_THUMBNAIL_WIDTH)
    : undefined;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function thumbnailResponse(body: Buffer, width: number): Promise<Response> {
  const thumbnail = await sharp(body).resize({ width }).webp({ quality: 82 }).toBuffer();
  return new Response(new Uint8Array(thumbnail), {
    headers: {
      "Content-Type": "image/webp",
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=300",
    },
  });
}

function attachment(body: BodyInit, contentType: string, jobId: string, index: number): Response {
  const extension = EXTENSIONS[contentType.split(";")[0].trim().toLowerCase()] ?? "png";
  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="mono-image2-${jobId}-${index + 1}.${extension}"`,
      "Cache-Control": "private, max-age=300",
    },
  });
}
import { Readable } from "node:stream";
