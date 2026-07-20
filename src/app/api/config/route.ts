import { NextResponse } from "next/server";
import {
  API_CONFIG_GROUPS,
  getAllConfigForDisplay,
  setConfigValues,
  type ApiConfigKey,
} from "@/lib/server/api-config";

export async function GET() {
  return NextResponse.json({ groups: getAllConfigForDisplay() });
}

const ALL_KEYS = new Set<string>(
  Object.values(API_CONFIG_GROUPS).flatMap((g) => g.keys as readonly string[]),
);

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "无效请求体" }, { status: 400 });
  }
  const values: Partial<Record<ApiConfigKey, string>> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!ALL_KEYS.has(key)) continue;
    if (typeof value !== "string") continue;
    values[key as ApiConfigKey] = value;
  }
  setConfigValues(values);
  return NextResponse.json({ groups: getAllConfigForDisplay() });
}
