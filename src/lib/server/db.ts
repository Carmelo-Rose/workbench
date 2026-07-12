import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const DDL = `
CREATE TABLE IF NOT EXISTS threads (
  remote_id TEXT PRIMARY KEY,
  external_id TEXT,
  status TEXT NOT NULL DEFAULT 'regular' CHECK (status IN ('regular','archived')),
  title TEXT,
  custom_json TEXT,
  head_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_message_at INTEGER
);
CREATE TABLE IF NOT EXISTS messages (
  thread_id TEXT NOT NULL REFERENCES threads(remote_id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  parent_id TEXT,
  format TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, id)
);
CREATE TABLE IF NOT EXISTS mono_assets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  mime_type TEXT,
  name TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mono_assets_workspace_created
  ON mono_assets(workspace_id, created_at DESC);
CREATE TABLE IF NOT EXISTS mono_subjects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  asset_id TEXT NOT NULL REFERENCES mono_assets(id),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'workspace')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mono_subjects_workspace_updated
  ON mono_subjects(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS mono_subjects_owner_updated
  ON mono_subjects(owner_user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS mono_jobs (
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
CREATE INDEX IF NOT EXISTS mono_jobs_workspace_updated
  ON mono_jobs(workspace_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS mono_job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES mono_jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  detail_json TEXT,
  created_at INTEGER NOT NULL
);
`;

function ensureSchema(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(DDL);
  // v3：既有库补 favorite 列（DDL 的 CREATE TABLE IF NOT EXISTS 不会改老表）。
  const jobColumns = db.prepare("PRAGMA table_info(mono_jobs)").all() as { name: string }[];
  if (!jobColumns.some((column) => column.name === "favorite")) {
    db.exec("ALTER TABLE mono_jobs ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0");
  }
  db.exec("PRAGMA user_version = 4");
}

function openDb(): DatabaseSync {
  const dbPath =
    process.env.WORKBENCH_DB_PATH ??
    path.join(process.cwd(), "data", "workbench.db");
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  ensureSchema(db);
  console.log(`[workbench] sqlite db at ${dbPath}`);
  return db;
}

// 缓存在 globalThis 上，dev HMR 重新执行模块时复用同一连接。
const globalForDb = globalThis as typeof globalThis & {
  __workbenchDb?: DatabaseSync;
};

export function getDb(): DatabaseSync {
  globalForDb.__workbenchDb ??= openDb();
  // Dev HMR can retain an older connection after DDL changes. All statements
  // are idempotent, so reapplying them also serves as a lightweight migration.
  ensureSchema(globalForDb.__workbenchDb);
  return globalForDb.__workbenchDb;
}
