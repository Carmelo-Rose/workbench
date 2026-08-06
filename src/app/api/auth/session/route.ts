import { NextResponse } from "next/server";
import {
  assertSameOrigin,
  clearedSessionCookie,
  currentWorkspace,
  currentWorkspaceActor,
  login,
  logout,
  refreshedSession,
  sessionCookie,
  TenantAccessError,
  workspaceSummaries,
} from "@/lib/server/tenant";

export const dynamic = "force-dynamic";

function actorDto(actor: ReturnType<typeof currentWorkspaceActor>) {
  return {
    userId: actor.userId,
    account: actor.account,
    email: actor.email,
    displayName: actor.displayName,
    department: actor.department,
    role: actor.role,
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    organizationRoles: actor.organizationRoles,
    workspaceRoles: actor.workspaceRoles,
    permissions: actor.permissions,
    grants: actor.grants,
  };
}

function errorResponse(error: unknown): Response {
  if (error instanceof TenantAccessError) {
    return NextResponse.json({ error: error.message, ...(error.status === 403 ? { code: "PERMISSION_DENIED", ...(error.permission ? { permission: error.permission } : {}) } : {}) }, { status: error.status });
  }
  console.error("[auth] session request failed", error);
  return NextResponse.json({ error: "Authentication service is unavailable" }, { status: 500 });
}

/** Returns the signed-in employee and the workspace selected by their session. */
export async function GET(req: Request) {
  try {
    const session = refreshedSession(req);
    const response = NextResponse.json({
      actor: actorDto(session.actor),
      workspace: currentWorkspace(session.actor),
      workspaces: workspaceSummaries(session.actor.userId),
    });
    response.headers.set("Set-Cookie", sessionCookie(session.token));
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

/** Password login. Deployment bootstrap creates the first owner. */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const body = (await req.json()) as {
      account?: unknown;
      /** Legacy deployments may still submit email during their rollout. */
      email?: unknown;
      password?: unknown;
      workspaceId?: unknown;
    };
    if ((typeof body.account !== "string" && typeof body.email !== "string") || typeof body.password !== "string") {
      return NextResponse.json({ error: "account and password are required" }, { status: 400 });
    }
    if (body.workspaceId !== undefined && typeof body.workspaceId !== "string") {
      return NextResponse.json({ error: "workspaceId must be a string" }, { status: 400 });
    }
    const session = login({
      account: typeof body.account === "string" ? body.account : undefined,
      email: typeof body.email === "string" ? body.email : undefined,
      password: body.password,
      workspaceId: body.workspaceId,
      ip: req.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() ?? req.headers.get("x-real-ip") ?? undefined,
    });
    const response = NextResponse.json({
      actor: actorDto(session.actor),
      workspace: currentWorkspace(session.actor),
      workspaces: workspaceSummaries(session.actor.userId),
    });
    response.headers.set("Set-Cookie", sessionCookie(session.token));
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(req: Request) {
  try {
    assertSameOrigin(req);
    logout(req);
    const response = NextResponse.json({ ok: true });
    response.headers.set("Set-Cookie", clearedSessionCookie());
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
