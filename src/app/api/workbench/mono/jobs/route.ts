import { actorFromWorkbenchRequest, monoErrorResponse } from "@/lib/mono/http";
import { monoJobKinds, type MonoJobKind } from "@/lib/mono/contracts";
import { lightenMonoJob, listJobs } from "@/lib/mono/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Browser-only job history. Heavy reference data URLs are stripped per item. */
export async function GET(request: Request) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    const url = new URL(request.url);
    const kindParam = url.searchParams.get("kind");
    const kind = (monoJobKinds as readonly string[]).includes(kindParam ?? "")
      ? (kindParam as MonoJobKind)
      : "image_generation";
    const jobs = listJobs(actor, {
      kind,
      favoriteOnly: url.searchParams.get("favorite") === "1",
      limit: Number(url.searchParams.get("limit")) || undefined,
    });
    return Response.json({ jobs: jobs.map(lightenMonoJob) });
  } catch (error) {
    return monoErrorResponse(error);
  }
}
