import {
  isProductRootReachable,
  listProductFolders,
  listProductWorkflows,
  productSourceRoot,
} from "@/lib/mono/product-pipeline";
import { listProductModelPairs } from "@/lib/mono/product-model-pairs";
import { monoErrorResponse } from "@/lib/mono/http";
import {
  productPipelineTrialContext,
  productPipelineTrialJson,
} from "@/lib/try/product-pipeline-trial";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = productPipelineTrialContext(request);
    const query = new URL(request.url).searchParams.get("q")?.slice(0, 120) ?? "";
    const [folders, workflows, modelPairs, rootReachable] = await Promise.all([
      listProductFolders(query),
      listProductWorkflows(),
      listProductModelPairs(context.actor.workspaceId),
      isProductRootReachable(),
    ]);
    return productPipelineTrialJson(
      { folders, workflows, modelPairs, rootReachable, root: productSourceRoot() },
      context,
    );
  } catch (error) {
    return monoErrorResponse(error);
  }
}
