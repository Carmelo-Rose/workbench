import {
  deleteProductModelPair,
  updateProductModelPair,
  updateProductModelPairSchema,
} from "@/lib/mono/product-model-pairs";
import { actorFromWorkbenchRequest, monoErrorResponse, parseMonoJson } from "@/lib/mono/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    const { id } = await context.params;
    const patch = await parseMonoJson(request, updateProductModelPairSchema);
    return Response.json({ pair: updateProductModelPair(actor, id, patch) });
  } catch (error) {
    return monoErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    const { id } = await context.params;
    deleteProductModelPair(actor, id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
