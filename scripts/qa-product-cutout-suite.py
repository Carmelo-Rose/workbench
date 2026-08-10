from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import cv2
import numpy as np


CASES = {
    "8212": {
        "stem": "329A8212",
        "source": "329A8212.jpg",
        "edge_side": "left",
    },
    "8218": {
        "stem": "codex_test_329A8218",
        "source": "codex_test_329A8218.jpg",
        "edge_side": "right",
    },
    "8235": {
        "stem": "codex-original-8235",
        "source": "codex-original-8235.jpg",
        "edge_side": "right",
    },
    "8211": {
        "stem": "codex-original-8211",
        "source": "codex-original-8211.jpg",
        "edge_side": "right",
    },
    "4617": {
        "stem": "329A4617-21fb5d96ee34bada",
        "source": "329A4617-21fb5d96ee34bada.jpg",
        "edge_side": "left",
    },
}


def read_bgr(path: Path) -> np.ndarray:
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if image is None:
        raise FileNotFoundError(path)
    return image


def read_gray(path: Path) -> np.ndarray:
    image = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise FileNotFoundError(path)
    return image


def components(mask: np.ndarray) -> list[dict[str, Any]]:
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    result: list[dict[str, Any]] = []
    for label in range(1, count):
        area = int(stats[label, cv2.CC_STAT_AREA])
        if area <= 0:
            continue
        result.append(
            {
                "area_px": area,
                "bbox_xyxy": [
                    int(stats[label, cv2.CC_STAT_LEFT]),
                    int(stats[label, cv2.CC_STAT_TOP]),
                    int(stats[label, cv2.CC_STAT_LEFT] + stats[label, cv2.CC_STAT_WIDTH]),
                    int(stats[label, cv2.CC_STAT_TOP] + stats[label, cv2.CC_STAT_HEIGHT]),
                ],
            }
        )
    return sorted(result, key=lambda item: int(item["area_px"]), reverse=True)


def hard_bbox(alpha: np.ndarray, threshold: int = 204) -> tuple[int, int, int, int] | None:
    ys, xs = np.where(alpha >= threshold)
    if xs.size == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def circular_hue_delta(a: np.ndarray, b: float) -> np.ndarray:
    delta = np.abs(a.astype(np.float32) - float(b))
    return np.minimum(delta, 180.0 - delta) * 2.0


