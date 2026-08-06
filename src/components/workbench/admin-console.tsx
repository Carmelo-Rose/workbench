"use client";

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeftIcon, CopyIcon, KeyRoundIcon, PlusIcon, RefreshCwIcon, ShieldAlertIcon, Trash2Icon, UserRoundCheckIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DataScope, Permission, PermissionCatalogEntry, PermissionGrant } from "@/lib/authorization";
import { useWorkbenchSession, type RoleSummary } from "@/components/workbench/auth-gate";

type Account = {
  id: string; account: string; email: string; displayName: string; department: string | null;
  status: "active" | "disabled"; organizationRoles: RoleSummary[]; workspaceRoles: Record<string, RoleSummary[]>;
};
type Workspace = { id: string; name: string; slug: string; created_at: number };
type AuditEntry = { id: string; actorName: string; action: string; targetRoleId: string | null; detail: { before?: PermissionGrant[]; after?: PermissionGrant[]; assignedCount?: number } | null; createdAt: number };
type EffectiveGrant = PermissionGrant & { sourceRoles: { id: string; name: string }[] };
type Tab = "accounts" | "roles" | "workspaces" | "audit";

async function jsonOrError<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `请求失败 (${response.status})`);
  return payload;
}

const TAB_NAMES: Record<Tab, string> = { accounts: "账号", roles: "角色与权限", workspaces: "工作区", audit: "权限审计" };

export function AdminConsole() {
  const { canGrant, isAdministrator } = useWorkbenchSession();
  const tabs = useMemo<Tab[]>(() => [
    ...(!isAdministrator ? [] : [
    ...(canGrant("system.accounts.view") ? ["accounts" as const] : []),
    ...(canGrant("system.roles.view") ? ["roles" as const] : []),
    ...(canGrant("system.workspaces.view") ? ["workspaces" as const] : []),
    ...(canGrant("system.audit.view") ? ["audit" as const] : []),
    ]),
  ], [canGrant, isAdministrator]);
  const [tab, setTab] = useState<Tab>(tabs[0] ?? "roles");
  const [reloadKey, setReloadKey] = useState(0);
  const activeTab = tabs.includes(tab) ? tab : tabs[0];

  if (!tabs.length) {
    return <main className="bg-background flex min-h-dvh items-center justify-center p-6"><div className="max-w-sm rounded-2xl border bg-card p-6 text-center"><ShieldAlertIcon className="text-destructive mx-auto size-8" /><h1 className="mt-3 font-semibold">无权访问管理后台</h1><p className="text-muted-foreground mt-2 text-sm">管理后台仅对所有者和管理员账号开放。</p><Button asChild className="mt-5"><Link href="/">返回工作台</Link></Button></div></main>;
  }

  return <main className="bg-background min-h-dvh p-4 sm:p-8"><div className="mx-auto max-w-7xl">
    <div className="mb-6 flex items-center gap-3"><Button asChild variant="ghost" size="sm"><Link href="/"><ArrowLeftIcon />工作台</Link></Button><div className="flex-1"><h1 className="text-xl font-semibold">权限中心</h1><p className="text-muted-foreground text-sm">功能模块、操作与数据范围统一授权</p></div><Button variant="outline" size="sm" onClick={() => setReloadKey((value) => value + 1)}><RefreshCwIcon />刷新</Button></div>
    <div className="mb-6 flex gap-1 overflow-x-auto rounded-xl border bg-muted/30 p-1">{tabs.map((item) => <button key={item} type="button" onClick={() => setTab(item)} className={`min-w-28 flex-1 rounded-lg px-3 py-2 text-sm ${activeTab === item ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:bg-background/60"}`}>{TAB_NAMES[item]}</button>)}</div>
    {activeTab === "accounts" && <AccountsTab key={`accounts-${reloadKey}`} />}
    {activeTab === "roles" && <RolesTab key={`roles-${reloadKey}`} />}
    {activeTab === "workspaces" && <WorkspacesTab key={`workspaces-${reloadKey}`} />}
    {activeTab === "audit" && <AuditTab key={`audit-${reloadKey}`} />}
  </div></main>;
}

function ErrorText({ error }: { error: string | null }) { return error ? <p role="alert" className="text-destructive mb-4 text-sm">{error}</p> : null; }

