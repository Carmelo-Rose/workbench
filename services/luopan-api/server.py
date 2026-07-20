#!/usr/bin/env python3
"""luopan 只读数据 API sidecar。

部署在 luopan 采集机上，把 SQLite 快照/事件数据以只读 HTTP API 暴露给
Workbench 的 Agent 工具（luopan_query_*）。零第三方依赖，标准库直接跑：

    LUOPAN_DB_PATH=D:/luopan/data/compass.db python server.py

环境变量：
    LUOPAN_DB_PATH   luopan 的 compass.db 路径（默认 ../../data/compass.db 相对本文件）
    LUOPAN_API_PORT  监听端口（默认 8788）
    LUOPAN_API_HOST  监听地址（默认 127.0.0.1；给内网 Workbench 用时改 0.0.0.0）
    LUOPAN_API_TOKEN 可选 Bearer Token；设置后所有请求必须携带

采集管线（run.py 定时 → 飞书表 → 企微）完全不受影响：本服务以
sqlite3 URI 只读模式打开数据库，不加写锁。
"""

import json
import os
import re
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

DB_PATH = os.getenv(
    "LUOPAN_DB_PATH",
    str(Path(__file__).resolve().parent.parent.parent / "data" / "compass.db"),
)
HOST = os.getenv("LUOPAN_API_HOST", "127.0.0.1")
PORT = int(os.getenv("LUOPAN_API_PORT", "8788"))
TOKEN = os.getenv("LUOPAN_API_TOKEN", "")

SCOPE_PREFIXES = {"video_order", "video_acc", "card_order"}


def open_db() -> sqlite3.Connection:
    connection = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def rows_to_dicts(rows) -> list:
    return [dict(row) for row in rows]


def clamp(value, default, low, high) -> int:
    try:
        return max(low, min(int(value), high))
    except (TypeError, ValueError):
        return default


def scope_condition(params) -> tuple:
    """scope_key 精确匹配优先，其次按榜单前缀过滤。"""
    scope_key = (params.get("scope_key") or [""])[0]
    if scope_key:
        return "scope_key = ?", [scope_key]
    prefix = (params.get("scope_prefix") or [""])[0]
    if prefix:
        if prefix not in SCOPE_PREFIXES:
            raise ValueError(f"scope_prefix 只支持 {sorted(SCOPE_PREFIXES)}")
        return "scope_key LIKE ?", [prefix + "_%"]
    return "1=1", []


def query_rounds(params) -> dict:
    condition, args = scope_condition(params)
    limit = clamp((params.get("limit") or [None])[0], 10, 1, 50)
    with open_db() as db:
        rows = db.execute(
            f"""SELECT run_id,
                       COUNT(DISTINCT scope_key) AS scope_count,
                       COUNT(*) AS item_count,
                       MIN(captured_at) AS captured_at
                FROM products_snapshot WHERE {condition}
                GROUP BY run_id ORDER BY run_id DESC LIMIT ?""",
            [*args, limit],
        ).fetchall()
    return {"rounds": rows_to_dicts(rows)}


def latest_run_id(db, table: str, condition: str, args: list):
    row = db.execute(
        f"SELECT MAX(run_id) AS run_id FROM {table} WHERE {condition}", args
    ).fetchone()
    return row["run_id"] if row else None


def query_snapshot(params) -> dict:
    condition, args = scope_condition(params)
    limit = clamp((params.get("limit") or [None])[0], 50, 1, 200)
    offset = clamp((params.get("offset") or [None])[0], 0, 0, 10_000)
    with open_db() as db:
        run_id = (params.get("run_id") or [""])[0] or latest_run_id(
            db, "products_snapshot", condition, args
        )
        if not run_id:
            return {"run_id": None, "items": []}
        rows = db.execute(
            f"""SELECT run_id, scope_key, rank, product_id, product_title, shop_info,
                       price_range, pay_amount, clicks, conversion_rate,
                       industry_name, category_name, leaf_category_name, captured_at
                FROM products_snapshot
                WHERE run_id = ? AND {condition}
                ORDER BY scope_key, rank LIMIT ? OFFSET ?""",
            [run_id, *args, limit, offset],
        ).fetchall()
    return {"run_id": run_id, "items": rows_to_dicts(rows)}


