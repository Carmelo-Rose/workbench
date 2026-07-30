import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MonoImageGenerationInput } from "./contracts";

// Characterization test (Phase 1 baseline): locks in the *current* behavior
// of Image2 generation — request shape sent to MONO_IMAGE_BASE_URL, the
// per-slot retry loop (MAX_IMAGE_ATTEMPTS=3), the 6-image reference cap, and
// subject/reference prompt compilation. No behavior change.

const dbPath = path.join(os.tmpdir(), `workbench-image-generation-${crypto.randomUUID()}.db`);
const originalDbPath = process.env.WORKBENCH_DB_PATH;
const originalNodeEnv = process.env.NODE_ENV;
const originalLocalDevelopment = process.env.MONO_LOCAL_DEVELOPMENT;
const originalImageBaseUrl = process.env.MONO_IMAGE_BASE_URL;
const originalImageApiKey = process.env.MONO_IMAGE_API_KEY;
const originalImageGenerateUrl = process.env.MONO_IMAGE_GENERATE_URL;
const originalWorkerMode = process.env.MONO_WORKER_MODE;
const originalStorageDir = process.env.WORKBENCH_STORAGE_DIR;
const storageDir = path.join(os.tmpdir(), `workbench-image-generation-storage-${crypto.randomUUID()}`);
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function imageResponse(): Response {
  return new Response(new Uint8Array(tinyPng), { status: 200, headers: { "Content-Type": "image/png" } });
}

function generationCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([endpoint]) => String(endpoint).includes("/v1/api/generate"));
}

function resetTestDatabaseConnection(): void {
  const globalDb = globalThis as typeof globalThis & {
    __workbenchDb?: { close?: () => void };
  };
  globalDb.__workbenchDb?.close?.();
  delete globalDb.__workbenchDb;
}

function baseInput(overrides: Partial<MonoImageGenerationInput> = {}): MonoImageGenerationInput {
  return {
    prompt: "画一只猫",
    templateReferencesEnabled: true,
    referenceAssetIds: [],
    referenceImageUrls: ["https://example.test/ref1.png"],
    subjectIds: [],
    aspectRatio: "1:1",
    variants: 1,
    ...overrides,
  };
}

