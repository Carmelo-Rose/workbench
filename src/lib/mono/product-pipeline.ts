import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { readdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { updateMonoJobResult } from "./store";
import { gatewayBase, gatewayHeaders } from "@/lib/toolbox/gateway";
import { getConfigValue } from "@/lib/server/api-config";
import {
  allocateModelSlots,
  classifyProductSources,
  measureColorPresence,
  type RelativeBox,
  type SourceClassification,
} from "./product-classify";
import { applyBrandMark, renderDetailPresentation, renderTiledDisplay } from "./product-layouts";
import { buildModelPrompt, loadProductTemplate, type ProductTemplate } from "./product-template";
import type { MonoJob, ProductPipelineInput } from "./contracts";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);
/** Default when a caller does not name one; not the only one that is accepted. */
export const WORKFLOW_ID = "hat-62604171-v1";

export type ProductWorkflow = { id: string; label: string };

function workflowsRoot(): string {
  return path.join(process.cwd(), "config", "product-pipeline");
}

export function productTemplateRoot(workflowId: string): string {
  // The id is checked against the installed directory names before it ever gets
  // here, so it cannot be steered outside the bundle root.
  return path.join(workflowsRoot(), workflowId);
}

/**
 * Installed template bundles = subdirectories of `config/product-pipeline`.
 *
 * Adding a category is meant to be "drop a bundle in and restart" — no code
 * change in the launcher, the runner, or the card. Read synchronously because
 * job validation is synchronous and this is a handful of local directory
 * entries, not the network share.
 */
export function installedWorkflowIds(): Set<string> {
  try {
    return new Set(readdirSync(workflowsRoot(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name));
  } catch { return new Set(); }
}

/** Installed bundles with the human-facing category name out of each template. */
export async function listProductWorkflows(): Promise<ProductWorkflow[]> {
  const ids = [...installedWorkflowIds()].sort();
  return Promise.all(ids.map(async (id) => {
    try {
      const template = JSON.parse(await readFile(path.join(productTemplateRoot(id), "template.json"), "utf8")) as { categoryLabel?: string };
      return { id, label: template.categoryLabel ? `${template.categoryLabel}详情套图` : id };
    } catch { return { id, label: id }; }
  }));
}
const MODEL_CONCURRENCY = 6;
const DETAIL_SLOTS = [
  ["01", 790, 1243, "model"], ["02", 790, 681, "fixed"], ["03", 790, 1021, "model"],
  ["04", 790, 1008, "model"], ["05", 790, 1005, "model"], ["06", 790, 1004, "model"],
  ["07", 790, 1005, "model"], ["08", 790, 1025, "model"], ["09", 790, 688, "fixed"],
  ["10", 790, 610, "tiled"], ["11", 790, 1026, "detail"],
] as const;
export type DetailSlot = typeof DETAIL_SLOTS[number];
export const MODEL_SLOTS: readonly DetailSlot[] = DETAIL_SLOTS.filter((slot) => slot[3] === "model");
const MODEL_SLOT_IDS: ReadonlySet<string> = new Set(MODEL_SLOTS.map((slot) => slot[0]));

/** Narrows a retry run to the requested model slots, in their original template order. */
export function selectModelSlots(onlySlots: readonly string[] | null | undefined): DetailSlot[] {
  if (!onlySlots?.length) return [...MODEL_SLOTS];
  const wanted = new Set(onlySlots);
  return MODEL_SLOTS.filter((slot) => wanted.has(slot[0]));
}
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

export type ProductFolder = {
  id: string;
  name: string;
  imageCount: number;
  /** `x_` 开头的细节特写张数；为 0 时 11 号页要退化成用整体图拼版。 */
  detailShotCount: number;
  /** 详情页目录的 `主图/` 里已经有本文件夹的产物，再跑一次会覆盖（抠图本身不会跳过）。 */
  hasMasters: boolean;
  /** 详情页目录的 `images/` 里已经有本文件夹的成品，再跑一次会覆盖。 */
  hasImages: boolean;
};
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

/**
 * Where the pipeline's output lives: 主图/SKU/images, mirrored under the
 * product's own name. This is deliberately a different tree from
 * `productSourceRoot()` — 【原图】-待制作 is raw material handed to the
 * pipeline, 【详情页】-待审 is what a person reviews afterward, and the two
 * must not be conflated even though a folder shares its name across both.
 */
export function productDetailPageRoot(): string {
  return process.env.PRODUCT_PIPELINE_DETAIL_ROOT ?? "\\\\192.168.1.99\\picture\\型麦-得物-品牌\\【详情页】-待审";
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

/** The 【详情页】-待审 mirror of a resolved source folder's `relativePath`. */
export function resolveDetailPageFolder(relativePath: string, root = productDetailPageRoot()): string {
  const resolvedRoot = normalizeRoot(root);
  const absolutePath = path.resolve(resolvedRoot, relativePath);
  if (!contained(resolvedRoot, absolutePath)) throw new Error("详情页目录超出允许目录");
  return absolutePath;
}

/** A server-only, opaque identity for a shared product folder. */
export function productPipelineFolderKey(folderId: string): string {
  // Canonicalize base64url first so a padded and an unpadded representation of
  // the same server-issued folder id cannot create two independent queues.
  const canonicalId = Buffer.from(folderId, "base64url").toString("base64url");
  return createHash("sha256").update(canonicalId).digest("hex");
}

/** Image file stems in a directory; empty when the directory is missing. */
async function imageStems(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => path.parse(entry.name).name);
  } catch { return []; }
}

