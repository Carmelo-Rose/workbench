import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  ADAPTIVE_WHITE_SAMPLE_POLICY,
  applyLevelsChannel,
  assertRunnableMainImageVersion,
  buildCalibratedShadowAssignments,
  calibratedShadowManifestSha256,
  CALIBRATED_SHADOW_MAIN_IMAGE_VERSION,
  composeCalibratedShadowMain,
  DEFAULT_MAIN_IMAGE_VERSION,
  DEFAULT_SHADOW_PRESET_VERSION,
  isCalibratedShadowV2Enabled,
  isHistoricalShadowV2,
  loadCalibratedShadowBundle,
  loadCandidateCalibratedShadowBundle,
  normalizeMainImageVersion,
  parseCalibratedShadowManifest,
  scaleAndClipReferenceRect,
  scaleReferenceCoordinate,
  selectAdaptiveWhiteSample,
  SLOT_4_DEVELOPMENT_IDENTITY,
  validateCalibratedShadowBundle,
  type CalibratedShadowManifest,
  type AdaptiveCalibratedShadowManifest,
  type LegacyCalibratedShadowManifest,
  type LoadedCalibratedShadowBundle,
  type ScopedCalibratedShadowManifest,
} from "./product-main-shadow";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("calibrated shadow rollout and history", () => {
  it("keeps the current V2 opt-in and refuses to reinterpret historical experiments", () => {
    expect(DEFAULT_SHADOW_PRESET_VERSION).toBe("hat-ps-shadow-v2.1");
    expect(isCalibratedShadowV2Enabled({})).toBe(false);
    expect(isCalibratedShadowV2Enabled({ PRODUCT_MAIN_V2_ENABLED: "false" })).toBe(false);
    expect(isCalibratedShadowV2Enabled({ PRODUCT_MAIN_V2_ENABLED: "true" })).toBe(true);
    expect(normalizeMainImageVersion(CALIBRATED_SHADOW_MAIN_IMAGE_VERSION)).toBe(CALIBRATED_SHADOW_MAIN_IMAGE_VERSION);
    expect(normalizeMainImageVersion("refined-shadow-v2")).toBe(DEFAULT_MAIN_IMAGE_VERSION);
    expect(isHistoricalShadowV2("refined-shadow-v2")).toBe(true);
    expect(isHistoricalShadowV2("template-shadow-v2")).toBe(true);
    expect(() => assertRunnableMainImageVersion("refined-shadow-v2")).toThrow(/历史主图实验/u);
  });
});

describe("six-frame assignment", () => {
  const slot2Preset = {
    id: "hat-angle-slot-2",
    angleSlot: 2,
    humanAngleLabel: "左斜视角",
    approved: true as const,
    roi: { x: 0, y: 277, width: 800, height: 569 },
    whitePoint: { x: 11, y: 658 },
  };
  const slot3Preset = {
    id: "hat-angle-slot-3",
    angleSlot: 3,
    humanAngleLabel: "正面",
    approved: true as const,
    roi: { x: 0, y: 330, width: 800, height: 470 },
    whitePoint: { x: 15, y: 578 },
  };

  it("assigns slot 2 and slot 3 independently in every valid colour group", () => {
    const first = Array.from({ length: 6 }, (_, index) => ({ path: `C:/a/329A${8208 + index}.jpg` }));
    const second = Array.from({ length: 6 }, (_, index) => ({ path: `C:/b/329A${8217 + index}.jpg` }));
    const presets = [slot2Preset, slot3Preset];
    const assignments = buildCalibratedShadowAssignments([{ members: first }, { members: second }], presets);
    expect(assignments.get(first[1].path)).toEqual({ angleSlot: 2, presetId: slot2Preset.id });
    expect(assignments.get(first[2].path)).toEqual({ angleSlot: 3, presetId: slot3Preset.id });
    expect(assignments.get(second[1].path)).toEqual({ angleSlot: 2, presetId: slot2Preset.id });
    expect(assignments.get(second[2].path)).toEqual({ angleSlot: 3, presetId: slot3Preset.id });
    expect(assignments.get(first[0].path)).toMatchObject({ angleSlot: 1, fallbackReason: expect.stringContaining("暂无批准") });
    expect(assignments.get(first[5].path)).toMatchObject({ angleSlot: 6, fallbackReason: expect.stringContaining("暂无批准") });
  });

  it("fails closed for missing, gapped, disordered, or duplicate numeric names", () => {
    const short = Array.from({ length: 5 }, (_, index) => ({ path: `C:/short/${index + 1}.png` }));
    const gap = [1, 2, 4, 5, 6, 7].map((number) => ({ path: `C:/gap/${number}.png` }));
    const disorder = [1, 3, 2, 4, 5, 6].map((number) => ({ path: `C:/disorder/${number}.png` }));
    const duplicate = [1, 2, 3, 4, 5, 5].map((number) => ({ path: `C:/duplicate/${number}.png` }));
    const assignments = buildCalibratedShadowAssignments(
      [{ members: short }, { members: gap }, { members: disorder }, { members: duplicate }],
      [slot2Preset, slot3Preset],
    );
    expect(short.every((item) => assignments.get(item.path)?.fallbackReason?.includes("实际 5"))).toBe(true);
    expect(gap.every((item) => assignments.get(item.path)?.fallbackReason?.includes("不连续"))).toBe(true);
    expect(disorder.every((item) => assignments.get(item.path)?.fallbackReason?.includes("乱序"))).toBe(true);
    expect(duplicate.every((item) => assignments.get(item.path)?.fallbackReason?.includes("重复"))).toBe(true);
  });
});

