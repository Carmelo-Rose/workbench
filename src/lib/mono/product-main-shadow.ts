import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { isProductShadowPresetVersion, type ProductMainImageVersion, type ProductShadowPresetVersion } from "./contracts";

export const DEFAULT_MAIN_IMAGE_VERSION: ProductMainImageVersion = "whitefield-v1";
export const CALIBRATED_SHADOW_MAIN_IMAGE_VERSION: ProductMainImageVersion = "calibrated-shadow-v2";
export const DEFAULT_SHADOW_PRESET_VERSION: ProductShadowPresetVersion = "hat-ps-shadow-v2.1";

export const BIREFNET_MODEL_ID = "ZhengPeng7/BiRefNet_HR-matting";
export const BIREFNET_MODEL_REVISION = "5d6b6f8adcb5b417c871b1d84ceaae9871355b7f";
export const BIREFNET_WEIGHTS_SHA256 = "a5a4de698739ea5e0e8bbab28e1b293dde95092b87a442d566cbc585c53cef55";
/**
 * A deliberately non-production identity for controlled calibration work.
 * It is never part of ProductShadowPresetVersion, the production registry, or
 * the runtime loader.
 */
export const SLOT_4_DEVELOPMENT_IDENTITY = "slot-4-development" as const;
export type CandidateShadowManifestVersion = ProductShadowPresetVersion | typeof SLOT_4_DEVELOPMENT_IDENTITY;

