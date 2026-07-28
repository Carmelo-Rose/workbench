"""GPU worker：单线程串行消费任务队列。

2080 Ti 只有一张，所有能力共享显存，因此严格一次只跑一个任务。
子进程 stdout 里形如「PROGRESS 42 分割目标中」的行会被解析为进度。
"""

from __future__ import annotations

import os
import re
import subprocess
import threading
import time
from typing import Any

import store
from adapters import AdapterError, build_command, get_capability

_PROGRESS_RE = re.compile(r"^PROGRESS\s+(\d{1,3})\s*(.*)$")

POLL_INTERVAL = 1.0

PRODUCT_CUTOUT_CONCURRENCY = max(
    # Workbench fairly schedules at most six image cutouts per product folder and
    # the gateway is the final cross-client guardrail, but the binding limit is
    # the card.  The twelve this used to allow was safe only while the capability
    # ran on a CPU-only torch build; on the 2080 Ti one cutout reserves ~14.8 GiB
    # of the 22 GiB, two peak at 22.1 GiB, and three abort with a CUDA failure.
    # Two is therefore the hard ceiling, but one is the default: the second
    # process buys about 20% (9.9s to 8.0s per image) because a single one
    # already saturates the GPU, and it costs the card's entire spare margin --
    # 432 MiB is not enough for any other capability that shares it.
    # Workbench may still submit more; the surplus waits here, which is what
    # keeps the card fed between images.
    1, min(2, int(os.environ.get("TOOLBOX_PRODUCT_CUTOUT_CONCURRENCY", "1")))
)
_worker_threads: list[threading.Thread] = []


def start_worker() -> None:
    global _worker_threads
    if any(thread.is_alive() for thread in _worker_threads):
        return
    _worker_threads = [
        threading.Thread(
            target=_loop,
            kwargs={"capability": "product_cutout"},
            name=f"product-cutout-worker-{index + 1}",
            daemon=True,
        )
        for index in range(PRODUCT_CUTOUT_CONCURRENCY)
    ]
    _worker_threads.append(
        threading.Thread(
            target=_loop,
            kwargs={"exclude_capabilities": ("product_cutout",)},
            name="gpu-worker",
            daemon=True,
        )
    )
    for thread in _worker_threads:
        thread.start()


def worker_alive() -> bool:
    return bool(_worker_threads and all(thread.is_alive() for thread in _worker_threads))


def _loop(
    capability: str | None = None,
    exclude_capabilities: tuple[str, ...] = (),
) -> None:
    while True:
        try:
            job = store.claim_next_queued(capability, exclude_capabilities)
            if job:
                _run_job(job)
            else:
                time.sleep(POLL_INTERVAL)
        except Exception as exc:  # worker 自身绝不能死
            print(f"[worker] 未捕获异常：{exc!r}", flush=True)
            time.sleep(POLL_INTERVAL)


def _kill_tree(proc: subprocess.Popen) -> None:
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
            capture_output=True,
        )
    else:
        proc.kill()


def _log_tail(job_id: str, limit: int = 2000) -> str:
    try:
        text = store.log_path(job_id).read_text(encoding="utf-8", errors="replace")
        return text[-limit:]
    except OSError:
        return ""


def _scan_artifacts(job_id: str) -> list[dict[str, Any]]:
    out_dir = store.output_dir(job_id)
    artifacts = []
    for path in sorted(out_dir.rglob("*")):
        if path.is_file():
            artifacts.append(
                {
                    # 统一 posix 风格相对路径，前端拼 URL 不用关心 Windows 反斜杠。
                    "path": path.relative_to(out_dir).as_posix(),
                    "name": path.name,
                    "size": path.stat().st_size,
                }
            )
    return artifacts


def _run_job(job: dict[str, Any]) -> None:
    job_id = job["id"]
    store.update_job(
        job_id, status="running", stage="启动中", started_at=store.now_iso()
    )

    cap = get_capability(job["capability"])
    if cap is None or cap.get("status") != "ready":
        store.update_job(
            job_id,
            status="failed",
            error=f"能力 {job['capability']} 不可用",
            finished_at=store.now_iso(),
        )
        return

    try:
        argv, cwd, extra_env, timeout_sec = build_command(cap, job)
    except AdapterError as exc:
        store.update_job(
            job_id, status="failed", error=str(exc), finished_at=store.now_iso()
        )
        return

    store.output_dir(job_id).mkdir(parents=True, exist_ok=True)
    env = {
        **os.environ,
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUNBUFFERED": "1",
        **extra_env,
    }

    log_file = open(store.log_path(job_id), "w", encoding="utf-8")
    log_file.write(f"$ {subprocess.list2cmdline(argv)}\n(cwd: {cwd})\n\n")
    log_file.flush()

    try:
        proc = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
    except OSError as exc:
        log_file.write(f"启动失败：{exc}\n")
        log_file.close()
        store.update_job(
            job_id,
            status="failed",
            error=f"子进程启动失败：{exc}",
            finished_at=store.now_iso(),
        )
        return

    def _pump() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            try:
                log_file.write(line)
                log_file.flush()
            except ValueError:
                break  # 极端情况下主线程已关闭日志文件
            match = _PROGRESS_RE.match(line.strip())
            if match:
                progress = min(100, int(match.group(1)))
                stage = match.group(2).strip()
                store.update_job(job_id, progress=progress, stage=stage or "处理中")

    pump = threading.Thread(target=_pump, daemon=True)
    pump.start()

    started = time.monotonic()
    outcome: str | None = None
    while proc.poll() is None:
        time.sleep(0.5)
        if time.monotonic() - started > timeout_sec:
            _kill_tree(proc)
            outcome = "timeout"
            break
        current = store.get_job(job_id)
        if current and current["cancel_requested"]:
            _kill_tree(proc)
            outcome = "canceled"
            break

    proc.wait()
    pump.join(timeout=5)
    log_file.close()

    if outcome == "canceled":
        store.update_job(
            job_id, status="canceled", stage="已取消", finished_at=store.now_iso()
        )
    elif outcome == "timeout":
        store.update_job(
            job_id,
            status="failed",
            error=f"任务超时（>{timeout_sec}s），已终止",
            finished_at=store.now_iso(),
        )
    elif proc.returncode == 0:
        store.update_job(
            job_id,
            status="succeeded",
            progress=100,
            stage="完成",
            artifacts=_scan_artifacts(job_id),
            finished_at=store.now_iso(),
        )
    else:
        store.update_job(
            job_id,
            status="failed",
            error=f"退出码 {proc.returncode}\n{_log_tail(job_id)}",
            finished_at=store.now_iso(),
        )
