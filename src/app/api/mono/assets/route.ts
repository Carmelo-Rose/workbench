import { monoAssetInputSchema } from "@/lib/mono/contracts";
import { actorFromRequest, assertMonoApiAccess, monoErrorResponse, parseMonoJson } from "@/lib/mono/http";
import { createAsset } from "@/lib/mono/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertMonoApiAccess(request);
    const actor = actorFromRequest(request);
    const input = await parseMonoJson(request, monoAssetInputSchema);
    const asset = createAsset(actor, input);
    return Response.json({ asset }, { status: 201 });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
