import { monoImageAnalysisSchema } from "@/lib/mono/contracts";
import { actorFromRequest, assertMonoApiAccess, monoErrorResponse, parseMonoJson } from "@/lib/mono/http";
import { analyzeImage } from "@/lib/mono/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertMonoApiAccess(request);
    const actor = actorFromRequest(request);
    const input = await parseMonoJson(request, monoImageAnalysisSchema);
    return Response.json({ result: await analyzeImage(actor, input) });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
