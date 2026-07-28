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

/** Fallback shape of a tile's contents, used when no crop has been measured. */
const DEFAULT_TILE_ASPECT = 4 / 3;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Cell rectangles for `count` items inside `area`.
 *
 * The arrangement is derived rather than tabulated, because a lineup runs from
 * two colourways to seven or more and no fixed grid serves that whole range: a
 * grid shaped for three strands a lone tile on the last row once a shoot has
 * seven. Rows are chosen to make each tile as large as `area` allows for
 * contents of `aspect`, then the items are spread evenly so no row ends up
 * shorter than another by more than one. Short rows are centred, which is what
 * makes the reference three-colourway page read as a deliberate 2-over-1.
 */
export function tileRects(
  count: number,
  area: Rect,
  gapX = 18,
  gapY = gapX,
  aspect = DEFAULT_TILE_ASPECT,
): Rect[] {
  if (count <= 0) return [];
  if (count === 1) return [area];
  let best: { rows: number; width: number; height: number; area: number } | null = null;
  for (let rows = 1; rows <= count; rows += 1) {
    const columns = Math.ceil(count / rows);
    const width = Math.floor((area.width - gapX * (columns - 1)) / columns);
    const height = Math.floor((area.height - gapY * (rows - 1)) / rows);
    if (width <= 0 || height <= 0) continue;
    // Score on the tile's *rendered* size, not the cell's: a tall cell holding a
    // wide crop is mostly whitespace and does not make the article any bigger.
    const rendered = Math.min(width, height * aspect);
    const score = rendered * (rendered / aspect);
    if (!best || score > best.area) best = { rows, width, height, area: score };
  }
  if (!best) return [];
  const rects: Rect[] = [];
  let remaining = count;
  for (let row = 0; row < best.rows; row += 1) {
    const itemsInRow = Math.ceil(remaining / (best.rows - row));
    const rowWidth = itemsInRow * best.width + (itemsInRow - 1) * gapX;
    const offset = area.left + Math.floor((area.width - rowWidth) / 2);
    for (let column = 0; column < itemsInRow; column += 1) {
      rects.push({
        left: offset + column * (best.width + gapX),
        top: area.top + row * (best.height + gapY),
        width: best.width,
        height: best.height,
      });
    }
    remaining -= itemsInRow;
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

/**
 * How much closer than a plain cover-fit each block of the detail page frames
 * its crop.
 *
 * Measured off the hand-built reference page: its grid cells hold the middle
 * 44% of the frame's width and its hero band 60%, which is a 2.2x and a 1.65x
 * zoom on what covering the whole frame would show. The staged `x_` shots are
 * studio frames of the entire article, so cover-fitting them puts the cap in
 * the cell at arm's length and the page reads as four ordinary snapshots —
 * losing the one thing slot 11 exists to show, which is the article up close.
 */
const DETAIL_ZOOM = { hero: 1.65, cell: 2.2 } as const;

/**
 * Where the hero band is taken from vertically, as a fraction of the frame.
 *
 * The reference page pulls its band from below the middle, which is what keeps
 * the fabric caption over plain cloth rather than over the crown button — the
 * same shot supplies the last grid cell, and two crops of one button stacked on
 * one page is the most obviously repetitive thing this layout can do.
 */
const HERO_ANCHOR_Y = 0.74;

/**
 * Centre `file` in `rect`, framed `zoom` times closer than a cover-fit would.
 *
 * `anchorY` slides the window up or down the frame; it is clamped so the window
 * never runs off the edge, which would otherwise letterbox the block.
 */
async function placeZoomed(
  file: string,
  rect: Rect,
  zoom: number,
  anchorY = 0.5,
): Promise<sharp.OverlayOptions> {
  // Read once: a sharp instance cannot be reused after `metadata()` consumes it.
  const input = await readFile(file);
  const { width, height } = await sharp(input).metadata();
  if (!width || !height) throw new Error(`无法读取图片尺寸：${file}`);
  const aspect = rect.width / rect.height;
  // The largest rect-shaped window the frame holds, then closed in by `zoom`.
  const cover = Math.min(width, height * aspect);
  const cropWidth = Math.max(8, Math.min(width, Math.round(cover / zoom)));
  const cropHeight = Math.max(8, Math.min(height, Math.round(cropWidth / aspect)));
  const left = Math.round((width - cropWidth) / 2);
  const top = Math.min(Math.max(Math.round(height * anchorY - cropHeight / 2), 0), height - cropHeight);
  return {
    input: await sharp(input)
      .extract({ left, top, width: cropWidth, height: cropHeight })
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
  // Crop first, then let the crops' own shape pick the grid. A cap lineup is
  // wide, and a grid laid out for upright product would letterbox every tile.
  const crops = await Promise.all(representatives.map((source) =>
    cropToProduct(source.path, source.metric.box, TILE_CROP_PADDING)));
  const shapes = await Promise.all(crops.map(async (crop) => {
    const shape = await sharp(crop).metadata();
    return shape.width && shape.height ? shape.width / shape.height : DEFAULT_TILE_ASPECT;
  }));
  const rects = tileRects(crops.length, area, gapX, gapY, median(shapes));
  const layers = await Promise.all(crops.map(async (crop, index) => ({
    input: await sharp(crop)
      .resize(rects[index].width, rects[index].height, { fit: "contain", background: "#ffffff" })
      .toBuffer(),
    left: rects[index].left,
    top: rects[index].top,
  })));
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
 * Mean luma at which the caption needs no help, and the one at which it needs
 * the full scrim. A navy cap reads around 70 and a studio sweep around 250.
 */
const SCRIM_DARK_ENOUGH = 120;
const SCRIM_FULL_STRENGTH = 210;

/** Strength of the scrim the caption needs over `crop`, from 0 to 1. */
async function scrimStrength(crop: Buffer, rect: Rect): Promise<number> {
  const band = await sharp(crop)
    .extract({ left: 0, top: 0, width: rect.width, height: Math.min(HERO_SCRIM_HEIGHT, rect.height) })
    .greyscale()
    .stats();
  const luma = band.channels[0].mean;
  const span = SCRIM_FULL_STRENGTH - SCRIM_DARK_ENOUGH;
  return Math.min(Math.max((luma - SCRIM_DARK_ENOUGH) / span, 0), 1);
}

/**
 * Caption block laid over the hero crop of the detail page.
 *
 * The caption is white, but the crop behind it is whatever the shoot happened
 * to frame — a macro of a pale cap, or a dark one sitting on a blown-out studio
 * sweep. Without the scrim the text silently vanishes into any light region,
 * which is invisible to every automated check in the pipeline and only shows up
 * once a human looks at the published page. It is scaled by how light the crop
 * actually is rather than always applied: over dark cloth a fixed scrim is a
 * grey wash across the top of the page that the reference set does not have.
 */
function heroCaptionSvg(rect: Rect, caption: HeroCaption, scrim: number): Buffer {
  const padding = 34;
  const inner = rect.width - padding * 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${rect.width}" height="${rect.height}">` +
      `<defs><linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0%" stop-color="#000000" stop-opacity="${(0.62 * scrim).toFixed(3)}"/>` +
        `<stop offset="70%" stop-color="#000000" stop-opacity="${(0.34 * scrim).toFixed(3)}"/>` +
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
 * Slot 11 — a wide hero band carrying the fabric caption, over a grid of the
 * macro crops. Every block is filled edge to edge with a window cropped out of
 * its shot at `DETAIL_ZOOM`, so the article reads at the same distance here as
 * it does on the hand-built reference page.
 */
export async function renderDetailPresentation(
  hero: string,
  gridSources: readonly string[],
  output: string,
  width: number,
  height: number,
  title: PageTitle,
  caption: HeroCaption,
): Promise<void> {
  if (!hero || !gridSources.length) throw new Error("细节展示图没有可用的细节图");
  const { hero: heroGeometry, grid } = PAGE.detail;
  const heroRect: Rect = {
    left: MARGIN,
    top: heroGeometry.top,
    width: width - MARGIN * 2,
    height: heroGeometry.height,
  };
  const gridRects = tileRects(
    Math.min(gridSources.length, 4),
    {
      left: MARGIN,
      top: grid.top,
      width: width - MARGIN * 2,
      height: Math.min(grid.bottom, height) - grid.top,
    },
    grid.gapX,
    grid.gapY,
  );
  const layers = await Promise.all(gridSources.slice(0, 4)
    .map((file, index) => placeZoomed(file, gridRects[index], DETAIL_ZOOM.cell)));
  const heroLayer = await placeZoomed(hero, heroRect, DETAIL_ZOOM.hero, HERO_ANCHOR_Y);
  const scrim = await scrimStrength(heroLayer.input as Buffer, heroRect);
  await sharp({ create: { width, height, channels: 3, background: "#ffffff" } })
    .composite([
      { input: titleSvg(width, title), left: 0, top: 0 },
      heroLayer,
      { input: heroCaptionSvg(heroRect, caption, scrim), left: heroRect.left, top: heroRect.top },
      ...layers,
    ])
    .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
    .toFile(output);
}
