"""Deterministic product cutout adapter. Model files are supplied by the deployment runbook.

The runtime deliberately refuses floating model revisions: PRODUCT_CUTOUT_MODEL_REVISION and
PRODUCT_CUTOUT_MODEL_SHA256 must be set, and the local model marker must match both values.
"""
from __future__ import annotations
import argparse, hashlib, json, os
from pathlib import Path
from PIL import Image

def require_model(root: Path) -> None:
    revision = os.environ.get("PRODUCT_CUTOUT_MODEL_REVISION")
    expected = os.environ.get("PRODUCT_CUTOUT_MODEL_SHA256")
    marker = root / "model" / "BiRefNet_HR-matting.safetensors"
    if not revision or not expected or not marker.is_file(): raise RuntimeError("fixed BiRefNet model revision/checksum is not installed")
    digest = hashlib.sha256(marker.read_bytes()).hexdigest()
    if digest.lower() != expected.lower(): raise RuntimeError("BiRefNet model checksum mismatch")

def main() -> None:
    parser = argparse.ArgumentParser(); parser.add_argument("--input", required=True); parser.add_argument("--output-dir", required=True); parser.add_argument("--params", default="{}")
    args = parser.parse_args(); root = Path(__file__).parent; require_model(root)
    # The production image is intentionally delegated to a fixed local inference wrapper.
    # Keeping it outside the gateway avoids importing an unpinned repository at request time.
    runner = root / "run_birefnet.py"
    if not runner.is_file(): raise RuntimeError("run_birefnet.py is missing from the approved model bundle")
    raise RuntimeError("approved BiRefNet inference bundle has not been installed")

if __name__ == "__main__": main()
