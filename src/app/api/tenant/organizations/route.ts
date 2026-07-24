import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createOrganization,
  currentWorkspaceActor,
  organizationSummaries,
  requirePermission,
  tenantErrorResponse,
} from "@/lib/server/tenant";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export async function GET(req: Request) {
  try {
    const actor = currentWorkspaceActor(req);
    return NextResponse.json({
      organizations: organizationSummaries(actor.userId),
    });
  } catch (error) {
    return tenantErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const actor = currentWorkspaceActor(req);
    requirePermission(actor, "workspace:manage");
    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "组织信息无效" }, { status: 400 });
    }
    return NextResponse.json(
      { organization: createOrganization(actor, parsed.data) },
      { status: 201 },
    );
  } catch (error) {
    return tenantErrorResponse(error);
  }
}
