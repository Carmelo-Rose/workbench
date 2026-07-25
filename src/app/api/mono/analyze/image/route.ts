import { monoImageAnalysisSchema } from "@/lib/mono/contracts";
import { actorFromRequest, assertMonoApiAccess, monoErrorResponse, parseMonoJson } from "@/lib/mono/http";
import { analyzeImage } from "@/lib/mono/service";
import { runCapabilityCommand } from "@/lib/workbench/capability-bus";
import { isCapabilityBusEnabled } from "@/lib/workbench/capability-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CAPABILITY_ID = "image_to_prompt";

/**
 * 架构治理 Phase 3：外部 API 入口迁移到命令总线。响应形状必须和迁移前
 * 逐字节一致（`{result}`）——这是文档承诺的对外兼容面，命令总线只是换了
 * 内部分发路径，不是新协议。isCapabilityBusEnabled 提供按能力回滚开关。
 */
export async function POST(request: Request) {
  try {
    assertMonoApiAccess(request);
    const actor = actorFromRequest(request);
    const input = await parseMonoJson(request, monoImageAnalysisSchema);
    if (!isCapabilityBusEnabled(CAPABILITY_ID)) {
      return Response.json({ result: await analyzeImage(actor, input) });
    }
    const run = await runCapabilityCommand({ capabilityId: CAPABILITY_ID, input, assetIds: [], actor });
    return Response.json({ result: run.result });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
