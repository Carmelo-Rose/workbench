export const luopanScopePrefixes = ["video_order", "video_acc", "card_order"] as const;

export type LuopanScopePrefix = (typeof luopanScopePrefixes)[number];

export type LuopanInsightStatus =
  | "ready"
  | "stale"
  | "no_snapshot"
  | "no_event"
  | "unavailable"
  | "not_configured";

export type LuopanLatestRound = {
  runId: string;
  scopeCount?: number;
  itemCount?: number;
  capturedAt?: string;
};

export type LuopanRankingEvent = {
  runId?: string;
  scopeKey?: string;
  eventType?: string;
  productId?: string;
  productTitle?: string;
  shopInfo?: string;
  rankCurrent?: number;
  rankPrevious?: number;
  rankDelta?: number;
  price?: string;
  payAmount?: string;
  industryName?: string;
  categoryName?: string;
  leafCategoryName?: string;
  createdAt?: string;
};

export type LuopanRankInsights = {
  status: LuopanInsightStatus;
  scopePrefix: LuopanScopePrefix;
  fetchedAt: string;
  message: string;
  latestRound?: LuopanLatestRound;
  dataAsOf?: string;
  totalEvents: number;
  events: LuopanRankingEvent[];
};

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type LuopanRankInsightsOptions = {
  baseUrl?: string;
  token?: string;
  fetcher?: Fetcher;
  now?: Date;
  staleAfterMs?: number;
  scopePrefix?: LuopanScopePrefix;
  limit?: number;
};

type ApiRecord = Record<string, unknown>;

const EVENT_PRIORITY: Record<string, number> = {
  RANK_UP_150: 4,
  RANK_UP_100: 3,
  RANK_UP_50: 2,
  NEW_ENTRY: 1,
};

function asRecord(value: unknown): ApiRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as ApiRecord
    : undefined;
}

function asRecords(value: unknown): ApiRecord[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const record = asRecord(item);
        return record ? [record] : [];
      })
    : [];
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }
  return undefined;
}

function parseRound(record: ApiRecord): LuopanLatestRound | undefined {
  const runId = asString(record.run_id ?? record.runId);
  if (!runId) return undefined;
  return {
    runId,
    scopeCount: asNumber(record.scope_count ?? record.scopeCount),
    itemCount: asNumber(record.item_count ?? record.itemCount),
    capturedAt: asString(record.captured_at ?? record.capturedAt),
  };
}

function parseEvent(record: ApiRecord): LuopanRankingEvent {
  return {
    runId: asString(record.run_id ?? record.runId),
    scopeKey: asString(record.scope_key ?? record.scopeKey),
    eventType: asString(record.event_type ?? record.eventType),
    productId: asString(record.product_id ?? record.productId),
    productTitle: asString(record.product_title ?? record.productTitle),
    shopInfo: asString(record.shop_info ?? record.shopInfo),
    rankCurrent: asNumber(record.rank_current ?? record.rankCurrent),
    rankPrevious: asNumber(record.rank_previous ?? record.rankPrevious),
    rankDelta: asNumber(record.rank_delta ?? record.rankDelta),
    price: asString(record.price),
    payAmount: asString(record.pay_amount ?? record.payAmount),
    industryName: asString(record.industry_name ?? record.industryName),
    categoryName: asString(record.category_name ?? record.categoryName),
    leafCategoryName: asString(record.leaf_category_name ?? record.leafCategoryName),
    createdAt: asString(record.created_at ?? record.createdAt),
  };
}

function staleAfterMsFromEnvironment() {
  const hours = Number(process.env.LUOPAN_STALE_AFTER_HOURS ?? 30);
  return (Number.isFinite(hours) && hours > 0 ? hours : 30) * 60 * 60 * 1000;
}

function isStale(capturedAt: string | undefined, now: Date, staleAfterMs: number) {
  if (!capturedAt) return false;
  const capturedAtMs = Date.parse(capturedAt);
  return Number.isFinite(capturedAtMs) && now.getTime() - capturedAtMs > staleAfterMs;
}

