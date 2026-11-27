"""Focused offline checks for the first-class audience CI gate row."""

from __future__ import annotations

import importlib.util
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
from unittest.mock import patch
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
        pointer.write_text(json.dumps({"caseIds": ["not-the-archive-roster"], "suiteSha256": "a" * 64}), encoding="utf-8")
        with self.assertRaisesRegex(self.gate.AudienceGateError, "pointer caseIds"):
            self.gate.select_audience_case(
                self.fixture.archive,
                self.root / "pointer-mismatch",
                pointer,
            )

    def test_mapped_archive_requires_four_baseline_cases_plus_audience(self) -> None:
        members = self.gate._archive_members(self.fixture.archive)
        manifest_ids = [row["caseId"] for row in json.loads(members["staging/manifest.json"])["cases"]]
        pointer = self.root / "short-qualification-input.json"
        pointer.write_text(json.dumps({"caseIds": manifest_ids, "suiteSha256": "a" * 64}), encoding="utf-8")
        with self.assertRaisesRegex(self.gate.AudienceGateError, "four baseline cases plus one audience"):
            self.gate.select_audience_case(self.fixture.archive, self.root / "short-pointer", pointer)

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

    def test_carried_four_case_archive_selects_authenticated_appended_audience_row(self) -> None:
        original = self.gate._archive_members(self.fixture.archive)
        manifest_rows = []
        suite_rows = []
        members = {}
        for index in range(3):
            case_id = f"baseline.case-{index}"
            case_member = f"cases/{case_id}.frozen.json"
            bundle_member = f"bundles/{case_id}.json"
            case_raw = json.dumps({"case": {"caseId": case_id}}).encode()
            bundle_raw = f"bundle-{index}".encode()
            members[f"staging/{case_member}"] = case_raw
            members[f"staging/{bundle_member}"] = bundle_raw
            manifest_rows.append({
                "caseId": case_id,
                "case": case_member,
                "bundle": bundle_member,
                "caseSha256": "0" * 64,
                "bundleSha256": hashlib.sha256(bundle_raw).hexdigest(),
            })
            suite_rows.append({"case": case_member, "bundle": bundle_member})
        manifest = json.loads(original["staging/manifest.json"])
        audience_row = manifest["cases"][1]
        audience_case_member = audience_row["case"]
        audience_bundle_member = audience_row["bundle"]
        audience_row["provenance"] = "Phase 22 audience-style review from the exact captured denial"
        members["staging/" + audience_case_member] = original["staging/cases/audience.frozen.json"]
        members["staging/" + audience_bundle_member] = original["staging/bundles/audience.json"]
        manifest_rows.append(audience_row)
        suite_rows.append({"case": audience_case_member, "bundle": audience_bundle_member})
        members["staging/manifest.json"] = json.dumps({"schemaVersion": 1, "cases": manifest_rows}).encode()
        suite_raw = json.dumps({"schemaVersion": 1, "cases": suite_rows}).encode()
        members["staging/suite.json"] = suite_raw
        archive = self.root / "carried-audience.tar.gz"
        with tarfile.open(archive, "w:gz") as output:
            for name, raw in members.items():
                info = tarfile.TarInfo(name)
                info.size = len(raw)
                output.addfile(info, io.BytesIO(raw))
        pointer = self.root / "carried-pointer.json"
        pointer.write_text(json.dumps({
            "caseIds": [row["caseId"] for row in manifest_rows],
            "suiteSha256": hashlib.sha256(suite_raw).hexdigest(),
        }), encoding="utf-8")
        with patch.object(self.gate, "CARRIED_BASELINE_SUITE_SHA256", hashlib.sha256(suite_raw).hexdigest()):
            selected = self.gate.select_audience_case(archive, self.root / "carried-inputs", pointer)
        self.assertEqual(selected["gateKind"], "audience-carried")
        self.assertEqual(selected["caseId"], self.fixture.case_id)

    def test_workflow_wires_fast_gate_before_package_qualification(self) -> None:
        workflow = (ROOT / ".github/workflows/deploy.yml").read_text(encoding="utf-8")
        self.assertIn("audience-case-gate:", workflow)
        self.assertIn("name: Gate audience case (fast exact action)", workflow)
        self.assertIn("Run the same audience Strands exact-action check", workflow)
        self.assertIn("python examples/live-denial/strands_denial.py", workflow)
        self.assertIn('--scenario "$GATE_ROOT/inputs/staging/denial-case.json"', workflow)
        self.assertIn('--trace "$GATE_ROOT/inputs/staging/original-trace.json"', workflow)
        self.assertIn('--safe-output --result "$GATE_ROOT/audience-row.json"', workflow)
        self.assertIn('INPUT_POINTER: ${{ github.workspace }}/agent/audience-input.json', workflow)
        self.assertIn('INPUT_POINTER: ${{ github.workspace }}/agent/qualification-input.json', workflow)
        self.assertIn('test -s "$INPUT_POINTER"', workflow)
        self.assertNotIn("scripts/early_audience_gate.py \\", workflow)
        self.assertNotIn("--frozen-only", workflow)
        self.assertNotIn("--bundle", workflow)
        self.assertIn('native-gate.log', workflow)
        self.assertIn('AUDIENCE_GATE_ROW=', workflow)
        self.assertIn('GITHUB_SHA', workflow)
        self.assertIn('GITHUB_RUN_ATTEMPT', workflow)
        self.assertIn('exitCode: $exitCode', workflow)
        self.assertIn('exit "$status"', workflow)
        self.assertIn("needs: [route, check-agent, audience-case-gate]", workflow)
        self.assertIn("needs.audience-case-gate.result == 'success'", workflow)

    def test_rendered_summary_teaches_failure_without_private_free_text(self) -> None:
        extract = (
            'require "yaml"; '
            'workflow = YAML.load_file(".github/workflows/deploy.yml"); '
            'step = workflow["jobs"]["audience-case-gate"]["steps"].find '
            '{ |item| item["name"] == "Show the audience row in the job summary" }; '
            'print step.fetch("run")'
        )
        extracted = subprocess.run(
            ["ruby", "-e", extract], cwd=ROOT, text=True, capture_output=True, check=True,
        ).stdout.replace("${{ steps.gate.outputs.status }}", "1")
        with tempfile.TemporaryDirectory(prefix="audience-summary-") as directory:
            root = Path(directory)
            pointer = root / "audience-input.json"
            pointer.write_text(json.dumps({
                "schemaVersion": 1,
                "purpose": "Phase 20 native audience gate input handoff",
                "bucket": "private",
                "s3Key": "agent-evaluation/phase20/audience-inputs/" + "a" * 64 + "/staging.tar.gz",
                "sha256": "a" * 64,
                "scenarioSha256": "b" * 64,
                "traceSha256": "c" * 64,
            }), encoding="utf-8")
            (root / "audience-row.json").write_text(json.dumps({
                "status": "fail",
                "scenarioSha256": "b" * 64,
                "traceSha256": "c" * 64,
                "promptSha256": "d" * 64,
                "exactAction": "FAIL",
                "expected": {
                    "action": "Restore inventory access", "target": "inventory",
                    "value": "75", "unit": "version",
                },
                "actual": {
                    "action": "Other", "target": None,
                    "value": "<explanation redacted>", "unit": None,
                },
                "nativeEvaluator": {
                    "name": "Equals", "score": 0.0, "testPass": False,
                    "reason": "PRIVATE EVALUATOR PROSE MUST NOT RENDER",
                },
            }), encoding="utf-8")
            summary = root / "summary.md"
            environment = os.environ.copy()
            environment.update({
                "GATE_ROOT": str(root),
                "INPUT_POINTER": str(pointer),
                "GITHUB_SHA": "deadbeef",
                "GITHUB_RUN_ATTEMPT": "7",
                "GITHUB_STEP_SUMMARY": str(summary),
            })
            completed = subprocess.run(
                ["bash"], input=extracted, cwd=ROOT, env=environment,
                text=True, capture_output=True, check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            rendered = summary.read_text(encoding="utf-8")
            self.assertTrue(rendered.startswith("### Audience case gate\n\nExact recommendation: **FAIL**"))
            self.assertIn("Blocked by: exact structured action mismatch.", rendered)
            self.assertIn("| action | `Restore inventory access` | `Other` |", rendered)
            self.assertIn("| target | `inventory` | `unavailable` |", rendered)
            self.assertIn("| value | `75` | `<explanation redacted>` |", rendered)
            self.assertIn("| unit | `version` | `unavailable` |", rendered)
            self.assertIn("<details>", rendered)
            self.assertNotIn("PRIVATE EVALUATOR PROSE MUST NOT RENDER", rendered)
            self.assertNotIn("AUDIENCE_GATE_ROW=", rendered)
            self.assertIn("AUDIENCE_GATE_ROW=", completed.stdout)


if __name__ == "__main__":
    unittest.main()
