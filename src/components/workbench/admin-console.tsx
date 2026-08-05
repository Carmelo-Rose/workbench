"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowLeftIcon, CopyIcon, DownloadIcon, KeyRoundIcon, PlusIcon, RefreshCwIcon, ShieldAlertIcon, Trash2Icon, UploadIcon, UserRoundCheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { organizationPermissions, workspacePermissions, type Permission } from "@/lib/authorization";
import { useWorkbenchSession, type RoleSummary } from "@/components/workbench/auth-gate";

type Account = {
  id: string; account: string; email: string; displayName: string; department: string | null;
  status: "active" | "disabled"; organizationRoles: RoleSummary[]; workspaceRoles: Record<string, RoleSummary[]>;
};
type Workspace = { id: string; name: string; slug: string; created_at: number };
type ImportPreview = { valid: boolean; errors: { row: number; message: string }[]; rows: unknown[] };
type Tab = "accounts" | "roles" | "workspaces";

async function jsonOrError<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `请求失败 (${response.status})`);
  return payload;
}

const tabNames: Record<Tab, string> = { accounts: "账号", roles: "角色", workspaces: "工作区" };

export function AdminConsole() {
  const { can } = useWorkbenchSession();
  const [tab, setTab] = useState<Tab>("accounts");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async (query = "") => {
    setLoading(true);
    setError(null);
    try {
      const [accountData, roleData, workspaceData] = await Promise.all([
        fetch(`/api/admin/accounts?q=${encodeURIComponent(query)}`, { cache: "no-store" }).then(jsonOrError<{ accounts: Account[] }>),
        fetch("/api/admin/roles", { cache: "no-store" }).then(jsonOrError<{ roles: RoleSummary[] }>),
        fetch("/api/admin/workspaces", { cache: "no-store" }).then(jsonOrError<{ workspaces: Workspace[] }>),
      ]);
      setAccounts(accountData.accounts); setRoles(roleData.roles); setWorkspaces(workspaceData.workspaces);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法加载管理数据");
    } finally { setLoading(false); }
  };

  useEffect(() => {
    if (!can("read", "Admin")) return;
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [can]);

  if (!can("read", "Admin")) {
    return <main className="bg-background flex min-h-dvh items-center justify-center p-6"><div className="max-w-sm rounded-2xl border bg-card p-6 text-center"><ShieldAlertIcon className="text-destructive mx-auto size-8" /><h1 className="mt-3 font-semibold">无权访问管理后台</h1><p className="text-muted-foreground mt-2 text-sm">需要管理后台访问权限。</p><Button asChild className="mt-5"><Link href="/">返回工作台</Link></Button></div></main>;
  }

  return (
    <main className="bg-background min-h-dvh p-4 sm:p-8">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <Button asChild variant="ghost" size="sm"><Link href="/"><ArrowLeftIcon /> 工作台</Link></Button>
          <div className="min-w-0 flex-1"><h1 className="text-xl font-semibold">管理后台</h1><p className="text-muted-foreground text-sm">账号、角色和工作区权限管理</p></div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}><RefreshCwIcon className={loading ? "animate-spin" : ""} />刷新</Button>
        </div>
        <div className="mb-6 flex gap-1 rounded-xl border bg-muted/30 p-1">
          {(Object.keys(tabNames) as Tab[]).map((item) => <button key={item} type="button" onClick={() => setTab(item)} className={`flex-1 rounded-lg px-3 py-2 text-sm ${tab === item ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:bg-background/60"}`}>{tabNames[item]}</button>)}
        </div>
        {error && <p role="alert" className="text-destructive mb-4 text-sm">{error}</p>}
        {tab === "accounts" && <AccountsTab accounts={accounts} roles={roles} workspaces={workspaces} reload={load} reportError={setError} />}
        {tab === "roles" && <RolesTab roles={roles} reload={load} reportError={setError} />}
        {tab === "workspaces" && <WorkspacesTab accounts={accounts} roles={roles} workspaces={workspaces} reload={load} reportError={setError} />}
      </div>
    </main>
  );
}

