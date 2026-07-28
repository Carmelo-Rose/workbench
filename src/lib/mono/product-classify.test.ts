import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import sharp from "sharp";
import {
  allocateModelSlots,
  classifySources,
  clusterByColor,
  deltaE,
  type Lab,
  type MeasuredSource,
} from "./product-classify";
import { applyBrandMark, renderDetailPresentation, tileRects } from "./product-layouts";
import { buildModelPrompt, productTemplateSchema } from "./product-template";

/** Measured from a real three-colourway shoot; the values the thresholds were tuned against. */
const BLACK: Lab = [22.1, 2.1, -2.8];
const NAVY: Lab = [37.0, 3.8, -12.5];
const CREAM: Lab = [77.9, 0.5, 3.5];

function shot(name: string, lab: Lab, edgeRatio: number, coverage = 0.25): MeasuredSource {
  return {
    path: `/shoot/${name}.jpg`,
    metric: { lab, coverage, edgeRatio, box: { left: 0.2, top: 0.2, width: 0.6, height: 0.6 } },
  };
}

/** Five angles of one colourway, with the slight drift a real shoot has. */
function colourway(prefix: string, lab: Lab): MeasuredSource[] {
  return [0, 1, 2, 3, 4].map((index) =>
    shot(`${prefix}${index}`, [lab[0] + index * 0.9, lab[1], lab[2] + index * 0.2], 0.01));
}

describe("model slot allocation", () => {
  it("gives the hero colourway the 3/2/2 split used by the hand-built reference set", () => {
    expect(allocateModelSlots(3, 7)).toEqual([0, 0, 0, 1, 1, 2, 2]);
  });

  it("spreads seven slots over any colour count, remainders to the highest ranks", () => {
    expect(allocateModelSlots(1, 7)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(allocateModelSlots(2, 7)).toEqual([0, 0, 0, 0, 1, 1, 1]);
    expect(allocateModelSlots(4, 7)).toEqual([0, 0, 1, 1, 2, 2, 3]);
    expect(allocateModelSlots(5, 7)).toEqual([0, 0, 1, 1, 2, 3, 4]);
  });

  it("never allocates more colours than there are slots", () => {
    const allocation = allocateModelSlots(12, 7);
    expect(allocation).toHaveLength(7);
    expect(Math.max(...allocation)).toBeLessThan(7);
  });
});

describe("colourway clustering", () => {
  it("keeps genuinely different colourways apart and merges one colourway's drift", () => {
    const items = [...colourway("black", BLACK), ...colourway("navy", NAVY), ...colourway("cream", CREAM)];
    const clusters = clusterByColor(items);
    expect(clusters).toHaveLength(3);
    expect(clusters.map((cluster) => cluster.indices.length).sort()).toEqual([5, 5, 5]);
  });

  it("uses complete linkage so a gradual run cannot chain two colourways together", () => {
    // A ladder whose neighbours are all within the cutoff but whose ends are not.
    const ladder = [0, 6, 12, 18, 24].map((offset, index) => shot(`step${index}`, [20 + offset, 0, 0], 0.01));
    const clusters = clusterByColor(ladder);
    expect(clusters.length).toBeGreaterThan(1);
    for (const cluster of clusters) {
      for (const left of cluster.indices) {
        for (const right of cluster.indices) {
          expect(deltaE(ladder[left].metric.lab, ladder[right].metric.lab)).toBeLessThanOrEqual(12);
        }
      }
    }
  });
});

describe("shoot classification", () => {
  const shoot = [
    ...colourway("black", BLACK),
    ...colourway("navy", NAVY),
    ...colourway("cream", CREAM),
    // Macro crops run off the frame edge; four on navy plus one dark lining.
    shot("macro0", NAVY, 0.38, 0.59),
    shot("macro1", NAVY, 0.29, 0.5),
    shot("macro2", NAVY, 0.54, 0.74),
    shot("macro3", NAVY, 0.3, 0.5),
    shot("lining", [6, 0.9, -2.8], 0.44, 0.41),
  ];

  it("separates macro crops from full-article shots by edge occupancy", () => {
    const result = classifySources(shoot);
    expect(result.details.map((item) => item.path)).toEqual([
      "/shoot/macro2.jpg", "/shoot/macro0.jpg", "/shoot/macro1.jpg", "/shoot/macro3.jpg", "/shoot/lining.jpg",
    ]);
    expect(result.colors.flatMap((color) => color.members)).toHaveLength(15);
  });

  it("promotes the colourway the macro crops were shot on to hero", () => {
    const result = classifySources(shoot);
    expect(result.colors[0].lab[2]).toBeLessThan(-10);
    expect(result.colors[0].members).toHaveLength(5);
    expect(result.colors.map((color) => color.rank)).toEqual([0, 1, 2]);
  });

  it("orders detail crops hero-colour first and fullest frame first", () => {
    const result = classifySources(shoot);
    // The off-colour lining sorts last, so it is only used if the hero is short.
    expect(result.details.at(-1)!.path).toBe("/shoot/lining.jpg");
    expect(result.details[0].metric.coverage).toBe(0.74);
  });

  it("keeps a dark macro crop from inventing a fourth colourway", () => {
    expect(classifySources(shoot).colors).toHaveLength(3);
  });

  it("warns when a shoot has no macro crops at all", () => {
    const result = classifySources(shoot.filter((item) => item.metric.edgeRatio <= 0.1));
    expect(result.warnings.join()).toContain("没有细节特写");
    expect(result.colors).toHaveLength(3);
  });

  it("refuses a shoot that is entirely macro crops rather than guessing", () => {
    expect(() => classifySources([shot("macro", NAVY, 0.4, 0.6)])).toThrow("没有可用的商品整体图");
  });

  it("drops blank masters from a failed cutout instead of clustering them as a white colourway", () => {
    const result = classifySources([...shoot, shot("failed", [100, 0, 0], 0, 0)]);
    expect(result.colors).toHaveLength(3);
    expect(result.colors.flatMap((color) => color.members).map((item) => item.path))
      .not.toContain("/shoot/failed.jpg");
    expect(result.warnings.join()).toContain("抠图失败");
  });
});

describe("tile layout", () => {
  const area = { left: 36, top: 96, width: 718, height: 478 };

  it("centres the short final row so three colourways read as 2-over-1", () => {
    const rects = tileRects(3, area);
    expect(rects[0].top).toBe(rects[1].top);
    expect(rects[2].top).toBeGreaterThan(rects[0].top);
    const centre = (rect: { left: number; width: number }) => rect.left + rect.width / 2;
    expect(centre(rects[2])).toBeCloseTo(area.left + area.width / 2, 0);
  });

  it("keeps every tile inside the area it was given", () => {
    for (const count of [1, 2, 3, 4, 5, 6]) {
      for (const rect of tileRects(count, area)) {
        expect(rect.left).toBeGreaterThanOrEqual(area.left);
        expect(rect.top).toBeGreaterThanOrEqual(area.top);
        expect(rect.left + rect.width).toBeLessThanOrEqual(area.left + area.width);
        expect(rect.top + rect.height).toBeLessThanOrEqual(area.top + area.height);
      }
    }
  });
});

describe("brand wordmark", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /**
   * Regression: the overlay used to read the target through one sharp instance
   * and then re-run that same consumed instance to write it, which fails
   * outright on Windows and took the whole job down with it.
   */
  it("stamps a slot in place without reopening the file it is writing", async () => {
    const dir = await mkdtemp(nodePath.join(os.tmpdir(), "brandmark-"));
    dirs.push(dir);
    const file = nodePath.join(dir, "slot.jpg");
    await sharp({ create: { width: 790, height: 600, channels: 3, background: "#e6e6e6" } })
      .jpeg().toFile(file);
    const before = await readFile(file);

    await applyBrandMark(file, { text: "SHOMARNE", color: "#0058a0", fontSize: 30 }, dir);

    const after = await readFile(file);
    expect(after.equals(before)).toBe(false);
    await expect(sharp(after).metadata()).resolves.toMatchObject({ width: 790, height: 600 });
  });
});

