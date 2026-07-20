"""智能擦除 v1 调度脚本（部署于服务机 D:\\hyk_sort\\workspace\\video-toolbox\\erase\\）。

流程：框选区域 → 生成全片静态 mask → ProPainter 补绘 → 回并原音轨。
覆盖字幕/水印/台标/贴纸等固定位置目标；运动目标的点选追踪是 v2（SAM2）。

网关契约：
  .venv/Scripts/python.exe toolbox_run.py --input <视频> --output-dir <产物目录> --params <JSON>
  params: {"regions": [{"x":0.1,"y":0.8,"w":0.5,"h":0.1}, ...]}  # 相对首帧的归一化坐标
  stdout 的「PROGRESS <0-100> <阶段>」驱动前端进度条。
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

# 直跑时控制台可能是 GBK，转发子进程输出会因替换字符炸掉；统一成 UTF-8 自洽
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

BASE_DIR = Path(__file__).resolve().parent
PROPAINTER_DIR = BASE_DIR / "ProPainter"

# 长边超过此值就等比缩小：控制 2080 Ti 22G 上的显存与耗时
MAX_LONG_SIDE = 1280


def progress(percent: int, stage: str) -> None:
    print(f"PROGRESS {percent} {stage}", flush=True)


def build_mask(regions: list[dict], width: int, height: int, dest: Path) -> None:
    import cv2
    import numpy as np

    mask = np.zeros((height, width), dtype=np.uint8)
    for r in regions:
        x0 = max(0, int(float(r["x"]) * width))
        y0 = max(0, int(float(r["y"]) * height))
        x1 = min(width, int((float(r["x"]) + float(r["w"])) * width))
        y1 = min(height, int((float(r["y"]) + float(r["h"])) * height))
        if x1 > x0 and y1 > y0:
            mask[y0:y1, x0:x1] = 255
    if not mask.any():
        raise ValueError("框选区域为空或超出画面")
    cv2.imwrite(str(dest), mask)


def run_propainter(video: Path, mask: Path, work_dir: Path, fps: float, ratio: float) -> Path:
    cmd = [
        sys.executable,
        "inference_propainter.py",
        "--video", str(video),
        "--mask", str(mask),
        "--output", str(work_dir),
        "--save_fps", str(int(round(fps)) or 30),
        "--fp16",
    ]
    if ratio < 1.0:
        cmd += ["--resize_ratio", f"{ratio:.3f}"]

    proc = subprocess.Popen(
        cmd,
        cwd=str(PROPAINTER_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    # tqdm 用 \r 刷新进度，需要按 \r/\n 双分隔流式解析
    pct_re = re.compile(r"(\d{1,3})%\|")
    assert proc.stdout is not None
    buffer = ""
    while True:
        chunk = proc.stdout.read(256)
        if not chunk:
            break
        buffer += chunk
        parts = re.split(r"[\r\n]", buffer)
        buffer = parts.pop()
        for part in parts:
            if part.strip():
                print(part, flush=True)
            m = pct_re.search(part)
            if m:
                inner = min(100, int(m.group(1)))
                progress(10 + int(inner * 0.85), "补绘中")
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"ProPainter 退出码 {proc.returncode}")

    results = sorted(work_dir.rglob("inpaint_out.mp4"))
    if not results:
        raise RuntimeError("未找到补绘输出 inpaint_out.mp4")
    return results[0]


def merge_audio(video_no_audio: Path, source: Path, dest: Path) -> None:
    """把原视频音轨并回补绘结果；源无音轨或合并失败则直接用无声结果。"""
    try:
        import imageio_ffmpeg

        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        result = subprocess.run(
            [
                ffmpeg, "-y",
                "-i", str(video_no_audio),
                "-i", str(source),
                "-map", "0:v:0", "-map", "1:a:0?",
                "-c:v", "copy", "-c:a", "aac", "-shortest",
                str(dest),
            ],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0 and dest.exists():
            return
        print(f"音轨合并失败，使用无声输出：{result.stderr[-300:]}", flush=True)
    except Exception as exc:
        print(f"音轨合并异常，使用无声输出：{exc}", flush=True)
    shutil.copy2(video_no_audio, dest)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--params", default="{}")
    args = parser.parse_args()

    # 子进程以 ProPainter 目录为 cwd，路径必须先转绝对
    video = Path(args.input).resolve()
    out_dir = Path(args.output_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    params = json.loads(args.params)
    regions = params.get("regions") or []
    if not regions:
        print("缺少 regions（框选区域），无法擦除", flush=True)
        return 2
    if not video.is_file():
        print(f"输入视频不存在：{video}", flush=True)
        return 2

    progress(2, "读取视频信息")
    import cv2

    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        print("无法读取视频", flush=True)
        return 2
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    cap.release()

    progress(5, "生成擦除蒙版")
    mask_path = out_dir / "mask.png"
    build_mask(regions, width, height, mask_path)

    progress(8, "启动补绘引擎")
    work_dir = out_dir / "_propainter"
    ratio = min(1.0, MAX_LONG_SIDE / max(width, height))
    inpainted = run_propainter(video, mask_path, work_dir, fps, ratio)

    progress(96, "合并原音轨")
    merge_audio(inpainted, video, out_dir / "erased.mp4")
    shutil.rmtree(work_dir, ignore_errors=True)

    progress(100, "完成")
    return 0


if __name__ == "__main__":
    sys.exit(main())
