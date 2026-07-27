import { afterEach, describe, expect, it } from "vitest";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  atomicPublish,
  composeWhiteMaster,
  listProductFolders,
  ProductCutoutScheduler,
  productPipelineSchedulingSettings,
  resolveProductFolder,
  runWithConcurrency,
} from "./product-pipeline";
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

async function waitFor(assertion: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(message);
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

describe("product pipeline cutout concurrency", () => {
  it("limits in-flight white-master work to the configured bound", async () => {
    let inFlight = 0;
    let peak = 0;
    const completed: number[] = [];
    await runWithConcurrency([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 6, async (value) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      completed.push(value);
      inFlight -= 1;
    });
    expect(peak).toBe(6);
    expect(completed.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("fairly shares the global twelve slots among four active product folders", async () => {
    const scheduler = new ProductCutoutScheduler({ globalCutouts: 12, perFolderCutouts: 6 });
    const started: string[] = [];
    let unblock!: () => void;
    const hold = new Promise<void>((resolve) => { unblock = resolve; });
    const tasks = ["A", "B", "C", "D"].flatMap((folder) =>
      Array.from({ length: 6 }, () => scheduler.run(folder, async () => {
        started.push(folder);
        await hold;
      })),
    );

    await waitFor(() => started.length === 12, "the first twelve fair permits were not granted");
    expect(started.reduce<Record<string, number>>((counts, folder) => {
      counts[folder] = (counts[folder] ?? 0) + 1;
      return counts;
    }, {})).toEqual({ A: 3, B: 3, C: 3, D: 3 });
    expect(scheduler.getStats().active).toBe(12);

    unblock();
    await Promise.all(tasks);
    expect(scheduler.getStats().active).toBe(0);
  });

  it("never lets one folder use more than six slots even when global capacity remains", async () => {
    const scheduler = new ProductCutoutScheduler({ globalCutouts: 12, perFolderCutouts: 6 });
    const started: string[] = [];
    let unblock!: () => void;
    const hold = new Promise<void>((resolve) => { unblock = resolve; });
    const tasks = Array.from({ length: 12 }, () => scheduler.run("A", async () => {
      started.push("A");
      await hold;
    }));

    await waitFor(() => started.length === 6, "the per-folder ceiling was not reached");
    expect(scheduler.getStats()).toMatchObject({ active: 6, activeByFolder: { A: 6 } });

    unblock();
    await Promise.all(tasks);
  });

  it("allows safe environment tuning while retaining the agreed hard ceilings", () => {
    expect(productPipelineSchedulingSettings({
      PRODUCT_PIPELINE_ACTIVE_FOLDERS: "2",
      PRODUCT_PIPELINE_FOLDER_CUTOUT_CONCURRENCY: "5",
      PRODUCT_PIPELINE_GLOBAL_CUTOUT_CONCURRENCY: "9",
    })).toEqual({ activeFolders: 2, perFolderCutouts: 5, globalCutouts: 9 });
    expect(productPipelineSchedulingSettings({
      PRODUCT_PIPELINE_ACTIVE_FOLDERS: "99",
      PRODUCT_PIPELINE_FOLDER_CUTOUT_CONCURRENCY: "99",
      PRODUCT_PIPELINE_GLOBAL_CUTOUT_CONCURRENCY: "99",
    })).toEqual({ activeFolders: 4, perFolderCutouts: 6, globalCutouts: 12 });
  });
});

describe("white master composition", () => {
  it("keeps the original canvas and replaces only transparent cutout pixels with white", async () => {
    const root = await fixture();
    const source = path.join(root, "source.png");
    const cutout = path.join(root, "cutout.png");
    const output = path.join(root, "output.jpg");
    await sharp({ create: { width: 6, height: 4, channels: 3, background: "#2468c0" } }).png().toFile(source);
    const opaqueProduct = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    await sharp({ create: { width: 6, height: 4, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: opaqueProduct, left: 2, top: 1 }]).png().toFile(cutout);

    await composeWhiteMaster(source, await readFile(cutout), output);

    const rendered = sharp(output);
    await expect(rendered.metadata()).resolves.toMatchObject({ width: 6, height: 4, format: "jpeg" });
    const { data, info } = await rendered.raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x + 1) * info.channels));
    expect(pixel(0, 0)).toEqual([255, 255, 255]);
    expect(pixel(2, 1)[2]).toBeGreaterThan(150);
  });

  it("reads a standalone grayscale matte the same way as a legacy RGBA cutout", async () => {
    const root = await fixture();
    const source = path.join(root, "source.png");
    const mask = path.join(root, "mask.png");
    const output = path.join(root, "output.jpg");
    await sharp({ create: { width: 6, height: 4, channels: 3, background: "#2468c0" } }).png().toFile(source);
    const opaqueProduct = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#ffffff" } }).png().toBuffer();
    const canvas = await sharp({ create: { width: 6, height: 4, channels: 3, background: "#000000" } })
      .composite([{ input: opaqueProduct, left: 2, top: 1 }]).png().toBuffer();
    await sharp(canvas).removeAlpha().toColorspace("b-w").png().toFile(mask);
    await expect(sharp(mask).metadata()).resolves.toMatchObject({ channels: 1, hasAlpha: false });

    await composeWhiteMaster(source, await readFile(mask), output);

    const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x + 1) * info.channels));
    expect(pixel(0, 0)).toEqual([255, 255, 255]);
    expect(pixel(2, 1)[2]).toBeGreaterThan(150);
  });

  it("rejects a cutout whose canvas would alter the original composition", async () => {
    const root = await fixture();
    const source = path.join(root, "source.png");
    const cutout = path.join(root, "cutout.png");
    await sharp({ create: { width: 6, height: 4, channels: 3, background: "#ffffff" } }).png().toFile(source);
    await sharp({ create: { width: 5, height: 4, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(cutout);
    await expect(composeWhiteMaster(source, await readFile(cutout), path.join(root, "output.jpg"))).rejects.toThrow("尺寸与原图不一致");
  });
});
