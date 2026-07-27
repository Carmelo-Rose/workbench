"""Deterministic product cutout adapter. Model files are supplied by the deployment runbook.

The runtime deliberately refuses floating model revisions: PRODUCT_CUTOUT_MODEL_REVISION and
PRODUCT_CUTOUT_MODEL_SHA256 must be set, and the local model marker must match both values.

The artifact is the matte alone, as an 8-bit grayscale PNG. Callers composite it over the
untouched source frame themselves, so shipping the source pixels back inside an RGBA PNG only
cost encode time and bandwidth.
"""
from __future__ import annotations
import argparse, hashlib, os, tempfile
from pathlib import Path
from PIL import Image

MODEL_ID = "ZhengPeng7/BiRefNet_HR-matting"
MODEL_REVISION = "5d6b6f8adcb5b417c871b1d84ceaae9871355b7f"

def verified_digest(weights: Path) -> str:
    """SHA256 of the weights, memoised against the file's own size and mtime.

    Every cutout runs in a fresh process, so hashing 444 MB inline cost a second of CPU per
    image for a file that changes only when the runbook replaces it. Any size or mtime change
    invalidates the marker, so a swapped model is still caught on its first run.
    """
    stat = weights.stat()
    fingerprint = f"{stat.st_size}:{stat.st_mtime_ns}"
    marker = weights.with_name(weights.name + ".verified")
    try:
        cached, digest = marker.read_text(encoding="ascii").split(" ", 1)
        if cached == fingerprint: return digest.strip()
    except (OSError, ValueError):
        pass  # absent, torn by a concurrent writer, or unreadable -- just re-hash
    digest = hashlib.sha256(weights.read_bytes()).hexdigest().lower()
    try:
        # Concurrent adapters race to publish the same value; os.replace keeps every reader
        # seeing either the old marker or a complete new one.
        handle, staged = tempfile.mkstemp(dir=marker.parent, suffix=".tmp")
        with os.fdopen(handle, "w", encoding="ascii") as f: f.write(f"{fingerprint} {digest}")
        os.replace(staged, marker)
    except OSError:
        pass  # a read-only deployment simply pays for the hash every run
    return digest

def require_model(root: Path) -> Path:
    if os.environ.get("PRODUCT_CUTOUT_MODEL_REVISION", MODEL_REVISION) != MODEL_REVISION:
        raise RuntimeError("BiRefNet model revision is not approved")
    weights = next((root / "model").rglob("*.safetensors"), None)
    checksum = root / "model.sha256"
    if weights is None or not checksum.is_file(): raise RuntimeError("fixed BiRefNet model revision/checksum is not installed")
    if verified_digest(weights) != checksum.read_text(encoding="ascii").strip().lower():
        raise RuntimeError("BiRefNet model checksum mismatch")
    return weights

def select_device(torch) -> str:
    """Resolve the compute device, refusing to quietly downgrade.

    This adapter used to ask for `"cuda" if torch.cuda.is_available() else "cpu"`. When the venv
    was built without a CUDA wheel that expression turned into a silent 60x slowdown -- 82s of
    inference per frame instead of 1.4s -- and nothing in the job log ever said so. CPU is still
    reachable, but only for someone who names it.
    """
    requested = os.environ.get("PRODUCT_CUTOUT_DEVICE", "cuda").strip().lower() or "cuda"
    if requested not in ("cuda", "cpu"):
        raise RuntimeError(f"PRODUCT_CUTOUT_DEVICE accepts 'cuda' or 'cpu', got {requested!r}")
    # device_count as well as is_available: a CPU-only wheel fails the first, while a CUDA build
    # that cannot see a card (CUDA_VISIBLE_DEVICES empty, driver wedged) passes it and then dies
    # deep inside torch with "Invalid device id", which says nothing about what to do next.
    if requested == "cuda" and not (torch.cuda.is_available() and torch.cuda.device_count() > 0):
        raise RuntimeError(
            f"no CUDA device available to torch {torch.__version__} -- a CPU-only build, or a "
            "build that cannot see the card, cannot serve this capability at its expected speed "
            "(82s per frame instead of 1.4s). Install the cu124 wheels from requirements.txt and "
            "check the driver, or set PRODUCT_CUTOUT_DEVICE=cpu to accept the slow path on purpose."
        )
    return requested

def main() -> None:
    parser = argparse.ArgumentParser(); parser.add_argument("--input", required=True); parser.add_argument("--output-dir", required=True); parser.add_argument("--params", default="{}")
    args = parser.parse_args(); root = Path(__file__).parent; require_model(root)
    import torch
    from torchvision import transforms
    from transformers import AutoModelForImageSegmentation
    device = select_device(torch)
    detail = torch.cuda.get_device_name(0) if device == "cuda" else "CPU"
    print(f"PROGRESS 5 device={device} ({detail})", flush=True)
    model = AutoModelForImageSegmentation.from_pretrained(root / "model", trust_remote_code=True).to(device).eval()
    image = Image.open(args.input).convert("RGB")
    original_size = image.size
    tensor = transforms.Compose([transforms.Resize((2048, 2048)), transforms.ToTensor()])(image).unsqueeze(0).to(device)
    with torch.no_grad(): prediction = model(tensor)[-1].sigmoid().cpu()[0].squeeze(0)
    # BILINEAR rather than LANCZOS: against a 50 MP frame the two mattes differ by a mean of
    # 0.014/255, and the handful of pixels that move at all sit inside the antialiased edge.
    alpha = transforms.ToPILImage()(prediction).resize(original_size, Image.Resampling.BILINEAR)
    output = Path(args.output_dir); output.mkdir(parents=True, exist_ok=True)
    # A matte is large flat runs of 0 and 255; the default filter+compression search spends
    # seconds to shave a file that is already tiny next to the RGBA page it replaces.
    alpha.save(output / "mask.png", optimize=False, compress_level=1)
    print("PROGRESS 100 product cutout complete", flush=True)

if __name__ == "__main__": main()
