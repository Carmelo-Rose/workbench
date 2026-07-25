import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Phase 4: queue-level retry-with-backoff. MONO_JOB_MAX_ATTEMPTS defaults to 1
// (see video-analysis.test.ts's "marks the job failed" test for the proof that
// default behavior is unchanged) — this file only exercises the opt-in path
// where MONO_JOB_MAX_ATTEMPTS > 1, read once at module load, so the env vars
// below must be set *before* the first dynamic `import("./service")`.

const dbPath = path.join(os.tmpdir(), `workbench-job-retry-${crypto.randomUUID()}.db`);

function resetTestDatabaseConnection(): void {
  const globalDb = globalThis as typeof globalThis & { __workbenchDb?: { close?: () => void } };
  globalDb.__workbenchDb?.close?.();
  delete globalDb.__workbenchDb;
}

beforeAll(() => {
  process.env.WORKBENCH_DB_PATH = dbPath;
  Object.assign(process.env, { NODE_ENV: "test" });
  process.env.MONO_LOCAL_DEVELOPMENT = "true";
  process.env.VISION_API_KEY = "test-vision-key";
  process.env.MONO_JOB_MAX_ATTEMPTS = "2";
  process.env.MONO_JOB_RETRY_BACKOFF_MS = "5000";
  resetTestDatabaseConnection();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  resetTestDatabaseConnection();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  delete process.env.WORKBENCH_DB_PATH;
  Reflect.deleteProperty(process.env, "NODE_ENV");
  delete process.env.MONO_LOCAL_DEVELOPMENT;
  delete process.env.VISION_API_KEY;
  delete process.env.MONO_JOB_MAX_ATTEMPTS;
  delete process.env.MONO_JOB_RETRY_BACKOFF_MS;
});

describe("MONO_JOB_MAX_ATTEMPTS > 1 (opt-in queue-level retry)", () => {
  it("requeues with a backoff on the first failure, then fails for good once attempts are exhausted", async () => {
    // A fresh Response per call — a shared instance's body can only be read
    // once, and the second dispatchJob() call would silently fall back to the
    // generic "HTTP 429" message once .json() found an already-consumed body.
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(
      JSON.stringify({ error: { message: "rate limited" } }),
      { status: 429 },
    )));
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

    const beforeFirstAttempt = Date.now();
    await service.dispatchJob(job.id);

    const afterFirstFailure = store.getMonoJob(actor, job.id);
    expect(afterFirstFailure?.status).toBe("queued");
    expect(afterFirstFailure?.attemptCount).toBe(1);
    expect(afterFirstFailure?.error).toBe("rate limited");
    expect(afterFirstFailure?.nextRunAt).not.toBeNull();
    expect(afterFirstFailure!.nextRunAt!).toBeGreaterThanOrEqual(beforeFirstAttempt + 5000);
    // Lease is released so the job is claimable again once next_run_at passes.
    expect(afterFirstFailure?.leaseOwner).toBeNull();

    await service.dispatchJob(job.id);

    const afterSecondFailure = store.getMonoJob(actor, job.id);
    expect(afterSecondFailure?.status).toBe("failed");
    expect(afterSecondFailure?.attemptCount).toBe(2);
    expect(afterSecondFailure?.error).toBe("rate limited");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
