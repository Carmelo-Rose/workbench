import { afterEach, describe, expect, it, vi } from "vitest";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  atomicPublish,
  composeNaturalShadowBackdrop,
  composeSquareDeliverable,
  composeWhiteMaster,
  describeReframing,
  detailPageSources,
  installedWorkflowIds,
  listProductFolders,
  listProductWorkflows,
  measureMatteAspect,
  MODEL_SLOTS,
  modelImageReferences,
  describeProportionDrift,
  modelSlotColorRanks,
  ProductCutoutScheduler,
  productPipelineSchedulingSettings,
  publishImages,
  refineProductForeground,
  refineSkuForeground,
  requestShadowBackdrop,
  resolveProductFolder,
  resolveProductFolderByName,
  runModelGenerationPhase,
  runWithConcurrency,
  selectModelSlots,
  validateProductPipelineInput,
  verifyDetailOutputs,
} from "./product-pipeline";
import type { RelativeBox } from "./product-classify";
import { productPipelineInputSchema } from "./contracts";
import { buildModelPrompt, identityGroupForLook, loadProductTemplate } from "./product-template";

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
/** An empty temp dir to stand in for the 【详情页】-待审 mirror in tests that don't care about its contents. */
async function emptyDetailRoot(): Promise<string> {
  const root = path.join(os.tmpdir(), `product-pipeline-detail-${crypto.randomUUID()}`); roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

describe("product pipeline folder isolation", () => {
  it("lists only selectable leaves and never returns an absolute path", async () => {
    const root = await fixture();
    const detailRoot = await emptyDetailRoot();
    const folders = await listProductFolders("商品", root, detailRoot);
    expect(folders).toEqual([{
      id: expect.any(String),
      name: "A / 商品一",
      imageCount: 1,
      detailShotCount: 0,
      hasMasters: false,
      hasImages: false,
    }]);
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
      modelPairId: "pair_30ebdd20-b35e-4e89-b6ae-7515f8256d28",
    }).success).toBe(true);
    expect(productPipelineInputSchema.safeParse({
      folderId: Buffer.from("123").toString("base64url"),
      workflowId: "hat-62604171-v1",
    }).success).toBe(true);
  });
});

describe("production model-pair conditioning", () => {
  it("maps A/C to the selected woman and B to the selected man", () => {
    expect(identityGroupForLook("A")).toBe("female");
    expect(identityGroupForLook("B")).toBe("male");
    expect(identityGroupForLook("C")).toBe("female");
  });

  it("puts the identity anchor before all product references", () => {
    expect(modelImageReferences(["front.jpg", "side.jpg"]))
      .toEqual(["front.jpg", "side.jpg"]);
    expect(modelImageReferences(
      ["front.jpg", "side.jpg", "back.jpg"],
      "anchor.jpg",
    )).toEqual(["anchor.jpg", "front.jpg", "side.jpg", "back.jpg"]);
    expect(modelImageReferences(
      ["front.jpg", "side.jpg"],
      "face.jpg",
      "body.jpg",
    )).toEqual(["face.jpg", "body.jpg", "front.jpg", "side.jpg"]);
  });

  it("keeps product rules without identity and dynamically numbers face/body references", async () => {
    const template = await loadProductTemplate(
      path.resolve("config/product-pipeline/hat-62604171-v1"),
    );
    const withIdentity = buildModelPrompt(template, "01", 0, 790, 1243, "female");
    expect(withIdentity).toContain("参考图1");
    expect(withIdentity).toContain("参考图2");
    expect(withIdentity).toContain("人物身份");
    const withBody = buildModelPrompt(template, "01", 0, 790, 1243, "female", true);
    expect(withBody).toContain("参考图2只用于参考人物的大致身高感");
    expect(withBody).toContain("参考图3及其后的图片是同一件商品");
    const automatic = buildModelPrompt(template, "01", 0, 790, 1243);
    expect(automatic).not.toContain("人物身份");
    expect(automatic).toContain("参考图1及其后的图片是同一件商品");
    expect(automatic).toContain("【禁止出现】");
  });
});

