import { randomUUID } from "node:crypto";
import type { MonoJob } from "@/lib/mono/contracts";
import { CapabilityNotFoundError, type CapabilityCommand, type CapabilityRun } from "./capability-command";
import { getCapability } from "./capability-registry";

export function jobToCapabilityRun(capabilityId: string, job: MonoJob): CapabilityRun {
  return {
    id: job.id,
    capabilityId,
    mode: "async",
    status: job.status,
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

/**
 * 命令总线的第一版：查注册表 → 校验入参 → 分发到 sync/async 执行入口。
 * 同步能力的结果不落库，`id` 只是这次响应自带的标识，不能拿去 GET 复查
 * （现状如此——`image_to_prompt` 今天在聊天工具里也是即算即回，不新增限制）。
 */
export async function runCapabilityCommand(command: CapabilityCommand): Promise<CapabilityRun> {
  const capability = getCapability(command.capabilityId);
  if (!capability) throw new CapabilityNotFoundError(command.capabilityId);

  const input = capability.inputSchema.parse(command.input);

  if (capability.mode === "async") {
    if (!capability.runAsync) throw new Error(`能力 ${capability.id} 声明为 async 但未提供 runAsync`);
    // 三个现有异步能力的 Schema 都自带 idempotencyKey 字段，命令信封上的顶层
    // idempotencyKey 只在调用方没把它塞进 input 时兜底合并，不覆盖已有值。
    const inputWithIdempotency = input as Record<string, unknown> & { idempotencyKey?: string };
    if (command.idempotencyKey && !inputWithIdempotency.idempotencyKey) {
      inputWithIdempotency.idempotencyKey = command.idempotencyKey;
    }
    const job = capability.runAsync(command.actor, input);
    return jobToCapabilityRun(capability.id, job);
  }

  if (!capability.runSync) throw new Error(`能力 ${capability.id} 声明为 sync 但未提供 runSync`);
  const now = Date.now();
  const result = await capability.runSync(command.actor, input);
  return {
    id: `run_${randomUUID()}`,
    capabilityId: capability.id,
    mode: "sync",
    status: "succeeded",
    result: result as Record<string, unknown>,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}