function AccountsTab({ accounts, roles, workspaces, reload, reportError }: { accounts: Account[]; roles: RoleSummary[]; workspaces: Workspace[]; reload: (query?: string) => Promise<void>; reportError: (value: string | null) => void }) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Account | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const orgRoles = roles.filter((role) => role.scope === "organization");
  const workspaceRoles = roles.filter((role) => role.scope === "workspace");

  const mutate = async (body: Record<string, unknown>) => {
    setBusy(true); reportError(null);
    try { await jsonOrError(await fetch("/api/admin/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })); await reload(query); }
    catch (reason) { reportError(reason instanceof Error ? reason.message : "操作失败"); }
    finally { setBusy(false); }
  };
  const inspectImport = async (commit: boolean) => {
    if (!file) return;
    setBusy(true); reportError(null);
    try {
      const form = new FormData(); form.set("file", file); if (commit) form.set("commit", "true");
      const result = await jsonOrError<{ preview: ImportPreview }>(await fetch("/api/admin/employees/import", { method: "POST", body: form }));
      setPreview(result.preview); if (commit && result.preview.valid) { setFile(null); await reload(query); }
    } catch (reason) { reportError(reason instanceof Error ? reason.message : "导入失败"); }
    finally { setBusy(false); }
  };

  return <div className="grid gap-6">
    <section className="rounded-2xl border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-3"><div className="flex-1"><h2 className="font-semibold">账号列表</h2><p className="text-muted-foreground mt-1 text-sm">禁用、重置密码和角色变更会在服务端立即生效。</p></div><form onSubmit={(event) => { event.preventDefault(); void reload(query); }} className="flex gap-2"><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="按账号、姓名或部门搜索" /><Button type="submit" variant="outline">搜索</Button></form><Button size="sm" onClick={() => setEditing({ id: "", account: "", email: "", displayName: "", department: null, status: "active", organizationRoles: [], workspaceRoles: {} })}><PlusIcon />新建账号</Button></div>
      <div className="mt-4 divide-y overflow-hidden rounded-xl border">
        {accounts.map((account) => <div key={account.id} className="flex flex-wrap items-center gap-3 p-3"><div className="min-w-40 flex-1"><p className="font-medium">{account.displayName} <span className="text-muted-foreground font-normal">{account.account}</span></p><p className="text-muted-foreground text-xs">{account.department || "未设置部门"} · {account.organizationRoles.map((role) => role.name).join("、") || "无组织角色"}</p></div><span className={`rounded-full px-2 py-1 text-xs ${account.status === "active" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-muted text-muted-foreground"}`}>{account.status === "active" ? "已启用" : "已禁用"}</span><Button variant="outline" size="sm" onClick={() => setEditing(account)}>编辑</Button><Button variant="outline" size="sm" onClick={() => void mutate({ action: "reset-password", userId: account.id })}><KeyRoundIcon />重置为 123456</Button><Button variant={account.status === "active" ? "outline" : "default"} size="sm" disabled={busy} onClick={() => void mutate({ action: "status", userId: account.id, status: account.status === "active" ? "disabled" : "active" })}>{account.status === "active" ? "禁用" : "启用"}</Button></div>)}
        {!accounts.length && <p className="text-muted-foreground p-6 text-center text-sm">暂无匹配账号</p>}
      </div>
    </section>
    <section className="rounded-2xl border bg-card p-4 sm:p-5"><div className="flex flex-wrap items-center gap-3"><div className="flex-1"><h2 className="font-semibold">批量导入</h2><p className="text-muted-foreground mt-1 text-sm">先预检；角色或字段无效时整批不会入库。新账号密码为 123456，已有账号不重置密码。</p></div><Button asChild variant="outline" size="sm"><a href="/api/admin/employees/import"><DownloadIcon />CSV 模板</a></Button><Button asChild variant="outline" size="sm"><a href="/api/admin/employees/import?format=xlsx"><DownloadIcon />XLSX 模板</a></Button></div><div className="mt-4 flex flex-wrap items-center gap-3"><Input className="max-w-sm" type="file" accept=".csv,.xlsx" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); }} /><Button variant="outline" disabled={!file || busy} onClick={() => void inspectImport(false)}><UploadIcon />预检</Button>{preview?.valid && <Button disabled={busy} onClick={() => void inspectImport(true)}>确认导入</Button>}</div>{preview && <div className={`mt-4 rounded-xl border p-3 text-sm ${preview.valid ? "border-emerald-500/30 bg-emerald-500/5" : "border-destructive/30 bg-destructive/5"}`}><p className="font-medium">{preview.valid ? `预检通过：${preview.rows.length} 条记录` : `预检失败：${preview.errors.length} 个问题`}</p>{preview.errors.map((item) => <p key={`${item.row}-${item.message}`} className="mt-1 text-destructive">第 {item.row} 行：{item.message}</p>)}</div>}</section>
    {editing && <AccountEditor account={editing} organizationRoles={orgRoles} workspaceRoles={workspaceRoles} workspaces={workspaces} onClose={() => setEditing(null)} onSubmit={async (payload) => { await mutate(payload); setEditing(null); }} />}
  </div>;
}

