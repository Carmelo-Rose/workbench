import { actorFromWorkbenchRequest, monoErrorResponse, parseMonoJson } from "@/lib/mono/http";
import {
  createModelPair,
  createModelPairSchema,
} from "@/experiments/product-set-model-consistency/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Saving a pair is a free metadata-only operation. Catalog reads the saved pairs. */
export async function POST(request: Request) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    const input = await parseMonoJson(request, createModelPairSchema);
    return Response.json({ modelPair: await createModelPair(actor.workspaceId, input) }, { status: 201 });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
