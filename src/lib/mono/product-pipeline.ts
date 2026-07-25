import { createHash, randomUUID } from "node:crypto";
import { access, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { getMonoJob, updateMonoJobResult } from "./store";
import { gatewayBase, gatewayHeaders } from "@/lib/toolbox/gateway";
import type { MonoJob, ProductPipelineInput } from "./contracts";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);
const WORKFLOW_ID = "hat-62604171-v1";
const PRODUCT_CUTOUT_CONCURRENCY = Math.max(1, Math.min(3, Number(process.env.PRODUCT_PIPELINE_CUTOUT_CONCURRENCY) || 3));
const MODEL_CONCURRENCY = 2;
const DETAIL_SLOTS = [
  ["01", 790, 1243, "model"], ["02", 790, 681, "fixed"], ["03", 790, 1021, "model"],
  ["04", 790, 1008, "model"], ["05", 790, 1005, "model"], ["06", 790, 1004, "model"],
  ["07", 790, 1005, "model"], ["08", 790, 1025, "model"], ["09", 790, 688, "fixed"],
  ["10", 790, 610, "master"], ["11", 790, 1026, "original"],
] as const;
type DetailSlot = typeof DETAIL_SLOTS[number];
type TemplateManifest = { version: string; files: Record<string, { sha256: string; kind: string }> };

export type ProductFolder = { id: string; name: string; imageCount: number };
type SourceImage = { path: string; name: string; stem: string; size: number; mtimeMs: number; hash: string };

/** Kept server-side. Do not send this value or an absolute path to a browser. */
export function productSourceRoot(): string {
  return process.env.PRODUCT_PIPELINE_SOURCE_ROOT ?? "\\\\192.168.1.99\\picture\\型麦-得物-品牌\\【原图】-待制作";
}

function normalizeRoot(root = productSourceRoot()): string { return path.resolve(root); }
function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
function folderId(relative: string): string { return Buffer.from(relative, "utf8").toString("base64url"); }
function decodeFolderId(id: string): string {
  try { return Buffer.from(id, "base64url").toString("utf8"); } catch { throw new Error("无效的商品文件夹标识"); }
}

export function resolveProductFolder(id: string, root = productSourceRoot()): { absolutePath: string; relativePath: string } {
  const resolvedRoot = normalizeRoot(root);
  const relativePath = decodeFolderId(id);
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0")) throw new Error("无效的商品文件夹标识");
  const absolutePath = path.resolve(resolvedRoot, relativePath);
  if (!contained(resolvedRoot, absolutePath)) throw new Error("商品文件夹超出允许目录");
  return { absolutePath, relativePath: path.relative(resolvedRoot, absolutePath) };
}

async function validImageCount(originalDir: string): Promise<number> {
  try {
    const entries = await readdir(originalDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())).length;
  } catch { return 0; }
}

/** Only direct children and grandchildren that themselves contain 原图 are selectable. */
export async function listProductFolders(query = "", root = productSourceRoot()): Promise<ProductFolder[]> {
  const resolvedRoot = normalizeRoot(root);
  const rows: ProductFolder[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    const originals = path.join(dir, "原图");
    const count = await validImageCount(originals);
    if (count > 0 && contained(resolvedRoot, dir)) {
      const relative = path.relative(resolvedRoot, dir);
      const label = relative.replaceAll(path.sep, " / ");
      if (!query || label.toLocaleLowerCase().includes(query.toLocaleLowerCase())) rows.push({ id: folderId(relative), name: label, imageCount: count });
      return;
    }
    if (depth < 2) await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => visit(path.join(dir, entry.name), depth + 1)));
  };
  await visit(resolvedRoot, 0);
  return rows.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

export function validateProductPipelineInput(input: ProductPipelineInput): { relativePath: string } {
  if (input.workflowId !== WORKFLOW_ID) throw new Error("不支持的商品套图工作流");
  const resolved = resolveProductFolder(input.folderId);
  return { relativePath: resolved.relativePath };
}

