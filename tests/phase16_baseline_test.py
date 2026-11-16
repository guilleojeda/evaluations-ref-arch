"""Acceptance at the captured-run and CloudWatch-to-AgentCore boundaries."""

from __future__ import annotations

import copy
from datetime import datetime
import hashlib
from itertools import count
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from botocore.session import get_session

from phase14_reviewed_cases_test import make_case, write_bundle
from phase15_deterministic_checks_test import recommendation, report_for


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))

from reviewed_cases import freeze_case, load_frozen_case  # noqa: E402
from captured_evidence import write_bundle as write_captured_bundle  # noqa: E402


EXECUTION_ID = "843d3f25-924f-41af-bef2-f6c083f6552d"
SESSION_ID = "incident-triage-eval-843d3f25-924f-41af-bef2-f6c083f6552d"
TRACE_ID = "1" * 32
ROOT_SPAN = "a" * 16
MODEL_SPAN = "b" * 16
TOOL_SPAN = "c" * 16
REPORT_SPAN = "d" * 16
FAILED_TOOL_SPAN = "e" * 16
EVALUATOR_ID = "IncidentTriageSemantic-0000000001"
MODEL_ID = "us.anthropic.claude-sonnet-4-6"
SOURCE_DIGEST = "a" * 64
PROMPT_DIGEST = "b" * 64
LOCK_DIGEST = "c" * 64


class EvaluationService:
    """Substitute only for the AWS Evaluate service."""

    def __init__(self, session_id=SESSION_ID):
        self.calls = []
        self.session_id = session_id

    def evaluate(self, **request):
        self.calls.append(request)
        return {
            "evaluationResults": [
                {
                    "evaluatorId": EVALUATOR_ID,
                    "evaluationDimensionName": dimension,
                    "context": {"spanContext": {"sessionId": self.session_id}},
                    "label": "pass",
                    "explanation": "The synthetic session supports this criterion.",
                }
                for dimension in ("diagnosis_support", "evidence_grounding")
            ]
        }


class ScriptedBedrock:
    """ConverseStream responses for real Strands and captured tools."""

    def __init__(self, report, task, reads=None):
        self.report = report
        self.task = task
        self.requests = []
        self.reads = iter(reads if reads is not None else ({"resource": "inventory", "service": "gateway"}, {"resource": "inventory"}))
        self.region_name = "us-east-1"
        self.meta = SimpleNamespace(
            region_name=self.region_name,
            service_model=get_session().get_service_model("bedrock-runtime"),
        )

    def client(self, service_name, **_kwargs):
        if service_name != "bedrock-runtime":
            raise AssertionError(f"Captured execution requested live AWS service {service_name}")
        return self

    def converse_stream(self, **request):
        self.requests.append(copy.deepcopy(request))
        call_id = f"tool-{len(self.requests)}"
        tool_config = request.get("toolConfig", {})
        forced = tool_config.get("toolChoice", {}).get("tool", {}).get("name")
        if forced == "InvestigationReport":
            name, arguments = "InvestigationReport", self.report
        else:
            scope = next(self.reads, None)
            name = "search_logs" if scope is not None else None
            arguments = {
                **(scope or {}), "start": self.task["incidentWindow"]["start"],
                "end": self.task["referenceTime"],
            }
        events = [{"messageStart": {"role": "assistant"}}]
        if name is None:
            events.append({"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "I inspected the captured Inventory evidence."}}})
        else:
            events.extend((
                {"contentBlockStart": {"contentBlockIndex": 0, "start": {"toolUse": {"toolUseId": call_id, "name": name}}}},
                {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"toolUse": {"input": json.dumps(arguments)}}}},
            ))
        events.extend((
            {"contentBlockStop": {"contentBlockIndex": 0}},
            {"messageStop": {"stopReason": "tool_use" if name else "end_turn"}},
            {"metadata": {"usage": {"inputTokens": 3, "outputTokens": 2, "totalTokens": 5}, "metrics": {"latencyMs": 1}}},
        ))
        return {"stream": iter(events)}


