"""Deterministic FBA matting and white-plate nodes for ComfyUI.

This module deliberately does not call a diffusion model.  It takes a coarse
foreground mask, runs the official FBA Matting network, tightens the alpha
matte, and composites the estimated foreground over white.  The optional
contact-shadow node is source analysis only; it never paints a synthetic
product shadow around the silhouette.
"""

from __future__ import annotations

import os
import sys
import threading
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import torch


_MODEL_CACHE: dict[tuple[str, str], torch.nn.Module] = {}
_MODEL_LOCK = threading.Lock()

_DEFAULT_FBA_ROOT = os.environ.get(
    "FBA_MATTING_ROOT",
    r"D:\hyk_sort\prod-data\comfyui-neo\fba-test",
)
_DEFAULT_FBA_WEIGHTS = os.environ.get(
    "FBA_MATTING_WEIGHTS",
    str(Path(_DEFAULT_FBA_ROOT) / "FBA.pth"),
)


def _device_name(value: str) -> str:
    if value.startswith("cuda") and torch.cuda.is_available():
        return value
    if value.startswith("cuda"):
        raise RuntimeError("FBA Matting requested CUDA, but CUDA is not available")
    return "cpu"


def _load_model(weights_path: str, device_name: str) -> tuple[torch.nn.Module, torch.device]:
    weights = str(Path(weights_path).resolve())
    if not Path(weights).is_file():
        raise FileNotFoundError(f"FBA weights not found: {weights}")
    device = torch.device(_device_name(device_name))
    key = (weights, str(device))
    with _MODEL_LOCK:
        model = _MODEL_CACHE.get(key)
        if model is None:
            root = str(Path(weights).parent)
            if root not in sys.path:
                sys.path.insert(0, root)
            from networks.models import build_model  # type: ignore[import-not-found]

            model = build_model(weights)
            model.eval().to(device)
            _MODEL_CACHE[key] = model
    return model, device


def _scaled_size(height: int, width: int, max_side: int) -> tuple[int, int]:
    scale = min(1.0, float(max_side) / max(height, width))
    target_h = max(8, int(np.ceil(height * scale / 8.0) * 8))
    target_w = max(8, int(np.ceil(width * scale / 8.0) * 8))
    return target_h, target_w


def _as_image_array(image: torch.Tensor) -> np.ndarray:
    array = image.detach().cpu().numpy().astype(np.float32, copy=False)
    return np.clip(array, 0.0, 1.0)


def _as_mask_array(mask: torch.Tensor) -> np.ndarray:
    array = mask.detach().cpu().numpy().astype(np.float32, copy=False)
    if array.ndim == 3:
        return np.clip(array, 0.0, 1.0)
    if array.ndim == 4 and array.shape[-1] == 1:
        return np.clip(array[..., 0], 0.0, 1.0)
    raise ValueError(f"expected MASK [batch,height,width], got {array.shape}")


def _make_trimap(mask: np.ndarray, erode: int, dilate: int) -> np.ndarray:
    """Convert a soft coarse mask into FBA's two-channel trimap."""

    binary = mask >= 0.5
    foreground = binary
    background = ~binary
    if erode > 0:
        size = erode * 2 + 1
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))
        foreground = cv2.erode(foreground.astype(np.uint8), kernel) > 0
    if dilate > 0:
        size = dilate * 2 + 1
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))
        background = cv2.erode((~binary).astype(np.uint8), kernel) > 0

    trimap = np.zeros((*mask.shape, 2), dtype=np.float32)
    trimap[:, :, 0] = background.astype(np.float32)
    trimap[:, :, 1] = foreground.astype(np.float32)
    # The two known regions must never overlap, even when a tiny object is
    # smaller than the requested trimap margins.
    trimap[foreground, 0] = 0.0
    return trimap


def _fba_predict(
    image: np.ndarray,
    mask: np.ndarray,
    model: torch.nn.Module,
    device: torch.device,
    trimap_erode: int,
    trimap_dilate: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    height, width = mask.shape
    trimap = _make_trimap(mask, trimap_erode, trimap_dilate)
    image_tensor = torch.from_numpy(np.ascontiguousarray(image)).permute(2, 0, 1)[None].float().to(device)
    trimap_tensor = torch.from_numpy(np.ascontiguousarray(trimap)).permute(2, 0, 1)[None].float().to(device)

    from networks.transforms import trimap_transform  # type: ignore[import-not-found]

    clicks = trimap_transform(trimap)
    clicks_tensor = torch.from_numpy(np.ascontiguousarray(clicks))[None].float().to(device)
    mean = torch.tensor((0.485, 0.456, 0.406), device=device).view(1, 3, 1, 1)
    std = torch.tensor((0.229, 0.224, 0.225), device=device).view(1, 3, 1, 1)
    normalized = (image_tensor - mean) / std

    with torch.inference_mode():
        output = model(image_tensor, trimap_tensor, normalized, clicks_tensor)
        output_np = output[0].detach().float().cpu().numpy().transpose(1, 2, 0)

    output_np = cv2.resize(output_np, (width, height), interpolation=cv2.INTER_LANCZOS4)
    alpha = np.clip(output_np[:, :, 0], 0.0, 1.0)
    foreground = np.clip(output_np[:, :, 1:4], 0.0, 1.0)
    background = np.clip(output_np[:, :, 4:7], 0.0, 1.0)
    alpha[trimap[:, :, 0] == 1] = 0.0
    alpha[trimap[:, :, 1] == 1] = 1.0
    foreground[alpha >= 1.0] = image[alpha >= 1.0]
    background[alpha <= 0.0] = image[alpha <= 0.0]
    return foreground, alpha, background


def _clean_alpha(mask: np.ndarray, threshold: float, erode: int, soften: float) -> np.ndarray:
    hard = (mask >= threshold).astype(np.uint8) * 255
    if erode > 0:
        size = erode * 2 + 1
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))
        hard = cv2.erode(hard, kernel)
    if soften > 0:
        hard = cv2.GaussianBlur(hard, (0, 0), soften)
    return np.clip(hard.astype(np.float32) / 255.0, 0.0, 1.0)


