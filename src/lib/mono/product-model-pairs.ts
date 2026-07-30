import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDb } from "@/lib/server/db";
import { readObjectBuffer, saveObjectBuffer, statObject } from "@/lib/storage";
import { createMonoAsset, createMonoSubject, getMonoSubject } from "./store";
import type { MonoActor } from "./contracts";
import { MonoHttpError } from "./http";

export type ProductModelIdentityGroup = "female" | "male";

export type ProductModelProfileOption = {
  id: string;
  displayName: string;
  groupId: ProductModelIdentityGroup;
  sourceCandidateId: string;
  faceAssetId: string;
  bodyAssetId?: string;
  facePreviewUrl: string;
  bodyPreviewUrl?: string;
  /** @deprecated Use faceAssetId. */
  anchorAssetId: string;
  needsFaceRecrop: boolean;
  subjectId: string;
};

export type ProductModelPairOption = {
  id: string;
  displayName: string;
  female: ProductModelProfileOption;
  male: ProductModelProfileOption;
};

export type ResolvedProductModelPair = {
  id: string;
  displayName: string;
  profiles: Record<ProductModelIdentityGroup, ProductModelProfileOption & {
    faceBytes: Buffer;
    bodyBytes?: Buffer;
    /** @deprecated Use faceBytes. */
    anchorBytes: Buffer;
  }>;
};

export const createProductModelCardSchema = z.object({
  displayName: z.string().trim().min(1).max(40),
  groupId: z.enum(["female", "male"]),
  faceAssetId: z.string().regex(/^asset_[0-9a-f-]{36}$/u).optional(),
  /** Legacy create payload. */
  assetId: z.string().regex(/^asset_[0-9a-f-]{36}$/u).optional(),
  bodyAssetId: z.string().regex(/^asset_[0-9a-f-]{36}$/u).nullable().optional(),
  visibility: z.enum(["private", "workspace"]).default("workspace"),
}).refine((input) => Boolean(input.faceAssetId || input.assetId), {
  message: "请提供脸部参考图",
});

export const createProductModelPairFromSubjectsSchema = z.object({
  displayName: z.string().trim().min(1).max(40),
  femaleSubjectId: z.string().regex(/^subject_[0-9a-f-]{36}$/u),
  maleSubjectId: z.string().regex(/^subject_[0-9a-f-]{36}$/u),
});

export const updateProductModelCardSchema = z.object({
  displayName: z.string().trim().min(1).max(40).optional(),
  groupId: z.enum(["female", "male"]).optional(),
  faceAssetId: z.string().regex(/^asset_[0-9a-f-]{36}$/u).optional(),
  bodyAssetId: z.string().regex(/^asset_[0-9a-f-]{36}$/u).nullable().optional(),
}).refine((input) => Object.keys(input).length > 0, {
  message: "至少提供一个需要修改的字段",
});

export const updateProductModelPairSchema = createProductModelPairFromSubjectsSchema.partial().refine(
  (input) => Object.keys(input).length > 0,
  { message: "至少提供一个需要修改的字段" },
);

type ProfileRow = {
  id: string;
  workspace_id: string;
  display_name: string;
  group_id: ProductModelIdentityGroup;
  anchor_asset_id: string;
  body_asset_id: string | null;
  subject_id: string | null;
  source_candidate_id: string | null;
};

type PairRow = {
  id: string;
  workspace_id: string;
  display_name: string;
  female_profile_id: string;
  male_profile_id: string;
  female_subject_id: string | null;
  male_subject_id: string | null;
};

type AssetStorageRow = { storage_key: string | null };

