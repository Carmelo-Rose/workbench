import { currentWorkspaceActor, listPermissionAudit, tenantErrorResponse } from "@/lib/server/tenant";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const limit = Number(new URL(request.url).searchParams.get("limit")) || 100;
    return Response.json({ audit: listPermissionAudit(currentWorkspaceActor(request), limit) });
  } catch (error) {
    return tenantErrorResponse(error);
  }
}
