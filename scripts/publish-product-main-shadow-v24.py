"""Publish the explicitly approved v2.4 candidate as a new immutable bundle."""
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
from pathlib import Path
from typing import Any


VERSION = "hat-ps-shadow-v2.4"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def manifest_digest(value: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"JSON object required: {path}")
    return value


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def make_tree_writable(root: Path) -> None:
    for path in root.rglob("*"):
        if path.is_file():
            path.chmod(stat.S_IWRITE | stat.S_IREAD)


def remove_tree(root: Path) -> None:
    def unlock(function: Any, path: str, _error: Any) -> None:
        os.chmod(path, stat.S_IWRITE | stat.S_IREAD)
        function(path)
    shutil.rmtree(root, onerror=unlock)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate-package", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--registry", type=Path, required=True)
    args = parser.parse_args()

    candidate = args.candidate_package.resolve()
    destination = args.destination.resolve()
    registry_path = args.registry.resolve()
    repo_root = Path(__file__).resolve().parents[1]
    config_root = (repo_root / "config" / "product-main-shadows").resolve()
    if candidate == destination or not candidate.is_dir():
        raise RuntimeError("candidate package is missing or destination aliases candidate")
    if destination.exists():
        raise RuntimeError(f"refusing to overwrite existing immutable destination: {destination}")
    if config_root not in destination.parents:
        raise RuntimeError("published destination must be a sibling under config/product-main-shadows")
    candidate_manifest = read_json(candidate / "manifest.json")
    if candidate_manifest.get("version") != VERSION or candidate_manifest.get("candidateOnly") is not True or candidate_manifest.get("releaseState") != "awaiting-human-approval" or candidate_manifest.get("approved") is not False or candidate_manifest.get("publicationAllowed") is not False:
        raise RuntimeError("candidate manifest is not the exact approved-before-publish v2.4 state")
    candidate_registry = read_json(candidate / "candidate-registry.json")
    pins = [item for item in candidate_registry.get("packages", []) if item.get("version") == VERSION]
    if len(pins) != 1 or pins[0].get("manifestSha256") != manifest_digest(candidate_manifest):
        raise RuntimeError("candidate registry does not pin the candidate manifest")

    stage = Path(tempfile.mkdtemp(prefix=f".{VERSION}-publishing-", dir=destination.parent))
    registry_stage = stage.parent / f".{VERSION}-registry.json"
    completed = False
    try:
        shutil.copytree(candidate, stage, dirs_exist_ok=True)
        make_tree_writable(stage)
        manifest = read_json(stage / "manifest.json")
        manifest["candidateOnly"] = False
        manifest["releaseState"] = "approved"
        manifest["approved"] = True
        manifest["publicationAllowed"] = True
        for preset in manifest.get("presets", []):
            if preset.get("id") == "hat-angle-slot-1":
                preset["approved"] = True
                preset["releaseState"] = "approved"
                preset["publicationAllowed"] = True
        write_json(stage / "manifest.json", manifest)
        registry = read_json(registry_path)
        existing_versions = [item.get("version") for item in registry.get("packages", [])]
        if VERSION in existing_versions:
            raise RuntimeError("production registry already contains v2.4")
        published_registry = {
            "schemaVersion": 1,
            "packages": [*registry.get("packages", []), {"version": VERSION, "manifestSha256": manifest_digest(manifest)}],
        }
        write_json(registry_stage, published_registry)
        validator = repo_root / "scripts" / "validate-product-main-shadow-preset.py"
        validation = subprocess.run([
            sys.executable, str(validator), "--bundle", str(stage), "--registry", str(registry_stage), "--require-gold-psd",
        ], capture_output=True, text=True, encoding="utf-8")
        if validation.returncode != 0:
            raise RuntimeError(f"publication-mode validation failed:\n{validation.stdout}\n{validation.stderr}")
        stage.replace(destination)
        registry_stage.replace(registry_path)
        completed = True
        print(json.dumps({
            "version": VERSION,
            "destination": str(destination),
            "manifestSha256": manifest_digest(manifest),
            "registry": str(registry_path),
            "registrySha256": digest(registry_path),
            "publicationValidation": json.loads(validation.stdout),
        }, ensure_ascii=False, indent=2))
    finally:
        if not completed and stage.exists():
            remove_tree(stage)
        if not completed and registry_stage.exists():
            registry_stage.unlink()


if __name__ == "__main__":
    main()
