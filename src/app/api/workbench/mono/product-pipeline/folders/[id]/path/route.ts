import { actorFromWorkbenchRequest, monoErrorResponse } from "@/lib/mono/http";
import { resolveProductFolder } from "@/lib/mono/product-pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * The absolute share path is deliberately redacted from job records before
 * they leave the server (see service.ts createProductPipelineJob) — but the
 * "复制文件夹路径" button exists specifically so a user can paste a working
 * path into Explorer, so it needs one purpose-built, on-demand route rather
 * than widening what every job response carries.
 */
export async function GET(request: Request, context: Context) {
  try {
    actorFromWorkbenchRequest(request);
    const { id } = await context.params;
    const folder = resolveProductFolder(id);
    return Response.json({ absolutePath: folder.absolutePath });
  } catch (error) { return monoErrorResponse(error); }
}
