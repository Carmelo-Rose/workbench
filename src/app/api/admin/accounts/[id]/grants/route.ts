import { currentWorkspaceActor, effectiveGrantsForAccount, tenantErrorResponse } from "@/lib/server/tenant";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const workspaceId = new URL(request.url).searchParams.get("workspaceId") ?? undefined;
    return Response.json({ grants: effectiveGrantsForAccount(currentWorkspaceActor(request), id, workspaceId) });
  } catch (error) {
    return tenantErrorResponse(error);
  }
}
