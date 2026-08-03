import { monoErrorResponse, MonoHttpError } from "@/lib/mono/http";
import { cancelJob, lightenMonoJob } from "@/lib/mono/service";
import {
  productPipelineTrialContext,
  productPipelineTrialJson,
  trialProductPipelineJob,
} from "@/lib/try/product-pipeline-trial";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const trial = productPipelineTrialContext(request);
    const { id } = await context.params;
    const job = trialProductPipelineJob(trial.actor, id);
    if (!job) throw new MonoHttpError(404, "任务不存在或已无权访问");
    return productPipelineTrialJson({ job: lightenMonoJob(job) }, trial);
  } catch (error) {
    return monoErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    const trial = productPipelineTrialContext(request);
    const { id } = await context.params;
    const job = trialProductPipelineJob(trial.actor, id);
    if (!job) throw new MonoHttpError(404, "任务不存在或已无权访问");
    const cancelled = await cancelJob(trial.actor, id);
    if (!cancelled) throw new MonoHttpError(404, "任务不存在或已无权访问");
    return productPipelineTrialJson({ job: lightenMonoJob(cancelled) }, trial);
  } catch (error) {
    return monoErrorResponse(error);
  }
}
