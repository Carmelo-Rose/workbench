import { monoAssetInputSchema } from "@/lib/mono/contracts";
import { actorFromWorkbenchRequest, monoErrorResponse, parseMonoJson } from "@/lib/mono/http";
import { createAsset, listGeneratedAssets } from "@/lib/mono/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = actorFromWorkbenchRequest(request, "resources.assets.view");
    const url = new URL(request.url);
    if (url.searchParams.get("origin") !== "generated") {
      return Response.json({ assets: [] });
    }
    return Response.json({
      assets: listGeneratedAssets(
        actor,
        Number(url.searchParams.get("limit")) || 24,
        Number(url.searchParams.get("before")) || undefined,
      ),
    });
  } catch (error) {
    return monoErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = actorFromWorkbenchRequest(request, "resources.assets.create");
    const input = await parseMonoJson(request, monoAssetInputSchema);
    return Response.json({ asset: createAsset(actor, input) }, { status: 201 });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
