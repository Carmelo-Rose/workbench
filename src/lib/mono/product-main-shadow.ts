import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { ProductShadowTemplateVersion } from "./contracts";
import type { RelativeBox } from "./product-classify";

export const DEFAULT_SHADOW_TEMPLATE_VERSION: ProductShadowTemplateVersion = "hat-shadow-v1";
export const SHADOW_CANVAS_SIZE = 800;
export const SHADOW_PRODUCT_FILL = 0.90;

export type ProductShadowAngle = "oblique-left" | "front" | "top-down" | "side" | "rear";
export type NormalizedPoint = { x: number; y: number };
export type ProductGeometry = { box: RelativeBox; contactAnchor: NormalizedPoint };

type ShadowSourceProvenance = {
  relativePath: string;
  sha256: string;
};

export type ShadowVariantManifest = {
  id: string;
  angle: ProductShadowAngle;
  file: string;
  order: number;
  sha256: string;
  source: ShadowSourceProvenance;
  reference: ProductGeometry;
};

export type ProductShadowManifest = {
  schemaVersion: 1;
  version: ProductShadowTemplateVersion;
  canvas: { width: 800; height: 800 };
  variants: ShadowVariantManifest[];
};

export type LoadedShadowVariant = ShadowVariantManifest & { image: Buffer };
export type LoadedProductShadowBundle = Omit<ProductShadowManifest, "variants"> & {
  root: string;
  variants: LoadedShadowVariant[];
};

export type ShadowAngleAssignment = {
  ordinal?: number;
  angle?: ProductShadowAngle;
  fallbackReason?: string;
};

const ANGLE_BY_ORDINAL: Readonly<Record<number, ProductShadowAngle | undefined>> = {
  1: undefined,
  2: "oblique-left",
  3: "front",
  4: "top-down",
  5: "side",
  6: "rear",
};

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function assertGeometry(value: unknown, label: string): asserts value is ProductGeometry {
  if (!value || typeof value !== "object") throw new Error(`${label} 缺少商品几何信息`);
  const candidate = value as { box?: Partial<RelativeBox>; contactAnchor?: Partial<NormalizedPoint> };
  const box = candidate.box;
  const anchor = candidate.contactAnchor;
  if (!box || !isUnit(box.left) || !isUnit(box.top) || !isUnit(box.width) || !isUnit(box.height)
    || box.width <= 0 || box.height <= 0 || box.left + box.width > 1.001 || box.top + box.height > 1.001) {
    throw new Error(`${label} 的商品包围盒非法`);
  }
  if (!anchor || !isUnit(anchor.x) || !isUnit(anchor.y)) throw new Error(`${label} 的接地点非法`);
}

function shadowBundleBase(): string {
  return path.join(process.cwd(), "config", "product-main-shadows");
}

export function productShadowBundleRoot(version: ProductShadowTemplateVersion): string {
  return path.join(shadowBundleBase(), version);
}

/** Server-only rollout gate. Already-created jobs deliberately do not read it. */
export function isTemplateShadowV2Enabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.PRODUCT_MAIN_V2_ENABLED === "true";
}

function parseManifest(bytes: Buffer, expectedVersion: ProductShadowTemplateVersion): ProductShadowManifest {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")) as unknown; }
  catch { throw new Error("固定阴影模板 manifest 不是有效 JSON"); }
  if (!value || typeof value !== "object") throw new Error("固定阴影模板 manifest 格式错误");
  const manifest = value as Partial<ProductShadowManifest>;
  if (manifest.schemaVersion !== 1 || manifest.version !== expectedVersion) {
    throw new Error("固定阴影模板版本不匹配");
  }
  if (manifest.canvas?.width !== SHADOW_CANVAS_SIZE || manifest.canvas.height !== SHADOW_CANVAS_SIZE) {
    throw new Error("固定阴影模板画布必须是 800×800");
  }
  if (!Array.isArray(manifest.variants) || !manifest.variants.length) {
    throw new Error("固定阴影模板没有可用变体");
  }
  const ids = new Set<string>();
  for (const variant of manifest.variants) {
    if (!variant || typeof variant !== "object" || !/^[a-z0-9-]+$/u.test(variant.id ?? "")) {
      throw new Error("固定阴影模板变体标识非法");
    }
    if (ids.has(variant.id)) throw new Error(`固定阴影模板变体重复：${variant.id}`);
    ids.add(variant.id);
    if (!["oblique-left", "front", "top-down", "side", "rear"].includes(variant.angle)) {
      throw new Error(`固定阴影模板角度非法：${variant.id}`);
    }
    if (!Number.isInteger(variant.order) || variant.order < 0) throw new Error(`固定阴影模板顺序非法：${variant.id}`);
    if (!/^[a-f0-9]{64}$/u.test(variant.sha256)) throw new Error(`固定阴影模板哈希非法：${variant.id}`);
    if (!variant.source || typeof variant.source.relativePath !== "string"
      || !/^[a-f0-9]{64}$/u.test(variant.source.sha256)) {
      throw new Error(`固定阴影模板来源记录非法：${variant.id}`);
    }
    assertGeometry(variant.reference, `固定阴影模板 ${variant.id}`);
  }
  return manifest as ProductShadowManifest;
}