function AccountsTab() {
  const { canGrant, session } = useWorkbenchSession();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [effective, setEffective] = useState<{ account: Account; grants: EffectiveGrant[] } | null>(null);
  const load = async () => {
    try { setAccounts((await jsonOrError<{ accounts: Account[] }>(await fetch(`/api/admin/accounts?q=${encodeURIComponent(query)}`, { cache: "no-store" }))).accounts); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "账号加载失败"); }
  };
  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const mutate = async (body: Record<string, unknown>) => {
    try { await jsonOrError(await fetch("/api/admin/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "账号操作失败"); }
  };
  const remove = async (account: Account) => {
    if (!window.confirm(`确认删除账号“${account.displayName}（${account.account}）”？该账号会被移出组织和全部工作区。`)) return;
    try {
      await jsonOrError(await fetch(`/api/admin/accounts?id=${encodeURIComponent(account.id)}`, { method: "DELETE" }));
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "账号删除失败"); }
  };
  const inspect = async (account: Account) => {
    try {
      const result = await jsonOrError<{ grants: EffectiveGrant[] }>(await fetch(`/api/admin/accounts/${encodeURIComponent(account.id)}/grants?workspaceId=${encodeURIComponent(session.actor.workspaceId)}`));
      setEffective({ account, grants: result.grants });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "有效权限加载失败"); }
  };
  return <section className="rounded-2xl border bg-card p-4 sm:p-5"><div className="mb-4 flex flex-wrap gap-2"><div className="flex-1"><h2 className="font-semibold">账号</h2><p className="text-muted-foreground text-sm">角色变更会在下一次请求立即生效。</p></div><form onSubmit={(event) => { event.preventDefault(); void load(); }} className="flex gap-2"><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="账号、姓名或部门" /><Button variant="outline">搜索</Button></form></div><ErrorText error={error} />
    <div className="divide-y rounded-xl border">{accounts.map((account) => <div key={account.id} className="flex flex-wrap items-center gap-3 p-3"><div className="min-w-48 flex-1"><p className="font-medium">{account.displayName} <span className="text-muted-foreground font-normal">{account.account}</span></p><p className="text-muted-foreground text-xs">组织角色：{account.organizationRoles.map((role) => role.name).join("、") || "无"}</p><p className="text-muted-foreground text-xs">当前工作区角色：{account.workspaceRoles[session.actor.workspaceId]?.map((role) => role.name).join("、") || "未加入"}</p></div><Button variant="outline" size="sm" onClick={() => void inspect(account)}>有效权限</Button>{canGrant("system.accounts.manage") && <><Button variant="outline" size="sm" onClick={() => void mutate({ action: "reset-password", userId: account.id })}><KeyRoundIcon />重置密码</Button><Button variant="outline" size="sm" onClick={() => void mutate({ action: "status", userId: account.id, status: account.status === "active" ? "disabled" : "active" })}>{account.status === "active" ? "禁用" : "启用"}</Button>{account.id !== session.actor.userId && <Button variant="ghost" size="sm" className="text-destructive" onClick={() => void remove(account)}><Trash2Icon />删除</Button>}</>}</div>)}</div>
    {effective && <Drawer title={`${effective.account.displayName} · 有效权限`} onClose={() => setEffective(null)}><div className="grid gap-2">{effective.grants.map((grant) => <div key={grant.permission} className="rounded-lg border p-3"><p className="font-mono text-xs">{grant.permission}</p><p className="text-muted-foreground mt-1 text-xs">范围：{grant.dataScope === "workspace" ? "工作区" : grant.dataScope === "own" ? "本人" : "不适用"} · 来源：{grant.sourceRoles.map((role) => role.name).join("、")}</p></div>)}</div></Drawer>}
  </section>;
}

