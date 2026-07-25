import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/server/db";
import { monoJobKinds } from "./contracts";
import type {
  MonoActor,
  MonoAsset,
  MonoAssetInput,
  MonoAssetLocation,
  MonoJob,
  MonoJobKind,
  MonoJobStatus,
  MonoSubject,
  MonoSubjectInput,
  MonoSubjectPatch,
  MonoSubjectVisibility,
} from "./contracts";

type AssetRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  source_url: string;
  mime_type: string | null;
  name: string | null;
  storage_key: string | null;
  location: string;
  created_at: number;
};

type JobRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  kind: MonoJobKind;
  status: MonoJobStatus;
  input_json: string;
  result_json: string | null;
  error: string | null;
  idempotency_key: string | null;
  trace_id: string;
  favorite: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  attempt_count: number;
  next_run_at: number | null;
  worker_version: string | null;
};

type SubjectRow = {
  id: string;
  workspace_id: string;
  owner_user_id: string;
  name: string;
  asset_id: string;
  visibility: MonoSubjectVisibility;
  created_at: number;
  updated_at: number;
};

function toAsset(row: AssetRow): MonoAsset {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    sourceUrl: row.source_url,
    mimeType: row.mime_type ?? undefined,
    name: row.name ?? undefined,
    storageKey: row.storage_key ?? undefined,
    location: row.location as MonoAssetLocation,
    createdAt: row.created_at,
  };
}

function toJob(row: JobRow): MonoJob {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    kind: row.kind,
    status: row.status,
    input: JSON.parse(row.input_json) as Record<string, unknown>,
    result: row.result_json ? (JSON.parse(row.result_json) as Record<string, unknown>) : null,
    error: row.error,
    idempotencyKey: row.idempotency_key,
    traceId: row.trace_id,
    favorite: row.favorite === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    attemptCount: row.attempt_count,
    nextRunAt: row.next_run_at,
    workerVersion: row.worker_version,
  };
}