describe("800-reference pixel math", () => {
  it("scales 800/1200/1600 coordinates without changing the preset", () => {
    expect([800, 1200, 1600].map((side) => scaleReferenceCoordinate(277, side))).toEqual([277, 416, 554]);
    expect([800, 1200, 1600].map((side) => scaleReferenceCoordinate(11, side))).toEqual([11, 17, 22]);
    expect([800, 1200, 1600].map((side) => scaleReferenceCoordinate(330, side))).toEqual([330, 495, 660]);
    expect([800, 1200, 1600].map((side) => scaleReferenceCoordinate(578, side))).toEqual([578, 867, 1156]);
  });

  it("clips the approved 569px ROI at the lower canvas edge", () => {
    const roi = { x: 0, y: 277, width: 800, height: 569 };
    expect(scaleAndClipReferenceRect(roi, 800)).toEqual({ x: 0, y: 277, width: 800, height: 523 });
    expect(scaleAndClipReferenceRect(roi, 1200)).toEqual({ x: 0, y: 416, width: 1200, height: 784 });
    expect(scaleAndClipReferenceRect(roi, 1600)).toEqual({ x: 0, y: 554, width: 1600, height: 1046 });
  });

  it("uses the exact positive-value Photoshop Levels rounding formula", () => {
    expect(applyLevelsChannel(0, 233)).toBe(0);
    expect(applyLevelsChannel(100, 233)).toBe(109);
    expect(applyLevelsChannel(232, 233)).toBe(254);
    expect(applyLevelsChannel(233, 233)).toBe(255);
    expect(applyLevelsChannel(255, 233)).toBe(255);
  });
});

function syntheticBundle(): LoadedCalibratedShadowBundle {
  const regressionAssets = ["gold-a", "gold-b"].flatMap((id, index) => [
    { id: `${id}-input`, kind: "input" as const, file: `${id}-input.png`, sha256: String(index + 1).repeat(64) },
    { id: `${id}-product`, kind: "product" as const, file: `${id}-product.png`, sha256: String(index + 2).repeat(64) },
    { id: `${id}-ps-mask`, kind: "mask" as const, file: `${id}-ps-mask.png`, sha256: String(index + 3).repeat(64) },
    { id: `${id}-birefnet-mask`, kind: "mask" as const, file: `${id}-birefnet-mask.png`, sha256: String(index + 4).repeat(64) },
    { id: `${id}-shadow`, kind: "shadow" as const, file: `${id}-shadow.png`, sha256: String(index + 5).repeat(64) },
    { id: `${id}-preview`, kind: "preview" as const, file: `${id}-preview.png`, sha256: String(index + 6).repeat(64) },
  ]);
  return {
    schemaVersion: 1,
    version: DEFAULT_SHADOW_PRESET_VERSION,
    canvas: { width: 800, height: 800 },
    algorithm: { id: "ps-levels-roi-v1", levels: "round(value*255/whitePoint)-clamp-255" },
    biRefNet: {
      modelId: "ZhengPeng7/BiRefNet_HR-matting",
      revision: "5d6b6f8adcb5b417c871b1d84ceaae9871355b7f",
      weightsSha256: "a5a4de698739ea5e0e8bbab28e1b293dde95092b87a442d566cbc585c53cef55",
    },
    gates: { whitePointMin: 220, whitePointMax: 245, whitePointMaxChannelSpread: 8, productBoxTolerance: 0.05 },
    goldStandards: [
      { id: "gold-a", psdPath: "C:/gold-a.psd", psdSha256: "a".repeat(64), layerNames: { product: "product", shadow: "shadow", background: "white" }, productBox: { left: 0.05, top: 0.125, width: 0.9, height: 0.75 } },
      { id: "gold-b", psdPath: "C:/gold-b.psd", psdSha256: "b".repeat(64), layerNames: { product: "product", shadow: "shadow", background: "white" }, productBox: { left: 0.05, top: 0.125, width: 0.9, height: 0.75 } },
    ],
    presets: [{ id: "hat-angle-slot-2", angleSlot: 2, humanAngleLabel: "左斜视角", approved: true, roi: { x: 0, y: 277, width: 800, height: 569 }, whitePoint: { x: 11, y: 658 } }],
    regressionAssets,
    root: "C:/fixture",
    manifestSha256: "d".repeat(64),
  };
}

