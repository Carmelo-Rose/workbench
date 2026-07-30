import path from "node:path";
import { z } from "zod";
import { listProductWorkflows, productTemplateRoot, installedWorkflowIds } from "@/lib/mono/product-pipeline";
import {
  buildCatalog,
  castingDir,
  castingImageExists,
  clearExclusive,
  copyCandidateToProfile,
  ensureExperimentRoot,
  getCasting,
  getModelPair,
  getProfile,
  getRun,
  selectedMasterImages,
  newCastingId,
  newPairId,
  newProfileId,
  newRunId,
  runDir,
  saveCasting,
  saveModelPair,
  saveProfile,
  saveReview,
  saveRun,
} from "./storage";
import {
  candidatePrompt,
  castingIsActive,
  configuredExperimentModel,
  runIsActive,
  scheduleCasting,
  scheduleRun,
} from "./runner";
import {
  experimentSlotIds,
  identityGroupIds,
  type CastingRecord,
  type ConsistencyRun,
  type ExperimentSlotId,
  type IdentityGroupId,
  type ModelPair,
  type ModelProfile,
} from "./types";

export const createCastingSchema = z.object({
  candidateCountPerGroup: z.literal(4).default(4),
});

/** A paid action is always explicit and scoped to concrete candidate ids. */
export const continueCastingSchema = z.object({
  candidateIds: z.array(z.string().regex(/^(female|male)-[1-4]$/u)).min(1).max(8),
});

export const createProfilesSchema = z.object({
  castingId: z.string().regex(/^casting_[0-9a-f-]{36}$/u),
  selections: z.object({
    female: z.string().min(1),
    male: z.string().min(1),
  }),
  names: z.object({
    female: z.string().trim().min(1).max(40).default("AI 女模特"),
    male: z.string().trim().min(1).max(40).default("AI 男模特"),
  }).default({ female: "AI 女模特", male: "AI 男模特" }),
});

export const createRunSchema = z.object({
  productId: z.string().min(1).max(1_000),
  workflowId: z.string().min(1).max(160),
  modelPairId: z.string().regex(/^pair_[0-9a-f-]{36}$/u),
  productReferenceNames: z.array(z.string().min(1).max(255)).length(3),
});

export const createModelPairSchema = z.object({
  displayName: z.string().trim().min(1).max(40),
  profileIds: z.object({
    female: z.string().regex(/^profile_[0-9a-f-]{36}$/u),
    male: z.string().regex(/^profile_[0-9a-f-]{36}$/u),
  }),
});

export const reviewRunSchema = z.object({
  slots: z.array(z.object({
    id: z.enum(experimentSlotIds),
    identity: z.enum(["pending", "passed", "failed"]),
    product: z.enum(["pending", "passed", "failed"]),
    note: z.string().trim().max(500).optional(),
  })).min(1).max(2),
});

export const retryRunSchema = z.object({
  slots: z.array(z.enum(experimentSlotIds)).min(1).max(2),
});

export async function catalog(workspaceId: string) {
  await ensureExperimentRoot();
  const result = await buildCatalog(workspaceId, await listProductWorkflows());
  // A process-local worker cannot survive a server restart. Reconcile those
  // records on read, but never restart them here: that must be explicit.
  result.castings = await Promise.all(
    result.castings.map((casting) => castingForWorkspace(workspaceId, casting.id)),
  );
  return result;
}

export async function createCasting(
  workspaceId: string,
  input: z.infer<typeof createCastingSchema>,
): Promise<CastingRecord> {
  await ensureExperimentRoot();
  const id = newCastingId();
  const now = Date.now();
  const model = configuredExperimentModel(workspaceId);
  const candidates = buildCastingCandidates(input.candidateCountPerGroup);
  const casting: CastingRecord = {
    id,
    workspaceId,
    // Creating a casting is free. A separate Continue action is the only
    // path that schedules paid image generation.
    status: "draft",
    provider: "mono-image",
    model,
    candidateCountPerGroup: input.candidateCountPerGroup,
    candidates,
    createdAt: now,
    updatedAt: now,
  };
  await saveCasting(casting);
  return casting;
}

export function buildCastingCandidates(candidateCountPerGroup: 4): CastingRecord["candidates"] {
  return identityGroupIds.flatMap((groupId) =>
    Array.from({ length: candidateCountPerGroup }, (_, index) => ({
      id: `${groupId}-${index + 1}`,
      groupId,
      index,
      imageName: `${groupId}-${index + 1}.jpg`,
      prompt: candidatePrompt(groupId, index),
      status: "queued" as const,
      attempts: 0,
    })));
}

