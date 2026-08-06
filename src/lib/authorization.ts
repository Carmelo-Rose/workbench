import { createMongoAbility, type MongoAbility, type RawRuleOf } from "@casl/ability";

export type DataScope = "own" | "workspace";
export type PermissionOperation = "view" | "use" | "create" | "manage" | "import" | "export";
export type PermissionGroup = "workbench" | "sessions" | "image" | "video" | "commerce" | "resources" | "models" | "system";

export type PermissionCatalogEntry = {
  id: string;
  group: PermissionGroup;
  groupName: string;
  module: string;
  moduleName: string;
  operation: PermissionOperation;
  operationName: string;
  dataScopes: readonly DataScope[];
  roleScope: "organization" | "workspace";
};

const entry = (
  id: string,
  group: PermissionGroup,
  groupName: string,
  module: string,
  moduleName: string,
  operation: PermissionOperation,
  operationName: string,
  options: Partial<Pick<PermissionCatalogEntry, "dataScopes" | "roleScope">> = {},
): PermissionCatalogEntry => ({
  id, group, groupName, module, moduleName, operation, operationName,
  dataScopes: options.dataScopes ?? [],
  roleScope: options.roleScope ?? "workspace",
});

/**
 * Browser Workbench feature permission registry. This is deliberately the
 * single catalogue shared by migrations, CASL, route guards and the admin UI.
 */
export const permissionRegistry = [
  entry("workbench.chat.use", "workbench", "工作台", "chat", "AI 对话", "use", "使用"),
  entry("workbench.backend.direct.use", "workbench", "工作台", "direct-backend", "Direct 后端", "use", "使用"),
  entry("workbench.backend.hermes.use", "workbench", "工作台", "hermes-backend", "Hermes 后端", "use", "使用"),

  entry("sessions.messages.view", "sessions", "会话", "messages", "会话与消息", "view", "查看", { dataScopes: ["own"] }),
  entry("sessions.messages.manage", "sessions", "会话", "messages", "会话与消息", "manage", "管理", { dataScopes: ["own"] }),
  entry("sessions.messages.import", "sessions", "会话", "messages", "会话与消息", "import", "导入", { dataScopes: ["own"] }),
  entry("sessions.messages.export", "sessions", "会话", "messages", "会话与消息", "export", "导出", { dataScopes: ["own"] }),

  entry("image.reverse.use", "image", "图片创作", "image-reverse", "图片反推", "use", "使用"),
  entry("image.generate.use", "image", "图片创作", "image-generation", "图片生成", "use", "使用"),
  entry("image.product-set.use", "image", "图片创作", "product-set", "商品套图", "use", "使用"),
  entry("image.cutout.use", "image", "图片创作", "image-cutout", "图片抠图", "use", "使用"),

  entry("video.analyze.use", "video", "视频创作", "video-analysis", "视频分析", "use", "使用"),
  entry("video.generate.use", "video", "视频创作", "video-generation", "视频生成", "use", "使用"),
  entry("video.erase.use", "video", "视频创作", "video-erase", "智能擦除", "use", "使用"),
  entry("video.enhance.use", "video", "视频创作", "video-enhance", "修复增强", "use", "使用"),
  entry("video.cutout.use", "video", "视频创作", "video-cutout", "视频抠图", "use", "使用"),

  entry("commerce.rankings.view", "commerce", "电商数据", "rankings", "榜单分析", "view", "查看", { dataScopes: ["workspace"] }),
  entry("commerce.rankings.import", "commerce", "电商数据", "rankings", "榜单分析", "import", "导入", { dataScopes: ["workspace"] }),
  entry("commerce.collection.view", "commerce", "电商数据", "collection", "采集数据", "view", "查看", { dataScopes: ["own", "workspace"] }),
  entry("commerce.collection.import", "commerce", "电商数据", "collection", "采集数据", "import", "导入", { dataScopes: ["own", "workspace"] }),

  ...([[
    "assets", "素材库",
  ], ["subjects", "主体库"], ["tasks", "任务中心"]] as const).flatMap(([module, moduleName]) => [
    entry(`resources.${module}.view`, "resources", "资源中心", module, moduleName, "view", "查看", { dataScopes: ["own", "workspace"] }),
    entry(`resources.${module}.create`, "resources", "资源中心", module, moduleName, "create", "创建/使用", { dataScopes: ["own", "workspace"] }),
    entry(`resources.${module}.manage`, "resources", "资源中心", module, moduleName, "manage", "管理", { dataScopes: ["own", "workspace"] }),
    entry(`resources.${module}.export`, "resources", "资源中心", module, moduleName, "export", "导出", { dataScopes: ["own", "workspace"] }),
  ]),

  entry("models.library.view", "models", "模型资源", "model-library", "模特库", "view", "查看", { dataScopes: ["workspace"] }),
  entry("models.library.manage", "models", "模型资源", "model-library", "模特库", "manage", "管理", { dataScopes: ["workspace"] }),
  entry("models.combinations.view", "models", "模型资源", "model-combinations", "模特组合", "view", "查看", { dataScopes: ["workspace"] }),
  entry("models.combinations.manage", "models", "模型资源", "model-combinations", "模特组合", "manage", "管理", { dataScopes: ["workspace"] }),

  ...([[
    "accounts", "账号", "organization",
  ], ["roles", "角色", "organization"], ["workspaces", "工作区", "organization"], ["members", "成员", "workspace"], ["runtime-config", "运行配置", "workspace"]] as const).flatMap(([module, moduleName, roleScope]) => [
    entry(`system.${module}.view`, "system", "系统管理", module, moduleName, "view", "查看", { roleScope }),
    entry(`system.${module}.manage`, "system", "系统管理", module, moduleName, "manage", "管理", { roleScope }),
  ]),
  entry("system.audit.view", "system", "系统管理", "audit", "审计", "view", "查看", { roleScope: "organization" }),
] as const satisfies readonly PermissionCatalogEntry[];