function syntheticScopedBundle(): LoadedCalibratedShadowBundle & ScopedCalibratedShadowManifest {
  const regressionAssets = ["slot2-black", "slot2-blue", "slot3-black", "slot3-blue"].flatMap((id, index) => [
    { id: `${id}-input`, kind: "input" as const, file: `${id}-input.png`, sha256: String((index + 1) % 10).repeat(64) },
    { id: `${id}-product`, kind: "product" as const, file: `${id}-product.png`, sha256: String((index + 2) % 10).repeat(64) },
    { id: `${id}-ps-mask`, kind: "mask" as const, file: `${id}-ps-mask.png`, sha256: String((index + 3) % 10).repeat(64) },
    { id: `${id}-birefnet-mask`, kind: "mask" as const, file: `${id}-birefnet-mask.png`, sha256: String((index + 4) % 10).repeat(64) },
    { id: `${id}-shadow`, kind: "shadow" as const, file: `${id}-shadow.png`, sha256: String((index + 5) % 10).repeat(64) },
    { id: `${id}-preview`, kind: "preview" as const, file: `${id}-preview.png`, sha256: String((index + 6) % 10).repeat(64) },
  ]);
  return {
    schemaVersion: 2,
    version: "hat-ps-shadow-v2.3",
    candidateOnly: false,
    releaseState: "approved",
    approved: true,
    publicationAllowed: true,
    canvas: { width: 800, height: 800 },
    algorithm: { id: "ps-levels-roi-v1", levels: "round(value*255/whitePoint)-clamp-255" },
    biRefNet: {
      modelId: "ZhengPeng7/BiRefNet_HR-matting",
      revision: "5d6b6f8adcb5b417c871b1d84ceaae9871355b7f",
      weightsSha256: "a5a4de698739ea5e0e8bbab28e1b293dde95092b87a442d566cbc585c53cef55",
    },
    gates: { whitePointMin: 220, whitePointMax: 245, whitePointMaxChannelSpread: 8, productBoxTolerance: 0.05 },
    goldStandards: [
      { id: "slot2-black", psdPath: "C:/slot2-black.psd", psdSha256: "a".repeat(64), layerNames: { product: "product", shadow: "shadow", background: "white" }, productBox: { left: 0.05, top: 0.125, width: 0.9, height: 0.75 } },
      { id: "slot2-blue", psdPath: "C:/slot2-blue.psd", psdSha256: "b".repeat(64), layerNames: { product: "product", shadow: "shadow", background: "white" }, productBox: { left: 0.05, top: 0.125, width: 0.9, height: 0.75 } },
      { id: "slot3-black", psdPath: "C:/slot3-black.psd", psdSha256: "c".repeat(64), layerNames: { product: "product", shadow: "shadow", background: "white" }, productBox: { left: 0.15, top: 0.05, width: 0.7, height: 0.9 } },
      { id: "slot3-blue", psdPath: "C:/slot3-blue.psd", psdSha256: "d".repeat(64), layerNames: { product: "product", shadow: "shadow", background: "white" }, productBox: { left: 0.15, top: 0.05, width: 0.7, height: 0.9 } },
    ],
    presets: [
      { id: "hat-angle-slot-2", angleSlot: 2, humanAngleLabel: "左斜视角", approved: true, roi: { x: 0, y: 277, width: 800, height: 569 }, whitePoint: { x: 10, y: 10 }, goldStandardIds: ["slot2-black", "slot2-blue"] },
      { id: "hat-angle-slot-3", angleSlot: 3, humanAngleLabel: "正面", approved: true, roi: { x: 0, y: 330, width: 800, height: 470 }, whitePoint: { x: 15, y: 578 }, goldStandardIds: ["slot3-black", "slot3-blue"] },
    ],
    regressionAssets,
    root: "C:/fixture-v2",
    manifestSha256: "f".repeat(64),
  };
}

function syntheticAdaptiveBundle(): LoadedCalibratedShadowBundle & AdaptiveCalibratedShadowManifest {
  const goldIds = ["slot1-black", "slot1-blue", "slot1-white"];
  const regressionAssets = goldIds.flatMap((id, index) => [
    { id: `${id}-input`, kind: "input" as const, file: `${id}-input.png`, sha256: String(index + 1).repeat(64) },
    { id: `${id}-product`, kind: "product" as const, file: `${id}-product.png`, sha256: String(index + 2).repeat(64) },
    { id: `${id}-ps-mask`, kind: "mask" as const, file: `${id}-ps-mask.png`, sha256: String(index + 3).repeat(64) },
    { id: `${id}-birefnet-mask`, kind: "mask" as const, file: `${id}-birefnet-mask.png`, sha256: String(index + 4).repeat(64) },
    { id: `${id}-shadow`, kind: "shadow" as const, file: `${id}-shadow.png`, sha256: String(index + 5).repeat(64) },
    { id: `${id}-preview`, kind: "preview" as const, file: `${id}-preview.png`, sha256: String(index + 6).repeat(64) },
  ]);
  return {
    schemaVersion: 3,
    version: "hat-ps-shadow-v2.4",
    candidateOnly: false,
    releaseState: "approved",
    approved: true,
    publicationAllowed: true,
    canvas: { width: 800, height: 800 },
    algorithm: { id: "ps-levels-roi-v2-adaptive-white", levels: "round(value*255/channelMedian)-clamp-255" },
    biRefNet: {
      modelId: "ZhengPeng7/BiRefNet_HR-matting",
      revision: "5d6b6f8adcb5b417c871b1d84ceaae9871355b7f",
      weightsSha256: "a5a4de698739ea5e0e8bbab28e1b293dde95092b87a442d566cbc585c53cef55",
    },
    gates: {
      whitePointMin: 220,
      whitePointMax: 245,
      whitePointMaxChannelSpread: 8,
      productBoxTolerance: 0.05,
      roiBoundaryMaxChannelJump: 5,
      detachedResidueMinArea: 64,
      residueThreshold: 2,
      legalShadowMaskNeighborhood: 16,
    },
    goldStandards: goldIds.map((id, index) => ({
      id,
      psdPath: `C:/${id}.psd`,
      psdSha256: String.fromCharCode(97 + index).repeat(64),
      layerNames: { product: "product", shadow: "shadow", background: "white" },
      productBox: { left: 0.375, top: 0.25, width: 0.25, height: 0.375 },
    })),
    presets: [{
      id: "hat-angle-slot-1",
      angleSlot: 1,
      humanAngleLabel: "主图斜视角",
      approved: true,
      roi: { x: 0, y: 480, width: 800, height: 320 },
      whiteSamplePolicy: ADAPTIVE_WHITE_SAMPLE_POLICY,
      goldStandardIds: goldIds,
    }],
    regressionAssets,
    root: "C:/fixture-v3",
    manifestSha256: "9".repeat(64),
  };
}

