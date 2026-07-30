import sharp from "sharp";

/**
 * Source-set classification for the product pipeline.
 *
 * A product folder is an unedited studio shoot: several colourways of the same
 * article, each photographed from the same fixed set of angles, plus a trailing
 * group of macro crops.  Nothing in the folder names the colourway, so the
 * pipeline has to recover that structure from pixels alone before it can decide
 * which product reference belongs in which detail slot.
 */

/** Downscale target for measurement. Large enough to be stable, small enough to stay cheap. */
const PROBE_WIDTH = 200;
const PROBE_HEIGHT = 133;

/**
 * A macro crop runs off the edge of the frame; a full-article shot sits inside
 * it with studio margin.  Measured across a reference shoot the two populations
 * were 0-2.1% and 28.6-54.4% edge occupancy, so anything in the wide gap
 * between them is treated as a crop.
 */
export const DETAIL_EDGE_RATIO_THRESHOLD = 0.1;

/**
 * Complete-linkage cutoff in CIE76 ΔE. On the reference shoot the widest spread
 * inside one colourway was ~7.3 and the closest distance between two colourways
 * was ~17.7, so this sits in the gap with margin on both sides.
 */
export const COLOR_MERGE_DELTA_E = 12;

/**
 * Floor below which a frame holds no article at all.
 *
 * A white master whose cutout failed is a blank white canvas; left in, it would
 * cluster as a phantom white colourway and could even win a model slot. Real
 * frames in a reference shoot run around 21-25% whatever the colourway, so this
 * sits orders of magnitude below anything genuine.
 */
export const MIN_PRODUCT_COVERAGE = 0.005;

/**
 * Background is the white master's sweep; anything darker or coloured is product.
 *
 * The cutoff has to clear the brightest article we ship, not just the sweep. A
 * cream cap on white peaks around 244, so at the old 225 only its shadowed
 * creases counted as product: the measured box stopped short of the crown and
 * the tiled page published a cap with its back sliced off. Across the reference
 * shoot the box stops moving once the cutoff passes 242, while JPEG ringing
 * along the cutout edge only starts leaking in at 254.
 */
const BACKGROUND_MAX_CHANNEL = 246;
const BACKGROUND_MAX_CHROMA = 22;

export type Lab = readonly [L: number, a: number, b: number];

/** Product extent as a fraction of the frame, so it survives any later resize. */
export type RelativeBox = { left: number; top: number; width: number; height: number };

export type SourceMetric = {
  /** Mean CIE L*a*b* of the product pixels. */
  lab: Lab;
  /** Share of the frame occupied by product pixels. */
  coverage: number;
  /** Share of the frame border occupied by product pixels. */
  edgeRatio: number;
  /** Tight box around the product pixels. */
  box: RelativeBox;
};

export type MeasuredSource = { path: string; metric: SourceMetric };

export type ColorGroup = {
  /** 0 is the hero colourway; it receives the most model slots. */
  rank: number;
  lab: Lab;
  /** Members in their original folder order, which is the shoot's angle order. */
  members: MeasuredSource[];
  /** Clean catalogue angle selected from this colourway's ordered shoot. */
  representative: MeasuredSource;
};

export type ClassifyOptions = {
  /**
   * Set when the folder ships `x_`-named macro crops. Those never reach the
   * master set, so the classifier would otherwise report the detail page as
   * falling back to whole-article angles when it is not.
   */
  hasNamedDetailShots?: boolean;
};

/**
 * The standard shoot records five angles per colourway. Frame three is the
 * clean catalogue three-quarter view used by the approved SKU references: the
 * brim edge is visible without the broad underside/table shadow exposed by
 * frame one. Short/incomplete shoots fall back to their last available frame.
 */
export function catalogueRepresentative(members: readonly MeasuredSource[]): MeasuredSource {
  if (!members.length) throw new Error("颜色组缺少可用的商品角度");
  return members[Math.min(2, members.length - 1)];
}

export type SourceClassification = {
  /**
   * Macro crops ordered for the detail page: hero colourway first, fullest
   * frame first within each colourway.
   */
  details: MeasuredSource[];
  /** Colourways, hero first. */
  colors: ColorGroup[];
  /** Whatever the run should surface to a human afterwards. */
  warnings: string[];
};

function srgbToLab(r: number, g: number, b: number): Lab {
  const linear = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [linear(r), linear(g), linear(b)];
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

export function deltaE(first: Lab, second: Lab): number {
  return Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]);
}

