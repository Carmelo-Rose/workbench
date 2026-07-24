import { NextResponse } from "next/server";
import {
  appendEntry,
  deleteEntries,
  loadRepo,
  ThreadScopeError,
  updateEntry,
  type StoredEntry,
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
  try {
    const actor = actorFromWorkbenchRequest(req);
    const { threadId } = await params;
    const format = new URL(req.url).searchParams.get("format");
    if (!format) {
      return NextResponse.json({ error: "format is required" }, { status: 400 });
    }
    return NextResponse.json(loadRepo(
      { workspaceId: actor.workspaceId, userId: actor.userId },
      threadId,
      format,
    ));
  } catch (error) {
    return errorResponse(error);
  }
}

/** append：upsert 单条并把 head 指向它。 */
export async function POST(req: Request, { params }: Params) {
  try {
    const actor = actorFromWorkbenchRequest(req);
    const { threadId } = await params;
    const { entry } = (await req.json()) as { entry?: unknown };
    if (!isEntry(entry)) {
      return NextResponse.json({ error: "invalid entry" }, { status: 400 });
    }
    appendEntry({ workspaceId: actor.workspaceId, userId: actor.userId }, threadId, entry);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

/** update：按旧 matchId 匹配后改写到新 id（重新生成消息时触发）。 */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const actor = actorFromWorkbenchRequest(req);
    const { threadId } = await params;
    const { entry, matchId } = (await req.json()) as {
      entry?: unknown;
      matchId?: string;
    };
    if (!isEntry(entry)) {
      return NextResponse.json({ error: "invalid entry" }, { status: 400 });
    }
    updateEntry(
      { workspaceId: actor.workspaceId, userId: actor.userId },
      threadId,
      entry,
      matchId,
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(req: Request, { params }: Params) {
  try {
    const actor = actorFromWorkbenchRequest(req);
    const { threadId } = await params;
    const { ids } = (await req.json()) as { ids?: unknown };
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      return NextResponse.json({ error: "invalid ids" }, { status: 400 });
    }
    deleteEntries(
      { workspaceId: actor.workspaceId, userId: actor.userId },
      threadId,
      ids as string[],
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
