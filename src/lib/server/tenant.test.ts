import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dbPath = path.join(os.tmpdir(), `workbench-tenant-${crypto.randomUUID()}.db`);
const legacyDbPath = path.join(os.tmpdir(), `workbench-legacy-${crypto.randomUUID()}.db`);
const originalDbPath = process.env.WORKBENCH_DB_PATH;
const originalNodeEnv = process.env.NODE_ENV;
const originalLocalDevelopment = process.env.MONO_LOCAL_DEVELOPMENT;
const originalBootstrapEmail = process.env.WORKBENCH_BOOTSTRAP_EMAIL;
const originalBootstrapPassword = process.env.WORKBENCH_BOOTSTRAP_PASSWORD;

function resetTestDatabaseConnection(): void {
  const globalDb = globalThis as typeof globalThis & {
    __workbenchDb?: { close?: () => void };
  };
  globalDb.__workbenchDb?.close?.();
  delete globalDb.__workbenchDb;
}

beforeAll(() => {
  process.env.WORKBENCH_DB_PATH = dbPath;
  Object.assign(process.env, { NODE_ENV: "test" });
  process.env.MONO_LOCAL_DEVELOPMENT = "true";
  resetTestDatabaseConnection();
});

afterAll(() => {
  resetTestDatabaseConnection();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(legacyDbPath, { force: true });
  rmSync(`${legacyDbPath}-wal`, { force: true });
  rmSync(`${legacyDbPath}-shm`, { force: true });
  if (originalDbPath === undefined) delete process.env.WORKBENCH_DB_PATH;
  else process.env.WORKBENCH_DB_PATH = originalDbPath;
  if (originalNodeEnv === undefined) {
    Reflect.deleteProperty(process.env, "NODE_ENV");
  } else {
    Object.assign(process.env, { NODE_ENV: originalNodeEnv });
  }
  if (originalLocalDevelopment === undefined) delete process.env.MONO_LOCAL_DEVELOPMENT;
  else process.env.MONO_LOCAL_DEVELOPMENT = originalLocalDevelopment;
  if (originalBootstrapEmail === undefined) delete process.env.WORKBENCH_BOOTSTRAP_EMAIL;
  else process.env.WORKBENCH_BOOTSTRAP_EMAIL = originalBootstrapEmail;
  if (originalBootstrapPassword === undefined) delete process.env.WORKBENCH_BOOTSTRAP_PASSWORD;
  else process.env.WORKBENCH_BOOTSTRAP_PASSWORD = originalBootstrapPassword;
});

