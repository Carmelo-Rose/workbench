import { monoImageGenerationSchema } from "@/lib/mono/contracts";
import { actorFromRequest, assertMonoApiAccess, monoErrorResponse, parseMonoJson } from "@/lib/mono/http";
import { createImageGenerationJob } from "@/lib/mono/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertMonoApiAccess(request);
    const actor = actorFromRequest(request);
    const input = await parseMonoJson(request, monoImageGenerationSchema);
    const job = createImageGenerationJob(actor, input);
    return Response.json({ job }, { status: 202 });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