function toSubject(row: SubjectRow): MonoSubject {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    assetId: row.asset_id,
    visibility: row.visibility,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createMonoAsset(
  actor: MonoActor,
  input: MonoAssetInput & { storageKey?: string; location?: MonoAssetLocation },
): MonoAsset {
  const asset: MonoAsset = {
    id: `asset_${randomUUID()}`,
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    ...input,
    // Same inference the v9 backfill migration uses: a storage key means the
    // bytes live in our own object storage, otherwise treat it as an external URL.
    location: input.location ?? (input.storageKey ? "local-storage" : "remote-url"),
    createdAt: Date.now(),
  };
  getDb().prepare(
    `INSERT INTO mono_assets (id, workspace_id, user_id, source_url, mime_type, name, storage_key, location, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    asset.id,
    asset.workspaceId,
    asset.userId,
    asset.sourceUrl,
    asset.mimeType ?? null,
    asset.name ?? null,
    asset.storageKey ?? null,
    asset.location,
    asset.createdAt,
  );
  return asset;
}

export function getMonoAsset(actor: MonoActor, assetId: string): MonoAsset | null {
  const row = getDb().prepare(
    "SELECT * FROM mono_assets WHERE id = ? AND workspace_id = ?",
  ).get(assetId, actor.workspaceId) as AssetRow | undefined;
  return row ? toAsset(row) : null;
}

export function createMonoSubject(actor: MonoActor, input: MonoSubjectInput): MonoSubject | null {
  if (!getMonoAsset(actor, input.assetId)) return null;
  const now = Date.now();
  const subject: MonoSubject = {
    id: `subject_${randomUUID()}`,
    workspaceId: actor.workspaceId,
    ownerUserId: actor.userId,
    name: input.name,
    assetId: input.assetId,
    visibility: input.visibility,
    createdAt: now,
    updatedAt: now,
  };
  getDb().prepare(
    `INSERT INTO mono_subjects
     (id, workspace_id, owner_user_id, name, asset_id, visibility, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    subject.id,
    subject.workspaceId,
    subject.ownerUserId,
    subject.name,
    subject.assetId,
    subject.visibility,
    subject.createdAt,
    subject.updatedAt,
  );
  return subject;
}

export function listMonoSubjects(actor: MonoActor): MonoSubject[] {
  const rows = getDb().prepare(
    `SELECT * FROM mono_subjects
     WHERE workspace_id = ? AND (owner_user_id = ? OR visibility = 'workspace')
     ORDER BY updated_at DESC`,
  ).all(actor.workspaceId, actor.userId) as SubjectRow[];
  return rows.map(toSubject);
}

export function getMonoSubject(actor: MonoActor, subjectId: string): MonoSubject | null {
  const row = getDb().prepare(
    `SELECT * FROM mono_subjects
     WHERE id = ? AND workspace_id = ? AND (owner_user_id = ? OR visibility = 'workspace')`,
  ).get(subjectId, actor.workspaceId, actor.userId) as SubjectRow | undefined;
  return row ? toSubject(row) : null;
}

export function updateMonoSubject(
  actor: MonoActor,
  subjectId: string,
  patch: MonoSubjectPatch,
): MonoSubject | null {
  const fields: string[] = [];
  const values: (string | number)[] = [];
  if (patch.name !== undefined) {
    fields.push("name = ?");
    values.push(patch.name);
  }
  if (patch.visibility !== undefined) {
    fields.push("visibility = ?");
    values.push(patch.visibility);
  }
  if (!fields.length) return getMonoSubject(actor, subjectId);
  fields.push("updated_at = ?");
  values.push(Date.now(), subjectId, actor.workspaceId, actor.userId);
  const result = getDb().prepare(
    `UPDATE mono_subjects SET ${fields.join(", ")}
     WHERE id = ? AND workspace_id = ? AND owner_user_id = ?`,
  ).run(...values);
  return result.changes > 0 ? getMonoSubject(actor, subjectId) : null;
}

export function deleteMonoSubject(actor: MonoActor, subjectId: string): boolean {
  const result = getDb().prepare(
    "DELETE FROM mono_subjects WHERE id = ? AND workspace_id = ? AND owner_user_id = ?",
  ).run(subjectId, actor.workspaceId, actor.userId);
  return result.changes > 0;
}

export function createMonoJob(
  actor: MonoActor,
  kind: MonoJobKind,
  input: Record<string, unknown>,
  idempotencyKey?: string,
): MonoJob {
  const db = getDb();
  if (idempotencyKey) {
    const existing = db.prepare(
      "SELECT * FROM mono_jobs WHERE workspace_id = ? AND idempotency_key = ?",
    ).get(actor.workspaceId, idempotencyKey) as JobRow | undefined;
    if (existing) return toJob(existing);
  }

  const now = Date.now();
  const job: MonoJob = {
    id: `job_${randomUUID()}`,
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    kind,
    status: "queued",
    input,
    result: null,
    error: null,
    idempotencyKey: idempotencyKey ?? null,
    traceId: actor.traceId,
    favorite: false,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    attemptCount: 0,
    nextRunAt: null,
    workerVersion: null,
  };
  db.prepare(
    `INSERT INTO mono_jobs
     (id, workspace_id, user_id, kind, status, input_json, idempotency_key, trace_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    job.id,
    job.workspaceId,
    job.userId,
    job.kind,
    job.status,
    JSON.stringify(job.input),
    job.idempotencyKey,
    job.traceId,
    job.createdAt,
    job.updatedAt,
  );
  appendMonoJobEvent(job.id, "queued", { traceId: actor.traceId });
  return job;
}

export function listMonoJobs(
  actor: MonoActor,
  options: { kind?: MonoJobKind; favoriteOnly?: boolean; limit?: number } = {},
): MonoJob[] {
  const conditions = ["workspace_id = ?"];
  const params: (string | number)[] = [actor.workspaceId];
  if (options.kind) {
    conditions.push("kind = ?");
    params.push(options.kind);
  }
  if (options.favoriteOnly) conditions.push("favorite = 1");
  const limit = Math.min(Math.max(options.limit ?? 60, 1), 200);
  const rows = getDb().prepare(
    `SELECT * FROM mono_jobs WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
  ).all(...params, limit) as JobRow[];
  return rows.map(toJob);
}

export function setMonoJobFavorite(actor: MonoActor, jobId: string, favorite: boolean): MonoJob | null {
  getDb().prepare(
    "UPDATE mono_jobs SET favorite = ? WHERE id = ? AND workspace_id = ?",
  ).run(favorite ? 1 : 0, jobId, actor.workspaceId);
  return getMonoJob(actor, jobId);
}

export function purgeMonoJob(actor: MonoActor, jobId: string): boolean {
  const result = getDb().prepare(
    `DELETE FROM mono_jobs
     WHERE id = ? AND workspace_id = ? AND status IN ('succeeded', 'failed', 'cancelled')`,
  ).run(jobId, actor.workspaceId);
  return result.changes > 0;
}

export function purgeUnfavoriteMonoJobs(actor: MonoActor, kind: MonoJobKind): number {
  const result = getDb().prepare(
    `DELETE FROM mono_jobs
     WHERE workspace_id = ? AND kind = ? AND favorite = 0
       AND status IN ('succeeded', 'failed', 'cancelled')`,
  ).run(actor.workspaceId, kind);
  return Number(result.changes);
}

export function getMonoJob(actor: MonoActor, jobId: string): MonoJob | null {
  const row = getDb().prepare(
    "SELECT * FROM mono_jobs WHERE id = ? AND workspace_id = ?",
  ).get(jobId, actor.workspaceId) as JobRow | undefined;
  return row ? toJob(row) : null;
}

/** 默认租约 5 分钟：单个 Provider 调用（含轮询）一般不会跑这么久，跑满说明 worker 大概率已经挂了。 */
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
export const INLINE_WORKER_ID = "inline";

export type ClaimJobOptions = {
  /** 认领者标识；同一个 workerId 的心跳/日志能对上同一个 worker（架构治理 Phase 4）。 */
  workerId?: string;
  /** 租约时长（毫秒）；租约到期还没完成会被 reclaimExpiredLeases 当孤儿任务收回。 */
  leaseMs?: number;
  /** 认领它的 worker 所在版本，纯记录用途，不参与任何判断逻辑。 */
  workerVersion?: string;
};

export function claimMonoJob(jobId: string, options: ClaimJobOptions = {}): MonoJob | null {
  const db = getDb();
  const now = Date.now();
  const workerId = options.workerId ?? INLINE_WORKER_ID;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const result = db.prepare(
    `UPDATE mono_jobs
     SET status = 'running', started_at = ?, updated_at = ?,
         lease_owner = ?, lease_expires_at = ?, attempt_count = attempt_count + 1,
         worker_version = ?
     WHERE id = ? AND status = 'queued'`,
  ).run(now, now, workerId, now + leaseMs, options.workerVersion ?? null, jobId);
  if (result.changes === 0) return null;
  appendMonoJobEvent(jobId, "running", { workerId });
  const row = db.prepare("SELECT * FROM mono_jobs WHERE id = ?").get(jobId) as JobRow;
  return toJob(row);
}

/**
 * 只认领还有并发空位的那几类任务，避免被一类占满时饿死其他类；
 * 同时排除 next_run_at 还没到的任务（重试退避中）。
 */
export function claimNextMonoJob(kinds: readonly MonoJobKind[], options: ClaimJobOptions = {}): MonoJob | null {
  if (!kinds.length) return null;
  const now = Date.now();
  const row = getDb().prepare(
    `SELECT id FROM mono_jobs
     WHERE status = 'queued' AND kind IN (${kinds.map(() => "?").join(",")})
       AND (next_run_at IS NULL OR next_run_at <= ?)
     ORDER BY created_at ASC LIMIT 1`,
  ).get(...kinds, now) as { id: string } | undefined;
  return row ? claimMonoJob(row.id, options) : null;
}

/** 进程刚启动：这个进程里不可能有任何任务真的在跑，running 状态只可能是上次异常退出留下的。 */
export function requeueInterruptedMonoJobs(): number {
  const now = Date.now();
  const result = getDb().prepare(
    `UPDATE mono_jobs
     SET status = 'queued', started_at = NULL, updated_at = ?,
         lease_owner = NULL, lease_expires_at = NULL
     WHERE status = 'running'`,
  ).run(now);
  if (result.changes > 0) {
    getDb().prepare(
      "INSERT INTO mono_job_events (job_id, event_type, detail_json, created_at) SELECT id, 'recovered', NULL, ? FROM mono_jobs WHERE status = 'queued' AND updated_at = ?",
    ).run(now, now);
  }
  return Number(result.changes);
}

/**
 * 进程存活期间的周期性回收：只收租约明确过期的任务，不像
 * requeueInterruptedMonoJobs 那样一上来就假定所有 running 都是孤儿——
 * 独立 Worker 场景下同一时刻可能有多个进程，其他进程的任务还在正常跑。
 */
export function reclaimExpiredLeases(now: number = Date.now()): number {
  const result = getDb().prepare(
    `UPDATE mono_jobs
     SET status = 'queued', started_at = NULL, updated_at = ?,
         lease_owner = NULL, lease_expires_at = NULL
     WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
  ).run(now, now);
  if (result.changes > 0) {
    getDb().prepare(
      "INSERT INTO mono_job_events (job_id, event_type, detail_json, created_at) SELECT id, 'lease_expired', NULL, ? FROM mono_jobs WHERE status = 'queued' AND updated_at = ?",
    ).run(now, now);
  }
  return Number(result.changes);
}

/** 长任务的心跳：还在正常跑就把租约续一段，避免被回收器当孤儿收走。 */
export function renewMonoJobLease(jobId: string, workerId: string, leaseMs: number = DEFAULT_LEASE_MS): boolean {
  const now = Date.now();
  const result = getDb().prepare(
    `UPDATE mono_jobs SET lease_expires_at = ?, updated_at = ?
     WHERE id = ? AND status = 'running' AND lease_owner = ?`,
  ).run(now + leaseMs, now, jobId, workerId);
  return result.changes > 0;
}

/**
 * 失败时的重试决策：attempt_count 还没到上限就退避重排队（保留 error 供 UI
 * 展示"上一次失败原因"），到上限了才真正 failMonoJob。调用方（service.ts）
 * 决定 maxAttempts/backoffMs，这里只管原子地把结果落库。
 */
export function failOrRetryMonoJob(
  jobId: string,
  error: string,
  maxAttempts: number,
  backoffMs: number,
): Extract<MonoJobStatus, "queued" | "failed"> {
  const db = getDb();
  const row = db.prepare(
    "SELECT attempt_count FROM mono_jobs WHERE id = ? AND status = 'running'",
  ).get(jobId) as { attempt_count: number } | undefined;
  if (row && row.attempt_count < maxAttempts) {
    const now = Date.now();
    const nextRunAt = now + backoffMs;
    const result = db.prepare(
      `UPDATE mono_jobs
       SET status = 'queued', started_at = NULL, updated_at = ?, next_run_at = ?,
           lease_owner = NULL, lease_expires_at = NULL, error = ?
       WHERE id = ? AND status = 'running'`,
    ).run(now, nextRunAt, error, jobId);
    if (result.changes > 0) {
      appendMonoJobEvent(jobId, "retry_scheduled", { error, attempt: row.attempt_count, nextRunAt });
      return "queued";
    }
  }
  failMonoJob(jobId, error);
  return "failed";
}

export type MonoWorkerHeartbeat = {
  id: string;
  mode: "inline" | "standalone";
  hostname: string | null;
  pid: number | null;
  startedAt: number;
  lastHeartbeatAt: number;
  inFlight: Record<string, number>;
};

export function upsertMonoWorkerHeartbeat(worker: {
  id: string;
  mode: "inline" | "standalone";
  hostname?: string;
  pid?: number;
  startedAt: number;
  inFlight: Record<string, number>;
}): void {
  const now = Date.now();
  getDb().prepare(
    `INSERT INTO mono_workers (id, mode, hostname, pid, started_at, last_heartbeat_at, in_flight_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       mode = excluded.mode, hostname = excluded.hostname, pid = excluded.pid,
       last_heartbeat_at = excluded.last_heartbeat_at, in_flight_json = excluded.in_flight_json`,
  ).run(
    worker.id,
    worker.mode,
    worker.hostname ?? null,
    worker.pid ?? null,
    worker.startedAt,
    now,
    JSON.stringify(worker.inFlight),
  );
}

export function listMonoWorkers(): MonoWorkerHeartbeat[] {
  const rows = getDb().prepare(
    "SELECT * FROM mono_workers ORDER BY last_heartbeat_at DESC",
  ).all() as {
    id: string;
    mode: string;
    hostname: string | null;
    pid: number | null;
    started_at: number;
    last_heartbeat_at: number;
    in_flight_json: string | null;
  }[];
  return rows.map((row) => ({
    id: row.id,
    mode: row.mode as "inline" | "standalone",
    hostname: row.hostname,
    pid: row.pid,
    startedAt: row.started_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    inFlight: row.in_flight_json ? (JSON.parse(row.in_flight_json) as Record<string, number>) : {},
  }));
}

export type MonoJobQueueStats = {
  queueDepthByKind: Record<MonoJobKind, number>;
  runningByKind: Record<MonoJobKind, number>;
  oldestQueuedAgeMs: number | null;
  recentFailureRate: { window: number; failed: number; rate: number };
};

function emptyKindCounter(): Record<MonoJobKind, number> {
  const counter = {} as Record<MonoJobKind, number>;
  for (const kind of monoJobKinds) counter[kind] = 0;
  return counter;
}

/** recentWindow 是"最近 N 条已完结任务"里失败了几条，不是时间窗口——单机低流量下更稳定，不会因为半夜没任务而失真。 */
export function monoJobQueueStats(recentWindow: number = 100): MonoJobQueueStats {
  const db = getDb();
  const now = Date.now();
  const queueDepthByKind = emptyKindCounter();
  const runningByKind = emptyKindCounter();
  const depthRows = db.prepare(
    "SELECT kind, status, COUNT(*) as count FROM mono_jobs WHERE status IN ('queued','running') GROUP BY kind, status",
  ).all() as { kind: MonoJobKind; status: "queued" | "running"; count: number }[];
  for (const row of depthRows) {
    if (row.status === "queued") queueDepthByKind[row.kind] = row.count;
    else runningByKind[row.kind] = row.count;
  }
  const oldest = db.prepare(
    "SELECT MIN(created_at) as oldest FROM mono_jobs WHERE status = 'queued'",
  ).get() as { oldest: number | null };
  const recentRows = db.prepare(
    "SELECT status FROM mono_jobs WHERE status IN ('succeeded','failed') ORDER BY completed_at DESC LIMIT ?",
  ).all(recentWindow) as { status: "succeeded" | "failed" }[];
  const failed = recentRows.filter((row) => row.status === "failed").length;
  return {
    queueDepthByKind,
    runningByKind,
    oldestQueuedAgeMs: oldest.oldest != null ? now - oldest.oldest : null,
    recentFailureRate: {
      window: recentRows.length,
      failed,
      rate: recentRows.length ? failed / recentRows.length : 0,
    },
  };
}

export function updateMonoJobResult(jobId: string, result: Record<string, unknown>): void {
  const now = Date.now();
  getDb().prepare(
    "UPDATE mono_jobs SET result_json = ?, updated_at = ? WHERE id = ? AND status = 'running'",
  ).run(JSON.stringify(result), now, jobId);
  appendMonoJobEvent(jobId, "progress", result);
}

export function completeMonoJob(
  jobId: string,
  result: Record<string, unknown>,
  failure?: string,
  /** 停止导致一张都没生成时用 "cancelled" 覆盖默认的 failed/succeeded 判断。 */
  statusOverride?: Extract<MonoJobStatus, "succeeded" | "failed" | "cancelled">,
): void {
  const now = Date.now();
  const status = statusOverride ?? (failure ? "failed" : "succeeded");
  getDb().prepare(
    `UPDATE mono_jobs
     SET status = ?, result_json = ?, error = ?, updated_at = ?, completed_at = ?
     WHERE id = ? AND status = 'running'`,
  ).run(status, JSON.stringify(result), failure ?? null, now, now, jobId);
  appendMonoJobEvent(jobId, status, failure ? { ...result, error: failure } : result);
}

export function failMonoJob(jobId: string, error: string): void {
  const now = Date.now();
  getDb().prepare(
    `UPDATE mono_jobs
     SET status = 'failed', error = ?, updated_at = ?, completed_at = ?
     WHERE id = ? AND status = 'running'`,
  ).run(error, now, now, jobId);
  appendMonoJobEvent(jobId, "failed", { error });
}

export function cancelMonoJob(actor: MonoActor, jobId: string): MonoJob | null {
  const now = Date.now();
  const result = getDb().prepare(
    `UPDATE mono_jobs
     SET status = 'cancelled', updated_at = ?, completed_at = ?
     WHERE id = ? AND workspace_id = ? AND status IN ('queued', 'running')`,
  ).run(now, now, jobId, actor.workspaceId);
  if (result.changes === 0) return getMonoJob(actor, jobId);
  appendMonoJobEvent(jobId, "cancelled");
  return getMonoJob(actor, jobId);
}

export function appendMonoJobEvent(
  jobId: string,
  eventType: string,
  detail?: Record<string, unknown>,
): void {
  getDb().prepare(
    "INSERT INTO mono_job_events (job_id, event_type, detail_json, created_at) VALUES (?, ?, ?, ?)",
  ).run(jobId, eventType, detail ? JSON.stringify(detail) : null, Date.now());
}
