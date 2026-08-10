from pathlib import Path
import cv2
import numpy as np


BASE = Path(r"D:\ai\ComfyUINeo50_250719\ComfyUINeo50_250719\ComfyUINeo50\tmp\codex-f1-diagnose")
CASES = [
    ("8212", "source-8212.jpg", "fg-8212.png", "alpha-8212.png"),
    ("8218", "source-8218.jpg", "fg-8218.png", "alpha-8218.png"),
    ("8235", "source-8235.jpg", "fg-8235.png", "alpha-8235.png"),
]


def lab_image(image: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(np.clip(image * 255.0, 0, 255).astype(np.uint8), cv2.COLOR_RGB2LAB).astype(np.float32)


for name, source_name, fg_name, alpha_name in CASES:
    source_bgr = cv2.imread(str(BASE / source_name), cv2.IMREAD_COLOR)
    source = cv2.cvtColor(source_bgr, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    fg = cv2.cvtColor(cv2.imread(str(BASE / fg_name), cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    alpha = cv2.imread(str(BASE / alpha_name), cv2.IMREAD_GRAYSCALE).astype(np.float32) / 255.0
    source = cv2.resize(source, (alpha.shape[1], alpha.shape[0]), interpolation=cv2.INTER_LANCZOS4)
    lab = lab_image(source)
    h, w = alpha.shape
    corner = max(16, int(round(min(h, w) * 0.08)))
    patches = [
        lab[:corner, :corner],
        lab[:corner, -corner:],
        lab[-corner:, :corner],
        lab[-corner:, -corner:],
    ]
    samples = np.asarray([np.median(p.reshape(-1, 3), axis=0) for p in patches], dtype=np.float32)
    distances = np.stack([np.linalg.norm(lab - sample[None, None, :], axis=2) for sample in samples], axis=0)
    nearest = np.min(distances, axis=0)
    hard = alpha >= 0.5
    print("CASE", name, "shape", (w, h), "corner", corner)
    print("corner_samples_lab", np.round(samples, 2).tolist())
    print("corner_pairwise", np.round(np.linalg.norm(samples[:, None, :] - samples[None, :, :], axis=2), 2).tolist())
    for region_name, region in [
        ("all_hard", hard),
        ("center_opening", hard & (np.indices(hard.shape)[1] >= int(w * 0.30)) & (np.indices(hard.shape)[1] <= int(w * 0.70)) & (np.indices(hard.shape)[0] >= int(h * 0.50)) & (np.indices(hard.shape)[0] <= int(h * 0.90))),
    ]:
        values = nearest[region]
        print(region_name, "nearest_lab_distance", {
            "p01": round(float(np.quantile(values, 0.01)), 2),
            "p05": round(float(np.quantile(values, 0.05)), 2),
            "p25": round(float(np.quantile(values, 0.25)), 2),
            "p50": round(float(np.quantile(values, 0.50)), 2),
            "p75": round(float(np.quantile(values, 0.75)), 2),
            "p95": round(float(np.quantile(values, 0.95)), 2),
            "p99": round(float(np.quantile(values, 0.99)), 2),
        })
    # Locate low-texture low-saturation gray components under a few data-driven
    # color thresholds, so the F1 rule can be conservative around product fabric.
    maximum = np.max(fg, axis=2)
    minimum = np.min(fg, axis=2)
    saturation = (maximum - minimum) / np.maximum(maximum, 1e-6)
    luminance = 0.2126 * fg[:, :, 0] + 0.7152 * fg[:, :, 1] + 0.0722 * fg[:, :, 2]
    gx = cv2.Sobel(luminance, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(luminance, cv2.CV_32F, 0, 1, ksize=3)
    gradient = np.sqrt(gx * gx + gy * gy)
    source_luma = 0.2126 * source[:, :, 0] + 0.7152 * source[:, :, 1] + 0.0722 * source[:, :, 2]
    source_gx = cv2.Sobel(source_luma, cv2.CV_32F, 1, 0, ksize=3)
    source_gy = cv2.Sobel(source_luma, cv2.CV_32F, 0, 1, ksize=3)
    source_gradient = np.sqrt(source_gx * source_gx + source_gy * source_gy)
    named_regions = {
        "8235": {"opening": (760, 730, 1180, 900), "adjustment_band": (700, 900, 1300, 1040)},
        "8218": {"rear_spur": (1280, 790, 1400, 890)},
    }
    for region_name, (x0, y0, x1, y1) in named_regions.get(name, {}).items():
        region = hard[y0:y1, x0:x1]
        if not np.any(region):
            continue
        source_region = source[y0:y1, x0:x1][region]
        grad_region = source_gradient[y0:y1, x0:x1][region]
        lab_region = nearest[y0:y1, x0:x1][region]
        print("named_region", region_name, {
            "source_rgb_median": np.round(np.median(source_region, axis=0), 3).tolist(),
            "source_gradient": {
                "p25": round(float(np.quantile(grad_region, 0.25)), 3),
                "p50": round(float(np.quantile(grad_region, 0.50)), 3),
                "p75": round(float(np.quantile(grad_region, 0.75)), 3),
                "p90": round(float(np.quantile(grad_region, 0.90)), 3),
            },
            "source_lab_distance": {
                "p25": round(float(np.quantile(lab_region, 0.25)), 2),
                "p50": round(float(np.quantile(lab_region, 0.50)), 2),
                "p75": round(float(np.quantile(lab_region, 0.75)), 2),
            },
        })
    for region_name, (x0, y0, x1, y1) in {
        "8218_spur_or_8235_open": (720, 700, 1400, 920),
    }.items():
        region = hard[y0:y1, x0:x1]
        if not np.any(region):
            continue
        source_region = source[y0:y1, x0:x1][region]
        fg_region = fg[y0:y1, x0:x1][region]
        dist_region = nearest[y0:y1, x0:x1][region]
        sat_region = saturation[y0:y1, x0:x1][region]
        grad_region = gradient[y0:y1, x0:x1][region]
        print(region_name, {
            "source_rgb_median": np.round(np.median(source_region, axis=0), 3).tolist(),
            "fg_rgb_median": np.round(np.median(fg_region, axis=0), 3).tolist(),
            "lab_dist_p05": round(float(np.quantile(dist_region, 0.05)), 2),
            "lab_dist_p25": round(float(np.quantile(dist_region, 0.25)), 2),
            "lab_dist_p50": round(float(np.quantile(dist_region, 0.50)), 2),
            "sat_p50": round(float(np.quantile(sat_region, 0.50)), 3),
            "grad_p50": round(float(np.quantile(grad_region, 0.50)), 3),
        })
    for threshold in (8.0, 12.0, 16.0, 22.0, 30.0):
        mask = hard & (nearest <= threshold) & (saturation <= 0.16) & (gradient <= 0.12)
        count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
        items = []
        for label in range(1, count):
            component = labels == label
            area = int(stats[label, cv2.CC_STAT_AREA])
            if area < 200:
                continue
            ys, xs = np.where(component)
            items.append({
                "area": area,
                "bbox": [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1],
                "mean_lab_dist": round(float(np.mean(nearest[component])), 2),
                "mean_sat": round(float(np.mean(saturation[component])), 3),
                "mean_grad": round(float(np.mean(gradient[component])), 3),
            })
        if items:
            print("threshold", threshold, sorted(items, key=lambda item: item["area"], reverse=True)[:8])
    gray_probe = hard & (nearest <= 30.0) & (saturation <= 0.16)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(gray_probe.astype(np.uint8), 8)
    outside_near = cv2.dilate((~hard).astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11))) > 0
    gray_items = []
    for label in range(1, count):
        component = labels == label
        area = int(stats[label, cv2.CC_STAT_AREA])
        if area < 500:
            continue
        ys, xs = np.where(component)
        gray_items.append({
            "area": area,
            "bbox": [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1],
            "boundary": bool(np.any(component & outside_near)),
            "source_lab_dist": round(float(np.mean(nearest[component])), 2),
            "source_grad": round(float(np.mean(source_gradient[component])), 3),
            "fg_grad": round(float(np.mean(gradient[component])), 3),
            "fg_sat": round(float(np.mean(saturation[component])), 3),
        })
    if gray_items:
        print("gray_probe_components", sorted(gray_items, key=lambda item: item["area"], reverse=True)[:20])
    fba_gray_probe = hard & (luminance >= 0.12) & (saturation <= 0.16)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(fba_gray_probe.astype(np.uint8), 8)
    fba_items = []
    for label in range(1, count):
        component = labels == label
        area = int(stats[label, cv2.CC_STAT_AREA])
        if area < 500:
            continue
        ys, xs = np.where(component)
        fba_items.append({
            "area": area,
            "bbox": [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1],
            "boundary": bool(np.any(component & outside_near)),
            "source_lab_dist": round(float(np.mean(nearest[component])), 2),
            "source_grad": round(float(np.mean(source_gradient[component])), 3),
            "fg_luma": round(float(np.mean(luminance[component])), 3),
            "fg_grad": round(float(np.mean(gradient[component])), 3),
            "fg_sat": round(float(np.mean(saturation[component])), 3),
        })
    if fba_items:
        print("fba_gray_components", sorted(fba_items, key=lambda item: item["area"], reverse=True)[:20])
