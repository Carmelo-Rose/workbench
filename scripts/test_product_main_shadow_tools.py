from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parent


def load_script(filename: str, module_name: str):
    spec = importlib.util.spec_from_file_location(module_name, SCRIPTS / filename)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


calibrate = load_script("calibrate-product-main-shadow.py", "calibrate_product_main_shadow")
validate = load_script("validate-product-main-shadow-preset.py", "validate_product_main_shadow_preset")
build_candidate = load_script("build-product-main-shadow-candidate-package.py", "build_product_main_shadow_candidate_package")


class CalibrationArgumentsTest(unittest.TestCase):
    def test_new_candidate_coordinates_have_no_defaults(self) -> None:
        source = (SCRIPTS / "calibrate-product-main-shadow.py").read_text(encoding="utf-8")
        for flag in ("--preset-version", "--angle-slot", "--angle-label", "--roi", "--white-point", "--product-layer", "--shadow-layer", "--background-layer"):
            line = next(line for line in source.splitlines() if f'add_argument("{flag}"' in line)
            self.assertIn("required=True", line)
            self.assertNotIn("default=", line)

    def test_slot_and_reference_coordinate_validation(self) -> None:
        valid = type("Args", (), {
            "angle_slot": 3, "angle_label": "front", "preset_version": "candidate-v1",
            "roi": (0, 330, 800, 470), "white_point": (15, 578),
            "gold_id": "black", "gold_standard_id": ["black", "blue"],
        })()
        calibrate.validate_reference_inputs(valid)
        valid.angle_slot = 7
        with self.assertRaisesRegex(RuntimeError, "1 through 6"):
            calibrate.validate_reference_inputs(valid)


class ManifestAssociationTest(unittest.TestCase):
    def test_v1_uses_every_manifest_gold(self) -> None:
        self.assertEqual(
            validate.associated_gold_ids(1, {"id": "slot-2"}, ["black", "blue"]),
            ["black", "blue"],
        )

    def test_v2_requires_two_known_unique_gold_ids(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "at least two"):
            validate.associated_gold_ids(2, {"id": "slot-3", "goldStandardIds": ["black"]}, ["black", "blue"])
        with self.assertRaisesRegex(RuntimeError, "unknown"):
            validate.associated_gold_ids(2, {"id": "slot-3", "goldStandardIds": ["black", "red"]}, ["black", "blue"])
        self.assertEqual(
            validate.associated_gold_ids(2, {"id": "slot-3", "goldStandardIds": ["black", "blue"]}, ["black", "blue"]),
            ["black", "blue"],
        )

    def test_validator_declares_cross_preset_gold_exclusivity(self) -> None:
        source = (SCRIPTS / "validate-product-main-shadow-preset.py").read_text(encoding="utf-8")
        self.assertIn("gold standards cannot be associated with multiple presets", source)
        self.assertIn("must be associated exactly once", source)

    def test_validator_requires_correct_regression_asset_kinds_and_psd_pixels(self) -> None:
        source = (SCRIPTS / "validate-product-main-shadow-preset.py").read_text(encoding="utf-8")
        self.assertIn("gold standard regression asset kind mismatch", source)
        self.assertIn("must exactly cover the six fixed assets", source)
        self.assertIn("gold PSD pixels do not match packaged regression assets", source)
        self.assertIn("must be full-canvas opaque white", source)

    def test_manifest_digest_is_canonical(self) -> None:
        first = {"schemaVersion": 2, "version": "candidate", "presets": []}
        second = json.loads('{\n  "schemaVersion": 2,\n  "version": "candidate",\n  "presets": []\n}')
        self.assertEqual(validate.manifest_digest(first), validate.manifest_digest(second))

    def test_immutable_versions_are_bound_to_their_schema(self) -> None:
        self.assertEqual(validate.expected_schema_version("hat-ps-shadow-v2.1"), 1)
        self.assertEqual(validate.expected_schema_version("hat-ps-shadow-v2.3"), 2)
        with self.assertRaisesRegex(RuntimeError, "unsupported immutable preset version"):
            validate.expected_schema_version("hat-ps-shadow-v9")