def _remove_gray_background_components(
    color_cue: np.ndarray,
    alpha: np.ndarray,
    coarse_alpha: np.ndarray | None,
    source: np.ndarray | None,
    luma_min: float,
    saturation_max: float,
    min_area: int,
    large_area: int,
    boundary_radius: int,
) -> tuple[np.ndarray, np.ndarray]:
    """Remove connected gray background islands without touching the product core.

    The FBA foreground is used as a deterministic color cue.  Fully opaque
    product details are protected regardless of their size.  A large enclosed
    component is removed only when the original source agrees with the four
    sampled corner-background chroma values and is locally smooth.  A separate
    smooth gray spur connected to the outside alpha boundary is still removed;
    that is the 8218 regression case.  Source texture/gradient is deliberately
    used as a protection signal so dark woven product fabric is not mistaken
    for a neutral studio background.
    """

    clipped_source = np.clip(color_cue, 0.0, 1.0)
    maximum = np.max(clipped_source, axis=2)
    minimum = np.min(clipped_source, axis=2)
    saturation = (maximum - minimum) / np.maximum(maximum, 1e-6)
    luminance = (
        0.2126 * clipped_source[:, :, 0]
        + 0.7152 * clipped_source[:, :, 1]
        + 0.0722 * clipped_source[:, :, 2]
    )
    # Keep the public luma cutoff for edge cleanup.  A second, lower cutoff is
    # used only for the large-enclosed-hole pass below; applying it to the
    # boundary rule would mistake antialiased dark product edges for gray
    # background and create a jagged contour.
    gray_luma_floor = max(0.12, min(0.50, float(luma_min) * 0.25))
    candidate = (
        (alpha > 0.02)
        & (luminance >= float(luma_min))
        & (saturation <= float(saturation_max))
    )
    gray_candidate = (
        (alpha > 0.02)
        & (luminance >= gray_luma_floor)
        & (saturation <= float(saturation_max))
    )
    if not np.any(candidate) and not np.any(gray_candidate):
        return np.clip(alpha, 0.0, 1.0), np.zeros(alpha.shape, dtype=np.float32)

    # FBA_Matting already returns the resized original image as `source`.  Use
    # it as the only background-color reference: no fixed gray RGB range is
    # used here.  The L channel is intentionally ignored for the color match
    # because a studio background can have a smooth shadow/gradient, while its
    # neutral chroma remains stable.  Texture and gradient then separate that
    # smooth background from dark woven fabric and hardware.
    if source is None:
        source_image = clipped_source
    elif source.shape != alpha.shape + (3,):
        source_image = cv2.resize(
            np.clip(source, 0.0, 1.0).astype(np.float32),
            (alpha.shape[1], alpha.shape[0]),
            interpolation=cv2.INTER_LANCZOS4,
        )
    else:
        source_image = np.clip(source, 0.0, 1.0).astype(np.float32, copy=False)
    source_luma = (
        0.2126 * source_image[:, :, 0]
        + 0.7152 * source_image[:, :, 1]
        + 0.0722 * source_image[:, :, 2]
    )
    source_gradient_x = cv2.Sobel(source_luma, cv2.CV_32F, 1, 0, ksize=3)
    source_gradient_y = cv2.Sobel(source_luma, cv2.CV_32F, 0, 1, ksize=3)
    source_gradient = np.sqrt(source_gradient_x * source_gradient_x + source_gradient_y * source_gradient_y)
    source_blur = cv2.GaussianBlur(source_image, (0, 0), 2.0)
    source_texture = np.mean(np.abs(source_image - source_blur), axis=2)
    source_lab = cv2.cvtColor(
        np.clip(source_image * 255.0, 0.0, 255.0).astype(np.uint8),
        cv2.COLOR_RGB2LAB,
    ).astype(np.float32)
    height, width = alpha.shape
    corner_size = max(16, int(round(min(height, width) * 0.08)))
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
    chroma_distances = np.stack(
        [
            np.linalg.norm(source_lab[:, :, 1:] - sample[None, None, 1:], axis=2)
            for sample in corner_samples
        ],
        axis=0,
    )
    chroma_distance = np.min(chroma_distances, axis=0)
    full_lab_distances = np.stack(
        [
            np.linalg.norm(source_lab - sample[None, None, :], axis=2)
            for sample in corner_samples
        ],
        axis=0,
    )
    full_lab_distance = np.min(full_lab_distances, axis=0)
    corner_chroma_spread = float(
        np.max(
            np.linalg.norm(
                corner_samples[:, None, 1:] - corner_samples[None, :, 1:],
                axis=2,
            )
        )
    )
    # The lower bound handles ordinary JPEG/camera noise.  The upper bound is
    # deliberately conservative: it keeps a dark purple fabric (the 8235
    # adjustment band) outside the neutral sampled-background class.
    chroma_threshold = float(np.clip(max(4.0, corner_chroma_spread * 1.5 + 1.5), 4.0, 6.0))
    corner_texture_values = np.concatenate([
        source_texture[:corner_size, :corner_size].reshape(-1),
        source_texture[:corner_size, -corner_size:].reshape(-1),
        source_texture[-corner_size:, :corner_size].reshape(-1),
        source_texture[-corner_size:, -corner_size:].reshape(-1),
    ])
    corner_gradient_values = np.concatenate([
        source_gradient[:corner_size, :corner_size].reshape(-1),
        source_gradient[:corner_size, -corner_size:].reshape(-1),
        source_gradient[-corner_size:, :corner_size].reshape(-1),
        source_gradient[-corner_size:, -corner_size:].reshape(-1),
    ])
    texture_threshold = float(
        np.clip(np.quantile(corner_texture_values, 0.99) * 1.05, 0.012, 0.020)
    )
    gradient_threshold = float(
        np.clip(np.quantile(corner_gradient_values, 0.99) * 1.15, 0.10, 0.16)
    )
    sampled_background = (
        (chroma_distance <= chroma_threshold)
        & (source_texture <= texture_threshold)
        & (source_gradient <= gradient_threshold)
    )
    # Keep the enclosed-hole expansion permissive for a photographed gray
    # gradient: its luminance gradient can be much stronger than the four
    # corners even though its chroma and texture still match the background.
    # The relaxed branch is still gated by both source texture and gradient;
    # the low-texture escape is only for a smooth studio gradient.  Purple
    # woven fabric remains outside through chroma/texture and the transition
    # protection below.
    smooth_background = (
        (chroma_distance <= chroma_threshold)
        & (source_texture <= max(texture_threshold, 0.022))
        & (
            (source_gradient <= max(gradient_threshold * 2.0, 0.16))
            | (source_texture <= texture_threshold * 0.75)
        )
    )

    hard = alpha >= 0.5
    if coarse_alpha is None:
        coarse = np.zeros(alpha.shape, dtype=np.float32)
    elif coarse_alpha.shape != alpha.shape:
        coarse = cv2.resize(
            np.clip(coarse_alpha, 0.0, 1.0).astype(np.float32),
            (alpha.shape[1], alpha.shape[0]),
            interpolation=cv2.INTER_LINEAR,
        )
    else:
        coarse = np.clip(coarse_alpha, 0.0, 1.0).astype(np.float32, copy=False)
    coarse_support = coarse >= 0.5
    # Use the sampled/background-like pixels to set the L-inclusive distance
    # cutoff for an enclosed hole.  The 75th percentile is data-derived per
    # image: it follows a smooth studio gradient but rejects a darker product
    # strap whose full color distance is outside that distribution.
    full_lab_threshold = float("inf")
    sampled_distances = full_lab_distance[sampled_background & (alpha > 0.02)]
    if sampled_distances.size >= 64:
        full_lab_threshold = float(np.quantile(sampled_distances, 0.75))
        sampled_background &= full_lab_distance <= full_lab_threshold
    radius = max(1, int(boundary_radius))
    boundary_kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (radius * 2 + 1, radius * 2 + 1)
    )
    outside_near = cv2.dilate((~hard).astype(np.uint8), boundary_kernel) > 0
    count, labels, stats, _ = cv2.connectedComponentsWithStats(candidate.astype(np.uint8), 8)
    remove_external = np.zeros(alpha.shape, dtype=bool)
    for label in range(1, count):
        area = int(stats[label, cv2.CC_STAT_AREA])
        if area < max(1, int(min_area)):
            continue
        component = labels == label
        mean_alpha = float(np.mean(alpha[component]))
        mean_coarse = float(np.mean(coarse[component]))
        boundary_connected = bool(np.any(component & outside_near))
        # A bright, low-saturation logo can be large (the 8218 embroidery is a
        # concrete example), so area alone must never be a removal criterion.
        # Fully opaque components are treated as product detail and protected.
        # Keep a little tolerance for antialiased embroidery and hardware.
        opaque_detail = mean_alpha >= 0.98
        unsupported = component & ~coarse_support
        # A bright candidate may be removed at this stage only when it is
        # actually connected to the outside.  An enclosed component must pass
        # the sampled-source test below; `not coarse_product_detail` alone is
        # not enough because the rear adjustment band is inside the product.
        if boundary_connected and not opaque_detail:
            # FBA can hallucinate a bright trimap fringe outside the original
            # RmBG subject mask.  A semi-transparent component that reaches the
            # alpha boundary is also contamination even when most of it sits
            # inside the coarse mask.  Opaque logo/buckle details remain intact.
            remove_external |= component
        elif np.any(unsupported) and boundary_connected:
            remove_external |= unsupported

    # Rear views can contain a large gray opening that RmBG has filled as
    # foreground.  This is the only enclosed-component deletion path: it must
    # be fully enclosed and match the original four-corner background chroma,
    # texture, and gradient.  A dark fabric band therefore remains protected.
    large_gray_area = max(8192, int(large_area) * 12)
    enclosed_candidate = gray_candidate & sampled_background
    gray_count, gray_labels, gray_stats, _ = cv2.connectedComponentsWithStats(
        enclosed_candidate.astype(np.uint8), 8
    )
    remove_enclosed = np.zeros(alpha.shape, dtype=bool)
    for label in range(1, gray_count):
        area = int(gray_stats[label, cv2.CC_STAT_AREA])
        if area < large_gray_area:
            continue
        component = gray_labels == label
        if np.any(component & outside_near):
            continue
        remove_enclosed |= component

    # The lower part of a photographed opening can be much darker than the
    # corner samples, so it may fail the L-inclusive seed test even though it
    # is the same smooth neutral background.  Grow only into the original
    # smooth/background-like component that overlaps the confirmed seed; the
    # later product guard keeps the textured adjustment band out.
    extension_candidate = gray_candidate & smooth_background
    extension_count, extension_labels, extension_stats, _ = cv2.connectedComponentsWithStats(
        extension_candidate.astype(np.uint8), 8
    )
    seed_area = max(256, int(large_gray_area * 0.05))
    transition_protect = np.zeros(alpha.shape, dtype=bool)
    transition_guard = np.zeros(alpha.shape, dtype=bool)
    for label in range(1, extension_count):
        area = int(extension_stats[label, cv2.CC_STAT_AREA])
        if area < large_gray_area:
            continue
        component = extension_labels == label
        if np.any(component & outside_near):
            continue
        overlap = int(np.count_nonzero(component & remove_enclosed))
        if overlap >= seed_area:
            remove_enclosed |= component
            ys, xs = np.where(component)
            x0, x1 = int(xs.min()), int(xs.max()) + 1
            y0, y1 = int(ys.min()), int(ys.max()) + 1
            profile = np.mean(np.abs(source_gradient_y[y0:y1, x0:x1]), axis=1)
            search_start = min(profile.size - 1, max(0, int(round(profile.size * 0.45))))
            transition_y = y0 + search_start + int(np.argmax(profile[search_start:]))
            transition_margin = max(4, int(boundary_radius) * 9)
            transition_guard[
                max(0, transition_y - transition_margin):y1,
                x0:x1,
            ] = True
            transition_features = (
                (chroma_distance > chroma_threshold)
                | (source_texture > max(texture_threshold, 0.022))
                | (source_gradient > max(gradient_threshold * 2.0, 0.16))
            )
            transition_protect |= component & (
                np.indices(alpha.shape)[0] >= transition_y - transition_margin
            ) & transition_features

    # The feature gate intentionally selects smooth pixels, so JPEG/FBA
    # speckle can leave pinholes inside an otherwise confirmed background
    # region.  Fill only holes inside the confirmed enclosed region; the
    # product-protection pass below still has the final say on textured pixels.
    if np.any(remove_enclosed):
        enclosed_flood = remove_enclosed.astype(np.uint8)
        flood_mask = np.zeros((height + 2, width + 2), dtype=np.uint8)
        cv2.floodFill(enclosed_flood, flood_mask, (0, 0), 255)
        remove_enclosed |= enclosed_flood == 0
        contour_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11))
        contour_source = cv2.morphologyEx(
            remove_enclosed.astype(np.uint8), cv2.MORPH_CLOSE, contour_kernel
        )
        contours, _ = cv2.findContours(
            contour_source, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        contour_fill = np.zeros(alpha.shape, dtype=np.uint8)
        for contour in contours:
            if cv2.contourArea(contour) >= float(max(1024, large_gray_area // 2)):
                cv2.drawContours(contour_fill, [contour], -1, 255, thickness=cv2.FILLED)
        remove_enclosed |= contour_fill > 0

    # A floor/shadow spur can be attached to the hard alpha boundary rather
    # than enclosed inside it.  Require all of the following so this branch
    # does not eat dark product fabric: it must be a sizeable component, have
    # gray mid-tone color, and be locally smooth.  The 8218 rear spur is the
    # reference case; 8212's dark seams are both smaller and more textured.
    boundary_gray_area = max(2048, int(large_area) * 3)
    gradient_x = cv2.Sobel(luminance, cv2.CV_32F, 1, 0, ksize=3)
    gradient_y = cv2.Sobel(luminance, cv2.CV_32F, 0, 1, ksize=3)
    gradient = np.sqrt(gradient_x * gradient_x + gradient_y * gradient_y)
    gray_count, gray_labels, gray_stats, _ = cv2.connectedComponentsWithStats(
        gray_candidate.astype(np.uint8), 8
    )
    for label in range(1, gray_count):
        area = int(gray_stats[label, cv2.CC_STAT_AREA])
        if area < boundary_gray_area:
            continue
        component = gray_labels == label
        if not np.any(component & outside_near):
            continue
        mean_luma = float(np.mean(luminance[component]))
        mean_saturation = float(np.mean(saturation[component]))
        mean_gradient = float(np.mean(gradient[component]))
        mean_source_texture = float(np.mean(source_texture[component]))
        mean_source_gradient = float(np.mean(source_gradient[component]))
        if (
            mean_luma <= min(0.50, float(luma_min) * 0.75)
            and mean_saturation <= float(saturation_max) * 0.90
            and mean_gradient <= 0.12
            and mean_source_texture <= texture_threshold
            and mean_source_gradient <= gradient_threshold
        ):
            remove_external |= component

    remove = remove_external | remove_enclosed
    if np.any(remove):
        close_radius = max(2, min(5, int(boundary_radius)))
        remove_kernel = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, (close_radius * 2 + 1, close_radius * 2 + 1)
        )
        # Close the deletion mask as the final morphology operation, then
        # restore textured/strong-gradient pixels from the enclosed branch.
        # This prevents the clean-up itself from eroding a real product edge.
        remove = cv2.morphologyEx(remove.astype(np.uint8), cv2.MORPH_CLOSE, remove_kernel) > 0
        # Do not protect every high-frequency pixel in the studio gradient:
        # that would re-introduce the exact white-background speckle this
        # branch is meant to remove.  Protect product-like pixels only when
        # they are also outside the source-background Lab distribution or
        # outside the public FBA saturation class.
        protect_product = hard & (
            (chroma_distance > chroma_threshold)
            & (full_lab_distance > full_lab_threshold)
            & (
                (saturation > float(saturation_max))
                | (source_texture > texture_threshold)
                | (source_gradient > max(0.14, gradient_threshold * 1.40))
            )
        )
        enclosed_neighborhood = cv2.dilate(remove_enclosed.astype(np.uint8), remove_kernel) > 0
        remove[protect_product & enclosed_neighborhood] = False
        remove[transition_protect & enclosed_neighborhood] = False
        remove[transition_guard & enclosed_neighborhood] = False
    cleaned = np.clip(alpha, 0.0, 1.0).copy()
    cleaned[remove] = 0.0
    return cleaned, remove.astype(np.float32)


def _refill_edge_color(
    foreground: np.ndarray,
    alpha: np.ndarray,
    edge_px: int,
    strength: float,
) -> tuple[np.ndarray, np.ndarray]:
    """Replace contaminated edge colors with a sample taken inward from FBA fg."""

    radius = max(0, int(edge_px))
    if radius == 0 or not np.any(alpha > 0.02):
        return np.clip(foreground, 0.0, 1.0), np.zeros(alpha.shape, dtype=np.float32)

    hard = (alpha >= 0.5).astype(np.uint8)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius * 2 + 1, radius * 2 + 1))
    outer = cv2.dilate(hard, kernel) > 0
    core = cv2.erode(hard, kernel) > 0
    edge_band = outer & ~core & (alpha > 0.01)
    if not np.any(edge_band):
        return np.clip(foreground, 0.0, 1.0), np.zeros(alpha.shape, dtype=np.float32)

    smooth_alpha = cv2.GaussianBlur(alpha.astype(np.float32), (0, 0), 1.0)
    gradient_x = cv2.Sobel(smooth_alpha, cv2.CV_32F, 1, 0, ksize=3)
    gradient_y = cv2.Sobel(smooth_alpha, cv2.CV_32F, 0, 1, ksize=3)
    norm = np.sqrt(gradient_x * gradient_x + gradient_y * gradient_y)
    direction_x = gradient_x / np.maximum(norm, 1e-5)
    direction_y = gradient_y / np.maximum(norm, 1e-5)
    height, width = alpha.shape
    grid_x, grid_y = np.meshgrid(
        np.arange(width, dtype=np.float32),
        np.arange(height, dtype=np.float32),
    )
    sample_distance = max(1.0, float(radius) * 0.85)
    sample_x = grid_x + direction_x * sample_distance
    sample_y = grid_y + direction_y * sample_distance
    sampled = np.empty_like(foreground, dtype=np.float32)
    for channel in range(3):
        sampled[:, :, channel] = cv2.remap(
            foreground[:, :, channel].astype(np.float32),
            sample_x,
            sample_y,
            cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REPLICATE,
        )
    # `strength=1` is an explicit decontamination request: even an opaque
    # edge pixel may still carry the warm FBA estimate, so the inward sample
    # must dominate across the whole requested refill band.  Keep a little
    # antialiasing slack for partial-alpha pixels, but do not cap opaque
    # pixels at the old 35% blend.
    edge_weight = np.full(alpha.shape, float(np.clip(strength, 0.0, 1.0)), dtype=np.float32)
    edge_weight *= edge_band.astype(np.float32)
    result = foreground * (1.0 - edge_weight[:, :, None]) + sampled * edge_weight[:, :, None]
    return np.clip(result, 0.0, 1.0), np.repeat(edge_weight[:, :, None], 3, axis=2)


