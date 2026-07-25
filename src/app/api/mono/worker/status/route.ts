import { assertMonoApiAccess, monoErrorResponse } from "@/lib/mono/http";
import { getMonoJobQueueStats, listMonoWorkerHeartbeats } from "@/lib/mono/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WORKER_STALE_MS = Math.max(10_000, Number(process.env.MONO_WORKER_STALE_MS) || 60_000);

/**
 * 架构治理 Phase 4：队列可观测性端点。跨工作区的运维视角，不按 workspace
 * 隔离——跟其余 /api/mono/* 一样用平台服务凭证保护（assertMonoApiAccess），
 * 不是给最终用户看的。
 */
export async function GET(request: Request) {
  try {
    assertMonoApiAccess(request);
    const now = Date.now();
    const workers = listMonoWorkerHeartbeats().map((worker) => ({
      ...worker,
      stale: now - worker.lastHeartbeatAt > WORKER_STALE_MS,
    }));
    const queue = getMonoJobQueueStats();
    return Response.json({ workers, queue, checkedAt: now });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
