import { z } from "zod";
import { monoImage2TemplateIds } from "./image2-templates";

export const monoJobKinds = ["video_analysis", "image_generation", "matting", "product_pipeline"] as const;
export const monoJobStatuses = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export const monoActorSchema = z.object({
  userId: z.string().min(1).max(120),
  workspaceId: z.string().min(1).max(120),
  sessionId: z.string().min(1).max(160).optional(),
  traceId: z.string().min(1).max(160),
});

export const monoAssetInputSchema = z.object({
  sourceUrl: z.string().min(1).max(30_000_000),
  mimeType: z.string().max(160).optional(),
  name: z.string().max(255).optional(),
});

/**
 * 素材实际内容存在哪：本地对象存储、Toolbox 网关、火山 TOS，或纯外部直链。
 * `storageKey`/Toolbox `fileId`/TOS key 仍是各自的内部定位器，`location` 只是
 * 标注去哪找——调用方统一认 `assetId`，不需要关心这些差异（架构治理 Phase 2）。
 */
export const monoAssetLocations = ["local-storage", "toolbox", "tos", "remote-url"] as const;
export type MonoAssetLocation = (typeof monoAssetLocations)[number];

export const monoImageAnalysisSchema = z.object({
  assetId: z.string().min(1).optional(),
  imageUrl: z.string().min(1).max(10_000_000).optional(),
  focus: z.string().max(800).optional(),
  outputFormat: z.enum(["prompt", "json"]).default("prompt"),
}).refine((input) => Boolean(input.assetId || input.imageUrl), {
  message: "assetId 或 imageUrl 至少提供一个",
});

export const monoVideoAnalysisSchema = z.object({
  assetId: z.string().min(1).optional(),
  videoUrl: z.string().url().optional(),
  focus: z.string().max(1_000).optional(),
  model: z.string().max(160).optional(),
  idempotencyKey: z.string().min(1).max(180).optional(),
}).refine((input) => Boolean(input.assetId || input.videoUrl), {
  message: "assetId 或 videoUrl 至少提供一个",
});

/** 工具层用 base（附件可在 execute 时兜底注入），API 层用带 refine 的完整版。 */
export const monoMattingBaseSchema = z.object({
  assetId: z.string().min(1).optional(),
  mediaUrl: z.string().url().optional(),
  mediaType: z.enum(["image", "video"]).default("image"),
  /** 换背景：纯色（#RRGGBB）留空则输出透明背景。 */
  backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/u, "背景色必须是 #RRGGBB").optional(),
  /** 换背景：已登记的背景图素材。 */
  backgroundAssetId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).max(180).optional(),
});

export const monoMattingSchema = monoMattingBaseSchema.refine(
  (input) => Boolean(input.assetId || input.mediaUrl),
  { message: "assetId 或 mediaUrl 至少提供一个" },
);

export const monoAspectRatios = ["1:1", "3:4", "9:16", "4:3", "16:9"] as const;
export const monoImageVariants = [1, 2, 4, 6] as const;
export const monoImageSlotStatuses = ["generating", "retrying", "succeeded", "failed"] as const;
export const monoSubjectVisibilities = ["private", "workspace"] as const;
/** Subject-library classification; product-model cards are still ordinary subjects. */
export const monoSubjectKinds = ["generic", "product-model"] as const;

const monoSubjectNameSchema = z.string().trim().min(1).max(40).refine(
  (value) => !/[\n\r\[\]{}@]/u.test(value),
  "主体名称不能包含换行、@、[] 或 {}",
);

export const monoSubjectInputSchema = z.object({
  name: monoSubjectNameSchema,
  assetId: z.string().min(1),
  visibility: z.enum(monoSubjectVisibilities).default("private"),
  kind: z.enum(monoSubjectKinds).default("generic"),
});

export const monoSubjectPatchSchema = z.object({
  name: monoSubjectNameSchema.optional(),
  visibility: z.enum(monoSubjectVisibilities).optional(),
}).refine((input) => input.name !== undefined || input.visibility !== undefined, {
  message: "至少提供一个需要更新的主体字段",
});

const referenceSourceSchema = z.string().min(1).max(30_000_000).refine(
  (value) => value.startsWith("data:image/") || value.startsWith("http://") || value.startsWith("https://"),
  "参考图必须是 http(s) URL 或图片 data URL",
);

export const monoImageGenerationSchema = z.object({
  prompt: z.string().min(1).max(8_000),
  templateId: z.enum(monoImage2TemplateIds).optional(),
  templateReferencesEnabled: z.boolean().default(true),
  referenceAssetIds: z.array(z.string().min(1)).max(6).default([]),
  referenceImageUrls: z.array(referenceSourceSchema).max(6).default([]),
  structuredReferences: z.object({
    productAssetId: z.string().min(1),
    sceneAssetId: z.string().min(1),
  }).optional(),
  /** Ordered workspace subject references. The service resolves and snapshots them. */
  subjectIds: z.array(z.string().min(1)).max(6).default([]),
  aspectRatio: z.enum(monoAspectRatios).default("1:1"),
  variants: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(6)]).default(1),
  model: z.string().max(160).optional(),
  idempotencyKey: z.string().min(1).max(180).optional(),
});