def _bottom_contact_shadow(
    alpha: np.ndarray,
    band_px: int,
    width_scale: float,
    height_scale: float,
    offset_px: float,
    blur: float,
) -> np.ndarray:
    """Build a soft ground ellipse from the product's lowest alpha rows."""

    hard = alpha >= 0.5
    if not np.any(hard):
        return np.zeros(alpha.shape, dtype=np.float32)
    height, width = alpha.shape
    ys, _ = np.where(hard)
    bottom = int(ys.max())
    band = max(1, int(band_px))
    rows = np.arange(height, dtype=np.float32)[:, None]
    bottom_line = np.full(width, -1.0, dtype=np.float32)
    for x in range(width):
        values = np.where(hard[:, x])[0]
        if values.size:
            bottom_line[x] = float(values[-1])
    contact = hard & (rows >= (bottom_line[None, :] - float(band)))
    contact_x = np.where(np.any(contact, axis=0))[0]
    if contact_x.size == 0:
        contact_x = np.where(np.any(hard, axis=0))[0]
    if contact_x.size == 0:
        return np.zeros(alpha.shape, dtype=np.float32)

    x0, x1 = int(contact_x.min()), int(contact_x.max())
    center_x = 0.5 * (x0 + x1)
    footprint_width = max(16.0, float(x1 - x0 + 1))
    product_height = max(16.0, float(bottom - np.where(hard)[0].min() + 1))
    radius_x = max(8.0, 0.5 * footprint_width * max(0.5, float(width_scale)))
    radius_y = max(6.0, product_height * max(0.02, float(height_scale)))
    # Put the ellipse centre on the lowest foreground row.  Its upper half is
    # then hidden by the product, leaving a soft shadow that visibly touches it
    # instead of floating below it.
    center_y = float(bottom) + float(offset_px)

    grid_y, grid_x = np.mgrid[0:height, 0:width].astype(np.float32)
    normalized = ((grid_x - center_x) / radius_x) ** 2 + ((grid_y - center_y) / radius_y) ** 2
    shadow = np.clip(1.0 - normalized, 0.0, 1.0) ** 0.72
    shadow[alpha > 0.02] = 0.0
    if blur > 0:
        shadow = cv2.GaussianBlur(shadow.astype(np.float32), (0, 0), float(blur))
    shadow *= np.clip(1.0 - alpha, 0.0, 1.0)
    return np.clip(shadow, 0.0, 1.0).astype(np.float32)


