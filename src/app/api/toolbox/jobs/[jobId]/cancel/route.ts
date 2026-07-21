import { NextResponse } from "next/server";
import { GatewayError, cancelJob } from "@/lib/toolbox/gateway";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ jobId: string }> };

/** 任务取消代理：卡片在排队/运行中点「取消」时调用。 */
export async function POST(_req: Request, { params }: Params) {
  const { jobId } = await params;
  try {
    return NextResponse.json(await cancelJob(jobId));
  } catch (error) {
    const message =
      error instanceof GatewayError ? error.message : "取消失败";
    const status =
      error instanceof GatewayError && error.status === 404 ? 404 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
