import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { getConfigValue } from "@/lib/server/api-config";
import { classifyProductSources } from "@/lib/mono/product-classify";
import {
  MODEL_SLOTS,
  modelSlotColorRanks,
  productTemplateRoot,
  runModelGenerationPhase,
  type DetailSlot,
} from "@/lib/mono/product-pipeline";
import { loadProductTemplate } from "@/lib/mono/product-template";
import { generateExperimentImage } from "./provider";
import { buildConsistencyPrompt, castingPrompt, identityGroupForLook } from "./prompts";
import {
  castingDir,
  createExclusive,
  getCasting,
  getProfile,
  getRun,
  masterImages,
  profileDir,
  runDir,
  saveCasting,
  saveRun,
} from "./storage";
import type {
  CastingCandidate,
  CastingRecord,
  ConsistencyRun,
  ExperimentSlotId,
  IdentityGroupId,
} from "./types";

const activeCastings = new Set<string>();
const activeRuns = new Set<string>();
const CANDIDATE_CONCURRENCY = 2;
const SLOT_CONCURRENCY = 2;
const MAX_ATTEMPTS = 3;

export function castingIsActive(id: string): boolean {
  return activeCastings.has(id);
}

export function runIsActive(id: string): boolean {
  return activeRuns.has(id);
}

export function scheduleCasting(id: string, onlyCandidateIds?: readonly string[]): void {
  if (activeCastings.has(id)) return;
  activeCastings.add(id);
  queueMicrotask(() => {
    void executeCasting(id, onlyCandidateIds).finally(() => activeCastings.delete(id));
  });
}

export function scheduleRun(id: string, onlySlots?: readonly ExperimentSlotId[]): void {
  if (activeRuns.has(id)) return;
  activeRuns.add(id);
  queueMicrotask(() => {
    void executeRun(id, onlySlots).finally(() => activeRuns.delete(id));
  });
}

async function executeCasting(id: string, onlyCandidateIds?: readonly string[]): Promise<void> {
  let release: (() => Promise<void>) | undefined;
  let casting: CastingRecord | undefined;
  try {
    release = await createExclusive(path.join(castingDir(id), ".running"));
    const record = await getCasting(id);
    casting = record;
    record.status = "running";
    record.startedAt ??= Date.now();
    record.updatedAt = Date.now();
    // Workers can finish out of order. Serialize all JSON writes against the
    // same in-memory record so a stale candidate update cannot overwrite a
    // later successful candidate state.
    let saveChain: Promise<void> = Promise.resolve();
    const persist = () => {
      saveChain = saveChain.catch(() => undefined).then(() => saveCasting(record));
      return saveChain;
    };
    await persist();

    const selected = new Set(onlyCandidateIds ?? record.candidates
      .filter((candidate) => candidate.status === "queued")
      .map((candidate) => candidate.id));
    const candidates = record.candidates.filter((candidate) =>
      selected.has(candidate.id) && candidate.status !== "succeeded");
    if (!candidates.length) throw new Error("No unfinished casting candidates were selected");

    await runPool(candidates, CANDIDATE_CONCURRENCY, async (candidate) => {
      candidate.status = "generating";
      candidate.error = undefined;
      record.updatedAt = Date.now();
      await persist();
      await generateCandidate(record, candidate);
      record.updatedAt = Date.now();
      await persist();
    });
    await saveChain;
    const unfinished = record.candidates.filter((candidate) =>
      candidate.status === "queued" || candidate.status === "generating" || candidate.status === "interrupted");
    const failures = record.candidates.filter((candidate) => candidate.status === "failed");
    record.status = unfinished.length > 0
      ? "partial"
      : failures.length === 0
        ? "succeeded"
        : failures.length === record.candidates.length
          ? "failed"
          : "partial";
    record.completedAt = Date.now();
    record.updatedAt = record.completedAt;
    await persist();
  } catch (error) {
    try {
      const current = casting ?? await getCasting(id);
      for (const candidate of current.candidates) {
        if (candidate.status === "generating") {
          candidate.status = "interrupted";
          candidate.error = "The worker stopped before this candidate completed";
        }
      }
      current.status = "interrupted";
      current.error = error instanceof Error ? error.message : String(error);
      current.completedAt = Date.now();
      current.updatedAt = current.completedAt;
      await saveCasting(current);
    } catch { /* nothing else can be persisted */ }
  } finally {
    await release?.();
  }
}

