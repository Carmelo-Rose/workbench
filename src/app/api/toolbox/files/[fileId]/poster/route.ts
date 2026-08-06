import { NextResponse, type NextRequest } from "next/server";
import { gatewayBase, gatewayHeaders } from "@/lib/toolbox/gateway";
import {
  monoErrorResponse,
  workspaceActorFromWorkbenchRequest,
} from "@/lib/mono/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ fileId: string }> };

/** 视频首帧缩略图代理：框选界面的底图。同一文件的首帧不变，允许浏览器缓存。 */
export async function GET(req: NextRequest, { params }: Params) {
  let actor: ReturnType<typeof workspaceActorFromWorkbenchRequest>;
  try {
    actor = workspaceActorFromWorkbenchRequest(req, "resources.tasks.view");
  } catch (error) {
    return monoErrorResponse(error);
  }
  const { fileId } = await params;

  let upstream: Response;
  try {
    upstream = await fetch(
      `${gatewayBase()}/files/${encodeURIComponent(fileId)}/poster`,
      { headers: gatewayHeaders(actor), cache: "no-store" },
    );
  } catch {
    return NextResponse.json(
      { error: "视频工具箱网关连接失败" },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    return NextResponse.json(
      { error: detail.slice(0, 200) || "首帧提取失败" },
      { status: upstream.status },
    );
  }

  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "image/jpeg",
      "cache-control": "private, max-age=3600",
    },
  });
}
