import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createVideoGenerationDraft,
  useVideoGenerationMode,
  validateVideoGenerationDraft,
} from "@/lib/video-generation-mode";

afterEach(() => {
  useVideoGenerationMode.getState().reset();
  vi.unstubAllGlobals();
});

/** Minimal window.localStorage stand-in — this suite runs under the "node" vitest environment. */
function stubLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
}

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

  it("scopes the current-job pointer per thread, not just per workspace", () => {
    stubLocalStorage();
    const mode = useVideoGenerationMode.getState();

    mode.setCurrentJob("ws_1", "thread_a", "job_a");
    expect(useVideoGenerationMode.getState().currentJob).toEqual({ threadId: "thread_a", jobId: "job_a" });

    // A different thread in the same workspace must not see thread A's job —
    // this is the bug: it used to be keyed by workspace alone, so any thread
    // (new or existing) restored whatever job was last written anywhere.
    mode.restoreCurrentJob("ws_1", "thread_b");
    expect(useVideoGenerationMode.getState().currentJob).toBeUndefined();

    // Switching back to thread A restores its own job.
    mode.restoreCurrentJob("ws_1", "thread_a");
    expect(useVideoGenerationMode.getState().currentJob).toEqual({ threadId: "thread_a", jobId: "job_a" });

    // Clearing thread A's job doesn't touch thread B's (absence of) one.
    mode.setCurrentJob("ws_1", "thread_a", undefined);
    mode.restoreCurrentJob("ws_1", "thread_a");
    expect(useVideoGenerationMode.getState().currentJob).toBeUndefined();
  });

  it("keeps the thread id on the pointer so a stale card can be refused", () => {
    stubLocalStorage();
    const mode = useVideoGenerationMode.getState();

    // "New Thread" reuses the same `__LOCALID_*` until a message materialises
    // the thread, and a video job never sends one — so storage scoping alone
    // can't tell the two apart. The pointer therefore carries its own thread
    // id and consumers compare it against the thread on screen.
    mode.setCurrentJob("ws_1", "__LOCALID_1", "job_a");
    expect(useVideoGenerationMode.getState().currentJob?.threadId).toBe("__LOCALID_1");

    mode.reset();
    expect(useVideoGenerationMode.getState().currentJob).toBeUndefined();
  });
});
