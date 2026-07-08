import { getDb } from "./db";

export type ThreadRecord = {
  remoteId: string;
  externalId: string | null;
  status: "regular" | "archived";
  title: string | null;
  custom: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number | null;
};

/** 与客户端 MessageStorageEntry 对齐的行格式（content 为解码后的 JSON）。 */
export type StoredEntry = {
  id: string;
  parent_id: string | null;
  format: string;
  content: unknown;
};

export type ThreadSnapshot = {
  thread: Omit<ThreadRecord, "createdAt" | "updatedAt">;
  headId: string | null;
  entries: StoredEntry[];
};

type ThreadRow = {
  remote_id: string;
  external_id: string | null;
  status: string;
  title: string | null;
  custom_json: string | null;
  head_id: string | null;
  created_at: number;
  updated_at: number;
  last_message_at: number | null;
};

type MessageRow = {
  id: string;
  parent_id: string | null;
  format: string;
  content_json: string;
};

// node:sqlite 没有 .transaction() 助手，手写 BEGIN/COMMIT/ROLLBACK。
function tx<T>(fn: () => T): T {
  const db = getDb();
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function toRecord(row: ThreadRow): ThreadRecord {
  return {
    remoteId: row.remote_id,
    externalId: row.external_id,
    status: row.status === "archived" ? "archived" : "regular",
    title: row.title,
    custom: row.custom_json
      ? (JSON.parse(row.custom_json) as Record<string, unknown>)
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at,
  };
}

export function listThreads(): ThreadRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM threads ORDER BY created_at DESC")
    .all() as ThreadRow[];
  return rows.map(toRecord);
}

export function getThread(remoteId: string): ThreadRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM threads WHERE remote_id = ?")
    .get(remoteId) as ThreadRow | undefined;
  return row ? toRecord(row) : null;
}

/** initialize 语义：幂等，已存在时不改动任何字段。 */
export function ensureThread(remoteId: string): {
  remoteId: string;
  externalId: string | null;
} {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO threads (remote_id, created_at, updated_at)
       VALUES (?, ?, ?)`,
    )
    .run(remoteId, now, now);
  const row = getDb()
    .prepare("SELECT external_id FROM threads WHERE remote_id = ?")
    .get(remoteId) as { external_id: string | null };
  return { remoteId, externalId: row.external_id };
}

export function updateThread(
  remoteId: string,
  patch: {
    title?: string;
    status?: "regular" | "archived";
    custom?: Record<string, unknown> | null;
  },
): boolean {
  const sets: string[] = ["updated_at = ?"];
  const values: (string | number | null)[] = [Date.now()];
  if (patch.title !== undefined) {
    sets.push("title = ?");
    values.push(patch.title);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    values.push(patch.status);
  }
  if (patch.custom !== undefined) {
    sets.push("custom_json = ?");
    values.push(patch.custom === null ? null : JSON.stringify(patch.custom));
  }
  values.push(remoteId);
  const result = getDb()
    .prepare(`UPDATE threads SET ${sets.join(", ")} WHERE remote_id = ?`)
    .run(...values);
  return result.changes > 0;
}

export function deleteThread(remoteId: string): boolean {
  // ON DELETE CASCADE 依赖连接级 foreign_keys=ON（db.ts 已设）。
  const result = getDb()
    .prepare("DELETE FROM threads WHERE remote_id = ?")
    .run(remoteId);
  return result.changes > 0;
}

export function deleteAllThreads(): void {
  tx(() => {
    getDb().exec("DELETE FROM messages");
    getDb().exec("DELETE FROM threads");
  });
}

export function loadRepo(
  threadId: string,
  format: string,
): { headId: string | null; entries: StoredEntry[] } {
  const thread = getDb()
    .prepare("SELECT head_id FROM threads WHERE remote_id = ?")
    .get(threadId) as { head_id: string | null } | undefined;
  const rows = getDb()
    .prepare(
      `SELECT id, parent_id, format, content_json FROM messages
       WHERE thread_id = ? AND format = ? ORDER BY rowid`,
    )
    .all(threadId, format) as MessageRow[];
  return {
    headId: thread?.head_id ?? null,
    entries: rows.map((r) => ({
      id: r.id,
      parent_id: r.parent_id,
      format: r.format,
      content: JSON.parse(r.content_json),
    })),
  };
}

export function appendEntry(threadId: string, entry: StoredEntry): void {
  const now = Date.now();
  tx(() => {
    ensureThread(threadId);
    // ON CONFLICT 原位更新保留 rowid（插入序），镜像 localStorage upsert。
    getDb()
      .prepare(
        `INSERT INTO messages (thread_id, id, parent_id, format, content_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id, id) DO UPDATE SET
           parent_id = excluded.parent_id,
           format = excluded.format,
           content_json = excluded.content_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        threadId,
        entry.id,
        entry.parent_id,
        entry.format,
        JSON.stringify(entry.content),
        now,
        now,
      );
    getDb()
      .prepare(
        "UPDATE threads SET head_id = ?, last_message_at = ?, updated_at = ? WHERE remote_id = ?",
      )
      .run(entry.id, now, now, threadId);
  });
}

