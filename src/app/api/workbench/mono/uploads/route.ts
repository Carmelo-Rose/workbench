import { actorFromWorkbenchRequest, MonoHttpError, monoErrorResponse } from "@/lib/mono/http";
import { createStoredAsset } from "@/lib/mono/service";
import { saveObjectStream, uploadMaxBytes } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 大文件直传：请求体即文件流（application/octet-stream 或真实 MIME），
 * 文件名放在 x-workbench-filename（encodeURIComponent 编码）。
 * 不走 JSON/data URL，视频等大素材流式落盘。
 */
export async function POST(request: Request) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    if (!request.body) throw new MonoHttpError(400, "请求体为空，请直接以文件流作为 body 上传");
    const encodedName = request.headers.get("x-workbench-filename");
    const name = encodedName ? decodeURIComponent(encodedName) : undefined;
    const mimeType = request.headers.get("content-type") ?? "application/octet-stream";
    const stored = await saveObjectStream(request.body, {
      nameHint: name ?? mimeType,
      maxBytes: uploadMaxBytes(),
    });
    const asset = createStoredAsset(actor, { storageKey: stored.key, mimeType, name });
    return Response.json({ asset, size: stored.size }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && /超过上限/.test(error.message)) {
      return Response.json({ error: error.message }, { status: 413 });
    }
    return monoErrorResponse(error);
  }
}
