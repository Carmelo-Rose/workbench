import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  ADAPTIVE_WHITE_SAMPLE_POLICY,
  BIREFNET_MODEL_ID,
  BIREFNET_MODEL_REVISION,
  BIREFNET_WEIGHTS_SHA256,
  composeCalibratedShadowMain,
  type AdaptiveCalibratedShadowPreset,
  type LoadedCalibratedShadowBundle,
} from "../src/lib/mono/product-main-shadow";

type Report = {
  sourceId: string; goldId: string; presetVersion: string; angleSlot: number;
  humanAngleLabel: string; v1: { path: string; sha256: string };
  approvedPsd: { path: string; sha256: string };
  birefnetMask: { path: string; sha256: string };
  layerNames: { product: string; shadow: string; background: string };
  productBox: { left: number; top: number; width: number; height: number };
  automaticGatesPassed: boolean; automaticGates: Record<string, { passed: boolean }>;
};

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const readPinned = async (file: string, expected: string, label: string): Promise<Buffer> => {
  const bytes = await readFile(path.resolve(file));
  if (sha256(bytes) !== expected) throw new Error(`${label} SHA-256 mismatch`);
  return bytes;
};

async function main(): Promise<void> {
  const [reportArgument, outputArgument] = process.argv.slice(2);
  if (!reportArgument || !outputArgument) throw new Error("usage: npx tsx scripts/verify-product-main-shadow-v24-production-entry.ts <report.json> <authoritative-report.json>");
  const reportPath = path.resolve(reportArgument);
  const report = JSON.parse((await readFile(reportPath)).toString("utf8")) as Report;
  if (report.presetVersion !== "hat-ps-shadow-v2.4" || report.angleSlot !== 1) throw new Error("only hat-ps-shadow-v2.4 Slot 1 is accepted");
  if (!report.automaticGatesPassed || Object.values(report.automaticGates).some((gate) => gate.passed !== true)) throw new Error("Python automatic gates are not all passing");
  const root = path.resolve(reportPath, "..", "..", "..");
  const ids = ["329A8208", "329A8217", "329A8239"];
  const reports = await Promise.all(ids.map(async (id) => JSON.parse((await readFile(path.join(root, id, "calibration-gates-v5", "report.json"))).toString("utf8")) as Report));
  const sourceReport = reports.find((item) => item.sourceId === report.sourceId);
  if (!sourceReport) throw new Error("source report is not one of the fixed Slot 1 golds");
  const [v1, mask] = await Promise.all([
    readPinned(sourceReport.v1.path, sourceReport.v1.sha256, "V1"),
    readPinned(sourceReport.birefnetMask.path, sourceReport.birefnetMask.sha256, "BiRefNet mask"),
  ]);
  await readPinned(sourceReport.approvedPsd.path, sourceReport.approvedPsd.sha256, "approved PSD");
  const preset: AdaptiveCalibratedShadowPreset = {
    id: "hat-angle-slot-1", angleSlot: 1, humanAngleLabel: sourceReport.humanAngleLabel,
    approved: false, goldStandardIds: reports.map((item) => item.goldId),
    roi: { x: 0, y: 480, width: 800, height: 320 }, whiteSamplePolicy: ADAPTIVE_WHITE_SAMPLE_POLICY,
  };
  const bundle: LoadedCalibratedShadowBundle = {
    schemaVersion: 3, version: "hat-ps-shadow-v2.4", candidateOnly: true,
    releaseState: "awaiting-human-approval", approved: false, publicationAllowed: false,
    canvas: { width: 800, height: 800 },
    algorithm: { id: "ps-levels-roi-v2-adaptive-white", levels: "round(value*255/channelMedian)-clamp-255" },
    biRefNet: { modelId: BIREFNET_MODEL_ID, revision: BIREFNET_MODEL_REVISION, weightsSha256: BIREFNET_WEIGHTS_SHA256 },
    gates: { whitePointMin: 220, whitePointMax: 245, whitePointMaxChannelSpread: 8, productBoxTolerance: 0.05, roiBoundaryMaxChannelJump: 5, detachedResidueMinArea: 64, residueThreshold: 2, legalShadowMaskNeighborhood: 16 },
    goldStandards: reports.map((item) => ({ id: item.goldId, psdPath: item.approvedPsd.path, psdSha256: item.approvedPsd.sha256, layerNames: item.layerNames, productBox: item.productBox })),
    regressionAssets: [], presets: [preset], root, manifestSha256: "development-only-v24-entry-check",
  };
  const render = await composeCalibratedShadowMain(v1, mask, bundle, preset);
  const expectedPath = path.join(path.dirname(reportPath), "native-preview.png");
  const expected = await readFile(expectedPath);
  const [{ data: actual }, { data: expectedRaw }] = await Promise.all([
    sharp(render.image).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(expected).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (actual.length !== expectedRaw.length) throw new Error("production output dimensions differ");
  let total = 0; let maximum = 0;
  for (let index = 0; index < actual.length; index += 1) { const delta = Math.abs(actual[index] - expectedRaw[index]); total += delta; maximum = Math.max(maximum, delta); }
  const mean = total / actual.length;
  const quality = Object.values(render.qualityGates).every((gate) => gate.passed);
  if (!quality || mean > 0.1 || maximum > 2) throw new Error(`production entry failed: quality=${quality} mean=${mean} max=${maximum}`);
  const output = {
    schemaVersion: 1, sourceId: sourceReport.sourceId, presetVersion: sourceReport.presetVersion,
    releaseState: "awaiting-human-approval", approved: false, publicationAllowed: false, packageBuilt: false,
    sampledPoint: render.sampledPoint, sampledPointRgb: render.sampledPointRgb, sampledRgb: render.sampledRgb,
    sampledPatchPassRate: render.sampledPatchPassRate, sampledMaskDistance: render.sampledMaskDistance,
    qualityGates: render.qualityGates, productionPixelParity: { meanChannelError: mean, maxChannelError: maximum },
    outputSha256: sha256(render.image), automaticGatesPassed: true, passed: true,
  };
  await writeFile(path.resolve(outputArgument), `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ sourceId: sourceReport.sourceId, passed: true, mean, maximum }));
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
