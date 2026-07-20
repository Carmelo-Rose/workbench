import { inflateRawSync } from "node:zlib";

/**
 * 零依赖的最小 XLSX/CSV 读取器（沿用项目“零外部依赖”选型）。
 * 只覆盖导入抓取结果所需：读第一张工作表的文本矩阵。
 * XLSX 本质是 zip：从中央目录定位 sharedStrings 与 sheet1，inflate 后解析 XML。
 */

type ZipEntry = { name: string; compressedSize: number; method: number; localOffset: number };

function readCentralDirectory(buffer: Buffer): ZipEntry[] {
  // EOCD 签名 PK\x05\x06 在文件尾部（可能有 zip 注释，最多回扫 64KB）。
  let eocd = -1;
  const scanStart = Math.max(0, buffer.length - 65_557);
  for (let index = buffer.length - 22; index >= scanStart; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 XLSX 文件（找不到 zip 目录）");
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  const entries: ZipEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    entries.push({ name, compressedSize, method, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  if (buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) throw new Error("XLSX 内部结构损坏");
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(compressed);
  if (entry.method === 8) return inflateRawSync(compressed);
  throw new Error(`不支持的 zip 压缩方式：${entry.method}`);
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/gu, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&");
}

/** <si> 里可能是纯 <t> 或多段 rich text <r><t>，全部拼接。 */
function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  for (const si of xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/gu)) {
    const texts = [...si[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gu)];
    strings.push(decodeXmlEntities(texts.map((match) => match[1]).join("")));
  }
  return strings;
}

function columnIndex(cellRef: string): number {
  const letters = cellRef.match(/^[A-Z]+/u)?.[0] ?? "A";
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/** 解析第一张工作表为文本矩阵（跳过图片等非单元格内容）。 */
export function parseXlsx(buffer: Buffer): string[][] {
  const entries = readCentralDirectory(buffer);
  const findEntry = (name: string) => entries.find((entry) => entry.name === name);

  const sharedEntry = findEntry("xl/sharedStrings.xml");
  const sharedStrings = sharedEntry ? parseSharedStrings(readZipEntry(buffer, sharedEntry).toString("utf8")) : [];

  const sheetEntry = entries
    .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }))[0];
  if (!sheetEntry) throw new Error("XLSX 里没有工作表");
  const sheetXml = readZipEntry(buffer, sheetEntry).toString("utf8");

  const rows: string[][] = [];
  for (const rowMatch of sheetXml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/gu)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gu)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2] ?? "";
      const ref = attrs.match(/r="([A-Z]+\d+)"/u)?.[1] ?? "";
      const type = attrs.match(/t="(\w+)"/u)?.[1];
      let value = "";
      if (type === "inlineStr") {
        const texts = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gu)];
        value = decodeXmlEntities(texts.map((match) => match[1]).join(""));
      } else {
        const raw = body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/u)?.[1] ?? "";
        value = type === "s"
          ? sharedStrings[Number(raw)] ?? ""
          : decodeXmlEntities(raw);
      }
      cells[ref ? columnIndex(ref) : cells.length] = value;
    }
    // 空洞补成空串，保证行内列对齐。
    rows.push(Array.from(cells, (cell) => cell ?? ""));
  }
  return rows;
}

/** RFC 4180 风格 CSV：支持引号包裹、转义引号与字段内换行。 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const source = text.replace(/^﻿/u, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}
