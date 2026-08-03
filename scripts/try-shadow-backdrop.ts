import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat, readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const { requestShadowBackdrop } = require("@/lib/mono/product-pipeline") as typeof import("@/lib/mono/product-pipeline");

/**
 * One-off manual verification for the online shadow-backdrop switch: runs
 * requestShadowBackdrop() directly against a handful of real photos (not the
 * full runProductPipeline — no cutout gateway / template bundle involved),
 * so the shadow quality can be eyeballed before wiring real folders through
 * the paid endpoint at scale.
 *
 * Usage: npx tsx scripts/try-shadow-backdrop.ts "C:\path\to\folder" [model]
 */
async function main(): Promise<void> {
  const sourceDir = process.argv[2];
  const model = process.argv[3] || "gpt-image-2";
  if (!sourceDir) throw new Error("用法：npx tsx scripts/try-shadow-backdrop.ts <图片文件夹> [模型名]");
  const outDir = path.join(process.cwd(), "data", "shadow-backdrop-trial", randomUUID());
  await mkdir(outDir, { recursive: true });

  const entries = (await readdir(sourceDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.(jpe?g|png)$/iu.test(entry.name));

  console.log(`共 ${entries.length} 张图，模型：${model}，输出目录：${outDir}`);

  for (const entry of entries) {
    const filePath = path.join(sourceDir, entry.name);
    const stem = path.parse(entry.name).name;
    const stats = await stat(filePath);
    const source = {
      path: filePath,
      name: entry.name,
      stem,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      hash: "trial",
    };
    const started = Date.now();
    try {
      const backdrop = await requestShadowBackdrop(source, new AbortController().signal, "default", model);
      const outPath = path.join(outDir, `${stem}.shadow.png`);
      await sharp(backdrop).toFile(outPath);
      console.log(`✓ ${entry.name} -> ${outPath}（${Date.now() - started}ms）`);
    } catch (error) {
      console.error(`✗ ${entry.name} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
