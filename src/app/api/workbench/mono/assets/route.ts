import { monoAssetInputSchema } from "@/lib/mono/contracts";
import { actorFromWorkbenchRequest, monoErrorResponse, parseMonoJson } from "@/lib/mono/http";
import { createAsset } from "@/lib/mono/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    const input = await parseMonoJson(request, monoAssetInputSchema);
    return Response.json({ asset: createAsset(actor, input) }, { status: 201 });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