function adaptiveRawFixture(side: number, background = 240): { rgb: Buffer; mask: Buffer } {
  const rgb = Buffer.alloc(side * side * 3, background);
  const mask = Buffer.alloc(side * side);
  const left = Math.round(side * 0.375);
  const top = Math.round(side * 0.25);
  const width = Math.round(side * 0.25);
  const height = Math.round(side * 0.375);
  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) {
      const index = y * side + x;
      mask[index] = 255;
      rgb[index * 3] = 30; rgb[index * 3 + 1] = 40; rgb[index * 3 + 2] = 50;
    }
  }
  return { rgb, mask };
}

async function encodeAdaptiveFixture(rgb: Buffer, mask: Buffer, side: number): Promise<{ v1: Buffer; matte: Buffer }> {
  return {
    v1: await sharp(rgb, { raw: { width: side, height: side, channels: 3 } }).png().toBuffer(),
    matte: await sharp(mask, { raw: { width: side, height: side, channels: 1 } }).png().toBuffer(),
  };
}

async function rectangularMaskAtSide(side: number, left: number, top: number, width: number, height: number): Promise<Buffer> {
  const mask = Buffer.alloc(side * side);
  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) mask[y * side + x] = 255;
  }
  return sharp(mask, { raw: { width: side, height: side, channels: 1 } }).png().toBuffer();
}

async function rectangularMask(left: number, top: number, width: number, height: number): Promise<Buffer> {
  return rectangularMaskAtSide(800, left, top, width, height);
}