function RolesTab() {
  const { canGrant } = useWorkbenchSession();
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [catalog, setCatalog] = useState<PermissionCatalogEntry[]>([]);
  const [editing, setEditing] = useState<RoleSummary | null | "new">(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    try { const result = await jsonOrError<{ catalog: PermissionCatalogEntry[]; roles: RoleSummary[] }>(await fetch("/api/admin/roles", { cache: "no-store" })); setCatalog(result.catalog); setRoles(result.roles); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "角色加载失败"); }
  };
  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, []);
  const remove = async (role: RoleSummary) => {
    if (!window.confirm(`确认删除角色“${role.name}”？`)) return;
    try { await jsonOrError(await fetch(`/api/admin/roles?id=${encodeURIComponent(role.id)}`, { method: "DELETE" })); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "删除失败"); }
  };
  return <><section className="rounded-2xl border bg-card p-4 sm:p-5"><div className="mb-4 flex items-center gap-3"><div className="flex-1"><h2 className="font-semibold">角色与权限</h2><p className="text-muted-foreground text-sm">所有者、管理员锁定；成员和只读成员仅可调整业务授权。</p></div>{canGrant("system.roles.manage") && <Button size="sm" onClick={() => setEditing("new")}><PlusIcon />创建角色</Button>}</div><ErrorText error={error} /><div className="grid gap-3 md:grid-cols-2">{roles.map((role) => { const editableMember = role.key === "workspace-member" || role.key === "workspace-viewer"; return <article key={role.id} className="rounded-xl border p-4"><div className="flex gap-2"><div className="flex-1"><p className="font-medium">{role.name} {role.system && <span className="text-muted-foreground text-xs">系统</span>}</p><p className="text-muted-foreground text-xs">{role.scope === "organization" ? "组织级" : "工作区级"} · 已分配 {role.assignedCount ?? 0} 人</p></div>{canGrant("system.roles.manage") && (!role.protected || editableMember) && <Button variant="ghost" size="sm" onClick={() => setEditing(role)}>编辑</Button>}{canGrant("system.roles.manage") && !role.protected && !role.system && <Button variant="ghost" size="sm" onClick={() => void remove(role)}><Trash2Icon className="text-destructive" /></Button>}</div><p className="text-muted-foreground mt-3 text-xs">{role.grants.length} 项授权 · 更新于 {new Date(role.updatedAt).toLocaleString()}</p>{canGrant("system.roles.manage") && !role.system && <Button variant="outline" size="sm" className="mt-3" onClick={() => setEditing({ ...role, id: "", key: "", name: `${role.name} 副本`, system: false, protected: false })}><CopyIcon />复制</Button>}</article>; })}</div></section>
    {editing && <RoleEditor role={editing === "new" ? null : editing} catalog={catalog} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await load(); }} />}
  </>;
}

function RoleEditor({ role, catalog, onClose, onSaved }: { role: RoleSummary | null; catalog: PermissionCatalogEntry[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [scope, setScope] = useState<"organization" | "workspace">(role?.scope ?? "workspace");
  const [name, setName] = useState(role?.name ?? "");
  const [grants, setGrants] = useState<PermissionGrant[]>(role?.grants ?? []);
  const [error, setError] = useState<string | null>(null);
  const editableSystemMember = role?.key === "workspace-member" || role?.key === "workspace-viewer";
  const available = catalog.filter((item) => item.roleScope === scope && (!editableSystemMember || item.group !== "system"));
  const modules = useMemo(() => [...new Map(available.map((item) => [`${item.group}:${item.module}`, { group: item.groupName, module: item.moduleName }])).entries()], [available]);
  const grantFor = (permission: string) => grants.find((grant) => grant.permission === permission);
  const toggle = (entry: PermissionCatalogEntry) => setGrants((current) => current.some((grant) => grant.permission === entry.id)
    ? current.filter((grant) => grant.permission !== entry.id)
    : [...current, { permission: entry.id as Permission, ...(entry.dataScopes.length ? { dataScope: entry.dataScopes[0] } : {}) }]);
  const setDataScope = (permission: string, dataScope: DataScope) => setGrants((current) => current.map((grant) => grant.permission === permission ? { ...grant, dataScope } : grant));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if ((role?.assignedCount ?? 0) > 0 && !window.confirm(`该角色已分配给 ${role!.assignedCount} 人，保存后下一次请求立即生效。确认继续？`)) return;
    try {
      await jsonOrError(await fetch("/api/admin/roles", { method: role?.id ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(role?.id ? { id: role.id } : {}), scope, name, grants }) }));
      await onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
  };
  return <Drawer title={role?.id ? "编辑角色" : "创建角色"} onClose={onClose}><form onSubmit={submit}><div className="mb-4 grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm">作用域<select value={scope} disabled={!!role?.id} onChange={(event) => { setScope(event.target.value as typeof scope); setGrants([]); }} className="bg-background h-9 rounded-md border px-3"><option value="organization">组织级</option><option value="workspace">工作区级</option></select></label><label className="grid gap-1 text-sm">角色名称<Input value={name} disabled={!!editableSystemMember} onChange={(event) => setName(event.target.value)} required /></label></div><ErrorText error={error} />
    <div className="max-h-[60vh] overflow-auto rounded-xl border"><table className="w-full min-w-[760px] text-sm"><thead className="bg-muted/50 sticky top-0"><tr><th className="p-2 text-left">分组 / 模块</th>{(["view", "use", "create", "manage", "import", "export"] as const).map((op) => <th key={op} className="p-2 text-center">{{ view: "查看", use: "使用", create: "创建/使用", manage: "管理", import: "导入", export: "导出" }[op]}</th>)}</tr></thead><tbody>{modules.map(([key, meta]) => <tr key={key} className="border-t"><td className="p-2"><span className="text-muted-foreground">{meta.group}</span><br />{meta.module}</td>{(["view", "use", "create", "manage", "import", "export"] as const).map((operation) => { const entry = available.find((item) => `${item.group}:${item.module}` === key && item.operation === operation); const grant = entry ? grantFor(entry.id) : undefined; return <td key={operation} className="p-2 text-center">{!entry ? <span className="text-muted-foreground">—</span> : <div className="grid justify-items-center gap-1"><input type="checkbox" checked={!!grant} onChange={() => toggle(entry)} />{grant && entry.dataScopes.length > 1 && <select aria-label={`${entry.moduleName}${entry.operationName}数据范围`} value={grant.dataScope ?? "own"} onChange={(event) => setDataScope(entry.id, event.target.value as DataScope)} className="bg-background rounded border px-1 py-0.5 text-xs"><option value="own">本人</option><option value="workspace">工作区</option></select>}{grant && entry.dataScopes.length === 1 && <span className="text-muted-foreground text-[10px]">{entry.dataScopes[0] === "own" ? "本人" : "工作区"}</span>}</div>}</td>; })}</tr>)}</tbody></table></div>
    <div className="mt-5 flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>取消</Button><Button type="submit">保存</Button></div></form></Drawer>;
}

