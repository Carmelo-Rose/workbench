import { afterEach, describe, expect, it } from "vitest";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  atomicPublish,
  composeWhiteMaster,
  installedWorkflowIds,
  listProductFolders,
  listProductWorkflows,
  MODEL_SLOTS,
  modelSlotColorRanks,
  ProductCutoutScheduler,
  productPipelineSchedulingSettings,
  publishImages,
  resolveProductFolder,
  resolveProductFolderByName,
  runModelGenerationPhase,
  runWithConcurrency,
  selectModelSlots,
  validateProductPipelineInput,
  verifyDetailOutputs,
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
    }).success).toBe(true);
  });
});

describe("folder status markers", () => {
  /** Writes a shoot folder in one of the states the picker has to describe. */
  async function shoot(root: string, name: string, contents: {
    article: string[];
    details?: string[];
    masters?: string[];
    published?: string[];
  }): Promise<void> {
    const write = async (dir: string, files: string[]) => {
      if (!files.length) return;
      await mkdir(path.join(root, name, dir), { recursive: true });
      await Promise.all(files.map((file) => writeFile(path.join(root, name, dir, file), "x")));
    };
    await write("原图", [...contents.article, ...(contents.details ?? [])]);
    await write("主图", contents.masters ?? []);
    await write("images", contents.published ?? []);
  }

  async function statuses(): Promise<Record<string, Awaited<ReturnType<typeof listProductFolders>>[number]>> {
    const root = path.join(os.tmpdir(), `product-pipeline-${crypto.randomUUID()}`); roots.push(root);
    await shoot(root, "全新", { article: ["a.jpg", "b.jpg"] });
    await shoot(root, "有细节图", { article: ["a.jpg"], details: ["x_1.jpg", "x_2.jpg"] });
    await shoot(root, "主图齐全", { article: ["a.jpg", "b.jpg"], masters: ["a.jpg", "b.jpg"] });
    await shoot(root, "主图缺一张", { article: ["a.jpg", "b.jpg"], masters: ["a.jpg"] });
    await shoot(root, "已发布", { article: ["a.jpg"], published: ["已发布_01.jpg", "已发布_11.jpg"] });
    await shoot(root, "空images", { article: ["a.jpg"], published: [] });
    return Object.fromEntries((await listProductFolders("", root)).map((folder) => [folder.name, folder]));
  }

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
