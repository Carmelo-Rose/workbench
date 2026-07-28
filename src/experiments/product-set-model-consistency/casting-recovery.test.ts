import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runner = vi.hoisted(() => ({
  scheduleCasting: vi.fn(),
  scheduleRun: vi.fn(),
  castingIsActive: vi.fn(() => false),
  runIsActive: vi.fn(() => false),
}));

vi.mock("./runner", () => ({
  candidatePrompt: (group: string, index: number) => `${group}-${index}`,
  configuredExperimentModel: () => "gpt-image-2",
  ...runner,
}));

import {
  buildCastingCandidates,
  castingForWorkspace,
  continueCasting,
  createCasting,
  createProfiles,
} from "./service";
import {
  castingDir,
  ensureExperimentRoot,
  getCasting,
  newCastingId,
  saveCasting,
} from "./storage";
import type { CastingRecord } from "./types";

let temporaryRoot = "";

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "model-consistency-casting-"));
  process.env.MODEL_CONSISTENCY_TEST_ROOT = temporaryRoot;
  runner.scheduleCasting.mockReset();
  runner.castingIsActive.mockReturnValue(false);
  await ensureExperimentRoot();
});

afterEach(async () => {
  delete process.env.MODEL_CONSISTENCY_TEST_ROOT;
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("casting recovery", () => {
  it("creates a free draft and never schedules image generation on creation", async () => {
    const casting = await createCasting("workspace-a", { candidateCountPerGroup: 4 });
    expect(casting.status).toBe("draft");
    expect(runner.scheduleCasting).not.toHaveBeenCalled();
  });

  it("recovers a stale casting, preserves successful candidates, and only continues the requested candidate", async () => {
    const id = newCastingId();
    const candidates = buildCastingCandidates(4);
    candidates.find((candidate) => candidate.id === "female-1")!.status = "succeeded";
    candidates.find((candidate) => candidate.id === "male-1")!.status = "succeeded";
    candidates.find((candidate) => candidate.id === "female-2")!.status = "generating";
    const casting: CastingRecord = {
      id,
      workspaceId: "workspace-a",
      status: "running",
      provider: "mono-image",
      model: "gpt-image-2",
      candidateCountPerGroup: 4,
      candidates,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await saveCasting(casting);

    const recovered = await castingForWorkspace("workspace-a", id);
    expect(recovered.status).toBe("interrupted");
    expect(recovered.candidates.find((candidate) => candidate.id === "female-1")?.status).toBe("succeeded");
    expect(recovered.candidates.find((candidate) => candidate.id === "female-2")?.status).toBe("interrupted");
    expect(runner.scheduleCasting).not.toHaveBeenCalled();

    const continued = await continueCasting("workspace-a", id, { candidateIds: ["female-2"] });
    expect(continued.candidates.find((candidate) => candidate.id === "female-1")?.status).toBe("succeeded");
    expect(continued.candidates.find((candidate) => candidate.id === "female-2")?.status).toBe("queued");
    expect(runner.scheduleCasting).toHaveBeenCalledWith(id, ["female-2"]);
    await expect(continueCasting("workspace-a", id, { candidateIds: ["female-1"] })).rejects.toThrow("Succeeded");
  });

  it("treats an image already written to disk as succeeded during recovery", async () => {
    const id = newCastingId();
    const candidates = buildCastingCandidates(4);
    candidates.find((candidate) => candidate.id === "female-2")!.status = "generating";
    await mkdir(castingDir(id), { recursive: true });
    await writeFile(path.join(castingDir(id), "female-2.jpg"), "already-generated");
    await saveCasting({
      id,
      workspaceId: "workspace-a",
      status: "running",
      provider: "mono-image",
      model: "gpt-image-2",
      candidateCountPerGroup: 4,
      candidates,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const recovered = await castingForWorkspace("workspace-a", id);
    expect(recovered.candidates.find((candidate) => candidate.id === "female-2")?.status).toBe("succeeded");
    await expect(continueCasting("workspace-a", id, { candidateIds: ["female-2"] })).rejects.toThrow("Succeeded");
  });

  it("allows reusable profile cards from successful candidates in an interrupted casting", async () => {
    const id = newCastingId();
    const candidates = buildCastingCandidates(4);
    for (const candidateId of ["female-1", "male-1"]) {
      candidates.find((candidate) => candidate.id === candidateId)!.status = "succeeded";
      await mkdir(castingDir(id), { recursive: true });
      await writeFile(path.join(castingDir(id), `${candidateId}.jpg`), "placeholder");
    }
    await saveCasting({
      id,
      workspaceId: "workspace-a",
      status: "interrupted",
      provider: "mono-image",
      model: "gpt-image-2",
      candidateCountPerGroup: 4,
      candidates,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const profiles = await createProfiles("workspace-a", {
      castingId: id,
      selections: { female: "female-1", male: "male-1" },
      names: { female: "Female anchor", male: "Male anchor" },
    });
    expect(profiles.map((profile) => profile.groupId).sort()).toEqual(["female", "male"]);
    expect((await getCasting(id)).candidates.filter((candidate) => candidate.status === "succeeded")).toHaveLength(2);
  });
});