def source_features(source_bgr: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, float, float, float]:
    source = cv2.cvtColor(source_bgr, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    luma = 0.2126 * source[:, :, 0] + 0.7152 * source[:, :, 1] + 0.0722 * source[:, :, 2]
    gx = cv2.Sobel(luma, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(luma, cv2.CV_32F, 0, 1, ksize=3)
    gradient = np.sqrt(gx * gx + gy * gy)
    texture = np.mean(np.abs(source - cv2.GaussianBlur(source, (0, 0), 2.0)), axis=2)
    corner_size = max(16, int(round(min(source.shape[:2]) * 0.08)))
    corners = np.concatenate(
        [
            texture[:corner_size, :corner_size].reshape(-1),
            texture[:corner_size, -corner_size:].reshape(-1),
            texture[-corner_size:, :corner_size].reshape(-1),
            texture[-corner_size:, -corner_size:].reshape(-1),
        ]
    )
    gradients = np.concatenate(
        [
            gradient[:corner_size, :corner_size].reshape(-1),
            gradient[:corner_size, -corner_size:].reshape(-1),
            gradient[-corner_size:, :corner_size].reshape(-1),
            gradient[-corner_size:, -corner_size:].reshape(-1),
        ]
    )
    source_lab = cv2.cvtColor(
        np.clip(source * 255.0, 0.0, 255.0).astype(np.uint8), cv2.COLOR_RGB2LAB
    ).astype(np.float32)
    corner_patches = (
        source_lab[:corner_size, :corner_size],
        source_lab[:corner_size, -corner_size:],
        source_lab[-corner_size:, :corner_size],
        source_lab[-corner_size:, -corner_size:],
    )
    corner_samples = np.asarray(
        [np.median(patch.reshape(-1, 3), axis=0) for patch in corner_patches],
        dtype=np.float32,
    )
    chroma_distance = np.min(
        np.stack(
            [
                np.linalg.norm(source_lab[:, :, 1:] - sample[None, None, 1:], axis=2)
                for sample in corner_samples
            ],
            axis=0,
        ),
        axis=0,
    )
    corner_chroma_spread = float(
        np.max(
            np.linalg.norm(
                corner_samples[:, None, 1:] - corner_samples[None, :, 1:], axis=2
            )
        )
    )
    chroma_threshold = float(np.clip(max(4.0, corner_chroma_spread * 1.5 + 1.5), 4.0, 6.0))
    texture_threshold = float(np.clip(np.quantile(corners, 0.99) * 1.05, 0.012, 0.020))
    gradient_threshold = float(np.clip(np.quantile(gradients, 0.99) * 1.15, 0.10, 0.16))
    return texture, gradient, chroma_distance, chroma_threshold, texture_threshold, gradient_threshold


def make_crop_sheet(image: np.ndarray, bbox: tuple[int, int, int, int], output: Path, label: str, edge_side: str) -> None:
    x0, y0, x1, y1 = bbox
    width = x1 - x0
    height = y1 - y0
    cx = (x0 + x1) // 2
    rear_edge_x = x0 + int(width * 0.08) if edge_side == "left" else x1 - int(width * 0.08)
    regions = {
        "cap_top": (cx, y0 + int(height * 0.16)),
        "brim": (x0 + int(width * 0.50), y0 + int(height * 0.84)),
        "rear_edge": (rear_edge_x, y0 + int(height * 0.60)),
        "rear_opening": (x0 + int(width * 0.51), y0 + int(height * 0.70)),
    }
    crop_w = max(240, min(420, int(round(width * 0.32))))
    crop_h = max(180, min(320, int(round(height * 0.25))))
    tiles: list[np.ndarray] = []
    for name, (center_x, center_y) in regions.items():
        left = int(np.clip(center_x - crop_w // 2, 0, image.shape[1] - crop_w))
        top = int(np.clip(center_y - crop_h // 2, 0, image.shape[0] - crop_h))
        crop = image[top : top + crop_h, left : left + crop_w]
        crop = cv2.resize(crop, (crop_w * 2, crop_h * 2), interpolation=cv2.INTER_CUBIC)
        cv2.rectangle(crop, (0, 0), (crop.shape[1] - 1, 31), (0, 0, 0), thickness=-1)
        cv2.putText(crop, f"{label} / {name} / 200%", (10, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.58, (255, 255, 255), 1, cv2.LINE_AA)
        tiles.append(crop)
    row1 = np.hstack([tiles[0], tiles[1]])
    row2 = np.hstack([tiles[2], tiles[3]])
    sheet = np.vstack([row1, row2])
    output.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output), sheet)


def alpha_image(mask: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(np.clip(mask, 0, 255).astype(np.uint8), cv2.COLOR_GRAY2BGR)


def analyze_case(case_id: str, config: dict[str, str], output_dir: Path, source_dir: Path, artifact_dir: Path) -> dict[str, Any]:
    stem = config["stem"]
    white = read_bgr(output_dir / f"{stem}-1.png")
    dark = read_bgr(output_dir / f"{stem}-2.png")
    final_alpha = read_gray(output_dir / f"{stem}-3.png")
    shadow = read_gray(output_dir / f"{stem}-4.png")
    before_alpha = read_gray(output_dir / f"{stem}-8.png")
    after_alpha = read_gray(output_dir / f"{stem}-9.png")
    foreground = read_bgr(output_dir / f"{stem}-10.png")
    source = read_bgr(source_dir / config["source"])
    if source.shape[:2] != foreground.shape[:2]:
        source = cv2.resize(source, (foreground.shape[1], foreground.shape[0]), interpolation=cv2.INTER_LANCZOS4)
    analysis_source = source
    if analysis_source.shape[:2] != white.shape[:2]:
        analysis_source = cv2.resize(analysis_source, (white.shape[1], white.shape[0]), interpolation=cv2.INTER_LANCZOS4)

    bbox = hard_bbox(final_alpha)
    if bbox is None:
        raise RuntimeError(f"empty final alpha for {case_id}")
    x0, y0, x1, y1 = bbox
    hard = final_alpha >= 204
    hsv = cv2.cvtColor(white, cv2.COLOR_BGR2HSV)
    gray_candidate = hard & (hsv[:, :, 1] < round(0.12 * 255.0)) & (hsv[:, :, 2] > 60) & (hsv[:, :, 2] < 240)
    gray_components = components(gray_candidate)
    texture, source_gradient, chroma_distance, chroma_threshold, texture_threshold, gradient_threshold = source_features(analysis_source)
    gray_background_like = gray_candidate & (chroma_distance <= chroma_threshold) & (texture <= max(texture_threshold, 0.022)) & (
        (source_gradient <= max(gradient_threshold * 2.0, 0.16))
        | (texture <= texture_threshold * 0.75)
    )
    gray_background_components = components(gray_background_like)
    gray_background_residual = gray_candidate & (chroma_distance <= chroma_threshold) & (texture <= max(texture_threshold, 0.022)) & (
        source_gradient <= max(gradient_threshold * 2.0, 0.16)
    )
    hard_distance = cv2.distanceTransform(hard.astype(np.uint8), cv2.DIST_L2, 5)
    group_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11))
    grouped_residual = cv2.dilate(gray_background_residual.astype(np.uint8), group_kernel) > 0
    residual_count, residual_labels, residual_stats, _ = cv2.connectedComponentsWithStats(grouped_residual.astype(np.uint8), 8)
    verified_background_residual = np.zeros_like(gray_background_residual, dtype=bool)
    residual_components: list[dict[str, Any]] = []
    excluded_product_gray_components: list[dict[str, Any]] = []
    for label in range(1, residual_count):
        group = residual_labels == label
        component = gray_background_residual & group
        area = int(np.count_nonzero(component))
        if area <= 0:
            continue
        ys, xs = np.where(component)
        min_distance = float(np.min(hard_distance[component]))
        feature_region = cv2.dilate(component.astype(np.uint8), group_kernel) > 0
        feature_region &= hard
        p90_gradient = float(np.quantile(source_gradient[feature_region], 0.90)) if np.any(feature_region) else 0.0
        p90_texture = float(np.quantile(texture[feature_region], 0.90)) if np.any(feature_region) else 0.0
        product_evidence: list[str] = []
        if area > 500 and min_distance <= 2.0:
            product_evidence.append("large_component_near_alpha_exterior")
        if p90_gradient > 0.20:
            product_evidence.append("high_source_gradient_detail")
        if p90_texture > 0.05:
            product_evidence.append("high_source_texture_detail")
        record = {
            "area_px": area,
            "bbox_xyxy": [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1],
            "alpha_exterior_min_distance_px": round(min_distance, 2),
            "source_gradient_p90": round(p90_gradient, 4),
            "source_texture_p90": round(p90_texture, 5),
        }
        if product_evidence:
            record["excluded_as_product_evidence"] = product_evidence
            excluded_product_gray_components.append(record)
        else:
            verified_background_residual[component] = True
            residual_components.append(record)
    residual_components.sort(key=lambda item: int(item["area_px"]), reverse=True)
    excluded_product_gray_components.sort(key=lambda item: int(item["area_px"]), reverse=True)

    before_hard = before_alpha >= 128
    after_hard = after_alpha >= 128
    diff = before_hard & ~after_hard
    diff_items = components(diff)
    fg_rgb = cv2.cvtColor(foreground, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    fg_max = np.max(fg_rgb, axis=2)
    fg_min = np.min(fg_rgb, axis=2)
    fg_saturation = (fg_max - fg_min) / np.maximum(fg_max, 1e-6)
    entity_texture, entity_gradient, entity_chroma, entity_chroma_threshold, entity_texture_threshold, entity_gradient_threshold = source_features(source)
    entity = before_hard & (entity_chroma > entity_chroma_threshold) & (
        (fg_saturation > 0.16)
        | (entity_texture > entity_texture_threshold)
        | (entity_gradient > entity_gradient_threshold)
    )
    diff_entity_items = components(diff & entity)

    if case_id == "8235":
        alpha_dir = artifact_dir / "8235-alpha"
        alpha_dir.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(alpha_dir / "alpha_before_clean.png"), alpha_image(before_alpha))
        cv2.imwrite(str(alpha_dir / "alpha_after_clean.png"), alpha_image(after_alpha))
        cv2.imwrite(str(alpha_dir / "alpha_clean_diff_removed.png"), alpha_image(diff.astype(np.uint8) * 255))
        cv2.imwrite(str(alpha_dir / "alpha_clean_diff_inside_entity.png"), alpha_image((diff & entity).astype(np.uint8) * 255))

    white_sheet = artifact_dir / "crops" / f"{case_id}_white_200pct_contact.png"
    dark_sheet = artifact_dir / "crops" / f"{case_id}_dark_200pct_contact.png"
    make_crop_sheet(white, bbox, white_sheet, f"{case_id} white", config["edge_side"])
    make_crop_sheet(dark, bbox, dark_sheet, f"{case_id} dark", config["edge_side"])

    metrics: dict[str, Any] = {
        "dimensions": {"width": int(white.shape[1]), "height": int(white.shape[0])},
        "hard_bbox_xyxy": [x0, y0, x1, y1],
        "hard_foreground_width_px": x1 - x0,
        "hard_foreground_height_px": y1 - y0,
        "hard_foreground_long_side_px": max(x1 - x0, y1 - y0),
        "gray_area_rule": "hard final alpha; HSV S < 0.12; 60 < V < 240",
        "gray_components_raw": gray_components[:20],
        "max_raw_gray_component_px": int(gray_components[0]["area_px"]) if gray_components else 0,
        "gray_components_background_like": gray_background_components[:20],
        "max_internal_gray_component_px": int(gray_background_components[0]["area_px"]) if gray_background_components else 0,
        "gray_background_like_rule": "raw gray candidate plus source four-corner Lab chroma match, low texture, and smooth-gradient gate",
        "gray_components_background_residual_candidate": components(gray_background_residual)[:20],
        "gray_components_background_residual": residual_components[:20],
        "max_background_residual_component_px": int(residual_components[0]["area_px"]) if residual_components else 0,
        "gray_product_component_exclusions": excluded_product_gray_components[:20],
        "gray_background_residual_rule": "raw gray candidate plus four-corner Lab chroma match, low texture, and low source gradient; components with deterministic product evidence are reported separately",
        "alpha_clean_diff_components": diff_items[:20],
        "alpha_clean_diff_max_component_px": int(diff_items[0]["area_px"]) if diff_items else 0,
        "alpha_clean_diff_inside_entity_components": diff_entity_items[:20],
        "alpha_clean_diff_inside_entity_max_component_px": int(diff_entity_items[0]["area_px"]) if diff_entity_items else 0,
        "crops": {
            "white_200pct_contact": str(white_sheet),
            "dark_200pct_contact": str(dark_sheet),
        },
    }

    if case_id == "8212":
        core_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (17, 17))
        core = cv2.erode(hard.astype(np.uint8), core_kernel) > 0
        ring_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
        ring = hard & ~(cv2.erode(hard.astype(np.uint8), ring_kernel) > 0)
        hue = hsv[:, :, 0].astype(np.float32)
        core_valid = core & (hsv[:, :, 1] >= 13) & (hsv[:, :, 2] >= 24)
        core_hue = float(np.median(hue[core_valid])) if np.any(core_valid) else 0.0
        edge_y, edge_x = np.where(ring)
        center_x = 0.5 * (x0 + x1)
        center_y = 0.5 * (y0 + y1)
        vector_x = edge_x.astype(np.float32) - center_x
        vector_y = edge_y.astype(np.float32) - center_y
        vector_norm = np.maximum(np.sqrt(vector_x * vector_x + vector_y * vector_y), 1.0)
        inward_distance = 6.0
        sample_x = np.clip(np.rint(edge_x - vector_x / vector_norm * inward_distance).astype(np.int32), 0, white.shape[1] - 1)
        sample_y = np.clip(np.rint(edge_y - vector_y / vector_norm * inward_distance).astype(np.int32), 0, white.shape[0] - 1)
        edge_hue = hue[edge_y, edge_x]
        reference_hue = hue[sample_y, sample_x]
        edge_sat = hsv[edge_y, edge_x, 1]
        reference_sat = hsv[sample_y, sample_x, 1]
        # Hue is undefined on near-neutral fabric/metal/black pixels.  Keep the
        # requested 3px ring, but only score pixels whose edge and inward sample
        # both have enough chroma for a meaningful hue comparison.
        valid = (edge_sat >= 30) & (reference_sat >= 30) & (hsv[edge_y, edge_x, 2] >= 24) & (hsv[sample_y, sample_x, 2] >= 24)
        if np.any(valid):
            hue_delta_raw = np.abs(edge_hue[valid] - reference_hue[valid])
            hue_delta = np.minimum(hue_delta_raw, 180.0 - hue_delta_raw) * 2.0
        else:
            hue_delta = np.zeros(0, dtype=np.float32)
        metrics["edge_hue_rule"] = "inside 3px ring; each edge pixel compared with a 6px inward sample; edge/reference S < 30/255 excluded because hue is undefined"
        metrics["edge_hue_reference_deg"] = core_hue * 2.0
        metrics["edge_hue_valid_px"] = int(np.count_nonzero(valid))
        metrics["edge_hue_unmeasured_px"] = int(valid.size - np.count_nonzero(valid))
        metrics["edge_hue_max_deviation_deg"] = float(np.max(hue_delta)) if hue_delta.size else 0.0
        metrics["edge_hue_p95_deviation_deg"] = float(np.quantile(hue_delta, 0.95)) if hue_delta.size else 0.0

    shadow_mask = shadow.astype(np.float32) / 255.0
    shadow_pixels = (shadow_mask > 0.02) & (final_alpha < 5)
    white_rgb = cv2.cvtColor(white, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    white_luma = 0.2126 * white_rgb[:, :, 0] + 0.7152 * white_rgb[:, :, 1] + 0.0722 * white_rgb[:, :, 2]
    darkest_l = float(np.min(white_luma[shadow_pixels]) * 255.0) if np.any(shadow_pixels) else 255.0
    dilated_hard = cv2.dilate(hard.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))) > 0
    touching = np.any((shadow_mask > 0.02) & dilated_hard & ~hard)
    raster_distance = cv2.distanceTransform((~hard).astype(np.uint8), cv2.DIST_L2, 5)
    shadow_distance = float(np.min(raster_distance[shadow_mask > 0.02])) if np.any(shadow_mask > 0.02) else None
    metrics["shadow_min_distance_px_continuous"] = 0.0 if touching else None
    metrics["shadow_raster_distance_px"] = shadow_distance
    metrics["shadow_darkest_L"] = darkest_l
    metrics["shadow_contact_touch_detected"] = bool(touching)
    return metrics


def markdown_report(metrics: dict[str, Any], output_path: Path, workflow_name: str, params: dict[str, Any]) -> None:
    lines = [
        "# 商品图抠白底第 3 轮 QA 实测",
        "",
        f"工作流：`{workflow_name}`",
        "",
        "## 统一参数",
        "",
        "```json",
        json.dumps(params, ensure_ascii=False, indent=2),
        "```",
        "",
        "## 五张实测",
        "",
        "| 图 | 尺寸 | 硬前景宽×高 | 长边 | 原始 HSV 灰区最大 | 背景候选最大 | 严格背景残留最大 | 清理差最大块 | 差集落在实体特征内最大块 | 阴影接触距离 | 阴影最暗 L |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for case_id, item in metrics["cases"].items():
        size = f"{item['dimensions']['width']}×{item['dimensions']['height']}"
        lines.append(
            f"| {case_id} | {size} | {item['hard_foreground_width_px']}×{item['hard_foreground_height_px']} | "
            f"{item['hard_foreground_long_side_px']} | {item['max_raw_gray_component_px']} | "
            f"{item['max_internal_gray_component_px']} | {item['max_background_residual_component_px']} | "
            f"{item['alpha_clean_diff_max_component_px']} | {item['alpha_clean_diff_inside_entity_max_component_px']} | {item['shadow_min_distance_px_continuous']} | "
            f"{item['shadow_darkest_L']:.1f} |"
        )
    if "edge_hue_max_deviation_deg" in metrics["cases"]["8212"]:
        item = metrics["cases"]["8212"]
        lines.extend(
            [
                "",
                "## 8212 边缘色相",
                "",
                f"内向 3px 环带逐像素对比 6px 内取样：最大偏离 `{item['edge_hue_max_deviation_deg']:.2f}°`；P95：`{item['edge_hue_p95_deviation_deg']:.2f}°`；有效像素 `{item['edge_hue_valid_px']}`，未测 `{item['edge_hue_unmeasured_px']}`。低饱和像素色相无定义，按规则排除。",
            ]
        )
    lines.extend(
        [
            "",
            "## F1 alpha 对照图",
            "",
            "8235 已输出清理前 alpha、清理后 alpha、清理差集，以及差集与实体特征交集。",
            "",
            "## 200% 对照图",
            "",
            "每张图各有一张白底和一张深灰底 contact sheet，四格分别标注帽顶、帽檐、后侧边缘、后开口。",
            "",
            "## 说明",
            "",
            "原始 HSV 灰区列严格按最终硬 alpha 内 S<0.12、60<V<240 计算；背景候选列叠加原图四角 Lab 色度、纹理和梯度判据；背景残留列不使用低纹理 OR 快捷条件，并将大于 500px² 且贴近 alpha 外轮廓、P90 梯度>0.20 或 P90 纹理>0.05 的组件作为商品证据单独列出。低饱和金属、扣件、刺绣等真实商品材质仍会进入原始列，不能把它们误报为背景残留。实体差集统计用原图纹理/梯度和 FBA 前景饱和度构成保守实体特征掩膜。所有数值由脚本直接从输出 PNG 读取。",
        ]
    )
    output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--source-dir", required=True, type=Path)
    parser.add_argument("--artifact-dir", required=True, type=Path)
    parser.add_argument("--workflow", default="product-cutout-fba-three-fixes.api.json")
    args = parser.parse_args()
    args.artifact_dir.mkdir(parents=True, exist_ok=True)
    params = {
        "EDGE_REFILL_PX": 8,
        "EDGE_REFILL_STRENGTH": 1.0,
        "SHADOW_BAND_PX": 18,
        "SHADOW_WIDTH_SCALE": 1.15,
        "SHADOW_HEIGHT_SCALE": 0.14,
        "SHADOW_OFFSET_PX": 0,
        "SHADOW_BLUR": 6,
        "TARGET_LONG_SIDE": 1100,
        "CENTER_X": 0.5,
        "CENTER_Y": 0.48,
        "SHADOW_STRENGTH": 0.30,
    }
    case_metrics = {
        case_id: analyze_case(case_id, config, args.output_dir, args.source_dir, args.artifact_dir)
        for case_id, config in CASES.items()
    }
    result = {
        "workflow": args.workflow,
        "params": params,
        "cases": case_metrics,
    }
    (args.artifact_dir / "metrics.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    markdown_report(result, args.artifact_dir / "qa-report.md", args.workflow, params)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
