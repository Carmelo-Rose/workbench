"""Build a self-contained, registry-pinned, deliberately non-publishable shadow candidate."""
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


TARGET_VERSION = "hat-ps-shadow-v2.3"
BASELINE_VERSION = "hat-ps-shadow-v2.1"
SLOT3_GOLD_IDS = ("329a8210", "329a8219")
REQUIRED_GATE_NAMES = (
    "whitePoint",
    "sampleOutsideMask",
    "photoshopShadowParity",
    "birefnetMask",
    "productBox",
    "opaqueProductCore",
    "outsideProductAndRoiWhite",
)
ASSET_SOURCES = {
    "input": ("input.png", "input"),
    "product": ("product.png", "product"),
    "ps-mask": ("mask.png", "mask"),
    "shadow": ("shadow.png", "shadow"),
    "preview": ("preview.png", "preview"),
}


def fail(message: str) -> None:
    raise RuntimeError(message)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def manifest_sha256(value: dict[str, Any]) -> str:
    canonical = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        fail(f"JSON root must be an object: {path}")
    return value


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def is_within(child: Path, parent: Path) -> bool:
    return child == parent or parent in child.parents


def validate_destination(repo_root: Path, candidate_root: Path, output_dir: Path) -> tuple[Path, Path]:
    repo = repo_root.resolve()
    candidate = candidate_root.resolve()
    output = output_dir.resolve()
    config = (repo / "config").resolve()
    if is_within(candidate, config) or is_within(output, config):
        fail("candidate packages must never be written under config")
    if output == candidate or not is_within(output, candidate):
        fail("output directory must be a new child of the candidate root")
    if not candidate.is_dir():
        fail(f"candidate root does not exist: {candidate}")
    if output.exists():
        fail(f"output directory already exists; refusing to overwrite: {output}")
    return candidate, output


def checked_file(path: Path, expected_hash: str | None = None) -> Path:
    if not path.is_file():
        fail(f"required source file is missing: {path}")
    if expected_hash is not None and sha256(path) != expected_hash:
        fail(f"source hash mismatch: {path}")
    return path


def assert_same_rgb_pixels(first: Path, second: Path, label: str) -> None:
    with Image.open(first) as first_image, Image.open(second) as second_image:
        first_rgb = first_image.convert("RGB")
        second_rgb = second_image.convert("RGB")
        if first_rgb.size != second_rgb.size or first_rgb.tobytes() != second_rgb.tobytes():
            fail(f"RGB pixels differ: {label}")


