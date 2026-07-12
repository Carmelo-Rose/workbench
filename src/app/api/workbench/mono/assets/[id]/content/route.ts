import { actorFromWorkbenchRequest, MonoHttpError, monoErrorResponse } from "@/lib/mono/http";
import { getMonoAsset } from "@/lib/mono/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    const { id } = await context.params;
    const asset = getMonoAsset(actor, id);
    if (!asset) throw new MonoHttpError(404, "素材不存在或已无权访问");
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
