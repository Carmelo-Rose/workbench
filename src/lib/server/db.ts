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
`;

function openDb(): DatabaseSync {
  const dbPath =
    process.env.WORKBENCH_DB_PATH ??
    path.join(process.cwd(), "data", "workbench.db");
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(DDL);
  db.exec("PRAGMA user_version = 1");
  console.log(`[workbench] sqlite db at ${dbPath}`);
  return db;
}

// 缓存在 globalThis 上，dev HMR 重新执行模块时复用同一连接。
const globalForDb = globalThis as typeof globalThis & {
  __workbenchDb?: DatabaseSync;
};

export function getDb(): DatabaseSync {
  globalForDb.__workbenchDb ??= openDb();
  return globalForDb.__workbenchDb;
}
