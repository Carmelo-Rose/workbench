import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import { parseCsv, parseXlsx } from "./xlsx";

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeAll(() => {
  setEnv("WORKBENCH_DB_PATH", path.join(os.tmpdir(), `workbench-collector-suite-${crypto.randomUUID()}.db`));
  setEnv("NODE_ENV", "test");
});

/** 测试用最小 zip 写入器（stored 方式，不压缩），拼出合法 XLSX。 */
function buildZip(files: { name: string; content: string }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const data = Buffer.from(file.content);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += 30 + name.length + data.length;
  }
  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuffer, eocd]);
}

function buildXlsx(rows: string[][]): Buffer {
  const shared: string[] = [];
  const sharedIndex = (text: string) => {
    const existing = shared.indexOf(text);
    if (existing >= 0) return existing;
    shared.push(text);
    return shared.length - 1;
  };
  const sheetRows = rows.map((cells, rowIndex) => {
    const cellsXml = cells.map((cell, columnIndex) => {
      const ref = `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`;
      if (/^\d+$/u.test(cell)) return `<c r="${ref}"><v>${cell}</v></c>`;
      return `<c r="${ref}" t="s"><v>${sharedIndex(cell)}</v></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${cellsXml}</row>`;
  }).join("");
  const escape = (text: string) => text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;");
  return buildZip([
    {
      name: "xl/sharedStrings.xml",
      content: `<?xml version="1.0"?><sst>${shared.map((text) => `<si><t>${escape(text)}</t></si>`).join("")}</sst>`,
    },
    {
      name: "xl/worksheets/sheet1.xml",
      content: `<?xml version="1.0"?><worksheet><sheetData>${sheetRows}</sheetData></worksheet>`,
    },
  ]);
}

const SAMPLE_ROWS = [
  ["视频ID", "来源", "标题/描述", "作者", "发布时间", "点赞数", "分享链接"],
  ["7301", "douyin-search", "夏日渔夫帽穿搭 & 测评", "小A", "2026-07-10 12:00", "1024", "https://v.douyin.com/x1"],
  ["7302", "douyin-search", "防晒帽实测", "小B", "2026-07-11 09:30", "88", "https://v.douyin.com/x2"],
];

describe("minimal xlsx / csv readers", () => {
  it("parses an xlsx built with shared strings and inline numbers", () => {
    const matrix = parseXlsx(buildXlsx(SAMPLE_ROWS));
    expect(matrix).toHaveLength(3);
    expect(matrix[0]).toEqual(SAMPLE_ROWS[0]);
    expect(matrix[1][2]).toBe("夏日渔夫帽穿搭 & 测评");
    expect(matrix[2][5]).toBe("88");
  });

  it("rejects non-zip files with a clear error", () => {
    expect(() => parseXlsx(Buffer.from("not a zip at all"))).toThrow(/XLSX/u);
  });

  it("parses quoted csv with embedded commas and newlines", () => {
    const matrix = parseCsv('标题,作者\n"你好, 世界","第一行\n第二行"\n"引号""转义",b');
    expect(matrix).toEqual([
      ["标题", "作者"],
      ["你好, 世界", "第一行\n第二行"],
      ['引号"转义', "b"],
    ]);
  });
});

describe("collector import and search", () => {
  it("imports rows, maps Chinese headers and searches by keyword", async () => {
    const { importCollectorRows, searchCollectorItems, listCollectorBatches } = await import("./store");
    const batch = importCollectorRows("default", "local-user", parseXlsx(buildXlsx(SAMPLE_ROWS)));
    expect(batch.platform).toBe("douyin");
    expect(batch.itemCount).toBe(2);

    const hits = searchCollectorItems("default", { keyword: "渔夫帽" });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      itemId: "7301",
      author: "小A",
      url: "https://v.douyin.com/x1",
      metrics: { 点赞数: "1024" },
    });
    expect(hits[0].raw["来源"]).toBe("douyin-search");

    expect(searchCollectorItems("other-workspace", {})).toHaveLength(0);
    expect(listCollectorBatches("default")[0]).toMatchObject({ batchId: batch.batchId, itemCount: 2 });
  });

  it("refuses empty imports", async () => {
    const { importCollectorRows } = await import("./store");
    expect(() => importCollectorRows("default", "local-user", [["标题"]])).toThrow(/数据行/u);
  });
});
