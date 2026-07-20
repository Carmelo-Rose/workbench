"""SQLite 任务存储 + 数据目录布局。

目录结构：
  data/
    gateway.db
    files/<file_id>/<原始文件名>     # 上传的输入文件（可被多个任务引用）
    jobs/<job_id>/output/...        # 任务产物
    jobs/<job_id>/log.txt           # 子进程完整输出
"""

from __future__ import annotations

import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("TOOLBOX_DATA", str(BASE_DIR / "data")))
FILES_DIR = DATA_DIR / "files"
JOBS_DIR = DATA_DIR / "jobs"
DB_PATH = DATA_DIR / "gateway.db"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  capability TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  inputs TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  artifacts TEXT NOT NULL DEFAULT '[]',
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
"""

_JSON_FIELDS = ("params", "inputs", "artifacts")


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def new_id() -> str:
    return uuid.uuid4().hex[:12]


@contextmanager
def _conn() -> Iterator[sqlite3.Connection]:
    """每次操作独立连接（worker 线程与请求线程并存），退出时提交并关闭。"""
    conn = sqlite3.connect(DB_PATH, timeout=30)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        with conn:
            yield conn
    finally:
        conn.close()


def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    FILES_DIR.mkdir(parents=True, exist_ok=True)
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    with _conn() as conn:
        conn.executescript(_SCHEMA)


def job_dir(job_id: str) -> Path:
    return JOBS_DIR / job_id


def output_dir(job_id: str) -> Path:
    return job_dir(job_id) / "output"


def log_path(job_id: str) -> Path:
    return job_dir(job_id) / "log.txt"


def _row_to_job(row: sqlite3.Row) -> dict[str, Any]:
    job = dict(row)
    for field in _JSON_FIELDS:
        job[field] = json.loads(job[field])
    job["cancel_requested"] = bool(job["cancel_requested"])
    return job


def create_job(capability: str, params: dict, inputs: dict) -> dict[str, Any]:
    job_id = new_id()
    with _conn() as conn:
        conn.execute(
            "INSERT INTO jobs (id, capability, params, inputs, created_at) VALUES (?,?,?,?,?)",
            (
                job_id,
                capability,
                json.dumps(params, ensure_ascii=False),
                json.dumps(inputs, ensure_ascii=False),
                now_iso(),
            ),
        )
    output_dir(job_id).mkdir(parents=True, exist_ok=True)
    return get_job(job_id)  # type: ignore[return-value]


def get_job(job_id: str) -> dict[str, Any] | None:
    with _conn() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    return _row_to_job(row) if row else None


def list_jobs(limit: int = 50) -> list[dict[str, Any]]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
    return [_row_to_job(r) for r in rows]


def update_job(job_id: str, **fields: Any) -> None:
    if not fields:
        return
    cols, vals = [], []
    for key, value in fields.items():
        if key in _JSON_FIELDS:
            value = json.dumps(value, ensure_ascii=False)
        elif key == "cancel_requested":
            value = int(value)
        cols.append(f"{key}=?")
        vals.append(value)
    vals.append(job_id)
    with _conn() as conn:
        conn.execute(f"UPDATE jobs SET {', '.join(cols)} WHERE id=?", vals)


def next_queued() -> dict[str, Any] | None:
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 1"
        ).fetchone()
    return _row_to_job(row) if row else None


def count_by_status() -> dict[str, int]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT status, COUNT(*) AS n FROM jobs GROUP BY status"
        ).fetchall()
    return {r["status"]: r["n"] for r in rows}


def fail_interrupted_jobs() -> int:
    """网关重启后，把上次遗留的 running 任务标记为失败（进程已不在了）。"""
    with _conn() as conn:
        cur = conn.execute(
            "UPDATE jobs SET status='failed', error='网关重启，任务被中断', finished_at=? "
            "WHERE status='running'",
            (now_iso(),),
        )
        return cur.rowcount
