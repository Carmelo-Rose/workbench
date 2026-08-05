import { createMongoAbility, type MongoAbility } from "@casl/ability";

export const organizationPermissions = [
  "admin:access",
  "accounts:manage",
  "roles:manage",
  "workspaces:manage",
  "organization:read",
  "organization:manage",
] as const;

export const workspacePermissions = [
  "workspace:read",
  "workspace:operate",
  "workspace:members:manage",
  "workspace:settings:manage",
  "runtime-config:manage",
] as const;

/** The only permission catalogue administrators may assign to custom roles. */
export const permissionCatalog = [
  ...organizationPermissions,
  ...workspacePermissions,
] as const;

export type Permission = (typeof permissionCatalog)[number];
export type RoleScope = "organization" | "workspace";
export type AbilityAction = "read" | "manage" | "operate";
export type AbilitySubject =
  | "Admin"
  | "Account"
  | "Role"
  | "Workspace"
  | "WorkspaceMember"
  | "Organization"
  | "RuntimeConfig";

export type WorkbenchAbility = MongoAbility<[AbilityAction, AbilitySubject]>;

type SystemRoleDefinition = {
  key: string;
  scope: RoleScope;
  name: string;
  permissions: readonly Permission[];
  protected: boolean;
};

export const systemRoleDefinitions: readonly SystemRoleDefinition[] = [
  {
    key: "organization-owner",
    scope: "organization",
    name: "组织所有者",
    permissions: permissionCatalog,
    protected: true,
  },
  {
    key: "organization-admin",
    scope: "organization",
    name: "组织管理员",
    permissions: ["admin:access", "accounts:manage", "roles:manage", "workspaces:manage", "organization:read"],
    protected: true,
  },
  {
    key: "organization-member",
    scope: "organization",
    name: "组织成员",
    permissions: ["organization:read"],
    protected: true,
  },
  {
    key: "workspace-owner",
    scope: "workspace",
    name: "工作区所有者",
    permissions: workspacePermissions,
    protected: true,
  },
  {
    key: "workspace-admin",
    scope: "workspace",
    name: "工作区管理员",
    permissions: workspacePermissions,
    protected: true,
  },
  {
    key: "workspace-member",
    scope: "workspace",
    name: "工作区成员",
    permissions: ["workspace:read", "workspace:operate"],
    protected: true,
  },
  {
    key: "workspace-viewer",
    scope: "workspace",
    name: "工作区只读成员",
    permissions: ["workspace:read"],
    protected: true,
  },
];

const legacyPermissionAliases: Record<string, Permission> = {
  "workspace:write": "workspace:operate",
  "workspace:manage": "workspace:settings:manage",
  "members:manage": "workspace:members:manage",
  "config:manage": "runtime-config:manage",
};

export function canonicalPermission(permission: string): Permission | null {
  const value = legacyPermissionAliases[permission] ?? permission;
  return (permissionCatalog as readonly string[]).includes(value)
    ? value as Permission
    : null;
}

function rulesFor(permissions: readonly string[]) {
  const allowed = new Set(permissions.map(canonicalPermission).filter((value): value is Permission => value !== null));
  const rules: { action: AbilityAction; subject: AbilitySubject }[] = [];
  if (allowed.has("admin:access")) rules.push({ action: "read", subject: "Admin" });
  if (allowed.has("accounts:manage")) rules.push({ action: "manage", subject: "Account" });
  if (allowed.has("roles:manage")) rules.push({ action: "manage", subject: "Role" });
  if (allowed.has("workspaces:manage")) rules.push({ action: "manage", subject: "Workspace" });
  if (allowed.has("organization:read")) rules.push({ action: "read", subject: "Organization" });
  if (allowed.has("organization:manage")) rules.push({ action: "manage", subject: "Organization" });
  if (allowed.has("workspace:read")) rules.push({ action: "read", subject: "Workspace" });
  if (allowed.has("workspace:operate")) rules.push({ action: "operate", subject: "Workspace" });
  if (allowed.has("workspace:members:manage")) rules.push({ action: "manage", subject: "WorkspaceMember" });
  if (allowed.has("workspace:settings:manage")) rules.push({ action: "manage", subject: "Workspace" });
  if (allowed.has("runtime-config:manage")) rules.push({ action: "manage", subject: "RuntimeConfig" });
  return rules;
}

export function createWorkbenchAbility(permissions: readonly string[]): WorkbenchAbility {
  return createMongoAbility<[AbilityAction, AbilitySubject]>(rulesFor(permissions));
}

export function hasAbility(
  permissions: readonly string[],
  action: AbilityAction,
  subject: AbilitySubject,
): boolean {
  return createWorkbenchAbility(permissions).can(action, subject);
}
