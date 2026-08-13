"""Build the explicit Slot 3 + Slot 4 candidate for hat-ps-shadow-v2.5.

The resulting package stays outside config/product-main-shadows and is deliberately
non-publishable.  It combines the already-published v2.4 Slots 1/2 baseline with
the separately calibrated Slot 3 and Slot 4 candidates, then re-runs the normal
repository validator across every preset/gold pair.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
from copy import deepcopy
from pathlib import Path
from typing import Any

from PIL import Image


VERSION = "hat-ps-shadow-v2.5"
WHITE_SAMPLE_POLICY = {
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
REQUIRED_GATES = (
    "whitePoint",
    "sampleOutsideMask",
    "photoshopShadowParity",
    "birefnetMask",
    "productBox",
    "opaqueProductCore",
    "outsideProductAndRoiWhite",
)
ADAPTIVE_GATES = REQUIRED_GATES + ("roiBoundary", "detachedBackgroundResidue", "outputOpaqueRgb")
ASSETS = {
    "input": ("input.png", "input"),
    "product": ("product.png", "product"),
    "ps-mask": ("mask.png", "mask"),
    "shadow": ("shadow.png", "shadow"),
    "preview": ("preview.png", "preview"),
}


def fail(message: str) -> None:
    raise RuntimeError(message)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical_digest(value: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        fail(f"JSON object required: {path}")
    return value


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def ensure_file(path: Path, expected: str | None = None) -> Path:
    if not path.is_file():
        fail(f"required source file is missing: {path}")
    actual = digest(path)
    if expected is not None and actual != expected:
        fail(f"source hash mismatch: {path}")
    return path


def copy_pinned(source: Path, stage: Path, relative: str, expected: str | None = None) -> tuple[str, str]:
    ensure_file(source, expected)
    destination = stage / relative
    if destination.exists():
        fail(f"duplicate package destination: {relative}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    actual = digest(destination)
    if expected is not None and actual != expected:
        fail(f"copied hash mismatch: {relative}")
    return destination.relative_to(stage).as_posix(), actual


def assert_same_rgb(first: Path, second: Path, label: str) -> None:
    with Image.open(first) as first_image, Image.open(second) as second_image:
        first_rgb = first_image.convert("RGB")
        second_rgb = second_image.convert("RGB")
        if first_rgb.size != second_rgb.size or first_rgb.tobytes() != second_rgb.tobytes():
            fail(f"RGB pixels differ: {label}")


def box_from_mask(path: Path) -> dict[str, float]:
    with Image.open(path) as image:
        pixels = image.convert("L")
        width, height = pixels.size
        if (width, height) != (800, 800):
            fail(f"product-box evidence must be 800x800: {path}")
        coordinates = [(x, y) for y in range(height) for x in range(width) if pixels.getpixel((x, y)) >= 128]
    if not coordinates:
        fail(f"product-box evidence has no foreground pixels: {path}")
    xs = [value[0] for value in coordinates]
    ys = [value[1] for value in coordinates]
    left, top, right, bottom = min(xs), min(ys), max(xs) + 1, max(ys) + 1
    return {"left": left / 800, "top": top / 800, "width": (right - left) / 800, "height": (bottom - top) / 800}


def assert_passed_gates(report: dict[str, Any], required: tuple[str, ...], source_id: str) -> None:
    gates = report.get("automaticGates")
    if not isinstance(gates, dict):
        fail(f"automatic gates missing: {source_id}")
    for name in required:
        gate = gates.get(name)
        if not isinstance(gate, dict) or gate.get("passed") is not True:
            fail(f"automatic gate failed or missing: {source_id} / {name}")


def validate_baseline(bundle: Path) -> dict[str, Any]:
    manifest = read_json(bundle / "manifest.json")
    registry = read_json(bundle.parent / "registry.json")
    if manifest.get("version") != "hat-ps-shadow-v2.4":
        fail("v2.5 must use the published v2.4 package as its baseline")
    if any(manifest.get(name) != value for name, value in {
        "candidateOnly": False, "releaseState": "approved", "approved": True, "publicationAllowed": True,
    }.items()):
        fail("baseline is not approved for production")
    pins = [item for item in registry.get("packages", []) if item.get("version") == manifest["version"]]
    if len(pins) != 1 or pins[0].get("manifestSha256") != canonical_digest(manifest):
        fail("baseline manifest is not pinned exactly once")
    for asset in manifest.get("regressionAssets", []):
        ensure_file(bundle / asset["file"], asset["sha256"])
    for gold in manifest.get("goldStandards", []):
        ensure_file(bundle / gold["psdPath"], gold["psdSha256"])
    return manifest


def candidate_status(value: dict[str, Any], label: str) -> None:
    expected = {"releaseState": "awaiting-human-approval", "approved": False, "publicationAllowed": False}
    if any(value.get(name) != wanted for name, wanted in expected.items()):
        fail(f"{label} is not a non-publishable awaiting-approval candidate")


def slot3_spec(root: Path) -> dict[str, Any]:
    summary = read_json(root / "candidate-summary.json")
    candidate_status(summary, "Slot 3 candidate summary")
    if summary.get("candidateVersion") != VERSION or summary.get("angleSlot") != 3:
        fail("Slot 3 candidate version or angle slot is not v2.5 / 3")
    label = summary.get("humanAngleLabel")
    gold_ids = summary.get("goldStandardIds")
    if not isinstance(label, str) or not label or gold_ids != ["329a8210", "329a8219"]:
        fail("Slot 3 label or gold IDs are invalid")
    return {
        "slot": 3,
        "label": label,
        "root": root,
        "summary": summary,
        "goldIds": gold_ids,
        "roi": summary.get("roi"),
        "whitePoint": summary.get("whitePoint"),
        "samples": [
            {"sourceId": "329A8210", "goldId": "329a8210", "gatesDir": "calibration-gates-v4", "psdDir": "photoshop-candidate-v4"},
            {"sourceId": "329A8219", "goldId": "329a8219", "gatesDir": "calibration-gates-v4", "psdDir": "photoshop-candidate-v4"},
        ],
        "adaptive": False,
        "reference": root / summary["visualStyleReference"]["path"],
        "referenceHash": summary["visualStyleReference"].get("sha256"),
        "evidence": [
            ("slot3-source-summary", root / "candidate-summary.json", "evidence/slot3-source-summary.json"),
            ("slot3-comparison", root / "slot3-black-blue-side-by-side.png", "evidence/slot3-comparison.png"),
            ("slot3-reference-comparison", root / "slot3-v1-reference-candidate.png", "evidence/slot3-reference-comparison.png"),
            ("slot3-reference-snapshot", root / "reference" / "reference-snapshot-report.json", "evidence/slot3-reference-snapshot.json"),
        ],
    }


def slot4_spec(root: Path) -> dict[str, Any]:
    status = read_json(root / "candidate-status.json")
    if (status.get("releaseState") != "awaiting-package-lineage" or status.get("approved") is not False
            or status.get("publicationAllowed") is not False or status.get("candidateOnly") is not True
            or status.get("packageBuilt") is not False):
        fail("Slot 4 development status is not a non-publishable package-lineage candidate")
    if status.get("developmentIdentity") != "slot-4-development" or status.get("angleSlot") != 4:
        fail("Slot 4 candidate does not carry the expected development identity")
    ids = ["slot4-black-329a8211", "slot4-blue-329a8220", "slot4-purple-329a8233"]
    if status.get("goldStandardIds") != ids:
        fail("Slot 4 gold IDs are invalid")
    sample_reports = [
        read_json(root / source / "full-canvas-run" / "calibration-gates" / "report.json")
        for source in ("329A8211", "329A8220", "329A8233")
    ]
    labels = {report.get("humanAngleLabel") for report in sample_reports}
    if labels != {"俯视"}:
        fail("Slot 4 human angle label is absent or inconsistent")
    return {
        "slot": 4,
        "label": "俯视",
        "root": root,
        "summary": status,
        "goldIds": ids,
        "roi": {"x": 0, "y": 0, "width": 800, "height": 800},
        "whiteSamplePolicy": WHITE_SAMPLE_POLICY,
        "samples": [
            {"sourceId": "329A8211", "goldId": ids[0], "gatesDir": "full-canvas-run/calibration-gates", "psdDir": "full-canvas-run/photoshop-candidate"},
            {"sourceId": "329A8220", "goldId": ids[1], "gatesDir": "full-canvas-run/calibration-gates", "psdDir": "full-canvas-run/photoshop-candidate"},
            {"sourceId": "329A8233", "goldId": ids[2], "gatesDir": "full-canvas-run/calibration-gates", "psdDir": "full-canvas-run/photoshop-candidate"},
        ],
        "adaptive": True,
        "reference": root / "reference" / "1440-8.png",
        "referenceHash": digest(root / "reference" / "1440-8.png"),
        "evidence": [
            ("slot4-candidate-status", root / "candidate-status.json", "evidence/slot4-candidate-status.json"),
            ("slot4-comparison", root / "slot-4-v1-photoshop-native-all-colours.png", "evidence/slot4-comparison.png"),
            ("slot4-product-box-evidence", root / "photoshop-product-box-evidence.json", "evidence/slot4-product-box-evidence.json"),
        ],
    }


def add_candidate_slot(
    spec: dict[str, Any],
    stage: Path,
    regression_assets: list[dict[str, str]],
    gold_standards: list[dict[str, Any]],
    candidate_evidence: list[dict[str, str]],
) -> dict[str, Any]:
    root: Path = spec["root"]
    for evidence_id, source, destination in spec["evidence"]:
        relative, actual = copy_pinned(source, stage, destination)
        candidate_evidence.append({"id": evidence_id, "file": relative, "sha256": actual})

    for sample in spec["samples"]:
        source_id = sample["sourceId"]
        gold_id = sample["goldId"]
        gates = root / source_id / sample["gatesDir"]
        report = read_json(gates / "report.json")
        candidate_status(report, f"{source_id} gate report")
        if report.get("sourceId") != source_id or report.get("goldId") != gold_id or report.get("angleSlot") != spec["slot"]:
            fail(f"identity mismatch in gate report: {source_id}")
        if spec["adaptive"]:
            if report.get("whiteSamplePolicy") != WHITE_SAMPLE_POLICY:
                fail(f"Slot 4 white-sample policy mismatch: {source_id}")
            assert_passed_gates(report, ADAPTIVE_GATES, source_id)
        else:
            if report.get("presetVersion") != VERSION or report.get("whitePoint") != spec["whitePoint"]:
                fail(f"Slot 3 preset version or white point mismatch: {source_id}")
            assert_passed_gates(report, REQUIRED_GATES, source_id)
        if report.get("automaticGatesPassed") is not True:
            fail(f"automatic gates did not pass: {source_id}")

        source_input = gates / "input.png"
        v1 = ensure_file(Path(report["v1"]["path"]), report["v1"]["sha256"])
        ensure_file(source_input)
        assert_same_rgb(source_input, v1, f"{source_id} packaged input vs V1")
        psd = root / source_id / sample["psdDir"] / "calibration.psd"
        relative_psd, psd_hash = copy_pinned(psd, stage, f"gold-psd/{gold_id}.psd", report["approvedPsd"]["sha256"])
        mask = root / "masks" / f"{source_id}-birefnet-mask.png"
        ensure_file(mask, report["birefnetMask"]["sha256"])

        for suffix, (filename, kind) in ASSETS.items():
            source = source_input if suffix == "input" else gates / filename
            relative, actual = copy_pinned(source, stage, f"regression/{gold_id}-{suffix}.png")
            regression_assets.append({"id": f"{gold_id}-{suffix}", "kind": kind, "file": relative, "sha256": actual})
        relative, actual = copy_pinned(mask, stage, f"regression/{gold_id}-birefnet-mask.png", report["birefnetMask"]["sha256"])
        regression_assets.append({"id": f"{gold_id}-birefnet-mask", "kind": "mask", "file": relative, "sha256": actual})

        product_box = report["automaticGates"]["productBox"].get("associatedGold")
        if not isinstance(product_box, dict):
            fail(f"product-box source missing: {source_id}")
        product_mask = root / source_id / sample["psdDir"] / "product-mask.png"
        if box_from_mask(product_mask) != product_box:
            fail(f"product-box evidence does not match report: {source_id}")
        relative_mask, product_mask_hash = copy_pinned(product_mask, stage, f"evidence/{gold_id}-product-box-mask.png")
        candidate_evidence.append({"id": f"{gold_id}-product-box-mask", "file": relative_mask, "sha256": product_mask_hash})
        relative_report, report_hash = copy_pinned(gates / "report.json", stage, f"evidence/{gold_id}-gate-report.json")
        candidate_evidence.append({"id": f"{gold_id}-gate-report", "file": relative_report, "sha256": report_hash})

        gold_standards.append({
            "id": gold_id,
            "psdPath": relative_psd,
            "sourcePsdPath": report["approvedPsd"]["path"],
            "psdSha256": psd_hash,
            "layerNames": report["layerNames"],
            "productBox": product_box,
        })

    preset: dict[str, Any] = {
        "id": f"hat-angle-slot-{spec['slot']}",
        "angleSlot": spec["slot"],
        "humanAngleLabel": spec["label"],
        "approved": False,
        "goldStandardIds": spec["goldIds"],
        "roi": spec["roi"],
        "releaseState": "awaiting-human-approval",
        "publicationAllowed": False,
    }
    if spec["adaptive"]:
        preset["whiteSamplePolicy"] = spec["whiteSamplePolicy"]
    else:
        preset["whitePoint"] = spec["whitePoint"]
    return preset


def make_writable(root: Path) -> None:
    for path in root.rglob("*"):
        if path.is_file():
            path.chmod(stat.S_IREAD | stat.S_IWRITE)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-bundle", type=Path, default=Path("config/product-main-shadows/hat-ps-shadow-v2.4"))
    parser.add_argument("--slot3-root", type=Path, required=True)
    parser.add_argument("--slot4-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    repo = Path(__file__).resolve().parents[1]
    baseline = args.baseline_bundle.resolve()
    output = args.output_dir.resolve()
    config = (repo / "config").resolve()
    if config in output.parents or output.exists():
        fail("candidate output must be a new directory outside config")
    if not output.parent.exists():
        output.parent.mkdir(parents=True)
    baseline_manifest = validate_baseline(baseline)
    slot3 = slot3_spec(args.slot3_root.resolve())
    slot4 = slot4_spec(args.slot4_root.resolve())

    stage = Path(tempfile.mkdtemp(prefix=f".{VERSION}-building-", dir=output.parent))
    complete = False
    try:
        regression_assets: list[dict[str, str]] = []
        gold_standards: list[dict[str, Any]] = []
        for asset in baseline_manifest["regressionAssets"]:
            relative, actual = copy_pinned(baseline / asset["file"], stage, asset["file"], asset["sha256"])
            regression_assets.append({"id": asset["id"], "kind": asset["kind"], "file": relative, "sha256": actual})
        for gold in baseline_manifest["goldStandards"]:
            relative, actual = copy_pinned(baseline / gold["psdPath"], stage, f"gold-psd/{gold['id']}.psd", gold["psdSha256"])
            copied = deepcopy(gold)
            copied["sourcePsdPath"] = gold["psdPath"]
            copied["psdPath"] = relative
            copied["psdSha256"] = actual
            gold_standards.append(copied)

        candidate_evidence: list[dict[str, str]] = []
        slot3_preset = add_candidate_slot(slot3, stage, regression_assets, gold_standards, candidate_evidence)
        slot4_preset = add_candidate_slot(slot4, stage, regression_assets, gold_standards, candidate_evidence)
        summary = {
            "schemaVersion": 1,
            "candidateVersion": VERSION,
            "baselineVersion": baseline_manifest["version"],
            "releaseState": "awaiting-human-approval",
            "approved": False,
            "publicationAllowed": False,
            "slots": [
                {"angleSlot": 3, "humanAngleLabel": slot3_preset["humanAngleLabel"], "goldStandardIds": slot3_preset["goldStandardIds"]},
                {"angleSlot": 4, "humanAngleLabel": slot4_preset["humanAngleLabel"], "goldStandardIds": slot4_preset["goldStandardIds"]},
            ],
            "automaticGatesPassed": True,
            "note": "Slot 3 source candidate package had stale pinned evidence; this new v2.5 candidate rebuilds evidence hashes and revalidates all Slot 1–4 pairs.",
        }
        write_json(stage / "evidence" / "candidate-summary.json", summary)
        candidate_evidence.insert(0, {"id": "candidate-summary", "file": "evidence/candidate-summary.json", "sha256": digest(stage / "evidence" / "candidate-summary.json")})

        reference_files = []
        for name, spec in (("slot3", slot3), ("slot4", slot4)):
            relative, actual = copy_pinned(spec["reference"], stage, f"visual-style-reference/{name}-{spec['reference'].name}", spec["referenceHash"])
            reference_files.append({"id": name, "file": relative, "sha256": actual, "role": "visual-style-reference-only", "isGoldStandard": False})
        slot3_reference = next(item for item in reference_files if item["id"] == "slot3")
        slot4_reference = next(item for item in reference_files if item["id"] == "slot4")
        candidate_evidence.append({"id": "slot3-visual-style-reference", "file": slot3_reference["file"], "sha256": slot3_reference["sha256"]})

        manifest = {
            "schemaVersion": 3,
            "version": VERSION,
            "candidateOnly": True,
            "releaseState": "awaiting-human-approval",
            "approved": False,
            "publicationAllowed": False,
            "canvas": deepcopy(baseline_manifest["canvas"]),
            "algorithm": deepcopy(baseline_manifest["algorithm"]),
            "biRefNet": deepcopy(baseline_manifest["biRefNet"]),
            "gates": deepcopy(baseline_manifest["gates"]),
            "goldStandards": gold_standards,
            "presets": [*deepcopy(baseline_manifest["presets"]), slot3_preset, slot4_preset],
            "regressionAssets": regression_assets,
            "visualStyleReference": {
                "file": slot4_reference["file"],
                "sha256": slot4_reference["sha256"],
                "artboard": "Slot 4 visual style reference",
                "role": "visual-style-reference-only",
                "isGoldStandard": False,
            },
            "candidateEvidence": candidate_evidence,
            "provenance": {
                "baselineVersion": baseline_manifest["version"],
                "baselineManifestSha256": canonical_digest(baseline_manifest),
                "slot3SourceSummarySha256": digest(slot3["root"] / "candidate-summary.json"),
                "slot4CandidateStatusSha256": digest(slot4["root"] / "candidate-status.json"),
            },
        }
        write_json(stage / "manifest.json", manifest)
        manifest_hash = canonical_digest(manifest)
        registry = {
            "schemaVersion": 1,
            "candidateOnly": True,
            "releaseState": "awaiting-human-approval",
            "approved": False,
            "publicationAllowed": False,
            "packages": [{"version": VERSION, "manifestSha256": manifest_hash}],
        }
        write_json(stage / "candidate-registry.json", registry)

        validator = repo / "scripts" / "validate-product-main-shadow-preset.py"
        candidate_run = subprocess.run([sys.executable, str(validator), "--bundle", str(stage), "--registry", str(stage / "candidate-registry.json"), "--candidate-mode", "--require-gold-psd"], capture_output=True, text=True, encoding="utf-8")
        if candidate_run.returncode != 0:
            fail(f"candidate validation failed:\n{candidate_run.stdout}\n{candidate_run.stderr}")
        publication_run = subprocess.run([sys.executable, str(validator), "--bundle", str(stage), "--registry", str(stage / "candidate-registry.json"), "--require-gold-psd"], capture_output=True, text=True, encoding="utf-8")
        if publication_run.returncode == 0:
            fail("unapproved candidate was accepted in publication mode")
        write_json(stage / "candidate-validation-report.json", {
            "schemaVersion": 1,
            "candidateVersion": VERSION,
            "manifestSha256": manifest_hash,
            "candidateRegistryPinned": True,
            "candidateModePassed": True,
            "publicationModeRejected": True,
            "releaseState": "awaiting-human-approval",
            "approved": False,
            "publicationAllowed": False,
            "goldStandardCount": len(gold_standards),
            "regressionAssetCount": len(regression_assets),
            "validatorReport": json.loads(candidate_run.stdout),
            "publicationRejection": (publication_run.stderr or publication_run.stdout).strip().splitlines()[-1],
        })
        stage.replace(output)
        for file in output.rglob("*"):
            if file.is_file():
                file.chmod(stat.S_IREAD | stat.S_IRGRP | stat.S_IROTH)
                if os.name == "nt" and not (getattr(file.stat(), "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_READONLY):
                    fail(f"failed to mark candidate file read-only: {file}")
        complete = True
        print(json.dumps({"output": str(output), "version": VERSION, "manifestSha256": manifest_hash, "goldStandardCount": len(gold_standards), "regressionAssetCount": len(regression_assets), "candidateModePassed": True, "publicationModeRejected": True, "allFilesReadOnly": True}, ensure_ascii=False, indent=2))
    finally:
        if not complete and stage.exists():
            make_writable(stage)
            shutil.rmtree(stage)


if __name__ == "__main__":
    main()
