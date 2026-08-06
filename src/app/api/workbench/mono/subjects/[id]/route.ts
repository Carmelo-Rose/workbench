import { monoSubjectPatchSchema } from "@/lib/mono/contracts";
import { actorFromWorkbenchRequest, MonoHttpError, monoErrorResponse, parseMonoJson } from "@/lib/mono/http";
import { deleteSubject, getSubject, updateSubject } from "@/lib/mono/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const actor = actorFromWorkbenchRequest(request, "resources.subjects.view");
    const { id } = await context.params;
    const subject = getSubject(actor, id);
    if (!subject) throw new MonoHttpError(404, "主体不存在或已无权访问");
    return Response.json({ subject: {
      ...subject,
      editable: actor.dataScope === "workspace" || subject.ownerUserId === actor.userId,
      previewUrl: `/api/workbench/mono/assets/${encodeURIComponent(subject.assetId)}/content`,
    } });
  } catch (error) {
    return monoErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const actor = actorFromWorkbenchRequest(request, "resources.subjects.manage");
    const { id } = await context.params;
    const patch = await parseMonoJson(request, monoSubjectPatchSchema);
    const subject = updateSubject(actor, id, patch);
    if (!subject) throw new MonoHttpError(404, "主体不存在，或只有创建者可以修改");
    return Response.json({ subject: {
      ...subject,
      editable: true,
      previewUrl: `/api/workbench/mono/assets/${encodeURIComponent(subject.assetId)}/content`,
    } });
  } catch (error) {
    return monoErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    const actor = actorFromWorkbenchRequest(request, "resources.subjects.manage");
    const { id } = await context.params;
    if (!deleteSubject(actor, id)) throw new MonoHttpError(404, "主体不存在，或只有创建者可以删除");
    return new Response(null, { status: 204 });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
