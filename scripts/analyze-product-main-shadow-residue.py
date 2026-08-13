"""Create fail-closed detached-residue diagnostics for one calibration run.

The input directory must be one immutable gate run containing input.png,
preview.png, native-preview.png, mask.png, and report.json.  This tool never
changes a preset, builds a candidate package, or publishes an image.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi


RESIDUE_THRESHOLD = 2
DETACHED_RESIDUE_MIN_AREA = 64
LEGAL_SHADOW_MASK_NEIGHBORHOOD = 16
REFERENCE_SIDE = 800
REQUIRED_INPUTS = ("input.png", "preview.png", "native-preview.png", "mask.png", "report.json")


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def scaled(value: int, side: int) -> int:
    return max(1, round(value * side / REFERENCE_SIDE))


def darkness(image: np.ndarray) -> np.ndarray:
    return 255 - image.min(axis=2).astype(np.float64)


def stats(values: np.ndarray) -> dict[str, float]:
    if not values.size:
        return {"min": 0.0, "mean": 0.0, "max": 0.0}
    return {
        "min": float(values.min()),
        "mean": float(values.mean()),
        "max": float(values.max()),
    }


def component_bbox(component: np.ndarray) -> list[int]:
    ys, xs = np.nonzero(component)
    return [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]


def maximin_target_saddles(field: np.ndarray, seeds: np.ndarray, targets: np.ndarray, target_labels: set[int]) -> dict[int, float]:
    """Return each target component's strongest bottleneck path to any seed.

    The path capacity is the minimum field value along a path.  Maximizing it
    makes a one-pixel raw-noise bridge irrelevant once `field` is spatially
    smoothed, while retaining a measurable broad fade corridor.
    """
    structure = np.ones((3, 3), dtype=np.uint8)
    saddles: dict[int, float] = {}
    for target_label in target_labels:
        target = targets == target_label
        low = 0.0
        high = float(field[target].max())
        for _ in range(12):
            threshold = (low + high) / 2
            support = field >= threshold
            connected, _ = ndi.label(support, structure=structure)
            seed_labels = np.unique(connected[seeds & support])
            target_values = connected[target & support]
            reaches = bool(target_values.size and np.isin(target_values, seed_labels[seed_labels != 0]).any())
            if reaches:
                low = threshold
            else:
                high = threshold
        saddles[target_label] = low
    return saddles


def build_components(native: np.ndarray, mask: np.ndarray) -> tuple[list[dict[str, Any]], np.ndarray]:
    height, width = mask.shape
    native_darkness = darkness(native)
    residue = (mask == 0) & (native_darkness >= RESIDUE_THRESHOLD)
    labels, count = ndi.label(residue, structure=np.ones((3, 3), dtype=np.uint8))
    mask_distance = ndi.distance_transform_edt(mask == 0)
    neighborhood = scaled(LEGAL_SHADOW_MASK_NEIGHBORHOOD, width)

    legal_residue = np.zeros_like(residue)
    components: list[tuple[int, np.ndarray, bool]] = []
    for label in range(1, count + 1):
        component = labels == label
        legal = bool(np.any(component & (mask_distance <= neighborhood)))
        components.append((label, component, legal))
        if legal:
            legal_residue |= component

    distance_to_legal = ndi.distance_transform_edt(~legal_residue) if legal_residue.any() else np.full(mask.shape, np.inf)
    failing_labels = {
        label for label, component, legal in components
        if not legal and int(component.sum()) >= DETACHED_RESIDUE_MIN_AREA
    }
    bridge_metrics: dict[int, dict[str, Any]] = {label: {} for label in failing_labels}
    for sigma_reference in (2, 4, 8):
        sigma = sigma_reference * width / REFERENCE_SIDE
        field = ndi.gaussian_filter(native_darkness * (mask == 0), sigma=sigma, mode="constant", cval=0.0)
        saddles = maximin_target_saddles(field, legal_residue, labels, failing_labels)
        for label, component, legal in components:
            if legal or label not in failing_labels:
                continue
            component_field = field[component]
            peak = float(component_field.max()) if component_field.size else 0.0
            saddle = saddles.get(label, 0.0)
            bridge_metrics[label][f"sigma{sigma_reference}"] = {
                "smoothedPeakDarkness": peak,
                "maximinSaddleDarkness": saddle,
                "saddleToPeakRatio": float(saddle / peak) if peak > 0 else 0.0,
            }

    result: list[dict[str, Any]] = []
    for label, component, legal in components:
        area = int(component.sum())
        if legal or area < DETACHED_RESIDUE_MIN_AREA:
            continue
        bbox = component_bbox(component)
        dilation = ndi.binary_dilation(component, iterations=scaled(8, width))
        annulus = dilation & ~component & (mask == 0)
        threshold_profile = {
            str(threshold): int(np.count_nonzero(component & (native_darkness >= threshold)))
            for threshold in range(RESIDUE_THRESHOLD, 13)
        }
        result.append({
            "componentId": f"C{len(result) + 1:02d}",
            "label": label,
            "area": area,
            "bbox": bbox,
            "darkness": stats(native_darkness[component]),
            "minimumMaskDistance": float(mask_distance[component].min()),
            "minimumDistanceToLegalResidue": float(distance_to_legal[component].min()),
            "surrounding8pxDarkness": stats(native_darkness[annulus]),
            "thresholdPersistenceArea": threshold_profile,
            "broadFadeBridge": bridge_metrics[label],
        })
    result.sort(key=lambda item: (-item["area"], item["bbox"][1], item["bbox"][0]))
    for index, item in enumerate(result, start=1):
        item["componentId"] = f"C{index:02d}"
    return result, legal_residue


def add_per_image_metrics(components: list[dict[str, Any]], images: dict[str, np.ndarray], mask: np.ndarray) -> None:
    native_darkness = darkness(images["native"])
    residue = (mask == 0) & (native_darkness >= RESIDUE_THRESHOLD)
    labels, _ = ndi.label(residue, structure=np.ones((3, 3), dtype=np.uint8))
    for item in components:
        component = labels == item["label"]
        item["images"] = {name: {"darkness": stats(darkness(image)[component])} for name, image in images.items()}


def resolve_reference_regions(components: list[dict[str, Any]], images: dict[str, np.ndarray], mask: np.ndarray) -> list[dict[str, Any]]:
    resolved = copy.deepcopy(components)
    for item in resolved:
        left, top, right, bottom = item["bbox"]
        region_mask = mask[top:bottom + 1, left:right + 1] == 0
        item["originalDarkness"] = item["darkness"]
        item["images"] = {}
        for name, image in images.items():
            region = darkness(image)[top:bottom + 1, left:right + 1]
            item["images"][name] = {"darkness": stats(region[region_mask])}
        item["darkness"] = item["images"]["native"]["darkness"]
    return resolved


def draw_overlay(images: dict[str, Image.Image], components: list[dict[str, Any]], path: Path) -> None:
    first = next(iter(images.values()))
    width, height = first.size
    header = 48
    sheet = Image.new("RGB", (width * 3, height + header), (255, 255, 255))
    colors = ((239, 68, 68), (245, 158, 11), (139, 92, 246), (14, 165, 233), (34, 197, 94), (236, 72, 153))
    for column, (name, image) in enumerate(images.items()):
        panel = image.convert("RGB").copy()
        draw = ImageDraw.Draw(panel)
        for index, item in enumerate(components):
            left, top, right, bottom = item["bbox"]
            color = colors[index % len(colors)]
            draw.rectangle((left, top, right, bottom), outline=color, width=3)
            label = f"{item['componentId']} A={item['area']} d={item['darkness']['min']:.0f}/{item['darkness']['mean']:.1f}/{item['darkness']['max']:.0f} m={item['minimumMaskDistance']:.1f}"
            label_y = max(0, top - 15)
            label_box = draw.textbbox((left, label_y), label)
            draw.rectangle(label_box, fill=(20, 20, 20))
            draw.text((left, label_y), label, fill=color)
        sheet.paste(panel, (column * width, header))
        sheet_draw = ImageDraw.Draw(sheet)
        sheet_draw.rectangle((column * width, 0, (column + 1) * width, header), fill=(28, 28, 30))
        sheet_draw.text((column * width + 16, 16), name, fill=(255, 255, 255))
    sheet.save(path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Write detached-residue component JSON and a three-column overlay")
    parser.add_argument("--source-id", required=True)
    parser.add_argument("--gate-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--regions-from", type=Path, help="Mark the failed component boxes from an earlier diagnostic on this gate run")
    args = parser.parse_args()

    missing = [name for name in REQUIRED_INPUTS if not (args.gate_dir / name).is_file()]
    if missing:
        raise RuntimeError(f"gate directory is incomplete: {', '.join(missing)}")
    report_path = args.gate_dir / "report.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if report.get("sourceId") != args.source_id:
        raise RuntimeError(f"source identity mismatch: expected {args.source_id}, report has {report.get('sourceId')}")
    if args.output_dir.exists():
        raise RuntimeError(f"refusing to overwrite diagnostics: {args.output_dir}")
    args.output_dir.mkdir(parents=True)

    pil_images = {
        "V1 input": Image.open(args.gate_dir / "input.png").convert("RGB"),
        "Photoshop reference": Image.open(args.gate_dir / "preview.png").convert("RGB"),
        "native candidate": Image.open(args.gate_dir / "native-preview.png").convert("RGB"),
    }
    sizes = {image.size for image in pil_images.values()}
    if len(sizes) != 1:
        raise RuntimeError("V1, Photoshop, and native dimensions do not match")
    mask_image = Image.open(args.gate_dir / "mask.png").convert("L")
    if mask_image.size != next(iter(pil_images.values())).size:
        raise RuntimeError("mask dimensions do not match the image columns")
    arrays = {
        "v1": np.asarray(pil_images["V1 input"]),
        "photoshop": np.asarray(pil_images["Photoshop reference"]),
        "native": np.asarray(pil_images["native candidate"]),
    }
    mask = np.asarray(mask_image)
    mode = "detached-components"
    if args.regions_from:
        reference = json.loads(args.regions_from.read_text(encoding="utf-8"))
        components = resolve_reference_regions(reference["failedComponents"], arrays, mask)
        mode = "reference-regions"
    else:
        components, _ = build_components(arrays["native"], mask)
        add_per_image_metrics(components, arrays, mask)

    overlay_path = args.output_dir / "detached-residue-overlay.png"
    draw_overlay(pil_images, components, overlay_path)
    output = {
        "schemaVersion": 1,
        "sourceId": args.source_id,
        "mode": mode,
        "authoritativeGateReport": {
            "path": str(report_path.resolve()),
            "sha256": digest(report_path),
        },
        "fixedGatePolicy": {
            "residueDefinition": "mask=0 and 255-min(RGB)>=2",
            "minimumFailingArea": DETACHED_RESIDUE_MIN_AREA,
            "legalShadowMaskNeighborhoodAt800": LEGAL_SHADOW_MASK_NEIGHBORHOOD,
            "connectivity": 8,
        },
        "failedComponents": components if mode == "detached-components" else [],
        "markedRegions": components if mode == "reference-regions" else [],
        "artifacts": {
            name: {"path": str((args.gate_dir / name).resolve()), "sha256": digest(args.gate_dir / name)}
            for name in REQUIRED_INPUTS
        } | {
            "detached-residue-overlay.png": {"path": str(overlay_path.resolve()), "sha256": digest(overlay_path)}
        } | ({
            "reference-components.json": {"path": str(args.regions_from.resolve()), "sha256": digest(args.regions_from)}
        } if args.regions_from else {}),
    }
    json_path = args.output_dir / "detached-residue-components.json"
    json_path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "sourceId": args.source_id,
        "failedComponentCount": len(components) if mode == "detached-components" else 0,
        "markedRegionCount": len(components) if mode == "reference-regions" else 0,
        "json": str(json_path),
        "overlay": str(overlay_path),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
