import sharp from "sharp";
import { getConfigValue } from "@/lib/server/api-config";
import { readObjectBuffer } from "@/lib/storage";
import {
  cancelComfyWorkflow,
  downloadComfyOutput,
  loadComfyWorkflow,
  pollComfyWorkflow,
  submitComfyWorkflow,
  uploadComfyInput,
  type ComfyOutputFile,
} from "./comfyui";
import type { MonoActor, MonoVideoGenerationInput } from "./contracts";
import { getMonoAsset } from "./store";
import { uploadImageToTosAndGetUrl } from "./tos";

export const videoProviderIds = ["comfyui", "dashscope-wan"] as const;
export type VideoProviderId = (typeof videoProviderIds)[number];

export type VideoGenerationCapabilities = {
  configured: boolean;
  provider: VideoProviderId | null;
  message?: string;
  modes: Array<"text-to-video" | "image-to-video">;
  models: Array<{ id: string; label: string; modes: Array<"text-to-video" | "image-to-video"> }>;
  durations: number[];
  resolutions: Array<"480p" | "720p">;
  variants: number[];
  aspectRatios: string[];
  supportsLastFrame: boolean;
};

export type ResolvedVideoGeneration = {
  provider: VideoProviderId;
  model: string;
  capabilities: VideoGenerationCapabilities;
};

export type PersistedVideoInput = MonoVideoGenerationInput & {
  provider: VideoProviderId;
  providerModel: string;
};

export type VideoProviderPoll = {
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stage: string;
  output?: Record<string, unknown>;
  error?: string;
};

export type DownloadedVideo = { buffer: Buffer; mimeType: string; filename: string };

export type VideoProvider = {
  id: VideoProviderId;
  submit(input: PersistedVideoInput, actor: MonoActor, signal: AbortSignal): Promise<{ remoteId: string }>;
  poll(remoteId: string, signal: AbortSignal): Promise<VideoProviderPoll>;
  cancel(remoteId: string, signal: AbortSignal): Promise<void>;
  download(output: Record<string, unknown>, signal: AbortSignal): Promise<DownloadedVideo>;
  pollIntervalMs: number;
};

const COMFY_MODEL = "wan2.2-ti2v-5b";
const DEFAULT_T2V_MODEL = "wan2.7-t2v-2026-06-12";
const DEFAULT_I2V_MODEL = "wan2.7-i2v-2026-04-25";

function configuredProvider(workspaceId?: string): VideoProviderId | null {
  const configured = getConfigValue("VIDEO_GENERATION_PROVIDER", workspaceId);
  if (configured === "comfyui") return process.env.COMFYUI_URL ? "comfyui" : null;
  if (configured === "dashscope-wan") {
    return getConfigValue("VIDEO_GENERATION_BASE_URL", workspaceId) && getConfigValue("VIDEO_GENERATION_API_KEY", workspaceId)
      ? "dashscope-wan"
      : null;
  }
  return null;
}

export function getVideoGenerationCapabilities(workspaceId?: string): VideoGenerationCapabilities {
  const provider = configuredProvider(workspaceId);
  if (!provider) {
    return {
      configured: false,
      provider: null,
      message: "视频生成未配置。请在设置中选择 provider 并填写所需凭证。",
      modes: [], models: [], durations: [], resolutions: [], variants: [], aspectRatios: [], supportsLastFrame: false,
    };
  }
  if (provider === "comfyui") {
    return {
      configured: true,
      provider,
      modes: ["text-to-video", "image-to-video"],
      models: [{ id: COMFY_MODEL, label: "Wan 2.2 TI2V-5B（本地）", modes: ["text-to-video", "image-to-video"] }],
      durations: [5], resolutions: ["480p"], variants: [1], aspectRatios: ["16:9", "9:16", "1:1"], supportsLastFrame: false,
    };
  }
  const t2v = getConfigValue("VIDEO_GENERATION_T2V_MODEL", workspaceId) ?? DEFAULT_T2V_MODEL;
  const i2v = getConfigValue("VIDEO_GENERATION_I2V_MODEL", workspaceId) ?? DEFAULT_I2V_MODEL;
  return {
    configured: true,
    provider,
    modes: ["text-to-video", "image-to-video"],
    models: [
      { id: t2v, label: "Wan 2.7 文生视频", modes: ["text-to-video"] },
      { id: i2v, label: "Wan 2.7 图生视频", modes: ["image-to-video"] },
    ],
    durations: [5, 10], resolutions: ["720p"], variants: [1],
    aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4"], supportsLastFrame: true,
  };
}

