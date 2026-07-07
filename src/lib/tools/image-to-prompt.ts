import { generateText, tool } from "ai";
import { z } from "zod";
import { visionModel } from "@/lib/models";
import { buildImagePromptInstruction } from "@/lib/prompts";

export type ImageToPromptArgs = {
  imageUrl: string;
  focus?: string;
};

export type ImageToPromptResult = {
  imageUrl: string;
  prompt: string;
};

/**
 * 第一根竖切的工具：图 → 提示词。
 * 内部调用视觉模型（Qwen-VL 等），把一张图反推成中英双语的文生图提示词。
 * 复用了 Mono 插件里 callQwenAPI 的思路——本质就是给视觉模型发图 + 反推指令。
 */
export const imageToPromptTool = tool({
  description:
    "根据一张图片反推出可用于 AI 文生图的中英双语提示词。当用户提供了图片的 http(s) URL 或 data: URL，并希望得到绘画提示词时调用。",
  inputSchema: z.object({
    imageUrl: z
      .string()
      .describe("要反推提示词的图片，可访问的 http(s) URL 或 data: URL"),
    focus: z
      .string()
      .optional()
      .describe("可选，用户希望侧重的方向，例如 画风、镜头、配色"),
  }),
  execute: async ({ imageUrl, focus }): Promise<ImageToPromptResult> => {
    const image = imageUrl.startsWith("data:") ? imageUrl : new URL(imageUrl);
    const { text } = await generateText({
      model: visionModel(),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: buildImagePromptInstruction(focus) },
            { type: "image", image },
          ],
        },
      ],
    });
    return { imageUrl, prompt: text.trim() };
  },
});
