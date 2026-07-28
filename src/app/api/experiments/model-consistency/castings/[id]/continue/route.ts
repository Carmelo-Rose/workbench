import { actorFromWorkbenchRequest, monoErrorResponse, parseMonoJson } from "@/lib/mono/http";
import {
  continueCasting,
  continueCastingSchema,
} from "@/experiments/product-set-model-consistency/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Explicit paid continuation; GET/catalog can never schedule image work. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    const input = await parseMonoJson(request, continueCastingSchema);
    const { id } = await context.params;
    return Response.json({ casting: await continueCasting(actor.workspaceId, id, input) });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
