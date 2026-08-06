import { z } from "zod";
import { monoActorFromWorkspaceActor, monoErrorResponse, parseMonoJson, workspaceActorFromWorkbenchRequest } from "@/lib/mono/http";
import { runCapabilityCommand } from "@/lib/workbench/capability-bus";
import { getCapability } from "@/lib/workbench/capability-registry";
import { requireGrant, tenantErrorResponse } from "@/lib/server/tenant";
import type { CapabilityCommand } from "@/lib/workbench/capability-command";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 统一能力执行接口（架构治理 Phase 2）。现有 /api/workbench/mono/* 接口继续
 * 保留、行为不变——这是新增的单一入口，不是替换，供 Phase 3 起工具/聊天/MCP
 * 入口逐步切过来。
 */
const capabilityCommandSchema = z.object({
  capabilityId: z.string().min(1),
  input: z.unknown(),
  assetIds: z.array(z.string().min(1)).default([]),
  threadId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).optional(),
});

export async function POST(request: Request) {
  try {
    const body = await parseMonoJson(request, capabilityCommandSchema);
    const workspaceActor = workspaceActorFromWorkbenchRequest(request);
    const capability = getCapability(body.capabilityId);
    if (!capability) return Response.json({ error: "未知能力" }, { status: 404 });
    try {
      requireGrant(workspaceActor, capability.permission);
      if (capability.mode === "async") requireGrant(workspaceActor, "resources.tasks.create");
    }
    catch (error) { return tenantErrorResponse(error); }
    const actor = monoActorFromWorkspaceActor(workspaceActor);
    const command: CapabilityCommand = {
      capabilityId: body.capabilityId,
      input: body.input,
      assetIds: body.assetIds,
      actor,
      threadId: body.threadId,
      idempotencyKey: body.idempotencyKey,
    };
    const run = await runCapabilityCommand(command);
    // 202 用于异步能力（已受理、排队执行中），跟现有 /api/workbench/mono/generate/image
    // 等异步创建接口的约定保持一致；同步能力已经算完，200 更准确。
    return Response.json({ run }, { status: run.mode === "async" ? 202 : 200 });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
