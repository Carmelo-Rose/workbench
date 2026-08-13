"""Build fail-closed calibration artifacts from one V1 square and approved PSD.

This command never publishes.  It consumes only explicitly named PSD layers
and leaves every generated candidate awaiting human approval.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw
from psd_tools import PSDImage
from scipy import ndimage as ndi

REFERENCE_SIDE = 800
WHITE_MIN = 220
WHITE_MAX = 245
WHITE_SPREAD_MAX = 8
PRODUCT_BOX_TOLERANCE = 0.05
SHADOW_MEAN_ERROR_MAX = 0.1
SHADOW_MAX_ERROR_MAX = 2
MASK_IOU_MIN = 0.98
BOUNDARY_MAX_AT_800 = 3.0
ADAPTIVE_VERSION = "hat-ps-shadow-v2.4"
DEVELOPMENT_IDENTITY = "slot-4-development"
ADAPTIVE_PATCH_SIZE = 31
ADAPTIVE_PATCH_PASS_RATE = 0.95
ADAPTIVE_MASK_DISTANCE = 32
ADAPTIVE_EDGE_DISTANCE = 16
ADAPTIVE_TARGET_MEAN = 240
ROI_BOUNDARY_MAX_CHANNEL_JUMP = 5
DETACHED_RESIDUE_MIN_AREA = 64
RESIDUE_THRESHOLD = 2
LEGAL_SHADOW_MASK_NEIGHBORHOOD = 16
SAFE_ID_CHARS = frozenset("abcdefghijklmnopqrstuvwxyz0123456789.-")


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parse_pair(value: str, label: str) -> tuple[int, int]:
    try:
        parts = tuple(int(part.strip()) for part in value.split(","))
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"{label} must contain integers") from error
    if len(parts) != 2:
        raise argparse.ArgumentTypeError(f"{label} must contain two comma-separated integers")
    return parts  # type: ignore[return-value]


def parse_rect(value: str) -> tuple[int, int, int, int]:
    try:
        parts = tuple(int(part.strip()) for part in value.split(","))
    except ValueError as error:
        raise argparse.ArgumentTypeError("roi must contain integers") from error
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("roi must be x,y,width,height")
    return parts  # type: ignore[return-value]


def parse_box(value: str) -> dict[str, float]:
    try:
        parts = tuple(float(part.strip()) for part in value.split(","))
    except ValueError as error:
        raise argparse.ArgumentTypeError("gold-product-box must contain numbers") from error
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("gold-product-box must be left,top,width,height")
    left, top, width, height = parts
    if left < 0 or top < 0 or width <= 0 or height <= 0 or left + width > 1.001 or top + height > 1.001:
        raise argparse.ArgumentTypeError("gold-product-box must be a normalized in-canvas box")
    return dict(zip(("left", "top", "width", "height"), parts, strict=True))


def validate_reference_inputs(args: argparse.Namespace) -> None:
    if not 1 <= args.angle_slot <= 6:
        raise RuntimeError("angle-slot must be an integer from 1 through 6")
    if not args.angle_label.strip():
        raise RuntimeError("angle-label must not be empty")
    if not args.preset_version.strip():
        raise RuntimeError("preset-version must not be empty")
    x, y, width, height = args.roi
    if x < 0 or y < 0 or width <= 0 or height <= 0 or x >= REFERENCE_SIDE or y >= REFERENCE_SIDE:
        raise RuntimeError("ROI origin and size are invalid")
    if x + width > REFERENCE_SIDE or y + height > REFERENCE_SIDE * 2:
        raise RuntimeError("ROI may overflow only the bottom of the 800-reference canvas")
    adaptive = args.preset_version in (ADAPTIVE_VERSION, DEVELOPMENT_IDENTITY)
    if args.preset_version == DEVELOPMENT_IDENTITY and args.development_identity != DEVELOPMENT_IDENTITY:
        raise RuntimeError("slot-4-development requires an explicit matching development-identity")
    if adaptive:
        if args.white_point is not None:
            raise RuntimeError(f"{ADAPTIVE_VERSION} must not use a fixed white-point")
        if not args.source_id or args.v1.stem != args.source_id:
            raise RuntimeError(f"{ADAPTIVE_VERSION} source-id must exactly match the V1 filename")
    else:
        if args.white_point is None:
            raise RuntimeError("historical preset versions require white-point")
        sample_x, sample_y = args.white_point
        if not (0 <= sample_x < REFERENCE_SIDE and 0 <= sample_y < REFERENCE_SIDE):
            raise RuntimeError("white-point must be inside the 800-reference canvas")
    if len(args.gold_standard_id) < 2 or len(set(args.gold_standard_id)) != len(args.gold_standard_id):
        raise RuntimeError("at least two unique gold-standard-id values are required")
    if any(not value or not value[0].isalnum() or any(character not in SAFE_ID_CHARS for character in value) for value in args.gold_standard_id):
        raise RuntimeError("gold-standard-id values must be safe lowercase IDs")
    if args.gold_id not in args.gold_standard_id:
        raise RuntimeError("gold-id must be included among gold-standard-id values")


def named_layer(psd: PSDImage, name: str):
    matches = [layer for layer in psd.descendants() if layer.name == name and not layer.is_group()]
    if len(matches) != 1:
        raise RuntimeError(f"expected exactly one layer named {name!r}, found {len(matches)}")
    return matches[0]


def full_layer_rgba(layer, size: tuple[int, int]) -> Image.Image:
    rendered = layer.composite()
    if rendered is None:
        raise RuntimeError(f"layer {layer.name!r} has no pixels")
    full = Image.new("RGBA", size, (0, 0, 0, 0))
    full.alpha_composite(rendered.convert("RGBA"), (layer.left, layer.top))
    return full


def normalized_bounds(mask: np.ndarray) -> dict[str, float]:
    ys, xs = np.where(mask)
    if not xs.size:
        raise RuntimeError("product mask is empty")
    height, width = mask.shape
    return {
        "left": float(xs.min() / width),
        "top": float(ys.min() / height),
        "width": float((xs.max() - xs.min() + 1) / width),
        "height": float((ys.max() - ys.min() + 1) / height),
    }


def box_matches(actual: dict[str, float], expected: dict[str, float]) -> bool:
    return all(abs(actual[key] - expected[key]) <= PRODUCT_BOX_TOLERANCE for key in actual)


def scale_coordinate(value: int, side: int) -> int:
    return math.floor(value * side / REFERENCE_SIDE + 0.5)


def scale_roi(roi: tuple[int, int, int, int], side: int) -> tuple[int, int, int, int]:
    x, y, width, height = roi
    left = scale_coordinate(x, side)
    top = scale_coordinate(y, side)
    right = min(side, scale_coordinate(x + width, side))
    bottom = min(side, scale_coordinate(y + height, side))
    if left < 0 or top < 0 or left >= side or top >= side or right <= left or bottom <= top:
        raise RuntimeError("ROI is empty after scaling and clipping")
    return left, top, right, bottom


def levels_plate(source: np.ndarray, roi: tuple[int, int, int, int], white: tuple[int, int, int]) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    left, top, right, bottom = scale_roi(roi, source.shape[1])
    output = np.full_like(source, 255)
    region = source[top:bottom, left:right].astype(np.float64)
    for channel, point in enumerate(white):
        region[..., channel] = np.minimum(255, np.floor(region[..., channel] * 255 / point + 0.5))
    output[top:bottom, left:right] = region.astype(np.uint8)
    return output, (left, top, right, bottom)


def scale_odd_size(value: int, side: int) -> int:
    scaled = max(1, scale_coordinate(value, side))
    return scaled if scaled % 2 else scaled + 1


def adaptive_white_sample(source: np.ndarray, mask: np.ndarray, roi: tuple[int, int, int, int]) -> dict[str, Any]:
    side = source.shape[1]
    left, top, right, bottom = scale_roi(roi, side)
    patch_size = scale_odd_size(ADAPTIVE_PATCH_SIZE, side)
    radius = patch_size // 2
    mask_distance_min = scale_coordinate(ADAPTIVE_MASK_DISTANCE, side)
    edge_distance_min = scale_coordinate(ADAPTIVE_EDGE_DISTANCE, side)
    product = mask > 0
    distances = ndi.distance_transform_edt(~product)
    yy, xx = np.indices(mask.shape)
    roi_edge_distance = np.minimum.reduce((
        xx - left,
        right - 1 - xx,
        yy - top,
        bottom - 1 - yy,
        xx,
        side - 1 - xx,
        yy,
        side - 1 - yy,
    ))
    channel_spread = source.max(axis=2) - source.min(axis=2)
    rgb_valid = np.all((source >= WHITE_MIN) & (source <= WHITE_MAX), axis=2) & (channel_spread <= WHITE_SPREAD_MAX)
    in_roi = (xx >= left) & (xx < right) & (yy >= top) & (yy < bottom)
    valid = in_roi & (mask == 0) & (distances >= mask_distance_min) & (roi_edge_distance >= edge_distance_min) & rgb_valid
    stable_counts = np.rint(ndi.uniform_filter(valid.astype(np.float64), size=patch_size, mode="constant", cval=0) * (patch_size * patch_size))
    candidates = np.argwhere(valid & (stable_counts / (patch_size * patch_size) >= ADAPTIVE_PATCH_PASS_RATE))
    if not candidates.size:
        raise RuntimeError("adaptive white-field sampling found no region passing distance, edge, RGB, and 31x31 stability gates")

    def score(point: np.ndarray) -> tuple[float, float, float, int, int]:
        y, x = (int(point[0]), int(point[1]))
        mean_distance = abs(float(source[y, x].mean()) - ADAPTIVE_TARGET_MEAN)
        return (-float(stable_counts[y, x]), -float(distances[y, x]), mean_distance, y, x)

    sample_y, sample_x = (int(value) for value in min(candidates, key=score))
    patch_valid = valid[sample_y - radius:sample_y + radius + 1, sample_x - radius:sample_x + radius + 1]
    patch_rgb = source[sample_y - radius:sample_y + radius + 1, sample_x - radius:sample_x + radius + 1][patch_valid]
    median = tuple(int(np.floor(value + 0.5)) for value in np.median(patch_rgb, axis=0))
    return {
        "point": (sample_x, sample_y),
        "pointRgb": tuple(int(value) for value in source[sample_y, sample_x]),
        "medianRgb": median,
        "patchPassRate": float(patch_valid.sum() / (patch_size * patch_size)),
        "maskDistance": float(distances[sample_y, sample_x]),
        "patchSize": patch_size,
        "validPixelCount": int(patch_valid.sum()),
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


def detached_residue_area(image: np.ndarray, mask: np.ndarray) -> int:
    residue = (mask == 0) & ((255 - image.min(axis=2)) >= RESIDUE_THRESHOLD)
    labels, count = ndi.label(residue, structure=np.ones((3, 3), dtype=np.uint8))
    if not count:
        return 0
    neighborhood = scale_coordinate(LEGAL_SHADOW_MASK_NEIGHBORHOOD, image.shape[1])
    distances = ndi.distance_transform_edt(mask == 0)
    largest = 0
    for label in range(1, count + 1):
        component = labels == label
        if not np.any(component & (distances <= neighborhood)):
            largest = max(largest, int(component.sum()))
    return largest


def purify_detached_background_residue(image: np.ndarray, mask: np.ndarray) -> tuple[np.ndarray, dict[str, int]]:
    """Whiten failing detached components without changing legal contact shadow."""
    purified = image.copy()
    residue = (mask == 0) & ((255 - purified.min(axis=2)) >= RESIDUE_THRESHOLD)
    labels, count = ndi.label(residue, structure=np.ones((3, 3), dtype=np.uint8))
    neighborhood = scale_coordinate(LEGAL_SHADOW_MASK_NEIGHBORHOOD, image.shape[1])
    distances = ndi.distance_transform_edt(mask == 0)
    component_count = 0
    pixel_count = 0
    for label in range(1, count + 1):
        component = labels == label
        area = int(component.sum())
        if area < DETACHED_RESIDUE_MIN_AREA or np.any(component & (distances <= neighborhood)):
            continue
        purified[component] = 255
        component_count += 1
        pixel_count += area
    return purified, {"purifiedComponentCount": component_count, "purifiedPixelCount": pixel_count}


def mask_agreement(candidate: np.ndarray, expected: np.ndarray) -> tuple[float, float]:
    candidate_binary = candidate >= 128
    expected_binary = expected >= 128
    union = np.logical_or(candidate_binary, expected_binary).sum()
    iou = float(np.logical_and(candidate_binary, expected_binary).sum() / max(1, union))
    candidate_edge = candidate_binary ^ ndi.binary_erosion(candidate_binary)
    expected_edge = expected_binary ^ ndi.binary_erosion(expected_binary)
    if not candidate_edge.any() or not expected_edge.any():
        return iou, float("inf")
    to_expected = ndi.distance_transform_edt(~expected_edge)[candidate_edge]
    to_candidate = ndi.distance_transform_edt(~candidate_edge)[expected_edge]
    return iou, float((to_expected.mean() + to_candidate.mean()) / 2)


def compose(source: np.ndarray, plate: np.ndarray, mask: np.ndarray) -> np.ndarray:
    alpha = mask.astype(np.float64) / 255
    return np.rint(source * alpha[..., None] + plate * (1 - alpha[..., None])).astype(np.uint8)


def write_comparison(source: Image.Image, photoshop: Image.Image, native: Image.Image, path: Path) -> None:
    width, height = source.size
    header = max(32, round(height * 0.06))
    sheet = Image.new("RGB", (width * 3, height + header), "white")
    sheet.paste(source.convert("RGB"), (0, header))
    sheet.paste(photoshop.convert("RGB"), (width, header))
    sheet.paste(native.convert("RGB"), (width * 2, header))
    draw = ImageDraw.Draw(sheet)
    draw.rectangle((0, 0, sheet.width, header), fill=(28, 28, 30))
    for index, label in enumerate(("V1 input", "Photoshop reference", "native candidate")):
        draw.text((index * width + 12, 10), label, fill="white")
    sheet.save(path)


def gate(passed: bool, **details: Any) -> dict[str, Any]:
    return {"passed": bool(passed), **details}


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate a non-publishing calibrated-shadow candidate")
    parser.add_argument("--v1", type=Path, required=True)
    parser.add_argument("--approved-psd", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--gold-id", required=True, help="ID of the approved PSD used for this calibration run")
    parser.add_argument("--gold-standard-id", action="append", required=True, help="Gold ID associated with this preset; repeat for every approved colour")
    parser.add_argument("--gold-product-box", type=parse_box, required=True, help="Associated gold box: left,top,width,height")
    parser.add_argument("--product-layer", required=True)
    parser.add_argument("--shadow-layer", required=True)
    parser.add_argument("--background-layer", required=True)
    parser.add_argument("--birefnet-mask", type=Path, required=True)
    parser.add_argument("--preset-version", required=True)
    parser.add_argument("--development-identity")
    parser.add_argument("--source-id", help="Exact source filename stem; required by adaptive candidates")
    parser.add_argument("--angle-slot", type=int, required=True)
    parser.add_argument("--angle-label", required=True)
    parser.add_argument("--roi", type=parse_rect, required=True)
    parser.add_argument("--white-point", type=lambda value: parse_pair(value, "white-point"))
    args = parser.parse_args()
    validate_reference_inputs(args)

    args.output_dir.mkdir(parents=True, exist_ok=False)
    source_image = Image.open(args.v1).convert("RGB")
    source = np.asarray(source_image)
    if source_image.width != source_image.height:
        raise RuntimeError("V1 input must be square")
    psd = PSDImage.open(args.approved_psd)
    if psd.size != source_image.size:
        raise RuntimeError("PSD and V1 dimensions do not match")

    product = full_layer_rgba(named_layer(psd, args.product_layer), psd.size)
    shadow = full_layer_rgba(named_layer(psd, args.shadow_layer), psd.size)
    background = full_layer_rgba(named_layer(psd, args.background_layer), psd.size)
    background_rgba = np.asarray(background)
    if background_rgba[..., 3].max() == 0:
        raise RuntimeError("mapped white-background layer is empty")
    background_rgb = np.asarray(background.convert("RGB"))
    visible_background = background_rgba[..., 3] > 0
    if not np.all(background_rgb[visible_background] == 255):
        raise RuntimeError("mapped white-background layer is not pure white")

    ps_mask = np.asarray(product)[..., 3]
    birefnet = np.asarray(Image.open(args.birefnet_mask).convert("L"))
    if birefnet.shape != ps_mask.shape:
        raise RuntimeError("BiRefNet mask dimensions do not match the PSD product layer")
    adaptive = args.preset_version in (ADAPTIVE_VERSION, DEVELOPMENT_IDENTITY)
    if adaptive:
        sample = adaptive_white_sample(source, birefnet, args.roi)
        sample_x, sample_y = sample["point"]
        sampled_point_rgb = sample["pointRgb"]
        sampled = sample["medianRgb"]
    else:
        sample_x = scale_coordinate(args.white_point[0], source_image.width)
        sample_y = scale_coordinate(args.white_point[1], source_image.height)
        if sample_x >= source_image.width or sample_y >= source_image.height:
            raise RuntimeError("white sample point is outside the source after scaling")
        sampled_point_rgb = tuple(int(value) for value in source[sample_y, sample_x])
        sampled = sampled_point_rgb
        sample = {
            "point": (sample_x, sample_y),
            "pointRgb": sampled_point_rgb,
            "medianRgb": sampled,
            "patchPassRate": 1.0,
            "maskDistance": 0.0,
            "patchSize": 1,
            "validPixelCount": 1,
        }

    white = Image.new("RGBA", psd.size, (255, 255, 255, 255))
    ps_shadow_image = white.copy()
    ps_shadow_image.alpha_composite(shadow)
    ps_preview = ps_shadow_image.copy()
    ps_preview.alpha_composite(product)
    ps_shadow = np.asarray(ps_shadow_image.convert("RGB"))
    native_shadow_before_purification, roi = levels_plate(source, args.roi, sampled)
    native_preview_before_purification = compose(source, native_shadow_before_purification, birefnet)
    native_shadow, purification = purify_detached_background_residue(native_shadow_before_purification, birefnet)
    native_preview = compose(source, native_shadow, birefnet)
    shadow_diff = np.abs(native_shadow.astype(np.int16) - ps_shadow.astype(np.int16))

    product_box = normalized_bounds(birefnet >= 128)
    iou, boundary = mask_agreement(birefnet, ps_mask)
    boundary_at_800 = boundary * REFERENCE_SIDE / source_image.width
    left, top, right, bottom = roi
    yy, xx = np.indices(birefnet.shape)
    outside = (birefnet == 0) & ((xx < left) | (xx >= right) | (yy < top) | (yy >= bottom))
    core = birefnet == 255
    boundary_jump = roi_boundary_jump(native_preview_before_purification, birefnet, roi)
    detached_area = detached_residue_area(native_preview, birefnet)
    gates: dict[str, dict[str, Any]] = {
        "whitePoint": gate(
            all(WHITE_MIN <= value <= WHITE_MAX for value in sampled) and max(sampled) - min(sampled) <= WHITE_SPREAD_MAX,
            point={"x": sample_x, "y": sample_y},
            pointRgb=sampled_point_rgb,
            medianRgb=sampled,
            patchPassRate=sample["patchPassRate"],
            maskDistance=sample["maskDistance"],
            patchSize=sample["patchSize"],
        ),
        "sampleOutsideMask": gate(
            bool(birefnet[sample_y, sample_x] == 0 and ps_mask[sample_y, sample_x] == 0),
            birefnetAlpha=int(birefnet[sample_y, sample_x]),
            photoshopAlpha=int(ps_mask[sample_y, sample_x]),
        ),
        "photoshopShadowParity": gate(float(shadow_diff.mean()) <= SHADOW_MEAN_ERROR_MAX and int(shadow_diff.max()) <= SHADOW_MAX_ERROR_MAX, meanChannelError=float(shadow_diff.mean()), maxChannelError=int(shadow_diff.max())),
        "birefnetMask": gate(iou >= MASK_IOU_MIN and boundary_at_800 <= BOUNDARY_MAX_AT_800, iou=iou, meanBoundaryDistancePxAt800=boundary_at_800),
        "productBox": gate(box_matches(product_box, args.gold_product_box), actual=product_box, associatedGold=args.gold_product_box, tolerance=PRODUCT_BOX_TOLERANCE),
        "opaqueProductCore": gate(bool(np.array_equal(native_preview[core], source[core]))),
        "outsideProductAndRoiWhite": gate(bool(np.all(native_preview[outside] == 255))),
    }
    if adaptive:
        gates["roiBoundary"] = gate(boundary_jump <= ROI_BOUNDARY_MAX_CHANNEL_JUMP, maxChannelJump=boundary_jump, limit=ROI_BOUNDARY_MAX_CHANNEL_JUMP)
        gates["detachedBackgroundResidue"] = gate(
            detached_area < DETACHED_RESIDUE_MIN_AREA,
            largestDetachedArea=detached_area,
            minimumFailingArea=DETACHED_RESIDUE_MIN_AREA,
        )
        gates["outputOpaqueRgb"] = gate(True, mode="RGB")

    product.save(args.output_dir / "product.png")
    Image.fromarray(ps_mask, "L").save(args.output_dir / "mask.png")
    ps_shadow_image.convert("RGB").save(args.output_dir / "shadow.png")
    ps_preview.convert("RGB").save(args.output_dir / "preview.png")
    Image.fromarray(native_shadow, "RGB").save(args.output_dir / "native-shadow.png")
    Image.fromarray(native_preview, "RGB").save(args.output_dir / "native-preview.png")
    source_image.save(args.output_dir / "input.png")
    Image.fromarray(np.clip(shadow_diff * 8, 0, 255).astype(np.uint8), "RGB").save(args.output_dir / "difference.png")
    write_comparison(source_image, ps_preview.convert("RGB"), Image.fromarray(native_preview, "RGB"), args.output_dir / "side-by-side.png")

    artifact_hashes = {
        path.name: digest(path)
        for path in sorted(args.output_dir.iterdir())
        if path.is_file()
    }

    report = {
        "schemaVersion": 2,
        "releaseState": "awaiting-human-approval",
        "approved": False,
        "publicationAllowed": False,
        "sourceId": args.source_id or args.v1.stem,
        "goldId": args.gold_id,
        "presetVersion": args.preset_version,
        "developmentIdentity": args.development_identity,
        "angleSlot": args.angle_slot,
        "humanAngleLabel": args.angle_label,
        "goldStandardIds": args.gold_standard_id,
        "whiteSamplePolicy": {
            "referencePatchSize": ADAPTIVE_PATCH_SIZE,
            "minimumPatchPassRate": ADAPTIVE_PATCH_PASS_RATE,
            "minimumMaskDistance": ADAPTIVE_MASK_DISTANCE,
            "minimumEdgeDistance": ADAPTIVE_EDGE_DISTANCE,
            "rgbMin": WHITE_MIN,
            "rgbMax": WHITE_MAX,
            "maxChannelSpread": WHITE_SPREAD_MAX,
            "targetMean": ADAPTIVE_TARGET_MEAN,
            "selectionOrder": ["patch-pass-rate-desc", "mask-distance-desc", "mean-distance-to-240-asc", "y-asc", "x-asc"],
            "median": "per-channel-median-of-valid-patch-pixels",
        } if adaptive else None,
        "v1": {"path": str(args.v1), "sha256": digest(args.v1)},
        "approvedPsd": {"path": str(args.approved_psd), "sha256": digest(args.approved_psd)},
        "birefnetMask": {"path": str(args.birefnet_mask), "sha256": digest(args.birefnet_mask)},
        "layerNames": {"product": args.product_layer, "shadow": args.shadow_layer, "background": args.background_layer},
        "referenceCanvas": {"width": REFERENCE_SIDE, "height": REFERENCE_SIDE},
        "roi": dict(zip(("x", "y", "width", "height"), args.roi, strict=True)),
        "sampledPoint": {"x": sample_x, "y": sample_y},
        "sampledPointRgb": sampled_point_rgb,
        "sampledRgb": sampled,
        "samplePatchPassRate": sample["patchPassRate"],
        "sampleMaskDistance": sample["maskDistance"],
        "samplePatchSize": sample["patchSize"],
        "backgroundPurification": {
            "algorithm": "detached-residue-to-white-v1",
            "residueThreshold": RESIDUE_THRESHOLD,
            "minimumArea": DETACHED_RESIDUE_MIN_AREA,
            "legalShadowMaskNeighborhoodAt800": LEGAL_SHADOW_MASK_NEIGHBORHOOD,
            "connectivity": 8,
            **purification,
        },
        "productBox": product_box,
        "automaticGates": gates,
        "automaticGatesPassed": all(bool(item["passed"]) for item in gates.values()),
        "artifactSha256": artifact_hashes,
    }
    (args.output_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    candidate = {
        "id": f"hat-angle-slot-{args.angle_slot}",
        "angleSlot": args.angle_slot,
        "humanAngleLabel": args.angle_label,
        "approved": False,
        "goldStandardIds": args.gold_standard_id,
        "roi": report["roi"],
        "releaseState": "awaiting-human-approval",
        "publicationAllowed": False,
    }
    if adaptive:
        candidate["whiteSamplePolicy"] = {
            "referencePatchSize": ADAPTIVE_PATCH_SIZE,
            "minimumPatchPassRate": ADAPTIVE_PATCH_PASS_RATE,
            "minimumMaskDistance": ADAPTIVE_MASK_DISTANCE,
            "minimumEdgeDistance": ADAPTIVE_EDGE_DISTANCE,
            "rgbMin": WHITE_MIN,
            "rgbMax": WHITE_MAX,
            "maxChannelSpread": WHITE_SPREAD_MAX,
            "targetMean": ADAPTIVE_TARGET_MEAN,
            "selectionOrder": ["patch-pass-rate-desc", "mask-distance-desc", "mean-distance-to-240-asc", "y-asc", "x-asc"],
            "median": "per-channel-median-of-valid-patch-pixels",
        }
    else:
        candidate["whitePoint"] = {"x": args.white_point[0], "y": args.white_point[1]}
    (args.output_dir / "candidate-preset.json").write_text(json.dumps(candidate, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"outputDir": str(args.output_dir), "releaseState": "awaiting-human-approval", "gatesPassed": report["automaticGatesPassed"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
