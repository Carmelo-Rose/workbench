"use client";

import { makeAssistantToolUI } from "@assistant-ui/react";
import { ChartColumnIcon, CheckIcon, LoaderCircleIcon } from "lucide-react";
import type { LuopanRankInsights, LuopanRankingEvent } from "@/lib/luopan/insights";

/**
 * 采集数据工具卡：luopan sidecar / collector_items 的查询结果
 * 统一渲染成紧凑表格，字段随后端返回自适应，分析结论由模型在正文里给出。
 */

const COLUMN_LABELS: Record<string, string> = {
  run_id: "轮次",
  runId: "轮次",
  scope_key: "范围",
  scope_count: "范围数",
  item_count: "条数",
  event_count: "事件数",
  captured_at: "采集时间",
  event_type: "事件",
  rank: "排名",
  rank_current: "当前排名",
  rank_previous: "上轮排名",
  rank_delta: "变化",
  product_id: "商品ID",
  product_title: "商品",
  shop_info: "店铺",
  price_range: "价格带",
  price: "价格",
  pay_amount: "支付金额",
  industry_name: "一级类目",
  category_name: "二级类目",
  leaf_category_name: "叶子类目",
  created_at: "时间",
  platform: "平台",
  itemId: "内容ID",
  title: "标题",
  author: "作者",
  publishedAt: "发布时间",
  batchId: "批次",
  itemCount: "条数",
  importedAt: "导入时间",
};

const HIDDEN_COLUMNS = new Set(["image", "raw", "metrics_json", "raw_json", "product_url", "url", "notified", "id"]);
const MAX_ROWS = 20;
const MAX_COLUMNS = 8;