function WorkspacesTab() {
  const { canGrant, session } = useWorkbenchSession();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    try {
      const workspaceData = await jsonOrError<{ workspaces: Workspace[] }>(await fetch("/api/admin/workspaces", { cache: "no-store" })); setWorkspaces(workspaceData.workspaces);
      if (canGrant("system.members.manage") && canGrant("system.accounts.view") && canGrant("system.roles.view")) {
        const [accountData, roleData] = await Promise.all([fetch("/api/admin/accounts", { cache: "no-store" }).then(jsonOrError<{ accounts: Account[] }>), fetch("/api/admin/roles", { cache: "no-store" }).then(jsonOrError<{ roles: RoleSummary[] }>)]); setAccounts(accountData.accounts); setRoles(roleData.roles);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "工作区加载失败"); }
  };
  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const create = async (event: FormEvent) => { event.preventDefault(); try { await jsonOrError(await fetch("/api/admin/workspaces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create", name }) })); setName(""); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "创建失败"); } };
  const remove = async (workspace: Workspace) => {
    if (!window.confirm(`确认删除工作区“${workspace.name}”？该工作区中的会话、素材、任务和配置数据会一并删除。`)) return;
    try {
      await jsonOrError(await fetch(`/api/admin/workspaces?id=${encodeURIComponent(workspace.id)}`, { method: "DELETE" }));
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "工作区删除失败"); }
  };
  return <div className="grid gap-6 lg:grid-cols-2"><section className="rounded-2xl border bg-card p-5"><h2 className="font-semibold">工作区</h2><ErrorText error={error} /><ul className="mt-4 divide-y rounded-xl border">{workspaces.map((workspace) => <li key={workspace.id} className="flex items-center gap-3 p-3"><div className="min-w-0 flex-1"><p className="font-medium">{workspace.name}</p><p className="text-muted-foreground text-xs">{workspace.slug}</p></div>{canGrant("system.workspaces.manage") && workspace.id !== session.actor.workspaceId && <Button variant="ghost" size="sm" className="text-destructive" onClick={() => void remove(workspace)}><Trash2Icon />删除</Button>}</li>)}</ul>{canGrant("system.workspaces.manage") && <form onSubmit={create} className="mt-4 flex gap-2"><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="新工作区名称" required /><Button><PlusIcon />创建</Button></form>}</section>{canGrant("system.members.manage") && accounts.length > 0 && <WorkspaceAssignment accounts={accounts} roles={roles} workspaces={workspaces} onError={setError} onSaved={load} />}</div>;
}

