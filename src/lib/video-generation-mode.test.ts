import { afterEach, describe, expect, it } from "vitest";
import {
  createVideoGenerationDraft,
  useVideoGenerationMode,
  validateVideoGenerationDraft,
} from "@/lib/video-generation-mode";

afterEach(() => useVideoGenerationMode.getState().reset());

describe("video generation mode", () => {
  it("keeps only a real-job-ready draft as local state", () => {
    expect(createVideoGenerationDraft()).toMatchObject({
      kind: "image-to-video",
      aspectRatio: "16:9",
      durationSeconds: 5,
      resolution: "720p",
      variants: 1,
      model: "auto",
    });
    expect(useVideoGenerationMode.getState()).not.toHaveProperty("job");
  });

  it("requires text for t2v and a file or persisted asset for i2v", () => {
    const textDraft = createVideoGenerationDraft();
    textDraft.kind = "text-to-video";
    expect(validateVideoGenerationDraft(textDraft, " ")).toBe("请先描述画面、动作和镜头语言。");
    expect(validateVideoGenerationDraft(textDraft, "a product rotates")).toBeUndefined();

    const imageDraft = createVideoGenerationDraft();
    expect(validateVideoGenerationDraft(imageDraft, "")).toBe("图生视频需要先添加首帧。");
    imageDraft.firstFrameAssetId = "asset_11111111-1111-1111-1111-111111111111";
    expect(validateVideoGenerationDraft(imageDraft, "")).toBeUndefined();
  });

  it("switches mode without retaining impossible input-frame fields", () => {
    const mode = useVideoGenerationMode.getState();
    mode.activate();
    mode.setFrame("firstFrame", { name: "first.png" } as File);
    mode.setKind("text-to-video");
    mode.setAspectRatio("9:16");
    mode.setDurationSeconds(10);
    mode.setResolution("480p");
    mode.setVariants(1);
    mode.setModel("wan2.7-t2v-2026-06-12");

    expect(useVideoGenerationMode.getState()).toMatchObject({
      active: true,
      draft: { kind: "text-to-video", aspectRatio: "9:16", durationSeconds: 10, resolution: "480p", variants: 1 },
    });
  });

  it("restores reusable job parameters as asset IDs rather than files", () => {
    const prompt = useVideoGenerationMode.getState().restoreFromInput({
      mode: "image-to-video",
      prompt: "camera circles product",
      durationSeconds: 5,
      resolution: "480p",
      variants: 1,
      model: "wan2.2-ti2v-5b",
      firstFrameAssetId: "asset_11111111-1111-1111-1111-111111111111",
      lastFrameAssetId: "asset_22222222-2222-2222-2222-222222222222",
    });
    expect(prompt).toBe("camera circles product");
    expect(useVideoGenerationMode.getState().draft).toMatchObject({
      firstFrameAssetId: "asset_11111111-1111-1111-1111-111111111111",
      lastFrameAssetId: "asset_22222222-2222-2222-2222-222222222222",
    });
  });
});
