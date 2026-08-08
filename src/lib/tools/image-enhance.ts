import { tool } from "ai";
import { z } from "zod";
import { GatewayError, submitJob } from "@/lib/toolbox/gateway";
import { chainTargets } from "@/lib/toolbox/types";

export type ImageEnhanceArgs = { imageFileId: string; outscale?: number | string; faceEnhance?: boolean | string; denoise?: number | string; note?: string };
export type ImageEnhanceResult = { jobId?: string; imageFileId?: string; note?: string; continueTargets?: string[]; error?: string };

export const imageEnhanceTool = tool({
  description: "Enhance an uploaded image with Real-ESRGAN and optional GFPGAN face restoration.",
  inputSchema: z.object({
    imageFileId: z.string().describe("The image attachment fileId."),
    outscale: z.union([z.number(), z.string()]).optional().describe("Scale: 2 or 4; defaults to 4."),
    faceEnhance: z.union([z.boolean(), z.string()]).optional().describe("Enable face restoration for portraits."),
    denoise: z.union([z.number(), z.string()]).optional().describe("Denoise strength from 0 to 1; defaults to 1."),
    note: z.string().optional(),
  }),
  execute: async ({ imageFileId, outscale, faceEnhance, denoise, note }): Promise<ImageEnhanceResult> => {
    const safeOutscale = Number(outscale) === 2 ? 2 : 4;
    const safeFace = faceEnhance === true || faceEnhance === "true";
    const rawDenoise = Number(denoise);
    const safeDenoise = Number.isFinite(rawDenoise) ? Math.min(1, Math.max(0, rawDenoise)) : 1;
    try {
      const job = await submitJob({ capability: "image_enhance", params: { outscale: safeOutscale, face_enhance: safeFace, denoise: safeDenoise }, inputs: { image: imageFileId } });
      return { jobId: job.id, imageFileId, ...(note ? { note } : {}), continueTargets: chainTargets("image_enhance").map((c) => c.name) };
    } catch (error) {
      return { error: error instanceof GatewayError ? error.message : "任务提交失败，请稍后重试" };
    }
  },
});
