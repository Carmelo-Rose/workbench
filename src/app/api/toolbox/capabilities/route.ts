import { NextResponse } from "next/server";
import { gatewayBase, gatewayHeaders } from "@/lib/toolbox/gateway";

export const dynamic = "force-dynamic";

/** 能力清单代理：哪些能力已就绪、哪些是留口子的 planned 状态，由网关端 capabilities.json 决定。 */
export async function GET() {
  let upstream: Response;
  try {
    upstream = await fetch(`${gatewayBase()}/capabilities`, {
      headers: gatewayHeaders(),
      cache: "no-store",
    });
  } catch {
    return NextResponse.json(
      { error: "视频工具箱网关连接失败" },
      { status: 502 },
    );
  }
  const body = await upstream.text();
  return new NextResponse(body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    },
  });
}
