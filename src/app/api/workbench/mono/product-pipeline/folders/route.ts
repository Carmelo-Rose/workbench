import { actorFromWorkbenchRequest, monoErrorResponse } from "@/lib/mono/http";
import { listProductFolders, listProductWorkflows } from "@/lib/mono/product-pipeline";
import { listProductModelPairs } from "@/lib/mono/product-model-pairs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    const query = new URL(request.url).searchParams.get("q")?.slice(0, 120) ?? "";
    // Workflows ride along with the folder list: the picker needs both to
    // render one row, and the installed bundles are a local directory read.
    const [folders, workflows, modelPairs] = await Promise.all([
      listProductFolders(query),
      listProductWorkflows(),
      listProductModelPairs(actor.workspaceId),
    ]);
    return Response.json({ folders, workflows, modelPairs });
  } catch (error) { return monoErrorResponse(error); }
}