function profileOption(profile: ProfileRow): ProductModelProfileOption {
  return {
    id: profile.id,
    displayName: profile.display_name,
    groupId: profile.group_id,
    sourceCandidateId: profile.source_candidate_id ?? "",
    faceAssetId: profile.anchor_asset_id,
    bodyAssetId: profile.body_asset_id ?? undefined,
    facePreviewUrl: `/api/workbench/mono/assets/${encodeURIComponent(profile.anchor_asset_id)}/content`,
    bodyPreviewUrl: profile.body_asset_id
      ? `/api/workbench/mono/assets/${encodeURIComponent(profile.body_asset_id)}/content`
      : undefined,
    anchorAssetId: profile.anchor_asset_id,
    needsFaceRecrop: Boolean(profile.source_candidate_id),
    subjectId: profile.subject_id ?? "",
  };
}

function profileForWorkspace(
  workspaceId: string,
  profileId: string,
): ProfileRow | null {
  return getDb().prepare(
    `SELECT id, workspace_id, display_name, group_id, anchor_asset_id, body_asset_id, subject_id, source_candidate_id
     FROM mono_product_model_profiles WHERE id = ? AND workspace_id = ?`,
  ).get(profileId, workspaceId) as ProfileRow | undefined ?? null;
}

function profileForSubject(
  workspaceId: string,
  subjectId: string,
): ProfileRow | null {
  return getDb().prepare(
    `SELECT id, workspace_id, display_name, group_id, anchor_asset_id, body_asset_id, subject_id, source_candidate_id
     FROM mono_product_model_profiles WHERE subject_id = ? AND workspace_id = ?`,
  ).get(subjectId, workspaceId) as ProfileRow | undefined ?? null;
}

function pairForWorkspace(workspaceId: string, pairId: string): PairRow | null {
  return getDb().prepare(
    `SELECT id, workspace_id, display_name, female_profile_id, male_profile_id, female_subject_id, male_subject_id
     FROM mono_product_model_pairs WHERE id = ? AND workspace_id = ?`,
  ).get(pairId, workspaceId) as PairRow | undefined ?? null;
}

function assertProfileGroup(
  profile: ProfileRow | null,
  groupId: ProductModelIdentityGroup,
): asserts profile is ProfileRow {
  if (!profile || profile.group_id !== groupId) {
    throw new Error(`模特组合中的${groupId === "female" ? "女" : "男"}模特资料无效`);
  }
}

/** Lists the formal, reusable model library. No experiment folder is read. */
export function listProductModelPairs(workspaceId: string): ProductModelPairOption[] {
  const pairs = getDb().prepare(
    `SELECT id, workspace_id, display_name, female_profile_id, male_profile_id, female_subject_id, male_subject_id
     FROM mono_product_model_pairs WHERE workspace_id = ? ORDER BY created_at DESC`,
  ).all(workspaceId) as PairRow[];
  return pairs.flatMap((pair) => {
    const female = pair.female_subject_id
      ? profileForSubject(workspaceId, pair.female_subject_id)
      : profileForWorkspace(workspaceId, pair.female_profile_id);
    const male = pair.male_subject_id
      ? profileForSubject(workspaceId, pair.male_subject_id)
      : profileForWorkspace(workspaceId, pair.male_profile_id);
    if (!female || !male || female.group_id !== "female" || male.group_id !== "male") return [];
    return [{
      id: pair.id,
      displayName: pair.display_name,
      female: profileOption(female),
      male: profileOption(male),
    }];
  });
}

/** The model-card subset of the subject library, newest first. */
export function listProductModelCards(workspaceId: string): ProductModelProfileOption[] {
  const rows = getDb().prepare(
    `SELECT id, workspace_id, display_name, group_id, anchor_asset_id, body_asset_id, subject_id, source_candidate_id
     FROM mono_product_model_profiles WHERE workspace_id = ? ORDER BY created_at DESC`,
  ).all(workspaceId) as ProfileRow[];
  return rows.filter((profile) => Boolean(profile.subject_id)).map(profileOption);
}

/**
 * Resolves the two anchors from the Workbench asset store.  The worker reads
 * bytes directly, so it never needs a Z: path and no anchor is exposed as a
 * filesystem path in a job or API response.
 */