export function resolveVideoGeneration(input: MonoVideoGenerationInput, workspaceId?: string): ResolvedVideoGeneration {
  const capabilities = getVideoGenerationCapabilities(workspaceId);
  if (!capabilities.configured || !capabilities.provider) throw new Error(capabilities.message ?? "视频生成未配置");
  if (!capabilities.modes.includes(input.mode)) throw new Error("当前 provider 不支持该视频生成模式");
  if (!capabilities.durations.includes(input.durationSeconds)) throw new Error("当前 provider 不支持该视频时长");
  if (!capabilities.resolutions.includes(input.resolution)) throw new Error("当前 provider 不支持该清晰度");
  if (!capabilities.variants.includes(input.variants)) throw new Error("当前 provider 不支持该生成数量");
  if (input.lastFrameAssetId && !capabilities.supportsLastFrame) throw new Error("当前本地模型暂不支持尾帧；云模型支持后开放");
  if (input.mode === "text-to-video" && input.aspectRatio && !capabilities.aspectRatios.includes(input.aspectRatio)) {
    throw new Error("当前 provider 不支持该画面比例");
  }
  const candidates = capabilities.models.filter((model) => model.modes.includes(input.mode));
  const model = input.model === "auto" ? candidates[0]?.id : input.model;
  if (!model || !candidates.some((candidate) => candidate.id === model)) {
    throw new Error("所选模型不支持当前生成模式");
  }
  return { provider: capabilities.provider, model, capabilities };
}

function apiBase(): string {
  const value = getConfigValue("VIDEO_GENERATION_BASE_URL");
  if (!value) throw new Error("视频生成未配置：请设置 VIDEO_GENERATION_BASE_URL");
  const base = value.replace(/\/+$/u, "");
  return base.endsWith("/api/v1") ? base : `${base}/api/v1`;
}

function apiKey(): string {
  const value = getConfigValue("VIDEO_GENERATION_API_KEY");
  if (!value) throw new Error("视频生成未配置：请设置 VIDEO_GENERATION_API_KEY");
  return value;
}

