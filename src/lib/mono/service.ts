import { randomUUID } from "node:crypto";
import { generateText } from "ai";
import sharp from "sharp";
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
  MonoAssetInput,
  MonoAssetLocation,
  MonoImageAnalysisInput,
  MonoImageGenerationInput,
  MonoImageGenerationResult,
  MonoImageGenerationSlot,
  MonoVideoGenerationInput,
  MonoVideoGenerationResult,
  MonoVideoGenerationSlot,
  MonoJob,
  MonoJobKind,
  MonoMattingInput,
  ProductPipelineInput,
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
import { deleteObject, readObjectBuffer, saveObjectBuffer } from "@/lib/storage";
import { compileSubjectPrompt, subjectIdsFromPrompt } from "./subject-compiler";
import { uploadVideoToTosAndGetUrl } from "./tos";
import {
  resolveVideoGeneration,
  videoProvider,
  type PersistedVideoInput,
} from "./video-provider";
import {
  cancelMonoJob,
  claimMonoJob,
  claimNextMonoJob,
  claimNextProductPipelineJob,
  completeMonoJob,
  createMonoAsset,
  createMonoJob,
  createProductPipelineMonoJob,
  createMonoSubject,
  deleteMonoSubject,
  deleteMonoAssetIfUnreferenced,
  failExpiredProductPipelineJobs,
  failOrRetryMonoJob,
  getMonoAsset,
  getMonoJob,
  getMonoSubject,
  INLINE_WORKER_ID,
  listMonoJobs,
  listGeneratedMonoAssets,
  listMonoJobAssets,
  listUnreferencedMonoAssetsOlderThan,
  linkMonoJobAsset,
  listPurgeableMonoJobIds,
  listMonoSubjects,
  listMonoWorkers,
  monoJobQueueStats,
  purgeMonoJob,
  reclaimExpiredLeases,
  requeueInterruptedMonoJobs,
  renewMonoJobLease,
  setMonoJobFavorite,
  updateMonoJobInput,
  updateMonoJobResult,
  updateMonoSubject,
  upsertMonoWorkerHeartbeat,
  type ClaimJobOptions,
} from "./store";
import {
  productPipelineSchedulingSettings,
  runProductPipeline,
  validateProductPipelineInput,
} from "./product-pipeline";

const MAX_IMAGE_ATTEMPTS = 3;
const controllers = new Map<string, AbortController>();
/**
 * 图片生成任务的软停止标记：只挡「还没发出的下一次尝试/重试」，不打断已经
 * 提交给远端服务的那一次请求——那次调用大概率已经在计费/生成了，硬中断只是
 * 让我们自己看不到结果，图片服务那边并不会因此停下来。见 cancelJob 的说明。
 */
const stopRequested = new Set<string>();
const PRODUCT_PIPELINE_ACTIVE_FOLDERS = productPipelineSchedulingSettings().activeFolders;

/**
 * 每类任务的并发上限。图片生成打的是远端 HTTP 接口，串行排队没有意义
 * （同一个 job 内部的 variants 本来就是并发的）；抠像和视频分析吃 AILAB 那台
 * GPU，多开会互相抢显存，保持单条。
 */
const JOB_CONCURRENCY: Record<MonoJobKind, number> = {
  image_generation: Math.max(1, Number(process.env.MONO_IMAGE_JOB_CONCURRENCY) || 3),
  video_analysis: 1,
  video_generation: 1,
  matting: 1,
  product_pipeline: PRODUCT_PIPELINE_ACTIVE_FOLDERS,
};

/**
 * 架构治理 Phase 4：独立 Worker 队列配置。全部有向后兼容的默认值——不设置
 * 任何一个新环境变量时，行为和 Phase 3 完全一致（inline 模式、失败即
 * failed、不重试）。
 *
 * - MONO_WORKER_MODE=standalone：web 进程的 scheduleMonoWorker() 变成空操作，
 *   只负责入队，认领/执行交给单独跑的 `npm run mono:worker` 进程。默认 inline
 *   （web 进程自己 drain，等价于这之前的唯一模式）。
 * - MONO_JOB_MAX_ATTEMPTS：默认 1，即"失败就 failed，不重试"——跟迁移前
 *   完全一样。大于 1 时，dispatchClaimedJob 的 catch 分支会退避重排队而不是
 *   直接判失败（图片生成每个 slot 自己的 MAX_IMAGE_ATTEMPTS 重试不受这个影响，
 *   那是另一层，只在这里的 catch 兜不住的意外错误上生效）。
 * - MONO_JOB_LEASE_MS：租约时长，默认 5 分钟。
 */
