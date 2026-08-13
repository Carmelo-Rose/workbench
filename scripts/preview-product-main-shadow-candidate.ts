import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  ADAPTIVE_WHITE_SAMPLE_POLICY,
  CALIBRATED_SHADOW_MAIN_IMAGE_VERSION,
  composeCalibratedShadowMain,
  isCandidateShadowManifestVersion,
  loadCandidateCalibratedShadowBundle,
  SLOT_4_DEVELOPMENT_IDENTITY,
  type ReferenceRect,
} from "../src/lib/mono/product-main-shadow";

type PinnedFile = { path: string; sha256: string };
type PreviewRequest = {
  schemaVersion: 1;
  candidatePackage: string;
  candidateVersion: typeof SLOT_4_DEVELOPMENT_IDENTITY;
  developmentIdentity: typeof SLOT_4_DEVELOPMENT_IDENTITY;
  manifestSha256: string;
  sourceId: string;
  presetId: string;
  angleSlot: number;
  humanAngleLabel: string;
  roi: ReferenceRect;
  whiteSamplePolicy: typeof ADAPTIVE_WHITE_SAMPLE_POLICY;
  goldStandardIds: string[];
  v1: PinnedFile;
  birefnetMask: PinnedFile;
  photoshopPreview: PinnedFile;
  outputDir: string;
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9.-]+$/u;
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

async function readPinned(file: PinnedFile, label: string): Promise<Buffer> {
  if (!file || typeof file.path !== "string" || !SHA256_PATTERN.test(file.sha256)) throw new Error(`${label} 哈希绑定非法`);
  const bytes = await readFile(path.resolve(file.path));
  const actual = sha256(bytes);
  if (actual !== file.sha256) throw new Error(`${label} SHA-256 不匹配：expected ${file.sha256}, actual ${actual}`);
  return bytes;
}

function assertIdentity(request: PreviewRequest): void {
  if (!SOURCE_ID_PATTERN.test(request.sourceId)) throw new Error("source ID 非法");
  if (path.parse(request.v1.path).name !== request.sourceId) throw new Error("V1 文件名与 source ID 不一致");
  if (path.parse(request.birefnetMask.path).name !== `${request.sourceId}-birefnet-mask`) throw new Error("蒙版文件名与 source ID 不一致");
  if (!path.parse(request.photoshopPreview.path).name.startsWith(request.sourceId)) throw new Error("Photoshop 展示图与 source ID 不一致");
  if (request.candidateVersion !== SLOT_4_DEVELOPMENT_IDENTITY || request.developmentIdentity !== SLOT_4_DEVELOPMENT_IDENTITY
    || !isCandidateShadowManifestVersion(request.candidateVersion)) throw new Error("受控预演只接受显式 slot-4-development 身份");
  if (!Number.isInteger(request.angleSlot) || request.angleSlot < 1 || request.angleSlot > 6 || !request.humanAngleLabel.trim()) {
    throw new Error("受控预演需要显式 Slot 1–6 与人工角度标签");
  }
  const roi = request.roi;
  if (!roi || ![roi.x, roi.y, roi.width, roi.height].every(Number.isInteger)
    || roi.x < 0 || roi.y < 0 || roi.width <= 0 || roi.height <= 0 || roi.x + roi.width > 800 || roi.y + roi.height > 1600) {
    throw new Error("受控预演 ROI 非法");
  }
  if (JSON.stringify(request.whiteSamplePolicy) !== JSON.stringify(ADAPTIVE_WHITE_SAMPLE_POLICY)
    || !Array.isArray(request.goldStandardIds) || request.goldStandardIds.length < 2
    || new Set(request.goldStandardIds).size !== request.goldStandardIds.length) {
    throw new Error("受控预演需要不可变 whiteSamplePolicy 与至少两份唯一 gold IDs");
  }
}

async function writeThreeColumnComparison(
  v1: Buffer,
  photoshop: Buffer,
  native: Buffer,
  outputPath: string,
): Promise<void> {
  const meta = await sharp(v1).metadata();
  if (!meta.width || meta.height !== meta.width) throw new Error("对照图输入不是方图");
  const side = meta.width;
  const header = Math.max(40, Math.round(side * 0.06));
  const label = Buffer.from(`<svg width="${side * 3}" height="${header}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#1c1c1e"/>
    <g fill="white" font-family="Arial, sans-serif" font-size="${Math.max(18, Math.round(header * 0.42))}">
      <text x="12" y="${Math.round(header * 0.68)}">V1</text>
      <text x="${side + 12}" y="${Math.round(header * 0.68)}">Photoshop</text>
      <text x="${side * 2 + 12}" y="${Math.round(header * 0.68)}">native</text>
    </g>
  </svg>`);
  await sharp({ create: { width: side * 3, height: side + header, channels: 3, background: "white" } })
    .composite([
      { input: label, left: 0, top: 0 },
      { input: v1, left: 0, top: header },
      { input: photoshop, left: side, top: header },
      { input: native, left: side * 2, top: header },
    ])
    .removeAlpha()
    .png()
    .toFile(outputPath);
}