export async function castingForWorkspace(workspaceId: string, id: string): Promise<CastingRecord> {
  const casting = await getCasting(id);
  assertWorkspace(casting.workspaceId, workspaceId);
  if ((casting.status === "queued" || casting.status === "running") && !castingIsActive(id)) {
    casting.status = "interrupted";
    casting.error = "服务重启或任务中断；不会自动重试付费请求";
    casting.updatedAt = Date.now();
    casting.completedAt = casting.updatedAt;
    for (const candidate of casting.candidates) {
      if (candidate.status !== "succeeded" && await castingImageExists(id, candidate.imageName)) {
        candidate.status = "succeeded";
        candidate.error = undefined;
        continue;
      }
      if (candidate.status === "generating") {
        candidate.status = "interrupted";
        candidate.error = "The service stopped before this candidate completed";
      }
    }
    await clearExclusive(path.join(castingDir(id), ".running"));
    await saveCasting(casting);
  }
  return casting;
}

/**
 * Continue only the candidate ids named by the user. Succeeded candidates are
 * deliberately ineligible, so a refresh/recovery can never regenerate them.
 */
export async function continueCasting(
  workspaceId: string,
  id: string,
  input: z.infer<typeof continueCastingSchema>,
): Promise<CastingRecord> {
  const casting = await castingForWorkspace(workspaceId, id);
  if (castingIsActive(id)) throw new Error("This casting is already generating");

  const requested = new Set(input.candidateIds);
  const selected = casting.candidates.filter((candidate) => requested.has(candidate.id));
  if (selected.length !== requested.size) throw new Error("One or more casting candidates do not exist");
  if (selected.some((candidate) => candidate.status === "succeeded")) {
    throw new Error("Succeeded candidates cannot be generated again");
  }

  for (const candidate of selected) {
    candidate.status = "queued";
    candidate.error = undefined;
  }
  casting.status = "queued";
  casting.error = undefined;
  casting.completedAt = undefined;
  casting.updatedAt = Date.now();
  await clearExclusive(path.join(castingDir(id), ".running"));
  await saveCasting(casting);
  scheduleCasting(id, selected.map((candidate) => candidate.id));
  return casting;
}

export async function createProfiles(
  workspaceId: string,
  input: z.infer<typeof createProfilesSchema>,
): Promise<ModelProfile[]> {
  const casting = await castingForWorkspace(workspaceId, input.castingId);
  // A partial/interrupted casting is still useful as soon as the user has
  // selected one successful woman and one successful man. Do not require a
  // further paid request merely to save reusable profile cards.
  const profiles = await Promise.all(identityGroupIds.map(async (groupId) => {
    const candidateId = input.selections[groupId];
    const candidate = casting.candidates.find((item) =>
      item.id === candidateId && item.groupId === groupId && item.status === "succeeded");
    if (!candidate) throw new Error(`${groupId === "female" ? "女" : "男"}模特候选无效`);
    const profile: ModelProfile = {
      id: newProfileId(),
      workspaceId,
      displayName: input.names[groupId],
      groupId,
      anchorImageName: "anchor.jpg",
      sourceCastingId: casting.id,
      sourceCandidateId: candidate.id,
      prompt: candidate.prompt,
      provider: casting.provider,
      model: casting.model,
      createdAt: Date.now(),
    };
    await copyCandidateToProfile(casting.id, candidate.imageName, profile.id);
    await saveProfile(profile);
    return profile;
  }));
  return profiles;
}

/** Saving a pair is free: it only names two existing anchor images. */
export async function createModelPair(
  workspaceId: string,
  input: z.infer<typeof createModelPairSchema>,
): Promise<ModelPair> {
  const [female, male] = await Promise.all([
    getProfile(input.profileIds.female),
    getProfile(input.profileIds.male),
  ]);
  assertProfile(female, workspaceId, "female");
  assertProfile(male, workspaceId, "male");
  const pair: ModelPair = {
    id: newPairId(),
    workspaceId,
    displayName: input.displayName,
    profileIds: input.profileIds,
    createdAt: Date.now(),
  };
  await saveModelPair(pair);
  return pair;
}

export async function modelPairForWorkspace(workspaceId: string, id: string): Promise<ModelPair> {
  const pair = await getModelPair(id);
  assertWorkspace(pair.workspaceId, workspaceId);
  return pair;
}

