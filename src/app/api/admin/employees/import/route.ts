import { NextResponse } from "next/server";
import { parseCsv, parseXlsx } from "@/lib/collector/xlsx";
import {
  currentWorkspaceActor,
  importEmployees,
  requireAdministrator,
  requireGrant,
  previewEmployeeImport,
  tenantErrorResponse,
  type ImportRow,
} from "@/lib/server/tenant";

export const dynamic = "force-dynamic";

const REQUIRED_HEADERS = ["账号", "姓名", "部门", "组织角色", "工作区角色"] as const;

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A tiny, dependency-free stored ZIP is enough for Excel's standard XLSX package. */
function xlsxTemplate(): Buffer {
  const files = new Map<string, string>([
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="员工导入" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
    ["xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>账号</t></is></c><c r="B1" t="inlineStr"><is><t>姓名</t></is></c><c r="C1" t="inlineStr"><is><t>部门</t></is></c><c r="D1" t="inlineStr"><is><t>组织角色</t></is></c><c r="E1" t="inlineStr"><is><t>工作区角色</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>E1001</t></is></c><c r="B2" t="inlineStr"><is><t>张三</t></is></c><c r="C2" t="inlineStr"><is><t>创意部</t></is></c></row></sheetData></worksheet>`],
  ]);
  const locals: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const [name, text] of files) {
    const nameBytes = Buffer.from(name); const content = Buffer.from(text); const crc = crc32(content);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, content);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(content.length, 20); entry.writeUInt32LE(content.length, 24); entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes); offset += local.length + nameBytes.length + content.length;
  }
  const centralSize = central.reduce((size, item) => size + item.length, 0); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

function rowsFromUpload(filename: string, buffer: Buffer): ImportRow[] {
  const matrix = /\.xlsx$/iu.test(filename) ? parseXlsx(buffer) : parseCsv(buffer.toString("utf8"));
  const headers = matrix[0]?.map((value) => value.trim().replace(/^\uFEFF/u, "")) ?? [];
  const indexes = REQUIRED_HEADERS.map((header) => headers.indexOf(header));
  if (indexes[0] < 0 || indexes[1] < 0) throw new Error("导入模板必须包含：账号、姓名、部门、组织角色、工作区角色");
  return matrix.slice(1).flatMap((cells, index) => {
    const value = (column: number) => column >= 0 ? (cells[column] ?? "").trim() : "";
    if (!cells.some((cell) => cell.trim())) return [];
    return [{ account: value(indexes[0]), displayName: value(indexes[1]), department: value(indexes[2]), organizationRole: value(indexes[3]), workspaceRole: value(indexes[4]), row: index + 2 }];
  });
}

export async function GET(request: Request) {
  try {
    const actor = currentWorkspaceActor(request);
    requireAdministrator(actor);
    requireGrant(actor, "system.accounts.manage");
  } catch (error) {
    return tenantErrorResponse(error);
  }
  if (new URL(request.url).searchParams.get("format") === "xlsx") {
    return new Response(new Uint8Array(xlsxTemplate()), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": "attachment; filename=employee-import-template.xlsx",
      },
    });
  }
  const csv = `账号,姓名,部门,组织角色,工作区角色\nE1001,张三,创意部,,,\n`;
  return new Response(`\uFEFF${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=employee-import-template.csv",
    },
  });
}

export async function POST(request: Request) {
  try {
    const actor = currentWorkspaceActor(request);
    const form = await request.formData();
    const file = form.get("file");
    const commit = form.get("commit") === "true";
    if (!(file instanceof File)) return NextResponse.json({ error: "file is required" }, { status: 400 });
    if (!/\.(csv|xlsx)$/iu.test(file.name)) return NextResponse.json({ error: "only CSV and XLSX are supported" }, { status: 400 });
    if (file.size > 5 * 1024 * 1024) return NextResponse.json({ error: "file is too large" }, { status: 400 });
    const rows = rowsFromUpload(file.name, Buffer.from(await file.arrayBuffer()));
    const preview = previewEmployeeImport(actor, rows);
    if (!commit || !preview.valid) return NextResponse.json({ preview });
    return NextResponse.json({ preview, result: importEmployees(actor, rows) });
  } catch (error) {
    return tenantErrorResponse(error);
  }
}
