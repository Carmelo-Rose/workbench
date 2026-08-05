import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { getDb } from "./db";
import {
  canonicalPermission,
  createWorkbenchAbility,
  organizationPermissions,
  permissionCatalog,
  systemRoleDefinitions,
  workspacePermissions as catalogWorkspacePermissions,
  type AbilityAction,
  type AbilitySubject,
  type Permission,
  type RoleScope,
} from "../authorization";
import {
  legacyOrganizationId,
  legacyUserId,
  legacyWorkspaceId,
} from "./tenant-ids";

/** Legacy names remain as response summaries only; they never authorize a request. */
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
export type WorkspacePermission =
  | (typeof workspacePermissions)[number]
  | Permission;

export const DEFAULT_INITIAL_PASSWORD = "123456";
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = "workbench_session";
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;

export type RoleSummary = {
  id: string;
  key: string;
  name: string;
  scope: RoleScope;
  system: boolean;
  protected: boolean;
  permissions: Permission[];
  assignedCount?: number;
};

export type WorkspaceActor = {
  userId: string;
  organizationId: string;
  workspaceId: string;
  /** Compatibility display role; do not use for authorization. */
  role: WorkspaceRole;
  account: string;
  email: string;
  displayName: string;
  department: string | null;
  organizationRoles: RoleSummary[];
  workspaceRoles: RoleSummary[];
  permissions: Permission[];
};

export type WorkspaceMember = {
  userId: string;
  account: string;
  email: string;
  displayName: string;
  department: string | null;
  role: WorkspaceRole;
  roles: RoleSummary[];
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
  roles?: RoleSummary[];
};

export type OrganizationSummary = {
  id: string;
  name: string;
  slug: string;
  role: OrganizationRole;
  roles?: RoleSummary[];
};

export class TenantAccessError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 429, message: string) {
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

type UserRow = {
  id: string;
  account: string;
  email: string;
  display_name: string;
  department: string | null;
  password_hash: string | null;
  status: string;
};

type ActorRow = UserRow & {
  organization_id: string;
  workspace_id: string;
  role: string;
};

type DbRoleRow = {
  id: string;
  role_key: string;
  name: string;
  scope: RoleScope;
  is_system: number;
  is_protected: number;
  permission: string | null;
};

function localDevelopmentEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.MONO_LOCAL_DEVELOPMENT === "true";
}

export function normalizedAccount(value: string): string {
  const account = value.trim().toLocaleLowerCase();
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u.test(account)) {
    throw new TenantAccessError(409, "账号只能包含字母、数字、点、下划线或连字符，且长度不超过 64 位");
  }
  return account;
}

function normalizedEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new TenantAccessError(409, "请输入有效的历史兼容邮箱");
  }
  return email;
}

function accountFromEmail(email: string): string {
  const local = email.split("@", 1)[0] ?? "employee";
  const candidate = local.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "employee";
  return normalizedAccount(candidate.slice(0, 64));
}

function syntheticEmail(account: string): string {
  return `${account}@account.workbench`;
}

function stableUserId(account: string): string {
  return `usr_${createHash("sha256").update(account).digest("hex").slice(0, 24)}`;
}

function isWorkspaceRole(value: string): value is WorkspaceRole {
  return (workspaceRoles as readonly string[]).includes(value);
}