describe("folder status markers", () => {
  /**
   * Writes a shoot folder in one of the states the picker has to describe.
   * 原图 goes under the source root; 主图/images go under a *separate*
   * detail root at the same relative path, mirroring how the pipeline itself
   * now reads and writes them from two different trees.
   */
  async function shoot(sourceRoot: string, detailRoot: string, name: string, contents: {
    article: string[];
    details?: string[];
    masters?: string[];
    published?: string[];
  }): Promise<void> {
    const write = async (base: string, dir: string, files: string[]) => {
      if (!files.length) return;
      await mkdir(path.join(base, name, dir), { recursive: true });
      await Promise.all(files.map((file) => writeFile(path.join(base, name, dir, file), "x")));
    };
    await write(sourceRoot, "原图", [...contents.article, ...(contents.details ?? [])]);
    await write(detailRoot, "主图", contents.masters ?? []);
    await write(detailRoot, "images", contents.published ?? []);
  }

  async function statuses(): Promise<Record<string, Awaited<ReturnType<typeof listProductFolders>>[number]>> {
    const sourceRoot = path.join(os.tmpdir(), `product-pipeline-${crypto.randomUUID()}`); roots.push(sourceRoot);
    const detailRoot = path.join(os.tmpdir(), `product-pipeline-detail-${crypto.randomUUID()}`); roots.push(detailRoot);
    await shoot(sourceRoot, detailRoot, "全新", { article: ["a.jpg", "b.jpg"] });
    await shoot(sourceRoot, detailRoot, "有细节图", { article: ["a.jpg"], details: ["x_1.jpg", "x_2.jpg"] });
    await shoot(sourceRoot, detailRoot, "主图齐全", { article: ["a.jpg", "b.jpg"], masters: ["a.jpg", "b.jpg"] });
    await shoot(sourceRoot, detailRoot, "主图缺一张", { article: ["a.jpg", "b.jpg"], masters: ["a.jpg"] });
    await shoot(sourceRoot, detailRoot, "已发布", { article: ["a.jpg"], published: ["已发布_01.jpg", "已发布_11.jpg"] });
    await shoot(sourceRoot, detailRoot, "空images", { article: ["a.jpg"], published: [] });
    return Object.fromEntries((await listProductFolders("", sourceRoot, detailRoot)).map((folder) => [folder.name, folder]));
  }

  /**
   * Regression, twice over: a shoot that stages `x_5` had it promoted to the
   * hero band, so the top of the page became a shot framed for nothing in
   * particular while the fabric caption sat over it.
   */
  it("builds the detail page from four crops and cuts the hero out of the fourth", () => {
    const five = ["x_1", "x_2", "x_3", "x_4", "x_5"];
    expect(detailPageSources(five)).toEqual({ hero: "x_4", grid: ["x_1", "x_2", "x_3", "x_4"] });
    // A short shoot still fills every block it can, from whatever it staged.
    expect(detailPageSources(["x_1", "x_2"])).toEqual({ hero: "x_2", grid: ["x_1", "x_2"] });
  });

  it("counts x_ crops as detail shots and keeps them out of the article count comparison", async () => {
    const rows = await statuses();
    expect(rows["有细节图"]).toMatchObject({ imageCount: 3, detailShotCount: 2 });
    expect(rows["全新"]).toMatchObject({ imageCount: 2, detailShotCount: 0 });
  });

  it("claims reusable masters only when every article shot has one", async () => {
    const rows = await statuses();
    expect(rows["主图齐全"].hasMasters).toBe(true);
    // One missing master means the cutout step still runs, so promising a skip
    // here would be a straight lie about what the run is about to do.
    expect(rows["主图缺一张"].hasMasters).toBe(false);
    expect(rows["全新"].hasMasters).toBe(false);
  });

  it("flags an existing published set, and does not flag an empty images folder", async () => {
    const rows = await statuses();
    expect(rows["已发布"].hasImages).toBe(true);
    // `123` on the real share has an images/ directory with nothing in it —
    // warning "将覆盖" there would train the user to ignore the warning.
    expect(rows["空images"].hasImages).toBe(false);
    expect(rows["全新"].hasImages).toBe(false);
  });
});

describe("installed template bundles", () => {
  it("accepts an installed workflow id and rejects anything else", async () => {
    const installed = installedWorkflowIds();
    expect(installed.has("hat-62604171-v1")).toBe(true);
    const folderId = Buffer.from("A/商品一", "utf8").toString("base64url");
    expect(() => validateProductPipelineInput({ folderId, workflowId: "hat-62604171-v1" })).not.toThrow();
    for (const workflowId of ["", "../../etc", "shirt-v1"]) {
      expect(() => validateProductPipelineInput({ folderId, workflowId })).toThrow("不支持的商品套图工作流");
    }
  });

  it("labels each bundle with the category its template declares", async () => {
    const workflows = await listProductWorkflows();
    expect(workflows).toContainEqual({ id: "hat-62604171-v1", label: "帽子详情套图" });
  });
});

