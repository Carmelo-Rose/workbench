import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Characterization test (Phase 1 baseline): locks in the *current* behavior of
// mono asset/job store scoping before any hexagonal-architecture refactor.
// Every mono store query hand-writes `WHERE workspace_id = ?` — there is no
// ORM/middleware enforcing this. This test exists so a future refactor that
// drops one of those clauses fails loudly instead of silently leaking data
// across tenants.

const dbPath = path.join(os.tmpdir(), `workbench-mono-isolation-${crypto.randomUUID()}.db`);
const originalDbPath = process.env.WORKBENCH_DB_PATH;
const originalNodeEnv = process.env.NODE_ENV;
const originalLocalDevelopment = process.env.MONO_LOCAL_DEVELOPMENT;

function resetTestDatabaseConnection(): void {
  const globalDb = globalThis as typeof globalThis & {
    __workbenchDb?: { close?: () => void };
  };
  globalDb.__workbenchDb?.close?.();
  delete globalDb.__workbenchDb;
}

beforeAll(() => {
  process.env.WORKBENCH_DB_PATH = dbPath;
  Object.assign(process.env, { NODE_ENV: "test" });
  process.env.MONO_LOCAL_DEVELOPMENT = "true";
  resetTestDatabaseConnection();
});

async function flushMonoWorker(): Promise<void> {
  // createVideoAnalysisJob()/createMattingJob() fire scheduleMonoWorker(), a
  // fire-and-forget setImmediate that isn't awaited anywhere. If it's still
  // pending when afterAll tears down WORKBENCH_DB_PATH, it fires against the
  // *real* dev db (process.cwd()/data/workbench.db) instead of the temp one.
  // Flush it here, while the temp db is still live, so nothing touches the real one.
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
});

describe("mono asset/job workspace isolation (Phase 1 baseline)", () => {
  it("keeps mono_assets scoped per workspace", async () => {
    const { newMonoActor } = await import("./service");
    const store = await import("./store");

    const actorA = newMonoActor({ userId: "user-a", workspaceId: `ws-a-${crypto.randomUUID()}` });
    const actorB = newMonoActor({ userId: "user-b", workspaceId: `ws-b-${crypto.randomUUID()}` });

    const assetA = store.createMonoAsset(actorA, {
      sourceUrl: "https://example.test/a.png",
      mimeType: "image/png",
    });

    expect(store.getMonoAsset(actorA, assetA.id)).not.toBeNull();
    // Same asset id, other workspace's actor: current store code filters by
    // `id = ? AND workspace_id = ?`, so this must come back null, not the row.
    expect(store.getMonoAsset(actorB, assetA.id)).toBeNull();
  });

  it("keeps mono_jobs scoped per workspace for get/list", async () => {
    const { newMonoActor } = await import("./service");
    const store = await import("./store");

    const actorA = newMonoActor({ userId: "user-a", workspaceId: `ws-a-${crypto.randomUUID()}` });
    const actorB = newMonoActor({ userId: "user-b", workspaceId: `ws-b-${crypto.randomUUID()}` });

    const job = store.createMonoJob(actorA, "video_analysis", {
      assetId: null,
      videoUrl: "https://example.test/video.mp4",
      focus: "test",
      model: "mono-video-analysis",
    });

    expect(store.getMonoJob(actorA, job.id)).not.toBeNull();
    expect(store.getMonoJob(actorB, job.id)).toBeNull();

    expect(store.listMonoJobs(actorA).map((j) => j.id)).toContain(job.id);
    expect(store.listMonoJobs(actorB).map((j) => j.id)).not.toContain(job.id);
  });

  it("rejects job creation against another workspace's asset with the current 400 message", async () => {
    const { newMonoActor } = await import("./service");
    const service = await import("./service");
    const store = await import("./store");

    const actorA = newMonoActor({ userId: "user-a", workspaceId: `ws-a-${crypto.randomUUID()}` });
    const actorB = newMonoActor({ userId: "user-b", workspaceId: `ws-b-${crypto.randomUUID()}` });

    const assetA = store.createMonoAsset(actorA, {
      sourceUrl: "https://example.test/a.png",
      mimeType: "image/png",
    });

    expect(() => service.createVideoAnalysisJob(actorB, { assetId: assetA.id }))
      .toThrow("素材不存在，或不属于当前工作区");
    expect(() => service.createMattingJob(actorB, { assetId: assetA.id, mediaType: "image" }))
      .toThrow("素材不存在，或不属于当前工作区");
  });

  it("does not let favorite/purge mutate another workspace's job", async () => {
    const { newMonoActor } = await import("./service");
    const store = await import("./store");

    const actorA = newMonoActor({ userId: "user-a", workspaceId: `ws-a-${crypto.randomUUID()}` });
    const actorB = newMonoActor({ userId: "user-b", workspaceId: `ws-b-${crypto.randomUUID()}` });

    const job = store.createMonoJob(actorA, "matting", { assetId: null, mediaType: "image" });
    store.failMonoJob(job.id, "forced-for-test");

    // setMonoJobFavorite/purgeMonoJob both filter by `id = ? AND workspace_id = ?`.
    const favoritedFromB = store.setMonoJobFavorite(actorB, job.id, true);
    expect(favoritedFromB).toBeNull();
    expect(store.getMonoJob(actorA, job.id)?.favorite).toBe(false);

    const purgedFromB = store.purgeMonoJob(actorB, job.id);
    expect(purgedFromB).toBe(false);
    expect(store.getMonoJob(actorA, job.id)).not.toBeNull();
  });
});
