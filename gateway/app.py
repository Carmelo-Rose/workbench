"""视频工具箱 Job 网关。

跑在 AILAB 服务机（192.168.1.198:8100），为 workbench 提供统一的
异步视频处理任务协议：上传输入 → 提交任务 → 轮询状态 → 下载产物。
能力清单与各能力的执行方式全部由 capabilities.json 驱动。
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel, Field

import store
import worker
from adapters import (
    AdapterError,
    get_capability,
    load_capabilities,
    public_capability,
    resolve_input_ref,
    resolve_inputs,
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    store.init_db()
    interrupted = store.fail_interrupted_jobs()
    if interrupted:
        print(f"[gateway] 标记了 {interrupted} 个被重启中断的任务", flush=True)
    worker.start_worker()
    yield


app = FastAPI(title="video-toolbox-gateway", lifespan=lifespan)


def check_token(request: Request) -> None:
    expected = os.environ.get("TOOLBOX_TOKEN")
    if expected and request.headers.get("x-toolbox-token") != expected:
        raise HTTPException(status_code=401, detail="invalid token")


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "worker_alive": worker.worker_alive(),
        "jobs": store.count_by_status(),
    }


@app.get("/capabilities", dependencies=[Depends(check_token)])
def capabilities() -> dict[str, Any]:
    return {"capabilities": [public_capability(c) for c in load_capabilities()]}


def _safe_filename(name: str) -> str:
    name = Path(name.replace("\\", "/")).name.strip()
    name = re.sub(r'[<>:"|?*\x00-\x1f]', "_", name)
    return name or "input.bin"


def _file_meta(file_id: str, path: Path) -> dict[str, Any]:
    return {"file_id": file_id, "name": path.name, "size": path.stat().st_size}


@app.post("/files", dependencies=[Depends(check_token)])
def upload_file(file: UploadFile) -> dict[str, Any]:
    """multipart 上传（curl / 调试用）。"""
    file_id = store.new_id()
    folder = store.FILES_DIR / file_id
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / _safe_filename(file.filename or "input.bin")
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)
    return _file_meta(file_id, dest)


@app.post("/files/raw", dependencies=[Depends(check_token)])
async def upload_raw(request: Request, name: str = "input.bin") -> dict[str, Any]:
    """裸字节流上传（workbench 代理走这条，全程流式不落内存）。"""
    file_id = store.new_id()
    folder = store.FILES_DIR / file_id
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / _safe_filename(name)
    size = 0
    with open(dest, "wb") as f:
        async for chunk in request.stream():
            size += len(chunk)
            f.write(chunk)
    if size == 0:
        shutil.rmtree(folder, ignore_errors=True)
        raise HTTPException(status_code=400, detail="empty upload")
    return _file_meta(file_id, dest)


@app.get("/files/{file_id}/poster", dependencies=[Depends(check_token)])
def file_poster(file_id: str) -> FileResponse:
    """视频首帧缩略图（前端框选界面用），首次请求时用 ffmpeg 抽取并缓存。"""
    try:
        src = resolve_input_ref(file_id)
    except AdapterError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    poster = src.parent / "_poster.jpg"
    if not poster.exists():
        import imageio_ffmpeg

        result = subprocess.run(
            [
                imageio_ffmpeg.get_ffmpeg_exe(),
                "-y", "-i", str(src),
                "-frames:v", "1", "-q:v", "3",
                str(poster),
            ],
            capture_output=True,
        )
        if result.returncode != 0 or not poster.exists():
            raise HTTPException(status_code=500, detail="无法提取视频首帧")
    return FileResponse(poster, media_type="image/jpeg")


class SubmitJob(BaseModel):
    capability: str
    params: dict[str, Any] = Field(default_factory=dict)
    inputs: dict[str, str] = Field(default_factory=dict)


@app.post("/jobs", dependencies=[Depends(check_token)])
def submit_job(body: SubmitJob) -> dict[str, Any]:
    cap = get_capability(body.capability)
    if cap is None:
        raise HTTPException(status_code=400, detail=f"未知能力：{body.capability}")
    if cap.get("status") != "ready":
        raise HTTPException(
            status_code=400, detail=f"能力 {cap.get('name', cap['id'])} 尚未上线"
        )

    for spec in cap.get("inputs_spec", []):
        if spec.get("required") and spec["field"] not in body.inputs:
            raise HTTPException(
                status_code=400, detail=f"缺少输入文件：{spec['field']}"
            )
    try:
        # 提交时就把引用解析一遍，坏引用立刻报错而不是排队后才失败。
        resolve_inputs(body.inputs)
    except AdapterError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return store.create_job(body.capability, body.params, body.inputs)


@app.get("/jobs", dependencies=[Depends(check_token)])
def list_jobs(limit: int = 50) -> dict[str, Any]:
    return {"jobs": store.list_jobs(limit)}


def _get_job_or_404(job_id: str) -> dict[str, Any]:
    job = store.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return job


@app.get("/jobs/{job_id}", dependencies=[Depends(check_token)])
def get_job(job_id: str) -> dict[str, Any]:
    return _get_job_or_404(job_id)


@app.post("/jobs/{job_id}/cancel", dependencies=[Depends(check_token)])
def cancel_job(job_id: str) -> dict[str, Any]:
    job = _get_job_or_404(job_id)
    if job["status"] == "queued":
        # 同时置 cancel_requested：万一 worker 恰好在这瞬间取走任务，仍能被杀掉。
        store.update_job(
            job_id,
            status="canceled",
            stage="已取消",
            cancel_requested=True,
            finished_at=store.now_iso(),
        )
    elif job["status"] == "running":
        store.update_job(job_id, cancel_requested=True)
    return _get_job_or_404(job_id)


@app.get("/jobs/{job_id}/artifacts/{path:path}", dependencies=[Depends(check_token)])
def get_artifact(job_id: str, path: str) -> FileResponse:
    _get_job_or_404(job_id)
    out_dir = store.output_dir(job_id).resolve()
    target = (out_dir / path).resolve()
    if not str(target).startswith(str(out_dir)) or not target.is_file():
        raise HTTPException(status_code=404, detail="artifact not found")
    return FileResponse(target, filename=target.name)


@app.get("/jobs/{job_id}/log", dependencies=[Depends(check_token)])
def get_log(job_id: str, tail: int = 8000) -> PlainTextResponse:
    _get_job_or_404(job_id)
    try:
        text = store.log_path(job_id).read_text(encoding="utf-8", errors="replace")
    except OSError:
        text = ""
    return PlainTextResponse(text[-tail:])
