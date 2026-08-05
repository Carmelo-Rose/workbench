import { NextResponse } from "next/server";
import {
  assignWorkspaceRoles,
  createWorkspace,
  currentWorkspaceActor,
  listAdminWorkspaces,
  tenantErrorResponse,
} from "@/lib/server/tenant";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    return NextResponse.json({ workspaces: listAdminWorkspaces(currentWorkspaceActor(request)) });
  } catch (error) {
    return tenantErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = currentWorkspaceActor(request);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.action !== "string") return NextResponse.json({ error: "action is required" }, { status: 400 });
    if (body.action === "create" && typeof body.name === "string") {
      return NextResponse.json({ workspace: createWorkspace(actor, { name: body.name }) }, { status: 201 });
    }
    if (body.action === "assign-roles" && typeof body.userId === "string" && typeof body.workspaceId === "string" && Array.isArray(body.roleIds) && body.roleIds.every((id) => typeof id === "string")) {
      assignWorkspaceRoles(actor, { userId: body.userId, workspaceId: body.workspaceId, roleIds: body.roleIds });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "invalid workspace action" }, { status: 400 });
  } catch (error) {
    return tenantErrorResponse(error);
  }
}
