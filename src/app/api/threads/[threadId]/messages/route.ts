import { NextResponse } from "next/server";
import {
  appendEntry,
  deleteEntries,
  loadRepo,
  updateEntry,
  type StoredEntry,
} from "@/lib/server/thread-store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ threadId: string }> };

function isEntry(value: unknown): value is StoredEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    (v.parent_id === null || typeof v.parent_id === "string") &&
    typeof v.format === "string" &&
    "content" in v
  );
}

/** GET ?format=ai-sdk/v6 → { headId, entries }（按插入序）。 */
export async function GET(req: Request, { params }: Params) {
  const { threadId } = await params;
  const format = new URL(req.url).searchParams.get("format");
  if (!format) {
    return NextResponse.json({ error: "format is required" }, { status: 400 });
  }
  return NextResponse.json(loadRepo(threadId, format));
}

/** append：upsert 单条并把 head 指向它。 */
export async function POST(req: Request, { params }: Params) {
  const { threadId } = await params;
  const { entry } = (await req.json()) as { entry?: unknown };
  if (!isEntry(entry)) {
    return NextResponse.json({ error: "invalid entry" }, { status: 400 });
  }
  appendEntry(threadId, entry);
  return NextResponse.json({ ok: true });
}

/** update：按旧 matchId 匹配后改写到新 id（重新生成消息时触发）。 */
export async function PATCH(req: Request, { params }: Params) {
  const { threadId } = await params;
  const { entry, matchId } = (await req.json()) as {
    entry?: unknown;
    matchId?: string;
  };
  if (!isEntry(entry)) {
    return NextResponse.json({ error: "invalid entry" }, { status: 400 });
  }
  updateEntry(threadId, entry, matchId);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, { params }: Params) {
  const { threadId } = await params;
  const { ids } = (await req.json()) as { ids?: unknown };
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    return NextResponse.json({ error: "invalid ids" }, { status: 400 });
  }
  deleteEntries(threadId, ids as string[]);
  return NextResponse.json({ ok: true });
}
