import { actorFromWorkbenchRequest, MonoHttpError, monoErrorResponse } from "@/lib/mono/http";
import { deleteAssetIfUnreferenced } from "@/lib/mono/service";
import { getMonoAsset } from "@/lib/mono/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Cleanup endpoint for uploads that never became a job input. */
export async function DELETE(request: Request, context: Context) {
  try {
    const actor = actorFromWorkbenchRequest(request, "resources.assets.manage");
    const { id } = await context.params;
    if (!getMonoAsset(actor, id)) throw new MonoHttpError(404, "素材不存在或无权访问");
    if (!await deleteAssetIfUnreferenced(actor, id)) {
      throw new MonoHttpError(409, "素材仍被任务或主体引用，不能删除");
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