/** Mean product colour, frame coverage and border occupancy of one shot. */
export async function measureProductImage(file: string): Promise<SourceMetric> {
  const { data, info } = await sharp(file)
    .resize(PROBE_WIDTH, PROBE_HEIGHT, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let red = 0, green = 0, blue = 0, product = 0, edgeProduct = 0, edgeTotal = 0;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      const [r, g, b] = [data[offset], data[offset + 1], data[offset + 2]];
      const isProduct = Math.max(r, g, b) < BACKGROUND_MAX_CHANNEL
        || Math.max(r, g, b) - Math.min(r, g, b) > BACKGROUND_MAX_CHROMA;
      if (x < 2 || y < 2 || x >= width - 2 || y >= height - 2) {
        edgeTotal += 1;
        if (isProduct) edgeProduct += 1;
      }
      if (isProduct) {
        red += r; green += g; blue += b; product += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  const whole: RelativeBox = { left: 0, top: 0, width: 1, height: 1 };
  if (!product) return { lab: [100, 0, 0], coverage: 0, edgeRatio: 0, box: whole };
  return {
    lab: srgbToLab(red / product, green / product, blue / product),
    coverage: product / (width * height),
    edgeRatio: edgeTotal ? edgeProduct / edgeTotal : 0,
    box: {
      left: minX / width,
      top: minY / height,
      width: (maxX - minX + 1) / width,
      height: (maxY - minY + 1) / height,
    },
  };
}

/**
 * Crop a shot down to the article plus a little breathing room.
 *
 * Studio frames leave most of the canvas empty, which would otherwise shrink the
 * article to a speck once it is letterboxed into a tile.
 */
export async function cropToProduct(file: string, box: RelativeBox, padding = 0.04): Promise<Buffer> {
  const image = sharp(file);
  const { width, height } = await image.metadata();
  if (!width || !height) throw new Error(`无法读取图片尺寸：${file}`);
  const left = Math.max(0, Math.round((box.left - padding) * width));
  const top = Math.max(0, Math.round((box.top - padding) * height));
  const right = Math.min(width, Math.round((box.left + box.width + padding) * width));
  const bottom = Math.min(height, Math.round((box.top + box.height + padding) * height));
  if (right - left < 8 || bottom - top < 8) return image.toBuffer();
  return image.extract({ left, top, width: right - left, height: bottom - top }).toBuffer();
}

/**
 * Share of a generated frame that sits within `tolerance` ΔE of `target`.
 *
 * Used as a coarse "is the right colourway even in this picture" signal on
 * generated model shots, where the article cannot be segmented reliably.
 */
export async function measureColorPresence(file: string, target: Lab, tolerance: number): Promise<number> {
  const { data, info } = await sharp(file)
    .resize(PROBE_WIDTH, PROBE_HEIGHT, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let matched = 0;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    const lab = srgbToLab(data[offset], data[offset + 1], data[offset + 2]);
    if (deltaE(lab, target) <= tolerance) matched += 1;
  }
  return matched / (info.width * info.height);
}

type Cluster = { indices: number[]; lab: Lab };

function centroid(items: readonly MeasuredSource[], indices: readonly number[]): Lab {
  const total = indices.reduce<[number, number, number]>(
    (sum, index) => {
      const [L, a, b] = items[index].metric.lab;
      return [sum[0] + L, sum[1] + a, sum[2] + b];
    },
    [0, 0, 0],
  );
  return [total[0] / indices.length, total[1] / indices.length, total[2] / indices.length];
}

/**
 * Complete-linkage agglomerative clustering. Complete linkage (rather than the
 * cheaper single linkage) keeps a cluster's diameter under the cutoff, so a run
 * of gradually shifting shots cannot chain two genuinely different colourways
 * into one group.
 */
export function clusterByColor(
  items: readonly MeasuredSource[],
  threshold = COLOR_MERGE_DELTA_E,
): { indices: number[]; lab: Lab }[] {
  let clusters: Cluster[] = items.map((item, index) => ({ indices: [index], lab: item.metric.lab }));
  for (;;) {
    let best: { a: number; b: number; distance: number } | null = null;
    for (let a = 0; a < clusters.length; a += 1) {
      for (let b = a + 1; b < clusters.length; b += 1) {
        // Complete linkage: the pair's distance is its widest member-to-member gap.
        let widest = 0;
        for (const left of clusters[a].indices) {
          for (const right of clusters[b].indices) {
            widest = Math.max(widest, deltaE(items[left].metric.lab, items[right].metric.lab));
          }
        }
        if (widest <= threshold && (!best || widest < best.distance)) best = { a, b, distance: widest };
      }
    }
    if (!best) break;
    const merged = [...clusters[best.a].indices, ...clusters[best.b].indices].sort((x, y) => x - y);
    clusters = clusters.filter((_, index) => index !== best!.a && index !== best!.b);
    clusters.push({ indices: merged, lab: centroid(items, merged) });
  }
  return clusters.map((cluster) => ({ indices: [...cluster.indices].sort((a, b) => a - b), lab: cluster.lab }));
}

/**
 * Spread `slotCount` model slots across the available colourways: divide evenly
 * and hand every remainder slot to the highest-ranked colours, so the hero
 * colourway is always the best represented. With three colours and seven slots
 * this reproduces the 3/2/2 split used by the hand-built reference set.
 */
export function allocateModelSlots(colorCount: number, slotCount: number): number[] {
  if (colorCount <= 1) return Array.from({ length: slotCount }, () => 0);
  const usable = Math.min(colorCount, slotCount);
  const base = Math.floor(slotCount / usable);
  const remainder = slotCount % usable;
  const allocation: number[] = [];
  for (let rank = 0; rank < usable; rank += 1) {
    const share = base + (rank < remainder ? 1 : 0);
    for (let n = 0; n < share; n += 1) allocation.push(rank);
  }
  return allocation;
}

/**
 * Recover colourways and macro crops from an unlabelled shoot.
 *
 * Order matters: crops are removed first. A macro crop of a dark lining reads as
 * a near-black colour that does not exist as a colourway, and would otherwise
 * either invent a fourth group or drag the black centroid off its true value.
 */
export function classifySources(
  measured: readonly MeasuredSource[],
  options: ClassifyOptions = {},
): SourceClassification {
  const warnings: string[] = [];
  const blank = measured.filter((item) => item.metric.coverage < MIN_PRODUCT_COVERAGE);
  if (blank.length) {
    warnings.push(`${blank.length} 张白底主图几乎是空白，可能抠图失败，已排除在颜色识别之外`);
  }
  const usable = measured.filter((item) => item.metric.coverage >= MIN_PRODUCT_COVERAGE);
  const details = usable.filter((item) => item.metric.edgeRatio > DETAIL_EDGE_RATIO_THRESHOLD);
  const fullShots = usable.filter((item) => item.metric.edgeRatio <= DETAIL_EDGE_RATIO_THRESHOLD);
  if (!fullShots.length) throw new Error("原图里没有可用的商品整体图，全部被判定为细节特写或空白");

  const clusters = clusterByColor(fullShots);
  const nearestCluster = (lab: Lab): number => {
    let nearest = 0;
    let distance = Number.POSITIVE_INFINITY;
    clusters.forEach((cluster, index) => {
      const candidate = deltaE(lab, cluster.lab);
      if (candidate < distance) { distance = candidate; nearest = index; }
    });
    return nearest;
  };

  // The hero colourway is whichever one the detail crops were shot on: the
  // shoot convention is that macro detail is captured on the pushed colour.
  const detailVotes = new Map<number, number>();
  for (const detail of details) {
    const nearest = nearestCluster(detail.metric.lab);
    detailVotes.set(nearest, (detailVotes.get(nearest) ?? 0) + 1);
  }

  const ranked = clusters
    .map((cluster, index) => ({ ...cluster, index, votes: detailVotes.get(index) ?? 0 }))
    .sort((a, b) => b.votes - a.votes || b.indices.length - a.indices.length || a.lab[0] - b.lab[0]);
  const rankByClusterIndex = new Map(ranked.map((cluster, rank) => [cluster.index, rank] as const));

  // The caller may already hold detail crops the classifier never saw — the
  // `x_` shots are kept out of the master set on purpose — so only warn about a
  // fallback that is actually going to happen.
  if (!details.length && !options.hasNamedDetailShots) {
    warnings.push("原图里没有细节特写，主推色改用出图数量最多的颜色；细节展示图将改用整体图拼版");
  } else if (!details.length) {
    warnings.push("主推色改用出图数量最多的颜色（细节图由 x_ 命名的特写提供，不参与颜色识别）");
  }
  const sizes = new Set(ranked.map((cluster) => cluster.indices.length));
  if (sizes.size > 1) {
    warnings.push(`各颜色的原图张数不一致（${ranked.map((c) => c.indices.length).join("/")}），请确认拍摄是否有漏拍或废片`);
  }

  // Detail crops carry a colourway too. Grouping them keeps a stray shot of a
  // different colour (a dark lining, say) out of the hero colour's detail page,
  // while still leaving it available if the hero has too few frames.
  const detailRank = new Map(details.map((item) =>
    [item, rankByClusterIndex.get(nearestCluster(item.metric.lab)) ?? 0] as const));
  const orderedDetails = [...details].sort((a, b) =>
    (detailRank.get(a)! - detailRank.get(b)!) || (b.metric.coverage - a.metric.coverage));

  return {
    details: orderedDetails,
    colors: ranked.map((cluster, rank) => {
      const members = cluster.indices.map((index) => fullShots[index]);
      return { rank, lab: cluster.lab, members, representative: catalogueRepresentative(members) };
    }),
    warnings,
  };
}

/** Measure and classify a folder's white-master set. */
export async function classifyProductSources(
  masters: readonly string[],
  options: ClassifyOptions = {},
): Promise<SourceClassification> {
  const measured = await Promise.all(
    masters.map(async (file) => ({ path: file, metric: await measureProductImage(file) })),
  );
  return classifySources(measured, options);
}
