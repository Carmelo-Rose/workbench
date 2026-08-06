import { NextResponse } from "next/server";
import { searchThreads } from "@/lib/server/thread-store";
import { actorFromWorkbenchRequest, monoErrorResponse } from "@/lib/mono/http";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** GET ?q=&limit= → 标题 + 正文全文检索命中列表。 */
export async function GET(req: Request) {
  try {
    const actor = actorFromWorkbenchRequest(req, "sessions.messages.view");
    const url = new URL(req.url);
    const q = url.searchParams.get("q") ?? "";
    const limitParam = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(limitParam, MAX_LIMIT)
      : DEFAULT_LIMIT;
    return NextResponse.json({
      results: searchThreads({ workspaceId: actor.workspaceId, userId: actor.userId }, q, limit),
    });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
