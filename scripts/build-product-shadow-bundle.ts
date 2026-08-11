import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import sharp from "sharp";
import {
  DEFAULT_SHADOW_TEMPLATE_VERSION,
  SHADOW_CANVAS_SIZE,
  measureAlphaGeometry,
  type ProductShadowAngle,
  type ProductShadowManifest,
  type ShadowVariantManifest,
} from "@/lib/mono/product-main-shadow";

loadEnvConfig(process.cwd());

type Sample = {
  id: string;
  angle: ProductShadowAngle;
  order: number;
  relativePath: string;
};

const SAMPLES: readonly Sample[] = [
  { id: "oblique-left-a", angle: "oblique-left", order: 0, relativePath: path.join("左", "1786364938666.png") },
  { id: "oblique-left-b", angle: "oblique-left", order: 1, relativePath: path.join("左", "SKU 2.jpg") },
  { id: "front-a", angle: "front", order: 0, relativePath: path.join("前", "1 拷贝 5.jpg") },
  { id: "front-b", angle: "front", order: 1, relativePath: path.join("前", "1786367481972.jpg") },
  { id: "top-down", angle: "top-down", order: 0, relativePath: path.join("竖", "1440 8.jpg") },
  { id: "side", angle: "side", order: 0, relativePath: path.join("侧", "画板 1 拷贝 4-2.jpg") },
  { id: "rear", angle: "rear", order: 0, relativePath: path.join("后", "1786367451673.jpg") },
];

const GROUND_START_BY_ANGLE: Readonly<Record<ProductShadowAngle, number>> = {
  "oblique-left": 0.58,
  front: 0.82,
  "top-down": 0,
  side: 0.78,
  rear: 0.65,
};

const COMPLETION_STRENGTH_BY_ANGLE: Readonly<Record<ProductShadowAngle, number>> = {
  "oblique-left": 0.25,
  front: 0.25,
  "top-down": 0.25,
  side: 0.35,
  rear: 0.25,
};

const COMPLETION_RADIUS_BY_ANGLE: Readonly<Record<ProductShadowAngle, number>> = {
  "oblique-left": 160,
  front: 240,
  "top-down": 160,
  side: 200,
  rear: 180,
};

// Low-opacity pixels from the fitted white plate are useful as a soft penumbra
// only while they remain attached to a real cast-shadow core. A whole filled
// completion rectangle at alpha 1-15 reads as a white block after compositing
// onto a white product plate, so each approved angle has an explicit floor.
const MIN_SHADOW_ALPHA_BY_ANGLE: Readonly<Record<ProductShadowAngle, number>> = {
  "oblique-left": 64,
  front: 64,
  "top-down": 12,
  side: 64,
  rear: 64,
};

function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/build-product-shadow-bundle.ts --source-root <test folder> [--output-dir <bundle>]",
    "  npx tsx scripts/build-product-shadow-bundle.ts --verify [--output-dir <bundle>]",
    "",
    "The builder reads seven approved flattened samples, uses the checked-in",
    "WhiteField workflow to recover transmittance + product protection masks,",
    "then publishes immutable 800×800 RGBA shadow assets and a hash manifest.",
  ].join("\n");
}

function option(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function canonicalComponent(image: Buffer, background: string): Promise<Buffer> {
  return sharp(image)
    .resize(SHADOW_CANVAS_SIZE, SHADOW_CANVAS_SIZE, { fit: "contain", background, withoutEnlargement: true })
    .extend({
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      background,
    })
    .resize(SHADOW_CANVAS_SIZE, SHADOW_CANVAS_SIZE, { fit: "contain", background })
    .removeAlpha()
    .png()
    .toBuffer();
}

function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const horizontal = new Uint8Array(mask.length);
  const output = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = 0;
      for (let dx = -radius; dx <= radius && !value; dx += 1) {
        const candidate = x + dx;
        if (candidate >= 0 && candidate < width) value = mask[y * width + candidate];
      }
      horizontal[y * width + x] = value;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = 0;
      for (let dy = -radius; dy <= radius && !value; dy += 1) {
        const candidate = y + dy;
        if (candidate >= 0 && candidate < height) value = horizontal[candidate * width + x];
      }
      output[y * width + x] = value;
    }
  }
  return output;
}

