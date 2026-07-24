import { randomUUID } from "node:crypto";
import { generateText } from "ai";
import { visionModel } from "@/lib/models";
import { getConfigValue } from "@/lib/server/api-config";
import {
  runWithTenantContext,
  tenantContext,
} from "@/lib/server/tenant-context";
import { buildImagePromptInstruction } from "@/lib/prompts";
import type {
  MonoActor,
  MonoAsset,
  MonoImageAnalysisInput,
  MonoImageGenerationInput,
  MonoImageGenerationResult,
  MonoImageGenerationSlot,
  MonoJob,
  MonoJobKind,
  MonoMattingInput,
  MonoSubject,
  MonoSubjectInput,
  MonoSubjectPatch,
  MonoSubjectSnapshot,
  MonoVideoAnalysisInput,
} from "./contracts";
import { monoJobKinds } from "./contracts";
import { getMonoImage2Template } from "./image2-templates";
import { MonoHttpError } from "./http";
import {
  downloadComfyOutput,
  loadComfyWorkflow,
  runComfyWorkflow,
  uploadComfyInput,
} from "./comfyui";
import { readObjectBuffer, saveObjectBuffer } from "@/lib/storage";
import { compileSubjectPrompt, subjectIdsFromPrompt } from "./subject-compiler";
import { uploadVideoToTosAndGetUrl } from "./tos";
import {
  cancelMonoJob,
  claimMonoJob,
  claimNextMonoJob,
  completeMonoJob,
  createMonoAsset,
  createMonoJob,
  createMonoSubject,
  deleteMonoSubject,
  failMonoJob,
  getMonoAsset,
  getMonoJob,
  getMonoSubject,
  listMonoJobs,
  listMonoSubjects,
  purgeMonoJob,
  purgeUnfavoriteMonoJobs,
  requeueInterruptedMonoJobs,
  setMonoJobFavorite,
  updateMonoJobResult,
  updateMonoSubject,
} from "./store";

const MAX_IMAGE_ATTEMPTS = 3;
const controllers = new Map<string, AbortController>();
/**
 * 图片生成任务的软停止标记：只挡「还没发出的下一次尝试/重试」，不打断已经
 * 提交给远端服务的那一次请求——那次调用大概率已经在计费/生成了，硬中断只是
 * 让我们自己看不到结果，图片服务那边并不会因此停下来。见 cancelJob 的说明。
 */
const stopRequested = new Set<string>();

/**
 * 每类任务的并发上限。图片生成打的是远端 HTTP 接口，串行排队没有意义
 * （同一个 job 内部的 variants 本来就是并发的）；抠像和视频分析吃 AILAB 那台
 * GPU，多开会互相抢显存，保持单条。
 */
const JOB_CONCURRENCY: Record<MonoJobKind, number> = {
  image_generation: Math.max(1, Number(process.env.MONO_IMAGE_JOB_CONCURRENCY) || 3),
  video_analysis: 1,
  matting: 1,
};

type WorkerState = { started: boolean; scheduled: boolean; inFlight: Record<MonoJobKind, number> };
const emptyInFlight = (): Record<MonoJobKind, number> =>
  ({ image_generation: 0, video_analysis: 0, matting: 0 });

// worker 状态挂在 globalThis 上跨模块实例复用，开发态热更会留下上一版形状的对象。
// 缺字段必须补齐：drain 在 setImmediate 里跑，抛出去没人接，整个队列会静默卡死。
const globalForWorker = globalThis as typeof globalThis & { __monoWorker?: Partial<WorkerState> };
const cachedWorker = (globalForWorker.__monoWorker ??= {});
cachedWorker.started ??= false;
cachedWorker.scheduled ??= false;
cachedWorker.inFlight ??= emptyInFlight();
const worker = cachedWorker as WorkerState;

function imageSource(sourceUrl: string): URL | string {
  return sourceUrl.startsWith("data:") ? sourceUrl : new URL(sourceUrl);
}

