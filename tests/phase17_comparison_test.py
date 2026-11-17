"""Acceptance for offline comparison of saved captured executions."""

from __future__ import annotations

from contextlib import redirect_stdout
from io import StringIO
import json
import multiprocessing
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from phase14_reviewed_cases_test import make_case, write_bundle
from phase15_deterministic_checks_test import recommendation, report_for
from phase16_baseline_test import EVALUATOR_ID, MODEL_ID, ROOT, ScriptedBedrock

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider

import captured_execution
import evaluate_case
from agentcore_evaluation import evaluator_config
from reviewed_cases import freeze_case


class OfflineComparisonAcceptance(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.bundle = self.root / "bundle.json"
        origin = write_bundle(self.bundle)
        self.case = make_case(self.bundle, origin["runId"])
        self.frozen = self.freeze("denial", self.case)
        self.agent = self.root / "agent"
        shutil.copytree(ROOT / "agent", self.agent, ignore=shutil.ignore_patterns(".venv", "__pycache__"))
        if not isinstance(trace.get_tracer_provider(), TracerProvider):
            trace.set_tracer_provider(TracerProvider())

    def freeze(self, label, case):
        source = self.root / f"{label}.json"
        source.write_text(json.dumps(case), encoding="utf-8")
        frozen = source.with_suffix(".frozen.json")
        freeze_case(source, self.bundle, frozen)
        return frozen

    def run_candidate(self, *, repaired=False, case=None, frozen=None, reads=None):
        if repaired:
            prompt = self.agent / "prompt.py"
            prompt.write_text(
                prompt.read_text(encoding="utf-8")
                + '\nSYSTEM_PROMPT += "\\nUse the applicable remedy supported by the captured evidence."\n'
                + 'PROMPT_SHA256 = hashlib.sha256(SYSTEM_PROMPT.encode("utf-8")).hexdigest()\n',
                encoding="utf-8",
            )
        action = (recommendation("Restore inventory access", "inventory", "75", "version")
                  if repaired else recommendation("Increase memory", "inventory", 512, "MB"))
        record_report = report_for(action, late_citation=not repaired)
        model = ScriptedBedrock(record_report, (case or self.case)["task"], reads=reads)
        selected = {"candidate_id": "repaired"} if repaired else {}
        with patch.object(captured_execution, "AGENT_DIRECTORY", self.agent):
            run = captured_execution.run_captured_case(
                frozen or self.frozen,
                self.bundle,
                self.root / "runs",
                model_session=model,
                **selected,
            )
        record = json.loads((run / "execution.json").read_bytes())
        self.assertEqual(record["status"], "complete", record.get("failure"))
        return run

    def invoke(self, *args):
        output = StringIO()
        with patch.object(sys, "argv", ["evaluate_case.py", *map(str, args)]), redirect_stdout(output):
            return_code = evaluate_case.main()
        return return_code, json.loads(output.getvalue())

    def score(self, run, *, evaluator_id=EVALUATOR_ID, label="pass", explanation="Matching saved session.", observe=None):
        record, _, spans = captured_execution.load_execution(run)
        config = evaluator_config(MODEL_ID, "single")
        arn = f"arn:aws:bedrock-agentcore:{evaluate_case.REGION}:{evaluate_case.ACCOUNT}:evaluator/{evaluator_id}"
        pin = self.root / f"{evaluator_id}.json"
        pin.write_text(json.dumps({
            "evaluatorId": evaluator_id, "evaluatorArn": arn, "judgeModelId": MODEL_ID,
            "evaluatorMode": "single", "configSha256": evaluate_case._digest(config),
        }), encoding="utf-8")
        configuration = {
            "evaluatorId": evaluator_id, "evaluatorArn": arn, "evaluatorConfig": config,
            "status": "ACTIVE", "level": "SESSION",
        }
        verdict = {
            "evaluatorId": evaluator_id, "context": {"spanContext": {"sessionId": record["identity"]["sessionId"]}},
            "label": label, "explanation": explanation,
        }
        def fetch(session_id, trace_id):
            if observe is not None:
                observe("waiting_for_telemetry")
            self.assertEqual(session_id, record["identity"]["sessionId"])
            self.assertEqual(trace_id, record["identity"]["traceId"])
            return spans

        def evaluate(**request):
            if observe is not None:
                observe("scoring")
            self.assertEqual(request["evaluationInput"]["sessionSpans"], spans)
            return {"evaluationResults": [verdict]}

        clients = {
            "bedrock-agentcore-control": SimpleNamespace(get_evaluator=lambda **_: configuration),
            "logs": object(),
            "bedrock-agentcore": SimpleNamespace(evaluate=evaluate),
        }
        aws = SimpleNamespace(client=lambda name, **_: clients[name])
        with patch.object(evaluate_case, "_aws", return_value=aws), patch.object(
            evaluate_case, "CloudWatchSession", return_value=fetch
        ):
            code, result = self.invoke("score", "--run", run, "--evaluator", pin, "--wait-seconds", 0)
        self.assertEqual(code, 0, result)
        return result["scoringAttemptId"]

    def compare(self, baseline, candidate, *options):
        with patch.object(evaluate_case.boto3, "Session", side_effect=AssertionError("comparison opened AWS")):
            return self.invoke("compare", "--baseline", baseline, "--candidate", candidate, *options)

    def test_show_reports_waiting_and_scoring_on_the_same_attempt(self):
        run = self.run_candidate()
        observations = []

        def inspect(expected_phase):
            with patch.object(evaluate_case.boto3, "Session", side_effect=AssertionError("show opened AWS")):
                code, shown = self.invoke("show", "--run", run)
            self.assertEqual(code, 0, shown)
            observations.append((expected_phase, shown["scoringAttempts"]))

        attempt = self.score(run, observe=inspect)
        self.assertEqual([phase for phase, _ in observations], ["waiting_for_telemetry", "scoring"])
        for phase, rows in observations:
            self.assertEqual(len(rows), 1, rows)
            self.assertEqual(rows[0]["status"], "pending", rows[0])
            self.assertEqual(rows[0]["phase"], phase, rows[0])
            self.assertEqual(rows[0]["scoringAttemptId"], attempt)
        _, shown = self.invoke("show", "--run", run)
        self.assertEqual(len(shown["scoringAttempts"]), 1)
        self.assertEqual(shown["scoringAttempts"][0]["status"], "complete")
        self.assertEqual(shown["scoringAttempts"][0]["scoringAttemptId"], attempt)
        self.assertNotIn("phase", shown["scoringAttempts"][0])

    def test_lost_score_owner_does_not_leave_pending_work_or_restart_execution(self):
        run = self.run_candidate()
        execution_before = (run / "execution.json").read_bytes()
        context = multiprocessing.get_context("fork")
        entered = context.Event()
        release = context.Event()

        def wait_at_evaluate(phase):
            if phase == "scoring":
                entered.set()
                release.wait(15)

        process = context.Process(target=self.score, args=(run,), kwargs={"observe": wait_at_evaluate})
        process.start()
        try:
            self.assertTrue(entered.wait(10), "test scorer never submitted its saved session")
            _, active = self.invoke("show", "--run", run)
            self.assertEqual(len(active["scoringAttempts"]), 1)
            self.assertEqual(active["scoringAttempts"][0]["status"], "pending")
        finally:
            if process.is_alive():
                process.kill()
            process.join(10)
        self.assertFalse(process.is_alive())
        _, shown = self.invoke("show", "--run", run)
        self.assertEqual(shown["status"], "complete")
        self.assertEqual(len(shown["scoringAttempts"]), 1)
        self.assertEqual(shown["scoringAttempts"][0]["status"], "interrupted")
        self.assertEqual(shown["scoringAttempts"][0]["scoringAttemptId"], active["scoringAttempts"][0]["scoringAttemptId"])
        self.assertEqual((run / "execution.json").read_bytes(), execution_before)

    def test_compare_reports_missing_runs_through_the_offline_cli(self):
        code, result = self.compare(self.root / "missing", self.root / "also-missing")
        self.assertNotEqual(code, 0, result)
        self.assertIn("unavailable", result["reason"].lower())

    def test_compare_reports_matching_runs_and_requires_explicit_choice_after_rejudge(self):
        baseline = self.run_candidate()
        original_attempt = self.score(baseline, explanation="Original advisory pass.")
        candidate = self.run_candidate(
            repaired=True, reads=({"resource": "inventory", "limit": 1},),
        )
        repaired_attempt = self.score(candidate, label="fail", explanation="Questioned the repaired report's citation.")
        baseline_receipt = json.loads((baseline / "scores" / original_attempt / "result.json").read_bytes())
        candidate_receipt = json.loads((candidate / "scores" / repaired_attempt / "result.json").read_bytes())
        self.assertNotEqual(baseline_receipt["assertions"], candidate_receipt["assertions"])
        return_code, result = self.compare(baseline, candidate)
        self.assertEqual(return_code, 0, result)
        self.assertEqual(result["status"], "complete")
        before, after = result["baseline"], result["candidate"]
        self.assertEqual(before["identity"]["caseSha256"], after["identity"]["caseSha256"])
        self.assertNotEqual(before["identity"]["executionId"], after["identity"]["executionId"])
        self.assertNotEqual(before["identity"]["promptSha256"], after["identity"]["promptSha256"])
        self.assertEqual(before["report"]["recommendation"]["action"], "Increase memory")
        self.assertEqual(after["report"]["recommendation"], recommendation("Restore inventory access", "inventory", "75", "version"))
        self.assertEqual(before["deterministic"]["findings"]["action"]["verdict"], "fail")
        self.assertEqual(before["deterministic"]["findings"]["as_of_time"]["verdict"], "fail")
        self.assertEqual(after["deterministic"]["findings"]["action"]["verdict"], "pass")
        self.assertEqual(before["score"]["scoringAttemptId"], original_attempt)
        self.assertEqual(after["score"]["scoringAttemptId"], repaired_attempt)
        self.assertEqual(before["score"]["semantic"]["findings"]["semantic_quality"]["verdict"], "pass")
        repaired_feedback = after["score"]["semantic"]["findings"]["semantic_quality"]
        self.assertEqual(repaired_feedback["verdict"], "fail")
        self.assertEqual(repaired_feedback["explanation"], "Questioned the repaired report's citation.")

        self.score(baseline, label="fail", explanation="Later review disagreed about source coverage.")
        ambiguous_code, ambiguous_result = self.compare(baseline, candidate)
        self.assertNotEqual(ambiguous_code, 0, ambiguous_result)
        self.assertIn("attempt", ambiguous_result["reason"].lower())
        explicit_code, explicit_result = self.compare(baseline, candidate, "--baseline-attempt", original_attempt)
        self.assertEqual(explicit_code, 0, explicit_result)
        selected = explicit_result["baseline"]["score"]
        self.assertEqual(selected["scoringAttemptId"], original_attempt)
        self.assertEqual(selected["semantic"]["findings"]["semantic_quality"]["verdict"], "pass")
        self.assertEqual(selected["semantic"]["findings"]["semantic_quality"]["explanation"], "Original advisory pass.")

    def test_comparison_is_incomplete_with_missing_score_or_different_evaluator(self):
        baseline = self.run_candidate()
        self.score(baseline)
        candidate = self.run_candidate(repaired=True)
        return_code, awaiting = self.compare(baseline, candidate)
        self.assertNotEqual(return_code, 0, awaiting)
        self.assertEqual(awaiting["status"], "incomplete")
        self.assertIn("scor", awaiting["reason"].lower())
        self.assertEqual(awaiting["baseline"]["identity"]["executionId"], baseline.name)
        self.assertEqual(awaiting["candidate"]["identity"]["executionId"], candidate.name)
        self.assertEqual(awaiting["baseline"]["deterministic"]["findings"]["action"]["verdict"], "fail")
        self.assertEqual(awaiting["baseline"]["deterministic"]["findings"]["as_of_time"]["verdict"], "fail")
        self.assertEqual(awaiting["candidate"]["report"]["recommendation"]["value"], "75")

        self.score(candidate, evaluator_id="IncidentTriageSemantic-0000000002")
        return_code, foreign = self.compare(baseline, candidate)
        self.assertNotEqual(return_code, 0, foreign)
        self.assertIn("evaluator", foreign["reason"].lower())

    def test_comparison_rejects_different_reviewed_case_with_same_task(self):
        baseline = self.run_candidate()
        self.score(baseline)
        other_case = json.loads(json.dumps(self.case))
        other_case["review"]["coverageJustification"] += " A second review recorded the partial scope."
        other_case["expectations"]["diagnosis"] += " The reviewed scope is Inventory GetItem."
        frozen = self.freeze("different-review", other_case)
        candidate = self.run_candidate(repaired=True, case=other_case, frozen=frozen)
        self.score(candidate)
        return_code, result = self.compare(baseline, candidate)
        self.assertNotEqual(return_code, 0, result)
        self.assertIn("case", result["reason"].lower())

    def test_comparison_rejects_score_from_the_other_execution(self):
        baseline = self.run_candidate()
        baseline_attempt = self.score(baseline)
        candidate = self.run_candidate(repaired=True)
        (candidate / "scores").mkdir()
        source_score = baseline / "scores" / baseline_attempt / "result.json"
        copied_dir = candidate / "scores" / baseline_attempt
        copied_dir.mkdir()
        score = json.loads(source_score.read_bytes())
        current = json.loads((candidate / "execution.json").read_bytes())["identity"]
        # A shallow identity check should not accept the foreign telemetry
        # and semantic row after a receipt was moved and relabeled.
        score["executionId"] = current["executionId"]
        score["identity"] = current
        (copied_dir / "result.json").write_text(json.dumps(score), encoding="utf-8")
        return_code, result = self.compare(baseline, candidate)
        self.assertNotEqual(return_code, 0, result)
        self.assertRegex(result["reason"].lower(), r"session|trace|report|execution")

        shutil.rmtree(copied_dir)
        candidate_attempt = self.score(candidate)
        receipt = candidate / "scores" / candidate_attempt / "result.json"
        bound = json.loads(receipt.read_bytes())
        foreign_session = score["telemetry"]["sessionId"]
        # Keep the candidate execution and CloudWatch digest intact. Only
        # the returned semantic row now belongs to the other session.
        semantic = bound["semantic"]
        for row in (
            semantic["findings"]["semantic_quality"],
            semantic["findings"]["semantic_quality"]["rawResult"],
            semantic["rawResponse"]["evaluationResults"][0],
        ):
            row["context"]["spanContext"]["sessionId"] = foreign_session
        receipt.write_text(json.dumps(bound), encoding="utf-8")
        return_code, result = self.compare(baseline, candidate)
        self.assertNotEqual(return_code, 0, result)
        self.assertRegex(result["reason"].lower(), r"session|semantic")

    def test_comparison_rejects_changes_to_common_execution_source(self):
        baseline = self.run_candidate()
        self.score(baseline)
        runner = self.agent / "captured_execution.py"
        contents = runner.read_text(encoding="utf-8")
        changed = contents.replace("MAX_TOOL_CALLS = 12", "MAX_TOOL_CALLS = 13", 1)
        self.assertNotEqual(changed, contents)
        runner.write_text(changed, encoding="utf-8")
        candidate = self.run_candidate(repaired=True)
        self.score(candidate)
        return_code, result = self.compare(baseline, candidate)
        self.assertNotEqual(return_code, 0, result)
        self.assertIn("source", result["reason"].lower())

    def test_comparison_rejects_foreign_semantic_trace_and_evaluator_rows(self):
        baseline = self.run_candidate()
        self.score(baseline)
        candidate = self.run_candidate(repaired=True)
        attempt = self.score(candidate)
        receipt = candidate / "scores" / attempt / "result.json"
        saved = json.loads(receipt.read_bytes())
        finding = saved["semantic"]["findings"]["semantic_quality"]
        raw = saved["semantic"]["rawResponse"]["evaluationResults"][0]
        finding["context"]["spanContext"]["traceId"] = "f" * 32
        finding["rawResult"]["context"]["spanContext"]["traceId"] = "f" * 32
        raw["context"]["spanContext"]["traceId"] = "f" * 32
        receipt.write_text(json.dumps(saved), encoding="utf-8")
        code, result = self.compare(baseline, candidate)
        self.assertNotEqual(code, 0, result)
        self.assertIn("trace", result["reason"].lower())

        saved = json.loads((candidate / "scores" / attempt / "result.json").read_bytes())
        finding = saved["semantic"]["findings"]["semantic_quality"]
        raw = saved["semantic"]["rawResponse"]["evaluationResults"][0]
        finding["context"]["spanContext"].pop("traceId", None)
        finding["rawResult"]["context"]["spanContext"].pop("traceId", None)
        raw["context"]["spanContext"].pop("traceId", None)
        finding["evaluatorId"] = raw["evaluatorId"] = "foreign-evaluator"
        receipt.write_text(json.dumps(saved), encoding="utf-8")
        code, result = self.compare(baseline, candidate)
        self.assertNotEqual(code, 0, result)
        self.assertIn("evaluator", result["reason"].lower())

    def test_comparison_rejects_native_row_errors_and_tampered_evidence_digest(self):
        baseline = self.run_candidate()
        self.score(baseline)
        candidate = self.run_candidate(repaired=True)
        attempt = self.score(candidate)
        receipt = candidate / "scores" / attempt / "result.json"

        saved = json.loads(receipt.read_bytes())
        raw = saved["semantic"]["rawResponse"]["evaluationResults"][0]
        raw["ignoredReferenceInputFields"] = ["assertions"]
        receipt.write_text(json.dumps(saved), encoding="utf-8")
        code, result = self.compare(baseline, candidate)
        self.assertNotEqual(code, 0, result)
        self.assertIn("ignored", result["reason"].lower())

        saved = json.loads(receipt.read_bytes())
        raw = saved["semantic"]["rawResponse"]["evaluationResults"][0]
        raw.pop("ignoredReferenceInputFields", None)
        raw["errorCode"] = "NativeEvaluatorError"
        receipt.write_text(json.dumps(saved), encoding="utf-8")
        code, result = self.compare(baseline, candidate)
        self.assertNotEqual(code, 0, result)
        self.assertIn("error", result["reason"].lower())

        saved = json.loads(receipt.read_bytes())
        raw = saved["semantic"]["rawResponse"]["evaluationResults"][0]
        raw.pop("errorCode", None)
        raw["evaluationDimensionName"] = "foreign-dimension"
        receipt.write_text(json.dumps(saved), encoding="utf-8")
        code, result = self.compare(baseline, candidate)
        self.assertNotEqual(code, 0, result)
        self.assertIn("dimension", result["reason"].lower())

        saved = json.loads(receipt.read_bytes())
        raw = saved["semantic"]["rawResponse"]["evaluationResults"][0]
        raw.pop("evaluationDimensionName", None)
        saved["telemetry"]["sha256"] = "0" * 64
        saved["evidenceSha256"] = "0" * 64
        receipt.write_text(json.dumps(saved), encoding="utf-8")
        code, result = self.compare(baseline, candidate)
        self.assertNotEqual(code, 0, result)
        self.assertIn("digest", result["reason"].lower())

    def test_comparison_rejects_response_errors_and_inconsistent_normalized_rows(self):
        baseline = self.run_candidate()
        self.score(baseline)
        candidate = self.run_candidate(repaired=True)
        attempt = self.score(candidate)
        receipt = candidate / "scores" / attempt / "result.json"
        original = receipt.read_bytes()
        saved = json.loads(original)
        saved["semantic"]["rawResponse"]["errorCode"] = "NativeEvaluatorError"
        receipt.write_text(json.dumps(saved), encoding="utf-8")
        code, result = self.compare(baseline, candidate)
        self.assertNotEqual(code, 0, result)
        self.assertIn("error", result["reason"].lower())

        saved = json.loads(original)
        saved["semantic"]["findings"]["semantic_quality"]["rawResult"]["errorCode"] = "ForeignError"
        receipt.write_text(json.dumps(saved), encoding="utf-8")
        code, result = self.compare(baseline, candidate)
        self.assertNotEqual(code, 0, result)
        self.assertIn("normalized", result["reason"].lower())

    def test_comparison_rejects_different_scoring_source_with_same_evaluator(self):
        baseline = self.run_candidate()
        self.score(baseline)
        candidate = self.run_candidate(repaired=True)
        scorer = self.agent / "agentcore_evaluation.py"
        scorer.write_text(scorer.read_text(encoding="utf-8") + "\n# A separate scoring revision.\n", encoding="utf-8")
        with patch.object(evaluate_case, "__file__", str(self.agent / "evaluate_case.py")):
            self.score(candidate)
        return_code, result = self.compare(baseline, candidate)
        self.assertNotEqual(return_code, 0, result)
        self.assertRegex(result["reason"].lower(), r"scor")
