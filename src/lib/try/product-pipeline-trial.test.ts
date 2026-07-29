import { afterEach, describe, expect, it } from "vitest";
import {
  assertProductPipelineTrialEnabled,
  isProductPipelineTrialEnabled,
  productPipelineTrialContext,
} from "./product-pipeline-trial";

const originalEnabled = process.env.PRODUCT_TRIAL_ENABLED;
const originalSecret = process.env.PRODUCT_TRIAL_SECRET;
const originalWorkspace = process.env.PRODUCT_TRIAL_WORKSPACE_ID;

afterEach(() => {
  if (originalEnabled === undefined) delete process.env.PRODUCT_TRIAL_ENABLED;
  else process.env.PRODUCT_TRIAL_ENABLED = originalEnabled;
  if (originalSecret === undefined) delete process.env.PRODUCT_TRIAL_SECRET;
  else process.env.PRODUCT_TRIAL_SECRET = originalSecret;
  if (originalWorkspace === undefined) delete process.env.PRODUCT_TRIAL_WORKSPACE_ID;
  else process.env.PRODUCT_TRIAL_WORKSPACE_ID = originalWorkspace;
});

describe("product pipeline trial session", () => {
  it("is fail-closed when the temporary preview is disabled", () => {
    process.env.PRODUCT_TRIAL_ENABLED = "false";
    expect(isProductPipelineTrialEnabled()).toBe(false);
    expect(() => assertProductPipelineTrialEnabled()).toThrow("体验页已关闭");
  });

  it("keeps a browser session stable and rejects a tampered cookie", () => {
    process.env.PRODUCT_TRIAL_ENABLED = "true";
    process.env.PRODUCT_TRIAL_SECRET = "trial-test-secret";
    process.env.PRODUCT_TRIAL_WORKSPACE_ID = "preview";

    const first = productPipelineTrialContext(new Request("http://localhost/api/try/product-pipeline/folders"));
    const resumed = productPipelineTrialContext(new Request("http://localhost/api/try/product-pipeline/folders", {
      headers: { cookie: `wb_product_pipeline_trial=${first.cookieValue}` },
    }));
    const tamperedCookie = `${first.cookieValue[0] === "x" ? "y" : "x"}${first.cookieValue.slice(1)}`;
    const tampered = productPipelineTrialContext(new Request("http://localhost/api/try/product-pipeline/folders", {
      headers: { cookie: `wb_product_pipeline_trial=${tamperedCookie}` },
    }));

    expect(first.actor.workspaceId).toBe("preview");
    expect(resumed.actor.userId).toBe(first.actor.userId);
    expect(tampered.actor.userId).not.toBe(first.actor.userId);
  });
});
