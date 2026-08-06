import { actorFromWorkbenchRequest, MonoHttpError, monoErrorResponse } from "@/lib/mono/http";
import { getJob } from "@/lib/mono/service";
import { capabilityIdForJobKind } from "@/lib/workbench/capability-registry";
import { jobToCapabilityRun } from "@/lib/workbench/capability-bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * 只能查到异步能力的 run（背后是 mono_jobs 记录）。同步能力（如
 * image_to_prompt）不落库，查不到是预期行为，不是 bug。
 */
export async function GET(request: Request, context: Context) {
  try {
    const actor = actorFromWorkbenchRequest(request, "resources.tasks.view");
    const { id } = await context.params;
    const job = getJob(actor, id);
    if (!job) throw new MonoHttpError(404, "能力执行记录不存在，或不属于当前工作区");
    const capabilityId = capabilityIdForJobKind(job.kind) ?? job.kind;
    return Response.json({ run: jobToCapabilityRun(capabilityId, job) });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
