import { actorFromWorkbenchRequest, MonoHttpError, monoErrorResponse } from "@/lib/mono/http";
import { monoJobKinds, type MonoJobKind } from "@/lib/mono/contracts";
import { lightenMonoJob, listJobs, purgeUnfavoriteJobs } from "@/lib/mono/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Browser-only job history. Heavy reference data URLs are stripped per item. */
export async function GET(request: Request) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    const url = new URL(request.url);
    const kindsParam = url.searchParams.get("kinds");
    const kinds = kindsParam
      ? kindsParam
          .split(",")
          .map((value) => value.trim())
          .filter((value): value is MonoJobKind => (monoJobKinds as readonly string[]).includes(value))
      : undefined;
    const kindParam = url.searchParams.get("kind");
    const kind = (monoJobKinds as readonly string[]).includes(kindParam ?? "")
      ? (kindParam as MonoJobKind)
      : "image_generation";
    const jobs = listJobs(actor, {
      ...(kinds?.length ? { kinds } : { kind }),
      favoriteOnly: url.searchParams.get("favorite") === "1",
      limit: Number(url.searchParams.get("limit")) || undefined,
    });
    return Response.json({ jobs: jobs.map(lightenMonoJob) });
  } catch (error) {
    return monoErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    const kindParam = new URL(request.url).searchParams.get("kind") ?? "image_generation";
    if (!(monoJobKinds as readonly string[]).includes(kindParam)) {
      throw new MonoHttpError(400, "任务类型无效");
    }
    const deleted = await purgeUnfavoriteJobs(actor, kindParam as MonoJobKind);
    return Response.json({ deleted });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
