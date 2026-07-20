import { actorFromWorkbenchRequest, MonoHttpError, monoErrorResponse } from "@/lib/mono/http";
import { importCollectorRows } from "@/lib/collector/store";
import { parseCsv, parseXlsx } from "@/lib/collector/xlsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

/** 导入 douyin_Playwright 的抓取结果：body 即文件内容，文件名放 x-workbench-filename。 */
export async function POST(request: Request) {
  try {
    const actor = actorFromWorkbenchRequest(request);
    const encodedName = request.headers.get("x-workbench-filename");
    const filename = encodedName ? decodeURIComponent(encodedName) : "import.xlsx";
    const buffer = Buffer.from(await request.arrayBuffer());
    if (buffer.length === 0) throw new MonoHttpError(400, "文件为空");
    if (buffer.length > MAX_IMPORT_BYTES) throw new MonoHttpError(413, "导入文件超过 50MB 上限");

    const matrix = /\.csv$/iu.test(filename)
      ? parseCsv(buffer.toString("utf8"))
      : parseXlsx(buffer);
    const batch = importCollectorRows(actor.workspaceId, actor.userId, matrix);
    return Response.json({ batch }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && !(error instanceof MonoHttpError) && /XLSX|数据行|zip/u.test(error.message)) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return monoErrorResponse(error);
  }
}
