import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";

const originalDbPath = process.env.WORKBENCH_DB_PATH;
const originalStorageDir = process.env.WORKBENCH_STORAGE_DIR;
const dbPath = path.join(os.tmpdir(), `workbench-product-model-library-${crypto.randomUUID()}.db`);
const storageDir = path.join(os.tmpdir(), `workbench-product-model-library-storage-${crypto.randomUUID()}`);

function resetDb(): void {
  const globalDb = globalThis as typeof globalThis & { __workbenchDb?: { close?: () => void } };
  globalDb.__workbenchDb?.close?.();
  delete globalDb.__workbenchDb;
}

beforeAll(() => {
  resetDb();
  process.env.WORKBENCH_DB_PATH = dbPath;
  process.env.WORKBENCH_STORAGE_DIR = storageDir;
});

afterAll(async () => {
  resetDb();
  if (originalDbPath === undefined) delete process.env.WORKBENCH_DB_PATH;
  else process.env.WORKBENCH_DB_PATH = originalDbPath;
  if (originalStorageDir === undefined) delete process.env.WORKBENCH_STORAGE_DIR;
  else process.env.WORKBENCH_STORAGE_DIR = originalStorageDir;
  await Promise.all([
    rm(dbPath, { force: true }),
    rm(`${dbPath}-wal`, { force: true }),
    rm(`${dbPath}-shm`, { force: true }),
    rm(storageDir, { force: true, recursive: true }),
  ]);
});

describe("product model cards in the subject library", () => {
  it("rejects a URL-only asset so an unusable anchor cannot enter the product library", async () => {
    const { createMonoAsset } = await import("./store");
    const { createProductModelCard } = await import("./product-model-pairs");
    const actor = { userId: "owner", workspaceId: "model-library-url-only", traceId: "test" };
    const temporary = createMonoAsset(actor, {
      sourceUrl: "data:image/jpeg;base64,AA==",
      mimeType: "image/jpeg",
    });

    expect(() => createProductModelCard(actor, {
      displayName: "临时女模特",
      groupId: "female",
      assetId: temporary.id,
    })).toThrow("必须先通过上传存储");
  });

  it("creates typed subjects first, then makes a reusable female/male pair", async () => {
    const { createMonoAsset, getMonoSubject, listMonoSubjects } = await import("./store");
    const { saveObjectBuffer } = await import("@/lib/storage");
    const {
      createProductModelCard,
      createProductModelPairFromSubjects,
      deleteProductModelCard,
      deleteProductModelPair,
      listProductModelCards,
      listProductModelPairs,
      resolveProductModelPair,
      updateProductModelCard,
      updateProductModelPair,
    } = await import("./product-model-pairs");
    const actor = { userId: "owner", workspaceId: "model-library", traceId: "test" };
    const femaleStored = await saveObjectBuffer(Buffer.from("female-anchor"), "female.jpg");
    const maleStored = await saveObjectBuffer(Buffer.from("male-anchor"), "male.jpg");
    const bodyStored = await saveObjectBuffer(Buffer.from("female-body"), "female-body.jpg");
    const femaleAsset = createMonoAsset(actor, {
      sourceUrl: `storage:${femaleStored.key}`,
      storageKey: femaleStored.key,
      location: "local-storage",
      mimeType: "image/jpeg",
    });
    const maleAsset = createMonoAsset(actor, {
      sourceUrl: `storage:${maleStored.key}`,
      storageKey: maleStored.key,
      location: "local-storage",
      mimeType: "image/jpeg",
    });
    const bodyAsset = createMonoAsset(actor, {
      sourceUrl: `storage:${bodyStored.key}`,
      storageKey: bodyStored.key,
      location: "local-storage",
      mimeType: "image/jpeg",
    });

    const female = createProductModelCard(actor, {
      displayName: "女模特 A",
      groupId: "female",
      faceAssetId: femaleAsset.id,
      bodyAssetId: bodyAsset.id,
    });
    const male = createProductModelCard(actor, {
      displayName: "男模特 A",
      groupId: "male",
      assetId: maleAsset.id,
    });
    const pair = createProductModelPairFromSubjects(actor, {
      displayName: "通勤组合",
      femaleSubjectId: female.subjectId,
      maleSubjectId: male.subjectId,
    });

    expect(getMonoSubject(actor, female.subjectId)).toMatchObject({ kind: "product-model", assetId: femaleAsset.id });
    // Existing generic subject pickers stay unchanged until their dedicated
    // model-card UI is designed in the next round.
    expect(listMonoSubjects(actor)).toEqual([]);
    expect(listProductModelCards(actor.workspaceId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: female.id,
        subjectId: female.subjectId,
        faceAssetId: femaleAsset.id,
        bodyAssetId: bodyAsset.id,
        anchorAssetId: femaleAsset.id,
      }),
      expect.objectContaining({ id: male.id, subjectId: male.subjectId }),
    ]));
    expect(listProductModelPairs(actor.workspaceId)).toContainEqual(expect.objectContaining({
      id: pair.id,
      female: expect.objectContaining({ subjectId: female.subjectId }),
      male: expect.objectContaining({ subjectId: male.subjectId }),
    }));
    await expect(resolveProductModelPair(actor.workspaceId, pair.id)).resolves.toMatchObject({
      profiles: {
        female: expect.objectContaining({ anchorBytes: Buffer.from("female-anchor") }),
        male: expect.objectContaining({ anchorBytes: Buffer.from("male-anchor") }),
      },
    });

    const renamed = updateProductModelCard(actor, female.id, { displayName: "女模特 A2" });
    expect(renamed.displayName).toBe("女模特 A2");
    expect(getMonoSubject(actor, female.subjectId)?.name).toBe("女模特 A2");
    expect(() => updateProductModelCard(actor, female.id, { groupId: "male" }))
      .toThrow("通勤组合");
    expect(() => deleteProductModelCard(actor, female.id)).toThrow("通勤组合");

    const renamedPair = updateProductModelPair(actor, pair.id, { displayName: "通勤组合 2" });
    expect(renamedPair.displayName).toBe("通勤组合 2");
    deleteProductModelPair(actor, pair.id);
    expect(listProductModelPairs(actor.workspaceId)).toEqual([]);
    expect(() => deleteProductModelCard(actor, female.id)).not.toThrow();
  });
});