describe("resolving a folder from the name a person says", () => {
  async function namedFixture(): Promise<string> {
    const root = path.join(os.tmpdir(), `product-pipeline-${crypto.randomUUID()}`); roots.push(root);
    for (const name of ["1234", "12345", "123456"]) {
      await mkdir(path.join(root, "得物", name, "原图"), { recursive: true });
      await writeFile(path.join(root, "得物", name, "原图", "hat.jpg"), "not-a-real-image");
    }
    return root;
  }

  it("takes an exact folder name even when longer names contain it", async () => {
    const root = await namedFixture();
    const folder = await resolveProductFolderByName("1234", root);
    expect(folder.name).toBe("1234");
    expect(resolveProductFolder(folder.id, root).relativePath).toBe(path.join("得物", "1234"));
  });

  it("refuses an ambiguous name instead of picking one and spending money", async () => {
    const root = await namedFixture();
    // "234" is a substring of all three and an exact match for none. Guessing
    // here would run seven paid generations against the wrong article and
    // overwrite that folder's published set. The candidates are listed by full
    // label so a user can actually tell them apart.
    await expect(resolveProductFolderByName("234", root))
      .rejects.toThrow(/得物 \/ 1234、得物 \/ 12345、得物 \/ 123456/u);
  });

  it("reports a name that matches nothing rather than falling back to any folder", async () => {
    const root = await namedFixture();
    await expect(resolveProductFolderByName("9999", root)).rejects.toThrow("没有找到");
    await expect(resolveProductFolderByName("   ", root)).rejects.toThrow("请提供商品文件夹名");
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

describe("natural studio shadow recovery", () => {
  it("keeps a nearby photographed shadow while removing distant backdrop marks", async () => {
    const root = await fixture();
    const source = path.join(root, "source.png");
    const mask = path.join(root, "mask.png");
    const width = 120;
    const height = 80;
    const pixels = Buffer.alloc(width * height * 3);
    const matte = Buffer.alloc(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        const offset = index * 3;
        const background = [232, 236, 242];
        pixels[offset] = background[0];
        pixels[offset + 1] = background[1];
        pixels[offset + 2] = background[2];

        // A soft photographed contact shadow immediately below the product.
        const distance = ((x - 60) / 38) ** 2 + ((y - 61) / 9) ** 2;
        if (distance < 1) {
          const shade = Math.round(75 * (1 - distance) ** 2);
          pixels[offset] -= shade;
          pixels[offset + 1] -= shade;
          pixels[offset + 2] -= shade;
        }
        // A paper seam far away from the product must not leak into the result.
        if (x === 5 && y >= 48) {
          pixels[offset] -= 70;
          pixels[offset + 1] -= 70;
          pixels[offset + 2] -= 70;
        }
        if (x >= 47 && x <= 73 && y >= 20 && y <= 57) {
          matte[index] = 255;
          pixels[offset] = 35;
          pixels[offset + 1] = 35;
          pixels[offset + 2] = 35;
        }
      }
    }
    await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toFile(source);
    await sharp(matte, { raw: { width, height, channels: 1 } }).png().toFile(mask);

    const backdrop = await composeNaturalShadowBackdrop(source, await readFile(mask));
    const { data, info } = await sharp(backdrop).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) =>
      Array.from(data.subarray((y * width + x) * info.channels, (y * width + x + 1) * info.channels));

    expect(info).toMatchObject({ width, height, channels: 3 });
    expect(pixel(0, 0)).toEqual([255, 255, 255]);
    expect(pixel(5, 60)).toEqual([255, 255, 255]);
    expect(pixel(60, 30)).toEqual([255, 255, 255]);
    expect(Math.max(...pixel(60, 60))).toBeLessThan(235);
  });

  it("removes low-confidence shadow fragments from the opaque product layer", async () => {
    const foreground = await sharp(Buffer.from([
      30, 30, 30, 32,
      30, 30, 30, 160,
      30, 30, 30, 255,
    ]), { raw: { width: 3, height: 1, channels: 4 } }).png().toBuffer();

    const alpha = await sharp(await refineProductForeground(foreground))
      .extractChannel("alpha")
      .raw()
      .toBuffer();

    expect(Array.from(alpha)).toEqual([0, 127, 255]);
  });

  it("uses only the high-confidence silhouette for SKU", async () => {
    const foreground = await sharp(Buffer.from([
      30, 30, 30, 96,
      30, 30, 30, 200,
      30, 30, 30, 223,
      30, 30, 30, 255,
    ]), { raw: { width: 4, height: 1, channels: 4 } }).png().toBuffer();

    const alpha = await sharp(await refineSkuForeground(foreground))
      .extractChannel("alpha")
      .raw()
      .toBuffer();

    expect(Array.from(alpha)).toEqual([0, 0, 0, 255]);
  });
});

describe("square deliverable composition", () => {
  /** A 40x30 RGBA canvas with a 20x16 opaque red block at (10,7). */
  async function foreground(): Promise<Buffer> {
    const opaque = await sharp({ create: { width: 20, height: 16, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } } }).png().toBuffer();
    return sharp({ create: { width: 40, height: 30, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: opaque, left: 10, top: 7 }])
      .png()
      .toBuffer();
  }
  const box: RelativeBox = { left: 10 / 40, top: 7 / 30, width: 20 / 40, height: 16 / 30 };

  /**
   * A generated frame shaped like the ones the 1234 run produced: the article
   * over on one side of the frame, lit from that side, its cast shadow running
   * a long way out to the other. `reach` is how far left the shadow gets.
   */
  async function litFromOneSide(reach: number): Promise<Buffer> {
    const frame = Buffer.alloc(60 * 30 * 3, 255);
    for (let y = 7; y < 23; y += 1) {
      for (let x = 40; x < 56; x += 1) {
        const offset = (y * 60 + x) * 3;
        frame[offset] = 200; frame[offset + 1] = 30; frame[offset + 2] = 30;
      }
    }
    for (let y = 23; y < 26; y += 1) {
      for (let x = reach; x < 50; x += 1) {
        const offset = (y * 60 + x) * 3;
        frame[offset] = 232; frame[offset + 1] = 234; frame[offset + 2] = 238;
      }
    }
    return sharp(frame, { raw: { width: 60, height: 30, channels: 3 } }).png().toBuffer();
  }
  /** Where the article in `litFromOneSide` sits — what its matte would say. */
  const litArticle: RelativeBox = { left: 40 / 60, top: 7 / 30, width: 16 / 60, height: 16 / 30 };

  /** Bounding box of the red article block on a rendered square. */
  function articleBox(data: Buffer, info: { width: number; height: number; channels: number }) {
    let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const offset = (y * info.width + x) * info.channels;
        if (data[offset] <= data[offset + 2] + 40) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }

  it("centres the product on an 800x800 white canvas", async () => {
    const root = await fixture();
    const output = path.join(root, "square.png");
    await composeSquareDeliverable(await foreground(), box, output);
    const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width: 800, height: 800, channels: 3 });
    const pixel = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x + 1) * info.channels));
    expect(pixel(0, 0)).toEqual([255, 255, 255]);
    expect(pixel(799, 799)).toEqual([255, 255, 255]);
    // Centre of the canvas sits inside the product: red channel dominant, not white.
    const centre = pixel(400, 400);
    expect(centre[0]).toBeGreaterThan(centre[2]);
    expect(centre).not.toEqual([255, 255, 255]);
  });

  it("keeps the shadow a 主图 frame already contains, without a separate layer", async () => {
    const root = await fixture();
    const output = path.join(root, "square-main.png");
    // A generated frame: white sweep, product, and the shadow already in it.
    const frame = Buffer.alloc(40 * 30 * 3, 255);
    for (let y = 7; y < 23; y += 1) {
      for (let x = 10; x < 30; x += 1) {
        const offset = (y * 40 + x) * 3;
        frame[offset] = 200; frame[offset + 1] = 30; frame[offset + 2] = 30;
      }
    }
    for (let x = 8; x < 32; x += 1) {
      const offset = (23 * 40 + x) * 3;
      frame[offset] = 170; frame[offset + 1] = 175; frame[offset + 2] = 185;
    }
    const generated = await sharp(frame, { raw: { width: 40, height: 30, channels: 3 } }).png().toBuffer();
    await composeSquareDeliverable(generated, box, output, { framing: "main" });

    const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) =>
      Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x + 1) * info.channels));
    expect(info).toMatchObject({ width: 800, height: 800, channels: 3 });
    // The band below the product survived the crop and resize.
    const column = Array.from({ length: 800 }, (_, y) => Math.max(...pixel(400, y)));
    expect(column.slice(500).some((value) => value < 230)).toBe(true);
    expect(pixel(0, 0)).toEqual([255, 255, 255]);
  });

  it("centres a 主图 on the article, not on the article plus the shadow beside it", async () => {
    const root = await fixture();
    const output = path.join(root, "square-main-lit-side.png");
    await composeSquareDeliverable(await litFromOneSide(4), litArticle, output, { framing: "main" });

    const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
    const rendered = articleBox(data, info);
    // Centring the two together is what shipped every 1234 主图 with the hat
    // shoved against one edge: its centre landed at 57%–67% of the width,
    // because that is how far the shadow reached the other way.
    expect(rendered.left + rendered.width / 2).toBeGreaterThan(392);
    expect(rendered.left + rendered.width / 2).toBeLessThan(408);
    expect(rendered.top + rendered.height / 2).toBeGreaterThan(392);
    expect(rendered.top + rendered.height / 2).toBeLessThan(408);
  });

  it("prints the article the same whatever shadow the generator drew next to it", async () => {
    const root = await fixture();
    const near = path.join(root, "square-main-near-shadow.png");
    const far = path.join(root, "square-main-far-shadow.png");
    // One hat, two shots, two very different shadows — the swing that made
    // every revision of this folder frame the product differently.
    await composeSquareDeliverable(await litFromOneSide(30), litArticle, near, { framing: "main" });
    await composeSquareDeliverable(await litFromOneSide(4), litArticle, far, { framing: "main" });

    const read = async (file: string) => {
      const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
      let shadowPixels = 0;
      for (let offset = 0; offset < data.length; offset += info.channels) {
        const max = Math.max(data[offset], data[offset + 1], data[offset + 2]);
        const min = Math.min(data[offset], data[offset + 1], data[offset + 2]);
        if (max < 250 && max > 200 && max - min < 20) shadowPixels += 1;
      }
      return { article: articleBox(data, info), shadowPixels };
    };
    const [a, b] = await Promise.all([read(near), read(far)]);
    expect(a.article).toEqual(b.article);
    // Still a shadow under the hat in both — it just no longer votes on where
    // the hat goes or how large it prints.
    expect(a.shadowPixels).toBeGreaterThan(1000);
    expect(b.shadowPixels).toBeGreaterThan(1000);
  });

  it("still frames a 主图 when the frame's matte came back empty", async () => {
    const root = await fixture();
    const output = path.join(root, "square-main-no-article.png");
    // Degraded rather than fatal: with nothing to separate article from
    // shadow, framing falls back to the whole frame's ink and the run warns.
    await composeSquareDeliverable(await litFromOneSide(4), null, output, { framing: "main" });

    const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width: 800, height: 800, channels: 3 });
    expect(articleBox(data, info).width).toBeGreaterThan(200);
  });

  it("scales a 主图 uniformly, so the article keeps the proportions it was generated at", async () => {
    const root = await fixture();
    const output = path.join(root, "square-main-uniform.png");
    // A 2:1 block on a frame that is not itself 2:1. Any non-uniform resize on
    // the way to the square canvas shows up as a different ratio here.
    const frame = Buffer.alloc(40 * 30 * 3, 255);
    for (let y = 10; y < 20; y += 1) {
      for (let x = 10; x < 30; x += 1) {
        const offset = (y * 40 + x) * 3;
        frame[offset] = 200; frame[offset + 1] = 30; frame[offset + 2] = 30;
      }
    }
    const generated = await sharp(frame, { raw: { width: 40, height: 30, channels: 3 } }).png().toBuffer();
    const box: RelativeBox = { left: 10 / 40, top: 10 / 30, width: 20 / 40, height: 10 / 30 };
    await composeSquareDeliverable(generated, box, output, { framing: "main" });

    const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
    const isProduct = (x: number, y: number) => {
      const offset = (y * info.width + x) * info.channels;
      return data[offset] > data[offset + 2] + 40;
    };
    let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        if (!isProduct(x, y)) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    const renderedAspect = (maxX - minX + 1) / (maxY - minY + 1);
    expect(renderedAspect).toBeGreaterThan(1.9);
    expect(renderedAspect).toBeLessThan(2.1);
  });
});

