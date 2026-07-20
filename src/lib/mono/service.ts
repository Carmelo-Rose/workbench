import { randomUUID } from "node:crypto";
import { generateText } from "ai";
import { visionModel } from "@/lib/models";
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

type WorkerState = { started: boolean; draining: boolean; scheduled: boolean };
const globalForWorker = globalThis as typeof globalThis & { __monoWorker?: WorkerState };
const worker = globalForWorker.__monoWorker ??= { started: false, draining: false, scheduled: false };

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
    model: visionModel(),
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
  const videoUrl = input.assetId ? getAssetSource(actor, input.assetId) : input.videoUrl!;
  const job = createMonoJob(actor, "video_analysis", {
    videoUrl,
    focus: input.focus ?? "请总结视频内容、镜头语言、节奏、音频和可复用的创作提示词。",
    model: input.model ?? process.env.MONO_VIDEO_MODEL ?? "mono-video-analysis",
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
    model: template?.model ?? input.model ?? process.env.MONO_IMAGE_MODEL ?? "gpt-image-2-vip",
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
  const cancelled = cancelMonoJob(actor, jobId);
  if (cancelled?.status === "cancelled") {
    controllers.get(jobId)?.abort();
    controllers.delete(jobId);
  }
  return cancelled;
}

export function scheduleMonoWorker(): void {
  if (!worker.started) {
    requeueInterruptedMonoJobs();
    worker.started = true;
  }
  if (worker.scheduled || worker.draining) return;
  worker.scheduled = true;
  setImmediate(() => {
    worker.scheduled = false;
    void drainMonoJobs();
  });
}

async function drainMonoJobs(): Promise<void> {
  if (worker.draining) return;
  worker.draining = true;
  try {
    for (;;) {
      const job = claimNextMonoJob();
      if (!job) break;
      await dispatchClaimedJob(job);
    }
  } finally {
    worker.draining = false;
  }
}

export async function dispatchJob(jobId: string): Promise<void> {
  const job = claimMonoJob(jobId);
  if (job) await dispatchClaimedJob(job);
}

async function dispatchClaimedJob(job: MonoJob): Promise<void> {
  const controller = new AbortController();
  controllers.set(job.id, controller);
  try {
    if (job.kind === "video_analysis") {
      completeMonoJob(job.id, await runVideoAnalysis(job.input, controller.signal));
    } else if (job.kind === "matting") {
      completeMonoJob(job.id, await runMatting(job, controller.signal));
    } else {
      const result = await runImageGenerationBatch(job.id, job.input, controller.signal);
      completeMonoJob(
        job.id,
        result as unknown as Record<string, unknown>,
        result.succeeded === 0 ? "全部图片均生成失败" : undefined,
      );
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      failMonoJob(job.id, error instanceof Error ? error.message : "Mono 任务执行失败");
    }
  } finally {
    controllers.delete(job.id);
  }
}

async function runVideoAnalysis(input: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
  const endpoint = process.env.MONO_VIDEO_ANALYZE_URL;
  const apiKey = process.env.MONO_VIDEO_API_KEY;
  if (!endpoint || !apiKey) throw new Error("视频分析未配置：请设置 MONO_VIDEO_ANALYZE_URL 和 MONO_VIDEO_API_KEY");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ videoUrl: input.videoUrl, prompt: input.focus, model: input.model }),
    signal,
  });
  const data = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || data?.success === false) {
    throw new Error(typeof data?.error === "string" ? data.error : `视频分析服务返回 HTTP ${response.status}`);
  }
  const text = data?.data ?? data?.text ?? data?.result;
  if (typeof text !== "string" || text.length === 0) throw new Error("视频分析服务没有返回可用结果");
  return { text, model: data?.model ?? input.model, provider: data?.upstream ?? "mono-video" };
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
  const model = typeof input.model === "string" ? input.model : "gpt-image-2-vip";
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
  const baseUrl = process.env.MONO_IMAGE_BASE_URL;
  const apiKey = process.env.MONO_IMAGE_API_KEY;
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
  return {
    userId: overrides.userId ?? "local-user",
    workspaceId: overrides.workspaceId ?? "default",
    sessionId: overrides.sessionId,
    traceId: overrides.traceId ?? `trace_${randomUUID()}`,
  };
}
