import { NextResponse } from "next/server";
import {
  currentWorkspaceActor,
  deleteAdminAccount,
  listAdminAccounts,
  resetAccountPassword,
  setAccountStatus,
  tenantErrorResponse,
  upsertAdminAccount,
} from "@/lib/server/tenant";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = currentWorkspaceActor(request);
    const query = new URL(request.url).searchParams.get("q") ?? "";
    return NextResponse.json({ accounts: listAdminAccounts(actor, query) });
  } catch (error) {
    return tenantErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = currentWorkspaceActor(request);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.action !== "string") return NextResponse.json({ error: "action is required" }, { status: 400 });
    if (body.action === "upsert") {
      if (typeof body.account !== "string" || typeof body.displayName !== "string") {
        return NextResponse.json({ error: "account and displayName are required" }, { status: 400 });
      }
      const workspaceRoleIds = body.workspaceRoleIds && typeof body.workspaceRoleIds === "object" && !Array.isArray(body.workspaceRoleIds)
        ? Object.fromEntries(Object.entries(body.workspaceRoleIds as Record<string, unknown>).map(([workspaceId, ids]) => [
          workspaceId,
          Array.isArray(ids) && ids.every((id) => typeof id === "string") ? ids : [],
        ]))
        : undefined;
      const account = upsertAdminAccount(actor, {
        id: typeof body.id === "string" ? body.id : undefined,
        account: body.account,
        displayName: body.displayName,
        department: typeof body.department === "string" ? body.department : undefined,
        status: body.status === "active" || body.status === "disabled" ? body.status : undefined,
        organizationRoleIds: Array.isArray(body.organizationRoleIds) && body.organizationRoleIds.every((id) => typeof id === "string") ? body.organizationRoleIds : undefined,
        workspaceRoleIds,
      });
      return NextResponse.json({ account }, { status: body.id ? 200 : 201 });
    }
    if (body.action === "status" && typeof body.userId === "string" && (body.status === "active" || body.status === "disabled")) {
      setAccountStatus(actor, body.userId, body.status);
      return NextResponse.json({ ok: true });
    }
    if (body.action === "reset-password" && typeof body.userId === "string") {
      resetAccountPassword(actor, body.userId);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "invalid account action" }, { status: 400 });
  } catch (error) {
    return tenantErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    deleteAdminAccount(currentWorkspaceActor(request), id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return tenantErrorResponse(error);
  }
}