function sortEvents(events: LuopanRankingEvent[]) {
  return [...events].sort((left, right) => {
    const priorityDiff = (EVENT_PRIORITY[right.eventType ?? ""] ?? 0) - (EVENT_PRIORITY[left.eventType ?? ""] ?? 0);
    if (priorityDiff !== 0) return priorityDiff;
    const rankDeltaDiff = (right.rankDelta ?? 0) - (left.rankDelta ?? 0);
    if (rankDeltaDiff !== 0) return rankDeltaDiff;
    return (left.rankCurrent ?? Number.MAX_SAFE_INTEGER) - (right.rankCurrent ?? Number.MAX_SAFE_INTEGER);
  });
}

function insight(
  status: LuopanInsightStatus,
  scopePrefix: LuopanScopePrefix,
  fetchedAt: string,
  message: string,
  extras: Partial<Omit<LuopanRankInsights, "status" | "scopePrefix" | "fetchedAt" | "message">> = {},
): LuopanRankInsights {
  return {
    status,
    scopePrefix,
    fetchedAt,
    message,
    totalEvents: 0,
    events: [],
    ...extras,
  };
}

async function fetchLuopanJson(
  baseUrl: string,
  token: string | undefined,
  fetcher: Fetcher,
  pathname: string,
  params: Record<string, string | number | undefined>,
) {
  const url = new URL(pathname, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }

  const response = await fetcher(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data = asRecord(await response.json().catch(() => undefined));
  if (!response.ok || !data) throw new Error("Luopan service request failed");
  return data;
}

/**
 * Produces one deterministic result for the rank-events capability.  This keeps
 * availability states out of the model loop and always pins events to the same
 * scoped snapshot run that the user is looking at.
 */
export async function getLuopanRankInsights(options: LuopanRankInsightsOptions = {}): Promise<LuopanRankInsights> {
  const scopePrefix = options.scopePrefix ?? "video_order";
  const now = options.now ?? new Date();
  const fetchedAt = now.toISOString();
  const baseUrl = options.baseUrl ?? process.env.LUOPAN_API_URL;
  if (!baseUrl) {
    return insight("not_configured", scopePrefix, fetchedAt, "罗盘数据服务尚未配置，无法判断当前榜单状态。");
  }

  const fetcher = options.fetcher ?? fetch;
  const token = options.token ?? process.env.LUOPAN_API_TOKEN;
  const limit = Math.max(1, Math.min(options.limit ?? 100, 200));

  try {
    const health = await fetchLuopanJson(baseUrl, token, fetcher, "health", {});
    if (health.ok === false) {
      return insight("unavailable", scopePrefix, fetchedAt, "罗盘数据服务暂不可用，请检查服务机连接。");
    }

    const roundsPayload = await fetchLuopanJson(baseUrl, token, fetcher, "api/rounds", {
      scope_prefix: scopePrefix,
      limit: 1,
    });
    const latestRound = parseRound(asRecords(roundsPayload.rounds)[0] ?? {});
    if (!latestRound) {
      return insight("no_snapshot", scopePrefix, fetchedAt, "数据服务已连通，但当前榜单还没有采集快照。", {
        latestRound: undefined,
      });
    }

    const eventsPayload = await fetchLuopanJson(baseUrl, token, fetcher, "api/events", {
      scope_prefix: scopePrefix,
      run_id: latestRound.runId,
      limit,
    });
    const events = sortEvents(asRecords(eventsPayload.events).map(parseEvent));
    const totalEvents = asNumber(eventsPayload.total ?? eventsPayload.total_count) ?? events.length;
    const stale = isStale(latestRound.capturedAt, now, options.staleAfterMs ?? staleAfterMsFromEnvironment());

    if (events.length === 0) {
      return insight(
        stale ? "stale" : "no_event",
        scopePrefix,
        fetchedAt,
        stale
          ? "榜单数据已过期，建议先检查采集任务后再判断是否有异动。"
          : "本轮榜单已同步，未检测到符合规则的异动。",
        { latestRound, dataAsOf: latestRound.capturedAt },
      );
    }

    return insight(
      stale ? "stale" : "ready",
      scopePrefix,
      fetchedAt,
        stale
          ? `检测到 ${totalEvents} 条异动，但数据已过期，结果仅供回溯。`
          : `本轮榜单已同步，检测到 ${totalEvents} 条异动。`,
      { latestRound, dataAsOf: latestRound.capturedAt, totalEvents, events },
    );
  } catch {
    return insight("unavailable", scopePrefix, fetchedAt, "罗盘数据服务暂不可用，请检查服务机和数据连接。");
  }
}