/**
 * What the shoot folder already contains, from directory listings alone.
 *
 * Deliberately shallow: no cutout, no colour classification, no image decode.
 * This runs for every folder on a network share each time the picker opens, and
 * its only job is to tell the user what pressing "开始生成" will actually do —
 * publish over an existing set, or fall back on the detail page because nobody
 * staged any macro crops. `sourceDir` and `detailDir` are two different trees
 * (原图 stays under 【原图】-待制作, 主图/images are read from the
 * 【详情页】-待审 mirror), so both are needed here.
 */
async function folderStatus(sourceDir: string, detailDir: string, folderName: string): Promise<Omit<ProductFolder, "id" | "name">> {
  const [originals, masters, published] = await Promise.all([
    imageStems(path.join(sourceDir, "原图")),
    imageStems(path.join(detailDir, "主图")),
    imageStems(path.join(detailDir, "images")),
  ]);
  const article = originals.filter((stem) => !DETAIL_SHOT_PATTERN.test(stem));
  const masterStems = new Set(masters);
  return {
    imageCount: originals.length,
    detailShotCount: originals.length - article.length,
    hasMasters: article.length > 0 && article.every((stem) => masterStems.has(stem)),
    hasImages: published.some((stem) => new RegExp(`^${escapeRegExp(folderName)}_\\d{2}$`, "u").test(stem)),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Only direct children and grandchildren that themselves contain 原图 are selectable. */
export async function listProductFolders(
  query = "",
  root = productSourceRoot(),
  detailRoot = productDetailPageRoot(),
): Promise<ProductFolder[]> {
  const resolvedRoot = normalizeRoot(root);
  const resolvedDetailRoot = normalizeRoot(detailRoot);
  const rows: ProductFolder[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    const originals = path.join(dir, "原图");
    const count = (await imageStems(originals)).length;
    if (count > 0 && contained(resolvedRoot, dir)) {
      const relative = path.relative(resolvedRoot, dir);
      const label = relative.replaceAll(path.sep, " / ");
      // Only folders that survive the query pay for the extra listings.
      if (!query || label.toLocaleLowerCase().includes(query.toLocaleLowerCase())) {
        const detailDir = path.join(resolvedDetailRoot, relative);
        rows.push({ id: folderId(relative), name: label, ...await folderStatus(dir, detailDir, path.basename(dir)) });
      }
      return;
    }
    if (depth < 2) await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => visit(path.join(dir, entry.name), depth + 1)));
  };
  await visit(resolvedRoot, 0);
  return rows.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

/**
 * Turn what a person calls a folder ("1234") into the opaque id the pipeline
 * takes.
 *
 * Refuses rather than guesses when the name matches more than one folder. The
 * caller here is a language model acting on a sentence typed in chat, and the
 * action it is resolving spends real money on seven generated images and
 * overwrites a folder on a shared drive — so "1234" matching both `1234` and
 * `12345` has to come back as a question, not as a coin flip. An exact match on
 * the folder's own name always wins outright, which is what keeps `1234`
 * usable even though `12345` and `123456` exist alongside it.
 */
export async function resolveProductFolderByName(
  name: string,
  root = productSourceRoot(),
): Promise<{ id: string; name: string }> {
  const wanted = name.trim();
  if (!wanted) throw new Error("请提供商品文件夹名");
  const folders = await listProductFolders("", root);
  const leafOf = (label: string) => label.split(" / ").at(-1) ?? label;
  const exact = folders.filter((folder) => leafOf(folder.name) === wanted || folder.name === wanted);
  const matches = exact.length ? exact : folders.filter((folder) =>
    folder.name.toLocaleLowerCase().includes(wanted.toLocaleLowerCase()));
  if (!matches.length) throw new Error(`没有找到名为「${wanted}」的商品文件夹`);
  if (matches.length > 1) {
    // The full label, not the leaf: a shoot can be split into `XM2606011 / 普通版`
    // and `XM2606011 / 水洗版`, and listing those as "普通版、水洗版" gives the
    // user nothing to choose between.
    throw new Error(`「${wanted}」匹配到多个商品文件夹：${matches.map((folder) => folder.name).join("、")}。请确认要跑哪一个。`);
  }
  return { id: matches[0].id, name: leafOf(matches[0].name) };
}

export function validateProductPipelineInput(input: ProductPipelineInput): { relativePath: string; folderKey: string } {
  // Whatever bundles are installed, not one hardcoded id — but still a
  // membership test against real directory names, so the value can never reach
  // `productTemplateRoot` as a path fragment of the caller's choosing.
  if (!installedWorkflowIds().has(input.workflowId)) throw new Error("不支持的商品套图工作流");
  const resolved = resolveProductFolder(input.folderId);
  if (input.onlySlots?.length) {
    const invalid = input.onlySlots.filter((slot) => !MODEL_SLOT_IDS.has(slot));
    if (invalid.length) throw new Error(`onlySlots 包含非法槽位：${invalid.join(", ")}`);
  }
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

/**
 * Detail shots are named `x_1`, `x_2`, … in the shoot folder.
 *
 * They are macro crops of the article rather than frames of the whole thing, so
 * they must not go through the rest of the pipeline: cutting them out to white
 * would destroy them, and colour-clustering a macro of a dark lining invents a
 * colourway that the product does not have. Naming them is also the only signal
 * we get — the earlier edge-occupancy heuristic silently found nothing whenever
 * a folder's macros were framed loosely, and the detail page then published
 * whole-cap angles instead. They are handed to the detail page in filename order.
 */
/**
 * Where a run assembles its slots before the single atomic publish at the end.
 *
 * Exported because the images route serves from here while a job is still
 * running: a slot is finished (and paid for) minutes before anything reaches
 * the shared drive, and the progress board has nothing to show until then.
 */
/**
 * Which colourway each model slot is generated in, keyed by slot id.
 *
 * Always computed against the *full* model slot list, never against the slots
 * a given run happens to be generating. A retry narrowed to slot 04 must give
 * it exactly the colourway the original run did; allocating over a list of
 * length one would hand it rank 0 — the hero colourway — and the run would
 * cheerfully pay for a wrong-colour image and publish it over the good one.
 */
export function modelSlotColorRanks(colorCount: number): Map<string, number> {
  const allocation = allocateModelSlots(colorCount, MODEL_SLOTS.length);
  return new Map(MODEL_SLOTS.map((slot, index) => [slot[0], allocation[index]] as const));
}

export function productPipelineStagingRoot(jobId: string): string {
  return path.join(process.cwd(), "data", "product-pipeline-staging", jobId);
}

const DETAIL_SHOT_PATTERN = /^x_(\d+)$/iu;

function partitionSources(sources: SourceImage[]): { article: SourceImage[]; details: SourceImage[] } {
  const article: SourceImage[] = [];
  const details: { order: number; source: SourceImage }[] = [];
  for (const source of sources) {
    const match = DETAIL_SHOT_PATTERN.exec(source.stem);
    if (match) details.push({ order: Number(match[1]), source });
    else article.push(source);
  }
  details.sort((first, second) => first.order - second.order);
  return { article, details: details.map((item) => item.source) };
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

/**
 * Flattens onto white at the source's own framing and returns the RGBA
 * foreground (source pixels, cutout alpha) alongside it. The flattened file is
 * the classification-safe "master" — full frame, natural studio margin —
 * used for colour clustering and as the gpt-image-2 reference set. The
 * returned buffer carries the real segmentation alpha forward for
 * `composeSquareDeliverable`, which needs it once a product's crop box is
 * known and must not have to re-derive a silhouette by thresholding a
 * flattened JPEG.
 */
export async function composeWhiteMaster(sourcePath: string, cutout: Buffer, output: string): Promise<Buffer> {
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
  return foreground;
}

async function makeWhiteMaster(source: SourceImage, output: string, folderKey: string, signal: AbortSignal): Promise<Buffer> {
  return composeWhiteMaster(source.path, await requestCutout(source, folderKey, signal), output);
}

/** Square 1:1 deliverable side, matching the hand-built reference set on the share. */
const SQUARE_CANVAS_SIZE = 800;
/** Breathing room kept around the product when cropping to its measured box. */
const SQUARE_CROP_PADDING = 0.04;
/** Product's longer side as a fraction of the canvas; the rest is white margin. */
const SQUARE_FILL_RATIO = 0.86;
const SHADOW_BLUR_SIGMA = 14;
const SHADOW_OPACITY = 0.35;
const SHADOW_OFFSET_RATIO = 0.02;

/** Crops an RGBA buffer to a relative box plus padding, in pixel space. */
async function cropBufferToBox(buffer: Buffer, box: RelativeBox, padding: number): Promise<Buffer> {
  const { width, height } = await sharp(buffer).metadata();
  if (!width || !height) throw new Error("无法读取白底图尺寸");
  const left = Math.max(0, Math.round((box.left - padding) * width));
  const top = Math.max(0, Math.round((box.top - padding) * height));
  const right = Math.min(width, Math.round((box.left + box.width + padding) * width));
  const bottom = Math.min(height, Math.round((box.top + box.height + padding) * height));
  return sharp(buffer)
    .extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) })
    .png()
    .toBuffer();
}