def _smooth_step(value: np.ndarray, first: float, last: float) -> np.ndarray:
    normalized = np.clip((value - first) / max(1e-6, last - first), 0.0, 1.0)
    return normalized * normalized * (3.0 - 2.0 * normalized)


def _quantile_profile(values: np.ndarray, valid: np.ndarray, axis: int, quantile: float, fallback: float) -> np.ndarray:
    # `axis=1` means one profile value per row; `axis=0` means one per column.
    length = values.shape[0] if axis == 1 else values.shape[1]
    profile = np.full(length, fallback, dtype=np.float32)
    if axis == 1:
        for index in range(length):
            row_values = values[index][valid[index]]
            if row_values.size:
                profile[index] = float(np.quantile(row_values, quantile))
    else:
        for index in range(length):
            column_values = values[:, index][valid[:, index]]
            if column_values.size:
                profile[index] = float(np.quantile(column_values, quantile))
    return profile


def _support_line(mask: np.ndarray, direction: str) -> tuple[np.ndarray, np.ndarray]:
    height, width = mask.shape
    if direction == "down":
        line = np.full(width, np.nan, dtype=np.float32)
        for x in range(width):
            values = np.where(mask[:, x])[0]
            if values.size:
                line[x] = values[-1]
        valid = np.flatnonzero(~np.isnan(line))
        if valid.size == 0:
            return line, np.zeros_like(line, dtype=bool)
        filled = np.interp(np.arange(width), valid, line[valid]).astype(np.float32)
        return filled, np.ones(width, dtype=bool)
    if direction == "up":
        line = np.full(width, np.nan, dtype=np.float32)
        for x in range(width):
            values = np.where(mask[:, x])[0]
            if values.size:
                line[x] = values[0]
        valid = np.flatnonzero(~np.isnan(line))
        if valid.size == 0:
            return line, np.zeros_like(line, dtype=bool)
        return np.interp(np.arange(width), valid, line[valid]).astype(np.float32), np.ones(width, dtype=bool)
    line = np.full(height, np.nan, dtype=np.float32)
    for y in range(height):
        values = np.where(mask[y])[0]
        if values.size:
            line[y] = values[-1] if direction == "right" else values[0]
    valid = np.flatnonzero(~np.isnan(line))
    if valid.size == 0:
        return line, np.zeros_like(line, dtype=bool)
    return np.interp(np.arange(height), valid, line[valid]).astype(np.float32), np.ones(height, dtype=bool)