export type Permission = (typeof permissionRegistry)[number]["id"];
export type PermissionGrant = { permission: Permission; dataScope?: DataScope };
export type RoleScope = "organization" | "workspace";
export type AbilityAction = PermissionOperation | "read" | "operate";
export type AbilitySubject = (typeof permissionRegistry)[number]["module"] | "Admin" | "Account" | "Role" | "Workspace" | "WorkspaceMember" | "Organization" | "RuntimeConfig";
export type AbilityResource = { __caslSubjectType__: AbilitySubject; ownerUserId?: string };
export type WorkbenchAbility = MongoAbility<[AbilityAction, AbilitySubject | AbilityResource]>;

export const permissionCatalog = permissionRegistry.map((item) => item.id) as Permission[];
export const organizationPermissions = permissionRegistry.filter((item) => item.roleScope === "organization").map((item) => item.id) as Permission[];
export const workspacePermissions = permissionRegistry.filter((item) => item.roleScope === "workspace").map((item) => item.id) as Permission[];

const byId = new Map<string, PermissionCatalogEntry>(permissionRegistry.map((item) => [item.id, item]));
export function permissionDefinition(permission: string): PermissionCatalogEntry | undefined { return byId.get(permission); }
export function isPermission(permission: string): permission is Permission { return byId.has(permission); }
export function isDataScope(value: unknown): value is DataScope { return value === "own" || value === "workspace"; }

