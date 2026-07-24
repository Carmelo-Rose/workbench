import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ZodError } from "zod";

// Phase 2 contract tests: the command bus must route each registered
// capability to the *same* mono/service.ts entry point the existing tools
// and routes already call, with no behavior change — this is the adapter
// layer described in the architecture plan, not a reimplementation.

const dbPath = path.join(os.tmpdir(), `workbench-capability-bus-${crypto.randomUUID()}.db`);
const originalDbPath = process.env.WORKBENCH_DB_PATH;
const originalNodeEnv = process.env.NODE_ENV;
const originalLocalDevelopment = process.env.MONO_LOCAL_DEVELOPMENT;
const originalVisionApiKey = process.env.VISION_API_KEY;

function resetTestDatabaseConnection(): void {
  const globalDb = globalThis as typeof globalThis & {
    __workbenchDb?: { close?: () => void };
  };
  globalDb.__workbenchDb?.close?.();
  delete globalDb.__workbenchDb;
}

const generateTextMock = vi.fn();
vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));
const visionModelMock = vi.fn((_workspaceId?: string) => ({ modelId: "mock-vision-model" }));
vi.mock("@/lib/models", () => ({
  visionModel: (workspaceId?: string) => visionModelMock(workspaceId),
}));

async function flushMonoWorker(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

beforeAll(() => {
  process.env.WORKBENCH_DB_PATH = dbPath;
  Object.assign(process.env, { NODE_ENV: "test" });
  process.env.MONO_LOCAL_DEVELOPMENT = "true";
  process.env.VISION_API_KEY = "test-vision-key";
  resetTestDatabaseConnection();
});

afterEach(() => {
  generateTextMock.mockReset();
  visionModelMock.mockClear();
});

afterAll(async () => {
  await flushMonoWorker();
  resetTestDatabaseConnection();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  if (originalDbPath === undefined) delete process.env.WORKBENCH_DB_PATH;
  else process.env.WORKBENCH_DB_PATH = originalDbPath;
  if (originalNodeEnv === undefined) {
    Reflect.deleteProperty(process.env, "NODE_ENV");
  } else {
    Object.assign(process.env, { NODE_ENV: originalNodeEnv });
  }
  if (originalLocalDevelopment === undefined) delete process.env.MONO_LOCAL_DEVELOPMENT;
  else process.env.MONO_LOCAL_DEVELOPMENT = originalLocalDevelopment;
  if (originalVisionApiKey === undefined) delete process.env.VISION_API_KEY;
  else process.env.VISION_API_KEY = originalVisionApiKey;
});

describe("runCapabilityCommand (Phase 2)", () => {
  it("routes image_to_prompt synchronously and never persists a job", async () => {
    generateTextMock.mockResolvedValue({ text: "a mock prompt" });
    const { runCapabilityCommand } = await import("./capability-bus");
    const { newMonoActor } = await import("@/lib/mono/service");
    const store = await import("@/lib/mono/store");
    const actor = newMonoActor({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });

    const run = await runCapabilityCommand({
      capabilityId: "image_to_prompt",
      input: { imageUrl: "https://example.test/cat.png" },
      assetIds: [],
      actor,
    });

    expect(run).toMatchObject({ capabilityId: "image_to_prompt", mode: "sync", status: "succeeded" });
    expect(run.result).toMatchObject({ prompt: "a mock prompt" });
    // Sync capabilities aren't job-backed; there is nothing to look up by run.id.
    expect(store.getMonoJob(actor, run.id)).toBeNull();
  });

  it("routes mono_analyze_video to createVideoAnalysisJob and returns a queued run", async () => {
    const { runCapabilityCommand } = await import("./capability-bus");
    const { newMonoActor } = await import("@/lib/mono/service");
    const store = await import("@/lib/mono/store");
    const actor = newMonoActor({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });

    const run = await runCapabilityCommand({
      capabilityId: "mono_analyze_video",
      input: { videoUrl: "https://example.test/clip.mp4" },
      assetIds: [],
      actor,
    });

    expect(run).toMatchObject({ capabilityId: "mono_analyze_video", mode: "async", status: "queued" });
    const job = store.getMonoJob(actor, run.id);
    expect(job?.kind).toBe("video_analysis");
  });

  it("routes mono_matting and mono_generate_image to their existing job creators", async () => {
    const { runCapabilityCommand } = await import("./capability-bus");
    const { newMonoActor } = await import("@/lib/mono/service");
    const store = await import("@/lib/mono/store");
    const actor = newMonoActor({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });

    const mattingRun = await runCapabilityCommand({
      capabilityId: "mono_matting",
      input: { mediaUrl: "https://example.test/a.png", mediaType: "image" },
      assetIds: [],
      actor,
    });
    expect(store.getMonoJob(actor, mattingRun.id)?.kind).toBe("matting");

    const imageRun = await runCapabilityCommand({
      capabilityId: "mono_generate_image",
      input: { prompt: "a cat", referenceImageUrls: [], subjectIds: [] },
      assetIds: [],
      actor,
    });
    expect(store.getMonoJob(actor, imageRun.id)?.kind).toBe("image_generation");
  });

  it("merges the top-level idempotencyKey into input for async capabilities", async () => {
    const { runCapabilityCommand } = await import("./capability-bus");
    const { newMonoActor } = await import("@/lib/mono/service");
    const actor = newMonoActor({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });
    const idempotencyKey = `idem-${crypto.randomUUID()}`;

    const first = await runCapabilityCommand({
      capabilityId: "mono_analyze_video",
      input: { videoUrl: "https://example.test/clip.mp4" },
      assetIds: [],
      actor,
      idempotencyKey,
    });
    const second = await runCapabilityCommand({
      capabilityId: "mono_analyze_video",
      input: { videoUrl: "https://example.test/clip.mp4" },
      assetIds: [],
      actor,
      idempotencyKey,
    });

    expect(second.id).toBe(first.id);
  });

  it("rejects an unknown capabilityId with a 404-flavored error", async () => {
    const { runCapabilityCommand } = await import("./capability-bus");
    const { CapabilityNotFoundError } = await import("./capability-command");
    const { newMonoActor } = await import("@/lib/mono/service");
    const actor = newMonoActor({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });

    await expect(runCapabilityCommand({
      capabilityId: "does_not_exist",
      input: {},
      assetIds: [],
      actor,
    })).rejects.toThrow(CapabilityNotFoundError);
  });

  it("rejects input that fails the capability's own schema", async () => {
    const { runCapabilityCommand } = await import("./capability-bus");
    const { newMonoActor } = await import("@/lib/mono/service");
    const actor = newMonoActor({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });

    await expect(runCapabilityCommand({
      capabilityId: "mono_generate_image",
      input: { /* missing required `prompt` */ },
      assetIds: [],
      actor,
    })).rejects.toThrow(ZodError);
  });
});
