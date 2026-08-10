import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

type ComfyOutputFile = {
  filename: string;
  subfolder?: string;
  type?: string;
};

type ComfyHistoryEntry = {
  status?: { completed?: boolean; status_str?: string };
  outputs?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
};

type Options = {
  workflow: string;
  inputs: string[];
  outputDir: string;
  baseUrl: string;
  timeoutMs: number;
  concurrency: number;
  params: Record<string, unknown>;
};

const IMAGE_EXTENSIONS = /\.(?:jpe?g|png|webp)$/iu;

/**
 * Thin ComfyUI API runner for a checked-in API-format workflow.
 *
 * This script owns transport only: upload, token replacement, /prompt, history
 * polling, and output download. It never resizes the source image and never
 * calls a generative model itself. The workflow remains the single place where
 * matting, aspect-ratio handling, compositing, and SaveImage nodes are defined.
 */

function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/run-comfyui-batch.ts --workflow <api.json> --input <image> [--input <image> ...] --output-dir <dir>",
    "  npx tsx scripts/run-comfyui-batch.ts --workflow <api.json> --input-dir <dir> --output-dir <dir>",
    "",
    "Options:",
    "  --workflow <path>       API-format workflow JSON",
    "  --input <path>          One input image; repeatable",
    "  --input-dir <path>      Directory of images (non-recursive)",
    "  --output-dir <path>     Local output directory",
    "  --url <http://...>      ComfyUI base URL (default: COMFYUI_URL or http://192.168.1.198:8188)",
    "  --timeout-ms <n>        Per-image timeout (default: 600000)",
    "  --concurrency <n>       Number of queued images (default: 1)",
    "  --param NAME=JSON       Extra workflow token, repeatable (bare words are accepted as strings)",
    "",
    "Built-in tokens: {{INPUT_IMAGE}}, {{INPUT_MEDIA}}, {{INPUT_BASENAME}}, {{OUTPUT_PREFIX}}",
  ].join("\n");
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseParam(value: string): [string, unknown] {
  const separator = value.indexOf("=");
  if (separator <= 0) throw new Error(`--param must be NAME=JSON, got ${value}`);
  const name = value.slice(0, separator).trim();
  if (!/^[A-Z0-9_]+$/u.test(name)) throw new Error(`invalid workflow token name: ${name}`);
  const rawValue = value.slice(separator + 1);
  try {
    return [name, JSON.parse(rawValue) as unknown];
  } catch {
    if (/^[A-Za-z0-9_.-]+$/u.test(rawValue)) return [name, rawValue];
    throw new Error(`--param ${name} has invalid JSON`);
  }
}

async function parseOptions(): Promise<Options> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    process.exit(0);
  }

  let workflow = "";
  let inputDir = "";
  let outputDir = "";
  const explicitInputs: string[] = [];
  const params: Record<string, unknown> = {};
  const baseUrl = process.env.COMFYUI_URL ?? "http://192.168.1.198:8188";
  let url = baseUrl;
  let timeoutMs = 600_000;
  let concurrency = 1;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--workflow") workflow = requireValue(args, index++, arg);
    else if (arg === "--input") explicitInputs.push(requireValue(args, index++, arg));
    else if (arg === "--input-dir") inputDir = requireValue(args, index++, arg);
    else if (arg === "--output-dir") outputDir = requireValue(args, index++, arg);
    else if (arg === "--url") url = requireValue(args, index++, arg);
    else if (arg === "--timeout-ms") timeoutMs = Number(requireValue(args, index++, arg));
    else if (arg === "--concurrency") concurrency = Number(requireValue(args, index++, arg));
    else if (arg === "--param") {
      const [name, value] = parseParam(requireValue(args, index++, arg));
      params[name] = value;
    } else {
      throw new Error(`unknown argument: ${arg}\n\n${usage()}`);
    }
  }

  if (!workflow) throw new Error("--workflow is required");
  if (!outputDir) throw new Error("--output-dir is required");
  if (!explicitInputs.length && !inputDir) throw new Error("provide --input or --input-dir");
  if (explicitInputs.length && inputDir) throw new Error("use --input or --input-dir, not both");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be positive");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error("--concurrency must be an integer from 1 to 4");
  }

  const inputs = explicitInputs.length
    ? explicitInputs.map((input) => path.resolve(input))
    : (await readdir(path.resolve(inputDir), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.test(entry.name))
      .map((entry) => path.join(path.resolve(inputDir), entry.name))
      .sort((left, right) => left.localeCompare(right));
  if (!inputs.length) throw new Error("no image inputs found");

  return {
    workflow: path.resolve(workflow),
    inputs,
    outputDir: path.resolve(outputDir),
    baseUrl: url.replace(/\/+$/u, ""),
    timeoutMs,
    concurrency,
    params,
  };
}

function mimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  return "image/jpeg";
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.text();
  let parsed: unknown = null;
  try {
    parsed = body ? JSON.parse(body) as unknown : null;
  } catch {
    parsed = body;
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`);
  }
  return parsed as T;
}

async function uploadImage(baseUrl: string, filePath: string, uploadName: string): Promise<string> {
  const bytes = await readFile(filePath);
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(bytes)], { type: mimeType(filePath) }), uploadName);
  form.append("overwrite", "true");
  const uploaded = await requestJson<{ name?: string; subfolder?: string }>(`${baseUrl}/upload/image`, {
    method: "POST",
    body: form,
  });
  if (!uploaded.name) throw new Error(`ComfyUI upload did not return a filename for ${filePath}`);
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
}

function resolveWorkflowTokens(value: unknown, values: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveWorkflowTokens(item, values));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveWorkflowTokens(item, values)]),
    );
  }
  if (typeof value !== "string") return value;

  const exact = value.match(/^\{\{([A-Z0-9_]+)\}\}$/u);
  if (exact && exact[1] in values) return values[exact[1]];
  return value.replace(/\{\{([A-Z0-9_]+)\}\}/gu, (token, name: string) => (
    name in values ? String(values[name]) : token
  ));
}

function fillWorkflow(raw: string, values: Record<string, unknown>): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  const filled = resolveWorkflowTokens(parsed, values);
  const leftover = JSON.stringify(filled).match(/\{\{([A-Z0-9_]+)\}\}/u);
  if (leftover) throw new Error(`workflow token {{${leftover[1]}}} has no value`);
  return filled as Record<string, unknown>;
}

async function submit(baseUrl: string, workflow: Record<string, unknown>): Promise<string> {
  const response = await requestJson<{ prompt_id?: string; error?: unknown; node_errors?: unknown }>(`${baseUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: `workbench-cutout-${randomUUID()}` }),
  });
  if (!response.prompt_id) {
    throw new Error(`ComfyUI rejected workflow: ${JSON.stringify({ error: response.error, node_errors: response.node_errors })}`);
  }
  return response.prompt_id;
}

function collectOutputFiles(outputs: Record<string, Record<string, unknown>>): ComfyOutputFile[] {
  const files: ComfyOutputFile[] = [];
  for (const nodeOutput of Object.values(outputs)) {
    for (const value of Object.values(nodeOutput)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (typeof item === "object" && item !== null && typeof (item as ComfyOutputFile).filename === "string") {
          const file = item as ComfyOutputFile;
          files.push({ filename: file.filename, subfolder: file.subfolder ?? "", type: file.type ?? "output" });
        }
      }
    }
  }
  return files;
}

async function waitForHistory(
  baseUrl: string,
  promptId: string,
  timeoutMs: number,
): Promise<ComfyOutputFile[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const history = await requestJson<Record<string, ComfyHistoryEntry>>(`${baseUrl}/history/${encodeURIComponent(promptId)}`);
    const entry = history[promptId];
    if (entry?.status?.status_str === "error") {
      throw new Error(`ComfyUI workflow failed: ${JSON.stringify(entry)}`);
    }
    if (entry?.status?.completed) {
      const outputs = collectOutputFiles(entry.outputs ?? {});
      if (!outputs.length) throw new Error("ComfyUI workflow completed without output files");
      return outputs;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`ComfyUI prompt ${promptId} timed out after ${timeoutMs}ms`);
}

async function downloadOutput(baseUrl: string, file: ComfyOutputFile): Promise<Buffer> {
  const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? "", type: file.type ?? "output" });
  const response = await fetch(`${baseUrl}/view?${query.toString()}`);
  if (!response.ok) throw new Error(`ComfyUI output download failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function runOne(
  options: Options,
  workflowRaw: string,
  inputPath: string,
  index: number,
): Promise<void> {
  const stem = path.parse(inputPath).name;
  const runToken = `${stem}-${randomUUID().slice(0, 8)}`;
  const uploadedName = await uploadImage(
    options.baseUrl,
    inputPath,
    `${runToken}${path.extname(inputPath).toLowerCase() || ".png"}`,
  );
  const workflow = fillWorkflow(workflowRaw, {
    ...options.params,
    INPUT_IMAGE: uploadedName,
    INPUT_MEDIA: uploadedName,
    INPUT_BASENAME: stem,
    OUTPUT_PREFIX: runToken,
  });
  const promptId = await submit(options.baseUrl, workflow);
  const files = await waitForHistory(options.baseUrl, promptId, options.timeoutMs);
  for (let outputIndex = 0; outputIndex < files.length; outputIndex += 1) {
    const file = files[outputIndex];
    const extension = path.extname(file.filename) || ".bin";
    const name = files.length === 1 ? `${stem}${extension}` : `${stem}-${outputIndex + 1}${extension}`;
    await writeFile(path.join(options.outputDir, name), await downloadOutput(options.baseUrl, file));
  }
  console.log(`PROGRESS 100 ${index + 1}/${options.inputs.length} ${path.basename(inputPath)} prompt=${promptId}`);
}

async function main(): Promise<void> {
  const options = await parseOptions();
  const workflowRaw = await readFile(options.workflow, "utf8");
  await stat(options.workflow);
  await mkdir(options.outputDir, { recursive: true });
  console.log(`ComfyUI: ${options.baseUrl}`);
  console.log(`Workflow: ${options.workflow}`);
  console.log(`Inputs: ${options.inputs.length}; concurrency: ${options.concurrency}`);

  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= options.inputs.length) return;
      await runOne(options, workflowRaw, options.inputs[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, options.inputs.length) }, () => worker()));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
