import { monoSubjectInputSchema } from "@/lib/mono/contracts";
import { actorFromRequest, assertMonoApiAccess, monoErrorResponse, parseMonoJson } from "@/lib/mono/http";
import { createSubject, listSubjects } from "@/lib/mono/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    assertMonoApiAccess(request);
    return Response.json({ subjects: listSubjects(actorFromRequest(request)) });
  } catch (error) {
    return monoErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertMonoApiAccess(request);
    const actor = actorFromRequest(request);
    const input = await parseMonoJson(request, monoSubjectInputSchema);
    return Response.json({ subject: createSubject(actor, input) }, { status: 201 });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
