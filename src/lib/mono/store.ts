import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/server/db";
import type {
  MonoActor,
  MonoAsset,
  MonoAssetInput,
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

export function createMonoAsset(actor: MonoActor, input: MonoAssetInput): MonoAsset {
  const asset: MonoAsset = {
    id: `asset_${randomUUID()}`,
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    ...input,
    createdAt: Date.now(),
  };
  getDb().prepare(
    `INSERT INTO mono_assets (id, workspace_id, user_id, source_url, mime_type, name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    asset.id,
    asset.workspaceId,
    asset.userId,
    asset.sourceUrl,
    asset.mimeType ?? null,
    asset.name ?? null,
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

export function claimMonoJob(jobId: string): MonoJob | null {
  const db = getDb();
  const now = Date.now();
  const result = db.prepare(
    "UPDATE mono_jobs SET status = 'running', started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'",
  ).run(now, now, jobId);
  if (result.changes === 0) return null;
  appendMonoJobEvent(jobId, "running");
  const row = db.prepare("SELECT * FROM mono_jobs WHERE id = ?").get(jobId) as JobRow;
  return toJob(row);
}

export function claimNextMonoJob(): MonoJob | null {
  const row = getDb().prepare(
    "SELECT id FROM mono_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1",
  ).get() as { id: string } | undefined;
  return row ? claimMonoJob(row.id) : null;
}

export function requeueInterruptedMonoJobs(): number {
  const now = Date.now();
  const result = getDb().prepare(
    "UPDATE mono_jobs SET status = 'queued', started_at = NULL, updated_at = ? WHERE status = 'running'",
  ).run(now);
  if (result.changes > 0) {
    getDb().prepare(
      "INSERT INTO mono_job_events (job_id, event_type, detail_json, created_at) SELECT id, 'recovered', NULL, ? FROM mono_jobs WHERE status = 'queued' AND updated_at = ?",
    ).run(now, now);
  }
  return Number(result.changes);
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
): void {
  const now = Date.now();
  getDb().prepare(
    `UPDATE mono_jobs
     SET status = ?, result_json = ?, error = ?, updated_at = ?, completed_at = ?
     WHERE id = ? AND status = 'running'`,
  ).run(failure ? "failed" : "succeeded", JSON.stringify(result), failure ?? null, now, now, jobId);
  appendMonoJobEvent(jobId, failure ? "failed" : "succeeded", failure ? { ...result, error: failure } : result);
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