async function sourceImages(originalDir: string): Promise<SourceImage[]> {
  const entries = await readdir(originalDir, { withFileTypes: true });
  const taken = new Set<string>();
  const result: SourceImage[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const stem = path.basename(entry.name, path.extname(entry.name));
    if (taken.has(stem.toLocaleLowerCase())) throw new Error(`原图存在重复文件名 stem：${stem}`);
    const filePath = path.join(originalDir, entry.name);
    try {
      await sharp(filePath).metadata();
      const [info, bytes] = await Promise.all([stat(filePath), readFile(filePath)]);
      taken.add(stem.toLocaleLowerCase());
      result.push({ path: filePath, name: entry.name, stem, size: info.size, mtimeMs: info.mtimeMs, hash: createHash("sha256").update(bytes).digest("hex") });
    } catch { /* damaged images are deliberately skipped */ }
  }
  if (!result.length) throw new Error("原图目录没有可用 JPG/JPEG/PNG 图片");
  return result;
}

async function assertSourcesUnchanged(sources: SourceImage[]): Promise<void> {
  for (const source of sources) {
    const current = await stat(source.path);
    if (current.size !== source.size || current.mtimeMs !== source.mtimeMs) throw new Error("运行期间检测到原图发生变化，任务已中止");
  }
}

