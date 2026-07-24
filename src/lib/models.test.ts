import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Characterization test (Phase 1 baseline): locks in the *current* "protocol"
// — three flat, independently-configured provider functions with no shared
// role abstraction (planner/vision/image-generation). This is the gap the
// architecture plan wants to close with a Provider Profile registry; this
// test is the regression net for whatever replaces it.

const dbPath = path.join(os.tmpdir(), `workbench-models-${crypto.randomUUID()}.db`);
const originalDbPath = process.env.WORKBENCH_DB_PATH;
const originalNodeEnv = process.env.NODE_ENV;
const originalLocalDevelopment = process.env.MONO_LOCAL_DEVELOPMENT;
const envKeys = [
  "CHAT_BASE_URL", "CHAT_API_KEY", "CHAT_MODEL",
  "HERMES_API_KEY", "HERMES_BASE_URL", "HERMES_MODEL",
  "VISION_BASE_URL", "VISION_API_KEY", "VISION_MODEL",
] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const key of envKeys) originalEnv[key] = process.env[key];

function resetTestDatabaseConnection(): void {
  const globalDb = globalThis as typeof globalThis & {
    __workbenchDb?: { close?: () => void };
  };
  globalDb.__workbenchDb?.close?.();
  delete globalDb.__workbenchDb;
}

const createOpenAICompatibleMock = vi.fn();
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: (...args: unknown[]) => createOpenAICompatibleMock(...args),
}));

beforeAll(() => {
  process.env.WORKBENCH_DB_PATH = dbPath;
  Object.assign(process.env, { NODE_ENV: "test" });
  process.env.MONO_LOCAL_DEVELOPMENT = "true";
  resetTestDatabaseConnection();
});

afterEach(() => {
  createOpenAICompatibleMock.mockReset();
  for (const key of envKeys) delete process.env[key];
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
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe("chatModel (Phase 1 baseline)", () => {
  it("defaults to DeepSeek's endpoint and model when unconfigured", async () => {
    process.env.CHAT_API_KEY = "test-chat-key";
    const providerMock = vi.fn((modelId: string) => ({ modelId }));
    createOpenAICompatibleMock.mockReturnValue(providerMock);

    const { chatModel } = await import("./models");
    chatModel();

    expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
      name: "workbench-chat",
      baseURL: "https://api.deepseek.com/v1",
      apiKey: "test-chat-key",
    });
    expect(providerMock).toHaveBeenCalledWith("deepseek-chat");
  });

  it("throws a specific message when CHAT_API_KEY is missing", async () => {
    const { chatModel } = await import("./models");
    expect(() => chatModel()).toThrow(/CHAT_API_KEY/);
  });

  it("adds enable_thinking:false transformRequestBody only for DashScope-compatible base URLs", async () => {
    process.env.CHAT_API_KEY = "test-chat-key";
    process.env.CHAT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
    process.env.CHAT_MODEL = "qwen-plus";
    const providerMock = vi.fn((modelId: string) => ({ modelId }));
    createOpenAICompatibleMock.mockReturnValue(providerMock);

    const { chatModel } = await import("./models");
    chatModel();

    const config = createOpenAICompatibleMock.mock.calls[0][0];
    expect(typeof config.transformRequestBody).toBe("function");
    expect(config.transformRequestBody({ foo: "bar" })).toEqual({ foo: "bar", enable_thinking: false });
    expect(providerMock).toHaveBeenCalledWith("qwen-plus");
  });

  it("omits transformRequestBody for non-DashScope base URLs", async () => {
    process.env.CHAT_API_KEY = "test-chat-key";
    process.env.CHAT_BASE_URL = "https://api.deepseek.com/v1";
    createOpenAICompatibleMock.mockReturnValue(vi.fn());

    const { chatModel } = await import("./models");
    chatModel();

    const config = createOpenAICompatibleMock.mock.calls[0][0];
    expect(config.transformRequestBody).toBeUndefined();
  });
});

describe("hermesModel (Phase 1 baseline)", () => {
  it("throws when HERMES_API_KEY is missing", async () => {
    const { hermesModel } = await import("./models");
    expect(() => hermesModel()).toThrow(/HERMES_API_KEY/);
  });

  it("defaults to the local Hermes gateway with a custom fetch implementation", async () => {
    process.env.HERMES_API_KEY = "test-hermes-key";
    const providerMock = vi.fn((modelId: string) => ({ modelId }));
    createOpenAICompatibleMock.mockReturnValue(providerMock);

    const { hermesModel } = await import("./models");
    hermesModel();

    const config = createOpenAICompatibleMock.mock.calls[0][0];
    expect(config.name).toBe("hermes");
    expect(config.baseURL).toBe("http://127.0.0.1:8642/v1");
    expect(config.apiKey).toBe("test-hermes-key");
    // hermesFetch wraps the global fetch to translate Hermes's SSE activity
    // frames into reasoning_content deltas — it must not be the raw global fetch.
    expect(typeof config.fetch).toBe("function");
    expect(config.fetch).not.toBe(fetch);
    expect(providerMock).toHaveBeenCalledWith("hermes-agent");
  });
});

describe("visionModel (Phase 1 baseline)", () => {
  it("throws a workspace-scoped message when VISION_API_KEY is missing", async () => {
    const { visionModel } = await import("./models");
    expect(() => visionModel("ws-1")).toThrow(/VISION_API_KEY/);
  });

  it("defaults to DashScope's OpenAI-compatible endpoint and qwen-vl-max", async () => {
    process.env.VISION_API_KEY = "test-vision-key";
    const providerMock = vi.fn((modelId: string) => ({ modelId }));
    createOpenAICompatibleMock.mockReturnValue(providerMock);

    const { visionModel } = await import("./models");
    visionModel("ws-1");

    expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
      name: "workbench-vision",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "test-vision-key",
    });
    expect(providerMock).toHaveBeenCalledWith("qwen-vl-max");
  });
});
