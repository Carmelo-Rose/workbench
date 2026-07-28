import { actorFromWorkbenchRequest, monoErrorResponse } from "@/lib/mono/http";
import { listProductFolders, listProductWorkflows } from "@/lib/mono/product-pipeline";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    actorFromWorkbenchRequest(request);
    const query = new URL(request.url).searchParams.get("q")?.slice(0, 120) ?? "";
    // Workflows ride along with the folder list: the picker needs both to
    // render one row, and the installed bundles are a local directory read.
    const [folders, workflows] = await Promise.all([listProductFolders(query), listProductWorkflows()]);
    return Response.json({ folders, workflows });
  } catch (error) { return monoErrorResponse(error); }
}
