import { afterEach, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { monoImageGenerationSchema, monoSubjectInputSchema } from "./contracts";
import { assertMonoApiAccess } from "./http";
import { MONO_IMAGE2_TEMPLATES, getMonoImage2Template } from "./image2-templates";
import { getCurrentImage2ChatConfig, useImage2Mode } from "@/lib/image2-mode";

beforeAll(() => {
  setEnv("WORKBENCH_DB_PATH", path.join(os.tmpdir(), `workbench-image2-suite-${crypto.randomUUID()}.db`));
});

describe("Image2 template catalog", () => {
  it("migrates all six plugin templates with unique ids", () => {
    expect(MONO_IMAGE2_TEMPLATES).toHaveLength(6);
    expect(new Set(MONO_IMAGE2_TEMPLATES.map((template) => template.id)).size).toBe(6);
    expect(getMonoImage2Template("tpl-replace-product")?.structuredMode).toBe("replace-product");
    expect(getMonoImage2Template("tpl-ref-gen")?.structuredMode).toBe("reference-generate");
  });

  it("keeps ordinary template references and structured templates separate", () => {
    const ordinary = MONO_IMAGE2_TEMPLATES.filter((template) => !template.structuredMode);
    const structured = MONO_IMAGE2_TEMPLATES.filter((template) => template.structuredMode);
    expect(ordinary.every((template) => template.referenceImageUrl)).toBe(true);
    expect(structured.every((template) => !template.referenceImageUrl && template.model === "gpt-image-2")).toBe(true);
  });
});

describe("Image2 generation contract", () => {
  it.each([1, 2, 4, 6] as const)("accepts %i variants", (variants) => {
    expect(monoImageGenerationSchema.parse({ prompt: "test", variants }).variants).toBe(variants);
  });

  it("accepts six references and rejects a seventh", () => {
    const six = Array.from({ length: 6 }, (_, index) => `https://example.com/${index}.png`);
    expect(monoImageGenerationSchema.safeParse({ prompt: "test", referenceImageUrls: six }).success).toBe(true);
    expect(monoImageGenerationSchema.safeParse({ prompt: "test", referenceImageUrls: [...six, "https://example.com/7.png"] }).success).toBe(false);
  });

  it("supports structured product and scene asset roles", () => {
    const parsed = monoImageGenerationSchema.parse({
      prompt: "replace product",
      templateId: "tpl-replace-product",
      structuredReferences: { productAssetId: "asset_product", sceneAssetId: "asset_scene" },
    });
    expect(parsed.structuredReferences).toEqual({ productAssetId: "asset_product", sceneAssetId: "asset_scene" });
  });

  it("validates subject names and ordered subject ids", () => {
    expect(monoSubjectInputSchema.safeParse({ name: "白色陶瓷杯", assetId: "asset_1" }).success).toBe(true);
    expect(monoSubjectInputSchema.safeParse({ name: "坏[名称]", assetId: "asset_1" }).success).toBe(false);
    expect(monoImageGenerationSchema.parse({ prompt: "test", subjectIds: ["subject_b", "subject_a"] }).subjectIds)
      .toEqual(["subject_b", "subject_a"]);
  });

  it("reads structured subject slots at submit time", () => {
    const mode = useImage2Mode.getState();
    mode.reset();
    mode.selectTemplate("tpl-ref-gen");
    mode.setStructuredSubject(0, "subject-product");
    mode.setStructuredSubject(1, "subject-wearer");

    expect(getCurrentImage2ChatConfig()).toMatchObject({
      active: true,
      templateId: "tpl-ref-gen",
      structuredSubjectIds: ["subject-product", "subject-wearer"],
    });

    mode.reset();
  });

  it("opens the model-management tab only from the unstructured subject library", () => {
    const mode = useImage2Mode.getState();
    mode.reset();

    mode.openSubjectLibrary(undefined, "models");
    expect(useImage2Mode.getState()).toMatchObject({
      subjectLibraryOpen: true,
      subjectLibrarySlot: undefined,
      subjectLibraryTab: "models",
    });

    mode.openSubjectLibrary(0, "pairs");
    expect(useImage2Mode.getState()).toMatchObject({
      subjectLibraryOpen: true,
      subjectLibrarySlot: 0,
      subjectLibraryTab: "subjects",
    });
    mode.reset();
  });
});

describe("Mono subject library", () => {
  it("keeps private subjects private and workspace subjects shareable", async () => {
    setEnv("NODE_ENV", "test");
    setEnv("MONO_LOCAL_DEVELOPMENT", "true");
    const { createMonoAsset, createMonoSubject, getMonoSubject, listMonoSubjects, updateMonoSubject, deleteMonoSubject } = await import("./store");
    const owner = { userId: "owner", workspaceId: "subject-workspace", traceId: "owner-trace" };
    const teammate = { userId: "teammate", workspaceId: "subject-workspace", traceId: "team-trace" };
    const outsider = { userId: "owner", workspaceId: "other-workspace", traceId: "other-trace" };
    const asset = createMonoAsset(owner, { sourceUrl: "data:image/png;base64,AA==", mimeType: "image/png" });
    const subject = createMonoSubject(owner, { name: "产品 A", assetId: asset.id, visibility: "private" })!;

    expect(getMonoSubject(teammate, subject.id)).toBeNull();
    expect(listMonoSubjects(outsider)).toHaveLength(0);
    const shared = updateMonoSubject(owner, subject.id, { visibility: "workspace" })!;
    expect(getMonoSubject(teammate, shared.id)?.name).toBe("产品 A");
    expect(updateMonoSubject(teammate, shared.id, { name: "越权修改" })).toBeNull();
    expect(deleteMonoSubject(teammate, shared.id)).toBe(false);
    expect(deleteMonoSubject(owner, shared.id)).toBe(true);
    expect(getMonoSubject(owner, shared.id)).toBeNull();
  });

  it("compiles subject directives and freezes the subject snapshot at submission", async () => {
    const { createAsset, createImageGenerationJob, createSubject, newMonoActor, updateSubject, deleteSubject } = await import("./service");
    const actor = newMonoActor({ userId: "compiler", workspaceId: "compiler-workspace" });
    const asset = createAsset(actor, { sourceUrl: "https://example.com/person.png", mimeType: "image/png" });
    const subject = createSubject(actor, { name: "模特 A", assetId: asset.id, visibility: "private" });
    const job = createImageGenerationJob(actor, monoImageGenerationSchema.parse({
      prompt: `让 :subject[模特 A]{name=${subject.id}} 戴上黑色帽子`,
      subjectIds: [subject.id],
    }));
    expect(job.input.compiledPrompt).toContain("参考图1（模特 A）");
    expect(job.input.compiledPrompt).toContain("佩戴到");
    expect(job.input.referenceImageUrls).toEqual(["https://example.com/person.png"]);
    expect(job.input.subjectSnapshots).toMatchObject([{ id: subject.id, name: "模特 A" }]);

    updateSubject(actor, subject.id, { name: "改名后" });
    deleteSubject(actor, subject.id);
    expect(job.input.compiledPrompt).toContain("模特 A");
    expect(job.input.compiledPrompt).not.toContain("改名后");
  });

  it("rejects a combined attachment and subject reference count above six", async () => {
    const { createAsset, createImageGenerationJob, createSubject, newMonoActor } = await import("./service");
    const actor = newMonoActor({ userId: "limit", workspaceId: "limit-workspace" });
    const asset = createAsset(actor, { sourceUrl: "https://example.com/subject.png", mimeType: "image/png" });
    const subject = createSubject(actor, { name: "上限主体", assetId: asset.id, visibility: "private" });
    const references = Array.from({ length: 6 }, (_, index) => `https://example.com/ref-${index}.png`);
    expect(() => createImageGenerationJob(actor, monoImageGenerationSchema.parse({
      prompt: `:subject[上限主体]{name=${subject.id}}`,
      subjectIds: [subject.id],
      referenceImageUrls: references,
    }))).toThrow("最多允许 6 张");
  });

  it("preserves both positional slots when a structured template uses the same asset twice", async () => {
    const { createAsset, createImageGenerationJob, newMonoActor } = await import("./service");
    const actor = newMonoActor({ userId: "slots", workspaceId: "slot-workspace" });
    const asset = createAsset(actor, { sourceUrl: "https://example.com/shared-slot.png", mimeType: "image/png" });
    const job = createImageGenerationJob(actor, monoImageGenerationSchema.parse({
      prompt: "same asset in two roles",
      templateId: "tpl-replace-product",
      structuredReferences: { productAssetId: asset.id, sceneAssetId: asset.id },
    }));
    expect(job.input.referenceImageUrls).toEqual([
      "https://example.com/shared-slot.png",
      "https://example.com/shared-slot.png",
    ]);
  });
});

describe("Mono platform authentication", () => {
  const originalKey = process.env.MONO_PLATFORM_API_KEY;
  const originalLocal = process.env.MONO_LOCAL_DEVELOPMENT;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    setEnv("MONO_PLATFORM_API_KEY", originalKey);
    setEnv("MONO_LOCAL_DEVELOPMENT", originalLocal);
    setEnv("NODE_ENV", originalNodeEnv);
  });

  it("fails closed without a platform key", () => {
    delete process.env.MONO_PLATFORM_API_KEY;
    delete process.env.MONO_LOCAL_DEVELOPMENT;
    expect(() => assertMonoApiAccess(new Request("http://localhost/api/mono/jobs/x"))).toThrow("尚未配置访问凭证");
  });

  it("allows explicitly enabled non-production local development", () => {
    delete process.env.MONO_PLATFORM_API_KEY;
    process.env.MONO_LOCAL_DEVELOPMENT = "true";
    setEnv("NODE_ENV", "test");
    expect(() => assertMonoApiAccess(new Request("http://localhost/api/mono/jobs/x"))).not.toThrow();
  });
});

