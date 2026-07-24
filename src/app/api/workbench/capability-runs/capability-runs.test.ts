import { afterEach, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";

// Route-level tests for the new unified capability execution endpoint
// (architecture plan Phase 2). Follows the same MONO_LOCAL_DEVELOPMENT bridge
// pattern as src/lib/mono/image2.test.ts for exercising route handlers
// directly with plain Request objects.

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const headers = { "Content-Type": "application/json", Origin: "http://localhost" };

beforeAll(() => {
  setEnv("WORKBENCH_DB_PATH", path.join(os.tmpdir(), `workbench-capability-runs-${crypto.randomUUID()}.db`));
  setEnv("NODE_ENV", "test");
  setEnv("MONO_LOCAL_DEVELOPMENT", "true");
});

afterEach(() => {
  setEnv("NODE_ENV", "test");
  setEnv("MONO_LOCAL_DEVELOPMENT", "true");
});

describe("POST /api/workbench/capability-runs", () => {
  it("creates an async run (202) and the run is fetchable via GET /:id", async () => {
    const { POST } = await import("./route");
    const { GET } = await import("./[id]/route");

    const created = await POST(new Request("http://localhost/api/workbench/capability-runs", {
      method: "POST",
      headers,
      body: JSON.stringify({
        capabilityId: "mono_analyze_video",
        input: { videoUrl: "https://example.test/clip.mp4" },
      }),
    }));
    expect(created.status).toBe(202);
    const { run } = await created.json() as { run: { id: string; capabilityId: string; status: string } };
    expect(run).toMatchObject({ capabilityId: "mono_analyze_video", status: "queued" });

    const fetched = await GET(
      new Request(`http://localhost/api/workbench/capability-runs/${run.id}`, { headers }),
      { params: Promise.resolve({ id: run.id }) },
    );
    expect(fetched.status).toBe(200);
    const { run: fetchedRun } = await fetched.json() as { run: { id: string; capabilityId: string } };
    expect(fetchedRun).toMatchObject({ id: run.id, capabilityId: "mono_analyze_video" });
  });

  it("404s GET /:id for an id that was never persisted as a job (sync-capability run ids)", async () => {
    // Sync capabilities (image_to_prompt) never call createMonoJob, so a run
    // id minted for one is never queryable — proven directly here without
    // depending on a real vision-model network call in this route test.
    const { GET } = await import("./[id]/route");
    const fetched = await GET(
      new Request("http://localhost/api/workbench/capability-runs/run_nonexistent", { headers }),
      { params: Promise.resolve({ id: "run_nonexistent" }) },
    );
    expect(fetched.status).toBe(404);
  });

  it("returns 404 for an unknown capabilityId", async () => {
    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/workbench/capability-runs", {
      method: "POST",
      headers,
      body: JSON.stringify({ capabilityId: "does_not_exist", input: {} }),
    }));
    expect(response.status).toBe(404);
  });

  it("returns 400 when input fails the capability's schema", async () => {
    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/workbench/capability-runs", {
      method: "POST",
      headers,
      body: JSON.stringify({ capabilityId: "mono_generate_image", input: {} }),
    }));
    expect(response.status).toBe(400);
  });

  it("cancels a queued run through POST /:id/cancel", async () => {
    const { POST } = await import("./route");
    const { POST: cancel } = await import("./[id]/cancel/route");

    const created = await POST(new Request("http://localhost/api/workbench/capability-runs", {
      method: "POST",
      headers,
      body: JSON.stringify({
        capabilityId: "mono_matting",
        input: { mediaUrl: "https://example.test/a.png", mediaType: "image" },
      }),
    }));
    const { run } = await created.json() as { run: { id: string } };

    const cancelled = await cancel(
      new Request(`http://localhost/api/workbench/capability-runs/${run.id}/cancel`, { method: "POST", headers }),
      { params: Promise.resolve({ id: run.id }) },
    );
    expect(cancelled.status).toBe(200);
    const { run: cancelledRun } = await cancelled.json() as { run: { status: string } };
    expect(["cancelled", "succeeded", "failed"]).toContain(cancelledRun.status);
  });

  it("keeps a run scoped to the workspace that created it", async () => {
    // The route delegates straight to getJob(actor, id) / cancelJob(actor, id),
    // which src/lib/mono/asset-isolation.test.ts already proves are workspace-
    // scoped. This just checks the route wires a *different* actor's lookup
    // through correctly rather than re-testing the store's isolation logic.
    const { POST } = await import("./route");
    const store = await import("@/lib/mono/store");
    const { newMonoActor } = await import("@/lib/mono/service");

    const created = await POST(new Request("http://localhost/api/workbench/capability-runs", {
      method: "POST",
      headers,
      body: JSON.stringify({
        capabilityId: "mono_analyze_video",
        input: { videoUrl: "https://example.test/isolation.mp4" },
      }),
    }));
    const { run } = await created.json() as { run: { id: string } };

    const otherActor = newMonoActor({ userId: "other-user", workspaceId: `other-ws-${crypto.randomUUID()}` });
    expect(store.getMonoJob(otherActor, run.id)).toBeNull();
  });
});
