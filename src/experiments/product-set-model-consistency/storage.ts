import { randomUUID } from "node:crypto";
import { cp, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { productSourceRoot } from "@/lib/mono/product-roots";
import type {
  CastingRecord,
  ConsistencyRun,
  ExperimentCatalog,
  ExperimentProduct,
  ModelPair,
  ModelProfile,
} from "./types";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const CASTING_ID = /^casting_[0-9a-f-]{36}$/u;
const PROFILE_ID = /^profile_[0-9a-f-]{36}$/u;
const PAIR_ID = /^pair_[0-9a-f-]{36}$/u;
const RUN_ID = /^run_[0-9a-f-]{36}$/u;

export function experimentRoot(): string {
  return path.resolve(
    process.env.MODEL_CONSISTENCY_TEST_ROOT
      ?? path.join(productSourceRoot(), "test", "model-consistency"),
  );
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

export function assertExperimentPath(candidate: string): string {
  const resolved = path.resolve(candidate);
  if (!contained(experimentRoot(), resolved)) throw new Error("实验路径超出允许目录");
  return resolved;
}

function opaqueId(prefix: "casting" | "profile" | "pair" | "run"): string {
  return `${prefix}_${randomUUID()}`;
}

export const newCastingId = () => opaqueId("casting");
export const newProfileId = () => opaqueId("profile");
export const newPairId = () => opaqueId("pair");
export const newRunId = () => opaqueId("run");

function requireId(id: string, pattern: RegExp, label: string): string {
  if (!pattern.test(id)) throw new Error(`${label}标识无效`);
  return id;
}

export function castingsRoot(): string {
  return assertExperimentPath(path.join(experimentRoot(), "_castings"));
}

export function castingDir(id: string): string {
  return assertExperimentPath(path.join(castingsRoot(), requireId(id, CASTING_ID, "选角")));
}

export function profilesRoot(): string {
  return assertExperimentPath(path.join(experimentRoot(), "_model-profiles"));
}

export function profileDir(id: string): string {
  return assertExperimentPath(path.join(profilesRoot(), requireId(id, PROFILE_ID, "模特卡")));
}

export function pairsRoot(): string {
  return assertExperimentPath(path.join(experimentRoot(), "_model-pairs"));
}

export function pairDir(id: string): string {
  return assertExperimentPath(path.join(pairsRoot(), requireId(id, PAIR_ID, "模特组合")));
}

function runIndexRoot(): string {
  return assertExperimentPath(path.join(experimentRoot(), "_run-index"));
}

function productId(name: string): string {
  return Buffer.from(name, "utf8").toString("base64url");
}

function productNameFromId(id: string): string {
  let name: string;
  try {
    name = Buffer.from(id, "base64url").toString("utf8");
  } catch {
    throw new Error("测试商品标识无效");
  }
  if (!name || name.includes("\0") || name.includes("/") || name.includes("\\")) {
    throw new Error("测试商品标识无效");
  }
  return name;
}

export function productDir(id: string): string {
  const name = productNameFromId(id);
  const resolved = assertExperimentPath(path.join(experimentRoot(), name));
  if (path.dirname(resolved) !== experimentRoot()) throw new Error("测试商品超出允许目录");
  return resolved;
}

export async function runDir(id: string): Promise<string> {
  requireId(id, RUN_ID, "运行");
  const index = await readJson<{ productId: string }>(path.join(runIndexRoot(), `${id}.json`));
  return assertExperimentPath(path.join(productDir(index.productId), "runs", id));
}

export async function ensureExperimentRoot(): Promise<void> {
  await Promise.all([
    mkdir(castingsRoot(), { recursive: true }),
    mkdir(profilesRoot(), { recursive: true }),
    mkdir(pairsRoot(), { recursive: true }),
    mkdir(runIndexRoot(), { recursive: true }),
  ]);
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(assertExperimentPath(file), "utf8")) as T;
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const target = assertExperimentPath(file);
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${randomUUID()}`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function createExclusive(file: string): Promise<() => Promise<void>> {
  const lock = assertExperimentPath(file);
  await mkdir(path.dirname(lock), { recursive: true });
  const handle = await open(lock, "wx");
  await handle.close();
  return async () => { await rm(lock, { force: true }); };
}

export async function clearExclusive(file: string): Promise<void> {
  await rm(assertExperimentPath(file), { force: true });
}

export async function saveCasting(record: CastingRecord): Promise<void> {
  await writeJsonAtomic(path.join(castingDir(record.id), "casting.json"), record);
}

export async function getCasting(id: string): Promise<CastingRecord> {
  return readJson<CastingRecord>(path.join(castingDir(id), "casting.json"));
}

/**
 * A successful image may be on disk even if a process stopped between image
 * write and JSON persistence. Recovery uses this to avoid charging for the
 * same candidate twice.
 */
export async function castingImageExists(id: string, name: string): Promise<boolean> {
  const safeName = path.basename(name);
  if (safeName !== name || !IMAGE_EXTENSIONS.has(path.extname(safeName).toLowerCase())) return false;
  try {
    const value = await stat(assertExperimentPath(path.join(castingDir(id), safeName)));
    return value.isFile() && value.size > 0;
  } catch {
    return false;
  }
}

export async function saveProfile(profile: ModelProfile): Promise<void> {
  await writeJsonAtomic(path.join(profileDir(profile.id), "profile.json"), profile);
}

export async function getProfile(id: string): Promise<ModelProfile> {
  return readJson<ModelProfile>(path.join(profileDir(id), "profile.json"));
}

export async function saveModelPair(pair: ModelPair): Promise<void> {
  await writeJsonAtomic(path.join(pairDir(pair.id), "pair.json"), pair);
}

export async function getModelPair(id: string): Promise<ModelPair> {
  return readJson<ModelPair>(path.join(pairDir(id), "pair.json"));
}

export async function copyCandidateToProfile(
  castingId: string,
  candidateName: string,
  profileId: string,
): Promise<void> {
  const safeName = path.basename(candidateName);
  if (safeName !== candidateName || !IMAGE_EXTENSIONS.has(path.extname(safeName).toLowerCase())) {
    throw new Error("候选图片名称无效");
  }
  const destination = profileDir(profileId);
  await mkdir(destination, { recursive: true });
  await cp(assertExperimentPath(path.join(castingDir(castingId), safeName)), path.join(destination, "anchor.jpg"));
}

export async function saveRun(record: ConsistencyRun): Promise<void> {
  const directory = record.id.startsWith("run_")
    ? await resolveOrCreateRunDir(record)
    : await runDir(record.id);
  await writeJsonAtomic(path.join(directory, "run.json"), record);
}

async function resolveOrCreateRunDir(record: ConsistencyRun): Promise<string> {
  requireId(record.id, RUN_ID, "运行");
  const indexPath = path.join(runIndexRoot(), `${record.id}.json`);
  try {
    return await runDir(record.id);
  } catch {
    const directory = assertExperimentPath(path.join(productDir(record.productId), "runs", record.id));
    await mkdir(directory, { recursive: true });
    await writeJsonAtomic(indexPath, { productId: record.productId });
    return directory;
  }
}

export async function getRun(id: string): Promise<ConsistencyRun> {
  return readJson<ConsistencyRun>(path.join(await runDir(id), "run.json"));
}

export async function saveReview(run: ConsistencyRun): Promise<void> {
  const reviews = Object.fromEntries(run.slots.map((slot) => [slot.id, slot.review]));
  await writeJsonAtomic(path.join(await runDir(run.id), "review.json"), reviews);
}

async function listJsonDirectories<T>(
  root: string,
  fileName: string,
  include: (item: T) => boolean,
): Promise<T[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const values = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    try {
      const value = await readJson<T>(path.join(root, entry.name, fileName));
      return include(value) ? value : null;
    } catch {
      return null;
    }
  }));
  return values.filter((value) => value !== null) as T[];
}

export async function listProfiles(workspaceId: string): Promise<ModelProfile[]> {
  const profiles = await listJsonDirectories<ModelProfile>(
    profilesRoot(),
    "profile.json",
    (profile) => profile.workspaceId === workspaceId,
  );
  return profiles.sort((first, second) => second.createdAt - first.createdAt);
}

export async function listModelPairs(workspaceId: string): Promise<ModelPair[]> {
  const pairs = await listJsonDirectories<ModelPair>(
    pairsRoot(),
    "pair.json",
    (pair) => pair.workspaceId === workspaceId,
  );
  return pairs.sort((first, second) => second.createdAt - first.createdAt);
}

/**
 * Castings are intentionally file-backed just like profiles.  Keeping this
 * list means a browser refresh can restore an unfinished or partially
 * completed selection instead of silently offering a fresh paid request.
 */
export async function listCastings(workspaceId: string): Promise<CastingRecord[]> {
  const castings = await listJsonDirectories<CastingRecord>(
    castingsRoot(),
    "casting.json",
    (casting) => casting.workspaceId === workspaceId,
  );
  return castings.sort((first, second) => second.createdAt - first.createdAt);
}

async function imageCount(directory: string): Promise<number> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .length;
  } catch {
    return 0;
  }
}

export async function listProducts(): Promise<ExperimentProduct[]> {
  await ensureExperimentRoot();
  const entries = await readdir(experimentRoot(), { withFileTypes: true });
  const products = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map(async (entry): Promise<ExperimentProduct> => {
      const directory = assertExperimentPath(path.join(experimentRoot(), entry.name));
      const masterDirectory = path.join(directory, "主图");
      const masterCount = await imageCount(masterDirectory);
      const masterImageNames = await masterImageNamesInDirectory(masterDirectory);
      return {
        id: productId(entry.name),
        name: entry.name,
        masterCount,
        masterImageNames,
        ready: masterCount > 0,
        issue: masterCount > 0 ? undefined : "缺少可直接使用的主图",
      };
    }));
  return products.sort((first, second) => first.name.localeCompare(second.name, "zh-CN"));
}

async function masterImageNamesInDirectory(directory: string): Promise<string[]> {
  try {
    return (await readdir(assertExperimentPath(directory), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => entry.name)
      .sort((first, second) => first.localeCompare(second, "zh-CN"));
  } catch {
    return [];
  }
}

export async function masterImages(id: string): Promise<string[]> {
  const directory = assertExperimentPath(path.join(productDir(id), "主图"));
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => assertExperimentPath(path.join(directory, entry.name)))
    .sort((first, second) => path.basename(first).localeCompare(path.basename(second), "zh-CN"));
  if (!files.length) throw new Error("测试商品缺少主图");
  return files;
}

/**
 * Resolve an explicit three-image reference set without trusting a client path.
 * The demo uses this instead of the production white-background classifier:
 * product-only hat photos can legitimately fill the frame edge-to-edge.
 */
export async function selectedMasterImages(id: string, names: readonly string[]): Promise<[string, string, string]> {
  if (names.length !== 3 || new Set(names).size !== 3) {
    throw new Error("请选择三张不同的同色商品参考图");
  }
  const masters = await masterImages(id);
  const byName = new Map(masters.map((file) => [path.basename(file), file]));
  const selected = names.map((name) => {
    if (path.basename(name) !== name || !IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase())) {
      throw new Error("商品参考图名称无效");
    }
    const file = byName.get(name);
    if (!file) throw new Error("所选商品参考图不属于当前测试货号");
    return file;
  });
  return selected as [string, string, string];
}

export async function experimentFile(
  kind: "casting" | "profile" | "run",
  id: string,
  name: string,
): Promise<string> {
  const safeName = path.basename(name);
  if (safeName !== name || !IMAGE_EXTENSIONS.has(path.extname(safeName).toLowerCase())) {
    throw new Error("实验图片名称无效");
  }
  const directory = kind === "casting"
    ? castingDir(id)
    : kind === "profile"
      ? profileDir(id)
      : await runDir(id);
  const file = assertExperimentPath(path.join(directory, safeName));
  await stat(file);
  return file;
}

export async function buildCatalog(
  workspaceId: string,
  workflows: ExperimentCatalog["workflows"],
): Promise<ExperimentCatalog> {
  const [products, profiles, modelPairs, castings] = await Promise.all([
    listProducts(),
    listProfiles(workspaceId),
    listModelPairs(workspaceId),
    listCastings(workspaceId),
  ]);
  return { products, profiles, modelPairs, castings, workflows };
}
