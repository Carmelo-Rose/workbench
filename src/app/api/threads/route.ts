import { NextResponse } from "next/server";
import {
  deleteAllThreads,
  ensureThread,
  listThreads,
  ThreadScopeError,
} from "@/lib/server/thread-store";
import { actorFromWorkbenchRequest, monoErrorResponse } from "@/lib/mono/http";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown): Response {
  if (error instanceof ThreadScopeError) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }
  return monoErrorResponse(error);
}

/** 线程列表；lastMessageAt 以 epoch ms 返回，客户端转 Date。 */
export async function GET(req: Request) {
  try {
    const actor = actorFromWorkbenchRequest(req);
    return NextResponse.json({
      threads: listThreads({ workspaceId: actor.workspaceId, userId: actor.userId }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** initialize：幂等创建，threadId 即 remoteId。 */
export async function POST(req: Request) {
  try {
    const actor = actorFromWorkbenchRequest(req);
    const { threadId } = (await req.json()) as { threadId?: string };
    if (!threadId || typeof threadId !== "string") {
      return NextResponse.json({ error: "threadId is required" }, { status: 400 });
    }
    return NextResponse.json(ensureThread(
      { workspaceId: actor.workspaceId, userId: actor.userId },
      threadId,
    ));
  } catch (error) {
    return errorResponse(error);
  }
}

/** 全部清空（设置页"清除所有会话"）。 */
export async function DELETE(req: Request) {
  try {
    const actor = actorFromWorkbenchRequest(req);
    deleteAllThreads({ workspaceId: actor.workspaceId, userId: actor.userId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
