import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildShadowAngleAssignments,
  composeTemplateShadowMain,
  isTemplateShadowV2Enabled,
  prepareTemplateShadowForeground,
  removeWhiteFieldForegroundSpill,
  selectShadowVariant,
  validateProductShadowBundle,
  type LoadedProductShadowBundle,
  type LoadedShadowVariant,
  type ProductGeometry,
  type ProductShadowManifest,
} from "./product-main-shadow";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const geometry: ProductGeometry = {
  box: { left: 0.2, top: 0.2, width: 0.6, height: 0.6 },
  contactAnchor: { x: 0.5, y: 0.8 },
};

function variant(id: string, reference: ProductGeometry, order = 0): LoadedShadowVariant {
  return {
    id,
    angle: "front",
    file: `${id}.png`,
    order,
    sha256: "a".repeat(64),
    source: { relativePath: `${id}.jpg`, sha256: "b".repeat(64) },
    reference,
    image: Buffer.alloc(0),
  };
}

describe("template shadow rollout and angle contract", () => {
  it("keeps V2 fail-closed behind its server-only switch", () => {
    expect(isTemplateShadowV2Enabled({})).toBe(false);
    expect(isTemplateShadowV2Enabled({ PRODUCT_MAIN_V2_ENABLED: "false" })).toBe(false);
    expect(isTemplateShadowV2Enabled({ PRODUCT_MAIN_V2_ENABLED: "true" })).toBe(true);
  });

  it("maps an ordered six-frame colour group and leaves ordinal one on V1", () => {
    const members = Array.from({ length: 6 }, (_, index) => ({ path: `C:/masters/329A${8208 + index}.jpg` }));
    const assignments = buildShadowAngleAssignments([{ members }]);
    expect(assignments.get(members[0].path)).toMatchObject({ ordinal: 1, fallbackReason: expect.stringContaining("暂无") });
    expect(members.slice(1).map((member) => assignments.get(member.path)?.angle))
      .toEqual(["oblique-left", "front", "top-down", "side", "rear"]);
  });

  it("falls back for the whole group when count or numeric order is unsafe", () => {
    const short = Array.from({ length: 5 }, (_, index) => ({ path: `C:/masters/${index + 1}.jpg` }));
    const duplicate = Array.from({ length: 6 }, (_, index) => ({ path: `C:/other/${index === 5 ? 5 : index + 1}.jpg` }));
    const assignments = buildShadowAngleAssignments([{ members: short }, { members: duplicate }]);
    expect(short.every((member) => assignments.get(member.path)?.fallbackReason?.includes("不是标准六角度"))).toBe(true);
    expect(duplicate.every((member) => assignments.get(member.path)?.fallbackReason?.includes("顺序"))).toBe(true);
  });

  it("selects the nearest same-angle geometry deterministically", () => {
    const exact = variant("front-b", geometry, 1);
    const offset = variant("front-a", {
      box: { ...geometry.box, left: 0.05 },
      contactAnchor: { x: 0.35, y: 0.8 },
    });
    const bundle = {
      root: "C:/bundle",
      schemaVersion: 1,
      version: "hat-shadow-v1",
      canvas: { width: 800, height: 800 },
      variants: [offset, exact],
    } satisfies LoadedProductShadowBundle;
    expect(selectShadowVariant(bundle, "front", geometry)?.id).toBe("front-b");
    expect(selectShadowVariant(bundle, "rear", geometry)).toBeUndefined();
  });
});

