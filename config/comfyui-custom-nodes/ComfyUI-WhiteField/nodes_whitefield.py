"""White-field normalisation nodes for ComfyUI.

These nodes do not cut the product out and do not synthesise a shadow.  A studio
shadow is a *multiplicative* attenuation of the light falling on the seamless, so
if you can estimate B(x,y) -- what the backdrop would have measured with no
object in frame -- then `source / B` is the measured shadow transmittance, per
channel.  The backdrop divides out to pure white, the paper's colour cast divides
out with it, and the shadow keeps its own direction, shape and falloff because it
is measured rather than modelled.  Nothing about it has to be re-tuned when the
camera angle changes.

The product mask is used only as a *protection* region: inside it the source
pixels are copied through unchanged.  There is no cut line, so the failure modes
that live on a cut line -- white fringes, chewed hardware, halos -- have nowhere
to appear.

Contrast with `ComfyUI-FBA-Matting`, whose `FBA_BottomContactShadow` paints a
symmetric ellipse under the alpha bounding box: that ellipse is identical for a
front, side and rear view, so it discards the real light direction, and its
`FBA_ForegroundClean` deletes low-saturation regions by threshold, which eats the
real fabric inside a cap's rear opening on cream and khaki colourways.
"""

from __future__ import annotations

from typing import Any

import cv2
import numpy as np
import torch


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


def _stack_images(images: list[np.ndarray]) -> torch.Tensor:
    return torch.from_numpy(np.stack(images, axis=0).astype(np.float32))


def _stack_masks(masks: list[np.ndarray]) -> torch.Tensor:
    return torch.from_numpy(np.stack(masks, axis=0).astype(np.float32))


def _gray_to_image(mask: np.ndarray) -> np.ndarray:
    return np.repeat(np.clip(mask, 0.0, 1.0)[:, :, None], 3, axis=2)


def _ellipse(radius: int) -> np.ndarray:
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1,) * 2)


def _resize_to(array: np.ndarray, height: int, width: int, interpolation: int) -> np.ndarray:
    if array.shape[0] == height and array.shape[1] == width:
        return array
    return cv2.resize(array, (width, height), interpolation=interpolation)


# --------------------------------------------------------------------- backdrop

def _norm_conv(rgb: np.ndarray, weight: np.ndarray, sigma: float) -> tuple[np.ndarray, np.ndarray]:
    """Smooth field built only from `weight`ed pixels (normalised convolution)."""

    numerator = cv2.GaussianBlur(rgb * weight[:, :, None], (0, 0), sigma)
    denominator = cv2.GaussianBlur(weight, (0, 0), sigma)
    return numerator / np.maximum(denominator, 1e-5)[:, :, None], denominator


