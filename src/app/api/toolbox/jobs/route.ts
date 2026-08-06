import { NextResponse, type NextRequest } from "next/server";
import { GatewayError, submitJob } from "@/lib/toolbox/gateway";
import {
  monoErrorResponse,
  workspaceActorFromWorkbenchRequest,
} from "@/lib/mono/http";
import { requireGrant, tenantErrorResponse } from "@/lib/server/tenant";
import type { Permission } from "@/lib/authorization";

export const dynamic = "force-dynamic";

/** 任务提交代理：JobToolUI 卡片在用户完成框选后从浏览器直接提交。 */
export async function POST(req: NextRequest) {
  let actor: ReturnType<typeof workspaceActorFromWorkbenchRequest>;
  try {
    actor = workspaceActorFromWorkbenchRequest(req);
  } catch (error) {
    return monoErrorResponse(error);
  }
  const body = (await req.json().catch(() => null)) as {
    capability?: string;
    params?: Record<string, unknown>;
    inputs?: Record<string, string>;
  } | null;

  if (!body?.capability) {
    return NextResponse.json({ error: "缺少 capability" }, { status: 400 });
  }

  const permissionByCapability: Record<string, Permission> = {
    erase: "video.erase.use",
    enhance: "video.enhance.use",
    matting: "video.cutout.use",
    smart_erase: "video.erase.use",
    video_enhance: "video.enhance.use",
    product_cutout: "image.cutout.use",
    "video-erase": "video.erase.use",
    "video-enhance": "video.enhance.use",
    "video-matting": "video.cutout.use",
  };
  const permission = permissionByCapability[body.capability];
  if (!permission) return NextResponse.json({ error: "未知工具能力" }, { status: 400 });
  try {
    requireGrant(actor, permission);
  } catch (error) {
    return tenantErrorResponse(error);
  }

  try {
    const job = await submitJob({
      capability: body.capability,
      params: body.params ?? {},
      inputs: body.inputs ?? {},
    }, actor);
    return NextResponse.json(job);
  } catch (error) {
    if (error instanceof GatewayError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status === 400 ? 400 : 502 },
      );
    }
    return NextResponse.json({ error: "任务提交失败" }, { status: 502 });
  }
}
