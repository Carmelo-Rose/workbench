import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  legacyOrganizationId,
  legacyUserId,
  legacyWorkspaceId,
} from "./tenant-ids";
import { systemRoleDefinitions } from "../authorization";

const DDL = `
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  account TEXT UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  department TEXT,
  password_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS organization_members (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS workspace_members_user
  ON workspace_members(user_id, workspace_id);
CREATE TABLE IF NOT EXISTS workbench_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('organization', 'workspace')),
  role_key TEXT NOT NULL,
  name TEXT NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 0,
  is_protected INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (organization_id, scope, role_key),
  UNIQUE (organization_id, scope, name)
);
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
);
CREATE TABLE IF NOT EXISTS organization_member_roles (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (organization_id, user_id, role_id)
);
CREATE TABLE IF NOT EXISTS workspace_member_roles (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id, role_id)
);
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  detail_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (
  scope TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  failed_count INTEGER NOT NULL DEFAULT 0,
  window_started_at INTEGER NOT NULL,
  locked_until INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, scope_key)
);
CREATE TABLE IF NOT EXISTS threads (
  workspace_id TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  external_id TEXT,
  status TEXT NOT NULL DEFAULT 'regular' CHECK (status IN ('regular','archived')),
  title TEXT,
  custom_json TEXT,
  head_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_message_at INTEGER,
  PRIMARY KEY (workspace_id, remote_id)
);
CREATE TABLE IF NOT EXISTS messages (
  workspace_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  id TEXT NOT NULL,
  parent_id TEXT,
  format TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, thread_id, id),
  FOREIGN KEY (workspace_id, thread_id)
    REFERENCES threads(workspace_id, remote_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS mono_assets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  mime_type TEXT,
  name TEXT,
  storage_key TEXT,
  location TEXT NOT NULL DEFAULT 'remote-url'
    CHECK (location IN ('local-storage', 'toolbox', 'tos', 'remote-url')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mono_assets_workspace_created
  ON mono_assets(workspace_id, created_at DESC);
CREATE TABLE IF NOT EXISTS mono_product_model_profiles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  group_id TEXT NOT NULL CHECK (group_id IN ('female', 'male')),
  anchor_asset_id TEXT NOT NULL REFERENCES mono_assets(id) ON DELETE RESTRICT,
  body_asset_id TEXT REFERENCES mono_assets(id) ON DELETE RESTRICT,
  subject_id TEXT REFERENCES mono_subjects(id) ON DELETE RESTRICT,
  source_candidate_id TEXT,
  prompt TEXT,
  provider TEXT,
  model TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mono_product_model_profiles_workspace_created
  ON mono_product_model_profiles(workspace_id, created_at DESC);
CREATE TABLE IF NOT EXISTS mono_product_model_pairs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  female_profile_id TEXT NOT NULL REFERENCES mono_product_model_profiles(id) ON DELETE RESTRICT,
  male_profile_id TEXT NOT NULL REFERENCES mono_product_model_profiles(id) ON DELETE RESTRICT,
  female_subject_id TEXT REFERENCES mono_subjects(id) ON DELETE RESTRICT,
  male_subject_id TEXT REFERENCES mono_subjects(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (female_profile_id <> male_profile_id)
);
CREATE INDEX IF NOT EXISTS mono_product_model_pairs_workspace_created
  ON mono_product_model_pairs(workspace_id, created_at DESC);
CREATE TABLE IF NOT EXISTS mono_subjects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  asset_id TEXT NOT NULL REFERENCES mono_assets(id),
  kind TEXT NOT NULL DEFAULT 'generic' CHECK (kind IN ('generic', 'product-model')),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'workspace')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mono_subjects_workspace_updated
  ON mono_subjects(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS mono_subjects_owner_updated
  ON mono_subjects(owner_user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS mono_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  input_json TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  idempotency_key TEXT,
  trace_id TEXT NOT NULL,
  favorite INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER,
  worker_version TEXT,
  UNIQUE(workspace_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS mono_job_assets (
  job_id TEXT NOT NULL REFERENCES mono_jobs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  asset_id TEXT NOT NULL REFERENCES mono_assets(id) ON DELETE RESTRICT,
  role TEXT NOT NULL,
  slot_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, role, slot_key)
);
CREATE INDEX IF NOT EXISTS mono_job_assets_workspace_created
  ON mono_job_assets(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mono_job_assets_asset
  ON mono_job_assets(asset_id);
CREATE INDEX IF NOT EXISTS mono_jobs_workspace_updated
  ON mono_jobs(workspace_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS mono_workers (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('inline', 'standalone')),
  hostname TEXT,
  pid INTEGER,
  started_at INTEGER NOT NULL,
  last_heartbeat_at INTEGER NOT NULL,
  in_flight_json TEXT
);
CREATE TABLE IF NOT EXISTS collector_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  item_id TEXT,
  title TEXT,
  author TEXT,
  url TEXT,
  published_at TEXT,
  metrics_json TEXT,
  raw_json TEXT NOT NULL,
  imported_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS collector_items_workspace_imported
  ON collector_items(workspace_id, imported_at DESC);
CREATE TABLE IF NOT EXISTS mono_job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES mono_jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  detail_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS api_config (
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, key)
);
`;