const businessView: Permission[] = [
  "sessions.messages.view",
  "commerce.rankings.view", "commerce.collection.view",
  "resources.assets.view", "resources.subjects.view", "resources.tasks.view",
  "models.library.view", "models.combinations.view",
];
const businessOperate: Permission[] = [
  "workbench.chat.use", "workbench.backend.direct.use", "workbench.backend.hermes.use",
  "sessions.messages.manage", "sessions.messages.import", "sessions.messages.export",
  "image.reverse.use", "image.generate.use", "image.product-set.use", "image.cutout.use",
  "video.analyze.use", "video.generate.use", "video.erase.use", "video.enhance.use", "video.cutout.use",
  "commerce.rankings.import", "commerce.collection.import",
  "resources.assets.create", "resources.assets.manage", "resources.assets.export",
  "resources.subjects.create", "resources.subjects.manage", "resources.subjects.export",
  "resources.tasks.create", "resources.tasks.manage", "resources.tasks.export",
  "models.library.manage", "models.combinations.manage",
];
const memberBusinessPermissions: Permission[] = [...businessView, ...businessOperate];
const businessAll = permissionRegistry.filter((item) => item.roleScope === "workspace" && item.group !== "system").map((item) => item.id as Permission);

/** Frozen legacy expansion: never add future catalogue entries here implicitly. */
export const legacyPermissionExpansions: Readonly<Record<string, readonly Permission[]>> = {
  "admin:access": ["system.accounts.view", "system.roles.view", "system.workspaces.view", "system.audit.view"],
  "accounts:manage": ["system.accounts.view", "system.accounts.manage"],
  "roles:manage": ["system.roles.view", "system.roles.manage", "system.audit.view"],
  "workspaces:manage": ["system.workspaces.view", "system.workspaces.manage"],
  "organization:read": ["system.accounts.view", "system.roles.view", "system.workspaces.view"],
  "organization:manage": ["system.accounts.manage", "system.roles.manage", "system.workspaces.manage", "system.audit.view"],
  "workspace:read": businessView,
  "workspace:operate": businessOperate,
  "workspace:write": businessOperate,
  "workspace:members:manage": ["system.members.view", "system.members.manage"],
  "members:manage": ["system.members.view", "system.members.manage"],
  "workspace:settings:manage": ["system.workspaces.view", "system.workspaces.manage"],
  "workspace:manage": ["system.workspaces.view", "system.workspaces.manage"],
  "runtime-config:manage": ["system.runtime-config.view", "system.runtime-config.manage"],
  "config:manage": ["system.runtime-config.view", "system.runtime-config.manage"],
};

export function expandLegacyPermission(permission: string): readonly Permission[] {
  if (isPermission(permission)) return [permission];
  return legacyPermissionExpansions[permission] ?? [];
}

/** Compatibility helper for old callers that expected a single canonical ID. */
export function canonicalPermission(permission: string): Permission | null {
  return expandLegacyPermission(permission)[0] ?? null;
}

function scopeFor(permission: Permission, requested?: DataScope): DataScope | undefined {
  const definition = permissionDefinition(permission)!;
  if (!definition.dataScopes.length) return undefined;
  if (definition.dataScopes.length === 1) return definition.dataScopes[0];
  return requested && definition.dataScopes.includes(requested) ? requested : "own";
}

export function normalizeGrants(grants: readonly { permission: string; dataScope?: DataScope | null }[]): PermissionGrant[] {
  const merged = new Map<Permission, DataScope | undefined>();
  for (const grant of grants) {
    for (const permission of expandLegacyPermission(grant.permission)) {
      const next = scopeFor(permission, grant.dataScope ?? undefined);
      const current = merged.get(permission);
      merged.set(permission, current === "workspace" || next === "workspace" ? "workspace" : next ?? current);
    }
  }
  return [...merged].map(([permission, dataScope]) => ({ permission, ...(dataScope ? { dataScope } : {}) })).sort((a, b) => a.permission.localeCompare(b.permission));
}

function defaultScope(permission: Permission, role: "owner" | "member" | "viewer"): DataScope | undefined {
  const definition = permissionDefinition(permission)!;
  if (!definition.dataScopes.length) return undefined;
  if (definition.dataScopes.length === 1) return definition.dataScopes[0];
  return role === "owner" || role === "member" ? "workspace" : "own";
}

const grantsFor = (permissions: readonly Permission[], role: "owner" | "member" | "viewer" = "owner"): PermissionGrant[] =>
  permissions.map((permission) => ({ permission, ...(defaultScope(permission, role) ? { dataScope: defaultScope(permission, role) } : {}) }));

