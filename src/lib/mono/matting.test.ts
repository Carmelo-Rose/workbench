import { beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { monoMattingSchema } from "./contracts";

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const dbPath = path.join(os.tmpdir(), `workbench-matting-suite-${crypto.randomUUID()}.db`);

beforeAll(() => {
  setEnv("WORKBENCH_DB_PATH", dbPath);
  setEnv("NODE_ENV", "test");
});

describe("matting contract", () => {
  it("requires a media source and validates background color", () => {
    expect(monoMattingSchema.safeParse({}).success).toBe(false);
    expect(monoMattingSchema.safeParse({ assetId: "asset_1" }).success).toBe(true);
    expect(monoMattingSchema.parse({ mediaUrl: "https://example.com/a.mp4", mediaType: "video" }).mediaType).toBe("video");
    expect(monoMattingSchema.safeParse({ assetId: "asset_1", backgroundColor: "#12ab34" }).success).toBe(true);
    expect(monoMattingSchema.safeParse({ assetId: "asset_1", backgroundColor: "红色" }).success).toBe(false);
  });
});

describe("mono_jobs kind CHECK migration", () => {
  it("rebuilds a legacy table so new kinds can be inserted while old rows survive", async () => {
    // 先手工造一个带旧 kind CHECK 的库（v4 时代的表结构）。
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE mono_jobs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('video_analysis', 'image_generation')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        input_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        idempotency_key TEXT,
        trace_id TEXT NOT NULL,
        favorite INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        UNIQUE(workspace_id, idempotency_key)
      );
      INSERT INTO mono_jobs (id, workspace_id, user_id, kind, status, input_json, trace_id, created_at, updated_at)
      VALUES ('job_legacy', 'default', 'local-user', 'video_analysis', 'succeeded', '{}', 'trace_x', 1, 1);
    `);
    legacy.close();

    const { getDb } = await import("@/lib/server/db");
    const db = getDb();
    const migratedSql = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mono_jobs'",
    ).get() as { sql: string }).sql;
    expect(migratedSql).not.toContain("CHECK (kind IN");

    const legacyRow = db.prepare("SELECT kind, status FROM mono_jobs WHERE id = 'job_legacy'").get() as {
      kind: string;
      status: string;
    };
    expect(legacyRow).toEqual({ kind: "video_analysis", status: "succeeded" });

    db.prepare(
      `INSERT INTO mono_jobs (id, workspace_id, user_id, kind, status, input_json, trace_id, created_at, updated_at)
       VALUES ('job_matting', 'default', 'local-user', 'matting', 'queued', '{}', 'trace_y', 2, 2)`,
    ).run();
    db.prepare("DELETE FROM mono_jobs WHERE id = 'job_matting'").run();
  });
});

describe("matting job creation", () => {
  it("queues a matting job and rejects unknown assets", async () => {
    const { createMattingJob, newMonoActor, getJob } = await import("./service");
    const actor = newMonoActor({ userId: "local-user", workspaceId: "default" });

    expect(() => createMattingJob(actor, { assetId: "asset_missing", mediaType: "image" }))
      .toThrow(/素材不存在/u);

    const job = createMattingJob(actor, {
      mediaUrl: "https://example.com/model.png",
      mediaType: "image",
      backgroundColor: "#ffffff",
      idempotencyKey: "matting-test-1",
    });
    expect(job.kind).toBe("matting");
    expect(["queued", "running", "failed"]).toContain(job.status);
    expect(job.input).toMatchObject({ mediaUrl: "https://example.com/model.png", backgroundColor: "#ffffff" });

    // 幂等：同 key 不会重复建任务。
    const duplicate = createMattingJob(actor, {
      mediaUrl: "https://example.com/model.png",
      mediaType: "image",
      idempotencyKey: "matting-test-1",
    });
    expect(duplicate.id).toBe(job.id);
    expect(getJob(actor, job.id)?.id).toBe(job.id);
  });
});

describe("comfyui workflow templates", () => {
  it("fills placeholders and rejects missing tokens", async () => {
    const dir = path.join(os.tmpdir(), `workbench-workflows-${crypto.randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "matting-image.json"), JSON.stringify({
      "1": { class_type: "LoadImage", inputs: { image: "{{INPUT_MEDIA}}" } },
      "2": { class_type: "SaveImage", inputs: { color: "{{BACKGROUND_COLOR}}" } },
    }));
    setEnv("COMFYUI_WORKFLOWS_DIR", dir);
    const { loadComfyWorkflow } = await import("./comfyui");

    const workflow = await loadComfyWorkflow("matting-image", {
      INPUT_MEDIA: "input.png",
      BACKGROUND_COLOR: "#ffffff",
    }) as Record<string, { inputs: Record<string, string> }>;
    expect(workflow["1"].inputs.image).toBe("input.png");
    expect(workflow["2"].inputs.color).toBe("#ffffff");

    await expect(loadComfyWorkflow("matting-image", { INPUT_MEDIA: "input.png" }))
      .rejects.toThrow(/BACKGROUND_COLOR/u);
    await expect(loadComfyWorkflow("erase-video", {})).rejects.toThrow(/工作流未配置/u);
  });
});
