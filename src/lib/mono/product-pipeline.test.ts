import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listProductFolders, resolveProductFolder } from "./product-pipeline";

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
});
