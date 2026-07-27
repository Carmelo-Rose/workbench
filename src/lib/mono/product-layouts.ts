import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { cropToProduct, type MeasuredSource } from "./product-classify";

/**
 * Composited (non-generated) pages of the product set.
 *
 * Slot 10 tiles one representative shot per colourway; slot 11 presents the
 * macro crops as a hero plus a grid.  Both are rebuilt from the shoot rather
 * than generated, so they cost nothing and always show the real article.
 */

/** Stack that resolves to an installed CJK face on both Windows and Linux hosts. */
const FONT_STACK = "'Microsoft YaHei','PingFang SC','Noto Sans CJK SC','Source Han Sans SC','WenQuanYi Micro Hei',sans-serif";

const MARGIN = 34;

/**
 * Block geometry measured off the hand-built reference set.
 *
 * These pages sit next to each other in a listing, so every product has to
 * publish with the blocks in exactly the same place — a layout derived from
 * whatever margins happened to be convenient drifts visibly between products.
 * The values are absolute because the slot canvases are fixed by the workflow.
 */
const PAGE = {
  title: { baseline: 64, fontSize: 29, subFontSize: 18, bandHeight: 90 },
  /** Slot 10, on a 790x610 canvas. */
  tiled: { top: 108, bottom: 609, left: 40, right: 742, gapX: 30, gapY: 22 },
  /** Slot 11, on a 790x1026 canvas. */
  detail: {
    hero: { top: 109, height: 316 },
    grid: { top: 460, bottom: 975, gapX: 39, gapY: 35 },
  },
} as const;

export type PageTitle = { chinese: string; english: string };
export type HeroCaption = { headline: string; english: string; sub: string };

type Rect = { left: number; top: number; width: number; height: number };

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[char]!);
}

/**
 * Title band shared by both pages: a large Chinese title followed by a lighter
 * Latin subtitle on the same baseline, as used by the hand-built reference set.
 */
function titleSvg(width: number, title: PageTitle): Buffer {
  const chinese = escapeXml(title.chinese);
  const english = escapeXml(title.english);
  const { baseline, fontSize, subFontSize, bandHeight } = PAGE.title;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${bandHeight}">` +
      `<text x="${MARGIN}" y="${baseline}" font-family="${FONT_STACK}" font-size="${fontSize}" fill="#1a1a1a">${chinese}` +
        `<tspan font-size="${subFontSize}" fill="#8a8a8a" dx="10">/ ${english}</tspan>` +
      `</text>` +
    `</svg>`,
  );
}

/**
 * Cell rectangles for `count` items inside `area`.
 *
 * Three items get the reference set's 2-over-1 arrangement with the last one
 * centred; every other count falls back to a balanced grid.
 */
export function tileRects(count: number, area: Rect, gapX = 18, gapY = gapX): Rect[] {
  if (count <= 0) return [];
  if (count === 1) return [area];
  const columns = count === 2 ? 2 : count === 3 ? 2 : count === 4 ? 2 : 3;
  const rows = Math.ceil(count / columns);
  const width = Math.floor((area.width - gapX * (columns - 1)) / columns);
  const height = Math.floor((area.height - gapY * (rows - 1)) / rows);
  const rects: Rect[] = [];
  for (let index = 0; index < count; index += 1) {
    const row = Math.floor(index / columns);
    const itemsInRow = Math.min(columns, count - row * columns);
    // Centre a short final row so a 2-over-1 layout reads as intentional. The
    // reference page has this row nudged slightly off-centre by hand; centring
    // it is what makes the block land identically for every product.
    const rowWidth = itemsInRow * width + (itemsInRow - 1) * gapX;
    const offset = area.left + Math.floor((area.width - rowWidth) / 2);
    const column = index - row * columns;
    rects.push({
      left: offset + column * (width + gapX),
      top: area.top + row * (height + gapY),
      width,
      height,
    });
  }
  return rects;
}

/**
 * Studio frame trimmed to the article, then letterboxed into the tile.
 *
 * The trim keeps only a hairline of breathing room: the tile is already the
 * page's own spacing, so any margin baked into the crop just shrinks the
 * article relative to the reference layout.
 */
const TILE_CROP_PADDING = 0.012;

async function placeContained(source: MeasuredSource, rect: Rect): Promise<sharp.OverlayOptions> {
  const cropped = await cropToProduct(source.path, source.metric.box, TILE_CROP_PADDING);
  return {
    input: await sharp(cropped)
      .resize(rect.width, rect.height, { fit: "contain", background: "#ffffff" })
      .toBuffer(),
    left: rect.left,
    top: rect.top,
  };
}

/** Macro crops are already tightly framed, so they fill the tile edge to edge. */
async function placeCovered(source: MeasuredSource, rect: Rect): Promise<sharp.OverlayOptions> {
  return {
    input: await sharp(source.path)
      .resize(rect.width, rect.height, { fit: "cover", position: "centre" })
      .toBuffer(),
    left: rect.left,
    top: rect.top,
  };
}

/**
 * Slot 10 — one representative shot per colourway on the studio sweep, so a
 * shopper can compare the range at a glance.
 */
