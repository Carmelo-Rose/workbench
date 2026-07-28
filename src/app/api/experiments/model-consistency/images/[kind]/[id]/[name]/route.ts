import { readFile } from "node:fs/promises";
import path from "node:path";
import { actorFromWorkbenchRequest, monoErrorResponse } from "@/lib/mono/http";
import {
  castingForWorkspace,
  profileForWorkspace,
  runForWorkspace,
} from "@/experiments/product-set-model-consistency/service";
import { experimentFile } from "@/experiments/product-set-model-consistency/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const contentTypes: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export async function GET(
  request: Request,
  context: { params: Promise<{ kind: string; id: string; name: string }> },
) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    const { kind, id, name } = await context.params;
    if (kind === "casting") await castingForWorkspace(actor.workspaceId, id);
    else if (kind === "profile") await profileForWorkspace(actor.workspaceId, id);
    else if (kind === "run") await runForWorkspace(actor.workspaceId, id);
    else return Response.json({ error: "Unknown image kind" }, { status: 404 });

    const file = await experimentFile(kind, id, name);
    const extension = path.extname(file).toLowerCase();
    const contentType = contentTypes[extension];
    if (!contentType) return Response.json({ error: "Unsupported image type" }, { status: 415 });
    return new Response(await readFile(file), {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=60",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
