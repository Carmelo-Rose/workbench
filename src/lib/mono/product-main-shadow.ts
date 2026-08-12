import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { ProductMainImageVersion, ProductShadowPresetVersion } from "./contracts";

export const DEFAULT_MAIN_IMAGE_VERSION: ProductMainImageVersion = "whitefield-v1";
export const CALIBRATED_SHADOW_MAIN_IMAGE_VERSION: ProductMainImageVersion = "calibrated-shadow-v2";
export const DEFAULT_SHADOW_PRESET_VERSION: ProductShadowPresetVersion = "hat-ps-shadow-v2.1";

export const BIREFNET_MODEL_ID = "ZhengPeng7/BiRefNet_HR-matting";
export const BIREFNET_MODEL_REVISION = "5d6b6f8adcb5b417c871b1d84ceaae9871355b7f";
export const BIREFNET_WEIGHTS_SHA256 = "a5a4de698739ea5e0e8bbab28e1b293dde95092b87a442d566cbc585c53cef55";

const HISTORICAL_MAIN_IMAGE_VERSIONS = new Set(["refined-shadow-v2", "template-shadow-v2"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9.-]*$/u;
const MASK_BOUNDS_THRESHOLD = 128;

export type ReferencePoint = { x: number; y: number };
export type ReferenceRect = { x: number; y: number; width: number; height: number };
export type NormalizedBox = { left: number; top: number; width: number; height: number };

type CalibratedShadowPresetBase = {
  id: string;
  angleSlot: number;
  humanAngleLabel: string;
  approved: true;
  roi: ReferenceRect;
  whitePoint: ReferencePoint;
};

export type LegacyCalibratedShadowPreset = CalibratedShadowPresetBase & {
  goldStandardIds?: never;
};

export type ScopedCalibratedShadowPreset = CalibratedShadowPresetBase & {
  goldStandardIds: string[];
};

export type CalibratedShadowPreset = LegacyCalibratedShadowPreset | ScopedCalibratedShadowPreset;

export type ShadowRegressionAsset = {
  id: string;
  kind: "input" | "product" | "mask" | "shadow" | "preview";
  file: string;
  sha256: string;
};

export type ShadowGoldStandard = {
  id: string;
  psdPath: string;
  psdSha256: string;
  layerNames: { product: string; shadow: string; background: string };
  productBox: NormalizedBox;
};

type CalibratedShadowManifestBase = {
  version: ProductShadowPresetVersion;
  canvas: { width: number; height: number };
  algorithm: {
    id: "ps-levels-roi-v1";
    levels: "round(value*255/whitePoint)-clamp-255";
  };
  biRefNet: { modelId: string; revision: string; weightsSha256: string };
  gates: {
    whitePointMin: number;
    whitePointMax: number;
    whitePointMaxChannelSpread: number;
    productBoxTolerance: number;
  };
  goldStandards: ShadowGoldStandard[];
  regressionAssets: ShadowRegressionAsset[];
};

export type LegacyCalibratedShadowManifest = CalibratedShadowManifestBase & {
  schemaVersion: 1;
  presets: LegacyCalibratedShadowPreset[];
};

export type ScopedCalibratedShadowManifest = CalibratedShadowManifestBase & {
  schemaVersion: 2;
  candidateOnly: false;
  releaseState: "approved";
  approved: true;
  publicationAllowed: true;
  presets: ScopedCalibratedShadowPreset[];
};

export type CalibratedShadowManifest = LegacyCalibratedShadowManifest | ScopedCalibratedShadowManifest;

type UncheckedCalibratedShadowManifest = CalibratedShadowManifestBase & {
  schemaVersion: 1 | 2;
  candidateOnly?: unknown;
  releaseState?: unknown;
  approved?: unknown;
  publicationAllowed?: unknown;
  presets: CalibratedShadowPreset[];
};

export type LoadedCalibratedShadowBundle = CalibratedShadowManifest & {
  root: string;
  manifestSha256: string;
};

export type ShadowAngleAssignment = {
  angleSlot?: number;
  presetId?: string;
  fallbackReason?: string;
};

export type CalibratedShadowRenderResult = {
  image: Buffer;
  sampledRgb: [number, number, number];
  productBox: NormalizedBox;
};

type ShadowPresetRegistry = {
  schemaVersion: 1;
  packages: { version: ProductShadowPresetVersion; manifestSha256: string }[];
};

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Stable across Git's LF/CRLF checkout conversion while still pinning JSON content. */
export function calibratedShadowManifestSha256(bytes: Buffer): string {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")) as unknown; }
  catch { throw new Error("阴影预设 manifest 不是有效 JSON"); }
  return sha256(Buffer.from(JSON.stringify(value), "utf8"));
}

export function isCalibratedShadowV2(value: unknown): boolean {
  return value === CALIBRATED_SHADOW_MAIN_IMAGE_VERSION;
}

export function isHistoricalShadowV2(value: unknown): boolean {
  return typeof value === "string" && HISTORICAL_MAIN_IMAGE_VERSIONS.has(value);
}

export function isVersionedShadowOutput(value: unknown): boolean {
  return isCalibratedShadowV2(value) || isHistoricalShadowV2(value);
}

export function normalizeMainImageVersion(value: unknown): ProductMainImageVersion {
  return isCalibratedShadowV2(value) ? CALIBRATED_SHADOW_MAIN_IMAGE_VERSION : DEFAULT_MAIN_IMAGE_VERSION;
}

/** Historical experiments remain readable, but must never enter a current worker. */
export function assertRunnableMainImageVersion(value: unknown): void {
  if (isHistoricalShadowV2(value)) {
    throw new Error(`历史主图实验 ${String(value)} 不允许新建或按当前算法重跑`);
  }
}

/** Server-only rollout gate. Already-created jobs deliberately do not read it. */
export function isCalibratedShadowV2Enabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.PRODUCT_MAIN_V2_ENABLED === "true";
}

