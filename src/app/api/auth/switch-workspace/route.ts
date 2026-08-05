import { NextResponse } from "next/server";
import {
  currentWorkspace,
  currentWorkspaceActor,
  logout,
  sessionCookie,
  switchWorkspace,
  TenantAccessError,
  workspaceSummaries,
} from "@/lib/server/tenant";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown): Response {
  if (error instanceof TenantAccessError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error("[auth] workspace switch failed", error);
  return NextResponse.json({ error: "Workspace switch failed" }, { status: 500 });
}

export async function POST(req: Request) {
  try {
    const actor = currentWorkspaceActor(req);
    const body = (await req.json()) as { workspaceId?: unknown };
    if (typeof body.workspaceId !== "string" || !body.workspaceId) {
      return NextResponse.json({ error: "workspaceId is required" }, { status: 400 });
    }
    const session = switchWorkspace(actor, body.workspaceId);
    logout(req);
    const response = NextResponse.json({
      actor: {
        userId: session.actor.userId,
        account: session.actor.account,
        email: session.actor.email,
        displayName: session.actor.displayName,
        department: session.actor.department,
        role: session.actor.role,
        organizationId: session.actor.organizationId,
        workspaceId: session.actor.workspaceId,
        organizationRoles: session.actor.organizationRoles,
        workspaceRoles: session.actor.workspaceRoles,
        permissions: session.actor.permissions,
      },
      workspace: currentWorkspace(session.actor),
      workspaces: workspaceSummaries(session.actor.userId),
    });
    response.headers.set("Set-Cookie", sessionCookie(session.token));
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
