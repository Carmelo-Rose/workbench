import { tool } from "ai";
import {
  monoAssetInputSchema,
  monoImageGenerationSchema,
  monoMattingBaseSchema,
  monoSubjectInputSchema,
  monoSubjectPatchSchema,
  monoVideoAnalysisSchema,
} from "@/lib/mono/contracts";
import {
  cancelJob,
  createAsset,
  createImageGenerationJob,
  createMattingJob,
  createSubject,
  createVideoAnalysisJob,
  getJob,
  lightenMonoJob,
  listSubjects,
  newMonoActor,
  deleteSubject,
  updateSubject,
} from "@/lib/mono/service";
import { z } from "zod";

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
};

/** One registry powers direct AI SDK tools and the MCP adapter's business calls. */
export function createMonoTools(context: MonoToolContext = {}) {
  const actor = newMonoActor({
    sessionId: context.sessionId,
    userId: context.userId,
    workspaceId: context.workspaceId,
  });

  return {
    mono_create_asset: tool({
      description: "登记一个图片或视频素材，供后续 Mono 分析或生成工具使用。支持 http(s) URL 或 data: URL。",
      inputSchema: monoAssetInputSchema,
      execute: (input) => createAsset(actor, input),
    }),
    mono_analyze_video: tool({
      description: "创建视频音画分析任务。适用于用户提供视频直链、抖音分享链接或已登记视频素材，并希望分析内容、镜头、节奏、音频或提示词时调用。",
      inputSchema: monoVideoAnalysisSchema,
      execute: (input) => createVideoAnalysisJob(actor, {
        ...input,
        assetId: context.videoAssetId ?? input.assetId,
      }),
    }),
    mono_list_subjects: tool({
      description: "列出当前用户可用的私有主体和工作区共享主体。",
      inputSchema: z.object({}),
      execute: () => listSubjects(actor),
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
        const subject = updateSubject(actor, subjectId, patch);
        if (!subject) throw new Error("主体不存在，或只有创建者可以修改");
        return subject;
      },
    }),
    mono_delete_subject: tool({
      description: "删除可复用主体记录，不删除底层图片素材。只有创建者可以删除。",
      inputSchema: z.object({ subjectId: z.string().min(1) }),
      execute: ({ subjectId }) => ({ deleted: deleteSubject(actor, subjectId) }),
    }),
    mono_matting: tool({
      description: "人物/主体抠像换背景任务。输入已登记素材 id 或公开媒体 URL（图片、视频均可）；用户直接发图片附件时可都不填。可选纯色背景（#RRGGBB）或背景图素材，缺省输出透明背景。",
      inputSchema: monoMattingBaseSchema,
      execute: (input) => {
        let assetId = input.assetId;
        if (!assetId && !input.mediaUrl) {
          if (!context.attachmentUrl) throw new Error("请提供素材 id、媒体 URL，或直接附上图片");
          assetId = createAsset(actor, { sourceUrl: context.attachmentUrl, mimeType: "image/*" }).id;
        }
        return createMattingJob(actor, { ...input, assetId });
      },
    }),
    mono_generate_image: tool({
      description: "直接创建 Image2 图片生成任务。支持模板、多参考图、结构化双参考图、画面比例，以及一次生成 1、2、4 或 6 张图片。",
      inputSchema: monoImageGenerationSchema,
      // 工具结果会整段落进消息历史，之后每一轮都原样回发给模型——参考图是
      // base64 data URL，一张就有 2MB+，必须瘦身，否则几轮内就能把上下文塞爆。
      // 前端卡片展示走的是 /api/workbench/mono/jobs/{id} 的独立轮询（未瘦身），
      // 不受这里影响；「再次生成」需要完整参考图时会另外发起一次 GET 去补。
      execute: (input) => lightenMonoJob(createImageGenerationJob(actor, input)),
    }),
    mono_get_job: tool({
      description: "查询 Mono 视频分析或图片生成任务的进度和结果。",
      inputSchema: z.object({ jobId: z.string().min(1) }),
      execute: ({ jobId }) => {
        const job = getJob(actor, jobId);
        if (!job) throw new Error("Mono 任务不存在，或不属于当前工作区");
        return lightenMonoJob(job);
      },
    }),
    mono_cancel_job: tool({
      description: "取消仍在排队或运行中的 Mono 任务。",
      inputSchema: z.object({ jobId: z.string().min(1) }),
      execute: ({ jobId }) => {
        const job = cancelJob(actor, jobId);
        if (!job) throw new Error("Mono 任务不存在，或不属于当前工作区");
        return lightenMonoJob(job);
      },
    }),
  };
}
