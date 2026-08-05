import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { loadEnvConfig } from "@next/env";

// This standalone process is outside the Next runtime, so load the same
// root-level .env files before importing services that read configuration.
loadEnvConfig(process.cwd());

/**
 * 独立 Mono Worker 进程（架构治理 Phase 4）。跟 Next.js web 进程共用同一个
 * SQLite 队列文件（WORKBENCH_DB_PATH，缺省和 web 进程同一个默认路径
 * data/workbench.db），靠带过期时间的租约原子认领任务——多个进程（包括还开着
 * inline drain 的 web 进程）同时轮询也不会抢错，但要真正把执行职责移交给这个
 * 独立进程，请给 web 进程设 MONO_WORKER_MODE=standalone，否则 web 进程会继续
 * 自己 drain，这个进程只是在陪跑、白占并发位。
 *
 * 启动：npm run mono:worker
 * 停止：SIGINT/SIGTERM 会先停止认领新任务，等在飞任务收尾（有超时）再退出；
 * 超时仍在跑的任务不会丢——它们的租约到期后会被 reclaimExpiredLeases 收回，
 * 下一个 worker（可能是重启后的自己）会重新认领执行。
 */

async function bootstrap(): Promise<void> {
const {
  createEmptyWorkerInFlight,
  reportStandaloneWorkerHeartbeat,
  runStandaloneWorkerTick,
} = await import("@/lib/mono/service");

const POLL_MS = Math.max(250, Number(process.env.MONO_WORKER_POLL_MS) || 1_500);
const HEARTBEAT_MS = Math.max(POLL_MS, Number(process.env.MONO_WORKER_HEARTBEAT_MS) || 10_000);
const SHUTDOWN_GRACE_MS = Math.max(0, Number(process.env.MONO_WORKER_SHUTDOWN_GRACE_MS) || 30_000);

const workerId = process.env.MONO_WORKER_ID
  ?? `standalone-${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const startedAt = Date.now();
const inFlight = createEmptyWorkerInFlight();

let stopping = false;
let lastHeartbeatAt = 0;

function log(message: string): void {
  console.log(`[mono-worker ${workerId}] ${message}`);
}

function totalInFlight(): number {
  return Object.values(inFlight).reduce((sum, count) => sum + count, 0);
}

async function tick(): Promise<void> {
  const claimed = await runStandaloneWorkerTick(workerId, inFlight);
  if (claimed > 0) log(`认领 ${claimed} 个任务，当前 in-flight: ${JSON.stringify(inFlight)}`);
  const now = Date.now();
  if (now - lastHeartbeatAt >= HEARTBEAT_MS) {
    reportStandaloneWorkerHeartbeat(workerId, inFlight, startedAt);
    lastHeartbeatAt = now;
  }
}

async function loop(): Promise<void> {
  for (;;) {
    if (stopping) return;
    try {
      await tick();
    } catch (error) {
      console.error(`[mono-worker ${workerId}] 轮询出错`, error);
    }
    if (stopping) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`收到 ${signal}，停止认领新任务，等待在飞任务收尾（最多 ${SHUTDOWN_GRACE_MS}ms）…`);
  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  while (totalInFlight() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (totalInFlight() > 0) {
    log(`超时仍有 ${totalInFlight()} 个任务在跑，直接退出——它们的租约到期后会被重新认领。`);
  } else {
    log("已收尾，退出。");
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

log(`启动，DB=${process.env.WORKBENCH_DB_PATH ?? "(默认 data/workbench.db)"}，轮询间隔 ${POLL_MS}ms`);
reportStandaloneWorkerHeartbeat(workerId, inFlight, startedAt);
lastHeartbeatAt = Date.now();
void loop();
}

void bootstrap().catch((error) => {
  console.error("[mono-worker] startup failed", error);
  process.exit(1);
});
