import { Readable } from "node:stream";
import { actorFromWorkbenchRequest, MonoHttpError, monoErrorResponse } from "@/lib/mono/http";
import { getMonoAsset } from "@/lib/mono/store";
import { openObjectStream, statObject } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const permission = new URL(request.url).searchParams.get("download") === "1"
      ? "resources.assets.export"
      : "resources.assets.view";
    const actor = actorFromWorkbenchRequest(request, permission);
    const { id } = await context.params;
    const asset = getMonoAsset(actor, id);
    if (!asset) throw new MonoHttpError(404, "素材不存在或已无权访问");
    if (asset.storageKey) return storedContentResponse(request, asset.storageKey, asset.mimeType);
    if (/^https?:\/\//iu.test(asset.sourceUrl)) return Response.redirect(asset.sourceUrl, 302);
    const match = asset.sourceUrl.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/u);
    if (!match) throw new MonoHttpError(400, "素材内容格式无效");
    const body = match[2]
      ? Buffer.from(match[3], "base64")
      : Buffer.from(decodeURIComponent(match[3]), "utf8");
    return new Response(body, {
      headers: {
        "Content-Type": match[1] || asset.mimeType || "application/octet-stream",
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (error) {
    return monoErrorResponse(error);
  }
}

/** 存储素材走流式读取，支持 Range 以便浏览器直接拖动播放视频。 */
async function storedContentResponse(
  request: Request,
  storageKey: string,
  mimeType: string | undefined,
): Promise<Response> {
  const info = await statObject(storageKey);
  if (!info) throw new MonoHttpError(404, "素材文件不存在或已被清理");

  const baseHeaders = {
    "Content-Type": mimeType ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=300",
  };

  const range = request.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/u);
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(info.size - Number(range[2]), 0);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (!Number.isFinite(start) || start > end || start >= info.size) {
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, "Content-Range": `bytes */${info.size}` },
      });
    }
    return new Response(Readable.toWeb(openObjectStream(storageKey, { start, end })) as ReadableStream, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${info.size}`,
      },
    });
  }

  return new Response(Readable.toWeb(openObjectStream(storageKey)) as ReadableStream, {
    headers: { ...baseHeaders, "Content-Length": String(info.size) },
  });
}