function presetRoot(version: ProductShadowPresetVersion): string {
  return path.join(process.cwd(), "config", "product-main-shadows", version);
}

function registryPath(): string {
  return path.join(process.cwd(), "config", "product-main-shadows", "registry.json");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function assertNormalizedBox(box: unknown, label: string): asserts box is NormalizedBox {
  if (!box || typeof box !== "object") throw new Error(`${label} 缺少商品框`);
  const candidate = box as Partial<NormalizedBox>;
  if (![candidate.left, candidate.top, candidate.width, candidate.height].every(isFiniteNumber)
    || candidate.left! < 0 || candidate.top! < 0 || candidate.width! <= 0 || candidate.height! <= 0
    || candidate.left! + candidate.width! > 1.001 || candidate.top! + candidate.height! > 1.001) {
    throw new Error(`${label} 商品框非法`);
  }
}

function assertSafeAssetPath(file: unknown, label: string): asserts file is string {
  if (typeof file !== "string" || !file || path.isAbsolute(file)) throw new Error(`${label} 路径非法`);
  const normalized = path.normalize(file);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) throw new Error(`${label} 路径越界`);
}

export function parseCalibratedShadowManifest(
  bytes: Buffer,
  expectedVersion: ProductShadowPresetVersion,
): CalibratedShadowManifest {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")) as unknown; }
  catch { throw new Error("阴影预设 manifest 不是有效 JSON"); }
  if (!value || typeof value !== "object") throw new Error("阴影预设 manifest 格式错误");
  const manifest = value as Partial<UncheckedCalibratedShadowManifest>;
  if ((manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) || manifest.version !== expectedVersion) {
    throw new Error("阴影预设版本不匹配");
  }
  const expectedSchemaVersion = expectedVersion === "hat-ps-shadow-v2.1" ? 1 : 2;
  if (manifest.schemaVersion !== expectedSchemaVersion) {
    throw new Error(`阴影预设 ${expectedVersion} 必须使用 schema v${expectedSchemaVersion}`);
  }
  if (manifest.schemaVersion === 2
    && (manifest.candidateOnly !== false || manifest.releaseState !== "approved"
      || manifest.approved !== true || manifest.publicationAllowed !== true)) {
    throw new Error("schema v2 阴影预设必须显式批准发布，候选包不得进入运行时");
  }
  if (manifest.canvas?.width !== 800 || manifest.canvas.height !== 800) throw new Error("阴影预设参考画布必须是 800×800");
  if (manifest.algorithm?.id !== "ps-levels-roi-v1"
    || manifest.algorithm.levels !== "round(value*255/whitePoint)-clamp-255") {
    throw new Error("阴影预设算法非法");
  }
  if (manifest.biRefNet?.modelId !== BIREFNET_MODEL_ID
    || manifest.biRefNet.revision !== BIREFNET_MODEL_REVISION
    || manifest.biRefNet.weightsSha256 !== BIREFNET_WEIGHTS_SHA256) {
    throw new Error("阴影预设 BiRefNet 版本或权重哈希不匹配");
  }
  const gates = manifest.gates;
  if (!gates || gates.whitePointMin !== 220 || gates.whitePointMax !== 245
    || gates.whitePointMaxChannelSpread !== 8 || gates.productBoxTolerance !== 0.05) {
    throw new Error("阴影预设门禁参数非法");
  }
  if (!Array.isArray(manifest.goldStandards)
    || (manifest.schemaVersion === 1 ? manifest.goldStandards.length !== 2 : manifest.goldStandards.length < 2)) {
    throw new Error(manifest.schemaVersion === 1
      ? "schema v1 阴影预设必须恰好包含两份金标准"
      : "schema v2 阴影预设必须至少包含两份金标准");
  }
  const goldIds = new Set<string>();
  for (const gold of manifest.goldStandards) {
    if (!gold || !SAFE_ID_PATTERN.test(gold.id ?? "") || goldIds.has(gold.id)) throw new Error("阴影预设金标准 ID 非法或重复");
    goldIds.add(gold.id);
    if (typeof gold.psdPath !== "string" || !gold.psdPath || !SHA256_PATTERN.test(gold.psdSha256 ?? "")) {
      throw new Error(`阴影预设金标准来源非法：${gold.id}`);
    }
    if (!gold.layerNames
      || [gold.layerNames.product, gold.layerNames.shadow, gold.layerNames.background]
        .some((name) => typeof name !== "string" || !name)) {
      throw new Error(`阴影预设金标准图层映射非法：${gold.id}`);
    }
    assertNormalizedBox(gold.productBox, `阴影预设金标准 ${gold.id}`);
  }
  if (!Array.isArray(manifest.presets) || !manifest.presets.length) throw new Error("阴影预设包为空");
  const presetIds = new Set<string>();
  const slots = new Set<number>();
  const assignedGoldIds = new Set<string>();
  for (const preset of manifest.presets) {
    if (!preset || !SAFE_ID_PATTERN.test(preset.id ?? "") || presetIds.has(preset.id)) throw new Error("阴影预设 ID 非法或重复");
    presetIds.add(preset.id);
    if (!Number.isInteger(preset.angleSlot) || preset.angleSlot < 1 || preset.angleSlot > 6 || slots.has(preset.angleSlot)) {
      throw new Error(`阴影预设角度序号非法或重复：${preset.id}`);
    }
    slots.add(preset.angleSlot);
    if (preset.approved !== true || typeof preset.humanAngleLabel !== "string" || !preset.humanAngleLabel) {
      throw new Error(`阴影预设未批准或缺少人工角度标签：${preset.id}`);
    }
    const roi = preset.roi;
    if (!roi || ![roi.x, roi.y, roi.width, roi.height].every(isFiniteNumber)
      || ![roi.x, roi.y, roi.width, roi.height].every(Number.isInteger)
      || roi.x < 0 || roi.y < 0 || roi.width <= 0 || roi.height <= 0
      || roi.x >= 800 || roi.y >= 800 || roi.x + roi.width > 800 || roi.y + roi.height > 1600) {
      throw new Error(`阴影预设 ROI 非法：${preset.id}`);
    }
    const point = preset.whitePoint;
    if (!point || !Number.isInteger(point.x) || !Number.isInteger(point.y)
      || point.x < 0 || point.y < 0 || point.x >= 800 || point.y >= 800) {
      throw new Error(`阴影预设白场采样点非法：${preset.id}`);
    }
    if (manifest.schemaVersion === 2) {
      const scopedGoldIds = preset.goldStandardIds;
      if (!Array.isArray(scopedGoldIds) || scopedGoldIds.length < 2
        || scopedGoldIds.some((id) => typeof id !== "string" || !SAFE_ID_PATTERN.test(id))
        || new Set(scopedGoldIds).size !== scopedGoldIds.length) {
        throw new Error(`schema v2 阴影预设必须引用至少两份不同的同角度金标准：${preset.id}`);
      }
      const missingGoldIds = scopedGoldIds.filter((id) => !goldIds.has(id));
      if (missingGoldIds.length) {
        throw new Error(`阴影预设引用不存在的金标准：${preset.id} -> ${missingGoldIds.join(", ")}`);
      }
      const overlappingGoldIds = scopedGoldIds.filter((id) => assignedGoldIds.has(id));
      if (overlappingGoldIds.length) {
        throw new Error(`同一金标准不能关联多个角度预设：${overlappingGoldIds.join(", ")}`);
      }
      scopedGoldIds.forEach((id) => assignedGoldIds.add(id));
    }
  }
  if (manifest.schemaVersion === 2) {
    const unassignedGoldIds = [...goldIds].filter((id) => !assignedGoldIds.has(id));
    if (unassignedGoldIds.length) {
      throw new Error(`schema v2 金标准必须恰好关联一个角度预设：${unassignedGoldIds.join(", ")}`);
    }
  }
  if (!Array.isArray(manifest.regressionAssets) || !manifest.regressionAssets.length) {
    throw new Error("阴影预设缺少回归素材");
  }
  const assetKindsById = new Map<string, ShadowRegressionAsset["kind"]>();
  for (const asset of manifest.regressionAssets) {
    if (!asset || !SAFE_ID_PATTERN.test(asset.id ?? "") || assetKindsById.has(asset.id)) throw new Error("阴影回归素材 ID 非法或重复");
    assetKindsById.set(asset.id, asset.kind);
    if (!["input", "product", "mask", "shadow", "preview"].includes(asset.kind)) throw new Error(`阴影回归素材类型非法：${asset.id}`);
    assertSafeAssetPath(asset.file, `阴影回归素材 ${asset.id}`);
    if (!SHA256_PATTERN.test(asset.sha256 ?? "")) throw new Error(`阴影回归素材哈希非法：${asset.id}`);
  }
  const requiredAssetKinds = {
    input: "input",
    product: "product",
    "ps-mask": "mask",
    "birefnet-mask": "mask",
    shadow: "shadow",
    preview: "preview",
  } as const satisfies Record<string, ShadowRegressionAsset["kind"]>;
  const requiredAssetIds = new Set<string>();
  for (const gold of manifest.goldStandards) {
    for (const [suffix, expectedKind] of Object.entries(requiredAssetKinds)) {
      const requiredId = `${gold.id}-${suffix}`;
      requiredAssetIds.add(requiredId);
      const actualKind = assetKindsById.get(requiredId);
      if (!actualKind) {
        throw new Error(`阴影金标准缺少回归素材：${requiredId}`);
      }
      if (actualKind !== expectedKind) {
        throw new Error(`阴影金标准回归素材类型不匹配：${requiredId}`);
      }
    }
  }
  if (assetKindsById.size !== requiredAssetIds.size
    || [...assetKindsById.keys()].some((assetId) => !requiredAssetIds.has(assetId))) {
    throw new Error("阴影回归素材必须恰好覆盖每份金标准的六类固定资产");
  }
  return manifest as CalibratedShadowManifest;
}