describe("native three-layer compositor", () => {
  it("keeps opaque product pixels, normalizes the ROI, emits white elsewhere, and has no alpha", async () => {
    const side = 800;
    const rgb = Buffer.alloc(side * side * 3, 245);
    const mask = Buffer.alloc(side * side);
    for (let y = 100; y < 700; y += 1) for (let x = 40; x < 760; x += 1) {
      const pixel = y * side + x;
      mask[pixel] = 255;
      rgb[pixel * 3] = 20; rgb[pixel * 3 + 1] = 30; rgb[pixel * 3 + 2] = 40;
    }
    for (let y = 710; y < 720; y += 1) for (let x = 300; x < 500; x += 1) {
      const offset = (y * side + x) * 3;
      rgb[offset] = 200; rgb[offset + 1] = 200; rgb[offset + 2] = 200;
    }
    const sampleOffset = (658 * side + 11) * 3;
    rgb[sampleOffset] = 230; rgb[sampleOffset + 1] = 231; rgb[sampleOffset + 2] = 232;
    const v1 = await sharp(rgb, { raw: { width: side, height: side, channels: 3 } }).png().toBuffer();
    const matte = await sharp(mask, { raw: { width: side, height: side, channels: 1 } }).png().toBuffer();
    const bundle = syntheticBundle();
    const result = await composeCalibratedShadowMain(v1, matte, bundle, bundle.presets[0]);
    expect(result.sampledRgb).toEqual([230, 231, 232]);
    const metadata = await sharp(result.image).metadata();
    expect(metadata.hasAlpha).toBe(false);
    const { data, info } = await sharp(result.image).raw().toBuffer({ resolveWithObject: true });
    const productOffset = (300 * side + 400) * info.channels;
    expect([...data.subarray(productOffset, productOffset + 3)]).toEqual([20, 30, 40]);
    const shadowOffset = (715 * side + 400) * info.channels;
    expect([...data.subarray(shadowOffset, shadowOffset + 3)]).toEqual([222, 221, 220]);
    const outsideOffset = (10 * side + 10) * info.channels;
    expect([...data.subarray(outsideOffset, outsideOffset + 3)]).toEqual([255, 255, 255]);
  });

  it("rejects empty/wrong-size masks and unsafe white samples", async () => {
    const v1 = await sharp({ create: { width: 800, height: 800, channels: 3, background: { r: 230, g: 230, b: 230 } } }).png().toBuffer();
    const empty = await sharp(Buffer.alloc(800 * 800), { raw: { width: 800, height: 800, channels: 1 } }).png().toBuffer();
    const wrong = await sharp(Buffer.alloc(799 * 800, 255), { raw: { width: 799, height: 800, channels: 1 } }).png().toBuffer();
    const bundle = syntheticBundle();
    await expect(composeCalibratedShadowMain(v1, empty, bundle, bundle.presets[0])).rejects.toThrow(/蒙版为空/u);
    await expect(composeCalibratedShadowMain(v1, wrong, bundle, bundle.presets[0])).rejects.toThrow(/尺寸/u);
    const unsafe = await sharp({ create: { width: 800, height: 800, channels: 3, background: { r: 219, g: 230, b: 230 } } }).png().toBuffer();
    await expect(composeCalibratedShadowMain(unsafe, empty, bundle, bundle.presets[0])).rejects.toThrow(/白场采样/u);
  });

  it("accepts each schema v2 angle only against that preset's pinned gold standards", async () => {
    const bundle = syntheticScopedBundle();
    const v1 = await sharp({
      create: { width: 800, height: 800, channels: 3, background: { r: 230, g: 230, b: 230 } },
    }).png().toBuffer();
    const slot2Mask = await rectangularMask(40, 100, 720, 600);
    const slot3Mask = await rectangularMask(120, 40, 560, 720);
    await expect(composeCalibratedShadowMain(v1, slot2Mask, bundle, bundle.presets[0])).resolves.toMatchObject({
      productBox: { left: 0.05, top: 0.125, width: 0.9, height: 0.75 },
    });
    await expect(composeCalibratedShadowMain(v1, slot3Mask, bundle, bundle.presets[1])).resolves.toMatchObject({
      productBox: { left: 0.15, top: 0.05, width: 0.7, height: 0.9 },
    });
    await expect(composeCalibratedShadowMain(v1, slot2Mask, bundle, bundle.presets[1]))
      .rejects.toThrow(/同角度金标准/u);
    await expect(composeCalibratedShadowMain(v1, slot3Mask, bundle, bundle.presets[0]))
      .rejects.toThrow(/同角度金标准/u);
  });

  it("renders the approved slot 3 recipe at 800/1200/1600 without alpha", async () => {
    const bundle = syntheticScopedBundle();
    const preset = bundle.presets[1];
    for (const side of [800, 1200, 1600]) {
      const v1 = await sharp({
        create: { width: side, height: side, channels: 3, background: { r: 240, g: 240, b: 240 } },
      }).png().toBuffer();
      const mask = await rectangularMaskAtSide(
        side,
        Math.round(side * 0.15),
        Math.round(side * 0.05),
        Math.round(side * 0.7),
        Math.round(side * 0.9),
      );
      const result = await composeCalibratedShadowMain(v1, mask, bundle, preset);
      expect(await sharp(result.image).metadata()).toMatchObject({ width: side, height: side, hasAlpha: false });
      expect(result.productBox).toMatchObject({ left: 0.15, top: 0.05, width: 0.7, height: 0.9 });
    }
  });

  it("keeps schema v1 legacy behavior by matching against either package gold", async () => {
    const bundle = syntheticBundle();
    bundle.goldStandards[1].productBox = { left: 0.15, top: 0.05, width: 0.7, height: 0.9 };
    const v1 = await sharp({
      create: { width: 800, height: 800, channels: 3, background: { r: 230, g: 230, b: 230 } },
    }).png().toBuffer();
    const secondLegacyGoldMask = await rectangularMask(120, 40, 560, 720);
    await expect(composeCalibratedShadowMain(v1, secondLegacyGoldMask, bundle, bundle.presets[0]))
      .resolves.toMatchObject({ productBox: bundle.goldStandards[1].productBox });
  });

  it("scales and clips the approved slot 3 ROI at 800/1200/1600", () => {
    const roi = { x: 0, y: 330, width: 800, height: 470 };
    expect(scaleAndClipReferenceRect(roi, 800)).toEqual({ x: 0, y: 330, width: 800, height: 470 });
    expect(scaleAndClipReferenceRect(roi, 1200)).toEqual({ x: 0, y: 495, width: 1200, height: 705 });
    expect(scaleAndClipReferenceRect(roi, 1600)).toEqual({ x: 0, y: 660, width: 1600, height: 940 });
  });
});

