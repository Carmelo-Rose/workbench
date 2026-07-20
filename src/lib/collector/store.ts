import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/server/db";

/**
 * 抓取结果（douyin_Playwright 导出的 XLSX/CSV）导入与检索。
 * 表头按 douyin_Playwright 的中文列名映射到统一字段，
 * 未识别列全部保留在 raw_json，检索命中后交给 Agent 分析。
 */

export type CollectorItem = {
  id: string;
  batchId: string;
  platform: string;
  itemId: string | null;
  title: string | null;
  author: string | null;
  url: string | null;
  publishedAt: string | null;
  metrics: Record<string, string>;
  raw: Record<string, string>;
  importedAt: number;
};

export type CollectorBatch = {
  batchId: string;
  platform: string;
  itemCount: number;
  importedAt: number;
};

const ID_HEADERS = ["图文ID", "视频ID", "笔记ID", "ID"];
const TITLE_HEADERS = ["标题/描述", "标题", "正文", "描述"];
const AUTHOR_HEADERS = ["作者"];
const URL_HEADERS = ["分享链接", "链接", "笔记链接"];
const PUBLISHED_HEADERS = ["发布时间"];
const METRIC_HEADERS = ["点赞数", "评论数", "分享数", "收藏数", "视觉分数", "视觉合格"];

function pick(row: Record<string, string>, headers: string[]): string | null {
  for (const header of headers) {
    const value = row[header]?.trim();
    if (value) return value;
  }
  return null;
}

function detectPlatform(headers: string[], row: Record<string, string>): string {
  const source = row["来源"]?.toLowerCase() ?? "";
  if (source.includes("xhs") || source.includes("小红书")) return "xhs";
  if (source.includes("douyin") || source.includes("抖音")) return "douyin";
  if (headers.includes("笔记ID")) return "xhs";
  if (headers.includes("视频ID") || headers.includes("图文ID")) return "douyin";
  return "unknown";
}

/** 把表格矩阵（首行表头）导入 collector_items，返回批次信息。 */
export function importCollectorRows(
  workspaceId: string,
  userId: string,
  matrix: string[][],
): CollectorBatch {
  if (matrix.length < 2) throw new Error("文件里没有数据行（首行应为表头）");
  const headers = matrix[0].map((header) => header.trim());
  const batchId = `batch_${randomUUID()}`;
  const importedAt = Date.now();
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO collector_items
     (id, workspace_id, user_id, batch_id, platform, item_id, title, author, url, published_at, metrics_json, raw_json, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let platform = "unknown";
  let count = 0;
  for (const cells of matrix.slice(1)) {
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (header) row[header] = cells[index]?.trim() ?? "";
    });
    if (Object.values(row).every((value) => value === "")) continue;
    platform = detectPlatform(headers, row);
    const metrics: Record<string, string> = {};
    for (const header of METRIC_HEADERS) {
      if (row[header]) metrics[header] = row[header];
    }
    insert.run(
      `citem_${randomUUID()}`,
      workspaceId,
      userId,
      batchId,
      platform,
      pick(row, ID_HEADERS),
      pick(row, TITLE_HEADERS),
      pick(row, AUTHOR_HEADERS),
      pick(row, URL_HEADERS),
      pick(row, PUBLISHED_HEADERS),
      JSON.stringify(metrics),
      JSON.stringify(row),
      importedAt,
    );
    count += 1;
  }
  if (count === 0) throw new Error("没有可导入的数据行");
  return { batchId, platform, itemCount: count, importedAt };
}

type ItemRow = {
  id: string;
  batch_id: string;
  platform: string;
  item_id: string | null;
  title: string | null;
  author: string | null;
  url: string | null;
  published_at: string | null;
  metrics_json: string | null;
  raw_json: string;
  imported_at: number;
};

function toItem(row: ItemRow): CollectorItem {
  return {
    id: row.id,
    batchId: row.batch_id,
    platform: row.platform,
    itemId: row.item_id,
    title: row.title,
    author: row.author,
    url: row.url,
    publishedAt: row.published_at,
    metrics: row.metrics_json ? JSON.parse(row.metrics_json) as Record<string, string> : {},
    raw: JSON.parse(row.raw_json) as Record<string, string>,
    importedAt: row.imported_at,
  };
}

export function searchCollectorItems(
  workspaceId: string,
  options: { keyword?: string; platform?: string; batchId?: string; limit?: number } = {},
): CollectorItem[] {
  const conditions = ["workspace_id = ?"];
  const params: (string | number)[] = [workspaceId];
  if (options.keyword) {
    conditions.push("(title LIKE ? OR author LIKE ?)");
    const pattern = `%${options.keyword}%`;
    params.push(pattern, pattern);
  }
  if (options.platform) {
    conditions.push("platform = ?");
    params.push(options.platform);
  }
  if (options.batchId) {
    conditions.push("batch_id = ?");
    params.push(options.batchId);
  }
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
  const rows = getDb().prepare(
    `SELECT * FROM collector_items WHERE ${conditions.join(" AND ")}
     ORDER BY imported_at DESC, id LIMIT ?`,
  ).all(...params, limit) as ItemRow[];
  return rows.map(toItem);
}

export function listCollectorBatches(workspaceId: string): CollectorBatch[] {
  const rows = getDb().prepare(
    `SELECT batch_id, platform, COUNT(*) AS item_count, MAX(imported_at) AS imported_at
     FROM collector_items WHERE workspace_id = ?
     GROUP BY batch_id, platform ORDER BY imported_at DESC LIMIT 50`,
  ).all(workspaceId) as { batch_id: string; platform: string; item_count: number; imported_at: number }[];
  return rows.map((row) => ({
    batchId: row.batch_id,
    platform: row.platform,
    itemCount: Number(row.item_count),
    importedAt: Number(row.imported_at),
  }));
}