/** Loads and hash-verifies one immutable shadow bundle without consulting the sample share. */
export async function validateProductShadowBundle(
  root: string,
  expectedVersion: ProductShadowTemplateVersion,
): Promise<LoadedProductShadowBundle> {
  const resolvedRoot = await realpath(root);
  const manifest = parseManifest(await readFile(path.join(resolvedRoot, "manifest.json")), expectedVersion);
  const variants = await Promise.all(manifest.variants.map(async (variant) => {
    if (path.basename(variant.file) !== variant.file || path.extname(variant.file).toLowerCase() !== ".png") {
      throw new Error(`固定阴影模板路径非法：${variant.id}`);
    }
    const candidate = path.resolve(resolvedRoot, variant.file);
    if (path.dirname(candidate) !== resolvedRoot) throw new Error(`固定阴影模板越界：${variant.id}`);
    const actual = await realpath(candidate);
    if (path.dirname(actual) !== resolvedRoot) throw new Error(`固定阴影模板越界：${variant.id}`);
    const image = await readFile(actual);
    if (sha256(image) !== variant.sha256) throw new Error(`固定阴影模板哈希不匹配：${variant.id}`);
    const metadata = await sharp(image).metadata();
    if (metadata.width !== SHADOW_CANVAS_SIZE || metadata.height !== SHADOW_CANVAS_SIZE || !metadata.hasAlpha) {
      throw new Error(`固定阴影模板必须是 800×800 透明 PNG：${variant.id}`);
    }
    return { ...variant, image };
  }));
  return { ...manifest, root: resolvedRoot, variants };
}

export function loadProductShadowBundle(
  version: ProductShadowTemplateVersion = DEFAULT_SHADOW_TEMPLATE_VERSION,
): Promise<LoadedProductShadowBundle> {
  return validateProductShadowBundle(productShadowBundleRoot(version), version);
}

