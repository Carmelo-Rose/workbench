import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  ADAPTIVE_WHITE_SAMPLE_POLICY,
  purifyDetachedBackgroundResidue,
  scaleAndClipReferenceRect,
  selectAdaptiveWhiteSample,
  type ReferenceRect,
} from "../src/lib/mono/product-main-shadow";

type RequestConfig = {
  sourceId: string;
  input: string;
  mask: string;
  outputDir: string;
  developmentIdentity: "slot-4-development";
  angleSlot: number;
  angleLabel: string;
  roi: ReferenceRect;
  whiteSamplePolicy: typeof ADAPTIVE_WHITE_SAMPLE_POLICY;
  goldStandardIds: string[];
  layerNames: { product: string; shadow: string; background: string };
};

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

async function main(): Promise<void> {
  const [configPath, outputPath, outputDirOverride] = process.argv.slice(2);
  if (!configPath || !outputPath) throw new Error("usage: npx tsx scripts/prepare-product-main-shadow-photoshop-request.ts <config.json> <new-request.json> [new-output-dir]");
  const config = JSON.parse(await readFile(path.resolve(configPath), "utf8")) as RequestConfig;
  if (outputDirOverride) config.outputDir = outputDirOverride;
  if (!/^[A-Za-z0-9.-]+$/u.test(config.sourceId) || path.parse(config.input).name !== config.sourceId) throw new Error("source ID 与输入文件名不一致");
  if (path.parse(config.mask).name !== `${config.sourceId}-birefnet-mask`) throw new Error("source ID 与蒙版文件名不一致");
  if (config.developmentIdentity !== "slot-4-development") throw new Error("受控 Photoshop 请求必须使用显式 slot-4-development 身份");
  if (!Number.isInteger(config.angleSlot) || config.angleSlot < 1 || config.angleSlot > 6) throw new Error("angleSlot 非法");
  if (!config.angleLabel.trim() || JSON.stringify(config.whiteSamplePolicy) !== JSON.stringify(ADAPTIVE_WHITE_SAMPLE_POLICY)
    || !Array.isArray(config.goldStandardIds) || config.goldStandardIds.length < 2
    || new Set(config.goldStandardIds).size !== config.goldStandardIds.length
    || config.goldStandardIds.some((id) => !/^[a-z0-9][a-z0-9.-]*$/u.test(id))) {
    throw new Error("开发请求必须显式携带 label、不可变 whiteSamplePolicy 和至少两份唯一 gold IDs");
  }
  const [input, maskImage] = await Promise.all([readFile(path.resolve(config.input)), readFile(path.resolve(config.mask))]);
  const [{ data: rgb, info: rgbInfo }, { data: mask, info: maskInfo }] = await Promise.all([
    sharp(input).removeAlpha().toColorspace("srgb").raw().toBuffer({ resolveWithObject: true }),
    sharp(maskImage).toColorspace("b-w").raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (rgbInfo.width !== rgbInfo.height || maskInfo.width !== rgbInfo.width || maskInfo.height !== rgbInfo.height) throw new Error("输入或蒙版尺寸非法");
  const sample = selectAdaptiveWhiteSample(
    rgb,
    rgbInfo.channels,
    mask,
    maskInfo.channels,
    rgbInfo.width,
    scaleAndClipReferenceRect(config.roi, rgbInfo.width),
  );
  const roi = scaleAndClipReferenceRect(config.roi, rgbInfo.width);
  const shadowRaw = Buffer.alloc(rgbInfo.width * rgbInfo.height * 3, 255);
  const productRaw = Buffer.alloc(rgbInfo.width * rgbInfo.height * 4);
  for (let y = 0; y < rgbInfo.height; y += 1) {
    for (let x = 0; x < rgbInfo.width; x += 1) {
      const index = y * rgbInfo.width + x;
      const inputOffset = index * rgbInfo.channels;
      const maskValue = mask[index * maskInfo.channels];
      const productOffset = index * 4;
      productRaw[productOffset] = rgb[inputOffset];
      productRaw[productOffset + 1] = rgb[inputOffset + 1];
      productRaw[productOffset + 2] = rgb[inputOffset + 2];
      productRaw[productOffset + 3] = maskValue;
      if (x >= roi.x && x < roi.x + roi.width && y >= roi.y && y < roi.y + roi.height) {
        const shadowOffset = index * 3;
        for (let channel = 0; channel < 3; channel += 1) {
          shadowRaw[shadowOffset + channel] = Math.min(255, Math.round((rgb[inputOffset + channel] * 255) / sample.medianRgb[channel]));
        }
      }
    }
  }
  const purification = purifyDetachedBackgroundResidue(
    shadowRaw,
    3,
    mask,
    maskInfo.channels,
    rgbInfo.width,
    2,
    64,
    Math.max(1, Math.round(16 * rgbInfo.width / 800)),
  );
  const requestRoot = path.dirname(path.resolve(outputPath));
  const productLayerPath = path.join(requestRoot, `${config.sourceId}-product-layer.png`);
  const shadowLayerPath = path.join(requestRoot, `${config.sourceId}-shadow-layer.png`);
  const [productLayer, shadowLayer] = await Promise.all([
    sharp(productRaw, { raw: { width: rgbInfo.width, height: rgbInfo.height, channels: 4 } }).png().toBuffer(),
    sharp(shadowRaw, { raw: { width: rgbInfo.width, height: rgbInfo.height, channels: 3 } }).png().toBuffer(),
  ]);
  await Promise.all([
    writeFile(productLayerPath, productLayer, { flag: "wx" }),
    writeFile(shadowLayerPath, shadowLayer, { flag: "wx" }),
  ]);
  const request = {
    schemaVersion: 2,
    sourceId: config.sourceId,
    input: path.resolve(config.input),
    inputSha256: sha256(input),
    birefnetMask: path.resolve(config.mask),
    birefnetMaskSha256: sha256(maskImage),
    productLayer: productLayerPath,
    productLayerSha256: sha256(productLayer),
    shadowLayer: shadowLayerPath,
    shadowLayerSha256: sha256(shadowLayer),
    outputDir: path.resolve(config.outputDir),
    presetVersion: config.developmentIdentity,
    developmentIdentity: config.developmentIdentity,
    angleSlot: config.angleSlot,
    angleLabel: config.angleLabel,
    roi: config.roi,
    sampledPoint: sample.point,
    sampledPointRgb: sample.pointRgb,
    sampledRgb: sample.medianRgb,
    sampledPatchPassRate: sample.patchPassRate,
    sampledMaskDistance: sample.maskDistance,
    sampledPatchSize: sample.patchSize,
    whiteSamplePolicy: config.whiteSamplePolicy,
    goldStandardIds: config.goldStandardIds,
    backgroundPurification: {
      algorithm: "detached-residue-to-white-v1",
      residueThreshold: 2,
      minimumArea: 64,
      legalShadowMaskNeighborhoodAt800: 16,
      connectivity: 8,
      ...purification,
    },
    layerNames: config.layerNames,
    releaseState: "awaiting-human-approval",
    approved: false,
    publicationAllowed: false,
  };
  await writeFile(path.resolve(outputPath), `${JSON.stringify(request, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ outputPath: path.resolve(outputPath), sourceId: config.sourceId, sampledPoint: sample.point, sampledRgb: sample.medianRgb }));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
