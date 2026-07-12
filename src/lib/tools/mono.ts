import { tool } from "ai";
import {
  monoAssetInputSchema,
  monoImageGenerationSchema,
  monoSubjectInputSchema,
  monoSubjectPatchSchema,
  monoVideoAnalysisSchema,
} from "@/lib/mono/contracts";
import {
  cancelJob,
  createAsset,
  createImageGenerationJob,
  createSubject,
  createVideoAnalysisJob,
  getJob,
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
      description: "创建视频音画分析任务。适用于用户提供视频 URL 或已登记视频素材，并希望分析内容、镜头、节奏、音频或提示词时调用。",
      inputSchema: monoVideoAnalysisSchema,
      execute: (input) => createVideoAnalysisJob(actor, input),
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
    mono_generate_image: tool({
      description: "直接创建 Image2 图片生成任务。支持模板、多参考图、结构化双参考图、画面比例，以及一次生成 1、2、4 或 6 张图片。",
      inputSchema: monoImageGenerationSchema,
      execute: (input) => createImageGenerationJob(actor, input),
    }),
    mono_get_job: tool({
      description: "查询 Mono 视频分析或图片生成任务的进度和结果。",
      inputSchema: z.object({ jobId: z.string().min(1) }),
      execute: ({ jobId }) => {
        const job = getJob(actor, jobId);
        if (!job) throw new Error("Mono 任务不存在，或不属于当前工作区");
        return job;
      },
    }),
    mono_cancel_job: tool({
      description: "取消仍在排队或运行中的 Mono 任务。",
      inputSchema: z.object({ jobId: z.string().min(1) }),
      execute: ({ jobId }) => {
        const job = cancelJob(actor, jobId);
        if (!job) throw new Error("Mono 任务不存在，或不属于当前工作区");
        return job;
      },
    }),
  };
}
