import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { updateMonoJobResult } from "./store";
import { gatewayBase, gatewayHeaders } from "@/lib/toolbox/gateway";
import { getConfigValue } from "@/lib/server/api-config";
import {
  allocateModelSlots,
  classifyProductSources,
  measureColorPresence,
  type SourceClassification,
} from "./product-classify";
import { applyBrandMark, renderDetailPresentation, renderTiledDisplay } from "./product-layouts";
import { buildModelPrompt, loadProductTemplate, type ProductTemplate } from "./product-template";
import type { MonoJob, ProductPipelineInput } from "./contracts";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);
const WORKFLOW_ID = "hat-62604171-v1";
const MODEL_CONCURRENCY = 2;
const DETAIL_SLOTS = [
  ["01", 790, 1243, "model"], ["02", 790, 681, "fixed"], ["03", 790, 1021, "model"],
  ["04", 790, 1008, "model"], ["05", 790, 1005, "model"], ["06", 790, 1004, "model"],
  ["07", 790, 1005, "model"], ["08", 790, 1025, "model"], ["09", 790, 688, "fixed"],
  ["10", 790, 610, "tiled"], ["11", 790, 1026, "detail"],
] as const;
type DetailSlot = typeof DETAIL_SLOTS[number];
type TemplateManifest = { version: string; files: Record<string, { sha256: string; kind: string }> };

/**
 * Colour-fidelity gate for generated model shots. A generated frame should
 * contain a meaningful patch of the product's colour; when it does not, the
 * model has most likely substituted a different article. This is a heuristic
 * over a whole photo, so it records a warning rather than failing the run —
 * an unattended pipeline must not stall on a false positive.
 */
const COLOR_PRESENCE_DELTA_E = 20;
const COLOR_PRESENCE_MIN_RATIO = 0.02;

export type ProductFolder = { id: string; name: string; imageCount: number };
type SourceImage = { path: string; name: string; stem: string; size: number; mtimeMs: number; hash: string };

export type ProductPipelineSchedulingSettings = {
  activeFolders: number;
  perFolderCutouts: number;
  globalCutouts: number;
};

type Environment = Record<string, string | undefined>;

function boundedConcurrency(env: Environment, key: string, fallback: number, ceiling: number): number {
  const value = Number(env[key]);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(ceiling, Math.floor(value));
}

/**
 * These limits are intentionally configurable downward for GPU tuning, but the
 * production-safe ceilings prevent an accidental environment value from
 * exceeding the agreed four product slots / six per folder / twelve total.
 */
export function productPipelineSchedulingSettings(
  env: Environment = process.env,
): ProductPipelineSchedulingSettings {
  const globalCutouts = boundedConcurrency(
    env,
    "PRODUCT_PIPELINE_GLOBAL_CUTOUT_CONCURRENCY",
    12,
    12,
  );
  const configuredPerFolder = env.PRODUCT_PIPELINE_FOLDER_CUTOUT_CONCURRENCY
    ?? env.PRODUCT_PIPELINE_CUTOUT_CONCURRENCY;
  const perFolderCutouts = Math.min(
    globalCutouts,
    boundedConcurrency(
      { PRODUCT_PIPELINE_FOLDER_CUTOUT_CONCURRENCY: configuredPerFolder },
      "PRODUCT_PIPELINE_FOLDER_CUTOUT_CONCURRENCY",
      6,
      6,
    ),
  );
  return {
    activeFolders: boundedConcurrency(env, "PRODUCT_PIPELINE_ACTIVE_FOLDERS", 4, 4),
    perFolderCutouts,
    globalCutouts,
  };
}

