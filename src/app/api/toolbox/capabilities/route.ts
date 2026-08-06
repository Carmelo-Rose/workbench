import { NextResponse } from "next/server";
import { gatewayBase, gatewayHeaders } from "@/lib/toolbox/gateway";
import {
  monoErrorResponse,
  workspaceActorFromWorkbenchRequest,
} from "@/lib/mono/http";
import { hasGrant } from "@/lib/server/tenant";
import type { Permission } from "@/lib/authorization";

export const dynamic = "force-dynamic";

/** 能力清单代理：哪些能力已就绪、哪些是留口子的 planned 状态，由网关端 capabilities.json 决定。 */
export async function GET(req: Request) {
  let actor: ReturnType<typeof workspaceActorFromWorkbenchRequest>;
  try {
    actor = workspaceActorFromWorkbenchRequest(req);
  } catch (error) {
    return monoErrorResponse(error);
  }
  let upstream: Response;
  try {
    upstream = await fetch(`${gatewayBase()}/capabilities`, {
      headers: gatewayHeaders(actor),
      cache: "no-store",
    });
  } catch {
    return NextResponse.json(
      { error: "视频工具箱网关连接失败" },
      { status: 502 },
    );
  }
  const body = await upstream.text();
  if (upstream.ok) {
    try {
      const payload = JSON.parse(body) as { capabilities?: { id?: string }[] };
      const permissionByCapability: Record<string, Permission> = {
        product_cutout: "image.cutout.use",
        smart_erase: "video.erase.use",
        video_enhance: "video.enhance.use",
        matting: "video.cutout.use",
      };
      payload.capabilities = (payload.capabilities ?? []).filter((capability) => {
        const permission = capability.id ? permissionByCapability[capability.id] : undefined;
        return !!permission && hasGrant(actor, permission);
      });
      return NextResponse.json(payload, { status: upstream.status });
    } catch { /* preserve non-JSON upstream errors below */ }
  }
  return new NextResponse(body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    },
  });
}
