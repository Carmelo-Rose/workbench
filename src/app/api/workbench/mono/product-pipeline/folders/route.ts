import { actorFromWorkbenchRequest, monoErrorResponse } from "@/lib/mono/http";
import {
  isProductRootReachable,
  listProductFolders,
  listProductWorkflows,
  productSourceRoot,
} from "@/lib/mono/product-pipeline";
import { listProductModelPairs } from "@/lib/mono/product-model-pairs";
import { isTemplateShadowV2Enabled } from "@/lib/mono/product-main-shadow";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const actor = actorFromWorkbenchRequest(request, "image.product-set.use");
    const query = new URL(request.url).searchParams.get("q")?.slice(0, 120) ?? "";
    // Workflows ride along with the folder list: the picker needs both to
    // render one row, and the installed bundles are a local directory read.
    const [folders, workflows, modelPairs, rootReachable] = await Promise.all([
      listProductFolders(query),
      listProductWorkflows(),
      listProductModelPairs(actor.workspaceId),
      isProductRootReachable(),
    ]);
    return Response.json({
      folders,
      workflows,
      modelPairs,
      rootReachable,
      root: productSourceRoot(),
      templateShadowV2Enabled: isTemplateShadowV2Enabled(),
    });
  } catch (error) { return monoErrorResponse(error); }
}
