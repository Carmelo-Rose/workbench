import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MonoJob } from "@/lib/mono/contracts";

// Phase 3 route-level tests: /api/mono/* is the documented external API surface
// (also what services/mono-mcp forwards to). These four routes were migrated to
// dispatch through runCapabilityCommand instead of calling mono/service.ts
// directly — the point of this file is proving the response shape/status is
// byte-for-byte the same as before the migration, in both the default
// (capability-bus enabled) and rolled-back (WORKBENCH_CAPABILITY_BUS_DISABLED) states.

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const dbPath = path.join(os.tmpdir(), `workbench-mono-routes-${crypto.randomUUID()}.db`);
const headers = { "Content-Type": "application/json" };

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

function resetTestDatabaseConnection(): void {
  const globalDb = globalThis as typeof globalThis & { __workbenchDb?: { close?: () => void } };
  globalDb.__workbenchDb?.close?.();
  delete globalDb.__workbenchDb;
}

beforeAll(async () => {
  setEnv("WORKBENCH_DB_PATH", dbPath);
  setEnv("NODE_ENV", "test");
  setEnv("MONO_LOCAL_DEVELOPMENT", "true");
  setEnv("VISION_API_KEY", "test-vision-key");
  delete process.env.MONO_PLATFORM_API_KEY;
  // /api/mono/* authenticates as a fixed service actor (actorFromRequest), which
  // requires its workspace to already exist — seed the same "default" workspace
  // ensureLocalWorkspaceActor() would create for the workbench-session entry point.
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ url: "https://example.test/result.png" }), { status: 200 })));
  const { ensureLocalWorkspaceActor } = await import("@/lib/server/tenant");
  ensureLocalWorkspaceActor();
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

describe("POST /api/mono/analyze/image", () => {
  it.each([undefined, "image_to_prompt"])(
    "returns {result:{prompt}} unchanged (WORKBENCH_CAPABILITY_BUS_DISABLED=%s)",
    async (disabled) => {
      setEnv("WORKBENCH_CAPABILITY_BUS_DISABLED", disabled);
      generateTextMock.mockResolvedValue({ text: "a reversed prompt" });
      const { POST } = await import("./analyze/image/route");

      const response = await POST(new Request("http://localhost/api/mono/analyze/image", {
        method: "POST",
        headers,
        body: JSON.stringify({ imageUrl: "https://example.test/cat.png" }),
      }));

      expect(response.status).toBe(200);
      const body = await response.json() as { result: { prompt: string } };
      expect(body.result.prompt).toBe("a reversed prompt");
    },
  );
});

describe("POST /api/mono/analyze/video", () => {
  it.each([undefined, "mono_analyze_video"])(
    "returns a 202 {job} of kind video_analysis unchanged (WORKBENCH_CAPABILITY_BUS_DISABLED=%s)",
    async (disabled) => {
      setEnv("WORKBENCH_CAPABILITY_BUS_DISABLED", disabled);
      const { POST } = await import("./analyze/video/route");

      const response = await POST(new Request("http://localhost/api/mono/analyze/video", {
        method: "POST",
        headers,
        body: JSON.stringify({ videoUrl: "https://example.test/clip.mp4" }),
      }));

      expect(response.status).toBe(202);
      const body = await response.json() as { job: MonoJob };
      expect(body.job).toMatchObject({ kind: "video_analysis", status: "queued" });
      expect(typeof body.job.id).toBe("string");
    },
  );
});

describe("POST /api/mono/matting", () => {
  it.each([undefined, "mono_matting"])(
    "returns a 202 {job} of kind matting unchanged (WORKBENCH_CAPABILITY_BUS_DISABLED=%s)",
    async (disabled) => {
      setEnv("WORKBENCH_CAPABILITY_BUS_DISABLED", disabled);
      const { POST } = await import("./matting/route");

      const response = await POST(new Request("http://localhost/api/mono/matting", {
        method: "POST",
        headers,
        body: JSON.stringify({ mediaUrl: "https://example.test/a.png", mediaType: "image" }),
      }));

      expect(response.status).toBe(202);
      const body = await response.json() as { job: MonoJob };
      expect(body.job).toMatchObject({ kind: "matting", status: "queued" });
    },
  );
});

describe("POST /api/mono/generate/image", () => {
  it.each([undefined, "mono_generate_image"])(
    "returns a 202 {job} of kind image_generation unchanged (WORKBENCH_CAPABILITY_BUS_DISABLED=%s)",
    async (disabled) => {
      setEnv("WORKBENCH_CAPABILITY_BUS_DISABLED", disabled);
      const { POST } = await import("./generate/image/route");

      const response = await POST(new Request("http://localhost/api/mono/generate/image", {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "a cat", referenceImageUrls: [] }),
      }));

      expect(response.status).toBe(202);
      const body = await response.json() as { job: MonoJob };
      expect(body.job).toMatchObject({ kind: "image_generation", status: "queued" });
    },
  );
});

describe("capability schema validation still applies through the bus", () => {
  it("returns 400 for /api/mono/generate/image when prompt is missing", async () => {
    const { POST } = await import("./generate/image/route");
    const response = await POST(new Request("http://localhost/api/mono/generate/image", {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    }));
    expect(response.status).toBe(400);
  });
});
