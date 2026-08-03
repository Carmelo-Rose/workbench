import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `workbench-thread-search-${crypto.randomUUID()}.db`);
const originalDbPath = process.env.WORKBENCH_DB_PATH;
const originalNodeEnv = process.env.NODE_ENV;
const originalLocalDevelopment = process.env.MONO_LOCAL_DEVELOPMENT;

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
  if (originalDbPath === undefined) delete process.env.WORKBENCH_DB_PATH;
  else process.env.WORKBENCH_DB_PATH = originalDbPath;
  if (originalNodeEnv === undefined) {
    Reflect.deleteProperty(process.env, "NODE_ENV");
  } else {
    Object.assign(process.env, { NODE_ENV: originalNodeEnv });
  }
  if (originalLocalDevelopment === undefined) delete process.env.MONO_LOCAL_DEVELOPMENT;
  else process.env.MONO_LOCAL_DEVELOPMENT = originalLocalDevelopment;
});

describe("searchThreads", () => {
  it("matches by title and by message body text, ranking title hits first", async () => {
    const threads = await import("./thread-store");
    const tenant = await import("./tenant");
    const owner = tenant.ensureLocalWorkspaceActor();

    const titleThread = `thread_${crypto.randomUUID()}`;
    threads.ensureThread(owner, titleThread);
    threads.updateThread(owner, titleThread, { title: "关于报销流程的讨论" });

    const bodyThread = `thread_${crypto.randomUUID()}`;
    threads.ensureThread(owner, bodyThread);
    threads.appendEntry(owner, bodyThread, {
      id: "message_1",
      parent_id: null,
      format: "ai-sdk/v6",
      content: {
        role: "assistant",
        parts: [{ type: "text", text: "这里详细说明了报销的具体步骤和所需材料。" }],
      },
    });

    const noMatchThread = `thread_${crypto.randomUUID()}`;
    threads.ensureThread(owner, noMatchThread);
    threads.updateThread(owner, noMatchThread, { title: "无关话题" });

    const hits = threads.searchThreads(owner, "报销", 20);
    const ids = hits.map((hit) => hit.threadId);
    expect(ids).toContain(titleThread);
    expect(ids).toContain(bodyThread);
    expect(ids).not.toContain(noMatchThread);

    const titleHit = hits.find((hit) => hit.threadId === titleThread);
    expect(titleHit?.matchedIn).toBe("title");
    const bodyHit = hits.find((hit) => hit.threadId === bodyThread);
    expect(bodyHit?.matchedIn).toBe("message");
    expect(bodyHit?.snippet).toContain("报销");
  });

  it("returns nothing for an empty query", async () => {
    const threads = await import("./thread-store");
    const tenant = await import("./tenant");
    const owner = tenant.ensureLocalWorkspaceActor();
    expect(threads.searchThreads(owner, "   ", 20)).toEqual([]);
  });

  it("isolates results across workspace and owner scope", async () => {
    const threads = await import("./thread-store");
    const tenant = await import("./tenant");
    const owner = tenant.ensureLocalWorkspaceActor();
    const workspace = tenant.createWorkspace(owner, {
      name: `Search boundary ${crypto.randomUUID()}`,
    });
    const workspaceOwner = tenant.workspaceActorForUser(owner.userId, workspace.id);
    const employeeEmail = `employee-${crypto.randomUUID()}@example.test`;
    const invited = tenant.addWorkspaceMember(workspaceOwner, {
      email: employeeEmail,
      displayName: "测试员工",
      role: "member",
    });
    const employeeSession = tenant.login({
      email: employeeEmail,
      password: invited.temporaryPassword!,
      workspaceId: workspace.id,
    });
    const employeeScope = {
      workspaceId: employeeSession.actor.workspaceId,
      userId: employeeSession.actor.userId,
    };

    const secretThread = `thread_${crypto.randomUUID()}`;
    threads.ensureThread(workspaceOwner, secretThread);
    threads.updateThread(workspaceOwner, secretThread, { title: "机密项目 Nightingale" });

    // 同一 workspace 下另一个员工搜不到 owner 的私有会话。
    expect(threads.searchThreads(employeeScope, "Nightingale", 20)).toEqual([]);

    // 不同 workspace 的所有者也搜不到彼此的会话。
    const otherOwner = tenant.ensureLocalWorkspaceActor();
    const otherWorkspace = tenant.createWorkspace(otherOwner, {
      name: `Other boundary ${crypto.randomUUID()}`,
    });
    const otherWorkspaceOwner = tenant.workspaceActorForUser(otherOwner.userId, otherWorkspace.id);
    expect(threads.searchThreads(otherWorkspaceOwner, "Nightingale", 20)).toEqual([]);

    // 原 owner 自己能搜到。
    expect(threads.searchThreads(workspaceOwner, "Nightingale", 20).map((hit) => hit.threadId))
      .toContain(secretThread);
  });
});