/**
 * Renders the published 1:1 deliverable: the product cropped to its measured
 * box, centred on a white square, with an optional soft contact shadow.
 *
 * `box` must come from measuring the *same* foreground this was cut from
 * (`classification`'s per-shot box) — a mismatched box would crop the wrong
 * region of a differently-framed photo.
 */
export async function composeSquareDeliverable(
  foreground: Buffer,
  box: RelativeBox,
  output: string,
  options: { shadow: boolean },
): Promise<void> {
  const cropped = await cropBufferToBox(foreground, box, SQUARE_CROP_PADDING);
  const target = Math.round(SQUARE_CANVAS_SIZE * SQUARE_FILL_RATIO);
  const { data: resized, info } = await sharp(cropped)
    .resize(target, target, { fit: "inside" })
    .png()
    .toBuffer({ resolveWithObject: true });
  const left = Math.round((SQUARE_CANVAS_SIZE - info.width) / 2);
  const top = Math.round((SQUARE_CANVAS_SIZE - info.height) / 2);
  const layers: { input: Buffer; left: number; top: number }[] = [];
  if (options.shadow) {
    // A blurred, dimmed copy of the product's own alpha silhouette, offset
    // down slightly — a cheap but convincing contact shadow that needs no
    // extra segmentation pass since the alpha channel is already exact.
    const shadowAlpha = await sharp(resized).extractChannel("alpha").blur(SHADOW_BLUR_SIGMA).linear(SHADOW_OPACITY, 0).toBuffer();
    const shadowRgb = await sharp({ create: { width: info.width, height: info.height, channels: 3, background: { r: 20, g: 20, b: 20 } } }).png().toBuffer();
    const shadowLayer = await sharp(shadowRgb).joinChannel(shadowAlpha).png().toBuffer();
    layers.push({ input: shadowLayer, left, top: top + Math.round(SQUARE_CANVAS_SIZE * SHADOW_OFFSET_RATIO) });
  }
  layers.push({ input: resized, left, top });
  await sharp({ create: { width: SQUARE_CANVAS_SIZE, height: SQUARE_CANVAS_SIZE, channels: 3, background: "#ffffff" } })
    .composite(layers)
    // sharp applies flatten() in a fixed internal stage that runs before
    // composite(), so it cannot strip the alpha composite() just introduced —
    // removeAlpha() has no such ordering quirk.
    .removeAlpha()
    .png()
    .toFile(output);
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

export type FailedModelSlot = { slot: string; reason: string };

/**
 * Runs the paid model-image generation for a set of slots without letting one
 * rejected frame discard the others: a worker's failure is recorded here and
 * the concurrency pool keeps going, so slots already generated (and paid for)
 * are never thrown away just because a later slot got rejected.
 *
 * A cancellation must still stop everything immediately, so it is rethrown
 * rather than recorded as a failed slot — this preserves runWithConcurrency's
 * fail-stop contract for that one case instead of quietly downgrading it.
 */
export async function runModelGenerationPhase(
  slots: readonly DetailSlot[],
  concurrency: number,
  signal: AbortSignal,
  generate: (slot: DetailSlot) => Promise<Record<string, unknown>>,
  onSlotSettled?: (state: { records: Record<string, unknown>[]; failedSlots: FailedModelSlot[] }) => void,
): Promise<{ records: Record<string, unknown>[]; failedSlots: FailedModelSlot[] }> {
  const records: Record<string, unknown>[] = [];
  const failedSlots: FailedModelSlot[] = [];
  await runWithConcurrency(slots, concurrency, async (slot) => {
    if (signal.aborted) throw new Error("任务已取消");
    try {
      records.push(await generate(slot));
    } catch (error) {
      if (signal.aborted) throw error;
      failedSlots.push({ slot: slot[0], reason: error instanceof Error ? error.message : String(error) });
    }
    onSlotSettled?.({ records, failedSlots });
  });
  return { records, failedSlots };
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
  const detailFolder = resolveDetailPageFolder(relativePath);
  const folderKey = productPipelineFolderKey(folderId);
  const sources = await sourceImages(path.join(absolutePath, "原图"));
  const { article: articleSources, details: detailShots } = partitionSources(sources);
  if (!articleSources.length) throw new Error("原图目录只有 x_ 开头的细节图，缺少商品整体图");
  const stagingRoot = productPipelineStagingRoot(job.id);
  // Full-frame, unstyled — an intermediate used only for colour clustering and
  // as the gpt-image-2 reference set. Never published: the deliverable a
  // person sees under 【详情页】-待审/主图 is the square+shadow render below,
  // built once each shot's crop box is known from classification.
  const masterStage = path.join(stagingRoot, "主图-原始");
  const masterDestination = path.join(detailFolder, "主图");
  const skuDestination = path.join(detailFolder, "SKU");
  await mkdir(masterStage, { recursive: true });
  progress(job, "正在生成白底主图", 5, { sourceCount: articleSources.length, outputs: [] });
  const outputs: ({ name: string; sha256: string } | undefined)[] = Array.from({ length: articleSources.length });
  // Keyed by masterStage path so the classifier's per-shot box (computed
  // against that exact file) can be matched back to the RGBA layer it came
  // from when rendering the square deliverable.
  const foregroundByPath = new Map<string, Buffer>();
  await runWithConcurrency(articleSources, PRODUCT_CUTOUT_CONCURRENCY, async (source, index) => {
    if (signal.aborted) throw new Error("任务已取消");
    await assertSourcesUnchanged(sources);
    const name = `${source.stem}.jpg`; const output = path.join(masterStage, name);
    const foreground = await makeWhiteMaster(source, output, folderKey, signal);
    foregroundByPath.set(output, foreground);
    outputs[index] = { name, sha256: sha256(await readFile(output)) };
    progress(job, "正在生成白底主图", Math.round(5 + (outputs.filter(Boolean).length / articleSources.length) * 70), { sourceCount: articleSources.length, outputs: outputs.filter(Boolean) });
  });
  await assertSourcesUnchanged(sources);
  const masters = articleSources.map((source) => path.join(masterStage, `${source.stem}.jpg`));
  progress(job, "main_published", 25, { resumed: false, masterHashes: await Promise.all(masters.map(fileHash)) });
  // The bundle the job asked for, not a hardcoded one — otherwise dropping a
  // second category into config/product-pipeline would still render every
  // product with the hat template.
  const workflowId = String(job.input.workflowId ?? WORKFLOW_ID);
  if (!installedWorkflowIds().has(workflowId)) throw new Error(`商品套图模板未安装：${workflowId}`);
  const templateRoot = productTemplateRoot(workflowId);
  const manifest = await validateTemplateBundle(templateRoot, workflowId);
  const template = await loadProductTemplate(templateRoot);
  if (template.version !== manifest.version) throw new Error("商品套图模板版本不匹配");
  await assertSourcesUnchanged(sources);
  progress(job, "classifying", 30, { templateVersion: manifest.version });

  // Colourways and macro crops are recovered from the shoot itself; nothing in
  // the folder labels them, and no human edits the set between steps.
  const classification = await classifyProductSources(masters, { hasNamedDetailShots: detailShots.length > 0 });
  if (!classification.colors.length) throw new Error("无法识别可用商品颜色；未调用付费生图服务");

  // 主图（方形+阴影，每张原图一份）和 SKU（每个颜色一张代表图，无阴影）都是
  // 本地渲染，不占抠图或付费生图的名额。放在分类之后，是因为方形裁切要用
  // classifyProductSources 已经量出来的 box —— 这张图里商品到底在哪。
  progress(job, "正在渲染方形主图与 SKU 图", 32, { colors: classification.colors.length });
  const masterSquareStage = path.join(stagingRoot, "主图"); await mkdir(masterSquareStage, { recursive: true });
  const skuStage = path.join(stagingRoot, "SKU"); await mkdir(skuStage, { recursive: true });
  const allMasterShots = classification.colors.flatMap((color) => color.members);
  await runWithConcurrency(allMasterShots, PRODUCT_CUTOUT_CONCURRENCY, async (member) => {
    if (signal.aborted) throw new Error("任务已取消");
    const foreground = foregroundByPath.get(member.path);
    if (!foreground) throw new Error(`缺少白底图中间产物：${member.path}`);
    const stem = path.parse(member.path).name;
    await composeSquareDeliverable(foreground, member.metric.box, path.join(masterSquareStage, `${stem}.png`), { shadow: true });
  });
  await runWithConcurrency(classification.colors, PRODUCT_CUTOUT_CONCURRENCY, async (color) => {
    if (signal.aborted) throw new Error("任务已取消");
    const foreground = foregroundByPath.get(color.representative.path);
    if (!foreground) throw new Error(`缺少 SKU 代表图的中间产物：${color.representative.path}`);
    // representative is today's best-effort stand-in for "the ~45° side shot":
    // the shoot's first frame in that colourway, not an angle-verified pick —
    // spot-check the published SKU images against the real angle convention.
    await composeSquareDeliverable(foreground, color.representative.metric.box, path.join(skuStage, `SKU${color.rank + 1}.png`), { shadow: false });
  });
  await atomicPublish(masterSquareStage, masterDestination);
  await atomicPublish(skuStage, skuDestination);

  const slotColorRank = modelSlotColorRanks(classification.colors.length);
  const rawOnlySlots = job.input.onlySlots;
  const onlySlots = Array.isArray(rawOnlySlots) && rawOnlySlots.length ? rawOnlySlots.map(String) : null;
  const modelSlots = selectModelSlots(onlySlots);
  const warnings = [...classification.warnings];
  // Captured once and carried through every later progress() call and the
  // final return: each call replaces the whole result rather than merging
  // into it, so a field dropped from one payload just disappears from the
  // job the moment the next stage reports in.
  const colors = classification.colors.map((color) => ({
    rank: color.rank,
    lab: color.lab.map((channel) => Math.round(channel * 10) / 10),
    shots: color.members.length,
  }));
  const detailShotCount = detailShots.length || classification.details.length;
  progress(job, "generating_models", 35, {
    colors,
    detailShots: detailShotCount,
    slotColorRanks: Object.fromEntries(slotColorRank),
    onlySlots,
    warnings,
  });

  const detailStage = path.join(stagingRoot, "images"); await mkdir(detailStage, { recursive: true });
  const baseName = path.basename(absolutePath);
  const records: Record<string, unknown>[] = [];
  const { records: modelRecords, failedSlots } = await runModelGenerationPhase(
    modelSlots,
    MODEL_CONCURRENCY,
    signal,
    async (slot) => {
      const color = classification.colors[slotColorRank.get(slot[0])!];
      const output = path.join(detailStage, `${baseName}_${slot[0]}.jpg`);
      const record = await generateModelSlot(template, templateRoot, color, output, slot, signal, job.workspaceId);
      if (record.warning) warnings.push(`${slot[0]}: ${record.warning}`);
      return { slot: slot[0], colorRank: color.rank, ...record };
    },
    ({ records: settledRecords, failedSlots: settledFailures }) => {
      progress(job, "generating_models", 35 + (settledRecords.length + settledFailures.length) * 5, {
        colors, detailShots: detailShotCount, slots: settledRecords, failedSlots: settledFailures, warnings,
      });
    },
  );
  records.push(...modelRecords);
  // A run that produced nothing new has nothing worth publishing, and must
  // still fail loudly rather than report a hollow "success".
  if (!records.length) {
    throw new Error(`模特图全部生成失败（${modelSlots.length} 个槽位），未发布任何内容：${failedSlots.map((item) => `${item.slot}(${item.reason})`).join("；")}`);
  }

  progress(job, "compositing", 75, { colors, detailShots: detailShotCount, slots: records, failedSlots, warnings });
  for (const slot of DETAIL_SLOTS.filter((item) => item[3] !== "model")) {
    const output = path.join(detailStage, `${baseName}_${slot[0]}.jpg`);
    await renderCompositedSlot(template, templateRoot, classification, detailShots, slot, output);
    records.push({ slot: slot[0], attempts: 0, qa: "not-required", sha256: await fileHash(output) });
  }
  progress(job, "qa", 87, { colors, detailShots: detailShotCount, slots: records, failedSlots, warnings });
  // Only the slots actually staged this run are verified/published: a failed
  // model slot (or one skipped by `onlySlots`) simply keeps whatever image is
  // already on the share, rather than blocking or clobbering it.
  const producedSlotIds = new Set(records.map((record) => record.slot as string));
  await verifyDetailOutputs(detailStage, baseName, sources, producedSlotIds);
  await assertSourcesUnchanged(sources);
  progress(job, "publishing_images", 93, { colors, detailShots: detailShotCount, slots: records, failedSlots, warnings });
  await publishImages(detailStage, path.join(detailFolder, "images"), baseName, producedSlotIds);
  // The only staging directory not already removed by an atomicPublish call:
  // it fed classification and the gpt-image-2 references but was never itself
  // a publish target.
  await rm(masterStage, { recursive: true, force: true });
  return {
    stage: "completed",
    progress: 100,
    relativePath,
    templateVersion: manifest.version,
    colors,
    detailShots: detailShotCount,
    slots: records,
    warnings,
    // Cutout is no longer skipped across runs (see masterStage above), so this
    // is always false. Kept for API/UI compatibility with `result.resumed`.
    resumed: false,
    incomplete: failedSlots.length > 0,
    failedSlots,
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
  detailShots: SourceImage[],
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
  // Named `x_` crops are what a designer actually staged for this page. A shoot
  // without them still needs a detail page, so fall back to whatever the
  // classifier recovered and then to the hero colourway's angles, rather than
  // publishing the slot empty.
  const crops = detailShots.length
    ? detailShots.map((shot) => shot.path)
    : (classification.details.length ? classification.details : classification.colors[0].members)
        .map((item) => item.path);
  // The grid takes the first four crops. The hero band is its own shot when the
  // shoot supplies a fifth; otherwise it is a wide centre crop of the last one,
  // which is how the hand-built reference page was put together.
  const grid = crops.slice(0, 4);
  await renderDetailPresentation(
    crops[4] ?? grid[grid.length - 1], grid,
    output, width, height, template.pages["11"].title, template.pages["11"].caption,
  );
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fileHash(file: string): Promise<string> { return sha256(await readFile(file)); }
async function validateTemplateBundle(root: string, workflowId: string): Promise<TemplateManifest> {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as TemplateManifest;
  if (manifest.version !== workflowId) throw new Error("商品套图模板版本不匹配");
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
  let lastFailure = "";
  // The request itself has to sit inside the retry, not outside it. gpt-image-2
  // rejects an occasional frame with a `violation` status whose own message asks
  // for the request to be sent again, and identical prompts do go through on a
  // later attempt. Left outside, that one refusal aborted the whole run —
  // discarding the slots already generated and paid for alongside it.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    attempts = attempt;
    try {
      const generated = await requestModelImage(references, prompt, slot, signal, workspaceId);
      await sharp(generated).metadata();
      best = generated;
      break;
    } catch (error) {
      if (signal.aborted) throw error;
      lastFailure = error instanceof Error ? error.message : "生成结果无法解码";
    }
  }
  if (!best) throw new Error(`模特槽位 ${slot[0]} 三次都没拿到有效候选图，未发布 images：${lastFailure}`);
  // A slot that recovered on a later attempt needs no human review — say so,
  // rather than filing the raw refusal and making a healthy frame read as bad.
  if (attempts > 1) warning = `重试 ${attempts - 1} 次后成功（${lastFailure}）`;
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
  // Read the body as text first: a rejected prompt, an oversized reference and a
  // spent quota all arrive as the same status, and one failed slot ends the run.
  // Reporting the code alone leaves nothing to act on.
  const body = await response.text().catch(() => "");
  type GenerateResponse = { url?: string; results?: { url?: string }[] };
  let json: GenerateResponse | null = null;
  try { json = JSON.parse(body) as GenerateResponse; } catch { /* upstream errors are not always JSON */ }
  const url = json?.url ?? json?.results?.[0]?.url;
  if (!response.ok || !url) throw new Error(`gpt-image-2 请求失败 (HTTP ${response.status})：${body.slice(0, 300)}`);
  const image = await fetch(url, { signal }); if (!image.ok) throw new Error("无法下载 gpt-image-2 结果"); return Buffer.from(await image.arrayBuffer());
}
/** Validates only the slots actually staged this run — a failed or `onlySlots`-skipped model slot has no file here, and that is expected. */
export async function verifyDetailOutputs(
  stage: string,
  base: string,
  sources: SourceImage[],
  producedSlotIds: ReadonlySet<string>,
): Promise<void> {
  for (const [id, width, height] of DETAIL_SLOTS) {
    if (!producedSlotIds.has(id)) continue;
    const meta = await sharp(path.join(stage, `${base}_${id}.jpg`)).metadata();
    if (meta.width !== width || meta.height !== height) throw new Error(`详情图 ${id} 尺寸校验失败`);
  }
  await assertSourcesUnchanged(sources);
}
/** Publishes only the slots staged this run; a missing slot keeps whatever the share already had (or stays absent), it is never treated as an error. */
export async function publishImages(
  stage: string,
  destination: string,
  base: string,
  producedSlotIds: ReadonlySet<string>,
): Promise<void> {
  const merge = `${stage}-merged`; await mkdir(merge, { recursive: true });
  try { await cp(destination, merge, { recursive: true, errorOnExist: false }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const [id] of DETAIL_SLOTS) {
    if (!producedSlotIds.has(id)) continue;
    await cp(path.join(stage, `${base}_${id}.jpg`), path.join(merge, `${base}_${id}.jpg`));
  }
  await atomicPublish(merge, destination);
}
