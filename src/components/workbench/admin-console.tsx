"use client";

import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
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
type EffectivePermissions = { account: Account; workspaceId: string; grants: EffectiveGrant[] };
type Tab = "accounts" | "roles" | "workspaces" | "audit";
type CreateEmployeeForm = {
  account: string;
  displayName: string;
  department: string;
  organizationRoleId: string;
  workspaceRoleId: string;
};

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
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState<CreateEmployeeForm>({
    account: "",
    displayName: "",
    department: "",
    organizationRoleId: "",
    workspaceRoleId: "",
  });
  const [catalog, setCatalog] = useState<PermissionCatalogEntry[]>([]);
  const [effective, setEffective] = useState<EffectivePermissions | null>(null);
  const [effectiveLoading, setEffectiveLoading] = useState<string | null>(null);
  const organizationRoles = roles.filter((role) => role.scope === "organization");
  const workspaceRoles = roles.filter((role) => role.scope === "workspace");
  const setCreateField = <K extends keyof CreateEmployeeForm>(field: K, value: CreateEmployeeForm[K]) => {
    setCreateForm((current) => ({ ...current, [field]: value }));
  };
  const load = async () => {
    try {
      const accountData = await jsonOrError<{ accounts: Account[] }>(await fetch(`/api/admin/accounts?q=${encodeURIComponent(query)}`, { cache: "no-store" }));
      setAccounts(accountData.accounts);
      if (canGrant("system.roles.view")) {
        const roleData = await jsonOrError<{ catalog: PermissionCatalogEntry[]; roles: RoleSummary[] }>(await fetch("/api/admin/roles", { cache: "no-store" }));
        setCatalog(roleData.catalog);
        setRoles(roleData.roles);
        const organizationDefault = roleData.roles.find((role) => role.key === "organization-member") ?? roleData.roles.find((role) => role.scope === "organization");
        const workspaceDefault = roleData.roles.find((role) => role.key === "workspace-member") ?? roleData.roles.find((role) => role.scope === "workspace");
        setCreateForm((current) => ({
          ...current,
          organizationRoleId: current.organizationRoleId || organizationDefault?.id || "",
          workspaceRoleId: current.workspaceRoleId || workspaceDefault?.id || "",
        }));
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "账号加载失败"); }
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
  const createEmployee = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (!createForm.organizationRoleId || !createForm.workspaceRoleId) {
      setError("请先加载可用角色");
      return;
    }
    setCreating(true);
    try {
      const result = await jsonOrError<{ account: Account }>(await fetch("/api/admin/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "upsert",
          account: createForm.account,
          displayName: createForm.displayName,
          department: createForm.department || undefined,
          status: "active",
          organizationRoleIds: [createForm.organizationRoleId],
          workspaceRoleIds: { [session.actor.workspaceId]: [createForm.workspaceRoleId] },
        }),
      }));
      setCreateOpen(false);
      setCreateForm({
        account: "",
        displayName: "",
        department: "",
        organizationRoleId: organizationRoles.find((role) => role.key === "organization-member")?.id ?? organizationRoles[0]?.id ?? "",
        workspaceRoleId: workspaceRoles.find((role) => role.key === "workspace-member")?.id ?? workspaceRoles[0]?.id ?? "",
      });
      setNotice(`已创建 ${result.account.displayName}。初始密码为 123456，员工登录后请立即修改。`);
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "员工创建失败"); }
    finally { setCreating(false); }
  };
  const inspect = async (account: Account, workspaceId = session.actor.workspaceId) => {
    setEffectiveLoading(`${account.id}:${workspaceId}`);
    try {
      const result = await jsonOrError<{ grants: EffectiveGrant[] }>(await fetch(`/api/admin/accounts/${encodeURIComponent(account.id)}/grants?workspaceId=${encodeURIComponent(workspaceId)}`));
      setEffective({ account, workspaceId, grants: result.grants });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "有效权限加载失败"); }
    finally { setEffectiveLoading(null); }
  };
  return <section className="rounded-2xl border bg-card p-4 sm:p-5"><div className="mb-4 flex flex-wrap items-end gap-2"><div className="min-w-48 flex-1"><h2 className="font-semibold">账号</h2><p className="text-muted-foreground text-sm">角色变更会在下一次请求立即生效。</p></div>{canGrant("system.accounts.manage") && <Button type="button" onClick={() => { setNotice(null); setCreateOpen((value) => !value); }}><PlusIcon />新增员工</Button>}<form onSubmit={(event) => { event.preventDefault(); void load(); }} className="flex gap-2"><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="账号、姓名或部门" /><Button variant="outline">搜索</Button></form></div><ErrorText error={error} />{notice && <p role="status" className="text-emerald-600 mb-4 text-sm">{notice}</p>}
    {createOpen && canGrant("system.accounts.manage") && <form onSubmit={createEmployee} className="mb-4 rounded-xl border bg-muted/20 p-4"><div className="mb-3"><h3 className="font-medium">新增员工</h3><p className="text-muted-foreground mt-1 text-xs">创建后员工可用账号登录当前工作区。初始密码为 123456。</p></div><div className="grid gap-3 sm:grid-cols-3"><label className="grid gap-1 text-sm">账号<Input value={createForm.account} onChange={(event) => setCreateField("account", event.target.value)} placeholder="例如 zhangsan" required /></label><label className="grid gap-1 text-sm">姓名<Input value={createForm.displayName} onChange={(event) => setCreateField("displayName", event.target.value)} placeholder="员工姓名" required /></label><label className="grid gap-1 text-sm">部门<Input value={createForm.department} onChange={(event) => setCreateField("department", event.target.value)} placeholder="可选" /></label></div><div className="mt-3 grid gap-3 sm:grid-cols-2"><Select label="组织角色" value={createForm.organizationRoleId} setValue={(value) => setCreateField("organizationRoleId", value)} options={organizationRoles.map((role) => ({ value: role.id, label: role.name }))} /><Select label="当前工作区角色" value={createForm.workspaceRoleId} setValue={(value) => setCreateField("workspaceRoleId", value)} options={workspaceRoles.map((role) => ({ value: role.id, label: role.name }))} /></div><div className="mt-4 flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>取消</Button><Button type="submit" disabled={creating || !organizationRoles.length || !workspaceRoles.length}>{creating ? "创建中…" : "创建员工"}</Button></div></form>}
    <div className="divide-y rounded-xl border">{accounts.map((account) => <div key={account.id} className="flex flex-wrap items-center gap-3 p-3"><div className="min-w-48 flex-1"><p className="font-medium">{account.displayName} <span className="text-muted-foreground font-normal">{account.account}</span></p><p className="text-muted-foreground text-xs">组织角色：{account.organizationRoles.map((role) => role.name).join("、") || "无"}</p><p className="text-muted-foreground text-xs">当前工作区角色：{account.workspaceRoles[session.actor.workspaceId]?.map((role) => role.name).join("、") || "未加入"}</p></div><Button variant="outline" size="sm" onClick={() => void inspect(account)}>有效权限</Button>{canGrant("system.accounts.manage") && <><Button variant="outline" size="sm" onClick={() => void mutate({ action: "reset-password", userId: account.id })}><KeyRoundIcon />重置密码</Button><Button variant="outline" size="sm" onClick={() => void mutate({ action: "status", userId: account.id, status: account.status === "active" ? "disabled" : "active" })}>{account.status === "active" ? "禁用" : "启用"}</Button>{account.id !== session.actor.userId && <Button variant="ghost" size="sm" className="text-destructive" onClick={() => void remove(account)}><Trash2Icon />删除</Button>}</>}</div>)}</div>
    {effective && <EffectivePermissionsDrawer effective={effective} catalog={catalog} workspaces={session.workspaces} loading={effectiveLoading !== null} onClose={() => setEffective(null)} onWorkspaceChange={(workspaceId) => void inspect(effective.account, workspaceId)} />}
  </section>;
}

