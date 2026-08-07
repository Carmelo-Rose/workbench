import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { readdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { createMonoAsset, getMonoAsset, linkMonoJobAsset, updateMonoJobResult } from "./store";
import { readObjectBuffer, saveObjectBuffer } from "@/lib/storage";
import { gatewayBase, gatewayHeaders } from "@/lib/toolbox/gateway";
import { getConfigValue } from "@/lib/server/api-config";
import {
  allocateModelSlots,
  classifySources,
  isFullArticleShot,
  measureColorPresence,
  measureProductImage,
  type RelativeBox,
  type SourceClassification,
  type SourceMetric,
} from "./product-classify";
import { applyBrandMark, renderDetailPresentation, renderTiledDisplay } from "./product-layouts";
import {
  buildModelPrompt,
  identityGroupForLook,
  loadProductTemplate,
  type ModelIdentityGroup,
  type ProductTemplate,
} from "./product-template";
import { resolveProductModelPair, type ResolvedProductModelPair } from "./product-model-pairs";
import { productDetailPageRoot, productSourceRoot } from "./product-roots";
import type { MonoActor, MonoJob, ProductPipelineInput } from "./contracts";

export { productDetailPageRoot, productSourceRoot } from "./product-roots";

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
const MODEL_CONCURRENCY = 8;
/**
 * TEMPORARY (shadow-backdrop trial only): when true, runProductPipeline
 * publishes 主图/SKU and returns without generating the paid images/ detail
 * set. Flip back to false (or delete alongside the block that reads it)
 * once the online shadow generation is confirmed.
 */
const PRODUCT_PIPELINE_SHADOW_ONLY_TRIAL = false;
const DETAIL_SLOTS = [
  ["01", 790, 1243, "model"], ["02", 790, 681, "fixed"], ["03", 790, 1021, "model"],
  ["04", 790, 1008, "model"], ["05", 790, 1005, "model"], ["06", 790, 1004, "model"],
  ["07", 790, 1005, "model"], ["08", 790, 1025, "model"], ["09", 790, 688, "fixed"],
  ["10", 790, 610, "tiled"], ["11", 790, 1026, "detail"],
] as const;
export type DetailSlot = typeof DETAIL_SLOTS[number];
export const MODEL_SLOTS: readonly DetailSlot[] = DETAIL_SLOTS.filter((slot) => slot[3] === "model");
const MODEL_SLOT_IDS: ReadonlySet<string> = new Set(MODEL_SLOTS.map((slot) => slot[0]));
export const DETAIL_SLOT_IDS: readonly string[] = DETAIL_SLOTS.map((slot) => slot[0]);

/** Narrows a retry run to the requested model slots, in their original template order. */
export function selectModelSlots(onlySlots: readonly string[] | null | undefined): DetailSlot[] {
  if (!onlySlots?.length) return [...MODEL_SLOTS];
  const wanted = new Set(onlySlots);
  return MODEL_SLOTS.filter((slot) => wanted.has(slot[0]));
}

/** Narrows a main-image retry to the requested source-image stems. */
export function selectMainSourceStems(
  available: readonly string[],
  onlyMain: readonly string[] | null | undefined,
): string[] {
  if (!onlyMain?.length) return [...available];
  const byStem = new Map(available.map((stem) => [stem.toLocaleLowerCase(), stem]));
  const wanted = [...new Set(onlyMain.map((stem) => stem.trim().toLocaleLowerCase()))];
  const invalid = wanted.filter((stem) => !byStem.has(stem));
  if (invalid.length) throw new Error(`onlyMain 包含不可重跑的主图：${invalid.join(", ")}`);
  return wanted.map((stem) => byStem.get(stem)!);
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

/**
 * One slot's image bytes, tried in the same order for every caller (single
 * image route, zip-all route): a stored deliverable asset first, then the
 * published detail-page mirror, then this run's staging directory. Kept in
 * one place so the "which of three sources is this slot in" logic can't
 * drift between the two routes that need it.
 */
export async function resolveProductPipelineSlotImage(
  actor: MonoActor,
  job: MonoJob,
  slot: string,
): Promise<Buffer | null> {
  const deliverables = (job.result as {
    deliverables?: Array<{ assetId: string; role: string; slotKey: string }>;
  } | null)?.deliverables ?? [];
  const deliverable = deliverables.find((item) => item.role === "product-detail" && item.slotKey === slot);
  if (deliverable) {
    const asset = getMonoAsset(actor, deliverable.assetId);
    if (asset?.storageKey) return readObjectBuffer(asset.storageKey);
  }

  const folder = resolveProductFolder(String(job.input.folderId ?? ""));
  const imagesDir = path.resolve(resolveDetailPageFolder(folder.relativePath), "images");
  const baseName = path.basename(folder.absolutePath);
  const fileName = `${baseName}_${slot}.jpg`;
  const target = path.resolve(imagesDir, fileName);
  if (path.dirname(target) !== imagesDir) return null;

  const stagingDir = path.resolve(productPipelineStagingRoot(job.id), "images");
  return readFile(target)
    .catch(() => readFile(path.resolve(stagingDir, fileName)))
    .catch(() => null);
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

/**
 * Whether the root itself can be read at all. Kept separate from the
 * recursive `visit` in `listProductFolders`, whose per-directory `catch {
 * return }` is correct for a permission-denied subdirectory (skip it, keep
 * listing the rest) but wrong for the root — a root that can't be read at
 * all (share not mounted, path typo'd) is a configuration failure, not an
 * empty result, and the two must not collapse into the same "0 个商品" UI.
 */
export async function isProductRootReachable(root = productSourceRoot()): Promise<boolean> {
  try {
    const info = await stat(normalizeRoot(root));
    return info.isDirectory();
  } catch { return false; }
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
  if (input.onlyMain?.length) {
    const invalid = input.onlyMain.filter((stem) => !stem.trim() || /[\\/\0]/u.test(stem) || stem === "." || stem === "..");
    if (invalid.length) throw new Error(`onlyMain 包含非法主图标识：${invalid.join(", ")}`);
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

/**
 * The four crops slot 11 publishes, and the shot its hero band is cut out of.
 *
 * Anything past the fourth is deliberately ignored. A shoot that stages a fifth
 * macro briefly had it promoted to the hero, which put across the top of the
 * page a shot nobody had framed for the fabric caption — the hand-built
 * reference page cuts its band out of the fourth crop instead, and a shoot with
 * fewer than four falls back to whichever is last for the same reason.
 */
export function detailPageSources(crops: readonly string[]): { hero: string; grid: string[] } {
  const grid = crops.slice(0, 4);
  return { hero: grid[grid.length - 1], grid };
}

function partitionSources(sources: SourceImage[]): { article: SourceImage[]; details: SourceImage[] } {
  const article: SourceImage[] = [];
  const details: { order: number; source: SourceImage }[] = [];
  for (const source of sources) {
    const match = DETAIL_SHOT_PATTERN.exec(source.stem);
    if (match) details.push({ order: Number(match[1]), source });
    else article.push(source);
  }
  details.sort((first, second) => first.order - second.order);
  // `readdir` order is whatever the filesystem/SMB share happens to return, not
  // the camera's frame sequence — on a shoot where a colourway spans two
  // sessions (a reshoot merged back in by colour), an unsorted `article` array
  // can hand the SKU/tiled representative pick (`members[0]` in
  // classifyProductSources) a mid-sequence frame instead of the shoot's actual
  // lead angle, publishing a cap that faces the wrong way next to its siblings.
  // Camera filenames increment per frame within a session, so a plain name sort
  // restores shoot order.
  article.sort((first, second) => first.name.localeCompare(second.name, "en", { numeric: true }));
  return { article, details: details.map((item) => item.source) };
}

async function assertSourcesUnchanged(sources: SourceImage[]): Promise<void> {
  for (const source of sources) {
    const current = await stat(source.path);
    if (current.size !== source.size || current.mtimeMs !== source.mtimeMs) throw new Error("运行期间检测到原图发生变化，任务已中止");
  }
}

async function requestCutout(source: SourceImage, folderKey: string, signal: AbortSignal): Promise<Buffer> {
  return requestCutoutBytes(await readFile(source.path), source.name, folderKey, signal);
}

/**
 * Cutout for bytes that are not a file on the share — the generated frame,
 * whose article has to be located before it can be compared with the one that
 * was photographed. Same queue and same per-folder fair share as the sources.
 */
async function requestCutoutBytes(bytes: Buffer, name: string, folderKey: string, signal: AbortSignal): Promise<Buffer> {
  return productCutoutScheduler.run(folderKey, async () => {
    const headers = gatewayHeaders();
    // Re-wrapped rather than passed straight through: `Buffer` is typed over
    // ArrayBufferLike, which fetch does not accept as a body.
    const uploaded = await fetch(`${gatewayBase()}/files/raw?name=${encodeURIComponent(name)}`, { method: "POST", headers: { ...headers, "content-type": "application/octet-stream" }, body: new Uint8Array(bytes), signal });
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

const DELIVERABLE_ALPHA_FLOOR = 96;
const DELIVERABLE_ALPHA_CEILING = 224;
// SKU images deliberately use a hard high-confidence silhouette. The soft
// alpha halo from a cutout can include cast-shadow fragments, which read as
// grey dirt once flattened onto SKU's required pure-white background.
const SKU_ALPHA_THRESHOLD = 224;
const SHADOW_ANALYSIS_MAX_SIDE = 1200;
const SHADOW_BACKGROUND_QUANTILE = 0.82;
const SHADOW_CONTRAST_START = 7;
const SHADOW_CONTRAST_FULL = 42;

/**
 * The segmentation matte sometimes assigns a little alpha to the cast shadow.
 * That fragment is not a usable shadow layer: it is normally clipped and much
 * darker than the surrounding penumbra. Tighten the matte for the opaque
 * product layer; the complete photographed shadow is recovered separately
 * below.
 */
export async function refineProductForeground(foreground: Buffer): Promise<Buffer> {
  const metadata = await sharp(foreground).metadata();
  if (!metadata.hasAlpha) return sharp(foreground).ensureAlpha().png().toBuffer();
  const [rgb, originalAlpha] = await Promise.all([
    sharp(foreground).removeAlpha().png().toBuffer(),
    sharp(foreground).extractChannel("alpha").png().toBuffer(),
  ]);
  // `linear()` runs before `extractChannel()` in libvips' fixed operation
  // order. Decode the extracted channel as a separate image so the level
  // adjustment is applied to the matte rather than discarded with RGB.
  const alpha = await sharp(originalAlpha)
    .linear(
      255 / (DELIVERABLE_ALPHA_CEILING - DELIVERABLE_ALPHA_FLOOR),
      (-DELIVERABLE_ALPHA_FLOOR * 255) /
        (DELIVERABLE_ALPHA_CEILING - DELIVERABLE_ALPHA_FLOOR),
    )
    .png()
    .toBuffer();
  return sharp(rgb).joinChannel(alpha).png().toBuffer();
}

/**
 * SKU is a clean catalogue cutout, not a studio presentation. Keep only the
 * high-confidence product matte; the final resize supplies a narrow antialias
 * at the silhouette without carrying a photographed shadow into the white
 * square.
 */
export async function refineSkuForeground(foreground: Buffer): Promise<Buffer> {
  const metadata = await sharp(foreground).metadata();
  if (!metadata.hasAlpha) return sharp(foreground).ensureAlpha().png().toBuffer();
  const [rgb, originalAlpha] = await Promise.all([
    sharp(foreground).removeAlpha().png().toBuffer(),
    sharp(foreground).extractChannel("alpha").png().toBuffer(),
  ]);
  const alpha = await sharp(originalAlpha)
    .threshold(SKU_ALPHA_THRESHOLD)
    .png()
    .toBuffer();
  return sharp(rgb).joinChannel(alpha).png().toBuffer();
}

function histogramQuantile(histogram: Uint32Array, count: number, quantile: number): number {
  if (count < 1) return 255;
  const target = Math.max(1, Math.ceil(count * quantile));
  let seen = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    seen += histogram[value];
    if (seen >= target) return value;
  }
  return 255;
}

function smoothProfile(profile: Float32Array, radius: number): Float32Array {
  if (radius < 1) return profile;
  const prefix = new Float64Array(profile.length + 1);
  for (let index = 0; index < profile.length; index += 1) {
    prefix[index + 1] = prefix[index] + profile[index];
  }
  const smoothed = new Float32Array(profile.length);
  for (let index = 0; index < profile.length; index += 1) {
    const first = Math.max(0, index - radius);
    const last = Math.min(profile.length, index + radius + 1);
    smoothed[index] = (prefix[last] - prefix[first]) / (last - first);
  }
  return smoothed;
}

function smoothStep(value: number, first: number, last: number): number {
  const normalized = Math.max(0, Math.min(1, (value - first) / (last - first)));
  return normalized * normalized * (3 - 2 * normalized);
}

/**
 * Recovers the real studio shadow from a light sweep without treating the
 * sweep itself as foreground.
 *
 * BiRefNet already leaves a low-confidence halo over most real cast shadows;
 * that semantic seed is strengthened non-linearly instead of discarded. Some
 * deep concavities (under a curved brim, for example) have zero matte despite
 * containing a real contact shadow, so a second, tightly bounded pass recovers
 * darkness immediately below each product column. The clean sweep for that
 * pass is estimated from the bright quantile of every row and column.
 *
 * Using the model halo for the broad penumbra and luminance only for contact
 * gaps retains the photographed shape while rejecting distant paper seams and
 * backdrop gradients.
 *
 * The result is an opaque RGB backdrop (mostly pure white), deliberately kept
 * separate from the product alpha. It can therefore be enabled for 主图 and
 * omitted for SKU without inventing a synthetic drop shadow.
 */
export async function composeNaturalShadowBackdrop(sourcePath: string, cutout: Buffer): Promise<Buffer> {
  const [sourceMeta, cutoutMeta] = await Promise.all([sharp(sourcePath).metadata(), sharp(cutout).metadata()]);
  if (!sourceMeta.width || !sourceMeta.height) throw new Error("无法读取原图尺寸");
  if (cutoutMeta.width !== sourceMeta.width || cutoutMeta.height !== sourceMeta.height) {
    throw new Error("抠图产物尺寸与原图不一致，无法恢复自然阴影");
  }

  const scale = Math.min(1, SHADOW_ANALYSIS_MAX_SIDE / Math.max(sourceMeta.width, sourceMeta.height));
  const width = Math.max(1, Math.round(sourceMeta.width * scale));
  const height = Math.max(1, Math.round(sourceMeta.height * scale));
  const mattePipeline = cutoutMeta.hasAlpha
    ? sharp(cutout).extractChannel("alpha")
    : sharp(cutout).toColorspace("b-w");
  const [{ data: source, info: sourceInfo }, { data: matte }] = await Promise.all([
    sharp(sourcePath)
      .removeAlpha()
      .toColorspace("srgb")
      .resize(width, height, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true }),
    mattePipeline
      .resize(width, height, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true }),
  ]);

  const pixels = width * height;
  const luminance = new Uint8Array(pixels);
  const bottomByColumn = new Int32Array(width);
  bottomByColumn.fill(-1);
  const globalHistogram = new Uint32Array(256);
  const rowHistograms = new Uint32Array(height * 256);
  const columnHistograms = new Uint32Array(width * 256);
  const rowCounts = new Uint32Array(height);
  const columnCounts = new Uint32Array(width);
  let backgroundCount = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const offset = index * sourceInfo.channels;
      const value = Math.round(
        0.2126 * source[offset]
        + 0.7152 * source[offset + 1]
        + 0.0722 * source[offset + 2],
      );
      luminance[index] = value;
      if (matte[index] >= 160) {
        bottomByColumn[x] = y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      // High-confidence product pixels cannot describe the backdrop. Softer
      // matte values are left in: a high quantile ignores their dark tail and
      // still has enough samples on rows mostly occupied by the article.
      if (matte[index] < 192) {
        globalHistogram[value] += 1;
        rowHistograms[y * 256 + value] += 1;
        columnHistograms[x * 256 + value] += 1;
        rowCounts[y] += 1;
        columnCounts[x] += 1;
        backgroundCount += 1;
      }
    }
  }

  const white = Buffer.alloc(pixels * 3, 255);
  if (maxX < 0 || backgroundCount < 1) {
    return sharp(white, { raw: { width, height, channels: 3 } }).png().toBuffer();
  }

  const background = histogramQuantile(globalHistogram, backgroundCount, SHADOW_BACKGROUND_QUANTILE);
  // A dark/non-studio source has no trustworthy "white sweep" to recover a
  // shadow from. Publishing a clean cutout is safer than leaking its scene.
  if (background < 190) {
    return sharp(white, { raw: { width, height, channels: 3 } }).png().toBuffer();
  }

  const rows = new Float32Array(height);
  const columns = new Float32Array(width);
  for (let y = 0; y < height; y += 1) {
    rows[y] = rowCounts[y]
      ? histogramQuantile(
        rowHistograms.subarray(y * 256, (y + 1) * 256),
        rowCounts[y],
        SHADOW_BACKGROUND_QUANTILE,
      )
      : background;
  }
  for (let x = 0; x < width; x += 1) {
    columns[x] = columnCounts[x]
      ? histogramQuantile(
        columnHistograms.subarray(x * 256, (x + 1) * 256),
        columnCounts[x],
        SHADOW_BACKGROUND_QUANTILE,
      )
      : background;
  }
  const smoothRows = smoothProfile(rows, Math.max(1, Math.round(height * 0.025)));
  const smoothColumns = smoothProfile(columns, Math.max(1, Math.round(width * 0.025)));

  const marginX = Math.round(width * 0.065);
  const marginY = Math.round(height * 0.12);
  const envelopeLeft = Math.max(0, minX - marginX);
  const envelopeTop = Math.max(0, minY - marginY);
  const envelopeRight = Math.min(width - 1, maxX + marginX);
  const envelopeBottom = Math.min(height - 1, maxY + marginY);

  for (let y = envelopeTop; y <= envelopeBottom; y += 1) {
    for (let x = envelopeLeft; x <= envelopeRight; x += 1) {
      const index = y * width + x;
      if (matte[index] >= 192) continue;
      const sourceOffset = index * sourceInfo.channels;
      const outputOffset = index * 3;

      // The low-confidence portion of the model matte is a useful semantic
      // shadow detector. A square-root curve lifts its faint halo while values
      // close to zero remain visually negligible on white.
      if (matte[index] > 0) {
        const semanticWeight = Math.sqrt(matte[index] / 255);
        for (let channel = 0; channel < 3; channel += 1) {
          white[outputOffset + channel] = Math.round(
            255 - (255 - source[sourceOffset + channel]) * semanticWeight,
          );
        }
      }

      const bottom = bottomByColumn[x];
      if (bottom < 0) continue;
      const contactWeight = y <= bottom
        ? (y >= minY ? 1 : 0)
        : 1 - smoothStep(y - bottom, marginY * 0.4, marginY);
      if (contactWeight <= 0) continue;

      const estimatedBackground = Math.max(
        190,
        Math.min(255, smoothRows[y] + smoothColumns[x] - background),
      );
      const contrast = estimatedBackground - luminance[index];
      if (contrast <= SHADOW_CONTRAST_START) continue;
      const weight = contactWeight * smoothStep(
        contrast,
        SHADOW_CONTRAST_START,
        SHADOW_CONTRAST_FULL,
      );
      const lift = 255 - estimatedBackground;
      for (let channel = 0; channel < 3; channel += 1) {
        const corrected = Math.max(0, Math.min(255, source[sourceOffset + channel] + lift));
        const contact = Math.round(255 - (255 - corrected) * weight);
        white[outputOffset + channel] = Math.min(white[outputOffset + channel], contact);
      }
    }
  }

  return sharp(white, { raw: { width, height, channels: 3 } })
    .blur(Math.max(0.3, Math.max(width, height) * 0.0025))
    .png()
    .toBuffer();
}

/**
 * Everything one photographed frame yields locally, before any paid request.
 *
 * This is the pipeline's shared prefix: the cutout feeds SKU, the colour
 * clustering and 主图's proportion check, and the white master is both what the
 * classifier measures and what the model-image slots reference.
 */
type PreparedArticleSource = {
  source: SourceImage;
  /** The white master this frame was flattened to, on the staging disk. */
  master: string;
  /** Segmentation alpha over the source's own canvas. */
  cutout: Buffer;
  /** Measured once here, so neither the classifier nor 主图 re-reads the file. */
  metric: SourceMetric;
  foreground: Buffer;
  skuForeground: Buffer;
};

/** What the generator drew for one frame, ready to be framed as a 主图. */
type MainFrameRender = {
  image: Buffer;
  /**
   * Where the article sits inside `image`, measured on that frame's own matte.
   * Null when the matte came back empty, which drops 主图 onto the degraded
   * framing in `composeSquareDeliverable`.
   */
  article: RelativeBox | null;
  /** Anything about this frame a person should look at before it ships. */
  warnings: string[];
};

/**
 * The white the generated sweep actually comes back at.
 *
 * The generator's background is not #ffffff: across the 1234 frames it measures
 * 253–254 over ~58% of the picture. 主图 pads with pure white wherever the
 * framing window runs off the frame, so an unlifted sweep prints that padding
 * as a visible rectangle against the slightly darker background.
 *
 * This has to sit on the measured floor. The lift is `v * 255 / floor` applied
 * to the whole picture, so every level below the real floor multiplies the cast
 * shadow along with the background. At 245 it did exactly that: ×1.0408 pushed
 * the 245–252 outer edge of every shadow to pure white and cost 12%–35% of the
 * shadow pixels the generator drew — which is what "the shadow changed after
 * cropping" turned out to be. At 253 the seam disappears just the same and
 * nothing below it moves by more than two levels.
 */
const GENERATED_SWEEP_WHITE_FLOOR = 253;

/**
 * Lifts the generated sweep to pure white, and nothing else.
 *
 * Named and exported because it is the only step on the 主图 path that changes
 * a pixel value the generator drew — everything downstream scales and crops.
 * A 主图 whose shadow reads lighter than the frame it came from came from here.
 */
export async function liftGeneratedSweep(frame: Buffer): Promise<Buffer> {
  return sharp(frame)
    .linear(255 / GENERATED_SWEEP_WHITE_FLOOR, 0)
    .removeAlpha()
    .png()
    .toBuffer();
}

/**
 * How far the generated frame's own aspect may drift from the source photo's
 * before the run says so.
 *
 * `requestShadowBackdrop` asks for the source's exact ratio precisely so the
 * generator edits the background of the shot it was given. A frame that comes
 * back a different shape was re-composed instead, and a re-composed shot is
 * where the article's own proportions are at risk — the one thing this
 * pipeline cannot measure for itself, because the article was redrawn.
 *
 * Reported, not fatal, in line with the colour-presence gate above: it is a
 * signal about a whole picture, and an unattended run must not stall on it.
 * The message carries both sizes, which is also how the first real run
 * answers "what does this service actually return?".
 */
const MAIN_FRAME_ASPECT_TOLERANCE = 0.02;

/** Longest side of the probe the matte's bounding box is measured on. */
const MATTE_PROBE_SIDE = 400;
/** A matte pixel this opaque is the article rather than its feathered edge. */
const MATTE_PRODUCT_ALPHA = 128;
/**
 * How far the article's width-to-height ratio may differ between the photograph
 * and the frame the generator drew from it before the run says so.
 *
 * Wide enough that probe noise on a 400px matte cannot reach it, tight enough
 * to catch the ~6% redraw this pipeline was once thought to be suffering from.
 */
const ARTICLE_PROPORTION_TOLERANCE = 0.05;

/**
 * Where the article a matte describes sits, and how wide it reads.
 *
 * `fit: "inside"` keeps the matte's own proportions, so the probe's pixels stay
 * square and the box measured on it is already in the picture's real ones — no
 * multiplying back by the full-size dimensions, and no dependence on what those
 * dimensions were. The box comes back in fractions of the frame, which hold for
 * the frame the matte was cut from whatever size it is.
 *
 * A matte is the only thing in this pipeline that can tell the article apart
 * from the shadow it casts: on the generated frame both are simply non-white.
 */
export async function measureMatteBox(matte: Buffer): Promise<{ box: RelativeBox; aspect: number } | null> {
  const meta = await sharp(matte).metadata();
  const single = meta.hasAlpha
    ? sharp(matte).extractChannel("alpha")
    : sharp(matte).toColorspace("b-w");
  const { data, info } = await single
    .resize(MATTE_PROBE_SIDE, MATTE_PROBE_SIDE, { fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * info.channels] < MATTE_PRODUCT_ALPHA) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  return {
    box: {
      left: minX / info.width,
      top: minY / info.height,
      width: width / info.width,
      height: height / info.height,
    },
    aspect: width / height,
  };
}

/** Width-to-height ratio of the article a matte describes. */
export async function measureMatteAspect(matte: Buffer): Promise<number | null> {
  return (await measureMatteBox(matte))?.aspect ?? null;
}

/**
 * Says whether the generator came back with an article shaped like the one that
 * was photographed, and what to tell the operator when it did not.
 *
 * This used to stretch the frame back on one axis instead of reporting. The
 * evidence for doing so turned out to be a measuring error: the probe that
 * found the hat "6–7% too narrow" was counting the *photograph's* cast shadow
 * as part of the hat and the generated frame's much lighter shadow as
 * background, so it was comparing hat-plus-shadow against hat. Measured with a
 * threshold that separates the two, the same pictures agree to within 0.5%, and
 * the hat is the same width in both at matched height.
 *
 * The measurement stayed and the stretch went, because the two are not
 * symmetric. A warning that fires on a bad reading costs someone a look at a
 * good picture. A stretch that fires on a bad reading ships a deformed product
 * photo and nothing downstream can tell — which is the complaint that started
 * all of this.
 */
export function describeProportionDrift(
  sourceName: string,
  sourceAspect: number,
  generatedAspect: number,
): string | undefined {
  const drift = Math.abs(generatedAspect / sourceAspect - 1);
  if (drift <= ARTICLE_PROPORTION_TOLERANCE) return undefined;
  return `${sourceName}：生成图里商品的长宽比 ${generatedAspect.toFixed(3)} 与原图 ${sourceAspect.toFixed(3)} 相差 `
    + `${(drift * 100).toFixed(0)}%，模型可能改了商品形状，已按原样发布，请人工复核该张主图`;
}

/**
 * Finds the article in the frame the generator drew, and checks it still has
 * the shape it was photographed with.
 *
 * Locating it is the part 主图 cannot do without: nothing else in the frame
 * separates the article from the shadow beside it, because both are simply
 * non-white. Both mattes come from the same segmentation service, so the two
 * readings are directly comparable.
 */
async function locateGeneratedArticle(
  generated: Buffer,
  sourceMatte: Buffer,
  folderKey: string,
  signal: AbortSignal,
  sourceName: string,
): Promise<{ article: RelativeBox | null; warning?: string }> {
  const generatedMatte = await requestCutoutBytes(generated, `${sourceName}-generated.png`, folderKey, signal);
  const measured = await measureMatteBox(generatedMatte);
  if (!measured) {
    return {
      article: null,
      warning: `${sourceName}：生成图抠图为空，主图取景改用整幅墨迹（阴影会把商品挤偏），请人工复核该张主图`,
    };
  }
  const sourceAspect = await measureMatteAspect(sourceMatte);
  if (!sourceAspect) {
    return { article: measured.box, warning: `${sourceName}：原图抠图为空，无法核对主图里商品的长宽比` };
  }
  return { article: measured.box, warning: describeProportionDrift(sourceName, sourceAspect, measured.aspect) };
}

export async function describeReframing(source: SourceImage, generated: Buffer): Promise<string | undefined> {
  const [sourceMeta, generatedMeta] = await Promise.all([
    sharp(source.path).metadata(),
    sharp(generated).metadata(),
  ]);
  if (!sourceMeta.width || !sourceMeta.height || !generatedMeta.width || !generatedMeta.height) return undefined;
  const sourceAspect = sourceMeta.width / sourceMeta.height;
  const generatedAspect = generatedMeta.width / generatedMeta.height;
  if (Math.abs(generatedAspect - sourceAspect) / sourceAspect <= MAIN_FRAME_ASPECT_TOLERANCE) return undefined;
  return `${source.name}：生成图比例 ${generatedMeta.width}×${generatedMeta.height} 与原图 ${sourceMeta.width}×${sourceMeta.height} 不一致，`
    + "生图服务重新构图了，商品比例可能被改动，请人工复核该张主图";
}

/**
 * The local half of one frame: cutout, white master, refined foregrounds and
 * the metric all three downstream branches ask questions of.
 *
 * No paid request happens here. That is the whole point of the split — the
 * detail set's model slots wait on colour clustering, clustering waits on every
 * frame's cutout, and none of it should also be waiting behind 主图's paid
 * background generation.
 */
async function prepareArticleSource(
  source: SourceImage,
  output: string,
  folderKey: string,
  signal: AbortSignal,
): Promise<PreparedArticleSource> {
  const cutout = await requestCutout(source, folderKey, signal);
  const rawForeground = await composeWhiteMaster(source.path, cutout, output);
  const [foreground, skuForeground, metric] = await Promise.all([
    refineProductForeground(rawForeground),
    refineSkuForeground(rawForeground),
    measureProductImage(output),
  ]);
  return { source, master: output, cutout, metric, foreground, skuForeground };
}

/**
 * The paid half of one frame, which only 主图 needs.
 *
 * 主图 is the generated frame whole, product included — not a cutout laid over
 * a generated backdrop. Compositing the two means aligning a redrawn product
 * with a photographed one pixel for pixel, and everywhere they disagree prints
 * as a doubled outline. The prepared cutout still reaches this path, but only
 * as the reference the redrawn article's proportions are checked against.
 */
async function renderMainFrame(
  prepared: PreparedArticleSource,
  folderKey: string,
  signal: AbortSignal,
  workspaceId: string,
): Promise<MainFrameRender> {
  const { source, cutout } = prepared;
  const generated = await requestShadowBackdrop(source, signal, workspaceId);
  const located = await locateGeneratedArticle(generated, cutout, folderKey, signal, source.name);
  // Tone only. Nothing on the 主图 path resizes the generated frame on one
  // axis, so the article reaches the square canvas at the proportions the
  // generator drew it at, and `located.article` stays true of the picture.
  const image = await liftGeneratedSweep(generated);
  const warnings = [await describeReframing(source, generated), located.warning]
    .filter((entry): entry is string => Boolean(entry));
  return { image, article: located.article, warnings };
}

/** Square 1:1 deliverable side, matching the hand-built reference set on the share. */
const SQUARE_CANVAS_SIZE = 800;
/**
 * SKU framing: the article on white, with no shadow to leave room for.
 *
 * Measured against the hand-built SKU sets on the share, where the article
 * covers 88%–98% of the frame with 0%–5.6% of margin at its tightest edge.
 * The 0.04/0.86 pair these replace printed 73.6% and 13% — a quarter of the
 * canvas was white the reference sets do not have.
 *
 * The two multiply, which is why the old pair landed so far short of its own
 * 0.86: the padding is a fraction of the *source* frame rather than of the
 * article, so on a white master where the article spans about half the frame,
 * 4% each side ate another 14% of the article's size inside the crop. It is
 * only a safety margin against cropping into the matte's own edge, so it stays
 * as small as that job allows.
 */
const SQUARE_SKU_CROP_PADDING = 0.01;
const SQUARE_SKU_FILL_RATIO = 0.94;
/**
 * How much of the 800px canvas the article itself spans on its longer axis.
 *
 * Measured off the hand-built reference sets on the share, where the article
 * covers 69%–93% of the frame depending on how much of it is profile. Front
 * views need more breathing room than a low, wide side view.
 *
 * These describe the *article*, not the article plus its cast shadow. The
 * shadow reaches well past the hat on the lit side, so letting it into this
 * budget both shrinks the article and makes its size swing shot to shot with
 * whatever shadow the generator happened to draw.
 *
 * They are also the only control over how much of that shadow survives, which
 * is what set them where they are. At 0.78/0.90 the article left 5%–11% of the
 * canvas as margin and the shadow ran off the edge: the 1234 frames printed
 * 1.3%–8.3% of each 主图 as shadow. At 0.72/0.84 the same frames print
 * 2.4%–9.3% — level with what cropping the generated frame to a plain square
 * keeps, without handing the article's size back to the generator. A plain
 * square crop put that size anywhere from 66% to 100% and clipped the one
 * frame drawn wider than the sweep is tall, which is why this is a ratio and
 * not a crop.
 */
const SQUARE_COMPACT_FILL_RATIO = 0.72;
const SQUARE_LANDSCAPE_FILL_RATIO = 0.84;

function squareFillRatio(articleAspect: number): number {
  const landscapeWeight = smoothStep(articleAspect, 1, 1.35);
  return SQUARE_COMPACT_FILL_RATIO
    + (SQUARE_LANDSCAPE_FILL_RATIO - SQUARE_COMPACT_FILL_RATIO) * landscapeWeight;
}

/**
 * Pure-white ceiling for "this pixel is blank canvas, not content". The
 * generated sweep is lifted to 255 before this runs, so anything below the
 * ceiling is product or the shadow it casts.
 */
const SQUARE_INK_MAX_CHANNEL = 250;

/**
 * Bounding box of everything that is not blank canvas — the article *and* its
 * cast shadow.
 *
 * Only a fallback, for the frame whose matte came back empty. Framing on this
 * box is what put the hat hard against one edge of every 主图 in the 1234 run:
 * the shadow falls to one side, so centring article-plus-shadow leaves the
 * article as far off centre as the shadow is long. Prefer the article box from
 * the frame's own matte; reach for this only when there is not one.
 */
async function measureInkBox(buffer: Buffer): Promise<RelativeBox | null> {
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      if (data[offset] >= SQUARE_INK_MAX_CHANNEL
        && data[offset + 1] >= SQUARE_INK_MAX_CHANNEL
        && data[offset + 2] >= SQUARE_INK_MAX_CHANNEL) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return {
    left: minX / width,
    top: minY / height,
    width: (maxX - minX + 1) / width,
    height: (maxY - minY + 1) / height,
  };
}

/** Crops a raster buffer to a relative box plus padding, in pixel space. */
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
 * Renders the published 1:1 deliverable. `box` says where the article is in
 * `source`, and for both framings it is measured on the very picture being
 * composed — the cutout for SKU, the generated frame's own matte for 主图.
 *
 * The two framings differ in what else is in the picture. A SKU cutout is the
 * article and nothing else, so cropping to the box and centring the crop puts
 * the article in the middle. A generated 主图 frame also carries the shadow
 * the generator drew, which is not centred on the article and is not the same
 * size twice — so that one is framed on the article and lets the shadow fall
 * where it falls, off the edge of the canvas if it reaches that far.
 *
 * For 主图, `box` may be null when the frame's matte came back empty; framing
 * then falls back to the whole frame's ink, which is the degraded path and
 * puts the article off centre by however far the shadow reaches.
 */
export async function composeSquareDeliverable(
  source: Buffer,
  box: RelativeBox | null,
  output: string,
  options: { framing?: "main" | "sku" } = {},
): Promise<void> {
  if (options.framing === "main") {
    const article = box ?? await measureInkBox(source);
    if (!article) throw new Error("方形交付图缺少裁切框：生成图整幅是空白");
    await frameArticleOnSquare(source, article, output);
    return;
  }
  if (!box) throw new Error("方形交付图缺少裁切框：未提供 SKU 裁切框");
  const cropped = await cropBufferToBox(source, box, SQUARE_SKU_CROP_PADDING);
  const target = Math.round(SQUARE_CANVAS_SIZE * SQUARE_SKU_FILL_RATIO);
  // `inside` is uniform: the article keeps the proportions the frame gave it.
  // No other resize in this path is allowed to be anything else.
  const { data: resized, info } = await sharp(cropped)
    .resize(target, target, { fit: "inside" })
    .png()
    .toBuffer({ resolveWithObject: true });
  const left = Math.round((SQUARE_CANVAS_SIZE - info.width) / 2);
  const top = Math.round((SQUARE_CANVAS_SIZE - info.height) / 2);
  await sharp({ create: { width: SQUARE_CANVAS_SIZE, height: SQUARE_CANVAS_SIZE, channels: 3, background: "#ffffff" } })
    .composite([{ input: resized, left, top }])
    // sharp applies flatten() in a fixed internal stage that runs before
    // composite(), so it cannot strip the alpha composite() just introduced —
    // removeAlpha() has no such ordering quirk.
    .removeAlpha()
    .png()
    .toFile(output);
}

/**
 * Puts `article` in the middle of the square at the size the reference set
 * prints it, and lets the rest of the frame land wherever that leaves it.
 *
 * Scaling and placement are driven by the article alone, so two shots of the
 * same hat come out the same size in the same place whatever the generator did
 * with the shadow between them. The frame is not cropped to any box first: it
 * is scaled whole and a window is taken out of it, which is what keeps the
 * shadow attached to the article instead of sliced to a box's edge.
 */
async function frameArticleOnSquare(frame: Buffer, article: RelativeBox, output: string): Promise<void> {
  const { width, height } = await sharp(frame).metadata();
  if (!width || !height) throw new Error("无法读取生成图尺寸");
  const articleWidth = Math.max(1, article.width * width);
  const articleHeight = Math.max(1, article.height * height);
  const span = SQUARE_CANVAS_SIZE * squareFillRatio(articleWidth / articleHeight);
  // Uniform, and the only thing setting it is how big the article has to come
  // out. Fitting the longer axis is what leaves the shorter one its margin.
  const scale = Math.min(span / articleWidth, span / articleHeight);
  // Width only, so sharp derives the height and the resize cannot come out
  // anything but uniform. The height it picked is then read back rather than
  // assumed, because the window below is measured against it.
  const scaled = await sharp(frame)
    .resize({ width: Math.max(1, Math.round(width * scale)) })
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .png()
    .toBuffer();
  const scaledMeta = await sharp(scaled).metadata();
  if (!scaledMeta.width || !scaledMeta.height) throw new Error("无法读取缩放后的生成图尺寸");
  const { width: scaledWidth, height: scaledHeight } = scaledMeta;

  // The 800x800 window onto the scaled frame whose centre is the article's.
  const windowLeft = Math.round((article.left + article.width / 2) * scaledWidth - SQUARE_CANVAS_SIZE / 2);
  const windowTop = Math.round((article.top + article.height / 2) * scaledHeight - SQUARE_CANVAS_SIZE / 2);
  // Wherever the window runs off the frame, the canvas shows through as blank
  // white — the same white the generated sweep was lifted to.
  const padLeft = Math.max(0, -windowLeft);
  const padTop = Math.max(0, -windowTop);
  const padRight = Math.max(0, windowLeft + SQUARE_CANVAS_SIZE - scaledWidth);
  const padBottom = Math.max(0, windowTop + SQUARE_CANVAS_SIZE - scaledHeight);
  // Kept to its own pass: sharp runs extend and a post-resize extract at fixed
  // points in one pipeline, and this reads as the two steps it is.
  const padded = padLeft || padTop || padRight || padBottom
    ? await sharp(scaled)
      .extend({ top: padTop, bottom: padBottom, left: padLeft, right: padRight, background: "#ffffff" })
      .png()
      .toBuffer()
    : scaled;
  await sharp(padded)
    .extract({
      left: windowLeft + padLeft,
      top: windowTop + padTop,
      width: SQUARE_CANVAS_SIZE,
      height: SQUARE_CANVAS_SIZE,
    })
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

/**
 * The four stretches of work a run is made of. `prepare` is the shared prefix —
 * every cutout, every white master and the colour clustering — and the other
 * three are the deliverable directories, which run concurrently once it is done.
 */
export type PipelineBranchId = "prepare" | "main" | "sku" | "images";

/**
 * Roughly what share of a run each stretch takes, so the single number the card
 * shows still climbs at a believable rate now that three things advance at once.
 * `main` and `images` both wait on a paid generator; `sku` is local compositing
 * and is over almost as soon as it starts.
 */
const BRANCH_WEIGHT: Record<PipelineBranchId, number> = {
  prepare: 0.2,
  main: 0.3,
  sku: 0.05,
  images: 0.45,
};

export const BRANCH_LABEL: Record<PipelineBranchId, string> = {
  prepare: "白底图与颜色识别",
  main: "主图",
  sku: "SKU 图",
  images: "详情套图",
};

export type PipelineBranchState = { stage: string; progress: number };

export type PipelineProgressReporter = {
  /**
   * Set result fields that outlive any one report. Every emitted payload
   * replaces `result_json` wholesale, so with branches reporting concurrently
   * the accumulated fields have to live here rather than in each call site.
   */
  merge(fields: Record<string, unknown>): void;
  report(branch: PipelineBranchId, stage: string, percent: number, fields?: Record<string, unknown>): void;
  /** Marks a branch done at whatever it managed, so it stops holding the total back. */
  settle(branch: PipelineBranchId, stage: string, fields?: Record<string, unknown>): void;
  snapshot(): Record<string, unknown>;
};

/**
 * Collects what the branches report into one job result.
 *
 * `stage` stays a single key because that is what the card renders, and is
 * taken from the branch with the most weighted work left — the critical path,
 * which is the honest answer to "what is this run waiting on". The per-branch
 * detail travels alongside it under `branches` for anyone who wants the rest.
 */
export function createPipelineProgress(
  emit: (result: Record<string, unknown>) => void,
  activeBranches: readonly PipelineBranchId[],
): PipelineProgressReporter {
  const fields: Record<string, unknown> = {};
  const branches = new Map<PipelineBranchId, PipelineBranchState>(
    activeBranches.map((id) => [id, { stage: "queued", progress: 0 }] as const),
  );
  const totalWeight = activeBranches.reduce((sum, id) => sum + BRANCH_WEIGHT[id], 0) || 1;
  const snapshot = (): Record<string, unknown> => {
    let done = 0;
    let critical: { stage: string; remaining: number } | null = null;
    for (const [id, state] of branches) {
      done += BRANCH_WEIGHT[id] * state.progress;
      // A branch nobody has reported on yet is not what the run is waiting on,
      // however much weight it carries: while the shared prefix is running,
      // images/ has the largest share left and has not started, and naming it
      // would leave the card reading "排队中" for the whole first phase.
      if (state.stage === "queued" || state.progress >= 100) continue;
      const remaining = BRANCH_WEIGHT[id] * (100 - state.progress);
      if (!critical || remaining > critical.remaining) critical = { stage: state.stage, remaining };
    }
    return {
      ...fields,
      stage: critical?.stage ?? "completed",
      progress: Math.round(done / totalWeight),
      branches: Object.fromEntries([...branches].map(([id, state]) => [id, { ...state }])),
    };
  };
  const set = (branch: PipelineBranchId, stage: string, percent: number, extra?: Record<string, unknown>) => {
    const state = branches.get(branch);
    if (!state) return;
    state.stage = stage;
    // Clamped, and never allowed to walk backwards: a branch reporting an
    // earlier stage must not make the run look like it lost ground.
    state.progress = Math.max(state.progress, Math.min(100, Math.max(0, Math.round(percent))));
    if (extra) Object.assign(fields, extra);
    emit(snapshot());
  };
  return {
    merge(extra) { Object.assign(fields, extra); emit(snapshot()); },
    report(branch, stage, percent, extra) { set(branch, stage, percent, extra); },
    settle(branch, stage, extra) { set(branch, stage, 100, extra); },
    snapshot,
  };
}

export type PipelineBranchFailure = { branch: PipelineBranchId; reason: string };

/**
 * Runs the deliverable branches at the same time and lets each one fail alone.
 *
 * The point is that a rejected 主图 must not throw away an images/ set that has
 * already been paid for, and vice versa. Failures come back in the order the
 * branches were declared rather than the order they happened, so the same run
 * reports the same way twice.
 */
export async function runPipelineBranches(
  branches: readonly { id: PipelineBranchId; run: () => Promise<void> }[],
  onSettled?: (branch: PipelineBranchId, reason?: string) => void,
): Promise<PipelineBranchFailure[]> {
  const failures = new Map<PipelineBranchId, string>();
  await Promise.all(branches.map(async ({ id, run }) => {
    try {
      await run();
      onSettled?.(id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.set(id, reason);
      onSettled?.(id, reason);
    }
  }));
  return branches.flatMap(({ id }) => {
    const reason = failures.get(id);
    return reason === undefined ? [] : [{ branch: id, reason }];
  });
}

/** Everything the three deliverable branches share once the prefix is done. */
type BranchContext = {
  job: MonoJob;
  signal: AbortSignal;
  folderKey: string;
  stagingRoot: string;
  detailFolder: string;
  prepared: readonly PreparedArticleSource[];
  classification: SourceClassification;
  progress: PipelineProgressReporter;
};

/**
 * 主图: the generated frame for every whole-article shot, framed on the square.
 *
 * Which shots those are used to come out of `classification.colors`, which is
 * only reachable after every cutout in the folder has landed. It is the same
 * set either way — the clustering partitions exactly the frames this predicate
 * accepts — but asking each frame's own metric is what lets this branch run
 * without waiting on the rest of the folder.
 */
export type FailedMainFrame = { stem: string; name: string; reason: string };
type MainFrameRecord = { stem: string; name: string; warnings?: string[]; sha256: string; assetId?: string };
type MainBranchOutcome = {
  deliverables: ProductPipelineDeliverable[];
  records: MainFrameRecord[];
  failedMain: FailedMainFrame[];
  warnings: string[];
};

/**
 * Main images use the same partial-delivery rule as the paid detail slots:
 * a failed source frame is recorded, while every successful frame is merged
 * into 主图/ at the end of this run. That makes a retry cheap and prevents one
 * transient provider rejection from hiding an otherwise usable set.
 */
async function runMainBranch(ctx: BranchContext): Promise<MainBranchOutcome> {
  const eligibleShots = ctx.prepared.filter((item) => isFullArticleShot(item.metric));
  if (!eligibleShots.length) throw new Error("没有可用于主图的商品整体图：原图不是细节特写就是抠图为空");
  const rawOnlyMain = ctx.job.input.onlyMain;
  const onlyMain = Array.isArray(rawOnlyMain) && rawOnlyMain.length ? rawOnlyMain.map(String) : null;
  const selectedStems = selectMainSourceStems(eligibleShots.map((item) => item.source.stem), onlyMain);
  const byStem = new Map(eligibleShots.map((item) => [item.source.stem, item]));
  const shots = selectedStems.map((stem) => byStem.get(stem)!);
  const stage = path.join(ctx.stagingRoot, "主图");
  await mkdir(stage, { recursive: true });
  const destination = path.join(ctx.detailFolder, "主图");
  const warnings: string[] = [];
  const records: MainFrameRecord[] = [];
  const failedMain: FailedMainFrame[] = [];
  ctx.progress.report("main", "generating_main", 2, { mainRecords: [], failedMain: [] });
  await runWithConcurrency(shots, PRODUCT_CUTOUT_CONCURRENCY, async (item) => {
    if (ctx.signal.aborted) throw new Error("任务已取消");
    try {
      const frame = await renderMainFrame(item, ctx.folderKey, ctx.signal, ctx.job.workspaceId);
      warnings.push(...frame.warnings);
      const name = `${item.source.stem}.png`;
      const output = path.join(stage, name);
      // The article as located on this very generated frame. Nothing measured
      // on another picture reaches the framing.
      await composeSquareDeliverable(frame.image, frame.article, output, { framing: "main" });
      records.push({
        stem: item.source.stem,
        name,
        ...(frame.warnings.length ? { warnings: frame.warnings } : {}),
        sha256: await fileHash(output),
      });
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      failedMain.push({
        stem: item.source.stem,
        name: item.source.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    const settled = records.length + failedMain.length;
    ctx.progress.report("main", "generating_main", 2 + (settled / Math.max(1, shots.length)) * 88, {
      mainRecords: [...records],
      failedMain: [...failedMain],
      mainWarnings: [...warnings],
      onlyMain,
    });
  });

  let deliverables: ProductPipelineDeliverable[] = [];
  if (records.length) {
    const producedNames = new Set(records.map((record) => record.name));
    await verifyMainOutputs(stage, producedNames, ctx.prepared.map((item) => item.source));
    ctx.progress.report("main", "publishing_main", 92, {
      mainRecords: [...records], failedMain: [...failedMain], mainWarnings: [...warnings], onlyMain,
    });
    await publishMainImages(stage, destination, producedNames);
    deliverables = await persistProductDirectory(ctx.job, destination, "product-main", producedNames);
    for (const record of records) {
      const asset = deliverables.find((item) => item.slotKey === record.name);
      if (asset) record.assetId = asset.assetId;
    }
  }
  return { deliverables, records, failedMain, warnings };
}

/** SKU: one clean catalogue angle per colourway, no recovered shadow. */
async function runSkuBranch(ctx: BranchContext): Promise<{ deliverables: ProductPipelineDeliverable[] }> {
  const stage = path.join(ctx.stagingRoot, "SKU");
  await mkdir(stage, { recursive: true });
  const destination = path.join(ctx.detailFolder, "SKU");
  const byMaster = preparedByMaster(ctx.prepared);
  let done = 0;
  ctx.progress.report("sku", "rendering_sku", 5);
  await runWithConcurrency(ctx.classification.colors, PRODUCT_CUTOUT_CONCURRENCY, async (color) => {
    if (ctx.signal.aborted) throw new Error("任务已取消");
    const item = byMaster.get(color.representative.path);
    if (!item) throw new Error(`缺少 SKU 代表图的中间产物：${color.representative.path}`);
    await composeSquareDeliverable(
      item.skuForeground,
      color.representative.metric.box,
      path.join(stage, `SKU${color.rank + 1}.png`),
    );
    done += 1;
    ctx.progress.report("sku", "rendering_sku", (done / ctx.classification.colors.length) * 90);
  });
  ctx.progress.report("sku", "publishing_sku", 92);
  await atomicPublish(stage, destination);
  return { deliverables: await persistProductDirectory(ctx.job, destination, "product-sku") };
}

function preparedByMaster(prepared: readonly PreparedArticleSource[]): Map<string, PreparedArticleSource> {
  return new Map(prepared.map((item) => [item.master, item]));
}

type ImagesBranchOutcome = {
  deliverables: ProductPipelineDeliverable[];
  records: Record<string, unknown>[];
  failedSlots: FailedModelSlot[];
  warnings: string[];
};

/** images/: the eight paid model slots plus the four assembled from the shoot. */
async function runImagesBranch(
  ctx: BranchContext,
  options: {
    template: ProductTemplate;
    templateRoot: string;
    sources: SourceImage[];
    detailShots: SourceImage[];
    baseName: string;
    modelPair: ResolvedProductModelPair | undefined;
  },
): Promise<ImagesBranchOutcome> {
  const { job, signal, classification } = ctx;
  const { template, templateRoot, sources, detailShots, baseName, modelPair } = options;
  const slotColorRank = modelSlotColorRanks(classification.colors.length);
  const rawOnlySlots = job.input.onlySlots;
  const onlySlots = Array.isArray(rawOnlySlots) && rawOnlySlots.length ? rawOnlySlots.map(String) : null;
  const modelSlots = selectModelSlots(onlySlots);
  const warnings: string[] = [];
  // color.members[].path is a white-master path; model-slot generation resolves
  // it back to the matching raw original through this map.
  const masterToOriginal = new Map(ctx.prepared.map((item) => [item.master, item.source.path]));
  const byMaster = preparedByMaster(ctx.prepared);
  // The colourway line-up wants the same silhouette SKU publishes, in rank
  // order. Built here rather than borrowed from the SKU branch, so a failure
  // over there cannot leave this one holding a half-filled array.
  const tiledForegrounds = classification.colors.map((color) => {
    const item = byMaster.get(color.representative.path);
    if (!item) throw new Error(`缺少颜色拼版的中间产物：${color.representative.path}`);
    return item.skuForeground;
  });
  ctx.progress.report("images", "generating_models", 2, {
    slotColorRanks: Object.fromEntries(slotColorRank),
    onlySlots,
  });

  const detailStage = path.join(ctx.stagingRoot, "images"); await mkdir(detailStage, { recursive: true });
  const records: Record<string, unknown>[] = [];
  const { records: modelRecords, failedSlots } = await runModelGenerationPhase(
    modelSlots,
    MODEL_CONCURRENCY,
    signal,
    async (slot) => {
      const color = classification.colors[slotColorRank.get(slot[0])!];
      const output = path.join(detailStage, `${baseName}_${slot[0]}.jpg`);
      const record = await generateModelSlot(
        template,
        templateRoot,
        color,
        output,
        slot,
        signal,
        job.workspaceId,
        modelPair,
        masterToOriginal,
      );
      if (record.warning) warnings.push(`${slot[0]}: ${record.warning}`);
      return { slot: slot[0], colorRank: color.rank, ...record };
    },
    ({ records: settledRecords, failedSlots: settledFailures }) => {
      const settled = settledRecords.length + settledFailures.length;
      ctx.progress.report("images", "generating_models", 2 + (settled / Math.max(1, modelSlots.length)) * 70, {
        slots: [...settledRecords], failedSlots: [...settledFailures],
      });
    },
  );
  records.push(...modelRecords);
  ctx.progress.report("images", "compositing", 76, { slots: [...records], failedSlots });
  // A detail-only retry is intentionally limited to the requested paid model
  // frames. Static and assembled pages already on the share stay untouched.
  const compositedSlots = onlySlots ? [] : DETAIL_SLOTS.filter((item) => item[3] !== "model");
  for (const slot of compositedSlots) {
    const output = path.join(detailStage, `${baseName}_${slot[0]}.jpg`);
    await renderCompositedSlot(
      template,
      templateRoot,
      classification,
      detailShots,
      slot,
      output,
      tiledForegrounds,
    );
    records.push({ slot: slot[0], attempts: 0, qa: "not-required", sha256: await fileHash(output) });
  }
  // An all-failed targeted retry has no files to publish, but it is still a
  // completed attempt with retryable slot-level errors. Returning that result
  // keeps the next "重跑失败项" action available instead of hiding it behind a
  // branch-level failure.
  if (!records.length) return { deliverables: [], records, failedSlots, warnings };
  ctx.progress.report("images", "qa", 88, { slots: [...records], failedSlots });
  // Only the slots actually staged this run are verified/published: a failed
  // model slot (or one skipped by `onlySlots`) simply keeps whatever image is
  // already on the share, rather than blocking or clobbering it.
  const producedSlotIds = new Set(records.map((record) => record.slot as string));
  await verifyDetailOutputs(detailStage, baseName, sources, producedSlotIds);
  await assertSourcesUnchanged(sources);
  ctx.progress.report("images", "publishing_images", 94);
  const destination = path.join(ctx.detailFolder, "images");
  await publishImages(detailStage, destination, baseName, producedSlotIds);
  const deliverables = await persistProductDetailDirectory(job, destination, baseName);
  for (const slotId of producedSlotIds) {
    const asset = deliverables.find((item) => item.slotKey === slotId);
    const record = records.find((item) => item.slot === slotId);
    if (record && asset) record.assetId = asset.assetId;
  }
  return { deliverables, records, failedSlots, warnings };
}

/**
 * The shared local prefix, then the three deliverable directories at once.
 *
 * Every cutout, white master and the colour clustering happen first because all
 * three branches ask something of them. Once they have, 主图 / SKU / images run
 * concurrently and settle independently: the detail set's paid model slots no
 * longer queue behind 主图's paid backgrounds, and neither directory is thrown
 * away because the other one failed.
 *
 * The detail set requires an installed, hash-verified template bundle: the
 * bundle carries only category-level styling, so an unattended run can never
 * fall back to describing one particular article it happens to remember. That
 * check stays in the prefix — a missing bundle is a misconfigured job, not one
 * branch's bad luck, and there is no point paying for 主图 backgrounds first.
 */
export async function runProductPipeline(job: MonoJob, signal: AbortSignal): Promise<Record<string, unknown>> {
  const folderId = String(job.input.folderId ?? "");
  const modelPairId = typeof job.input.modelPairId === "string" ? job.input.modelPairId : "";
  // Resolve before any local cutout work or paid request. The current adapter
  // only reads already-saved experiment assets; it never creates castings.
  const modelPair = modelPairId
    ? await resolveProductModelPair(job.workspaceId, modelPairId)
    : undefined;
  const { absolutePath, relativePath } = resolveProductFolder(folderId);
  const detailFolder = resolveDetailPageFolder(relativePath);
  const folderKey = productPipelineFolderKey(folderId);
  const sources = await sourceImages(path.join(absolutePath, "原图"));
  const { article: articleSources, details: detailShots } = partitionSources(sources);
  if (!articleSources.length) throw new Error("原图目录只有 x_ 开头的细节图，缺少商品整体图");
  const stagingRoot = productPipelineStagingRoot(job.id);
  // Full-frame, unstyled — an intermediate used only for colour clustering and
  // as the gpt-image-2 reference set. Never published: the deliverable a person
  // sees under 【详情页】-待审/主图 is the square render the 主图 branch builds
  // from the generated frame.
  const masterStage = path.join(stagingRoot, "主图-原始");
  await mkdir(masterStage, { recursive: true });

  const hasOnlySlots = Array.isArray(job.input.onlySlots) && job.input.onlySlots.length > 0;
  const hasOnlyMain = Array.isArray(job.input.onlyMain) && job.input.onlyMain.length > 0;
  // `retryMain` supports jobs created before per-frame main failures existed;
  // `onlyMain` itself is also sufficient for new, narrowed retries.
  const retryMain = job.input.retryMain === true || hasOnlyMain;
  const isTargetedRetry = hasOnlySlots || retryMain;
  // A retry must not make unrelated paid requests. The shared prepare phase is
  // still required, but it only runs the requested delivery branch afterwards.
  const runMain = !isTargetedRetry || retryMain;
  const runSku = !isTargetedRetry;
  const runImages = !PRODUCT_PIPELINE_SHADOW_ONLY_TRIAL && (!isTargetedRetry || hasOnlySlots);
  const activeBranches: PipelineBranchId[] = [
    "prepare",
    ...(runMain ? ["main" as const] : []),
    ...(runSku ? ["sku" as const] : []),
    ...(runImages ? ["images" as const] : []),
  ];
  const progress = createPipelineProgress(
    (result) => updateMonoJobResult(job.id, result),
    activeBranches,
  );
  progress.merge({
    relativePath,
    sourceCount: articleSources.length,
    modelPairId: modelPair?.id,
    modelPairName: modelPair?.displayName,
    // Cutout is no longer skipped across runs (see masterStage above), so this
    // is always false. Kept for API/UI compatibility with `result.resumed`.
    resumed: false,
    outputs: [],
  });

  const prepared: PreparedArticleSource[] = Array.from({ length: articleSources.length });
  const outputs: ({ name: string; sha256: string } | undefined)[] = Array.from({ length: articleSources.length });
  progress.report("prepare", "正在生成白底主图", 1);
  await runWithConcurrency(articleSources, PRODUCT_CUTOUT_CONCURRENCY, async (source, index) => {
    if (signal.aborted) throw new Error("任务已取消");
    await assertSourcesUnchanged(sources);
    const name = `${source.stem}.jpg`;
    const output = path.join(masterStage, name);
    prepared[index] = await prepareArticleSource(source, output, folderKey, signal);
    outputs[index] = { name, sha256: sha256(await readFile(output)) };
    progress.report(
      "prepare",
      "正在生成白底主图",
      (outputs.filter(Boolean).length / articleSources.length) * 80,
      { outputs: outputs.filter(Boolean) },
    );
  });
  await assertSourcesUnchanged(sources);

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
  progress.report("prepare", "classifying", 88, {
    templateVersion: manifest.version,
    masterHashes: await Promise.all(prepared.map((item) => fileHash(item.master))),
  });

  // Colourways and macro crops are recovered from the shoot itself; nothing in
  // the folder labels them, and no human edits the set between steps. The
  // metrics were already taken while the masters were being written, so this
  // only does the clustering.
  const classification = classifySources(
    prepared.map((item) => ({ path: item.master, metric: item.metric })),
    { hasNamedDetailShots: detailShots.length > 0 },
  );
  if (!classification.colors.length) throw new Error("无法识别可用商品颜色；未调用付费生图服务");
  const colors = classification.colors.map((color) => ({
    rank: color.rank,
    lab: color.lab.map((channel) => Math.round(channel * 10) / 10),
    shots: color.members.length,
  }));
  const detailShotCount = detailShots.length || classification.details.length;
  progress.settle("prepare", "classified", { colors, detailShots: detailShotCount });

  const context: BranchContext = {
    job, signal, folderKey, stagingRoot, detailFolder, prepared, classification, progress,
  };
  let mainOutcome: MainBranchOutcome | undefined;
  let skuOutcome: { deliverables: ProductPipelineDeliverable[] } | undefined;
  let imagesOutcome: ImagesBranchOutcome | undefined;
  const branches: { id: PipelineBranchId; run: () => Promise<void> }[] = [];
  if (runMain) branches.push({ id: "main", run: async () => { mainOutcome = await runMainBranch(context); } });
  if (runSku) branches.push({ id: "sku", run: async () => { skuOutcome = await runSkuBranch(context); } });
  if (runImages) {
    branches.push({
      id: "images",
      run: async () => {
        imagesOutcome = await runImagesBranch(context, {
          template, templateRoot, sources, detailShots,
          baseName: path.basename(absolutePath),
          modelPair,
        });
      },
    });
  }
  const failures = await runPipelineBranches(branches, (branch, reason) => {
    progress.settle(branch, reason ? "branch_failed" : "branch_published");
  });

  // The only staging directory not already removed by an atomicPublish call:
  // it fed classification and the gpt-image-2 references but was never itself
  // a publish target.
  await rm(masterStage, { recursive: true, force: true });
  // A cancellation reaches every branch at once and would otherwise read as
  // "everything failed on its own", which is not what happened and not what
  // the operator should be told.
  if (signal.aborted) throw new Error("任务已取消");
  if (failures.length === branches.length) {
    throw new Error(`${branches.length} 个交付目录全部失败，未发布任何内容：${failures.map((item) => `${BRANCH_LABEL[item.branch]}(${item.reason})`).join("；")}`);
  }

  const warnings = [
    ...classification.warnings,
    ...(mainOutcome?.warnings ?? []),
    ...(imagesOutcome?.warnings ?? []),
    ...(mainOutcome?.failedMain ?? []).map((item) => `主图 ${item.name} 未能完成：${item.reason}`),
    ...failures.map((item) => `${BRANCH_LABEL[item.branch]}未能完成，其余目录已照常发布：${item.reason}`),
    ...(PRODUCT_PIPELINE_SHADOW_ONLY_TRIAL ? ["PRODUCT_PIPELINE_SHADOW_ONLY_TRIAL：本次运行跳过了 images 详情图生成"] : []),
  ];
  const failedSlots = imagesOutcome?.failedSlots ?? [];
  const failedMain = mainOutcome?.failedMain ?? [];
  return {
    stage: "completed",
    progress: 100,
    relativePath,
    templateVersion: manifest.version,
    modelPairId: modelPair?.id,
    modelPairName: modelPair?.displayName,
    colors,
    detailShots: detailShotCount,
    mainRecords: mainOutcome?.records ?? [],
    failedMain,
    slots: imagesOutcome?.records ?? [],
    deliverables: [
      ...(mainOutcome?.deliverables ?? []),
      ...(skuOutcome?.deliverables ?? []),
      ...(imagesOutcome?.deliverables ?? []),
    ],
    warnings,
    resumed: false,
    incomplete: failedSlots.length > 0 || failedMain.length > 0 || failures.length > 0,
    failedSlots,
    failedBranches: failures.map((item) => ({ ...item, label: BRANCH_LABEL[item.branch] })),
  };
}

type ProductPipelineDeliverable = {
  assetId: string;
  role: "product-main" | "product-sku" | "product-detail";
  slotKey: string;
  name: string;
  sha256: string;
};

async function persistProductFile(
  job: MonoJob,
  file: string,
  role: ProductPipelineDeliverable["role"],
  slotKey: string,
): Promise<ProductPipelineDeliverable> {
  const bytes = await readFile(file);
  const name = path.basename(file);
  const mimeType = path.extname(file).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
  const stored = await saveObjectBuffer(bytes, name);
  const actor = {
    userId: job.userId,
    workspaceId: job.workspaceId,
    traceId: job.traceId,
  };
  const asset = createMonoAsset(actor, {
    sourceUrl: `storage:${stored.key}`,
    storageKey: stored.key,
    location: "local-storage",
    mimeType,
    name,
  });
  linkMonoJobAsset(actor, job.id, asset.id, role, slotKey);
  return { assetId: asset.id, role, slotKey, name, sha256: sha256(bytes) };
}

async function persistProductDirectory(
  job: MonoJob,
  directory: string,
  role: "product-main" | "product-sku",
  onlyNames?: ReadonlySet<string>,
): Promise<ProductPipelineDeliverable[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries.filter(
    (entry) => entry.isFile()
      && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      && (!onlyNames || onlyNames.has(entry.name)),
  );
  return Promise.all(files.map((entry) =>
    persistProductFile(job, path.join(directory, entry.name), role, entry.name)));
}

async function persistProductDetailDirectory(
  job: MonoJob,
  directory: string,
  baseName: string,
): Promise<ProductPipelineDeliverable[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const pattern = new RegExp(`^${escapeRegExp(baseName)}_(\\d{2})\\.(?:jpe?g|png|webp)$`, "iu");
  return Promise.all(entries.flatMap((entry) => {
    if (!entry.isFile()) return [];
    const match = entry.name.match(pattern);
    if (!match) return [];
    return [persistProductFile(job, path.join(directory, entry.name), "product-detail", match[1])];
  }));
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
  tiledForegrounds: readonly Buffer[],
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
      tiledForegrounds,
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
  const { hero, grid } = detailPageSources(crops);
  await renderDetailPresentation(
    hero, grid, output, width, height, template.pages["11"].title, template.pages["11"].caption,
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
// A fetch without a deadline can leave a card looking active indefinitely
// while the worker continues renewing its lease. This remains comfortably
// above normal image-generation latency but routes a real stall through the
// existing per-slot retry and failure handling.
const MODEL_IMAGE_REQUEST_TIMEOUT_MS = Math.max(
  30_000,
  Number(process.env.PRODUCT_PIPELINE_MODEL_REQUEST_TIMEOUT_MS) || 5 * 60 * 1000,
);

async function generateModelSlot(
  template: ProductTemplate,
  templateRoot: string,
  color: SourceClassification["colors"][number],
  output: string,
  slot: DetailSlot,
  signal: AbortSignal,
  workspaceId: string,
  modelPair?: ResolvedProductModelPair,
  masterToOriginal?: ReadonlyMap<string, string>,
): Promise<Record<string, unknown>> {
  const look = template.looks[color.rank % template.looks.length];
  const identityGroupId: ModelIdentityGroup | undefined = modelPair
    ? identityGroupForLook(look.id)
    : undefined;
  const identityProfile = identityGroupId ? modelPair?.profiles[identityGroupId] : undefined;
  const prompt = buildModelPrompt(
    template,
    slot[0],
    color.rank,
    slot[1],
    slot[2],
    identityGroupId,
    Boolean(identityProfile?.bodyBytes),
  );
  // Several angles of the same colourway make it much harder for the model to
  // invent a plain version of an article whose graphic sits on one face only.
  // OLD (white-master references; waits on the cutout/composite step):
  // const productReferences = color.members.slice(0, PRODUCT_REFERENCE_COUNT).map((member) => member.path);
  // TRIAL: raw originals, resolved from the white-master path classification carries.
  const productReferences = color.members.slice(0, PRODUCT_REFERENCE_COUNT)
    .map((member) => masterToOriginal?.get(member.path) ?? member.path);
  const references = modelImageReferences(
    productReferences,
    identityProfile?.faceBytes,
    identityProfile?.bodyBytes,
  );
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
    ...(identityGroupId ? {
      identityGroupId,
      modelProfileId: identityProfile?.id,
    } : {}),
    qa: warning ? "warning" : "passed",
    warning,
    colorPresence: Math.round(presence * 1000) / 1000,
    sha256: await fileHash(output),
  };
}

export function modelImageReferences(
  productReferences: readonly string[],
  faceReference?: string | Buffer,
  bodyReference?: string | Buffer,
): (string | Buffer)[] {
  if (productReferences.length < 1) throw new Error("商品套图缺少商品参考图");
  return faceReference
    ? [faceReference, ...(bodyReference ? [bodyReference] : []), ...productReferences]
    : [...productReferences];
}

async function callImageGenerate(
  references: readonly (string | Buffer)[],
  prompt: string,
  aspectRatio: string,
  signal: AbortSignal,
  workspaceId: string,
  model: string,
): Promise<Buffer> {
  const base = getConfigValue("MONO_IMAGE_BASE_URL", workspaceId); const key = getConfigValue("MONO_IMAGE_API_KEY", workspaceId);
  if (!base || !key) throw new Error(`详情套图需要配置 MONO_IMAGE_BASE_URL 和 MONO_IMAGE_API_KEY（将调用付费 ${model}）`);
  const endpoint = process.env.MONO_IMAGE_GENERATE_URL ?? new URL("/v1/api/generate", base).toString();
  const bytes = await Promise.all(references.map((reference) =>
    Buffer.isBuffer(reference) ? reference : readFile(reference)));
  const deadline = AbortSignal.timeout(MODEL_IMAGE_REQUEST_TIMEOUT_MS);
  const requestSignal = AbortSignal.any([signal, deadline]);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        prompt,
        images: bytes.map((buffer) => `data:image/jpeg;base64,${buffer.toString("base64")}`),
        aspectRatio,
        replyType: "json",
      }),
      signal: requestSignal,
    });
  } catch (error) {
    if (deadline.aborted && !signal.aborted) {
      throw new Error(`${model} 请求超时（${Math.round(MODEL_IMAGE_REQUEST_TIMEOUT_MS / 1000)} 秒）`);
    }
    throw error;
  }
  // Read the body as text first: a rejected prompt, an oversized reference and a
  // spent quota all arrive as the same status, and one failed slot ends the run.
  // Reporting the code alone leaves nothing to act on.
  const body = await response.text().catch(() => "");
  type GenerateResponse = { url?: string; results?: { url?: string }[] };
  let json: GenerateResponse | null = null;
  try { json = JSON.parse(body) as GenerateResponse; } catch { /* upstream errors are not always JSON */ }
  const url = json?.url ?? json?.results?.[0]?.url;
  if (!response.ok || !url) throw new Error(`${model} 请求失败 (HTTP ${response.status})：${body.slice(0, 300)}`);
  let image: Response;
  try {
    image = await fetch(url, { signal: requestSignal });
  } catch (error) {
    if (deadline.aborted && !signal.aborted) {
      throw new Error(`${model} 结果下载超时（${Math.round(MODEL_IMAGE_REQUEST_TIMEOUT_MS / 1000)} 秒）`);
    }
    throw error;
  }
  if (!image.ok) throw new Error(`无法下载 ${model} 结果`);
  return Buffer.from(await image.arrayBuffer());
}

async function requestModelImage(
  references: readonly (string | Buffer)[],
  prompt: string,
  slot: DetailSlot,
  signal: AbortSignal,
  workspaceId: string,
): Promise<Buffer> {
  return callImageGenerate(references, prompt, `${slot[1]}:${slot[2]}`, signal, workspaceId, "gpt-image-2");
}

/**
 * Two instructions here are spelled out rather than left implied by
 * "像素级不变", for different reasons:
 *
 * - the proportions, because a run once appeared to come back with the article
 *   7% narrower. That reading was a measuring error (see
 *   `describeProportionDrift`) and the article is in fact redrawn at the size
 *   it went in, so this sentence is now belt-and-braces rather than a fix —
 *   `locateGeneratedArticle` reports it if that ever stops being true;
 * - the cast shadow, because it did genuinely come back so faint it read as no
 *   shadow at all against the white, which defeats the point of sending the
 *   shot out in the first place.
 */
const SHADOW_BACKDROP_PROMPT = "请保持商品本体像素级不变，构图、裁切、取景范围与输入图完全一致；"
  + "严格保持商品的长宽比例、尺寸与透视，不得把商品拉长、压扁、放大或缩小，"
  + "不要改变商品的形状、颜色、材质、图案或位置；"
  + "将背景替换为纯白色 #FFFFFF，并保留输入图中商品投在地面上的投影，"
  + "投影的方向、长度与浓淡要与输入图一致，且必须清晰可见——"
  + "是影棚级的自然投影，不是几乎看不见的一层浅灰。";

/**
 * Replaces the local histogram-based shadow recovery with the same online
 * generation service already used for detail-page model shots
 * (`MONO_IMAGE_BASE_URL`/`MONO_IMAGE_API_KEY`). The source photo itself is
 * sent as the only reference — its real lighting already contains the
 * shadow — and the model is asked to clean the background rather than
 * invent one from nothing.
 *
 * No silent fallback to `composeNaturalShadowBackdrop` on failure: a
 * downgraded-quality shadow must surface as a failed run, not slip through
 * unnoticed.
 *
 * The source's own pixel dimensions are sent as the requested ratio so the
 * model has no reason to reframe: a re-composition is the point at which it
 * starts redrawing the article at new proportions. Whatever comes back is
 * returned at its own size — see below.
 */
export async function requestShadowBackdrop(
  source: SourceImage,
  signal: AbortSignal,
  workspaceId: string,
  model = "gpt-image-2",
): Promise<Buffer> {
  const { width, height } = await sharp(source.path).metadata();
  if (!width || !height) throw new Error("无法读取原图尺寸");
  let lastFailure = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const generated = await callImageGenerate(
        [source.path],
        SHADOW_BACKDROP_PROMPT,
        `${width}:${height}`,
        signal,
        workspaceId,
        model,
      );
      // Returned at the generator's own dimensions, deliberately. Forcing it
      // back to the source's width/height is a non-uniform resize wherever the
      // service rounded the requested ratio to one of its supported shapes,
      // and it squeezed the article in every single 主图. Everything
      // downstream measures and scales this frame in its own coordinates, so
      // no size agreement is needed here.
      return await sharp(generated)
        .removeAlpha()
        .png()
        .toBuffer();
    } catch (error) {
      if (signal.aborted) throw error;
      lastFailure = error instanceof Error ? error.message : "生成结果无法解码";
    }
  }
  throw new Error(`主图阴影三次都没拿到有效结果：${lastFailure}`);
}

/** Validates only the main images completed by this run before they are merged onto the share. */
export async function verifyMainOutputs(
  stage: string,
  producedNames: ReadonlySet<string>,
  sources: SourceImage[],
): Promise<void> {
  for (const name of producedNames) {
    const meta = await sharp(path.join(stage, name)).metadata();
    if (meta.width !== SQUARE_CANVAS_SIZE || meta.height !== SQUARE_CANVAS_SIZE) {
      throw new Error(`主图 ${name} 尺寸校验失败`);
    }
  }
  await assertSourcesUnchanged(sources);
}

/**
 * Publishes only the main files staged by this run. Existing successful files
 * stay in place during a retry, exactly as detail-slot retries do.
 */
export async function publishMainImages(
  stage: string,
  destination: string,
  producedNames: ReadonlySet<string>,
): Promise<void> {
  const merge = `${stage}-merged`;
  await mkdir(merge, { recursive: true });
  try {
    await cp(destination, merge, { recursive: true, errorOnExist: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const name of producedNames) await cp(path.join(stage, name), path.join(merge, name));
  await atomicPublish(merge, destination);
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
