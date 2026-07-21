"""视频修复增强调度脚本（部署于服务机 D:\\hyk_sort\\workspace\\video-toolbox\\enhance\\）。

流程：逐帧读取 → Real-ESRGAN（realesr-general-x4v3，通用真实场景降质/压缩伪影修复）
逐帧超分（tile 分块推理，显存占用与帧分辨率解耦，不随视频长度增长）→ PNG 序列
→ ffmpeg 重编码 → 合并原音轨。

网关契约：
  .venv/Scripts/python.exe toolbox_run.py --input <视频> --output-dir <产物目录> --params <JSON>
  params: {"outscale": 4}  # 放大倍数，2 或 4，默认 4
  stdout 的「PROGRESS <0-100> <阶段>」驱动前端进度条。
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

# 直跑时控制台可能是 GBK，转发子进程输出会因替换字符炸掉；统一成 UTF-8 自洽
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

BASE_DIR = Path(__file__).resolve().parent
WEIGHTS_PATH = BASE_DIR / "weights" / "realesr-general-x4v3.pth"

# 分块推理边长：把单帧切成不超过此边长的小块分别推理，显存占用由块大小决定，
# 与帧分辨率、视频总长度无关（不会重现 ProPainter 那种随帧数线性增长的显存问题）。
TILE_SIZE = 512
TILE_PAD = 10


def progress(percent: int, stage: str) -> None:
    print(f"PROGRESS {percent} {stage}", flush=True)


def build_upsampler(half: bool):
    import torch
    from basicsr.archs.srvgg_arch import SRVGGNetCompact
    from realesrgan import RealESRGANer

    model = SRVGGNetCompact(
        num_in_ch=3, num_out_ch=3, num_feat=64, num_conv=32, upscale=4, act_type="prelu"
    )
    return RealESRGANer(
        scale=4,
        model_path=str(WEIGHTS_PATH),
        model=model,
        tile=TILE_SIZE,
        tile_pad=TILE_PAD,
        pre_pad=10,
        half=half and torch.cuda.is_available(),
    )


def enhance_frames(video: Path, frames_dir: Path, outscale: float, frame_count: int) -> None:
    """逐帧读取→超分→写 PNG 序列（原地流式处理，不把整段视频读进内存）。"""
    import cv2
    import torch

    upsampler = build_upsampler(half=True)
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise RuntimeError("无法读取视频")

    frames_dir.mkdir(parents=True, exist_ok=True)
    idx = 0
    last_pct = -1
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        try:
            output, _ = upsampler.enhance(frame, outscale=outscale)
        except torch.cuda.OutOfMemoryError:
            # 极端分辨率兜底：缩小分块边长重建一次 upsampler 重试当前帧。
            torch.cuda.empty_cache()
            upsampler.tile_size = max(128, TILE_SIZE // 2)
            output, _ = upsampler.enhance(frame, outscale=outscale)
        cv2.imwrite(str(frames_dir / f"{idx:06d}.png"), output, [cv2.IMWRITE_PNG_COMPRESSION, 1])
        idx += 1
        pct = 10 + int(idx / frame_count * 80) if frame_count else 10
        if pct != last_pct:
            progress(pct, f"超分中 {idx}/{frame_count} 帧")
            last_pct = pct
    cap.release()
    if idx == 0:
        raise RuntimeError("视频没有可读取的帧")


def encode_video(frames_dir: Path, fps: float, dest: Path) -> None:
    import imageio_ffmpeg

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    result = subprocess.run(
        [
            ffmpeg, "-y",
            "-framerate", f"{fps:.3f}",
            "-i", str(frames_dir / "%06d.png"),
            "-c:v", "libx264", "-preset", "fast", "-crf", "18",
            "-pix_fmt", "yuv420p",
            str(dest),
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 or not dest.exists():
        raise RuntimeError(f"重编码失败：{result.stderr[-300:]}")


def merge_audio(video_no_audio: Path, source: Path, dest: Path) -> None:
    """把原视频音轨并回超分结果；源无音轨或合并失败则直接用无声结果。"""
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

    video = Path(args.input).resolve()
    out_dir = Path(args.output_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    params = json.loads(args.params)
    outscale = float(params.get("outscale", 4))
    if outscale not in (2.0, 4.0):
        outscale = 4.0

    if not video.is_file():
        print(f"输入视频不存在：{video}", flush=True)
        return 2
    if not WEIGHTS_PATH.is_file():
        print(f"缺少模型权重：{WEIGHTS_PATH}", flush=True)
        return 2

    progress(2, "读取视频信息")
    import cv2

    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        print("无法读取视频", flush=True)
        return 2
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()

    progress(5, "加载超分模型")
    frames_dir = out_dir / "_frames"
    enhance_frames(video, frames_dir, outscale, frame_count)

    progress(92, "重新编码视频")
    encoded = out_dir / "_encoded.mp4"
    encode_video(frames_dir, fps, encoded)
    shutil.rmtree(frames_dir, ignore_errors=True)

    progress(96, "合并原音轨")
    merge_audio(encoded, video, out_dir / "enhanced.mp4")
    encoded.unlink(missing_ok=True)

    progress(100, "完成")
    return 0


if __name__ == "__main__":
    sys.exit(main())
