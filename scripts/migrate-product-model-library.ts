/**
 * One-time, idempotent import of the old consistency-demo model library.
 *
 * It copies only already-approved profile anchors and pair metadata. It never
 * creates a casting, calls an image provider, or touches product folders.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  listModelPairs,
  listProfiles,
  profileDir,
} from "../src/experiments/product-set-model-consistency/storage";
import {
  registerProductModelPair,
  registerProductModelProfile,
} from "../src/lib/mono/product-model-pairs";
import { legacyUserId, legacyWorkspaceId } from "../src/lib/server/tenant-ids";

const actor = {
  userId: legacyUserId,
  workspaceId: legacyWorkspaceId,
  traceId: "product-model-library-migration",
};

async function main(): Promise<void> {
  const [profiles, pairs] = await Promise.all([
    listProfiles(actor.workspaceId),
    listModelPairs(actor.workspaceId),
  ]);

  for (const profile of profiles) {
    const anchor = await readFile(path.join(profileDir(profile.id), profile.anchorImageName));
    await registerProductModelProfile(actor, {
      id: profile.id,
      displayName: profile.displayName,
      groupId: profile.groupId,
      anchor,
      sourceCandidateId: profile.sourceCandidateId,
      prompt: profile.prompt,
      provider: profile.provider,
      model: profile.model,
      createdAt: profile.createdAt,
    });
  }

  for (const pair of pairs) {
    await registerProductModelPair(actor.workspaceId, {
      id: pair.id,
      displayName: pair.displayName,
      femaleProfileId: pair.profileIds.female,
      maleProfileId: pair.profileIds.male,
      createdAt: pair.createdAt,
    });
  }

  console.log(JSON.stringify({
    importedProfiles: profiles.length,
    importedPairs: pairs.length,
    paidRequests: 0,
  }));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
