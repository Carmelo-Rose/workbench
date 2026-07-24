import { randomUUID, timingSafeEqual } from "node:crypto";
import { ZodError, type z } from "zod";
import { monoActorSchema, type MonoActor } from "./contracts";
import {
  currentWorkspaceActor,
  ensureServiceWorkspaceActor,
  requirePermission,
  TenantAccessError,
  type WorkspaceActor,
} from "@/lib/server/tenant";

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  return authorization.slice("Bearer ".length);
}

function equalSecrets(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/**
 * The first deployment uses a shared service credential. Existing Workbench has
 * no user auth yet, so actor headers are scoped and validated independently.
 */
export function assertMonoApiAccess(request: Request): void {
  const expected = process.env.MONO_PLATFORM_API_KEY;
  const localDevelopment = process.env.MONO_LOCAL_DEVELOPMENT === "true" && process.env.NODE_ENV !== "production";
  if (!expected && localDevelopment) return;
  if (!expected) throw new MonoHttpError(503, "Mono 平台接口尚未配置访问凭证");
  const received = bearerToken(request);
  if (!received || !equalSecrets(received, expected)) {
    throw new MonoHttpError(401, "Mono 平台接口未授权");
  }
}

/**
 * Resolve the signed-in employee and active workspace for Workbench requests.
 * Explicit local development keeps the existing zero-setup experience, but all
 * other deployments must present a server-side session.
 */
export function workspaceActorFromWorkbenchRequest(
  request: Request,
): WorkspaceActor {
  try {
    const actor = currentWorkspaceActor(request);
    requirePermission(
      actor,
      request.method === "GET" || request.method === "HEAD"
        ? "workspace:read"
        : "workspace:write",
    );
    return actor;
  } catch (error) {
    if (error instanceof TenantAccessError) {
      throw new MonoHttpError(error.status, error.message);
    }
    throw error;
  }
}

export function monoActorFromWorkspaceActor(actor: WorkspaceActor): MonoActor {
  return monoActorSchema.parse({
    userId: actor.userId,
    workspaceId: actor.workspaceId,
    traceId: `trace_${randomUUID()}`,
  });
}

export function actorFromWorkbenchRequest(request: Request): MonoActor {
  return monoActorFromWorkspaceActor(workspaceActorFromWorkbenchRequest(request));
}

export function actorFromRequest(request: Request): MonoActor {
  try {
    const actor = ensureServiceWorkspaceActor({
      userId: process.env.MONO_PLATFORM_USER_ID ?? "mono-platform",
      workspaceId: process.env.MONO_PLATFORM_WORKSPACE_ID ?? "default",
      displayName: "Mono 平台服务",
    });
    return monoActorSchema.parse({
      userId: actor.userId,
      workspaceId: actor.workspaceId,
      sessionId: request.headers.get("x-mono-session-id") ?? undefined,
      traceId: request.headers.get("x-mono-trace-id") ?? `trace_${randomUUID()}`,
    });
  } catch (error) {
    if (error instanceof TenantAccessError) {
      throw new MonoHttpError(error.status, error.message);
    }
    throw error;
  }
}

export async function parseMonoJson<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new MonoHttpError(400, "请求体必须是 JSON");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new MonoHttpError(400, parsed.error.issues.map((issue) => issue.message).join("；"));
  }
  return parsed.data;
}

export class MonoHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function monoErrorResponse(error: unknown): Response {
  if (error instanceof MonoHttpError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof ZodError) {
    return Response.json({ error: error.issues.map((issue) => issue.message).join("；") }, { status: 400 });
  }
  console.error("[mono] API request failed", error);
  return Response.json({ error: "Mono 服务暂时不可用" }, { status: 500 });
}
