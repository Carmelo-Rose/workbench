import { NextResponse } from "next/server";
import { GatewayError, cancelJob } from "@/lib/toolbox/gateway";
import {
  monoErrorResponse,
  workspaceActorFromWorkbenchRequest,
} from "@/lib/mono/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ jobId: string }> };

/** 任务取消代理：卡片在排队/运行中点「取消」时调用。 */
export async function POST(req: Request, { params }: Params) {
  let actor: ReturnType<typeof workspaceActorFromWorkbenchRequest>;
  try {
    actor = workspaceActorFromWorkbenchRequest(req);
  } catch (error) {
    return monoErrorResponse(error);
  }
  const { jobId } = await params;
  try {
    return NextResponse.json(await cancelJob(jobId, actor));
  } catch (error) {
    const message =
      error instanceof GatewayError ? error.message : "取消失败";
    const status =
      error instanceof GatewayError && error.status === 404 ? 404 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
