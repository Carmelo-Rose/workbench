import { monoSubjectPatchSchema } from "@/lib/mono/contracts";
import { actorFromRequest, assertMonoApiAccess, MonoHttpError, monoErrorResponse, parseMonoJson } from "@/lib/mono/http";
import { deleteSubject, getSubject, updateSubject } from "@/lib/mono/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  try {
    assertMonoApiAccess(request);
    const subject = getSubject(actorFromRequest(request), (await context.params).id);
    if (!subject) throw new MonoHttpError(404, "主体不存在或已无权访问");
    return Response.json({ subject });
  } catch (error) {
    return monoErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    assertMonoApiAccess(request);
    const actor = actorFromRequest(request);
    const patch = await parseMonoJson(request, monoSubjectPatchSchema);
    const subject = updateSubject(actor, (await context.params).id, patch);
    if (!subject) throw new MonoHttpError(404, "主体不存在，或只有创建者可以修改");
    return Response.json({ subject });
  } catch (error) {
    return monoErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    assertMonoApiAccess(request);
    if (!deleteSubject(actorFromRequest(request), (await context.params).id)) {
      throw new MonoHttpError(404, "主体不存在，或只有创建者可以删除");
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
