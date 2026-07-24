import { tool } from "ai";
import { z } from "zod";
import { chainTargets } from "@/lib/toolbox/types";

export type VideoEraseArgs = {
  videoFileId: string;
  note?: string;
};

export type VideoEraseResult = {
  videoFileId?: string;
  note?: string;
  /** 用户框选并提交后卡片真的能续接到的能力名单，来自 chainTargets("smart_erase")；模型只能对这个列表里的能力承诺续接按钮。 */
  continueTargets?: string[];
  error?: string;
};

/**
 * 视频工具箱第一根竖切：智能擦除 v1（固定区域 + ProPainter 补绘，跑在 AILAB 服务机）。
 * 工具本身不提交任务——擦除需要用户在视频首帧上框选区域，而坐标没法经由对话
 * 可靠传递，所以这里只把 videoFileId 交给 JobToolUI 卡片，由卡片完成
 * 框选 → 提交 → 轮询进度 → 展示结果的整个闭环。
 */
export const videoEraseTool = tool({
  description:
    "对用户上传的视频发起智能擦除（去除字幕、水印、台标、贴纸等固定区域内容）。" +
    "当用户消息中出现「[视频附件 …]」标记（含 fileId）且用户希望擦除视频中的内容时调用。" +
    "调用后界面会出现操作卡片，用户在卡片中的视频首帧上框选要擦除的区域并启动任务；" +
    "你不需要、也无法提供区域坐标。",
  inputSchema: z.object({
    videoFileId: z
      .string()
      .describe("视频附件标记中的 fileId，原样传入"),
    note: z
      .string()
      .optional()
      .describe("可选，用户想擦除的内容的一句话描述，仅作为卡片上的提示文案"),
  }),
  execute: async ({ videoFileId, note }): Promise<VideoEraseResult> => {
    return {
      videoFileId,
      ...(note ? { note } : {}),
      continueTargets: chainTargets("smart_erase").map((c) => c.name),
    };
  },
});