const HISTORICAL_MAIN_IMAGE_VERSIONS = new Set(["refined-shadow-v2", "template-shadow-v2"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9.-]*$/u;
const MASK_BOUNDS_THRESHOLD = 128;

export const ADAPTIVE_WHITE_SAMPLE_POLICY: AdaptiveWhiteSamplePolicy = Object.freeze({
  referencePatchSize: 31,
  minimumPatchPassRate: 0.95,
  minimumMaskDistance: 32,
  minimumEdgeDistance: 16,
  rgbMin: 220,
  rgbMax: 245,
  maxChannelSpread: 8,
  targetMean: 240,
  selectionOrder: Object.freeze([
    "patch-pass-rate-desc",
    "mask-distance-desc",
    "mean-distance-to-240-asc",
    "y-asc",
    "x-asc",
  ] as const),
  median: "per-channel-median-of-valid-patch-pixels",
});

export type ReferencePoint = { x: number; y: number };
export type ReferenceRect = { x: number; y: number; width: number; height: number };
export type NormalizedBox = { left: number; top: number; width: number; height: number };

type CalibratedShadowPresetBase = {
  id: string;
  angleSlot: number;
  humanAngleLabel: string;
  approved: boolean;
  roi: ReferenceRect;
};

export type LegacyCalibratedShadowPreset = CalibratedShadowPresetBase & {
  approved: true;
  whitePoint: ReferencePoint;
  goldStandardIds?: never;
};

export type ScopedCalibratedShadowPreset = CalibratedShadowPresetBase & {
  approved: true;
  whitePoint: ReferencePoint;
  goldStandardIds: string[];
};

export type AdaptiveWhiteSamplePolicy = {
  referencePatchSize: 31;
  minimumPatchPassRate: 0.95;
  minimumMaskDistance: 32;
  minimumEdgeDistance: 16;
  rgbMin: 220;
  rgbMax: 245;
  maxChannelSpread: 8;
  targetMean: 240;
  selectionOrder: readonly [
    "patch-pass-rate-desc",
    "mask-distance-desc",
    "mean-distance-to-240-asc",
    "y-asc",
    "x-asc",
  ];
  median: "per-channel-median-of-valid-patch-pixels";
};

export type AdaptiveCalibratedShadowPreset = CalibratedShadowPresetBase & {
  goldStandardIds: string[];
  whiteSamplePolicy: AdaptiveWhiteSamplePolicy;
  whitePoint?: never;
};

export type CalibratedShadowPreset = LegacyCalibratedShadowPreset | ScopedCalibratedShadowPreset | AdaptiveCalibratedShadowPreset;

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
  version: CandidateShadowManifestVersion;
  canvas: { width: number; height: number };
  algorithm: {
    id: "ps-levels-roi-v1" | "ps-levels-roi-v2-adaptive-white";
    levels: "round(value*255/whitePoint)-clamp-255" | "round(value*255/channelMedian)-clamp-255";
  };
  biRefNet: { modelId: string; revision: string; weightsSha256: string };
  gates: {
    whitePointMin: number;
    whitePointMax: number;
    whitePointMaxChannelSpread: number;
    productBoxTolerance: number;
    roiBoundaryMaxChannelJump?: number;
    detachedResidueMinArea?: number;
    residueThreshold?: number;
    legalShadowMaskNeighborhood?: number;
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

export type AdaptiveCalibratedShadowManifest = CalibratedShadowManifestBase & {
  schemaVersion: 3;
  candidateOnly: boolean;
  releaseState: "approved" | "awaiting-human-approval";
  approved: boolean;
  publicationAllowed: boolean;
  presets: Array<ScopedCalibratedShadowPreset | AdaptiveCalibratedShadowPreset>;
};

export type CalibratedShadowManifest = LegacyCalibratedShadowManifest | ScopedCalibratedShadowManifest | AdaptiveCalibratedShadowManifest;

type UncheckedCalibratedShadowManifest = CalibratedShadowManifestBase & {
  schemaVersion: 1 | 2 | 3;
  candidateOnly?: unknown;
  releaseState?: unknown;
  approved?: unknown;
  publicationAllowed?: unknown;
  developmentIdentity?: unknown;
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
  sampledPoint: ReferencePoint;
  sampledPointRgb: [number, number, number];
  sampledRgb: [number, number, number];
  sampledPatchPassRate: number;
  sampledMaskDistance: number;
  productBox: NormalizedBox;
  qualityGates: {
    roiBoundary: { passed: boolean; maxChannelJump: number; limit: number };
    detachedBackgroundResidue: { passed: boolean; largestDetachedArea: number; minimumFailingArea: number };
    opaqueProductCore: { passed: boolean };
    outsideProductAndRoiWhite: { passed: boolean };
    outputOpaqueRgb: { passed: boolean };
  };
};

export function isCandidateShadowManifestVersion(value: unknown): value is CandidateShadowManifestVersion {
  return value === SLOT_4_DEVELOPMENT_IDENTITY || isProductShadowPresetVersion(value);
}

type ShadowPresetRegistry = {
  schemaVersion: 1;
  packages: { version: CandidateShadowManifestVersion; manifestSha256: string }[];
  developmentIdentity?: unknown;
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
  expectedVersion: CandidateShadowManifestVersion,
  mode: "runtime" | "candidate" = "runtime",
): CalibratedShadowManifest {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")) as unknown; }
  catch { throw new Error("阴影预设 manifest 不是有效 JSON"); }
  if (!value || typeof value !== "object") throw new Error("阴影预设 manifest 格式错误");
  const manifest = value as Partial<UncheckedCalibratedShadowManifest>;
  if (![1, 2, 3].includes(manifest.schemaVersion ?? -1) || manifest.version !== expectedVersion) {
    throw new Error("阴影预设版本不匹配");
  }
  const expectedSchemaVersion = expectedVersion === "hat-ps-shadow-v2.1" ? 1
    : expectedVersion === "hat-ps-shadow-v2.4" || expectedVersion === "hat-ps-shadow-v2.5" ? 3 : 2;
  const candidateDevelopmentIdentity = expectedVersion === SLOT_4_DEVELOPMENT_IDENTITY;
  if (candidateDevelopmentIdentity && mode !== "candidate") {
    throw new Error("开发身份不得进入生产运行时");
  }
  if (candidateDevelopmentIdentity && manifest.developmentIdentity !== SLOT_4_DEVELOPMENT_IDENTITY) {
    throw new Error("开发候选 manifest 必须显式声明 slot-4-development 身份");
  }
  const resolvedSchemaVersion = candidateDevelopmentIdentity ? 3 : expectedSchemaVersion;
  if (manifest.schemaVersion !== resolvedSchemaVersion) {
    throw new Error(`阴影预设 ${expectedVersion} 必须使用 schema v${resolvedSchemaVersion}`);
  }
  if (manifest.schemaVersion >= 2) {
    const validReleaseState = mode === "runtime"
      ? manifest.candidateOnly === false && manifest.releaseState === "approved"
        && manifest.approved === true && manifest.publicationAllowed === true
      : manifest.candidateOnly === true && manifest.releaseState === "awaiting-human-approval"
        && manifest.approved === false && manifest.publicationAllowed === false;
    if (!validReleaseState) {
      throw new Error(mode === "runtime"
        ? `schema v${manifest.schemaVersion} 阴影预设必须显式批准发布，候选包不得进入运行时`
        : `schema v${manifest.schemaVersion} 候选预演只接受 awaiting-human-approval / approved=false / publicationAllowed=false`);
    }
  }
  if (manifest.canvas?.width !== 800 || manifest.canvas.height !== 800) throw new Error("阴影预设参考画布必须是 800×800");
  const validAlgorithm = manifest.schemaVersion === 3
    ? manifest.algorithm?.id === "ps-levels-roi-v2-adaptive-white"
      && manifest.algorithm.levels === "round(value*255/channelMedian)-clamp-255"
    : manifest.algorithm?.id === "ps-levels-roi-v1"
      && manifest.algorithm.levels === "round(value*255/whitePoint)-clamp-255";
  if (!validAlgorithm) {
    throw new Error("阴影预设算法非法");
  }
  if (manifest.biRefNet?.modelId !== BIREFNET_MODEL_ID
    || manifest.biRefNet.revision !== BIREFNET_MODEL_REVISION
    || manifest.biRefNet.weightsSha256 !== BIREFNET_WEIGHTS_SHA256) {
    throw new Error("阴影预设 BiRefNet 版本或权重哈希不匹配");
  }
  const gates = manifest.gates;
  if (!gates || gates.whitePointMin !== 220 || gates.whitePointMax !== 245
    || gates.whitePointMaxChannelSpread !== 8 || gates.productBoxTolerance !== 0.05
    || (manifest.schemaVersion === 3 && (gates.roiBoundaryMaxChannelJump !== 5
      || gates.detachedResidueMinArea !== 64 || gates.residueThreshold !== 2
      || gates.legalShadowMaskNeighborhood !== 16))) {
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
  let unapprovedCandidatePresets = 0;
  for (const preset of manifest.presets) {
    if (!preset || !SAFE_ID_PATTERN.test(preset.id ?? "") || presetIds.has(preset.id)) throw new Error("阴影预设 ID 非法或重复");
    presetIds.add(preset.id);
    if (!Number.isInteger(preset.angleSlot) || preset.angleSlot < 1 || preset.angleSlot > 6 || slots.has(preset.angleSlot)) {
      throw new Error(`阴影预设角度序号非法或重复：${preset.id}`);
    }
    slots.add(preset.angleSlot);
    const validPresetApproval = manifest.schemaVersion === 3 && mode === "candidate"
      ? typeof preset.approved === "boolean" : preset.approved === true;
    if (!validPresetApproval || typeof preset.humanAngleLabel !== "string" || !preset.humanAngleLabel) {
      throw new Error(`阴影预设未批准或缺少人工角度标签：${preset.id}`);
    }
    if (manifest.schemaVersion === 3 && mode === "candidate" && preset.approved === false) unapprovedCandidatePresets += 1;
    const roi = preset.roi;
    if (!roi || ![roi.x, roi.y, roi.width, roi.height].every(isFiniteNumber)
      || ![roi.x, roi.y, roi.width, roi.height].every(Number.isInteger)
      || roi.x < 0 || roi.y < 0 || roi.width <= 0 || roi.height <= 0
      || roi.x >= 800 || roi.y >= 800 || roi.x + roi.width > 800 || roi.y + roi.height > 1600) {
      throw new Error(`阴影预设 ROI 非法：${preset.id}`);
    }
    if (manifest.schemaVersion === 3 && "whiteSamplePolicy" in preset) {
      const adaptive = preset as Partial<AdaptiveCalibratedShadowPreset> & { whitePoint?: unknown };
      if (adaptive.whitePoint !== undefined
        || JSON.stringify(adaptive.whiteSamplePolicy) !== JSON.stringify(ADAPTIVE_WHITE_SAMPLE_POLICY)) {
        throw new Error(`schema v3 阴影预设必须使用不可变自适应白场策略：${preset.id}`);
      }
    } else {
      const fixed = preset as Partial<ScopedCalibratedShadowPreset> & { whiteSamplePolicy?: unknown };
      const point = fixed.whitePoint;
      if (fixed.whiteSamplePolicy !== undefined || !point || !Number.isInteger(point.x) || !Number.isInteger(point.y)
        || point.x < 0 || point.y < 0 || point.x >= 800 || point.y >= 800) {
        throw new Error(`阴影预设白场采样点非法：${preset.id}`);
      }
    }
    if (manifest.schemaVersion >= 2) {
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
  if (manifest.schemaVersion >= 2) {
    const unassignedGoldIds = [...goldIds].filter((id) => !assignedGoldIds.has(id));
    if (unassignedGoldIds.length) {
      throw new Error(`schema v2 金标准必须恰好关联一个角度预设：${unassignedGoldIds.join(", ")}`);
    }
  }
  if (manifest.schemaVersion === 3 && mode === "candidate" && unapprovedCandidatePresets === 0) {
    throw new Error("schema v3 候选包必须至少包含一个未批准预设");
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

async function validateCalibratedShadowBundleMode(
  requestedRoot: string,
  version: CandidateShadowManifestVersion,
  expectedManifestSha256: string,
  mode: "runtime" | "candidate",
): Promise<LoadedCalibratedShadowBundle> {
  const root = await realpath(requestedRoot);
  const manifestBytes = await readFile(path.join(root, "manifest.json"));
  const manifestSha256 = calibratedShadowManifestSha256(manifestBytes);
  if (manifestSha256 !== expectedManifestSha256) throw new Error(`阴影预设 manifest 哈希不匹配：${version}`);
  const manifest = parseCalibratedShadowManifest(manifestBytes, version, mode);
  for (const asset of manifest.regressionAssets) {
    const candidate = path.resolve(root, asset.file);
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw new Error(`阴影回归素材路径越界：${asset.id}`);
    const actual = await realpath(candidate);
    if (actual !== root && !actual.startsWith(`${root}${path.sep}`)) throw new Error(`阴影回归素材路径越界：${asset.id}`);
    if (sha256(await readFile(actual)) !== asset.sha256) throw new Error(`阴影回归素材哈希不匹配：${asset.id}`);
  }
  return { ...manifest, root, manifestSha256 };
}

export async function validateCalibratedShadowBundle(
  requestedRoot: string,
  version: ProductShadowPresetVersion,
  expectedManifestSha256: string,
): Promise<LoadedCalibratedShadowBundle> {
  return validateCalibratedShadowBundleMode(requestedRoot, version, expectedManifestSha256, "runtime");
}

/** Candidate-only loader used by the controlled preview command. It cannot make a package publishable. */
export async function loadCandidateCalibratedShadowBundle(
  requestedRoot: string,
  version: CandidateShadowManifestVersion,
): Promise<LoadedCalibratedShadowBundle> {
  if (version !== SLOT_4_DEVELOPMENT_IDENTITY && version !== "hat-ps-shadow-v2.4") {
    throw new Error("受控候选加载器仅接受显式开发身份或当前待审候选版本");
  }
  const root = await realpath(requestedRoot);
  const registry = parseRegistry(await readFile(path.join(root, "candidate-registry.json")));
  if (version === SLOT_4_DEVELOPMENT_IDENTITY && registry.developmentIdentity !== SLOT_4_DEVELOPMENT_IDENTITY) {
    throw new Error("候选 registry 必须显式声明 slot-4-development 身份");
  }
  if (registry.packages.length !== 1 || registry.packages[0].version !== version) {
    throw new Error(`候选 registry 必须只固定精确版本：${version}`);
  }
  return validateCalibratedShadowBundleMode(root, version, registry.packages[0].manifestSha256, "candidate");
}

/** Loads an immutable preset package and verifies both its registry pin and every regression asset. */
export async function loadCalibratedShadowBundle(
  version: ProductShadowPresetVersion = DEFAULT_SHADOW_PRESET_VERSION,
): Promise<LoadedCalibratedShadowBundle> {
  if (!isProductShadowPresetVersion(version)) throw new Error("生产加载器拒绝开发身份");
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

function scaleOddReferenceSize(value: number, side: number): number {
  let scaled = Math.max(1, scaleReferenceCoordinate(value, side));
  if (scaled % 2 === 0) scaled += 1;
  return scaled;
}

function squaredDistanceTransform1d(values: Float64Array): Float64Array {
  const size = values.length;
  const sites: number[] = [];
  for (let index = 0; index < size; index += 1) {
    if (Number.isFinite(values[index])) sites.push(index);
  }
  const output = new Float64Array(size);
  if (!sites.length) {
    output.fill(Number.POSITIVE_INFINITY);
    return output;
  }
  const envelope = new Int32Array(sites.length);
  const boundaries = new Float64Array(sites.length + 1);
  let last = 0;
  envelope[0] = sites[0];
  boundaries[0] = Number.NEGATIVE_INFINITY;
  boundaries[1] = Number.POSITIVE_INFINITY;
  for (let siteIndex = 1; siteIndex < sites.length; siteIndex += 1) {
    const site = sites[siteIndex];
    let previous = envelope[last];
    let intersection = ((values[site] + site * site) - (values[previous] + previous * previous))
      / (2 * (site - previous));
    while (last > 0 && intersection <= boundaries[last]) {
      last -= 1;
      previous = envelope[last];
      intersection = ((values[site] + site * site) - (values[previous] + previous * previous))
        / (2 * (site - previous));
    }
    last += 1;
    envelope[last] = site;
    boundaries[last] = intersection;
    boundaries[last + 1] = Number.POSITIVE_INFINITY;
  }
  let envelopeIndex = 0;
  for (let coordinate = 0; coordinate < size; coordinate += 1) {
    while (boundaries[envelopeIndex + 1] < coordinate) envelopeIndex += 1;
    const site = envelope[envelopeIndex];
    const delta = coordinate - site;
    output[coordinate] = delta * delta + values[site];
  }
  return output;
}

function productDistances(mask: Buffer, width: number, height: number, channels: number): Float64Array {
  const horizontal = new Float64Array(width * height);
  const row = new Float64Array(width);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) row[x] = mask[(y * width + x) * channels] > 0 ? 0 : Number.POSITIVE_INFINITY;
    horizontal.set(squaredDistanceTransform1d(row), y * width);
  }
  const result = new Float64Array(width * height);
  const column = new Float64Array(height);
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) column[y] = horizontal[y * width + x];
    const transformed = squaredDistanceTransform1d(column);
    for (let y = 0; y < height; y += 1) result[y * width + x] = Math.sqrt(transformed[y]);
  }
  return result;
}

function integralMask(values: Uint8Array, width: number, height: number): Int32Array {
  const stride = width + 1;
  const integral = new Int32Array(stride * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    for (let x = 0; x < width; x += 1) {
      rowSum += values[y * width + x];
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + rowSum;
    }
  }
  return integral;
}

function integralRectSum(integral: Int32Array, width: number, left: number, top: number, right: number, bottom: number): number {
  const stride = width + 1;
  return integral[bottom * stride + right] - integral[top * stride + right]
    - integral[bottom * stride + left] + integral[top * stride + left];
}

function medianByte(values: number[]): number {
  values.sort((first, second) => first - second);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1 ? values[middle] : Math.round((values[middle - 1] + values[middle]) / 2);
}

export type AdaptiveWhiteSample = {
  point: ReferencePoint;
  pointRgb: [number, number, number];
  medianRgb: [number, number, number];
  patchPassRate: number;
  maskDistance: number;
  patchSize: number;
  validPixelCount: number;
};

export function selectAdaptiveWhiteSample(
  rgb: Buffer,
  rgbChannels: number,
  mask: Buffer,
  maskChannels: number,
  side: number,
  roi: ReferenceRect,
  policy: AdaptiveWhiteSamplePolicy = ADAPTIVE_WHITE_SAMPLE_POLICY,
): AdaptiveWhiteSample {
  const patchSize = scaleOddReferenceSize(policy.referencePatchSize, side);
  const radius = Math.floor(patchSize / 2);
  const minimumMaskDistance = scaleReferenceCoordinate(policy.minimumMaskDistance, side);
  const minimumEdgeDistance = scaleReferenceCoordinate(policy.minimumEdgeDistance, side);
  const distances = productDistances(mask, side, side, maskChannels);
  const baseValid = new Uint8Array(side * side);
  const roiRight = roi.x + roi.width;
  const roiBottom = roi.y + roi.height;
  for (let y = roi.y; y < roiBottom; y += 1) {
    for (let x = roi.x; x < roiRight; x += 1) {
      const index = y * side + x;
      const offset = index * rgbChannels;
      const values = [rgb[offset], rgb[offset + 1], rgb[offset + 2]];
      const edgeDistance = Math.min(x - roi.x, roiRight - 1 - x, y - roi.y, roiBottom - 1 - y, x, side - 1 - x, y, side - 1 - y);
      if (mask[index * maskChannels] === 0 && distances[index] >= minimumMaskDistance
        && edgeDistance >= minimumEdgeDistance
        && values.every((value) => value >= policy.rgbMin && value <= policy.rgbMax)
        && Math.max(...values) - Math.min(...values) <= policy.maxChannelSpread) {
        baseValid[index] = 1;
      }
    }
  }
  const integral = integralMask(baseValid, side, side);
  const patchArea = patchSize * patchSize;
  let best: { x: number; y: number; validCount: number; maskDistance: number; meanDistance: number } | undefined;
  for (let y = roi.y + minimumEdgeDistance; y < roiBottom - minimumEdgeDistance; y += 1) {
    for (let x = roi.x + minimumEdgeDistance; x < roiRight - minimumEdgeDistance; x += 1) {
      const index = y * side + x;
      if (!baseValid[index]) continue;
      const validCount = integralRectSum(integral, side, x - radius, y - radius, x + radius + 1, y + radius + 1);
      if (validCount / patchArea < policy.minimumPatchPassRate) continue;
      const offset = index * rgbChannels;
      const mean = (rgb[offset] + rgb[offset + 1] + rgb[offset + 2]) / 3;
      const candidate = { x, y, validCount, maskDistance: distances[index], meanDistance: Math.abs(mean - policy.targetMean) };
      if (!best || candidate.validCount > best.validCount
        || (candidate.validCount === best.validCount && candidate.maskDistance > best.maskDistance)
        || (candidate.validCount === best.validCount && candidate.maskDistance === best.maskDistance && candidate.meanDistance < best.meanDistance)
        || (candidate.validCount === best.validCount && candidate.maskDistance === best.maskDistance && candidate.meanDistance === best.meanDistance
          && (candidate.y < best.y || (candidate.y === best.y && candidate.x < best.x)))) {
        best = candidate;
      }
    }
  }
  if (!best) throw new Error("自适应白场采样失败：ROI 内没有通过距离、边缘、RGB 和 31×31 稳定率门禁的区域");
  const channels: [number[], number[], number[]] = [[], [], []];
  for (let y = best.y - radius; y <= best.y + radius; y += 1) {
    for (let x = best.x - radius; x <= best.x + radius; x += 1) {
      if (!baseValid[y * side + x]) continue;
      const offset = (y * side + x) * rgbChannels;
      channels[0].push(rgb[offset]); channels[1].push(rgb[offset + 1]); channels[2].push(rgb[offset + 2]);
    }
  }
  const pointOffset = (best.y * side + best.x) * rgbChannels;
  return {
    point: { x: best.x, y: best.y },
    pointRgb: [rgb[pointOffset], rgb[pointOffset + 1], rgb[pointOffset + 2]],
    medianRgb: [medianByte(channels[0]), medianByte(channels[1]), medianByte(channels[2])],
    patchPassRate: best.validCount / patchArea,
    maskDistance: best.maskDistance,
    patchSize,
    validPixelCount: best.validCount,
  };
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

function roiBoundaryMaxChannelJump(
  output: Buffer,
  outputChannels: number,
  mask: Buffer,
  maskChannels: number,
  side: number,
  roi: ReferenceRect,
): number {
  let maximum = 0;
  const compare = (firstX: number, firstY: number, secondX: number, secondY: number): void => {
    const firstIndex = firstY * side + firstX;
    const secondIndex = secondY * side + secondX;
    if (mask[firstIndex * maskChannels] !== 0 || mask[secondIndex * maskChannels] !== 0) return;
    const firstOffset = firstIndex * outputChannels;
    const secondOffset = secondIndex * outputChannels;
    for (let channel = 0; channel < 3; channel += 1) {
      maximum = Math.max(maximum, Math.abs(output[firstOffset + channel] - output[secondOffset + channel]));
    }
  };
  const right = roi.x + roi.width;
  const bottom = roi.y + roi.height;
  if (roi.y > 0) for (let x = roi.x; x < right; x += 1) compare(x, roi.y - 1, x, roi.y);
  if (bottom < side) for (let x = roi.x; x < right; x += 1) compare(x, bottom - 1, x, bottom);
  if (roi.x > 0) for (let y = roi.y; y < bottom; y += 1) compare(roi.x - 1, y, roi.x, y);
  if (right < side) for (let y = roi.y; y < bottom; y += 1) compare(right - 1, y, right, y);
  return maximum;
}

function largestDetachedResidue(
  output: Buffer,
  outputChannels: number,
  mask: Buffer,
  maskChannels: number,
  side: number,
  residueThreshold: number,
  legalNeighborhood: number,
): number {
  const distances = productDistances(mask, side, side, maskChannels);
  const visited = new Uint8Array(side * side);
  const queue = new Int32Array(side * side);
  let largest = 0;
  const isResidue = (index: number): boolean => {
    if (mask[index * maskChannels] !== 0) return false;
    const offset = index * outputChannels;
    return 255 - Math.min(output[offset], output[offset + 1], output[offset + 2]) >= residueThreshold;
  };
  for (let start = 0; start < side * side; start += 1) {
    if (visited[start] || !isResidue(start)) continue;
    let head = 0; let tail = 1; let area = 0; let touchesProductNeighborhood = false;
    queue[0] = start;
    visited[start] = 1;
    while (head < tail) {
      const index = queue[head]; head += 1; area += 1;
      if (distances[index] <= legalNeighborhood) touchesProductNeighborhood = true;
      const x = index % side;
      const y = Math.floor(index / side);
      for (let deltaY = -1; deltaY <= 1; deltaY += 1) {
        for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
          if (deltaX === 0 && deltaY === 0) continue;
          const nextX = x + deltaX; const nextY = y + deltaY;
          if (nextX < 0 || nextY < 0 || nextX >= side || nextY >= side) continue;
          const next = nextY * side + nextX;
          if (!visited[next] && isResidue(next)) {
            visited[next] = 1;
            queue[tail] = next;
            tail += 1;
          }
        }
      }
    }
    if (!touchesProductNeighborhood) largest = Math.max(largest, area);
  }
  return largest;
}

/**
 * Turn only already-failing detached background components pure white.
 *
 * The fixed residue threshold, minimum area, and product neighborhood remain
 * inputs from the immutable v3 gate policy.  Components connected to the
 * product neighborhood are never edited, so the contact shadow bytes survive
 * unchanged.  The quality gate is still evaluated again after purification.
 */
export function purifyDetachedBackgroundResidue(
  output: Buffer,
  outputChannels: number,
  mask: Buffer,
  maskChannels: number,
  side: number,
  residueThreshold: number,
  minimumArea: number,
  legalNeighborhood: number,
): { purifiedPixelCount: number; purifiedComponentCount: number } {
  const distances = productDistances(mask, side, side, maskChannels);
  const visited = new Uint8Array(side * side);
  const queue = new Int32Array(side * side);
  let purifiedPixelCount = 0;
  let purifiedComponentCount = 0;
  const isResidue = (index: number): boolean => {
    if (mask[index * maskChannels] !== 0) return false;
    const offset = index * outputChannels;
    return 255 - Math.min(output[offset], output[offset + 1], output[offset + 2]) >= residueThreshold;
  };
  for (let start = 0; start < side * side; start += 1) {
    if (visited[start] || !isResidue(start)) continue;
    let head = 0; let tail = 1; let touchesProductNeighborhood = false;
    queue[0] = start;
    visited[start] = 1;
    while (head < tail) {
      const index = queue[head]; head += 1;
      if (distances[index] <= legalNeighborhood) touchesProductNeighborhood = true;
      const x = index % side;
      const y = Math.floor(index / side);
      for (let deltaY = -1; deltaY <= 1; deltaY += 1) {
        for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
          if (deltaX === 0 && deltaY === 0) continue;
          const nextX = x + deltaX; const nextY = y + deltaY;
          if (nextX < 0 || nextY < 0 || nextX >= side || nextY >= side) continue;
          const next = nextY * side + nextX;
          if (!visited[next] && isResidue(next)) {
            visited[next] = 1;
            queue[tail] = next;
            tail += 1;
          }
        }
      }
    }
    if (touchesProductNeighborhood || tail < minimumArea) continue;
    purifiedComponentCount += 1;
    purifiedPixelCount += tail;
    for (let position = 0; position < tail; position += 1) {
      const offset = queue[position] * outputChannels;
      output[offset] = 255;
      output[offset + 1] = 255;
      output[offset + 2] = 255;
    }
  }
  return { purifiedPixelCount, purifiedComponentCount };
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
  const { whitePointMin, whitePointMax, whitePointMaxChannelSpread, productBoxTolerance } = bundle.gates;
  const roi = scaleAndClipReferenceRect(activePreset.roi, side);
  let sampledPoint: ReferencePoint;
  let sampledPointRgb: [number, number, number];
  let sampledRgb: [number, number, number];
  let sampledPatchPassRate: number;
  let sampledMaskDistance: number;
  const adaptiveSampling = bundle.schemaVersion === 3 && "whiteSamplePolicy" in activePreset;
  if (adaptiveSampling) {
    const adaptive = selectAdaptiveWhiteSample(
      rgb,
      rgbInfo.channels,
      mask,
      maskInfo.channels,
      side,
      roi,
      activePreset.whiteSamplePolicy,
    );
    sampledPoint = adaptive.point;
    sampledPointRgb = adaptive.pointRgb;
    sampledRgb = adaptive.medianRgb;
    sampledPatchPassRate = adaptive.patchPassRate;
    sampledMaskDistance = adaptive.maskDistance;
  } else {
    const fixedPreset = activePreset as LegacyCalibratedShadowPreset | ScopedCalibratedShadowPreset;
    const sampleX = scaleReferenceCoordinate(fixedPreset.whitePoint.x, side);
    const sampleY = scaleReferenceCoordinate(fixedPreset.whitePoint.y, side);
    if (sampleX >= side || sampleY >= side) throw new Error("白场采样点缩放后越出画布");
    const sampleOffset = (sampleY * side + sampleX) * rgbInfo.channels;
    sampledPoint = { x: sampleX, y: sampleY };
    sampledRgb = [rgb[sampleOffset], rgb[sampleOffset + 1], rgb[sampleOffset + 2]];
    sampledPointRgb = sampledRgb;
    sampledPatchPassRate = 1;
    sampledMaskDistance = 0;
    if (sampledRgb.some((value) => value < whitePointMin || value > whitePointMax)
      || Math.max(...sampledRgb) - Math.min(...sampledRgb) > whitePointMaxChannelSpread) {
      throw new Error(`白场采样未通过门禁：RGB ${sampledRgb.join("/")}`);
    }
    const maskSample = mask[(sampleY * side + sampleX) * maskInfo.channels];
    if (maskSample !== 0) throw new Error(`白场采样点落入商品蒙版：alpha ${maskSample}`);
  }
  const productBox = boxFromMask(mask, side, side, maskInfo.channels);
  const presetGoldStandards = goldStandardsForPreset(bundle, activePreset);
  if (!presetGoldStandards.some((gold) => boxMatchesGold(productBox, gold.productBox, productBoxTolerance))) {
    throw new Error(`商品框超出预设 ${activePreset.id} 的同角度金标准 ±${productBoxTolerance * 100}% 容差`);
  }
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
  const output = Buffer.alloc(side * side * 3, 255);
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const index = y * side + x;
      const outputOffset = index * 3;
      const inputOffset = index * rgbInfo.channels;
      const insideRoi = x >= roi.x && x < roi.x + roi.width && y >= roi.y && y < roi.y + roi.height;
      const plateOffset = insideRoi ? ((y - roi.y) * roi.width + x - roi.x) * 3 : -1;
      const maskValue = alpha[index];
      for (let channel = 0; channel < 3; channel += 1) {
        const backgroundValue = insideRoi ? plate[plateOffset + channel] : 255;
        output[outputOffset + channel] = Math.round(
          (rgb[inputOffset + channel] * maskValue + backgroundValue * (255 - maskValue)) / 255,
        );
      }
    }
  }
  const outputInfo = { width: side, height: side, channels: 3 as const };
  const boundaryLimit = adaptiveSampling ? bundle.gates.roiBoundaryMaxChannelJump! : 255;
  const maximumBoundaryJump = adaptiveSampling
    ? roiBoundaryMaxChannelJump(output, outputInfo.channels, mask, maskInfo.channels, side, roi) : 0;
  if (adaptiveSampling) {
    purifyDetachedBackgroundResidue(
      output,
      outputInfo.channels,
      mask,
      maskInfo.channels,
      side,
      bundle.gates.residueThreshold!,
      bundle.gates.detachedResidueMinArea!,
      scaleReferenceCoordinate(bundle.gates.legalShadowMaskNeighborhood!, side),
    );
  }
  const image = await sharp(output, { raw: outputInfo }).removeAlpha().png().toBuffer();
  const metadata = await sharp(image).metadata();
  const outputOpaqueRgbPassed = metadata.hasAlpha !== true;
  let opaqueProductCorePassed = true;
  let outsideProductAndRoiWhitePassed = true;
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const index = y * side + x;
      const outputOffset = index * outputInfo.channels;
      const inputOffset = index * rgbInfo.channels;
      if (alpha[index] === 255
        && (output[outputOffset] !== rgb[inputOffset]
          || output[outputOffset + 1] !== rgb[inputOffset + 1]
          || output[outputOffset + 2] !== rgb[inputOffset + 2])) {
        opaqueProductCorePassed = false;
      }
      const outsideRoi = x < roi.x || x >= roi.x + roi.width || y < roi.y || y >= roi.y + roi.height;
      if (alpha[index] === 0 && outsideRoi
        && (output[outputOffset] !== 255 || output[outputOffset + 1] !== 255 || output[outputOffset + 2] !== 255)) {
        outsideProductAndRoiWhitePassed = false;
      }
    }
  }
  const detachedMinimumArea = adaptiveSampling ? bundle.gates.detachedResidueMinArea! : Number.MAX_SAFE_INTEGER;
  const largestDetachedArea = adaptiveSampling
    ? largestDetachedResidue(
      output,
      outputInfo.channels,
      mask,
      maskInfo.channels,
      side,
      bundle.gates.residueThreshold!,
      scaleReferenceCoordinate(bundle.gates.legalShadowMaskNeighborhood!, side),
    ) : 0;
  const qualityGates: CalibratedShadowRenderResult["qualityGates"] = {
    roiBoundary: { passed: maximumBoundaryJump <= boundaryLimit, maxChannelJump: maximumBoundaryJump, limit: boundaryLimit },
    detachedBackgroundResidue: {
      passed: largestDetachedArea < detachedMinimumArea,
      largestDetachedArea,
      minimumFailingArea: detachedMinimumArea,
    },
    opaqueProductCore: { passed: opaqueProductCorePassed },
    outsideProductAndRoiWhite: { passed: outsideProductAndRoiWhitePassed },
    outputOpaqueRgb: { passed: outputOpaqueRgbPassed },
  };
  const failedQualityGates = Object.entries(qualityGates).filter(([, value]) => !value.passed).map(([name]) => name);
  if (failedQualityGates.length) throw new Error(`calibrated 阴影质量门失败：${failedQualityGates.join(", ")}`);
  return {
    image,
    sampledPoint,
    sampledPointRgb,
    sampledRgb,
    sampledPatchPassRate,
    sampledMaskDistance,
    productBox,
    qualityGates,
  };
}