describe("主图 article measurement", () => {
  /** The standalone grayscale matte the gateway returns today. */
  async function greyMatte(w: number, h: number, blobW: number, blobH: number): Promise<Buffer> {
    const blob = await sharp({ create: { width: blobW, height: blobH, channels: 3, background: "#ffffff" } }).png().toBuffer();
    return sharp({ create: { width: w, height: h, channels: 3, background: "#000000" } })
      .composite([{ input: blob, left: Math.round((w - blobW) / 2), top: Math.round((h - blobH) / 2) }])
      .removeAlpha()
      .png()
      .toBuffer();
  }

  /** The older shape: a full-size RGBA copy whose alpha carries the matte. */
  async function alphaMatte(w: number, h: number, blobW: number, blobH: number): Promise<Buffer> {
    const blob = await sharp({ create: { width: blobW, height: blobH, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } } }).png().toBuffer();
    return sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: blob, left: Math.round((w - blobW) / 2), top: Math.round((h - blobH) / 2) }])
      .png()
      .toBuffer();
  }

  it("reads the article's own proportions off a matte, not the canvas's", async () => {
    // A 2:1 blob on a canvas that is neither 2:1 nor square.
    await expect(measureMatteAspect(await greyMatte(400, 300, 200, 100))).resolves.toBeCloseTo(2, 1);
    await expect(measureMatteAspect(await greyMatte(300, 400, 100, 200))).resolves.toBeCloseTo(0.5, 1);
  });

  it("reads a legacy RGBA matte the same way as a standalone grayscale one", async () => {
    await expect(measureMatteAspect(await alphaMatte(400, 300, 200, 100))).resolves.toBeCloseTo(2, 1);
  });

  it("returns null for an empty matte rather than a bogus ratio", async () => {
    await expect(measureMatteAspect(await sharp({ create: { width: 40, height: 30, channels: 3, background: "#000000" } }).png().toBuffer()))
      .resolves.toBeNull();
  });

  it("says nothing when the article came back the shape it went in", () => {
    expect(describeProportionDrift("hat.jpg", 1.4, 1.4)).toBeUndefined();
    // Probe noise on a 400px matte, not a redrawn article.
    expect(describeProportionDrift("hat.jpg", 1.4, 1.407)).toBeUndefined();
    // The real readings off 1234, measured with a threshold that separates the
    // article from its cast shadow: every shot agrees to well within tolerance.
    expect(describeProportionDrift("329A4131.jpg", 1.333, 1.332)).toBeUndefined();
    expect(describeProportionDrift("329A4133.jpg", 1.186, 1.192)).toBeUndefined();
  });

  it("reports a redrawn article, naming the shot and both readings", () => {
    const warning = describeProportionDrift("hat.jpg", 1.4, 1.19);
    expect(warning).toContain("hat.jpg");
    expect(warning).toContain("1.190");
    expect(warning).toContain("1.400");
    expect(warning).toContain("15%");
    expect(warning).toContain("请人工复核");
  });

  it("reports rather than repairs, in both directions", () => {
    // Whatever the reading, the answer is a string or nothing — there is no
    // resize to hand back. A bad reading costs someone a look at a good
    // picture; a stretch on a bad reading would ship a deformed product photo.
    expect(describeProportionDrift("hat.jpg", 1.2, 1.32)).toBeTypeOf("string");
    expect(describeProportionDrift("hat.jpg", 2.4, 1.2)).toBeTypeOf("string");
  });
});

