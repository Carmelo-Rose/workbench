import { actorFromWorkbenchRequest, monoErrorResponse, parseMonoJson } from "@/lib/mono/http";
import {
  retryRun,
  retryRunSchema,
} from "@/experiments/product-set-model-consistency/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    const input = await parseMonoJson(request, retryRunSchema);
    const { id } = await context.params;
    return Response.json({ run: await retryRun(actor.workspaceId, id, input) });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
