import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { requestCutoutBytes } from "../src/lib/mono/product-pipeline";

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
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function main(): Promise<void> {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error("usage: npx tsx scripts/export-product-cutout-mask.ts <input> <output>");
  await loadLocalEnvironment();
  const bytes = await readFile(path.resolve(input));
  const mask = await requestCutoutBytes(
    bytes,
    path.basename(input),
    `calibration-${path.parse(input).name}`,
    AbortSignal.timeout(15 * 60_000),
    { userId: "calibration", workspaceId: "calibration" },
  );
  await writeFile(path.resolve(output), mask, { flag: "wx" });
  console.log(path.resolve(output));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
