"""Offline contract tests for the public native denial example."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
for module_path in (ROOT / "agent", ROOT / "examples/live-denial"):
    if str(module_path) not in sys.path:
        sys.path.insert(0, str(module_path))


def load_runner():
    path = ROOT / "examples/live-denial/strands_denial.py"
    spec = importlib.util.spec_from_file_location("strands_denial_contract", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load native denial runner")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class NativeDenialContractTests(unittest.TestCase):
    def setUp(self):
        self.runner = load_runner()

    def evaluate(self, expected, actual):
        return self.runner.RecommendedAction().evaluate(
            SimpleNamespace(expected_output=expected, actual_output=actual)
        )[0]

    def test_valid_wrong_action_is_red_and_other_requires_explanation(self):
        expected = {"action": "Restore inventory access", "target": "inventory", "value": "75", "unit": "version"}
        wrong = {"action": "Increase memory", "target": "inventory", "value": 512, "unit": "MB"}
        self.assertFalse(self.evaluate(expected, wrong).test_pass)
        other = {"action": "Other", "target": None, "unit": None}
        self.assertTrue(self.evaluate(other, {**other, "value": "verify"}).test_pass)
        self.assertFalse(self.evaluate(other, {**other, "value": ""}).test_pass)

    def test_malformed_reviewed_expectation_fails_closed(self):
        malformed = {"action": "Restore inventory access", "target": "inventory", "value": "bad", "unit": "version"}
        with self.assertRaises(SystemExit):
            self.evaluate(malformed, {"action": "Increase memory", "target": "inventory", "value": 512, "unit": "MB"})

    def test_invalid_native_other_shape_is_rejected(self):
        task = {"referenceTime": "2026-01-01T00:00:00Z", "allowedResources": ["inventory"]}
        frozen = {
            "case": {
                "caseId": "frozen.denial", "task": task,
                "evidence": {"bundleSha256": "b", "originatingRunId": "run", "traceRef": {"traceId": "trace", "runId": "run"}},
                "expectations": {"admissibleRecommendations": [{"action": "Other", "target": None, "unit": None, "value": {"nonEmptyExplanation": True}}]},
            },
            "task": task, "bundleSha256": "b", "caseSha256": "a", "originatingRunId": "run",
        }
        with TemporaryDirectory() as directory:
            scenario = Path(directory) / "denial-case.json"
            scenario.write_text(json.dumps({
                "scenario_id": "native.denial", "metadata": {
                    "source": {"trace_id": "trace", "session_id": "source"},
                    "expected_recommendation": {"action": "Other", "target": "inventory", "unit": None, "value": None},
                },
            }))
            with patch.object(self.runner.strands_denial_io, "load_frozen_case", return_value=frozen):
                with self.assertRaises(ValueError):
                    self.runner.strands_denial_io.load_inputs(scenario, Path("case"), Path("bundle"))

    def test_cli_is_strict_and_distinguishes_zero_one_two(self):
        identity = {
            "nativeId": "native.denial", "nativeSession": "source-session", "frozenId": "frozen.denial",
            "caseSha256": "a" * 64, "traceId": "trace", "bundleSha256": "b" * 64,
            "originatingRunId": "run", "expected": {"action": "Other", "target": None, "unit": None},
        }
        actual = {"action": "Other", "target": None, "unit": None, "value": "verify"}
        with TemporaryDirectory() as directory:
            result = Path(directory) / "result.json"
            scenario = Path(directory) / "denial-case.json"
            scenario.write_text("{}")
            with patch.object(self.runner, "run_experiment", return_value=(identity, "fresh", actual, SimpleNamespace(test_pass=True, score=1.0, reason="ok"))):
                self.assertEqual(self.runner.main(["--scenario", str(scenario), "--result", str(result)]), 0)
                self.assertEqual(self.runner.main(["--frozen-only", "--result", str(result)]), 0)
            with patch.object(self.runner, "run_experiment", return_value=(identity, "fresh", actual, SimpleNamespace(test_pass=False, score=0.0, reason="wrong"))):
                self.assertEqual(self.runner.main(["--scenario", str(scenario), "--result", str(result)]), 1)
            with patch.object(self.runner, "run_experiment", side_effect=RuntimeError("model unavailable")):
                self.assertEqual(self.runner.main(["--scenario", str(scenario), "--result", str(result)]), 2)
            self.assertEqual(self.runner.main(["--scenario", str(Path(directory) / "missing.json"), "--result", str(result)]), 2)


if __name__ == "__main__":
    unittest.main()