/** `count` plain frames of one colour, standing in for a shoot's macro crops. */
async function plainCrops(dir: string, count: number, color: string): Promise<string[]> {
  const files: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const file = nodePath.join(dir, `crop-${index}.jpg`);
    await sharp({ create: { width: 900, height: 600, channels: 3, background: color } }).jpeg().toFile(file);
    files.push(file);
  }
  return files;
}

/** Mean luma over a rectangle of a rendered page. */
async function meanLuma(
  file: string,
  rect: { left: number; top: number; width: number; height: number },
): Promise<number> {
  const { data, info } = await sharp(file).extract(rect).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let total = 0;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    total += 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
  }
  return total / (info.width * info.height);
}

describe("detail page caption", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /**
   * Regression: the white caption used to be laid straight onto the hero crop.
   * When the crop was a pale macro on a blown-out studio sweep the text became
   * invisible, and every automated check still reported the slot as fine.
   */
  it("stays legible over a hero crop that is entirely white", async () => {
    const dir = await mkdtemp(nodePath.join(os.tmpdir(), "detailpage-"));
    dirs.push(dir);
    const crops: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const file = nodePath.join(dir, `crop-${index}.jpg`);
      await sharp({ create: { width: 900, height: 600, channels: 3, background: "#ffffff" } })
        .jpeg().toFile(file);
      crops.push(file);
    }
    const output = nodePath.join(dir, "slot-11.jpg");

    await renderDetailPresentation(crops[4], crops.slice(0, 4), output, 790, 1026,
      { chinese: "细节展示", english: "DETAIL PRESENTATION" },
      { headline: "升级面料", english: "Upgraded fabric", sub: "立体刺绣工艺" });

    const { data, info } = await sharp(output).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    // The caption band sits just inside the hero, which starts at y = 92.
    let darkened = 0, total = 0;
    for (let y = 100; y < 250; y += 1) {
      for (let x = 40; x < 750; x += 1) {
        const offset = (y * info.width + x) * info.channels;
        const luma = 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
        if (luma < 200) darkened += 1;
        total += 1;
      }
    }
    expect(darkened / total).toBeGreaterThan(0.5);
  });

  /**
   * Regression: the scrim used to be applied at full strength whatever the crop
   * was under it, which laid a grey wash across the top of every page whose
   * hero landed on dark cloth — the reference set has none.
   */
  it("leaves the caption band alone over a hero crop that is already dark", async () => {
    const dir = await mkdtemp(nodePath.join(os.tmpdir(), "detailpage-"));
    dirs.push(dir);
    const crops = await plainCrops(dir, 4, "#2b3350");
    const output = nodePath.join(dir, "slot-11.jpg");

    await renderDetailPresentation(crops[3], crops.slice(0, 4), output, 790, 1026,
      { chinese: "细节展示", english: "DETAIL PRESENTATION" },
      { headline: "升级面料", english: "Upgraded fabric", sub: "立体刺绣工艺" });

    // Sampled to the right of the English caption, so only the scrim can have
    // touched these pixels. #2b3350 reads about 51; a full scrim halves that.
    expect(await meanLuma(output, { left: 730, top: 115, width: 22, height: 35 })).toBeGreaterThan(40);
  });
});