class OverBudgetScriptedBedrock(ScriptedBedrock):
    """Emit one native response with 13 reads, then return the report."""

    def converse_stream(self, **request):
        self.requests.append(copy.deepcopy(request))
        forced = request.get("toolConfig", {}).get("toolChoice", {}).get("tool", {}).get("name")
        if forced == "InvestigationReport" or len(self.requests) > 1:
            requested = [("InvestigationReport", self.report)]
        else:
            requested = [("search_logs", {"resource": "inventory"}) for _ in range(13)]
        events = [{"messageStart": {"role": "assistant"}}]
        for index, (name, arguments) in enumerate(requested):
            call_id = f"tool-{len(self.requests)}-{index}"
            events.extend((
                {
                    "contentBlockStart": {
                        "contentBlockIndex": index,
                        "start": {"toolUse": {"toolUseId": call_id, "name": name}},
                    }
                },
                {
                    "contentBlockDelta": {
                        "contentBlockIndex": index,
                        "delta": {"toolUse": {"input": json.dumps(arguments)}},
                    }
                },
                {"contentBlockStop": {"contentBlockIndex": index}},
            ))
        events.extend((
            {"messageStop": {"stopReason": "tool_use"}},
            {"metadata": {"usage": {"inputTokens": 3, "outputTokens": 2, "totalTokens": 5}, "metrics": {"latencyMs": 1}}},
        ))
        return {"stream": iter(events)}


class FailedArgumentsScriptedBedrock(ScriptedBedrock):
    """Emit one native tool request with a schema-invalid array argument."""

    def converse_stream(self, **request):
        if self.requests:
            return super().converse_stream(**request)
        self.requests.append(copy.deepcopy(request))
        call_id = "tool-1"
        arguments = [{"resource": "inventory"}]
        events = [
            {"messageStart": {"role": "assistant"}},
            {"contentBlockStart": {"contentBlockIndex": 0, "start": {"toolUse": {"toolUseId": call_id, "name": "search_logs"}}}},
            {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"toolUse": {"input": json.dumps(arguments)}}}},
            {"contentBlockStop": {"contentBlockIndex": 0}},
            {"messageStop": {"stopReason": "tool_use"}},
            {"metadata": {"usage": {"inputTokens": 3, "outputTokens": 2, "totalTokens": 5}, "metrics": {"latencyMs": 1}}},
        ]
        return {"stream": iter(events)}


def session_span(span_id, name, *, operation, events, **attributes):
    span = {
        "spanId": span_id,
        "traceId": TRACE_ID,
        "name": name,
        "kind": "INTERNAL",
        "scope": {"name": "strands.telemetry.tracer"},
        "startTimeUnixNano": 1794823200000000000,
        "endTimeUnixNano": 1794823201000000000,
        "attributes": {
            "session.id": SESSION_ID,
            "gen_ai.operation.name": operation,
            **attributes,
        },
        "events": events,
    }
    if span_id != ROOT_SPAN:
        span["parentSpanId"] = ROOT_SPAN
    return span


def span_event(name, **attributes):
    return {"name": name, "attributes": attributes}


def tool_events(call_id, arguments, result):
    return [
        span_event("gen_ai.tool.message", content=json.dumps(arguments), role="tool", id=call_id),
        span_event("gen_ai.choice", message=json.dumps([{"text": json.dumps(result)}]), id=call_id),
    ]