describe("employee and workspace boundaries", () => {
  it("migrates legacy thread and config rows into the default tenant", async () => {
    const legacy = new DatabaseSync(legacyDbPath);
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
    `);
    legacy.prepare(
      "INSERT INTO threads (remote_id, status, created_at, updated_at) VALUES (?, 'regular', 1, 1)",
    ).run("legacy-thread");
    legacy.prepare(
      "INSERT INTO messages (thread_id, id, parent_id, format, content_json, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, 1, 1)",
    ).run("legacy-thread", "legacy-message", "ai-sdk/v6", JSON.stringify({ text: "legacy" }));
    legacy.prepare("INSERT INTO api_config (key, value, updated_at) VALUES (?, ?, 1)")
      .run("CHAT_MODEL", "legacy-model");
    legacy.close();

    const { openWorkbenchDatabase } = await import("./db");
    const { legacyUserId, legacyWorkspaceId } = await import("./tenant-ids");
    const migrated = openWorkbenchDatabase(legacyDbPath);
    expect(migrated.prepare(
      "SELECT workspace_id, owner_user_id FROM threads WHERE remote_id = ?",
    ).get("legacy-thread")).toEqual({
      workspace_id: legacyWorkspaceId,
      owner_user_id: legacyUserId,
    });
    expect(migrated.prepare(
      "SELECT workspace_id, thread_id FROM messages WHERE id = ?",
    ).get("legacy-message")).toEqual({
      workspace_id: legacyWorkspaceId,
      thread_id: "legacy-thread",
    });
    expect(migrated.prepare(
      "SELECT workspace_id, value FROM api_config WHERE key = ?",
    ).get("CHAT_MODEL")).toEqual({
      workspace_id: legacyWorkspaceId,
      value: "legacy-model",
    });
    migrated.close();
  });

  it("hands legacy single-user history to the first production owner", async () => {
    process.env.WORKBENCH_DB_PATH = legacyDbPath;
    process.env.WORKBENCH_BOOTSTRAP_EMAIL = "first-owner@example.test";
    process.env.WORKBENCH_BOOTSTRAP_PASSWORD = "test-bootstrap-password";
    resetTestDatabaseConnection();
    const tenant = await import("./tenant");
    const threads = await import("./thread-store");
    const session = tenant.login({
      email: "first-owner@example.test",
      password: "test-bootstrap-password",
    });
    expect(threads.listThreads({
      workspaceId: session.actor.workspaceId,
      userId: session.actor.userId,
    }).map((thread) => thread.remoteId)).toContain("legacy-thread");
    resetTestDatabaseConnection();
    process.env.WORKBENCH_DB_PATH = dbPath;
    delete process.env.WORKBENCH_BOOTSTRAP_EMAIL;
    delete process.env.WORKBENCH_BOOTSTRAP_PASSWORD;
  });

  it("issues an employee session and keeps private chat history separated", async () => {
    const tenant = await import("./tenant");
    const threads = await import("./thread-store");
    const owner = tenant.ensureLocalWorkspaceActor();
    const workspace = tenant.createWorkspace(owner, {
      name: `Boundary ${crypto.randomUUID()}`,
    });
    const workspaceOwner = tenant.workspaceActorForUser(owner.userId, workspace.id);
    const employeeEmail = `employee-${crypto.randomUUID()}@example.test`;
    const invited = tenant.addWorkspaceMember(workspaceOwner, {
      email: employeeEmail,
      displayName: "测试员工",
      role: "member",
    });

    expect(invited.temporaryPassword).toBeTruthy();
    const employeeSession = tenant.login({
      email: employeeEmail,
      password: invited.temporaryPassword!,
      workspaceId: workspace.id,
    });
    const fromCookie = tenant.currentWorkspaceActor(new Request("http://localhost", {
      headers: { cookie: `workbench_session=${employeeSession.token}` },
    }));
    expect(fromCookie).toMatchObject({
      userId: employeeSession.actor.userId,
      workspaceId: workspace.id,
      organizationId: workspace.organizationId,
      role: "member",
    });

    const ownerThread = `thread_${crypto.randomUUID()}`;
    threads.ensureThread(workspaceOwner, ownerThread);
    threads.appendEntry(workspaceOwner, ownerThread, {
      id: "message_1",
      parent_id: null,
      format: "ai-sdk/v6",
      content: { role: "user", text: "owner only" },
    });

    const employeeScope = {
      workspaceId: employeeSession.actor.workspaceId,
      userId: employeeSession.actor.userId,
    };
    expect(threads.getThread(employeeScope, ownerThread)).toBeNull();
    expect(() => threads.loadRepo(employeeScope, ownerThread, "ai-sdk/v6"))
      .toThrow(threads.ThreadScopeError);

    const employeeThread = `thread_${crypto.randomUUID()}`;
    threads.ensureThread(employeeScope, employeeThread);
    expect(threads.listThreads(employeeScope).map((thread) => thread.remoteId))
      .toEqual([employeeThread]);
    expect(threads.listThreads(workspaceOwner).map((thread) => thread.remoteId))
      .toContain(ownerThread);
  });

  it("isolates workspace config and rejects viewer writes", async () => {
    const tenant = await import("./tenant");
    const config = await import("./api-config");
    const owner = tenant.ensureLocalWorkspaceActor();
    const workspace = tenant.createWorkspace(owner, {
      name: `Config ${crypto.randomUUID()}`,
    });
    const workspaceOwner = tenant.workspaceActorForUser(
      owner.userId,
      workspace.id,
    );
    config.setConfigValues({ CHAT_MODEL: "workspace-a" }, owner.workspaceId);
    config.setConfigValues(
      { CHAT_MODEL: "workspace-b" },
      workspaceOwner.workspaceId,
    );
    expect(config.getConfigValue("CHAT_MODEL", owner.workspaceId))
      .toBe("workspace-a");
    expect(config.getConfigValue("CHAT_MODEL", workspaceOwner.workspaceId))
      .toBe("workspace-b");

    const viewer = tenant.addWorkspaceMember(workspaceOwner, {
      email: `viewer-${crypto.randomUUID()}@example.test`,
      displayName: "只读员工",
      role: "viewer",
    });
    const session = tenant.login({
      email: viewer.member.email,
      password: viewer.temporaryPassword!,
      workspaceId: workspace.id,
    });
    expect(() => tenant.requirePermission(session.actor, "workspace:write"))
      .toThrow(tenant.TenantAccessError);
    expect(() => tenant.requirePermission(session.actor, "workspace:read"))
      .not.toThrow();
  });

  it("keeps concurrent request tenant contexts independent", async () => {
    const tenant = await import("./tenant");
    const context = await import("./tenant-context");
    const owner = tenant.ensureLocalWorkspaceActor();
    const workspace = tenant.createWorkspace(owner, {
      name: `Context ${crypto.randomUUID()}`,
    });
    const otherActor = tenant.workspaceActorForUser(owner.userId, workspace.id);
    const observed = await Promise.all([
      context.runWithTenantContext(owner, async () => {
        await Promise.resolve();
        return context.requireTenantContext().actor.workspaceId;
      }),
      context.runWithTenantContext(otherActor, async () => {
        await Promise.resolve();
        return context.requireTenantContext().actor.workspaceId;
      }),
    ]);
    expect(observed).toEqual([owner.workspaceId, otherActor.workspaceId]);
    expect(context.tenantContext()).toBeNull();
  });

  it("normalizes account login and revokes every session when a password changes", async () => {
    const tenant = await import("./tenant");
    const owner = tenant.ensureLocalWorkspaceActor();
    const workspace = tenant.createWorkspace(owner, { name: `Session ${crypto.randomUUID()}` });
    const workspaceOwner = tenant.workspaceActorForUser(owner.userId, workspace.id);
    const invited = tenant.addWorkspaceMember(workspaceOwner, {
      account: "E1001",
      displayName: "账号测试员工",
      role: "member",
    });
    expect(invited.temporaryPassword).toBe(tenant.DEFAULT_INITIAL_PASSWORD);
    const first = tenant.login({ account: " e1001 ", password: "123456", workspaceId: workspace.id });
    const second = tenant.login({ account: "E1001", password: "123456", workspaceId: workspace.id });
    expect(first.actor.account).toBe("e1001");
    const { getDb } = await import("./db");
    const session = getDb().prepare("SELECT expires_at FROM workbench_sessions WHERE id IS NOT NULL ORDER BY created_at DESC LIMIT 1").get() as { expires_at: number };
    expect(session.expires_at - Date.now()).toBeGreaterThan(89 * 24 * 60 * 60 * 1000);
    tenant.changePassword(first.actor, { currentPassword: "123456", newPassword: "new-password" });
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM workbench_sessions WHERE user_id = ?").get(first.actor.userId)).toEqual({ count: 0 });
    expect(() => tenant.login({ account: "e1001", password: "123456", workspaceId: workspace.id })).toThrow(tenant.TenantAccessError);
    expect(tenant.login({ account: "e1001", password: "new-password", workspaceId: workspace.id }).actor.userId).toBe(second.actor.userId);
  });

  it("preflights imports transactionally and does not reset an existing password", async () => {
    const tenant = await import("./tenant");
    const owner = tenant.ensureLocalWorkspaceActor();
    const workspace = tenant.createWorkspace(owner, { name: `Import ${crypto.randomUUID()}` });
    const workspaceOwner = tenant.workspaceActorForUser(owner.userId, workspace.id);
    const invalid = tenant.previewEmployeeImport(workspaceOwner, [
      { account: "I1001", displayName: "有效行", row: 2 },
      { account: "I1002", displayName: "无效角色", workspaceRole: "missing-role", row: 3 },
    ]);
    expect(invalid.valid).toBe(false);
    expect(() => tenant.importEmployees(workspaceOwner, invalid.rows)).toThrow(tenant.TenantAccessError);
    expect(tenant.listAdminAccounts(workspaceOwner, "I1001")).toHaveLength(0);

    expect(tenant.importEmployees(workspaceOwner, [
      { account: "I1001", displayName: "导入员工", department: "设计部", row: 2 },
    ])).toEqual({ created: 1, updated: 0 });
    const imported = tenant.login({ account: "i1001", password: "123456", workspaceId: workspace.id });
    tenant.changePassword(imported.actor, { currentPassword: "123456", newPassword: "employee-password" });
    expect(tenant.importEmployees(workspaceOwner, [
      { account: "I1001", displayName: "已更新员工", department: "品牌部", row: 2 },
    ])).toEqual({ created: 0, updated: 1 });
    expect(tenant.login({ account: "i1001", password: "employee-password", workspaceId: workspace.id }).actor.displayName).toBe("已更新员工");
  });

  it("uses role permission unions and blocks a non-owner from creating a privilege escalation role", async () => {
    const tenant = await import("./tenant");
    const owner = tenant.ensureLocalWorkspaceActor();
    const workspace = tenant.createWorkspace(owner, { name: `Roles ${crypto.randomUUID()}` });
    const workspaceOwner = tenant.workspaceActorForUser(owner.userId, workspace.id);
    const customRole = tenant.createAdminRole(workspaceOwner, {
      scope: "workspace",
      name: `Runtime manager ${crypto.randomUUID()}`,
      permissions: ["runtime-config:manage"],
    });
    const members = tenant.listAdminRoles(workspaceOwner);
    const organizationMember = members.find((role) => role.key === "organization-member")!;
    const account = tenant.upsertAdminAccount(workspaceOwner, {
      account: `role-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "权限测试员工",
      organizationRoleIds: [organizationMember.id],
      workspaceRoleIds: { [workspace.id]: [customRole.id] },
    });
    const actor = tenant.login({ account: account.account, password: "123456", workspaceId: workspace.id }).actor;
    expect(tenant.hasPermission(actor, "runtime-config:manage")).toBe(true);
    expect(() => tenant.createAdminRole(actor, {
      scope: "workspace",
      name: "越权角色",
      permissions: ["workspace:members:manage"],
    })).toThrow(tenant.TenantAccessError);
  });

  it("rate limits repeated account failures and emits an XLSX import template", async () => {
    const tenant = await import("./tenant");
    const account = `limited-${crypto.randomUUID().slice(0, 8)}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(() => tenant.login({ account, password: "wrong-password", ip: "203.0.113.100" })).toThrow(tenant.TenantAccessError);
    }
    try {
      tenant.login({ account, password: "wrong-password", ip: "203.0.113.100" });
      throw new Error("expected login to be rate limited");
    } catch (error) {
      expect(error).toMatchObject({ status: 429 });
    }
    const { GET } = await import("@/app/api/admin/employees/import/route");
    const { parseXlsx } = await import("@/lib/collector/xlsx");
    const response = await GET(new Request("http://localhost/api/admin/employees/import?format=xlsx"));
    expect(response.headers.get("content-type")).toContain("spreadsheetml");
    expect(parseXlsx(Buffer.from(await response.arrayBuffer()))[0]).toEqual([
      "账号", "姓名", "部门", "组织角色", "工作区角色",
    ]);
  });
});