beforeAll(() => {
  process.env.WORKBENCH_DB_PATH = dbPath;
  Object.assign(process.env, { NODE_ENV: "test" });
  process.env.MONO_LOCAL_DEVELOPMENT = "true";
  process.env.MONO_IMAGE_BASE_URL = "https://image.example.test";
  process.env.MONO_IMAGE_API_KEY = "test-image-key";
  process.env.MONO_WORKER_MODE = "standalone";
  process.env.WORKBENCH_STORAGE_DIR = storageDir;
  delete process.env.MONO_IMAGE_GENERATE_URL;
  resetTestDatabaseConnection();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function flushMonoWorker(): Promise<void> {
  // createImageGenerationJob() fires scheduleMonoWorker(), a fire-and-forget
  // setImmediate that isn't awaited anywhere. If it's still pending when
  // afterAll tears down WORKBENCH_DB_PATH, it fires against the *real* dev
  // db (process.cwd()/data/workbench.db) instead of the temp test db. Flush
  // it here, while the temp db is still live, so nothing touches the real one.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

afterAll(async () => {
  await flushMonoWorker();
  resetTestDatabaseConnection();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(storageDir, { recursive: true, force: true });
  if (originalDbPath === undefined) delete process.env.WORKBENCH_DB_PATH;
  else process.env.WORKBENCH_DB_PATH = originalDbPath;
  if (originalNodeEnv === undefined) {
    Reflect.deleteProperty(process.env, "NODE_ENV");
  } else {
    Object.assign(process.env, { NODE_ENV: originalNodeEnv });
  }
  if (originalLocalDevelopment === undefined) delete process.env.MONO_LOCAL_DEVELOPMENT;
  else process.env.MONO_LOCAL_DEVELOPMENT = originalLocalDevelopment;
  if (originalImageBaseUrl === undefined) delete process.env.MONO_IMAGE_BASE_URL;
  else process.env.MONO_IMAGE_BASE_URL = originalImageBaseUrl;
  if (originalImageApiKey === undefined) delete process.env.MONO_IMAGE_API_KEY;
  else process.env.MONO_IMAGE_API_KEY = originalImageApiKey;
  if (originalImageGenerateUrl === undefined) delete process.env.MONO_IMAGE_GENERATE_URL;
  else process.env.MONO_IMAGE_GENERATE_URL = originalImageGenerateUrl;
  if (originalWorkerMode === undefined) delete process.env.MONO_WORKER_MODE;
  else process.env.MONO_WORKER_MODE = originalWorkerMode;
  if (originalStorageDir === undefined) delete process.env.WORKBENCH_STORAGE_DIR;
  else process.env.WORKBENCH_STORAGE_DIR = originalStorageDir;
});

describe("Image2 generation job runner (Phase 1 baseline)", () => {
  it("sends the compiled prompt + references to MONO_IMAGE_BASE_URL and completes on a direct URL result", async () => {
    const fetchMock = vi.fn().mockImplementation((endpoint: string) => {
      if (endpoint === "https://image.example.test/v1/api/generate") {
        return Promise.resolve(new Response(
          JSON.stringify({ results: [{ url: "https://image.example.test/out1.png" }] }),
          { status: 200 },
        ));
      }
      return Promise.resolve(imageResponse());
    });
    vi.stubGlobal("fetch", fetchMock);

    const { newMonoActor } = await import("./service");
    const service = await import("./service");
    const store = await import("./store");
    const actor = newMonoActor({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });

    const job = service.createImageGenerationJob(actor, baseInput());
    await service.dispatchJob(job.id);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [[endpoint, init]] = generationCalls(fetchMock);
    expect(endpoint).toBe("https://image.example.test/v1/api/generate");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer test-image-key",
    });
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      model: "gpt-image-2",
      prompt: "你将收到 1 张参考图，编号与输入图片顺序一致。\n请严格按编号理解用户指令。\n\n用户指令：画一只猫",
      images: [expect.stringMatching(/\/api\/workbench\/mono\/assets\/.+\/content$/)],
      aspectRatio: "1:1",
      replyType: "json",
    });

    const finished = store.getMonoJob(actor, job.id);
    expect(finished?.status).toBe("succeeded");
    expect(finished?.input.referenceImageUrls).toEqual([]);
    expect(finished?.input.referenceAssetIds).toEqual([expect.stringMatching(/^asset_/)]);
    expect(finished?.result).toMatchObject({
      succeeded: 1,
      failed: 0,
      provider: "mono-image",
      model: "gpt-image-2",
    });
    const slot = (finished?.result as { slots: Array<{ assetId?: string; imageUrl?: string }> }).slots[0];
    expect(slot.assetId).toMatch(/^asset_/);
    expect(slot.imageUrl).toBeUndefined();
  });

  it("retries a failing slot up to MAX_IMAGE_ATTEMPTS and succeeds on the second attempt", async () => {
    let generationAttempt = 0;
    const fetchMock = vi.fn().mockImplementation((endpoint: string) => {
      if (endpoint !== "https://image.example.test/v1/api/generate") return Promise.resolve(imageResponse());
      generationAttempt += 1;
      return Promise.resolve(generationAttempt === 1
        ? new Response(JSON.stringify({ error: "upstream busy" }), { status: 503 })
        : new Response(
          JSON.stringify({ results: [{ url: "https://image.example.test/out-retry.png" }] }),
          { status: 200 },
        ));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { newMonoActor } = await import("./service");
    const service = await import("./service");
    const store = await import("./store");
    const actor = newMonoActor({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });

    const job = service.createImageGenerationJob(actor, baseInput());
    await service.dispatchJob(job.id);

    expect(generationCalls(fetchMock)).toHaveLength(2);
    const finished = store.getMonoJob(actor, job.id);
    expect(finished?.status).toBe("succeeded");
    const slots = (finished?.result as { slots: Array<{ status: string; attempt: number; assetId?: string }> }).slots;
    expect(slots).toEqual([
      { index: 0, status: "succeeded", attempt: 2, assetId: expect.stringMatching(/^asset_/) },
    ]);
  });

  it("runs `variants` slots in parallel and reports per-slot success", async () => {
    // Each slot reads its own Response body concurrently, so the mock must
    // hand back a fresh Response per call — a shared instance's body can
    // only be consumed once and the second concurrent .json() call fails.
    const fetchMock = vi.fn().mockImplementation((endpoint: string) => Promise.resolve(
      endpoint === "https://image.example.test/v1/api/generate"
        ? new Response(
          JSON.stringify({ results: [{ url: "https://image.example.test/variant.png" }] }),
          { status: 200 },
        )
        : imageResponse(),
    ));
    vi.stubGlobal("fetch", fetchMock);

    const { newMonoActor } = await import("./service");
    const service = await import("./service");
    const store = await import("./store");
    const actor = newMonoActor({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });

    const job = service.createImageGenerationJob(actor, baseInput({ variants: 2 }));
    await service.dispatchJob(job.id);

    expect(generationCalls(fetchMock)).toHaveLength(2);
    const finished = store.getMonoJob(actor, job.id);
    expect(finished?.result).toMatchObject({ succeeded: 2, failed: 0 });
  });

  it("retries result persistence without paying for another generation", async () => {
    let resultDownloads = 0;
    const fetchMock = vi.fn().mockImplementation((endpoint: string) => {
      if (endpoint === "https://image.example.test/v1/api/generate") {
        return Promise.resolve(new Response(
          JSON.stringify({ results: [{ url: "https://image.example.test/persist-retry.png" }] }),
          { status: 200 },
        ));
      }
      if (endpoint === "https://image.example.test/persist-retry.png") {
        resultDownloads += 1;
        if (resultDownloads < 3) return Promise.resolve(new Response("temporary", { status: 503 }));
      }
      return Promise.resolve(imageResponse());
    });
    vi.stubGlobal("fetch", fetchMock);

    const { newMonoActor } = await import("./service");
    const service = await import("./service");
    const store = await import("./store");
    const actor = newMonoActor({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });

    const job = service.createImageGenerationJob(actor, baseInput());
    await service.dispatchJob(job.id);

    expect(generationCalls(fetchMock)).toHaveLength(1);
    expect(resultDownloads).toBe(3);
    expect(store.getMonoJob(actor, job.id)?.result).toMatchObject({ succeeded: 1, failed: 0 });
  });

  it("resolves subjectIds into a reference image and rewrites @name into 参考图N（name）", async () => {
    const fetchMock = vi.fn().mockImplementation((endpoint: string) => Promise.resolve(
      endpoint === "https://image.example.test/v1/api/generate"
        ? new Response(
          JSON.stringify({ results: [{ url: "https://image.example.test/subject.png" }] }),
          { status: 200 },
        )
        : imageResponse(),
    ));
    vi.stubGlobal("fetch", fetchMock);

    const { newMonoActor } = await import("./service");
    const service = await import("./service");
    const store = await import("./store");
    const actor = newMonoActor({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });

    const asset = store.createMonoAsset(actor, { sourceUrl: "https://example.test/subject-source.png" });
    const subject = store.createMonoSubject(actor, { name: "猫咪", assetId: asset.id, visibility: "private" });
    if (!subject) throw new Error("test setup failed: subject not created");

    const job = service.createImageGenerationJob(actor, baseInput({
      prompt: "把 @猫咪 放在草地上",
      referenceImageUrls: [],
      subjectIds: [subject.id],
    }));
    await service.dispatchJob(job.id);

    const [[, init]] = generationCalls(fetchMock);
    const body = JSON.parse(init.body);
    expect(body.images).toEqual([expect.stringMatching(/\/api\/workbench\/mono\/assets\/.+\/content$/)]);
    expect(body.prompt).toContain("参考图1（猫咪）");
    expect(body.prompt).not.toContain("@猫咪");
  });

  it("rejects more than 6 combined reference/subject images before creating a job", async () => {
    const { newMonoActor } = await import("./service");
    const service = await import("./service");
    const store = await import("./store");
    const actor = newMonoActor({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });

    const jobsBefore = store.listMonoJobs(actor, { kind: "image_generation" }).length;
    const sevenUrls = Array.from({ length: 7 }, (_, i) => `https://example.test/ref${i}.png`);

    expect(() => service.createImageGenerationJob(actor, baseInput({ referenceImageUrls: sevenUrls })))
      .toThrow("参考图与主体图片合计 7 张，最多允许 6 张");
    expect(store.listMonoJobs(actor, { kind: "image_generation" }).length).toBe(jobsBefore);
  });

  it("dedupes job creation by idempotencyKey instead of creating a second job", async () => {
    const { newMonoActor } = await import("./service");
    const service = await import("./service");
    const store = await import("./store");
    const actor = newMonoActor({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });

    const idempotencyKey = `idem-${crypto.randomUUID()}`;
    const first = service.createImageGenerationJob(actor, baseInput({ idempotencyKey }));
    const second = service.createImageGenerationJob(actor, baseInput({ idempotencyKey }));

    expect(second.id).toBe(first.id);
    expect(store.listMonoJobs(actor, { kind: "image_generation" }).map((j) => j.id)).toEqual([first.id]);
  });

  it("keeps a generated asset when a subject still references it during job deletion", async () => {
    const fetchMock = vi.fn().mockImplementation((endpoint: string) => Promise.resolve(
      endpoint === "https://image.example.test/v1/api/generate"
        ? new Response(
          JSON.stringify({ results: [{ url: "https://image.example.test/kept.png" }] }),
          { status: 200 },
        )
        : imageResponse(),
    ));
    vi.stubGlobal("fetch", fetchMock);
    const service = await import("./service");
    const store = await import("./store");
    const actor = service.newMonoActor({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });
    const job = service.createImageGenerationJob(actor, baseInput({ referenceImageUrls: [] }));
    await service.dispatchJob(job.id);
    const assetId = ((store.getMonoJob(actor, job.id)?.result as {
      slots: Array<{ assetId: string }>;
    }).slots[0]).assetId;
    expect(store.createMonoSubject(actor, { name: "保留主体", assetId, visibility: "private" })).toBeTruthy();

    await expect(service.purgeJob(actor, job.id)).resolves.toBe(true);
    expect(store.getMonoJob(actor, job.id)).toBeNull();
    expect(store.getMonoAsset(actor, assetId)).not.toBeNull();
  });
});
