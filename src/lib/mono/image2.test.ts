import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { monoImageGenerationSchema } from "./contracts";
import { assertMonoApiAccess } from "./http";
import { MONO_IMAGE2_TEMPLATES, getMonoImage2Template } from "./image2-templates";

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
});

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
