import type { z } from "zod";
import type { MonoActor, MonoJob, MonoJobKind } from "@/lib/mono/contracts";
import {
  monoImageAnalysisSchema,
  monoImageGenerationSchema,
  monoMattingSchema,
  monoVideoAnalysisSchema,
} from "@/lib/mono/contracts";
import {
  analyzeImage,
  createImageGenerationJob,
  createMattingJob,
  createVideoAnalysisJob,
} from "@/lib/mono/service";

export type CapabilityAssetKind = "image" | "video";

/**
 * 一个能力 = 一份 Schema + 一个执行入口。以后新增能力只加一条注册项，
 * 不改聊天主路由——这是架构治理计划里"能力注册表"的第一版骨架。
 *
 * 本轮只把现有四个 Mono 能力包一层适配器（`runSync`/`runAsync` 直接调用
 * `mono/service.ts` 里未改动过的原函数），不改行为、不接管聊天路由的分发
 * （那是 Phase 3「入口迁移」的事）。`tools/mono.ts`、`tools/image-to-prompt.ts`
 * 里的 AI SDK 工具定义暂时保持独立、不指回这里，避免本轮引入聊天链路风险；
 * 两边描述文本本轮出现重复，留给 Phase 3 收口。
 */
export type CapabilityDefinition<TInput = unknown> = {
  id: string;
  mode: "sync" | "async";
  /** 这个能力接受哪类素材作为输入引用，供未来 UI/校验使用；本轮不强制校验。 */
  assetKinds: CapabilityAssetKind[];
  /** 聊天工具描述的单一来源（Phase 3 前，tools/ 目录暂不指回这里）。 */
  chatToolDescription: string;
  inputSchema: z.ZodType<TInput>;
  /** 同步能力：直接算出结果，不落 job/不可通过 GET /capability-runs/:id 再查。 */
  runSync?: (actor: MonoActor, input: TInput) => Promise<unknown>;
  /** 异步能力：落一条 mono_jobs 记录，交给现有 Worker 调度執行。 */
  runAsync?: (actor: MonoActor, input: TInput) => MonoJob;
  /**
   * 异步能力对应的 mono_jobs.kind——job 表本身不记 capabilityId，
   * GET/cancel 用这个反查 capabilityId 塞进响应体。
   */
  jobKind?: MonoJobKind;
};

// Registry entries intentionally erase their individual schema input types at this lookup boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CAPABILITY_REGISTRY: Record<string, CapabilityDefinition<any>> = {
  image_to_prompt: {
    id: "image_to_prompt",
    mode: "sync",
    assetKinds: ["image"],
    chatToolDescription:
      "把图片反推成可用于 AI 文生图的中文提示词。有当前图片附件时直接调用，不要向用户索取 URL。",
    inputSchema: monoImageAnalysisSchema,
    runSync: (actor, input) => analyzeImage(actor, input),
  },
  mono_analyze_video: {
    id: "mono_analyze_video",
    mode: "async",
    assetKinds: ["video"],
    chatToolDescription:
      "创建视频音画分析任务。适用于用户提供视频直链、抖音分享链接或已登记视频素材，并希望分析内容、镜头、节奏、音频或提示词时调用。",
    inputSchema: monoVideoAnalysisSchema,
    runAsync: (actor, input) => createVideoAnalysisJob(actor, input),
    jobKind: "video_analysis",
  },
  mono_matting: {
    id: "mono_matting",
    mode: "async",
    assetKinds: ["image", "video"],
    chatToolDescription:
      "人物/主体抠像换背景任务。输入已登记素材 id 或公开媒体 URL（图片、视频均可）。可选纯色背景（#RRGGBB）或背景图素材，缺省输出透明背景。",
    inputSchema: monoMattingSchema,
    runAsync: (actor, input) => createMattingJob(actor, input),
    jobKind: "matting",
  },
  mono_generate_image: {
    id: "mono_generate_image",
    mode: "async",
    assetKinds: ["image"],
    chatToolDescription:
      "创建 Image2 图片生成任务。支持模板、多参考图、结构化双参考图、画面比例，以及一次生成 1、2、4 或 6 张图片。",
    inputSchema: monoImageGenerationSchema,
    runAsync: (actor, input) => createImageGenerationJob(actor, input),
    jobKind: "image_generation",
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getCapability(capabilityId: string): CapabilityDefinition<any> | undefined {
  return CAPABILITY_REGISTRY[capabilityId];
}

export function capabilityIdForJobKind(kind: MonoJobKind): string | undefined {
  return Object.values(CAPABILITY_REGISTRY).find((capability) => capability.jobKind === kind)?.id;
}

/**
 * Phase 3「入口迁移」的按能力回滚开关：把 capabilityId 加进
 * WORKBENCH_CAPABILITY_BUS_DISABLED（逗号分隔）后，已迁移的入口（/api/mono/*、
 * 聊天工具）会跳过命令总线，退回迁移前直接调用 mono/service.ts 的旧路径——
 * 不需要发版即可单独回滚某一个能力，其余能力不受影响。读取的是环境变量，
 * 每次调用都重新读，方便测试里用 process.env 直接切换。
 */
export function isCapabilityBusEnabled(capabilityId: string): boolean {
  const disabled = (process.env.WORKBENCH_CAPABILITY_BUS_DISABLED ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return !disabled.includes(capabilityId);
}