function parseRegistry(bytes: Buffer): ShadowPresetRegistry {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")) as unknown; }
  catch { throw new Error("阴影预设 registry 不是有效 JSON"); }
  const registry = value as Partial<ShadowPresetRegistry>;
  if (registry?.schemaVersion !== 1 || !Array.isArray(registry.packages)) throw new Error("阴影预设 registry 格式错误");
  const versions = new Set<string>();
  for (const item of registry.packages) {
    if (!item || !SAFE_ID_PATTERN.test(item.version ?? "") || versions.has(item.version)
      || !SHA256_PATTERN.test(item.manifestSha256 ?? "")) throw new Error("阴影预设 registry 版本重复或非法");
    versions.add(item.version);
  }
  return registry as ShadowPresetRegistry;
}

export async function validateCalibratedShadowBundle(
  requestedRoot: string,
  version: ProductShadowPresetVersion,
  expectedManifestSha256: string,
): Promise<LoadedCalibratedShadowBundle> {
  const root = await realpath(requestedRoot);
  const manifestBytes = await readFile(path.join(root, "manifest.json"));
  const manifestSha256 = calibratedShadowManifestSha256(manifestBytes);
  if (manifestSha256 !== expectedManifestSha256) throw new Error(`阴影预设 manifest 哈希不匹配：${version}`);
  const manifest = parseCalibratedShadowManifest(manifestBytes, version);
  for (const asset of manifest.regressionAssets) {
    const candidate = path.resolve(root, asset.file);
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw new Error(`阴影回归素材路径越界：${asset.id}`);
    const actual = await realpath(candidate);
    if (actual !== root && !actual.startsWith(`${root}${path.sep}`)) throw new Error(`阴影回归素材路径越界：${asset.id}`);
    if (sha256(await readFile(actual)) !== asset.sha256) throw new Error(`阴影回归素材哈希不匹配：${asset.id}`);
  }
  return { ...manifest, root, manifestSha256 };
}

