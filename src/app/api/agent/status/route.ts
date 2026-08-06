import { defaultBackend, type AgentStatus } from "@/lib/backends";
import {
  monoErrorResponse,
  workspaceActorFromWorkbenchRequest,
} from "@/lib/mono/http";
import { getConfigValue } from "@/lib/server/api-config";

export const dynamic = "force-dynamic";

/** 从 OpenAI 兼容 baseURL（…/v1）推导网关根地址。 */
function gatewayRoot(baseURL: string): string {
  return baseURL.replace(/\/v1\/?$/, "");
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  let actor: ReturnType<typeof workspaceActorFromWorkbenchRequest>;
  try {
    actor = workspaceActorFromWorkbenchRequest(req, "workbench.chat.use");
  } catch (error) {
    return monoErrorResponse(error);
  }
  const chatBase =
    getConfigValue("CHAT_BASE_URL", actor.workspaceId) ??
    "https://api.deepseek.com/v1";
  const hermesBase = process.env.HERMES_BASE_URL ?? "http://127.0.0.1:8642/v1";

  const hermes: AgentStatus["hermes"] = {
    configured: Boolean(process.env.HERMES_API_KEY),
    ok: false,
    version: null,
    platform: null,
    host: hostOf(hermesBase),
    error: null,
  };

  try {
    const res = await fetch(`${gatewayRoot(hermesBase)}/health`, {
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
    });
    if (res.ok) {
      const health: { status?: string; version?: string; platform?: string } =
        await res.json();
      hermes.ok = health.status === "ok";
      hermes.version = health.version ?? null;
      hermes.platform = health.platform ?? null;
      if (!hermes.ok) hermes.error = `网关状态异常：${health.status}`;
    } else {
      hermes.error = `网关返回 HTTP ${res.status}`;
    }
  } catch {
    hermes.error = "网关不可达（未启动或端口不通）";
  }

  const status: AgentStatus = {
    defaultBackend: defaultBackend(),
    direct: {
      configured: Boolean(getConfigValue("CHAT_API_KEY", actor.workspaceId)),
      model:
        getConfigValue("CHAT_MODEL", actor.workspaceId) ?? "deepseek-chat",
      host: hostOf(chatBase),
    },
    hermes,
  };

  return Response.json(status);
}
