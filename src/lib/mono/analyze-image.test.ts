import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Characterization test (Phase 1 baseline): locks in the *current* request
// shape analyzeImage() sends to the vision model, and how it resolves an
// asset vs a raw imageUrl into the `image` content block. No behavior change.

const dbPath = path.join(os.tmpdir(), `workbench-analyze-image-${crypto.randomUUID()}.db`);
const originalDbPath = process.env.WORKBENCH_DB_PATH;
const originalNodeEnv = process.env.NODE_ENV;
const originalLocalDevelopment = process.env.MONO_LOCAL_DEVELOPMENT;
const originalPublicUrl = process.env.WORKBENCH_PUBLIC_URL;

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

beforeAll(() => {
  process.env.WORKBENCH_DB_PATH = dbPath;
  Object.assign(process.env, { NODE_ENV: "test" });
  process.env.MONO_LOCAL_DEVELOPMENT = "true";
  process.env.WORKBENCH_PUBLIC_URL = "http://workbench.test";
  resetTestDatabaseConnection();
});

afterEach(() => {
  generateTextMock.mockReset();
  visionModelMock.mockClear();
});

afterAll(() => {
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
  if (originalPublicUrl === undefined) delete process.env.WORKBENCH_PUBLIC_URL;
  else process.env.WORKBENCH_PUBLIC_URL = originalPublicUrl;
});

describe("analyzeImage (Phase 1 baseline)", () => {
  it("sends a raw imageUrl straight through as the image content block", async () => {
    generateTextMock.mockResolvedValue({ text: "  a cat sitting on a fence  " });
    const { newMonoActor } = await import("./service");
    const service = await import("./service");
    const actor = newMonoActor({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });

    const result = await service.analyzeImage(actor, {
      imageUrl: "https://example.test/cat.png",
      outputFormat: "prompt",
    });

    expect(visionModelMock).toHaveBeenCalledWith(actor.workspaceId);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const call = generateTextMock.mock.calls[0][0];
    expect(call.messages).toEqual([{
      role: "user",
      content: [
        { type: "text", text: expect.stringContaining("提示词") },
        { type: "image", image: new URL("https://example.test/cat.png") },
      ],
    }]);
    // trimmed, assetId passed through as null when only imageUrl is given
    expect(result).toEqual({ assetId: null, prompt: "a cat sitting on a fence", traceId: actor.traceId });
  });

  it("resolves a stored asset via the internal public content URL, not sourceUrl", async () => {
    generateTextMock.mockResolvedValue({ text: "prompt text" });
    const { newMonoActor } = await import("./service");
    const service = await import("./service");
    const store = await import("./store");
    const actor = newMonoActor({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });

    const asset = store.createMonoAsset(actor, {
      sourceUrl: "storage:some-key",
      mimeType: "image/png",
      storageKey: "some-key",
    });

    const result = await service.analyzeImage(actor, { assetId: asset.id, outputFormat: "prompt" });

    const call = generateTextMock.mock.calls[0][0];
    expect(call.messages[0].content[1]).toEqual({
      type: "image",
      image: new URL(`http://workbench.test/api/workbench/mono/assets/${asset.id}/content`),
    });
    expect(result.assetId).toBe(asset.id);
  });

  it("passes a data: URL through as a string, not a URL instance", async () => {
    generateTextMock.mockResolvedValue({ text: "prompt text" });
    const { newMonoActor } = await import("./service");
    const service = await import("./service");
    const actor = newMonoActor({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });

    await service.analyzeImage(actor, {
      imageUrl: "data:image/png;base64,AAAA",
      outputFormat: "prompt",
    });

    const call = generateTextMock.mock.calls[0][0];
    expect(call.messages[0].content[1]).toEqual({
      type: "image",
      image: "data:image/png;base64,AAAA",
    });
  });

  it("switches to the strict JSON instruction when outputFormat is json, including focus", async () => {
    generateTextMock.mockResolvedValue({ text: "{}" });
    const { newMonoActor } = await import("./service");
    const service = await import("./service");
    const actor = newMonoActor({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });

    await service.analyzeImage(actor, {
      imageUrl: "https://example.test/cat.png",
      outputFormat: "json",
      focus: "配色",
    });

    const call = generateTextMock.mock.calls[0][0];
    const instruction = call.messages[0].content[0].text as string;
    expect(instruction).toContain("仅输出一个有效 JSON 对象");
    expect(instruction).toContain("subject");
    expect(instruction).toContain("特别侧重：配色");
  });
});
