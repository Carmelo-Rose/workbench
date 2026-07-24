import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Characterization test (Phase 1 baseline): locks in the *current* behavior
// of the video-analysis job runner — the raw fetch request it builds, the
// data-URL vs TOS-upload split by size, and job status transitions. This is
// the path the plan wants replaced by an independent Worker; this test is
// the regression net for that future change, not a design opinion now.

const dbPath = path.join(os.tmpdir(), `workbench-video-analysis-${crypto.randomUUID()}.db`);
const originalDbPath = process.env.WORKBENCH_DB_PATH;
const originalNodeEnv = process.env.NODE_ENV;
const originalLocalDevelopment = process.env.MONO_LOCAL_DEVELOPMENT;
const originalVisionApiKey = process.env.VISION_API_KEY;
const originalVisionBaseUrl = process.env.VISION_BASE_URL;
const originalVideoAnalyzeUrl = process.env.MONO_VIDEO_ANALYZE_URL;
const originalVideoModel = process.env.MONO_VIDEO_MODEL;

function resetTestDatabaseConnection(): void {
  const globalDb = globalThis as typeof globalThis & {
    __workbenchDb?: { close?: () => void };
  };
  globalDb.__workbenchDb?.close?.();
  delete globalDb.__workbenchDb;
}

const readObjectBufferMock = vi.fn();
vi.mock("@/lib/storage", () => ({
  readObjectBuffer: (...args: unknown[]) => readObjectBufferMock(...args),
  saveObjectBuffer: vi.fn(),
}));

const uploadVideoToTosMock = vi.fn();
vi.mock("./tos", () => ({
  uploadVideoToTosAndGetUrl: (...args: unknown[]) => uploadVideoToTosMock(...args),
}));

beforeAll(() => {
  process.env.WORKBENCH_DB_PATH = dbPath;
  Object.assign(process.env, { NODE_ENV: "test" });
  process.env.MONO_LOCAL_DEVELOPMENT = "true";
  process.env.VISION_API_KEY = "test-vision-key";
  delete process.env.VISION_BASE_URL;
  delete process.env.MONO_VIDEO_ANALYZE_URL;
  delete process.env.MONO_VIDEO_MODEL;
  resetTestDatabaseConnection();
});

afterEach(() => {
  vi.unstubAllGlobals();
  readObjectBufferMock.mockReset();
  uploadVideoToTosMock.mockReset();
});

async function flushMonoWorker(): Promise<void> {
  // Defensive: if any job-creating helper here starts firing scheduleMonoWorker()
  // (a fire-and-forget setImmediate) in the future, make sure it settles against
  // the temp test db before afterAll tears down WORKBENCH_DB_PATH — otherwise it
  // fires against the real dev db (process.cwd()/data/workbench.db) instead.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

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
  if (originalVisionBaseUrl === undefined) delete process.env.VISION_BASE_URL;
  else process.env.VISION_BASE_URL = originalVisionBaseUrl;
  if (originalVideoAnalyzeUrl === undefined) delete process.env.MONO_VIDEO_ANALYZE_URL;
  else process.env.MONO_VIDEO_ANALYZE_URL = originalVideoAnalyzeUrl;
  if (originalVideoModel === undefined) delete process.env.MONO_VIDEO_MODEL;
  else process.env.MONO_VIDEO_MODEL = originalVideoModel;
});