const MONO_WORKER_MODE: "inline" | "standalone" =
  process.env.MONO_WORKER_MODE === "standalone" ? "standalone" : "inline";
const MONO_JOB_MAX_ATTEMPTS = Math.max(1, Number(process.env.MONO_JOB_MAX_ATTEMPTS) || 1);
const MONO_JOB_RETRY_BACKOFF_MS = Math.max(0, Number(process.env.MONO_JOB_RETRY_BACKOFF_MS) || 10_000);
const MONO_JOB_MAX_RETRY_BACKOFF_MS = Math.max(
  MONO_JOB_RETRY_BACKOFF_MS,
  Number(process.env.MONO_JOB_MAX_RETRY_BACKOFF_MS) || 5 * 60 * 1000,
);
const MONO_JOB_LEASE_MS = Math.max(30_000, Number(process.env.MONO_JOB_LEASE_MS) || 5 * 60 * 1000);
const MONO_WORKER_VERSION = process.env.MONO_WORKER_VERSION ?? process.env.npm_package_version ?? "dev";
const PRODUCT_PIPELINE_ORPHANED_ERROR = "商品套图执行服务已中断；为避免重复扣费，任务未自动重跑。已发布的 images 文件不受影响。";

type WorkerState = { started: boolean; scheduled: boolean; inFlight: Record<MonoJobKind, number> };
const emptyInFlight = (): Record<MonoJobKind, number> =>
  ({ image_generation: 0, video_analysis: 0, video_generation: 0, matting: 0, product_pipeline: 0 });

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
  const baseUrl = process.env.WORKBENCH_PUBLIC_URL ?? "http://127.0.0.1:3020";
  return new URL(`/api/workbench/mono/assets/${encodeURIComponent(assetId)}/content`, baseUrl).toString();
}

function getAssetSource(actor: MonoActor, assetId: string): string {
  const asset = getMonoAsset(actor, assetId);
  if (!asset) throw new Error("素材不存在，或不属于当前工作区");
  return asset.storageKey ? publicAssetUrl(asset.id) : asset.sourceUrl;
}

export function createAsset(
  actor: MonoActor,
  input: MonoAssetInput & { storageKey?: string; location?: MonoAssetLocation },
): MonoAsset {
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
  if (input.kind && input.kind !== "generic") {
    throw new MonoHttpError(400, "模特卡请通过主体库的模特卡接口创建");
  }
  const subject = createMonoSubject(actor, { ...input, kind: "generic" });
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
  const subject = getMonoSubject(actor, subjectId);
  if (subject?.kind === "product-model") {
    throw new MonoHttpError(409, "商品套图模特卡请通过主体库的模特卡接口管理");
  }
  return updateMonoSubject(actor, subjectId, patch);
}