/** 存储素材对外的可取回 URL（外部处理服务用它拉取内容）。 */
function publicAssetUrl(assetId: string): string {
  const baseUrl = process.env.WORKBENCH_PUBLIC_URL ?? "http://127.0.0.1:3000";
  return new URL(`/api/workbench/mono/assets/${encodeURIComponent(assetId)}/content`, baseUrl).toString();
}

function getAssetSource(actor: MonoActor, assetId: string): string {
  const asset = getMonoAsset(actor, assetId);
  if (!asset) throw new Error("素材不存在，或不属于当前工作区");
  return asset.storageKey ? publicAssetUrl(asset.id) : asset.sourceUrl;
}

export function createAsset(actor: MonoActor, input: Omit<MonoAsset, "id" | "workspaceId" | "userId" | "createdAt">): MonoAsset {
  return createMonoAsset(actor, input);
}

/** 上传落盘后的素材登记：sourceUrl 用 storage: 哨兵，内容走 content 路由取回。 */
export function createStoredAsset(
  actor: MonoActor,
  input: { storageKey: string; mimeType?: string; name?: string },
): MonoAsset {
  return createMonoAsset(actor, {
    sourceUrl: `storage:${input.storageKey}`,
    mimeType: input.mimeType,
    name: input.name,
    storageKey: input.storageKey,
  });
}

export function createSubject(actor: MonoActor, input: MonoSubjectInput): MonoSubject {
  const subject = createMonoSubject(actor, input);
  if (!subject) throw new MonoHttpError(400, "主体图片素材不存在，或不属于当前工作区");
  return subject;
}

export function listSubjects(actor: MonoActor): MonoSubject[] {
  return listMonoSubjects(actor);
}

export function getSubject(actor: MonoActor, subjectId: string): MonoSubject | null {
  return getMonoSubject(actor, subjectId);
}

export function updateSubject(actor: MonoActor, subjectId: string, patch: MonoSubjectPatch): MonoSubject | null {
  return updateMonoSubject(actor, subjectId, patch);
}

export function deleteSubject(actor: MonoActor, subjectId: string): boolean {
  return deleteMonoSubject(actor, subjectId);
}

export async function analyzeImage(
  actor: MonoActor,
  input: MonoImageAnalysisInput,
): Promise<{ assetId: string | null; prompt: string; traceId: string }> {
  const sourceUrl = input.assetId ? getAssetSource(actor, input.assetId) : input.imageUrl!;
  const instruction = input.outputFormat === "json"
    ? `仅输出一个有效 JSON 对象，不要 Markdown 或额外说明。字段必须包含 subject、style、lighting、composition、color_palette、mood、details、prompt_en、prompt_cn，除 prompt_en 外使用中文。${input.focus ? `特别侧重：${input.focus}` : ""}`
    : buildImagePromptInstruction(input.focus);
  const { text } = await generateText({
    model: visionModel(actor.workspaceId),
    messages: [{
      role: "user",
      content: [
        { type: "text", text: instruction },
        { type: "image", image: imageSource(sourceUrl) },
      ],
    }],
  });
  return { assetId: input.assetId ?? null, prompt: text.trim(), traceId: actor.traceId };
}

export function createVideoAnalysisJob(actor: MonoActor, input: MonoVideoAnalysisInput): MonoJob {
  // 素材引用只存 assetId，不在这里提前解析成 URL——本机上传的视频这时候还没有
  // 公网可达的地址（见 resolveVideoContent），解析工作留到真正执行时按体积分流。
  if (input.assetId && !getMonoAsset(actor, input.assetId)) {
    throw new MonoHttpError(400, "素材不存在，或不属于当前工作区");
  }
  const job = createMonoJob(actor, "video_analysis", {
    assetId: input.assetId ?? null,
    videoUrl: input.assetId ? null : input.videoUrl!,
    focus: input.focus ?? "请总结视频内容、镜头语言、节奏、音频和可复用的创作提示词。",
    model:
      input.model ??
      getConfigValue("MONO_VIDEO_MODEL", actor.workspaceId) ??
      "mono-video-analysis",
  }, input.idempotencyKey);
  scheduleMonoWorker();
  return job;
}

