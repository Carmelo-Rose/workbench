import path from "node:path";
import { readFile } from "node:fs/promises";
import { actorFromWorkbenchRequest, MonoHttpError, monoErrorResponse } from "@/lib/mono/http";
import { getJob } from "@/lib/mono/service";
import { resolveDetailPageFolder, resolveProductFolder } from "@/lib/mono/product-pipeline";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; name: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const actor = actorFromWorkbenchRequest(request); const { id, name } = await context.params;
    if (!/^[^\\/:*?"<>|]+\.png$/iu.test(name)) throw new MonoHttpError(404, "产物不存在");
    const job = getJob(actor, id); if (!job || job.kind !== "product_pipeline") throw new MonoHttpError(404, "任务不存在或无权访问");
    const folder = resolveProductFolder(String(job.input.folderId ?? ""));
    const detailFolder = resolveDetailPageFolder(folder.relativePath);
    const target = path.resolve(detailFolder, "主图", name);
    if (path.dirname(target) !== path.resolve(detailFolder, "主图")) throw new MonoHttpError(404, "产物不存在");
    const body = await readFile(target); return new Response(body, { headers: { "content-type": "image/png", "cache-control": "private, no-store" } });
  } catch (error) { return monoErrorResponse(error); }
}
