import { tool } from "ai";
import {
  monoAssetInputSchema,
  monoImageGenerationSchema,
  monoMattingBaseSchema,
  monoSubjectInputSchema,
  monoSubjectPatchSchema,
  monoVideoAnalysisSchema,
  type MonoJob,
} from "@/lib/mono/contracts";
import {
  cancelJob,
  createAsset,
  createImageGenerationJob,
  createMattingJob,
  createProductPipelineJob,
  createSubject,
  createVideoAnalysisJob,
  getJob,
  lightenMonoJob,
  listSubjects,
  newMonoActor,
  deleteSubject,
  updateSubject,
} from "@/lib/mono/service";
import { resolveProductFolderByName, WORKFLOW_ID } from "@/lib/mono/product-pipeline";
import { z } from "zod";
import { runCapabilityCommand } from "@/lib/workbench/capability-bus";
import { getCapability, isCapabilityBusEnabled } from "@/lib/workbench/capability-registry";
import { MonoHttpError } from "@/lib/mono/http";
import type { MonoActor } from "@/lib/mono/contracts";

type MonoToolContext = {
  sessionId?: string;
  userId?: string;
  workspaceId?: string;
  /** 最近一条用户消息里的图片附件，供抠像等工具在缺少显式素材时兜底。 */
  attachmentUrl?: string;
  /**
   * 从最近一条用户消息文本里用正则确定性提取出的 asset_<uuid> 引用。
   * 模型自己在工具参数里手抄这个 36 位 UUID 容易转录出错，
   * 这里优先信任服务端的确定性提取，而不是模型的复述。
   */
  videoAssetId?: string;
  assetScope?: "own" | "workspace";
  subjectViewScope?: "own" | "workspace";
  subjectManageScope?: "own" | "workspace";
  taskViewScope?: "own" | "workspace";
  taskManageScope?: "own" | "workspace";
};

/**
 * 架构治理 Phase 3：三个已注册进 CAPABILITY_REGISTRY 的能力（视频分析/抠像/
 * 生图）改为经 runCapabilityCommand 分发，而不是各自直连 mono/service.ts；
 * 异步能力用 run.id 回查一次完整 MonoJob 还原成迁移前的返回形状——工具结果会
 * 整段落进 assistant-ui 的消息历史，形状变化会直接破坏 MonoToolUI 卡片渲染，
 * 所以这里不能像 /api/mono/* 那样只保证 JSON 响应体兼容，必须是同一个 TS 类型。
 * isCapabilityBusEnabled 提供按能力回滚开关，禁用时退回旧的直连调用。
 */
async function runJobCapability(
  capabilityId: string,
  actor: MonoActor,
  input: unknown,
  assetIds: string[],
  fallback: () => MonoJob,
): Promise<MonoJob> {
  if (!isCapabilityBusEnabled(capabilityId)) return fallback();
  const run = await runCapabilityCommand({ capabilityId, input, assetIds, actor });
  const job = getJob(actor, run.id);
  if (!job) throw new MonoHttpError(500, `${capabilityId} 任务创建后未能读取`);
  return job;
}

