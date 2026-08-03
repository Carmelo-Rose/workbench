import { actorFromWorkbenchRequest, monoErrorResponse } from "@/lib/mono/http";
import { getVideoGenerationCapabilities } from "@/lib/mono/video-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Live provider capability document; clients must not infer support from model names. */
export async function GET(request: Request) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    return Response.json({
      workspaceId: actor.workspaceId,
      capabilities: getVideoGenerationCapabilities(actor.workspaceId),
    });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
