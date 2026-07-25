import { actorFromWorkbenchRequest, monoErrorResponse, parseMonoJson } from "@/lib/mono/http";
import { productPipelineInputSchema } from "@/lib/mono/contracts";
import { createProductPipelineJob, lightenMonoJob } from "@/lib/mono/service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try { const actor = actorFromWorkbenchRequest(request); const input = await parseMonoJson(request, productPipelineInputSchema); return Response.json({ job: lightenMonoJob(createProductPipelineJob(actor, input)) }, { status: 201 }); }
  catch (error) { return monoErrorResponse(error); }
}