function firstObjectArray(value: unknown): Record<string, unknown>[] | null {
  if (typeof value !== "object" || value === null) return null;
  for (const candidate of Object.values(value)) {
    if (
      Array.isArray(candidate) &&
      candidate.length > 0 &&
      typeof candidate[0] === "object" && candidate[0] !== null
    ) {
      return candidate as Record<string, unknown>[];
    }
  }
  return null;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number" && value > 1_000_000_000_000) {
    return new Date(value).toLocaleString("zh-CN", { hour12: false });
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function CollectorCard({ title, result }: { title: string; result?: unknown }) {
  const rows = result !== undefined ? firstObjectArray(result) : null;
  const done = result !== undefined;
  const empty = done && (!rows || rows.length === 0);

  const columns = rows
    ? [...new Set(rows.flatMap((row) => Object.keys(row)))]
        .filter((key) => !HIDDEN_COLUMNS.has(key))
        .slice(0, MAX_COLUMNS)
    : [];

  return (
    <section className="my-3 w-full overflow-hidden rounded-2xl border border-border/70 bg-card/80 shadow-sm backdrop-blur">
      <header className="flex items-center gap-2.5 border-b border-border/60 px-4 py-3">
        <span className="bg-muted flex size-7 items-center justify-center rounded-lg">
          <ChartColumnIcon className="size-3.5" />
        </span>
        <span className="font-medium">{title}</span>
        <span className="text-muted-foreground flex items-center gap-1 text-xs">
          {done ? <CheckIcon className="size-4" /> : <LoaderCircleIcon className="size-4 animate-spin" />}
          {done ? (rows ? `${rows.length} 条` : "已完成") : "正在查询"}
        </span>
      </header>
      <div className="max-h-80 overflow-auto p-2">
        {empty ? (
          <p className="text-muted-foreground px-2 py-3 text-sm">没有匹配的数据。</p>
        ) : rows ? (
          <table className="w-full min-w-max text-left text-xs">
            <thead>
              <tr className="text-muted-foreground">
                {columns.map((column) => (
                  <th key={column} className="px-2 py-1.5 font-medium whitespace-nowrap">
                    {COLUMN_LABELS[column] ?? column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, MAX_ROWS).map((row, index) => (
                <tr key={index} className="border-t border-border/40">
                  {columns.map((column) => (
                    <td key={column} className="max-w-56 truncate px-2 py-1.5" title={cellText(row[column])}>
                      {cellText(row[column])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {rows && rows.length > MAX_ROWS ? (
          <p className="text-muted-foreground px-2 py-2 text-xs">已省略 {rows.length - MAX_ROWS} 行，完整数据由 AI 分析。</p>
        ) : null}
      </div>
    </section>
  );
}

const INSIGHT_STATUS_LABELS: Record<LuopanRankInsights["status"], string> = {
  ready: "数据已同步",
  stale: "数据已过期",
  no_snapshot: "等待采集数据",
  no_event: "本轮无异动",
  unavailable: "服务不可用",
  not_configured: "服务未配置",
};

const EVENT_LABELS: Record<string, string> = {
  NEW_ENTRY: "新进榜",
  RANK_UP_50: "排名上升 50+",
  RANK_UP_100: "排名上升 100+",
  RANK_UP_150: "排名上升 150+",
};

function isRankInsights(value: unknown): value is LuopanRankInsights {
  if (typeof value !== "object" || value === null) return false;
  const status = (value as Record<string, unknown>).status;
  return typeof status === "string" && status in INSIGHT_STATUS_LABELS;
}

function scopeLabel(scopePrefix: string) {
  if (scopePrefix === "video_acc") return "服配短视频榜";
  if (scopePrefix === "card_order") return "商品卡榜";
  return "大盘短视频榜";
}

function formatTime(value: string | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function eventReason(event: LuopanRankingEvent) {
  const parts: string[] = [];
  if (event.eventType === "NEW_ENTRY") parts.push("新进榜");
  else if (event.rankDelta !== undefined) parts.push(`排名上升 ${event.rankDelta} 位`);
  if (event.rankCurrent !== undefined) parts.push(`当前第 ${event.rankCurrent} 名`);
  const category = event.leafCategoryName ?? event.categoryName ?? event.industryName;
  if (category) parts.push(category);
  return parts.join(" · ") || "榜单异动";
}

function RankInsightsCard({ result }: { result?: unknown }) {
  const insights = isRankInsights(result) ? result : undefined;
  const done = result !== undefined;
  const showEvents = insights && insights.events.length > 0;

  return (
    <section className="my-3 w-full overflow-hidden rounded-2xl border border-border/70 bg-card/80 shadow-sm backdrop-blur" aria-live="polite">
      <header className="flex items-center gap-2.5 border-b border-border/60 px-4 py-3">
        <span className="bg-muted flex size-7 items-center justify-center rounded-lg">
          <ChartColumnIcon className="size-3.5" />
        </span>
        <span className="font-medium">榜单异动</span>
        <span className="text-muted-foreground flex items-center gap-1 text-xs">
          {done ? <CheckIcon className="size-4" /> : <LoaderCircleIcon className="size-4 animate-spin" />}
          {insights ? INSIGHT_STATUS_LABELS[insights.status] : "正在检查数据状态"}
        </span>
      </header>
      <div className="space-y-3 p-4">
        {insights ? (
          <>
            <p className="text-sm leading-6">{insights.message}</p>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl bg-muted/45 p-3 text-xs">
              <div>
                <dt className="text-muted-foreground">榜单范围</dt>
                <dd className="mt-0.5 font-medium">{scopeLabel(insights.scopePrefix)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">数据截至</dt>
                <dd className="mt-0.5 font-medium">{formatTime(insights.dataAsOf)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">本轮商品</dt>
                <dd className="mt-0.5 font-medium">{insights.latestRound?.itemCount?.toLocaleString("zh-CN") ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">检测到异动</dt>
                <dd className="mt-0.5 font-medium">{insights.totalEvents.toLocaleString("zh-CN")} 条</dd>
              </div>
            </dl>
            {showEvents ? (
              <ol className="space-y-2">
                {insights.events.slice(0, 8).map((event, index) => (
                  <li key={`${event.productId ?? "event"}-${index}`} className="rounded-xl border border-border/55 px-3 py-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{event.productTitle ?? "未命名商品"}</p>
                        <p className="text-muted-foreground mt-1 text-xs">{eventReason(event)}</p>
                      </div>
                      <span className="bg-muted shrink-0 rounded-md px-2 py-1 text-xs">{EVENT_LABELS[event.eventType ?? ""] ?? "异动"}</span>
                    </div>
                  </li>
                ))}
              </ol>
            ) : null}
          </>
        ) : (
          <p className="text-muted-foreground text-sm">正在确认服务连接、最新采集轮次和异动数据。</p>
        )}
      </div>
    </section>
  );
}

function collectorToolUI(toolName: string, title: string) {
  return makeAssistantToolUI<Record<string, unknown>, unknown>({
    toolName,
    display: "standalone",
    render: (props) => <CollectorCard title={title} result={props.result} />,
  });
}

export const LuopanRoundsToolUI = collectorToolUI("luopan_query_rounds", "罗盘采集轮次");
export const LuopanSnapshotToolUI = collectorToolUI("luopan_query_snapshot", "罗盘榜单快照");
export const LuopanTrendToolUI = collectorToolUI("luopan_product_trend", "商品排名轨迹");
export const LuopanEventsToolUI = collectorToolUI("luopan_query_events", "榜单异动事件");
export const LuopanRankInsightsToolUI = makeAssistantToolUI<Record<string, unknown>, unknown>({
  toolName: "luopan_rank_insights",
  display: "standalone",
  render: (props) => <RankInsightsCard result={props.result} />,
});
export const CollectorBatchesToolUI = collectorToolUI("collector_list_batches", "采集导入批次");
export const CollectorSearchToolUI = collectorToolUI("collector_search_items", "采集内容检索");
