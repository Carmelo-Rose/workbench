import { NextResponse } from "next/server";
import { permissionRegistry } from "@/lib/authorization";
import {
  createAdminRole,
  currentWorkspaceActor,
  deleteAdminRole,
  listAdminRoles,
  tenantErrorResponse,
  updateAdminRole,
} from "@/lib/server/tenant";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    return NextResponse.json({ catalog: permissionRegistry, roles: listAdminRoles(currentWorkspaceActor(request)) });
  } catch (error) {
    return tenantErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = currentWorkspaceActor(request);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const grantsValid = Array.isArray(body?.grants) && body.grants.every((item) => item && typeof item === "object" && typeof (item as { permission?: unknown }).permission === "string");
    const permissionsValid = Array.isArray(body?.permissions) && body.permissions.every((item) => typeof item === "string");
    if (!body || (body.scope !== "organization" && body.scope !== "workspace") || typeof body.name !== "string" || (!grantsValid && !permissionsValid)) {
      return NextResponse.json({ error: "scope, name and grants are required" }, { status: 400 });
    }
    const role = createAdminRole(actor, {
      scope: body.scope,
      name: body.name,
      ...(grantsValid ? { grants: body.grants as { permission: string; dataScope?: unknown }[] } : { permissions: body.permissions as string[] }),
      copyFromId: typeof body.copyFromId === "string" ? body.copyFromId : undefined,
    });
    return NextResponse.json({ role }, { status: 201 });
  } catch (error) {
    return tenantErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = currentWorkspaceActor(request);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const grantsValid = Array.isArray(body?.grants) && body.grants.every((item) => item && typeof item === "object" && typeof (item as { permission?: unknown }).permission === "string");
    const permissionsValid = Array.isArray(body?.permissions) && body.permissions.every((item) => typeof item === "string");
    if (!body || typeof body.id !== "string" || typeof body.name !== "string" || (!grantsValid && !permissionsValid)) {
      return NextResponse.json({ error: "id, name and grants are required" }, { status: 400 });
    }
    return NextResponse.json({ role: updateAdminRole(actor, body.id, grantsValid
      ? { name: body.name, grants: body.grants as { permission: string; dataScope?: unknown }[] }
      : { name: body.name, permissions: body.permissions as string[] }) });
  } catch (error) {
    return tenantErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const actor = currentWorkspaceActor(request);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    deleteAdminRole(actor, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return tenantErrorResponse(error);
  }
}
