from pathlib import Path
import cv2
import numpy as np


root = Path(r"D:\ai\ComfyUINeo50_250719\ComfyUINeo50_250719\ComfyUINeo50\tmp\codex-f1-diagnose")
source = cv2.cvtColor(cv2.imread(str(root / "source-8218.jpg"), cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
alpha = cv2.imread(str(root / "alpha-8218.png"), cv2.IMREAD_GRAYSCALE).astype(np.float32) / 255.0
fg = cv2.cvtColor(cv2.imread(str(root / "fg-8218.png"), cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
source = cv2.resize(source, (alpha.shape[1], alpha.shape[0]), interpolation=cv2.INTER_LANCZOS4)
hard = alpha >= 0.5
maximum = np.max(fg, axis=2)
minimum = np.min(fg, axis=2)
saturation = (maximum - minimum) / np.maximum(maximum, 1e-6)
luminance = 0.2126 * fg[:, :, 0] + 0.7152 * fg[:, :, 1] + 0.0722 * fg[:, :, 2]
gray = hard & (luminance >= 0.12) & (saturation <= 0.16)
count, labels, stats, _ = cv2.connectedComponentsWithStats(gray.astype(np.uint8), 8)
source_luma = 0.2126 * source[:, :, 0] + 0.7152 * source[:, :, 1] + 0.0722 * source[:, :, 2]
gx = cv2.Sobel(source_luma, cv2.CV_32F, 1, 0, ksize=3)
gy = cv2.Sobel(source_luma, cv2.CV_32F, 0, 1, ksize=3)
source_grad = np.sqrt(gx * gx + gy * gy)
source_blur = cv2.GaussianBlur(source, (0, 0), 2.0)
source_texture = np.mean(np.abs(source - source_blur), axis=2)
outside_near = cv2.dilate((~hard).astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11))) > 0
items = []
for label in range(1, count):
    component = labels == label
    area = int(stats[label, cv2.CC_STAT_AREA])
    if area < 500:
        continue
    ys, xs = np.where(component)
    items.append({
        "area": area,
        "bbox": [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1],
        "boundary": bool(np.any(component & outside_near)),
        "fg_luma": round(float(np.mean(luminance[component])), 4),
        "fg_sat": round(float(np.mean(saturation[component])), 4),
        "fg_grad": round(float(np.mean(np.sqrt(cv2.Sobel(luminance, cv2.CV_32F, 1, 0, ksize=3)[component] ** 2 + cv2.Sobel(luminance, cv2.CV_32F, 0, 1, ksize=3)[component] ** 2))), 4),
        "source_grad": round(float(np.mean(source_grad[component])), 4),
        "source_texture": round(float(np.mean(source_texture[component])), 5),
        "source_rgb": np.round(np.median(source[component], axis=0), 4).tolist(),
    })
print(sorted(items, key=lambda item: item["area"], reverse=True))