function lastNumericToken(file: string): number | undefined {
  const matches = path.parse(file).name.match(/\d+/gu);
  if (!matches?.length) return undefined;
  const value = Number(matches.at(-1));
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Assigns the fixed six-frame shoot contract inside every colour group.
 * Paths are already in folder/numeric order; numeric tokens are checked again
 * so a renamed or duplicate frame cannot silently shift every later angle.
 */
export function buildShadowAngleAssignments(
  colors: readonly { members: readonly { path: string }[] }[],
): Map<string, ShadowAngleAssignment> {
  const assignments = new Map<string, ShadowAngleAssignment>();
  for (const color of colors) {
    if (color.members.length !== 6) {
      for (const member of color.members) {
        assignments.set(member.path, { fallbackReason: `颜色组不是标准六角度（实际 ${color.members.length} 张）` });
      }
      continue;
    }
    const tokens = color.members.map((member) => lastNumericToken(member.path));
    const ordered = tokens.every((token, index) => token !== undefined && (index === 0 || token > tokens[index - 1]!));
    if (!ordered) {
      for (const member of color.members) assignments.set(member.path, { fallbackReason: "颜色组文件数字顺序缺失或重复" });
      continue;
    }
    color.members.forEach((member, index) => {
      const ordinal = index + 1;
      const angle = ANGLE_BY_ORDINAL[ordinal];
      assignments.set(member.path, angle
        ? { ordinal, angle }
        : { ordinal, fallbackReason: "组内序号 1 暂无固定阴影模板" });
    });
  }
  return assignments;
}

function geometryDistance(first: ProductGeometry, second: ProductGeometry): number {
  const firstCenterX = first.box.left + first.box.width / 2;
  const firstCenterY = first.box.top + first.box.height / 2;
  const secondCenterX = second.box.left + second.box.width / 2;
  const secondCenterY = second.box.top + second.box.height / 2;
  return (firstCenterX - secondCenterX) ** 2
    + (firstCenterY - secondCenterY) ** 2
    + (first.box.width - second.box.width) ** 2
    + (first.box.height - second.box.height) ** 2
    + (first.contactAnchor.x - second.contactAnchor.x) ** 2
    + (first.contactAnchor.y - second.contactAnchor.y) ** 2;
}

export function selectShadowVariant(
  bundle: LoadedProductShadowBundle,
  angle: ProductShadowAngle,
  geometry: ProductGeometry,
): LoadedShadowVariant | undefined {
  return bundle.variants
    .filter((variant) => variant.angle === angle)
    .sort((first, second) => (
      geometryDistance(first.reference, geometry) - geometryDistance(second.reference, geometry)
      || first.order - second.order
      || first.id.localeCompare(second.id)
    ))[0];
}

async function cropBufferToBox(buffer: Buffer, box: RelativeBox, padding: number): Promise<Buffer> {
  const { width, height } = await sharp(buffer).metadata();
  if (!width || !height) throw new Error("无法读取固定阴影商品前景尺寸");
  const left = Math.max(0, Math.floor((box.left - padding) * width));
  const top = Math.max(0, Math.floor((box.top - padding) * height));
  const right = Math.min(width, Math.ceil((box.left + box.width + padding) * width));
  const bottom = Math.min(height, Math.ceil((box.top + box.height + padding) * height));
  return sharp(buffer).extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }).png().toBuffer();
}

export async function measureAlphaGeometry(image: Buffer): Promise<ProductGeometry> {
  const metadata = await sharp(image).metadata();
  if (!metadata.width || !metadata.height || !metadata.hasAlpha) throw new Error("固定阴影商品前景必须带透明通道");
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width, top = info.height, right = -1, bottom = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * info.channels + 3] < 128) continue;
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  if (right < 0) throw new Error("固定阴影商品前景为空");
  const contactBandTop = Math.max(top, bottom - Math.max(2, Math.round((bottom - top + 1) * 0.03)));
  let contactX = 0, contactCount = 0;
  for (let y = contactBandTop; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      if (data[(y * info.width + x) * info.channels + 3] < 128) continue;
      contactX += x; contactCount += 1;
    }
  }
  return {
    box: {
      left: left / info.width,
      top: top / info.height,
      width: (right - left + 1) / info.width,
      height: (bottom - top + 1) / info.height,
    },
    contactAnchor: {
      x: (contactCount ? contactX / contactCount : (left + right) / 2) / info.width,
      y: bottom / info.height,
    },
  };
}

const WHITE_FIELD_SPILL_MIN_PRODUCT_RATIO = 0.25;
const WHITE_FIELD_SPILL_LARGE_COMPONENT_MIN_PIXELS = 2_048;
const WHITE_FIELD_SPILL_LARGE_COMPONENT_MIN_SOLIDITY = 0.18;

function isWhiteFieldPixel(data: Buffer, offset: number): boolean {
  const red = data[offset];
  const green = data[offset + 1];
  const blue = data[offset + 2];
  return red >= 235 && green >= 235 && blue >= 235
    && Math.max(red, green, blue) - Math.min(red, green, blue) <= 8;
}

/**
 * Removes opaque paper-white islands accidentally returned by the second
 * cutout over a WhiteField plate.
 *
 * BiRefNet can remember the outline of the former cast shadow even after that
 * shadow has been divided back to pure white. It is invisible in a normal SKU
 * (white-on-white), but punches conspicuous white holes through a fixed shadow
 * placed underneath. Flooding the actual white plate from the canvas edge
 * removes only white pixels connected to the backdrop; enclosed light details
 * such as embroidery remain part of a dark product. Predominantly light
 * products fail open to the original matte because white-on-white cannot be
 * decided safely from pixels alone.
 */
