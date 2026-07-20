import { NextResponse, type NextRequest } from "next/server";
import { gatewayBase, gatewayHeaders } from "@/lib/toolbox/gateway";

export const dynamic = "force-dynamic";
/** 大视频上传直通网关，禁止任何缓冲层介入。 */
export const maxDuration = 300;

/**
 * 视频上传代理：浏览器把文件字节流原样 POST 过来（文件名放 x-file-name 头，
 * 值经 encodeURIComponent 保证 ASCII 安全），这里流式转发给网关的 /files/raw，
 * 全程不落内存不落盘。
 */
export async function POST(req: NextRequest) {
  if (!req.body) {
    return NextResponse.json({ error: "empty body" }, { status: 400 });
  }

  const rawName = req.headers.get("x-file-name");
  let name = "upload.bin";
  if (rawName) {
    try {
      name = decodeURIComponent(rawName);
    } catch {
      name = rawName;
    }
  }

  // Node fetch 携带流式 body 必须显式声明半双工（duplex 未进 DOM 类型，用交叉类型补齐）。
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: {
      ...gatewayHeaders(),
      "content-type":
        req.headers.get("content-type") ?? "application/octet-stream",
    },
    body: req.body,
    duplex: "half",
  };

  let upstream: Response;
  try {
    upstream = await fetch(
      `${gatewayBase()}/files/raw?name=${encodeURIComponent(name)}`,
      init,
    );
  } catch {
    return NextResponse.json(
      { error: "视频工具箱网关连接失败（服务机可能未启动）" },
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
