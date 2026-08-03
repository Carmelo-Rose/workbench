import { z } from "zod";
import { actorFromWorkbenchRequest, MonoHttpError, monoErrorResponse, parseMonoJson } from "@/lib/mono/http";
import { getJob, cancelJob, lightenMonoJob, purgeJob, setJobFavorite } from "@/lib/mono/service";

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

const patchJobSchema = z.object({ favorite: z.boolean() });

export async function PATCH(request: Request, context: Context) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    const { id } = await context.params;
    const { favorite } = await parseMonoJson(request, patchJobSchema);
    const job = setJobFavorite(actor, id, favorite);
    if (!job) throw new MonoHttpError(404, "任务不存在或已无权访问");
    return Response.json({ job: lightenMonoJob(job) });
  } catch (error) {
    return monoErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    const { id } = await context.params;
    if (new URL(request.url).searchParams.get("purge") === "true") {
      if (!await purgeJob(actor, id)) throw new MonoHttpError(409, "只有已结束的任务可以从历史中删除");
      return new Response(null, { status: 204 });
    }
    const job = await cancelJob(actor, id);
    if (!job) throw new MonoHttpError(404, "任务不存在或已无权访问");
    return Response.json({ job });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