export async function renderTiledDisplay(
  representatives: readonly MeasuredSource[],
  output: string,
  width: number,
  height: number,
  title: PageTitle,
): Promise<void> {
  if (!representatives.length) throw new Error("平铺展示图没有可用的商品图");
  const { top, bottom, left, right, gapX, gapY } = PAGE.tiled;
  const area: Rect = {
    left,
    top,
    width: Math.min(right, width) - left,
    height: Math.min(bottom, height) - top,
  };
  const rects = tileRects(representatives.length, area, gapX, gapY);
  const layers = await Promise.all(representatives.map((source, index) => placeContained(source, rects[index])));
  await sharp({ create: { width, height, channels: 3, background: "#ffffff" } })
    .composite([{ input: titleSvg(width, title), left: 0, top: 0 }, ...layers])
    .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
    .toFile(output);
}

export type BrandMark = {
  asset?: string;
  text?: string;
  color: string;
  fontSize: number;
};

/**
 * Stamp the brand wordmark into the top-left corner of a finished slot.
 *
 * Compositing it here — rather than asking the image model for it — is the only
 * way to get identical letterforms on every slot of every product.
 */
export async function applyBrandMark(file: string, mark: BrandMark, assetRoot: string): Promise<void> {
  // Read once into memory. A sharp instance cannot be reused after `metadata()`
  // has consumed it, and re-opening the same path while the earlier handle is
  // still around fails outright on Windows — which previously turned a purely
  // cosmetic overlay into a job-ending error.
  const input = await readFile(file);
  const { width } = await sharp(input).metadata();
  if (!width) throw new Error(`无法读取图片尺寸：${file}`);
  const overlay = mark.asset
    ? await sharp(await readFile(path.join(assetRoot, mark.asset)))
        .resize({ width: Math.round(width * 0.24) }).png().toBuffer()
    : Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${mark.fontSize * 2}">` +
          `<text x="${MARGIN}" y="${Math.round(mark.fontSize * 1.3)}" font-family="Georgia,'Times New Roman',serif" ` +
          `font-size="${mark.fontSize}" letter-spacing="1.5" fill="${mark.color}">${escapeXml(mark.text ?? "")}</text>` +
        `</svg>`,
      );
  const stamped = await sharp(input)
    .composite([{ input: overlay, left: mark.asset ? MARGIN : 0, top: Math.round(mark.fontSize * 0.8) }])
    .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
    .toBuffer();
  await writeFile(file, stamped);
}

/** Height of the darkened band that guarantees the caption stays readable. */
const HERO_SCRIM_HEIGHT = 168;

/**
 * Caption block laid over the hero crop of the detail page.
 *
 * The caption is white, but the crop behind it is whatever the shoot happened
 * to frame — a macro of a pale cap, or a dark one sitting on a blown-out studio
 * sweep. Without the scrim the text silently vanishes into any light region,
 * which is invisible to every automated check in the pipeline and only shows up
 * once a human looks at the published page.
 */
function heroCaptionSvg(rect: Rect, caption: HeroCaption): Buffer {
  const padding = 34;
  const inner = rect.width - padding * 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${rect.width}" height="${rect.height}">` +
      `<defs><linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0%" stop-color="#000000" stop-opacity="0.62"/>` +
        `<stop offset="70%" stop-color="#000000" stop-opacity="0.34"/>` +
        `<stop offset="100%" stop-color="#000000" stop-opacity="0"/>` +
      `</linearGradient></defs>` +
      `<rect x="0" y="0" width="${rect.width}" height="${HERO_SCRIM_HEIGHT}" fill="url(#scrim)"/>` +
      `<text x="${padding}" y="76" font-family="${FONT_STACK}" font-size="36" font-weight="bold" fill="#ffffff">${escapeXml(caption.headline)}</text>` +
      `<text x="${padding + inner}" y="76" text-anchor="end" font-family="${FONT_STACK}" font-size="25" fill="#ffffff">${escapeXml(caption.english)}</text>` +
      `<rect x="${padding}" y="92" width="${inner}" height="1.5" fill="#ffffff" opacity="0.85"/>` +
      `<text x="${padding}" y="126" font-family="${FONT_STACK}" font-size="19" fill="#ffffff" opacity="0.92">${escapeXml(caption.sub)}</text>` +
    `</svg>`,
  );
}

/**
 * Slot 11 — the macro crops, hero first with the fabric caption over it and the
 * remainder in a grid. Crops are placed full-bleed because they are already
 * tightly framed on the article.
 */
export async function renderDetailPresentation(
  crops: readonly MeasuredSource[],
  output: string,
  width: number,
  height: number,
  title: PageTitle,
  caption: HeroCaption,
): Promise<void> {
  if (!crops.length) throw new Error("细节展示图没有可用的细节图");
  const [heroSource, ...rest] = crops;
  const { hero: heroGeometry, grid } = PAGE.detail;
  const heroRect: Rect = {
    left: MARGIN,
    top: heroGeometry.top,
    width: width - MARGIN * 2,
    height: heroGeometry.height,
  };
  const gridRects = tileRects(
    Math.min(rest.length, 4),
    {
      left: MARGIN,
      top: grid.top,
      width: width - MARGIN * 2,
      height: Math.min(grid.bottom, height) - grid.top,
    },
    grid.gapX,
    grid.gapY,
  );
  const layers = await Promise.all(rest.slice(0, 4).map((source, index) => placeCovered(source, gridRects[index])));
  const hero = await placeCovered(heroSource, heroRect);
  await sharp({ create: { width, height, channels: 3, background: "#ffffff" } })
    .composite([
      { input: titleSvg(width, title), left: 0, top: 0 },
      hero,
      { input: heroCaptionSvg(heroRect, caption), left: heroRect.left, top: heroRect.top },
      ...layers,
    ])
    .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
    .toFile(output);
}
