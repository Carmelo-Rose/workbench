import { tool } from "ai";
import { z } from "zod";
import { analyzeImage, newMonoActor } from "@/lib/mono/service";
import { runCapabilityCommand } from "@/lib/workbench/capability-bus";
import { getCapability, isCapabilityBusEnabled } from "@/lib/workbench/capability-registry";

export type ImageToPromptArgs = {
  imageUrl?: string;
  focus?: string;
};

export type ImageToPromptResult = {
  imageUrl: string;
  prompt: string;
};

const CAPABILITY_ID = "image_to_prompt";

/**
 * 第一根竖切的工具：图 → 提示词。
 * 内部调用视觉模型（Qwen-VL 等），把一张图反推成中文文生图提示词。
 * 复用了 Mono 插件里 callQwenAPI 的思路——本质就是给视觉模型发图 + 反推指令。
 */
/**
 * Attachments are UIMessage file parts, not text available for a model to copy
 * into tool JSON. The route supplies the latest image as this fallback so a
 * user can simply say “分析这张图”.
 */
export function createImageToPromptTool(attachedImageUrl?: string) {
  return tool({
    description: getCapability(CAPABILITY_ID)!.chatToolDescription,
    inputSchema: z.object({
      imageUrl: z
        .string()
        .optional()
        .describe("可选：图片 http(s) URL 或 data: URL；当前附件会自动使用"),
      focus: z
        .string()
        .optional()
        .describe("可选，用户希望侧重的方向，例如画风、镜头、配色"),
    }),
    // 架构治理 Phase 3：走 runCapabilityCommand 分发，但同步能力的结果形状
    // （{assetId, prompt, traceId}）跟这个工具历史上返回的 {imageUrl, prompt}
    // 不同——这里手动摘取 prompt 字段拼回原有形状，不直接透传 run.result。
    execute: async ({ imageUrl, focus }): Promise<ImageToPromptResult> => {
      const resolvedImageUrl = imageUrl ?? attachedImageUrl;
      if (!resolvedImageUrl) {
        throw new Error("请先上传图片，或提供可访问的图片 URL");
      }
      const actor = newMonoActor();
      const input = { imageUrl: resolvedImageUrl, focus, outputFormat: "prompt" as const };
      if (!isCapabilityBusEnabled(CAPABILITY_ID)) {
        const result = await analyzeImage(actor, input);
        return { imageUrl: resolvedImageUrl, prompt: result.prompt };
      }
      const run = await runCapabilityCommand({ capabilityId: CAPABILITY_ID, input, assetIds: [], actor });
      const result = run.result as { prompt: string };
      return { imageUrl: resolvedImageUrl, prompt: result.prompt };
    },
  });
}