export async function createConsistencyRun(
  workspaceId: string,
  input: z.infer<typeof createRunSchema>,
): Promise<ConsistencyRun> {
  if (!installedWorkflowIds().has(input.workflowId)) throw new Error("商品套图模板不存在");
  const productReferenceNames = input.productReferenceNames as [string, string, string];
  await selectedMasterImages(input.productId, productReferenceNames);
  const modelPair = await modelPairForWorkspace(workspaceId, input.modelPairId);
  const [female, male] = await Promise.all([
    getProfile(modelPair.profileIds.female),
    getProfile(modelPair.profileIds.male),
  ]);
  assertProfile(female, workspaceId, "female");
  assertProfile(male, workspaceId, "male");
  // Loading validates the selected bundle before a paid run can be queued.
  await import("@/lib/mono/product-template").then(({ loadProductTemplate }) =>
    loadProductTemplate(productTemplateRoot(input.workflowId)));
  const now = Date.now();
  const run: ConsistencyRun = {
    id: newRunId(),
    workspaceId,
    productId: input.productId,
    productName: Buffer.from(input.productId, "base64url").toString("utf8"),
    workflowId: input.workflowId,
    modelPairId: modelPair.id,
    profileIds: modelPair.profileIds,
    productReferenceNames,
    status: "queued",
    stage: "queued",
    provider: "mono-image",
    model: configuredExperimentModel(workspaceId),
    slots: experimentSlotIds.map((id) => {
      const lookId = demoLookForSlot(id);
      return ({
      id,
      identityGroupId: lookId === "B" ? "male" : "female",
      lookId,
      colorRank: 0,
      status: "queued",
      attempts: 0,
      imageName: `${id}.jpg`,
      review: { identity: "pending", product: "pending" },
      });
    }),
    createdAt: now,
    updatedAt: now,
  };
  await saveRun(run);
  scheduleRun(run.id);
  return run;
}

function demoLookForSlot(slotId: ExperimentSlotId): "A" | "B" | "C" {
  if (slotId === "01") return "A";
  if (slotId === "04") return "B";
  return "C";
}

export async function runForWorkspace(workspaceId: string, id: string): Promise<ConsistencyRun> {
  const run = await getRun(id);
  assertWorkspace(run.workspaceId, workspaceId);
  if ((run.status === "queued" || run.status === "running") && !runIsActive(id)) {
    run.status = "interrupted";
    run.stage = "interrupted";
    run.error = "服务重启或任务中断；不会自动重试付费请求";
    run.updatedAt = Date.now();
    run.completedAt = run.updatedAt;
    for (const slot of run.slots) {
      if (slot.status === "queued" || slot.status === "generating") {
        slot.status = "failed";
        slot.error = "Service restarted before this slot completed";
      }
    }
    await clearExclusive(path.join(await runDir(id), ".running"));
    await saveRun(run);
  }
  return run;
}

export async function profileForWorkspace(workspaceId: string, id: string): Promise<ModelProfile> {
  const profile = await getProfile(id);
  assertWorkspace(profile.workspaceId, workspaceId);
  return profile;
}

export async function reviewRun(
  workspaceId: string,
  id: string,
  input: z.infer<typeof reviewRunSchema>,
): Promise<ConsistencyRun> {
  const run = await runForWorkspace(workspaceId, id);
  if (runIsActive(id)) throw new Error("生成进行中，暂不能审核");
  const now = Date.now();
  for (const review of input.slots) {
    const slot = run.slots.find((item) => item.id === review.id);
    if (!slot || slot.status !== "succeeded") throw new Error(`槽位 ${review.id} 尚无可审核图片`);
    slot.review = { identity: review.identity, product: review.product, note: review.note, updatedAt: now };
  }
  const allPassed = run.slots.every((slot) =>
    slot.status === "succeeded"
    && slot.review.identity === "passed"
    && slot.review.product === "passed");
  run.stage = allPassed ? "completed" : "review";
  run.status = allPassed ? "succeeded" : run.slots.some((slot) => slot.status === "failed") ? "partial" : "succeeded";
  run.updatedAt = now;
  await Promise.all([saveRun(run), saveReview(run)]);
  return run;
}

export async function retryRun(
  workspaceId: string,
  id: string,
  input: z.infer<typeof retryRunSchema>,
): Promise<ConsistencyRun> {
  const run = await runForWorkspace(workspaceId, id);
  if (runIsActive(id) || run.status === "queued" || run.status === "running") {
    throw new Error("该实验运行已经在生成");
  }
  const requested = [...new Set(input.slots)] as ExperimentSlotId[];
  for (const slotId of requested) {
    const slot = run.slots.find((item) => item.id === slotId);
    if (!slot) throw new Error(`槽位 ${slotId} 不存在`);
    const rejected = slot.review.identity === "failed" || slot.review.product === "failed";
    if (slot.status !== "failed" && !rejected) throw new Error(`槽位 ${slotId} 未失败或未被拒绝，不允许付费重跑`);
    slot.status = "queued";
    slot.error = undefined;
    slot.review = { identity: "pending", product: "pending" };
  }
  run.status = "queued";
  run.stage = "queued";
  run.error = undefined;
  run.updatedAt = Date.now();
  await saveRun(run);
  scheduleRun(run.id, requested);
  return run;
}

function assertWorkspace(actual: string, expected: string): void {
  if (actual !== expected) throw new Error("实验记录不存在或当前工作区无权访问");
}

function assertProfile(
  profile: ModelProfile,
  workspaceId: string,
  groupId: IdentityGroupId,
): void {
  assertWorkspace(profile.workspaceId, workspaceId);
  if (profile.groupId !== groupId) throw new Error(`所选模特卡不是 ${groupId} 身份组`);
}

export { castingDir };
