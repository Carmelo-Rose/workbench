import { NextResponse } from "next/server";
import {
  importSnapshot,
  type ThreadSnapshot,
} from "@/lib/server/thread-store";

/** localStorage → SQLite 一次性迁移；已存在的线程/消息跳过。 */
export async function POST(req: Request) {
  const { snapshots } = (await req.json()) as { snapshots?: ThreadSnapshot[] };
  if (!Array.isArray(snapshots)) {
    return NextResponse.json({ error: "invalid snapshots" }, { status: 400 });
  }
  return NextResponse.json(importSnapshot(snapshots));
}
