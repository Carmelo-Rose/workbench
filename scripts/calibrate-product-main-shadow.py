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
    parser.add_argument("--angle-slot", type=int, required=True)
    parser.add_argument("--angle-label", required=True)
    parser.add_argument("--roi", type=parse_rect, required=True)
    parser.add_argument("--white-point", type=lambda value: parse_pair(value, "white-point"), required=True)
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
    sample_x = scale_coordinate(args.white_point[0], source_image.width)
    sample_y = scale_coordinate(args.white_point[1], source_image.height)
    if sample_x >= source_image.width or sample_y >= source_image.height:
        raise RuntimeError("white sample point is outside the source after scaling")
    sampled = tuple(int(value) for value in source[sample_y, sample_x])

    white = Image.new("RGBA", psd.size, (255, 255, 255, 255))
    ps_shadow_image = white.copy()
    ps_shadow_image.alpha_composite(shadow)
    ps_preview = ps_shadow_image.copy()
    ps_preview.alpha_composite(product)
    ps_shadow = np.asarray(ps_shadow_image.convert("RGB"))
    native_shadow, roi = levels_plate(source, args.roi, sampled)
    native_preview = compose(source, native_shadow, birefnet)
    shadow_diff = np.abs(native_shadow.astype(np.int16) - ps_shadow.astype(np.int16))

    product_box = normalized_bounds(birefnet >= 128)
    iou, boundary = mask_agreement(birefnet, ps_mask)
    boundary_at_800 = boundary * REFERENCE_SIDE / source_image.width
    left, top, right, bottom = roi
    yy, xx = np.indices(birefnet.shape)
    outside = (birefnet == 0) & ((xx < left) | (xx >= right) | (yy < top) | (yy >= bottom))
    core = birefnet == 255
    gates: dict[str, dict[str, Any]] = {
        "whitePoint": gate(all(WHITE_MIN <= value <= WHITE_MAX for value in sampled) and max(sampled) - min(sampled) <= WHITE_SPREAD_MAX, rgb=sampled),
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

    product.save(args.output_dir / "product.png")
    Image.fromarray(ps_mask, "L").save(args.output_dir / "mask.png")
    ps_shadow_image.convert("RGB").save(args.output_dir / "shadow.png")
    ps_preview.convert("RGB").save(args.output_dir / "preview.png")
    Image.fromarray(native_shadow, "RGB").save(args.output_dir / "native-shadow.png")
    Image.fromarray(native_preview, "RGB").save(args.output_dir / "native-preview.png")
    source_image.save(args.output_dir / "input.png")
    Image.fromarray(np.clip(shadow_diff * 8, 0, 255).astype(np.uint8), "RGB").save(args.output_dir / "difference.png")
    write_comparison(source_image, ps_preview.convert("RGB"), Image.fromarray(native_preview, "RGB"), args.output_dir / "side-by-side.png")

    report = {
        "schemaVersion": 2,
        "releaseState": "awaiting-human-approval",
        "approved": False,
        "publicationAllowed": False,
        "goldId": args.gold_id,
        "presetVersion": args.preset_version,
        "angleSlot": args.angle_slot,
        "humanAngleLabel": args.angle_label,
        "v1": {"path": str(args.v1), "sha256": digest(args.v1)},
        "approvedPsd": {"path": str(args.approved_psd), "sha256": digest(args.approved_psd)},
        "birefnetMask": {"path": str(args.birefnet_mask), "sha256": digest(args.birefnet_mask)},
        "layerNames": {"product": args.product_layer, "shadow": args.shadow_layer, "background": args.background_layer},
        "referenceCanvas": {"width": REFERENCE_SIDE, "height": REFERENCE_SIDE},
        "roi": dict(zip(("x", "y", "width", "height"), args.roi, strict=True)),
        "whitePoint": {"x": args.white_point[0], "y": args.white_point[1]},
        "sampledRgb": sampled,
        "productBox": product_box,
        "automaticGates": gates,
        "automaticGatesPassed": all(bool(item["passed"]) for item in gates.values()),
    }
    (args.output_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    candidate = {
        "id": f"hat-angle-slot-{args.angle_slot}",
        "angleSlot": args.angle_slot,
        "humanAngleLabel": args.angle_label,
        "approved": False,
        "goldStandardIds": args.gold_standard_id,
        "roi": report["roi"],
        "whitePoint": report["whitePoint"],
        "releaseState": "awaiting-human-approval",
        "publicationAllowed": False,
    }
    (args.output_dir / "candidate-preset.json").write_text(json.dumps(candidate, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"outputDir": str(args.output_dir), "releaseState": "awaiting-human-approval", "gatesPassed": report["automaticGatesPassed"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
