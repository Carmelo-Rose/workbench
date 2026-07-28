import { actorFromWorkbenchRequest, monoErrorResponse, parseMonoJson } from "@/lib/mono/http";
import {
  castingForWorkspace,
  createCasting,
  createCastingSchema,
} from "@/experiments/product-set-model-consistency/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return Response.json({ error: "Missing casting id" }, { status: 400 });
    return Response.json({ casting: await castingForWorkspace(actor.workspaceId, id) });
  } catch (error) {
    return monoErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    const input = await parseMonoJson(request, createCastingSchema);
    return Response.json({ casting: await createCasting(actor.workspaceId, input) }, { status: 201 });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