def copy_pinned(source: Path, stage: Path, relative: str, expected_hash: str | None = None) -> tuple[str, str]:
    checked_file(source, expected_hash)
    destination = stage / Path(relative)
    if destination.exists():
        fail(f"duplicate package destination: {relative}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    actual = sha256(destination)
    if expected_hash is not None and actual != expected_hash:
        fail(f"copied file hash mismatch: {relative}")
    return destination.relative_to(stage).as_posix(), actual


def validate_baseline(baseline: Path) -> dict[str, Any]:
    manifest = load_json(baseline / "manifest.json")
    if manifest.get("schemaVersion") != 1 or manifest.get("version") != BASELINE_VERSION:
        fail("baseline must be the immutable schema-v1 hat-ps-shadow-v2.1 bundle")
    golds = manifest.get("goldStandards")
    presets = manifest.get("presets")
    assets = manifest.get("regressionAssets")
    if not isinstance(golds, list) or len(golds) != 2 or not isinstance(presets, list) or len(presets) != 1:
        fail("baseline must contain exactly two gold standards and one preset")
    if presets[0].get("angleSlot") != 2 or presets[0].get("approved") is not True:
        fail("baseline slot 2 preset must remain approved")
    if not isinstance(assets, list) or len(assets) != 12:
        fail("baseline must contain exactly twelve regression assets")
    baseline_registry = load_json(baseline.parent / "registry.json")
    pins = [item for item in baseline_registry.get("packages", []) if item.get("version") == BASELINE_VERSION]
    if len(pins) != 1 or pins[0].get("manifestSha256") != manifest_sha256(manifest):
        fail("baseline manifest is not pinned exactly once by the production registry")
    for item in assets:
        source = baseline / item["file"]
        checked_file(source, item["sha256"])
    for gold in golds:
        checked_file(Path(gold["psdPath"]), gold["psdSha256"])
    return manifest


def candidate_evidence_sources(candidate_root: Path) -> list[tuple[str, Path, str]]:
    values: list[tuple[str, Path, str]] = [
        ("candidate-summary", candidate_root / "candidate-summary.json", "evidence/candidate-summary.json"),
        ("reference-snapshot-report", candidate_root / "reference/reference-snapshot-report.json", "evidence/reference-snapshot-report.json"),
        ("reference-visible", candidate_root / "reference/1-copy-visible-reference.png", "evidence/1-copy-visible-reference.png"),
        ("slot3-black-blue-comparison", candidate_root / "slot3-black-blue-side-by-side.png", "evidence/slot3-black-blue-side-by-side.png"),
        ("slot3-reference-comparison", candidate_root / "slot3-v1-reference-candidate.png", "evidence/slot3-v1-reference-candidate.png"),
    ]
    for source_id in ("329A8210", "329A8219"):
        gold_id = source_id.lower()
        values.extend([
            (f"{gold_id}-gate-report", candidate_root / source_id / "calibration-gates-v4/report.json", f"evidence/{source_id}-gate-report.json"),
            (f"{gold_id}-candidate-preset", candidate_root / source_id / "calibration-gates-v4/candidate-preset.json", f"evidence/{source_id}-candidate-preset.json"),
            (f"{gold_id}-side-by-side", candidate_root / source_id / "calibration-gates-v4/side-by-side.png", f"evidence/{source_id}-side-by-side.png"),
            (f"{gold_id}-photoshop-report", candidate_root / source_id / "photoshop-candidate-v4/photoshop-report.json", f"evidence/{source_id}-photoshop-report.json"),
        ])
    return values


def build_package(repo_root: Path, baseline_bundle: Path, candidate_root: Path, output_dir: Path, candidate_version: str) -> dict[str, Any]:
    if candidate_version != TARGET_VERSION:
        fail(f"this builder is locked to {TARGET_VERSION}")
    candidate, output = validate_destination(repo_root, candidate_root, output_dir)
    baseline = baseline_bundle.resolve()
    baseline_manifest = validate_baseline(baseline)
    summary = load_json(candidate / "candidate-summary.json")
    required_summary = {
        "schemaVersion": 2,
        "candidateVersion": TARGET_VERSION,
        "releaseState": "awaiting-human-approval",
        "approved": False,
        "publicationAllowed": False,
        "angleSlot": 3,
        "automaticGatesPassed": True,
    }
    if any(summary.get(key) != value for key, value in required_summary.items()):
        fail("candidate summary release state or automatic gate status is invalid")
    if summary.get("goldStandardIds") != list(SLOT3_GOLD_IDS):
        fail("candidate summary must bind the two slot 3 gold standards")

    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f".{output.name}-building-", dir=output.parent)).resolve()
    if not is_within(stage, candidate):
        fail("temporary build directory escaped the candidate root")
    completed = False
    try:
        regression_assets: list[dict[str, str]] = []
        gold_standards: list[dict[str, Any]] = []

        for item in baseline_manifest["regressionAssets"]:
            relative, actual = copy_pinned(baseline / item["file"], stage, item["file"], item["sha256"])
            regression_assets.append({"id": item["id"], "kind": item["kind"], "file": relative, "sha256": actual})

        for gold in baseline_manifest["goldStandards"]:
            source_psd = Path(gold["psdPath"])
            relative, actual = copy_pinned(source_psd, stage, f"gold-psd/{gold['id']}.psd", gold["psdSha256"])
            packaged_gold = deepcopy(gold)
            packaged_gold["sourcePsdPath"] = gold["psdPath"]
            packaged_gold["psdPath"] = relative
            packaged_gold["psdSha256"] = actual
            gold_standards.append(packaged_gold)

        slot3_preset: dict[str, Any] | None = None
        for source_id, gold_id in zip(("329A8210", "329A8219"), SLOT3_GOLD_IDS, strict=True):
            gates_root = candidate / source_id / "calibration-gates-v4"
            report = load_json(gates_root / "report.json")
            preset = load_json(gates_root / "candidate-preset.json")
            expected_report = {
                "schemaVersion": 2,
                "releaseState": "awaiting-human-approval",
                "approved": False,
                "publicationAllowed": False,
                "goldId": gold_id,
                "presetVersion": TARGET_VERSION,
                "angleSlot": 3,
                "automaticGatesPassed": True,
            }
            if any(report.get(key) != value for key, value in expected_report.items()):
                fail(f"slot 3 report state is invalid: {gold_id}")
            automatic = report.get("automaticGates")
            if not isinstance(automatic, dict) or any(not isinstance(automatic.get(name), dict) or automatic[name].get("passed") is not True for name in REQUIRED_GATE_NAMES):
                fail(f"slot 3 report does not pass every required automatic gate: {gold_id}")
            if preset.get("id") != "hat-angle-slot-3" or preset.get("approved") is not False or preset.get("goldStandardIds") != list(SLOT3_GOLD_IDS):
                fail(f"slot 3 candidate preset is invalid: {gold_id}")
            if preset.get("releaseState") != "awaiting-human-approval" or preset.get("publicationAllowed") is not False:
                fail(f"slot 3 candidate preset is publishable: {gold_id}")
            if preset.get("roi") != summary.get("roi") or preset.get("whitePoint") != summary.get("whitePoint"):
                fail(f"slot 3 candidate coordinates disagree with summary: {gold_id}")
            if slot3_preset is None:
                slot3_preset = preset
            elif preset != slot3_preset:
                fail("slot 3 black and blue candidate presets disagree")

            source_psd = candidate / source_id / "photoshop-candidate-v4/calibration.psd"
            relative_psd, psd_hash = copy_pinned(source_psd, stage, f"gold-psd/{gold_id}.psd", report["approvedPsd"]["sha256"])
            source_input = gates_root / "input.png"
            checked_file(source_input)
            original_input = checked_file(Path(report["v1"]["path"]), report["v1"]["sha256"])
            assert_same_rgb_pixels(source_input, original_input, f"{gold_id} packaged input vs V1 source")
            source_mask = candidate / "masks" / f"{source_id}-birefnet-mask.png"
            checked_file(source_mask, report["birefnetMask"]["sha256"])

            for suffix, (filename, kind) in ASSET_SOURCES.items():
                relative, actual = copy_pinned(source_input if suffix == "input" else gates_root / filename, stage, f"regression/{source_id}-{suffix}.png")
                regression_assets.append({"id": f"{gold_id}-{suffix}", "kind": kind, "file": relative, "sha256": actual})
            relative, actual = copy_pinned(source_mask, stage, f"regression/{source_id}-birefnet-mask.png", report["birefnetMask"]["sha256"])
            regression_assets.append({"id": f"{gold_id}-birefnet-mask", "kind": "mask", "file": relative, "sha256": actual})

            associated_box = automatic["productBox"].get("associatedGold")
            if not isinstance(associated_box, dict):
                fail(f"slot 3 report lacks Photoshop-associated product box: {gold_id}")
            gold_standards.append({
                "id": gold_id,
                "psdPath": relative_psd,
                "sourcePsdPath": report["approvedPsd"]["path"],
                "psdSha256": psd_hash,
                "layerNames": report["layerNames"],
                "productBox": associated_box,
            })

        if slot3_preset is None:
            fail("slot 3 preset was not built")

        candidate_evidence: list[dict[str, str]] = []
        for evidence_id, source, destination in candidate_evidence_sources(candidate):
            relative, actual = copy_pinned(source, stage, destination)
            candidate_evidence.append({"id": evidence_id, "file": relative, "sha256": actual})

        reference = summary.get("visualStyleReference")
        if not isinstance(reference, dict) or reference.get("role") != "visual-style-reference-only":
            fail("candidate summary does not declare the PSD as a visual-only reference")
        reference_source = candidate / reference["path"]
        reference_file, reference_hash = copy_pinned(reference_source, stage, "visual-style-reference/4-slot3-front-reference.psd", reference.get("sha256"))

        slot2_preset = deepcopy(baseline_manifest["presets"][0])
        slot2_preset["goldStandardIds"] = [gold["id"] for gold in baseline_manifest["goldStandards"]]
        manifest: dict[str, Any] = {
            "schemaVersion": 2,
            "version": TARGET_VERSION,
            "candidateOnly": True,
            "releaseState": "awaiting-human-approval",
            "approved": False,
            "publicationAllowed": False,
            "canvas": deepcopy(baseline_manifest["canvas"]),
            "algorithm": deepcopy(baseline_manifest["algorithm"]),
            "biRefNet": deepcopy(baseline_manifest["biRefNet"]),
            "gates": deepcopy(baseline_manifest["gates"]),
            "goldStandards": gold_standards,
            "presets": [slot2_preset, slot3_preset],
            "regressionAssets": regression_assets,
            "visualStyleReference": {
                "file": reference_file,
                "sha256": reference_hash,
                "artboard": reference.get("artboard"),
                "role": "visual-style-reference-only",
                "isGoldStandard": False,
            },
            "candidateEvidence": candidate_evidence,
            "provenance": {
                "baselineVersion": BASELINE_VERSION,
                "baselineManifestSha256": manifest_sha256(baseline_manifest),
                "candidateSummarySha256": sha256(candidate / "candidate-summary.json"),
            },
        }
        if len(manifest["goldStandards"]) != 4 or len(manifest["regressionAssets"]) != 24:
            fail("candidate package must contain four gold standards and twenty-four regression assets")
        write_json(stage / "manifest.json", manifest)
        manifest_hash = manifest_sha256(manifest)
        registry = {
            "schemaVersion": 1,
            "candidateOnly": True,
            "releaseState": "awaiting-human-approval",
            "approved": False,
            "publicationAllowed": False,
            "packages": [{"version": TARGET_VERSION, "manifestSha256": manifest_hash}],
        }
        write_json(stage / "candidate-registry.json", registry)

        validator = repo_root.resolve() / "scripts/validate-product-main-shadow-preset.py"
        candidate_command = [
            sys.executable,
            str(validator),
            "--bundle", str(stage),
            "--registry", str(stage / "candidate-registry.json"),
            "--candidate-mode",
            "--require-gold-psd",
        ]
        candidate_result = subprocess.run(candidate_command, capture_output=True, text=True, encoding="utf-8")
        if candidate_result.returncode != 0:
            fail(f"candidate validation failed:\n{candidate_result.stdout}\n{candidate_result.stderr}")
        validation = json.loads(candidate_result.stdout)

        publication_command = [
            sys.executable,
            str(validator),
            "--bundle", str(stage),
            "--registry", str(stage / "candidate-registry.json"),
            "--require-gold-psd",
        ]
        publication_result = subprocess.run(publication_command, capture_output=True, text=True, encoding="utf-8")
        if publication_result.returncode == 0:
            fail("publication-mode validator unexpectedly accepted the unapproved candidate")
        validation_report = {
            "schemaVersion": 1,
            "candidateVersion": TARGET_VERSION,
            "manifestSha256": manifest_hash,
            "candidateRegistryPinned": True,
            "candidateModePassed": True,
            "publicationModeRejected": True,
            "releaseState": "awaiting-human-approval",
            "approved": False,
            "publicationAllowed": False,
            "goldStandardCount": len(gold_standards),
            "regressionAssetCount": len(regression_assets),
            "validatorReport": validation,
            "publicationRejection": (publication_result.stderr or publication_result.stdout).strip().splitlines()[-1],
        }
        write_json(stage / "candidate-validation-report.json", validation_report)

        stage.replace(output)
        for packaged_file in output.rglob("*"):
            if packaged_file.is_file():
                packaged_file.chmod(stat.S_IREAD | stat.S_IRGRP | stat.S_IROTH)
                if os.name == "nt" and not (getattr(packaged_file.stat(), "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_READONLY):
                    fail(f"failed to set read-only attribute: {packaged_file}")
        completed = True
        return {
            "output": str(output),
            "version": TARGET_VERSION,
            "manifestSha256": manifest_hash,
            "goldStandardCount": len(gold_standards),
            "regressionAssetCount": len(regression_assets),
            "candidateEvidenceCount": len(candidate_evidence),
            "candidateModePassed": True,
            "publicationModeRejected": True,
            "allFilesReadOnly": True,
        }
    finally:
        if not completed and stage.exists():
            shutil.rmtree(stage)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-bundle", type=Path, required=True)
    parser.add_argument("--candidate-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--candidate-version", required=True)
    args = parser.parse_args()
    repo_root = Path(__file__).resolve().parents[1]
    result = build_package(repo_root, args.baseline_bundle, args.candidate_root, args.output_dir, args.candidate_version)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