export async function resolveProductModelPair(
  workspaceId: string,
  pairId: string,
): Promise<ResolvedProductModelPair> {
  const pair = pairForWorkspace(workspaceId, pairId);
  if (!pair) throw new Error("模特组合不存在，或不属于当前工作区");
  const female = pair.female_subject_id
    ? profileForSubject(workspaceId, pair.female_subject_id)
    : profileForWorkspace(workspaceId, pair.female_profile_id);
  const male = pair.male_subject_id
    ? profileForSubject(workspaceId, pair.male_subject_id)
    : profileForWorkspace(workspaceId, pair.male_profile_id);
  assertProfileGroup(female, "female");
  assertProfileGroup(male, "male");

  const profiles = await Promise.all(([female, male] as const).map(async (profile) => {
    if (!profile.subject_id) throw new Error("模特卡尚未迁入主体库");
    const faceAsset = getDb().prepare(
      "SELECT storage_key FROM mono_assets WHERE id = ? AND workspace_id = ?",
    ).get(profile.anchor_asset_id, workspaceId) as AssetStorageRow | undefined;
    if (!faceAsset?.storage_key || !(await statObject(faceAsset.storage_key))) {
      throw new Error("模特组合的参考图不存在或已被清理");
    }
    const bodyAsset = profile.body_asset_id
      ? getDb().prepare(
          "SELECT storage_key FROM mono_assets WHERE id = ? AND workspace_id = ?",
        ).get(profile.body_asset_id, workspaceId) as AssetStorageRow | undefined
      : undefined;
    if (profile.body_asset_id && (!bodyAsset?.storage_key || !(await statObject(bodyAsset.storage_key)))) {
      throw new Error("模特组合的全身参考图不存在或已被清理");
    }
    const faceBytes = await readObjectBuffer(faceAsset.storage_key);
    return [profile.group_id, {
      ...profileOption(profile),
      faceBytes,
      bodyBytes: bodyAsset?.storage_key ? await readObjectBuffer(bodyAsset.storage_key) : undefined,
      anchorBytes: faceBytes,
    }] as const;
  }));

  return {
    id: pair.id,
    displayName: pair.display_name,
    profiles: Object.fromEntries(profiles) as ResolvedProductModelPair["profiles"],
  };
}

export type RegisterProductModelProfileInput = {
  id?: string;
  displayName: string;
  groupId: ProductModelIdentityGroup;
  anchor: Buffer;
  sourceCandidateId?: string;
  prompt?: string;
  provider?: string;
  model?: string;
  createdAt?: number;
};