def _fit_backdrop(
    rgb: np.ndarray,
    known: np.ndarray,
    sigma_frac: float,
    levels: int,
    fit_side: int,
) -> np.ndarray:
    """Coarse-to-fine estimate of the unoccluded backdrop.

    Wide passes fill in behind the product and its cast shadow; narrower passes
    track the seamless's wall-to-floor curve.  Only pixels marked clean backdrop
    are ever read, so the product and its shadow cannot bleed into the estimate.

    The fit runs on a downsampled copy.  At `fit_side` the narrowest pass is
    still tens of pixels wide, and the field is band-limited well below that, so
    upsampling it back is exact -- this is roughly an order of magnitude faster
    than fitting at working resolution for no measurable change in the result.
    """

    height, width, _ = rgb.shape
    scale = min(1.0, float(fit_side) / max(height, width))
    if scale < 1.0:
        small = cv2.resize(rgb, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        # fractional coverage is a natural weight for normalised convolution
        weight = cv2.resize(known.astype(np.float32), None, fx=scale, fy=scale,
                            interpolation=cv2.INTER_AREA)
    else:
        small, weight = rgb, known.astype(np.float32)

    base = sigma_frac * max(small.shape[:2])
    field: np.ndarray | None = None
    for level in range(max(1, levels)):
        estimate, denominator = _norm_conv(small, weight, base / (1.6 ** level))
        if field is None:
            field = estimate
        else:
            # trust the finer estimate only where enough known pixels backed it
            trust = np.clip(denominator / (denominator.max() * 0.05 + 1e-6), 0.0, 1.0)
            field = trust[:, :, None] * estimate + (1.0 - trust[:, :, None]) * field

    assert field is not None
    if scale < 1.0:
        field = cv2.resize(field, (width, height), interpolation=cv2.INTER_CUBIC)
    return np.maximum(field, 1e-3)


def _clean_backdrop_pixels(
    rgb: np.ndarray,
    mask: np.ndarray,
    exclude_px: int,
    percentile: float,
) -> np.ndarray:
    """Pixels that are safe to treat as bare, unshadowed backdrop."""

    reach = cv2.dilate((mask > 0.02).astype(np.uint8), _ellipse(max(1, exclude_px)))
    far = reach == 0
    if far.sum() < 5000:
        # product fills the frame; fall back to whatever sits outside the mask
        far = mask <= 0.02
    if not far.any():
        raise ValueError("no backdrop pixels left after excluding the product")
    luma = rgb.mean(axis=2)
    return far & (luma >= np.percentile(luma[far], percentile))


# --------------------------------------------------------------------- topology

def _split_background(mask: np.ndarray, threshold: float = 0.5) -> tuple[np.ndarray, np.ndarray]:
    """Separate outer background from background enclosed by the product.

    A flood fill from the frame corners reaches everything connected to the
    outside; whatever it cannot reach is surrounded by product -- a cap's rear
    opening, the gap under a handle.  Those two cases need opposite treatment:
    the outer region keeps its cast shadow because that shadow is what grounds
    the product, while an enclosed hole must go pure white.  Both are simply
    "darker than the fitted backdrop", so intensity cannot tell them apart and
    connectivity has to.
    """

    solid = (mask > threshold).astype(np.uint8)
    free = (1 - solid).astype(np.uint8)
    height, width = free.shape
    flooded = free.copy()
    for x, y in ((0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)):
        if flooded[y, x] == 1:
            cv2.floodFill(flooded, np.zeros((height + 2, width + 2), np.uint8), (x, y), 2)
    outer = flooded == 2
    return outer, (free == 1) & ~outer


# ------------------------------------------------------------------------- dust

def _find_dust(
    dark: np.ndarray,
    mask: np.ndarray,
    max_area: int,
    max_dim: int,
    min_gap: int,
) -> np.ndarray:
    """Isolated specks on the paper: small, compact, and well clear of the product.

    The size ceiling is what keeps a missed strap tip or a dropped eyelet safe --
    those are either elongated or large, and dust is neither.  The gap test keeps
    the search away from the product's own edge, where a real detail that the
    mask happened to miss would sit.
    """

    count, labels, stats, _ = cv2.connectedComponentsWithStats(dark.astype(np.uint8), 8)
    gap = cv2.distanceTransform((mask <= 0.02).astype(np.uint8), cv2.DIST_L2, 3)
    found = np.zeros(dark.shape, dtype=bool)
    for index in range(1, count):
        _, _, box_w, box_h, area = stats[index]
        if area > max_area or max(box_w, box_h) > max_dim:
            continue
        component = labels == index
        if gap[component].min() < min_gap:
            continue
        found |= component
    return found


# ---------------------------------------------------------------------- framing

def _mask_box(mask: np.ndarray, threshold: float = 0.5, min_area_frac: float = 1e-4)\
        -> tuple[int, int, int, int]:
    """Bounding box of the product, read from the segmentation mask.

    Deriving it from the finished image instead does not work: after
    normalisation the cast shadow is a smooth gradient that any texture or
    threshold test either merges into the product or drops entirely, and on a
    3000px delivery it merges.  The mask already knows where the product is.
    """

    solid = (mask > threshold).astype(np.uint8)
    count, _, stats, _ = cv2.connectedComponentsWithStats(solid, 8)
    if count < 2:
        raise ValueError("no product found in mask")
    floor = solid.size * min_area_frac
    keep = [i for i in range(1, count) if stats[i, 4] >= floor]
    if not keep:
        keep = [1 + int(np.argmax(stats[1:, 4]))]
    x0 = min(int(stats[i, 0]) for i in keep)
    y0 = min(int(stats[i, 1]) for i in keep)
    x1 = max(int(stats[i, 0] + stats[i, 2]) for i in keep)
    y1 = max(int(stats[i, 1] + stats[i, 3]) for i in keep)
    return x0, y0, x1, y1


def _edge_load(rgb: np.ndarray, level: float, band: int = 5) -> dict[str, float]:
    """How much live content each frame edge carries.

    A shot framed tight enough that the cast shadow runs off the edge will read
    high on that side.  The threshold has to sit clearly below the backdrop
    residue -- measured at 238-252 on this catalogue -- or the residue itself
    gets mistaken for shadow and the padding goes to the wrong side.
    """

    luma = rgb.mean(axis=2)
    return {
        "left": float((luma[:, :band] < level).mean()),
        "right": float((luma[:, -band:] < level).mean()),
        "top": float((luma[:band, :] < level).mean()),
        "bottom": float((luma[-band:, :] < level).mean()),
    }


def _extend_pad(rgb: np.ndarray, pad_y: tuple[int, int], pad_x: tuple[int, int]) -> np.ndarray:
    """Grow the frame outwards, fading whatever was at the edge back to white.

    A square window wider than the source has to invent something beyond the
    frame.  Filling it with flat white butts a 255 wall against a shadow that
    the camera merely ran out of room for, which reads as a hard straight seam.
    Replicating the edge and fading it out keeps the gradient continuous.  The
    fade is a guess, but it only ever covers ground the photograph never held.
    """

    out = np.pad(rgb, (pad_y, pad_x, (0, 0)), mode="edge")
    height, width, _ = out.shape
    ramp = np.ones((height, width), np.float32)
    for axis, (low, high) in ((0, pad_y), (1, pad_x)):
        span = out.shape[axis]
        taper = np.ones(span, np.float32)
        if low:
            taper[:low] = np.linspace(0.0, 1.0, low, endpoint=False)
        if high:
            taper[span - high:] = np.linspace(1.0, 0.0, high)
        ramp *= taper[:, None] if axis == 0 else taper[None, :]
    return out * ramp[:, :, None] + (1.0 - ramp[:, :, None])


# ------------------------------------------------------------------------ nodes

class WhiteField_FitBackdrop:
    CATEGORY = "AILAB/WhiteField"
    FUNCTION = "fit"
    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("backdrop", "known_debug")

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "image": ("IMAGE",),
                "mask": ("MASK",),
                "exclude_px": ("INT", {"default": 40, "min": 1, "max": 512, "step": 1}),
                "known_percentile": ("FLOAT", {"default": 55.0, "min": 0.0, "max": 99.0, "step": 1.0}),
                "sigma_frac": ("FLOAT", {"default": 0.16, "min": 0.02, "max": 0.60, "step": 0.01}),
                "levels": ("INT", {"default": 4, "min": 1, "max": 8, "step": 1}),
                "fit_side": ("INT", {"default": 640, "min": 128, "max": 4096, "step": 32}),
            },
        }

    def fit(
        self,
        image: torch.Tensor,
        mask: torch.Tensor,
        exclude_px: int,
        known_percentile: float,
        sigma_frac: float,
        levels: int,
        fit_side: int,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        images = _as_image_array(image)
        masks = _as_mask_array(mask)
        if images.shape[0] != masks.shape[0]:
            raise ValueError(f"image/mask batch mismatch: {images.shape[0]} vs {masks.shape[0]}")

        backdrops: list[np.ndarray] = []
        debugs: list[np.ndarray] = []
        for rgb, single in zip(images, masks):
            single = _resize_to(single, rgb.shape[0], rgb.shape[1], cv2.INTER_LINEAR)
            known = _clean_backdrop_pixels(rgb, single, int(exclude_px), float(known_percentile))
            backdrops.append(_fit_backdrop(rgb, known, float(sigma_frac), int(levels), int(fit_side)))
            debugs.append(_gray_to_image(known.astype(np.float32)))
        return _stack_images(backdrops), _stack_images(debugs)


class WhiteField_Normalize:
    CATEGORY = "AILAB/WhiteField"
    FUNCTION = "normalize"
    RETURN_TYPES = ("IMAGE", "IMAGE", "IMAGE", "IMAGE", "MASK")
    RETURN_NAMES = ("white", "transmittance", "holes_debug", "dust_debug", "protect")

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "image": ("IMAGE",),
                "mask": ("MASK",),
                "backdrop": ("IMAGE",),
                # 0 measured best: the product stays bit-exact either way, but
                # growing the protection region copies unnormalised backdrop
                # through and leaves a grey halo hugging the contour.
                "dilate_px": ("INT", {"default": 0, "min": 0, "max": 32, "step": 1}),
                "feather_px": ("INT", {"default": 1, "min": 0, "max": 32, "step": 1}),
                "white_at": ("FLOAT", {"default": 0.965, "min": 0.80, "max": 1.0, "step": 0.001}),
                "shadow_gain": ("FLOAT", {"default": 1.0, "min": 0.20, "max": 3.0, "step": 0.01}),
                # How much of an enclosed hole -- a cap's rear opening, the gap
                # under a handle -- is forced to pure white.  Both answers appear
                # in the retoucher's own main images for this catalogue: some
                # colourways keep the measured grey inside the opening, others
                # flatten it to paper white, so this cannot be decided here.
                # 0 keeps what the division measured, 1 is a flat white fill.
                "hole_white": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05}),
                "hole_feather": ("FLOAT", {"default": 2.0, "min": 0.0, "max": 32.0, "step": 0.5}),
                "remove_dust": ("BOOLEAN", {"default": True}),
                "dust_max_area": ("INT", {"default": 400, "min": 1, "max": 100000, "step": 1}),
                "dust_max_dim": ("INT", {"default": 25, "min": 1, "max": 512, "step": 1}),
                "dust_min_gap": ("INT", {"default": 30, "min": 0, "max": 512, "step": 1}),
            },
        }

    def normalize(
        self,
        image: torch.Tensor,
        mask: torch.Tensor,
        backdrop: torch.Tensor,
        dilate_px: int,
        feather_px: int,
        white_at: float,
        shadow_gain: float,
        hole_white: float,
        hole_feather: float,
        remove_dust: bool,
        dust_max_area: int,
        dust_max_dim: int,
        dust_min_gap: int,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        images = _as_image_array(image)
        masks = _as_mask_array(mask)
        backdrops = _as_image_array(backdrop)
        if not images.shape[0] == masks.shape[0] == backdrops.shape[0]:
            raise ValueError(
                "image/mask/backdrop batch mismatch: "
                f"{images.shape[0]}/{masks.shape[0]}/{backdrops.shape[0]}"
            )

        whites: list[np.ndarray] = []
        transmittances: list[np.ndarray] = []
        hole_debugs: list[np.ndarray] = []
        dust_debugs: list[np.ndarray] = []
        protects: list[np.ndarray] = []
        for rgb, single, field in zip(images, masks, backdrops):
            height, width, _ = rgb.shape
            # The mask and the backdrop may legitimately arrive smaller than the
            # image: the mask comes from a segmentation model with a megapixel
            # ceiling, and the backdrop is smooth by construction.  Resampling
            # them up here is what lets the division run at delivery resolution
            # while the expensive steps stay cheap.
            single = _resize_to(single, height, width, cv2.INTER_LINEAR)
            field = np.maximum(_resize_to(field, height, width, cv2.INTER_CUBIC), 1e-3)

            protect = self._protect(single, int(dilate_px), int(feather_px))
            transmittance = np.clip(np.clip(rgb / field, 0.0, 1.0) / max(white_at, 1e-3), 0.0, 1.0)
            if shadow_gain != 1.0:
                transmittance = np.clip(
                    1.0 - (1.0 - transmittance) / max(shadow_gain, 1e-3), 0.0, 1.0
                )

            outer, holes = _split_background(single)
            if holes.any() and hole_white > 0.0:
                weight = holes.astype(np.float32)
                if hole_feather > 0:
                    weight = cv2.GaussianBlur(weight, (0, 0), float(hole_feather))
                weight = np.clip(weight * float(hole_white), 0.0, 1.0)[:, :, None]
                transmittance = weight + (1.0 - weight) * transmittance

            dust = np.zeros((height, width), dtype=bool)
            if remove_dust:
                dark = outer & (transmittance.mean(axis=2) < 0.985)
                dust = _find_dust(dark, single, int(dust_max_area), int(dust_max_dim),
                                  int(dust_min_gap))
                if dust.any():
                    weight = cv2.GaussianBlur(dust.astype(np.float32), (0, 0), 1.5)
                    weight = np.clip(weight * 1.6, 0.0, 1.0)[:, :, None]
                    transmittance = weight + (1.0 - weight) * transmittance

            white = protect[:, :, None] * rgb + (1.0 - protect[:, :, None]) * transmittance
            whites.append(np.clip(white, 0.0, 1.0))
            transmittances.append(transmittance)
            hole_debugs.append(_gray_to_image(holes.astype(np.float32)))
            dust_debugs.append(_gray_to_image(dust.astype(np.float32)))
            protects.append(protect)

        return (
            _stack_images(whites),
            _stack_images(transmittances),
            _stack_images(hole_debugs),
            _stack_images(dust_debugs),
            _stack_masks(protects),
        )

    @staticmethod
    def _protect(mask: np.ndarray, dilate_px: int, feather_px: int) -> np.ndarray:
        """Protection region, never a cut line.

        The mask's own soft alpha is kept as a floor so a feather can only ever
        add protection, never erode the product's antialiased edge.
        """

        hard = (mask > 0.5).astype(np.uint8)
        if dilate_px > 0:
            hard = cv2.dilate(hard, _ellipse(dilate_px))
        protect = hard.astype(np.float32)
        if feather_px > 0:
            protect = cv2.GaussianBlur(protect, (0, 0), feather_px / 2.0)
        return np.clip(np.maximum(protect, mask), 0.0, 1.0)


class WhiteField_ScaleLongEdge:
    """Resize so the long edge hits a target, keeping the aspect ratio.

    The workflow used to carry hard-coded width/height, which silently required
    every image in a batch to share one aspect ratio -- a portrait frame mixed
    into a landscape batch came out stretched.  The batch runner cannot fix that
    either: its parameters are per-run, not per-image.  Deciding the size here,
    from the image itself, is the only place that sees one image at a time.
    """

    CATEGORY = "AILAB/WhiteField"
    FUNCTION = "scale"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "image": ("IMAGE",),
                "long_edge": ("INT", {"default": 3000, "min": 64, "max": 16384, "step": 8}),
            },
        }

    def scale(self, image: torch.Tensor, long_edge: int) -> tuple[torch.Tensor]:
        images = _as_image_array(image)
        scaled: list[np.ndarray] = []
        for rgb in images:
            height, width, _ = rgb.shape
            factor = float(long_edge) / max(height, width)
            target = (max(1, int(round(width * factor))), max(1, int(round(height * factor))))
            interpolation = cv2.INTER_AREA if factor < 1.0 else cv2.INTER_LANCZOS4
            scaled.append(np.clip(cv2.resize(rgb, target, interpolation=interpolation), 0.0, 1.0))
        return (_stack_images(scaled),)