type SystemRoleDefinition = { key: string; scope: RoleScope; name: string; grants: readonly PermissionGrant[]; permissions: readonly Permission[]; protected: boolean };
const all = permissionCatalog;
const systemOrg = permissionRegistry.filter((item) => item.group === "system" && item.roleScope === "organization").map((item) => item.id as Permission);
const systemWorkspace = permissionRegistry.filter((item) => item.group === "system" && item.roleScope === "workspace").map((item) => item.id as Permission);
const viewerPermissions = permissionRegistry.filter((item) => item.roleScope === "workspace" && item.operation === "view").map((item) => item.id as Permission);

export const systemRoleDefinitions: readonly SystemRoleDefinition[] = [
  { key: "organization-owner", scope: "organization", name: "组织所有者", grants: grantsFor(all), permissions: all, protected: true },
  { key: "organization-admin", scope: "organization", name: "组织管理员", grants: grantsFor(systemOrg), permissions: systemOrg, protected: true },
  { key: "organization-member", scope: "organization", name: "组织成员", grants: [], permissions: [], protected: true },
  { key: "workspace-owner", scope: "workspace", name: "工作区所有者", grants: grantsFor([...businessAll, ...systemWorkspace]), permissions: [...businessAll, ...systemWorkspace], protected: true },
  { key: "workspace-admin", scope: "workspace", name: "工作区管理员", grants: grantsFor([...businessAll, ...systemWorkspace]), permissions: [...businessAll, ...systemWorkspace], protected: true },
  { key: "workspace-member", scope: "workspace", name: "工作区成员", grants: grantsFor(memberBusinessPermissions, "member"), permissions: memberBusinessPermissions, protected: true },
  { key: "workspace-viewer", scope: "workspace", name: "工作区只读成员", grants: grantsFor(viewerPermissions, "viewer"), permissions: viewerPermissions, protected: true },
];

export function createWorkbenchAbility(input: readonly string[] | readonly PermissionGrant[], userId?: string): WorkbenchAbility {
  const grants = normalizeGrants(input.map((value) => typeof value === "string" ? { permission: value } : value));
  const rules: RawRuleOf<WorkbenchAbility>[] = grants.map((grant) => {
    const definition = permissionDefinition(grant.permission)!;
    return grant.dataScope === "own" && userId
      ? { action: definition.operation, subject: definition.module, conditions: { ownerUserId: userId } }
      : { action: definition.operation, subject: definition.module };
  });
  const allowed = new Set(grants.map((grant) => grant.permission));
  if ([...allowed].some((permission) => permission.startsWith("system.") && permission.endsWith(".view"))) rules.push({ action: "read", subject: "Admin" });
  if (allowed.has("system.accounts.manage")) rules.push({ action: "manage", subject: "Account" });
  if (allowed.has("system.roles.manage")) rules.push({ action: "manage", subject: "Role" });
  if (allowed.has("system.workspaces.manage")) rules.push({ action: "manage", subject: "Workspace" });
  if (allowed.has("system.members.manage")) rules.push({ action: "manage", subject: "WorkspaceMember" });
  if (allowed.has("system.runtime-config.manage")) rules.push({ action: "manage", subject: "RuntimeConfig" });
  if ([...allowed].some((permission) => permissionRegistry.some((item) => item.id === permission && item.roleScope === "workspace"))) {
    rules.push({ action: "read", subject: "Workspace" });
  }
  if ([...allowed].some((permission) => permissionRegistry.some((item) => item.id === permission && item.roleScope === "workspace" && item.operation !== "view"))) {
    rules.push({ action: "operate", subject: "Workspace" });
  }
  return createMongoAbility<[AbilityAction, AbilitySubject | AbilityResource]>(rules);
}

export function hasAbility(input: readonly string[] | readonly PermissionGrant[], action: AbilityAction, subject: AbilitySubject, userId?: string): boolean {
  return createWorkbenchAbility(input, userId).can(action, subject);
}