describe("product pipeline model generation phase", () => {
  it("collects a failed slot without discarding the others, with the correct reason attached", async () => {
    const slots = MODEL_SLOTS.slice(0, 3);
    const failingId = slots[1][0];
    const { records, failedSlots } = await runModelGenerationPhase(
      slots,
      6,
      new AbortController().signal,
      async (slot) => {
        if (slot[0] === failingId) throw new Error("gpt-image-2 请求失败 (HTTP 400)：违规内容");
        return { slot: slot[0], ok: true };
      },
    );
    expect(records.map((record) => record.slot).sort()).toEqual(
      slots.filter((slot) => slot[0] !== failingId).map((slot) => slot[0]).sort(),
    );
    expect(failedSlots).toEqual([{ slot: failingId, reason: "gpt-image-2 请求失败 (HTTP 400)：违规内容" }]);
  });

  it("never calls the generator once the signal is already aborted, and never records it as a failed slot", async () => {
    const controller = new AbortController();
    controller.abort();
    const attempted: string[] = [];
    await expect(
      runModelGenerationPhase(MODEL_SLOTS.slice(0, 2), 6, controller.signal, async (slot) => {
        attempted.push(slot[0]);
        return { slot: slot[0] };
      }),
    ).rejects.toThrow("任务已取消");
    expect(attempted).toEqual([]);
  });

  it("propagates a mid-run cancellation as a hard stop instead of recording a failed slot", async () => {
    const controller = new AbortController();
    const slots = MODEL_SLOTS.slice(0, 2);
    const survivorId = slots[1][0];
    const run = runModelGenerationPhase(slots, 6, controller.signal, async (slot) => {
      if (slot[0] === survivorId) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { slot: slot[0] };
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
      controller.abort();
      throw new Error("upstream aborted the request");
    });
    await expect(run).rejects.toThrow("upstream aborted the request");
  });
});