type CutoutWaiter = {
  folderKey: string;
  resolve: (release: () => void) => void;
  reject: (reason: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

/**
 * One Workbench process can run several product jobs.  This arbiter applies a
 * shared global ceiling while choosing the least-occupied product first; ties
 * rotate, so four simultaneously active products receive 3/3/3/3 rather than
 * letting the first folder flood the gateway queue.
 */
export class ProductCutoutScheduler {
  private readonly globalCutouts: number;
  private readonly perFolderCutouts: number;
  private active = 0;
  private readonly activeByFolder = new Map<string, number>();
  private readonly waitersByFolder = new Map<string, CutoutWaiter[]>();
  private folderOrder: string[] = [];
  private lastGrantedFolder: string | null = null;
  private drainScheduled = false;

  constructor(settings: Pick<ProductPipelineSchedulingSettings, "globalCutouts" | "perFolderCutouts">) {
    this.globalCutouts = Math.max(1, Math.floor(settings.globalCutouts));
    this.perFolderCutouts = Math.min(
      this.globalCutouts,
      Math.max(1, Math.floor(settings.perFolderCutouts)),
    );
  }

  async run<T>(folderKey: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(folderKey, signal);
    try {
      return await work();
    } finally {
      release();
    }
  }

  acquire(folderKey: string, signal?: AbortSignal): Promise<() => void> {
    if (!folderKey) return Promise.reject(new Error("商品抠图缺少文件夹队列标识"));
    if (signal?.aborted) return Promise.reject(new Error("任务已取消"));
    return new Promise<() => void>((resolve, reject) => {
      const waiter: CutoutWaiter = { folderKey, resolve, reject, signal };
      const onAbort = () => {
        this.removeWaiter(waiter);
        reject(new Error("任务已取消"));
        this.scheduleDrain();
      };
      waiter.onAbort = onAbort;
      const queue = this.waitersByFolder.get(folderKey) ?? [];
      if (!this.waitersByFolder.has(folderKey)) {
        this.waitersByFolder.set(folderKey, queue);
        this.folderOrder.push(folderKey);
      }
      queue.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      this.scheduleDrain();
    });
  }

  getStats(): { active: number; activeByFolder: Record<string, number>; queuedByFolder: Record<string, number> } {
    return {
      active: this.active,
      activeByFolder: Object.fromEntries(this.activeByFolder),
      queuedByFolder: Object.fromEntries(
        [...this.waitersByFolder.entries()].filter(([, queue]) => queue.length).map(([key, queue]) => [key, queue.length]),
      ),
    };
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.globalCutouts) {
      const folderKey = this.nextFolderToGrant();
      if (!folderKey) return;
      const queue = this.waitersByFolder.get(folderKey);
      const waiter = queue?.shift();
      if (!waiter) {
        this.pruneFolder(folderKey);
        continue;
      }
      waiter.signal?.removeEventListener("abort", waiter.onAbort!);
      this.active += 1;
      this.activeByFolder.set(folderKey, (this.activeByFolder.get(folderKey) ?? 0) + 1);
      this.lastGrantedFolder = folderKey;
      waiter.resolve(this.releaseFor(folderKey));
    }
  }

  private nextFolderToGrant(): string | null {
    const candidates = this.folderOrder.filter((folderKey) => {
      const queue = this.waitersByFolder.get(folderKey);
      return Boolean(queue?.length) && (this.activeByFolder.get(folderKey) ?? 0) < this.perFolderCutouts;
    });
    if (!candidates.length) return null;
    const fewestActive = Math.min(...candidates.map((key) => this.activeByFolder.get(key) ?? 0));
    const eligible = new Set(candidates.filter((key) => (this.activeByFolder.get(key) ?? 0) === fewestActive));
    const lastIndex = this.lastGrantedFolder ? this.folderOrder.indexOf(this.lastGrantedFolder) : -1;
    for (let offset = 1; offset <= this.folderOrder.length; offset += 1) {
      const key = this.folderOrder[(lastIndex + offset + this.folderOrder.length) % this.folderOrder.length];
      if (eligible.has(key)) return key;
    }
    return candidates[0];
  }

  private releaseFor(folderKey: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const previous = this.activeByFolder.get(folderKey) ?? 0;
      this.active = Math.max(0, this.active - 1);
      if (previous <= 1) this.activeByFolder.delete(folderKey);
      else this.activeByFolder.set(folderKey, previous - 1);
      this.pruneFolder(folderKey);
      this.scheduleDrain();
    };
  }

  private removeWaiter(waiter: CutoutWaiter): void {
    const queue = this.waitersByFolder.get(waiter.folderKey);
    const index = queue?.indexOf(waiter) ?? -1;
    if (index >= 0) queue!.splice(index, 1);
    this.pruneFolder(waiter.folderKey);
  }

  private pruneFolder(folderKey: string): void {
    const queue = this.waitersByFolder.get(folderKey);
    if (queue?.length || (this.activeByFolder.get(folderKey) ?? 0) > 0) return;
    this.waitersByFolder.delete(folderKey);
    this.folderOrder = this.folderOrder.filter((key) => key !== folderKey);
    if (this.lastGrantedFolder === folderKey) this.lastGrantedFolder = null;
  }
}

