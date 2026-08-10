from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np


OUTPUT = Path(r"D:\ai\ComfyUINeo50_250719\ComfyUINeo50_250719\ComfyUINeo50\tmp\codex-comfy-fba-round3-targeted-v4")
STEM = "codex-original-8235"


def comps(mask: np.ndarray) -> list[dict[str, int]]:
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    out = []
    for label in range(1, count):
        out.append({
            "area": int(stats[label, cv2.CC_STAT_AREA]),
            "x": int(stats[label, cv2.CC_STAT_LEFT]),
            "y": int(stats[label, cv2.CC_STAT_TOP]),
            "w": int(stats[label, cv2.CC_STAT_WIDTH]),
            "h": int(stats[label, cv2.CC_STAT_HEIGHT]),
        })
    return sorted(out, key=lambda item: item["area"], reverse=True)


white = cv2.imread(str(OUTPUT / f"{STEM}-1.png"), cv2.IMREAD_COLOR)
alpha = cv2.imread(str(OUTPUT / f"{STEM}-3.png"), cv2.IMREAD_GRAYSCALE)
before = cv2.imread(str(OUTPUT / f"{STEM}-8.png"), cv2.IMREAD_GRAYSCALE)
after = cv2.imread(str(OUTPUT / f"{STEM}-9.png"), cv2.IMREAD_GRAYSCALE)
removed = cv2.imread(str(OUTPUT / f"{STEM}-5.png"), cv2.IMREAD_GRAYSCALE)
assert white is not None and alpha is not None and before is not None and after is not None and removed is not None

def bbox(mask: np.ndarray) -> list[int] | None:
    ys, xs = np.where(mask >= 204)
    return [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1] if xs.size else None

roi = np.zeros_like(alpha, dtype=bool)
roi[650:1060, 500:1350] = True
hsv = cv2.cvtColor(white, cv2.COLOR_BGR2HSV)
gray = roi & (alpha >= 204) & (hsv[:, :, 1] < 31) & (hsv[:, :, 2] > 60) & (hsv[:, :, 2] < 240)
residual = roi & (before >= 128) & (after >= 128) & (hsv[:, :, 1] < 64) & (hsv[:, :, 2] < 245)
print(json.dumps({
    "shape": [int(alpha.shape[1]), int(alpha.shape[0])],
    "final_bbox": bbox(alpha),
    "prefit_after_bbox": bbox(after),
    "removed_area": int((removed > 127).sum()),
    "removed_components": comps(removed > 127)[:20],
    "internal_gray_components": comps(gray)[:30],
    "residual_candidate_components": comps(residual)[:30],
    "gray_row_counts": [{"y": y, "n": int(gray[y].sum())} for y in range(650, 1060) if int(gray[y].sum()) > 0],
}, ensure_ascii=False, indent=2))

crop = white[640:1080, 560:1380]
crop = cv2.resize(crop, (crop.shape[1] * 2, crop.shape[0] * 2), interpolation=cv2.INTER_CUBIC)
for x in range(0, crop.shape[1], 200):
    cv2.line(crop, (x, 0), (x, crop.shape[0] - 1), (0, 0, 255), 1)
for y in range(0, crop.shape[0], 200):
    cv2.line(crop, (0, y), (crop.shape[1] - 1, y), (0, 0, 255), 1)
cv2.imwrite(str(OUTPUT / "8235-v4-opening-coordinates-2x.png"), crop)