const INDEX_DDL = `
CREATE INDEX IF NOT EXISTS organization_members_user
  ON organization_members(user_id, organization_id);
CREATE INDEX IF NOT EXISTS workspaces_organization
  ON workspaces(organization_id, created_at);
CREATE INDEX IF NOT EXISTS workspace_members_user
  ON workspace_members(user_id, workspace_id);
CREATE INDEX IF NOT EXISTS workbench_sessions_token
  ON workbench_sessions(token_hash);
CREATE INDEX IF NOT EXISTS workbench_sessions_expiry
  ON workbench_sessions(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS users_account_unique
  ON users(account COLLATE NOCASE) WHERE account IS NOT NULL;
CREATE INDEX IF NOT EXISTS roles_organization_scope
  ON roles(organization_id, scope);
CREATE INDEX IF NOT EXISTS organization_member_roles_lookup
  ON organization_member_roles(organization_id, user_id);
CREATE INDEX IF NOT EXISTS workspace_member_roles_lookup
  ON workspace_member_roles(workspace_id, user_id);
CREATE INDEX IF NOT EXISTS admin_audit_organization_created
  ON admin_audit_log(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS threads_workspace_updated
  ON threads(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS messages_workspace_thread
  ON messages(workspace_id, thread_id);
CREATE INDEX IF NOT EXISTS mono_assets_workspace_created
  ON mono_assets(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mono_product_model_profiles_workspace_created
  ON mono_product_model_profiles(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mono_product_model_pairs_workspace_created
  ON mono_product_model_pairs(workspace_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS mono_product_model_profiles_subject
  ON mono_product_model_profiles(subject_id) WHERE subject_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mono_subjects_workspace_updated
  ON mono_subjects(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS mono_subjects_owner_updated
  ON mono_subjects(owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS mono_jobs_workspace_updated
  ON mono_jobs(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS mono_product_pipeline_jobs_folder
  ON mono_product_pipeline_jobs(folder_key, job_id);
CREATE INDEX IF NOT EXISTS collector_items_workspace_imported
  ON collector_items(workspace_id, imported_at DESC);
`;

function columns(db: DatabaseSync, table: string): { name: string; pk: number }[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
    pk: number;
  }[];
}

