import type { JobInfo } from "@/lib/toolbox/types";

/**
 * 视频工具箱网关（跑在 AILAB 服务机上的 FastAPI Job 服务）的服务端客户端。
 * 浏览器不直连网关，一律经 /api/toolbox/* 代理，这里是代理与工具共用的唯一出口。
 */

export function gatewayBase(): string {
  return (
    process.env.TOOLBOX_GATEWAY_URL?.replace(/\/+$/, "") ??
    "http://192.168.1.198:8100"
  );
}

export function gatewayHeaders(): Record<string, string> {
  const token = process.env.TOOLBOX_TOKEN;
  return token ? { "x-toolbox-token": token } : {};
}

export class GatewayError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

async function gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${gatewayBase()}${path}`, {
      ...init,
      headers: { ...gatewayHeaders(), ...init?.headers },
      cache: "no-store",
    });
  } catch {
    throw new GatewayError("视频工具箱网关连接失败（服务机可能未启动）");
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GatewayError(
      `网关返回 ${res.status}${detail ? `：${detail.slice(0, 200)}` : ""}`,
      res.status,
    );
  }
  return res;
}

export type SubmitJobRequest = {
  capability: string;
  params?: Record<string, unknown>;
  /** 输入文件引用：字段名 → file_id（或 "job:<jobId>/<产物路径>" 以复用其他任务的产物）。 */
  inputs?: Record<string, string>;
};

export async function submitJob(req: SubmitJobRequest): Promise<JobInfo> {
  const res = await gatewayFetch("/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  return (await res.json()) as JobInfo;
}

export async function getJob(jobId: string): Promise<JobInfo | null> {
  try {
    const res = await gatewayFetch(`/jobs/${encodeURIComponent(jobId)}`);
    return (await res.json()) as JobInfo;
  } catch (error) {
    if (error instanceof GatewayError && error.status === 404) return null;
    throw error;
  }
}