/** Loads an immutable preset package and verifies both its registry pin and every regression asset. */
export async function loadCalibratedShadowBundle(
  version: ProductShadowPresetVersion = DEFAULT_SHADOW_PRESET_VERSION,
): Promise<LoadedCalibratedShadowBundle> {
  const registry = parseRegistry(await readFile(registryPath()));
  const pinned = registry.packages.find((item) => item.version === version);
  if (!pinned) throw new Error(`阴影预设未注册：${version}`);
  return validateCalibratedShadowBundle(presetRoot(version), version, pinned.manifestSha256);
}

function lastNumericToken(file: string): number | undefined {
  const matches = path.parse(file).name.match(/\d+/gu);
  if (!matches?.length) return undefined;
  const value = Number(matches.at(-1));
  return Number.isSafeInteger(value) ? value : undefined;
}

/** Assigns presets only when each colour group is an unambiguous, strictly increasing six-frame set. */
export function buildCalibratedShadowAssignments(
  colors: readonly { members: readonly { path: string }[] }[],
  presets: readonly CalibratedShadowPreset[],
): Map<string, ShadowAngleAssignment> {
  const bySlot = new Map(presets.filter((preset) => preset.approved).map((preset) => [preset.angleSlot, preset]));
  const assignments = new Map<string, ShadowAngleAssignment>();
  for (const color of colors) {
    if (color.members.length !== 6) {
      for (const member of color.members) assignments.set(member.path, { fallbackReason: `颜色组不是标准六角度（实际 ${color.members.length} 张）` });
      continue;
    }
    const tokens = color.members.map((member) => lastNumericToken(member.path));
    const firstToken = tokens[0];
    const consecutive = firstToken !== undefined
      && tokens.every((token, index) => token !== undefined && token === firstToken + index);
    if (!consecutive) {
      for (const member of color.members) assignments.set(member.path, { fallbackReason: "颜色组文件数字顺序缺失、不连续、乱序或重复" });
      continue;
    }
    color.members.forEach((member, index) => {
      const angleSlot = index + 1;
      const preset = bySlot.get(angleSlot);
      assignments.set(member.path, preset
        ? { angleSlot, presetId: preset.id }
        : { angleSlot, fallbackReason: `组内序号 ${angleSlot} 暂无批准的阴影预设` });
    });
  }
  return assignments;
}

