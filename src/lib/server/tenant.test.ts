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
});
