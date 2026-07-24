/**
 * Legacy single-user deployments already persist these identifiers in several
 * tables. Keep them stable while the application moves to real memberships.
 */
export const legacyUserId = process.env.WORKBENCH_LOCAL_USER_ID ?? "local-user";
export const legacyWorkspaceId = process.env.WORKBENCH_LOCAL_WORKSPACE_ID ?? "default";
export const legacyOrganizationId =
  process.env.WORKBENCH_LOCAL_ORGANIZATION_ID ?? "org_default";