describe("Workbench Image2 route", () => {
  it("creates, lists, updates, previews, and deletes subjects through the browser bridge", async () => {
    setEnv("NODE_ENV", "test");
    setEnv("MONO_LOCAL_DEVELOPMENT", "true");
    const { POST: createAsset } = await import("@/app/api/workbench/mono/assets/route");
    const { GET: listSubjects, POST: createSubject } = await import("@/app/api/workbench/mono/subjects/route");
    const subjectRoute = await import("@/app/api/workbench/mono/subjects/[id]/route");
    const { GET: previewAsset } = await import("@/app/api/workbench/mono/assets/[id]/content/route");
    const headers = { "Content-Type": "application/json", Origin: "http://localhost" };

    const assetResponse = await createAsset(new Request("http://localhost/api/workbench/mono/assets", {
      method: "POST",
      headers,
      body: JSON.stringify({ sourceUrl: "data:image/png;base64,AA==", mimeType: "image/png", name: "subject-api" }),
    }));
    const { asset } = await assetResponse.json() as { asset: { id: string } };
    const created = await createSubject(new Request("http://localhost/api/workbench/mono/subjects", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "API 主体", assetId: asset.id }),
    }));
    const { subject } = await created.json() as { subject: { id: string; editable: boolean; previewUrl: string } };
    expect(created.status).toBe(201);
    expect(subject.editable).toBe(true);
    expect(subject.previewUrl).toContain(asset.id);

    const listed = await listSubjects(new Request("http://localhost/api/workbench/mono/subjects", { headers }));
    expect((await listed.json() as { subjects: { id: string }[] }).subjects.map((item) => item.id)).toContain(subject.id);
    const patched = await subjectRoute.PATCH(new Request(`http://localhost/api/workbench/mono/subjects/${subject.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "更新后的主体", visibility: "workspace" }),
    }), { params: Promise.resolve({ id: subject.id }) });
    expect((await patched.json() as { subject: { name: string; visibility: string } }).subject)
      .toMatchObject({ name: "更新后的主体", visibility: "workspace" });

    const preview = await previewAsset(new Request(`http://localhost/api/workbench/mono/assets/${asset.id}/content`, { headers }), {
      params: Promise.resolve({ id: asset.id }),
    });
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("image/png");

    const deleted = await subjectRoute.DELETE(new Request(`http://localhost/api/workbench/mono/subjects/${subject.id}`, {
      method: "DELETE",
      headers,
    }), { params: Promise.resolve({ id: subject.id }) });
    expect(deleted.status).toBe(204);
    // Deleting a subject intentionally retains the underlying asset.
    const retainedAsset = await previewAsset(new Request(`http://localhost/api/workbench/mono/assets/${asset.id}/content`, { headers }), {
      params: Promise.resolve({ id: asset.id }),
    });
    expect(retainedAsset.status).toBe(200);
  });

  it("submits one idempotent batch job through the trusted local bridge", async () => {
    setEnv("NODE_ENV", "test");
    setEnv("MONO_LOCAL_DEVELOPMENT", "true");
    setEnv("WORKBENCH_DB_PATH", path.join(os.tmpdir(), `workbench-image2-${crypto.randomUUID()}.db`));
    const { POST } = await import("@/app/api/workbench/mono/generate/image/route");
    const body = {
      prompt: "route integration test",
      aspectRatio: "3:4",
      variants: 2,
      idempotencyKey: "route-integration-idempotency",
    };
    const request = () => new Request("http://localhost/api/workbench/mono/generate/image", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify(body),
    });
    const first = await POST(request());
    const second = await POST(request());
    const firstPayload = await first.json() as { job: { id: string; input: Record<string, unknown> } };
    const secondPayload = await second.json() as { job: { id: string } };
    expect(first.status).toBe(202);
    expect(firstPayload.job.input).toMatchObject({ aspectRatio: "3:4", variants: 2 });
    expect(secondPayload.job.id).toBe(firstPayload.job.id);

    const { getMonoJob } = await import("./store");
    expect(getMonoJob({ userId: "other", workspaceId: "other", traceId: "trace_other" }, firstPayload.job.id)).toBeNull();
  });

  it("creates an Image2 tool message through /api/chat without following the selected backend", async () => {
    setEnv("NODE_ENV", "test");
    setEnv("MONO_LOCAL_DEVELOPMENT", "true");
    const { POST } = await import("@/app/api/chat/route");
    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "thread_image2_chat",
        config: {
          modelName: "hermes",
          image2: {
            active: true,
            templateId: "tpl-replace-product",
            aspectRatio: "3:4",
            variants: 2,
          },
        },
        messages: [{
          id: "user_image2_chat",
          role: "user",
          parts: [
            { type: "text", text: "把产品放进这个场景" },
            { type: "file", mediaType: "image/png", filename: "product.png", url: "data:image/png;base64,AA==" },
            { type: "file", mediaType: "image/png", filename: "scene.png", url: "data:image/png;base64,AQ==" },
          ],
        }],
      }),
    }));
    const streamText = await response.text();
    expect(response.status).toBe(200);
    expect(streamText).toContain("mono_generate_image");
    expect(streamText).toContain("tool-output-available");
    expect(streamText).toContain("thread_image2_chat");
    expect(streamText).toContain('"mode":"image2"');
  });

  it("lists, favorites, and lightens Image2 history through the browser bridge", async () => {
    setEnv("NODE_ENV", "test");
    setEnv("MONO_LOCAL_DEVELOPMENT", "true");
    setEnv("WORKBENCH_DB_PATH", path.join(os.tmpdir(), `workbench-image2-history-${crypto.randomUUID()}.db`));
    const { POST } = await import("@/app/api/workbench/mono/generate/image/route");
    const { GET: listJobs } = await import("@/app/api/workbench/mono/jobs/route");
    const { PATCH } = await import("@/app/api/workbench/mono/jobs/[id]/route");

    const created = await POST(new Request("http://localhost/api/workbench/mono/generate/image", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify({
        prompt: "history test",
        referenceImageUrls: ["data:image/png;base64,AA=="],
        aspectRatio: "1:1",
        variants: 1,
      }),
    }));
    const { job } = await created.json() as { job: { id: string } };

    const patched = await PATCH(
      new Request(`http://localhost/api/workbench/mono/jobs/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Origin: "http://localhost" },
        body: JSON.stringify({ favorite: true }),
      }),
      { params: Promise.resolve({ id: job.id }) },
    );
    expect(patched.status).toBe(200);

    const listed = await listJobs(new Request("http://localhost/api/workbench/mono/jobs?favorite=1", {
      headers: { Origin: "http://localhost" },
    }));
    const payload = await listed.json() as { jobs: { id: string; favorite: boolean; input: Record<string, unknown> }[] };
    expect(listed.status).toBe(200);
    expect(payload.jobs.map((item) => item.id)).toContain(job.id);
    const entry = payload.jobs.find((item) => item.id === job.id)!;
    expect(entry.favorite).toBe(true);
    // 列表接口必须剥离 data URL 参考图，只保留数量。
    expect(entry.input.referenceImageUrls).toBeUndefined();
    expect(entry.input.referenceImageCount).toBe(1);

    const unfavorited = await PATCH(
      new Request(`http://localhost/api/workbench/mono/jobs/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Origin: "http://localhost" },
        body: JSON.stringify({ favorite: false }),
      }),
      { params: Promise.resolve({ id: job.id }) },
    );
    expect(unfavorited.status).toBe(200);
    const relisted = await listJobs(new Request("http://localhost/api/workbench/mono/jobs?favorite=1", {
      headers: { Origin: "http://localhost" },
    }));
    const relistedPayload = await relisted.json() as { jobs: { id: string }[] };
    expect(relistedPayload.jobs.map((item) => item.id)).not.toContain(job.id);
  });

  it("purges one terminal history entry and clears only terminal unfavorite entries", async () => {
    setEnv("NODE_ENV", "test");
    setEnv("MONO_LOCAL_DEVELOPMENT", "true");
    const actor = { userId: "local-user", workspaceId: "default", traceId: "purge-test" };
    const { claimMonoJob, completeMonoJob, createMonoJob, getMonoJob, setMonoJobFavorite } = await import("./store");
    const jobA = createMonoJob(actor, "image_generation", { prompt: "purge A" });
    const jobB = createMonoJob(actor, "image_generation", { prompt: "keep favorite" });
    const jobC = createMonoJob(actor, "image_generation", { prompt: "purge C" });
    for (const job of [jobA, jobB, jobC]) {
      claimMonoJob(job.id);
      completeMonoJob(job.id, { slots: [] });
    }
    setMonoJobFavorite(actor, jobB.id, true);

    const jobRoute = await import("@/app/api/workbench/mono/jobs/[id]/route");
    const jobsRoute = await import("@/app/api/workbench/mono/jobs/route");
    const headers = { Origin: "http://localhost" };
    const single = await jobRoute.DELETE(
      new Request(`http://localhost/api/workbench/mono/jobs/${jobA.id}?purge=true`, { method: "DELETE", headers }),
      { params: Promise.resolve({ id: jobA.id }) },
    );
    expect(single.status).toBe(204);
    expect(getMonoJob(actor, jobA.id)).toBeNull();

    const cleared = await jobsRoute.DELETE(new Request("http://localhost/api/workbench/mono/jobs", { method: "DELETE", headers }));
    expect((await cleared.json() as { deleted: number }).deleted).toBeGreaterThanOrEqual(1);
    expect(getMonoJob(actor, jobB.id)?.favorite).toBe(true);
    expect(getMonoJob(actor, jobC.id)).toBeNull();
  });
});

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
