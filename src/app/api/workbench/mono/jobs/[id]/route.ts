import { actorFromWorkbenchRequest, MonoHttpError, monoErrorResponse } from "@/lib/mono/http";
import { getJob, cancelJob } from "@/lib/mono/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * Browser-only job bridge. Provider credentials stay in the server-side Mono
 * service; this route only exposes the current Workbench actor's own job.
 */
export async function GET(request: Request, context: Context) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    const { id } = await context.params;
    const job = getJob(actor, id);
    if (!job) throw new MonoHttpError(404, "任务不存在或已无权访问");
    return Response.json({ job });
  } catch (error) {
    return monoErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    const { id } = await context.params;
    const job = cancelJob(actor, id);
    if (!job) throw new MonoHttpError(404, "任务不存在或已无权访问");
    return Response.json({ job });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
