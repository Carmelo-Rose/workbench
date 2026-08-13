"""Publish the explicitly approved hat-ps-shadow-v2.5 candidate immutably."""
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


VERSION = "hat-ps-shadow-v2.5"


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
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def make_writable(root: Path) -> None:
    for path in root.rglob("*"):
        if path.is_file():
            path.chmod(stat.S_IREAD | stat.S_IWRITE)


def remove_tree(root: Path) -> None:
    def unlock(function: Any, path: str, _error: Any) -> None:
        os.chmod(path, stat.S_IREAD | stat.S_IWRITE)
        function(path)
    shutil.rmtree(root, onerror=unlock)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate-package", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--registry", type=Path, required=True)
    args = parser.parse_args()

    repo = Path(__file__).resolve().parents[1]
    candidate = args.candidate_package.resolve()
    destination = args.destination.resolve()
    registry_path = args.registry.resolve()
    config_root = (repo / "config" / "product-main-shadows").resolve()
    if not candidate.is_dir() or destination.exists() or candidate == destination:
        fail("candidate package is missing, aliases destination, or destination already exists")
    if config_root not in destination.parents:
        fail("published destination must be a new sibling under config/product-main-shadows")
    candidate_manifest = read_json(candidate / "manifest.json")
    candidate_registry = read_json(candidate / "candidate-registry.json")
    required = {"version": VERSION, "candidateOnly": True, "releaseState": "awaiting-human-approval", "approved": False, "publicationAllowed": False}
    if any(candidate_manifest.get(key) != value for key, value in required.items()):
        fail("candidate manifest is not the exact pre-publish v2.5 state")
    pin = [item for item in candidate_registry.get("packages", []) if item.get("version") == VERSION]
    if len(pin) != 1 or pin[0].get("manifestSha256") != canonical_digest(candidate_manifest):
        fail("candidate registry does not pin the v2.5 manifest")

    validator = repo / "scripts" / "validate-product-main-shadow-preset.py"
    candidate_check = subprocess.run([sys.executable, str(validator), "--bundle", str(candidate), "--registry", str(candidate / "candidate-registry.json"), "--candidate-mode", "--require-gold-psd"], capture_output=True, text=True, encoding="utf-8")
    if candidate_check.returncode != 0:
        fail(f"candidate revalidation failed:\n{candidate_check.stdout}\n{candidate_check.stderr}")

    stage = Path(tempfile.mkdtemp(prefix=f".{VERSION}-publishing-", dir=destination.parent))
    registry_stage = stage.parent / f".{VERSION}-registry.json"
    completed = False
    try:
        shutil.copytree(candidate, stage, dirs_exist_ok=True)
        make_writable(stage)
        manifest = read_json(stage / "manifest.json")
        manifest.update({"candidateOnly": False, "releaseState": "approved", "approved": True, "publicationAllowed": True})
        for preset in manifest.get("presets", []):
            preset.update({"approved": True, "releaseState": "approved", "publicationAllowed": True})
        write_json(stage / "manifest.json", manifest)

        production_registry = read_json(registry_path)
        if VERSION in [item.get("version") for item in production_registry.get("packages", [])]:
            fail("production registry already contains v2.5")
        published_registry = {"schemaVersion": 1, "packages": [*production_registry.get("packages", []), {"version": VERSION, "manifestSha256": canonical_digest(manifest)}]}
        write_json(registry_stage, published_registry)
        production_check = subprocess.run([sys.executable, str(validator), "--bundle", str(stage), "--registry", str(registry_stage), "--require-gold-psd"], capture_output=True, text=True, encoding="utf-8")
        if production_check.returncode != 0:
            fail(f"production validation failed:\n{production_check.stdout}\n{production_check.stderr}")

        stage.replace(destination)
        registry_stage.replace(registry_path)
        completed = True
        print(json.dumps({"version": VERSION, "destination": str(destination), "manifestSha256": canonical_digest(manifest), "registry": str(registry_path), "registrySha256": digest(registry_path), "candidateRevalidation": json.loads(candidate_check.stdout), "publicationValidation": json.loads(production_check.stdout)}, ensure_ascii=False, indent=2))
    finally:
        if not completed and stage.exists():
            remove_tree(stage)
        if not completed and registry_stage.exists():
            registry_stage.unlink()


if __name__ == "__main__":
    main()