function AccountEditor({ account, organizationRoles, workspaceRoles, workspaces, onClose, onSubmit }: { account: Account; organizationRoles: RoleSummary[]; workspaceRoles: RoleSummary[]; workspaces: Workspace[]; onClose: () => void; onSubmit: (payload: Record<string, unknown>) => Promise<void> }) {
  const [accountId, setAccountId] = useState(account.account); const [name, setName] = useState(account.displayName); const [department, setDepartment] = useState(account.department ?? "");
  const [organizationRoleId, setOrganizationRoleId] = useState(account.organizationRoles[0]?.id ?? organizationRoles.find((role) => role.key === "organization-member")?.id ?? "");
  const [workspaceRoleId, setWorkspaceRoleId] = useState(account.workspaceRoles[workspaces[0]?.id ?? ""]?.[0]?.id ?? workspaceRoles.find((role) => role.key === "workspace-member")?.id ?? "");
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"><form onSubmit={(event) => { event.preventDefault(); void onSubmit({ action: "upsert", ...(account.id ? { id: account.id } : {}), account: accountId, displayName: name, department, organizationRoleIds: organizationRoleId ? [organizationRoleId] : [], workspaceRoleIds: workspaceId && workspaceRoleId ? { [workspaceId]: [workspaceRoleId] } : {} }); }} className="bg-card w-full max-w-lg rounded-2xl border p-5 shadow-xl"><div className="flex items-center justify-between"><h2 className="font-semibold">{account.id ? "编辑账号" : "新建账号"}</h2><Button type="button" variant="ghost" size="sm" onClick={onClose}>关闭</Button></div><div className="mt-4 grid gap-3"><label className="grid gap-1 text-sm">账号<Input value={accountId} onChange={(event) => setAccountId(event.target.value)} required /></label><label className="grid gap-1 text-sm">姓名<Input value={name} onChange={(event) => setName(event.target.value)} required /></label><label className="grid gap-1 text-sm">部门<Input value={department} onChange={(event) => setDepartment(event.target.value)} /></label><label className="grid gap-1 text-sm">组织角色<select value={organizationRoleId} onChange={(event) => setOrganizationRoleId(event.target.value)} className="bg-background h-9 rounded-md border px-3">{organizationRoles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label><div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm">工作区<select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} className="bg-background h-9 rounded-md border px-3">{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label><label className="grid gap-1 text-sm">工作区角色<select value={workspaceRoleId} onChange={(event) => setWorkspaceRoleId(event.target.value)} className="bg-background h-9 rounded-md border px-3">{workspaceRoles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label></div></div><div className="mt-5 flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>取消</Button><Button type="submit">保存</Button></div></form></div>;
}

function RolesTab({ roles, reload, reportError }: { roles: RoleSummary[]; reload: () => Promise<void>; reportError: (value: string | null) => void }) {
  const [editing, setEditing] = useState<RoleSummary | null>(null); const [creating, setCreating] = useState(false);
  const remove = async (id: string) => { try { await jsonOrError(await fetch(`/api/admin/roles?id=${encodeURIComponent(id)}`, { method: "DELETE" })); await reload(); } catch (reason) { reportError(reason instanceof Error ? reason.message : "删除失败"); } };
  return <section className="rounded-2xl border bg-card p-4 sm:p-5"><div className="flex items-center gap-3"><div className="flex-1"><h2 className="font-semibold">角色与权限</h2><p className="text-muted-foreground mt-1 text-sm">权限目录受到控制；系统角色受保护，不能编辑、删除或降权。</p></div><Button size="sm" onClick={() => setCreating(true)}><PlusIcon />创建自定义角色</Button></div><div className="mt-4 grid gap-3 md:grid-cols-2">{roles.map((role) => <article key={role.id} className="rounded-xl border p-4"><div className="flex gap-2"><div className="min-w-0 flex-1"><p className="font-medium">{role.name} {role.system && <span className="text-muted-foreground text-xs">系统</span>}</p><p className="text-muted-foreground text-xs">{role.scope === "organization" ? "组织级" : "工作区级"} · 已分配 {role.assignedCount ?? 0} 人</p></div>{!role.protected && <><Button variant="ghost" size="sm" onClick={() => setEditing(role)}>编辑</Button><Button variant="ghost" size="sm" onClick={() => void remove(role.id)}><Trash2Icon className="text-destructive" /></Button></>}</div><p className="text-muted-foreground mt-3 text-xs">{role.permissions.length ? role.permissions.join(" · ") : "无权限"}</p>{!role.protected && <Button variant="outline" size="sm" className="mt-3" onClick={() => { setEditing({ ...role, id: "", name: `${role.name} 副本`, system: false, protected: false }); setCreating(true); }}><CopyIcon />复制</Button>}</article>)}</div>{(creating || editing) && <RoleEditor role={creating ? editing : editing} onClose={() => { setCreating(false); setEditing(null); }} onSubmit={async (payload) => { try { const method = payload.id ? "PATCH" : "POST"; await jsonOrError(await fetch("/api/admin/roles", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })); await reload(); setCreating(false); setEditing(null); } catch (reason) { reportError(reason instanceof Error ? reason.message : "保存失败"); } }} />}</section>;
}