export function createMattingJob(actor: MonoActor, input: MonoMattingInput): MonoJob {
  // 只存引用不存内容：runner 用 job 自带的 actor 信息在执行时解析素材字节。
  if (input.assetId && !getMonoAsset(actor, input.assetId)) {
    throw new MonoHttpError(400, "素材不存在，或不属于当前工作区");
  }
  if (input.backgroundAssetId && !getMonoAsset(actor, input.backgroundAssetId)) {
    throw new MonoHttpError(400, "背景图素材不存在，或不属于当前工作区");
  }
  const job = createMonoJob(actor, "matting", {
    assetId: input.assetId ?? null,
    mediaUrl: input.mediaUrl ?? null,
    mediaType: input.mediaType,
    backgroundColor: input.backgroundColor ?? null,
    backgroundAssetId: input.backgroundAssetId ?? null,
  }, input.idempotencyKey);
  scheduleMonoWorker();
  return job;
}

export function createImageGenerationJob(actor: MonoActor, input: MonoImageGenerationInput): MonoJob {
  const template = getMonoImage2Template(input.templateId);
  if (input.templateId && !template) throw new Error("Image2 模板不存在");

  const orderedSubjectIds = [...new Set([
    ...subjectIdsFromPrompt(input.prompt),
    ...input.subjectIds,
  ])];
  const subjectSnapshots: MonoSubjectSnapshot[] = orderedSubjectIds.map((subjectId) => {
    const subject = getMonoSubject(actor, subjectId);
    if (!subject) throw new MonoHttpError(403, "主体不存在，或当前用户无权使用");
    const asset = getMonoAsset(actor, subject.assetId);
    if (!asset) throw new MonoHttpError(400, `主体“${subject.name}”的图片素材不存在`);
    return { id: subject.id, name: subject.name, assetId: subject.assetId, sourceUrl: asset.sourceUrl };
  });

  let referenceImageUrls: string[];
  if (template?.structuredMode) {
    if (subjectSnapshots.length > 0) throw new MonoHttpError(400, "结构化双槽模板请在槽位中选择主体，不支持内联 @主体");
    const directReferences = [
      ...input.referenceImageUrls,
      ...input.referenceAssetIds.map((assetId) => getAssetSource(actor, assetId)),
    ];
    referenceImageUrls = input.structuredReferences
      ? [
          getAssetSource(actor, input.structuredReferences.productAssetId),
          getAssetSource(actor, input.structuredReferences.sceneAssetId),
        ]
      : directReferences.slice(0, 2);
    if (referenceImageUrls.length !== 2) throw new Error("该模板需要产品图和参考图");
  } else {
    referenceImageUrls = [
      ...(input.templateReferencesEnabled && template?.referenceImageUrl
        ? [absoluteTemplateReference(template.referenceImageUrl)]
        : []),
      ...input.referenceImageUrls,
      ...input.referenceAssetIds.map((assetId) => getAssetSource(actor, assetId)),
      ...subjectSnapshots.map((subject) => subject.sourceUrl),
    ];
  }
  // Structured templates are positional. Preserve both slots even when the
  // user intentionally selects the same source for product and scene.
  if (!template?.structuredMode) referenceImageUrls = [...new Set(referenceImageUrls)];
  if (referenceImageUrls.length > 6) {
    throw new MonoHttpError(400, `参考图与主体图片合计 ${referenceImageUrls.length} 张，最多允许 6 张`);
  }

  const compiledPrompt = compileSubjectPrompt(input.prompt, referenceImageUrls, subjectSnapshots);

  const job = createMonoJob(actor, "image_generation", {
    prompt: input.prompt,
    compiledPrompt,
    subjectIds: orderedSubjectIds,
    subjectSnapshots,
    templateId: template?.id ?? null,
    structuredMode: template?.structuredMode ?? null,
    referenceImageUrls,
    aspectRatio: input.aspectRatio,
    variants: input.variants,
    model:
      template?.model ??
      input.model ??
      getConfigValue("MONO_IMAGE_MODEL", actor.workspaceId) ??
      "gpt-image-2",
  }, input.idempotencyKey);
  scheduleMonoWorker();
  return job;
}

