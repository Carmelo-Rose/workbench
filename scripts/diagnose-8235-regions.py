from pathlib import Path
import cv2
import numpy as np


root = Path(r"D:\ai\ComfyUINeo50_250719\ComfyUINeo50_250719\ComfyUINeo50\tmp\codex-f1-diagnose")
source = cv2.cvtColor(cv2.imread(str(root / "source-8235.jpg"), cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
alpha = cv2.imread(str(root / "alpha-8235.png"), cv2.IMREAD_GRAYSCALE).astype(np.float32) / 255.0
source = cv2.resize(source, (alpha.shape[1], alpha.shape[0]), interpolation=cv2.INTER_LANCZOS4)
lab = cv2.cvtColor(np.clip(source * 255, 0, 255).astype(np.uint8), cv2.COLOR_RGB2LAB).astype(np.float32)
luma = 0.2126 * source[:, :, 0] + 0.7152 * source[:, :, 1] + 0.0722 * source[:, :, 2]
gx = cv2.Sobel(luma, cv2.CV_32F, 1, 0, ksize=3)
gy = cv2.Sobel(luma, cv2.CV_32F, 0, 1, ksize=3)
grad = np.sqrt(gx * gx + gy * gy)
blur = cv2.GaussianBlur(source, (0, 0), 2.0)
texture = np.mean(np.abs(source - blur), axis=2)
hard = alpha >= 0.5
corner = 102
corner_patches = [
    lab[:corner, :corner],
    lab[:corner, -corner:],
    lab[-corner:, :corner],
    lab[-corner:, -corner:],
]
corner_samples = np.asarray([np.median(p.reshape(-1, 3), axis=0) for p in corner_patches], dtype=np.float32)
ab_distance = np.min(np.stack([np.linalg.norm(lab[:, :, 1:] - sample[None, None, 1:], axis=2) for sample in corner_samples], axis=0), axis=0)
full_distance = np.min(np.stack([np.linalg.norm(lab - sample[None, None, :], axis=2) for sample in corner_samples], axis=0), axis=0)
corner_texture = np.concatenate([texture[:corner, :corner].reshape(-1), texture[:corner, -corner:].reshape(-1), texture[-corner:, :corner].reshape(-1), texture[-corner:, -corner:].reshape(-1)])
corner_gradient = np.concatenate([grad[:corner, :corner].reshape(-1), grad[:corner, -corner:].reshape(-1), grad[-corner:, :corner].reshape(-1), grad[-corner:, -corner:].reshape(-1)])
print("corner_samples", np.round(corner_samples, 2).tolist(), "corner_ab_p99", round(float(np.quantile(corner_texture, 0.99)), 5), "corner_grad_p99", round(float(np.quantile(corner_gradient, 0.99)), 4))
for chroma_threshold in (4.0, 5.0, 6.0, 8.0, 10.0):
    for texture_threshold in (0.010, 0.014, 0.018, 0.022):
        gradient_threshold = 0.12
        probe = hard & (ab_distance <= chroma_threshold) & (texture <= texture_threshold) & (grad <= gradient_threshold)
        count, labels, stats, _ = cv2.connectedComponentsWithStats(probe.astype(np.uint8), 8)
        items = []
        for label in range(1, count):
            area = int(stats[label, cv2.CC_STAT_AREA])
            if area < 500:
                continue
            component = labels == label
            ys, xs = np.where(component)
            items.append((area, [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1], float(np.mean(full_distance[component])), float(np.mean(texture[component])), float(np.mean(grad[component]))))
        if items:
            print("probe", chroma_threshold, texture_threshold, sorted(items, reverse=True)[:4])
regions = {
    "opening_top": (760, 730, 1180, 820),
    "opening_middle": (760, 820, 1180, 900),
    "opening_bottom": (760, 900, 1180, 980),
    "adjustment_band": (700, 940, 1300, 1050),
    "outer_background": (0, 0, 250, 250),
}
for name, (x0, y0, x1, y1) in regions.items():
    region = hard[y0:y1, x0:x1]
    if name == "outer_background":
        region = np.ones_like(region, dtype=bool)
    if not np.any(region):
        print(name, "no-hard-pixels")
        continue
    rgb = source[y0:y1, x0:x1][region]
    values = {
        "rgb_median": np.round(np.median(rgb, axis=0), 4).tolist(),
        "lab_median": np.round(np.median(lab[y0:y1, x0:x1][region], axis=0), 2).tolist(),
        "luma": [round(float(np.quantile(luma[y0:y1, x0:x1][region], q)), 4) for q in (0.1, 0.5, 0.9)],
        "ab_std": np.round(np.std(lab[y0:y1, x0:x1][region][:, 1:], axis=0), 2).tolist(),
        "gradient": [round(float(np.quantile(grad[y0:y1, x0:x1][region], q)), 4) for q in (0.1, 0.5, 0.9)],
        "texture": [round(float(np.quantile(texture[y0:y1, x0:x1][region], q)), 5) for q in (0.1, 0.5, 0.9)],
        "pixels": int(region.sum()),
    }
    print(name, values)
