import { NextResponse } from "next/server";
import {
  changePassword,
  currentWorkspaceActor,
  tenantErrorResponse,
} from "@/lib/server/tenant";

export const dynamic = "force-dynamic";

/** Changes an employee password and invalidates every existing session. */
export async function POST(request: Request) {
  try {
    const actor = currentWorkspaceActor(request);
    const body = await request.json().catch(() => null) as {
      currentPassword?: unknown;
      newPassword?: unknown;
    } | null;
    if (!body || typeof body.currentPassword !== "string" || typeof body.newPassword !== "string") {
      return NextResponse.json({ error: "currentPassword and newPassword are required" }, { status: 400 });
    }
    changePassword(actor, { currentPassword: body.currentPassword, newPassword: body.newPassword });
    return NextResponse.json({ ok: true, reauthenticate: true });
  } catch (error) {
    return tenantErrorResponse(error);
  }
}
