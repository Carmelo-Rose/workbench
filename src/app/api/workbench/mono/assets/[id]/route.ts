import { actorFromWorkbenchRequest, MonoHttpError, monoErrorResponse } from "@/lib/mono/http";
import { deleteAssetIfUnreferenced } from "@/lib/mono/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Cleanup endpoint for uploads that never became a job input. */
export async function DELETE(request: Request, context: Context) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    const { id } = await context.params;
    if (!await deleteAssetIfUnreferenced(actor, id)) {
      throw new MonoHttpError(409, "素材仍被任务或主体引用，不能删除");
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
