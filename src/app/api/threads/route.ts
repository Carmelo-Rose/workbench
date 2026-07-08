import { NextResponse } from "next/server";
import {
  deleteAllThreads,
  ensureThread,
  listThreads,
} from "@/lib/server/thread-store";

export const dynamic = "force-dynamic";

/** 线程列表；lastMessageAt 以 epoch ms 返回，客户端转 Date。 */
export async function GET() {
  return NextResponse.json({ threads: listThreads() });
}

/** initialize：幂等创建，threadId 即 remoteId。 */
export async function POST(req: Request) {
  const { threadId } = (await req.json()) as { threadId?: string };
  if (!threadId || typeof threadId !== "string") {
    return NextResponse.json({ error: "threadId is required" }, { status: 400 });
  }
  return NextResponse.json(ensureThread(threadId));
}

/** 全部清空（设置页"清除所有会话"）。 */
export async function DELETE() {
  deleteAllThreads();
  return NextResponse.json({ ok: true });
}
