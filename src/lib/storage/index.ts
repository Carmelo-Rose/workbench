import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { randomUUID } from "node:crypto";
import path from "node:path";

/**
 * 本地磁盘对象存储。视频等大文件不再走 data URL 进 SQLite，
 * 而是流式落盘，DB 只记 storage key。公司部署换 S3/OSS 时
 * 只需按同名函数换一个实现（key 语义不变）。
 */

export type StoredObject = { key: string; size: number };

const KEY_PATTERN = /^[0-9a-f]{2}\/[0-9a-f-]{36}(\.[0-9a-z]{1,12})?$/u;

function storageRoot(): string {
  return process.env.WORKBENCH_STORAGE_DIR ?? path.join(process.cwd(), "data", "storage");
}

function objectPath(key: string): string {
  if (!KEY_PATTERN.test(key)) throw new Error("存储 key 无效");
  return path.join(storageRoot(), key);
}

/** 从文件名或 MIME 提示里提取安全的小写扩展名。 */
function safeExtension(hint?: string): string {
  const fromName = hint?.match(/\.([0-9a-z]{1,12})$/iu)?.[1];
  if (fromName) return `.${fromName.toLowerCase()}`;
  const fromMime = hint?.match(/^[a-z]+\/([0-9a-z.+-]+)/iu)?.[1]?.match(/^[0-9a-z]{1,12}$/iu)?.[0];
  return fromMime ? `.${fromMime.toLowerCase()}` : "";
}

export function uploadMaxBytes(): number {
  const parsed = Number(process.env.WORKBENCH_UPLOAD_MAX_BYTES);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2 * 1024 * 1024 * 1024;
}

export async function saveObjectStream(
  source: ReadableStream<Uint8Array> | Readable,
  options: { nameHint?: string; maxBytes?: number } = {},
): Promise<StoredObject> {
  const id = randomUUID();
  const key = `${id.slice(0, 2)}/${id}${safeExtension(options.nameHint)}`;
  const filePath = path.join(storageRoot(), key);
  await mkdir(path.dirname(filePath), { recursive: true });

  const maxBytes = options.maxBytes ?? uploadMaxBytes();
  let size = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        callback(new Error(`文件超过上限 ${Math.floor(maxBytes / 1024 / 1024)}MB`));
        return;
      }
      callback(null, chunk);
    },
  });
  const readable = source instanceof Readable ? source : Readable.fromWeb(source as import("node:stream/web").ReadableStream<Uint8Array>);
  try {
    await pipeline(readable, limiter, createWriteStream(filePath, { flags: "wx" }));
  } catch (error) {
    await rm(filePath, { force: true });
    throw error;
  }
  return { key, size };
}

export async function saveObjectBuffer(buffer: Buffer, nameHint?: string): Promise<StoredObject> {
  return saveObjectStream(Readable.from(buffer), { nameHint, maxBytes: Math.max(buffer.length, 1) });
}

export async function statObject(key: string): Promise<{ size: number } | null> {
  const filePath = objectPath(key);
  try {
    const info = await stat(filePath);
    return info.isFile() ? { size: info.size } : null;
  } catch {
    return null;
  }
}

/** start/end 为字节闭区间，供 HTTP Range 流式播放使用。 */
export function openObjectStream(key: string, range?: { start: number; end: number }): Readable {
  return createReadStream(objectPath(key), range ? { start: range.start, end: range.end } : undefined);
}

export async function readObjectBuffer(key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of openObjectStream(key)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function deleteObject(key: string): Promise<void> {
  await rm(objectPath(key), { force: true });
}
