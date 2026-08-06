import { NextResponse } from "next/server";
import {
  createWorkspace,
  currentWorkspace,
  currentWorkspaceActor,
  TenantAccessError,
  workspaceSummaries,
} from "@/lib/server/tenant";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown): Response {
  if (error instanceof TenantAccessError) {
    return NextResponse.json({ error: error.message, ...(error.status === 403 ? { code: "PERMISSION_DENIED", ...(error.permission ? { permission: error.permission } : {}) } : {}) }, { status: error.status });
  }
  console.error("[workspaces] request failed", error);
  return NextResponse.json({ error: "Workspace service is unavailable" }, { status: 500 });
}

export async function GET(req: Request) {
  try {
    const actor = currentWorkspaceActor(req);
    return NextResponse.json({
      current: currentWorkspace(actor),
      workspaces: workspaceSummaries(actor.userId),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Owner/admin creates another isolated workspace; it is not auto-selected. */
export async function POST(req: Request) {
  try {
    const actor = currentWorkspaceActor(req);
    const body = (await req.json()) as { name?: unknown };
    if (typeof body.name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    return NextResponse.json({ workspace: createWorkspace(actor, { name: body.name }) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
