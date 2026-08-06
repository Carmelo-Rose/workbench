import { NextResponse } from "next/server";
import { GatewayError, getJob } from "@/lib/toolbox/gateway";
import {
  monoErrorResponse,
  workspaceActorFromWorkbenchRequest,
} from "@/lib/mono/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ jobId: string }> };

/** 任务状态查询代理：JobToolUI 卡片轮询用。 */
export async function GET(req: Request, { params }: Params) {
  let actor: ReturnType<typeof workspaceActorFromWorkbenchRequest>;
  try {
    actor = workspaceActorFromWorkbenchRequest(req, "resources.tasks.view");
  } catch (error) {
    return monoErrorResponse(error);
  }
  const { jobId } = await params;
  try {
    const job = await getJob(jobId, actor);
    if (!job) {
      return NextResponse.json({ error: "job not found" }, { status: 404 });
    }
    return NextResponse.json(job);
  } catch (error) {
    const message =
      error instanceof GatewayError ? error.message : "网关查询失败";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