function seedLegacyTenant(db: DatabaseSync): void {
  const now = Date.now();
  const localEmail = `${legacyUserId}@local.workbench`;
  db.prepare(
    `INSERT OR IGNORE INTO organizations (id, name, slug, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    legacyOrganizationId,
    process.env.WORKBENCH_LOCAL_ORGANIZATION_NAME ?? "默认组织",
    legacyOrganizationId,
    now,
    now,
  );
  db.prepare(
    `INSERT OR IGNORE INTO users
       (id, email, display_name, password_hash, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 'active', ?, ?)`,
  ).run(
    legacyUserId,
    localEmail,
    process.env.WORKBENCH_LOCAL_USER_NAME ?? "本地管理员",
    now,
    now,
  );

  const workspaceColumns = columns(db, "workspaces");
  if (!workspaceColumns.some((column) => column.name === "organization_id")) {
    db.exec("ALTER TABLE workspaces ADD COLUMN organization_id TEXT");
  }
  db.prepare(
    `INSERT OR IGNORE INTO workspaces
       (id, organization_id, name, slug, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    legacyWorkspaceId,
    legacyOrganizationId,
    process.env.WORKBENCH_LOCAL_WORKSPACE_NAME ?? "默认工作区",
    legacyWorkspaceId,
    now,
    now,
  );
  db.prepare(
    `UPDATE workspaces SET organization_id = ?
     WHERE organization_id IS NULL OR organization_id = ''`,
  ).run(legacyOrganizationId);
  db.prepare(
    `INSERT OR IGNORE INTO organization_members
       (organization_id, user_id, role, created_at, updated_at)
     VALUES (?, ?, 'owner', ?, ?)`,
  ).run(legacyOrganizationId, legacyUserId, now, now);
  db.exec(`
    INSERT OR IGNORE INTO organization_members
      (organization_id, user_id, role, created_at, updated_at)
    SELECT
      w.organization_id,
      wm.user_id,
      CASE
        WHEN MAX(CASE wm.role WHEN 'owner' THEN 3 WHEN 'admin' THEN 2 ELSE 1 END) = 3
          THEN 'owner'
        WHEN MAX(CASE wm.role WHEN 'owner' THEN 3 WHEN 'admin' THEN 2 ELSE 1 END) = 2
          THEN 'admin'
        ELSE 'member'
      END,
      MIN(wm.created_at),
      MAX(wm.updated_at)
    FROM workspace_members wm
    JOIN workspaces w ON w.id = wm.workspace_id
    GROUP BY w.organization_id, wm.user_id
  `);
  db.prepare(
    `INSERT OR IGNORE INTO workspace_members
       (workspace_id, user_id, role, created_at, updated_at)
     VALUES (?, ?, 'owner', ?, ?)`,
  ).run(legacyWorkspaceId, legacyUserId, now, now);
}

function migrateThreads(db: DatabaseSync): void {
  const threadColumns = columns(db, "threads");
  const messageColumns = columns(db, "messages");
  const compositeThreadKey =
    threadColumns.find((column) => column.name === "workspace_id")?.pk === 1 &&
    threadColumns.find((column) => column.name === "remote_id")?.pk === 2;
  if (
    compositeThreadKey &&
    messageColumns.some((column) => column.name === "workspace_id")
  ) {
    return;
  }

  const threadWorkspace = threadColumns.some(
    (column) => column.name === "workspace_id",
  )
    ? "COALESCE(NULLIF(workspace_id, ''), ?)"
    : "?";
  const threadOwner = threadColumns.some(
    (column) => column.name === "owner_user_id",
  )
    ? "COALESCE(NULLIF(owner_user_id, ''), ?)"
    : "?";

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE threads_tenant_new (
        workspace_id TEXT NOT NULL,
        remote_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        external_id TEXT,
        status TEXT NOT NULL DEFAULT 'regular' CHECK (status IN ('regular','archived')),
        title TEXT,
        custom_json TEXT,
        head_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_message_at INTEGER,
        PRIMARY KEY (workspace_id, remote_id)
      );
    `);
    db.prepare(
      `INSERT INTO threads_tenant_new
        (workspace_id, remote_id, owner_user_id, external_id, status, title,
         custom_json, head_id, created_at, updated_at, last_message_at)
       SELECT ${threadWorkspace}, remote_id, ${threadOwner}, external_id, status,
              title, custom_json, head_id, created_at, updated_at, last_message_at
       FROM threads`,
    ).run(legacyWorkspaceId, legacyUserId);
    db.exec(`
      CREATE TABLE messages_tenant_new (
        workspace_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        id TEXT NOT NULL,
        parent_id TEXT,
        format TEXT NOT NULL,
        content_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, thread_id, id),
        FOREIGN KEY (workspace_id, thread_id)
          REFERENCES threads_tenant_new(workspace_id, remote_id) ON DELETE CASCADE
      );
      INSERT INTO messages_tenant_new
        (workspace_id, thread_id, id, parent_id, format, content_json, created_at, updated_at)
      SELECT t.workspace_id, m.thread_id, m.id, m.parent_id, m.format,
             m.content_json, m.created_at, m.updated_at
      FROM messages m
      JOIN threads_tenant_new t ON t.remote_id = m.thread_id;
      DROP TABLE messages;
      DROP TABLE threads;
      ALTER TABLE threads_tenant_new RENAME TO threads;
      ALTER TABLE messages_tenant_new RENAME TO messages;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function migrateApiConfig(db: DatabaseSync): void {
  const configColumns = columns(db, "api_config");
  if (configColumns.some((column) => column.name === "workspace_id")) return;
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE api_config_tenant_new (
        workspace_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, key)
      );
    `);
    db.prepare(
      `INSERT INTO api_config_tenant_new (workspace_id, key, value, updated_at)
       SELECT ?, key, value, updated_at FROM api_config`,
    ).run(legacyWorkspaceId);
    db.exec(`
      DROP TABLE api_config;
      ALTER TABLE api_config_tenant_new RENAME TO api_config;
      COMMIT;
    `);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * v13: product model cards are first-class entries in the Mono subject
 * library.  The profile table remains the product-specific subtype (gender
 * and provenance), while mono_subjects owns the reusable identity card and
 * anchor asset.  Pairs record the selected subject relationship as well.
 */
function migrateProductModelLibraryToSubjects(db: DatabaseSync): void {
  const subjectColumns = columns(db, "mono_subjects");
  if (!subjectColumns.some((column) => column.name === "kind")) {
    db.exec("ALTER TABLE mono_subjects ADD COLUMN kind TEXT NOT NULL DEFAULT 'generic'");
  }

  const profileColumns = columns(db, "mono_product_model_profiles");
  if (!profileColumns.some((column) => column.name === "body_asset_id")) {
    db.exec("ALTER TABLE mono_product_model_profiles ADD COLUMN body_asset_id TEXT REFERENCES mono_assets(id)");
  }
  if (!profileColumns.some((column) => column.name === "subject_id")) {
    db.exec("ALTER TABLE mono_product_model_profiles ADD COLUMN subject_id TEXT REFERENCES mono_subjects(id)");
  }

  const pairColumns = columns(db, "mono_product_model_pairs");
  if (!pairColumns.some((column) => column.name === "female_subject_id")) {
    db.exec("ALTER TABLE mono_product_model_pairs ADD COLUMN female_subject_id TEXT REFERENCES mono_subjects(id)");
  }
  if (!pairColumns.some((column) => column.name === "male_subject_id")) {
    db.exec("ALTER TABLE mono_product_model_pairs ADD COLUMN male_subject_id TEXT REFERENCES mono_subjects(id)");
  }

  type ProfileWithoutSubject = {
    id: string;
    workspace_id: string;
    display_name: string;
    anchor_asset_id: string;
    created_at: number;
  };
  const missingSubjects = db.prepare(
    `SELECT id, workspace_id, display_name, anchor_asset_id, created_at
     FROM mono_product_model_profiles WHERE subject_id IS NULL OR subject_id = ''`,
  ).all() as ProfileWithoutSubject[];
  if (missingSubjects.length) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const assetOwner = db.prepare(
        "SELECT user_id FROM mono_assets WHERE id = ? AND workspace_id = ?",
      );
      const addSubject = db.prepare(
        `INSERT INTO mono_subjects
         (id, workspace_id, owner_user_id, name, asset_id, kind, visibility, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'product-model', 'workspace', ?, ?)`,
      );
      const linkProfile = db.prepare(
        "UPDATE mono_product_model_profiles SET subject_id = ?, updated_at = ? WHERE id = ? AND workspace_id = ?",
      );
      for (const profile of missingSubjects) {
        const asset = assetOwner.get(profile.anchor_asset_id, profile.workspace_id) as { user_id: string } | undefined;
        if (!asset) throw new Error(`模特卡 ${profile.id} 缺少锚点素材`);
        const subjectId = `subject_${randomUUID()}`;
        addSubject.run(
          subjectId,
          profile.workspace_id,
          asset.user_id,
          profile.display_name,
          profile.anchor_asset_id,
          profile.created_at,
          profile.created_at,
        );
        linkProfile.run(subjectId, profile.created_at, profile.id, profile.workspace_id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  type PairWithoutSubjects = {
    id: string;
    workspace_id: string;
    female_profile_id: string;
    male_profile_id: string;
  };
  const missingPairSubjects = db.prepare(
    `SELECT id, workspace_id, female_profile_id, male_profile_id
     FROM mono_product_model_pairs
     WHERE female_subject_id IS NULL OR male_subject_id IS NULL`,
  ).all() as PairWithoutSubjects[];
  if (missingPairSubjects.length) {
    const profileSubject = db.prepare(
      "SELECT subject_id, group_id FROM mono_product_model_profiles WHERE id = ? AND workspace_id = ?",
    );
    const linkPair = db.prepare(
      `UPDATE mono_product_model_pairs
       SET female_subject_id = ?, male_subject_id = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    );
    for (const pair of missingPairSubjects) {
      const female = profileSubject.get(pair.female_profile_id, pair.workspace_id) as { subject_id: string | null; group_id: string } | undefined;
      const male = profileSubject.get(pair.male_profile_id, pair.workspace_id) as { subject_id: string | null; group_id: string } | undefined;
      if (!female?.subject_id || female.group_id !== "female" || !male?.subject_id || male.group_id !== "male") {
        throw new Error(`模特组合 ${pair.id} 的主体关系无效`);
      }
      linkPair.run(female.subject_id, male.subject_id, Date.now(), pair.id, pair.workspace_id);
    }
  }
}

