/**
 * 对话后端注册表：direct（模型直连）与 hermes（Hermes Agent 内核）。
 * 前端把选中的 backend id 注册进 ModelContext（config.modelName），
 * AssistantChatTransport 随每条请求发给 /api/chat，服务端按请求路由——
 * 两条链路常驻并行，无需重启切换。
 */

export const BACKEND_IDS = ["direct", "hermes"] as const;
export type BackendId = (typeof BACKEND_IDS)[number];

export type BackendInfo = {
  id: BackendId;
  name: string;
  /** 选择器里的一句话说明 */
  description: string;
  /** 能力面板里的展示项 */
  capabilities: { label: string; detail: string }[];
};

export const BACKENDS: Record<BackendId, BackendInfo> = {
  direct: {
    id: "direct",
    name: "Qwen 直连",
    description: "轻量快速，本地工具在 workbench 内执行",
    capabilities: [
      { label: "流式对话", detail: "OpenAI 兼容端点直连，首字延迟最低" },
      { label: "本地工具", detail: "image_to_prompt 等工具在 workbench 进程内运行" },
      { label: "低开销", detail: "系统提示精简，按 token 计费成本低" },
    ],
  },
  hermes: {
    id: "hermes",
    name: "Hermes Agent",
    description: "完整 Agent 内核：工具、记忆、技能在服务端闭环",
    capabilities: [
      { label: "Agent 循环", detail: "工具调用、多步推理在 Hermes 网关内自主完成" },
      { label: "跨会话记忆", detail: "服务端持久记忆，同一会话通过 Session-Id 保持连续" },
      { label: "技能系统", detail: "Hermes 技能与扩展在服务端加载，前端零改动" },
      { label: "会话连续性", detail: "X-Hermes-Session-Id 绑定线程，上下文服务端托管" },
    ],
  },
};

export function isBackendId(value: unknown): value is BackendId {
  return typeof value === "string" && (BACKEND_IDS as readonly string[]).includes(value);
}

/** /api/agent/status 的响应契约，服务端与客户端共用。 */
export type AgentStatus = {
  defaultBackend: string;
  direct: {
    configured: boolean;
    model: string;
    host: string | null;
  };
  hermes: {
    configured: boolean;
    ok: boolean;
    version: string | null;
    platform: string | null;
    host: string | null;
    error: string | null;
  };
};

/** 服务端默认后端：WORKBENCH_AGENT_BACKEND 未设置或非法时回落 direct。 */
export function defaultBackend(): BackendId {
  const env = process.env.WORKBENCH_AGENT_BACKEND;
  return isBackendId(env) ? env : "direct";
}