describe("product pipeline onlySlots retry", () => {
  it("selectModelSlots narrows generation to exactly the requested slot", () => {
    expect(selectModelSlots(["04"]).map((slot) => slot[0])).toEqual(["04"]);
  });

  it("selectModelSlots returns every model slot when nothing is requested", () => {
    expect(selectModelSlots(null).map((slot) => slot[0])).toEqual(MODEL_SLOTS.map((slot) => slot[0]));
    expect(selectModelSlots(undefined).map((slot) => slot[0])).toEqual(MODEL_SLOTS.map((slot) => slot[0]));
  });

  it("calls the generator exactly once when a retry is narrowed to a single slot", async () => {
    const calls: string[] = [];
    const { records, failedSlots } = await runModelGenerationPhase(
      selectModelSlots(["04"]),
      6,
      new AbortController().signal,
      async (slot) => {
        calls.push(slot[0]);
        return { slot: slot[0] };
      },
    );
    expect(calls).toEqual(["04"]);
    expect(records).toHaveLength(1);
    expect(failedSlots).toHaveLength(0);
  });

  it("gives a retried slot the colourway it had on the full run, not the hero one", () => {
    // The failure this guards against is silent and expensive: allocating over
    // only the retried slots would hand every retry rank 0, so re-running slot
    // 08 of a three-colourway shoot would pay for a hero-colour image and
    // publish it over the correct one on the shared drive.
    for (const colorCount of [1, 2, 3, 4, 7]) {
      const full = modelSlotColorRanks(colorCount);
      for (const slot of MODEL_SLOTS) {
        const narrowed = selectModelSlots([slot[0]]);
        expect(narrowed.map((item) => item[0])).toEqual([slot[0]]);
        expect(modelSlotColorRanks(colorCount).get(slot[0])).toBe(full.get(slot[0]));
      }
    }
  });

  it("binds slots to colourways by rank, keeping the reference 3/2/2 split", () => {
    const ranks = modelSlotColorRanks(3);
    expect(MODEL_SLOTS.map((slot) => ranks.get(slot[0]))).toEqual([0, 0, 0, 1, 1, 2, 2]);
    // Every model slot must be bound; an unbound one would read as `undefined`
    // and index the colour array out of bounds at generation time.
    expect([...ranks.keys()]).toEqual(MODEL_SLOTS.map((slot) => slot[0]));
    // A single-colourway shoot puts every slot on that colourway.
    expect([...modelSlotColorRanks(1).values()].every((rank) => rank === 0)).toBe(true);
  });

  it("rejects onlySlots entries that are not model-kind slot ids", () => {
    const folderId = Buffer.from("A/商品一", "utf8").toString("base64url");
    expect(() => validateProductPipelineInput({
      folderId, workflowId: "hat-62604171-v1", onlySlots: ["04"],
    })).not.toThrow();
    expect(() => validateProductPipelineInput({
      folderId, workflowId: "hat-62604171-v1", onlySlots: ["02"],
    })).toThrow("onlySlots");
    expect(() => validateProductPipelineInput({
      folderId, workflowId: "hat-62604171-v1", onlySlots: ["99"],
    })).toThrow("onlySlots");
  });
});

