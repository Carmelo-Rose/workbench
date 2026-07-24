import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { getDb } from "./db";
import {
  legacyOrganizationId,
  legacyUserId,
  legacyWorkspaceId,
} from "./tenant-ids";

export const workspaceRoles = ["owner", "admin", "member", "viewer"] as const;
export type WorkspaceRole = (typeof workspaceRoles)[number];
export const organizationRoles = ["owner", "admin", "member"] as const;
export type OrganizationRole = (typeof organizationRoles)[number];

export const workspacePermissions = [
  "workspace:read",
  "workspace:write",
  "workspace:manage",
  "members:manage",
  "config:manage",
] as const;
export type WorkspacePermission = (typeof workspacePermissions)[number];

const permissionsByRole: Record<WorkspaceRole, readonly WorkspacePermission[]> = {
  owner: workspacePermissions,
  admin: workspacePermissions,
  member: ["workspace:read", "workspace:write"],
  viewer: ["workspace:read"],
};

export type WorkspaceActor = {
  userId: string;
  organizationId: string;
  workspaceId: string;
  role: WorkspaceRole;
  email: string;
  displayName: string;
};

export type WorkspaceMember = {
  userId: string;
  email: string;
  displayName: string;
  role: WorkspaceRole;
  status: "active" | "disabled";
  joinedAt: number;
};

export type WorkspaceSummary = {
  id: string;
  organizationId: string;
  organizationName: string;
  name: string;
  slug: string;
  role: WorkspaceRole;
};

export type OrganizationSummary = {
  id: string;
  name: string;
  slug: string;
  role: OrganizationRole;
};

export class TenantAccessError extends Error {
  constructor(readonly status: 401 | 403 | 404 | 409, message: string) {
    super(message);
  }
}

export function tenantErrorResponse(error: unknown): Response {
  if (error instanceof TenantAccessError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  console.error("[tenant] request failed", error);
  return Response.json({ error: "租户服务暂时不可用" }, { status: 500 });
}

const SESSION_COOKIE = "workbench_session";
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

type ActorRow = {
  user_id: string;
  organization_id: string;
  workspace_id: string;
  role: string;
  email: string;
  display_name: string;
  status: string;
};

type UserRow = {
  id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  status: string;
};

function normalizedEmail(email: string): string {
  const value = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) {
    throw new TenantAccessError(409, "请输入有效的员工邮箱");
  }
  return value;
}

function stableUserId(email: string): string {
  return `usr_${createHash("sha256").update(email).digest("hex").slice(0, 24)}`;
}

function localDevelopmentEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.MONO_LOCAL_DEVELOPMENT === "true";
}

function isRole(value: string): value is WorkspaceRole {
  return (workspaceRoles as readonly string[]).includes(value);
}

function isOrganizationRole(value: string): value is OrganizationRole {
  return (organizationRoles as readonly string[]).includes(value);
}

