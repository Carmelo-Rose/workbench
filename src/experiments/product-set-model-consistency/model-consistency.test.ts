import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProductTemplate } from "@/lib/mono/product-template";
import { MODEL_SLOTS } from "@/lib/mono/product-pipeline";
import { buildConsistencyPrompt, identityGroupForLook } from "./prompts";
import { buildSlotReferences } from "./runner";
import { buildCastingCandidates } from "./service";
import {
  assertExperimentPath,
  ensureExperimentRoot,
  experimentRoot,
  listProducts,
} from "./storage";

let temporaryRoot = "";

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "model-consistency-"));
  process.env.MODEL_CONSISTENCY_TEST_ROOT = temporaryRoot;
  await ensureExperimentRoot();
});

afterEach(async () => {
  delete process.env.MODEL_CONSISTENCY_TEST_ROOT;
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("model consistency experiment", () => {
  it("maps A/C to female and B to male", () => {
    expect(identityGroupForLook("A")).toBe("female");
    expect(identityGroupForLook("B")).toBe("male");
    expect(identityGroupForLook("C")).toBe("female");
  });

  it("creates exactly four candidates for each identity group", () => {
    const candidates = buildCastingCandidates(4);
    expect(candidates).toHaveLength(8);
    expect(candidates.filter((item) => item.groupId === "female")).toHaveLength(4);
    expect(candidates.filter((item) => item.groupId === "male")).toHaveLength(4);
  });

  it("keeps the identity anchor first and exactly three product references after it", () => {
    expect(buildSlotReferences("anchor.jpg", ["front.jpg", "side.jpg", "back.jpg"]))
      .toEqual(["anchor.jpg", "front.jpg", "side.jpg", "back.jpg"]);
    expect(() => buildSlotReferences("anchor.jpg", ["front.jpg"])).toThrow();
  });

  it("includes explicit identity and product reference constraints in the experiment prompt", async () => {
    const template = await loadProductTemplate(
      path.resolve("config/product-pipeline/hat-62604171-v1"),
    );
    const prompt = buildConsistencyPrompt({
      template,
      slot: MODEL_SLOTS[0],
      colorRank: 0,
      identityGroupId: "female",
    });
    expect(prompt).toContain("参考图1");
    expect(prompt).toContain("参考图2");
    expect(prompt).toContain("参考图4");
  });

  it("lists only direct test products with a 主图 folder and blocks traversal", async () => {
    const product = path.join(experimentRoot(), "SKU-001");
    await mkdir(path.join(product, "主图"), { recursive: true });
    await writeFile(path.join(product, "主图", "front.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    await mkdir(path.join(experimentRoot(), "nested", "SKU-ignored", "主图"), { recursive: true });

    const products = await listProducts();
    expect(products.map((item) => item.name)).toEqual(["nested", "SKU-001"]);
    expect(products.find((item) => item.name === "nested")?.ready).toBe(false);
    expect(products.some((item) => item.name === "SKU-ignored")).toBe(false);
    expect(() => assertExperimentPath(path.resolve(experimentRoot(), "..", "outside.jpg"))).toThrow();
  });
});
