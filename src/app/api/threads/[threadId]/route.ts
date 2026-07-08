import { NextResponse } from "next/server";
import {
  deleteThread,
  getThread,
  updateThread,
} from "@/lib/server/thread-store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ threadId: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { threadId } = await params;
  const thread = getThread(threadId);
  if (!thread) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }
  return NextResponse.json(thread);
}

export async function PATCH(req: Request, { params }: Params) {
  const { threadId } = await params;
  const body = (await req.json()) as {
    title?: string;
    status?: "regular" | "archived";
    custom?: Record<string, unknown> | null;
  };
  if (body.status !== undefined && !["regular", "archived"].includes(body.status)) {
    return NextResponse.json({ error: "invalid status" }, { status: 400 });
  }
  const found = updateThread(threadId, body);
  if (!found) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: Params) {
  const { threadId } = await params;
  deleteThread(threadId);
  return NextResponse.json({ ok: true });
}