function toActor(row: ActorRow): WorkspaceActor | null {
  if (!isRole(row.role) || row.status !== "active") return null;
  return {
    userId: row.user_id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    role: row.role,
    email: row.email,
    displayName: row.display_name,
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [algorithm, encodedSalt, encodedHash] = stored.split("$");
  if (algorithm !== "scrypt" || !encodedSalt || !encodedHash) return false;
  const expected = Buffer.from(encodedHash, "base64url");
  const actual = scryptSync(password, Buffer.from(encodedSalt, "base64url"), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function temporaryPassword(): string {
  return randomBytes(18).toString("base64url");
}

function actorForMembership(userId: string, workspaceId: string): WorkspaceActor | null {
  const row = getDb().prepare(
    `SELECT u.id AS user_id, w.organization_id, w.id AS workspace_id,
            m.role, u.email, u.display_name, u.status
     FROM workspace_members m
     JOIN users u ON u.id = m.user_id
     JOIN workspaces w ON w.id = m.workspace_id
     JOIN organization_members om
       ON om.organization_id = w.organization_id AND om.user_id = u.id
     WHERE m.user_id = ? AND m.workspace_id = ?`,
  ).get(userId, workspaceId) as ActorRow | undefined;
  return row ? toActor(row) : null;
}

export function workspaceActorForUser(
  userId: string,
  workspaceId: string,
): WorkspaceActor {
  const actor = actorForMembership(userId, workspaceId);
  if (!actor) {
    throw new TenantAccessError(403, "该员工不属于此工作区");
  }
  return actor;
}

function upsertOrganization(id: string, name: string, slug: string): void {
  const now = Date.now();
  getDb().prepare(
    `INSERT INTO organizations (id, name, slug, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(id, name, slug, now, now);
}

function upsertWorkspace(
  id: string,
  organizationId: string,
  name: string,
  slug: string,
): void {
  const now = Date.now();
  getDb().prepare(
    `INSERT INTO workspaces
       (id, organization_id, name, slug, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(id, organizationId, name, slug, now, now);
}

function upsertOrganizationMembership(
  organizationId: string,
  userId: string,
  role: OrganizationRole,
): void {
  const now = Date.now();
  getDb().prepare(
    `INSERT INTO organization_members
       (organization_id, user_id, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(organization_id, user_id)
     DO UPDATE SET
       role = CASE
         WHEN organization_members.role = 'owner' OR excluded.role = 'owner'
           THEN 'owner'
         WHEN organization_members.role = 'admin' OR excluded.role = 'admin'
           THEN 'admin'
         ELSE 'member'
       END,
       updated_at = excluded.updated_at`,
  ).run(organizationId, userId, role, now, now);
}

function upsertMembership(workspaceId: string, userId: string, role: WorkspaceRole): void {
  const now = Date.now();
  getDb().prepare(
    `INSERT INTO workspace_members (workspace_id, user_id, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
  ).run(workspaceId, userId, role, now, now);
}

function createUserIfMissing(input: {
  id: string;
  email: string;
  displayName: string;
  password?: string;
}): UserRow {
  const now = Date.now();
  getDb().prepare(
    `INSERT INTO users (id, email, display_name, password_hash, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT(email) DO NOTHING`,
  ).run(input.id, input.email, input.displayName, input.password ? hashPassword(input.password) : null, now, now);
  return getDb().prepare(
    "SELECT id, email, display_name, password_hash, status FROM users WHERE email = ?",
  ).get(input.email) as UserRow;
}

/**
 * Before employee accounts existed, every record implicitly belonged to the
 * local development actor. When production creates its first bootstrap owner,
 * hand that legacy single-user data to the owner instead of making it vanish
 * behind the new per-employee boundary.
 */
function claimLegacySingleUserData(ownerUserId: string, workspaceId: string): void {
  if (workspaceId !== legacyWorkspaceId || ownerUserId === legacyUserId) return;
  const legacyUser = getDb().prepare(
    "SELECT password_hash FROM users WHERE id = ?",
  ).get(legacyUserId) as { password_hash: string | null } | undefined;
  // A real account must never be silently reassigned. The null-password local
  // principal is the only identity created by the historical single-user mode.
  if (!legacyUser || legacyUser.password_hash) return;
  const db = getDb();
  db.prepare(
    "UPDATE threads SET owner_user_id = ? WHERE workspace_id = ? AND owner_user_id = ?",
  ).run(ownerUserId, workspaceId, legacyUserId);
  db.prepare(
    "UPDATE mono_assets SET user_id = ? WHERE workspace_id = ? AND user_id = ?",
  ).run(ownerUserId, workspaceId, legacyUserId);
  db.prepare(
    "UPDATE mono_subjects SET owner_user_id = ? WHERE workspace_id = ? AND owner_user_id = ?",
  ).run(ownerUserId, workspaceId, legacyUserId);
  db.prepare(
    "UPDATE mono_jobs SET user_id = ? WHERE workspace_id = ? AND user_id = ?",
  ).run(ownerUserId, workspaceId, legacyUserId);
  db.prepare(
    "UPDATE collector_items SET user_id = ? WHERE workspace_id = ? AND user_id = ?",
  ).run(ownerUserId, workspaceId, legacyUserId);
}

/** Seed the existing single-user setup only in explicit local development. */
export function ensureLocalWorkspaceActor(): WorkspaceActor {
  const email = `${legacyUserId}@local.workbench`;
  const user = createUserIfMissing({
    id: legacyUserId,
    email,
    displayName: process.env.WORKBENCH_LOCAL_USER_NAME ?? "本地管理员",
  });
  upsertOrganization(
    legacyOrganizationId,
    process.env.WORKBENCH_LOCAL_ORGANIZATION_NAME ?? "默认组织",
    legacyOrganizationId,
  );
  upsertOrganizationMembership(legacyOrganizationId, user.id, "owner");
  upsertWorkspace(
    legacyWorkspaceId,
    legacyOrganizationId,
    process.env.WORKBENCH_LOCAL_WORKSPACE_NAME ?? "默认工作区",
    legacyWorkspaceId,
  );
  upsertMembership(legacyWorkspaceId, user.id, "owner");
  const actor = actorForMembership(user.id, legacyWorkspaceId);
  if (!actor) throw new Error("无法初始化本地工作区身份");
  return actor;
}

/**
 * Production bootstrap is explicit: an owner is created only when both values
 * are configured. This keeps an accidentally exposed deployment fail-closed.
 */
export function ensureConfiguredBootstrap(): void {
  const rawEmail = process.env.WORKBENCH_BOOTSTRAP_EMAIL;
  const password = process.env.WORKBENCH_BOOTSTRAP_PASSWORD;
  if (!rawEmail || !password) return;
  if (password.length < 12) {
    throw new Error("WORKBENCH_BOOTSTRAP_PASSWORD 至少需要 12 个字符");
  }
  const email = normalizedEmail(rawEmail);
  const organizationId =
    process.env.WORKBENCH_BOOTSTRAP_ORGANIZATION_ID ?? legacyOrganizationId;
  const organizationName =
    process.env.WORKBENCH_BOOTSTRAP_ORGANIZATION_NAME ?? "默认组织";
  const workspaceId = process.env.WORKBENCH_BOOTSTRAP_WORKSPACE_ID ?? "default";
  const workspaceName = process.env.WORKBENCH_BOOTSTRAP_WORKSPACE_NAME ?? "默认工作区";
  const user = createUserIfMissing({
    id: stableUserId(email),
    email,
    displayName: process.env.WORKBENCH_BOOTSTRAP_DISPLAY_NAME ?? "工作区管理员",
    password,
  });
  upsertOrganization(organizationId, organizationName, organizationId);
  upsertWorkspace(workspaceId, organizationId, workspaceName, workspaceId);
  // Existing single-user databases already have the default workspace. Its
  // organization is authoritative during migration, so a custom bootstrap
  // organization cannot make the first owner lose membership of that workspace.
  const workspace = getDb().prepare(
    "SELECT organization_id FROM workspaces WHERE id = ?",
  ).get(workspaceId) as { organization_id: string } | undefined;
  const workspaceOrganizationId = workspace?.organization_id ?? organizationId;
  upsertOrganizationMembership(workspaceOrganizationId, user.id, "owner");
  upsertMembership(workspaceId, user.id, "owner");
  claimLegacySingleUserData(user.id, workspaceId);
}

function sessionActor(token: string): WorkspaceActor | null {
  const now = Date.now();
  const row = getDb().prepare(
    `SELECT u.id AS user_id, w.organization_id, s.workspace_id,
            m.role, u.email, u.display_name, u.status
     FROM workbench_sessions s
     JOIN users u ON u.id = s.user_id
     JOIN workspaces w ON w.id = s.workspace_id
     JOIN workspace_members m ON m.user_id = s.user_id AND m.workspace_id = s.workspace_id
     JOIN organization_members om
       ON om.user_id = s.user_id AND om.organization_id = w.organization_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  ).get(hashToken(token), now) as ActorRow | undefined;
  if (!row) return null;
  getDb().prepare("UPDATE workbench_sessions SET last_seen_at = ? WHERE token_hash = ?")
    .run(now, hashToken(token));
  return toActor(row);
}

function cookieValue(request: Request, name: string): string | null {
  const cookies = request.headers.get("cookie");
  if (!cookies) return null;
  for (const part of cookies.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const requestHost =
    request.headers.get("host") ??
    request.headers.get("x-forwarded-host") ??
    new URL(request.url).host;
  try {
    if (new URL(origin).host !== requestHost) {
      throw new TenantAccessError(403, "Workbench 请求来源无效");
    }
  } catch (error) {
    if (error instanceof TenantAccessError) throw error;
    throw new TenantAccessError(403, "Workbench 请求来源无效");
  }
}

export function currentWorkspaceActor(request: Request): WorkspaceActor {
  assertSameOrigin(request);
  ensureConfiguredBootstrap();
  const token = cookieValue(request, SESSION_COOKIE);
  if (token) {
    const actor = sessionActor(token);
    if (actor) return actor;
  }
  if (localDevelopmentEnabled()) return ensureLocalWorkspaceActor();
  throw new TenantAccessError(401, "请先登录 Workbench");
}

function issueSession(userId: string, workspaceId: string): { token: string; actor: WorkspaceActor } {
  const actor = actorForMembership(userId, workspaceId);
  if (!actor) throw new TenantAccessError(403, "该员工不属于此工作区");
  const now = Date.now();
  const token = randomBytes(32).toString("base64url");
  getDb().prepare("DELETE FROM workbench_sessions WHERE expires_at <= ?").run(now);
  getDb().prepare(
    `INSERT INTO workbench_sessions (id, token_hash, user_id, workspace_id, expires_at, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), hashToken(token), userId, workspaceId, now + SESSION_TTL_MS, now, now);
  return { token, actor };
}

export function login(input: { email: string; password: string; workspaceId?: string }) {
  ensureConfiguredBootstrap();
  const email = normalizedEmail(input.email);
  const user = getDb().prepare(
    "SELECT id, email, display_name, password_hash, status FROM users WHERE email = ?",
  ).get(email) as UserRow | undefined;
  if (!user || user.status !== "active" || !verifyPassword(input.password, user.password_hash)) {
    throw new TenantAccessError(401, "邮箱或密码不正确");
  }
  const workspace = input.workspaceId
    ? actorForMembership(user.id, input.workspaceId)
    : (getDb().prepare(
      `SELECT u.id AS user_id, w.organization_id, m.workspace_id,
              m.role, u.email, u.display_name, u.status
       FROM workspace_members m
       JOIN users u ON u.id = m.user_id
       JOIN workspaces w ON w.id = m.workspace_id
       JOIN organization_members om
         ON om.user_id = m.user_id AND om.organization_id = w.organization_id
       WHERE m.user_id = ? ORDER BY m.created_at ASC LIMIT 1`,
    ).get(user.id) as ActorRow | undefined);
  const actor = workspace && ("workspaceId" in workspace ? workspace : toActor(workspace));
  if (!actor) throw new TenantAccessError(403, "该员工尚未加入任何工作区");
  return issueSession(actor.userId, actor.workspaceId);
}

export function switchWorkspace(actor: WorkspaceActor, workspaceId: string) {
  return issueSession(actor.userId, workspaceId);
}

export function logout(request: Request): void {
  const token = cookieValue(request, SESSION_COOKIE);
  if (token) getDb().prepare("DELETE FROM workbench_sessions WHERE token_hash = ?").run(hashToken(token));
}

export function sessionCookie(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`;
}

export function clearedSessionCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function workspaceSummaries(userId: string): WorkspaceSummary[] {
  const rows = getDb().prepare(
    `SELECT w.id, w.organization_id, o.name AS organization_name,
            w.name, w.slug, m.role
     FROM workspace_members m
     JOIN workspaces w ON w.id = m.workspace_id
     JOIN organizations o ON o.id = w.organization_id
     WHERE m.user_id = ? ORDER BY w.created_at ASC`,
  ).all(userId) as {
    id: string;
    organization_id: string;
    organization_name: string;
    name: string;
    slug: string;
    role: string;
  }[];
  return rows.flatMap((row) => isRole(row.role)
    ? [{
        id: row.id,
        organizationId: row.organization_id,
        organizationName: row.organization_name,
        name: row.name,
        slug: row.slug,
        role: row.role,
      }]
    : []);
}

export function currentWorkspace(actor: WorkspaceActor): WorkspaceSummary {
  const row = getDb().prepare(
    `SELECT w.id, w.organization_id, o.name AS organization_name,
            w.name, w.slug, m.role
     FROM workspaces w
     JOIN organizations o ON o.id = w.organization_id
     JOIN workspace_members m ON m.workspace_id = w.id
     WHERE w.id = ? AND m.user_id = ?`,
  ).get(actor.workspaceId, actor.userId) as {
    id: string;
    organization_id: string;
    organization_name: string;
    name: string;
    slug: string;
    role: string;
  } | undefined;
  if (!row || !isRole(row.role)) throw new TenantAccessError(404, "工作区不存在");
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    name: row.name,
    slug: row.slug,
    role: row.role,
  };
}

export function organizationSummaries(userId: string): OrganizationSummary[] {
  const rows = getDb().prepare(
    `SELECT o.id, o.name, o.slug, m.role
     FROM organization_members m
     JOIN organizations o ON o.id = m.organization_id
     WHERE m.user_id = ? ORDER BY o.created_at ASC`,
  ).all(userId) as {
    id: string;
    name: string;
    slug: string;
    role: string;
  }[];
  return rows.flatMap((row) => isOrganizationRole(row.role)
    ? [{ id: row.id, name: row.name, slug: row.slug, role: row.role }]
    : []);
}

export function hasPermission(
  actor: WorkspaceActor,
  permission: WorkspacePermission,
): boolean {
  return permissionsByRole[actor.role].includes(permission);
}

export function requirePermission(
  actor: WorkspaceActor,
  permission: WorkspacePermission,
): void {
  if (!hasPermission(actor, permission)) {
    throw new TenantAccessError(403, "当前角色无权执行此操作");
  }
}

export function listWorkspaceMembers(actor: WorkspaceActor): WorkspaceMember[] {
  return (getDb().prepare(
    `SELECT u.id AS user_id, u.email, u.display_name, m.role, u.status, m.created_at
     FROM workspace_members m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = ? ORDER BY m.created_at ASC`,
  ).all(actor.workspaceId) as {
    user_id: string; email: string; display_name: string; role: string; status: string; created_at: number;
  }[]).flatMap((row) => isRole(row.role) && (row.status === "active" || row.status === "disabled")
    ? [{
        userId: row.user_id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
        status: row.status,
        joinedAt: row.created_at,
      }]
    : []);
}

export function requireWorkspaceManager(actor: WorkspaceActor): void {
  requirePermission(actor, "members:manage");
}

export function addWorkspaceMember(
  actor: WorkspaceActor,
  input: { email: string; displayName: string; role?: WorkspaceRole; temporaryPassword?: string },
): { member: WorkspaceMember; temporaryPassword: string | undefined } {
  requireWorkspaceManager(actor);
  const role = input.role ?? "member";
  if (!isRole(role)) throw new TenantAccessError(409, "员工角色无效");
  if (role === "owner" && actor.role !== "owner") {
    throw new TenantAccessError(403, "仅所有者可以新增所有者");
  }
  const email = normalizedEmail(input.email);
  const displayName = input.displayName.trim();
  if (!displayName) throw new TenantAccessError(409, "请输入员工姓名");
  const password = input.temporaryPassword ?? temporaryPassword();
  if (password.length < 12) throw new TenantAccessError(409, "临时密码至少需要 12 个字符");
  const existing = getDb().prepare(
    "SELECT id, email, display_name, password_hash, status FROM users WHERE email = ?",
  ).get(email) as UserRow | undefined;
  const user = existing ?? createUserIfMissing({
    id: stableUserId(email),
    email,
    displayName,
    password,
  });
  const existingMembership = getDb().prepare(
    `SELECT role FROM workspace_members
     WHERE workspace_id = ? AND user_id = ?`,
  ).get(actor.workspaceId, user.id) as { role: string } | undefined;
  if (existingMembership) {
    if (!isRole(existingMembership.role) || existingMembership.role !== role) {
      throw new TenantAccessError(
        409,
        "该员工已在工作区中；角色变更需要使用独立的成员管理操作",
      );
    }
    const member = listWorkspaceMembers(actor).find(
      (item) => item.userId === user.id,
    );
    if (!member) throw new Error("员工成员关系读取失败");
    return { member, temporaryPassword: undefined };
  }
  if (existing && !existing.password_hash) {
    getDb().prepare(
      "UPDATE users SET display_name = ?, password_hash = ?, status = 'active', updated_at = ? WHERE id = ?",
    ).run(displayName, hashPassword(password), Date.now(), user.id);
  }
  const organizationRole: OrganizationRole =
    role === "owner" ? "owner" : role === "admin" ? "admin" : "member";
  upsertOrganizationMembership(
    actor.organizationId,
    user.id,
    organizationRole,
  );
  upsertMembership(actor.workspaceId, user.id, role);
  const member = listWorkspaceMembers(actor).find((item) => item.userId === user.id);
  if (!member) throw new Error("员工成员关系创建失败");
  return { member, temporaryPassword: existing?.password_hash ? undefined : password };
}

export function createWorkspace(actor: WorkspaceActor, input: { name: string }): WorkspaceSummary {
  requirePermission(actor, "workspace:manage");
  const name = input.name.trim();
  if (!name) throw new TenantAccessError(409, "请输入工作区名称");
  const id = `ws_${randomUUID()}`;
  upsertWorkspace(id, actor.organizationId, name, id);
  upsertMembership(id, actor.userId, "owner");
  const workspace = workspaceSummaries(actor.userId).find((item) => item.id === id);
  if (!workspace) throw new Error("工作区创建失败");
  return workspace;
}

export function createOrganization(
  actor: WorkspaceActor,
  input: { name: string },
): OrganizationSummary {
  requirePermission(actor, "workspace:manage");
  const name = input.name.trim();
  if (!name) throw new TenantAccessError(409, "请输入组织名称");
  const id = `org_${randomUUID()}`;
  upsertOrganization(id, name, id);
  upsertOrganizationMembership(id, actor.userId, "owner");
  const workspaceId = `ws_${randomUUID()}`;
  upsertWorkspace(workspaceId, id, "默认工作区", workspaceId);
  upsertMembership(workspaceId, actor.userId, "owner");
  const organization = organizationSummaries(actor.userId).find(
    (item) => item.id === id,
  );
  if (!organization) throw new Error("组织创建失败");
  return organization;
}

/**
 * A shared service credential maps to a server-controlled employee principal.
 * Caller-supplied user/workspace headers are never accepted.
 */
export function ensureServiceWorkspaceActor(input: {
  userId: string;
  workspaceId: string;
  displayName?: string;
}): WorkspaceActor {
  const workspace = getDb().prepare(
    "SELECT organization_id FROM workspaces WHERE id = ?",
  ).get(input.workspaceId) as { organization_id: string } | undefined;
  if (!workspace) {
    throw new TenantAccessError(403, "服务身份配置的工作区不存在");
  }
  const user = createUserIfMissing({
    id: input.userId,
    email: `svc_${createHash("sha256").update(input.userId).digest("hex").slice(0, 24)}@service.workbench`,
    displayName: input.displayName ?? "Workbench 服务身份",
  });
  upsertOrganizationMembership(workspace.organization_id, user.id, "member");
  upsertMembership(input.workspaceId, user.id, "member");
  const actor = actorForMembership(user.id, input.workspaceId);
  if (!actor) throw new Error("服务身份初始化失败");
  return actor;
}