const PRODUCT_PIPELINE_SCHEDULING = productPipelineSchedulingSettings();
const PRODUCT_CUTOUT_CONCURRENCY = PRODUCT_PIPELINE_SCHEDULING.perFolderCutouts;
const productCutoutScheduler = new ProductCutoutScheduler(PRODUCT_PIPELINE_SCHEDULING);

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

/** A server-only, opaque identity for a shared product folder. */
export function productPipelineFolderKey(folderId: string): string {
  // Canonicalize base64url first so a padded and an unpadded representation of
  // the same server-issued folder id cannot create two independent queues.
  const canonicalId = Buffer.from(folderId, "base64url").toString("base64url");
  return createHash("sha256").update(canonicalId).digest("hex");
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

export function validateProductPipelineInput(input: ProductPipelineInput): { relativePath: string; folderKey: string } {
  if (input.workflowId !== WORKFLOW_ID) throw new Error("不支持的商品套图工作流");
  const resolved = resolveProductFolder(input.folderId);
  return {
    relativePath: resolved.relativePath,
    folderKey: productPipelineFolderKey(input.folderId),
  };
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

async function requestCutout(source: SourceImage, folderKey: string, signal: AbortSignal): Promise<Buffer> {
  return productCutoutScheduler.run(folderKey, async () => {
    const headers = gatewayHeaders();
    const bytes = await readFile(source.path);
    const uploaded = await fetch(`${gatewayBase()}/files/raw?name=${encodeURIComponent(source.name)}`, { method: "POST", headers: { ...headers, "content-type": "application/octet-stream" }, body: bytes, signal });
    if (!uploaded.ok) throw new Error(`product_cutout 上传失败：${uploaded.status}`);
    const file = await uploaded.json() as { file_id?: string };
    if (!file.file_id) throw new Error("product_cutout 未返回输入文件标识");
    const created = await fetch(`${gatewayBase()}/jobs`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      // The gateway receives an opaque queue label only.  No UNC path or folder
      // name is present in the request, logs, or browser-visible job response.
      body: JSON.stringify({ capability: "product_cutout", params: { productFolderKey: folderKey }, inputs: { image: file.file_id } }),
      signal,
    });
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
  }, signal);
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
    // The gateway now returns the matte on its own as a grayscale PNG.  Earlier
    // artifacts carried it as the alpha of a full-size RGBA copy of the source,
    // whose colour channels were discarded right here — so accept either shape
    // rather than pinning the two deployments to the same release.
    cutoutMeta.hasAlpha
      ? sharp(cutout).extractChannel("alpha").toBuffer()
      : sharp(cutout).toColorspace("b-w").toBuffer(),
  ]);
  const foreground = await sharp(sourceRgb).joinChannel(alpha).png().toBuffer();
  await sharp({ create: { width: sourceMeta.width, height: sourceMeta.height, channels: 3, background: "#ffffff" } })
    .composite([{ input: foreground, left: 0, top: 0 }])
    .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
    .toFile(output);
}

