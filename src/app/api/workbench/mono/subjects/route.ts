import { monoSubjectInputSchema } from "@/lib/mono/contracts";
import { actorFromWorkbenchRequest, monoErrorResponse, parseMonoJson } from "@/lib/mono/http";
import { createSubject, listSubjects } from "@/lib/mono/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const exporting = url.searchParams.get("export") === "1";
    const actor = actorFromWorkbenchRequest(
      request,
      exporting ? "resources.subjects.export" : "resources.subjects.view",
    );
    return Response.json({ subjects: listSubjects(actor).map((subject) => ({
      ...subject,
      editable: actor.dataScope === "workspace" || subject.ownerUserId === actor.userId,
      previewUrl: `/api/workbench/mono/assets/${encodeURIComponent(subject.assetId)}/content`,
    })) });
  } catch (error) {
    return monoErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = actorFromWorkbenchRequest(request, "resources.subjects.create");
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