function isOrganizationRole(value: string): value is OrganizationRole {
  return (organizationRoles as readonly string[]).includes(value);
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

function systemRoleId(organizationId: string, key: string): string {
  return `sys_${organizationId}_${key}`;
}

/** Ensures an organization created after database boot receives protected system roles. */
function ensureSystemRoles(organizationId: string): void {
  const db = getDb();
  const now = Date.now();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO roles
      (id, organization_id, scope, role_key, name, is_system, is_protected, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  );
  const permission = db.prepare(
    "INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES (?, ?)",
  );
  for (const definition of systemRoleDefinitions) {
    const id = systemRoleId(organizationId, definition.key);
    insert.run(id, organizationId, definition.scope, definition.key, definition.name, definition.protected ? 1 : 0, now, now);
    for (const value of definition.permissions) permission.run(id, value);
  }
}

function roleSummaries(roleIds: readonly string[]): RoleSummary[] {
  if (!roleIds.length) return [];
  const placeholders = roleIds.map(() => "?").join(",");
  const rows = getDb().prepare(
    `SELECT r.id, r.role_key, r.name, r.scope, r.is_system, r.is_protected, rp.permission
       FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
      WHERE r.id IN (${placeholders}) ORDER BY r.name, rp.permission`,
  ).all(...roleIds) as DbRoleRow[];
  const grouped = new Map<string, RoleSummary>();
  for (const row of rows) {
    const current = grouped.get(row.id) ?? {
      id: row.id,
      key: row.role_key,
      name: row.name,
      scope: row.scope,
      system: row.is_system === 1,
      protected: row.is_protected === 1,
      permissions: [],
    };
    if (row.permission && (permissionCatalog as readonly string[]).includes(row.permission)) {
      current.permissions.push(row.permission as Permission);
    }
    grouped.set(row.id, current);
  }
  return [...grouped.values()];
}

function assignedRoles(userId: string, organizationId: string, workspaceId: string): {
  organizationRoles: RoleSummary[];
  workspaceRoles: RoleSummary[];
} {
  const db = getDb();
  const organizationIds = db.prepare(
    "SELECT role_id FROM organization_member_roles WHERE organization_id = ? AND user_id = ?",
  ).all(organizationId, userId) as { role_id: string }[];
  const workspaceIds = db.prepare(
    "SELECT role_id FROM workspace_member_roles WHERE workspace_id = ? AND user_id = ?",
  ).all(workspaceId, userId) as { role_id: string }[];
  return {
    organizationRoles: roleSummaries(organizationIds.map((row) => row.role_id)),
    workspaceRoles: roleSummaries(workspaceIds.map((row) => row.role_id)),
  };
}

function permissionsForRoles(...groups: RoleSummary[][]): Permission[] {
  return [...new Set(groups.flat().flatMap((role) => role.permissions))].sort();
}

function legacyWorkspaceRole(roles: RoleSummary[], fallback: string): WorkspaceRole {
  const keys = new Set(roles.map((role) => role.key));
  if (keys.has("workspace-owner")) return "owner";
  if (keys.has("workspace-admin")) return "admin";
  if (keys.has("workspace-viewer")) return "viewer";
  return isWorkspaceRole(fallback) ? fallback : "member";
}

function toActor(row: ActorRow): WorkspaceActor | null {
  if (row.status !== "active") return null;
  const roles = assignedRoles(row.id, row.organization_id, row.workspace_id);
  const permissions = permissionsForRoles(roles.organizationRoles, roles.workspaceRoles);
  return {
    userId: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    role: legacyWorkspaceRole(roles.workspaceRoles, row.role),
    account: row.account,
    email: row.email,
    displayName: row.display_name,
    department: row.department,
    organizationRoles: roles.organizationRoles,
    workspaceRoles: roles.workspaceRoles,
    permissions,
  };
}

function actorForMembership(userId: string, workspaceId: string): WorkspaceActor | null {
  const row = getDb().prepare(
    `SELECT u.id, u.account, u.email, u.display_name, u.department, u.password_hash, u.status,
            w.organization_id, w.id AS workspace_id, wm.role
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
       JOIN workspaces w ON w.id = wm.workspace_id
       JOIN organization_members om ON om.organization_id = w.organization_id AND om.user_id = u.id
      WHERE wm.user_id = ? AND wm.workspace_id = ?`,
  ).get(userId, workspaceId) as ActorRow | undefined;
  return row ? toActor(row) : null;
}

export function workspaceActorForUser(userId: string, workspaceId: string): WorkspaceActor {
  const actor = actorForMembership(userId, workspaceId);
  if (!actor) throw new TenantAccessError(403, "该账号不属于此工作区或已被禁用");
  return actor;
}

function upsertOrganization(id: string, name: string, slug: string): void {
  const now = Date.now();
  getDb().prepare(
    `INSERT INTO organizations (id, name, slug, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
  ).run(id, name, slug, now, now);
  ensureSystemRoles(id);
}

function upsertWorkspace(id: string, organizationId: string, name: string, slug: string): void {
  const now = Date.now();
  upsertOrganization(organizationId, organizationId, organizationId);
  getDb().prepare(
    `INSERT INTO workspaces (id, organization_id, name, slug, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
  ).run(id, organizationId, name, slug, now, now);
}

function replaceLegacyOrganizationRole(organizationId: string, userId: string, role: OrganizationRole): void {
  const now = Date.now();
  getDb().prepare(
    `INSERT INTO organization_members (organization_id, user_id, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(organization_id, user_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
  ).run(organizationId, userId, role, now, now);
  getDb().prepare(
    `INSERT OR IGNORE INTO organization_member_roles (organization_id, user_id, role_id, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(organizationId, userId, systemRoleId(organizationId, `organization-${role}`), now);
}

function replaceLegacyWorkspaceRole(workspaceId: string, userId: string, role: WorkspaceRole): void {
  const row = getDb().prepare("SELECT organization_id FROM workspaces WHERE id = ?").get(workspaceId) as { organization_id: string } | undefined;
  if (!row) throw new TenantAccessError(404, "工作区不存在");
  const now = Date.now();
  getDb().prepare(
    `INSERT INTO workspace_members (workspace_id, user_id, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
  ).run(workspaceId, userId, role, now, now);
  getDb().prepare(
    `INSERT OR IGNORE INTO workspace_member_roles (workspace_id, user_id, role_id, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(workspaceId, userId, systemRoleId(row.organization_id, `workspace-${role}`), now);
}

function createUserIfMissing(input: {
  id?: string;
  account: string;
  email?: string;
  displayName: string;
  department?: string | null;
  password?: string;
}): UserRow {
  const account = normalizedAccount(input.account);
  const email = input.email ? normalizedEmail(input.email) : syntheticEmail(account);
  const now = Date.now();
  getDb().prepare(
    `INSERT INTO users (id, account, email, display_name, department, password_hash, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?) ON CONFLICT(account) DO NOTHING`,
  ).run(input.id ?? stableUserId(account), account, email, input.displayName.trim(), input.department?.trim() || null, input.password ? hashPassword(input.password) : null, now, now);
  return getDb().prepare(
    "SELECT id, account, email, display_name, department, password_hash, status FROM users WHERE account = ?",
  ).get(account) as UserRow;
}

function primaryWorkspaceForUser(userId: string): ActorRow | undefined {
  return getDb().prepare(
    `SELECT u.id, u.account, u.email, u.display_name, u.department, u.password_hash, u.status,
            w.organization_id, wm.workspace_id, wm.role
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
       JOIN workspaces w ON w.id = wm.workspace_id
       JOIN organization_members om ON om.user_id = u.id AND om.organization_id = w.organization_id
      WHERE wm.user_id = ? ORDER BY wm.created_at ASC LIMIT 1`,
  ).get(userId) as ActorRow | undefined;
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

function touchSession(token: string): WorkspaceActor | null {
  const now = Date.now();
  const tokenHash = hashToken(token);
  const row = getDb().prepare(
    `SELECT u.id, u.account, u.email, u.display_name, u.department, u.password_hash, u.status,
            w.organization_id, s.workspace_id, wm.role
       FROM workbench_sessions s
       JOIN users u ON u.id = s.user_id
       JOIN workspaces w ON w.id = s.workspace_id
       JOIN workspace_members wm ON wm.user_id = s.user_id AND wm.workspace_id = s.workspace_id
       JOIN organization_members om ON om.user_id = s.user_id AND om.organization_id = w.organization_id
      WHERE s.token_hash = ? AND s.expires_at > ?`,
  ).get(tokenHash, now) as ActorRow | undefined;
  if (!row || row.status !== "active") return null;
  getDb().prepare(
    "UPDATE workbench_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?",
  ).run(now, now + SESSION_TTL_MS, tokenHash);
  return toActor(row);
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const requestHost = request.headers.get("host") ?? request.headers.get("x-forwarded-host") ?? new URL(request.url).host;
  try {
    if (new URL(origin).host !== requestHost) throw new TenantAccessError(403, "请求来源无效");
  } catch (error) {
    if (error instanceof TenantAccessError) throw error;
    throw new TenantAccessError(403, "请求来源无效");
  }
}

export function currentWorkspaceActor(request: Request): WorkspaceActor {
  assertSameOrigin(request);
  ensureConfiguredBootstrap();
  const token = cookieValue(request, SESSION_COOKIE);
  if (token) {
    const actor = touchSession(token);
    if (actor) return actor;
  }
  if (localDevelopmentEnabled()) return ensureLocalWorkspaceActor();
  throw new TenantAccessError(401, "请先登录 Workbench");
}

/** Returns the same database-backed session after extending its sliding expiry. */
export function refreshedSession(request: Request): { token: string; actor: WorkspaceActor } {
  assertSameOrigin(request);
  ensureConfiguredBootstrap();
  const token = cookieValue(request, SESSION_COOKIE);
  if (token) {
    const actor = touchSession(token);
    if (actor) return { token, actor };
  }
  if (localDevelopmentEnabled()) {
    const issued = issueSession(ensureLocalWorkspaceActor().userId, legacyWorkspaceId);
    return issued;
  }
  throw new TenantAccessError(401, "请先登录 Workbench");
}

function issueSession(userId: string, workspaceId: string): { token: string; actor: WorkspaceActor } {
  const actor = actorForMembership(userId, workspaceId);
  if (!actor) throw new TenantAccessError(403, "该账号不属于此工作区或已被禁用");
  const now = Date.now();
  const token = randomBytes(32).toString("base64url");
  const db = getDb();
  db.prepare("DELETE FROM workbench_sessions WHERE expires_at <= ?").run(now);
  db.prepare(
    `INSERT INTO workbench_sessions (id, token_hash, user_id, workspace_id, expires_at, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), hashToken(token), userId, workspaceId, now + SESSION_TTL_MS, now, now);
  return { token, actor };
}

function rateLimitScope(scope: "account" | "ip", key: string): void {
  const row = getDb().prepare(
    "SELECT failed_count, window_started_at, locked_until FROM login_attempts WHERE scope = ? AND scope_key = ?",
  ).get(scope, key) as { failed_count: number; window_started_at: number; locked_until: number | null } | undefined;
  if (row?.locked_until && row.locked_until > Date.now()) {
    throw new TenantAccessError(429, "登录失败次数过多，请稍后再试");
  }
}

function registerLoginFailure(scope: "account" | "ip", key: string): void {
  const now = Date.now();
  const row = getDb().prepare(
    "SELECT failed_count, window_started_at FROM login_attempts WHERE scope = ? AND scope_key = ?",
  ).get(scope, key) as { failed_count: number; window_started_at: number } | undefined;
  const count = !row || now - row.window_started_at > LOGIN_WINDOW_MS ? 1 : row.failed_count + 1;
  const windowStartedAt = !row || now - row.window_started_at > LOGIN_WINDOW_MS ? now : row.window_started_at;
  getDb().prepare(
    `INSERT INTO login_attempts (scope, scope_key, failed_count, window_started_at, locked_until, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope, scope_key) DO UPDATE SET failed_count = excluded.failed_count,
       window_started_at = excluded.window_started_at, locked_until = excluded.locked_until, updated_at = excluded.updated_at`,
  ).run(scope, key, count, windowStartedAt, count >= MAX_LOGIN_FAILURES ? now + LOGIN_LOCK_MS : null, now);
}

function clearLoginFailures(scope: "account" | "ip", key: string): void {
  getDb().prepare("DELETE FROM login_attempts WHERE scope = ? AND scope_key = ?").run(scope, key);
}

export function login(input: { account?: string; email?: string; password: string; workspaceId?: string; ip?: string }) {
  ensureConfiguredBootstrap();
  const identifier = (input.account ?? input.email ?? "").trim().toLocaleLowerCase();
  if (!identifier) throw new TenantAccessError(401, "账号或密码不正确");
  const accountKey = identifier.includes("@") ? identifier : normalizedAccount(identifier);
  const ip = input.ip?.trim() || "unknown";
  rateLimitScope("account", accountKey);
  rateLimitScope("ip", ip);
  const user = getDb().prepare(
    `SELECT id, account, email, display_name, department, password_hash, status FROM users
      WHERE account = ? COLLATE NOCASE OR email = ? COLLATE NOCASE LIMIT 1`,
  ).get(accountKey, accountKey) as UserRow | undefined;
  if (!user || user.status !== "active" || !verifyPassword(input.password, user.password_hash)) {
    registerLoginFailure("account", accountKey);
    registerLoginFailure("ip", ip);
    throw new TenantAccessError(401, "账号或密码不正确");
  }
  clearLoginFailures("account", accountKey);
  clearLoginFailures("ip", ip);
  const workspace = input.workspaceId ? actorForMembership(user.id, input.workspaceId) : (primaryWorkspaceForUser(user.id) ? toActor(primaryWorkspaceForUser(user.id)!) : null);
  if (!workspace) throw new TenantAccessError(403, "该员工尚未加入任何工作区");
  return issueSession(workspace.userId, workspace.workspaceId);
}

export function switchWorkspace(actor: WorkspaceActor, workspaceId: string) {
  return issueSession(actor.userId, workspaceId);
}

export function logout(request: Request): void {
  const token = cookieValue(request, SESSION_COOKIE);
  if (token) getDb().prepare("DELETE FROM workbench_sessions WHERE token_hash = ?").run(hashToken(token));
}

export function revokeUserSessions(userId: string): void {
  getDb().prepare("DELETE FROM workbench_sessions WHERE user_id = ?").run(userId);
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
    `SELECT w.id, w.organization_id, o.name AS organization_name, w.name, w.slug, wm.role
       FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
       JOIN organizations o ON o.id = w.organization_id WHERE wm.user_id = ? ORDER BY w.created_at ASC`,
  ).all(userId) as { id: string; organization_id: string; organization_name: string; name: string; slug: string; role: string }[];
  return rows.map((row) => {
    const roles = assignedRoles(userId, row.organization_id, row.id).workspaceRoles;
    return { id: row.id, organizationId: row.organization_id, organizationName: row.organization_name, name: row.name, slug: row.slug, role: legacyWorkspaceRole(roles, row.role), roles };
  });
}

export function currentWorkspace(actor: WorkspaceActor): WorkspaceSummary {
  const workspace = workspaceSummaries(actor.userId).find((item) => item.id === actor.workspaceId);
  if (!workspace) throw new TenantAccessError(404, "工作区不存在");
  return workspace;
}

export function organizationSummaries(userId: string): OrganizationSummary[] {
  const rows = getDb().prepare(
    `SELECT o.id, o.name, o.slug, om.role FROM organization_members om
       JOIN organizations o ON o.id = om.organization_id WHERE om.user_id = ? ORDER BY o.created_at ASC`,
  ).all(userId) as { id: string; name: string; slug: string; role: string }[];
  return rows.map((row) => {
    const roles = roleSummaries((getDb().prepare(
      "SELECT role_id FROM organization_member_roles WHERE organization_id = ? AND user_id = ?",
    ).all(row.id, userId) as { role_id: string }[]).map((item) => item.role_id));
    const keys = new Set(roles.map((role) => role.key));
    const role: OrganizationRole = keys.has("organization-owner") ? "owner" : keys.has("organization-admin") ? "admin" : isOrganizationRole(row.role) ? row.role : "member";
    return { id: row.id, name: row.name, slug: row.slug, role, roles };
  });
}

function requirementFor(permission: WorkspacePermission): { action: AbilityAction; subject: AbilitySubject } | null {
  const canonical = canonicalPermission(permission);
  if (!canonical) return null;
  const requirements: Record<Permission, { action: AbilityAction; subject: AbilitySubject }> = {
    "admin:access": { action: "read", subject: "Admin" },
    "accounts:manage": { action: "manage", subject: "Account" },
    "roles:manage": { action: "manage", subject: "Role" },
    "workspaces:manage": { action: "manage", subject: "Workspace" },
    "organization:read": { action: "read", subject: "Organization" },
    "organization:manage": { action: "manage", subject: "Organization" },
    "workspace:read": { action: "read", subject: "Workspace" },
    "workspace:operate": { action: "operate", subject: "Workspace" },
    "workspace:members:manage": { action: "manage", subject: "WorkspaceMember" },
    "workspace:settings:manage": { action: "manage", subject: "Workspace" },
    "runtime-config:manage": { action: "manage", subject: "RuntimeConfig" },
  };
  return requirements[canonical];
}

export function hasPermission(actor: WorkspaceActor, permission: WorkspacePermission): boolean {
  const requirement = requirementFor(permission);
  return !!requirement && createWorkbenchAbility(actor.permissions).can(requirement.action, requirement.subject);
}

export function requirePermission(actor: WorkspaceActor, permission: WorkspacePermission): void {
  if (!hasPermission(actor, permission)) throw new TenantAccessError(403, "当前账号无权执行此操作");
}

export function requireAbility(actor: WorkspaceActor, action: AbilityAction, subject: AbilitySubject): void {
  if (!createWorkbenchAbility(actor.permissions).can(action, subject)) {
    throw new TenantAccessError(403, "当前账号无权执行此操作");
  }
}

function isOrganizationOwner(actor: WorkspaceActor): boolean {
  return actor.organizationRoles.some((role) => role.key === "organization-owner");
}

export function requireWorkspaceManager(actor: WorkspaceActor): void {
  requirePermission(actor, "workspace:members:manage");
}

export function listWorkspaceMembers(actor: WorkspaceActor): WorkspaceMember[] {
  requirePermission(actor, "workspace:read");
  const rows = getDb().prepare(
    `SELECT u.id, u.account, u.email, u.display_name, u.department, u.status, wm.role, wm.created_at
       FROM workspace_members wm JOIN users u ON u.id = wm.user_id
      WHERE wm.workspace_id = ? ORDER BY wm.created_at ASC`,
  ).all(actor.workspaceId) as (UserRow & { role: string; created_at: number })[];
  return rows.map((row) => {
    const roles = assignedRoles(row.id, actor.organizationId, actor.workspaceId).workspaceRoles;
    return {
      userId: row.id, account: row.account, email: row.email, displayName: row.display_name,
      department: row.department, role: legacyWorkspaceRole(roles, row.role), roles,
      status: row.status === "disabled" ? "disabled" : "active", joinedAt: row.created_at,
    };
  });
}

function addAudit(actor: WorkspaceActor, action: string, targetType: string, targetId?: string, detail?: unknown): void {
  getDb().prepare(
    `INSERT INTO admin_audit_log (id, organization_id, actor_user_id, action, target_type, target_id, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), actor.organizationId, actor.userId, action, targetType, targetId ?? null, detail === undefined ? null : JSON.stringify(detail), Date.now());
}

function roleByKey(organizationId: string, scope: RoleScope, key: string): RoleSummary {
  const role = roleSummaries([systemRoleId(organizationId, key)])[0];
  if (!role) throw new Error(`Missing protected role ${key}`);
  return role;
}

function assertAssignableRoles(actor: WorkspaceActor, roleIds: string[], scope: RoleScope): RoleSummary[] {
  const roles = roleSummaries(roleIds);
  if (roles.length !== roleIds.length || roles.some((role) => role.scope !== scope)) {
    throw new TenantAccessError(409, "角色不存在或不属于此作用域");
  }
  const dbRows = getDb().prepare(
    `SELECT id FROM roles WHERE organization_id = ? AND id IN (${roleIds.map(() => "?").join(",")})`,
  ).all(actor.organizationId, ...roleIds) as { id: string }[];
  if (dbRows.length !== roleIds.length) throw new TenantAccessError(403, "不能跨组织分配角色");
  if (!isOrganizationOwner(actor) && roles.some((role) => role.key === "organization-owner" || role.key === "workspace-owner")) {
    throw new TenantAccessError(403, "只有组织所有者可以变更所有者");
  }
  const actorPermissions = new Set(actor.permissions);
  if (roles.some((role) => role.permissions.some((permission) => !actorPermissions.has(permission)))) {
    throw new TenantAccessError(403, "不能授予自己尚未拥有的权限");
  }
  return roles;
}

function assertOwnerWillRemain(organizationId: string, targetUserId: string, nextOrganizationRoles: RoleSummary[]): void {
  const targetOwns = nextOrganizationRoles.some((role) => role.key === "organization-owner");
  const otherOwner = getDb().prepare(
    `SELECT 1 FROM organization_member_roles omr JOIN roles r ON r.id = omr.role_id
      WHERE omr.organization_id = ? AND omr.user_id <> ? AND r.role_key = 'organization-owner' LIMIT 1`,
  ).get(organizationId, targetUserId);
  if (!targetOwns && !otherOwner) throw new TenantAccessError(409, "每个组织至少需要一位组织所有者");
}

function assertCanModifyTarget(actor: WorkspaceActor, userId: string): void {
  if (isOrganizationOwner(actor)) return;
  const owner = getDb().prepare(
    `SELECT 1
       FROM organization_member_roles omr JOIN roles r ON r.id = omr.role_id
      WHERE omr.organization_id = ? AND omr.user_id = ? AND r.role_key = 'organization-owner'
     UNION ALL
     SELECT 1
       FROM workspace_member_roles wmr
       JOIN workspaces w ON w.id = wmr.workspace_id
       JOIN roles r ON r.id = wmr.role_id
      WHERE w.organization_id = ? AND wmr.user_id = ? AND r.role_key = 'workspace-owner'
      LIMIT 1`,
  ).get(actor.organizationId, userId, actor.organizationId, userId);
  if (owner) throw new TenantAccessError(403, "只有组织所有者可以修改所有者账号或角色");
}

function setOrganizationRoles(actor: WorkspaceActor, userId: string, roleIds: string[]): void {
  assertCanModifyTarget(actor, userId);
  const roles = assertAssignableRoles(actor, roleIds, "organization");
  assertOwnerWillRemain(actor.organizationId, userId, roles);
  const db = getDb();
  const now = Date.now();
  db.prepare("DELETE FROM organization_member_roles WHERE organization_id = ? AND user_id = ?").run(actor.organizationId, userId);
  const insert = db.prepare("INSERT INTO organization_member_roles (organization_id, user_id, role_id, created_at) VALUES (?, ?, ?, ?)");
  for (const id of roleIds) insert.run(actor.organizationId, userId, id, now);
  const summary: OrganizationRole = roles.some((role) => role.key === "organization-owner") ? "owner" : roles.some((role) => role.key === "organization-admin") ? "admin" : "member";
  db.prepare("UPDATE organization_members SET role = ?, updated_at = ? WHERE organization_id = ? AND user_id = ?").run(summary, now, actor.organizationId, userId);
}

function setWorkspaceRoles(actor: WorkspaceActor, userId: string, workspaceId: string, roleIds: string[]): void {
  assertCanModifyTarget(actor, userId);
  const workspace = getDb().prepare("SELECT organization_id FROM workspaces WHERE id = ?").get(workspaceId) as { organization_id: string } | undefined;
  if (!workspace || workspace.organization_id !== actor.organizationId) throw new TenantAccessError(404, "工作区不存在");
  const roles = assertAssignableRoles(actor, roleIds, "workspace");
  const db = getDb();
  const now = Date.now();
  db.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'member', ?, ?)").run(workspaceId, userId, now, now);
  db.prepare("DELETE FROM workspace_member_roles WHERE workspace_id = ? AND user_id = ?").run(workspaceId, userId);
  const insert = db.prepare("INSERT INTO workspace_member_roles (workspace_id, user_id, role_id, created_at) VALUES (?, ?, ?, ?)");
  for (const id of roleIds) insert.run(workspaceId, userId, id, now);
  const summary = legacyWorkspaceRole(roles, "member");
  db.prepare("UPDATE workspace_members SET role = ?, updated_at = ? WHERE workspace_id = ? AND user_id = ?").run(summary, now, workspaceId, userId);
}

export function addWorkspaceMember(
  actor: WorkspaceActor,
  input: { account?: string; email?: string; displayName: string; department?: string; role?: WorkspaceRole; temporaryPassword?: string },
): { member: WorkspaceMember; temporaryPassword: string | undefined } {
  requireWorkspaceManager(actor);
  const account = input.account ? normalizedAccount(input.account) : input.email ? accountFromEmail(input.email) : (() => { throw new TenantAccessError(409, "账号不能为空"); })();
  const displayName = input.displayName.trim();
  if (!displayName) throw new TenantAccessError(409, "请输入员工姓名");
  const role = input.role ?? "member";
  if (!isWorkspaceRole(role)) throw new TenantAccessError(409, "员工角色无效");
  if (role === "owner" && !isOrganizationOwner(actor)) throw new TenantAccessError(403, "只有组织所有者可以新增所有者");
  let user = getDb().prepare("SELECT id, account, email, display_name, department, password_hash, status FROM users WHERE account = ?").get(account) as UserRow | undefined;
  const isNew = !user;
  if (!user) user = createUserIfMissing({ account, email: input.email, displayName, department: input.department, password: input.temporaryPassword ?? DEFAULT_INITIAL_PASSWORD });
  replaceLegacyOrganizationRole(actor.organizationId, user.id, role === "owner" ? "owner" : role === "admin" ? "admin" : "member");
  replaceLegacyWorkspaceRole(actor.workspaceId, user.id, role);
  const member = listWorkspaceMembers(actor).find((item) => item.userId === user!.id);
  if (!member) throw new Error("员工成员关系创建失败");
  return { member, temporaryPassword: isNew ? input.temporaryPassword ?? DEFAULT_INITIAL_PASSWORD : undefined };
}

export function createWorkspace(actor: WorkspaceActor, input: { name: string }): WorkspaceSummary {
  requireAbility(actor, "manage", "Workspace");
  const name = input.name.trim();
  if (!name) throw new TenantAccessError(409, "请输入工作区名称");
  const id = `ws_${randomUUID()}`;
  upsertWorkspace(id, actor.organizationId, name, id);
  replaceLegacyWorkspaceRole(id, actor.userId, "owner");
  addAudit(actor, "workspace.create", "workspace", id, { name });
  const workspace = workspaceSummaries(actor.userId).find((item) => item.id === id);
  if (!workspace) throw new Error("工作区创建失败");
  return workspace;
}

export function createOrganization(actor: WorkspaceActor, input: { name: string }): OrganizationSummary {
  requirePermission(actor, "organization:manage");
  const name = input.name.trim();
  if (!name) throw new TenantAccessError(409, "请输入组织名称");
  const id = `org_${randomUUID()}`;
  upsertOrganization(id, name, id);
  replaceLegacyOrganizationRole(id, actor.userId, "owner");
  const workspaceId = `ws_${randomUUID()}`;
  upsertWorkspace(workspaceId, id, "默认工作区", workspaceId);
  replaceLegacyWorkspaceRole(workspaceId, actor.userId, "owner");
  const organization = organizationSummaries(actor.userId).find((item) => item.id === id);
  if (!organization) throw new Error("组织创建失败");
  return organization;
}

/** Seed the existing single-user setup only in explicitly enabled local development. */
export function ensureLocalWorkspaceActor(): WorkspaceActor {
  const account = process.env.WORKBENCH_LOCAL_ACCOUNT ?? legacyUserId;
  const user = createUserIfMissing({ id: legacyUserId, account, email: `${legacyUserId}@local.workbench`, displayName: process.env.WORKBENCH_LOCAL_USER_NAME ?? "本地管理员" });
  upsertOrganization(legacyOrganizationId, process.env.WORKBENCH_LOCAL_ORGANIZATION_NAME ?? "默认组织", legacyOrganizationId);
  replaceLegacyOrganizationRole(legacyOrganizationId, user.id, "owner");
  upsertWorkspace(legacyWorkspaceId, legacyOrganizationId, process.env.WORKBENCH_LOCAL_WORKSPACE_NAME ?? "默认工作区", legacyWorkspaceId);
  replaceLegacyWorkspaceRole(legacyWorkspaceId, user.id, "owner");
  return workspaceActorForUser(user.id, legacyWorkspaceId);
}

/** Supports the new account bootstrap and the historical email bootstrap without a disruptive migration. */
export function ensureConfiguredBootstrap(): void {
  const rawAccount = process.env.WORKBENCH_BOOTSTRAP_ACCOUNT;
  const rawEmail = process.env.WORKBENCH_BOOTSTRAP_EMAIL;
  const password = process.env.WORKBENCH_BOOTSTRAP_PASSWORD;
  if ((!rawAccount && !rawEmail) || !password) return;
  if (password.length < 6) throw new Error("WORKBENCH_BOOTSTRAP_PASSWORD 至少需要 6 个字符");
  const account = rawAccount ? normalizedAccount(rawAccount) : accountFromEmail(rawEmail!);
  const organizationId = process.env.WORKBENCH_BOOTSTRAP_ORGANIZATION_ID ?? legacyOrganizationId;
  const organizationName = process.env.WORKBENCH_BOOTSTRAP_ORGANIZATION_NAME ?? "默认组织";
  const workspaceId = process.env.WORKBENCH_BOOTSTRAP_WORKSPACE_ID ?? "default";
  const workspaceName = process.env.WORKBENCH_BOOTSTRAP_WORKSPACE_NAME ?? "默认工作区";
  const user = createUserIfMissing({ id: stableUserId(account), account, email: rawEmail, displayName: process.env.WORKBENCH_BOOTSTRAP_DISPLAY_NAME ?? "工作区管理员", password });
  upsertOrganization(organizationId, organizationName, organizationId);
  upsertWorkspace(workspaceId, organizationId, workspaceName, workspaceId);
  replaceLegacyOrganizationRole(organizationId, user.id, "owner");
  replaceLegacyWorkspaceRole(workspaceId, user.id, "owner");
  claimLegacySingleUserData(user.id, workspaceId);
}

function claimLegacySingleUserData(ownerUserId: string, workspaceId: string): void {
  if (workspaceId !== legacyWorkspaceId || ownerUserId === legacyUserId) return;
  const legacyUser = getDb().prepare("SELECT password_hash FROM users WHERE id = ?").get(legacyUserId) as { password_hash: string | null } | undefined;
  if (!legacyUser || legacyUser.password_hash) return;
  const db = getDb();
  for (const [table, column] of [["threads", "owner_user_id"], ["mono_assets", "user_id"], ["mono_subjects", "owner_user_id"], ["mono_jobs", "user_id"], ["collector_items", "user_id"]] as const) {
    db.prepare(`UPDATE ${table} SET ${column} = ? WHERE workspace_id = ? AND ${column} = ?`).run(ownerUserId, workspaceId, legacyUserId);
  }
}

export function ensureServiceWorkspaceActor(input: { userId: string; workspaceId: string; displayName?: string }): WorkspaceActor {
  const workspace = getDb().prepare("SELECT organization_id FROM workspaces WHERE id = ?").get(input.workspaceId) as { organization_id: string } | undefined;
  if (!workspace) throw new TenantAccessError(403, "服务身份配置的工作区不存在");
  const account = `svc-${createHash("sha256").update(input.userId).digest("hex").slice(0, 24)}`;
  const user = createUserIfMissing({ id: input.userId, account, displayName: input.displayName ?? "Workbench 服务身份" });
  replaceLegacyOrganizationRole(workspace.organization_id, user.id, "member");
  replaceLegacyWorkspaceRole(input.workspaceId, user.id, "member");
  return workspaceActorForUser(user.id, input.workspaceId);
}

export function changePassword(actor: WorkspaceActor, input: { currentPassword: string; newPassword: string }): void {
  if (input.newPassword.length < 6) throw new TenantAccessError(409, "新密码至少需要 6 个字符");
  const user = getDb().prepare("SELECT password_hash FROM users WHERE id = ?").get(actor.userId) as { password_hash: string | null } | undefined;
  if (!user || !verifyPassword(input.currentPassword, user.password_hash)) throw new TenantAccessError(401, "当前密码不正确");
  const now = Date.now();
  getDb().prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(hashPassword(input.newPassword), now, actor.userId);
  revokeUserSessions(actor.userId);
  addAudit(actor, "account.password.change", "account", actor.userId);
}

export type AdminAccount = {
  id: string;
  account: string;
  email: string;
  displayName: string;
  department: string | null;
  status: "active" | "disabled";
  organizationRoles: RoleSummary[];
  workspaceRoles: Record<string, RoleSummary[]>;
};

export function listAdminAccounts(actor: WorkspaceActor, query = ""): AdminAccount[] {
  requireAbility(actor, "manage", "Account");
  const search = `%${query.trim()}%`;
  const rows = getDb().prepare(
    `SELECT DISTINCT u.id, u.account, u.email, u.display_name, u.department, u.status
       FROM organization_members om JOIN users u ON u.id = om.user_id
      WHERE om.organization_id = ? AND (u.account LIKE ? COLLATE NOCASE OR u.display_name LIKE ? COLLATE NOCASE OR COALESCE(u.department, '') LIKE ? COLLATE NOCASE)
      ORDER BY u.account`,
  ).all(actor.organizationId, search, search, search) as UserRow[];
  const workspaceRows = getDb().prepare("SELECT id FROM workspaces WHERE organization_id = ?").all(actor.organizationId) as { id: string }[];
  return rows.map((user) => {
    const organizationRoleIds = getDb().prepare("SELECT role_id FROM organization_member_roles WHERE organization_id = ? AND user_id = ?").all(actor.organizationId, user.id) as { role_id: string }[];
    const workspaceRoles: Record<string, RoleSummary[]> = {};
    for (const workspace of workspaceRows) workspaceRoles[workspace.id] = assignedRoles(user.id, actor.organizationId, workspace.id).workspaceRoles;
    return {
      id: user.id, account: user.account, email: user.email, displayName: user.display_name,
      department: user.department, status: user.status === "disabled" ? "disabled" : "active",
      organizationRoles: roleSummaries(organizationRoleIds.map((item) => item.role_id)), workspaceRoles,
    };
  });
}

export function upsertAdminAccount(actor: WorkspaceActor, input: {
  id?: string;
  account: string;
  displayName: string;
  department?: string | null;
  status?: "active" | "disabled";
  organizationRoleIds?: string[];
  workspaceRoleIds?: Record<string, string[]>;
}): AdminAccount {
  requireAbility(actor, "manage", "Account");
  const account = normalizedAccount(input.account);
  const displayName = input.displayName.trim();
  if (!displayName) throw new TenantAccessError(409, "姓名不能为空");
  const db = getDb();
  let user = input.id ? db.prepare("SELECT id, account, email, display_name, department, password_hash, status FROM users WHERE id = ?").get(input.id) as UserRow | undefined : undefined;
  if (!user) user = db.prepare("SELECT id, account, email, display_name, department, password_hash, status FROM users WHERE account = ?").get(account) as UserRow | undefined;
  const created = !user;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!user) {
      user = createUserIfMissing({ account, displayName, department: input.department, password: DEFAULT_INITIAL_PASSWORD });
      replaceLegacyOrganizationRole(actor.organizationId, user.id, "member");
    } else {
      assertCanModifyTarget(actor, user.id);
      const collision = db.prepare("SELECT id FROM users WHERE account = ? COLLATE NOCASE AND id <> ?").get(account, user.id);
      if (collision) throw new TenantAccessError(409, "账号已存在");
      db.prepare("UPDATE users SET account = ?, display_name = ?, department = ?, status = ?, updated_at = ? WHERE id = ?").run(account, displayName, input.department?.trim() || null, input.status ?? user.status, Date.now(), user.id);
      if (input.status === "disabled") revokeUserSessions(user.id);
    }
    if (input.organizationRoleIds) setOrganizationRoles(actor, user.id, [...new Set(input.organizationRoleIds)]);
    if (input.workspaceRoleIds) for (const [workspaceId, roleIds] of Object.entries(input.workspaceRoleIds)) setWorkspaceRoles(actor, user.id, workspaceId, [...new Set(roleIds)]);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  addAudit(actor, created ? "account.create" : "account.update", "account", user.id);
  const result = listAdminAccounts(actor).find((item) => item.id === user!.id);
  if (!result) throw new Error("账号读取失败");
  return result;
}

export function setAccountStatus(actor: WorkspaceActor, userId: string, status: "active" | "disabled"): void {
  requireAbility(actor, "manage", "Account");
  assertCanModifyTarget(actor, userId);
  const member = getDb().prepare("SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?").get(actor.organizationId, userId);
  if (!member) throw new TenantAccessError(404, "账号不存在");
  if (status === "disabled" && userId === actor.userId) throw new TenantAccessError(409, "不能禁用当前账号");
  getDb().prepare("UPDATE users SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), userId);
  if (status === "disabled") revokeUserSessions(userId);
  addAudit(actor, `account.${status}`, "account", userId);
}

export function resetAccountPassword(actor: WorkspaceActor, userId: string): void {
  requireAbility(actor, "manage", "Account");
  assertCanModifyTarget(actor, userId);
  const member = getDb().prepare("SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?").get(actor.organizationId, userId);
  if (!member) throw new TenantAccessError(404, "账号不存在");
  getDb().prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(hashPassword(DEFAULT_INITIAL_PASSWORD), Date.now(), userId);
  revokeUserSessions(userId);
  addAudit(actor, "account.password.reset", "account", userId);
}

export function listAdminRoles(actor: WorkspaceActor): RoleSummary[] {
  requireAbility(actor, "manage", "Role");
  const rows = getDb().prepare("SELECT id FROM roles WHERE organization_id = ? ORDER BY scope, is_system DESC, name").all(actor.organizationId) as { id: string }[];
  const roles = roleSummaries(rows.map((row) => row.id));
  for (const role of roles) {
    const orgCount = getDb().prepare("SELECT COUNT(*) AS count FROM organization_member_roles WHERE role_id = ?").get(role.id) as { count: number };
    const wsCount = getDb().prepare("SELECT COUNT(*) AS count FROM workspace_member_roles WHERE role_id = ?").get(role.id) as { count: number };
    role.assignedCount = orgCount.count + wsCount.count;
  }
  return roles;
}

function validateRolePermissions(scope: RoleScope, permissions: string[]): Permission[] {
  const permitted = scope === "organization" ? organizationPermissions : catalogWorkspacePermissions;
  const invalid = permissions.filter((value) => !(permitted as readonly string[]).includes(value));
  if (invalid.length) throw new TenantAccessError(409, "角色包含不属于此作用域的权限");
  return [...new Set(permissions)] as Permission[];
}

export function createAdminRole(actor: WorkspaceActor, input: { scope: RoleScope; name: string; permissions: string[]; copyFromId?: string }): RoleSummary {
  requireAbility(actor, "manage", "Role");
  const name = input.name.trim();
  if (!name || name.length > 80) throw new TenantAccessError(409, "请输入 1 至 80 个字符的角色名称");
  const permissions = validateRolePermissions(input.scope, input.permissions);
  if (permissions.some((permission) => !actor.permissions.includes(permission))) throw new TenantAccessError(403, "不能创建包含自己尚未拥有权限的角色");
  const id = `role_${randomUUID()}`;
  const db = getDb();
  db.prepare(
    `INSERT INTO roles (id, organization_id, scope, role_key, name, is_system, is_protected, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`,
  ).run(id, actor.organizationId, input.scope, `custom-${id.slice(5)}`, name, Date.now(), Date.now());
  const insert = db.prepare("INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)");
  for (const permission of permissions) insert.run(id, permission);
  addAudit(actor, input.copyFromId ? "role.copy" : "role.create", "role", id);
  return roleSummaries([id])[0]!;
}

export function updateAdminRole(actor: WorkspaceActor, roleId: string, input: { name: string; permissions: string[] }): RoleSummary {
  requireAbility(actor, "manage", "Role");
  const role = roleSummaries([roleId])[0];
  if (!role) throw new TenantAccessError(404, "角色不存在");
  const belongs = getDb().prepare("SELECT 1 FROM roles WHERE id = ? AND organization_id = ?").get(roleId, actor.organizationId);
  if (!belongs) throw new TenantAccessError(404, "角色不存在");
  if (role.protected || role.system) throw new TenantAccessError(403, "受保护的系统角色不可编辑");
  const name = input.name.trim();
  if (!name) throw new TenantAccessError(409, "角色名称不能为空");
  const permissions = validateRolePermissions(role.scope, input.permissions);
  if (permissions.some((permission) => !actor.permissions.includes(permission))) throw new TenantAccessError(403, "不能授予自己尚未拥有的权限");
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE roles SET name = ?, updated_at = ? WHERE id = ?").run(name, Date.now(), roleId);
    db.prepare("DELETE FROM role_permissions WHERE role_id = ?").run(roleId);
    const insert = db.prepare("INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)");
    for (const permission of permissions) insert.run(roleId, permission);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  addAudit(actor, "role.update", "role", roleId);
  return roleSummaries([roleId])[0]!;
}

export function deleteAdminRole(actor: WorkspaceActor, roleId: string): void {
  requireAbility(actor, "manage", "Role");
  const role = roleSummaries([roleId])[0];
  if (!role) throw new TenantAccessError(404, "角色不存在");
  const belongs = getDb().prepare("SELECT 1 FROM roles WHERE id = ? AND organization_id = ?").get(roleId, actor.organizationId);
  if (!belongs) throw new TenantAccessError(404, "角色不存在");
  if (role.protected || role.system) throw new TenantAccessError(403, "受保护的系统角色不可删除");
  getDb().prepare("DELETE FROM roles WHERE id = ?").run(roleId);
  addAudit(actor, "role.delete", "role", roleId);
}

export function listAdminWorkspaces(actor: WorkspaceActor) {
  requireAbility(actor, "manage", "Workspace");
  return getDb().prepare("SELECT id, name, slug, created_at, updated_at FROM workspaces WHERE organization_id = ? ORDER BY created_at").all(actor.organizationId) as { id: string; name: string; slug: string; created_at: number; updated_at: number }[];
}

export function assignWorkspaceRoles(actor: WorkspaceActor, input: { userId: string; workspaceId: string; roleIds: string[] }): void {
  requireAbility(actor, "manage", "Account");
  const member = getDb().prepare("SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?").get(actor.organizationId, input.userId);
  if (!member) throw new TenantAccessError(404, "账号不存在");
  setWorkspaceRoles(actor, input.userId, input.workspaceId, [...new Set(input.roleIds)]);
  addAudit(actor, "workspace.roles.assign", "workspace", input.workspaceId, { userId: input.userId, roleIds: input.roleIds });
}

export type ImportRow = { account: string; displayName: string; department?: string; organizationRole?: string; workspaceRole?: string; row: number };
export type ImportPreview = { valid: boolean; rows: ImportRow[]; errors: { row: number; message: string }[] };

function roleIdByNameOrId(actor: WorkspaceActor, scope: RoleScope, value: string | undefined, fallbackKey: string): string {
  if (!value?.trim()) return roleByKey(actor.organizationId, scope, fallbackKey).id;
  const parts = value.split(/[,，]/u).map((item) => item.trim()).filter(Boolean);
  if (parts.length !== 1) throw new TenantAccessError(409, "每一层只能指定一个角色；多个角色请在账号页配置");
  const row = getDb().prepare(
    "SELECT id FROM roles WHERE organization_id = ? AND scope = ? AND (id = ? OR name = ? OR role_key = ?) LIMIT 1",
  ).get(actor.organizationId, scope, parts[0], parts[0], parts[0]) as { id: string } | undefined;
  if (!row) throw new TenantAccessError(409, `${scope === "organization" ? "组织" : "工作区"}角色不存在：${parts[0]}`);
  return row.id;
}

export function previewEmployeeImport(actor: WorkspaceActor, rows: ImportRow[]): ImportPreview {
  requireAbility(actor, "manage", "Account");
  const errors: { row: number; message: string }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    try {
      const account = normalizedAccount(row.account);
      if (!row.displayName.trim()) throw new TenantAccessError(409, "姓名不能为空");
      if (seen.has(account)) throw new TenantAccessError(409, "导入文件内账号重复");
      seen.add(account);
      roleIdByNameOrId(actor, "organization", row.organizationRole, "organization-member");
      roleIdByNameOrId(actor, "workspace", row.workspaceRole, "workspace-member");
    } catch (error) { errors.push({ row: row.row, message: error instanceof Error ? error.message : "字段无效" }); }
  }
  return { valid: errors.length === 0, rows, errors };
}

export function importEmployees(actor: WorkspaceActor, rows: ImportRow[]): { created: number; updated: number } {
  const preview = previewEmployeeImport(actor, rows);
  if (!preview.valid) throw new TenantAccessError(409, "导入预检未通过");
  const db = getDb();
  let created = 0;
  let updated = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const account = normalizedAccount(row.account);
      let user = db.prepare("SELECT id, account, email, display_name, department, password_hash, status FROM users WHERE account = ?").get(account) as UserRow | undefined;
      if (!user) {
        user = createUserIfMissing({ account, displayName: row.displayName, department: row.department, password: DEFAULT_INITIAL_PASSWORD });
        replaceLegacyOrganizationRole(actor.organizationId, user.id, "member");
        created += 1;
      } else {
        db.prepare("UPDATE users SET display_name = ?, department = ?, updated_at = ? WHERE id = ?").run(row.displayName.trim(), row.department?.trim() || null, Date.now(), user.id);
        const member = db.prepare("SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?").get(actor.organizationId, user.id);
        if (!member) replaceLegacyOrganizationRole(actor.organizationId, user.id, "member");
        updated += 1;
      }
      const organizationRoleId = roleIdByNameOrId(actor, "organization", row.organizationRole, "organization-member");
      const workspaceRoleId = roleIdByNameOrId(actor, "workspace", row.workspaceRole, "workspace-member");
      setOrganizationRoles(actor, user.id, [organizationRoleId]);
      setWorkspaceRoles(actor, user.id, actor.workspaceId, [workspaceRoleId]);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  addAudit(actor, "account.import", "employee-import", undefined, { created, updated, count: rows.length });
  return { created, updated };
}
