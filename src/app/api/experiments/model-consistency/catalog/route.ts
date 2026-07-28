import { actorFromWorkbenchRequest, monoErrorResponse } from "@/lib/mono/http";
import { catalog } from "@/experiments/product-set-model-consistency/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    return Response.json(await catalog(actor.workspaceId));
  } catch (error) {
    return monoErrorResponse(error);
  }
}
