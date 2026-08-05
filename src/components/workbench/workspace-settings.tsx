"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useWorkbenchSession,
  type WorkbenchWorkspace,
} from "@/components/workbench/auth-gate";

type WorkspaceMember = {
  userId: string;
  email: string;
  displayName: string;
  role: "owner" | "admin" | "member" | "viewer";
  status: "active" | "disabled";
  joinedAt: number;
};

type WorkspaceListResponse = {
  current: WorkbenchWorkspace;
  workspaces: WorkbenchWorkspace[];
};

async function jsonOrError<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

const ROLE_LABEL: Record<WorkspaceMember["role"], string> = {
  owner: "所有者",
  admin: "管理员",
  member: "成员",
  viewer: "只读成员",
};

export function WorkspaceSettings() {
  const { session, refresh, switchWorkspace, can } = useWorkbenchSession();
  const [workspaces, setWorkspaces] = useState<WorkbenchWorkspace[]>(session.workspaces);
  const [members, setMembers] = useState<WorkspaceMember[] | null>(null);
  const [memberName, setMemberName] = useState("");
  const [memberEmail, setMemberEmail] = useState("");
  const [memberRole, setMemberRole] = useState<WorkspaceMember["role"]>("member");
  const [workspaceName, setWorkspaceName] = useState("");
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(null);
  const [busy, setBusy] = useState<"member" | "workspace" | "switch" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canManage = can("manage", "WorkspaceMember");
  const canAssignOwner = can("manage", "Organization");

  const load = async () => {
    const [workspaceData, memberData] = await Promise.all([
      fetch("/api/workspaces", { cache: "no-store" }).then(jsonOrError<WorkspaceListResponse>),
      fetch("/api/workspaces/current/members", { cache: "no-store" })
        .then(jsonOrError<{ members: WorkspaceMember[] }>),
    ]);
    setWorkspaces(workspaceData.workspaces);
    setMembers(memberData.members);
  };

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void load().catch((requestError) => {
        if (!cancelled) setError(requestError instanceof Error ? requestError.message : "无法加载工作区信息");
      });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const changeWorkspace = async (workspaceId: string) => {
    if (workspaceId === session.workspace.id) return;
    setBusy("switch");
    setError(null);
    try {
      await switchWorkspace(workspaceId);
      window.location.reload();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "切换工作区失败");
    } finally {
      setBusy(null);
    }
  };

  const addMember = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy("member");
    setError(null);
    setTemporaryPassword(null);
    try {
      const result = await jsonOrError<{
        member: WorkspaceMember;
        temporaryPassword?: string;
      }>(await fetch("/api/workspaces/current/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: memberName,
          email: memberEmail,
          role: memberRole,
        }),
      }));
      setMembers((current) => current
        ? [...current.filter((member) => member.userId !== result.member.userId), result.member]
        : [result.member]);
      setTemporaryPassword(result.temporaryPassword ?? null);
      setMemberName("");
      setMemberEmail("");
      setMemberRole("member");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "添加员工失败");
    } finally {
      setBusy(null);
    }
  };

  const addWorkspace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy("workspace");
    setError(null);
    try {
      await jsonOrError<{ workspace: WorkbenchWorkspace }>(await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: workspaceName }),
      }));
      setWorkspaceName("");
      await refresh();
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "创建工作区失败");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="text-sm font-semibold">工作区与员工</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          每位员工的会话和私有素材彼此隔离；共享素材和榜单数据仍以当前工作区为边界。
        </p>
        <div className="mt-4 rounded-xl border p-4">
          <p className="font-medium">{session.workspace.name}</p>
          <p className="text-muted-foreground mt-1 text-xs">
            你的角色：{ROLE_LABEL[session.actor.role]}
          </p>
          {workspaces.length > 1 && (
            <label className="mt-3 grid gap-1.5 text-xs font-medium">
              切换工作区
              <select
                value={session.workspace.id}
                disabled={busy === "switch"}
                onChange={(event) => void changeWorkspace(event.target.value)}
                className="bg-background h-9 rounded-md border px-3 text-sm"
              >
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </section>

      <section>
        <h4 className="text-sm font-semibold">员工</h4>
        <div className="mt-3 overflow-hidden rounded-xl border">
          {members === null ? (
            <p className="text-muted-foreground p-4 text-sm">加载中…</p>
          ) : members.length === 0 ? (
            <p className="text-muted-foreground p-4 text-sm">还没有员工。</p>
          ) : (
            <ul className="divide-y">
              {members.map((member) => (
                <li key={member.userId} className="flex items-center justify-between gap-3 px-4 py-3">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{member.displayName}</span>
                    <span className="text-muted-foreground block truncate text-xs">{member.email}</span>
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs">{ROLE_LABEL[member.role]}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {canManage && (
        <section className="grid gap-4">
          <div>
            <h4 className="text-sm font-semibold">添加员工</h4>
            <p className="text-muted-foreground mt-1 text-xs">首次创建会生成仅显示一次的初始密码，请安全转交给员工。</p>
          </div>
          <form onSubmit={addMember} className="grid gap-3 rounded-xl border p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                placeholder="员工姓名"
                value={memberName}
                onChange={(event) => setMemberName(event.target.value)}
                required
              />
              <Input
                type="email"
                placeholder="员工邮箱"
                value={memberEmail}
                onChange={(event) => setMemberEmail(event.target.value)}
                required
              />
            </div>
            <label className="grid gap-1.5 text-xs font-medium">
              角色
              <select
                value={memberRole}
                onChange={(event) => setMemberRole(event.target.value as WorkspaceMember["role"])}
                className="bg-background h-9 rounded-md border px-3 text-sm"
              >
                <option value="member">成员</option>
                <option value="viewer">只读成员</option>
                <option value="admin">管理员</option>
                {canAssignOwner && <option value="owner">所有者</option>}
              </select>
            </label>
            <Button type="submit" size="sm" className="w-fit" disabled={busy === "member"}>
              {busy === "member" ? "正在添加…" : "添加员工"}
            </Button>
          </form>
          {temporaryPassword && (
            <p role="status" className="rounded-lg border border-amber-400/50 bg-amber-100/40 p-3 text-sm dark:bg-amber-950/20">
              初始密码（仅此一次显示）：<code className="select-all font-semibold">{temporaryPassword}</code>
            </p>
          )}
          <form onSubmit={addWorkspace} className="flex flex-wrap items-center gap-2 rounded-xl border p-4">
            <Input
              className="max-w-64"
              placeholder="新工作区名称"
              value={workspaceName}
              onChange={(event) => setWorkspaceName(event.target.value)}
              required
            />
            <Button type="submit" variant="outline" size="sm" disabled={busy === "workspace"}>
              {busy === "workspace" ? "正在创建…" : "创建工作区"}
            </Button>
          </form>
        </section>
      )}

      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
    </div>
  );
}