/** The browser never submits a path. `folderId` is an opaque server-issued id. */
export const productPipelineWorkflowId = "hat-62604171-v1" as const;
export const productPipelineInputSchema = z.object({
  // Base64url IDs for short folder names (for example `123`) can be four
  // characters long. Security comes from server-side containment validation.
  folderId: z.string().min(1).max(2_000),
  // One template bundle used to be the only option, so this was a z.literal.
  // Now any installed bundle can be picked; membership is re-checked at
  // runtime against installedWorkflowIds() (product-pipeline.ts), since the
  // installed set isn't knowable from this schema alone.
  workflowId: z.string().min(1).max(160),
  // Optional for compatibility with older jobs and the language-model tool.
  // The formal folder picker requires it and the runner validates workspace
  // ownership before doing any work.
  modelPairId: z.string().regex(/^pair_[0-9a-f-]{36}$/u).optional(),
  // Retry-only-the-failures entry point. Membership in the model-kind slot set
  // is re-checked server-side (product-pipeline.ts) since that set isn't
  // knowable from this schema alone.
  onlySlots: z.array(z.string().regex(/^\d{2}$/u, "槽位编号必须是两位数字")).min(1).max(11).optional(),
});

export const monoImageGenerationSlotSchema = z.object({
  index: z.number().int().min(0),
  status: z.enum(monoImageSlotStatuses),
  attempt: z.number().int().min(0),
  assetId: z.string().regex(/^asset_[0-9a-f-]{36}$/u).optional(),
  /** Legacy provider URL. New successful slots are addressed by assetId. */
  imageUrl: z.string().optional(),
  error: z.string().optional(),
});

export const monoImageGenerationResultSchema = z.object({
  slots: z.array(monoImageGenerationSlotSchema),
  succeeded: z.number().int().min(0),
  failed: z.number().int().min(0),
  provider: z.string(),
  model: z.string(),
});

export type MonoActor = z.infer<typeof monoActorSchema>;
export type MonoAssetInput = z.infer<typeof monoAssetInputSchema>;
export type MonoImageAnalysisInput = z.infer<typeof monoImageAnalysisSchema>;
export type MonoVideoAnalysisInput = z.infer<typeof monoVideoAnalysisSchema>;
export type MonoMattingInput = z.infer<typeof monoMattingSchema>;
export type MonoImageGenerationInput = z.infer<typeof monoImageGenerationSchema>;
export type ProductPipelineInput = z.infer<typeof productPipelineInputSchema>;
export type MonoImageGenerationSlot = z.infer<typeof monoImageGenerationSlotSchema>;
export type MonoImageGenerationResult = z.infer<typeof monoImageGenerationResultSchema>;
/** Input remains backward-compatible: omitted kind/visibility use their schema defaults. */
export type MonoSubjectInput = z.input<typeof monoSubjectInputSchema>;
export type MonoSubjectPatch = z.infer<typeof monoSubjectPatchSchema>;
export type MonoSubjectVisibility = (typeof monoSubjectVisibilities)[number];
export type MonoSubjectKind = (typeof monoSubjectKinds)[number];
export type MonoJobKind = (typeof monoJobKinds)[number];
export type MonoJobStatus = (typeof monoJobStatuses)[number];

export type MonoAsset = MonoAssetInput & {
  id: string;
  workspaceId: string;
  userId: string;
  /** 落在本地对象存储时的 key；此时 sourceUrl 为 storage:<key> 哨兵。 */
  storageKey?: string;
  location: MonoAssetLocation;
  createdAt: number;
};

export type MonoJobAsset = {
  jobId: string;
  workspaceId: string;
  assetId: string;
  role: string;
  slotKey: string;
  createdAt: number;
};

export type MonoSubject = {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  name: string;
  assetId: string;
  kind: MonoSubjectKind;
  visibility: MonoSubjectVisibility;
  createdAt: number;
  updatedAt: number;
};

export type MonoSubjectSnapshot = Pick<MonoSubject, "id" | "name" | "assetId"> & {
  sourceUrl: string;
};

export type MonoJob = {
  id: string;
  workspaceId: string;
  userId: string;
  kind: MonoJobKind;
  status: MonoJobStatus;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  idempotencyKey: string | null;
  traceId: string;
  favorite: boolean;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  /** 架构治理 Phase 4：当前持有租约的 worker id（inline 模式下是固定的进程内标识）。 */
  leaseOwner: string | null;
  /** 租约到期时间——过期仍是 running 的任务会被判定为孤儿，重新入队。 */
  leaseExpiresAt: number | null;
  /** 已认领执行过的次数，从 0 开始；重试退避判断依据 MONO_JOB_MAX_ATTEMPTS。 */
  attemptCount: number;
  /** 重试退避：非空时表示这个任务在这个时间点之前不参与认领。 */
  nextRunAt: number | null;
  /** 最后一次认领它的 worker 所在的构建/版本标识，供排障时区分是哪版代码跑的。 */
  workerVersion: string | null;
};
