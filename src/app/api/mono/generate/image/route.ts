import { monoImageGenerationSchema } from "@/lib/mono/contracts";
import { actorFromRequest, assertMonoApiAccess, MonoHttpError, monoErrorResponse, parseMonoJson } from "@/lib/mono/http";
import { createImageGenerationJob, getJob } from "@/lib/mono/service";
import { runCapabilityCommand } from "@/lib/workbench/capability-bus";
import { isCapabilityBusEnabled } from "@/lib/workbench/capability-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CAPABILITY_ID = "mono_generate_image";

/** 架构治理 Phase 3：见 analyze/video/route.ts 顶部注释，同样的迁移方式。 */
export async function POST(request: Request) {
  try {
    assertMonoApiAccess(request);
    const actor = actorFromRequest(request);
    const input = await parseMonoJson(request, monoImageGenerationSchema);
    if (!isCapabilityBusEnabled(CAPABILITY_ID)) {
      const job = createImageGenerationJob(actor, input);
      return Response.json({ job }, { status: 202 });
    }
    const run = await runCapabilityCommand({ capabilityId: CAPABILITY_ID, input, assetIds: [], actor });
    const job = getJob(actor, run.id);
    if (!job) throw new MonoHttpError(500, "图片生成任务创建后未能读取");
    return Response.json({ job }, { status: 202 });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
