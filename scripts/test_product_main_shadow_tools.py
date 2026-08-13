from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np


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
        for flag in ("--preset-version", "--angle-slot", "--angle-label", "--roi", "--product-layer", "--shadow-layer", "--background-layer"):
            line = next(line for line in source.splitlines() if f'add_argument("{flag}"' in line)
            self.assertIn("required=True", line)
            self.assertNotIn("default=", line)
        white_point = next(line for line in source.splitlines() if 'add_argument("--white-point"' in line)
        self.assertNotIn("required=True", white_point)

    def test_slot_and_reference_coordinate_validation(self) -> None:
        valid = type("Args", (), {
            "angle_slot": 3, "angle_label": "front", "preset_version": "candidate-v1",
            "roi": (0, 330, 800, 470), "white_point": (15, 578),
            "gold_id": "black", "gold_standard_id": ["black", "blue"],
            "source_id": None, "v1": Path("black.png"),
        })()
        calibrate.validate_reference_inputs(valid)
        valid.angle_slot = 7
        with self.assertRaisesRegex(RuntimeError, "1 through 6"):
            calibrate.validate_reference_inputs(valid)

    def test_development_identity_requires_explicit_slot_4_metadata(self) -> None:
        valid = type("Args", (), {
            "angle_slot": 4, "angle_label": "synthetic-slot-4", "preset_version": "slot-4-development",
            "development_identity": "slot-4-development", "roi": (40, 350, 720, 420), "white_point": None,
            "gold_id": "synthetic-black", "gold_standard_id": ["synthetic-black", "synthetic-blue"],
            "source_id": "synthetic-slot-4", "v1": Path("synthetic-slot-4.png"),
        })()
        calibrate.validate_reference_inputs(valid)
        valid.development_identity = None
        with self.assertRaisesRegex(RuntimeError, "explicit matching development-identity"):
            calibrate.validate_reference_inputs(valid)

    def test_adaptive_selection_is_deterministic_and_fails_without_a_candidate(self) -> None:
        side = 800
        source = np.full((side, side, 3), 240, dtype=np.uint8)
        mask = np.zeros((side, side), dtype=np.uint8)
        mask[200:500, 300:500] = 255
        source[200:500, 300:500] = (20, 30, 40)
        first = calibrate.adaptive_white_sample(source, mask, (0, 480, 800, 320))
        second = calibrate.adaptive_white_sample(source, mask, (0, 480, 800, 320))
        self.assertEqual(first, second)
        self.assertEqual(first["medianRgb"], (240, 240, 240))
        self.assertEqual(first["patchSize"], 31)
        with self.assertRaisesRegex(RuntimeError, "found no region"):
            calibrate.adaptive_white_sample(np.full_like(source, 255), mask, (0, 480, 800, 320))

    def test_adaptive_window_scales_to_1200_and_1600(self) -> None:
        self.assertEqual([calibrate.scale_odd_size(31, side) for side in (800, 1200, 1600)], [31, 47, 63])

    def test_detached_background_is_purified_at_64_without_touching_contact_shadow(self) -> None:
        side = 800
        image = np.full((side, side, 3), 255, dtype=np.uint8)
        mask = np.zeros((side, side), dtype=np.uint8)
        mask[300:500, 300:500] = 255
        image[500:510, 360:440] = 230
        image[700:708, 100:108] = 230
        before_contact = image[500:510, 360:440].copy()
        purified, result = calibrate.purify_detached_background_residue(image, mask)
        self.assertEqual(result, {"purifiedComponentCount": 1, "purifiedPixelCount": 64})
        self.assertTrue(np.array_equal(purified[500:510, 360:440], before_contact))
        self.assertTrue(np.all(purified[700:708, 100:108] == 255))

    def test_63px_detached_component_remains_visible_to_the_fixed_gate(self) -> None:
        side = 800
        image = np.full((side, side, 3), 255, dtype=np.uint8)
        mask = np.zeros((side, side), dtype=np.uint8)
        mask[300:500, 300:500] = 255
        image[700:707, 100:109] = 230
        purified, result = calibrate.purify_detached_background_residue(image, mask)
        self.assertEqual(result, {"purifiedComponentCount": 0, "purifiedPixelCount": 0})
        self.assertEqual(calibrate.detached_residue_area(purified, mask), 63)


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
        self.assertEqual(validate.expected_schema_version("hat-ps-shadow-v2.2"), 2)
        self.assertEqual(validate.expected_schema_version("hat-ps-shadow-v2.3"), 2)
        self.assertEqual(validate.expected_schema_version("hat-ps-shadow-v2.4"), 3)
        self.assertEqual(validate.expected_schema_version("slot-4-development"), 3)
        with self.assertRaisesRegex(RuntimeError, "unsupported immutable preset version"):
            validate.expected_schema_version("hat-ps-shadow-v9")


class CandidatePackageSafetyTest(unittest.TestCase):
    def test_development_identity_is_candidate_only(self) -> None:
        candidate = {
            "version": "slot-4-development",
            "developmentIdentity": "slot-4-development",
            "candidateOnly": True,
            "releaseState": "awaiting-human-approval",
            "approved": False,
            "publicationAllowed": False,
        }
        registry = {**candidate}
        validate.validate_release_policy(candidate, registry, True)
        with self.assertRaisesRegex(RuntimeError, "cannot be validated in publication mode"):
            validate.validate_release_policy(candidate, registry, False)

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
        self.assertIn("productMaskSource: \"photoshop-select-subject-second-pass-on-photoshop-product\"", source)

    def test_controlled_preview_calls_the_production_compositor(self) -> None:
        source = (SCRIPTS / "preview-product-main-shadow-candidate.ts").read_text(encoding="utf-8")
        self.assertIn("composeCalibratedShadowMain", source)
        self.assertIn("loadCandidateCalibratedShadowBundle", source)
        self.assertNotIn("levels_plate", source)
        self.assertNotIn("applyLevelsChannel", source)
        self.assertIn("comparisonPreflight", source)

    def test_slot_agnostic_development_entries_require_explicit_metadata(self) -> None:
        for filename in (
            "prepare-product-main-shadow-photoshop-request.ts",
            "preview-product-main-shadow-candidate.ts",
            "verify-product-main-shadow-production-entry.ts",
            "run-product-main-shadow-photoshop-calibration.py",
        ):
            source = (SCRIPTS / filename).read_text(encoding="utf-8")
            self.assertIn("slot-4-development", source)
            self.assertIn("angleSlot", source)
            self.assertIn("goldStandardIds", source)
        verifier = (SCRIPTS / "verify-product-main-shadow-production-entry.ts").read_text(encoding="utf-8")
        self.assertNotIn("angleSlot !== 1", verifier)
        self.assertNotIn("roi: { x: 0, y: 480, width: 800, height: 320 }", verifier)


if __name__ == "__main__":
    unittest.main()
