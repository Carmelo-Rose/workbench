import { describe, expect, it } from "vitest";
import { getLuopanRankInsights } from "./insights";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL) {
  if (input instanceof URL) return input;
  if (input instanceof Request) return new URL(input.url);
  return new URL(input);
}

describe("getLuopanRankInsights", () => {
  it("distinguishes a connected but empty source from an unavailable service", async () => {
    const result = await getLuopanRankInsights({
      baseUrl: "http://luopan.test",
      now: new Date("2026-07-23T10:00:00.000Z"),
      fetcher: async (input) => {
        const url = requestUrl(input);
        if (url.pathname === "/health") return json({ ok: true, database: "sqlite" });
        if (url.pathname === "/api/rounds") return json({ rounds: [] });
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    expect(result).toMatchObject({
      status: "no_snapshot",
      totalEvents: 0,
      events: [],
    });
    expect(result.message).toContain("没有采集快照");
  });

  it("pins events to the selected scoped snapshot run and returns one priority-sorted result", async () => {
    const calls: URL[] = [];
    const result = await getLuopanRankInsights({
      baseUrl: "http://luopan.test",
      now: new Date("2026-07-23T10:00:00.000Z"),
      fetcher: async (input) => {
        const url = requestUrl(input);
        calls.push(url);
        if (url.pathname === "/health") return json({ ok: true });
        if (url.pathname === "/api/rounds") {
          return json({
            rounds: [{
              run_id: "run-video-order",
              scope_count: 19,
              item_count: 3665,
              captured_at: "2026-07-23T09:30:00.000Z",
            }],
          });
        }
        if (url.pathname === "/api/events") {
          return json({
            run_id: "run-video-order",
            total: 502,
            events: [
              { event_type: "NEW_ENTRY", product_title: "新进商品", rank_current: 12 },
              { event_type: "RANK_UP_100", product_title: "急升商品", rank_delta: 124, rank_current: 28 },
            ],
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    expect(result).toMatchObject({
      status: "ready",
      totalEvents: 502,
      latestRound: { runId: "run-video-order", itemCount: 3665 },
    });
    expect(result.events.map((event) => event.productTitle)).toEqual(["急升商品", "新进商品"]);
    const eventRequest = calls.find((url) => url.pathname === "/api/events");
    expect(eventRequest?.searchParams.get("scope_prefix")).toBe("video_order");
    expect(eventRequest?.searchParams.get("run_id")).toBe("run-video-order");
  });

  it("marks a populated but outdated snapshot as stale", async () => {
    const result = await getLuopanRankInsights({
      baseUrl: "http://luopan.test",
      now: new Date("2026-07-23T10:00:00.000Z"),
      staleAfterMs: 60 * 60 * 1000,
      fetcher: async (input) => {
        const url = requestUrl(input);
        if (url.pathname === "/health") return json({ ok: true });
        if (url.pathname === "/api/rounds") {
          return json({
            rounds: [{ run_id: "old-run", item_count: 200, captured_at: "2026-07-23T07:00:00.000Z" }],
          });
        }
        if (url.pathname === "/api/events") return json({ run_id: "old-run", events: [] });
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    expect(result).toMatchObject({ status: "stale", totalEvents: 0 });
    expect(result.message).toContain("过期");
  });
});