export function deleteSubject(actor: MonoActor, subjectId: string): boolean {
  const subject = getMonoSubject(actor, subjectId);
  if (subject?.kind === "product-model") {
    throw new MonoHttpError(409, "商品套图模特卡请通过主体库的模特卡接口管理");
  }
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

export function createProductPipelineJob(actor: MonoActor, input: ProductPipelineInput): MonoJob {
  const resolved = validateProductPipelineInput(input);
  const job = createProductPipelineMonoJob(actor, {
    folderId: input.folderId,
    workflowId: input.workflowId,
    modelPairId: input.modelPairId ?? null,
    onlySlots: input.onlySlots ?? null,
    // The resolved relative path is retained only in the private job record;
    // API responses redact it before leaving the server.
    folderRelativePath: resolved.relativePath,
  }, resolved.folderKey);
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
    return { id: subject.id, name: subject.name, assetId: subject.assetId, sourceUrl: getAssetSource(actor, asset.id) };
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
  const baseUrl = process.env.WORKBENCH_PUBLIC_URL ?? "http://127.0.0.1:3020";
  return new URL(path, baseUrl).toString();
}

export function getJob(actor: MonoActor, jobId: string): MonoJob | null {
  // Browser polling is the only reliable observer if a standalone worker has
  // exited and no replacement was started. Product runs are terminalized,
  // rather than requeued, because another attempt can incur duplicate charges.
  failExpiredProductPipelineJobs(PRODUCT_PIPELINE_ORPHANED_ERROR);
  scheduleMonoWorker();
  return getMonoJob(actor, jobId);
}

export function listJobs(
  actor: MonoActor,
  options: { kind?: MonoJobKind; kinds?: MonoJobKind[]; favoriteOnly?: boolean; limit?: number } = {},
): MonoJob[] {
  if (options.kind === "product_pipeline" || options.kinds?.includes("product_pipeline")) {
    failExpiredProductPipelineJobs(PRODUCT_PIPELINE_ORPHANED_ERROR);
  }
  scheduleMonoWorker();
  return listMonoJobs(actor, options);
}

/**
 * The provider and concrete model are resolved once at submission time and
 * saved in the job input.  A later settings change therefore cannot make a
 * recovered job silently hop to a different, chargeable provider.
 */
export function createVideoGenerationJob(actor: MonoActor, input: MonoVideoGenerationInput): MonoJob {
  const resolved = resolveVideoGeneration(input, actor.workspaceId);
  const assetIds = [input.firstFrameAssetId, input.lastFrameAssetId].filter((value): value is string => Boolean(value));
  for (const assetId of assetIds) {
    const asset = getMonoAsset(actor, assetId);
    if (!asset) throw new MonoHttpError(400, "输入帧不存在或不属于当前工作区");
    if (!asset.mimeType?.toLowerCase().startsWith("image/")) throw new MonoHttpError(400, "视频输入帧必须是图片素材");
  }
  const durableInput: PersistedVideoInput = {
    ...input,
    provider: resolved.provider,
    providerModel: resolved.model,
  };
  const job = createMonoJob(actor, "video_generation", durableInput, input.idempotencyKey);
  // createMonoJob returns the already-persisted object for an idempotent retry.
  // Do not change its asset graph with a different browser request.
  if (job.input === durableInput) {
    if (input.firstFrameAssetId) linkMonoJobAsset(actor, job.id, input.firstFrameAssetId, "video-first-frame", "primary");
    if (input.lastFrameAssetId) linkMonoJobAsset(actor, job.id, input.lastFrameAssetId, "video-last-frame", "primary");
  }
  void cleanupExpiredUnreferencedAssets(actor).catch((error) => console.warn("[mono] 清理未引用上传失败", error));
  scheduleMonoWorker();
  return job;
}

export function listGeneratedAssets(
  actor: MonoActor,
  limit = 24,
  beforeCreatedAt?: number,
): Array<{
  assetId: string;
  jobId: string;
  role: string;
  slotKey: string;
  name?: string;
  mimeType?: string;
  createdAt: number;
  previewUrl: string;
}> {
  return listGeneratedMonoAssets(actor, limit, beforeCreatedAt).map((item) => ({
    assetId: item.assetId,
    jobId: item.jobId,
    role: item.role,
    slotKey: item.slotKey,
    name: item.name,
    mimeType: item.mimeType,
    createdAt: item.createdAt,
    previewUrl: `/api/workbench/mono/assets/${encodeURIComponent(item.assetId)}/content`,
  }));
}

export function setJobFavorite(actor: MonoActor, jobId: string, favorite: boolean): MonoJob | null {
  return setMonoJobFavorite(actor, jobId, favorite);
}

export async function purgeJob(actor: MonoActor, jobId: string): Promise<boolean> {
  const links = listMonoJobAssets(actor, jobId);
  if (!purgeMonoJob(actor, jobId)) return false;
  await Promise.all(links.map(async (link) => {
    const deleted = deleteMonoAssetIfUnreferenced(actor, link.assetId);
    if (deleted.storageKey) await deleteObject(deleted.storageKey);
  }));
  return true;
}

export async function deleteAssetIfUnreferenced(actor: MonoActor, assetId: string): Promise<boolean> {
  const deleted = deleteMonoAssetIfUnreferenced(actor, assetId);
  if (!deleted.deleted) return false;
  if (deleted.storageKey) await deleteObject(deleted.storageKey);
  return true;
}

/** Remove abandoned uploads after 24 hours, while retaining every shared asset. */
export async function cleanupExpiredUnreferencedAssets(actor: MonoActor): Promise<number> {
  let deleted = 0;
  for (const asset of listUnreferencedMonoAssetsOlderThan(actor, Date.now() - 24 * 60 * 60_000)) {
    if (await deleteAssetIfUnreferenced(actor, asset.id)) deleted += 1;
  }
  return deleted;
}

export async function purgeUnfavoriteJobs(actor: MonoActor, kind: MonoJobKind): Promise<number> {
  let deleted = 0;
  for (const jobId of listPurgeableMonoJobIds(actor, kind)) {
    if (await purgeJob(actor, jobId)) deleted += 1;
  }
  return deleted;
}

/**
 * 列表/写操作响应用的瘦身版：入参参考图是 data URL（可达数十 MB），
 * 替换为数量；结果图是远端 URL，保留供缩略图使用。复用参数走单条 GET 取全量。
 */
export function lightenMonoJob(job: MonoJob): MonoJob & { input: { referenceImageCount: number } } {
  const references = Array.isArray(job.input.referenceImageUrls) ? job.input.referenceImageUrls : [];
  const referenceAssetIds = Array.isArray(job.input.referenceAssetIds) ? job.input.referenceAssetIds : [];
  const input = { ...job.input };
  delete input.referenceImageUrls;
  delete input.compiledPrompt;
  // Product paths are needed only by the background runner.  The browser keeps
  // the opaque folderId it submitted, never the resolved share-relative path.
  delete input.folderRelativePath;
  if (Array.isArray(input.subjectSnapshots)) {
    input.subjectSnapshots = input.subjectSnapshots.map((snapshot) => {
      if (typeof snapshot !== "object" || snapshot === null) return snapshot;
      const light = { ...(snapshot as Record<string, unknown>) };
      delete light.sourceUrl;
      return light;
    });
  }
  return { ...job, input: { ...input, referenceImageCount: Math.max(references.length, referenceAssetIds.length) } };
}

export async function cancelJob(actor: MonoActor, jobId: string): Promise<MonoJob | null> {
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

  if (ownedJob.kind === "video_generation" && ownedJob.status === "running") {
    const input = ownedJob.input as Partial<PersistedVideoInput>;
    const slot = Array.isArray(ownedJob.result?.slots)
      ? ownedJob.result?.slots.find((value) => typeof value === "object" && value !== null) as Record<string, unknown> | undefined
      : undefined;
    const providerTaskId = typeof slot?.providerTaskId === "string"
      ? slot.providerTaskId
      : typeof slot?.providerPromptId === "string" ? slot.providerPromptId : undefined;
    // DashScope only accepts PENDING cancellation.  If execution has begun we
    // preserve the real job state and explain the provider rejection to the UI.
    if (input.provider === "dashscope-wan" && providerTaskId && ownedJob.result?.stage !== "queued") {
      return ownedJob;
    }
    if (providerTaskId && input.provider) {
      await videoProvider(input.provider).cancel(providerTaskId, new AbortController().signal);
    }
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
  // standalone 模式下 web 进程只入队，不认领——认领/执行是独立 mono:worker
  // 进程的事，这里提前返回避免两边抢同一批任务（虽然 claim 本身是原子的，
  // 抢了也不会错，但没必要让 web 进程在没人要求它执行的情况下还占着并发位）。
  if (MONO_WORKER_MODE === "standalone") return;
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

const INLINE_CLAIM_OPTIONS: ClaimJobOptions = {
  workerId: INLINE_WORKER_ID,
  leaseMs: MONO_JOB_LEASE_MS,
  workerVersion: MONO_WORKER_VERSION,
};
const workerStartedAt = Date.now();

/**
 * The persistent product claim enforces folder exclusivity and the four-folder
 * global limit across processes.  Other Mono kinds retain their existing
 * queue/lease behavior and get first access to their own independent slots.
 */
function claimNextRunnableMonoJob(
  kinds: readonly MonoJobKind[],
  options: ClaimJobOptions,
): MonoJob | null {
  const nonProductKinds = kinds.filter((kind) => kind !== "product_pipeline");
  const standard = claimNextMonoJob(nonProductKinds, options);
  if (standard) return standard;
  if (!kinds.includes("product_pipeline")) return null;
  return claimNextProductPipelineJob(PRODUCT_PIPELINE_ACTIVE_FOLDERS, options);
}

/**
 * 认领到没有空位为止。这里不 await 任务本身——整个函数是同步的，
 * 所以不会有回调插进来改 inFlight；每个任务结束后自己再叫一次 worker 补位。
 */
function drainMonoJobs(): void {
  try {
    reclaimExpiredLeases();
    upsertMonoWorkerHeartbeat({
      id: INLINE_WORKER_ID,
      mode: "inline",
      pid: process.pid,
      startedAt: workerStartedAt,
      inFlight: worker.inFlight,
    });
    for (;;) {
      const kinds = monoJobKinds.filter((kind) => worker.inFlight[kind] < JOB_CONCURRENCY[kind]);
      if (!kinds.length) return;
      const job = claimNextRunnableMonoJob(kinds, INLINE_CLAIM_OPTIONS);
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
  const job = claimMonoJob(jobId, INLINE_CLAIM_OPTIONS);
  if (job) await dispatchClaimedJob(job);
}

/**
 * 独立 Worker 进程用的一次轮询：先回收租约过期的孤儿任务（可能是别的 worker
 * 异常退出留下的），再按并发上限认领并派发——跟 inline 模式共用同一个
 * dispatchClaimedJob，执行逻辑不重复一份，只是调度者和进程边界不同。
 * 调用方（scripts/mono-worker.ts）负责轮询节奏、心跳节奏和优雅退出。
 */
export async function runStandaloneWorkerTick(
  workerId: string,
  inFlight: Record<MonoJobKind, number>,
  concurrency: Partial<Record<MonoJobKind, number>> = {},
): Promise<number> {
  reclaimExpiredLeases();
  const effectiveConcurrency = { ...JOB_CONCURRENCY, ...concurrency };
  let claimed = 0;
  for (;;) {
    const kinds = monoJobKinds.filter((kind) => inFlight[kind] < effectiveConcurrency[kind]);
    if (!kinds.length) break;
    const job = claimNextRunnableMonoJob(kinds, {
      workerId,
      leaseMs: MONO_JOB_LEASE_MS,
      workerVersion: MONO_WORKER_VERSION,
    });
    if (!job) break;
    claimed += 1;
    inFlight[job.kind] += 1;
    void dispatchClaimedJob(job).finally(() => {
      inFlight[job.kind] -= 1;
    });
  }
  return claimed;
}

export function createEmptyWorkerInFlight(): Record<MonoJobKind, number> {
  return emptyInFlight();
}

export function reportStandaloneWorkerHeartbeat(
  workerId: string,
  inFlight: Record<MonoJobKind, number>,
  startedAt: number,
): void {
  upsertMonoWorkerHeartbeat({
    id: workerId,
    mode: "standalone",
    hostname: process.env.HOSTNAME,
    pid: process.pid,
    startedAt,
    inFlight,
  });
}

export function getMonoJobQueueStats(recentWindow?: number) {
  return monoJobQueueStats(recentWindow);
}

export function listMonoWorkerHeartbeats() {
  return listMonoWorkers();
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
    account: "mono-worker",
    email: "",
    department: null,
    organizationRoles: [],
    workspaceRoles: [],
    permissions: [],
    grants: [],
    displayName: "Mono 异步任务",
  };
  return runWithTenantContext(tenantActor, async () => {
    const controller = new AbortController();
    controllers.set(job.id, controller);
    const leaseOwner = job.leaseOwner;
    const leaseHeartbeat = leaseOwner
      ? setInterval(() => {
        if (renewMonoJobLease(job.id, leaseOwner, MONO_JOB_LEASE_MS)) return;
        // If a worker cannot renew its lease, it must stop before it can
        // publish a stale product stage after another worker has recovered it.
        console.warn(`[mono] 任务 ${job.id} 的租约续期失败，停止当前执行器`);
        controller.abort();
      }, Math.max(10_000, Math.floor(MONO_JOB_LEASE_MS / 3)))
      : null;
    leaseHeartbeat?.unref();
    try {
      if (job.kind === "video_analysis") {
        completeMonoJob(job.id, await runVideoAnalysis(job, controller.signal));
      } else if (job.kind === "video_generation") {
        const result = await runVideoGeneration(job, controller.signal);
        completeMonoJob(
          job.id,
          result as unknown as Record<string, unknown>,
          result.succeeded === 0 ? (result.failed ? "视频生成失败" : undefined) : undefined,
          result.slots.some((slot) => slot.status === "cancelled") ? "cancelled" : undefined,
        );
      } else if (job.kind === "matting") {
        completeMonoJob(job.id, await runMatting(job, controller.signal));
      } else if (job.kind === "product_pipeline") {
        completeMonoJob(job.id, await runProductPipeline(job, controller.signal));
      } else {
        const result = await runImageGenerationBatch(job, controller.signal);
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
        const message = error instanceof Error ? error.message : "Mono 任务执行失败";
        // job.attemptCount 是 claim 时刚自增过的值（1-indexed），退避随次数指数
        // 增长；MONO_JOB_MAX_ATTEMPTS 默认 1，默认行为等价于"失败就 failed"。
        const backoffMs = Math.min(
          MONO_JOB_RETRY_BACKOFF_MS * 2 ** Math.max(0, job.attemptCount - 1),
          MONO_JOB_MAX_RETRY_BACKOFF_MS,
        );
        failOrRetryMonoJob(job.id, message, MONO_JOB_MAX_ATTEMPTS, backoffMs);
      }
    } finally {
      if (leaseHeartbeat) clearInterval(leaseHeartbeat);
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
  linkMonoJobAsset(actor, job.id, resultAsset.id, "matting", "primary");
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
  job: MonoJob,
  signal: AbortSignal,
): Promise<MonoImageGenerationResult> {
  const jobId = job.id;
  const input = { ...job.input };
  const actor = newMonoActor({
    userId: job.userId,
    workspaceId: job.workspaceId,
    traceId: job.traceId,
  });
  const referenceImageUrls = Array.isArray(input.referenceImageUrls)
    ? input.referenceImageUrls.filter((value): value is string => typeof value === "string")
    : [];
  const persistedAssetIds = Array.isArray(input.referenceAssetIds)
    ? input.referenceAssetIds.filter((value): value is string => typeof value === "string")
    : [];
  const persistedReferences = referenceImageUrls.length
    ? await persistImageGenerationReferences(actor, jobId, referenceImageUrls, signal)
    : {
        assetIds: persistedAssetIds,
        urls: await hydrateImageGenerationReferences(actor, jobId, persistedAssetIds),
      };
  input.referenceImageUrls = persistedReferences.urls;
  input.referenceAssetIds = persistedReferences.assetIds;
  const durableInput = { ...input, referenceImageUrls: [] };
  updateMonoJobInput(jobId, durableInput);
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
    let providerUrl: string | undefined;
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
        providerUrl = await runSingleImageGeneration(input, signal);
        break;
      } catch (error) {
        if (signal.aborted) return;
        lastError = error instanceof Error ? error.message : lastError;
      }
    }
    if (!providerUrl) {
      Object.assign(slot, { status: "failed", error: lastError });
      updateMonoJobResult(jobId, snapshot());
      return;
    }

    // The provider call may already be billable. Persistence has its own retry
    // loop so a transient disk/download failure never triggers another image.
    for (let persistAttempt = 1; persistAttempt <= 3; persistAttempt += 1) {
      try {
        const assetId = await persistGeneratedImage(actor, jobId, slot.index, providerUrl, signal);
        Object.assign(slot, {
          status: "succeeded",
          assetId,
          imageUrl: undefined,
          error: undefined,
        });
        updateMonoJobResult(jobId, snapshot());
        return;
      } catch (error) {
        if (signal.aborted) return;
        lastError = error instanceof Error ? error.message : "图片持久化失败";
      }
    }
    Object.assign(slot, { status: "failed", error: `生成成功，但持久化失败：${lastError}` });
    updateMonoJobResult(jobId, snapshot());
  }));
  return snapshot();
}

function videoResultSnapshot(
  input: PersistedVideoInput,
  slot: MonoVideoGenerationSlot,
  stage: string,
): MonoVideoGenerationResult {
  const slots = [{ ...slot }];
  return {
    stage,
    provider: input.provider,
    model: input.providerModel,
    slots,
    succeeded: slot.status === "succeeded" ? 1 : 0,
    failed: slot.status === "failed" ? 1 : 0,
  };
}

/**
 * Remote IDs are checkpointed before the first poll.  A recovered lease reads
 * that checkpoint and resumes polling instead of ever submitting a second
 * provider task, which is vital for DashScope's per-second billing.
 */
async function runVideoGeneration(job: MonoJob, signal: AbortSignal): Promise<MonoVideoGenerationResult> {
  const input = job.input as PersistedVideoInput;
  if (!input.provider || !input.providerModel) throw new Error("视频任务缺少已解析的 provider 配置");
  const actor = newMonoActor({ userId: job.userId, workspaceId: job.workspaceId, traceId: job.traceId });
  const provider = videoProvider(input.provider);
  const previous = job.result;
  const oldSlot = Array.isArray(previous?.slots) && previous?.slots[0] && typeof previous.slots[0] === "object"
    ? previous.slots[0] as Record<string, unknown>
    : undefined;
  const checkpointId = typeof oldSlot?.providerTaskId === "string"
    ? oldSlot.providerTaskId
    : typeof oldSlot?.providerPromptId === "string" ? oldSlot.providerPromptId : undefined;
  const slot: MonoVideoGenerationSlot = {
    index: 0,
    status: "queued",
    ...(typeof oldSlot?.assetId === "string" ? { assetId: oldSlot.assetId } : {}),
    ...(input.provider === "comfyui"
      ? checkpointId ? { providerPromptId: checkpointId } : {}
      : checkpointId ? { providerTaskId: checkpointId } : {}),
  };

  let remoteId = checkpointId;
  if (!remoteId) {
    updateMonoJobResult(job.id, videoResultSnapshot(input, slot, "submitting"));
    remoteId = (await provider.submit(input, actor, signal)).remoteId;
    Object.assign(slot, input.provider === "comfyui" ? { providerPromptId: remoteId } : { providerTaskId: remoteId });
    // This write is deliberately the very next operation after submit.
    updateMonoJobResult(job.id, videoResultSnapshot(input, slot, "queued"));
  }

  const deadline = Date.now() + Math.max(60 * 60_000, Number(process.env.MONO_VIDEO_GENERATION_TIMEOUT_MS) || 0);
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("视频生成已取消");
    const polled = await provider.poll(remoteId, signal);
    if (polled.status === "queued" || polled.status === "running") {
      slot.status = polled.status;
      updateMonoJobResult(job.id, videoResultSnapshot(input, slot, polled.stage));
      await wait(provider.pollIntervalMs, signal);
      continue;
    }
    if (polled.status === "cancelled") {
      slot.status = "cancelled";
      return videoResultSnapshot(input, slot, "cancelled");
    }
    if (polled.status === "failed") {
      slot.status = "failed";
      slot.error = polled.error ?? "视频生成失败";
      return videoResultSnapshot(input, slot, "failed");
    }
    if (!polled.output) throw new Error("视频 provider 成功但没有返回结果");
    updateMonoJobResult(job.id, videoResultSnapshot(input, slot, "downloading"));
    const video = await provider.download(polled.output, signal);
    const filename = video.filename || `video-${job.id}.mp4`;
    const stored = await saveObjectBuffer(video.buffer, filename);
    const asset = createStoredAsset(actor, { storageKey: stored.key, mimeType: video.mimeType, name: filename });
    linkMonoJobAsset(actor, job.id, asset.id, "video-generation", "0");
    Object.assign(slot, { status: "succeeded", assetId: asset.id, error: undefined });
    return videoResultSnapshot(input, slot, "succeeded");
  }
  throw new Error("视频生成超时");
}

async function persistImageGenerationReferences(
  actor: MonoActor,
  jobId: string,
  sourceUrls: string[],
  signal: AbortSignal,
): Promise<{ assetIds: string[]; urls: string[] }> {
  const assetIds: string[] = [];
  const stableUrls: string[] = [];
  for (const [index, sourceUrl] of sourceUrls.entries()) {
    const existingAssetId = assetIdFromContentUrl(sourceUrl);
    const existingAsset = existingAssetId ? getMonoAsset(actor, existingAssetId) : null;
    if (existingAsset?.storageKey) {
      linkMonoJobAsset(actor, jobId, existingAsset.id, "image-reference", String(index));
      assetIds.push(existingAsset.id);
      stableUrls.push(await imageDataUrlFromStoredAsset(actor, existingAsset.id));
      continue;
    }
    const source = await resolveSourceBytes(actor, null, sourceUrl, signal);
    const metadata = await sharp(source.buffer).metadata();
    if (!metadata.width || !metadata.height) throw new Error(`参考图 ${index + 1} 不是有效图片`);
    const mimeType = imageMimeType(source.mimeType, metadata.format);
    const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1] || "png";
    const filename = `image2-reference-${jobId}-${index + 1}.${extension}`;
    const stored = await saveObjectBuffer(source.buffer, filename);
    const asset = createStoredAsset(actor, {
      storageKey: stored.key,
      mimeType,
      name: filename,
    });
    linkMonoJobAsset(actor, jobId, asset.id, "image-reference", String(index));
    assetIds.push(asset.id);
    stableUrls.push(imageDataUrl(source.buffer, mimeType));
  }
  return { assetIds, urls: stableUrls };
}