describe("adaptive white-field schema v3", () => {
  it("selects one deterministic patch and scales its window at 800/1200/1600", () => {
    const patchSizes: number[] = [];
    for (const side of [800, 1200, 1600]) {
      const { rgb, mask } = adaptiveRawFixture(side);
      const roi = scaleAndClipReferenceRect({ x: 0, y: 480, width: 800, height: 320 }, side);
      const first = selectAdaptiveWhiteSample(rgb, 3, mask, 1, side, roi);
      const second = selectAdaptiveWhiteSample(rgb, 3, mask, 1, side, roi);
      expect(second).toEqual(first);
      expect(first.medianRgb).toEqual([240, 240, 240]);
      expect(first.patchPassRate).toBe(1);
      expect(first.maskDistance).toBeGreaterThanOrEqual(scaleReferenceCoordinate(32, side));
      patchSizes.push(first.patchSize);
    }
    expect(patchSizes).toEqual([31, 47, 63]);
  });

  it("rejects calibrated rendering when no admissible white field exists", async () => {
    const side = 800;
    const { rgb, mask } = adaptiveRawFixture(side, 255);
    const { v1, matte } = await encodeAdaptiveFixture(rgb, mask, side);
    const bundle = syntheticAdaptiveBundle();
    await expect(composeCalibratedShadowMain(v1, matte, bundle, bundle.presets[0]))
      .rejects.toThrow(/自适应白场采样失败/u);
  });

  it("purifies detached gray blocks, still fails ROI seams, and preserves a connected contact shadow", async () => {
    const side = 800;
    const bundle = syntheticAdaptiveBundle();

    const detached = adaptiveRawFixture(side);
    for (let y = 650; y < 660; y += 1) for (let x = 50; x < 60; x += 1) {
      const offset = (y * side + x) * 3;
      detached.rgb[offset] = 230; detached.rgb[offset + 1] = 230; detached.rgb[offset + 2] = 230;
    }
    const detachedImages = await encodeAdaptiveFixture(detached.rgb, detached.mask, side);
    const detachedResult = await composeCalibratedShadowMain(detachedImages.v1, detachedImages.matte, bundle, bundle.presets[0]);
    const { data: detachedOutput, info: detachedInfo } = await sharp(detachedResult.image).raw().toBuffer({ resolveWithObject: true });
    const detachedOffset = (655 * side + 55) * detachedInfo.channels;
    expect([...detachedOutput.subarray(detachedOffset, detachedOffset + 3)]).toEqual([255, 255, 255]);
    expect(detachedResult.qualityGates.detachedBackgroundResidue).toMatchObject({ passed: true, largestDetachedArea: 0 });

    const seam = adaptiveRawFixture(side);
    for (let x = 50; x < 150; x += 1) {
      const offset = (480 * side + x) * 3;
      seam.rgb[offset] = 234; seam.rgb[offset + 1] = 234; seam.rgb[offset + 2] = 234;
    }
    const seamImages = await encodeAdaptiveFixture(seam.rgb, seam.mask, side);
    await expect(composeCalibratedShadowMain(seamImages.v1, seamImages.matte, bundle, bundle.presets[0]))
      .rejects.toThrow(/roiBoundary/u);

    const legal = adaptiveRawFixture(side);
    for (let y = 500; y < 520; y += 1) for (let x = 320; x < 480; x += 1) {
      const index = y * side + x;
      if (legal.mask[index] !== 0) continue;
      const offset = index * 3;
      legal.rgb[offset] = 230; legal.rgb[offset + 1] = 230; legal.rgb[offset + 2] = 230;
    }
    const legalImages = await encodeAdaptiveFixture(legal.rgb, legal.mask, side);
    const legalResult = await composeCalibratedShadowMain(legalImages.v1, legalImages.matte, bundle, bundle.presets[0]);
    expect(legalResult).toMatchObject({
      sampledRgb: [240, 240, 240],
      qualityGates: { detachedBackgroundResidue: { passed: true } },
    });
    const { data: legalOutput, info: legalInfo } = await sharp(legalResult.image).raw().toBuffer({ resolveWithObject: true });
    const legalOffset = (510 * side + 400) * legalInfo.channels;
    expect([...legalOutput.subarray(legalOffset, legalOffset + 3)]).toEqual([244, 244, 244]);
  });

  it("keeps v2.4 candidate state fail-closed and rejects fixed white points", () => {
    const approved = syntheticAdaptiveBundle();
    const candidate = structuredClone(approved);
    candidate.candidateOnly = true;
    candidate.releaseState = "awaiting-human-approval";
    candidate.approved = false;
    candidate.publicationAllowed = false;
    candidate.presets[0].approved = false;
    const bytes = Buffer.from(JSON.stringify(candidate));
    expect(parseCalibratedShadowManifest(bytes, "hat-ps-shadow-v2.4", "candidate"))
      .toMatchObject({ schemaVersion: 3, approved: false, presets: [{ approved: false }] });
    expect(() => parseCalibratedShadowManifest(bytes, "hat-ps-shadow-v2.4"))
      .toThrow(/候选包不得进入运行时/u);
    const fixedPoint = structuredClone(candidate) as unknown as Record<string, unknown>;
    (fixedPoint.presets as Array<Record<string, unknown>>)[0].whitePoint = { x: 413, y: 739 };
    expect(() => parseCalibratedShadowManifest(Buffer.from(JSON.stringify(fixedPoint)), "hat-ps-shadow-v2.4", "candidate"))
      .toThrow(/不可变自适应白场策略/u);
  });

  it("accepts an explicit Slot 4 development identity only in candidate mode", async () => {
    const candidate = structuredClone(syntheticAdaptiveBundle()) as Record<string, unknown>;
    candidate.version = SLOT_4_DEVELOPMENT_IDENTITY;
    candidate.developmentIdentity = SLOT_4_DEVELOPMENT_IDENTITY;
    candidate.candidateOnly = true;
    candidate.releaseState = "awaiting-human-approval";
    candidate.approved = false;
    candidate.publicationAllowed = false;
    const preset = (candidate.presets as Array<Record<string, unknown>>)[0];
    preset.angleSlot = 4;
    preset.humanAngleLabel = "synthetic-slot-4";
    preset.approved = false;
    const bytes = Buffer.from(JSON.stringify(candidate));
    expect(parseCalibratedShadowManifest(bytes, SLOT_4_DEVELOPMENT_IDENTITY, "candidate"))
      .toMatchObject({ version: SLOT_4_DEVELOPMENT_IDENTITY, presets: [{ angleSlot: 4, approved: false }] });
    expect(() => parseCalibratedShadowManifest(bytes, SLOT_4_DEVELOPMENT_IDENTITY))
      .toThrow(/开发身份不得进入生产运行时/u);
    await expect(loadCalibratedShadowBundle(SLOT_4_DEVELOPMENT_IDENTITY as never))
      .rejects.toThrow(/生产加载器拒绝开发身份/u);
    await expect(loadCandidateCalibratedShadowBundle(process.cwd(), "hat-ps-shadow-v2.3"))
      .rejects.toThrow(/仅接受显式开发身份/u);
  });
});