/** Scales one 800-reference coordinate to any square delivery side. */
export function scaleReferenceCoordinate(value: number, side: number): number {
  if (!Number.isInteger(side) || side <= 0) throw new Error("主图边长非法");
  return Math.round((value * side) / 800);
}

export function scaleAndClipReferenceRect(rect: ReferenceRect, side: number): ReferenceRect {
  const x = scaleReferenceCoordinate(rect.x, side);
  const y = scaleReferenceCoordinate(rect.y, side);
  const right = Math.min(side, scaleReferenceCoordinate(rect.x + rect.width, side));
  const bottom = Math.min(side, scaleReferenceCoordinate(rect.y + rect.height, side));
  if (x < 0 || y < 0 || x >= side || y >= side || right <= x || bottom <= y) throw new Error("阴影 ROI 缩放后完全越出画布");
  return { x, y, width: right - x, height: bottom - y };
}

export function applyLevelsChannel(value: number, whitePoint: number): number {
  return Math.min(255, Math.round((value * 255) / whitePoint));
}

function boxFromMask(data: Buffer, width: number, height: number, channels: number): NormalizedBox {
  let left = width; let top = height; let right = -1; let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * channels] < MASK_BOUNDS_THRESHOLD) continue;
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  if (right < 0) throw new Error("BiRefNet 商品蒙版为空");
  return { left: left / width, top: top / height, width: (right - left + 1) / width, height: (bottom - top + 1) / height };
}