/**
 * update 语义（最大正确性风险）：runtime 重新生成消息时按旧 localMessageId
 * 匹配、存到新 id 下。按 entry.id 或 matchId 找到既有行后原位改写
 * （保留 rowid），head 指向 matchId 时挪到新 id。
 */
export function updateEntry(
  threadId: string,
  entry: StoredEntry,
  matchId: string | undefined,
): void {
  const now = Date.now();
  const db = getDb();
  tx(() => {
    const contentJson = JSON.stringify(entry.content);
    const exact = db
      .prepare("SELECT rowid FROM messages WHERE thread_id = ? AND id = ?")
      .get(threadId, entry.id) as { rowid: number } | undefined;
    const matched =
      matchId !== undefined && matchId !== entry.id
        ? (db
            .prepare(
              "SELECT rowid FROM messages WHERE thread_id = ? AND id = ?",
            )
            .get(threadId, matchId) as { rowid: number } | undefined)
        : undefined;

    if (exact) {
      db.prepare(
        `UPDATE messages SET parent_id = ?, format = ?, content_json = ?, updated_at = ?
         WHERE rowid = ?`,
      ).run(entry.parent_id, entry.format, contentJson, now, exact.rowid);
      // 同一逻辑消息不能同时以新旧两个 id 存在，清掉旧行防重复。
      if (matched) db.prepare("DELETE FROM messages WHERE rowid = ?").run(matched.rowid);
    } else if (matched) {
      db.prepare(
        `UPDATE messages SET id = ?, parent_id = ?, format = ?, content_json = ?, updated_at = ?
         WHERE rowid = ?`,
      ).run(entry.id, entry.parent_id, entry.format, contentJson, now, matched.rowid);
    } else {
      db.prepare(
        `INSERT INTO messages (thread_id, id, parent_id, format, content_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(threadId, entry.id, entry.parent_id, entry.format, contentJson, now, now);
    }

    if (matchId !== undefined) {
      const thread = db
        .prepare("SELECT head_id FROM threads WHERE remote_id = ?")
        .get(threadId) as { head_id: string | null } | undefined;
      if (thread?.head_id === matchId) {
        db.prepare(
          "UPDATE threads SET head_id = ?, updated_at = ? WHERE remote_id = ?",
        ).run(entry.id, now, threadId);
      }
    }
  });
}

export function deleteEntries(threadId: string, ids: string[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  tx(() => {
    const placeholders = ids.map(() => "?").join(", ");
    db.prepare(
      `DELETE FROM messages WHERE thread_id = ? AND id IN (${placeholders})`,
    ).run(threadId, ...ids);
    const thread = db
      .prepare("SELECT head_id FROM threads WHERE remote_id = ?")
      .get(threadId) as { head_id: string | null } | undefined;
    if (thread?.head_id && ids.includes(thread.head_id)) {
      const last = db
        .prepare(
          "SELECT id FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT 1",
        )
        .get(threadId) as { id: string } | undefined;
      db.prepare(
        "UPDATE threads SET head_id = ?, updated_at = ? WHERE remote_id = ?",
      ).run(last?.id ?? null, Date.now(), threadId);
    }
  });
}

/** 一次性迁移导入：已存在的线程/消息跳过，不覆盖。 */
export function importSnapshot(snapshots: ThreadSnapshot[]): {
  importedThreads: number;
  importedMessages: number;
} {
  const db = getDb();
  let importedThreads = 0;
  let importedMessages = 0;
  tx(() => {
    for (const snap of snapshots) {
      const now = Date.now();
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO threads
           (remote_id, external_id, status, title, custom_json, head_id, created_at, updated_at, last_message_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          snap.thread.remoteId,
          snap.thread.externalId,
          snap.thread.status,
          snap.thread.title,
          snap.thread.custom ? JSON.stringify(snap.thread.custom) : null,
          snap.headId,
          now,
          now,
          snap.thread.lastMessageAt,
        );
      if (result.changes > 0) importedThreads += 1;
      for (const entry of snap.entries) {
        const inserted = db
          .prepare(
            `INSERT OR IGNORE INTO messages
             (thread_id, id, parent_id, format, content_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            snap.thread.remoteId,
            entry.id,
            entry.parent_id,
            entry.format,
            JSON.stringify(entry.content),
            now,
            now,
          );
        if (inserted.changes > 0) importedMessages += 1;
      }
    }
  });
  return { importedThreads, importedMessages };
}

export function exportSnapshot(): ThreadSnapshot[] {
  const threads = listThreads();
  const db = getDb();
  return threads.map((thread) => {
    const rows = db
      .prepare(
        `SELECT id, parent_id, format, content_json FROM messages
         WHERE thread_id = ? ORDER BY rowid`,
      )
      .all(thread.remoteId) as MessageRow[];
    const head = db
      .prepare("SELECT head_id FROM threads WHERE remote_id = ?")
      .get(thread.remoteId) as { head_id: string | null };
    return {
      thread: {
        remoteId: thread.remoteId,
        externalId: thread.externalId,
        status: thread.status,
        title: thread.title,
        custom: thread.custom,
        lastMessageAt: thread.lastMessageAt,
      },
      headId: head.head_id,
      entries: rows.map((r) => ({
        id: r.id,
        parent_id: r.parent_id,
        format: r.format,
        content: JSON.parse(r.content_json),
      })),
    };
  });
}
