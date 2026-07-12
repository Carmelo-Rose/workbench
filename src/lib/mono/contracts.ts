import { z } from "zod";
import { monoImage2TemplateIds } from "./image2-templates";

export const monoJobKinds = ["video_analysis", "image_generation"] as const;
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

export const monoAspectRatios = ["1:1", "3:4", "9:16", "4:3", "16:9"] as const;
export const monoImageVariants = [1, 2, 4, 6] as const;
export const monoImageSlotStatuses = ["generating", "retrying", "succeeded", "failed"] as const;
export const monoSubjectVisibilities = ["private", "workspace"] as const;

const monoSubjectNameSchema = z.string().trim().min(1).max(40).refine(
  (value) => !/[\n\r\[\]{}@]/u.test(value),
  "主体名称不能包含换行、@、[] 或 {}",
);

export const monoSubjectInputSchema = z.object({
  name: monoSubjectNameSchema,
  assetId: z.string().min(1),
  visibility: z.enum(monoSubjectVisibilities).default("private"),
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

export const monoImageGenerationSlotSchema = z.object({
  index: z.number().int().min(0),
  status: z.enum(monoImageSlotStatuses),
  attempt: z.number().int().min(0),
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
export type MonoImageGenerationInput = z.infer<typeof monoImageGenerationSchema>;
export type MonoImageGenerationSlot = z.infer<typeof monoImageGenerationSlotSchema>;
export type MonoImageGenerationResult = z.infer<typeof monoImageGenerationResultSchema>;
export type MonoSubjectInput = z.infer<typeof monoSubjectInputSchema>;
export type MonoSubjectPatch = z.infer<typeof monoSubjectPatchSchema>;
export type MonoSubjectVisibility = (typeof monoSubjectVisibilities)[number];
export type MonoJobKind = (typeof monoJobKinds)[number];
export type MonoJobStatus = (typeof monoJobStatuses)[number];

export type MonoAsset = MonoAssetInput & {
  id: string;
  workspaceId: string;
  userId: string;
  createdAt: number;
};

export type MonoSubject = {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  name: string;
  assetId: string;
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
};