function boxMatchesGold(box: NormalizedBox, gold: NormalizedBox, tolerance: number): boolean {
  return (Object.keys(box) as (keyof NormalizedBox)[]).every((key) => Math.abs(box[key] - gold[key]) <= tolerance);
}

function resolveBundlePreset(
  bundle: LoadedCalibratedShadowBundle,
  requested: CalibratedShadowPreset,
): CalibratedShadowPreset {
  const preset = bundle.presets.find((candidate) => (
    candidate.id === requested.id && candidate.angleSlot === requested.angleSlot
  ));
  if (!preset) throw new Error(`阴影预设不属于当前固定包：${requested.id} / slot ${requested.angleSlot}`);
  return preset;
}

function goldStandardsForPreset(
  bundle: LoadedCalibratedShadowBundle,
  preset: CalibratedShadowPreset,
): ShadowGoldStandard[] {
  if (bundle.schemaVersion === 1) return bundle.goldStandards;
  const scopedPreset = bundle.presets.find((candidate) => (
    candidate.id === preset.id && candidate.angleSlot === preset.angleSlot
  ));
  if (!scopedPreset) throw new Error(`阴影预设不属于当前 schema v2 固定包：${preset.id}`);
  const scopedIds = new Set(scopedPreset.goldStandardIds);
  const standards = bundle.goldStandards.filter((gold) => scopedIds.has(gold.id));
  if (standards.length !== scopedIds.size) throw new Error(`阴影预设的同角度金标准不完整：${preset.id}`);
  return standards;
}