function dashHeaders(asyncTask = false): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey()}`,
    ...(asyncTask ? { "X-DashScope-Async": "enable" } : {}),
    "Content-Type": "application/json",
  };
}

async function assetBytes(actor: MonoActor, assetId: string, signal: AbortSignal): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
  const asset = getMonoAsset(actor, assetId);
  if (!asset) throw new Error("输入帧不存在或不属于当前工作区");
  const mimeType = asset.mimeType?.split(";", 1)[0] || "image/png";
  if (!mimeType.startsWith("image/")) throw new Error("视频输入帧必须是图片素材");
  if (asset.storageKey) {
    return { buffer: await readObjectBuffer(asset.storageKey), mimeType, filename: asset.name ?? `${assetId}.png` };
  }
  if (!/^https?:\/\//iu.test(asset.sourceUrl)) throw new Error("输入帧必须通过素材上传接口登记");
  const response = await fetch(asset.sourceUrl, { signal });
  if (!response.ok) throw new Error(`读取输入帧失败：HTTP ${response.status}`);
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    mimeType: response.headers.get("content-type")?.split(";", 1)[0] || mimeType,
    filename: asset.name ?? `${assetId}.png`,
  };
}

function comfyDimensions(aspectRatio: string | undefined): { width: number; height: number } {
  if (aspectRatio === "9:16") return { width: 480, height: 832 };
  if (aspectRatio === "1:1") return { width: 624, height: 624 };
  return { width: 832, height: 480 };
}

async function comfyI2vDimensions(buffer: Buffer): Promise<{ width: number; height: number }> {
  const metadata = await sharp(buffer).metadata();
  if (!metadata.width || !metadata.height) throw new Error("首帧不是有效图片");
  const scale = Math.sqrt(400_000 / (metadata.width * metadata.height));
  const round32 = (value: number) => Math.max(32, Math.round(value / 32) * 32);
  return { width: round32(metadata.width * scale), height: round32(metadata.height * scale) };
}

function mutateComfyI2vWorkflow(workflow: Record<string, unknown>, firstFrame?: string): void {
  const latent = workflow["55"] as { inputs?: Record<string, unknown> } | undefined;
  if (!latent?.inputs) throw new Error("Wan 2.2 工作流缺少 Wan22ImageToVideoLatent 节点");
  if (firstFrame) {
    const loadImage = workflow["56"] as { inputs?: Record<string, unknown> } | undefined;
    if (!loadImage?.inputs) throw new Error("Wan 2.2 工作流缺少 LoadImage 节点");
    loadImage.inputs.image = firstFrame;
    return;
  }
  delete workflow["56"];
  delete latent.inputs.start_image;
}

const comfyProvider: VideoProvider = {
  id: "comfyui",
  pollIntervalMs: 2_000,
  async submit(input, actor, signal) {
    let firstFrame: string | undefined;
    let dimensions = comfyDimensions(input.aspectRatio);
    if (input.mode === "image-to-video") {
      const source = await assetBytes(actor, input.firstFrameAssetId!, signal);
      firstFrame = await uploadComfyInput(source.buffer, source.filename, source.mimeType, signal);
      dimensions = await comfyI2vDimensions(source.buffer);
    }
    const workflow = await loadComfyWorkflow("wan2.2-ti2v-5b", {
      POSITIVE_PROMPT: input.prompt,
      NEGATIVE_PROMPT: "low quality, blurry, text, watermark, deformed",
      SEED: Math.floor(Math.random() * 2_147_483_647),
      WIDTH: dimensions.width,
      HEIGHT: dimensions.height,
      FRAMES: 121,
      OUTPUT_PREFIX: `workbench/video-${Date.now()}`,
    });
    mutateComfyI2vWorkflow(workflow, firstFrame);
    return { remoteId: await submitComfyWorkflow(workflow, signal) };
  },
  async poll(remoteId, signal) {
    const result = await pollComfyWorkflow(remoteId, signal);
    if (result.status === "succeeded") {
      const file = result.outputs?.find((output) => /\.(mp4|webm|mov)$/iu.test(output.filename)) ?? result.outputs?.[0];
      if (!file) return { status: "failed", stage: "failed", error: "ComfyUI 未返回视频文件" };
      return { status: "succeeded", stage: "downloading", output: file as unknown as Record<string, unknown> };
    }
    return result.status === "failed"
      ? { status: "failed", stage: "failed", error: "ComfyUI 工作流执行失败" }
      : { status: result.status, stage: "generating" };
  },
  async cancel(remoteId, signal) { await cancelComfyWorkflow(remoteId, signal); },
  async download(output, signal) {
    const file = output as unknown as ComfyOutputFile;
    return { buffer: await downloadComfyOutput(file, signal), mimeType: "video/mp4", filename: file.filename };
  },
};

function dashOutput(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function dashError(payload: Record<string, unknown>, fallback: string): string {
  return typeof payload.message === "string" ? payload.message : typeof payload.code === "string" ? payload.code : fallback;
}

const dashscopeProvider: VideoProvider = {
  id: "dashscope-wan",
  pollIntervalMs: 15_000,
  async submit(input, actor, signal) {
    const requestInput: Record<string, unknown> = { prompt: input.prompt };
    if (input.mode === "image-to-video") {
      const media: Array<{ type: "first_frame" | "last_frame"; url: string }> = [];
      for (const [type, assetId] of [["first_frame", input.firstFrameAssetId], ["last_frame", input.lastFrameAssetId]] as const) {
        if (!assetId) continue;
        const source = await assetBytes(actor, assetId, signal);
        media.push({ type, url: await uploadImageToTosAndGetUrl(source.buffer, source.mimeType) });
      }
      requestInput.media = media;
    }
    const parameters: Record<string, unknown> = {
      resolution: input.resolution.toUpperCase(),
      duration: input.durationSeconds,
      prompt_extend: true,
      watermark: false,
    };
    if (input.mode === "text-to-video" && input.aspectRatio) parameters.ratio = input.aspectRatio;
    const response = await fetch(`${apiBase()}/services/aigc/video-generation/video-synthesis`, {
      method: "POST", headers: dashHeaders(true), signal,
      body: JSON.stringify({ model: input.providerModel, input: requestInput, parameters }),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    const output = dashOutput(payload.output);
    const taskId = typeof output.task_id === "string" ? output.task_id : null;
    if (!response.ok || !taskId) throw new Error(dashError(payload, `DashScope 提交失败：HTTP ${response.status}`));
    return { remoteId: taskId };
  },
  async poll(remoteId, signal) {
    const response = await fetch(`${apiBase()}/tasks/${encodeURIComponent(remoteId)}`, { headers: dashHeaders(), signal });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(dashError(payload, `DashScope 轮询失败：HTTP ${response.status}`));
    const output = dashOutput(payload.output);
    const status = output.task_status;
    if (status === "SUCCEEDED") {
      const videoUrl = typeof output.video_url === "string" ? output.video_url : null;
      if (!videoUrl) return { status: "failed", stage: "failed", error: "DashScope 任务成功但没有视频 URL" };
      return { status: "succeeded", stage: "downloading", output: { videoUrl } };
    }
    if (status === "FAILED" || status === "UNKNOWN") return { status: "failed", stage: "failed", error: dashError(output, "DashScope 视频任务失败") };
    if (status === "CANCELED") return { status: "cancelled", stage: "cancelled" };
    return { status: status === "PENDING" ? "queued" : "running", stage: status === "PENDING" ? "queued" : "generating" };
  },
  async cancel(remoteId, signal) {
    const response = await fetch(`${apiBase()}/tasks/${encodeURIComponent(remoteId)}/cancel`, {
      method: "POST", headers: dashHeaders(), signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error(dashError(payload, `DashScope 取消失败：HTTP ${response.status}`));
    }
  },
  async download(output, signal) {
    const videoUrl = typeof output.videoUrl === "string" ? output.videoUrl : null;
    if (!videoUrl) throw new Error("DashScope 未返回可下载的视频 URL");
    const response = await fetch(videoUrl, { signal });
    if (!response.ok) throw new Error(`DashScope 视频归档失败：HTTP ${response.status}`);
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      mimeType: response.headers.get("content-type")?.split(";", 1)[0] || "video/mp4",
      filename: `wan2.7-${Date.now()}.mp4`,
    };
  },
};

export function videoProvider(provider: VideoProviderId): VideoProvider {
  return provider === "comfyui" ? comfyProvider : dashscopeProvider;
}
