import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { MonoHttpError } from "@/lib/mono/http";
import { getJob, listJobs } from "@/lib/mono/service";
import type { MonoActor, MonoJob } from "@/lib/mono/contracts";

const TRIAL_COOKIE = "wb_product_pipeline_trial";
const TRIAL_COOKIE_MAX_AGE = 24 * 60 * 60;
const processSecret = randomBytes(32);

export type ProductPipelineTrialContext = {
  actor: MonoActor;
  cookieValue: string;
};

export function isProductPipelineTrialEnabled(): boolean {
  return process.env.PRODUCT_TRIAL_ENABLED === "true";
}

export function assertProductPipelineTrialEnabled(): void {
  if (!isProductPipelineTrialEnabled()) {
    throw new MonoHttpError(404, "商品套图体验页已关闭");
  }
}

function secret(): Buffer {
  // A configured secret keeps sessions valid across restarts. The process-local
  // fallback keeps a temporary local preview zero-setup while invalidating all
  // old trial cookies whenever the server restarts.
  return Buffer.from(process.env.PRODUCT_TRIAL_SECRET ?? processSecret.toString("hex"), "utf8");
}

function signSession(nonce: string): string {
  return createHmac("sha256", secret()).update(nonce).digest("base64url");
}

function validSessionCookie(value: string | undefined): string | null {
  if (!value) return null;
  const [nonce, signature] = value.split(".");
  if (!nonce || !signature || !/^[A-Za-z0-9_-]{20,64}$/u.test(nonce)) return null;
  const expected = Buffer.from(signSession(nonce), "base64url");
  const received = Buffer.from(signature, "base64url");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  return nonce;
}

function requestCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

function trialWorkspaceId(): string {
  return process.env.PRODUCT_TRIAL_WORKSPACE_ID
    ?? process.env.MONO_PLATFORM_WORKSPACE_ID
    ?? "default";
}

export function productPipelineTrialContext(request: Request): ProductPipelineTrialContext {
  assertProductPipelineTrialEnabled();
  const existingNonce = validSessionCookie(requestCookie(request, TRIAL_COOKIE));
  const nonce = existingNonce ?? randomBytes(24).toString("base64url");
  return {
    actor: {
      userId: `product-trial:${nonce}`,
      workspaceId: trialWorkspaceId(),
      traceId: `trace_product_trial_${randomUUID()}`,
    },
    cookieValue: `${nonce}.${signSession(nonce)}`,
  };
}

export function withProductPipelineTrialCookie<T>(
  response: NextResponse<T>,
  cookieValue: string,
): NextResponse<T> {
  response.cookies.set({
    name: TRIAL_COOKIE,
    value: cookieValue,
    httpOnly: true,
    maxAge: TRIAL_COOKIE_MAX_AGE,
    sameSite: "lax",
    // The first rollout is explicitly an HTTP LAN URL. Opt into Secure only
    // when the temporary page is placed behind HTTPS; otherwise browsers drop
    // the cookie and every request would look like a new trial session.
    secure: process.env.PRODUCT_TRIAL_SECURE_COOKIE === "true",
    path: "/",
  });
  response.headers.set("cache-control", "no-store");
  response.headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  return response;
}

export function productPipelineTrialJson<T>(
  payload: T,
  context: ProductPipelineTrialContext,
  init?: ResponseInit,
): NextResponse<T> {
  return withProductPipelineTrialCookie(
    NextResponse.json(payload, init),
    context.cookieValue,
  );
}

export function trialProductPipelineJob(actor: MonoActor, jobId: string): MonoJob | null {
  if (!/^job_[A-Za-z0-9_-]{8,120}$/u.test(jobId)) return null;
  const job = getJob(actor, jobId);
  if (!job || job.kind !== "product_pipeline" || job.userId !== actor.userId) return null;
  return job;
}

export function assertTrialJobCapacity(actor: MonoActor): void {
  const activeJob = listJobs(actor, { kind: "product_pipeline", limit: 200 })
    .find((job) => job.userId === actor.userId && (job.status === "queued" || job.status === "running"));
  if (activeJob) {
    throw new MonoHttpError(409, "当前浏览器已有一个商品套图任务正在处理");
  }
}
