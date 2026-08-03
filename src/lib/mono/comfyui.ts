import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

/**
 * ComfyUI 统一 GPU 后端客户端。每个视频/图片处理能力对应一个
 * API 格式工作流 JSON（config/comfyui-workflows/<kind>.json），
 * 模板里的 "{{TOKEN}}" 字符串值在提交前用真实参数替换——
 * 换模型 = 换工作流文件，Workbench 代码不动。
 */

export type ComfyOutputFile = { filename: string; subfolder: string; type: string };

export function comfyBaseUrl(): string {
  const url = process.env.COMFYUI_URL;
  if (!url) throw new Error("ComfyUI 未配置：请设置 COMFYUI_URL（如 http://127.0.0.1:8188）");
  return url.replace(/\/+$/u, "");
}

export function comfyTimeoutMs(): number {
  const parsed = Number(process.env.COMFYUI_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 60_000;
}

export function workflowsDir(): string {
  return process.env.COMFYUI_WORKFLOWS_DIR ?? path.join(process.cwd(), "config", "comfyui-workflows");
}

/** 读取某能力的工作流模板并填充 "{{TOKEN}}" 占位值。 */
export async function loadComfyWorkflow(
  kind: string,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const filePath = path.join(workflowsDir(), `${kind}.json`);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    throw new Error(`「${kind}」能力的 ComfyUI 工作流未配置：请把 API 格式工作流放到 ${filePath}`);
  }
  const filled = raw.replace(/"\{\{([A-Z0-9_]+)\}\}"|\{\{([A-Z0-9_]+)\}\}/gu, (token, quotedName: string | undefined, bareName: string | undefined) => {
    const name = quotedName ?? bareName!;
    return name in values ? JSON.stringify(values[name]) : token;
  },
  );
  const leftover = filled.match(/\{\{([A-Z0-9_]+)\}\}/u);
  if (leftover) throw new Error(`工作流占位符 {{${leftover[1]}}} 没有对应参数`);
  return JSON.parse(filled) as Record<string, unknown>;
}

/** 上传输入文件到 ComfyUI，返回工作流中可引用的文件名。 */
export async function uploadComfyInput(
  buffer: Buffer,
  filename: string,
  mimeType: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(buffer)], { type: mimeType ?? "application/octet-stream" }), filename);
  form.append("overwrite", "true");
  const response = await fetch(`${comfyBaseUrl()}/upload/image`, { method: "POST", body: form, signal });
  const data = await response.json().catch(() => null) as { name?: string; subfolder?: string } | null;
  if (!response.ok || !data?.name) throw new Error(`ComfyUI 输入上传失败：HTTP ${response.status}`);
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

/** 提交工作流并轮询直到产出输出文件列表。 */
export async function submitComfyWorkflow(
  workflow: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const base = comfyBaseUrl();
  const response = await fetch(`${base}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: `workbench-${randomUUID()}` }),
    signal,
  });
  const submitted = await response.json().catch(() => null) as
    | { prompt_id?: string; error?: { message?: string }; node_errors?: Record<string, unknown> }
    | null;
  if (!response.ok || !submitted?.prompt_id) {
    const detail = submitted?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`ComfyUI 拒绝了工作流：${detail}`);
  }
  return submitted.prompt_id;
}

export async function pollComfyWorkflow(promptId: string, signal: AbortSignal): Promise<{
  status: "queued" | "running" | "succeeded" | "failed";
  outputs?: ComfyOutputFile[];
}> {
  const base = comfyBaseUrl();
  const response = await fetch(`${base}/history/${encodeURIComponent(promptId)}`, { signal });
  if (!response.ok) throw new Error(`ComfyUI 历史查询失败：HTTP ${response.status}`);
  const history = await response.json().catch(() => null) as Record<string, {
    status?: { completed?: boolean; status_str?: string };
    outputs?: Record<string, Record<string, unknown>>;
  }> | null;
  const entry = history?.[promptId];
  if (!entry) return { status: "running" };
  if (entry.status?.status_str === "error") return { status: "failed" };
  if (!entry.status?.completed) return { status: "running" };
  const outputs = collectOutputFiles(entry.outputs ?? {});
  if (outputs.length === 0) throw new Error("ComfyUI 任务完成但没有输出文件（工作流需要包含保存节点）");
  return { status: "succeeded", outputs };
}

export async function cancelComfyWorkflow(promptId: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(`${comfyBaseUrl()}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delete: [promptId] }),
    signal,
  });
  if (!response.ok) throw new Error(`ComfyUI 取消任务失败：HTTP ${response.status}`);
}

export async function runComfyWorkflow(
  workflow: Record<string, unknown>,
  signal: AbortSignal,
  onStage?: (stage: string) => void,
): Promise<ComfyOutputFile[]> {
  const promptId = await submitComfyWorkflow(workflow, signal);
  onStage?.("processing");

  const deadline = Date.now() + comfyTimeoutMs();
  while (Date.now() < deadline) {
    await waitAborting(2_000, signal);
    const result = await pollComfyWorkflow(promptId, signal);
    if (result.status === "failed") throw new Error("ComfyUI 工作流执行失败，请检查 ComfyUI 侧日志");
    if (result.status === "succeeded") return result.outputs!;
  }
  throw new Error("ComfyUI 任务超时");
}

/** 下载输出文件字节。 */
export async function downloadComfyOutput(file: ComfyOutputFile, signal: AbortSignal): Promise<Buffer> {
  const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
  const response = await fetch(`${comfyBaseUrl()}/view?${query}`, { signal });
  if (!response.ok) throw new Error(`ComfyUI 输出下载失败：HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** ComfyUI 各类保存节点输出键不同（images/gifs/videos/audio），统一拍平。 */
function collectOutputFiles(outputs: Record<string, Record<string, unknown>>): ComfyOutputFile[] {
  const files: ComfyOutputFile[] = [];
  for (const nodeOutput of Object.values(outputs)) {
    for (const value of Object.values(nodeOutput)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (
          typeof item === "object" && item !== null &&
          typeof (item as ComfyOutputFile).filename === "string"
        ) {
          const file = item as Partial<ComfyOutputFile>;
          files.push({ filename: file.filename!, subfolder: file.subfolder ?? "", type: file.type ?? "output" });
        }
      }
    }
  }
  return files;
}

function waitAborting(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("任务已取消"));
    }, { once: true });
  });
}