function absoluteTemplateReference(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  const baseUrl = process.env.WORKBENCH_PUBLIC_URL ?? "http://127.0.0.1:3000";
  return new URL(path, baseUrl).toString();
}

export function getJob(actor: MonoActor, jobId: string): MonoJob | null {
  scheduleMonoWorker();
  return getMonoJob(actor, jobId);
}

export function listJobs(
  actor: MonoActor,
  options: { kind?: MonoJobKind; favoriteOnly?: boolean; limit?: number } = {},
): MonoJob[] {
  scheduleMonoWorker();
  return listMonoJobs(actor, options);
}

export function setJobFavorite(actor: MonoActor, jobId: string, favorite: boolean): MonoJob | null {
  return setMonoJobFavorite(actor, jobId, favorite);
}

export function purgeJob(actor: MonoActor, jobId: string): boolean {
  return purgeMonoJob(actor, jobId);
}

export function purgeUnfavoriteJobs(actor: MonoActor, kind: MonoJobKind): number {
  return purgeUnfavoriteMonoJobs(actor, kind);
}

/**
 * 列表/写操作响应用的瘦身版：入参参考图是 data URL（可达数十 MB），
 * 替换为数量；结果图是远端 URL，保留供缩略图使用。复用参数走单条 GET 取全量。
 */
export function lightenMonoJob(job: MonoJob): MonoJob & { input: { referenceImageCount: number } } {
  const references = Array.isArray(job.input.referenceImageUrls) ? job.input.referenceImageUrls : [];
  const input = { ...job.input };
  delete input.referenceImageUrls;
  delete input.compiledPrompt;
  if (Array.isArray(input.subjectSnapshots)) {
    input.subjectSnapshots = input.subjectSnapshots.map((snapshot) => {
      if (typeof snapshot !== "object" || snapshot === null) return snapshot;
      const light = { ...(snapshot as Record<string, unknown>) };
      delete light.sourceUrl;
      return light;
    });
  }
  return { ...job, input: { ...input, referenceImageCount: references.length } };
}

export function cancelJob(actor: MonoActor, jobId: string): MonoJob | null {
  const ownedJob = getMonoJob(actor, jobId);
  if (!ownedJob) return null;

  // 图片生成任务一旦进入 running，当前这次尝试大概率已经把请求发给远端服务、
  // 甚至已经开始计费/生成。硬中断只会让我们自己等不到结果，图片服务那边并不
  // 会因此停下——等于真金白银换了个寂寞。这里改成软停止：只挡住还没发出的
  // 下一次重试/下一个 slot，已经在飞的这一次放它跑完，成了就地留证。
  if (ownedJob.kind === "image_generation" && ownedJob.status === "running") {
    stopRequested.add(jobId);
    return ownedJob;
  }

  const cancelled = cancelMonoJob(actor, jobId);
  if (cancelled?.status === "cancelled") {
    controllers.get(jobId)?.abort();
    controllers.delete(jobId);
    stopRequested.delete(jobId);
  }
  return cancelled;
}

export function scheduleMonoWorker(): void {
  if (!worker.started) {
    requeueInterruptedMonoJobs();
    worker.started = true;
  }
  if (worker.scheduled) return;
  worker.scheduled = true;
  setImmediate(() => {
    worker.scheduled = false;
    drainMonoJobs();
  });
}

/**
 * 认领到没有空位为止。这里不 await 任务本身——整个函数是同步的，
 * 所以不会有回调插进来改 inFlight；每个任务结束后自己再叫一次 worker 补位。
 */
function drainMonoJobs(): void {
  try {
    for (;;) {
      const kinds = monoJobKinds.filter((kind) => worker.inFlight[kind] < JOB_CONCURRENCY[kind]);
      if (!kinds.length) return;
      const job = claimNextMonoJob(kinds);
      if (!job) return;
      worker.inFlight[job.kind] += 1;
      void dispatchClaimedJob(job).finally(() => {
        worker.inFlight[job.kind] -= 1;
        scheduleMonoWorker();
      });
    }
  } catch (error) {
    // 这里是 setImmediate 的栈顶，漏出去就是队列静默卡死，必须留下痕迹。
    console.error("[mono] 任务调度失败，队列可能停摆", error);
  }
}

