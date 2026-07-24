import type { MonoActor, MonoJobStatus } from "@/lib/mono/contracts";
import { MonoHttpError } from "@/lib/mono/http";

/**
 * 统一能力命令（架构治理 Phase 2）——工具入口、聊天入口、MCP、外部 API
 * 以后都应该收敛成这一种形状再进注册表分发，而不是各自拼供应商请求。
 * `assetIds` 目前是调用方显式传入的、供审计/未来 Toolbox 副本联动用的
 * 素材清单，暂不校验它与 `input` 内部素材引用（如 assetId/referenceAssetIds）
 * 是否一致——具体能力的 `inputSchema` 才是当前唯一的输入真源。
 */
export type CapabilityCommand<TInput = unknown> = {
  capabilityId: string;
  input: TInput;
  assetIds: string[];
  actor: MonoActor;
  threadId?: string;
  idempotencyKey?: string;
};

/** MonoJobStatus 已经是 queued/running/succeeded/failed/cancelled，直接复用，避免另建一套重复枚举。 */
export type CapabilityRunStatus = MonoJobStatus;

export type CapabilityRun = {
  id: string;
  capabilityId: string;
  mode: "sync" | "async";
  status: CapabilityRunStatus;
  result: unknown;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

export class CapabilityNotFoundError extends MonoHttpError {
  constructor(capabilityId: string) {
    super(404, `能力不存在：${capabilityId}`);
  }
}