class WhiteField_SquareCrop:
    """Frame the finished white-background image as a 1:1 main image.

    Measured against 86 main images the retoucher produced for this catalogue:
    the canvas is always 800x800, the product's own bounding box spans a median
    0.909 of it, and the product sits centred (centre x 0.443-0.560, centre y
    0.477-0.583).  The cast shadow takes no part in the framing -- whatever
    falls outside the window is simply cropped.

    Nothing inside the window is repainted; this only chooses where the window
    goes and resamples once at the end.
    """

    CATEGORY = "AILAB/WhiteField"
    FUNCTION = "crop"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("square",)

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "image": ("IMAGE",),
                "mask": ("MASK",),
                "fill": ("FLOAT", {"default": 0.90, "min": 0.30, "max": 1.0, "step": 0.005}),
                "out_side": ("INT", {"default": 800, "min": 64, "max": 8192, "step": 8}),
                # Shifting the window off the product's centre is what lets the
                # padding land on a clean edge instead of across a live shadow.
                # Past ~0.06 the result stops looking like the reference set.
                "max_centre_offset": ("FLOAT", {"default": 0.06, "min": 0.0, "max": 0.25, "step": 0.01}),
                "live_level": ("FLOAT", {"default": 235.0, "min": 0.0, "max": 255.0, "step": 1.0}),
            },
        }

    def crop(
        self,
        image: torch.Tensor,
        mask: torch.Tensor,
        fill: float,
        out_side: int,
        max_centre_offset: float,
        live_level: float,
    ) -> tuple[torch.Tensor]:
        images = _as_image_array(image)
        masks = _as_mask_array(mask)
        if images.shape[0] != masks.shape[0]:
            raise ValueError(f"image/mask batch mismatch: {images.shape[0]} vs {masks.shape[0]}")

        squares: list[np.ndarray] = []
        for rgb, single in zip(images, masks):
            height, width, _ = rgb.shape
            single = _resize_to(single, height, width, cv2.INTER_LINEAR)
            x0, y0, x1, y1 = _mask_box(single)
            side = int(round(max(x1 - x0, y1 - y0) / max(fill, 1e-3)))
            load = _edge_load(rgb, float(live_level))
            limit = max_centre_offset * side

            left = self._settle((x0 + x1) / 2.0 - side / 2.0, side, width,
                                load["left"], load["right"], limit)
            top = self._settle((y0 + y1) / 2.0 - side / 2.0, side, height,
                               load["top"], load["bottom"], limit)

            sx0, sy0 = max(0, left), max(0, top)
            sx1, sy1 = min(width, left + side), min(height, top + side)
            inner = rgb[sy0:sy1, sx0:sx1]
            pad_y = (sy0 - top, top + side - sy1)
            pad_x = (sx0 - left, left + side - sx1)
            if any(pad_y) or any(pad_x):
                inner = _extend_pad(inner, pad_y, pad_x)
            squares.append(np.clip(
                cv2.resize(inner, (int(out_side),) * 2, interpolation=cv2.INTER_AREA), 0.0, 1.0))
        return (_stack_images(squares),)

    @staticmethod
    def _settle(pos: float, side: int, span: int, low: float, high: float, limit: float) -> int:
        """Nudge the window so any padding lands on an edge with nothing on it."""

        over_low, over_high = max(0.0, -pos), max(0.0, pos + side - span)
        if over_low > 0 and low > high:
            pos += min(over_low, limit)
        elif over_high > 0 and high > low:
            pos -= min(over_high, limit)
        return int(round(pos))


