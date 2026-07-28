import { actorFromWorkbenchRequest, monoErrorResponse, parseMonoJson } from "@/lib/mono/http";
import {
  reviewRun,
  reviewRunSchema,
} from "@/experiments/product-set-model-consistency/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    const input = await parseMonoJson(request, reviewRunSchema);
    const { id } = await context.params;
    return Response.json({ run: await reviewRun(actor.workspaceId, id, input) });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