describe("product pipeline partial publish", () => {
  it("publishImages only copies staged slots that exist, keeping the prior image for the rest", async () => {
    const root = await fixture();
    const stage = path.join(root, "stage");
    const destination = path.join(root, "images");
    await mkdir(stage, { recursive: true });
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, "商品一_01.jpg"), "old-01");
    await writeFile(path.join(destination, "商品一_04.jpg"), "old-04");
    await writeFile(path.join(stage, "商品一_01.jpg"), "new-01");
    await writeFile(path.join(stage, "商品一_02.jpg"), "new-02");

    await publishImages(stage, destination, "商品一", new Set(["01", "02"]));

    await expect(readFile(path.join(destination, "商品一_01.jpg"), "utf8")).resolves.toBe("new-01");
    await expect(readFile(path.join(destination, "商品一_02.jpg"), "utf8")).resolves.toBe("new-02");
    await expect(readFile(path.join(destination, "商品一_04.jpg"), "utf8")).resolves.toBe("old-04");
  });

  it("verifyDetailOutputs only checks the dimensions of slots actually produced this run", async () => {
    const root = await fixture();
    const stage = path.join(root, "stage");
    await mkdir(stage, { recursive: true });
    await sharp({ create: { width: 790, height: 681, channels: 3, background: "#ffffff" } }).jpeg().toFile(path.join(stage, "商品一_02.jpg"));
    await expect(verifyDetailOutputs(stage, "商品一", [], new Set(["02"]))).resolves.toBeUndefined();
  });
});