/**
 * Account/password authentication was introduced after email-based employee
 * records existed in the field.  SQLite cannot add a NOT NULL column to an
 * occupied table, so the account column is added first, deterministically
 * populated from the historical email local part, then protected by a unique
 * index.  No user id, password hash, membership, session, or business row is
 * rebuilt during this migration.
 */
function migrateAccountsAndRoles(db: DatabaseSync): void {
  const userColumns = columns(db, "users");
  if (!userColumns.some((column) => column.name === "account")) {
    db.exec("ALTER TABLE users ADD COLUMN account TEXT");
  }
  if (!userColumns.some((column) => column.name === "department")) {
    db.exec("ALTER TABLE users ADD COLUMN department TEXT");
  }

  const users = db.prepare(
    "SELECT id, email, account FROM users ORDER BY created_at ASC, id ASC",
  ).all() as { id: string; email: string; account: string | null }[];
  const used = new Set(
    users.flatMap((user) => user.account ? [user.account.trim().toLowerCase()] : []),
  );
  const setAccount = db.prepare("UPDATE users SET account = ? WHERE id = ?");
  for (const user of users) {
    if (user.account?.trim()) continue;
    const raw = user.email.split("@", 1)[0]?.toLowerCase() ?? "employee";
    const base = raw.replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "employee";
    let account = base;
    let suffix = 2;
    while (used.has(account)) account = `${base}-${suffix++}`;
    used.add(account);
    setAccount.run(account, user.id);
  }

  const now = Date.now();
  const organizations = db.prepare("SELECT id FROM organizations").all() as { id: string }[];
  const addRole = db.prepare(
    `INSERT OR IGNORE INTO roles
      (id, organization_id, scope, role_key, name, is_system, is_protected, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  );
  const addPermission = db.prepare(
    "INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES (?, ?)",
  );
  for (const organization of organizations) {
    for (const definition of systemRoleDefinitions) {
      const roleId = `sys_${organization.id}_${definition.key}`;
      addRole.run(
        roleId,
        organization.id,
        definition.scope,
        definition.key,
        definition.name,
        definition.protected ? 1 : 0,
        now,
        now,
      );
      for (const permission of definition.permissions) addPermission.run(roleId, permission);
    }
  }

  const organizationAssignments = db.prepare(
    `SELECT organization_id, user_id, role FROM organization_members`,
  ).all() as { organization_id: string; user_id: string; role: string }[];
  const addOrganizationRole = db.prepare(
    `INSERT OR IGNORE INTO organization_member_roles
      (organization_id, user_id, role_id, created_at) VALUES (?, ?, ?, ?)`,
  );
  for (const membership of organizationAssignments) {
    const role = ["owner", "admin", "member"].includes(membership.role) ? membership.role : "member";
    addOrganizationRole.run(
      membership.organization_id,
      membership.user_id,
      `sys_${membership.organization_id}_organization-${role}`,
      now,
    );
  }

  const workspaceAssignments = db.prepare(
    `SELECT wm.workspace_id, wm.user_id, wm.role, w.organization_id
       FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id`,
  ).all() as { workspace_id: string; user_id: string; role: string; organization_id: string }[];
  const addWorkspaceRole = db.prepare(
    `INSERT OR IGNORE INTO workspace_member_roles
      (workspace_id, user_id, role_id, created_at) VALUES (?, ?, ?, ?)`,
  );
  for (const membership of workspaceAssignments) {
    const role = ["owner", "admin", "member", "viewer"].includes(membership.role) ? membership.role : "member";
    addWorkspaceRole.run(
      membership.workspace_id,
      membership.user_id,
      `sys_${membership.organization_id}_workspace-${role}`,
      now,
    );
  }
}

function ensureSchema(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(DDL);
  seedLegacyTenant(db);
  migrateAccountsAndRoles(db);
  migrateThreads(db);
  migrateApiConfig(db);
  migrateProductModelLibraryToSubjects(db);
  // v3：既有库补 favorite 列（DDL 的 CREATE TABLE IF NOT EXISTS 不会改老表）。
  const jobColumns = db.prepare("PRAGMA table_info(mono_jobs)").all() as { name: string }[];
  if (!jobColumns.some((column) => column.name === "favorite")) {
    db.exec("ALTER TABLE mono_jobs ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0");
  }
  // v5：素材可落本地对象存储，DB 只记 storage key。
  const assetColumns = db.prepare("PRAGMA table_info(mono_assets)").all() as { name: string }[];
  if (!assetColumns.some((column) => column.name === "storage_key")) {
    db.exec("ALTER TABLE mono_assets ADD COLUMN storage_key TEXT");
  }
  // v9：素材位置统一记录（架构治理 Phase 2）——之前只能从 storage_key 是否
  // 非空隐式推断"本地存储 vs 外部 URL"，这里把它落成显式字段，为后续
  // toolbox/tos 定位器铺路。老库这一列不带 CHECK 约束（枚举值由应用层
  // TS 类型约束，同 v5 的 kind 处理思路），只回填一次；storage_key/source_url
  // 不删不改，可回滚。
  if (!assetColumns.some((column) => column.name === "location")) {
    db.exec(`
      BEGIN;
      ALTER TABLE mono_assets ADD COLUMN location TEXT;
      UPDATE mono_assets SET location =
        CASE WHEN storage_key IS NOT NULL THEN 'local-storage' ELSE 'remote-url' END
        WHERE location IS NULL;
      COMMIT;
    `);
  }
  // v5：kind 枚举改由应用层（zod/TS）约束。SQLite 无法修改 CHECK，
  // 带旧 kind CHECK 的表重建一次，之后新增任务类型不再需要迁移。
  const jobsTable = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mono_jobs'",
  ).get() as { sql: string } | undefined;
  if (jobsTable?.sql.includes("CHECK (kind IN")) {
    db.exec("PRAGMA foreign_keys = OFF");
    // 顺序必须是 建新表→拷贝→删旧表→改名：直接 RENAME 旧表会连带改写
    // mono_job_events 的外键引用，导致其指向被删除的表。
    db.exec(`
      BEGIN;
      CREATE TABLE mono_jobs_new (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        input_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        idempotency_key TEXT,
        trace_id TEXT NOT NULL,
        favorite INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        UNIQUE(workspace_id, idempotency_key)
      );
      INSERT INTO mono_jobs_new
        SELECT id, workspace_id, user_id, kind, status, input_json, result_json, error,
               idempotency_key, trace_id, favorite, created_at, updated_at, started_at, completed_at
        FROM mono_jobs;
      DROP TABLE mono_jobs;
      ALTER TABLE mono_jobs_new RENAME TO mono_jobs;
      CREATE INDEX IF NOT EXISTS mono_jobs_workspace_updated
        ON mono_jobs(workspace_id, updated_at DESC);
      COMMIT;
    `);
    db.exec("PRAGMA foreign_keys = ON");
  }
  // v10：独立 Worker 队列原语（架构治理 Phase 4）——mono_jobs 加 lease/重试/
  // worker 版本字段，claim 从"谁先 UPDATE 到就是谁的"升级成带过期时间的租约，
  // 让不共享同一个 globalThis 的独立进程也能安全地竞争同一批任务；
  // attempt_count/next_run_at 给失败重试退避用。默认值不改变现有行为
  // （MONO_JOB_MAX_ATTEMPTS 默认 1，等价于之前的"失败就 fail，不重试"）。
  // 必须用重新读一次的列表，不能用上面 v5 重建块之前缓存的 jobColumns——
  // 那个块可能已经整表重建过一次。
  const jobColumnsV10 = db.prepare("PRAGMA table_info(mono_jobs)").all() as { name: string }[];
  if (!jobColumnsV10.some((column) => column.name === "lease_owner")) {
    db.exec(`
      ALTER TABLE mono_jobs ADD COLUMN lease_owner TEXT;
      ALTER TABLE mono_jobs ADD COLUMN lease_expires_at INTEGER;
      ALTER TABLE mono_jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE mono_jobs ADD COLUMN next_run_at INTEGER;
      ALTER TABLE mono_jobs ADD COLUMN worker_version TEXT;
    `);
  }
  // v11：商品套图有自己的持久队列元数据。文件夹键是 Workbench 生成的不可逆
  // 摘要，而不是 UNC 路径；它让多个 worker 可以原子地判断“同一商品只能有一个
  // running 任务”，同时又不把共享盘路径泄露到 API 响应。
  //
  // 这张表必须在上面的旧 mono_jobs 重建之后才创建，否则旧库迁移时外键会指向被
  // 重命名的临时表。
  db.exec(`
    CREATE TABLE IF NOT EXISTS mono_product_pipeline_jobs (
      job_id TEXT PRIMARY KEY REFERENCES mono_jobs(id) ON DELETE CASCADE,
      folder_key TEXT NOT NULL
    );
  `);
  db.exec(INDEX_DDL);
  db.exec("PRAGMA user_version = 15");
}

export function openWorkbenchDatabase(dbPath: string): DatabaseSync {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // 长任务会持续写进度，而前端在轮询同一批行。默认的 rollback journal 让读写
  // 互斥，且撞锁时立刻抛 SQLITE_BUSY（界面上就是"Mono 服务暂时不可用"）。
  // WAL 允许读写并发，busy_timeout 再兜住短暂的排他写。
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  ensureSchema(db);
  return db;
}

function openDb(): DatabaseSync {
  const dbPath =
    process.env.WORKBENCH_DB_PATH ??
    path.join(process.cwd(), "data", "workbench.db");
  const db = openWorkbenchDatabase(dbPath);
  console.log(`[workbench] sqlite db at ${dbPath}`);
  return db;
}

// 缓存在 globalThis 上，dev HMR 重新执行模块时复用同一连接。
const globalForDb = globalThis as typeof globalThis & {
  __workbenchDb?: DatabaseSync;
};

export function getDb(): DatabaseSync {
  globalForDb.__workbenchDb ??= openDb();
  // Dev HMR can retain an older connection after DDL changes. All statements
  // are idempotent, so reapplying them also serves as a lightweight migration.
  ensureSchema(globalForDb.__workbenchDb);
  return globalForDb.__workbenchDb;
}
