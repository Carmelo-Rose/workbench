"""Image enhancement runner sharing the video enhancement environment and weights."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from common import (
    GFPGAN_WEIGHTS_PATH,
    TILE_FALLBACKS,
    TILE_SIZE,
    WEIGHTS_PATH,
    build_face_enhancer,
    build_upsampler,
    progress,
)

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def enhance_image(image, outscale: float, face_enhance: bool, denoise: float):
    import torch

    tile_size = TILE_SIZE
    upsampler = build_upsampler(half=True, tile_size=tile_size, denoise=denoise)
    face_enhancer = build_face_enhancer(upsampler, outscale) if face_enhance else None
    while True:
        try:
            if face_enhancer:
                _, _, output = face_enhancer.enhance(
                    image, has_aligned=False, only_center_face=False, paste_back=True
                )
            else:
                output, _ = upsampler.enhance(image, outscale=outscale)
            return output
        except torch.cuda.OutOfMemoryError:
            next_tile = next((size for size in TILE_FALLBACKS if size < tile_size), None)
            if next_tile is None:
                raise
            print(f"显存不足，分块从 {tile_size} 降至 {next_tile} 后重试", flush=True)
            del face_enhancer
            del upsampler
            torch.cuda.empty_cache()
            tile_size = next_tile
            upsampler = build_upsampler(half=True, tile_size=tile_size, denoise=denoise)
            face_enhancer = build_face_enhancer(upsampler, outscale) if face_enhance else None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--params", default="{}")
    args = parser.parse_args()

    source = Path(args.input).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    params = json.loads(args.params)
    outscale = float(params.get("outscale", 4))
    outscale = outscale if outscale in (2.0, 4.0) else 4.0
    face_enhance = bool(params.get("face_enhance", False))
    denoise = min(1.0, max(0.0, float(params.get("denoise", 1.0))))

    if not source.is_file():
        print(f"输入图片不存在：{source}", flush=True)
        return 2
    if not WEIGHTS_PATH.is_file():
        print(f"缺少模型权重：{WEIGHTS_PATH}", flush=True)
        return 2
    if face_enhance and not GFPGAN_WEIGHTS_PATH.is_file():
        print(f"缺少人脸修复权重：{GFPGAN_WEIGHTS_PATH}", flush=True)
        return 2

    import cv2

    progress(5, "读取图片")
    image = cv2.imread(str(source), cv2.IMREAD_COLOR)
    if image is None:
        print("无法读取图片", flush=True)
        return 2
    progress(10, "加载修复模型")
    output = enhance_image(image, outscale, face_enhance, denoise)
    target = output_dir / "enhanced.png"
    if not cv2.imwrite(str(target), output):
        raise RuntimeError("写入增强图片失败")

    height, width = output.shape[:2]
    if max(width, height) > 2048:
        ratio = 2048 / max(width, height)
        preview = cv2.resize(output, (round(width * ratio), round(height * ratio)), interpolation=cv2.INTER_LANCZOS4)
        if not cv2.imwrite(str(output_dir / "enhanced_preview.jpg"), preview, [cv2.IMWRITE_JPEG_QUALITY, 92]):
            raise RuntimeError("写入预览图失败")
    progress(100, "完成")
    return 0


if __name__ == "__main__":
    sys.exit(main())