class CapturedBaselineAcceptance(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.source = root / "case.json"
        self.frozen = root / "frozen.json"
        self.bundle = root / "bundle.json"
        self.output_root = root / "runs"
        origin = write_bundle(self.bundle)
        self.case = make_case(self.bundle, origin["runId"])
        self.source.write_text(json.dumps(self.case), encoding="utf-8")
        freeze_case(self.source, self.bundle, self.frozen)
        self.loaded = load_frozen_case(self.frozen, self.bundle)

    def test_valid_captured_run_records_real_tool_results_and_reopens_offline(self):
        # The future acquisition cannot make an earlier event retroactively visible.
        bundle = json.loads(self.bundle.read_text())
        logs = bundle["sources"]["logs"]
        logs["observedAt"] = "2026-11-13T10:06:30.000Z"
        early = next(log for log in logs["observations"] if log["eventId"] == "log-early")
        for key in ("timestamp", "ingestionTime"):
            early[key] = int(datetime.fromisoformat(early[key]).timestamp() * 1000)
        early.pop("availableAt")
        late = next(log for log in logs["observations"] if log["eventId"] == "log-late")
        late["observedAt"] = late.pop("availableAt")
        late.pop("ingestionTime")
        logs["scope"].append("gateway")
        logs["observations"].append({
            "resource": "gateway",
            "eventId": "excluded-gateway-log",
            "timestamp": "2026-11-13T10:01:00.000Z",
            "availableAt": "2026-11-13T10:01:10.000Z",
            "fields": {"requestId": "excluded-gateway-request", "status": "502"},
        })
        future = next(log for log in logs["observations"] if log["eventId"] == "log-future")
        future["timestamp"] = "2026-11-13T10:04:59.000Z"
        write_captured_bundle(self.bundle, origin=bundle["origin"], sources=bundle["sources"])
        case = make_case(self.bundle, self.loaded["originatingRunId"])
        case["task"]["allowedResources"] = ["inventory"]
        case["expectations"]["diagnosis"] += " PRIVATE_REFERENCE_FOR_JUDGE"
        self.source.write_text(json.dumps(case), encoding="utf-8")
        reviewed = self.source.with_name("narrow-frozen.json")
        freeze_case(self.source, self.bundle, reviewed)
        report = report_for(recommendation("Increase memory", "inventory", 512, "MB"))
        report["evidence"] = [{
            "source": "cloudwatch", "resource": "inventory",
            "windowStart": case["task"]["incidentWindow"]["start"],
            "windowEnd": case["task"]["referenceTime"],
            "observedAt": case["task"]["referenceTime"],
            "finding": "The returned Inventory read was denied.",
        }]
        from evaluate_case import run_captured_case
        from opentelemetry.sdk.trace import TracerProvider

        bedrock = ScriptedBedrock(
            report,
            case["task"],
            reads=(
                {"resource": "inventory", "limit": "not-an-integer"},
                {"resource": "inventory", "service": "gateway"},
                {"resource": "inventory"},
            ),
        )
        from opentelemetry import trace
        trace.set_tracer_provider(TracerProvider())
        run_dir = Path(run_captured_case(reviewed, self.bundle, self.output_root, model_session=bedrock))

        from captured_execution import load_execution
        from evaluation_telemetry import score_execution

        record, reopened_case, native_spans = load_execution(run_dir)
        evaluate = EvaluationService(session_id=record["identity"]["sessionId"])

        scored = score_execution(
            record,
            reopened_case,
            fetch_session=lambda _session_id, _trace_id: copy.deepcopy(native_spans),
            evaluation_client=evaluate,
            evaluator_id=EVALUATOR_ID,
            wait_seconds=0,
            verified_spans=native_spans,
        )
        self.assertEqual(scored["status"], "complete", scored)
        self.assertEqual(len(evaluate.calls), 1)
        self.assertEqual(evaluate.calls[0]["evaluationInput"]["sessionSpans"], native_spans)
        self.assertEqual(record["evidenceToolCallCount"], 3)
        self.assertEqual(record["evidenceProviderCallCount"], 2)

        self.assertTrue(run_dir.is_dir())
        self.assertGreaterEqual(len(bedrock.requests), 3)
        self.assertTrue(all(item["modelId"] == MODEL_ID for item in bedrock.requests))
        requests = json.dumps(bedrock.requests)
        self.assertNotIn("PRIVATE_REFERENCE_FOR_JUDGE", requests)
        self.assertNotIn("excluded-gateway-request", requests)
        self.assertNotIn("request-future", requests)
        self.assertIn("request-early", requests)
        self.assertIn("request-late", requests)
        self.assertIn(case["task"]["referenceTime"], requests)
        self.assertEqual(
            {"search_logs", "read_metrics", "read_configuration", "read_change_history", "InvestigationReport"},
            {item["toolSpec"]["name"] for item in bedrock.requests[0]["toolConfig"]["tools"]},
        )
        saved = {path.relative_to(run_dir): path.read_bytes() for path in run_dir.rglob("*") if path.is_file()}
        env = {name: value for name, value in os.environ.items() if not name.startswith("AWS_")}
        env.update(AWS_CONFIG_FILE=os.devnull, AWS_SHARED_CREDENTIALS_FILE=os.devnull, AWS_EC2_METADATA_DISABLED="true")
        result = subprocess.run(
            [sys.executable, str(ROOT / "agent" / "evaluate_case.py"), "show", "--run", str(run_dir)],
            cwd=ROOT, env=env, capture_output=True, text=True, timeout=15,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        shown = json.loads(result.stdout)
        self.assertEqual(shown["report"], report)
        self.assertNotEqual(shown["identity"]["executionId"], self.loaded["originatingRunId"])
        tools = shown["ledger"]["toolCalls"]
        self.assertEqual(
            [step["arguments"].get("service") for step in tools if step["tool"] == "search_logs"],
            [None, "gateway", None],
        )
        self.assertTrue(any(
            step["status"] == "error" and step["arguments"].get("limit") == "not-an-integer"
            for step in tools
        ))
        self.assertTrue(any(step["status"] == "error" and step["arguments"].get("service") == "gateway" for step in tools))
        self.assertEqual(shown["evidenceToolCallCount"], 3)
        self.assertEqual(shown["evidenceProviderCallCount"], 2)
        self.assertEqual(len(shown["ledger"]["modelCalls"]), len(bedrock.requests))
        findings = shown["deterministic"]["findings"]
        self.assertEqual((findings["action"]["verdict"], findings["target"]["verdict"]), ("fail", "pass"))
        self.assertEqual(findings["as_of_time"]["verdict"], "pass")
        self.assertEqual(findings["source_scope"]["verdict"], "pass")
        self.assertEqual(findings["operator_boundary"]["verdict"], "pass")
        self.assertEqual(saved, {path.relative_to(run_dir): path.read_bytes() for path in run_dir.rglob("*") if path.is_file()})

        execution_path = run_dir / "execution.json"
        pristine_execution = execution_path.read_bytes()
        for tamper in ("report", "ledger"):
            with self.subTest(tamper=tamper):
                changed = json.loads(pristine_execution)
                if tamper == "report":
                    changed["report"]["summary"] = "Tampered after the run completed."
                    report_bytes = json.dumps(
                        changed["report"], ensure_ascii=False, sort_keys=True,
                        separators=(",", ":"), allow_nan=False,
                    ).encode("utf-8")
                    changed["identity"]["reportSha256"] = hashlib.sha256(report_bytes).hexdigest()
                else:
                    changed["ledger"]["modelCalls"][0]["output"] += " tampered"
                execution_path.write_text(json.dumps(changed), encoding="utf-8")
                try:
                    with self.assertRaises(ValueError):
                        load_execution(run_dir)
                finally:
                    execution_path.write_bytes(pristine_execution)

        with patch.object(trace.get_tracer_provider(), "force_flush", return_value=False):
            interrupted_dir = run_captured_case(
                reviewed, self.bundle, self.output_root,
                model_session=ScriptedBedrock(report, case["task"]),
            )
        interrupted, _, _ = load_execution(interrupted_dir)
        self.assertEqual(interrupted["status"], "interrupted")
        self.assertEqual(interrupted["report"], report)
        self.assertEqual(interrupted["deterministic"]["inputKind"], "report_only")
        self.assertEqual(interrupted["deterministic"]["findings"]["action"]["verdict"], "fail")

    def test_tool_budget_rejection_keeps_native_attempt_and_scoreable_ledger(self):
        from captured_execution import load_execution
        from evaluate_case import run_captured_case
        from evaluation_telemetry import score_execution
        from opentelemetry import trace
        from opentelemetry.sdk.trace import TracerProvider

        report = report_for(recommendation("Restore inventory access", "inventory", "75", "version"))
        report["evidence"] = [{
            "source": "cloudwatch",
            "resource": "inventory",
            "windowStart": self.case["task"]["incidentWindow"]["start"],
            "windowEnd": self.case["task"]["referenceTime"],
            "observedAt": self.case["task"]["referenceTime"],
            "finding": "The returned Inventory read was denied.",
        }]
        bedrock = OverBudgetScriptedBedrock(report, self.case["task"])
        if not isinstance(trace.get_tracer_provider(), TracerProvider):
            trace.set_tracer_provider(TracerProvider())

        run_dir = Path(run_captured_case(
            self.frozen, self.bundle, self.output_root, model_session=bedrock,
        ))
        record, loaded_case, native_spans = load_execution(run_dir)

        self.assertEqual(record["status"], "complete", record)
        self.assertEqual(len(bedrock.requests), 2)
        self.assertEqual(record["modelRequestCount"], 2)
        self.assertEqual(record["evidenceToolCallCount"], 13)
        self.assertEqual(record["evidenceProviderCallCount"], 12)
        calls = record["ledger"]["toolCalls"]
        self.assertEqual(len(calls), 13)
        self.assertEqual([call["status"] for call in calls[:12]], ["success"] * 12)
        self.assertEqual(calls[-1]["tool"], "search_logs")
        self.assertEqual(calls[-1]["status"], "error")
        self.assertIn("ToolBudgetExceeded", calls[-1]["result"]["error"])

        evaluate = EvaluationService(session_id=record["identity"]["sessionId"])
        scored = score_execution(
            record,
            loaded_case,
            fetch_session=lambda _session_id, _trace_id: copy.deepcopy(native_spans),
            evaluation_client=evaluate,
            evaluator_id=EVALUATOR_ID,
            wait_seconds=0,
            verified_spans=native_spans,
        )
        self.assertEqual(scored["status"], "complete", scored)
        self.assertEqual(scored["deterministic"]["status"], "complete")
        self.assertEqual(scored["deterministic"]["findings"]["action"]["verdict"], "pass")
        self.assertEqual(scored["telemetry"]["status"], "complete")
        self.assertEqual(len(evaluate.calls), 1)

    def test_native_failed_array_arguments_are_retained_and_scoreable(self):
        from captured_execution import load_execution
        from evaluate_case import run_captured_case
        from evaluation_telemetry import score_execution
        from opentelemetry import trace
        from opentelemetry.sdk.trace import TracerProvider

        report = report_for(recommendation("Increase memory", "inventory", 512, "MB"))
        report["evidence"] = [{
            "source": "cloudwatch",
            "resource": "inventory",
            "windowStart": self.case["task"]["incidentWindow"]["start"],
            "windowEnd": self.case["task"]["referenceTime"],
            "observedAt": self.case["task"]["referenceTime"],
            "finding": "The returned Inventory read was denied.",
        }]
        if not isinstance(trace.get_tracer_provider(), TracerProvider):
            trace.set_tracer_provider(TracerProvider())
        bedrock = FailedArgumentsScriptedBedrock(report, self.case["task"])
        run_dir = Path(run_captured_case(
            self.frozen, self.bundle, self.output_root, model_session=bedrock,
        ))
        record, loaded_case, native_spans = load_execution(run_dir)
        calls = record["ledger"]["toolCalls"]
        self.assertEqual(calls[0]["status"], "error")
        self.assertEqual(calls[0]["arguments"], [{"resource": "inventory"}])
        self.assertEqual(calls[0]["result"], {
            "error": "Error: Validation failed for input parameters: "
            "strands.tools.decorator.Search_logsTool() argument after ** must be a mapping, not list",
        })

        evaluate = EvaluationService(session_id=record["identity"]["sessionId"])
        scored = score_execution(
            record, loaded_case,
            fetch_session=lambda _session_id, _trace_id: copy.deepcopy(native_spans),
            evaluation_client=evaluate,
            evaluator_id=EVALUATOR_ID,
            wait_seconds=0,
            verified_spans=native_spans,
        )
        self.assertEqual(scored["status"], "complete", scored)
        self.assertEqual(scored["deterministic"]["findings"]["operator_boundary"]["status"], "complete")
        self.assertEqual(scored["telemetry"]["status"], "complete")
        self.assertEqual(len(evaluate.calls), 1)

    def test_run_refuses_modified_frozen_input_before_any_cloud_work(self):
        envelope = json.loads(self.frozen.read_text())
        envelope["case"]["task"]["symptoms"][0] += " Modified after review."
        self.frozen.write_text(json.dumps(envelope))
        environment = {
            name: value for name, value in os.environ.items()
            if not name.startswith("AWS_")
        }
        environment.update(
            AWS_CONFIG_FILE=os.devnull,
            AWS_SHARED_CREDENTIALS_FILE=os.devnull,
            AWS_EC2_METADATA_DISABLED="true",
        )
        result = subprocess.run(
            [
                sys.executable, str(ROOT / "agent" / "evaluate_case.py"), "run",
                "--case", str(self.frozen), "--bundle", str(self.bundle),
                "--output-root", str(self.output_root),
            ],
            cwd=ROOT, env=environment, capture_output=True, text=True, timeout=15,
        )
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("caseSha256", result.stdout)
        self.assertFalse(self.output_root.exists() and any(self.output_root.iterdir()))

    def test_score_waits_for_matching_content_and_keeps_rejudging_separate(self):
        from evaluate_case import score_execution

        task = self.loaded["task"]
        # The telemetry time is a new execution. Captured evidence stays at the case cutoff.
        report = report_for(recommendation("Increase memory", "inventory", 512, "MB"))
        report_digest = hashlib.sha256(
            json.dumps(report, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        arguments = {"resource": "inventory"}
        returned = {"coverage": "partial", "observations": []}
        # The failed native call retains the raw JSON value the model sent;
        # Strands does not coerce a rejected array into the tool's object schema.
        rejected_arguments = [{"resource": "invented"}]
        rejected_result = {"error": "Requested resource is unsupported."}
        model_input = "Inspect Inventory."
        model_output = "I will check Inventory."
        model_events = [
            span_event("gen_ai.system.message", content="System instructions for the candidate."),
            span_event("gen_ai.user.message", content=model_input),
            span_event("gen_ai.assistant.message", content="I will inspect the evidence."),
            span_event("gen_ai.tool.message", content="Prior tool result context.", role="tool", id="context-1"),
            span_event("gen_ai.assistant.message", content="The tool result is relevant."),
            span_event("gen_ai.choice", message=model_output),
        ]
        projected_model_events = [
            {"name": event["name"], "attributes": event["attributes"]}
            for event in model_events
        ]
        execution = {
            "status": "complete",
            "identity": {
                "executionId": EXECUTION_ID,
                "sessionId": SESSION_ID,
                "traceId": TRACE_ID,
                "candidateId": "faulty",
                "sourceSha256": SOURCE_DIGEST,
                "promptSha256": PROMPT_DIGEST,
                "dependencySha256": LOCK_DIGEST,
                "modelId": MODEL_ID,
                "originatingRunId": self.loaded["originatingRunId"],
                "caseSha256": self.loaded["caseSha256"],
                "bundleSha256": self.loaded["bundleSha256"],
                "referenceTime": self.loaded["referenceTime"],
                "reportSha256": report_digest,
            },
            "report": report,
            "ledger": {
                "agentSpanId": ROOT_SPAN,
                "modelCalls": [{
                    "spanId": MODEL_SPAN, "input": model_input, "output": model_output,
                    "events": projected_model_events,
                }],
                "toolCalls": [
                    {
                        "spanId": TOOL_SPAN,
                        "callId": "configuration-1",
                        "tool": "read_configuration",
                        "arguments": arguments,
                        "status": "success",
                        "result": returned,
                    },
                    {
                        "spanId": FAILED_TOOL_SPAN,
                        "callId": "configuration-2",
                        "tool": "read_configuration",
                        "arguments": rejected_arguments,
                        "status": "error",
                        "result": rejected_result,
                    },
                ],
                "reportSpanId": REPORT_SPAN,
            },
        }
        ready = [
            session_span(ROOT_SPAN, "invoke_agent", operation="invoke_agent", events=[
                span_event("gen_ai.user.message", content=json.dumps([{"text": json.dumps(task)}])),
                span_event("gen_ai.choice", message="See the structured investigation report.", finish_reason="end_turn"),
            ], **{
                "incident.execution_id": EXECUTION_ID,
                "incident.originating_run_id": self.loaded["originatingRunId"],
                "incident.case_sha256": self.loaded["caseSha256"],
                "incident.bundle_sha256": self.loaded["bundleSha256"],
                "incident.reference_time": self.loaded["referenceTime"],
                "incident.candidate_id": "faulty",
                "incident.source_sha256": SOURCE_DIGEST,
                "incident.prompt_sha256": PROMPT_DIGEST,
                "incident.dependency_sha256": LOCK_DIGEST,
            }),
            session_span(MODEL_SPAN, "chat", operation="chat", events=model_events, **{
                "gen_ai.request.model": MODEL_ID,
            }),
            session_span(TOOL_SPAN, "execute_tool read_configuration", operation="execute_tool",
                         events=tool_events("configuration-1", arguments, returned), **{
                "gen_ai.tool.name": "read_configuration",
                "gen_ai.tool.call.id": "configuration-1",
                "gen_ai.tool.status": "success",
            }),
            session_span(FAILED_TOOL_SPAN, "execute_tool read_configuration", operation="execute_tool",
                         events=tool_events("configuration-2", rejected_arguments, rejected_result), **{
                "gen_ai.tool.name": "read_configuration",
                "gen_ai.tool.call.id": "configuration-2",
                "gen_ai.tool.status": "error",
            }),
            session_span(REPORT_SPAN, "execute_tool InvestigationReport", operation="execute_tool",
                         events=tool_events("report-1", report, {"status": "success"}), **{
                "gen_ai.tool.name": "InvestigationReport",
                "gen_ai.tool.call.id": "report-1",
                "gen_ai.tool.status": "success",
            }),
        ]
        service = EvaluationService()

        def score(spans, *, record=execution):
            def fetch(session_id, trace_id):
                self.assertEqual((session_id, trace_id), (SESSION_ID, TRACE_ID))
                return copy.deepcopy(spans)

            return score_execution(
                record, self.loaded, fetch_session=fetch, evaluation_client=service,
                evaluator_id=EVALUATOR_ID, wait_seconds=0, verified_spans=ready,
            )

        wrong_tool = copy.deepcopy(ready)
        wrong_tool[2]["events"][1]["attributes"]["message"] = '[{"text":"{}"}]'
        truncated_report = copy.deepcopy(ready)
        truncated_report[-1]["events"][0]["attributes"]["content"] = json.dumps(report)[:-8]
        other_snapshot = copy.deepcopy(ready)
        other_snapshot[0]["attributes"]["incident.prompt_sha256"] = "f" * 64
        different_report = copy.deepcopy(ready)
        substituted = {**report, "summary": "A complete but different report."}
        different_report[-1]["events"][0]["attributes"]["content"] = json.dumps(substituted)
        metadata_only_model = copy.deepcopy(ready)
        metadata_only_model[1]["events"].clear()
        foreign_tool = copy.deepcopy(ready)
        foreign_tool[2]["attributes"]["session.id"] = "different-session"
        mismatched_tool_error = copy.deepcopy(ready)
        mismatched_tool_error[3]["events"].pop()
        mismatched_model = copy.deepcopy(ready)
        mismatched_model[1]["events"][1]["attributes"]["content"] = "Unrelated model request."
        extra_judge_event_field = copy.deepcopy(ready)
        extra_judge_event_field[1]["events"][1]["attributes"]["message"] = "Unbound assistant context."
        wrong_task = copy.deepcopy(ready)
        wrong_task[0]["events"][0]["attributes"]["content"] = '[{"text":"A different task."}]'
        missing_hidden_context = copy.deepcopy(ready)
        missing_hidden_context[1]["events"] = [
            event for event in missing_hidden_context[1]["events"]
            if event["name"] not in {
                "gen_ai.system.message", "gen_ai.assistant.message", "gen_ai.tool.message",
            }
        ]
        successful_arguments_array = copy.deepcopy(ready)
        successful_arguments_array[2]["events"][0]["attributes"]["content"] = json.dumps(
            [{"resource": "inventory"}]
        )

        for case, mutation in (
            ("empty", []),
            ("first nonempty", ready[:1]),
            ("missing model", [ready[0], *ready[2:]]),
            ("missing tool", [*ready[:2], *ready[3:]]),
            ("missing failed tool", [*ready[:3], ready[-1]]),
            ("missing report", ready[:-1]),
            ("unmatched trace", [{**ready[0], "traceId": "9" * 32}, *ready[1:]]),
            ("conflicting duplicate span", [*ready, different_report[-1]]),
            ("wrong tool payload", wrong_tool),
            ("successful tool arguments are not an object", successful_arguments_array),
            ("truncated report", truncated_report),
            ("different report", different_report),
            ("different candidate snapshot", other_snapshot),
            ("model payload missing", metadata_only_model),
            ("model payload substituted", mismatched_model),
            ("extra judge-visible event field", extra_judge_event_field),
            ("model system/assistant/tool context missing", missing_hidden_context),
            ("foreign tool session", foreign_tool),
            ("failed tool result missing", mismatched_tool_error),
            ("different public task", wrong_task),
        ):
            with self.subTest(case=case):
                self.assertIn(score(mutation)["status"], {"incomplete", "error"})
                self.assertEqual(service.calls, [])

        for key, wrong in (
            ("referenceTime", "2026-11-16T03:02:30.945Z"),
            ("caseSha256", "e" * 64),
            ("bundleSha256", "d" * 64),
        ):
            with self.subTest(key=key):
                mismatched = {**execution, "identity": {**execution["identity"], key: wrong}}
                self.assertIn(score(ready, record=mismatched)["status"], {"incomplete", "error"})
                self.assertEqual(service.calls, [])

        for record in (
            {**execution, "status": "interrupted"},
            {**execution, "report": substituted},
        ):
            self.assertIn(score(ready, record=record)["status"], {"incomplete", "error"})
            self.assertEqual(service.calls, [])

        legacy_fetches = []
        legacy = score_execution(
            execution, self.loaded,
            fetch_session=lambda session_id, trace_id: legacy_fetches.append((session_id, trace_id)),
            evaluation_client=service, evaluator_id=EVALUATOR_ID, wait_seconds=0,
        )
        self.assertEqual(legacy["status"], "incomplete")
        self.assertEqual(legacy["deterministic"]["inputKind"], "report_only")
        self.assertEqual(legacy_fetches, [])
        self.assertEqual(service.calls, [])

        incomplete_fetches = []

        def fetch_incomplete(session_id, trace_id):
            incomplete_fetches.append((session_id, trace_id))
            if len(incomplete_fetches) > 8:
                raise AssertionError("The positive collection deadline did not bound repeated reads.")
            return copy.deepcopy(ready[:2])

        with patch("time.monotonic", side_effect=count()), patch("time.sleep"):
            expired = score_execution(
                execution, self.loaded, fetch_session=fetch_incomplete, evaluation_client=service,
                evaluator_id=EVALUATOR_ID, wait_seconds=5, verified_spans=ready,
            )
        self.assertEqual(expired["status"], "incomplete")
        self.assertTrue(incomplete_fetches)
        self.assertEqual(expired["deterministic"]["inputKind"], "captured_execution")
        self.assertEqual(expired["deterministic"]["findings"]["operator_boundary"]["status"], "complete")
        self.assertEqual(service.calls, [])

        published = iter((ready[:2], ready))
        fetches = []

        def fetch_delayed(session_id, trace_id):
            fetches.append((session_id, trace_id))
            self.assertEqual(service.calls, [])
            return next(published)

        with patch("time.sleep"):
            first = score_execution(
                execution, self.loaded, fetch_session=fetch_delayed, evaluation_client=service,
                evaluator_id=EVALUATOR_ID, wait_seconds=5, verified_spans=ready,
            )
        self.assertEqual(fetches, [(SESSION_ID, TRACE_ID), (SESSION_ID, TRACE_ID)])
        rejudged = score(ready)
        self.assertEqual(first["status"], "complete")
        self.assertEqual(rejudged["status"], "complete")
        self.assertEqual(first["executionId"], EXECUTION_ID)
        self.assertEqual(rejudged["executionId"], EXECUTION_ID)
        self.assertNotEqual(first["scoringAttemptId"], rejudged["scoringAttemptId"])
        self.assertEqual(first["deterministic"]["findings"]["action"]["verdict"], "fail")
        self.assertEqual(first["deterministic"]["findings"]["target"]["verdict"], "pass")
        self.assertEqual(first["deterministic"]["findings"]["operator_boundary"]["status"], "complete")
        from evaluation_telemetry import execution_content

        failed = next(
            call for call in execution_content(ready)["toolCalls"]
            if call["callId"] == "configuration-2"
        )
        self.assertEqual(failed["arguments"], rejected_arguments)
        self.assertEqual(failed["result"], rejected_result)
        self.assertEqual(len(service.calls), 2)
        for request in service.calls:
            self.assertEqual(request["evaluationInput"]["sessionSpans"], ready)
            references = request["evaluationReferenceInputs"]
            self.assertEqual(references[0]["context"]["spanContext"], {"sessionId": SESSION_ID})
            self.assertIn(self.case["expectations"]["diagnosis"], json.dumps(references))
            self.assertNotIn(self.case["expectations"]["diagnosis"], json.dumps(ready))


if __name__ == "__main__":
    unittest.main()
