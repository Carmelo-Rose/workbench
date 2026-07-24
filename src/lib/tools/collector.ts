import { tool } from "ai";
import { z } from "zod";
import { searchCollectorItems, listCollectorBatches } from "@/lib/collector/store";
import { tenantContext } from "@/lib/server/tenant-context";

/**
 * 采集数据分析层工具。原则：不动 luopan / douyin_Playwright 的采集管线
 * （定时 → 飞书表 → 企微保持原样），Workbench 只做数据的第二消费方，
 * 让 Agent 拿结构化数据做二次分析（趋势解读、对比、选品建议）。
 *
 * luopan_* 走采集机上的只读 sidecar API（services/luopan-api/server.py），
 * collector_* 查询本地导入的抓取结果（collector_items 表）。
 */

type CollectorToolContext = {
  userId?: string;
  workspaceId?: string;
};

const scopePrefixSchema = z
  .enum(["video_order", "video_acc", "card_order"])
  .optional()
  .describe("榜单范围：video_order 大盘短视频榜 / video_acc 服配支线 / card_order 旧商品卡榜");

async function luopanFetch(pathname: string, params: Record<string, string | number | undefined>) {
  const baseUrl = process.env.LUOPAN_API_URL;
  if (!baseUrl) {
    throw new Error("罗盘数据服务未配置：请设置 LUOPAN_API_URL（采集机上运行 services/luopan-api/server.py）");
  }
  const url = new URL(pathname, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  const token = process.env.LUOPAN_API_TOKEN;
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !data) {
    const detail = typeof data?.error === "string" ? data.error : `HTTP ${response.status}`;
    throw new Error(`罗盘数据服务请求失败：${detail}`);
  }
  return data;
}

export function createCollectorTools(context: CollectorToolContext = {}) {
  const workspaceId =
    context.workspaceId ?? tenantContext()?.actor.workspaceId;
  if (!workspaceId && process.env.NODE_ENV === "production") {
    throw new Error("Collector tools require an authenticated workspace");
  }
  const resolvedWorkspaceId = workspaceId ?? "default";

  return {
    luopan_query_rounds: tool({
      description: "列出抖音罗盘监控的采集轮次（run_id、榜单范围、商品数），用于确定后续查询的轮次。",
      inputSchema: z.object({
        scopePrefix: scopePrefixSchema,
        limit: z.number().int().min(1).max(50).default(10),
      }),
      execute: (input) => luopanFetch("api/rounds", { scope_prefix: input.scopePrefix, limit: input.limit }),
    }),
    luopan_query_snapshot: tool({
      description: "查询抖音罗盘某一轮采集的榜单快照（TOP200 排名、商品、店铺、价格带、支付金额区间）。不传 runId 时返回最新一轮。",
      inputSchema: z.object({
        runId: z.string().optional().describe("轮次 id，来自 luopan_query_rounds"),
        scopeKey: z.string().optional().describe("完整 scope_key，如 video_order_智能家居_五金"),
        scopePrefix: scopePrefixSchema,
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      }),
      execute: (input) => luopanFetch("api/snapshot", {
        run_id: input.runId,
        scope_key: input.scopeKey,
        scope_prefix: input.scopePrefix,
        limit: input.limit,
        offset: input.offset,
      }),
    }),
    luopan_product_trend: tool({
      description: "查询某个商品跨轮次的排名轨迹（升降趋势），用于判断商品热度走势。",
      inputSchema: z.object({
        productId: z.string().min(1).describe("罗盘商品 id"),
        scopeKey: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(30),
      }),
      execute: (input) => luopanFetch(`api/products/${encodeURIComponent(input.productId)}/trend`, {
        scope_key: input.scopeKey,
        limit: input.limit,
      }),
    }),
    luopan_query_events: tool({
      description: "查询抖音罗盘榜单差分事件：NEW_ENTRY 新进榜、RANK_UP_50/100/150 排名急升。这是发现潜力商品和榜单异动的主要入口。",
      inputSchema: z.object({
        eventType: z.enum(["NEW_ENTRY", "RANK_UP_50", "RANK_UP_100", "RANK_UP_150"]).optional(),
        scopePrefix: scopePrefixSchema,
        runId: z.string().optional().describe("不传时返回最新一轮的事件"),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      execute: (input) => luopanFetch("api/events", {
        event_type: input.eventType,
        scope_prefix: input.scopePrefix,
        run_id: input.runId,
        limit: input.limit,
      }),
    }),
    collector_list_batches: tool({
      description: "列出已导入 Workbench 的抓取结果批次（抖音/小红书搜索采集，来自 XLSX 导入）。",
      inputSchema: z.object({}),
      execute: () => ({ batches: listCollectorBatches(resolvedWorkspaceId) }),
    }),
    collector_search_items: tool({
      description: "检索已导入的抖音/小红书抓取内容（标题、作者、互动数据），用于素材调研和竞品图文对比。",
      inputSchema: z.object({
        keyword: z.string().optional().describe("按标题/作者模糊匹配"),
        platform: z.string().optional().describe("douyin 或 xhs"),
        batchId: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(30),
      }),
      execute: (input) => ({
        items: searchCollectorItems(resolvedWorkspaceId, {
          keyword: input.keyword,
          platform: input.platform,
          batchId: input.batchId,
          limit: input.limit,
        }),
      }),
    }),
  };
}