/** Native implementation of the approved Photoshop ROI + per-channel Levels recipe. */
export async function composeCalibratedShadowMain(
  v1Image: Buffer,
  maskImage: Buffer,
  bundle: LoadedCalibratedShadowBundle,
  preset: CalibratedShadowPreset,
): Promise<CalibratedShadowRenderResult> {
  const activePreset = resolveBundlePreset(bundle, preset);
  const [imageMeta, maskMeta] = await Promise.all([sharp(v1Image).metadata(), sharp(maskImage).metadata()]);
  const side = imageMeta.width;
  if (!side || imageMeta.height !== side) throw new Error("V1 主图不是方图");
  if (maskMeta.width !== side || maskMeta.height !== side) throw new Error("BiRefNet 蒙版尺寸与 V1 主图不符");
  const [{ data: rgb, info: rgbInfo }, { data: mask, info: maskInfo }] = await Promise.all([
    sharp(v1Image).removeAlpha().toColorspace("srgb").raw().toBuffer({ resolveWithObject: true }),
    sharp(maskImage).toColorspace("b-w").raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (rgbInfo.channels < 3) throw new Error("V1 主图没有 RGB 通道");
  const sampleX = scaleReferenceCoordinate(activePreset.whitePoint.x, side);
  const sampleY = scaleReferenceCoordinate(activePreset.whitePoint.y, side);
  if (sampleX >= side || sampleY >= side) throw new Error("白场采样点缩放后越出画布");
  const sampleOffset = (sampleY * side + sampleX) * rgbInfo.channels;
  const sampledRgb: [number, number, number] = [rgb[sampleOffset], rgb[sampleOffset + 1], rgb[sampleOffset + 2]];
  const { whitePointMin, whitePointMax, whitePointMaxChannelSpread, productBoxTolerance } = bundle.gates;
  if (sampledRgb.some((value) => value < whitePointMin || value > whitePointMax)
    || Math.max(...sampledRgb) - Math.min(...sampledRgb) > whitePointMaxChannelSpread) {
    throw new Error(`白场采样未通过门禁：RGB ${sampledRgb.join("/")}`);
  }
  const maskSample = mask[(sampleY * side + sampleX) * maskInfo.channels];
  if (maskSample !== 0) throw new Error(`白场采样点落入商品蒙版：alpha ${maskSample}`);
  const productBox = boxFromMask(mask, side, side, maskInfo.channels);
  const presetGoldStandards = goldStandardsForPreset(bundle, activePreset);
  if (!presetGoldStandards.some((gold) => boxMatchesGold(productBox, gold.productBox, productBoxTolerance))) {
    throw new Error(`商品框超出预设 ${activePreset.id} 的同角度金标准 ±${productBoxTolerance * 100}% 容差`);
  }

  const roi = scaleAndClipReferenceRect(activePreset.roi, side);
  const plate = Buffer.alloc(roi.width * roi.height * 3);
  for (let y = 0; y < roi.height; y += 1) {
    for (let x = 0; x < roi.width; x += 1) {
      const inputOffset = ((roi.y + y) * side + roi.x + x) * rgbInfo.channels;
      const outputOffset = (y * roi.width + x) * 3;
      plate[outputOffset] = applyLevelsChannel(rgb[inputOffset], sampledRgb[0]);
      plate[outputOffset + 1] = applyLevelsChannel(rgb[inputOffset + 1], sampledRgb[1]);
      plate[outputOffset + 2] = applyLevelsChannel(rgb[inputOffset + 2], sampledRgb[2]);
    }
  }
  const alpha = Buffer.alloc(side * side);
  for (let index = 0; index < alpha.length; index += 1) alpha[index] = mask[index * maskInfo.channels];
  const product = Buffer.alloc(side * side * 4);
  for (let index = 0; index < alpha.length; index += 1) {
    const rgbOffset = index * rgbInfo.channels;
    const rgbaOffset = index * 4;
    product[rgbaOffset] = rgb[rgbOffset];
    product[rgbaOffset + 1] = rgb[rgbOffset + 1];
    product[rgbaOffset + 2] = rgb[rgbOffset + 2];
    product[rgbaOffset + 3] = alpha[index];
  }
  const image = await sharp({ create: { width: side, height: side, channels: 3, background: "#ffffff" } })
    .composite([
      { input: plate, raw: { width: roi.width, height: roi.height, channels: 3 }, left: roi.x, top: roi.y },
      { input: product, raw: { width: side, height: side, channels: 4 }, left: 0, top: 0 },
    ])
    .removeAlpha()
    .png()
    .toBuffer();
  const metadata = await sharp(image).metadata();
  if (metadata.hasAlpha) throw new Error("V2 输出意外包含透明通道");
  const { data: output, info: outputInfo } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const index = y * side + x;
      const outputOffset = index * outputInfo.channels;
      const inputOffset = index * rgbInfo.channels;
      if (alpha[index] === 255
        && (output[outputOffset] !== rgb[inputOffset]
          || output[outputOffset + 1] !== rgb[inputOffset + 1]
          || output[outputOffset + 2] !== rgb[inputOffset + 2])) {
        throw new Error("商品不透明核心像素发生变化");
      }
      const outsideRoi = x < roi.x || x >= roi.x + roi.width || y < roi.y || y >= roi.y + roi.height;
      if (alpha[index] === 0 && outsideRoi
        && (output[outputOffset] !== 255 || output[outputOffset + 1] !== 255 || output[outputOffset + 2] !== 255)) {
        throw new Error("商品和 ROI 以外不是纯白");
      }
    }
  }
  return { image, sampledRgb, productBox };
}
