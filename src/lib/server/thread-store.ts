import { getDb } from "./db";

/** A chat history is private to one employee inside one workspace. */
export type ThreadScope = {
  workspaceId: string;
  userId: string;
};

export class ThreadScopeError extends Error {
  constructor(message = "Thread not found") {
    super(message);
  }
}

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

/** Persisted row aligned to assistant-ui MessageStorageEntry. */
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

function tx<T>(fn: () => T): T {
  const db = getDb();
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function toRecord(row: ThreadRow): ThreadRecord {
  return {
    remoteId: row.remote_id,
    externalId: row.external_id,
    status: row.status === "archived" ? "archived" : "regular",
    title: row.title,
    custom: row.custom_json ? (JSON.parse(row.custom_json) as Record<string, unknown>) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at,
  };
}

function threadRow(scope: ThreadScope, remoteId: string): ThreadRow | undefined {
  return getDb().prepare(
    `SELECT * FROM threads
     WHERE remote_id = ? AND workspace_id = ? AND owner_user_id = ?`,
  ).get(remoteId, scope.workspaceId, scope.userId) as ThreadRow | undefined;
}

function requireThread(scope: ThreadScope, remoteId: string): ThreadRow {
  const row = threadRow(scope, remoteId);
  if (!row) throw new ThreadScopeError();
  return row;
}

export function listThreads(scope: ThreadScope): ThreadRecord[] {
  const rows = getDb().prepare(
    `SELECT * FROM threads
     WHERE workspace_id = ? AND owner_user_id = ?
     ORDER BY created_at DESC`,
  ).all(scope.workspaceId, scope.userId) as ThreadRow[];
  return rows.map(toRecord);
}

export function getThread(scope: ThreadScope, remoteId: string): ThreadRecord | null {
  const row = threadRow(scope, remoteId);
  return row ? toRecord(row) : null;
}

/** Initialize is idempotent, but never adopts a thread owned by another employee. */
export function ensureThread(scope: ThreadScope, remoteId: string): {
  remoteId: string;
  externalId: string | null;
} {
  const now = Date.now();
  getDb().prepare(
    `INSERT OR IGNORE INTO threads (remote_id, workspace_id, owner_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(remoteId, scope.workspaceId, scope.userId, now, now);
  const row = requireThread(scope, remoteId);
  return { remoteId, externalId: row.external_id };
}

export function updateThread(
  scope: ThreadScope,
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
  values.push(remoteId, scope.workspaceId, scope.userId);
  const result = getDb().prepare(
    `UPDATE threads SET ${sets.join(", ")}
     WHERE remote_id = ? AND workspace_id = ? AND owner_user_id = ?`,
  ).run(...values);
  return result.changes > 0;
}

export function deleteThread(scope: ThreadScope, remoteId: string): boolean {
  const result = getDb().prepare(
    `DELETE FROM threads
     WHERE remote_id = ? AND workspace_id = ? AND owner_user_id = ?`,
  ).run(remoteId, scope.workspaceId, scope.userId);
  return result.changes > 0;
}

export function deleteAllThreads(scope: ThreadScope): void {
  getDb().prepare(
    "DELETE FROM threads WHERE workspace_id = ? AND owner_user_id = ?",
  ).run(scope.workspaceId, scope.userId);
}

export function loadRepo(
  scope: ThreadScope,
  threadId: string,
  format: string,
): { headId: string | null; entries: StoredEntry[] } {
  const thread = requireThread(scope, threadId);
  const rows = getDb().prepare(
    `SELECT id, parent_id, format, content_json FROM messages
     WHERE workspace_id = ? AND thread_id = ? AND format = ? ORDER BY rowid`,
  ).all(scope.workspaceId, threadId, format) as MessageRow[];
  return {
    headId: thread.head_id,
    entries: rows.map((row) => ({
      id: row.id,
      parent_id: row.parent_id,
      format: row.format,
      content: JSON.parse(row.content_json),
    })),
  };
}

export function appendEntry(scope: ThreadScope, threadId: string, entry: StoredEntry): void {
  const now = Date.now();
  tx(() => {
    ensureThread(scope, threadId);
    getDb().prepare(
      `INSERT INTO messages
         (workspace_id, thread_id, id, parent_id, format, content_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, thread_id, id) DO UPDATE SET
         parent_id = excluded.parent_id,
         format = excluded.format,
         content_json = excluded.content_json,
         updated_at = excluded.updated_at`,
    ).run(
      scope.workspaceId,
      threadId,
      entry.id,
      entry.parent_id,
      entry.format,
      JSON.stringify(entry.content),
      now,
      now,
    );
    getDb().prepare(
      `UPDATE threads SET head_id = ?, last_message_at = ?, updated_at = ?
       WHERE remote_id = ? AND workspace_id = ? AND owner_user_id = ?`,
    ).run(entry.id, now, now, threadId, scope.workspaceId, scope.userId);
  });
}

export function updateEntry(
  scope: ThreadScope,
  threadId: string,
  entry: StoredEntry,
  matchId: string | undefined,
): void {
  const now = Date.now();
  const db = getDb();
  tx(() => {
    requireThread(scope, threadId);
    const contentJson = JSON.stringify(entry.content);
    const exact = db.prepare(
      `SELECT rowid FROM messages
       WHERE workspace_id = ? AND thread_id = ? AND id = ?`,
    ).get(scope.workspaceId, threadId, entry.id) as { rowid: number } | undefined;
    const matched = matchId !== undefined && matchId !== entry.id
      ? (db.prepare(
          `SELECT rowid FROM messages
           WHERE workspace_id = ? AND thread_id = ? AND id = ?`,
        ).get(scope.workspaceId, threadId, matchId) as { rowid: number } | undefined)
      : undefined;

    if (exact) {
      db.prepare(
        `UPDATE messages SET parent_id = ?, format = ?, content_json = ?, updated_at = ?
         WHERE rowid = ?`,
      ).run(entry.parent_id, entry.format, contentJson, now, exact.rowid);
      if (matched) db.prepare("DELETE FROM messages WHERE rowid = ?").run(matched.rowid);
    } else if (matched) {
      db.prepare(
        `UPDATE messages SET id = ?, parent_id = ?, format = ?, content_json = ?, updated_at = ?
         WHERE rowid = ?`,
      ).run(entry.id, entry.parent_id, entry.format, contentJson, now, matched.rowid);
    } else {
      db.prepare(
        `INSERT INTO messages
           (workspace_id, thread_id, id, parent_id, format, content_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        scope.workspaceId,
        threadId,
        entry.id,
        entry.parent_id,
        entry.format,
        contentJson,
        now,
        now,
      );
    }

    if (matchId !== undefined) {
      const thread = requireThread(scope, threadId);
      if (thread.head_id === matchId) {
        db.prepare(
          `UPDATE threads SET head_id = ?, updated_at = ?
           WHERE remote_id = ? AND workspace_id = ? AND owner_user_id = ?`,
        ).run(entry.id, now, threadId, scope.workspaceId, scope.userId);
      }
    }
  });
}

