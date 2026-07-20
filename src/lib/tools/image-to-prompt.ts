import { tool } from "ai";
import { z } from "zod";
import { analyzeImage, newMonoActor } from "@/lib/mono/service";

export type ImageToPromptArgs = {
  imageUrl?: string;
  focus?: string;
};

export type ImageToPromptResult = {
  imageUrl: string;
  prompt: string;
};

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
    description:
      "把当前对话附件或指定图片反推成可用于 AI 文生图的中文提示词。有当前图片附件时直接调用，不要向用户索取 URL。",
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
    execute: async ({ imageUrl, focus }): Promise<ImageToPromptResult> => {
      const resolvedImageUrl = imageUrl ?? attachedImageUrl;
      if (!resolvedImageUrl) {
        throw new Error("请先上传图片，或提供可访问的图片 URL");
      }
      const result = await analyzeImage(newMonoActor(), {
        imageUrl: resolvedImageUrl,
        focus,
        outputFormat: "prompt",
      });
      return { imageUrl: resolvedImageUrl, prompt: result.prompt };
    },
  });
}