export async function removeWhiteFieldForegroundSpill(
  foreground: Buffer,
): Promise<{ foreground: Buffer; box: RelativeBox; removedPixels: number }> {
  const { data, info } = await sharp(foreground).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const pixelCount = width * height;
  let alphaPixels = 0;
  let nonWhiteProductPixels = 0;
  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * channels;
    if (data[offset + 3] < 128) continue;
    alphaPixels += 1;
    if (!isWhiteFieldPixel(data, offset)) nonWhiteProductPixels += 1;
  }
  if (!alphaPixels) throw new Error("白场归一前景为空");

  const original = await sharp(foreground).ensureAlpha().png().toBuffer();
  if (nonWhiteProductPixels / alphaPixels < WHITE_FIELD_SPILL_MIN_PRODUCT_RATIO) {
    const geometry = await measureAlphaGeometry(original);
    return { foreground: original, box: geometry.box, removedPixels: 0 };
  }

  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let head = 0;
  let tail = 0;
  const enqueue = (index: number): void => {
    if (visited[index]) return;
    const offset = index * channels;
    if (!isWhiteFieldPixel(data, offset)) return;
    visited[index] = 1;
    queue[tail] = index;
    tail += 1;
  };
  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }
  while (head < tail) {
    const index = queue[head];
    head += 1;
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) enqueue(index - 1);
    if (x + 1 < width) enqueue(index + 1);
    if (y > 0) enqueue(index - width);
    if (y + 1 < height) enqueue(index + width);
  }

  // Enclosed paper-white islands are not connected to the canvas edge, but a
  // second cutout can still leave a large low-texture plate under a dark
  // product. Remove only large, reasonably solid components; small or sparse
  // components remain available for embroidery and other true light details.
  const edgeConnectedWhite = Uint8Array.from(visited);
  const componentQueue = new Int32Array(pixelCount);
  const enclosedSpill = new Uint8Array(pixelCount);
  for (let start = 0; start < pixelCount; start += 1) {
    if (visited[start] || !isWhiteFieldPixel(data, start * channels)) continue;
    let componentHead = 0;
    let componentTail = 0;
    let left = width;
    let top = height;
    let right = -1;
    let bottom = -1;
    visited[start] = 1;
    componentQueue[componentTail] = start;
    componentTail += 1;
    while (componentHead < componentTail) {
      const index = componentQueue[componentHead];
      componentHead += 1;
      const x = index % width;
      const y = Math.floor(index / width);
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
      const neighbors = [
        x > 0 ? index - 1 : -1,
        x + 1 < width ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y + 1 < height ? index + width : -1,
      ];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || visited[neighbor]
          || !isWhiteFieldPixel(data, neighbor * channels)) continue;
        visited[neighbor] = 1;
        componentQueue[componentTail] = neighbor;
        componentTail += 1;
      }
    }
    const componentArea = componentTail;
    const boundingArea = Math.max(1, (right - left + 1) * (bottom - top + 1));
    const solidity = componentArea / boundingArea;
    if (componentArea < WHITE_FIELD_SPILL_LARGE_COMPONENT_MIN_PIXELS
      || (solidity < WHITE_FIELD_SPILL_LARGE_COMPONENT_MIN_SOLIDITY && componentArea < 8_192)) continue;
    for (let index = 0; index < componentTail; index += 1) enclosedSpill[componentQueue[index]] = 1;
  }

  const alpha = Buffer.alloc(pixelCount);
  let removedPixels = 0;
  for (let index = 0; index < pixelCount; index += 1) {
    const value = data[index * channels + 3];
    if (value >= 128 && (edgeConnectedWhite[index] || enclosedSpill[index])) {
      removedPixels += 1;
      alpha[index] = 0;
    } else {
      alpha[index] = value;
    }
  }
  const rgb = await sharp(foreground).removeAlpha().png().toBuffer();
  const alphaImage = await sharp(alpha, { raw: { width, height, channels: 1 } }).png().toBuffer();
  const cleaned = await sharp(rgb).joinChannel(alphaImage).png().toBuffer();
  const geometry = await measureAlphaGeometry(cleaned);
  return { foreground: cleaned, box: geometry.box, removedPixels };
}