/**
 * A reclaimed job has only durable asset IDs: its original external URLs are
 * deliberately removed from the database. Rebuild provider-ready data URLs
 * directly from object storage so retrying never depends on a browser session
 * or an externally reachable Workbench URL.
 */
async function hydrateImageGenerationReferences(
  actor: MonoActor,
  jobId: string,
  assetIds: string[],
): Promise<string[]> {
  return Promise.all(assetIds.map(async (assetId, index) => {
    linkMonoJobAsset(actor, jobId, assetId, "image-reference", String(index));
    return imageDataUrlFromStoredAsset(actor, assetId);
  }));
}

async function imageDataUrlFromStoredAsset(actor: MonoActor, assetId: string): Promise<string> {
  const asset = getMonoAsset(actor, assetId);
  if (!asset?.storageKey) {
    throw new Error("参考图持久化素材不存在，无法恢复任务");
  }
  const bytes = await readObjectBuffer(asset.storageKey);
  const metadata = await sharp(bytes).metadata();
  if (!metadata.width || !metadata.height) throw new Error("参考图持久化素材不是有效图片");
  return imageDataUrl(bytes, imageMimeType(asset.mimeType, metadata.format));
}

function imageMimeType(contentType: string | undefined, format: string | undefined): string {
  const normalized = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized?.startsWith("image/")) return normalized === "image/jpg" ? "image/jpeg" : normalized;
  if (format === "jpg" || format === "jpeg") return "image/jpeg";
  if (format) return `image/${format}`;
  return "image/png";
}

function imageDataUrl(bytes: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

function assetIdFromContentUrl(sourceUrl: string): string | null {
  try {
    const pathname = new URL(sourceUrl, "http://127.0.0.1").pathname;
    const match = pathname.match(/\/api\/workbench\/mono\/assets\/([^/]+)\/content$/u);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

async function persistGeneratedImage(
  actor: MonoActor,
  jobId: string,
  index: number,
  sourceUrl: string,
  signal: AbortSignal,
): Promise<string> {
  const source = await resolveSourceBytes(actor, null, sourceUrl, signal);
  const metadata = await sharp(source.buffer).metadata();
  if (!metadata.width || !metadata.height) throw new Error("生成结果不是有效图片");
  const mimeType = source.mimeType?.split(";")[0] || "image/png";
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1] || "png";
  const filename = `image2-${jobId}-${index + 1}.${extension}`;
  const stored = await saveObjectBuffer(source.buffer, filename);
  const asset = createStoredAsset(actor, {
    storageKey: stored.key,
    mimeType,
    name: filename,
  });
  linkMonoJobAsset(actor, jobId, asset.id, "image-generation", String(index));
  return asset.id;
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
    dataScope: overrides.dataScope,
  };
}
