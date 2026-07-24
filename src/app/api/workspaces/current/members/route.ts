import { NextResponse } from "next/server";
import {
  addWorkspaceMember,
  currentWorkspaceActor,
  listWorkspaceMembers,
  TenantAccessError,
  workspaceRoles,
  type WorkspaceRole,
} from "@/lib/server/tenant";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown): Response {
  if (error instanceof TenantAccessError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error("[workspaces] member request failed", error);
  return NextResponse.json({ error: "Workspace member service is unavailable" }, { status: 500 });
}

export async function GET(req: Request) {
  try {
    const actor = currentWorkspaceActor(req);
    return NextResponse.json({ members: listWorkspaceMembers(actor) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Add an employee to the active workspace. The initial password is returned only once. */
export async function POST(req: Request) {
  try {
    const actor = currentWorkspaceActor(req);
    const body = (await req.json()) as {
      email?: unknown;
      displayName?: unknown;
      role?: unknown;
      temporaryPassword?: unknown;
    };
    if (typeof body.email !== "string" || typeof body.displayName !== "string") {
      return NextResponse.json({ error: "email and displayName are required" }, { status: 400 });
    }
    if (body.role !== undefined && (typeof body.role !== "string" || !workspaceRoles.includes(body.role as WorkspaceRole))) {
      return NextResponse.json({ error: "invalid role" }, { status: 400 });
    }
    if (body.temporaryPassword !== undefined && typeof body.temporaryPassword !== "string") {
      return NextResponse.json({ error: "temporaryPassword must be a string" }, { status: 400 });
    }
    const result = addWorkspaceMember(actor, {
      email: body.email,
      displayName: body.displayName,
      role: body.role as WorkspaceRole | undefined,
      temporaryPassword: body.temporaryPassword,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
