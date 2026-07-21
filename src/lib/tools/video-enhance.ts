import { tool } from "ai";
import { z } from "zod";
import { GatewayError, submitJob } from "@/lib/toolbox/gateway";

export type VideoEnhanceArgs = {
  videoFileId: string;
  outscale?: number | string;
  note?: string;
};

export type VideoEnhanceResult = {
  jobId?: string;
  videoFileId?: string;
  note?: string;
  error?: string;
};

/**
 * 视频工具箱第二根竖切：修复增强（Real-ESRGAN 逐帧超分，跑在 AILAB 服务机）。
 * 与 video_erase 不同，这个能力不需要用户交互式框选——工具直接把任务提交给
 * 网关并把 jobId 交给 JobToolUI 卡片，卡片直接进入轮询，跳过框选步骤。
 */
export const videoEnhanceTool = tool({
  description:
    "对用户上传的视频发起修复增强（分辨率放大、去噪、压缩伪影修复）。" +
    "当用户消息中出现「[视频附件 …]」标记（含 fileId）且用户希望提升视频清晰度/画质/分辨率时调用。" +
    "调用后界面会直接出现进度卡片并开始处理，不需要用户额外操作。",
  inputSchema: z.object({
    videoFileId: z
      .string()
      .describe("视频附件标记中的 fileId，原样传入"),
    // 部分模型会把数字参数序列化成字符串（如 "4"），这里放宽入参类型、
    // 在 execute 里统一转数字再校验，避免 schema 直接拒收整个工具调用。
    outscale: z
      .union([z.number(), z.string()])
      .optional()
      .describe("放大倍数，2 或 4（数字或数字字符串均可）；用户没有明确要求时默认 4"),
    note: z
      .string()
      .optional()
      .describe("可选，一句话描述本次增强目的，仅作为卡片上的提示文案"),
  }),
  execute: async ({ videoFileId, outscale, note }): Promise<VideoEnhanceResult> => {
    const safeOutscale = Number(outscale) === 2 ? 2 : 4;
    try {
      const job = await submitJob({
        capability: "video_enhance",
        params: { outscale: safeOutscale },
        inputs: { video: videoFileId },
      });
      return { jobId: job.id, videoFileId, ...(note ? { note } : {}) };
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