export async function dispatchJob(jobId: string): Promise<void> {
  const job = claimMonoJob(jobId);
  if (job) await dispatchClaimedJob(job);
}

async function dispatchClaimedJob(job: MonoJob): Promise<void> {
  // The request path already verified membership before persisting the job.
  // Keep that immutable tenant snapshot for asynchronous execution so a
  // membership change does not accidentally move the job to another tenant.
  const tenantActor = {
    userId: job.userId,
    organizationId: "",
    workspaceId: job.workspaceId,
    role: "member" as const,
    email: "",
    displayName: "Mono 异步任务",
  };
  return runWithTenantContext(tenantActor, async () => {
    const controller = new AbortController();
    controllers.set(job.id, controller);
    try {
      if (job.kind === "video_analysis") {
        completeMonoJob(job.id, await runVideoAnalysis(job, controller.signal));
      } else if (job.kind === "matting") {
        completeMonoJob(job.id, await runMatting(job, controller.signal));
      } else {
        const result = await runImageGenerationBatch(job.id, job.input, controller.signal);
        const stopped = stopRequested.has(job.id);
        completeMonoJob(
          job.id,
          result as unknown as Record<string, unknown>,
          result.succeeded === 0 ? (stopped ? "已停止，未生成任何图片" : "全部图片均生成失败") : undefined,
          // 一张都没落地时用 cancelled 而不是 failed：这是用户主动叫停，不是服务出错。
          result.succeeded === 0 && stopped ? "cancelled" : undefined,
        );
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        failMonoJob(job.id, error instanceof Error ? error.message : "Mono 任务执行失败");
      }
    } finally {
      controllers.delete(job.id);
      stopRequested.delete(job.id);
    }
  });
}

const DOUYIN_SHARE_RE = /^https?:\/\/(?:v\.douyin\.com\/[A-Za-z0-9_-]+\/?|www\.douyin\.com\/video\/\d+)/i;

/**
 * 抖音分享链接是网页而非视频文件，先经解析服务换成可直接分析的视频直链。
 * 解析端点复用 Mono veFaaS 的 video/resolve 协议：POST { sourceUrl, platform }。
 * 未显式配置 MONO_VIDEO_RESOLVE_URL 时，按约定从 analyze 端点推导同级路径。
 */
async function resolveShareVideoUrl(sourceUrl: string, apiKey: string, signal: AbortSignal): Promise<string> {
  if (!DOUYIN_SHARE_RE.test(sourceUrl)) return sourceUrl;
  const endpoint = getConfigValue("MONO_VIDEO_RESOLVE_URL")
    ?? getConfigValue("MONO_VIDEO_ANALYZE_URL")?.replace(/\/video\/analyze\/?$/, "/video/resolve");
  if (!endpoint || endpoint === getConfigValue("MONO_VIDEO_ANALYZE_URL")) {
    throw new Error("检测到抖音分享链接，但未配置解析服务：请设置 MONO_VIDEO_RESOLVE_URL");
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ sourceUrl, platform: "douyin" }),
    signal,
  });
  const data = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || data?.success === false) {
    throw new Error(typeof data?.error === "string" ? data.error : `抖音链接解析服务返回 HTTP ${response.status}`);
  }
  const videoUrl = data?.videoUrl ?? data?.downloadUrl;
  if (typeof videoUrl !== "string" || videoUrl.length === 0) throw new Error("抖音链接解析成功，但未返回可分析的视频地址");
  return videoUrl;
}

const MAX_VIDEO_DATA_URL_BYTES = 10 * 1024 * 1024;
const VIDEO_BASE64_OVERHEAD_RATIO = 1.37;