describe("immutable preset package", () => {
  it("loads the checked-in package and renders both locked regression inputs", async () => {
    const bundle = await loadCalibratedShadowBundle();
    expect(bundle.version).toBe(DEFAULT_SHADOW_PRESET_VERSION);
    for (const id of ["329a8209", "329a8218"]) {
      const input = await readFile(path.join(bundle.root, bundle.regressionAssets.find((asset) => asset.id === `${id}-input`)!.file));
      const mask = await readFile(path.join(bundle.root, bundle.regressionAssets.find((asset) => asset.id === `${id}-birefnet-mask`)!.file));
      const result = await composeCalibratedShadowMain(input, mask, bundle, bundle.presets[0]);
      expect((await sharp(result.image).metadata()).hasAlpha).toBe(false);
    }
  });

  it("rejects illegal dimensions, paths, hashes, duplicate IDs, and parameters", async () => {
    const manifestPath = path.join(process.cwd(), "config", "product-main-shadows", DEFAULT_SHADOW_PRESET_VERSION, "manifest.json");
    const original = JSON.parse(await readFile(manifestPath, "utf8")) as CalibratedShadowManifest;
    const invalid = (mutate: (copy: CalibratedShadowManifest) => void): Buffer => {
      const copy = structuredClone(original);
      mutate(copy);
      return Buffer.from(JSON.stringify(copy));
    };
    expect(() => parseCalibratedShadowManifest(invalid((copy) => { copy.canvas.width = 801; }), DEFAULT_SHADOW_PRESET_VERSION)).toThrow(/800×800/u);
    expect(() => parseCalibratedShadowManifest(invalid((copy) => { copy.regressionAssets[0].file = "../escape.png"; }), DEFAULT_SHADOW_PRESET_VERSION)).toThrow(/越界/u);
    expect(() => parseCalibratedShadowManifest(invalid((copy) => { copy.regressionAssets[0].sha256 = "bad"; }), DEFAULT_SHADOW_PRESET_VERSION)).toThrow(/哈希/u);
    expect(() => parseCalibratedShadowManifest(invalid((copy) => {
      if (copy.schemaVersion !== 1) throw new Error("expected schema v1 fixture");
      copy.presets.push(structuredClone(copy.presets[0]));
    }), DEFAULT_SHADOW_PRESET_VERSION)).toThrow(/重复/u);
    expect(() => parseCalibratedShadowManifest(invalid((copy) => { copy.presets[0].roi.y = -1; }), DEFAULT_SHADOW_PRESET_VERSION)).toThrow(/ROI/u);
  });

  it("parses legacy schema v1 unchanged and validates schema v2 per-preset gold references", () => {
    const legacy = syntheticBundle();
    expect(parseCalibratedShadowManifest(Buffer.from(JSON.stringify(legacy)), DEFAULT_SHADOW_PRESET_VERSION))
      .toMatchObject({ schemaVersion: 1, presets: [{ id: "hat-angle-slot-2" }] });

    const scoped = syntheticScopedBundle();
    const encode = (value: ScopedCalibratedShadowManifest): Buffer => Buffer.from(JSON.stringify(value));
    expect(parseCalibratedShadowManifest(encode(scoped), "hat-ps-shadow-v2.3"))
      .toMatchObject({
        schemaVersion: 2,
        presets: [
          { id: "hat-angle-slot-2", goldStandardIds: ["slot2-black", "slot2-blue"] },
          { id: "hat-angle-slot-3", goldStandardIds: ["slot3-black", "slot3-blue"] },
        ],
      });

    const v23WithLegacySchema = {
      ...structuredClone(legacy),
      version: "hat-ps-shadow-v2.3",
    } as unknown as LegacyCalibratedShadowManifest;
    expect(() => parseCalibratedShadowManifest(Buffer.from(JSON.stringify(v23WithLegacySchema)), "hat-ps-shadow-v2.3"))
      .toThrow(/必须使用 schema v2/u);

    const missingReleaseApproval = structuredClone(scoped) as unknown as Record<string, unknown>;
    delete missingReleaseApproval.publicationAllowed;
    expect(() => parseCalibratedShadowManifest(Buffer.from(JSON.stringify(missingReleaseApproval)), "hat-ps-shadow-v2.3"))
      .toThrow(/显式批准发布/u);

    const v21WithScopedSchema = {
      ...structuredClone(scoped),
      version: "hat-ps-shadow-v2.1",
    } as unknown as ScopedCalibratedShadowManifest;
    expect(() => parseCalibratedShadowManifest(encode(v21WithScopedSchema), "hat-ps-shadow-v2.1"))
      .toThrow(/必须使用 schema v1/u);

    const oneGold = structuredClone(scoped);
    oneGold.presets[0].goldStandardIds = ["slot2-black"];
    expect(() => parseCalibratedShadowManifest(encode(oneGold), "hat-ps-shadow-v2.3"))
      .toThrow(/至少两份不同/u);

    const duplicateGold = structuredClone(scoped);
    duplicateGold.presets[0].goldStandardIds = ["slot2-black", "slot2-black"];
    expect(() => parseCalibratedShadowManifest(encode(duplicateGold), "hat-ps-shadow-v2.3"))
      .toThrow(/至少两份不同/u);

    const missingGold = structuredClone(scoped);
    missingGold.presets[0].goldStandardIds = ["slot2-black", "missing-gold"];
    expect(() => parseCalibratedShadowManifest(encode(missingGold), "hat-ps-shadow-v2.3"))
      .toThrow(/不存在的金标准/u);

    const overlappingGold = structuredClone(scoped);
    overlappingGold.presets[1].goldStandardIds = ["slot2-black", "slot3-blue"];
    expect(() => parseCalibratedShadowManifest(encode(overlappingGold), "hat-ps-shadow-v2.3"))
      .toThrow(/不能关联多个角度/u);

    const unassignedGold = structuredClone(scoped);
    unassignedGold.goldStandards.push({
      id: "slot3-green",
      psdPath: "C:/slot3-green.psd",
      psdSha256: "9".repeat(64),
      layerNames: { product: "product", shadow: "shadow", background: "white" },
      productBox: { left: 0.15, top: 0.05, width: 0.7, height: 0.9 },
    });
    expect(() => parseCalibratedShadowManifest(encode(unassignedGold), "hat-ps-shadow-v2.3"))
      .toThrow(/恰好关联一个角度/u);

    const incompleteLayers = structuredClone(scoped) as unknown as Record<string, unknown>;
    const firstGold = (incompleteLayers.goldStandards as Array<Record<string, unknown>>)[0];
    firstGold.layerNames = { product: "product", shadow: "shadow" };
    expect(() => parseCalibratedShadowManifest(Buffer.from(JSON.stringify(incompleteLayers)), "hat-ps-shadow-v2.3"))
      .toThrow(/图层映射/u);

    const wrongAssetKind = structuredClone(scoped);
    wrongAssetKind.regressionAssets.find((asset) => asset.id === "slot3-black-input")!.kind = "preview";
    expect(() => parseCalibratedShadowManifest(encode(wrongAssetKind), "hat-ps-shadow-v2.3"))
      .toThrow(/类型不匹配/u);

    const extraAsset = structuredClone(scoped);
    extraAsset.regressionAssets.push({
      id: "unrelated-preview",
      kind: "preview",
      file: "unrelated-preview.png",
      sha256: "e".repeat(64),
    });
    expect(() => parseCalibratedShadowManifest(encode(extraAsset), "hat-ps-shadow-v2.3"))
      .toThrow(/恰好覆盖/u);
  });

  it("detects manifest and regression-asset tampering", async () => {
    const source = path.join(process.cwd(), "config", "product-main-shadows", DEFAULT_SHADOW_PRESET_VERSION);
    const root = await mkdtemp(path.join(os.tmpdir(), "calibrated-shadow-bundle-"));
    temporaryRoots.push(root);
    await cp(source, root, { recursive: true });
    const manifestBytes = await readFile(path.join(root, "manifest.json"));
    const manifestHash = calibratedShadowManifestSha256(manifestBytes);
    await expect(validateCalibratedShadowBundle(root, DEFAULT_SHADOW_PRESET_VERSION, "0".repeat(64))).rejects.toThrow(/manifest 哈希/u);
    await writeFile(path.join(root, "regression", "329A8209-input.png"), Buffer.from("tampered"));
    await expect(validateCalibratedShadowBundle(root, DEFAULT_SHADOW_PRESET_VERSION, manifestHash)).rejects.toThrow(/素材哈希/u);
  });
});