async function requestCutout(source: SourceImage, signal: AbortSignal): Promise<Buffer> {
  const headers = gatewayHeaders();
  const bytes = await readFile(source.path);
  const uploaded = await fetch(`${gatewayBase()}/files/raw?name=${encodeURIComponent(source.name)}`, { method: "POST", headers: { ...headers, "content-type": "application/octet-stream" }, body: bytes, signal });
  if (!uploaded.ok) throw new Error(`product_cutout 上传失败：${uploaded.status}`);
  const file = await uploaded.json() as { file_id?: string };
  if (!file.file_id) throw new Error("product_cutout 未返回输入文件标识");
  const created = await fetch(`${gatewayBase()}/jobs`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ capability: "product_cutout", inputs: { image: file.file_id } }), signal });
  if (!created.ok) throw new Error(`product_cutout 创建失败：${created.status}`);
  const gatewayJob = await created.json() as { id?: string };
  if (!gatewayJob.id) throw new Error("product_cutout 未返回任务标识");
  for (let attempt = 0; attempt < 900; attempt += 1) {
    if (signal.aborted) throw new Error("任务已取消");
    const current = await fetch(`${gatewayBase()}/jobs/${encodeURIComponent(gatewayJob.id)}`, { headers, signal });
    if (!current.ok) throw new Error(`product_cutout 查询失败：${current.status}`);
    const info = await current.json() as { status?: string; error?: string; artifacts?: { path: string }[] };
    if (info.status === "failed" || info.status === "canceled") throw new Error(info.error ?? "product_cutout 失败");
    if (info.status === "succeeded") {
      const artifact = info.artifacts?.find((item) => item.path.toLowerCase().endsWith(".png"));
      if (!artifact) throw new Error("product_cutout 未返回 PNG 产物");
      const response = await fetch(`${gatewayBase()}/jobs/${encodeURIComponent(gatewayJob.id)}/artifacts/${artifact.path.split("/").map(encodeURIComponent).join("/")}`, { headers, signal });
      if (!response.ok) throw new Error(`product_cutout 下载失败：${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("product_cutout 超时");
}

export async function composeWhiteMaster(sourcePath: string, cutout: Buffer, output: string): Promise<void> {
  const [sourceMeta, cutoutMeta] = await Promise.all([sharp(sourcePath).metadata(), sharp(cutout).metadata()]);
  if (!sourceMeta.width || !sourceMeta.height) throw new Error("无法读取原图尺寸");
  if (cutoutMeta.width !== sourceMeta.width || cutoutMeta.height !== sourceMeta.height) {
    throw new Error("抠图产物尺寸与原图不一致，已拒绝改变商品构图");
  }
  // Retain the source pixels wherever the mask is opaque.  The cutout only
  // supplies alpha; it must never be resized or letterboxed into a new canvas.
  const [sourceRgb, alpha] = await Promise.all([
    sharp(sourcePath).removeAlpha().toColorspace("srgb").toBuffer(),
    sharp(cutout).ensureAlpha().extractChannel("alpha").toBuffer(),
  ]);
  const foreground = await sharp(sourceRgb).joinChannel(alpha).png().toBuffer();
  await sharp({ create: { width: sourceMeta.width, height: sourceMeta.height, channels: 3, background: "#ffffff" } })
    .composite([{ input: foreground, left: 0, top: 0 }])
    .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
    .toFile(output);
}

async function makeWhiteMaster(source: SourceImage, output: string, signal: AbortSignal): Promise<void> {
  await composeWhiteMaster(source.path, await requestCutout(source, signal), output);
}

/** Runs a bounded number of independent source-image jobs without allowing a
 * single product run to flood the gateway queue. */
export async function runWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  let failure: unknown;
  const run = async (): Promise<void> => {
    for (;;) {
      if (failure) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      try {
        await worker(values[index], index);
      } catch (error) {
        failure ??= error;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, run));
  if (failure) throw failure;
}

/**
 * Publish from the local Workbench staging disk to the product share.
 *
 * A rename is atomic only within one filesystem.  The staging area lives on
 * the Workbench disk whereas the product directory is a UNC share, so first
 * copy to a sibling directory on the share and only then rename on that share.
 */
export async function atomicPublish(stage: string, destination: string): Promise<void> {
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  const publishStage = path.join(parent, `.${path.basename(destination)}.workbench-stage-${randomUUID()}`);
  const backup = `${destination}.backup-${randomUUID()}`;
  let movedExisting = false;
  let published = false;
  try {
    await cp(stage, publishStage, { recursive: true, errorOnExist: true });
    try {
      await rename(destination, backup);
      movedExisting = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(publishStage, destination);
    published = true;
  } catch (error) {
    if (movedExisting && !published) {
      try { await rename(backup, destination); } catch { /* best effort restoration */ }
    }
    throw error;
  } finally {
    // A failed copy never affects the existing product directory.  A failed
    // publish leaves the local staging data for diagnosis/retry.
    if (!published) await rm(publishStage, { recursive: true, force: true });
  }
  // Cleanup must not turn an already-published, valid directory into a failed
  // job.  A stale backup is harmless and can be recovered manually if needed.
  await Promise.all([
    rm(backup, { recursive: true, force: true }),
    rm(stage, { recursive: true, force: true }),
  ]);
}

function progress(job: MonoJob, stage: string, percent: number, result: Record<string, unknown>): void {
  updateMonoJobResult(job.id, { stage, progress: percent, ...result });
}

/**
 * Deterministic white-master phase. Detail images intentionally require an installed,
 * versioned template bundle; this prevents accidental runtime use of 62604171.
 */
export async function runProductPipeline(job: MonoJob, signal: AbortSignal): Promise<Record<string, unknown>> {
  const folderId = String(job.input.folderId ?? "");
  const { absolutePath, relativePath } = resolveProductFolder(folderId);
  const sources = await sourceImages(path.join(absolutePath, "原图"));
  const stagingRoot = path.join(process.cwd(), "data", "product-pipeline-staging", job.id);
  const masterStage = path.join(stagingRoot, "主图");
  const masterDestination = path.join(absolutePath, "主图");
  const reusable = await findReusableMasters(masterDestination, sources);
  let masters: string[];
  if (reusable) {
    progress(job, "main_published", 20, { sourceCount: sources.length, resumed: true, masterHashes: reusable.map((item) => item.hash) });
    masters = reusable.map((item) => item.path);
  } else {
    await mkdir(masterStage, { recursive: true });
    progress(job, "正在生成白底主图", 5, { sourceCount: sources.length, outputs: [] });
    const outputs: ({ name: string; sha256: string } | undefined)[] = Array.from({ length: sources.length });
    await runWithConcurrency(sources, PRODUCT_CUTOUT_CONCURRENCY, async (source, index) => {
      if (signal.aborted) throw new Error("任务已取消");
      await assertSourcesUnchanged(sources);
      const name = `${source.stem}.jpg`; const output = path.join(masterStage, name);
      await makeWhiteMaster(source, output, signal);
      outputs[index] = { name, sha256: sha256(await readFile(output)) };
      progress(job, "正在生成白底主图", Math.round(5 + (outputs.filter(Boolean).length / sources.length) * 70), { sourceCount: sources.length, outputs: outputs.filter(Boolean) });
    });
    await assertSourcesUnchanged(sources);
    await atomicPublish(masterStage, masterDestination);
    masters = sources.map((source) => path.join(masterDestination, `${source.stem}.jpg`));
    progress(job, "main_published", 25, { resumed: false, masterHashes: await Promise.all(masters.map(fileHash)) });
  }
  const templateRoot = path.join(process.cwd(), "config", "product-pipeline", WORKFLOW_ID);
  const manifest = await validateTemplateBundle(templateRoot);
  await assertSourcesUnchanged(sources);
  progress(job, "classifying", 30, { templateVersion: manifest.version });
  const selected = await chooseProducts(masters, sources.length);
  if (!selected.length) throw new Error("无法识别可用商品颜色；未调用付费生图服务");
  const detailStage = path.join(stagingRoot, "images"); await mkdir(detailStage, { recursive: true });
  const baseName = path.basename(absolutePath);
  const records: Record<string, unknown>[] = [];
  progress(job, "generating_models", 35, { colorAssignments: selected.map((item) => item.index) });
  await runWithConcurrency(DETAIL_SLOTS.filter((slot) => slot[3] === "model"), MODEL_CONCURRENCY, async (slot, index) => {
    const assignment = selected.length === 1 ? 0 : selected.length === 2
      ? (index < 4 ? 0 : 1)
      : ([0, 0, 0, 1, 1, 2, 2][index] ?? 2);
    const product = selected[assignment].path;
    const scene = path.join(templateRoot, `model-${slot[0]}.svg`);
    const output = path.join(detailStage, `${baseName}_${slot[0]}.jpg`);
    const record = await generateModelSlot(product, scene, output, slot, signal);
    records.push({ slot: slot[0], ...record });
    progress(job, "generating_models", 35 + records.length * 5, { slots: records });
  });
  progress(job, "compositing", 75, { slots: records });
  for (const slot of DETAIL_SLOTS.filter((item) => item[3] !== "model")) {
    const output = path.join(detailStage, `${baseName}_${slot[0]}.jpg`);
    if (slot[3] === "fixed") await sharp(path.join(templateRoot, `fixed-${slot[0]}.svg`)).jpeg({ quality: 95 }).resize(slot[1], slot[2], { fit: "fill" }).toFile(output);
    else await makeCollage(slot[3] === "master" ? masters : sources.map((source) => source.path), output, slot[1], slot[2]);
    records.push({ slot: slot[0], attempts: 0, qa: "not-required", sha256: await fileHash(output) });
  }
  progress(job, "qa", 87, { slots: records });
  await verifyDetailOutputs(detailStage, baseName, sources, DETAIL_SLOTS);
  await assertSourcesUnchanged(sources);
  progress(job, "publishing_images", 93, { slots: records });
  await publishImages(detailStage, path.join(absolutePath, "images"), baseName);
  return { stage: "completed", progress: 100, relativePath, templateVersion: manifest.version, slots: records, resumed: Boolean(reusable) };
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fileHash(file: string): Promise<string> { return sha256(await readFile(file)); }
async function findReusableMasters(destination: string, sources: SourceImage[]): Promise<{ path: string; hash: string }[] | null> {
  try { const results = await Promise.all(sources.map(async (source) => { const file = path.join(destination, `${source.stem}.jpg`); await sharp(file).metadata(); return { path: file, hash: await fileHash(file) }; })); return results; } catch { return null; }
}
async function validateTemplateBundle(root: string): Promise<TemplateManifest> {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as TemplateManifest;
  if (manifest.version !== WORKFLOW_ID) throw new Error("商品套图模板版本不匹配");
  for (const [name, info] of Object.entries(manifest.files)) if (await fileHash(path.join(root, name)) !== info.sha256) throw new Error(`商品套图模板损坏: ${name}`);
  return manifest;
}
async function chooseProducts(masters: string[], sourceCount: number): Promise<{ path: string; index: number }[]> {
  const scored = await Promise.all(masters.map(async (file, index) => ({ path: file, index, score: (await sharp(file).stats()).channels.reduce((sum, channel) => sum + channel.stdev, 0) })));
  scored.sort((a, b) => b.score - a.score);
  const count = Math.min(3, Math.max(1, sourceCount)); return scored.slice(0, count);
}
async function generateModelSlot(product: string, scene: string, output: string, slot: DetailSlot, signal: AbortSignal): Promise<Record<string, unknown>> {
  let best: Buffer | null = null; let warning: string | undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const generated = await requestModelImage(product, scene, slot, signal);
    try { await sharp(generated).metadata(); best = generated; break; } catch { warning = "生成结果无法解码"; }
  }
  if (!best) throw new Error(`模特槽位 ${slot[0]} 没有有效候选图，未发布 images`);
  await sharp(best).resize(slot[1], slot[2], { fit: "cover", position: "centre" }).jpeg({ quality: 95 }).toFile(output);
  return { attempts: 1, qa: warning ? "warning" : "passed", warning, sha256: await fileHash(output) };
}
async function requestModelImage(product: string, scene: string, slot: DetailSlot, signal: AbortSignal): Promise<Buffer> {
  const base = process.env.MONO_IMAGE_BASE_URL; const key = process.env.MONO_IMAGE_API_KEY;
  if (!base || !key) throw new Error("详情套图需要配置 MONO_IMAGE_BASE_URL 和 MONO_IMAGE_API_KEY（将调用付费 gpt-image-2）");
  const endpoint = process.env.MONO_IMAGE_GENERATE_URL ?? new URL("/v1/api/generate", base).toString();
  const [productBytes, sceneBytes] = await Promise.all([readFile(product), readFile(scene)]);
  const dataUrl = (bytes: Buffer, mime: string) => `data:${mime};base64,${bytes.toString("base64")}`;
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ model: "gpt-image-2", prompt: `Create product model image slot ${slot[0]}. Product reference is authoritative for hat color, logo, embroidery, crown, brim and construction. Scene reference only constrains pose, composition, clothing mood and light; do not reproduce the reference person's identity. No extra hats or text.`, images: [dataUrl(productBytes, "image/jpeg"), dataUrl(sceneBytes, "image/svg+xml")], aspectRatio: `${slot[1]}:${slot[2]}`, replyType: "json" }), signal });
  const json = await response.json().catch(() => null) as { url?: string; results?: { url?: string }[] } | null;
  const url = json?.url ?? json?.results?.[0]?.url; if (!response.ok || !url) throw new Error(`gpt-image-2 请求失败 (HTTP ${response.status})`);
  const image = await fetch(url, { signal }); if (!image.ok) throw new Error("无法下载 gpt-image-2 结果"); return Buffer.from(await image.arrayBuffer());
}
async function makeCollage(inputs: string[], output: string, width: number, height: number): Promise<void> {
  const count = Math.min(3, inputs.length); const cell = Math.floor(width / count);
  const layers = await Promise.all(inputs.slice(0, count).map(async (input, index) => ({ input: await sharp(input).resize(cell, height, { fit: "contain", background: "white" }).jpeg().toBuffer(), left: index * cell, top: 0 })));
  await sharp({ create: { width, height, channels: 3, background: "white" } }).composite(layers).jpeg({ quality: 95 }).toFile(output);
}
async function verifyDetailOutputs(stage: string, base: string, sources: SourceImage[], slots: readonly DetailSlot[]): Promise<void> {
  for (const [id, width, height] of slots) { const meta = await sharp(path.join(stage, `${base}_${id}.jpg`)).metadata(); if (meta.width !== width || meta.height !== height) throw new Error(`详情图 ${id} 尺寸校验失败`); }
  await assertSourcesUnchanged(sources);
}
async function publishImages(stage: string, destination: string, base: string): Promise<void> {
  const merge = `${stage}-merged`; await mkdir(merge, { recursive: true });
  try { await cp(destination, merge, { recursive: true, errorOnExist: false }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const [id] of DETAIL_SLOTS) await cp(path.join(stage, `${base}_${id}.jpg`), path.join(merge, `${base}_${id}.jpg`));
  await atomicPublish(merge, destination);
}