describe("detail page framing", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /**
   * Regression: the crops were cover-fitted, which on a studio frame of the
   * whole article put the cap in the cell at arm's length. The reference page
   * frames each block roughly twice that close, and the difference between the
   * two is the whole of what slot 11 is for.
   */
  it("frames a block closer than a cover-fit of the whole frame would", async () => {
    const dir = await mkdtemp(nodePath.join(os.tmpdir(), "detailframe-"));
    dirs.push(dir);
    // White frames carrying a navy patch across the middle half. A cover-fit
    // shows the white surround; the reference zoom lands wholly inside it.
    const crops: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const file = nodePath.join(dir, `crop-${index}.jpg`);
      await sharp({ create: { width: 900, height: 600, channels: 3, background: "#ffffff" } })
        .composite([{
          input: { create: { width: 450, height: 300, channels: 3, background: "#2b3350" } },
          left: 225,
          top: 150,
        }])
        .jpeg().toFile(file);
      crops.push(file);
    }
    const output = nodePath.join(dir, "slot-11.jpg");

    await renderDetailPresentation(crops[3], crops.slice(0, 4), output, 790, 1026,
      { chinese: "细节展示", english: "DETAIL PRESENTATION" },
      { headline: "升级面料", english: "Upgraded fabric", sub: "立体刺绣工艺" });

    // The top-left cell of the grid, inset so JPEG ringing on the block edge
    // cannot decide the result.
    expect(await meanLuma(output, { left: 40, top: 466, width: 329, height: 228 })).toBeLessThan(80);
  });
});

describe("prompt assembly", () => {
  const template = productTemplateSchema.parse({
    version: "test-v1",
    category: "cap",
    categoryLabel: "帽子",
    productLock: "以参考图为准",
    framingRule: "竖构图。",
    negative: "不要第二顶帽子",
    looks: [{ id: "A", text: "女模黑T" }, { id: "B", text: "男模咖啡T" }, { id: "C", text: "女模白T" }],
    modelSlots: { "01": { framing: "半身景别。" } },
    pages: {
      "10": { title: { chinese: "平铺展示", english: "TILED DISPLAY" } },
      "11": {
        title: { chinese: "细节展示", english: "DETAIL PRESENTATION" },
        caption: { headline: "升级面料", english: "Upgraded fabric", sub: "立体刺绣工艺" },
      },
    },
    fixedSlots: { "02": "fixed-02.jpg" },
  });

  it("states the product contract before the styling so conflicts resolve toward the product", () => {
    const prompt = buildModelPrompt(template, "01", 0, 790, 1243);
    expect(prompt.indexOf("以参考图为准")).toBeLessThan(prompt.indexOf("女模黑T"));
    expect(prompt).toContain("790:1243");
    expect(prompt).toContain("不要第二顶帽子");
  });

  it("binds looks to colourway rank rather than to any colour name", () => {
    expect(buildModelPrompt(template, "01", 1, 790, 1243)).toContain("男模咖啡T");
    // A fourth colourway reuses the first look rather than failing the run.
    expect(buildModelPrompt(template, "01", 3, 790, 1243)).toContain("女模黑T");
  });

  it("fails loudly when a slot has no shot direction", () => {
    expect(() => buildModelPrompt(template, "07", 0, 790, 1005)).toThrow("槽位 07");
  });
});
