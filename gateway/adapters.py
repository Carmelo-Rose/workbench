"""能力注册表与 adapter 命令构造。

capabilities.json 是整个工具箱的"口子"：
- status=ready 且带 adapter 配置的能力可被提交任务；
- status=planned 的能力仅在 /capabilities 中露出（前端显示"即将上线"）；
- 新能力接入 = 在服务机装好它的独立 venv + 补一段 adapter 配置，网关代码零改动。

adapter 配置示例：
  {
    "cwd": "D:/hyk_sort/workspace/smart-erase",
    "command": ["{cwd}/.venv/Scripts/python.exe", "toolbox_run.py",
                "--input", "{input.video}", "--output-dir", "{output_dir}",
                "--params", "{params_json}"],
    "env": {"KMP_DUPLICATE_LIB_OK": "TRUE"},
    "timeout_sec": 7200
  }

占位符：{input}（=input.video 或首个输入）、{input.<字段>}、{output_dir}、
{job_dir}、{params_json}、{params.<键>}、{cwd}。

子进程约定：
- 退出码 0 视为成功，产物写入 {output_dir}；
- stdout 打印「PROGRESS <0-100> <阶段说明>」即可驱动进度条（可选）；
- 全部输出会落到任务目录 log.txt。
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from store import BASE_DIR, FILES_DIR, get_file, get_job, job_dir, output_dir

CAPABILITIES_PATH = BASE_DIR / "capabilities.json"

_cache: dict[str, Any] = {"mtime": None, "data": None}


class AdapterError(Exception):
    pass


def load_capabilities() -> list[dict[str, Any]]:
    """读取能力清单；带 mtime 缓存，改完 json 无需重启网关。"""
    mtime = CAPABILITIES_PATH.stat().st_mtime
    if _cache["mtime"] != mtime:
        with open(CAPABILITIES_PATH, encoding="utf-8") as f:
            _cache["data"] = json.load(f)["capabilities"]
        _cache["mtime"] = mtime
    return _cache["data"]


def get_capability(cap_id: str) -> dict[str, Any] | None:
    return next((c for c in load_capabilities() if c["id"] == cap_id), None)


def public_capability(cap: dict[str, Any]) -> dict[str, Any]:
    """对外暴露的字段（剥掉 adapter 内部配置）。"""
    return {
        "id": cap["id"],
        "name": cap.get("name", cap["id"]),
        "status": cap.get("status", "planned"),
        "description": cap.get("description", ""),
        "inputs_spec": cap.get("inputs_spec", []),
        "params_hint": cap.get("params_hint", {}),
    }


def resolve_input_ref(ref: str, workspace_id: str) -> Path:
    """输入引用 → 绝对路径。

    支持两种形式：
      "<file_id>" / "file:<file_id>"      → 上传的文件
      "job:<job_id>/<产物相对路径>"        → 复用其他任务的产物（能力串联）
    """
    if ref.startswith("job:"):
        rest = ref[len("job:"):]
        if "/" not in rest:
            raise AdapterError(f"非法的任务产物引用：{ref}")
        src_job, rel = rest.split("/", 1)
        if get_job(src_job, workspace_id) is None:
            raise AdapterError(f"引用的任务产物不存在：{ref}")
        path = (output_dir(src_job) / rel).resolve()
        if not str(path).startswith(str(output_dir(src_job).resolve())):
            raise AdapterError(f"产物引用越界：{ref}")
        if not path.is_file():
            raise AdapterError(f"引用的任务产物不存在：{ref}")
        return path

    file_id = ref[len("file:"):] if ref.startswith("file:") else ref
    if not re.fullmatch(r"[a-f0-9]{12}", file_id):
        raise AdapterError(f"非法的文件引用：{ref}")
    if get_file(file_id, workspace_id) is None:
        raise AdapterError(f"输入文件不存在或已清理：{ref}")
    folder = FILES_DIR / file_id
    # 下划线开头是派生文件（如 _poster.jpg），不算原始输入
    files = (
        [p for p in folder.iterdir() if p.is_file() and not p.name.startswith("_")]
        if folder.is_dir()
        else []
    )
    if not files:
        raise AdapterError(f"输入文件不存在或已清理：{ref}")
    return files[0]


def resolve_inputs(inputs: dict[str, str], workspace_id: str) -> dict[str, Path]:
    return {
        field: resolve_input_ref(ref, workspace_id)
        for field, ref in inputs.items()
    }


_PLACEHOLDER = re.compile(r"\{([a-zA-Z0-9_.]+)\}")


def build_command(
    cap: dict[str, Any], job: dict[str, Any]
) -> tuple[list[str], str, dict[str, str], int]:
    """返回 (argv, cwd, extra_env, timeout_sec)。"""
    adapter = cap.get("adapter")
    if not adapter or not adapter.get("command"):
        raise AdapterError(f"能力 {cap['id']} 未配置 adapter，无法执行")

    cwd = adapter.get("cwd", str(BASE_DIR))
    resolved = resolve_inputs(job["inputs"], job["workspace_id"])
    params = job["params"]

    def expand(match: re.Match[str]) -> str:
        key = match.group(1)
        if key == "cwd":
            return cwd
        if key == "output_dir":
            return str(output_dir(job["id"]))
        if key == "job_dir":
            return str(job_dir(job["id"]))
        if key == "params_json":
            return json.dumps(params, ensure_ascii=False)
        if key == "input":
            target = resolved.get("video") or next(iter(resolved.values()), None)
            if target is None:
                raise AdapterError("任务没有输入文件，无法展开 {input}")
            return str(target)
        if key.startswith("input."):
            field = key[len("input."):]
            if field not in resolved:
                raise AdapterError(f"缺少输入文件字段：{field}")
            return str(resolved[field])
        if key.startswith("params."):
            field = key[len("params."):]
            if field not in params:
                raise AdapterError(f"缺少参数：{field}")
            return str(params[field])
        raise AdapterError(f"未知占位符：{{{key}}}")

    argv = [_PLACEHOLDER.sub(expand, str(part)) for part in adapter["command"]]
    extra_env = {str(k): str(v) for k, v in adapter.get("env", {}).items()}
    timeout_sec = int(adapter.get("timeout_sec", 7200))
    return argv, cwd, extra_env, timeout_sec