function WorkspaceAssignment({ accounts, roles, workspaces, onError, onSaved }: { accounts: Account[]; roles: RoleSummary[]; workspaces: Workspace[]; onError: (error: string) => void; onSaved: () => Promise<void> }) {
  const workspaceRoles = roles.filter((role) => role.scope === "workspace");
  const [userId, setUserId] = useState(accounts[0]?.id ?? ""); const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? ""); const [roleId, setRoleId] = useState(workspaceRoles[0]?.id ?? "");
  const submit = async (event: FormEvent) => { event.preventDefault(); try { await jsonOrError(await fetch("/api/admin/workspaces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "assign-roles", userId, workspaceId, roleIds: [roleId] }) })); await onSaved(); } catch (reason) { onError(reason instanceof Error ? reason.message : "分配失败"); } };
  const remove = async () => {
    const account = accounts.find((item) => item.id === userId);
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!account || !workspace || !window.confirm(`确认将“${account.displayName}”移出工作区“${workspace.name}”？`)) return;
    try {
      await jsonOrError(await fetch("/api/admin/workspaces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "remove-member", userId, workspaceId }) }));
      await onSaved();
    } catch (reason) { onError(reason instanceof Error ? reason.message : "移除成员失败"); }
  };
  return <section className="rounded-2xl border bg-card p-5"><h2 className="font-semibold">分配工作区角色</h2><form onSubmit={submit} className="mt-4 grid gap-3"><Select label="账号" value={userId} setValue={setUserId} options={accounts.map((item) => ({ value: item.id, label: `${item.account} · ${item.displayName}` }))} /><Select label="工作区" value={workspaceId} setValue={setWorkspaceId} options={workspaces.map((item) => ({ value: item.id, label: item.name }))} /><Select label="角色" value={roleId} setValue={setRoleId} options={workspaceRoles.map((item) => ({ value: item.id, label: item.name }))} /><div className="flex gap-2"><Button className="flex-1"><UserRoundCheckIcon />保存分配</Button><Button type="button" variant="outline" className="text-destructive" onClick={() => void remove()}><Trash2Icon />移出工作区</Button></div></form></section>;
}

function AuditTab() {
  const [audit, setAudit] = useState<AuditEntry[]>([]); const [error, setError] = useState<string | null>(null);
  useEffect(() => { void fetch("/api/admin/audit", { cache: "no-store" }).then(jsonOrError<{ audit: AuditEntry[] }>).then((result) => setAudit(result.audit)).catch((reason) => setError(reason instanceof Error ? reason.message : "审计加载失败")); }, []);
  return <section className="rounded-2xl border bg-card p-5"><h2 className="font-semibold">权限变更审计</h2><p className="text-muted-foreground mb-4 text-sm">记录操作者、目标角色、授权前后差异和时间。</p><ErrorText error={error} /><div className="divide-y rounded-xl border">{audit.map((item) => <div key={item.id} className="p-3"><div className="flex flex-wrap justify-between gap-2"><p className="font-medium">{item.actorName} · {item.action}</p><time className="text-muted-foreground text-xs">{new Date(item.createdAt).toLocaleString()}</time></div><p className="text-muted-foreground mt-1 text-xs">角色：{item.targetRoleId ?? "—"} · 授权 {item.detail?.before?.length ?? 0} → {item.detail?.after?.length ?? 0}{item.detail?.assignedCount ? ` · 影响 ${item.detail.assignedCount} 人` : ""}</p></div>)}</div></section>;
}

function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <div className="fixed inset-0 z-50 bg-black/40" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="bg-background absolute inset-y-0 right-0 w-full max-w-4xl overflow-auto border-l p-5 shadow-xl"><div className="mb-5 flex items-center"><h2 className="flex-1 font-semibold">{title}</h2><Button variant="ghost" size="sm" onClick={onClose}><XIcon /></Button></div>{children}</aside></div>;
}

function Select({ label, value, setValue, options }: { label: string; value: string; setValue: (value: string) => void; options: { value: string; label: string }[] }) {
  return <label className="grid gap-1 text-sm">{label}<select value={value} onChange={(event) => setValue(event.target.value)} className="bg-background h-9 rounded-md border px-3">{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
}
