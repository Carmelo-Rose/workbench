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


BASELINE_VERSION = "hat-ps-shadow-v2.1"
ADAPTIVE_VERSION = "hat-ps-shadow-v2.4"
ADAPTIVE_ALGORITHM = {
    "id": "ps-levels-roi-v2-adaptive-white",
    "levels": "round(value*255/channelMedian)-clamp-255",
}
ADAPTIVE_GATES = {
    "whitePointMin": 220,
    "whitePointMax": 245,
    "whitePointMaxChannelSpread": 8,
    "productBoxTolerance": 0.05,
    "roiBoundaryMaxChannelJump": 5,
    "detachedResidueMinArea": 64,
    "residueThreshold": 2,
    "legalShadowMaskNeighborhood": 16,
}
ADAPTIVE_WHITE_SAMPLE_POLICY = {
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
REQUIRED_GATE_NAMES = (
    "whitePoint",
    "sampleOutsideMask",
    "photoshopShadowParity",
    "birefnetMask",
    "productBox",
    "opaqueProductCore",
    "outsideProductAndRoiWhite",
)
ADAPTIVE_GATE_NAMES = REQUIRED_GATE_NAMES + ("roiBoundary", "detachedBackgroundResidue", "outputOpaqueRgb")
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
    baseline_version = manifest.get("version")
    if not isinstance(baseline_version, str) or not baseline_version.startswith("hat-ps-shadow-"):
        fail("baseline must be an immutable hat-ps-shadow production bundle")
    if (manifest.get("candidateOnly") is not False
        or manifest.get("releaseState") != "approved"
        or manifest.get("approved") is not True
        or manifest.get("publicationAllowed") is not True):
        fail("baseline must be an approved, publishable production bundle")
    golds = manifest.get("goldStandards")
    presets = manifest.get("presets")
    assets = manifest.get("regressionAssets")
    if not isinstance(golds, list) or len(golds) < 2 or not isinstance(presets, list) or not presets:
        fail("baseline must contain gold standards and approved presets")
    if any(preset.get("approved") is not True for preset in presets):
        fail("baseline presets must remain approved")
    if not isinstance(assets, list) or not assets:
        fail("baseline must contain regression assets")
    baseline_registry = load_json(baseline.parent / "registry.json")
    pins = [item for item in baseline_registry.get("packages", []) if item.get("version") == baseline_version]
    if len(pins) != 1 or pins[0].get("manifestSha256") != manifest_sha256(manifest):
        fail("baseline manifest is not pinned exactly once by the production registry")
    for item in assets:
        source = baseline / item["file"]
        checked_file(source, item["sha256"])
    for gold in golds:
        source = Path(gold["psdPath"])
        if not source.is_absolute():
            source = baseline / source
        checked_file(source, gold["psdSha256"])
    return manifest


def candidate_evidence_sources(candidate_root: Path, summary: dict[str, Any]) -> list[tuple[str, Path, str]]:
    values: list[tuple[str, Path, str]] = [
        ("candidate-summary", candidate_root / "candidate-summary.json", "evidence/candidate-summary.json"),
    ]
    declared = summary.get("candidateEvidence")
    if not isinstance(declared, list) or not declared:
        fail("candidate summary must declare candidateEvidence")
    seen = {"candidate-summary"}
    for item in declared:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"] or item["id"] in seen:
            fail("candidate summary evidence IDs are invalid or duplicated")
        source_value = item.get("path")
        if not isinstance(source_value, str) or not source_value:
            fail(f"candidate evidence path is missing: {item.get('id')}")
        source = (candidate_root / source_value).resolve()
        if not is_within(source, candidate_root.resolve()):
            fail(f"candidate evidence escapes candidate root: {item['id']}")
        seen.add(item["id"])
        destination = item.get("packagePath", f"evidence/{Path(source_value).name}")
        if not isinstance(destination, str) or not destination.startswith("evidence/") or Path(destination).is_absolute():
            fail(f"candidate evidence package path is invalid: {item['id']}")
        values.append((item["id"], source, destination))
    return values


def build_package(repo_root: Path, baseline_bundle: Path, candidate_root: Path, output_dir: Path, candidate_version: str) -> dict[str, Any]:
    candidate, output = validate_destination(repo_root, candidate_root, output_dir)
    baseline = baseline_bundle.resolve()
    baseline_manifest = validate_baseline(baseline)
    summary = load_json(candidate / "candidate-summary.json")
    if candidate_version != summary.get("candidateVersion"):
        fail("candidate version must exactly match candidate summary")
    angle_slot = summary.get("angleSlot")
    if not isinstance(angle_slot, int) or not 1 <= angle_slot <= 6 or angle_slot == 2:
        fail("candidate angle slot must be from 1 through 6 and distinct from baseline slot 2")
    samples = summary.get("samples")
    if not isinstance(samples, list) or len(samples) < 2:
        fail("candidate summary must declare at least two same-angle colour samples")
    if candidate_version == ADAPTIVE_VERSION and len(samples) != 3:
        fail(f"{ADAPTIVE_VERSION} must bind exactly the black, blue, and white slot-1 samples")
    source_ids = [item.get("sourceId", item.get("id")) for item in samples if isinstance(item, dict)]
    gold_ids = [item.get("goldId", str(item.get("id", "")).lower()) for item in samples if isinstance(item, dict)]
    if len(source_ids) != len(samples) or len(gold_ids) != len(samples) or len(set(source_ids)) != len(samples) or len(set(gold_ids)) != len(samples):
        fail("candidate sample source and gold IDs must be present and unique")
    required_summary = {
        "schemaVersion": 2,
        "candidateVersion": candidate_version,
        "releaseState": "awaiting-human-approval",
        "approved": False,
        "publicationAllowed": False,
        "angleSlot": angle_slot,
        "automaticGatesPassed": True,
    }
    if any(summary.get(key) != value for key, value in required_summary.items()):
        fail("candidate summary release state or automatic gate status is invalid")
    if summary.get("goldStandardIds") != gold_ids:
        fail("candidate summary must bind its declared same-angle gold standards")

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
            if not source_psd.is_absolute():
                source_psd = baseline / source_psd
            relative, actual = copy_pinned(source_psd, stage, f"gold-psd/{gold['id']}.psd", gold["psdSha256"])
            packaged_gold = deepcopy(gold)
            packaged_gold["sourcePsdPath"] = gold["psdPath"]
            packaged_gold["psdPath"] = relative
            packaged_gold["psdSha256"] = actual
            gold_standards.append(packaged_gold)

        candidate_preset: dict[str, Any] | None = None
        for sample, source_id, gold_id in zip(samples, source_ids, gold_ids, strict=True):
            gates_dir = sample.get("gatesDir")
            photoshop_dir = sample.get("photoshopDir")
            if not isinstance(gates_dir, str) or not isinstance(photoshop_dir, str):
                fail(f"candidate sample paths are missing: {source_id}")
            gates_root = candidate / source_id / gates_dir
            report = load_json(gates_root / "report.json")
            preset = load_json(gates_root / "candidate-preset.json")
            expected_report = {
                "schemaVersion": 2,
                "releaseState": "awaiting-human-approval",
                "approved": False,
                "publicationAllowed": False,
                "goldId": gold_id,
                "presetVersion": candidate_version,
                "angleSlot": angle_slot,
                "automaticGatesPassed": True,
                "sourceId": source_id,
            }
            if any(report.get(key) != value for key, value in expected_report.items()):
                fail(f"candidate report state is invalid: {gold_id}")
            automatic = report.get("automaticGates")
            required_gate_names = ADAPTIVE_GATE_NAMES if candidate_version == ADAPTIVE_VERSION else REQUIRED_GATE_NAMES
            if not isinstance(automatic, dict) or any(not isinstance(automatic.get(name), dict) or automatic[name].get("passed") is not True for name in required_gate_names):
                fail(f"candidate report does not pass every required automatic gate: {gold_id}")
            if preset.get("id") != f"hat-angle-slot-{angle_slot}" or preset.get("approved") is not False or preset.get("goldStandardIds") != gold_ids:
                fail(f"candidate preset is invalid: {gold_id}")
            if preset.get("releaseState") != "awaiting-human-approval" or preset.get("publicationAllowed") is not False:
                fail(f"candidate preset is publishable: {gold_id}")
            expected_sampling = (preset.get("whiteSamplePolicy") == summary.get("whiteSamplePolicy") == ADAPTIVE_WHITE_SAMPLE_POLICY
                                 and "whitePoint" not in preset and "whitePoint" not in summary) if candidate_version == ADAPTIVE_VERSION else preset.get("whitePoint") == summary.get("whitePoint")
            if preset.get("roi") != summary.get("roi") or not expected_sampling:
                fail(f"candidate coordinates disagree with summary: {gold_id}")
            if candidate_preset is None:
                candidate_preset = preset
            elif preset != candidate_preset:
                fail("same-angle colour candidate presets disagree")

            source_psd = candidate / source_id / photoshop_dir / "calibration.psd"
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
                fail(f"candidate report lacks Photoshop-associated product box: {gold_id}")
            product_box_evidence = sample.get("productBoxEvidence")
            if not isinstance(product_box_evidence, dict) or product_box_evidence.get("threshold") != "grayscale >= 128" or product_box_evidence.get("box") != associated_box:
                fail(f"candidate product-box evidence is missing or inconsistent: {gold_id}")
            product_mask_path = candidate / source_id / photoshop_dir / "product-mask.png"
            checked_file(product_mask_path, product_box_evidence.get("sha256"))
            gold_standards.append({
                "id": gold_id,
                "psdPath": relative_psd,
                "sourcePsdPath": report["approvedPsd"]["path"],
                "psdSha256": psd_hash,
                "layerNames": report["layerNames"],
                "productBox": associated_box,
            })

        if candidate_preset is None:
            fail("candidate preset was not built")

        candidate_evidence: list[dict[str, str]] = []
        for evidence_id, source, destination in candidate_evidence_sources(candidate, summary):
            relative, actual = copy_pinned(source, stage, destination)
            candidate_evidence.append({"id": evidence_id, "file": relative, "sha256": actual})

        reference = summary.get("visualStyleReference")
        if not isinstance(reference, dict) or reference.get("role") != "visual-style-reference-only":
            fail("candidate summary does not declare the PSD as a visual-only reference")
        reference_source = candidate / reference["path"]
        reference_file, reference_hash = copy_pinned(reference_source, stage, f"visual-style-reference/{reference_source.name}", reference.get("sha256"))

        base_presets = deepcopy(baseline_manifest["presets"])
        if any(not isinstance(preset.get("goldStandardIds"), list) for preset in base_presets):
            fail("baseline presets must explicitly bind their gold standards")
        manifest: dict[str, Any] = {
            "schemaVersion": baseline_manifest["schemaVersion"],
            "version": candidate_version,
            "candidateOnly": True,
            "releaseState": "awaiting-human-approval",
            "approved": False,
            "publicationAllowed": False,
            "canvas": deepcopy(baseline_manifest["canvas"]),
            "algorithm": deepcopy(baseline_manifest["algorithm"]),
            "biRefNet": deepcopy(baseline_manifest["biRefNet"]),
            "gates": deepcopy(baseline_manifest["gates"]),
            "goldStandards": gold_standards,
            "presets": [*base_presets, candidate_preset],
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
                "baselineVersion": baseline_manifest["version"],
                "baselineManifestSha256": manifest_sha256(baseline_manifest),
                "candidateSummarySha256": sha256(candidate / "candidate-summary.json"),
            },
        }
        expected_gold_count = len(baseline_manifest["goldStandards"]) + len(samples)
        expected_asset_count = len(baseline_manifest["regressionAssets"]) + len(samples) * 6
        if len(manifest["goldStandards"]) != expected_gold_count or len(manifest["regressionAssets"]) != expected_asset_count:
            fail("candidate package gold or regression asset count is incomplete")
        write_json(stage / "manifest.json", manifest)
        manifest_hash = manifest_sha256(manifest)
        registry = {
            "schemaVersion": 1,
            "candidateOnly": True,
            "releaseState": "awaiting-human-approval",
            "approved": False,
            "publicationAllowed": False,
            "packages": [{"version": candidate_version, "manifestSha256": manifest_hash}],
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
            "candidateVersion": candidate_version,
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
            "version": candidate_version,
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
