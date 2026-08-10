from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import cv2
import numpy as np


ROOT = Path(r"D:\ai\ComfyUINeo50_250719\ComfyUINeo50_250719\ComfyUINeo50")
BASE = ROOT / "tmp" / "codex-f1-diagnose"
OUT = ROOT / "tmp" / "codex-f1-proposal"
OUT.mkdir(parents=True, exist_ok=True)
MODULE_PATH = ROOT / "custom_nodes" / "ComfyUI-FBA-Matting" / "nodes_fba.py"

spec = importlib.util.spec_from_file_location("nodes_fba_test", MODULE_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError(f"cannot import {MODULE_PATH}")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def read_rgb(path: Path) -> np.ndarray:
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if image is None:
        raise FileNotFoundError(path)
    return cv2.cvtColor(image, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0


def read_gray(path: Path) -> np.ndarray:
    image = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise FileNotFoundError(path)
    return image.astype(np.float32) / 255.0


def components(mask: np.ndarray) -> list[dict[str, object]]:
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    result: list[dict[str, object]] = []
    for label in range(1, count):
        area = int(stats[label, cv2.CC_STAT_AREA])
        if area == 0:
            continue
        ys, xs = np.where(labels == label)
        result.append({"area": area, "bbox": [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]})
    return sorted(result, key=lambda item: int(item["area"]), reverse=True)


cases = {
    "8212": ("source-8212.jpg", "fg-8212.png", "alpha-8212.png"),
    "8218": ("source-8218.jpg", "fg-8218.png", "alpha-8218.png"),
    "8235": ("source-8235.jpg", "fg-8235.png", "alpha-8235.png"),
}
metrics: dict[str, object] = {}
for name, (source_name, fg_name, alpha_name) in cases.items():
    source = read_rgb(BASE / source_name)
    foreground = read_rgb(BASE / fg_name)
    alpha = read_gray(BASE / alpha_name)
    if source.shape != foreground.shape:
        source = cv2.resize(source, (foreground.shape[1], foreground.shape[0]), interpolation=cv2.INTER_LANCZOS4)
    if alpha.shape != foreground.shape[:2]:
        alpha = cv2.resize(alpha, (foreground.shape[1], foreground.shape[0]), interpolation=cv2.INTER_LINEAR)
    cleaned, removed = module._remove_gray_background_components(
        foreground,
        alpha,
        None,
        source,
        0.68,
        0.16,
        24,
        640,
        5,
    )
    removed_mask = removed >= 0.5
    cv2.imwrite(str(OUT / f"{name}-removed.png"), (removed_mask.astype(np.uint8) * 255))
    items = components(removed_mask)
    case: dict[str, object] = {
        "shape": [int(foreground.shape[1]), int(foreground.shape[0])],
        "removed_px": int(removed_mask.sum()),
        "components": items[:20],
    }
    if name == "8235":
        band = np.zeros_like(removed_mask)
        band[900:1050, 700:1300] = True
        band_core = np.zeros_like(removed_mask)
        band_core[965:1080, 760:1220] = True
        opening = np.zeros_like(removed_mask)
        opening[720:1000, 700:1300] = True
        case["adjustment_band_removed_px"] = int((removed_mask & band).sum())
        case["adjustment_band_core_removed_px"] = int((removed_mask & band_core).sum())
        case["opening_removed_px"] = int((removed_mask & opening).sum())
        close_sweep: list[dict[str, int]] = []
        for kernel_size in (3, 5, 7, 9, 11, 15):
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
            closed = cv2.morphologyEx(removed_mask.astype(np.uint8), cv2.MORPH_CLOSE, kernel) > 0
            close_sweep.append({
                "kernel": kernel_size,
                "area": int(closed.sum()),
                "band_core": int((closed & band_core).sum()),
                "opening": int((closed & opening).sum()),
            })
        case["close_sweep"] = close_sweep
        source_luma = 0.2126 * source[:, :, 0] + 0.7152 * source[:, :, 1] + 0.0722 * source[:, :, 2]
        source_maximum = np.max(source, axis=2)
        source_minimum = np.min(source, axis=2)
        source_saturation = (source_maximum - source_minimum) / np.maximum(source_maximum, 1e-6)
        source_gx = cv2.Sobel(source_luma, cv2.CV_32F, 1, 0, ksize=3)
        source_gy = cv2.Sobel(source_luma, cv2.CV_32F, 0, 1, ksize=3)
        source_gradient = np.sqrt(source_gx * source_gx + source_gy * source_gy)
        row_gradient_profile = np.mean(np.abs(source_gy[:, 724:1214]), axis=1)
        case["row_gradient_peaks"] = [
            {"y": int(y), "value": float(row_gradient_profile[y])}
            for y in np.argsort(row_gradient_profile[850:1020])[-30:][::-1] + 850
        ]
        source_texture = np.mean(np.abs(source - cv2.GaussianBlur(source, (0, 0), 2.0)), axis=2)
        lab = cv2.cvtColor(np.clip(source * 255.0, 0, 255).astype(np.uint8), cv2.COLOR_RGB2LAB).astype(np.float32)
        corner_size = max(16, int(round(min(alpha.shape) * 0.08)))
        corner_samples = np.asarray([
            np.median(p.reshape(-1, 3), axis=0) for p in (
                lab[:corner_size, :corner_size], lab[:corner_size, -corner_size:],
                lab[-corner_size:, :corner_size], lab[-corner_size:, -corner_size:],
            )
        ], dtype=np.float32)
        ab_distance = np.min(np.stack([
            np.linalg.norm(lab[:, :, 1:] - sample[None, None, 1:], axis=2)
            for sample in corner_samples
        ], axis=0), axis=0)
        full_distance = np.min(np.stack([
            np.linalg.norm(lab - sample[None, None, :], axis=2)
            for sample in corner_samples
        ], axis=0), axis=0)
        fg_maximum = np.max(foreground, axis=2)
        fg_minimum = np.min(foreground, axis=2)
        fg_saturation = (fg_maximum - fg_minimum) / np.maximum(fg_maximum, 1e-6)
        fg_luma = 0.2126 * foreground[:, :, 0] + 0.7152 * foreground[:, :, 1] + 0.0722 * foreground[:, :, 2]
        case["feature_thresholds"] = {
            "corner_ab_spread": float(np.max(np.linalg.norm(corner_samples[:, None, 1:] - corner_samples[None, :, 1:], axis=2))),
            "texture_p99": float(np.quantile(np.concatenate([
                source_texture[:corner_size, :corner_size].reshape(-1), source_texture[:corner_size, -corner_size:].reshape(-1),
                source_texture[-corner_size:, :corner_size].reshape(-1), source_texture[-corner_size:, -corner_size:].reshape(-1),
            ]), 0.99)),
            "gradient_p99": float(np.quantile(np.concatenate([
                source_gradient[:corner_size, :corner_size].reshape(-1), source_gradient[:corner_size, -corner_size:].reshape(-1),
                source_gradient[-corner_size:, :corner_size].reshape(-1), source_gradient[-corner_size:, -corner_size:].reshape(-1),
            ]), 0.99)),
            "full_distance_probe": [float(np.quantile(full_distance[(alpha >= 0.5) & (fg_saturation <= 0.16)], q)) for q in (0.5, 0.75, 0.9, 0.95, 0.99)],
        }
        probe = (alpha >= 0.5) & (fg_saturation <= 0.16) & (ab_distance <= 6.0) & (source_texture <= 0.020) & (source_gradient <= 0.10)
        case["feature_thresholds"]["sampled_full_distance"] = [float(np.quantile(full_distance[probe], q)) for q in (0.5, 0.75, 0.9, 0.95, 0.99)] if np.any(probe) else []
        feature_regions = {
            "opening_core": (760, 780, 1180, 900),
            "opening_lower": (760, 900, 1180, 960),
            "band_top": (760, 950, 1180, 990),
            "band_core": (760, 990, 1180, 1070),
            "corner": (0, 0, corner_size, corner_size),
        }
        feature_report: dict[str, object] = {}
        for region_name, (x0, y0, x1, y1) in feature_regions.items():
            region = alpha[y0:y1, x0:x1] >= 0.5
            if region_name == "corner":
                region = np.ones_like(region, dtype=bool)
            values: dict[str, object] = {}
            for sigma in (1.0, 2.0, 3.0, 4.0, 6.0):
                texture = np.mean(np.abs(source[y0:y1, x0:x1] - cv2.GaussianBlur(source, (0, 0), sigma)[y0:y1, x0:x1]), axis=2)
                selected = texture[region]
                values[f"texture_sigma_{sigma}"] = [float(np.quantile(selected, q)) for q in (0.1, 0.5, 0.9)] if selected.size else []
            selected_gradient = source_gradient[y0:y1, x0:x1][region]
            values["gradient"] = [float(np.quantile(selected_gradient, q)) for q in (0.1, 0.5, 0.9)] if selected_gradient.size else []
            selected_sat = fg_saturation[y0:y1, x0:x1][region]
            selected_luma = fg_luma[y0:y1, x0:x1][region]
            values["fba_saturation"] = [float(np.quantile(selected_sat, q)) for q in (0.1, 0.5, 0.9)] if selected_sat.size else []
            values["fba_luma"] = [float(np.quantile(selected_luma, q)) for q in (0.1, 0.5, 0.9)] if selected_luma.size else []
            selected_full_distance = full_distance[y0:y1, x0:x1][region]
            values["source_full_lab_distance"] = [float(np.quantile(selected_full_distance, q)) for q in (0.1, 0.5, 0.9)] if selected_full_distance.size else []
            selected_source_sat = source_saturation[y0:y1, x0:x1][region]
            values["source_saturation"] = [float(np.quantile(selected_source_sat, q)) for q in (0.1, 0.5, 0.9)] if selected_source_sat.size else []
            feature_report[region_name] = values
        case["feature_regions"] = feature_report
        for chroma_threshold in (3.0, 4.0, 5.0, 6.0):
            for texture_threshold in (0.008, 0.010, 0.014, 0.018, 0.022):
                for gradient_threshold in (0.06, 0.08, 0.09, 0.10, 0.12):
                    probe = alpha >= 0.5
                    probe &= ab_distance <= chroma_threshold
                    probe &= source_texture <= texture_threshold
                    probe &= source_gradient <= gradient_threshold
                    case.setdefault("sweep", []).append({
                        "chroma": chroma_threshold,
                        "texture": texture_threshold,
                        "gradient": gradient_threshold,
                        "total": int(probe.sum()),
                        "band": int((probe & band).sum()),
                        "band_core": int((probe & band_core).sum()),
                        "opening": int((probe & opening).sum()),
                    })
    if name == "8218":
        spur = np.zeros_like(removed_mask)
        spur[790:890, 1260:1410] = True
        case["rear_spur_removed_px"] = int((removed_mask & spur).sum())
    metrics[name] = case

(OUT / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
print(json.dumps(metrics, indent=2))
