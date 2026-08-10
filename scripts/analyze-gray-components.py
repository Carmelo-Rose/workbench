from pathlib import Path

import cv2
import numpy as np


ROOT = Path(r"D:\ai\ComfyUINeo50_250719\ComfyUINeo50_250719\ComfyUINeo50\tmp\codex-comfy-fba-round3-all5-final30")
SOURCES = Path(r"D:\ai\ComfyUINeo50_250719\ComfyUINeo50_250719\ComfyUINeo50\tmp\codex-round3-sources")
CASES = {
    "8212": ("329A8212", "329A8212.jpg"),
    "8218": ("codex_test_329A8218", "codex_test_329A8218.jpg"),
    "8235": ("codex-original-8235", "codex-original-8235.jpg"),
    "8211": ("codex-original-8211", "codex-original-8211.jpg"),
    "4617": ("329A4617-21fb5d96ee34bada", "329A4617-21fb5d96ee34bada.jpg"),
}


def components(mask: np.ndarray) -> list[tuple[int, np.ndarray]]:
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    return sorted(
        [(int(stats[i, cv2.CC_STAT_AREA]), labels == i) for i in range(1, count)],
        key=lambda item: item[0],
        reverse=True,
    )


def features(source: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    rgb = cv2.cvtColor(source, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    luma = 0.2126 * rgb[:, :, 0] + 0.7152 * rgb[:, :, 1] + 0.0722 * rgb[:, :, 2]
    gx = cv2.Sobel(luma, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(luma, cv2.CV_32F, 0, 1, ksize=3)
    gradient = np.sqrt(gx * gx + gy * gy)
    texture = np.mean(np.abs(rgb - cv2.GaussianBlur(rgb, (0, 0), 2.0)), axis=2)
    lab = cv2.cvtColor(source, cv2.COLOR_BGR2LAB).astype(np.float32)
    corner_size = max(16, int(round(min(source.shape[:2]) * 0.08)))
    samples = [
        lab[:corner_size, :corner_size],
        lab[:corner_size, -corner_size:],
        lab[-corner_size:, :corner_size],
        lab[-corner_size:, -corner_size:],
    ]
    medians = [np.median(item.reshape(-1, 3), axis=0) for item in samples]
    chroma = np.min(
        np.stack([np.linalg.norm(lab[:, :, 1:] - item[None, None, 1:], axis=2) for item in medians], axis=0),
        axis=0,
    )
    return texture, gradient, chroma


def main() -> None:
    for label, (stem, source_name) in CASES.items():
        white = cv2.imread(str(ROOT / f"{stem}-1.png"), cv2.IMREAD_COLOR)
        alpha = cv2.imread(str(ROOT / f"{stem}-3.png"), cv2.IMREAD_GRAYSCALE)
        source = cv2.imread(str(SOURCES / source_name), cv2.IMREAD_COLOR)
        source = cv2.resize(source, (white.shape[1], white.shape[0]), interpolation=cv2.INTER_LANCZOS4)
        texture, gradient, chroma = features(source)
        hsv = cv2.cvtColor(white, cv2.COLOR_BGR2HSV)
        hard = alpha >= 204
        hard_distance = cv2.distanceTransform(hard.astype(np.uint8), cv2.DIST_L2, 5)
        gray = hard & (hsv[:, :, 1] < round(0.12 * 255.0)) & (hsv[:, :, 2] > 60) & (hsv[:, :, 2] < 240)
        print(f"CASE {label}")
        for area, component in components(gray)[:5]:
            ys, xs = np.where(component)
            pixel = white[component]
            component_dilate = cv2.dilate(component.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
            adjacent_hard = component_dilate & hard & ~component
            print({
                "area": area,
                "bbox": [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1],
                "white_rgb_median": np.median(pixel[:, ::-1], axis=0).round(1).tolist(),
                "texture_q": np.quantile(texture[component], [0.1, 0.5, 0.9]).round(5).tolist(),
                "gradient_q": np.quantile(gradient[component], [0.1, 0.5, 0.9]).round(4).tolist(),
                "corner_chroma_q": np.quantile(chroma[component], [0.1, 0.5, 0.9]).round(2).tolist(),
                "distance_to_alpha_exterior_q": np.quantile(hard_distance[component], [0.0, 0.1, 0.5, 0.9]).round(2).tolist(),
                "adjacent_hard_px": int(adjacent_hard.sum()),
            })


if __name__ == "__main__":
    main()
