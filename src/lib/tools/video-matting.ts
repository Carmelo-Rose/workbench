import { tool } from "ai";
import { z } from "zod";
import { GatewayError, submitJob } from "@/lib/toolbox/gateway";
import { chainTargets } from "@/lib/toolbox/types";

export type VideoMattingArgs = {
  videoFileId: string;
  background?: string;
  note?: string;
};

export type VideoMattingResult = {
  jobId?: string;
  videoFileId?: string;
  note?: string;
  /** 任务完成后卡片真的能续接到的能力名单，来自 chainTargets("matting")；模型只能对这个列表里的能力承诺续接按钮。 */
  continueTargets?: string[];
  error?: string;
};

/**
 * 视频工具箱第三根竖切：人物抠像换背景（RVM 逐帧递归抠像，跑在 AILAB 服务机）。
 * 与 video_enhance 同属非交互型：工具直接把任务提交给网关并把 jobId 交给
 * JobToolUI 卡片，卡片直接进入轮询。
 *
 * 只做视频里的人物抠像+纯色换背景；与 Mono 的 mono_matting（图片抠像/换背景）
 * 是两回事，调用前按输入是图片还是视频区分。
 */
export const videoMattingTool = tool({
  description:
    "对用户上传的视频做人物抠像并替换成纯色背景（RVM）。" +
    "当用户消息中出现「[视频附件 …]」标记（含 fileId）且用户希望抠出视频里的人物、" +
    "或把视频背景换成纯色时调用；这是视频工具，图片抠像请用 mono_matting。" +
    "调用后界面会直接出现进度卡片并开始处理，不需要用户额外操作。",
  inputSchema: z.object({
    videoFileId: z
      .string()
      .describe("视频附件标记中的 fileId，原样传入"),
    background: z
      .string()
      .optional()
      .describe(
        "替换的背景颜色：white/black/green/blue/gray/red 或 #rrggbb 十六进制；" +
          "用户没有明确要求时默认 white",
      ),
    note: z
      .string()
      .optional()
      .describe("可选，一句话描述本次抠像目的，仅作为卡片上的提示文案"),
  }),
  execute: async ({ videoFileId, background, note }): Promise<VideoMattingResult> => {
    try {
      const job = await submitJob({
        capability: "matting",
        params: { background: background?.trim() || "white" },
        inputs: { video: videoFileId },
      });
      return {
        jobId: job.id,
        videoFileId,
        ...(note ? { note } : {}),
        continueTargets: chainTargets("matting").map((c) => c.name),
      };
    } catch (error) {
      return {
        error:
          error instanceof GatewayError
            ? error.message
            : "任务提交失败，请稍后重试",
      };
    }
  },
});
