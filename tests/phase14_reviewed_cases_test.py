"""Acceptance tests for the reviewed-case CLI and immutable input boundary.

All source evidence is a bounded, synthetic Phase 13 bundle written by the
existing ``captured_evidence.write_bundle`` implementation.  Each scenario
invokes the public CLI in a subprocess with AWS credential discovery disabled.
"""

from __future__ import annotations

import copy
import hashlib
import importlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
AGENT_DIR = ROOT / "agent"
PHASE13_TEST = ROOT / "tests" / "phase13_captured_evidence_test.py"
START = "2026-11-13T10:00:00.000Z"
CUTOFF = "2026-11-13T10:05:00.000Z"
AFTER_CUTOFF = "2026-11-13T10:05:01.000Z"

if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))


def phase13_helpers() -> Any:
    """Load the fixture helpers already used by Phase 13 acceptance tests."""

    spec = importlib.util.spec_from_file_location("phase13_fixture_support", PHASE13_TEST)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load Phase 13 fixture helpers")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_bundle(path: Path, *, after_cutoff: bool = False) -> dict[str, Any]:
    """Write a small bounded evidence bundle through the Phase 13 writer."""

    helpers = phase13_helpers()
    captured_evidence = importlib.import_module("captured_evidence")
    sources = copy.deepcopy(helpers.fixture_sources())

    # This failed read is visible exactly at the case cutoff. The matching
    # negative test moves only its availability time one second later.
    denied_read = next(item for item in sources["logs"]["observations"] if item["eventId"] == "log-late")
    denied_read["timestamp"] = "2026-11-13T10:02:00.000Z"
    denied_read["ingestionTime"] = AFTER_CUTOFF if after_cutoff else CUTOFF
    denied_read["availableAt"] = AFTER_CUTOFF if after_cutoff else CUTOFF

    # Keep an as-of active alias and a healthy, same-memory published target
    # at the same snapshot time so the captured provider can join them into
    # one configuration view. This grounds the exact version string.
    sources["configuration"]["observations"].append(
        {
            "kind": "lambda-version",
            "function": "IncidentTriageDemoInventory",
            "observedAt": "2026-11-13T10:03:00.000Z",
            "availableAt": "2026-11-13T10:03:00.000Z",
            "configuration": {
                "FunctionName": "IncidentTriageDemoInventory",
                "Version": "75",
                "Role": "arn:aws:iam::123456789012:role/IncidentTriageDemoAppInventoryRole",
                "MemorySize": 256,
                "sourceRevision": "a" * 40,
                "artifactSha256": "b" * 64,
            },
        }
    )

    # An explicitly partial optional source must remain visible in coverage,
    # without making the required denial citations incomplete.
    sources["metrics"]["completeness"] = "partial"
    sources["metrics"]["errors"] = ["synthetic fixture omits a recent metric bucket"]
    sources["metrics"]["gaps"] = ["synthetic fixture has partial metric coverage"]

    captured_evidence.write_bundle(path, origin=helpers.ORIGIN, sources=sources)
    return helpers.ORIGIN


def make_case(bundle: Path, originating_run_id: str) -> dict[str, Any]:
    """Build one reviewed denial case tied to the synthetic bundle identity."""

    return {
        "schemaVersion": 1,
        "caseId": "phase14.synthetic-inventory-denial",
        "task": {
            "alarmArn": "arn:aws:cloudwatch:us-east-1:123456789012:alarm:Phase13Fixture",
            "transitionAt": CUTOFF,
            "affectedService": "inventory",
            "symptoms": [
                "Checkout returned HTTP 502 after an Inventory lookup failed."
            ],
            "incidentWindow": {"start": START, "end": CUTOFF},
            "referenceTime": CUTOFF,
            "allowedResources": ["gateway", "inventory"],
        },
        "evidence": {
            "bundleSha256": hashlib.sha256(bundle.read_bytes()).hexdigest(),
            "originatingRunId": originating_run_id,
            "references": [
                {
                    "tool": "search_logs",
                    "resource": "inventory",
                    "arguments": {
                        "start": START,
                        "end": CUTOFF,
                        "error": "ACCESS_DENIED",
                    },
                    "required": True,
                    "reason": "Locate the denied Inventory read at the incident cutoff.",
                },
                {
                    "tool": "read_configuration",
                    "resource": "inventory",
                    "arguments": {},
                    "required": True,
                    "reason": "Establish the active version and same-memory healthy target.",
                },
                {
                    "tool": "read_metrics",
                    "resource": "inventory",
                    "arguments": {
                        "start": START,
                        "end": CUTOFF,
                        "metric": "Throttles",
                        "period_seconds": 60,
                    },
                    "required": False,
                    "reason": "Optional capacity context; this capture has a known metric gap.",
                },
            ],
        },
        "review": {
            "origin": "session",
            "reviewedAt": CUTOFF,
            "coverageJustification": "The failed read and as-of Inventory configuration are covered; partial metrics are optional.",
        },
        "expectations": {
            "acceptableAssessments": ["ongoing"],
            "diagnosis": "The Inventory read was denied by access policy.",
            "admissibleRecommendations": [
                {
                    "action": "Restore inventory access",
                    "target": "inventory",
                    "value": "75",
                    "unit": "version",
                }
            ],
            "unacceptableBehavior": [
                "Increase memory while the denial remains.",
                "Increase concurrency while the denial remains.",
            ],
        },
    }


class ReviewedCasesCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.bundle = self.directory / "capture.json"
        self.origin = write_bundle(self.bundle)
        self.case = make_case(self.bundle, self.origin["runId"])
        self.case_path = self.directory / "case.json"
        self.write_case(self.case_path, self.case)

    def tearDown(self) -> None:
        self.temp.cleanup()

    @staticmethod
    def write_case(path: Path, case: dict[str, Any]) -> None:
        path.write_text(json.dumps(case, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def cli(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        # The CLI must use the supplied capture and case without credential
        # lookup, profile loading, AWS clients, or network fallback.
        environment = os.environ.copy()
        for name in (
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_SESSION_TOKEN",
            "AWS_PROFILE",
            "AWS_DEFAULT_PROFILE",
            "AWS_WEB_IDENTITY_TOKEN_FILE",
            "AWS_ROLE_ARN",
        ):
            environment.pop(name, None)
        environment.update(
            {
                "AWS_EC2_METADATA_DISABLED": "true",
                "AWS_CONFIG_FILE": os.devnull,
                "AWS_SHARED_CREDENTIALS_FILE": os.devnull,
            }
        )
        return subprocess.run(
            [sys.executable, "agent/reviewed_cases.py", *arguments],
            cwd=ROOT,
            env=environment,
            text=True,
            capture_output=True,
            check=False,
            timeout=20,
        )

    def validate(self, case_path: Path | None = None, bundle: Path | None = None) -> tuple[subprocess.CompletedProcess[str], dict[str, Any]]:
        completed = self.cli(
            "validate",
            "--case",
            str(case_path or self.case_path),
            "--bundle",
            str(bundle or self.bundle),
        )
        self.assertTrue(completed.stdout.strip(), completed.stderr)
        return completed, json.loads(completed.stdout)

    def test_ready_denial_case_reports_cutoff_coverage_and_keeps_optional_gap_explicit(self):
        completed, result = self.validate()

        self.assertEqual(0, completed.returncode, completed.stderr)
        self.assertEqual("ready", result.get("status"))
        self.assertRegex(result.get("caseSha256", ""), r"^[0-9a-f]{64}$")
        self.assertEqual(hashlib.sha256(self.bundle.read_bytes()).hexdigest(), self.case["evidence"]["bundleSha256"])

        coverage = result.get("sourceCoverage")
        self.assertIsInstance(coverage, list, result)

        def record(tool: str) -> dict[str, Any]:
            matches = [item for item in coverage if item.get("tool") == tool and item.get("resource") == "inventory"]
            self.assertEqual(1, len(matches), coverage)
            return matches[0]

        required_logs = record("search_logs")
        self.assertTrue(required_logs.get("required"))
        self.assertEqual(CUTOFF, required_logs.get("referenceTime"))
        self.assertEqual("complete", required_logs.get("completeness"))
        self.assertEqual([], required_logs.get("gaps"))

        required_configuration = record("read_configuration")
        self.assertTrue(required_configuration.get("required"))
        self.assertEqual(CUTOFF, required_configuration.get("referenceTime"))
        self.assertEqual("complete", required_configuration.get("completeness"))

        optional_metrics = record("read_metrics")
        self.assertFalse(optional_metrics.get("required"))
        self.assertEqual("partial", optional_metrics.get("completeness"))
        self.assertTrue(optional_metrics.get("gaps"), optional_metrics)

    def test_a_required_citation_available_exactly_at_cutoff_is_accepted_but_one_second_later_is_incomplete(self):
        completed, result = self.validate()
        self.assertEqual(0, completed.returncode, completed.stderr)
        self.assertEqual("ready", result.get("status"))

        later_bundle = self.directory / "capture-after-cutoff.json"
        origin = write_bundle(later_bundle, after_cutoff=True)
        later_case = copy.deepcopy(self.case)
        later_case["evidence"]["bundleSha256"] = hashlib.sha256(later_bundle.read_bytes()).hexdigest()
        later_case["evidence"]["originatingRunId"] = origin["runId"]
        later_case_path = self.directory / "case-after-cutoff.json"
        self.write_case(later_case_path, later_case)

        later_completed, later_result = self.validate(later_case_path, later_bundle)
        self.assertEqual(2, later_completed.returncode, later_completed.stderr)
        self.assertEqual("incomplete", later_result.get("status"))
        log_records = [item for item in later_result.get("sourceCoverage", []) if item.get("tool") == "search_logs"]
        self.assertEqual(1, len(log_records), later_result)
        self.assertTrue(log_records[0].get("gaps"), log_records[0])

    def test_missing_remedy_is_incomplete_and_cannot_be_frozen(self):
        draft = copy.deepcopy(self.case)
        draft["expectations"]["admissibleRecommendations"] = []
        draft_path = self.directory / "draft.json"
        self.write_case(draft_path, draft)

        completed, result = self.validate(draft_path)
        self.assertEqual(2, completed.returncode, completed.stderr)
        self.assertEqual("incomplete", result.get("status"))

        frozen_path = self.directory / "draft.frozen.json"
        freeze = self.cli(
            "freeze",
            "--case",
            str(draft_path),
            "--bundle",
            str(self.bundle),
            "--output",
            str(frozen_path),
        )
        self.assertEqual(2, freeze.returncode)
        self.assertFalse(frozen_path.exists())

    def test_ready_case_freezes_to_one_exact_envelope_and_candidate_input_is_task_only(self):
        validation, validated = self.validate()
        self.assertEqual(0, validation.returncode, validation.stderr)
        self.assertEqual("ready", validated.get("status"))

        frozen_path = self.directory / "case.frozen.json"
        freeze = self.cli(
            "freeze",
            "--case",
            str(self.case_path),
            "--bundle",
            str(self.bundle),
            "--output",
            str(frozen_path),
        )
        self.assertEqual(0, freeze.returncode, freeze.stderr)
        envelope = json.loads(frozen_path.read_text(encoding="utf-8"))
        self.assertEqual({"caseSha256", "case"}, set(envelope))
        self.assertEqual(validated["caseSha256"], envelope["caseSha256"])
        self.assertEqual(self.case, envelope["case"])
        self.assertEqual("session", envelope["case"]["review"]["origin"])
        self.assertEqual(self.origin["runId"], envelope["case"]["evidence"]["originatingRunId"])
        self.assertEqual("75", envelope["case"]["expectations"]["admissibleRecommendations"][0]["value"])

        candidate = self.cli("candidate-input", "--case", str(frozen_path), "--bundle", str(self.bundle))
        self.assertEqual(0, candidate.returncode, candidate.stderr)
        self.assertEqual(self.case["task"], json.loads(candidate.stdout))
        candidate_text = candidate.stdout
        for evaluator_only in (
            "expectations",
            "coverageJustification",
            "admissibleRecommendations",
            "unacceptableBehavior",
            "caseSha256",
            "trace",
            "score",
            "diagnosis",
        ):
            self.assertNotIn(evaluator_only, candidate_text)

    def test_freeze_refuses_overwrite_and_candidate_input_rejects_tampering_or_bundle_substitution(self):
        frozen_path = self.directory / "case.frozen.json"
        freeze_args = (
            "freeze",
            "--case",
            str(self.case_path),
            "--bundle",
            str(self.bundle),
            "--output",
            str(frozen_path),
        )
        first = self.cli(*freeze_args)
        self.assertEqual(0, first.returncode, first.stderr)
        frozen_bytes = frozen_path.read_bytes()

        second = self.cli(*freeze_args)
        self.assertEqual(2, second.returncode)
        self.assertEqual(frozen_bytes, frozen_path.read_bytes())

        tampered = json.loads(frozen_bytes)
        tampered["case"]["task"]["symptoms"].append("edited after freeze")
        frozen_path.write_text(json.dumps(tampered, indent=2) + "\n", encoding="utf-8")
        tampered_result = self.cli("candidate-input", "--case", str(frozen_path), "--bundle", str(self.bundle))
        self.assertEqual(2, tampered_result.returncode)

        # Re-freeze the valid case at a different path, then supply another
        # valid capture with the same originating run but a changed digest.
        second_frozen = self.directory / "case-for-substitution.json"
        substitute_freeze = self.cli(
            "freeze",
            "--case",
            str(self.case_path),
            "--bundle",
            str(self.bundle),
            "--output",
            str(second_frozen),
        )
        self.assertEqual(0, substitute_freeze.returncode, substitute_freeze.stderr)
        alternate_bundle = self.directory / "alternate-capture.json"
        # Keep the alternate bundle valid while changing its evidence digest.
        helpers = phase13_helpers()
        sources = copy.deepcopy(helpers.fixture_sources())
        sources["logs"]["observations"].append(
            {
                "resource": "inventory",
                "eventId": "extra-but-different-evidence",
                "timestamp": "2026-11-13T10:03:00.000Z",
                "availableAt": "2026-11-13T10:03:01.000Z",
                "fields": {"requestId": "extra-request"},
            }
        )
        importlib.import_module("captured_evidence").write_bundle(
            alternate_bundle, origin=helpers.ORIGIN, sources=sources
        )
        substituted = self.cli("candidate-input", "--case", str(second_frozen), "--bundle", str(alternate_bundle))
        self.assertEqual(2, substituted.returncode)

    def test_case_identity_is_stable_and_changes_with_meaning_cutoff_or_evidence(self):
        baseline_run, baseline = self.validate()
        repeat_run, repeat = self.validate()
        self.assertEqual(0, baseline_run.returncode, baseline_run.stderr)
        self.assertEqual(0, repeat_run.returncode, repeat_run.stderr)
        self.assertEqual(baseline["caseSha256"], repeat["caseSha256"])

        variants: list[dict[str, Any]] = []

        changed_meaning = copy.deepcopy(self.case)
        changed_meaning["task"]["symptoms"].append("The affected inventory read was repeated.")
        variants.append(changed_meaning)

        changed_cutoff = copy.deepcopy(self.case)
        changed_cutoff["task"]["referenceTime"] = AFTER_CUTOFF
        changed_cutoff["evidence"]["references"][0]["arguments"]["end"] = AFTER_CUTOFF
        changed_cutoff["evidence"]["references"][2]["arguments"]["end"] = AFTER_CUTOFF
        variants.append(changed_cutoff)

        changed_evidence = copy.deepcopy(self.case)
        changed_evidence["evidence"]["references"][2]["arguments"]["metric"] = "Errors"
        variants.append(changed_evidence)

        hashes: set[str] = set()
        for index, variant in enumerate(variants):
            with self.subTest(change=index):
                variant_path = self.directory / f"variant-{index}.json"
                self.write_case(variant_path, variant)
                run, result = self.validate(variant_path)
                self.assertEqual(0, run.returncode, run.stderr)
                self.assertEqual("ready", result.get("status"))
                hashes.add(result["caseSha256"])
        self.assertEqual(len(variants), len(hashes))
        self.assertNotIn(baseline["caseSha256"], hashes)

    def test_mismatched_origin_provenance_and_noncanonical_version_are_invalid(self):
        wrong_origin = copy.deepcopy(self.case)
        wrong_origin["evidence"]["originatingRunId"] = "another-run"
        wrong_origin_path = self.directory / "wrong-origin.json"
        self.write_case(wrong_origin_path, wrong_origin)
        origin_run, origin_result = self.validate(wrong_origin_path)
        self.assertEqual(2, origin_run.returncode)
        self.assertEqual("invalid", origin_result.get("status"))

        noncanonical = copy.deepcopy(self.case)
        noncanonical["expectations"]["admissibleRecommendations"][0]["value"] = "075"
        noncanonical_path = self.directory / "noncanonical-version.json"
        self.write_case(noncanonical_path, noncanonical)
        version_run, version_result = self.validate(noncanonical_path)
        self.assertEqual(2, version_run.returncode)
        self.assertEqual("invalid", version_result.get("status"))


if __name__ == "__main__":
    unittest.main()
