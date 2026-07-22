"""人物抠像换背景调度脚本（部署于服务机 D:\\hyk_sort\\workspace\\video-toolbox\\matting\\）。

流程：逐帧读取 → RVM（Robust Video Matting，mobilenetv3 变体，递归时序模型，
rec 状态跨帧传递保证抠像时序稳定不闪烁）→ 按纯色背景合成 → PNG 序列 →
ffmpeg 重编码 → 合并原音轨。

网关契约：
  .venv/Scripts/python.exe toolbox_run.py --input <视频> --output-dir <产物目录> --params <JSON>
  params: {"background": "white"}  # 颜色名（white/black/green/blue/gray/red）或 #rrggbb 十六进制，默认 white
  stdout 的「PROGRESS <0-100> <阶段>」驱动前端进度条。

model/ 是 vendor 进来的 PeterL1n/RobustVideoMatting 官方模型定义（MIT 协议），
权重 weights/rvm_mobilenetv3.pth 是官方 release 资产，二者均未改动。
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
WEIGHTS_PATH = BASE_DIR / "weights" / "rvm_mobilenetv3.pth"

# 背景色名到 BGR（cv2 通道序）的映射；也接受 "#rrggbb" 十六进制。
NAMED_COLORS_BGR = {
    "white": (255, 255, 255),
    "black": (0, 0, 0),
    "green": (0, 177, 64),
    "greenscreen": (0, 177, 64),
    "blue": (255, 0, 0),
    "bluescreen": (255, 0, 0),
    "gray": (128, 128, 128),
    "grey": (128, 128, 128),
    "red": (0, 0, 255),
}


def progress(percent: int, stage: str) -> None:
    print(f"PROGRESS {percent} {stage}", flush=True)


def parse_background_bgr(value: str) -> tuple[int, int, int]:
    v = (value or "").strip().lower()
    if v in NAMED_COLORS_BGR:
        return NAMED_COLORS_BGR[v]
    if v.startswith("#") and len(v) == 7:
        try:
            r, g, b = int(v[1:3], 16), int(v[3:5], 16), int(v[5:7], 16)
            return (b, g, r)
        except ValueError:
            pass
    return NAMED_COLORS_BGR["white"]


def build_model():
    import torch
    from model import MattingNetwork

    model = MattingNetwork(variant="mobilenetv3", refiner="deep_guided_filter")
    state_dict = torch.load(str(WEIGHTS_PATH), map_location="cpu")
    model.load_state_dict(state_dict)
    model = model.eval()
    if torch.cuda.is_available():
        model = model.cuda()
    return model


def matte_frames(
    video: Path, frames_dir: Path, bg_bgr: tuple[int, int, int], frame_count: int
) -> None:
    """逐帧读取→RVM 递归推理→纯色合成→写 PNG 序列（rec 状态跨帧串行传递，
    模型本身是递归结构，无法像 Real-ESRGAN 那样分块并行，只能顺序处理；
    好在 mobilenetv3 变体很轻，显存不是这个模型的瓶颈）。"""
    import cv2
    import numpy as np
    import torch

    model = build_model()
    device = next(model.parameters()).device
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise RuntimeError("无法读取视频")

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    # 官方推荐：较长边缩到约 512px 再推理，速度/质量的经验平衡点；refiner 会把
    # 结果引导滤波放大回原分辨率，不影响输出画质与尺寸。
    downsample_ratio = min(1.0, 512 / max(width, height))

    frames_dir.mkdir(parents=True, exist_ok=True)
    bg = np.full((height, width, 3), bg_bgr, dtype=np.uint8).astype(np.float32)

    rec: list = [None, None, None, None]
    idx = 0
    last_pct = -1
    with torch.no_grad():
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            src = torch.from_numpy(rgb).to(device, torch.float32).div(255)
            src = src.permute(2, 0, 1).unsqueeze(0)  # HWC -> 1CHW

            fgr, pha, *rec = model(src, *rec, downsample_ratio=downsample_ratio)

            fgr_np = fgr[0].permute(1, 2, 0).clamp(0, 1).mul(255).byte().cpu().numpy()
            pha_np = pha[0, 0].clamp(0, 1).cpu().numpy()[..., None]
            fgr_bgr = cv2.cvtColor(fgr_np, cv2.COLOR_RGB2BGR).astype(np.float32)

            composite = fgr_bgr * pha_np + bg * (1 - pha_np)
            composite = composite.clip(0, 255).astype(np.uint8)

            cv2.imwrite(
                str(frames_dir / f"{idx:06d}.png"),
                composite,
                [cv2.IMWRITE_PNG_COMPRESSION, 1],
            )
            idx += 1
            pct = 10 + int(idx / frame_count * 80) if frame_count else 10
            if pct != last_pct:
                progress(pct, f"抠像合成中 {idx}/{frame_count} 帧")
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
    """把原视频音轨并回合成结果；源无音轨或合并失败则直接用无声结果。"""
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
    bg_bgr = parse_background_bgr(str(params.get("background", "white")))

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

    progress(5, "加载抠像模型")
    frames_dir = out_dir / "_frames"
    matte_frames(video, frames_dir, bg_bgr, frame_count)

    progress(92, "重新编码视频")
    encoded = out_dir / "_encoded.mp4"
    encode_video(frames_dir, fps, encoded)
    shutil.rmtree(frames_dir, ignore_errors=True)

    progress(96, "合并原音轨")
    merge_audio(encoded, video, out_dir / "matted.mp4")
    encoded.unlink(missing_ok=True)

    progress(100, "完成")
    return 0


if __name__ == "__main__":
    sys.exit(main())
