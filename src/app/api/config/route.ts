import { NextResponse } from "next/server";
import {
  API_CONFIG_GROUPS,
  getAllConfigForDisplay,
  setConfigValues,
  type ApiConfigKey,
} from "@/lib/server/api-config";
import {
  currentWorkspaceActor,
  requirePermission,
  tenantErrorResponse,
} from "@/lib/server/tenant";
import { runWithTenantContext } from "@/lib/server/tenant-context";

export async function GET(req: Request) {
  try {
    const actor = currentWorkspaceActor(req);
    requirePermission(actor, "config:manage");
    return runWithTenantContext(actor, () =>
      NextResponse.json({ groups: getAllConfigForDisplay(actor.workspaceId) }),
    );
  } catch (error) {
    return tenantErrorResponse(error);
  }
}

const ALL_KEYS = new Set<string>(
  Object.values(API_CONFIG_GROUPS).flatMap((g) => g.keys as readonly string[]),
);

export async function POST(req: Request) {
  try {
    const actor = currentWorkspaceActor(req);
    requirePermission(actor, "config:manage");
    return await runWithTenantContext(actor, async () => {
      const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || typeof body !== "object") {
        return NextResponse.json({ error: "无效请求体" }, { status: 400 });
      }
      const values: Partial<Record<ApiConfigKey, string>> = {};
      for (const [key, value] of Object.entries(body)) {
        if (!ALL_KEYS.has(key)) continue;
        if (typeof value !== "string") continue;
        values[key as ApiConfigKey] = value;
      }
      setConfigValues(values, actor.workspaceId);
      return NextResponse.json({
        groups: getAllConfigForDisplay(actor.workspaceId),
      });
    });
  } catch (error) {
    return tenantErrorResponse(error);
  }
}