describe("video analysis job runner (Phase 1 baseline)", () => {
  it("sends a direct videoUrl straight through to the default DashScope endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ message: { content: "视频摘要" } }] }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const { newMonoActor } = await import("./service");
    const service = await import("./service");
    const store = await import("./store");
    const actor = newMonoActor({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });

    const job = store.createMonoJob(actor, "video_analysis", {
      assetId: null,
      videoUrl: "https://cdn.example.test/clip.mp4",
      focus: "请总结视频内容、镜头语言、节奏、音频和可复用的创作提示词。",
      model: "mono-video-analysis",
    });

    await service.dispatchJob(job.id);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchMock.mock.calls[0];
    expect(endpoint).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer test-vision-key",
    });
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      model: "mono-video-analysis",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "请总结视频内容、镜头语言、节奏、音频和可复用的创作提示词。" },
          { type: "video_url", video_url: { url: "https://cdn.example.test/clip.mp4" } },
        ],
      }],
    });

    const finished = store.getMonoJob(actor, job.id);
    expect(finished?.status).toBe("succeeded");
    expect(finished?.result).toEqual({ text: "视频摘要", model: "mono-video-analysis", provider: "vision" });
  });

  it("inlines a small stored asset as a base64 data: URL instead of uploading to TOS", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    readObjectBufferMock.mockResolvedValue(Buffer.from("small-video-bytes"));

    const { newMonoActor } = await import("./service");
    const service = await import("./service");
    const store = await import("./store");
    const actor = newMonoActor({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });

    const asset = store.createMonoAsset(actor, {
      sourceUrl: "storage:video-key",
      mimeType: "video/mp4",
      storageKey: "video-key",
    });
    const job = store.createMonoJob(actor, "video_analysis", {
      assetId: asset.id,
      videoUrl: null,
      focus: "总结",
      model: "mono-video-analysis",
    });

    await service.dispatchJob(job.id);

    expect(uploadVideoToTosMock).not.toHaveBeenCalled();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const videoUrl = body.messages[0].content[1].video_url.url as string;
    expect(videoUrl.startsWith("data:video/mp4;base64,")).toBe(true);
    expect(videoUrl).toContain(Buffer.from("small-video-bytes").toString("base64"));
  });

  it("uploads to TOS and uses the presigned URL when the stored asset exceeds the inline threshold", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    // MAX_VIDEO_DATA_URL_BYTES=10MiB, ratio=1.37 -> need > ~7.3MB raw to exceed threshold.
    const bigBuffer = Buffer.alloc(8 * 1024 * 1024, 1);
    readObjectBufferMock.mockResolvedValue(bigBuffer);
    uploadVideoToTosMock.mockResolvedValue("https://tos.example.test/signed/video.mp4");

    const { newMonoActor } = await import("./service");
    const service = await import("./service");
    const store = await import("./store");
    const actor = newMonoActor({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });

    const asset = store.createMonoAsset(actor, {
      sourceUrl: "storage:big-video-key",
      mimeType: "video/mp4",
      storageKey: "big-video-key",
    });
    const job = store.createMonoJob(actor, "video_analysis", {
      assetId: asset.id,
      videoUrl: null,
      focus: "总结",
      model: "mono-video-analysis",
    });

    await service.dispatchJob(job.id);

    // Reference equality only — `toHaveBeenCalledWith` deep-diffs large
    // Buffers byte-by-byte and turns this into a multi-second test.
    expect(uploadVideoToTosMock.mock.calls[0][0]).toBe(bigBuffer);
    expect(uploadVideoToTosMock.mock.calls[0][1]).toBe("video/mp4");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages[0].content[1].video_url.url).toBe("https://tos.example.test/signed/video.mp4");
  });

  it("marks the job failed with the provider's error message on a non-OK response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: "上游模型服务过载" } }),
      { status: 500 },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const { newMonoActor } = await import("./service");
    const service = await import("./service");
    const store = await import("./store");
    const actor = newMonoActor({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });

    const job = store.createMonoJob(actor, "video_analysis", {
      assetId: null,
      videoUrl: "https://cdn.example.test/clip.mp4",
      focus: "总结",
      model: "mono-video-analysis",
    });

    await service.dispatchJob(job.id);

    const finished = store.getMonoJob(actor, job.id);
    expect(finished?.status).toBe("failed");
    expect(finished?.error).toBe("上游模型服务过载");
  });
});
