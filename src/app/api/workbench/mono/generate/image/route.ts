import { monoImageGenerationSchema } from "@/lib/mono/contracts";
import { actorFromWorkbenchRequest, monoErrorResponse, parseMonoJson } from "@/lib/mono/http";
import { createImageGenerationJob } from "@/lib/mono/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const actor = actorFromWorkbenchRequest(request, "image.generate.use");
    const input = await parseMonoJson(request, monoImageGenerationSchema);
    return Response.json({ job: createImageGenerationJob(actor, input) }, { status: 202 });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