class CandidatePackageSafetyTest(unittest.TestCase):
    def test_candidate_mode_requires_explicit_non_publishable_state(self) -> None:
        candidate = {
            "candidateOnly": True,
            "releaseState": "awaiting-human-approval",
            "approved": False,
            "publicationAllowed": False,
        }
        registry = dict(candidate)
        validate.validate_release_policy(candidate, registry, True)
        with self.assertRaisesRegex(RuntimeError, "publication mode"):
            validate.validate_release_policy(candidate, registry, False)
        with self.assertRaisesRegex(RuntimeError, "explicitly forbid"):
            validate.validate_release_policy({**candidate, "publicationAllowed": True}, registry, True)

    def test_publication_mode_keeps_legacy_compatibility_but_rejects_pending_state(self) -> None:
        validate.validate_release_policy({}, {"schemaVersion": 1}, False)
        validate.validate_release_policy(
            {"releaseState": "approved", "approved": True, "publicationAllowed": True},
            {"schemaVersion": 1},
            False,
        )
        with self.assertRaisesRegex(RuntimeError, "not explicitly approved"):
            validate.validate_release_policy(
                {"releaseState": "awaiting-human-approval", "approved": False, "publicationAllowed": False},
                {"schemaVersion": 1},
                False,
            )
        with self.assertRaisesRegex(RuntimeError, "explicit approved release state"):
            validate.validate_release_policy({"version": "hat-ps-shadow-v2.3"}, {"schemaVersion": 1}, False)
        validate.validate_release_policy(
            {
                "version": "hat-ps-shadow-v2.3",
                "candidateOnly": False,
                "releaseState": "approved",
                "approved": True,
                "publicationAllowed": True,
            },
            {"schemaVersion": 1},
            False,
        )

    def test_candidate_evidence_is_relative_and_hash_pinned(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            evidence = root / "evidence.json"
            reference = root / "reference.psd"
            evidence.write_bytes(b"evidence")
            reference.write_bytes(b"reference")
            manifest = {
                "candidateEvidence": [{"id": "gate-report", "file": "evidence.json", "sha256": validate.digest(evidence)}],
                "visualStyleReference": {
                    "file": "reference.psd",
                    "sha256": validate.digest(reference),
                    "role": "visual-style-reference-only",
                    "isGoldStandard": False,
                },
            }
            validate.validate_candidate_evidence(manifest, root, True)
            manifest["candidateEvidence"][0]["file"] = str(evidence)
            with self.assertRaisesRegex(RuntimeError, "relative path"):
                validate.validate_candidate_evidence(manifest, root, True)

    def test_builder_refuses_config_existing_and_out_of_root_destinations(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory).resolve() / "repo"
            candidate = repo / "tmp/candidates/front"
            candidate.mkdir(parents=True)
            output = candidate / "immutable-package"
            self.assertEqual(build_candidate.validate_destination(repo, candidate, output), (candidate, output))
            output.mkdir()
            with self.assertRaisesRegex(RuntimeError, "refusing to overwrite"):
                build_candidate.validate_destination(repo, candidate, output)
            with self.assertRaisesRegex(RuntimeError, "under config"):
                build_candidate.validate_destination(repo, candidate, repo / "config/candidate")
            with self.assertRaisesRegex(RuntimeError, "new child"):
                build_candidate.validate_destination(repo, candidate, repo / "tmp/elsewhere")


class PhotoshopHelperTest(unittest.TestCase):
    def test_json_fallback_and_overwrite_guard_are_present(self) -> None:
        source = (SCRIPTS / "calibrate-product-main-shadow.jsx").read_text(encoding="utf-8")
        self.assertIn('eval("(" + text + ")")', source)
        self.assertIn("function stringifyJson", source)
        self.assertIn('if (outputDir.exists) fail("outputDir already exists; refusing to overwrite")', source)
        self.assertIn("if (original.isBackgroundLayer) original.isBackgroundLayer = false", source)
        self.assertIn("if (doc) doc.close(SaveOptions.DONOTSAVECHANGES)", source)
        self.assertIn("approved: false", source)
        self.assertIn("value.sampledRgb", source)
        self.assertIn("var whiteR = request.sampledRgb[0]", source)


if __name__ == "__main__":
    unittest.main()