def _contact_shadow(image: np.ndarray, alpha: np.ndarray, direction: str, radius: int, blur: float) -> np.ndarray:
    """Recover only photographed darkness below a support line.

    The support-line gate is the important distinction from a generic shadow
    detector: pixels beside or above the product cannot become a full-height
    outline just because the silhouette is dark.
    """

    luminance = 0.2126 * image[:, :, 0] + 0.7152 * image[:, :, 1] + 0.0722 * image[:, :, 2]
    foreground = alpha >= 0.8
    valid = ~foreground
    if not np.any(foreground) or not np.any(valid):
        return np.zeros(alpha.shape, dtype=np.float32)

    global_background = float(np.quantile(luminance[valid], 0.82))
    # ComfyUI IMAGE tensors are normalized to 0..1; keep the detector in the
    # same units instead of mixing it with the 8-bit thresholds used by the
    # original offline prototype.
    if global_background < 190.0 / 255.0:
        return np.zeros(alpha.shape, dtype=np.float32)
    rows = _quantile_profile(luminance, valid, 1, 0.82, global_background)
    columns = _quantile_profile(luminance, valid, 0, 0.82, global_background)
    row_radius = max(3, int(image.shape[0] * 0.025) // 2 * 2 + 1)
    column_radius = max(3, int(image.shape[1] * 0.025) // 2 * 2 + 1)
    rows = cv2.blur(rows.reshape(-1, 1), (1, row_radius)).reshape(-1)
    columns = cv2.blur(columns.reshape(1, -1), (column_radius, 1)).reshape(-1)
    estimated = np.clip(
        rows[:, None] + columns[None, :] - global_background,
        190.0 / 255.0,
        1.0,
    )
    contrast = np.maximum(0.0, estimated - luminance)

    distances = cv2.distanceTransform((~foreground).astype(np.uint8), cv2.DIST_L2, 5)
    near = (distances > 0.0) & (distances <= float(max(1, radius)))
    support, has_support = _support_line(foreground, direction)
    if direction in ("down", "up"):
        coordinate = np.arange(alpha.shape[0], dtype=np.float32)[:, None]
        if direction == "down":
            delta = coordinate - support[None, :]
        else:
            delta = support[None, :] - coordinate
    else:
        coordinate = np.arange(alpha.shape[1], dtype=np.float32)[None, :]
        if direction == "right":
            delta = coordinate - support[:, None]
        else:
            delta = support[:, None] - coordinate
    if not np.any(has_support):
        return np.zeros(alpha.shape, dtype=np.float32)

    support_gate = _smooth_step(delta, -8.0, 8.0) * (1.0 - _smooth_step(delta, radius * 0.45, float(radius)))
    weight = near.astype(np.float32) * support_gate * _smooth_step(contrast, 6.0 / 255.0, 42.0 / 255.0)
    weight[foreground] = 0.0
    if blur > 0:
        weight = cv2.GaussianBlur(weight, (0, 0), blur)
        weight[foreground] = 0.0
    return np.clip(weight * 0.75, 0.0, 0.75).astype(np.float32)


def _stack_images(images: list[np.ndarray]) -> torch.Tensor:
    return torch.from_numpy(np.stack(images, axis=0).astype(np.float32))


def _hard_bbox(mask: np.ndarray, threshold: float = 0.8) -> tuple[int, int, int, int] | None:
    ys, xs = np.where(mask >= threshold)
    if xs.size == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def _fit_one_to_canvas(
    foreground: np.ndarray,
    alpha: np.ndarray,
    shadow: np.ndarray,
    canvas_width: int,
    canvas_height: int,
    target_long_side: int,
    center_x: float,
    center_y: float,
    shadow_strength: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Place a native-aspect cutout on a common canvas.

    The scale is derived from the hard foreground bounding box, never from
    the source image dimensions.  This is what keeps a portrait source from
    becoming a tiny product when all deliverables use a landscape canvas.
    """

    height, width = alpha.shape
    matte = np.clip(alpha, 0.0, 1.0)
    shadow_mask = np.clip(shadow, 0.0, 1.0) * (1.0 - matte)
    product_bbox = _hard_bbox(matte)
    if product_bbox is None:
        raise ValueError("FBA_FitCanvas received an empty alpha mask")

    product_x0, product_y0, product_x1, product_y1 = product_bbox
    shadow_bbox = _hard_bbox(shadow_mask, 0.01)
    crop_x0, crop_y0, crop_x1, crop_y1 = product_x0, product_y0, product_x1, product_y1
    if shadow_bbox is not None:
        crop_x0 = min(crop_x0, shadow_bbox[0])
        crop_y0 = min(crop_y0, shadow_bbox[1])
        crop_x1 = max(crop_x1, shadow_bbox[2])
        crop_y1 = max(crop_y1, shadow_bbox[3])

    context = max(8, min(64, int(round(min(width, height) * 0.015))))
    crop_x0 = max(0, crop_x0 - context)
    crop_y0 = max(0, crop_y0 - context)
    crop_x1 = min(width, crop_x1 + context)
    crop_y1 = min(height, crop_y1 + context)

    product_width = product_x1 - product_x0
    product_height = product_y1 - product_y0
    desired_scale = float(target_long_side) / max(product_width, product_height)
    fit_scale = min(
        (canvas_width * 0.94) / max(1, product_width),
        (canvas_height * 0.94) / max(1, product_height),
    )
    scale = min(desired_scale, fit_scale)

    crop = foreground[crop_y0:crop_y1, crop_x0:crop_x1]
    crop_alpha = matte[crop_y0:crop_y1, crop_x0:crop_x1]
    crop_shadow = shadow_mask[crop_y0:crop_y1, crop_x0:crop_x1]
    scaled_width = max(1, int(round(crop.shape[1] * scale)))
    scaled_height = max(1, int(round(crop.shape[0] * scale)))
    scaled_foreground = cv2.resize(crop, (scaled_width, scaled_height), interpolation=cv2.INTER_LANCZOS4)
    scaled_alpha = cv2.resize(crop_alpha, (scaled_width, scaled_height), interpolation=cv2.INTER_LINEAR)
    scaled_shadow = cv2.resize(crop_shadow, (scaled_width, scaled_height), interpolation=cv2.INTER_LINEAR)

    product_center_x = ((product_x0 - crop_x0) + product_width / 2.0) * scale
    product_center_y = ((product_y0 - crop_y0) + product_height / 2.0) * scale
    desired_center_x = float(np.clip(center_x, 0.0, 1.0)) * canvas_width
    desired_center_y = float(np.clip(center_y, 0.0, 1.0)) * canvas_height
    paste_x = int(round(desired_center_x - product_center_x))
    paste_y = int(round(desired_center_y - product_center_y))

    canvas_foreground = np.zeros((canvas_height, canvas_width, 3), dtype=np.float32)
    canvas_alpha = np.zeros((canvas_height, canvas_width), dtype=np.float32)
    canvas_shadow = np.zeros((canvas_height, canvas_width), dtype=np.float32)
    source_x0 = max(0, -paste_x)
    source_y0 = max(0, -paste_y)
    source_x1 = min(scaled_width, canvas_width - paste_x)
    source_y1 = min(scaled_height, canvas_height - paste_y)
    if source_x1 > source_x0 and source_y1 > source_y0:
        dest_x0 = paste_x + source_x0
        dest_y0 = paste_y + source_y0
        dest_x1 = paste_x + source_x1
        dest_y1 = paste_y + source_y1
        canvas_foreground[dest_y0:dest_y1, dest_x0:dest_x1] = scaled_foreground[source_y0:source_y1, source_x0:source_x1]
        canvas_alpha[dest_y0:dest_y1, dest_x0:dest_x1] = scaled_alpha[source_y0:source_y1, source_x0:source_x1]
        canvas_shadow[dest_y0:dest_y1, dest_x0:dest_x1] = scaled_shadow[source_y0:source_y1, source_x0:source_x1]

    canvas_shadow = np.clip(canvas_shadow * (1.0 - canvas_alpha), 0.0, 1.0)
    white_background = 1.0 - float(shadow_strength) * canvas_shadow
    white = canvas_foreground * canvas_alpha[:, :, None] + white_background[:, :, None] * (1.0 - canvas_alpha[:, :, None])
    dark_background = 0.10 * (1.0 - 0.65 * canvas_shadow)
    dark = canvas_foreground * canvas_alpha[:, :, None] + dark_background[:, :, None] * (1.0 - canvas_alpha[:, :, None])
    alpha_debug = np.repeat(canvas_alpha[:, :, None], 3, axis=2)
    shadow_debug = np.repeat(canvas_shadow[:, :, None], 3, axis=2)
    return (
        np.clip(white, 0.0, 1.0),
        np.clip(dark, 0.0, 1.0),
        np.clip(alpha_debug, 0.0, 1.0),
        np.clip(shadow_debug, 0.0, 1.0),
    )


class FBA_Matting:
    CATEGORY = "AILAB/Matting"
    FUNCTION = "matte"
    RETURN_TYPES = ("IMAGE", "MASK", "IMAGE", "IMAGE")
    RETURN_NAMES = ("foreground", "alpha", "background", "source")

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "image": ("IMAGE",),
                "mask": ("MASK",),
                "max_side": ("INT", {"default": 1920, "min": 512, "max": 4096, "step": 64}),
                "trimap_erode": ("INT", {"default": 4, "min": 0, "max": 48, "step": 1}),
                "trimap_dilate": ("INT", {"default": 12, "min": 0, "max": 96, "step": 1}),
                "weights_path": ("STRING", {"default": _DEFAULT_FBA_WEIGHTS}),
                "device": (["cuda:0", "cpu"], {"default": "cuda:0"}),
            },
        }

    def matte(
        self,
        image: torch.Tensor,
        mask: torch.Tensor,
        max_side: int,
        trimap_erode: int,
        trimap_dilate: int,
        weights_path: str,
        device: str,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        model, model_device = _load_model(weights_path, device)
        images = _as_image_array(image)
        masks = _as_mask_array(mask)
        if images.shape[0] != masks.shape[0]:
            raise ValueError(f"image/mask batch mismatch: {images.shape[0]} vs {masks.shape[0]}")

        foregrounds: list[np.ndarray] = []
        alphas: list[np.ndarray] = []
        backgrounds: list[np.ndarray] = []
        sources: list[np.ndarray] = []
        for image_np, mask_np in zip(images, masks):
            height, width = mask_np.shape
            target_h, target_w = _scaled_size(height, width, int(max_side))
            source = cv2.resize(image_np, (target_w, target_h), interpolation=cv2.INTER_LANCZOS4)
            coarse = cv2.resize(mask_np, (target_w, target_h), interpolation=cv2.INTER_LINEAR)
            foreground, alpha, background = _fba_predict(
                np.clip(source, 0.0, 1.0).astype(np.float32),
                np.clip(coarse, 0.0, 1.0).astype(np.float32),
                model,
                model_device,
                int(trimap_erode),
                int(trimap_dilate),
            )
            foregrounds.append(foreground)
            alphas.append(alpha)
            backgrounds.append(background)
            sources.append(source)
        return _stack_images(foregrounds), torch.from_numpy(np.stack(alphas, axis=0)), _stack_images(backgrounds), _stack_images(sources)


class FBA_CleanAlpha:
    CATEGORY = "AILAB/Matting"
    FUNCTION = "clean"
    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("alpha",)

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "mask": ("MASK",),
                "threshold": ("FLOAT", {"default": 0.80, "min": 0.50, "max": 0.99, "step": 0.01}),
                "erode": ("INT", {"default": 4, "min": 0, "max": 24, "step": 1}),
                "soften": ("FLOAT", {"default": 0.35, "min": 0.0, "max": 3.0, "step": 0.05}),
            },
        }

    def clean(self, mask: torch.Tensor, threshold: float, erode: int, soften: float) -> tuple[torch.Tensor]:
        masks = _as_mask_array(mask)
        result = [_clean_alpha(item, float(threshold), int(erode), float(soften)) for item in masks]
        return (torch.from_numpy(np.stack(result, axis=0).astype(np.float32)),)


class FBA_ContactShadow:
    CATEGORY = "AILAB/Matting"
    FUNCTION = "extract"
    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("shadow",)

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "image": ("IMAGE",),
                "alpha": ("MASK",),
                "direction": (["down", "up", "left", "right"], {"default": "down"}),
                "radius": ("INT", {"default": 180, "min": 16, "max": 512, "step": 4}),
                "blur": ("FLOAT", {"default": 6.0, "min": 0.0, "max": 32.0, "step": 0.5}),
            },
        }

    def extract(self, image: torch.Tensor, alpha: torch.Tensor, direction: str, radius: int, blur: float) -> tuple[torch.Tensor]:
        images = _as_image_array(image)
        masks = _as_mask_array(alpha)
        if images.shape[0] != masks.shape[0]:
            raise ValueError(f"image/alpha batch mismatch: {images.shape[0]} vs {masks.shape[0]}")
        shadows = [_contact_shadow(item, mask, direction, int(radius), float(blur)) for item, mask in zip(images, masks)]
        return (torch.from_numpy(np.stack(shadows, axis=0).astype(np.float32)),)


class FBA_ImageToMask:
    """Convert image-like shadow maps to a ComfyUI MASK tensor.

    A few third-party nodes return an unbatched HxWxC tensor even though they
    advertise IMAGE.  Keep this adapter deterministic and do not alter pixel
    values beyond selecting the requested channel.
    """

    CATEGORY = "AILAB/Matting"
    FUNCTION = "convert"
    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("mask",)

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "image": ("IMAGE",),
                "channel": (["red", "green", "blue", "luminance"], {"default": "red"}),
            },
        }

    def convert(self, image: torch.Tensor, channel: str) -> tuple[torch.Tensor]:
        array = image.detach().cpu().numpy().astype(np.float32, copy=False)
        if array.ndim == 3:
            array = array[None, ...]
        if array.ndim != 4 or array.shape[-1] < 3:
            raise ValueError(f"expected image [batch,height,width,channels], got {array.shape}")
        if channel == "red":
            mask = array[..., 0]
        elif channel == "green":
            mask = array[..., 1]
        elif channel == "blue":
            mask = array[..., 2]
        else:
            mask = 0.2126 * array[..., 0] + 0.7152 * array[..., 1] + 0.0722 * array[..., 2]
        return (torch.from_numpy(np.clip(mask, 0.0, 1.0).astype(np.float32)),)


class FBA_ForegroundClean:
    CATEGORY = "AILAB/Matting"
    FUNCTION = "clean"
    RETURN_TYPES = ("IMAGE", "MASK", "IMAGE")
    RETURN_NAMES = ("foreground", "alpha", "removed_debug")

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "foreground": ("IMAGE",),
                "alpha": ("MASK",),
                "coarse_mask": ("MASK",),
                "source": ("IMAGE",),
                "luma_min": ("FLOAT", {"default": 0.68, "min": 0.0, "max": 1.0, "step": 0.01}),
                "saturation_max": ("FLOAT", {"default": 0.16, "min": 0.0, "max": 1.0, "step": 0.01}),
                "min_area": ("INT", {"default": 24, "min": 1, "max": 100000, "step": 1}),
                "large_area": ("INT", {"default": 640, "min": 1, "max": 1000000, "step": 1}),
                "boundary_radius": ("INT", {"default": 5, "min": 1, "max": 64, "step": 1}),
            },
        }

    def clean(
        self,
        foreground: torch.Tensor,
        alpha: torch.Tensor,
        coarse_mask: torch.Tensor,
        source: torch.Tensor,
        luma_min: float,
        saturation_max: float,
        min_area: int,
        large_area: int,
        boundary_radius: int,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        foregrounds = _as_image_array(foreground)
        alphas = _as_mask_array(alpha)
        coarse_masks = _as_mask_array(coarse_mask)
        sources = _as_image_array(source)
        if not (foregrounds.shape[0] == alphas.shape[0] == coarse_masks.shape[0] == sources.shape[0]):
            raise ValueError(
                "foreground/alpha/coarse_mask/source batch mismatch: "
                f"{foregrounds.shape[0]}/{alphas.shape[0]}/{coarse_masks.shape[0]}/{sources.shape[0]}"
            )
        cleaned_alphas: list[np.ndarray] = []
        debug_images: list[np.ndarray] = []
        for foreground_np, alpha_np, coarse_np, source_np in zip(foregrounds, alphas, coarse_masks, sources):
            cleaned, removed = _remove_gray_background_components(
                foreground_np,
                alpha_np,
                coarse_np,
                source_np,
                float(luma_min),
                float(saturation_max),
                int(min_area),
                int(large_area),
                int(boundary_radius),
            )
            cleaned_alphas.append(cleaned)
            debug_images.append(np.repeat(removed[:, :, None], 3, axis=2))
        return (
            _stack_images([item for item in foregrounds]),
            torch.from_numpy(np.stack(cleaned_alphas, axis=0).astype(np.float32)),
            _stack_images(debug_images),
        )


class FBA_EdgeColorRefill:
    CATEGORY = "AILAB/Matting"
    FUNCTION = "refill"
    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("foreground", "debug")

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "foreground": ("IMAGE",),
                "alpha": ("MASK",),
                "edge_px": ("INT", {"default": 0, "min": 0, "max": 12, "step": 1}),
                "strength": ("FLOAT", {"default": 0.9, "min": 0.0, "max": 1.0, "step": 0.01}),
            },
        }

    def refill(
        self,
        foreground: torch.Tensor,
        alpha: torch.Tensor,
        edge_px: int,
        strength: float,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        foregrounds = _as_image_array(foreground)
        alphas = _as_mask_array(alpha)
        if foregrounds.shape[0] != alphas.shape[0]:
            raise ValueError(f"foreground/alpha batch mismatch: {foregrounds.shape[0]} vs {alphas.shape[0]}")
        outputs: list[np.ndarray] = []
        debug_images: list[np.ndarray] = []
        for foreground_np, alpha_np in zip(foregrounds, alphas):
            output, debug = _refill_edge_color(foreground_np, alpha_np, int(edge_px), float(strength))
            outputs.append(output)
            debug_images.append(debug)
        return _stack_images(outputs), _stack_images(debug_images)


class FBA_BottomContactShadow:
    CATEGORY = "AILAB/Matting"
    FUNCTION = "generate"
    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("shadow",)

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "alpha": ("MASK",),
                "band_px": ("INT", {"default": 18, "min": 1, "max": 256, "step": 1}),
                "width_scale": ("FLOAT", {"default": 1.08, "min": 0.5, "max": 2.0, "step": 0.01}),
                "height_scale": ("FLOAT", {"default": 0.10, "min": 0.02, "max": 0.6, "step": 0.01}),
                "offset_px": ("FLOAT", {"default": 2.0, "min": -64.0, "max": 128.0, "step": 0.5}),
                "blur": ("FLOAT", {"default": 6.0, "min": 0.0, "max": 64.0, "step": 0.5}),
            },
        }

    def generate(
        self,
        alpha: torch.Tensor,
        band_px: int,
        width_scale: float,
        height_scale: float,
        offset_px: float,
        blur: float,
    ) -> tuple[torch.Tensor]:
        alphas = _as_mask_array(alpha)
        shadows = [
            _bottom_contact_shadow(
                alpha_np,
                int(band_px),
                float(width_scale),
                float(height_scale),
                float(offset_px),
                float(blur),
            )
            for alpha_np in alphas
        ]
        return (torch.from_numpy(np.stack(shadows, axis=0).astype(np.float32)),)


class FBA_FitCanvas:
    CATEGORY = "AILAB/Matting"
    FUNCTION = "fit"
    RETURN_TYPES = ("IMAGE", "IMAGE", "IMAGE", "IMAGE")
    RETURN_NAMES = ("white", "dark", "alpha_debug", "shadow_debug")

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "foreground": ("IMAGE",),
                "alpha": ("MASK",),
                "shadow": ("MASK",),
                "canvas_width": ("INT", {"default": 1920, "min": 256, "max": 4096, "step": 8}),
                "canvas_height": ("INT", {"default": 1280, "min": 256, "max": 4096, "step": 8}),
                "target_long_side": ("INT", {"default": 1100, "min": 128, "max": 4096, "step": 8}),
                "center_x": ("FLOAT", {"default": 0.50, "min": 0.0, "max": 1.0, "step": 0.01}),
                "center_y": ("FLOAT", {"default": 0.48, "min": 0.0, "max": 1.0, "step": 0.01}),
                "shadow_strength": ("FLOAT", {"default": 0.55, "min": 0.0, "max": 1.0, "step": 0.01}),
            },
        }

    def fit(
        self,
        foreground: torch.Tensor,
        alpha: torch.Tensor,
        shadow: torch.Tensor,
        canvas_width: int,
        canvas_height: int,
        target_long_side: int,
        center_x: float,
        center_y: float,
        shadow_strength: float,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        foregrounds = _as_image_array(foreground)
        alphas = _as_mask_array(alpha)
        shadows = _as_mask_array(shadow)
        if not (foregrounds.shape[0] == alphas.shape[0] == shadows.shape[0]):
            raise ValueError(
                "foreground/alpha/shadow batch mismatch: "
                f"{foregrounds.shape[0]}/{alphas.shape[0]}/{shadows.shape[0]}"
            )

        outputs = [[], [], [], []]
        for fg, matte, shadow_mask in zip(foregrounds, alphas, shadows):
            fitted = _fit_one_to_canvas(
                fg,
                matte,
                shadow_mask,
                int(canvas_width),
                int(canvas_height),
                int(target_long_side),
                float(center_x),
                float(center_y),
                float(shadow_strength),
            )
            for index, output in enumerate(fitted):
                outputs[index].append(output)
        return tuple(_stack_images(items) for items in outputs)  # type: ignore[return-value]


class FBA_Composite:
    CATEGORY = "AILAB/Matting"
    FUNCTION = "compose"
    RETURN_TYPES = ("IMAGE", "IMAGE", "IMAGE", "IMAGE")
    RETURN_NAMES = ("white", "dark", "alpha_debug", "shadow_debug")

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "foreground": ("IMAGE",),
                "alpha": ("MASK",),
                "shadow": ("MASK",),
                "shadow_strength": ("FLOAT", {"default": 0.55, "min": 0.0, "max": 1.0, "step": 0.01}),
            },
        }

    def compose(
        self,
        foreground: torch.Tensor,
        alpha: torch.Tensor,
        shadow: torch.Tensor,
        shadow_strength: float,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        foregrounds = _as_image_array(foreground)
        alphas = _as_mask_array(alpha)
        shadows = _as_mask_array(shadow)
        white_outputs: list[np.ndarray] = []
        dark_outputs: list[np.ndarray] = []
        alpha_outputs: list[np.ndarray] = []
        shadow_outputs: list[np.ndarray] = []
        for fg, matte, shadow_mask in zip(foregrounds, alphas, shadows):
            matte = np.clip(matte, 0.0, 1.0)
            shadow_mask = np.clip(shadow_mask, 0.0, 1.0) * (1.0 - matte)
            white_background = 1.0 - float(shadow_strength) * shadow_mask
            white = fg * matte[:, :, None] + white_background[:, :, None] * (1.0 - matte[:, :, None])
            dark_background = 0.10 * (1.0 - 0.65 * shadow_mask)
            dark = fg * matte[:, :, None] + dark_background[:, :, None] * (1.0 - matte[:, :, None])
            white_outputs.append(np.clip(white, 0.0, 1.0))
            dark_outputs.append(np.clip(dark, 0.0, 1.0))
            alpha_outputs.append(np.repeat(matte[:, :, None], 3, axis=2))
            shadow_outputs.append(np.repeat(shadow_mask[:, :, None], 3, axis=2))
        return (
            _stack_images(white_outputs),
            _stack_images(dark_outputs),
            _stack_images(alpha_outputs),
            _stack_images(shadow_outputs),
        )


NODE_CLASS_MAPPINGS = {
    "FBA_Matting": FBA_Matting,
    "FBA_CleanAlpha": FBA_CleanAlpha,
    "FBA_ContactShadow": FBA_ContactShadow,
    "FBA_ImageToMask": FBA_ImageToMask,
    "FBA_ForegroundClean": FBA_ForegroundClean,
    "FBA_EdgeColorRefill": FBA_EdgeColorRefill,
    "FBA_BottomContactShadow": FBA_BottomContactShadow,
    "FBA_FitCanvas": FBA_FitCanvas,
    "FBA_Composite": FBA_Composite,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "FBA_Matting": "FBA Matting (deterministic)",
    "FBA_CleanAlpha": "FBA Clean Alpha",
    "FBA_ContactShadow": "FBA Contact Shadow (source analysis)",
    "FBA_ImageToMask": "FBA Image To Mask",
    "FBA_ForegroundClean": "FBA Foreground Clean (gray component removal)",
    "FBA_EdgeColorRefill": "FBA Edge Color Refill (inward sample)",
    "FBA_BottomContactShadow": "FBA Bottom Contact Shadow (alpha ellipse)",
    "FBA_FitCanvas": "FBA Fit To Common Canvas",
    "FBA_Composite": "FBA White Plate + Diagnostics",
}
