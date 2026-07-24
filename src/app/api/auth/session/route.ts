import { NextResponse } from "next/server";
import {
  assertSameOrigin,
  clearedSessionCookie,
  currentWorkspace,
  currentWorkspaceActor,
  login,
  logout,
  sessionCookie,
  TenantAccessError,
  workspaceSummaries,
} from "@/lib/server/tenant";

export const dynamic = "force-dynamic";

function actorDto(actor: ReturnType<typeof currentWorkspaceActor>) {
  return {
    userId: actor.userId,
    email: actor.email,
    displayName: actor.displayName,
    role: actor.role,
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
  };
}

function errorResponse(error: unknown): Response {
  if (error instanceof TenantAccessError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error("[auth] session request failed", error);
  return NextResponse.json({ error: "Authentication service is unavailable" }, { status: 500 });
}

/** Returns the signed-in employee and the workspace selected by their session. */
export async function GET(req: Request) {
  try {
    const actor = currentWorkspaceActor(req);
    return NextResponse.json({
      actor: actorDto(actor),
      workspace: currentWorkspace(actor),
      workspaces: workspaceSummaries(actor.userId),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Password login. Deployment bootstrap creates the first owner. */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const body = (await req.json()) as {
      email?: unknown;
      password?: unknown;
      workspaceId?: unknown;
    };
    if (typeof body.email !== "string" || typeof body.password !== "string") {
      return NextResponse.json({ error: "email and password are required" }, { status: 400 });
    }
    if (body.workspaceId !== undefined && typeof body.workspaceId !== "string") {
      return NextResponse.json({ error: "workspaceId must be a string" }, { status: 400 });
    }
    const session = login({
      email: body.email,
      password: body.password,
      workspaceId: body.workspaceId,
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
