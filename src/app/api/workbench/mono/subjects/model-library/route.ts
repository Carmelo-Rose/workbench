import {
  createProductModelCard,
  createProductModelCardSchema,
  listProductModelCards,
  listProductModelPairs,
} from "@/lib/mono/product-model-pairs";
import { actorFromWorkbenchRequest, monoErrorResponse, parseMonoJson } from "@/lib/mono/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Backend contract for the future 主体库「模特卡」section. */
export async function GET(request: Request) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    return Response.json({
      models: listProductModelCards(actor.workspaceId),
      pairs: listProductModelPairs(actor.workspaceId),
    });
  } catch (error) {
    return monoErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    const input = await parseMonoJson(request, createProductModelCardSchema);
    return Response.json({ model: createProductModelCard(actor, input) }, { status: 201 });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