export function deleteEntries(scope: ThreadScope, threadId: string, ids: string[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  tx(() => {
    const thread = requireThread(scope, threadId);
    const placeholders = ids.map(() => "?").join(", ");
    db.prepare(
      `DELETE FROM messages
       WHERE workspace_id = ? AND thread_id = ? AND id IN (${placeholders})`,
    ).run(scope.workspaceId, threadId, ...ids);
    if (thread.head_id && ids.includes(thread.head_id)) {
      const last = db.prepare(
        `SELECT id FROM messages
         WHERE workspace_id = ? AND thread_id = ?
         ORDER BY rowid DESC LIMIT 1`,
      ).get(scope.workspaceId, threadId) as { id: string } | undefined;
      db.prepare(
        `UPDATE threads SET head_id = ?, updated_at = ?
         WHERE remote_id = ? AND workspace_id = ? AND owner_user_id = ?`,
      ).run(last?.id ?? null, Date.now(), threadId, scope.workspaceId, scope.userId);
    }
  });
}

/** One-time browser backup import. Existing private threads and messages are retained. */
export function importSnapshot(
  scope: ThreadScope,
  snapshots: ThreadSnapshot[],
): { importedThreads: number; importedMessages: number } {
  const db = getDb();
  let importedThreads = 0;
  let importedMessages = 0;
  tx(() => {
    for (const snapshot of snapshots) {
      const now = Date.now();
      const result = db.prepare(
        `INSERT OR IGNORE INTO threads
         (remote_id, workspace_id, owner_user_id, external_id, status, title, custom_json, head_id, created_at, updated_at, last_message_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        snapshot.thread.remoteId,
        scope.workspaceId,
        scope.userId,
        snapshot.thread.externalId,
        snapshot.thread.status,
        snapshot.thread.title,
        snapshot.thread.custom ? JSON.stringify(snapshot.thread.custom) : null,
        snapshot.headId,
        now,
        now,
        snapshot.thread.lastMessageAt,
      );
      const ownedThread = threadRow(scope, snapshot.thread.remoteId);
      // A same-workspace id collision belongs to someone else; never insert
      // messages into it or expose that it exists.
      if (!ownedThread) continue;
      if (result.changes > 0) importedThreads += 1;
      for (const entry of snapshot.entries) {
        const inserted = db.prepare(
          `INSERT OR IGNORE INTO messages
           (workspace_id, thread_id, id, parent_id, format, content_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          scope.workspaceId,
          snapshot.thread.remoteId,
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

export type ThreadSearchHit = {
  threadId: string;
  title: string | null;
  lastMessageAt: number | null;
  snippet: string | null;
  matchedIn: "title" | "message";
};

/** 转义 LIKE 通配符，配合 `ESCAPE '\'` 使用。 */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 正文预筛的行数上限：先用 LIKE 命中候选行，再逐行 JSON 解析确认，避免全表扫描拖垮侧边栏。 */
const MESSAGE_PREFILTER_LIMIT = 500;
const SNIPPET_RADIUS = 40;

type TitleRow = { remote_id: string; title: string | null; last_message_at: number | null };
type MessageSearchRow = {
  thread_id: string;
  content_json: string;
  title: string | null;
  last_message_at: number | null;
};

/** 标题 LIKE 命中优先，正文用 LIKE 预筛 + parts[] 文本二次确认，双 scope 隔离。 */
export function searchThreads(scope: ThreadScope, q: string, limit = 20): ThreadSearchHit[] {
  const query = q.trim();
  if (!query) return [];
  const db = getDb();
  const likeQuery = `%${escapeLike(query)}%`;
  const hits = new Map<string, ThreadSearchHit>();

  const titleRows = db.prepare(
    `SELECT remote_id, title, last_message_at FROM threads
     WHERE workspace_id = ? AND owner_user_id = ? AND title LIKE ? ESCAPE '\\'
     ORDER BY last_message_at DESC
     LIMIT ?`,
  ).all(scope.workspaceId, scope.userId, likeQuery, limit) as TitleRow[];
  for (const row of titleRows) {
    hits.set(row.remote_id, {
      threadId: row.remote_id,
      title: row.title,
      lastMessageAt: row.last_message_at,
      snippet: null,
      matchedIn: "title",
    });
  }

  if (hits.size < limit) {
    const messageRows = db.prepare(
      `SELECT m.thread_id AS thread_id, m.content_json AS content_json,
              t.title AS title, t.last_message_at AS last_message_at
       FROM messages m
       JOIN threads t ON t.workspace_id = m.workspace_id AND t.remote_id = m.thread_id
       WHERE m.workspace_id = ? AND t.owner_user_id = ? AND m.content_json LIKE ? ESCAPE '\\'
       ORDER BY m.updated_at DESC
       LIMIT ?`,
    ).all(scope.workspaceId, scope.userId, likeQuery, MESSAGE_PREFILTER_LIMIT) as MessageSearchRow[];

    const lowerQuery = query.toLowerCase();
    for (const row of messageRows) {
      if (hits.size >= limit) break;
      if (hits.has(row.thread_id)) continue;
      let content: { parts?: { type?: string; text?: string }[] };
      try {
        content = JSON.parse(row.content_json) as typeof content;
      } catch {
        continue;
      }
      const parts = Array.isArray(content.parts) ? content.parts : [];
      const combined = parts
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("\n");
      const idx = combined.toLowerCase().indexOf(lowerQuery);
      if (idx === -1) continue;
      const start = Math.max(0, idx - SNIPPET_RADIUS);
      const end = Math.min(combined.length, idx + query.length + SNIPPET_RADIUS);
      const snippet = `${start > 0 ? "…" : ""}${combined.slice(start, end)}${end < combined.length ? "…" : ""}`;
      hits.set(row.thread_id, {
        threadId: row.thread_id,
        title: row.title,
        lastMessageAt: row.last_message_at,
        snippet,
        matchedIn: "message",
      });
    }
  }

  return Array.from(hits.values()).slice(0, limit);
}

export function exportSnapshot(scope: ThreadScope): ThreadSnapshot[] {
  const db = getDb();
  return listThreads(scope).map((thread) => {
    const rows = db.prepare(
      `SELECT id, parent_id, format, content_json FROM messages
       WHERE workspace_id = ? AND thread_id = ? ORDER BY rowid`,
    ).all(scope.workspaceId, thread.remoteId) as MessageRow[];
    const head = requireThread(scope, thread.remoteId);
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
      entries: rows.map((row) => ({
        id: row.id,
        parent_id: row.parent_id,
        format: row.format,
        content: JSON.parse(row.content_json),
      })),
    };
  });
}
