import { NextResponse } from "next/server";
import {
  importSnapshot,
  type ThreadSnapshot,
} from "@/lib/server/thread-store";
import { actorFromWorkbenchRequest, monoErrorResponse } from "@/lib/mono/http";

/** localStorage → SQLite 一次性迁移；已存在的线程/消息跳过。 */
export async function POST(req: Request) {
  try {
    const actor = actorFromWorkbenchRequest(req, "sessions.messages.import");
    const { snapshots } = (await req.json()) as { snapshots?: ThreadSnapshot[] };
    if (!Array.isArray(snapshots)) {
      return NextResponse.json({ error: "invalid snapshots" }, { status: 400 });
    }
    return NextResponse.json(importSnapshot(
      { workspaceId: actor.workspaceId, userId: actor.userId },
      snapshots,
    ));
  } catch (error) {
    return monoErrorResponse(error);
  }
}