async function generateCandidate(casting: CastingRecord, candidate: CastingCandidate): Promise<void> {
  let lastError = "选角图片生成失败";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    candidate.attempts = attempt;
    try {
      const bytes = await generateExperimentImage({
        workspaceId: casting.workspaceId,
        prompt: candidate.prompt,
        references: [],
        aspectRatio: "3:4",
        model: casting.model,
      });
      await sharp(bytes).resize(768, 1024, { fit: "cover" }).jpeg({ quality: 95 }).toFile(
        path.join(castingDir(casting.id), candidate.imageName),
      );
      candidate.status = "succeeded";
      candidate.error = undefined;
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  candidate.status = "failed";
  candidate.error = lastError;
}

async function executeRun(id: string, onlySlots?: readonly ExperimentSlotId[]): Promise<void> {
  let release: (() => Promise<void>) | undefined;
  try {
    const directory = await runDir(id);
    release = await createExclusive(path.join(directory, ".running"));
    const run = await getRun(id);
    run.status = "running";
    run.stage = "classifying";
    run.startedAt ??= Date.now();
    run.updatedAt = Date.now();
    await saveRun(run);

    const [template, masters, female, male] = await Promise.all([
      loadProductTemplate(productTemplateRoot(run.workflowId)),
      masterImages(run.productId),
      getProfile(run.profileIds.female),
      getProfile(run.profileIds.male),
    ]);
    if (female.workspaceId !== run.workspaceId || male.workspaceId !== run.workspaceId) {
      throw new Error("模特卡不属于当前工作区");
    }
    const classification = await classifyProductSources(masters);
    if (!classification.colors.length) throw new Error("主图未识别出有效商品颜色");
    const colorRanks = modelSlotColorRanks(classification.colors.length);
    run.stage = "generating";

    const selected = new Set(onlySlots ?? run.slots.map((slot) => slot.id));
    const slots = MODEL_SLOTS.filter((slot) => selected.has(slot[0] as ExperimentSlotId));
    await runModelGenerationPhase(
      slots,
      SLOT_CONCURRENCY,
      new AbortController().signal,
      async (slot) => {
        const record = run.slots.find((item) => item.id === slot[0]);
        if (!record) throw new Error(`实验运行缺少槽位 ${slot[0]}`);
        record.status = "generating";
        record.error = undefined;
        record.review = { identity: "pending", product: "pending" };
        run.updatedAt = Date.now();
        await saveRun(run);
        try {
          await generateSlot(run, slot, template, classification, colorRanks, female.id, male.id);
          record.status = "succeeded";
          record.error = undefined;
          return { slot: slot[0], attempts: record.attempts };
        } catch (error) {
          record.status = "failed";
          record.error = error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          run.updatedAt = Date.now();
          await saveRun(run);
        }
      },
    );
    const failures = run.slots.filter((slot) => slot.status === "failed");
    run.status = failures.length ? "partial" : "succeeded";
    run.stage = "review";
    run.completedAt = Date.now();
    run.updatedAt = run.completedAt;
    await saveRun(run);
  } catch (error) {
    try {
      const run = await getRun(id);
      run.status = "failed";
      run.error = error instanceof Error ? error.message : String(error);
      run.completedAt = Date.now();
      run.updatedAt = run.completedAt;
      await saveRun(run);
    } catch { /* nothing else can be persisted */ }
  } finally {
    await release?.();
  }
}

async function generateSlot(
  run: ConsistencyRun,
  slot: DetailSlot,
  template: Awaited<ReturnType<typeof loadProductTemplate>>,
  classification: Awaited<ReturnType<typeof classifyProductSources>>,
  colorRanks: Map<string, number>,
  femaleProfileId: string,
  maleProfileId: string,
): Promise<void> {
  const record = run.slots.find((item) => item.id === slot[0]);
  if (!record) throw new Error(`实验运行缺少槽位 ${slot[0]}`);
  const colorRank = colorRanks.get(slot[0]) ?? 0;
  const color = classification.colors[colorRank] ?? classification.colors[0];
  const look = template.looks[colorRank % template.looks.length];
  const groupId = identityGroupForLook(look.id);
  const profileId = groupId === "female" ? femaleProfileId : maleProfileId;
  const productReferences = color.members.slice(0, 3).map((member) => member.path);
  while (productReferences.length < 3) productReferences.push(productReferences[productReferences.length - 1]);
  const references = buildSlotReferences(
    path.join(profileDir(profileId), "anchor.jpg"),
    productReferences,
  );
  let lastError = "槽位生成失败";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    record.attempts = attempt;
    try {
      const bytes = await generateExperimentImage({
        workspaceId: run.workspaceId,
        prompt: buildConsistencyPrompt({ template, slot, colorRank, identityGroupId: groupId }),
        references,
        aspectRatio: `${slot[1]}:${slot[2]}`,
        model: run.model,
      });
      await sharp(bytes).resize(slot[1], slot[2], { fit: "cover" }).jpeg({ quality: 95 }).toFile(
        path.join(await runDir(run.id), record.imageName),
      );
      record.identityGroupId = groupId;
      record.lookId = look.id;
      record.colorRank = colorRank;
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastError);
}

async function runPool<T>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const consume = async () => {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      await worker(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, consume));
}

export function configuredExperimentModel(workspaceId: string): string {
  return getConfigValue("MONO_IMAGE_MODEL", workspaceId) ?? "gpt-image-2";
}

export function buildSlotReferences(anchor: string, productReferences: string[]): string[] {
  if (productReferences.length !== 3) {
    throw new Error("Model consistency slots require exactly three product references");
  }
  return [anchor, ...productReferences];
}

export function candidatePrompt(groupId: IdentityGroupId, index: number): string {
  return castingPrompt(groupId, index);
}

export async function copyProfileAnchor(profileId: string, output: string): Promise<void> {
  await mkdir(path.dirname(output), { recursive: true });
  await cp(path.join(profileDir(profileId), "anchor.jpg"), output);
}