class WhiteField_Report:
    """Measure the two things that decide whether an output is acceptable.

    `product_delta_max` is the largest luminance change deep inside the product
    and must read 0.000 -- anything else means the pipeline altered pixels it was
    supposed to copy.  `backdrop_pure_pct` and `backdrop_cast` describe what is
    left outside: how much of the region clear of the product reached pure white,
    and how much channel spread survives in the rest.
    """

    CATEGORY = "AILAB/WhiteField"
    FUNCTION = "report"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("report",)
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "source": ("IMAGE",),
                "result": ("IMAGE",),
                "mask": ("MASK",),
                "core_erode_px": ("INT", {"default": 15, "min": 1, "max": 128, "step": 1}),
                "far_px": ("INT", {"default": 40, "min": 1, "max": 512, "step": 1}),
            },
        }

    def report(
        self,
        source: torch.Tensor,
        result: torch.Tensor,
        mask: torch.Tensor,
        core_erode_px: int,
        far_px: int,
    ) -> dict[str, Any]:
        sources = _as_image_array(source)
        results = _as_image_array(result)
        masks = _as_mask_array(mask)
        lines: list[str] = []
        for index, (raw, out, single) in enumerate(zip(sources, results, masks)):
            height, width, _ = out.shape
            raw = _resize_to(raw, height, width, cv2.INTER_LINEAR)
            single = _resize_to(single, height, width, cv2.INTER_LINEAR)

            solid = (single > 0.5).astype(np.uint8)
            core = cv2.erode(solid, _ellipse(int(core_erode_px))) > 0
            far = cv2.dilate((single > 0.02).astype(np.uint8), _ellipse(int(far_px))) == 0

            delta = np.abs(out.mean(axis=2) - raw.mean(axis=2)) * 255.0
            product_delta = float(delta[core].max()) if core.any() else 0.0

            luma = out.mean(axis=2) * 255.0
            pure = float((luma[far] >= 254.5).mean() * 100) if far.any() else 0.0
            shadow = far & (luma < 250.0)
            if shadow.sum() > 50:
                pixels = out[shadow] * 255.0
                cast = float(np.mean(pixels.max(axis=1) - pixels.min(axis=1)))
                darkest = float(np.percentile(pixels.mean(axis=1), 1))
            else:
                cast, darkest = 0.0, 255.0
            lines.append(
                f"[{index}] product_delta_max={product_delta:.3f} "
                f"backdrop_pure_pct={pure:.2f} backdrop_cast={cast:.2f} "
                f"shadow_darkest_L={darkest:.1f}"
            )
        text = "\n".join(lines)
        print(f"[WhiteField_Report]\n{text}")
        # OUTPUT_NODE alone does not surface a return value through /history --
        # the numbers have to travel in the `ui` payload to be readable by the
        # batch runner that does the acceptance checking.
        return {"ui": {"text": [text]}, "result": (text,)}


NODE_CLASS_MAPPINGS = {
    "WhiteField_FitBackdrop": WhiteField_FitBackdrop,
    "WhiteField_Normalize": WhiteField_Normalize,
    "WhiteField_ScaleLongEdge": WhiteField_ScaleLongEdge,
    "WhiteField_SquareCrop": WhiteField_SquareCrop,
    "WhiteField_Report": WhiteField_Report,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WhiteField_FitBackdrop": "White Field: Fit Backdrop",
    "WhiteField_Normalize": "White Field: Normalize To White",
    "WhiteField_ScaleLongEdge": "White Field: Scale Long Edge",
    "WhiteField_SquareCrop": "White Field: Square Crop (1:1)",
    "WhiteField_Report": "White Field: QA Report",
}
