import {
  createProductModelPairFromSubjects,
  createProductModelPairFromSubjectsSchema,
  listProductModelPairs,
} from "@/lib/mono/product-model-pairs";
import { actorFromWorkbenchRequest, monoErrorResponse, parseMonoJson } from "@/lib/mono/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Backend contract for the future 主体库「模特组合」section. */
export async function GET(request: Request) {
  try {
    const actor = actorFromWorkbenchRequest(request, "models.combinations.view");
    return Response.json({ pairs: listProductModelPairs(actor.workspaceId) });
  } catch (error) {
    return monoErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = actorFromWorkbenchRequest(request, "models.combinations.manage");
    const input = await parseMonoJson(request, createProductModelPairFromSubjectsSchema);
    return Response.json({ pair: createProductModelPairFromSubjects(actor, input) }, { status: 201 });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