function RoleEditor({ role, onClose, onSubmit }: { role: RoleSummary | null; onClose: () => void; onSubmit: (payload: { id?: string; scope: "organization" | "workspace"; name: string; permissions: Permission[] }) => Promise<void> }) {
  const [scope, setScope] = useState<"organization" | "workspace">(role?.scope ?? "workspace"); const [name, setName] = useState(role?.name ?? ""); const [permissions, setPermissions] = useState<Permission[]>(role?.permissions ?? []);
  const available = scope === "organization" ? organizationPermissions : workspacePermissions;
  const toggle = (permission: Permission) => setPermissions((current) => current.includes(permission) ? current.filter((item) => item !== permission) : [...current, permission]);
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"><form onSubmit={(event) => { event.preventDefault(); void onSubmit({ ...(role?.id ? { id: role.id } : {}), scope, name, permissions }); }} className="bg-card w-full max-w-lg rounded-2xl border p-5 shadow-xl"><div className="flex items-center justify-between"><h2 className="font-semibold">{role?.id ? "编辑角色" : "创建角色"}</h2><Button type="button" variant="ghost" size="sm" onClick={onClose}>关闭</Button></div><div className="mt-4 grid gap-3"><label className="grid gap-1 text-sm">作用域<select value={scope} disabled={!!role?.id} onChange={(event) => { setScope(event.target.value as typeof scope); setPermissions([]); }} className="bg-background h-9 rounded-md border px-3"><option value="organization">组织级</option><option value="workspace">工作区级</option></select></label><label className="grid gap-1 text-sm">角色名称<Input value={name} onChange={(event) => setName(event.target.value)} required /></label><fieldset className="grid gap-2 rounded-xl border p-3"><legend className="px-1 text-sm font-medium">权限</legend>{available.map((permission) => <label key={permission} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={permissions.includes(permission)} onChange={() => toggle(permission)} />{permission}</label>)}</fieldset></div><div className="mt-5 flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>取消</Button><Button type="submit">保存</Button></div></form></div>;
}