/**
 * 本机上传的视频没有公网可达地址，不能像分享链接那样直接把 URL 丢给远端模型
 * 去拉取（对方服务器连不到 127.0.0.1）。这里对齐 Mono 插件的策略：体积在阈值
 * 内的视频直接把字节内嵌成 data: URI 塞进请求体，完全不需要网络可达；超过阈值
 * 就先传到 TOS，换一个模型能直接拉取的签名下载链接。分享链接解析出来的视频
 * 本身就是公网 CDN 直链，直接把 URL 交给模型自己去拉取即可，不需要内嵌。
 */
async function resolveVideoContent(
  actor: MonoActor,
  input: Record<string, unknown>,
  apiKey: string,
  signal: AbortSignal,
): Promise<string> {
  const assetId = typeof input.assetId === "string" ? input.assetId : null;
  if (assetId) {
    const asset = getMonoAsset(actor, assetId);
    if (!asset) throw new Error("素材不存在，或不属于当前工作区");
    if (asset.storageKey) {
      const buffer = await readObjectBuffer(asset.storageKey);
      const mimeType = asset.mimeType || "video/mp4";
      const estimatedBase64Bytes = buffer.length * VIDEO_BASE64_OVERHEAD_RATIO;
      if (estimatedBase64Bytes <= MAX_VIDEO_DATA_URL_BYTES) {
        return `data:${mimeType};base64,${buffer.toString("base64")}`;
      }
      return uploadVideoToTosAndGetUrl(buffer, mimeType);
    }
    return resolveShareVideoUrl(asset.sourceUrl, apiKey, signal);
  }
  return resolveShareVideoUrl(String(input.videoUrl ?? ""), apiKey, signal);
}

/**
 * 视频分析复用图片反推的视觉模型配置（VISION_*），不再要求单独的
 * MONO_VIDEO_ANALYZE_URL/MONO_VIDEO_API_KEY——那是留给外部 Mono 视频服务的可选覆盖。
 * 走原始 fetch 而非 ai-sdk 的 generateText，是因为 @ai-sdk/openai-compatible
 * 目前只把 file part 的 image 媒体类型映射成 image_url，视频没有对应支持；
 * 而火山方舟（doubao 视觉模型）的 chat/completions 协议原生支持 video_url 内容块。
 */
async function runVideoAnalysis(job: MonoJob, signal: AbortSignal): Promise<Record<string, unknown>> {
  const input = job.input;
  const baseUrl = getConfigValue("MONO_VIDEO_ANALYZE_URL")
    ?? getConfigValue("VISION_BASE_URL")
    ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const apiKey = getConfigValue("MONO_VIDEO_API_KEY") ?? getConfigValue("VISION_API_KEY");
  if (!apiKey) throw new Error("视频分析未配置：请设置 VISION_API_KEY（或 MONO_VIDEO_API_KEY）");
  const model = (typeof input.model === "string" && input.model)
    || getConfigValue("MONO_VIDEO_MODEL")
    || getConfigValue("VISION_MODEL")
    || "qwen-vl-max";
  const actor = newMonoActor({ userId: job.userId, workspaceId: job.workspaceId, traceId: job.traceId });
  const videoUrl = await resolveVideoContent(actor, input, apiKey, signal);
  const endpoint = new URL("chat/completions", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: String(input.focus ?? "请总结视频内容、镜头语言、节奏、音频和可复用的创作提示词。") },
          { type: "video_url", video_url: { url: videoUrl } },
        ],
      }],
    }),
    signal,
  });
  const data = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const message = nestedString(data ?? {}, "error", "message") ?? `视频分析服务返回 HTTP ${response.status}`;
    throw new Error(message);
  }
  const text = extractChatText(data);
  if (!text) throw new Error("视频分析服务没有返回可用结果");
  return { text, model, provider: "vision" };
}

function extractChatText(data: Record<string, unknown> | null): string | null {
  const choices = data?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as Record<string, unknown> | undefined)?.message;
  const content = (message as Record<string, unknown> | undefined)?.content;
  return typeof content === "string" && content.length > 0 ? content : null;
}

type SourceBytes = { buffer: Buffer; filename: string; mimeType?: string };

