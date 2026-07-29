import { monoErrorResponse, parseMonoJson } from "@/lib/mono/http";
import { productPipelineInputSchema } from "@/lib/mono/contracts";
import { createProductPipelineJob, lightenMonoJob } from "@/lib/mono/service";
import {
  assertTrialJobCapacity,
  productPipelineTrialContext,
  productPipelineTrialJson,
} from "@/lib/try/product-pipeline-trial";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const context = productPipelineTrialContext(request);
    assertTrialJobCapacity(context.actor);
    const input = await parseMonoJson(request, productPipelineInputSchema);
    const job = createProductPipelineJob(context.actor, input);
    return productPipelineTrialJson({ job: lightenMonoJob(job) }, context, { status: 201 });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
