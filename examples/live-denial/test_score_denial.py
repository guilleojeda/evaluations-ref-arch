"""Check the case, trace and reviewed answer used by the public scoring example."""

import io
import json
import runpy
import tempfile
import unittest
from contextlib import chdir, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from bedrock_agentcore.evaluation.utils import cloudwatch_span_helper


SCRIPT = Path(__file__).with_name("score_denial.py").resolve()


class OriginalTraceTest(unittest.TestCase):
    def test_scores_only_the_selected_trace_with_its_reviewed_answer(self):
        source = {
            "trace_id": "selected-trace",
            "session_id": "source-session",
            "cloudwatch_logs": {"log_group_names": ["test/runtime"]},
        }
        case = {"scenario_id": "sample", "metadata": {"source": source, "expected_recommendation": {"action": "Other", "target": None, "unit": None}}, "turns": [{
            "input": "Investigate the alarm.\nStarted: 2026-01-01T12:00:05Z",
            "expected_response": "Keep the recovered configuration and verify checkout.",
        }]}
        recorded = {"traceId": "selected-trace", "name": "incident_triage.investigation",
                    "attributes": {"incident.report": json.dumps({"recommendation": {"action": "Increase memory"}})}}
        other = {**recorded, "traceId": "another-trace"}
        with tempfile.TemporaryDirectory() as tmp, chdir(tmp):
            Path("denial-case.json").write_text(json.dumps(case))
            with patch.object(cloudwatch_span_helper, "fetch_spans_from_cloudwatch", return_value=[other, recorded]) as fetch, \
                 patch("boto3.Session") as session, redirect_stdout(io.StringIO()) as printed:
                session.return_value.region_name = "test-region"
                evaluate = session.return_value.client.return_value.evaluate
                evaluate.return_value = {"evaluationResults": [{
                    "label": "Correct", "value": 1.0, "explanation": "The diagnosis identifies the denial.",
                }]}
                runpy.run_path(str(SCRIPT), run_name="__main__")
            self.assertEqual(fetch.call_args.kwargs["session_id"], "source-session")
            self.assertEqual(fetch.call_args.kwargs["region"], "test-region")
            request = evaluate.call_args.kwargs
            self.assertEqual(request["evaluationInput"]["sessionSpans"], [recorded])
            self.assertEqual(request["evaluationTarget"]["traceIds"], ["selected-trace"])
            reference, = request["evaluationReferenceInputs"]
            self.assertEqual(reference["context"]["spanContext"], {"sessionId": "source-session", "traceId": "selected-trace"})
            self.assertEqual(reference["expectedResponse"]["text"], case["turns"][0]["expected_response"])
            self.assertIn("Exact action: FAIL", printed.getvalue())
            self.assertIn("AgentCore: Correct 1.0", printed.getvalue())
            self.assertEqual(json.loads(Path("original-score.json").read_text())["exactAction"], "FAIL")

    def test_ongoing_version_and_recovered_explanation(self):
        matches = runpy.run_path(str(SCRIPT))["exact_action_matches"]
        restore = {"action": "Restore inventory access", "target": "inventory", "unit": "version", "value": "42"}
        self.assertTrue(matches(restore, restore))
        self.assertFalse(matches(restore, {**restore, "value": "43"}))
        recovered = {"action": "Other", "target": None, "unit": None}
        self.assertTrue(matches(recovered, {**recovered, "value": "Verify another checkout."}))
        self.assertFalse(matches(recovered, {**recovered, "value": ""}))
        self.assertFalse(matches(recovered, restore))

    def test_an_unreviewed_draft_never_calls_aws(self):
        with tempfile.TemporaryDirectory() as tmp, chdir(tmp):
            Path("denial-case.json").write_text('{"turns":[{"input":"Investigate this alarm"}]}')
            with patch("boto3.Session") as aws, self.assertRaisesRegex(SystemExit, "expected_response"):
                runpy.run_path(str(SCRIPT), run_name="__main__")
            aws.assert_not_called()


if __name__ == "__main__":
    unittest.main()
