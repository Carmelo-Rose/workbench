import { actorFromWorkbenchRequest, monoErrorResponse, parseMonoJson } from "@/lib/mono/http";
import {
  createProfiles,
  createProfilesSchema,
} from "@/experiments/product-set-model-consistency/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    const input = await parseMonoJson(request, createProfilesSchema);
    return Response.json({ profiles: await createProfiles(actor.workspaceId, input) }, { status: 201 });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