function WorkspacesTab({ accounts, roles, workspaces, reload, reportError }: { accounts: Account[]; roles: RoleSummary[]; workspaces: Workspace[]; reload: () => Promise<void>; reportError: (value: string | null) => void }) {
  const [name, setName] = useState(""); const [userId, setUserId] = useState(accounts[0]?.id ?? ""); const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? ""); const workspaceRoles = useMemo(() => roles.filter((role) => role.scope === "workspace"), [roles]); const [roleId, setRoleId] = useState(workspaceRoles.find((role) => role.key === "workspace-member")?.id ?? "");
  const create = async (event: FormEvent) => { event.preventDefault(); try { await jsonOrError(await fetch("/api/admin/workspaces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create", name }) })); setName(""); await reload(); } catch (reason) { reportError(reason instanceof Error ? reason.message : "创建失败"); } };
  const assign = async (event: FormEvent) => { event.preventDefault(); try { await jsonOrError(await fetch("/api/admin/workspaces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "assign-roles", userId, workspaceId, roleIds: roleId ? [roleId] : [] }) })); await reload(); } catch (reason) { reportError(reason instanceof Error ? reason.message : "分配失败"); } };
  return <div className="grid gap-6 lg:grid-cols-2"><section className="rounded-2xl border bg-card p-4 sm:p-5"><h2 className="font-semibold">工作区</h2><p className="text-muted-foreground mt-1 text-sm">首期不提供物理删除，避免误删业务数据。</p><ul className="mt-4 divide-y overflow-hidden rounded-xl border">{workspaces.map((workspace) => <li key={workspace.id} className="p-3"><p className="font-medium">{workspace.name}</p><p className="text-muted-foreground text-xs">{workspace.slug}</p></li>)}</ul><form onSubmit={create} className="mt-4 flex gap-2"><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="新工作区名称" required /><Button type="submit"><PlusIcon />创建</Button></form></section><section className="rounded-2xl border bg-card p-4 sm:p-5"><h2 className="font-semibold">分配工作区角色</h2><p className="text-muted-foreground mt-1 text-sm">账号可在不同工作区拥有不同角色，最终权限按组织和工作区角色并集计算。</p><form onSubmit={assign} className="mt-4 grid gap-3"><label className="grid gap-1 text-sm">账号<select value={userId} onChange={(event) => setUserId(event.target.value)} className="bg-background h-9 rounded-md border px-3">{accounts.map((account) => <option key={account.id} value={account.id}>{account.account} · {account.displayName}</option>)}</select></label><label className="grid gap-1 text-sm">工作区<select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} className="bg-background h-9 rounded-md border px-3">{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label><label className="grid gap-1 text-sm">工作区角色<select value={roleId} onChange={(event) => setRoleId(event.target.value)} className="bg-background h-9 rounded-md border px-3">{workspaceRoles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label><Button type="submit"><UserRoundCheckIcon />保存分配</Button></form></section></div>;
}