async function main(): Promise<void> {
  const requestPath = process.argv[2];
  if (!requestPath) throw new Error("usage: npx tsx scripts/preview-product-main-shadow-candidate.ts <request.json>");
  const requestBytes = await readFile(path.resolve(requestPath));
  const request = JSON.parse(requestBytes.toString("utf8")) as PreviewRequest;
  if (request.schemaVersion !== 1 || !SHA256_PATTERN.test(request.manifestSha256)) throw new Error("候选预演请求非法");
  assertIdentity(request);
  const [v1, mask, photoshopPreview, bundle] = await Promise.all([
    readPinned(request.v1, "V1"),
    readPinned(request.birefnetMask, "BiRefNet 蒙版"),
    readPinned(request.photoshopPreview, "Photoshop 预览"),
    loadCandidateCalibratedShadowBundle(path.resolve(request.candidatePackage), request.candidateVersion),
  ]);
  if (bundle.schemaVersion !== 3) throw new Error("受控候选预演只接受独立 schema v3");
  if (bundle.manifestSha256 !== request.manifestSha256) throw new Error("候选 manifest SHA-256 与请求不一致");
  const preset = bundle.presets.find((item) => item.id === request.presetId);
  if (!preset) throw new Error(`候选预设不存在：${request.presetId}`);
  if (preset.angleSlot !== request.angleSlot || preset.humanAngleLabel !== request.humanAngleLabel
    || JSON.stringify(preset.roi) !== JSON.stringify(request.roi)
    || !("whiteSamplePolicy" in preset) || JSON.stringify(preset.whiteSamplePolicy) !== JSON.stringify(request.whiteSamplePolicy)
    || JSON.stringify(preset.goldStandardIds) !== JSON.stringify(request.goldStandardIds)) {
    throw new Error("候选预演请求与 manifest 预设身份不一致");
  }

  let output = v1;
  let actualVersion = "whitefield-v1";
  let fallbackReason: string | undefined;
  let render: Awaited<ReturnType<typeof composeCalibratedShadowMain>> | undefined;
  try {
    render = await composeCalibratedShadowMain(v1, mask, bundle, preset);
    output = render.image;
    actualVersion = CALIBRATED_SHADOW_MAIN_IMAGE_VERSION;
  } catch (error) {
    fallbackReason = `候选 calibrated 渲染拒绝并回退 whitefield-v1：${error instanceof Error ? error.message : String(error)}`;
  }

  const outputRoot = path.resolve(request.outputDir);
  await mkdir(outputRoot, { recursive: false });
  const outputName = render
    ? `${request.sourceId}-${request.candidateVersion}-${request.presetId}-preview.png`
    : `${request.sourceId}-whitefield-v1-fallback.png`;
  const outputPath = path.join(outputRoot, outputName);
  await writeFile(outputPath, output);

  const manifestPath = path.join(bundle.root, "manifest.json");
  const preflight = {
    request: sha256(await readFile(path.resolve(requestPath))) === sha256(requestBytes),
    input: sha256(await readFile(path.resolve(request.v1.path))) === request.v1.sha256,
    mask: sha256(await readFile(path.resolve(request.birefnetMask.path))) === request.birefnetMask.sha256,
    photoshopPreview: sha256(await readFile(path.resolve(request.photoshopPreview.path))) === request.photoshopPreview.sha256,
    manifest: sha256(Buffer.from(JSON.stringify(JSON.parse((await readFile(manifestPath)).toString("utf8"))), "utf8")) === request.manifestSha256,
    output: sha256(await readFile(outputPath)) === sha256(output),
  };
  if (Object.values(preflight).some((passed) => !passed)) throw new Error("生成对照图前的 SHA-256 复核失败");
  const comparisonPath = path.join(outputRoot, `${request.sourceId}-v1-photoshop-native.png`);
  if (render) await writeThreeColumnComparison(v1, photoshopPreview, output, comparisonPath);

  const report = {
    schemaVersion: 2,
    previewOnly: true,
    candidateVersion: request.candidateVersion,
    candidatePackage: bundle.root,
    manifest: { path: manifestPath, sha256: bundle.manifestSha256 },
    releaseState: bundle.releaseState,
    approved: bundle.approved,
    publicationAllowed: bundle.publicationAllowed,
    sourceId: request.sourceId,
    presetId: request.presetId,
    developmentIdentity: request.developmentIdentity,
    angleSlot: request.angleSlot,
    humanAngleLabel: request.humanAngleLabel,
    roi: request.roi,
    goldStandardIds: request.goldStandardIds,
    input: { path: path.resolve(request.v1.path), sha256: request.v1.sha256 },
    birefnetMask: { path: path.resolve(request.birefnetMask.path), sha256: request.birefnetMask.sha256 },
    photoshopPreview: { path: path.resolve(request.photoshopPreview.path), sha256: request.photoshopPreview.sha256 },
    output: { path: outputPath, sha256: sha256(output), actualVersion },
    comparison: render ? { path: comparisonPath, sha256: sha256(await readFile(comparisonPath)) } : null,
    comparisonPreflight: preflight,
    sampledPoint: render?.sampledPoint ?? null,
    sampledPointRgb: render?.sampledPointRgb ?? null,
    sampledRgbMedian: render?.sampledRgb ?? null,
    sampledPatchPassRate: render?.sampledPatchPassRate ?? null,
    sampledMaskDistance: render?.sampledMaskDistance ?? null,
    qualityGates: render?.qualityGates ?? null,
    ...(fallbackReason ? { fallbackReason } : {}),
  };
  const reportPath = path.join(outputRoot, `${request.sourceId}-preview-report.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outputRoot, sourceId: request.sourceId, actualVersion, fallbackReason: fallbackReason ?? null }));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