describe("online shadow backdrop generation", () => {
  const originalBaseUrl = process.env.MONO_IMAGE_BASE_URL;
  const originalApiKey = process.env.MONO_IMAGE_API_KEY;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalBaseUrl === undefined) delete process.env.MONO_IMAGE_BASE_URL;
    else process.env.MONO_IMAGE_BASE_URL = originalBaseUrl;
    if (originalApiKey === undefined) delete process.env.MONO_IMAGE_API_KEY;
    else process.env.MONO_IMAGE_API_KEY = originalApiKey;
  });

  async function sourceFixture(root: string, width = 60, height = 40): Promise<{
    path: string; name: string; stem: string; size: number; mtimeMs: number; hash: string;
  }> {
    const sourcePath = path.join(root, "hat.jpg");
    await sharp({ create: { width, height, channels: 3, background: "#eeeeee" } }).jpeg().toFile(sourcePath);
    const stats = await (await import("node:fs/promises")).stat(sourcePath);
    return { path: sourcePath, name: "hat.jpg", stem: "hat", size: stats.size, mtimeMs: stats.mtimeMs, hash: "irrelevant" };
  }

  it("asks for the source's own ratio and never stretches what comes back", async () => {
    process.env.MONO_IMAGE_BASE_URL = "https://image.example.test";
    process.env.MONO_IMAGE_API_KEY = "test-image-key";
    const root = await fixture();
    const source = await sourceFixture(root, 90, 60);
    // Deliberately a different shape from the 3:2 that was asked for: a service
    // that rounds the requested ratio to one of its own supported shapes is
    // exactly the case that used to be resized back and squeeze the article.
    const resultPng = await sharp({ create: { width: 12, height: 12, channels: 3, background: "#123456" } }).png().toBuffer();

    const fetchMock = vi.fn().mockImplementation((endpoint: string) => {
      if (endpoint === "https://image.example.test/v1/api/generate") {
        return Promise.resolve(new Response(
          JSON.stringify({ results: [{ url: "https://image.example.test/shadow.png" }] }),
          { status: 200 },
        ));
      }
      return Promise.resolve(new Response(new Uint8Array(resultPng), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const backdrop = await requestShadowBackdrop(source, new AbortController().signal, "ws-test");

    const generateCall = fetchMock.mock.calls.find(([endpoint]) => endpoint === "https://image.example.test/v1/api/generate");
    expect(generateCall).toBeDefined();
    const body = JSON.parse(generateCall![1].body);
    expect(body.images).toHaveLength(1);
    expect(body.images[0]).toMatch(/^data:image\/jpeg;base64,/);
    expect(body.aspectRatio).toBe("90:60");

    const { info } = await sharp(backdrop).raw().toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width: 12, height: 12, channels: 3 });
  });

  it("reports a frame the generator re-composed, and stays quiet when it did not", async () => {
    const root = await fixture();
    const source = await sourceFixture(root, 90, 60);
    const reframed = await sharp({ create: { width: 12, height: 12, channels: 3, background: "#123456" } }).png().toBuffer();
    const inPlace = await sharp({ create: { width: 45, height: 30, channels: 3, background: "#123456" } }).png().toBuffer();

    await expect(describeReframing(source, reframed)).resolves.toMatch("12×12");
    await expect(describeReframing(source, inPlace)).resolves.toBeUndefined();
  });

  it("throws after three failed attempts instead of falling back to the local algorithm", async () => {
    process.env.MONO_IMAGE_BASE_URL = "https://image.example.test";
    process.env.MONO_IMAGE_API_KEY = "test-image-key";
    const root = await fixture();
    const source = await sourceFixture(root);

    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ error: "violation" }), { status: 400 })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestShadowBackdrop(source, new AbortController().signal, "ws-test")).rejects.toThrow(
      "主图阴影三次都没拿到有效结果",
    );
    const generateCalls = fetchMock.mock.calls.filter(([endpoint]) => endpoint === "https://image.example.test/v1/api/generate");
    expect(generateCalls).toHaveLength(3);
  });
});