describe("template shadow bundle and compositor", () => {
  it("hash-verifies an immutable 800×800 RGBA bundle", async () => {
    const root = path.join(os.tmpdir(), `shadow-bundle-${crypto.randomUUID()}`);
    temporaryRoots.push(root);
    await mkdir(root, { recursive: true });
    const image = await sharp({
      create: { width: 800, height: 800, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.2 } },
    }).png().toBuffer();
    const manifest: ProductShadowManifest = {
      schemaVersion: 1,
      version: "hat-shadow-v1",
      canvas: { width: 800, height: 800 },
      variants: [{
        id: "front-a",
        angle: "front",
        file: "front-a.png",
        order: 0,
        sha256: hash(image),
        source: { relativePath: "前/sample.jpg", sha256: "c".repeat(64) },
        reference: geometry,
      }],
    };
    await Promise.all([
      writeFile(path.join(root, "front-a.png"), image),
      writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest)),
    ]);
    await expect(validateProductShadowBundle(root, "hat-shadow-v1"))
      .resolves.toMatchObject({ version: "hat-shadow-v1", variants: [{ id: "front-a" }] });

    await writeFile(path.join(root, "front-a.png"), Buffer.from("tampered"));
    await expect(validateProductShadowBundle(root, "hat-shadow-v1")).rejects.toThrow("哈希不匹配");
  });

  it("keeps product pixels intact while placing shadow on pure white", async () => {
    const productSource = await sharp({
      create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).composite([{
      input: await sharp({ create: { width: 40, height: 60, channels: 4, background: { r: 210, g: 20, b: 30, alpha: 1 } } }).png().toBuffer(),
      left: 30,
      top: 20,
    }]).png().toBuffer();
    const product = await prepareTemplateShadowForeground(
      productSource,
      { left: 0.3, top: 0.2, width: 0.4, height: 0.6 },
    );
    const shadow = await sharp({
      create: { width: 800, height: 800, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).composite([{
      input: await sharp({ create: { width: 600, height: 30, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer(),
      left: 100,
      top: 765,
    }]).png().toBuffer();
    const selected = { ...variant("front-a", product.geometry), image: shadow };
    const output = await composeTemplateShadowMain(product, selected);
    await expect(sharp(output).metadata()).resolves.toMatchObject({ width: 800, height: 800 });

    const [productCore, outputCore, shadowPixel, backgroundPixel] = await Promise.all([
      sharp(product.image).extract({ left: 400, top: 400, width: 1, height: 1 }).removeAlpha().raw().toBuffer(),
      sharp(output).extract({ left: 400, top: 400, width: 1, height: 1 }).raw().toBuffer(),
      sharp(output).extract({ left: 400, top: 775, width: 1, height: 1 }).raw().toBuffer(),
      sharp(output).extract({ left: 10, top: 10, width: 1, height: 1 }).raw().toBuffer(),
    ]);
    expect([...outputCore]).toEqual([...productCore]);
    expect(shadowPixel[0]).toBeLessThan(255);
    expect([...backgroundPixel]).toEqual([255, 255, 255]);
  });

  it("removes edge-connected white matte spill but preserves enclosed light details", async () => {
    const width = 20;
    const height = 16;
    const pixels = Buffer.alloc(width * height * 4, 0);
    const paint = (
      left: number,
      top: number,
      right: number,
      bottom: number,
      rgba: [number, number, number, number],
    ): void => {
      for (let y = top; y <= bottom; y += 1) {
        for (let x = left; x <= right; x += 1) {
          pixels.set(rgba, (y * width + x) * 4);
        }
      }
    };
    paint(0, 10, 12, 14, [255, 255, 255, 255]);
    paint(5, 3, 16, 12, [20, 20, 20, 255]);
    paint(10, 7, 10, 7, [255, 255, 255, 255]);
    const input = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();

    const cleaned = await removeWhiteFieldForegroundSpill(input);
    const { data } = await sharp(cleaned.foreground).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(data[(12 * width + 1) * 4 + 3]).toBe(0);
    expect(data[(7 * width + 10) * 4 + 3]).toBe(255);
    expect(data[(7 * width + 7) * 4 + 3]).toBe(255);
    expect(cleaned.removedPixels).toBeGreaterThan(0);
  });

  it("removes a large enclosed white plate left by a second cutout", async () => {
    const width = 96;
    const height = 96;
    const pixels = Buffer.alloc(width * height * 4, 0);
    for (let y = 8; y < 88; y += 1) {
      for (let x = 8; x < 88; x += 1) pixels.set([24, 24, 24, 255], (y * width + x) * 4);
    }
    for (let y = 24; y < 72; y += 1) {
      for (let x = 24; x < 72; x += 1) pixels.set([255, 255, 255, 255], (y * width + x) * 4);
    }
    const input = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const cleaned = await removeWhiteFieldForegroundSpill(input);
    const { data } = await sharp(cleaned.foreground).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(data[(48 * width + 48) * 4 + 3]).toBe(0);
    expect(data[(12 * width + 12) * 4 + 3]).toBe(255);
    expect(cleaned.removedPixels).toBeGreaterThanOrEqual(48 * 48);
  });
});
