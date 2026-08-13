import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildCalibratedShadowAssignments,
  CALIBRATED_SHADOW_MAIN_IMAGE_VERSION,
  composeCalibratedShadowMain,
  DEFAULT_SHADOW_PRESET_VERSION,
  isCalibratedShadowV2Enabled,
  loadCalibratedShadowBundle,
} from "../src/lib/mono/product-main-shadow";
import { requestCutoutBytes } from "../src/lib/mono/product-pipeline";

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

async function loadLocalEnvironment(): Promise<void> {
  try {
    const source = await readFile(path.join(process.cwd(), ".env.local"), "utf8");
    for (const rawLine of source.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator <= 0) continue;
      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function numericToken(file: string): number {
  const matches = path.parse(file).name.match(/\d+/gu);
  const token = Number(matches?.at(-1));
  if (!Number.isSafeInteger(token)) throw new Error(`无法从文件名读取数字顺序：${file}`);
  return token;
}

async function main(): Promise<void> {
  const [sourceDirectory, outputDirectory] = process.argv.slice(2);
  if (!sourceDirectory || !outputDirectory) {
    throw new Error("usage: npx tsx scripts/dry-run-calibrated-shadow-v2.ts <V1-directory> <new-output-directory>");
  }
  await loadLocalEnvironment();
  process.env.PRODUCT_MAIN_V2_ENABLED = "false";
  if (isCalibratedShadowV2Enabled()) throw new Error("预演必须在 PRODUCT_MAIN_V2_ENABLED=false 下运行");
  const sourceRoot = path.resolve(sourceDirectory);
  const outputRoot = path.resolve(outputDirectory);
  await mkdir(outputRoot, { recursive: false });
  const names = (await readdir(sourceRoot))
    .filter((name) => /\.png$/iu.test(name) && !/_/u.test(path.parse(name).name))
    .sort((first, second) => numericToken(first) - numericToken(second));
  if (names.length !== 12) throw new Error(`测试222 预演要求两组六图，实际找到 ${names.length} 张`);
  const colors = [names.slice(0, 6), names.slice(6, 12)].map((members) => ({
    members: members.map((name) => ({ path: path.join(sourceRoot, name) })),
  }));
  const bundle = await loadCalibratedShadowBundle(DEFAULT_SHADOW_PRESET_VERSION);
  const assignments = buildCalibratedShadowAssignments(colors, bundle.presets);
  const records: Record<string, unknown>[] = [];
  for (const name of names) {
    const inputPath = path.join(sourceRoot, name);
    const input = await readFile(inputPath);
    const assignment = assignments.get(inputPath);
    let output: Buffer = input;
    let actualVersion = "whitefield-v1";
    let sampledPoint: { x: number; y: number } | undefined;
    let sampledRgb: [number, number, number] | undefined;
    let sampledPatchPassRate: number | undefined;
    let sampledMaskDistance: number | undefined;
    let fallbackReason = assignment?.fallbackReason;
    if (assignment?.presetId) {
      const preset = bundle.presets.find((candidate) => candidate.id === assignment.presetId);
      if (!preset) throw new Error(`预设不存在：${assignment.presetId}`);
      const mask = await requestCutoutBytes(
        input,
        name,
        `dry-run-${path.parse(name).name}`,
        AbortSignal.timeout(15 * 60_000),
        { userId: "calibration", workspaceId: "calibration" },
      );
      const rendered = await composeCalibratedShadowMain(input, mask, bundle, preset);
      output = rendered.image;
      sampledPoint = rendered.sampledPoint;
      sampledRgb = rendered.sampledRgb;
      sampledPatchPassRate = rendered.sampledPatchPassRate;
      sampledMaskDistance = rendered.sampledMaskDistance;
      actualVersion = CALIBRATED_SHADOW_MAIN_IMAGE_VERSION;
      fallbackReason = undefined;
    }
    await writeFile(path.join(outputRoot, name), output);
    records.push({
      name,
      angleSlot: assignment?.angleSlot ?? null,
      presetId: assignment?.presetId ?? null,
      shadowPresetVersion: DEFAULT_SHADOW_PRESET_VERSION,
      inputSha256: sha256(input),
      outputSha256: sha256(output),
      actualVersion,
      sampledPoint: sampledPoint ?? null,
      sampledRgb: sampledRgb ?? null,
      sampledPatchPassRate: sampledPatchPassRate ?? null,
      sampledMaskDistance: sampledMaskDistance ?? null,
      ...(fallbackReason ? { fallbackReason } : {}),
    });
  }
  const report = {
    schemaVersion: 1,
    productionSwitchEnabled: false,
    published: false,
    fixtureGrouping: "two numeric groups of six",
    requestedVersion: CALIBRATED_SHADOW_MAIN_IMAGE_VERSION,
    shadowPresetVersion: DEFAULT_SHADOW_PRESET_VERSION,
    records,
  };
  await writeFile(path.join(outputRoot, "dry-run-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outputRoot, calibrated: records.filter((record) => record.actualVersion === CALIBRATED_SHADOW_MAIN_IMAGE_VERSION).length, fallback: records.filter((record) => record.actualVersion === "whitefield-v1").length }));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