def query_trend(product_id: str, params) -> dict:
    condition, args = scope_condition(params)
    limit = clamp((params.get("limit") or [None])[0], 30, 1, 100)
    with open_db() as db:
        rows = db.execute(
            f"""SELECT run_id, scope_key, rank, product_title, pay_amount, captured_at
                FROM products_snapshot
                WHERE product_id = ? AND {condition}
                ORDER BY run_id DESC LIMIT ?""",
            [product_id, *args, limit],
        ).fetchall()
    points = rows_to_dicts(rows)
    points.reverse()  # 时间正序，方便看趋势
    return {"product_id": product_id, "points": points}


def query_events(params) -> dict:
    condition, args = scope_condition(params)
    limit = clamp((params.get("limit") or [None])[0], 50, 1, 200)
    event_type = (params.get("event_type") or [""])[0]
    extra = ""
    if event_type:
        if event_type not in {"NEW_ENTRY", "RANK_UP_50", "RANK_UP_100", "RANK_UP_150"}:
            raise ValueError("event_type 无效")
        extra = " AND event_type = ?"
        args = [*args, event_type]
    with open_db() as db:
        run_id = (params.get("run_id") or [""])[0] or latest_run_id(
            db, "ranking_event", "1=1", []
        )
        if not run_id:
            return {"run_id": None, "events": []}
        rows = db.execute(
            f"""SELECT run_id, scope_key, event_type, product_id, product_title, shop_info,
                       rank_current, rank_previous, rank_delta, price, pay_amount,
                       industry_name, category_name, leaf_category_name, created_at
                FROM ranking_event
                WHERE run_id = ? AND {condition}{extra}
                ORDER BY rank_delta DESC, rank_current LIMIT ?""",
            [run_id, *args, limit],
        ).fetchall()
    return {"run_id": run_id, "events": rows_to_dicts(rows)}


TREND_ROUTE = re.compile(r"^/api/products/([^/]+)/trend$")


class Handler(BaseHTTPRequestHandler):
    server_version = "luopan-api/1.0"

    def do_GET(self):  # noqa: N802 (http.server 命名约定)
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        try:
            if TOKEN:
                authorization = self.headers.get("Authorization", "")
                if authorization != f"Bearer {TOKEN}":
                    return self.send_json({"error": "未授权"}, 401)

            if parsed.path == "/health":
                return self.send_json({"ok": True, "db": DB_PATH})
            if parsed.path == "/api/rounds":
                return self.send_json(query_rounds(params))
            if parsed.path == "/api/snapshot":
                return self.send_json(query_snapshot(params))
            if parsed.path == "/api/events":
                return self.send_json(query_events(params))
            trend = TREND_ROUTE.match(parsed.path)
            if trend:
                return self.send_json(query_trend(trend.group(1), params))
            return self.send_json({"error": "接口不存在"}, 404)
        except ValueError as error:
            return self.send_json({"error": str(error)}, 400)
        except sqlite3.OperationalError as error:
            return self.send_json({"error": f"数据库不可用：{error}"}, 503)

    def send_json(self, payload: dict, status: int = 200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # 精简日志：只打一行
        print(f"[luopan-api] {self.address_string()} {fmt % args}")


if __name__ == "__main__":
    if not Path(DB_PATH).exists():
        raise SystemExit(f"找不到数据库：{DB_PATH}（请设置 LUOPAN_DB_PATH）")
    print(f"[luopan-api] serving http://{HOST}:{PORT} db={DB_PATH} auth={'on' if TOKEN else 'off'}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
