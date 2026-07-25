import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MonoJob } from "@/lib/mono/contracts";

// Phase 3: the chat entry point's AI SDK tools (tools/mono.ts, tools/image-to-prompt.ts)
// were rewired to dispatch through runCapabilityCommand instead of duplicating direct
// calls into mono/service.ts. The critical constraint here — unlike the /api/mono/*
// route migration — is that the *TypeScript shape* returned by `execute()` must stay
// exactly MonoJob (or the tool's original ad-hoc shape), because it gets rendered by
// assistant-ui's MonoToolUI cards (see src/components/workbench/MonoToolUI.tsx), which
// read job.kind/job.input/job.status directly and would break on a bare CapabilityRun.

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const dbPath = path.join(os.tmpdir(), `workbench-tools-mono-${crypto.randomUUID()}.db`);
const toolOptions = { toolCallId: "test-call", messages: [] } as never;

const generateTextMock = vi.fn();
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: (...args: unknown[]) => generateTextMock(...args) };
});
const visionModelMock = vi.fn((_workspaceId?: string) => ({ modelId: "mock-vision-model" }));
vi.mock("@/lib/models", () => ({
  visionModel: (workspaceId?: string) => visionModelMock(workspaceId),
}));

async function flushMonoWorker(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function resetTestDatabaseConnection(): void {
  const globalDb = globalThis as typeof globalThis & { __workbenchDb?: { close?: () => void } };
  globalDb.__workbenchDb?.close?.();
  delete globalDb.__workbenchDb;
}

beforeAll(() => {
  setEnv("WORKBENCH_DB_PATH", dbPath);
  setEnv("NODE_ENV", "test");
  setEnv("VISION_API_KEY", "test-vision-key");
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ url: "https://example.test/result.png" }), { status: 200 })));
});

afterEach(() => {
  generateTextMock.mockClear();
  visionModelMock.mockClear();
  delete process.env.WORKBENCH_CAPABILITY_BUS_DISABLED;
});

afterAll(async () => {
  await flushMonoWorker();
  vi.unstubAllGlobals();
  resetTestDatabaseConnection();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
});

describe("createMonoTools descriptions (Phase 3 dedup)", () => {
  it("sources mono_analyze_video and mono_generate_image descriptions from CAPABILITY_REGISTRY", async () => {
    const { createMonoTools } = await import("./mono");
    const { getCapability } = await import("@/lib/workbench/capability-registry");
    const tools = createMonoTools({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });
    expect(tools.mono_analyze_video.description).toBe(getCapability("mono_analyze_video")!.chatToolDescription);
    expect(tools.mono_generate_image.description).toBe(getCapability("mono_generate_image")!.chatToolDescription);
    expect(tools.mono_matting.description).toContain(getCapability("mono_matting")!.chatToolDescription);
  });
});

describe.each([undefined, "mono_analyze_video"])(
  "mono_analyze_video tool via capability bus (WORKBENCH_CAPABILITY_BUS_DISABLED=%s)",
  (disabled) => {
    it("returns a full MonoJob, not a bare CapabilityRun", async () => {
      setEnv("WORKBENCH_CAPABILITY_BUS_DISABLED", disabled);
      const { createMonoTools } = await import("./mono");
      const tools = createMonoTools({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });

      const job = await tools.mono_analyze_video.execute!(
        { videoUrl: "https://example.test/clip.mp4" },
        toolOptions,
      ) as MonoJob;

      expect(job).toMatchObject({ kind: "video_analysis", status: "queued" });
      expect(job.input).toBeDefined();
      expect(typeof job.id).toBe("string");
    });
  },
);

describe.each([undefined, "mono_matting"])(
  "mono_matting tool via capability bus (WORKBENCH_CAPABILITY_BUS_DISABLED=%s)",
  (disabled) => {
    it("falls back to the attachment URL and returns a full MonoJob", async () => {
      setEnv("WORKBENCH_CAPABILITY_BUS_DISABLED", disabled);
      const { createMonoTools } = await import("./mono");
      const tools = createMonoTools({
        userId: "u1",
        workspaceId: `ws-${crypto.randomUUID()}`,
        attachmentUrl: "https://example.test/attached.png",
      });

      const job = await tools.mono_matting.execute!({ mediaType: "image" }, toolOptions) as MonoJob;

      expect(job).toMatchObject({ kind: "matting", status: "queued" });
      expect(job.input).toBeDefined();
    });
  },
);

describe.each([undefined, "mono_generate_image"])(
  "mono_generate_image tool via capability bus (WORKBENCH_CAPABILITY_BUS_DISABLED=%s)",
  (disabled) => {
    it("returns a lightened MonoJob", async () => {
      setEnv("WORKBENCH_CAPABILITY_BUS_DISABLED", disabled);
      const { createMonoTools } = await import("./mono");
      const tools = createMonoTools({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });

      const job = await tools.mono_generate_image.execute!(
        {
          prompt: "a cat",
          templateReferencesEnabled: true,
          referenceAssetIds: [],
          referenceImageUrls: [],
          subjectIds: [],
          aspectRatio: "1:1",
          variants: 1,
        },
        toolOptions,
      ) as MonoJob;

      expect(job).toMatchObject({ kind: "image_generation", status: "queued" });
    });
  },
);

describe.each([undefined, "image_to_prompt"])(
  "image_to_prompt tool via capability bus (WORKBENCH_CAPABILITY_BUS_DISABLED=%s)",
  (disabled) => {
    it("keeps returning {imageUrl, prompt}, not the raw analyzeImage result", async () => {
      setEnv("WORKBENCH_CAPABILITY_BUS_DISABLED", disabled);
      generateTextMock.mockResolvedValue({ text: "a reversed prompt" });
      const { createImageToPromptTool } = await import("./image-to-prompt");
      const imageTool = createImageToPromptTool();

      const result = await imageTool.execute!(
        { imageUrl: "https://example.test/cat.png" },
        toolOptions,
      ) as { imageUrl: string; prompt: string };

      expect(result).toEqual({ imageUrl: "https://example.test/cat.png", prompt: "a reversed prompt" });
    });
  },
);
