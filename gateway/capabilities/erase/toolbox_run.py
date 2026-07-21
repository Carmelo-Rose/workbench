"""智能擦除 v1 调度脚本（部署于服务机 D:\\hyk_sort\\workspace\\video-toolbox\\erase\\）。

流程：框选区域 → 生成全片静态 mask → （长视频先按帧数切段）→ ProPainter 补绘 →
（多段则 ffmpeg 无损拼接）→ 回并原音轨。
覆盖字幕/水印/台标/贴纸等固定位置目标；运动目标的点选追踪是 v2（SAM2）。

网关契约：
  .venv/Scripts/python.exe toolbox_run.py --input <视频> --output-dir <产物目录> --params <JSON>
  params: {"regions": [{"x":0.1,"y":0.8,"w":0.5,"h":0.1}, ...]}  # 相对首帧的归一化坐标
  stdout 的「PROGRESS <0-100> <阶段>」驱动前端进度条。
"""

from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Callable

# 直跑时控制台可能是 GBK，转发子进程输出会因替换字符炸掉；统一成 UTF-8 自洽
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

BASE_DIR = Path(__file__).resolve().parent
PROPAINTER_DIR = BASE_DIR / "ProPainter"

# 长边超过此值就等比缩小：控制 2080 Ti 22G 上的显存与耗时
MAX_LONG_SIDE = 960

# 单次调用 ProPainter 能安全处理的帧数上限（经验值，非精确测算）。
# 官方推理脚本把整段视频的 frames/flow_masks/masks_dilated 等张量一次性搬上显存，
# --subvideo_length 只切分中间计算阶段、不切分这几个常驻张量，显存占用近似与帧数
# 线性相关、跟单帧分辨率关系不大。实测 720×1280 源（按 MAX_LONG_SIDE 降到约
# 540×960）在 353 帧时才堪堪跑完、显存全程贴着 2080Ti 22G 上限；713 帧时会在
# WDDM 驱动的显存边界假死（GPU 100%但显存与进度长时间冻结，不是干净报 OOM）。
# 这里留足安全余量：超过就按帧数切段，分别跑 ProPainter 再用 ffmpeg 无损拼接，
# 帧率/画质完全不降级，只是段与段交界处可能有轻微不连续（ProPainter 的时序一致性
# 窗口不跨段）。
CHUNK_FRAMES = 240


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


def run_propainter(
    video: Path,
    mask: Path,
    work_dir: Path,
    fps: float,
    ratio: float,
    on_progress: Callable[[int, str], None] | None = None,
) -> Path:
    """跑单次 ProPainter（一段视频，不做内部切段）。on_progress 默认按 10~95% 区间
    上报；分段编排（run_propainter_chunked）会传入按总段数折算过的回调。"""
    report = on_progress or (lambda inner, stage: progress(10 + int(inner * 0.85), stage))
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
                report(min(100, int(m.group(1))), "补绘中")
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"ProPainter 退出码 {proc.returncode}")

    results = sorted(work_dir.rglob("inpaint_out.mp4"))
    if not results:
        raise RuntimeError("未找到补绘输出 inpaint_out.mp4")
    return results[0]


def split_video_into_chunks(
    video: Path, chunks_dir: Path, fps: float, frame_count: int, chunk_frames: int
) -> list[Path]:
    """按帧序号（而非时间戳）切成互不重叠的连续片段，避免取整误差导致丢帧/重帧。"""
    import imageio_ffmpeg

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    chunks_dir.mkdir(parents=True, exist_ok=True)
    segments: list[Path] = []
    for i, start in enumerate(range(0, frame_count, chunk_frames)):
        end = min(frame_count, start + chunk_frames) - 1
        seg_path = chunks_dir / f"chunk_{i:03d}.mp4"
        result = subprocess.run(
            [
                ffmpeg, "-y", "-i", str(video),
                "-vf", f"select=between(n\\,{start}\\,{end}),setpts=PTS-STARTPTS",
                "-an", "-r", f"{fps:.3f}",
                "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                str(seg_path),
            ],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0 or not seg_path.exists():
            raise RuntimeError(f"切段失败（第 {i} 段，帧 {start}-{end}）：{result.stderr[-300:]}")
        segments.append(seg_path)
    return segments


def concat_videos(segments: list[Path], concat_dir: Path, dest: Path) -> None:
    """用 ffmpeg concat demuxer 无损拼接（同一套 ProPainter 参数产出的片段，编码
    参数一致，-c copy 不用重新编码）。"""
    import imageio_ffmpeg

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    list_path = concat_dir / "_concat_list.txt"
    with open(list_path, "w", encoding="utf-8") as f:
        for seg in segments:
            escaped = str(seg).replace("'", "'\\''")
            f.write(f"file '{escaped}'\n")
    result = subprocess.run(
        [ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(list_path), "-c", "copy", str(dest)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 or not dest.exists():
        raise RuntimeError(f"分段结果拼接失败：{result.stderr[-300:]}")


def run_propainter_chunked(
    video: Path, mask: Path, work_dir: Path, fps: float, ratio: float, frame_count: int
) -> Path:
    """帧数不超阈值就直接跑一次；超过则按 CHUNK_FRAMES 切段、逐段跑 ProPainter
    （进度按总段数折算，不会每段从头跳回去）、再无损拼接回一条完整视频。"""
    if frame_count <= CHUNK_FRAMES:
        return run_propainter(video, mask, work_dir, fps, ratio)

    total_chunks = math.ceil(frame_count / CHUNK_FRAMES)
    print(
        f"共 {frame_count} 帧，超过单次安全上限 {CHUNK_FRAMES}，切成 {total_chunks} 段分别补绘再拼接",
        flush=True,
    )

    segments_in = split_video_into_chunks(video, work_dir / "_chunks_input", fps, frame_count, CHUNK_FRAMES)

    segments_out: list[Path] = []
    for i, seg_video in enumerate(segments_in):
        def scaled_progress(inner: int, stage: str, _i: int = i) -> None:
            overall = (_i * 100 + inner) / total_chunks
            progress(10 + int(overall * 0.85), f"补绘中（{_i + 1}/{total_chunks}段）")

        seg_result = run_propainter(
            seg_video, mask, work_dir / f"chunk_{i:03d}", fps, ratio, on_progress=scaled_progress
        )
        segments_out.append(seg_result)

    concatenated = work_dir / "_concatenated.mp4"
    concat_videos(segments_out, work_dir, concatenated)
    return concatenated


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
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()

    progress(5, "生成擦除蒙版")
    mask_path = out_dir / "mask.png"
    build_mask(regions, width, height, mask_path)

    progress(8, "启动补绘引擎")
    work_dir = out_dir / "_propainter"
    ratio = min(1.0, MAX_LONG_SIDE / max(width, height))
    inpainted = run_propainter_chunked(video, mask_path, work_dir, fps, ratio, frame_count)

    progress(96, "合并原音轨")
    merge_audio(inpainted, video, out_dir / "erased.mp4")
    shutil.rmtree(work_dir, ignore_errors=True)

    progress(100, "完成")
    return 0


if __name__ == "__main__":
    sys.exit(main())