/** One registry powers direct AI SDK tools and the MCP adapter's business calls. */
export function createMonoTools(context: MonoToolContext = {}) {
  const actor = newMonoActor({
    sessionId: context.sessionId,
    userId: context.userId,
    workspaceId: context.workspaceId,
  });
  const assetActor = { ...actor, dataScope: context.assetScope };
  const subjectViewActor = { ...actor, dataScope: context.subjectViewScope };
  const subjectManageActor = { ...actor, dataScope: context.subjectManageScope };
  const taskViewActor = { ...actor, dataScope: context.taskViewScope };
  const taskManageActor = { ...actor, dataScope: context.taskManageScope };

  return {
    mono_create_asset: tool({
      description: "登记一个图片或视频素材，供后续 Mono 分析或生成工具使用。支持 http(s) URL 或 data: URL。",
      inputSchema: monoAssetInputSchema,
      execute: (input) => createAsset(actor, input),
    }),
    mono_analyze_video: tool({
      description: getCapability("mono_analyze_video")!.chatToolDescription,
      inputSchema: monoVideoAnalysisSchema,
      execute: (input) => {
        const mergedInput = { ...input, assetId: context.videoAssetId ?? input.assetId };
        return runJobCapability(
          "mono_analyze_video",
          actor,
          mergedInput,
          mergedInput.assetId ? [mergedInput.assetId] : [],
          () => createVideoAnalysisJob(actor, mergedInput),
        );
      },
    }),
    mono_list_subjects: tool({
      description: "列出当前用户可用的私有主体和工作区共享主体。",
      inputSchema: z.object({}),
      execute: () => listSubjects(subjectViewActor),
    }),
    mono_create_subject: tool({
      description: "把已登记的单张图片素材保存为可复用主体，默认仅创建者可见。",
      inputSchema: monoSubjectInputSchema,
      execute: (input) => createSubject(actor, input),
    }),
    mono_update_subject: tool({
      description: "重命名主体或修改主体的私有/工作区共享状态。只有创建者可以修改。",
      inputSchema: monoSubjectPatchSchema.and(z.object({ subjectId: z.string().min(1) })),
      execute: ({ subjectId, ...patch }) => {
        const subject = updateSubject(subjectManageActor, subjectId, patch);
        if (!subject) throw new Error("主体不存在，或只有创建者可以修改");
        return subject;
      },
    }),
    mono_delete_subject: tool({
      description: "删除可复用主体记录，不删除底层图片素材。只有创建者可以删除。",
      inputSchema: z.object({ subjectId: z.string().min(1) }),
      execute: ({ subjectId }) => ({ deleted: deleteSubject(subjectManageActor, subjectId) }),
    }),
    mono_matting: tool({
      description: `${getCapability("mono_matting")!.chatToolDescription}用户直接发图片附件时可都不填。`,
      inputSchema: monoMattingBaseSchema,
      execute: async (input) => {
        let assetId = input.assetId;
        if (!assetId && !input.mediaUrl) {
          if (!context.attachmentUrl) throw new Error("请提供素材 id、媒体 URL，或直接附上图片");
          assetId = createAsset(actor, { sourceUrl: context.attachmentUrl, mimeType: "image/*" }).id;
        }
        const mergedInput = { ...input, assetId };
        return runJobCapability(
          "mono_matting",
          assetActor,
          mergedInput,
          assetId ? [assetId] : [],
          () => createMattingJob(assetActor, mergedInput),
        );
      },
    }),
    mono_generate_image: tool({
      description: getCapability("mono_generate_image")!.chatToolDescription,
      inputSchema: monoImageGenerationSchema,
      // 工具结果会整段落进消息历史，之后每一轮都原样回发给模型——参考图是
      // base64 data URL，一张就有 2MB+，必须瘦身，否则几轮内就能把上下文塞爆。
      // 前端卡片展示走的是 /api/workbench/mono/jobs/{id} 的独立轮询（未瘦身），
      // 不受这里影响；「再次生成」需要完整参考图时会另外发起一次 GET 去补。
      execute: async (input) => lightenMonoJob(await runJobCapability(
        "mono_generate_image",
        actor,
        input,
        [],
        () => createImageGenerationJob(actor, input),
      )),
    }),
    mono_product_pipeline: tool({
      description:
        "为一个商品文件夹生成白底主图和 11 张详情套图（帽子品类）。" +
        "**会调用付费生图服务**：一次完整运行要生成 7 张模特图，每张都花钱，并且会把成品写进共享盘覆盖同名文件。" +
        "用户明确要求「跑某个货号 / 生成商品套图」时才调用，不要为了查看结果或确认状态而调用——查状态用 mono_get_job。" +
        "folderName 传用户说的货号即可（如「1234」）；名字对不上或匹配到多个时工具会报错并列出候选，把候选转达给用户确认，不要自己挑一个。" +
        "onlySlots 只在用户要求重跑指定的失败槽位时传，取值是模特槽位号（01、03–08）。",
      inputSchema: z.object({
        folderName: z.string().min(1).describe("商品文件夹名，通常就是货号，例如 1234"),
        onlySlots: z.array(z.string().regex(/^\d{2}$/u)).min(1).max(7).optional()
          .describe("只重跑这些模特槽位，例如 [\"04\",\"08\"]。不传则完整跑一遍"),
      }),
      execute: async ({ folderName, onlySlots }) => {
        const folder = await resolveProductFolderByName(folderName);
        return lightenMonoJob(createProductPipelineJob(actor, {
          folderId: folder.id,
          workflowId: WORKFLOW_ID,
          onlySlots,
        }));
      },
    }),
    mono_get_job: tool({
      description: "查询 Mono 任务（视频分析、图片生成、抠像、商品套图）的进度和结果。查状态一律用这个，不要重新发起任务。",
      inputSchema: z.object({ jobId: z.string().min(1) }),
      execute: async ({ jobId }) => {
        const job = getJob(taskViewActor, jobId);
        if (!job) throw new Error("Mono 任务不存在，或不属于当前工作区");
        return lightenMonoJob(job);
      },
    }),
    mono_cancel_job: tool({
      description: "取消仍在排队或运行中的 Mono 任务。",
      inputSchema: z.object({ jobId: z.string().min(1) }),
      execute: async ({ jobId }) => {
        const job = await cancelJob(taskManageActor, jobId);
        if (!job) throw new Error("Mono 任务不存在，或不属于当前工作区");
        return lightenMonoJob(job);
      },
    }),
  };
}