/** 把素材引用（storage / data URL / http URL）解析成字节，供 ComfyUI 上传。 */
async function resolveSourceBytes(
  actor: MonoActor,
  assetId: string | null,
  url: string | null,
  signal: AbortSignal,
): Promise<SourceBytes> {
  if (assetId) {
    const asset = getMonoAsset(actor, assetId);
    if (!asset) throw new Error("素材不存在，或不属于当前工作区");
    if (asset.storageKey) {
      return {
        buffer: await readObjectBuffer(asset.storageKey),
        filename: asset.name ?? asset.storageKey.slice(3),
        mimeType: asset.mimeType,
      };
    }
    return resolveSourceBytes(actor, null, asset.sourceUrl, signal);
  }
  if (!url) throw new Error("缺少素材来源");
  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/u);
    if (!match) throw new Error("素材内容格式无效");
    const buffer = match[2]
      ? Buffer.from(match[3], "base64")
      : Buffer.from(decodeURIComponent(match[3]), "utf8");
    return { buffer, filename: "input", mimeType: match[1] || undefined };
  }
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`素材下载失败：HTTP ${response.status}`);
  const filename = decodeURIComponent(new URL(url).pathname.split("/").pop() || "input");
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    filename,
    mimeType: response.headers.get("content-type") ?? undefined,
  };
}

const EXTENSION_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
};

function mimeFromFilename(filename: string): string | undefined {
  const extension = filename.match(/\.([0-9a-z]+)$/iu)?.[1]?.toLowerCase();
  return extension ? EXTENSION_MIME[extension] : undefined;
}

async function runMatting(job: MonoJob, signal: AbortSignal): Promise<Record<string, unknown>> {
  const actor = newMonoActor({ userId: job.userId, workspaceId: job.workspaceId, traceId: job.traceId });
  const input = job.input;
  const mediaType = input.mediaType === "video" ? "video" : "image";

  updateMonoJobResult(job.id, { stage: "uploading" });
  const media = await resolveSourceBytes(
    actor,
    typeof input.assetId === "string" ? input.assetId : null,
    typeof input.mediaUrl === "string" ? input.mediaUrl : null,
    signal,
  );
  const values: Record<string, string> = {
    INPUT_MEDIA: await uploadComfyInput(media.buffer, media.filename, media.mimeType, signal),
    BACKGROUND_COLOR: typeof input.backgroundColor === "string" ? input.backgroundColor : "",
    BACKGROUND_MEDIA: "",
  };
  if (typeof input.backgroundAssetId === "string" && input.backgroundAssetId) {
    const background = await resolveSourceBytes(actor, input.backgroundAssetId, null, signal);
    values.BACKGROUND_MEDIA = await uploadComfyInput(background.buffer, background.filename, background.mimeType, signal);
  }

  // 图片走 BiRefNet、视频走 RVM 之类的选择完全由工作流文件决定。
  const workflow = await loadComfyWorkflow(`matting-${mediaType}`, values);
  const outputs = await runComfyWorkflow(workflow, signal, (stage) => updateMonoJobResult(job.id, { stage }));

  updateMonoJobResult(job.id, { stage: "downloading" });
  const primary = outputs[0];
  const stored = await saveObjectBuffer(await downloadComfyOutput(primary, signal), primary.filename);
  const resultAsset = createStoredAsset(actor, {
    storageKey: stored.key,
    mimeType: mimeFromFilename(primary.filename),
    name: primary.filename,
  });
  return {
    assetId: resultAsset.id,
    url: `/api/workbench/mono/assets/${encodeURIComponent(resultAsset.id)}/content`,
    filename: primary.filename,
    mediaType,
    outputs: outputs.length,
    provider: "comfyui",
  };
}

