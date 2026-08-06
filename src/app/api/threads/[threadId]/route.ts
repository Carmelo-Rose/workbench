import { NextResponse } from "next/server";
import {
  deleteThread,
  getThread,
  ThreadScopeError,
  updateThread,
} from "@/lib/server/thread-store";
import { actorFromWorkbenchRequest, monoErrorResponse } from "@/lib/mono/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ threadId: string }> };

function errorResponse(error: unknown): Response {
  if (error instanceof ThreadScopeError) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }
  return monoErrorResponse(error);
}

export async function GET(req: Request, { params }: Params) {
  try {
    const actor = actorFromWorkbenchRequest(req, "sessions.messages.view");
    const { threadId } = await params;
    const thread = getThread({ workspaceId: actor.workspaceId, userId: actor.userId }, threadId);
    if (!thread) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }
    return NextResponse.json(thread);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(req: Request, { params }: Params) {
  try {
    const actor = actorFromWorkbenchRequest(req, "sessions.messages.manage");
    const { threadId } = await params;
    const body = (await req.json()) as {
      title?: string;
      status?: "regular" | "archived";
      custom?: Record<string, unknown> | null;
    };
    if (body.status !== undefined && !["regular", "archived"].includes(body.status)) {
      return NextResponse.json({ error: "invalid status" }, { status: 400 });
    }
    const found = updateThread({ workspaceId: actor.workspaceId, userId: actor.userId }, threadId, body);
    if (!found) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(req: Request, { params }: Params) {
  try {
    const actor = actorFromWorkbenchRequest(req, "sessions.messages.manage");
    const { threadId } = await params;
    deleteThread({ workspaceId: actor.workspaceId, userId: actor.userId }, threadId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
