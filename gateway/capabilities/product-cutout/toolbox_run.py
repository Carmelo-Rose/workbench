"""Deterministic product cutout adapter. Model files are supplied by the deployment runbook.

The runtime deliberately refuses floating model revisions: PRODUCT_CUTOUT_MODEL_REVISION and
PRODUCT_CUTOUT_MODEL_SHA256 must be set, and the local model marker must match both values.
"""
from __future__ import annotations
import argparse, hashlib, os
from pathlib import Path
from PIL import Image

MODEL_ID = "ZhengPeng7/BiRefNet_HR-matting"
MODEL_REVISION = "5d6b6f8adcb5b417c871b1d84ceaae9871355b7f"

def require_model(root: Path) -> Path:
    if os.environ.get("PRODUCT_CUTOUT_MODEL_REVISION", MODEL_REVISION) != MODEL_REVISION:
        raise RuntimeError("BiRefNet model revision is not approved")
    weights = next((root / "model").rglob("*.safetensors"), None)
    checksum = root / "model.sha256"
    if weights is None or not checksum.is_file(): raise RuntimeError("fixed BiRefNet model revision/checksum is not installed")
    if hashlib.sha256(weights.read_bytes()).hexdigest().lower() != checksum.read_text(encoding="ascii").strip().lower():
        raise RuntimeError("BiRefNet model checksum mismatch")
    return weights

def main() -> None:
    parser = argparse.ArgumentParser(); parser.add_argument("--input", required=True); parser.add_argument("--output-dir", required=True); parser.add_argument("--params", default="{}")
    args = parser.parse_args(); root = Path(__file__).parent; require_model(root)
    import torch
    from torchvision import transforms
    from transformers import AutoModelForImageSegmentation
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = AutoModelForImageSegmentation.from_pretrained(root / "model", trust_remote_code=True).to(device).eval()
    image = Image.open(args.input).convert("RGB")
    original_size = image.size
    tensor = transforms.Compose([transforms.Resize((2048, 2048)), transforms.ToTensor()])(image).unsqueeze(0).to(device)
    with torch.no_grad(): prediction = model(tensor)[-1].sigmoid().cpu()[0].squeeze(0)
    alpha = transforms.ToPILImage()(prediction).resize(original_size, Image.Resampling.LANCZOS)
    image.putalpha(alpha)
    output = Path(args.output_dir); output.mkdir(parents=True, exist_ok=True)
    image.save(output / "cutout.png")
    print("PROGRESS 100 product cutout complete", flush=True)

if __name__ == "__main__": main()