function completeOccludedAlpha(
  base: Buffer,
  occluded: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Buffer {
  const pixelCount = width * height;
  const distance = new Int16Array(pixelCount);
  distance.fill(-1);
  const nearestAlpha = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let head = 0;
  let tail = 0;
  for (let index = 0; index < pixelCount; index += 1) {
    if (base[index] < 2) continue;
    distance[index] = 0;
    nearestAlpha[index] = base[index];
    queue[tail] = index;
    tail += 1;
  }
  while (head < tail) {
    const index = queue[head];
    head += 1;
    const nextDistance = distance[index] + 1;
    if (nextDistance > radius) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    const neighbors = [
      x > 0 ? index - 1 : -1,
      x + 1 < width ? index + 1 : -1,
      y > 0 ? index - width : -1,
      y + 1 < height ? index + width : -1,
    ];
    for (const neighbor of neighbors) {
      if (neighbor < 0 || distance[neighbor] >= 0) continue;
      distance[neighbor] = nextDistance;
      nearestAlpha[neighbor] = nearestAlpha[index];
      queue[tail] = neighbor;
      tail += 1;
    }
  }
  const output = Buffer.from(base);
  for (let index = 0; index < pixelCount; index += 1) {
    if (!occluded[index] || distance[index] <= 0 || distance[index] > radius) continue;
    const decay = 1 - (distance[index] / radius) * 0.75;
    output[index] = Math.max(output[index], Math.round(nearestAlpha[index] * decay));
  }
  return output;
}

function boxBlur(input: Buffer, width: number, height: number, radius: number): Uint8Array {
  const horizontal = new Float32Array(input.length);
  const output = new Uint8Array(input.length);
  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    for (let x = -radius; x <= radius; x += 1) {
      sum += input[y * width + Math.min(width - 1, Math.max(0, x))];
    }
    for (let x = 0; x < width; x += 1) {
      horizontal[y * width + x] = sum / (radius * 2 + 1);
      const outgoing = Math.min(width - 1, Math.max(0, x - radius));
      const incoming = Math.min(width - 1, Math.max(0, x + radius + 1));
      sum += input[y * width + incoming] - input[y * width + outgoing];
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = -radius; y <= radius; y += 1) {
      sum += horizontal[Math.min(height - 1, Math.max(0, y)) * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      output[y * width + x] = Math.round(sum / (radius * 2 + 1));
      const outgoing = Math.min(height - 1, Math.max(0, y - radius));
      const incoming = Math.min(height - 1, Math.max(0, y + radius + 1));
      sum += horizontal[incoming * width + x] - horizontal[outgoing * width + x];
    }
  }
  return output;
}

/**
 * Keeps only the largest connected shadow component. The extraction workflow
 * can return a faint paper/stand fragment away from the grounded cast shadow;
 * publishing that fragment makes the product look like it is floating. The
 * largest component is the grounded shadow for all approved angle samples.
 */
function retainLargestShadowComponent(alpha: Buffer, width: number, height: number): Buffer {
  const componentThreshold = 16;
  const pixelCount = width * height;
  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let head = 0;
  let tail = 0;
  let largestStart = 0;
  let largestLength = 0;
  for (let start = 0; start < pixelCount; start += 1) {
    if (visited[start] || alpha[start] < componentThreshold) continue;
    const componentStart = tail;
    visited[start] = 1;
    queue[tail] = start;
    tail += 1;
    while (head < tail) {
      const index = queue[head];
      head += 1;
      const x = index % width;
      const y = Math.floor(index / width);
      const neighbors = [
        x > 0 ? index - 1 : -1,
        x + 1 < width ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y + 1 < height ? index + width : -1,
      ];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || visited[neighbor] || alpha[neighbor] < componentThreshold) continue;
        visited[neighbor] = 1;
        queue[tail] = neighbor;
        tail += 1;
      }
    }
    const componentLength = tail - componentStart;
    if (componentLength > largestLength) {
      largestStart = componentStart;
      largestLength = componentLength;
    }
  }
  const output = Buffer.alloc(pixelCount);
  for (let index = largestStart; index < largestStart + largestLength; index += 1) {
    output[queue[index]] = alpha[queue[index]];
  }
  return output;
}

function applyShadowAlphaFloor(alpha: Buffer, threshold: number): Buffer {
  const output = Buffer.alloc(alpha.length);
  for (let index = 0; index < alpha.length; index += 1) {
    const value = alpha[index];
    output[index] = value < threshold
      ? 0
      : Math.min(255, Math.round(((value - threshold) * 255) / (255 - threshold)));
  }
  return output;
}

