import { monoVideoAnalysisSchema } from "@/lib/mono/contracts";
import { actorFromRequest, assertMonoApiAccess, MonoHttpError, monoErrorResponse, parseMonoJson } from "@/lib/mono/http";
import { createVideoAnalysisJob, getJob } from "@/lib/mono/service";
import { runCapabilityCommand } from "@/lib/workbench/capability-bus";
import { isCapabilityBusEnabled } from "@/lib/workbench/capability-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CAPABILITY_ID = "mono_analyze_video";

/**
 * 架构治理 Phase 3：外部 API 入口迁移到命令总线。响应形状必须和迁移前
 * 逐字节一致（`{job}`，202）——命令总线内部返回的是瘦身过的 CapabilityRun，
 * 用 run.id 回查一次完整 MonoJob 还原成原来的响应体。
 */
export async function POST(request: Request) {
  try {
    assertMonoApiAccess(request);
    const actor = actorFromRequest(request);
    const input = await parseMonoJson(request, monoVideoAnalysisSchema);
    if (!isCapabilityBusEnabled(CAPABILITY_ID)) {
      const job = createVideoAnalysisJob(actor, input);
      return Response.json({ job }, { status: 202 });
    }
    const run = await runCapabilityCommand({ capabilityId: CAPABILITY_ID, input, assetIds: [], actor });
    const job = getJob(actor, run.id);
    if (!job) throw new MonoHttpError(500, "视频分析任务创建后未能读取");
    return Response.json({ job }, { status: 202 });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
