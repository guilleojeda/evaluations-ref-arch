"""Focused offline checks for the first-class audience CI gate row."""

from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
TESTS = ROOT / "tests"
if str(TESTS) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(TESTS))

from phase14_reviewed_cases_test import make_case, write_bundle  # noqa: E402
from reviewed_cases import freeze_case  # noqa: E402


def load_gate():
    path = ROOT / "scripts" / "early_audience_gate.py"
    spec = importlib.util.spec_from_file_location("early_audience_gate_test_subject", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load early audience gate")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_native_runner():
    path = ROOT / "examples" / "live-denial" / "strands_denial.py"
    spec = importlib.util.spec_from_file_location("strands_denial_gate_test_subject", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load native denial runner")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AudienceArchive:
    def __init__(self, root: Path, gate) -> None:
        self.root = root
        self.gate = gate
        self.archive = root / "staging.tar.gz"
        bundle = root / "audience-bundle.json"
        origin = write_bundle(bundle)
        draft = root / "audience.json"
        case = make_case(bundle, origin["runId"])
        case["caseId"] = "native.opaque-live-case-1234567890ab"
        draft.write_text(json.dumps(case), encoding="utf-8")
        frozen = root / "audience.frozen.json"
        freeze_case(draft, bundle, frozen)
        loaded = json.loads(frozen.read_text(encoding="utf-8"))
        case_sha = loaded["caseSha256"]
        bundle_sha = loaded["case"]["evidence"]["bundleSha256"]
        # Keep an unrelated row first to prove that the callback selects the
        # mapped audience row, not whichever case happens to be first.
        unrelated = {
            "caseId": "carried.capacity",
            "case": "cases/capacity.frozen.json",
            "bundle": "bundles/capacity.json",
            "caseSha256": "a" * 64,
            "bundleSha256": "b" * 64,
        }
        audience = {
            "caseId": loaded["case"]["caseId"],
            "case": "cases/audience.frozen.json",
            "bundle": "bundles/audience.json",
            "caseSha256": case_sha,
            "bundleSha256": bundle_sha,
            "provenance": "Verified native live bridge; candidate receives only the normal reviewed-case task.",
        }
        members = {
            "staging/manifest.json": json.dumps({"schemaVersion": 1, "cases": [unrelated, audience]}).encode(),
            "staging/cases/audience.frozen.json": frozen.read_bytes(),
            "staging/bundles/audience.json": bundle.read_bytes(),
            "staging/live-case-map.json": json.dumps({
                "schemaVersion": 1,
                "kind": "live-case-kit-member-map",
                "members": {
                    "case": "cases/audience.frozen.json",
                    "bundle": "bundles/audience.json",
                },
                "ci": audience,
            }).encode(),
        }
        with tarfile.open(self.archive, "w:gz") as output:
            for name, raw in members.items():
                info = tarfile.TarInfo(name)
                info.size = len(raw)
                output.addfile(info, io.BytesIO(raw))
        self.case_id = audience["caseId"]


class EarlyAudienceGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="early-audience-gate-")
        self.root = Path(self.temp.name)
        self.gate = load_gate()
        self.fixture = AudienceArchive(self.root, self.gate)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_selects_the_mapped_audience_row_when_an_unrelated_row_is_first(self) -> None:
        selected = self.gate.select_audience_case(self.fixture.archive, self.root / "inputs")
        self.assertEqual(selected["caseId"], self.fixture.case_id)
        self.assertEqual(selected["casePath"].name, "case.frozen.json")
        self.assertEqual(selected["bundlePath"].name, "captured-bundle.json")

    def test_prepare_writes_only_the_mapped_case_and_bundle(self) -> None:
        output_root = self.root / "gate"
        self.assertEqual(
            self.gate.main([
                "--archive", str(self.fixture.archive),
                "--output-root", str(output_root),
            ]),
            0,
        )
        prepared = json.loads((output_root / "audience-input.json").read_text())
        self.assertEqual(prepared["caseId"], self.fixture.case_id)
        self.assertTrue((output_root / "inputs" / "case.frozen.json").is_file())
        self.assertTrue((output_root / "inputs" / "captured-bundle.json").is_file())

    def test_live_row_without_member_map_fails_closed(self) -> None:
        members = self.gate._archive_members(self.fixture.archive)
        members.pop("staging/live-case-map.json")
        malformed = self.root / "missing-map.tar.gz"
        with tarfile.open(malformed, "w:gz") as output:
            for name, raw in members.items():
                info = tarfile.TarInfo(name)
                info.size = len(raw)
                output.addfile(info, io.BytesIO(raw))
        with self.assertRaisesRegex(self.gate.AudienceGateError, "live case"):
            self.gate.select_audience_case(malformed, self.root / "missing-map")

    def test_pointer_roster_must_match_the_archive_manifest(self) -> None:
        pointer = self.root / "qualification-input.json"
        pointer.write_text(json.dumps({"caseIds": ["not-the-archive-roster"]}), encoding="utf-8")
        with self.assertRaisesRegex(self.gate.AudienceGateError, "pointer caseIds"):
            self.gate.select_audience_case(
                self.fixture.archive,
                self.root / "pointer-mismatch",
                pointer,
            )

    def test_unaugmented_archive_labels_retained_denial_as_baseline(self) -> None:
        members = self.gate._archive_members(self.fixture.archive)
        members.pop("staging/live-case-map.json")
        manifest = json.loads(members["staging/manifest.json"])
        for row in manifest["cases"]:
            row.pop("provenance", None)
        members["staging/manifest.json"] = json.dumps(manifest).encode()
        baseline = self.root / "baseline.tar.gz"
        with tarfile.open(baseline, "w:gz") as output:
            for name, raw in members.items():
                info = tarfile.TarInfo(name)
                info.size = len(raw)
                output.addfile(info, io.BytesIO(raw))
        selected = self.gate.select_audience_case(baseline, self.root / "baseline-inputs")
        self.assertEqual(selected["gateKind"], "baseline-denial")

    def test_safe_native_receipt_redacts_free_form_other_explanation(self) -> None:
        runner = load_native_runner()
        safe = runner.strands_denial_io._safe_recommendation({
            "action": "Other", "target": None, "unit": None, "value": "private explanation",
        })
        self.assertEqual(safe, {
            "action": "Other", "target": None, "unit": None,
            "value": "<explanation redacted>",
        })

    def test_workflow_wires_fast_gate_before_package_qualification(self) -> None:
        workflow = (ROOT / ".github/workflows/deploy.yml").read_text(encoding="utf-8")
        self.assertIn("audience-case-gate:", workflow)
        self.assertIn("name: Gate audience case (fast exact action)", workflow)
        self.assertIn("Run the same audience Strands exact-action check", workflow)
        self.assertIn("python examples/live-denial/strands_denial.py", workflow)
        self.assertIn("--frozen-only --safe-output", workflow)
        self.assertIn('--pointer "$GITHUB_WORKSPACE/agent/qualification-input.json"', workflow)
        self.assertIn('native-gate.log', workflow)
        self.assertIn('exit "$status"', workflow)
        self.assertIn("needs: [route, check-agent, audience-case-gate]", workflow)
        self.assertIn("needs.audience-case-gate.result == 'success'", workflow)


if __name__ == "__main__":
    unittest.main()
