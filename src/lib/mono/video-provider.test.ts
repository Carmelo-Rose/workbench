import { afterEach, describe, expect, it } from "vitest";
import type { MonoVideoGenerationInput } from "./contracts";
import { getVideoGenerationCapabilities, resolveVideoGeneration } from "./video-provider";

const ENV_KEYS = [
  "COMFYUI_URL",
  "VIDEO_GENERATION_PROVIDER",
  "VIDEO_GENERATION_BASE_URL",
  "VIDEO_GENERATION_API_KEY",
  "VIDEO_GENERATION_T2V_MODEL",
  "VIDEO_GENERATION_I2V_MODEL",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];

const originalEnv: Partial<Record<EnvKey, string>> = {};
for (const key of ENV_KEYS) originalEnv[key] = process.env[key];

function setEnv(values: Partial<Record<EnvKey, string>>): void {
  for (const key of ENV_KEYS) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => setEnv(originalEnv));

const comfyui = { COMFYUI_URL: "https://comfy.example.test" };
const dashscope = { VIDEO_GENERATION_BASE_URL: "https://workspace.example.test", VIDEO_GENERATION_API_KEY: "sk-test" };

const textToVideo: MonoVideoGenerationInput = {
  mode: "text-to-video",
  prompt: "A rotating ceramic vase, studio light",
  aspectRatio: "16:9",
  durationSeconds: 5,
  resolution: "480p",
  variants: 1,
  model: "auto",
};

describe("getVideoGenerationCapabilities — provider merge", () => {
  it("reports unconfigured when neither backend has credentials", () => {
    setEnv({});
    const capabilities = getVideoGenerationCapabilities();
    expect(capabilities.configured).toBe(false);
    expect(capabilities.providers).toEqual([]);
  });

  it("exposes only the local Wan 2.2 model when just ComfyUI is configured", () => {
    setEnv(comfyui);
    const capabilities = getVideoGenerationCapabilities();
    expect(capabilities.providers).toEqual(["comfyui"]);
    expect(capabilities.models.map((model) => model.id)).toEqual(["wan2.2-ti2v-5b"]);
  });

  it("exposes Wan 2.7 and HappyHorse 1.1 models when only DashScope is configured", () => {
    setEnv(dashscope);
    const capabilities = getVideoGenerationCapabilities();
    expect(capabilities.providers).toEqual(["dashscope-wan"]);
    expect(capabilities.models.map((model) => model.id)).toEqual([
      "wan2.7-t2v-2026-06-12",
      "wan2.7-i2v-2026-04-25",
      "happyhorse-1.1-t2v",
      "happyhorse-1.1-i2v",
    ]);
  });

  it("merges both providers when both have credentials, ComfyUI ordered first by default", () => {
    setEnv({ ...comfyui, ...dashscope });
    const capabilities = getVideoGenerationCapabilities();
    expect(capabilities.providers).toEqual(["comfyui", "dashscope-wan"]);
    expect(capabilities.models).toHaveLength(5);
    expect(capabilities.modes).toEqual(["text-to-video", "image-to-video"]);
  });

  it("orders DashScope first when VIDEO_GENERATION_PROVIDER prefers it", () => {
    setEnv({ ...comfyui, ...dashscope, VIDEO_GENERATION_PROVIDER: "dashscope-wan" });
    const capabilities = getVideoGenerationCapabilities();
    expect(capabilities.providers).toEqual(["dashscope-wan", "comfyui"]);
  });
});

describe("resolveVideoGeneration — routes by the chosen model's own provider", () => {
  it("resolves 'auto' to the first provider's first matching model", () => {
    setEnv({ ...comfyui, ...dashscope });
    const resolved = resolveVideoGeneration(textToVideo);
    expect(resolved.provider).toBe("comfyui");
    expect(resolved.model).toBe("wan2.2-ti2v-5b");
  });

  it("routes an explicitly chosen cloud model to dashscope-wan even though comfyui is the default", () => {
    setEnv({ ...comfyui, ...dashscope });
    const resolved = resolveVideoGeneration({ ...textToVideo, model: "happyhorse-1.1-t2v", resolution: "720p" });
    expect(resolved.provider).toBe("dashscope-wan");
    expect(resolved.model).toBe("happyhorse-1.1-t2v");
  });

  it("validates duration/resolution against the resolved model's own provider, not a merged union", () => {
    setEnv({ ...comfyui, ...dashscope });
    // 720p only exists on the cloud provider; the local Wan 2.2 model must reject it even though
    // "720p" is a valid resolution somewhere in the merged capabilities list.
    expect(() => resolveVideoGeneration({ ...textToVideo, model: "wan2.2-ti2v-5b", resolution: "720p" })).toThrow("清晰度");
  });

  it("rejects a last frame for HappyHorse i2v, which only documents first-frame input", () => {
    setEnv(dashscope);
    const imageToVideo: MonoVideoGenerationInput = {
      mode: "image-to-video",
      prompt: "",
      durationSeconds: 5,
      resolution: "720p",
      variants: 1,
      model: "happyhorse-1.1-i2v",
      firstFrameAssetId: "asset_11111111-1111-1111-1111-111111111111",
      lastFrameAssetId: "asset_22222222-2222-2222-2222-222222222222",
    };
    expect(() => resolveVideoGeneration(imageToVideo)).toThrow("尾帧");
  });

  it("accepts a last frame for Wan 2.7 i2v, which documents first+last frame input", () => {
    setEnv(dashscope);
    const imageToVideo: MonoVideoGenerationInput = {
      mode: "image-to-video",
      prompt: "",
      durationSeconds: 5,
      resolution: "720p",
      variants: 1,
      model: "wan2.7-i2v-2026-04-25",
      firstFrameAssetId: "asset_11111111-1111-1111-1111-111111111111",
      lastFrameAssetId: "asset_22222222-2222-2222-2222-222222222222",
    };
    const resolved = resolveVideoGeneration(imageToVideo);
    expect(resolved.provider).toBe("dashscope-wan");
  });
});
