import { actorFromRequest, assertMonoApiAccess, MonoHttpError, monoErrorResponse } from "@/lib/mono/http";
import { cancelJob, getJob } from "@/lib/mono/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  try {
    assertMonoApiAccess(request);
    const actor = actorFromRequest(request);
    const { id } = await context.params;
    const job = getJob(actor, id);
    if (!job) throw new MonoHttpError(404, "Mono 任务不存在");
    return Response.json({ job });
  } catch (error) {
    return monoErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    assertMonoApiAccess(request);
    const actor = actorFromRequest(request);
    const { id } = await context.params;
    const job = cancelJob(actor, id);
    if (!job) throw new MonoHttpError(404, "Mono 任务不存在");
    return Response.json({ job });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
