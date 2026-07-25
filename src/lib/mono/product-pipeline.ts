import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { getMonoJob, updateMonoJobResult } from "./store";
import { gatewayBase, gatewayHeaders } from "@/lib/toolbox/gateway";
import type { MonoJob, ProductPipelineInput } from "./contracts";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);
const WORKFLOW_ID = "hat-62604171-v1";

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

async function makeWhiteMaster(source: SourceImage, output: string, signal: AbortSignal): Promise<void> {
  const product = await sharp(await requestCutout(source, signal)).resize({ width: 760, height: 760, fit: "contain", withoutEnlargement: true }).png().toBuffer();
  await sharp({ create: { width: 800, height: 800, channels: 3, background: "#ffffff" } })
    .composite([{ input: product, gravity: "centre" }]).jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toFile(output);
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
  await mkdir(masterStage, { recursive: true });
  progress(job, "正在生成白底主图", 5, { sourceCount: sources.length, outputs: [] });
  const outputs: { name: string; sha256: string }[] = [];
  for (let index = 0; index < sources.length; index += 1) {
    if (signal.aborted) throw new Error("任务已取消");
    await assertSourcesUnchanged(sources);
    const source = sources[index];
    const name = `${source.stem}.jpg`;
    const output = path.join(masterStage, name);
    await makeWhiteMaster(source, output, signal);
    outputs.push({ name, sha256: createHash("sha256").update(await readFile(output)).digest("hex") });
    progress(job, "正在生成白底主图", Math.round(5 + ((index + 1) / sources.length) * 70), { sourceCount: sources.length, outputs });
  }
  await assertSourcesUnchanged(sources);
  await atomicPublish(masterStage, path.join(absolutePath, "主图"));
  // Never create a partial images directory. It is only published after all eleven
  // template artifacts have been generated and verified by the image-model stage.
  const templateRoot = process.env.PRODUCT_PIPELINE_TEMPLATE_ROOT;
  if (!templateRoot) throw new Error("白底主图已完成；详情套图模板包尚未配置，未发布 images 阶段");
  await cp(templateRoot, path.join(stagingRoot, "template-validation"), { recursive: true, errorOnExist: true });
  throw new Error("详情套图生成器尚未部署，未发布 images 阶段");
}
