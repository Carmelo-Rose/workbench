import { afterEach, describe, expect, it } from "vitest";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicPublish, listProductFolders, resolveProductFolder } from "./product-pipeline";
import { productPipelineInputSchema } from "./contracts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(): Promise<string> {
  const root = path.join(os.tmpdir(), `product-pipeline-${crypto.randomUUID()}`); roots.push(root);
  await mkdir(path.join(root, "A", "商品一", "原图"), { recursive: true });
  await mkdir(path.join(root, "B", "无效", "原图"), { recursive: true });
  await writeFile(path.join(root, "A", "商品一", "原图", "hat.JPG"), "not-a-real-image");
  return root;
}
describe("product pipeline folder isolation", () => {
  it("lists only selectable leaves and never returns an absolute path", async () => {
    const root = await fixture();
    const folders = await listProductFolders("商品", root);
    expect(folders).toEqual([{ id: expect.any(String), name: "A / 商品一", imageCount: 1 }]);
    expect(JSON.stringify(folders)).not.toContain(root);
  });
  it("rejects encoded traversal outside the configured root", async () => {
    const root = await fixture();
    const id = Buffer.from("../outside").toString("base64url");
    expect(() => resolveProductFolder(id, root)).toThrow("超出允许目录");
  });
  it("accepts an opaque ID generated for a short folder name", () => {
    expect(productPipelineInputSchema.safeParse({
      folderId: Buffer.from("123").toString("base64url"),
      workflowId: "hat-62604171-v1",
    }).success).toBe(true);
  });
});

describe("product pipeline publishing", () => {
  it("copies local staging to a sibling share stage before atomically replacing the destination", async () => {
    const root = await fixture();
    const localStage = path.join(root, "local-staging", "主图");
    const destination = path.join(root, "A", "商品一", "主图");
    await mkdir(localStage, { recursive: true });
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(localStage, "new.jpg"), "new-master");
    await writeFile(path.join(destination, "old.jpg"), "old-master");

    await atomicPublish(localStage, destination);

    await expect(readFile(path.join(destination, "new.jpg"), "utf8")).resolves.toBe("new-master");
    await expect(access(path.join(destination, "old.jpg"))).rejects.toThrow();
    await expect(access(localStage)).rejects.toThrow();
    const siblings = await (await import("node:fs/promises")).readdir(path.dirname(destination));
    expect(siblings.some((name) => name.includes(".workbench-stage-") || name.includes(".backup-"))).toBe(false);
  });
});
