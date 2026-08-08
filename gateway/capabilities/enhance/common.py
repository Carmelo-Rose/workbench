"""Shared Real-ESRGAN and GFPGAN setup used by toolbox enhancement runners."""

from __future__ import annotations

from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
WEIGHTS_PATH = BASE_DIR / "weights" / "realesr-general-x4v3.pth"
WDN_WEIGHTS_PATH = BASE_DIR / "weights" / "realesr-general-wdn-x4v3.pth"
GFPGAN_WEIGHTS_PATH = BASE_DIR / "weights" / "GFPGANv1.4.pth"

# 1536 keeps a 720x1280 frame whole on the service GPU; larger inputs fall back.
TILE_SIZE = 1536
TILE_FALLBACKS = (1024, 768, 512, 256)
TILE_PAD = 10


def progress(percent: int, stage: str) -> None:
    print(f"PROGRESS {percent} {stage}", flush=True)


def build_upsampler(half: bool, tile_size: int, denoise: float = 1.0):
    """Build x4v3 with optional DNI interpolation against its WDN counterpart.

    Real-ESRGAN's official inference script maps ``[denoise, 1 - denoise]``
    to ``[general, general-wdn]``.  A denoise value of 1 therefore preserves
    the pre-existing x4v3-only behavior.
    """
    import torch
    from basicsr.archs.srvgg_arch import SRVGGNetCompact
    from realesrgan import RealESRGANer

    model_path: str | list[str] = str(WEIGHTS_PATH)
    dni_weight: list[float] | None = None
    if denoise < 1.0 and WDN_WEIGHTS_PATH.is_file():
        model_path = [str(WEIGHTS_PATH), str(WDN_WEIGHTS_PATH)]
        dni_weight = [denoise, 1.0 - denoise]

    model = SRVGGNetCompact(
        num_in_ch=3, num_out_ch=3, num_feat=64, num_conv=32, upscale=4, act_type="prelu"
    )
    return RealESRGANer(
        scale=4,
        model_path=model_path,
        dni_weight=dni_weight,
        model=model,
        tile=tile_size,
        tile_pad=TILE_PAD,
        pre_pad=10,
        half=half and torch.cuda.is_available(),
    )


def build_face_enhancer(upsampler, outscale: float):
    from gfpgan import GFPGANer

    return GFPGANer(
        model_path=str(GFPGAN_WEIGHTS_PATH),
        upscale=outscale,
        arch="clean",
        channel_multiplier=2,
        bg_upsampler=upsampler,
    )
