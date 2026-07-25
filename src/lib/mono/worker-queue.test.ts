import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Phase 4: store-level queue primitives (lease claim/reclaim, retry backoff,
// worker heartbeat, queue stats) — the parts of the independent-Worker plan
// that don't need a real provider call to exercise, so no fetch/generateText
// mocking here, just direct store function calls against a temp SQLite file.

const dbPath = path.join(os.tmpdir(), `workbench-worker-queue-${crypto.randomUUID()}.db`);

function resetTestDatabaseConnection(): void {
  const globalDb = globalThis as typeof globalThis & { __workbenchDb?: { close?: () => void } };
  globalDb.__workbenchDb?.close?.();
  delete globalDb.__workbenchDb;
}

beforeAll(() => {
  process.env.WORKBENCH_DB_PATH = dbPath;
  Object.assign(process.env, { NODE_ENV: "test" });
  resetTestDatabaseConnection();
});

afterAll(() => {
  resetTestDatabaseConnection();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  delete process.env.WORKBENCH_DB_PATH;
  Reflect.deleteProperty(process.env, "NODE_ENV");
});

describe("claimNextMonoJob lease exclusivity", () => {
  it("lets only one of two competing workers win the same queued job", async () => {
    const store = await import("./store");
    const { newMonoActor } = await import("./service");
    const actor = newMonoActor({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });

    const job = store.createMonoJob(actor, "matting", { assetId: null, mediaUrl: "https://example.test/a.png" });

    const claimedByA = store.claimNextMonoJob(["matting"], { workerId: "worker-a" });
    const claimedByB = store.claimNextMonoJob(["matting"], { workerId: "worker-b" });

    expect(claimedByA?.id).toBe(job.id);
    expect(claimedByB).toBeNull();
    expect(store.getMonoJob(actor, job.id)).toMatchObject({
      status: "running",
      leaseOwner: "worker-a",
      attemptCount: 1,
    });
  });

  it("skips jobs whose next_run_at is still in the future (retry backoff)", async () => {
    const store = await import("./store");
    const { newMonoActor } = await import("./service");
    const actor = newMonoActor({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });

    const job = store.createMonoJob(actor, "matting", { assetId: null, mediaUrl: "https://example.test/b.png" });
    // Put it into a running state, then force it back to queued with a future next_run_at
    // the same way failOrRetryMonoJob would after a failed first attempt.
    store.claimMonoJob(job.id, { workerId: "worker-a" });
    const status = store.failOrRetryMonoJob(job.id, "transient error", 3, 60_000);
    expect(status).toBe("queued");

    expect(store.claimNextMonoJob(["matting"], { workerId: "worker-b" })).toBeNull();
  });
});

describe("reclaimExpiredLeases", () => {
  it("requeues only jobs whose lease has actually expired", async () => {
    const store = await import("./store");
    const { newMonoActor } = await import("./service");
    const actor = newMonoActor({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });

    const expiring = store.createMonoJob(actor, "matting", { assetId: null, mediaUrl: "https://example.test/c.png" });
    const fresh = store.createMonoJob(actor, "matting", { assetId: null, mediaUrl: "https://example.test/d.png" });
    store.claimMonoJob(expiring.id, { workerId: "worker-a", leaseMs: -1_000 }); // already expired
    store.claimMonoJob(fresh.id, { workerId: "worker-a", leaseMs: 60_000 }); // not expired

    const reclaimed = store.reclaimExpiredLeases();

    expect(reclaimed).toBe(1);
    expect(store.getMonoJob(actor, expiring.id)).toMatchObject({ status: "queued", leaseOwner: null });
    expect(store.getMonoJob(actor, fresh.id)).toMatchObject({ status: "running", leaseOwner: "worker-a" });
  });
});

describe("failOrRetryMonoJob", () => {
  it("fails immediately once attempt_count reaches maxAttempts", async () => {
    const store = await import("./store");
    const { newMonoActor } = await import("./service");
    const actor = newMonoActor({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });

    const job = store.createMonoJob(actor, "matting", { assetId: null, mediaUrl: "https://example.test/e.png" });
    store.claimMonoJob(job.id, { workerId: "worker-a" }); // attempt 1

    const status = store.failOrRetryMonoJob(job.id, "boom", 1, 10_000);

    expect(status).toBe("failed");
    expect(store.getMonoJob(actor, job.id)).toMatchObject({ status: "failed", error: "boom" });
  });
});

describe("worker heartbeats and queue stats", () => {
  it("upserts and lists worker heartbeats", async () => {
    const store = await import("./store");
    const workerId = `worker-${crypto.randomUUID()}`;

    store.upsertMonoWorkerHeartbeat({
      id: workerId,
      mode: "standalone",
      hostname: "ailab-01",
      pid: 4242,
      startedAt: 1000,
      inFlight: { video_analysis: 1, matting: 0, image_generation: 0 },
    });
    let workers = store.listMonoWorkers();
    expect(workers.find((worker) => worker.id === workerId)).toMatchObject({
      mode: "standalone",
      hostname: "ailab-01",
      pid: 4242,
      inFlight: { video_analysis: 1, matting: 0, image_generation: 0 },
    });

    // Re-upserting the same id updates in place rather than duplicating the row.
    store.upsertMonoWorkerHeartbeat({
      id: workerId,
      mode: "standalone",
      startedAt: 1000,
      inFlight: { video_analysis: 0, matting: 0, image_generation: 0 },
    });
    workers = store.listMonoWorkers().filter((worker) => worker.id === workerId);
    expect(workers).toHaveLength(1);
    expect(workers[0].inFlight).toEqual({ video_analysis: 0, matting: 0, image_generation: 0 });
  });

  it("reports queue depth, oldest queued age, and recent failure rate", async () => {
    const store = await import("./store");
    const { newMonoActor } = await import("./service");
    const actor = newMonoActor({ userId: "u1", workspaceId: `ws-${crypto.randomUUID()}` });

    const queuedJob = store.createMonoJob(actor, "video_analysis", { assetId: null, videoUrl: "https://example.test/f.mp4" });
    const succeededJob = store.createMonoJob(actor, "matting", { assetId: null, mediaUrl: "https://example.test/g.png" });
    const failedJob = store.createMonoJob(actor, "matting", { assetId: null, mediaUrl: "https://example.test/h.png" });
    store.claimMonoJob(succeededJob.id, { workerId: "worker-a" });
    store.completeMonoJob(succeededJob.id, { ok: true });
    store.claimMonoJob(failedJob.id, { workerId: "worker-a" });
    store.failMonoJob(failedJob.id, "nope");

    const stats = store.monoJobQueueStats();

    expect(stats.queueDepthByKind.video_analysis).toBeGreaterThanOrEqual(1);
    expect(stats.oldestQueuedAgeMs).not.toBeNull();
    expect(stats.oldestQueuedAgeMs!).toBeGreaterThanOrEqual(0);
    expect(stats.recentFailureRate.failed).toBeGreaterThanOrEqual(1);
    expect(stats.recentFailureRate.rate).toBeGreaterThan(0);
    expect(stats.recentFailureRate.rate).toBeLessThanOrEqual(1);
    // Keep the queued job referenced so lint doesn't flag it as unused —
    // its presence is what makes queueDepthByKind.video_analysis non-zero above.
    expect(queuedJob.status).toBe("queued");
  });
});