async function makeWhiteMaster(source: SourceImage, output: string, folderKey: string, signal: AbortSignal): Promise<void> {
  await composeWhiteMaster(source.path, await requestCutout(source, folderKey, signal), output);
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
 * Deterministic white-master phase, then the detail set.
 *
 * The detail set requires an installed, hash-verified template bundle: the
 * bundle carries only category-level styling, so an unattended run can never
 * fall back to describing one particular article it happens to remember.
 */
export async function runProductPipeline(job: MonoJob, signal: AbortSignal): Promise<Record<string, unknown>> {
  const folderId = String(job.input.folderId ?? "");
  const { absolutePath, relativePath } = resolveProductFolder(folderId);
  const folderKey = productPipelineFolderKey(folderId);
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
      await makeWhiteMaster(source, output, folderKey, signal);
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
  const template = await loadProductTemplate(templateRoot);
  if (template.version !== manifest.version) throw new Error("商品套图模板版本不匹配");
  await assertSourcesUnchanged(sources);
  progress(job, "classifying", 30, { templateVersion: manifest.version });

  // Colourways and macro crops are recovered from the shoot itself; nothing in
  // the folder labels them, and no human edits the set between steps.
  const classification = await classifyProductSources(masters);
  if (!classification.colors.length) throw new Error("无法识别可用商品颜色；未调用付费生图服务");
  const modelSlots = DETAIL_SLOTS.filter((slot) => slot[3] === "model");
  const allocation = allocateModelSlots(classification.colors.length, modelSlots.length);
  const warnings = [...classification.warnings];
  progress(job, "generating_models", 35, {
    colors: classification.colors.map((color) => ({
      rank: color.rank,
      lab: color.lab.map((channel) => Math.round(channel * 10) / 10),
      shots: color.members.length,
    })),
    detailShots: classification.details.length,
    slotColorRanks: allocation,
    warnings,
  });

  const detailStage = path.join(stagingRoot, "images"); await mkdir(detailStage, { recursive: true });
  const baseName = path.basename(absolutePath);
  const records: Record<string, unknown>[] = [];
  await runWithConcurrency(modelSlots, MODEL_CONCURRENCY, async (slot, index) => {
    const color = classification.colors[allocation[index]];
    const output = path.join(detailStage, `${baseName}_${slot[0]}.jpg`);
    const record = await generateModelSlot(template, templateRoot, color, output, slot, signal, job.workspaceId);
    records.push({ slot: slot[0], colorRank: color.rank, ...record });
    if (record.warning) warnings.push(`${slot[0]}: ${record.warning}`);
    progress(job, "generating_models", 35 + records.length * 5, { slots: records, warnings });
  });

  progress(job, "compositing", 75, { slots: records, warnings });
  for (const slot of DETAIL_SLOTS.filter((item) => item[3] !== "model")) {
    const output = path.join(detailStage, `${baseName}_${slot[0]}.jpg`);
    await renderCompositedSlot(template, templateRoot, classification, slot, output);
    records.push({ slot: slot[0], attempts: 0, qa: "not-required", sha256: await fileHash(output) });
  }
  progress(job, "qa", 87, { slots: records, warnings });
  await verifyDetailOutputs(detailStage, baseName, sources, DETAIL_SLOTS);
  await assertSourcesUnchanged(sources);
  progress(job, "publishing_images", 93, { slots: records, warnings });
  await publishImages(detailStage, path.join(absolutePath, "images"), baseName);
  return {
    stage: "completed",
    progress: 100,
    relativePath,
    templateVersion: manifest.version,
    slots: records,
    warnings,
    resumed: Boolean(reusable),
  };
}

/**
 * Slots that are assembled from the shoot rather than generated: the two
 * ready-made spec pages, the colourway line-up and the detail page.
 */
async function renderCompositedSlot(
  template: ProductTemplate,
  templateRoot: string,
  classification: SourceClassification,
  slot: DetailSlot,
  output: string,
): Promise<void> {
  const [id, width, height, kind] = slot;
  if (kind === "fixed") {
    const asset = template.fixedSlots[id];
    if (!asset) throw new Error(`模板缺少固定页 ${id}`);
    // The bundled page is already at the published size, so copy it through
    // rather than re-encoding and softening the type on it.
    await cp(path.join(templateRoot, asset), output);
    return;
  }
  if (kind === "tiled") {
    await renderTiledDisplay(
      classification.colors.map((color) => color.representative),
      output, width, height, template.pages["10"].title,
    );
    return;
  }
  // A shoot without macro crops still needs a detail page; fall back to the
  // hero colourway's angles so the slot is never published empty.
  const crops = classification.details.length ? classification.details : classification.colors[0].members;
  await renderDetailPresentation(
    crops, output, width, height, template.pages["11"].title, template.pages["11"].caption,
  );
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
/** How many angles of the chosen colourway are sent as product references. */
const PRODUCT_REFERENCE_COUNT = 3;

async function generateModelSlot(
  template: ProductTemplate,
  templateRoot: string,
  color: SourceClassification["colors"][number],
  output: string,
  slot: DetailSlot,
  signal: AbortSignal,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  const prompt = buildModelPrompt(template, slot[0], color.rank, slot[1], slot[2]);
  // Several angles of the same colourway make it much harder for the model to
  // invent a plain version of an article whose graphic sits on one face only.
  const references = color.members.slice(0, PRODUCT_REFERENCE_COUNT).map((member) => member.path);
  let best: Buffer | null = null;
  let warning: string | undefined;
  let attempts = 0;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    attempts = attempt;
    const generated = await requestModelImage(references, prompt, slot, signal, workspaceId);
    try { await sharp(generated).metadata(); best = generated; break; } catch { warning = "生成结果无法解码"; }
  }
  if (!best) throw new Error(`模特槽位 ${slot[0]} 没有有效候选图，未发布 images`);
  await sharp(best).resize(slot[1], slot[2], { fit: "cover", position: "centre" }).jpeg({ quality: 95 }).toFile(output);
  if (template.brandMark?.slots.includes(slot[0])) {
    // The wordmark is decoration over an image that has already been paid for.
    // Losing it is worth a warning, never worth discarding the generation.
    try {
      await applyBrandMark(output, template.brandMark, templateRoot);
    } catch (error) {
      warning = `品牌角标未能叠加：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // Coarse fidelity signal only: it catches a wholly wrong colourway, not a
  // dropped print or embroidery, so it never blocks publishing on its own.
  const presence = await measureColorPresence(output, color.lab, COLOR_PRESENCE_DELTA_E);
  if (presence < COLOR_PRESENCE_MIN_RATIO) {
    warning = `画面中几乎找不到该颜色（${(presence * 100).toFixed(1)}%），商品可能被换色，请人工复核`;
  }
  return {
    attempts,
    qa: warning ? "warning" : "passed",
    warning,
    colorPresence: Math.round(presence * 1000) / 1000,
    sha256: await fileHash(output),
  };
}

async function requestModelImage(
  references: readonly string[],
  prompt: string,
  slot: DetailSlot,
  signal: AbortSignal,
  workspaceId: string,
): Promise<Buffer> {
  const base = getConfigValue("MONO_IMAGE_BASE_URL", workspaceId); const key = getConfigValue("MONO_IMAGE_API_KEY", workspaceId);
  if (!base || !key) throw new Error("详情套图需要配置 MONO_IMAGE_BASE_URL 和 MONO_IMAGE_API_KEY（将调用付费 gpt-image-2）");
  const endpoint = process.env.MONO_IMAGE_GENERATE_URL ?? new URL("/v1/api/generate", base).toString();
  const bytes = await Promise.all(references.map((file) => readFile(file)));
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "gpt-image-2",
      prompt,
      images: bytes.map((buffer) => `data:image/jpeg;base64,${buffer.toString("base64")}`),
      aspectRatio: `${slot[1]}:${slot[2]}`,
      replyType: "json",
    }),
    signal,
  });
  const json = await response.json().catch(() => null) as { url?: string; results?: { url?: string }[] } | null;
  const url = json?.url ?? json?.results?.[0]?.url; if (!response.ok || !url) throw new Error(`gpt-image-2 请求失败 (HTTP ${response.status})`);
  const image = await fetch(url, { signal }); if (!image.ok) throw new Error("无法下载 gpt-image-2 结果"); return Buffer.from(await image.arrayBuffer());
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
