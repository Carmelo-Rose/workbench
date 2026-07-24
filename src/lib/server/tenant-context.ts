import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { WorkspaceActor } from "./tenant";

export type TenantContext = {
  actor: WorkspaceActor;
  requestId: string;
};

const globalForTenant = globalThis as typeof globalThis & {
  __workbenchTenantStorage?: AsyncLocalStorage<TenantContext>;
};

const storage =
  globalForTenant.__workbenchTenantStorage ??
  new AsyncLocalStorage<TenantContext>();
globalForTenant.__workbenchTenantStorage = storage;

export function runWithTenantContext<T>(
  actor: WorkspaceActor,
  operation: () => T,
  requestId = `req_${randomUUID()}`,
): T {
  return storage.run({ actor, requestId }, operation);
}

export function tenantContext(): TenantContext | null {
  return storage.getStore() ?? null;
}

export function requireTenantContext(): TenantContext {
  const context = tenantContext();
  if (!context) {
    throw new Error("Tenant context is required for this operation");
  }
  return context;
}

export function activeWorkspaceId(): string | null {
  return tenantContext()?.actor.workspaceId ?? null;
}