async function runImageGenerationBatch(
  jobId: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<MonoImageGenerationResult> {
  const variants = [1, 2, 4, 6].includes(Number(input.variants)) ? Number(input.variants) : 1;
  const model = typeof input.model === "string" ? input.model : "gpt-image-2";
  const slots: MonoImageGenerationSlot[] = Array.from({ length: variants }, (_, index) => ({
    index,
    status: "generating",
    attempt: 0,
  }));
  const snapshot = () => ({
    slots: slots.map((slot) => ({ ...slot })),
    succeeded: slots.filter((slot) => slot.status === "succeeded").length,
    failed: slots.filter((slot) => slot.status === "failed").length,
    provider: "mono-image",
    model,
  });
  updateMonoJobResult(jobId, snapshot());

  await Promise.all(slots.map(async (slot) => {
    let lastError = "图片生成失败";
    for (let attempt = 1; attempt <= MAX_IMAGE_ATTEMPTS; attempt += 1) {
      if (signal.aborted) return;
      // 只在「即将发起下一次尝试」这个时间点检查软停止——已经在飞的那次调用
      // 不会被这里打断，它会自然跑到 try/catch 里 await 完，结果照样落地。
      if (stopRequested.has(jobId)) {
        Object.assign(slot, { status: "failed", error: "已停止，未再重试" });
        updateMonoJobResult(jobId, snapshot());
        return;
      }
      Object.assign(slot, { status: attempt === 1 ? "generating" : "retrying", attempt, error: undefined });
      updateMonoJobResult(jobId, snapshot());
      try {
        slot.imageUrl = await runSingleImageGeneration(input, signal);
        slot.status = "succeeded";
        updateMonoJobResult(jobId, snapshot());
        return;
      } catch (error) {
        if (signal.aborted) return;
        lastError = error instanceof Error ? error.message : lastError;
      }
    }
    Object.assign(slot, { status: "failed", error: lastError });
    updateMonoJobResult(jobId, snapshot());
  }));
  return snapshot();
}

async function runSingleImageGeneration(input: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  const baseUrl = getConfigValue("MONO_IMAGE_BASE_URL");
  const apiKey = getConfigValue("MONO_IMAGE_API_KEY");
  if (!baseUrl || !apiKey) throw new Error("图片生成未配置：请设置 MONO_IMAGE_BASE_URL 和 MONO_IMAGE_API_KEY");
  const generateUrl = process.env.MONO_IMAGE_GENERATE_URL ?? new URL("/v1/api/generate", baseUrl).toString();
  const response = await fetch(generateUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: input.model,
      prompt: input.compiledPrompt,
      images: input.referenceImageUrls,
      aspectRatio: input.aspectRatio,
      replyType: "json",
    }),
    signal,
  });
  const data = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !data) throw new Error(`图片生成服务返回 HTTP ${response.status}`);
  const imageUrl = extractImageUrl(data);
  if (imageUrl) return imageUrl;

  const taskId = stringAt(data, "id") ?? stringAt(data, "task_id") ?? nestedString(data, "data", "id");
  if (!taskId) throw new Error("图片生成服务没有返回图片或任务 ID");
  const resultBase = process.env.MONO_IMAGE_RESULT_URL ?? new URL("/v1/api/result", baseUrl).toString();
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await wait(3_000, signal);
    const resultResponse = await fetch(`${resultBase}?id=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    const result = await resultResponse.json().catch(() => null) as Record<string, unknown> | null;
    if (!resultResponse.ok || !result) continue;
    const resultUrl = extractImageUrl(result);
    if (resultUrl) return resultUrl;
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
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : null;
}

function nestedString(value: Record<string, unknown>, parent: string, key: string): string | null {
  const candidate = value[parent];
  return typeof candidate === "object" && candidate !== null
    ? stringAt(candidate as Record<string, unknown>, key)
    : null;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("任务已取消"));
    }, { once: true });
  });
}

export function newMonoActor(overrides: Partial<MonoActor> = {}): MonoActor {
  const activeActor = tenantContext()?.actor;
  if (
    process.env.NODE_ENV === "production" &&
    !activeActor &&
    (!overrides.userId || !overrides.workspaceId)
  ) {
    throw new Error("Mono actor requires an authenticated workspace context");
  }
  return {
    userId: overrides.userId ?? activeActor?.userId ?? "local-user",
    workspaceId:
      overrides.workspaceId ?? activeActor?.workspaceId ?? "default",
    sessionId: overrides.sessionId,
    traceId: overrides.traceId ?? `trace_${randomUUID()}`,
  };
}
