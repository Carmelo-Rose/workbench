import { NextResponse } from "next/server";
import { exportSnapshot } from "@/lib/server/thread-store";

export const dynamic = "force-dynamic";

/** 全量 JSON 备份下载。 */
export async function GET() {
  const snapshots = exportSnapshot();
  return new NextResponse(
    JSON.stringify({ exportedAt: new Date().toISOString(), snapshots }, null, 2),
    {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="workbench-threads-${Date.now()}.json"`,
      },
    },
  );
}
