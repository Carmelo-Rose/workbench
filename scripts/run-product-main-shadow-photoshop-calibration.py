"""Run the repository Photoshop calibration JSX for one pinned candidate request."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pythoncom
import win32com.client


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
CANDIDATE_ROOT = (REPOSITORY_ROOT / "tmp/product-main-shadow-candidates").resolve()
JSX_PATH = Path(__file__).with_name("calibrate-product-main-shadow.jsx")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("request", type=Path)
    args = parser.parse_args()
    request_path = args.request.resolve(strict=True)
    request_path.relative_to(CANDIDATE_ROOT)
    request = json.loads(request_path.read_text(encoding="utf-8"))
    if request.get("presetVersion") != "slot-4-development" or request.get("developmentIdentity") != "slot-4-development":
        raise RuntimeError("controlled Photoshop runner accepts only the explicit slot-4-development identity")
    if not isinstance(request.get("angleSlot"), int) or not 1 <= request["angleSlot"] <= 6:
        raise RuntimeError("controlled Photoshop runner requires an explicit angleSlot from 1 through 6")
    if not isinstance(request.get("angleLabel"), str) or not request["angleLabel"].strip():
        raise RuntimeError("controlled Photoshop runner requires a human angle label")
    if not isinstance(request.get("roi"), dict) or not request.get("whiteSamplePolicy"):
        raise RuntimeError("controlled Photoshop runner requires explicit ROI and whiteSamplePolicy")
    gold_ids = request.get("goldStandardIds")
    if not isinstance(gold_ids, list) or len(gold_ids) < 2 or len(set(gold_ids)) != len(gold_ids):
        raise RuntimeError("controlled Photoshop runner requires at least two unique gold IDs")
    output_dir = Path(request["outputDir"]).resolve()
    output_dir.relative_to(request_path.parent)
    if output_dir.exists():
        raise RuntimeError(f"candidate output already exists: {output_dir}")

    jsx = JSX_PATH.read_text(encoding="utf-8")
    request_literal = json.dumps(str(request_path), ensure_ascii=True)
    script = '$.setenv("WORKBENCH_SHADOW_CALIBRATION_REQUEST", ' + request_literal + ");\n" + jsx
    pythoncom.CoInitialize()
    try:
        photoshop = win32com.client.Dispatch("Photoshop.Application")
        photoshop.DoJavaScript(script)
    finally:
        pythoncom.CoUninitialize()
    print(output_dir)


if __name__ == "__main__":
    main()
