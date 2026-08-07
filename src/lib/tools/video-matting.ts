import { tool } from "ai";
import { z } from "zod";
import { GatewayError, submitJob } from "@/lib/toolbox/gateway";
import { chainTargets } from "@/lib/toolbox/types";

export type VideoMattingArgs = {
  videoFileId: string;
  background?: string;
  mode?: string;
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

const MATTING_MODES = ["auto", "human", "general"] as const;

/**
 * 收敛成适配器认识的三个值。适配器自己也会把不认识的值回落成 auto，这里再收一道
 * 是为了让落库的 params 干净可读——任务列表和重试都直接复用这份 params。
 */
function normalizeMode(mode?: string): string {
  const v = mode?.trim().toLowerCase() ?? "";
  return (MATTING_MODES as readonly string[]).includes(v) ? v : "auto";
}

/**
 * 视频工具箱第三根竖切：抠像换背景（跑在 AILAB 服务机）。
 * 与 video_enhance 同属非交互型：工具直接把任务提交给网关并把 jobId 交给
 * JobToolUI 卡片，卡片直接进入轮询。
 *
 * 两种模式：human 走 RVM（只认人像），general 走 BiRefNet 首帧 + MatAnyone 传播
 * （主体类别无关）。默认 auto，由适配器采样探测后自己选——模型从对话里未必判断
 * 得出主体是不是人，而选错的代价不对称（把非人当人会输出一整片背景色）。
 *
 * 只做视频；与 Mono 的 mono_matting（图片抠像/换背景）是两回事，调用前按输入是
 * 图片还是视频区分。
 */
export const videoMattingTool = tool({
  description:
    "对用户上传的视频做主体抠像并替换成纯色背景，人物和非人物（动物、商品、任意物体）都支持。" +
    "当用户消息中出现「[视频附件 …]」标记（含 fileId）且用户希望抠出视频里的主体、" +
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
    mode: z
      .string()
      .optional()
      .describe(
        "抠像模式：auto（默认，自动判定主体是不是人）、human（只抠人像，速度更快）、" +
          "general（任意主体，动物/商品/物体走这个）。" +
          "除非用户明确说了主体是什么，否则不要填，留给 auto 判定",
      ),
    note: z
      .string()
      .optional()
      .describe("可选，一句话描述本次抠像目的，仅作为卡片上的提示文案"),
  }),
  execute: async ({
    videoFileId,
    background,
    mode,
    note,
  }): Promise<VideoMattingResult> => {
    try {
      const job = await submitJob({
        capability: "matting",
        params: {
          background: background?.trim() || "white",
          mode: normalizeMode(mode),
        },
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
