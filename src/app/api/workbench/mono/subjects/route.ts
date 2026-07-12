import { monoSubjectInputSchema } from "@/lib/mono/contracts";
import { actorFromWorkbenchRequest, monoErrorResponse, parseMonoJson } from "@/lib/mono/http";
import { createSubject, listSubjects } from "@/lib/mono/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    return Response.json({ subjects: listSubjects(actor).map((subject) => ({
      ...subject,
      editable: subject.ownerUserId === actor.userId,
      previewUrl: `/api/workbench/mono/assets/${encodeURIComponent(subject.assetId)}/content`,
    })) });
  } catch (error) {
    return monoErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    const input = await parseMonoJson(request, monoSubjectInputSchema);
    const subject = createSubject(actor, input);
    return Response.json({ subject: {
      ...subject,
      editable: true,
      previewUrl: `/api/workbench/mono/assets/${encodeURIComponent(subject.assetId)}/content`,
    } }, { status: 201 });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