export async function prepareTemplateShadowForeground(
  foreground: Buffer,
  box: RelativeBox,
  reference?: ProductGeometry,
): Promise<{ image: Buffer; geometry: ProductGeometry }> {
  const cropped = await cropBufferToBox(foreground, box, 0.01);
  const targetWidth = Math.round(SHADOW_CANVAS_SIZE * (reference?.box.width ?? SHADOW_PRODUCT_FILL));
  const targetHeight = Math.round(SHADOW_CANVAS_SIZE * (reference?.box.height ?? SHADOW_PRODUCT_FILL));
  const { data: resized, info } = await sharp(cropped)
    .resize(targetWidth, targetHeight, { fit: "inside" })
    .png()
    .toBuffer({ resolveWithObject: true });
  const resizedGeometry = await measureAlphaGeometry(resized);
  const left = reference
    ? Math.round(reference.contactAnchor.x * SHADOW_CANVAS_SIZE - resizedGeometry.contactAnchor.x * info.width)
    : Math.round((SHADOW_CANVAS_SIZE - info.width) / 2);
  const top = reference
    ? Math.round(reference.contactAnchor.y * SHADOW_CANVAS_SIZE - resizedGeometry.contactAnchor.y * info.height)
    : Math.round((SHADOW_CANVAS_SIZE - info.height) / 2);
  const image = await sharp({
    create: { width: SHADOW_CANVAS_SIZE, height: SHADOW_CANVAS_SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite([{ input: resized, left, top }]).png().toBuffer();
  return { image, geometry: await measureAlphaGeometry(image) };
}

async function placeTransformedShadow(
  variant: LoadedShadowVariant,
  target: ProductGeometry,
): Promise<{ input: Buffer; left: number; top: number }> {
  const sourceArea = variant.reference.box.width * variant.reference.box.height;
  const targetArea = target.box.width * target.box.height;
  const scale = Math.min(2, Math.max(0.5, Math.sqrt(targetArea / sourceArea)));
  const width = Math.max(1, Math.round(SHADOW_CANVAS_SIZE * scale));
  const height = Math.max(1, Math.round(SHADOW_CANVAS_SIZE * scale));
  let left = Math.round(target.contactAnchor.x * SHADOW_CANVAS_SIZE - variant.reference.contactAnchor.x * width);
  let top = Math.round(target.contactAnchor.y * SHADOW_CANVAS_SIZE - variant.reference.contactAnchor.y * height);
  const cropLeft = Math.max(0, -left);
  const cropTop = Math.max(0, -top);
  const cropWidth = Math.min(width - cropLeft, SHADOW_CANVAS_SIZE - Math.max(0, left));
  const cropHeight = Math.min(height - cropTop, SHADOW_CANVAS_SIZE - Math.max(0, top));
  if (cropWidth <= 0 || cropHeight <= 0) throw new Error(`固定阴影变换后越出画布：${variant.id}`);
  const resized = await sharp(variant.image).resize(width, height, { fit: "fill" }).png().toBuffer();
  const input = cropLeft || cropTop || cropWidth !== width || cropHeight !== height
    ? await sharp(resized).extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight }).png().toBuffer()
    : resized;
  left = Math.max(0, left);
  top = Math.max(0, top);
  return { input, left, top };
}

export async function composeTemplateShadowMain(
  product: { image: Buffer; geometry: ProductGeometry },
  variant: LoadedShadowVariant,
): Promise<Buffer> {
  // The foreground is placed against this exact reference geometry before we
  // get here. Keeping the shadow at its authored coordinates preserves the
  // template's deliberately different crop, scale and contact point per angle.
  const shadow = await placeTransformedShadow(variant, variant.reference);
  return sharp({
    create: { width: SHADOW_CANVAS_SIZE, height: SHADOW_CANVAS_SIZE, channels: 3, background: "#ffffff" },
  })
    .composite([
      { input: shadow.input, left: shadow.left, top: shadow.top },
      { input: product.image, left: 0, top: 0 },
    ])
    .removeAlpha()
    .png()
    .toBuffer();
}
