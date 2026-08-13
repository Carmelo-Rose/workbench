"""Validate an immutable calibrated-shadow package and every preset/gold pair."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

REFERENCE_SIDE = 800
BIREFNET_WEIGHTS_SHA256 = "a5a4de698739ea5e0e8bbab28e1b293dde95092b87a442d566cbc585c53cef55"
BIREFNET_MODEL_ID = "ZhengPeng7/BiRefNet_HR-matting"
BIREFNET_MODEL_REVISION = "5d6b6f8adcb5b417c871b1d84ceaae9871355b7f"
ALGORITHM = {
    "id": "ps-levels-roi-v1",
    "levels": "round(value*255/whitePoint)-clamp-255",
}
ADAPTIVE_ALGORITHM = {
    "id": "ps-levels-roi-v2-adaptive-white",
    "levels": "round(value*255/channelMedian)-clamp-255",
}
FIXED_GATES = {
    "whitePointMin": 220,
    "whitePointMax": 245,
    "whitePointMaxChannelSpread": 8,
    "productBoxTolerance": 0.05,
}
ADAPTIVE_GATES = {
    **FIXED_GATES,
    "roiBoundaryMaxChannelJump": 5,
    "detachedResidueMinArea": 64,
    "residueThreshold": 2,
    "legalShadowMaskNeighborhood": 16,
}
ADAPTIVE_WHITE_SAMPLE_POLICY = {
    "referencePatchSize": 31,
    "minimumPatchPassRate": 0.95,
    "minimumMaskDistance": 32,
    "minimumEdgeDistance": 16,
    "rgbMin": 220,
    "rgbMax": 245,
    "maxChannelSpread": 8,
    "targetMean": 240,
    "selectionOrder": ["patch-pass-rate-desc", "mask-distance-desc", "mean-distance-to-240-asc", "y-asc", "x-asc"],
    "median": "per-channel-median-of-valid-patch-pixels",
}
SAFE_ID_CHARS = frozenset("abcdefghijklmnopqrstuvwxyz0123456789.-")
DEVELOPMENT_IDENTITY = "slot-4-development"
SCHEMA_BY_VERSION = {
    "hat-ps-shadow-v2.1": 1,
    "hat-ps-shadow-v2.2": 2,
    "hat-ps-shadow-v2.3": 2,
    "hat-ps-shadow-v2.4": 3,
    "hat-ps-shadow-v2.5": 3,
    DEVELOPMENT_IDENTITY: 3,
}


def fail(message: str) -> None:
    raise RuntimeError(message)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def expected_schema_version(version: object) -> int:
    expected = SCHEMA_BY_VERSION.get(version)
    if expected is None:
        fail(f"unsupported immutable preset version: {version}")
    return expected


def manifest_digest(value: dict[str, Any]) -> str:
    canonical = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def safe_id(value: Any) -> bool:
    return isinstance(value, str) and bool(value) and value[0].isalnum() and all(character in SAFE_ID_CHARS for character in value)


def package_file(root: Path, value: Any, label: str, *, require_relative: bool = False) -> Path:
    if not isinstance(value, str) or not value:
        fail(f"{label} path is missing")
    supplied = Path(value)
    if require_relative and supplied.is_absolute():
        fail(f"{label} must be packaged with a relative path")
    candidate = supplied.resolve() if supplied.is_absolute() else (root / supplied).resolve()
    if not supplied.is_absolute() and candidate != root and root not in candidate.parents:
        fail(f"{label} escapes package")
    return candidate


def validate_release_policy(manifest: dict[str, Any], registry: dict[str, Any], candidate_mode: bool) -> None:
    development_identity = manifest.get("version") == DEVELOPMENT_IDENTITY
    if candidate_mode:
        for value, label in ((manifest, "manifest"), (registry, "registry")):
            if value.get("candidateOnly") is not True:
                fail(f"candidate-mode {label} must declare candidateOnly true")
            if value.get("releaseState") != "awaiting-human-approval":
                fail(f"candidate-mode {label} must be awaiting-human-approval")
            if value.get("approved") is not False or value.get("publicationAllowed") is not False:
                fail(f"candidate-mode {label} must explicitly forbid approval and publication")
        if development_identity and (manifest.get("developmentIdentity") != DEVELOPMENT_IDENTITY or registry.get("developmentIdentity") != DEVELOPMENT_IDENTITY):
            fail("slot-4-development candidate must carry the explicit development identity in manifest and registry")
        return

    if development_identity:
        fail("slot-4-development is a development identity and cannot be validated in publication mode")
    if registry.get("candidateOnly") is True or manifest.get("candidateOnly") is True:
        fail("candidate-only package cannot be validated in publication mode")
    if SCHEMA_BY_VERSION.get(manifest.get("version")) in (2, 3):
        if manifest.get("candidateOnly") is not False or manifest.get("releaseState") != "approved" or manifest.get("approved") is not True or manifest.get("publicationAllowed") is not True:
            fail("schema-v2/v3 publication requires explicit approved release state and candidateOnly false")
        return
    release_keys = ("releaseState", "approved", "publicationAllowed")
    if any(key in manifest for key in release_keys):
        if manifest.get("releaseState") != "approved" or manifest.get("approved") is not True or manifest.get("publicationAllowed") is not True:
            fail("publication mode rejects manifests that are not explicitly approved for publication")


def validate_candidate_evidence(manifest: dict[str, Any], root: Path, candidate_mode: bool) -> None:
    if not candidate_mode:
        return
    evidence = manifest.get("candidateEvidence")
    if not isinstance(evidence, list) or not evidence:
        fail("candidate-mode manifest requires pinned candidateEvidence")
    evidence_ids: set[str] = set()
    for item in evidence:
        if not isinstance(item, dict) or not safe_id(item.get("id")) or item["id"] in evidence_ids:
            fail("candidate evidence IDs are invalid or duplicated")
        evidence_ids.add(item["id"])
        candidate = package_file(root, item.get("file"), f"candidate evidence {item['id']}", require_relative=True)
        if not candidate.is_file() or digest(candidate) != item.get("sha256"):
            fail(f"candidate evidence hash mismatch: {item['id']}")

    reference = manifest.get("visualStyleReference")
    if not isinstance(reference, dict) or reference.get("role") != "visual-style-reference-only" or reference.get("isGoldStandard") is not False:
        fail("candidate-mode manifest requires a non-gold visual style reference")
    reference_file = package_file(root, reference.get("file"), "visual style reference", require_relative=True)
    if not reference_file.is_file() or digest(reference_file) != reference.get("sha256"):
        fail("visual style reference hash mismatch")


def asset(manifest: dict[str, Any], root: Path, asset_id: str) -> Path:
    matches = [item for item in manifest["regressionAssets"] if item.get("id") == asset_id]
    if len(matches) != 1:
        fail(f"expected one regression asset {asset_id}, found {len(matches)}")
    candidate = (root / matches[0]["file"]).resolve()
    if candidate != root and root not in candidate.parents:
        fail(f"regression asset escapes package: {asset_id}")
    if not candidate.is_file() or digest(candidate) != matches[0].get("sha256"):
        fail(f"regression asset hash mismatch: {asset_id}")
    return candidate


def full_layer_rgba(layer: Any, size: tuple[int, int]) -> Image.Image:
    rendered = layer.composite()
    if rendered is None:
        fail(f"gold PSD layer has no pixels: {layer.name}")
    full = Image.new("RGBA", size, (0, 0, 0, 0))
    full.alpha_composite(rendered.convert("RGBA"), (layer.left, layer.top))
    return full


def mask_metrics(candidate: np.ndarray, expected: np.ndarray) -> tuple[float, float]:
    first = candidate >= 128
    second = expected >= 128
    iou = float(np.logical_and(first, second).sum() / max(1, np.logical_or(first, second).sum()))
    first_edge = first ^ ndi.binary_erosion(first)
    second_edge = second ^ ndi.binary_erosion(second)
    if not first_edge.any() or not second_edge.any():
        return iou, float("inf")
    first_distance = ndi.distance_transform_edt(~second_edge)[first_edge]
    second_distance = ndi.distance_transform_edt(~first_edge)[second_edge]
    return iou, float((first_distance.mean() + second_distance.mean()) / 2)


def product_box(mask: np.ndarray) -> dict[str, float]:
    ys, xs = np.where(mask >= 128)
    if not xs.size:
        fail("BiRefNet mask is empty")
    height, width = mask.shape
    return {
        "left": float(xs.min() / width),
        "top": float(ys.min() / height),
        "width": float((xs.max() - xs.min() + 1) / width),
        "height": float((ys.max() - ys.min() + 1) / height),
    }


def box_matches(actual: dict[str, float], expected: dict[str, float], tolerance: float) -> bool:
    return all(abs(actual[key] - float(expected[key])) <= tolerance for key in actual)


def validate_rect(roi: Any, preset_id: str) -> None:
    if not isinstance(roi, dict) or any(not isinstance(roi.get(key), int) for key in ("x", "y", "width", "height")):
        fail(f"preset ROI must contain integers: {preset_id}")
    if roi["x"] < 0 or roi["y"] < 0 or roi["width"] <= 0 or roi["height"] <= 0 or roi["x"] >= 800 or roi["y"] >= 800:
        fail(f"preset ROI is invalid: {preset_id}")
    if roi["x"] + roi["width"] > 800 or roi["y"] + roi["height"] > 1600:
        fail(f"preset ROI may overflow only the bottom: {preset_id}")


def validate_point(point: Any, preset_id: str) -> None:
    if not isinstance(point, dict) or any(not isinstance(point.get(key), int) for key in ("x", "y")):
        fail(f"preset whitePoint must contain integers: {preset_id}")
    if not (0 <= point["x"] < 800 and 0 <= point["y"] < 800):
        fail(f"preset whitePoint is outside reference canvas: {preset_id}")


def scale_coordinate(value: int, side: int) -> int:
    return math.floor(value * side / REFERENCE_SIDE + 0.5)


def scaled_roi(preset: dict[str, Any], side: int) -> tuple[int, int, int, int]:
    roi = preset["roi"]
    left = scale_coordinate(roi["x"], side)
    top = scale_coordinate(roi["y"], side)
    right = min(side, scale_coordinate(roi["x"] + roi["width"], side))
    bottom = min(side, scale_coordinate(roi["y"] + roi["height"], side))
    if left < 0 or top < 0 or left >= side or top >= side or right <= left or bottom <= top:
        fail(f"scaled ROI is empty: {preset['id']}")
    return left, top, right, bottom


def adaptive_white_sample(source: np.ndarray, mask: np.ndarray, preset: dict[str, Any]) -> dict[str, Any]:
    policy = preset["whiteSamplePolicy"]
    side = source.shape[1]
    left, top, right, bottom = scaled_roi(preset, side)
    patch_size = max(1, scale_coordinate(policy["referencePatchSize"], side))
    if patch_size % 2 == 0:
        patch_size += 1
    radius = patch_size // 2
    distances = ndi.distance_transform_edt(mask == 0)
    yy, xx = np.indices(mask.shape)
    edge = np.minimum.reduce((xx - left, right - 1 - xx, yy - top, bottom - 1 - yy, xx, side - 1 - xx, yy, side - 1 - yy))
    spread = source.max(axis=2) - source.min(axis=2)
    rgb_valid = np.all((source >= policy["rgbMin"]) & (source <= policy["rgbMax"]), axis=2) & (spread <= policy["maxChannelSpread"])
    valid = ((xx >= left) & (xx < right) & (yy >= top) & (yy < bottom)
             & (mask == 0)
             & (distances >= scale_coordinate(policy["minimumMaskDistance"], side))
             & (edge >= scale_coordinate(policy["minimumEdgeDistance"], side))
             & rgb_valid)
    counts = np.rint(ndi.uniform_filter(valid.astype(np.float64), size=patch_size, mode="constant", cval=0) * patch_size * patch_size)
    candidates = np.argwhere(valid & (counts / (patch_size * patch_size) >= policy["minimumPatchPassRate"]))
    if not candidates.size:
        fail(f"adaptive white-field sample not found: {preset['id']}")

    def score(point: np.ndarray) -> tuple[float, float, float, int, int]:
        y, x = int(point[0]), int(point[1])
        return (-float(counts[y, x]), -float(distances[y, x]), abs(float(source[y, x].mean()) - policy["targetMean"]), y, x)

    sample_y, sample_x = (int(value) for value in min(candidates, key=score))
    patch_valid = valid[sample_y - radius:sample_y + radius + 1, sample_x - radius:sample_x + radius + 1]
    patch = source[sample_y - radius:sample_y + radius + 1, sample_x - radius:sample_x + radius + 1][patch_valid]
    median = tuple(int(np.floor(value + 0.5)) for value in np.median(patch, axis=0))
    return {
        "point": {"x": sample_x, "y": sample_y},
        "pointRgb": tuple(int(value) for value in source[sample_y, sample_x]),
        "medianRgb": median,
        "patchPassRate": float(patch_valid.sum() / (patch_size * patch_size)),
        "maskDistance": float(distances[sample_y, sample_x]),
        "patchSize": patch_size,
    }


def roi_boundary_jump(image: np.ndarray, mask: np.ndarray, roi: tuple[int, int, int, int]) -> int:
    left, top, right, bottom = roi
    maximum = 0
    def compare(first: np.ndarray, second: np.ndarray, allowed: np.ndarray) -> None:
        nonlocal maximum
        if allowed.any():
            maximum = max(maximum, int(np.abs(first.astype(np.int16) - second.astype(np.int16))[allowed].max()))
    if top > 0:
        compare(image[top - 1, left:right], image[top, left:right], (mask[top - 1, left:right] == 0) & (mask[top, left:right] == 0))
    if bottom < image.shape[0]:
        compare(image[bottom - 1, left:right], image[bottom, left:right], (mask[bottom - 1, left:right] == 0) & (mask[bottom, left:right] == 0))
    if left > 0:
        compare(image[top:bottom, left - 1], image[top:bottom, left], (mask[top:bottom, left - 1] == 0) & (mask[top:bottom, left] == 0))
    if right < image.shape[1]:
        compare(image[top:bottom, right - 1], image[top:bottom, right], (mask[top:bottom, right - 1] == 0) & (mask[top:bottom, right] == 0))
    return maximum


def detached_residue_area(image: np.ndarray, mask: np.ndarray, gates: dict[str, Any]) -> int:
    residue = (mask == 0) & ((255 - image.min(axis=2)) >= gates["residueThreshold"])
    labels, count = ndi.label(residue, structure=np.ones((3, 3), dtype=np.uint8))
    distances = ndi.distance_transform_edt(mask == 0)
    neighborhood = scale_coordinate(gates["legalShadowMaskNeighborhood"], image.shape[1])
    largest = 0
    for label in range(1, count + 1):
        component = labels == label
        if not np.any(component & (distances <= neighborhood)):
            largest = max(largest, int(component.sum()))
    return largest


def purify_detached_background_residue(image: np.ndarray, mask: np.ndarray, gates: dict[str, Any]) -> np.ndarray:
    purified = image.copy()
    residue = (mask == 0) & ((255 - purified.min(axis=2)) >= gates["residueThreshold"])
    labels, count = ndi.label(residue, structure=np.ones((3, 3), dtype=np.uint8))
    distances = ndi.distance_transform_edt(mask == 0)
    neighborhood = scale_coordinate(gates["legalShadowMaskNeighborhood"], image.shape[1])
    for label in range(1, count + 1):
        component = labels == label
        if int(component.sum()) < gates["detachedResidueMinArea"] or np.any(component & (distances <= neighborhood)):
            continue
        purified[component] = 255
    return purified


def native_shadow(source: np.ndarray, preset: dict[str, Any], sampled: tuple[int, int, int]) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    height, width = source.shape[:2]
    if height != width:
        fail("regression input is not square")
    left, top, right, bottom = scaled_roi(preset, width)
    output = np.full_like(source, 255)
    region = source[top:bottom, left:right].astype(np.float64)
    for channel, white in enumerate(sampled):
        region[..., channel] = np.minimum(255, np.floor(region[..., channel] * 255 / white + 0.5))
    output[top:bottom, left:right] = region.astype(np.uint8)
    return output, (left, top, right, bottom)


def associated_gold_ids(schema_version: int, preset: dict[str, Any], all_gold_ids: list[str]) -> list[str]:
    if schema_version == 1:
        if "goldStandardIds" in preset:
            fail(f"schema v1 preset must not declare goldStandardIds: {preset['id']}")
        return all_gold_ids
    values = preset.get("goldStandardIds")
    if not isinstance(values, list) or len(values) < 2 or len(values) != len(set(values)) or any(not safe_id(value) for value in values):
        fail(f"schema v2 preset requires at least two unique goldStandardIds: {preset['id']}")
    unknown = sorted(set(values) - set(all_gold_ids))
    if unknown:
        fail(f"preset references unknown gold standards: {preset['id']} -> {unknown}")
    return values


def validate_pair(manifest: dict[str, Any], root: Path, preset: dict[str, Any], gold: dict[str, Any], require_gold_psd: bool, candidate_mode: bool) -> dict[str, Any]:
    psd = package_file(root, gold.get("psdPath"), f"gold PSD {gold.get('id')}", require_relative=candidate_mode)
    if psd.exists():
        if digest(psd) != gold["psdSha256"]:
            fail(f"gold PSD hash mismatch: {gold['id']}")
    elif require_gold_psd:
        fail(f"gold PSD is unavailable: {gold['psdPath']}")
    layer_names = gold.get("layerNames")
    if not isinstance(layer_names, dict) or any(not isinstance(layer_names.get(key), str) or not layer_names[key] for key in ("product", "shadow", "background")):
        fail(f"gold PSD layer mapping is incomplete: {gold['id']}")
    psd_regression: dict[str, np.ndarray] | None = None
    if psd.exists() and require_gold_psd:
        from psd_tools import PSDImage
        document = PSDImage.open(psd)
        resolved_layers: dict[str, Any] = {}
        for key in ("product", "shadow", "background"):
            matches = [layer for layer in document.descendants() if layer.name == layer_names[key] and not layer.is_group()]
            if len(matches) != 1:
                fail(f"gold PSD must resolve exactly one {key} layer: {gold['id']} -> {layer_names[key]}")
            if not matches[0].is_visible():
                fail(f"gold PSD mapped {key} layer must be visible: {gold['id']} -> {layer_names[key]}")
            resolved_layers[key] = matches[0]

        product_layer = full_layer_rgba(resolved_layers["product"], document.size)
        shadow_layer = full_layer_rgba(resolved_layers["shadow"], document.size)
        background_layer = full_layer_rgba(resolved_layers["background"], document.size)
        background_rgba = np.asarray(background_layer)
        if not np.all(background_rgba[..., 3] == 255) or not np.all(background_rgba[..., :3] == 255):
            fail(f"gold PSD mapped background must be full-canvas opaque white: {gold['id']}")

        white = Image.new("RGBA", document.size, (255, 255, 255, 255))
        psd_shadow = white.copy()
        psd_shadow.alpha_composite(shadow_layer)
        psd_preview = psd_shadow.copy()
        psd_preview.alpha_composite(product_layer)
        product_rgba = np.asarray(product_layer)
        psd_regression = {
            "product": product_rgba,
            "ps-mask": product_rgba[..., 3],
            "shadow": np.asarray(psd_shadow.convert("RGB")),
            "preview": np.asarray(psd_preview.convert("RGB")),
        }

    prefix = gold["id"]
    source = np.asarray(Image.open(asset(manifest, root, f"{prefix}-input")).convert("RGB"))
    packaged_product = np.asarray(Image.open(asset(manifest, root, f"{prefix}-product")).convert("RGBA"))
    ps_shadow = np.asarray(Image.open(asset(manifest, root, f"{prefix}-shadow")).convert("RGB"))
    ps_mask = np.asarray(Image.open(asset(manifest, root, f"{prefix}-ps-mask")).convert("L"))
    birefnet_mask = np.asarray(Image.open(asset(manifest, root, f"{prefix}-birefnet-mask")).convert("L"))
    packaged_preview = np.asarray(Image.open(asset(manifest, root, f"{prefix}-preview")).convert("RGB"))
    if packaged_product.shape != (*source.shape[:2], 4) or ps_shadow.shape != source.shape or ps_mask.shape != source.shape[:2] or birefnet_mask.shape != source.shape[:2] or packaged_preview.shape != source.shape:
        fail(f"regression asset dimensions disagree: {preset['id']} x {prefix}")
    if psd_regression is not None:
        packaged = {
            "product": packaged_product,
            "ps-mask": ps_mask,
            "shadow": ps_shadow,
            "preview": packaged_preview,
        }
        mismatches = [kind for kind, expected in psd_regression.items() if not np.array_equal(packaged[kind], expected)]
        if mismatches:
            fail(f"gold PSD pixels do not match packaged regression assets: {gold['id']} -> {mismatches}")

    gates = manifest["gates"]
    adaptive = manifest["schemaVersion"] == 3 and "whiteSamplePolicy" in preset
    if adaptive:
        sample = adaptive_white_sample(source, birefnet_mask, preset)
        sample_x, sample_y = sample["point"]["x"], sample["point"]["y"]
        sampled = sample["medianRgb"]
    else:
        point = preset["whitePoint"]
        sample_x = math.floor(point["x"] * source.shape[1] / REFERENCE_SIDE + 0.5)
        sample_y = math.floor(point["y"] * source.shape[0] / REFERENCE_SIDE + 0.5)
        if sample_x >= source.shape[1] or sample_y >= source.shape[0]:
            fail(f"sample point is outside scaled input: {preset['id']} x {prefix}")
        sampled = tuple(int(value) for value in source[sample_y, sample_x])
        sample = {"point": {"x": sample_x, "y": sample_y}, "pointRgb": sampled, "medianRgb": sampled, "patchPassRate": 1.0, "maskDistance": 0.0, "patchSize": 1}
    if not all(gates["whitePointMin"] <= value <= gates["whitePointMax"] for value in sampled) or max(sampled) - min(sampled) > gates["whitePointMaxChannelSpread"]:
        fail(f"white-point gate failed: {preset['id']} x {prefix} RGB={sampled}")
    if birefnet_mask[sample_y, sample_x] != 0 or ps_mask[sample_y, sample_x] != 0:
        fail(f"sample point falls inside product mask: {preset['id']} x {prefix}")

    actual_box = product_box(birefnet_mask)
    if not box_matches(actual_box, gold["productBox"], gates["productBoxTolerance"]):
        fail(f"product box gate failed: {preset['id']} x {prefix} actual={actual_box}")
    rendered_shadow_before_purification, roi = native_shadow(source, preset, sampled)
    alpha = birefnet_mask.astype(np.float64) / 255
    output_before_purification = np.rint(source * alpha[..., None] + rendered_shadow_before_purification * (1 - alpha[..., None])).astype(np.uint8)
    rendered_shadow = purify_detached_background_residue(rendered_shadow_before_purification, birefnet_mask, gates) if adaptive else rendered_shadow_before_purification
    delta = np.abs(rendered_shadow.astype(np.int16) - ps_shadow.astype(np.int16))
    mean_error = float(delta.mean())
    max_error = int(delta.max())
    if mean_error > 0.1 or max_error > 2:
        fail(f"Photoshop shadow parity failed: {preset['id']} x {prefix} mean={mean_error} max={max_error}")
    iou, boundary = mask_metrics(birefnet_mask, ps_mask)
    boundary_at_800 = boundary * REFERENCE_SIDE / source.shape[1]
    if iou < 0.98 or boundary_at_800 > 3:
        fail(f"BiRefNet mask parity failed: {preset['id']} x {prefix} IoU={iou} boundary={boundary_at_800}")

    output = np.rint(source * alpha[..., None] + rendered_shadow * (1 - alpha[..., None])).astype(np.uint8)
    core = birefnet_mask == 255
    if not np.array_equal(output[core], source[core]):
        fail(f"opaque product pixels changed: {preset['id']} x {prefix}")
    left, top, right, bottom = roi
    yy, xx = np.indices(birefnet_mask.shape)
    outside = (birefnet_mask == 0) & ((xx < left) | (xx >= right) | (yy < top) | (yy >= bottom))
    if not np.all(output[outside] == 255):
        fail(f"pixels outside product and ROI are not white: {preset['id']} x {prefix}")
    boundary_jump = 0
    detached_area = 0
    if adaptive:
        boundary_jump = roi_boundary_jump(output_before_purification, birefnet_mask, roi)
        if boundary_jump > gates["roiBoundaryMaxChannelJump"]:
            fail(f"ROI boundary channel jump failed: {preset['id']} x {prefix} jump={boundary_jump}")
        detached_area = detached_residue_area(output, birefnet_mask, gates)
        if detached_area >= gates["detachedResidueMinArea"]:
            fail(f"detached background residue failed: {preset['id']} x {prefix} area={detached_area}")
    return {
        "presetId": preset["id"],
        "angleSlot": preset["angleSlot"],
        "goldStandardId": prefix,
        "sampledPoint": sample["point"],
        "sampledPointRgb": sample["pointRgb"],
        "sampledRgb": sampled,
        "samplePatchPassRate": sample["patchPassRate"],
        "sampleMaskDistance": sample["maskDistance"],
        "samplePatchSize": sample["patchSize"],
        "productBox": actual_box,
        "shadowMeanChannelError": mean_error,
        "shadowMaxError": max_error,
        "maskIoU": iou,
        "meanBoundaryDistancePxAt800": boundary_at_800,
        "opaqueProductCoreByteIdentical": True,
        "outsideProductAndRoiWhite": True,
        "roiBoundaryMaxChannelJump": boundary_jump,
        "largestDetachedResidueArea": detached_area,
        "outputOpaqueRgb": True,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate every preset against its associated gold standards")
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--registry", type=Path, required=True)
    parser.add_argument("--require-gold-psd", action="store_true")
    parser.add_argument("--candidate-mode", action="store_true", help="Validate a pinned, explicitly non-publishable candidate package")
    args = parser.parse_args()

    root = args.bundle.resolve()
    manifest_path = root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    registry = json.loads(args.registry.read_text(encoding="utf-8"))
    validate_release_policy(manifest, registry, args.candidate_mode)
    pins = [item for item in registry.get("packages", []) if item.get("version") == manifest.get("version")]
    if len(pins) != 1 or pins[0].get("manifestSha256") != manifest_digest(manifest):
        fail("manifest is not pinned exactly once by registry")
    schema_version = manifest.get("schemaVersion")
    if schema_version not in (1, 2, 3):
        fail("manifest schemaVersion must be 1, 2, or 3")
    expected_schema = expected_schema_version(manifest.get("version"))
    if schema_version != expected_schema:
        fail(f"{manifest.get('version')} must use manifest schema v{expected_schema}")
    if manifest.get("canvas") != {"width": REFERENCE_SIDE, "height": REFERENCE_SIDE}:
        fail("reference canvas must be 800x800")
    expected_algorithm = ADAPTIVE_ALGORITHM if schema_version == 3 else ALGORITHM
    if manifest.get("algorithm") != expected_algorithm:
        fail("manifest algorithm revision is not approved")
    if manifest.get("biRefNet") != {
        "modelId": BIREFNET_MODEL_ID,
        "revision": BIREFNET_MODEL_REVISION,
        "weightsSha256": BIREFNET_WEIGHTS_SHA256,
    }:
        fail("BiRefNet model, revision, or weights hash is not approved")
    expected_gates = ADAPTIVE_GATES if schema_version == 3 else FIXED_GATES
    if manifest.get("gates") != expected_gates:
        fail("manifest gate thresholds do not match the fixed release gates")
    validate_candidate_evidence(manifest, root, args.candidate_mode)

    golds = manifest.get("goldStandards")
    presets = manifest.get("presets")
    if not isinstance(golds, list) or not golds or not isinstance(presets, list) or not presets:
        fail("manifest requires non-empty goldStandards and presets")
    if schema_version == 1 and len(golds) != 2:
        fail("schema v1 requires exactly two gold standards")
    gold_ids = [gold.get("id") for gold in golds]
    if len(set(gold_ids)) != len(gold_ids) or any(not safe_id(value) for value in gold_ids):
        fail("gold standard IDs are invalid or duplicated")
    gold_by_id = {gold["id"]: gold for gold in golds}
    required_suffixes = {
        "input": "input",
        "product": "product",
        "ps-mask": "mask",
        "birefnet-mask": "mask",
        "shadow": "shadow",
        "preview": "preview",
    }
    assets = manifest.get("regressionAssets", [])
    if not isinstance(assets, list) or any(not isinstance(item, dict) for item in assets):
        fail("regressionAssets must be a list of objects")
    asset_ids = [item.get("id") for item in assets]
    if len(asset_ids) != len(set(asset_ids)) or any(not safe_id(value) for value in asset_ids):
        fail("regression asset IDs are invalid or duplicated")
    asset_kinds_by_id = {item.get("id"): item.get("kind") for item in assets if isinstance(item, dict)}
    expected_asset_ids: set[str] = set()
    for gold_id in gold_ids:
        for suffix, expected_kind in required_suffixes.items():
            required_id = f"{gold_id}-{suffix}"
            expected_asset_ids.add(required_id)
            if required_id not in asset_kinds_by_id:
                fail(f"gold standard regression asset is missing: {required_id}")
            if asset_kinds_by_id[required_id] != expected_kind:
                fail(f"gold standard regression asset kind mismatch: {required_id}")
    if set(asset_ids) != expected_asset_ids:
        fail("regression assets must exactly cover the six fixed assets for every gold standard")

    preset_ids: set[str] = set()
    slots: set[int] = set()
    assigned_gold_ids: set[str] = set()
    pairs: list[tuple[dict[str, Any], dict[str, Any]]] = []
    unapproved_candidate_presets = 0
    for preset in presets:
        preset_id = preset.get("id")
        slot = preset.get("angleSlot")
        if not safe_id(preset_id) or preset_id in preset_ids:
            fail("preset IDs are invalid or duplicated")
        if not isinstance(slot, int) or not 1 <= slot <= 6 or slot in slots:
            fail(f"preset angleSlot is invalid or duplicated: {preset_id}")
        if not isinstance(preset.get("humanAngleLabel"), str) or not preset["humanAngleLabel"]:
            fail(f"preset lacks a human label: {preset_id}")
        if args.candidate_mode:
            if preset.get("approved") is False:
                unapproved_candidate_presets += 1
                if preset.get("releaseState") != "awaiting-human-approval" or preset.get("publicationAllowed") is not False:
                    fail(f"unapproved candidate preset must be awaiting approval and non-publishable: {preset_id}")
            elif preset.get("approved") is not True:
                fail(f"candidate preset approval flag must be boolean: {preset_id}")
        elif preset.get("approved") is not True:
            fail(f"preset is not approved: {preset_id}")
        validate_rect(preset.get("roi"), preset_id)
        if schema_version == 3 and "whiteSamplePolicy" in preset:
            if "whitePoint" in preset or preset.get("whiteSamplePolicy") != ADAPTIVE_WHITE_SAMPLE_POLICY:
                fail(f"schema v3 adaptive preset must use the immutable whiteSamplePolicy: {preset_id}")
        else:
            if "whiteSamplePolicy" in preset:
                fail(f"fixed white-point preset cannot also declare whiteSamplePolicy: {preset_id}")
            validate_point(preset.get("whitePoint"), preset_id)
        preset_ids.add(preset_id)
        slots.add(slot)
        scoped_ids = associated_gold_ids(schema_version, preset, gold_ids)
        if schema_version in (2, 3):
            overlapping = sorted(set(scoped_ids) & assigned_gold_ids)
            if overlapping:
                fail(f"gold standards cannot be associated with multiple presets: {overlapping}")
            assigned_gold_ids.update(scoped_ids)
        for gold_id in scoped_ids:
            pairs.append((preset, gold_by_id[gold_id]))
    if schema_version in (2, 3):
        unassigned = sorted(set(gold_ids) - assigned_gold_ids)
        if unassigned:
            fail(f"schema v2/v3 gold standards must be associated exactly once: {unassigned}")
    if args.candidate_mode and unapproved_candidate_presets == 0:
        fail("candidate-mode package must contain at least one unapproved preset")

    reports = [validate_pair(manifest, root, preset, gold, args.require_gold_psd, args.candidate_mode) for preset, gold in pairs]
    print(json.dumps({
        "version": manifest["version"],
        "schemaVersion": schema_version,
        "candidateMode": args.candidate_mode,
        "releaseState": manifest.get("releaseState", "approved-legacy"),
        "approved": manifest.get("approved", True),
        "publicationAllowed": manifest.get("publicationAllowed", True),
        "passed": True,
        "pairCount": len(reports),
        "presetGoldPairs": reports,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