async function makeShadowAsset(
  transmittance: Buffer,
  protectImage: Buffer,
  angle: ProductShadowAngle,
): Promise<{
  image: Buffer;
  reference: ShadowVariantManifest["reference"];
  coverage: number;
}> {
  const [canonicalTransmittance, canonicalProtect] = await Promise.all([
    canonicalComponent(transmittance, "#ffffff"),
    canonicalComponent(protectImage, "#000000"),
  ]);
  const [{ data: trans, info }, { data: protect, info: protectInfo }] = await Promise.all([
    sharp(canonicalTransmittance).raw().toBuffer({ resolveWithObject: true }),
    sharp(canonicalProtect).raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (info.width !== SHADOW_CANVAS_SIZE || info.height !== SHADOW_CANVAS_SIZE
    || protectInfo.width !== info.width || protectInfo.height !== info.height) {
    throw new Error("shadow extraction did not produce an 800×800 component pair");
  }
  const productMask = new Uint8Array(info.width * info.height);
  for (let index = 0; index < productMask.length; index += 1) {
    productMask[index] = protect[index * protectInfo.channels] >= 13 ? 1 : 0;
  }
  const excluded = dilate(productMask, info.width, info.height, 4);
  const protectAlpha = Buffer.alloc(productMask.length);
  for (let index = 0; index < productMask.length; index += 1) protectAlpha[index] = productMask[index] ? 255 : 0;
  const productRgba = await sharp({
    create: { width: info.width, height: info.height, channels: 3, background: "#000000" },
  }).joinChannel(protectAlpha, { raw: { width: info.width, height: info.height, channels: 1 } }).png().toBuffer();
  const reference = await measureAlphaGeometry(productRgba);
  const groundLine = Math.floor((
    reference.box.top + reference.box.height * GROUND_START_BY_ANGLE[angle]
  ) * info.height);
  const referenceLeft = Math.floor(reference.box.left * info.width);
  const referenceRight = Math.ceil((reference.box.left + reference.box.width) * info.width);
  const completionRegion = Uint8Array.from(excluded);
  if (angle !== "top-down") {
    for (let y = groundLine; y < info.height; y += 1) {
      for (let x = referenceLeft; x < referenceRight; x += 1) {
        completionRegion[y * info.width + x] = 1;
      }
    }
  }
  const frontShadowLeft = Math.floor((reference.box.left + reference.box.width * 0.08) * info.width);
  const frontShadowRight = Math.ceil((reference.box.left + reference.box.width * 0.92) * info.width);
  const baseAlpha = Buffer.alloc(productMask.length);
  for (let index = 0; index < productMask.length; index += 1) {
    const x = index % info.width;
    const y = Math.floor(index / info.width);
    if (excluded[index] || y < groundLine
      || (angle === "front" && (x < frontShadowLeft || x >= frontShadowRight))) continue;
    const offset = index * info.channels;
    const luminance = 0.2126 * trans[offset] + 0.7152 * trans[offset + 1] + 0.0722 * trans[offset + 2];
    const darkness = Math.max(0, Math.min(255, Math.round(255 - luminance)));
    baseAlpha[index] = darkness < 2 ? 0 : darkness;
  }
  // The photographed product occludes part of its own cast shadow. Keep the
  // measured pixels intact, but continue nearby values a short distance into
  // that unknown region so a slightly different target silhouette cannot
  // expose a hard product-shaped white hole.
  const completedAlpha = completeOccludedAlpha(
    baseAlpha,
    completionRegion,
    info.width,
    info.height,
    COMPLETION_RADIUS_BY_ANGLE[angle],
  );
  const smoothedCompletion = boxBlur(completedAlpha, info.width, info.height, 12);
  const candidateAlpha = Buffer.alloc(info.width * info.height);
  for (let index = 0; index < productMask.length; index += 1) {
    const alpha = baseAlpha[index] >= 2
      ? baseAlpha[index]
      : completionRegion[index]
        ? Math.min(255, Math.round(smoothedCompletion[index] * COMPLETION_STRENGTH_BY_ANGLE[angle]))
        : 0;
    candidateAlpha[index] = alpha;
  }
  const alpha = retainLargestShadowComponent(
    applyShadowAlphaFloor(candidateAlpha, MIN_SHADOW_ALPHA_BY_ANGLE[angle]),
    info.width,
    info.height,
  );
  const rgba = Buffer.alloc(info.width * info.height * 4);
  let shadowPixels = 0;
  for (let index = 0; index < productMask.length; index += 1) {
    const rgbaOffset = index * 4;
    rgba[rgbaOffset] = 0;
    rgba[rgbaOffset + 1] = 0;
    rgba[rgbaOffset + 2] = 0;
    rgba[rgbaOffset + 3] = alpha[index];
    if (alpha[index] >= 2) shadowPixels += 1;
  }
  const coverage = shadowPixels / productMask.length;
  if (coverage < 0.0001 || coverage > 0.45) {
    throw new Error(`shadow coverage ${coverage.toFixed(4)} is outside the safe range`);
  }
  return {
    image: await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer(),
    reference,
    coverage,
  };
}

async function extract(source: string, prefix: string): Promise<{ transmittance: Buffer; protect: Buffer }> {
  const {
    downloadComfyOutput,
    loadComfyWorkflow,
    runComfyWorkflow,
    uploadComfyInput,
  } = await import("@/lib/mono/comfyui");
  const sourceBytes = await readFile(source);
  const extension = path.extname(source).toLowerCase() || ".jpg";
  const uploaded = await uploadComfyInput(
    sourceBytes,
    `${sha256(sourceBytes)}${extension}`,
    extension === ".png" ? "image/png" : "image/jpeg",
    AbortSignal.timeout(15 * 60_000),
  );
  const outputPrefix = `workbench/shadow-template/${prefix}-${randomUUID().slice(0, 8)}`;
  const workflow = await loadComfyWorkflow("product-shadow-template", {
    INPUT_IMAGE: uploaded,
    TRANSMITTANCE_PREFIX: `${outputPrefix}-transmittance`,
    PROTECT_PREFIX: `${outputPrefix}-protect`,
  });
  const result = await runComfyWorkflow(workflow, AbortSignal.timeout(15 * 60_000));
  const transmittance = result.outputs.find((output) => output.nodeId === "15");
  const protect = result.outputs.find((output) => output.nodeId === "16");
  if (!transmittance || !protect) throw new Error("shadow extraction workflow did not return both components");
  return {
    transmittance: await downloadComfyOutput(transmittance, AbortSignal.timeout(60_000)),
    protect: await downloadComfyOutput(protect, AbortSignal.timeout(60_000)),
  };
}

async function verifyBundle(outputDir: string): Promise<void> {
  const { validateProductShadowBundle } = await import("@/lib/mono/product-main-shadow");
  const bundle = await validateProductShadowBundle(outputDir, DEFAULT_SHADOW_TEMPLATE_VERSION);
  console.log(`Verified ${bundle.version}: ${bundle.variants.length} variants`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage());
    return;
  }
  const outputDir = path.resolve(option("--output-dir")
    ?? path.join("config", "product-main-shadows", DEFAULT_SHADOW_TEMPLATE_VERSION));
  if (process.argv.includes("--verify")) {
    await verifyBundle(outputDir);
    return;
  }
  const sourceRootOption = option("--source-root");
  if (!sourceRootOption) throw new Error(`--source-root is required\n\n${usage()}`);
  const sourceRoot = path.resolve(sourceRootOption);
  try {
    await stat(outputDir);
    throw new Error(`immutable bundle already exists: ${outputDir}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const stage = `${outputDir}.stage-${randomUUID()}`;
  await mkdir(stage, { recursive: true });
  try {
    const variants: ShadowVariantManifest[] = [];
    for (const sample of SAMPLES) {
      const source = path.resolve(sourceRoot, sample.relativePath);
      if (!source.startsWith(`${sourceRoot}${path.sep}`)) throw new Error(`sample path escapes source root: ${sample.relativePath}`);
      const sourceBytes = await readFile(source);
      const components = await extract(source, sample.id);
      const built = await makeShadowAsset(components.transmittance, components.protect, sample.angle);
      const file = `${sample.id}.png`;
      await writeFile(path.join(stage, file), built.image);
      variants.push({
        id: sample.id,
        angle: sample.angle,
        file,
        order: sample.order,
        sha256: sha256(built.image),
        source: { relativePath: sample.relativePath.replaceAll(path.sep, "/"), sha256: sha256(sourceBytes) },
        reference: built.reference,
      });
      console.log(`${sample.id}: coverage=${built.coverage.toFixed(4)}`);
    }
    const manifest: ProductShadowManifest = {
      schemaVersion: 1,
      version: DEFAULT_SHADOW_TEMPLATE_VERSION,
      canvas: { width: SHADOW_CANVAS_SIZE, height: SHADOW_CANVAS_SIZE },
      variants,
    };
    await writeFile(path.join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await rename(stage, outputDir);
    await verifyBundle(outputDir);
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
