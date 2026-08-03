import { describe, expect, it } from "vitest";
import { monoVideoGenerationSchema } from "@/lib/mono/contracts";

const textToVideo = {
  mode: "text-to-video" as const,
  prompt: "A rotating ceramic vase, studio light",
  aspectRatio: "16:9" as const,
  durationSeconds: 5,
  resolution: "480p" as const,
  variants: 1,
  model: "auto",
};

describe("video generation request contract", () => {
  it("accepts the portable text-to-video request", () => {
    expect(monoVideoGenerationSchema.safeParse(textToVideo).success).toBe(true);
  });

  it("requires a prompt without accepting input frames for text-to-video", () => {
    expect(monoVideoGenerationSchema.safeParse({ ...textToVideo, prompt: "" }).success).toBe(false);
    expect(monoVideoGenerationSchema.safeParse({
      ...textToVideo,
      firstFrameAssetId: "asset_11111111-1111-1111-1111-111111111111",
    }).success).toBe(false);
  });

  it("requires a first frame and derives image-to-video aspect ratio from it", () => {
    const imageToVideo = {
      ...textToVideo,
      mode: "image-to-video" as const,
      prompt: "Slow camera dolly",
      aspectRatio: undefined,
      firstFrameAssetId: "asset_11111111-1111-1111-1111-111111111111",
    };
    expect(monoVideoGenerationSchema.safeParse(imageToVideo).success).toBe(true);
    expect(monoVideoGenerationSchema.safeParse({ ...imageToVideo, firstFrameAssetId: undefined }).success).toBe(false);
    expect(monoVideoGenerationSchema.safeParse({ ...imageToVideo, aspectRatio: "9:16" }).success).toBe(false);
  });
});