function EffectivePermissionsDrawer({
  effective,
  catalog,
  workspaces,
  loading,
  onClose,
  onWorkspaceChange,
}: {
  effective: EffectivePermissions;
  catalog: PermissionCatalogEntry[];
  workspaces: { id: string; name: string }[];
  loading: boolean;
  onClose: () => void;
  onWorkspaceChange: (workspaceId: string) => void;
}) {
  const catalogById = useMemo(() => new Map(catalog.map((entry) => [entry.id, entry])), [catalog]);
  const sections = useMemo(() => {
    const groups = new Map<string, {
      groupName: string;
      modules: Map<string, { moduleName: string; grants: { grant: EffectiveGrant; definition?: PermissionCatalogEntry }[] }>;
    }>();

    for (const grant of effective.grants) {
      const definition = catalogById.get(grant.permission);
      const groupKey = definition?.group ?? "other";
      const group = groups.get(groupKey) ?? { groupName: definition?.groupName ?? "其他权限", modules: new Map() };
      const moduleKey = definition?.module ?? "other";
      const moduleEntry = group.modules.get(moduleKey) ?? { moduleName: definition?.moduleName ?? "未分类", grants: [] };
      moduleEntry.grants.push({ grant, definition });
      group.modules.set(moduleKey, moduleEntry);
      groups.set(groupKey, group);
    }

    return [...groups.values()].map((group) => ({ ...group, modules: [...group.modules.values()] }));
  }, [catalogById, effective.grants]);

  const availableWorkspaces = workspaces.filter((workspace) => (effective.account.workspaceRoles[workspace.id]?.length ?? 0) > 0);
  const currentWorkspace = workspaces.find((workspace) => workspace.id === effective.workspaceId);
  const currentWorkspaceRoles = effective.account.workspaceRoles[effective.workspaceId] ?? [];
  const organizationRoleNames = effective.account.organizationRoles.map((role) => role.name).join("、") || "无";
  const workspaceRoleNames = currentWorkspaceRoles.map((role) => role.name).join("、") || "未加入";

  return (
    <Drawer title={`${effective.account.displayName} · 有效权限`} onClose={onClose}>
      <div className="space-y-5">
        <section className="rounded-xl border bg-muted/30 p-4">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-48 flex-1">
              <p className="font-medium">{effective.account.displayName} <span className="text-muted-foreground font-normal">{effective.account.account}</span></p>
              <p className="text-muted-foreground mt-1 text-xs">查看的是该账号在所选工作区内，由组织角色和工作区角色合并后的最终权限。</p>
            </div>
            <label className="grid min-w-44 gap-1 text-xs font-medium">
              查看工作区
              <select
                aria-label="查看工作区"
                value={effective.workspaceId}
                disabled={loading || availableWorkspaces.length < 2}
                onChange={(event) => onWorkspaceChange(event.target.value)}
                className="bg-background h-9 rounded-md border px-3 text-sm font-normal"
              >
                {(availableWorkspaces.length ? availableWorkspaces : currentWorkspace ? [currentWorkspace] : []).map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <PermissionSummary label="组织角色" value={organizationRoleNames} />
            <PermissionSummary label="工作区角色" value={workspaceRoleNames} />
            <PermissionSummary label="有效权限" value={`${effective.grants.length} 项 · ${sections.length} 个权限组`} />
          </div>
        </section>

        {sections.length ? sections.map((section) => (
          <section key={section.groupName}>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="font-semibold">{section.groupName}</h3>
              <span className="text-muted-foreground text-xs">{section.modules.reduce((total, module) => total + module.grants.length, 0)} 项</span>
            </div>
            <div className="grid gap-3">
              {section.modules.map((module) => (
                <article key={module.moduleName} className="rounded-xl border p-3">
                  <h4 className="text-sm font-medium">{module.moduleName}</h4>
                  <div className="mt-2 divide-y rounded-lg border">
                    {module.grants.map(({ grant, definition }) => (
                      <div key={grant.permission} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
                        <div className="min-w-40 flex-1">
                          <p className="text-sm">{definition?.operationName ?? "授权"}</p>
                          <p className="text-muted-foreground font-mono text-[11px]">{grant.permission}</p>
                        </div>
                        <span className="rounded-full bg-muted px-2 py-1 text-xs">
                          {grant.dataScope === "workspace" ? "工作区" : grant.dataScope === "own" ? "本人" : "不适用"}
                        </span>
                        <p className="text-muted-foreground w-full text-xs sm:w-auto">来源：{grant.sourceRoles.map((role) => role.name).join("、") || "直接授权"}</p>
                      </div>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </section>
        )) : <p className="text-muted-foreground rounded-xl border border-dashed p-6 text-center text-sm">该账号在当前工作区没有有效权限。</p>}
      </div>
    </Drawer>
  );
}

function PermissionSummary({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border bg-background/70 p-3"><p className="text-muted-foreground text-xs">{label}</p><p className="mt-1 text-sm font-medium">{value}</p></div>;
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
  const defaultRoleId = workspaceRoles.find((role) => role.key === "workspace-member")?.id ?? workspaceRoles[0]?.id ?? "";
  const initialAccount = accounts[0];
  const initialWorkspaceId = initialAccount
    ? workspaces.find((workspace) => (initialAccount.workspaceRoles[workspace.id]?.length ?? 0) > 0)?.id ?? workspaces[0]?.id ?? ""
    : workspaces[0]?.id ?? "";
  const [userId, setUserId] = useState(initialAccount?.id ?? "");
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId);
  const [roleId, setRoleId] = useState(initialAccount?.workspaceRoles[initialWorkspaceId]?.[0]?.id ?? defaultRoleId);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const selectedAccount = accounts.find((account) => account.id === userId);
  const selectedAccountRoles = selectedAccount?.workspaceRoles[workspaceId] ?? [];
  const selectedRole = workspaceRoles.find((role) => role.id === roleId);

  const selectAccount = (nextUserId: string) => {
    const nextAccount = accounts.find((account) => account.id === nextUserId);
    const nextWorkspaceId = nextAccount
      ? workspaces.find((workspace) => (nextAccount.workspaceRoles[workspace.id]?.length ?? 0) > 0)?.id ?? workspaces[0]?.id ?? ""
      : workspaces[0]?.id ?? "";
    const nextRoleId = nextAccount?.workspaceRoles[nextWorkspaceId]?.[0]?.id ?? defaultRoleId;
    setUserId(nextUserId);
    setWorkspaceId(nextWorkspaceId);
    setRoleId(nextRoleId);
    setNotice(null);
    setError(null);
  };

  const selectWorkspace = (nextWorkspaceId: string) => {
    setWorkspaceId(nextWorkspaceId);
    setRoleId(selectedAccount?.workspaceRoles[nextWorkspaceId]?.[0]?.id ?? defaultRoleId);
    setNotice(null);
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setNotice(null);
    setError(null);
    const account = selectedAccount;
    const workspace = workspaces.find((item) => item.id === workspaceId);
    const role = selectedRole;
    if (!account || !workspace || !role) {
      setError("请选择账号、工作区和角色后再保存");
      return;
    }
    setSaving(true);
    try {
      await jsonOrError(await fetch("/api/admin/workspaces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "assign-roles", userId, workspaceId, roleIds: [roleId] }) }));
      await onSaved();
      setNotice(`已保存：${account.displayName} · ${workspace.name} · ${role.name}`);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "分配失败";
      setError(message);
      onError(message);
    } finally { setSaving(false); }
  };

  const remove = async () => {
    const account = accounts.find((item) => item.id === userId);
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!account || !workspace || !window.confirm(`确认将“${account.displayName}”移出工作区“${workspace.name}”？`)) return;
    setNotice(null);
    setError(null);
    setRemoving(true);
    try {
      await jsonOrError(await fetch("/api/admin/workspaces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "remove-member", userId, workspaceId }) }));
      await onSaved();
      setNotice(`已将 ${account.displayName} 移出 ${workspace.name}`);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "移除成员失败";
      setError(message);
      onError(message);
    } finally { setRemoving(false); }
  };
  return <section className="rounded-2xl border bg-card p-5"><div><h2 className="font-semibold">分配工作区角色</h2><p className="text-muted-foreground mt-1 text-xs">切换账号或工作区时，会自动带出该账号已有的工作区和角色。</p></div>{notice && <p role="status" className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>}{error && <p role="alert" className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}<form onSubmit={submit} className="mt-4 grid gap-3"><Select label="账号" value={userId} setValue={selectAccount} options={accounts.map((item) => ({ value: item.id, label: `${item.account} · ${item.displayName}` }))} /><Select label="工作区" value={workspaceId} setValue={selectWorkspace} options={workspaces.map((item) => ({ value: item.id, label: item.name }))} /><Select label="角色" value={roleId} setValue={(value) => { setRoleId(value); setNotice(null); setError(null); }} options={workspaceRoles.map((item) => ({ value: item.id, label: item.name }))} />{selectedAccount && <p className="text-muted-foreground -mt-1 text-xs">当前已有角色：{selectedAccountRoles.map((role) => role.name).join("、") || "未加入该工作区"}</p>}<div className="flex gap-2"><Button type="submit" className="flex-1" disabled={saving || removing}><UserRoundCheckIcon />{saving ? "保存中…" : "保存分配"}</Button><Button type="button" variant="outline" className="text-destructive" disabled={saving || removing} onClick={() => void remove()}><Trash2Icon />{removing ? "移除中…" : "移出工作区"}</Button></div></form></section>;
}

function AuditTab() {
  const [audit, setAudit] = useState<AuditEntry[]>([]); const [error, setError] = useState<string | null>(null);
  useEffect(() => { void fetch("/api/admin/audit", { cache: "no-store" }).then(jsonOrError<{ audit: AuditEntry[] }>).then((result) => setAudit(result.audit)).catch((reason) => setError(reason instanceof Error ? reason.message : "审计加载失败")); }, []);
  return <section className="rounded-2xl border bg-card p-5"><h2 className="font-semibold">权限变更审计</h2><p className="text-muted-foreground mb-4 text-sm">记录操作者、目标角色、授权前后差异和时间。</p><ErrorText error={error} /><div className="divide-y rounded-xl border">{audit.map((item) => <div key={item.id} className="p-3"><div className="flex flex-wrap justify-between gap-2"><p className="font-medium">{item.actorName} · {item.action}</p><time className="text-muted-foreground text-xs">{new Date(item.createdAt).toLocaleString()}</time></div><p className="text-muted-foreground mt-1 text-xs">角色：{item.targetRoleId ?? "—"} · 授权 {item.detail?.before?.length ?? 0} → {item.detail?.after?.length ?? 0}{item.detail?.assignedCount ? ` · 影响 ${item.detail.assignedCount} 人` : ""}</p></div>)}</div></section>;
}

function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const titleId = useId();
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);
  return <div className="fixed inset-0 z-50 bg-black/40" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside role="dialog" aria-modal="true" aria-labelledby={titleId} className="bg-background absolute inset-y-0 right-0 w-full max-w-3xl overflow-auto border-l p-5 shadow-xl"><div className="mb-5 flex items-center"><h2 id={titleId} className="flex-1 font-semibold">{title}</h2><Button variant="ghost" size="sm" aria-label="关闭" onClick={onClose}><XIcon /></Button></div>{children}</aside></div>;
}

function Select({ label, value, setValue, options }: { label: string; value: string; setValue: (value: string) => void; options: { value: string; label: string }[] }) {
  return <label className="grid gap-1 text-sm">{label}<select value={value} onChange={(event) => setValue(event.target.value)} className="bg-background h-9 rounded-md border px-3">{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
}
