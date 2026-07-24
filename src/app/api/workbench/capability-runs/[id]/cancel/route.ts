import { actorFromWorkbenchRequest, MonoHttpError, monoErrorResponse } from "@/lib/mono/http";
import { cancelJob } from "@/lib/mono/service";
import { capabilityIdForJobKind } from "@/lib/workbench/capability-registry";
import { jobToCapabilityRun } from "@/lib/workbench/capability-bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    const { id } = await context.params;
    const job = cancelJob(actor, id);
    if (!job) throw new MonoHttpError(404, "能力执行记录不存在，或不属于当前工作区");
    const capabilityId = capabilityIdForJobKind(job.kind) ?? job.kind;
    return Response.json({ run: jobToCapabilityRun(capabilityId, job) });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
