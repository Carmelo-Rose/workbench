import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MonoJobQueueStats, MonoWorkerHeartbeat } from "@/lib/mono/store";

const dbPath = path.join(os.tmpdir(), `workbench-worker-status-${crypto.randomUUID()}.db`);

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function resetTestDatabaseConnection(): void {
  const globalDb = globalThis as typeof globalThis & { __workbenchDb?: { close?: () => void } };
  globalDb.__workbenchDb?.close?.();
  delete globalDb.__workbenchDb;
}

beforeAll(() => {
  setEnv("WORKBENCH_DB_PATH", dbPath);
  setEnv("NODE_ENV", "test");
  setEnv("MONO_LOCAL_DEVELOPMENT", "true");
  delete process.env.MONO_PLATFORM_API_KEY;
  resetTestDatabaseConnection();
});

afterAll(() => {
  resetTestDatabaseConnection();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  delete process.env.WORKBENCH_DB_PATH;
  Reflect.deleteProperty(process.env, "NODE_ENV");
  delete process.env.MONO_LOCAL_DEVELOPMENT;
});

describe("GET /api/mono/worker/status", () => {
  it("reports registered workers (flagging stale ones) and queue stats", async () => {
    const store = await import("@/lib/mono/store");
    store.upsertMonoWorkerHeartbeat({
      id: "fresh-worker",
      mode: "standalone",
      startedAt: Date.now(),
      inFlight: { video_analysis: 0, matting: 0, image_generation: 0 },
    });
    // Backdate a heartbeat far enough that it should be reported stale.
    store.upsertMonoWorkerHeartbeat({
      id: "stale-worker",
      mode: "standalone",
      startedAt: Date.now() - 10 * 60_000,
      inFlight: { video_analysis: 0, matting: 0, image_generation: 0 },
    });
    const db = (await import("@/lib/server/db")).getDb();
    db.prepare("UPDATE mono_workers SET last_heartbeat_at = ? WHERE id = ?")
      .run(Date.now() - 10 * 60_000, "stale-worker");

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/mono/worker/status"));

    expect(response.status).toBe(200);
    const body = await response.json() as { workers: (MonoWorkerHeartbeat & { stale: boolean })[]; queue: MonoJobQueueStats };
    const fresh = body.workers.find((worker) => worker.id === "fresh-worker");
    const stale = body.workers.find((worker) => worker.id === "stale-worker");
    expect(fresh?.stale).toBe(false);
    expect(stale?.stale).toBe(true);
    expect(body.queue.queueDepthByKind).toHaveProperty("video_analysis");
    expect(body.queue.queueDepthByKind).toHaveProperty("matting");
    expect(body.queue.queueDepthByKind).toHaveProperty("image_generation");
  });

  it("rejects requests without platform credentials outside local development", async () => {
    setEnv("MONO_LOCAL_DEVELOPMENT", "false");
    setEnv("MONO_PLATFORM_API_KEY", "secret");
    const { GET } = await import("./route");

    const response = await GET(new Request("http://localhost/api/mono/worker/status"));

    expect(response.status).toBe(401);
    setEnv("MONO_LOCAL_DEVELOPMENT", "true");
    delete process.env.MONO_PLATFORM_API_KEY;
  });
});