/** Formal persistence primitive used by the one-time legacy importer. */
export async function registerProductModelProfile(
  actor: MonoActor,
  input: RegisterProductModelProfileInput,
): Promise<ProductModelProfileOption> {
  const id = input.id ?? `profile_${randomUUID()}`;
  const existing = profileForWorkspace(actor.workspaceId, id);
  if (existing) return profileOption(existing);
  const now = input.createdAt ?? Date.now();
  const stored = await saveObjectBuffer(input.anchor, "model-anchor.jpg");
  const asset = createMonoAsset(actor, {
    sourceUrl: `storage:${stored.key}`,
    storageKey: stored.key,
    location: "local-storage",
    mimeType: "image/jpeg",
    name: `${input.displayName} 模特锚点`,
  });
  const subject = createMonoSubject(actor, {
    name: input.displayName,
    assetId: asset.id,
    kind: "product-model",
    visibility: "workspace",
  });
  if (!subject) throw new Error("模特锚点素材无法写入主体库");
  try {
    getDb().prepare(
      `INSERT INTO mono_product_model_profiles
       (id, workspace_id, display_name, group_id, anchor_asset_id, subject_id, source_candidate_id,
        prompt, provider, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, actor.workspaceId, input.displayName, input.groupId, asset.id, subject.id,
      input.sourceCandidateId ?? null, input.prompt ?? null, input.provider ?? null,
      input.model ?? null, now, now,
    );
  } catch (error) {
    // The database row is the source of truth. An interrupted import can leave
    // an unreferenced object, but never a pair that points at the wrong image.
    throw error;
  }
  return {
    id,
    displayName: input.displayName,
    groupId: input.groupId,
    sourceCandidateId: input.sourceCandidateId ?? "",
    faceAssetId: asset.id,
    anchorAssetId: asset.id,
    facePreviewUrl: `/api/workbench/mono/assets/${encodeURIComponent(asset.id)}/content`,
    needsFaceRecrop: Boolean(input.sourceCandidateId),
    subjectId: subject.id,
  };
}

function durableImageAsset(
  workspaceId: string,
  assetId: string,
  label: string,
): { id: string; storage_key: string; mime_type: string } {
  const asset = getDb().prepare(
    "SELECT id, storage_key, mime_type FROM mono_assets WHERE id = ? AND workspace_id = ?",
  ).get(assetId, workspaceId) as {
    id: string;
    storage_key: string | null;
    mime_type: string | null;
  } | undefined;
  if (!asset) throw new MonoHttpError(400, `${label}不存在，或不属于当前工作区`);
  if (!asset.storage_key) throw new MonoHttpError(400, `${label}必须先通过上传存储，不能使用临时 URL`);
  if (!asset.mime_type?.startsWith("image/")) throw new MonoHttpError(400, `${label}必须是图片文件`);
  return { id: asset.id, storage_key: asset.storage_key, mime_type: asset.mime_type };
}

/**
 * Creates a model card directly from a pre-uploaded subject-library asset.
 * It is intentionally UI-agnostic: the future library screen can use it after
 * an upload, while imports can continue to use registerProductModelProfile.
 */
export function createProductModelCard(
  actor: MonoActor,
  input: z.input<typeof createProductModelCardSchema>,
): ProductModelProfileOption {
  const faceAssetId = input.faceAssetId ?? input.assetId!;
  durableImageAsset(actor.workspaceId, faceAssetId, "脸部参考图");
  if (input.bodyAssetId) durableImageAsset(actor.workspaceId, input.bodyAssetId, "全身参考图");

  const subject = createMonoSubject(actor, {
    name: input.displayName,
    assetId: faceAssetId,
    kind: "product-model",
    visibility: input.visibility ?? "workspace",
  });
  if (!subject) throw new Error("模特锚点素材无法写入主体库");
  const now = Date.now();
  const profile: ProfileRow = {
    id: `profile_${randomUUID()}`,
    workspace_id: actor.workspaceId,
    display_name: input.displayName,
    group_id: input.groupId,
    anchor_asset_id: faceAssetId,
    body_asset_id: input.bodyAssetId ?? null,
    subject_id: subject.id,
    source_candidate_id: null,
  };
  getDb().prepare(
    `INSERT INTO mono_product_model_profiles
     (id, workspace_id, display_name, group_id, anchor_asset_id, body_asset_id, subject_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    profile.id,
    profile.workspace_id,
    profile.display_name,
    profile.group_id,
    profile.anchor_asset_id,
    profile.body_asset_id,
    profile.subject_id,
    now,
    now,
  );
  return profileOption(profile);
}

export type RegisterProductModelPairInput = {
  id?: string;
  displayName: string;
  femaleProfileId: string;
  maleProfileId: string;
  createdAt?: number;
};

export function registerProductModelPair(
  workspaceId: string,
  input: RegisterProductModelPairInput,
): ProductModelPairOption {
  const id = input.id ?? `pair_${randomUUID()}`;
  const existing = pairForWorkspace(workspaceId, id);
  if (existing) {
    const [female, male] = [
      existing.female_subject_id
        ? profileForSubject(workspaceId, existing.female_subject_id)
        : profileForWorkspace(workspaceId, existing.female_profile_id),
      existing.male_subject_id
        ? profileForSubject(workspaceId, existing.male_subject_id)
        : profileForWorkspace(workspaceId, existing.male_profile_id),
    ];
    assertProfileGroup(female, "female");
    assertProfileGroup(male, "male");
    return { id: existing.id, displayName: existing.display_name, female: profileOption(female), male: profileOption(male) };
  }
  const female = profileForWorkspace(workspaceId, input.femaleProfileId);
  const male = profileForWorkspace(workspaceId, input.maleProfileId);
  assertProfileGroup(female, "female");
  assertProfileGroup(male, "male");
  if (!female.subject_id || !male.subject_id) {
    throw new Error("模特卡尚未迁入主体库");
  }
  const now = input.createdAt ?? Date.now();
  getDb().prepare(
    `INSERT INTO mono_product_model_pairs
     (id, workspace_id, display_name, female_profile_id, male_profile_id, female_subject_id, male_subject_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, workspaceId, input.displayName, female.id, male.id, female.subject_id, male.subject_id, now, now);
  return { id, displayName: input.displayName, female: profileOption(female), male: profileOption(male) };
}

/** Creates a product-set pair from two existing model subjects. */
export function createProductModelPairFromSubjects(
  actor: MonoActor,
  input: z.infer<typeof createProductModelPairFromSubjectsSchema>,
): ProductModelPairOption {
  if (!getMonoSubject(actor, input.femaleSubjectId) || !getMonoSubject(actor, input.maleSubjectId)) {
    throw new Error("所选模特主体不存在，或当前用户无权使用");
  }
  const female = profileForSubject(actor.workspaceId, input.femaleSubjectId);
  const male = profileForSubject(actor.workspaceId, input.maleSubjectId);
  assertProfileGroup(female, "female");
  assertProfileGroup(male, "male");
  return registerProductModelPair(actor.workspaceId, {
    displayName: input.displayName,
    femaleProfileId: female.id,
    maleProfileId: male.id,
  });
}

function ownedProfile(actor: MonoActor, profileId: string): ProfileRow {
  const profile = profileForWorkspace(actor.workspaceId, profileId);
  if (!profile?.subject_id) throw new MonoHttpError(404, "模特卡不存在");
  const owned = getDb().prepare(
    "SELECT 1 FROM mono_subjects WHERE id = ? AND workspace_id = ? AND owner_user_id = ?",
  ).get(profile.subject_id, actor.workspaceId, actor.userId);
  if (!owned) throw new MonoHttpError(403, "只有模特卡创建者可以修改");
  return profile;
}

export function updateProductModelCard(
  actor: MonoActor,
  profileId: string,
  patch: z.infer<typeof updateProductModelCardSchema>,
): ProductModelProfileOption {
  const current = ownedProfile(actor, profileId);
  if (patch.faceAssetId) durableImageAsset(actor.workspaceId, patch.faceAssetId, "脸部参考图");
  if (patch.bodyAssetId) durableImageAsset(actor.workspaceId, patch.bodyAssetId, "全身参考图");

  if (patch.groupId && patch.groupId !== current.group_id) {
    const used = getDb().prepare(
      `SELECT display_name FROM mono_product_model_pairs
       WHERE workspace_id = ? AND (
         female_profile_id = ? OR male_profile_id = ? OR
         female_subject_id = ? OR male_subject_id = ?
       ) LIMIT 1`,
    ).get(
      actor.workspaceId,
      current.id,
      current.id,
      current.subject_id,
      current.subject_id,
    ) as { display_name: string } | undefined;
    if (used) throw new MonoHttpError(409, `该模特正在组合“${used.display_name}”中使用，请先调整组合`);
  }

  const displayName = patch.displayName ?? current.display_name;
  const groupId = patch.groupId ?? current.group_id;
  const faceAssetId = patch.faceAssetId ?? current.anchor_asset_id;
  const bodyAssetId = patch.bodyAssetId === undefined ? current.body_asset_id : patch.bodyAssetId;
  const now = Date.now();
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `UPDATE mono_product_model_profiles
       SET display_name = ?, group_id = ?, anchor_asset_id = ?, body_asset_id = ?,
           source_candidate_id = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    ).run(
      displayName,
      groupId,
      faceAssetId,
      bodyAssetId,
      patch.faceAssetId ? null : current.source_candidate_id,
      now,
      current.id,
      actor.workspaceId,
    );
    db.prepare(
      `UPDATE mono_subjects SET name = ?, asset_id = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND owner_user_id = ?`,
    ).run(displayName, faceAssetId, now, current.subject_id, actor.workspaceId, actor.userId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return profileOption(profileForWorkspace(actor.workspaceId, profileId)!);
}

export function deleteProductModelCard(actor: MonoActor, profileId: string): void {
  const current = ownedProfile(actor, profileId);
  const used = getDb().prepare(
    `SELECT display_name FROM mono_product_model_pairs
     WHERE workspace_id = ? AND (
       female_profile_id = ? OR male_profile_id = ? OR
       female_subject_id = ? OR male_subject_id = ?
     ) LIMIT 1`,
  ).get(
    actor.workspaceId,
    current.id,
    current.id,
    current.subject_id,
    current.subject_id,
  ) as { display_name: string } | undefined;
  if (used) throw new MonoHttpError(409, `该模特正在组合“${used.display_name}”中使用，请先调整或删除组合`);

  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "DELETE FROM mono_product_model_profiles WHERE id = ? AND workspace_id = ?",
    ).run(current.id, actor.workspaceId);
    db.prepare(
      "DELETE FROM mono_subjects WHERE id = ? AND workspace_id = ? AND owner_user_id = ?",
    ).run(current.subject_id, actor.workspaceId, actor.userId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function updateProductModelPair(
  actor: MonoActor,
  pairId: string,
  patch: z.infer<typeof updateProductModelPairSchema>,
): ProductModelPairOption {
  const current = pairForWorkspace(actor.workspaceId, pairId);
  if (!current) throw new MonoHttpError(404, "模特组合不存在");
  const femaleSubjectId = patch.femaleSubjectId ?? current.female_subject_id;
  const maleSubjectId = patch.maleSubjectId ?? current.male_subject_id;
  if (!femaleSubjectId || !maleSubjectId) throw new MonoHttpError(400, "模特组合资料不完整");
  if (!getMonoSubject(actor, femaleSubjectId) || !getMonoSubject(actor, maleSubjectId)) {
    throw new MonoHttpError(403, "所选模特不存在，或当前用户无权使用");
  }
  const female = profileForSubject(actor.workspaceId, femaleSubjectId);
  const male = profileForSubject(actor.workspaceId, maleSubjectId);
  assertProfileGroup(female, "female");
  assertProfileGroup(male, "male");
  getDb().prepare(
    `UPDATE mono_product_model_pairs
     SET display_name = ?, female_profile_id = ?, male_profile_id = ?,
         female_subject_id = ?, male_subject_id = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ?`,
  ).run(
    patch.displayName ?? current.display_name,
    female.id,
    male.id,
    female.subject_id,
    male.subject_id,
    Date.now(),
    pairId,
    actor.workspaceId,
  );
  return listProductModelPairs(actor.workspaceId).find((pair) => pair.id === pairId)!;
}

export function deleteProductModelPair(actor: MonoActor, pairId: string): void {
  const result = getDb().prepare(
    "DELETE FROM mono_product_model_pairs WHERE id = ? AND workspace_id = ?",
  ).run(pairId, actor.workspaceId);
  if (!result.changes) throw new MonoHttpError(404, "模特组合不存在");
}
