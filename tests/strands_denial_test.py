"""Offline contract tests for the public native denial example."""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch
import unittest


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


def write_inputs(root: Path, *, trace_id: str = "trace-1") -> tuple[Path, Path]:
    prompt = "Investigate the alarm."
    scenario = {
        "scenario_id": "scenario-1",
        "metadata": {
            "source": {"trace_id": trace_id, "session_id": "source-session"},
            "expected_recommendation": {
                "action": "Restore inventory access", "target": "inventory",
                "value": "167", "unit": "version",
            },
        },
        "turns": [{"input": prompt, "expected_response": "Restore access."}],
    }
    def event(name: str, content: object) -> dict[str, object]:
        return {"name": name, "attributes": {"content": json.dumps(content)}}
    trace = [{
        "traceId": trace_id,
        "name": "chat",
        "startTimeUnixNano": 20,
        "attributes": {"session.id": "source-session"},
        "events": [
            event("gen_ai.user.message", [{"text": prompt}]),
            event("gen_ai.assistant.message", [
                {"reasoningContent": {"reasoningText": {"signature": "signed"}}},
                {"toolUse": {"name": "search_logs", "input": {}}},
            ]),
            event("gen_ai.tool.message", [{"toolResult": {"content": [{"text": "denied"}]}}]),
            {"name": "gen_ai.choice", "attributes": {"message": json.dumps([
                {"reasoningContent": {"reasoningText": {"signature": "signed"}}},
                {"toolUse": {"name": "InvestigationReport", "input": {}}},
            ])}},
        ],
    }]
    scenario_path, trace_path = root / "denial-case.json", root / "original-trace.json"
    scenario_path.write_text(json.dumps(scenario, indent=2) + "\n", encoding="utf-8")
    trace_path.write_text(json.dumps(trace, indent=2) + "\n", encoding="utf-8")
    return scenario_path, trace_path


class NativeDenialContractTests(unittest.TestCase):
    def setUp(self):
        self.runner = load_runner()

    def test_provider_has_no_new_reads(self):
        self.assertEqual(self.runner.NoNewReads().tools(), [])

    def test_case_and_exact_trace_are_digest_bound_and_signed_blocks_omitted(self):
        with TemporaryDirectory() as directory:
            scenario, trace = write_inputs(Path(directory))
            loaded = self.runner.strands_denial_io.load_inputs(scenario, trace)
            self.assertEqual(loaded["scenarioSha256"], hashlib.sha256(scenario.read_bytes()).hexdigest())
            self.assertEqual(loaded["traceSha256"], hashlib.sha256(trace.read_bytes()).hexdigest())
            self.assertEqual(loaded["traceId"], "trace-1")
            messages, omitted = self.runner.public_decision_messages(
                loaded["scenario"]["turns"][0]["input"],
                self.runner.select_decision(loaded["scenario"], loaded["trace"])["events"],
            )
            self.assertEqual(omitted, 1)
            self.assertEqual(messages[0], {"role": "user", "content": [{"text": "Investigate the alarm."}]})
            self.assertNotIn("reasoningContent", json.dumps(messages))

    def test_mismatched_span_trace_is_incomplete_input(self):
        with TemporaryDirectory() as directory:
            scenario, trace = write_inputs(Path(directory))
            raw = json.loads(trace.read_text(encoding="utf-8"))
            raw[0]["traceId"] = "different"
            trace.write_text(json.dumps(raw), encoding="utf-8")
            with self.assertRaises(self.runner.strands_denial_io.InputMismatch):
                self.runner.strands_denial_io.load_inputs(scenario, trace)

    def test_native_evaluator_and_exact_action_are_separate(self):
        expected = {"action": "Restore inventory access", "target": "inventory", "value": "167", "unit": "version"}
        wrong = {"action": "Increase memory", "target": "inventory", "value": 512, "unit": "MB"}
        self.assertFalse(self.runner.exact_action_matches(expected, wrong))
        self.assertTrue(self.runner.exact_action_matches(expected, expected))

    def test_cli_distinguishes_pass_fail_and_incomplete(self):
        identity = {
            "scenarioId": "scenario-1", "scenarioSha256": "a" * 64,
            "traceSha256": "b" * 64, "traceId": "trace-1", "sourceSessionId": "source-session",
            "sessionId": "fresh-session",
            "expected": {"action": "Restore inventory access", "target": "inventory", "value": "167", "unit": "version"},
            "decisionStartTimeUnixNano": "20", "spanCount": 1, "signedBlocksOmitted": 1,
        }
        actual = identity["expected"]
        row = SimpleNamespace(test_pass=True, score=1.0, reason="actual_output matches expected value")
        prompt_module = SimpleNamespace(SYSTEM_PROMPT="prompt", PROMPT_SHA256=hashlib.sha256(b"prompt").hexdigest(), __file__=__file__)
        investigation_module = SimpleNamespace(__file__=__file__)
        with TemporaryDirectory() as directory:
            result = Path(directory) / "strands-result.json"
            with patch.object(self.runner.strands_denial_io, "prompt_digest", return_value=prompt_module.PROMPT_SHA256):
                with patch.object(self.runner, "run_experiment", return_value=(identity, actual, row, "PASS")):
                    code = self.runner.strands_denial_io.run_cli(
                        self.runner.run_experiment, prompt_module=prompt_module,
                        investigation_module=investigation_module, model_id="model",
                        argv=["--scenario", str(Path(directory) / "case.json"), "--trace", str(Path(directory) / "trace.json"), "--result", str(result)],
                    )
            self.assertEqual(code, 0)
            receipt = json.loads(result.read_text())
            self.assertEqual(receipt["status"], "pass")
            self.assertNotEqual(receipt["sessionId"], receipt["sourceSessionId"])
            with patch.object(self.runner.strands_denial_io, "prompt_digest", return_value=prompt_module.PROMPT_SHA256):
                with patch.object(self.runner, "run_experiment", return_value=(identity, actual, SimpleNamespace(test_pass=False, score=0.0, reason="wrong"), "FAIL")):
                    code = self.runner.strands_denial_io.run_cli(
                        self.runner.run_experiment, prompt_module=prompt_module,
                        investigation_module=investigation_module, model_id="model",
                        argv=["--scenario", str(Path(directory) / "case.json"), "--trace", str(Path(directory) / "trace.json"), "--result", str(result)],
                    )
            self.assertEqual(code, 1)
            with patch.object(self.runner.strands_denial_io, "prompt_digest", return_value=prompt_module.PROMPT_SHA256):
                with patch.object(self.runner, "run_experiment", side_effect=RuntimeError("model unavailable")):
                    code = self.runner.strands_denial_io.run_cli(
                        self.runner.run_experiment, prompt_module=prompt_module,
                        investigation_module=investigation_module, model_id="model",
                        argv=["--scenario", str(Path(directory) / "case.json"), "--trace", str(Path(directory) / "trace.json"), "--result", str(result)],
                    )
            self.assertEqual(code, 2)
            self.assertEqual(json.loads(result.read_text())["status"], "incomplete")


if __name__ == "__main__":
    unittest.main()
