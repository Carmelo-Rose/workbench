import { readFile } from "node:fs/promises";
import { getConfigValue } from "@/lib/server/api-config";

const RESULT_TIMEOUT_MS = 120_000;

export async function generateExperimentImage(input: {
  workspaceId: string;
  prompt: string;
  references: readonly string[];
  aspectRatio: string;
  model: string;
  signal?: AbortSignal;
}): Promise<Buffer> {
  const baseUrl = getConfigValue("MONO_IMAGE_BASE_URL", input.workspaceId);
  const apiKey = getConfigValue("MONO_IMAGE_API_KEY", input.workspaceId);
  if (!baseUrl || !apiKey) throw new Error("一致性实验需要配置 MONO_IMAGE_BASE_URL 和 MONO_IMAGE_API_KEY");
  const endpoint = process.env.MONO_IMAGE_GENERATE_URL ?? new URL("/v1/api/generate", baseUrl).toString();
  const references = await Promise.all(input.references.map(referenceDataUrl));
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: input.model,
      prompt: input.prompt,
      images: references,
      aspectRatio: input.aspectRatio,
      replyType: "json",
    }),
    signal: input.signal,
  });
  const data = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !data) throw new Error(`图片生成服务返回 HTTP ${response.status}`);
  const directUrl = extractImageUrl(data);
  const url = directUrl ?? await pollResult(data, baseUrl, apiKey, input.signal);
  const image = await fetch(url, { signal: input.signal });
  if (!image.ok) throw new Error(`无法下载生成图片：HTTP ${image.status}`);
  return Buffer.from(await image.arrayBuffer());
}

async function referenceDataUrl(reference: string): Promise<string> {
  if (reference.startsWith("data:image/") || /^https?:\/\//u.test(reference)) return reference;
  const bytes = await readFile(reference);
  const extension = reference.toLowerCase().endsWith(".png") ? "png" : "jpeg";
  return `data:image/${extension};base64,${bytes.toString("base64")}`;
}

async function pollResult(
  data: Record<string, unknown>,
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const taskId = stringAt(data, "id") ?? stringAt(data, "task_id") ?? nestedString(data, "data", "id");
  if (!taskId) throw new Error("图片生成服务没有返回图片或任务 ID");
  const resultBase = process.env.MONO_IMAGE_RESULT_URL ?? new URL("/v1/api/result", baseUrl).toString();
  const deadline = Date.now() + RESULT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await wait(3_000, signal);
    const response = await fetch(`${resultBase}?id=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    const result = await response.json().catch(() => null) as Record<string, unknown> | null;
    const url = response.ok && result ? extractImageUrl(result) : null;
    if (url) return url;
  }
  throw new Error("图片生成任务超时");
}

function extractImageUrl(data: Record<string, unknown>): string | null {
  const results = data.results;
  if (Array.isArray(results) && typeof results[0] === "object" && results[0] !== null) {
    const result = results[0] as Record<string, unknown>;
    const value = result.url ?? result.imageUrl ?? result.image_url;
    if (typeof value === "string") return value;
  }
  return stringAt(data, "url") ?? stringAt(data, "imageUrl") ?? nestedString(data, "data", "url");
}

function stringAt(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === "string" ? value[key] as string : null;
}

function nestedString(value: Record<string, unknown>, parent: string, key: string): string | null {
  const nested = value[parent];
  return typeof nested === "object" && nested !== null
    ? stringAt(nested as Record<string, unknown>, key)
    : null;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("任务已取消"));
    }, { once: true });
  });
}

