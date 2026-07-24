import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openWorkbenchDatabase } from "./db";

describe("default workspace migration", () => {
  it("backfills legacy threads, messages, and config", () => {
    const dbPath = path.join(
      os.tmpdir(),
      `workbench-legacy-${crypto.randomUUID()}.db`,
    );
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE threads (
        remote_id TEXT PRIMARY KEY,
        external_id TEXT,
        status TEXT NOT NULL DEFAULT 'regular',
        title TEXT,
        custom_json TEXT,
        head_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_message_at INTEGER
      );
      CREATE TABLE messages (
        thread_id TEXT NOT NULL,
        id TEXT NOT NULL,
        parent_id TEXT,
        format TEXT NOT NULL,
        content_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (thread_id, id)
      );
      CREATE TABLE api_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO threads
        (remote_id, status, title, created_at, updated_at)
      VALUES ('legacy-thread', 'regular', 'Legacy', 1, 1);
      INSERT INTO messages
        (thread_id, id, parent_id, format, content_json, created_at, updated_at)
      VALUES
        ('legacy-thread', 'legacy-message', NULL, 'ai-sdk/v6', '{}', 1, 1);
      INSERT INTO api_config (key, value, updated_at)
      VALUES ('CHAT_MODEL', 'legacy-model', 1);
    `);
    legacy.close();

    const migrated = openWorkbenchDatabase(dbPath);
    expect(migrated.prepare(
      `SELECT workspace_id, owner_user_id FROM threads
       WHERE remote_id = 'legacy-thread'`,
    ).get()).toEqual({
      workspace_id: "default",
      owner_user_id: "local-user",
    });
    expect(migrated.prepare(
      `SELECT workspace_id FROM messages
       WHERE thread_id = 'legacy-thread'`,
    ).get()).toEqual({ workspace_id: "default" });
    expect(migrated.prepare(
      `SELECT workspace_id, value FROM api_config
       WHERE key = 'CHAT_MODEL'`,
    ).get()).toEqual({
      workspace_id: "default",
      value: "legacy-model",
    });
    expect(migrated.prepare(
      "SELECT organization_id FROM workspaces WHERE id = 'default'",
    ).get()).toEqual({ organization_id: "org_default" });
    expect(migrated.prepare("PRAGMA user_version").get())
      .toEqual({ user_version: 9 });
    migrated.close();
  });

  it("backfills mono_assets.location from storage_key on a pre-v9 database", () => {
    const dbPath = path.join(
      os.tmpdir(),
      `workbench-asset-location-${crypto.randomUUID()}.db`,
    );
    const legacy = new DatabaseSync(dbPath);
    // Pre-v9 shape: no `location` column yet, matching what production DBs
    // created before this migration actually look like on disk.
    legacy.exec(`
      CREATE TABLE mono_assets (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        source_url TEXT NOT NULL,
        mime_type TEXT,
        name TEXT,
        storage_key TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    legacy.prepare(
      `INSERT INTO mono_assets (id, workspace_id, user_id, source_url, storage_key, created_at)
       VALUES (?, 'ws-1', 'user-1', ?, ?, 1)`,
    ).run("asset_local", "storage:some-key", "some-key");
    legacy.prepare(
      `INSERT INTO mono_assets (id, workspace_id, user_id, source_url, storage_key, created_at)
       VALUES (?, 'ws-1', 'user-1', ?, NULL, 1)`,
    ).run("asset_remote", "https://cdn.example.test/a.png");
    legacy.close();

    const migrated = openWorkbenchDatabase(dbPath);
    expect(migrated.prepare("SELECT location FROM mono_assets WHERE id = ?").get("asset_local"))
      .toEqual({ location: "local-storage" });
    expect(migrated.prepare("SELECT location FROM mono_assets WHERE id = ?").get("asset_remote"))
      .toEqual({ location: "remote-url" });
    migrated.close();
  });
});
