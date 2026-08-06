import { NextResponse, type NextRequest } from "next/server";
import { GatewayError, getJobLog } from "@/lib/toolbox/gateway";
import {
  monoErrorResponse,
  workspaceActorFromWorkbenchRequest,
} from "@/lib/mono/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ jobId: string }> };

/** 任务日志代理：卡片失败态展开「查看日志」时拉取尾部日志。 */
export async function GET(req: NextRequest, { params }: Params) {
  let actor: ReturnType<typeof workspaceActorFromWorkbenchRequest>;
  try {
    actor = workspaceActorFromWorkbenchRequest(req, "resources.tasks.view");
  } catch (error) {
    return monoErrorResponse(error);
  }
  const { jobId } = await params;
  const tail = Number(req.nextUrl.searchParams.get("tail")) || 8000;
  try {
    const log = await getJobLog(jobId, tail, actor);
    return new NextResponse(log, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  } catch (error) {
    const message =
      error instanceof GatewayError ? error.message : "日志读取失败";
    const status =
      error instanceof GatewayError && error.status === 404 ? 404 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
