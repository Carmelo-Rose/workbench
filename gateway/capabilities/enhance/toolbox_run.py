"""Video enhancement runner for the toolbox gateway.

Frames are enhanced one at a time with Real-ESRGAN. Each finished BGR frame is
immediately sent to FFmpeg through a raw-video pipe, so long videos do not
accumulate a large PNG sequence on disk. The master keeps the requested 2x/4x
size; when that exceeds a normal playback size, a second compatible rendition
is emitted.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

BASE_DIR = Path(__file__).resolve().parent
WEIGHTS_PATH = BASE_DIR / "weights" / "realesr-general-x4v3.pth"

# A 512 tile split a 720x1280 frame into six model calls on the 22G 2080 Ti.
# 1536 keeps that frame whole; larger sources safely fall back on OOM.
TILE_SIZE = 1536
TILE_FALLBACKS = (1024, 768, 512, 256)
TILE_PAD = 10

# A 4x 720x1280 video is 2880x5120 (5K).  Keep that master, but also create
# a smaller H.264 rendition for browser previews and normal local playback.
COMPATIBLE_MAX_SIDE = 1920
H264_NVENC_MAX_SIDE = 4096


def progress(percent: int, stage: str) -> None:
    print(f"PROGRESS {percent} {stage}", flush=True)


def build_upsampler(half: bool, tile_size: int):
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
        tile=tile_size,
        tile_pad=TILE_PAD,
        pre_pad=10,
        half=half and torch.cuda.is_available(),
    )


def video_encoder_args(ffmpeg: str, width: int, height: int) -> list[str]:
    """Use the fastest available encoder while keeping the preview H.264."""
    try:
        encoders = subprocess.run(
            [ffmpeg, "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        available = f"{encoders.stdout}\n{encoders.stderr}"
        # Turing H.264 NVENC cannot encode a 5K portrait master (2880x5120),
        # but HEVC NVENC can. The browser-facing compatible rendition below is
        # still H.264, so this does not affect ordinary local playback.
        if max(width, height) > H264_NVENC_MAX_SIDE and "hevc_nvenc" in available:
            return [
                "-c:v", "hevc_nvenc",
                "-preset", "p5",
                "-tune", "hq",
                "-rc", "vbr",
                "-cq", "21",
                "-b:v", "0",
                "-tag:v", "hvc1",
            ]
        if "h264_nvenc" in available:
            return [
                "-c:v", "h264_nvenc",
                "-preset", "p5",
                "-tune", "hq",
                "-rc", "vbr",
                "-cq", "19",
                "-b:v", "0",
            ]
    except OSError:
        pass
    return ["-c:v", "libx264", "-preset", "fast", "-crf", "18"]


def start_encoder(fps: float, dest: Path, width: int, height: int) -> subprocess.Popen:
    """Create an FFmpeg process receiving raw BGR frames on stdin."""
    import imageio_ffmpeg

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    return subprocess.Popen(
        [
            ffmpeg, "-y",
            "-f", "rawvideo", "-pix_fmt", "bgr24",
            "-video_size", f"{width}x{height}",
            "-framerate", f"{fps:.3f}", "-i", "-",
            *video_encoder_args(ffmpeg, width, height),
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            str(dest),
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )


def enhance_and_encode(
    video: Path,
    fps: float,
    outscale: float,
    frame_count: int,
    dest: Path,
    output_width: int,
    output_height: int,
) -> None:
    """Enhance and encode concurrently, without a disk-backed frame sequence."""
    import cv2
    import torch

    tile_size = TILE_SIZE
    upsampler = build_upsampler(half=True, tile_size=tile_size)
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise RuntimeError("无法读取视频")

    encoder = start_encoder(fps, dest, output_width, output_height)
    idx = 0
    last_pct = -1
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            try:
                output, _ = upsampler.enhance(frame, outscale=outscale)
            except torch.cuda.OutOfMemoryError:
                next_tile = next((size for size in TILE_FALLBACKS if size < tile_size), None)
                if next_tile is None:
                    raise
                print(f"显存不足，分块从 {tile_size} 降至 {next_tile} 后重试", flush=True)
                del upsampler
                torch.cuda.empty_cache()
                tile_size = next_tile
                upsampler = build_upsampler(half=True, tile_size=tile_size)
                output, _ = upsampler.enhance(frame, outscale=outscale)

            assert encoder.stdin is not None
            encoder.stdin.write(output.tobytes())

            idx += 1
            pct = 10 + int(idx / frame_count * 78) if frame_count else 10
            if pct != last_pct:
                progress(pct, f"超分中 {idx}/{frame_count} 帧")
                last_pct = pct
    except Exception:
        encoder.kill()
        encoder.wait()
        raise
    finally:
        cap.release()

    if idx == 0:
        encoder.kill()
        encoder.wait()
        raise RuntimeError("视频没有可读取的帧")

    assert encoder.stdin is not None
    encoder.stdin.close()
    assert encoder.stderr is not None
    stderr = encoder.stderr.read().decode("utf-8", errors="replace")
    if encoder.wait() != 0 or not dest.exists():
        raise RuntimeError(f"重新编码失败：{stderr[-300:]}")


def compatible_dimensions(width: int, height: int) -> tuple[int, int] | None:
    longest_side = max(width, height)
    if longest_side <= COMPATIBLE_MAX_SIDE:
        return None
    scale = COMPATIBLE_MAX_SIDE / longest_side
    # yuv420p requires even dimensions.
    target_width = max(2, int(width * scale) // 2 * 2)
    target_height = max(2, int(height * scale) // 2 * 2)
    return target_width, target_height


def create_compatible_video(source: Path, dest: Path, width: int, height: int) -> bool:
    target = compatible_dimensions(width, height)
    if target is None:
        return False

    import imageio_ffmpeg

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    result = subprocess.run(
        [
            ffmpeg, "-y", "-i", str(source),
            "-map", "0:v:0", "-map", "0:a:0?",
            "-vf", f"scale={target[0]}:{target[1]}:flags=lanczos",
            *video_encoder_args(ffmpeg, target[0], target[1]),
            "-pix_fmt", "yuv420p", "-c:a", "copy",
            "-movflags", "+faststart",
            str(dest),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0 or not dest.exists():
        raise RuntimeError(f"兼容版编码失败：{result.stderr[-300:]}")
    return True


def merge_audio(video_no_audio: Path, source: Path, dest: Path) -> None:
    """Restore the original audio when it exists; otherwise retain a silent video."""
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
                "-movflags", "+faststart",
                str(dest),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
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
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()

    progress(5, "加载超分模型")
    encoded = out_dir / "_encoded.mp4"
    enhance_and_encode(
        video,
        fps,
        outscale,
        frame_count,
        encoded,
        int(width * outscale),
        int(height * outscale),
    )

    progress(92, "合并原音轨")
    master = out_dir / "enhanced.mp4"
    merge_audio(encoded, video, master)
    encoded.unlink(missing_ok=True)

    if create_compatible_video(
        master,
        out_dir / "enhanced_compatible.mp4",
        int(width * outscale),
        int(height * outscale),
    ):
        progress(98, "生成兼容播放版")

    progress(100, "完成")
    return 0


if __name__ == "__main__":
    sys.exit(main())
