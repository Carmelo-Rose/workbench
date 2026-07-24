import { NextResponse, type NextRequest } from "next/server";
import { gatewayBase, gatewayHeaders } from "@/lib/toolbox/gateway";
import {
  monoErrorResponse,
  workspaceActorFromWorkbenchRequest,
} from "@/lib/mono/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ jobId: string; path: string[] }> };

/** 透传给浏览器的响应头；Range 相关头保证 <video> 可拖动进度条。 */
const PASSTHROUGH_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "content-disposition",
];

/** 任务产物代理：流式转发网关文件（视频预览 + 下载共用）。 */
export async function GET(req: NextRequest, { params }: Params) {
  let actor: ReturnType<typeof workspaceActorFromWorkbenchRequest>;
  try {
    actor = workspaceActorFromWorkbenchRequest(req);
  } catch (error) {
    return monoErrorResponse(error);
  }
  const { jobId, path } = await params;
  const artifactPath = path.map(encodeURIComponent).join("/");

  const headers: Record<string, string> = { ...gatewayHeaders(actor) };
  const range = req.headers.get("range");
  if (range) headers["range"] = range;

  let upstream: Response;
  try {
    upstream = await fetch(
      `${gatewayBase()}/jobs/${encodeURIComponent(jobId)}/artifacts/${artifactPath}`,
      { headers, cache: "no-store" },
    );
  } catch {
    return NextResponse.json(
      { error: "视频工具箱网关连接失败" },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers();
  for (const key of PASSTHROUGH_HEADERS) {
    const value = upstream.headers.get(key);
    if (value) responseHeaders.set(key, value);
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
