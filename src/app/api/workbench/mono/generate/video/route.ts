import { monoVideoGenerationSchema } from "@/lib/mono/contracts";
import { actorFromWorkbenchRequest, monoErrorResponse, parseMonoJson } from "@/lib/mono/http";
import { createVideoGenerationJob } from "@/lib/mono/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const actor = actorFromWorkbenchRequest(request, "video.generate.use");
    const input = await parseMonoJson(request, monoVideoGenerationSchema);
    return Response.json({ job: createVideoGenerationJob(actor, input) }, { status: 202 });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
