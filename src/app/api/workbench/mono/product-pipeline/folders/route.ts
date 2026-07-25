import { actorFromWorkbenchRequest, monoErrorResponse } from "@/lib/mono/http";
import { listProductFolders } from "@/lib/mono/product-pipeline";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    actorFromWorkbenchRequest(request);
    const query = new URL(request.url).searchParams.get("q")?.slice(0, 120) ?? "";
    return Response.json({ folders: await listProductFolders(query) });
  } catch (error) { return monoErrorResponse(error); }
}
