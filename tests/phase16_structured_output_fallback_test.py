"""Acceptance for captured Strands structured-output transport fallback."""

from __future__ import annotations

import copy
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from botocore.exceptions import ClientError
from botocore.session import get_session

from phase14_reviewed_cases_test import make_case, write_bundle
from phase15_deterministic_checks_test import recommendation, report_for


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))

from captured_execution import load_execution, run_captured_case  # noqa: E402
from evaluation_telemetry import score_execution  # noqa: E402
from reviewed_cases import freeze_case  # noqa: E402


MODEL_ID = "us.anthropic.claude-sonnet-4-6"
EVALUATOR_ID = "IncidentTriageSemantic-0000000001"


class StructuredOutputFallbackBedrock:
    """Script the real BedrockModel fallback without creating a provider client."""

    def __init__(self, report):
        self.report = report
        self.requests = []
        self.region_name = "us-east-1"
        self.meta = SimpleNamespace(
            region_name=self.region_name,
            service_model=get_session().get_service_model("bedrock-runtime"),
        )

    def client(self, service_name, **_kwargs):
        if service_name != "bedrock-runtime":
            raise AssertionError(f"captured run requested unexpected AWS client {service_name}")
        return self

    def converse_stream(self, **request):
        self.requests.append(copy.deepcopy(request))
        index = len(self.requests)
        forced_tool = request.get("toolConfig", {}).get("toolChoice", {}).get("tool", {}).get("name")
        if forced_tool == "InvestigationReport":
            raise ClientError(
                {
                    "Error": {
                        "Code": "ValidationException",
                        "Message": "This model doesn't support the toolConfig.toolChoice",
                    }
                },
                "ConverseStream",
            )

        if "outputConfig" in request:
            events = [
                {"messageStart": {"role": "assistant"}},
                {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"reasoningContent": {"text": "Checked the evidence."}}}},
                {"contentBlockStop": {"contentBlockIndex": 0}},
                {"contentBlockDelta": {"contentBlockIndex": 1, "delta": {"text": json.dumps(self.report)}}},
                {"contentBlockStop": {"contentBlockIndex": 1}},
                {"messageStop": {"stopReason": "end_turn"}},
                {"metadata": {"usage": {"inputTokens": 4, "outputTokens": 3, "totalTokens": 7}, "metrics": {"latencyMs": 1}}},
            ]
        elif index == 1:
            arguments = {"resource": "inventory"}
            events = [
                {"messageStart": {"role": "assistant"}},
                {"contentBlockStart": {"contentBlockIndex": 0, "start": {"toolUse": {"toolUseId": "read-1", "name": "search_logs"}}}},
                {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"toolUse": {"input": json.dumps(arguments)}}}},
                {"contentBlockStop": {"contentBlockIndex": 0}},
                {"messageStop": {"stopReason": "tool_use"}},
                {"metadata": {"usage": {"inputTokens": 3, "outputTokens": 2, "totalTokens": 5}, "metrics": {"latencyMs": 1}}},
            ]
        else:
            events = [
                {"messageStart": {"role": "assistant"}},
                {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "I inspected the captured evidence."}}},
                {"contentBlockStop": {"contentBlockIndex": 0}},
                {"messageStop": {"stopReason": "end_turn"}},
                {"metadata": {"usage": {"inputTokens": 3, "outputTokens": 2, "totalTokens": 5}, "metrics": {"latencyMs": 1}}},
            ]
        return {"stream": iter(events)}


class RecordingEvaluate:
    def __init__(self):
        self.calls = []

    def evaluate(self, **request):
        self.calls.append(request)
        session_id = request["evaluationReferenceInputs"][0]["context"]["spanContext"]["sessionId"]
        return {
            "evaluationResults": [
                {
                    "evaluatorId": EVALUATOR_ID,
                    "evaluationDimensionName": dimension,
                    "context": {"spanContext": {"sessionId": session_id}},
                    "label": "pass",
                    "explanation": "The structured assistant response is present in the native chat span.",
                }
                for dimension in ("diagnosis_support", "evidence_grounding")
            ]
        }


class StructuredOutputFallbackAcceptance(unittest.TestCase):
    def test_rejected_forced_report_is_retained_and_native_report_reaches_evaluate(self):
        from opentelemetry import trace
        from opentelemetry.sdk.trace import TracerProvider
        from strands.models import _native_output

        if not isinstance(trace.get_tracer_provider(), TracerProvider):
            trace.set_tracer_provider(TracerProvider())

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bundle_path = root / "bundle.json"
            origin = write_bundle(bundle_path)
            case = make_case(bundle_path, origin["runId"])
            case_path = root / "case.json"
            case_path.write_text(json.dumps(case), encoding="utf-8")
            frozen_path = root / "case.frozen.json"
            freeze_case(case_path, bundle_path, frozen_path)
            report = report_for(recommendation("Increase memory", "inventory", 512, "MB"))
            report["evidence"] = [{
                "source": "cloudwatch",
                "resource": "inventory",
                "windowStart": case["task"]["incidentWindow"]["start"],
                "windowEnd": case["task"]["referenceTime"],
                "observedAt": case["task"]["referenceTime"],
                "finding": "The captured Inventory read returned the denied observations.",
            }]
            model_session = StructuredOutputFallbackBedrock(report)

            # BedrockModel learns that the forced tool choice is unsupported.
            # Keep that process cache isolated from other Phase 16 tests.
            with patch.dict(_native_output._UNSUPPORTED_MECHANISMS, clear=True), patch.dict(
                _native_output._REJECTED_NATIVE_SCHEMAS, clear=True
            ):
                run_dir = run_captured_case(
                    frozen_path,
                    bundle_path,
                    root / "runs",
                    model_session=model_session,
                )
                record, loaded_case, native_spans = load_execution(run_dir)

                self.assertEqual(record["status"], "complete", record)
                self.assertEqual(len(model_session.requests), 4)
                self.assertEqual(record["modelRequestCount"], 4)
                self.assertEqual(record["modelResponseCount"], 3)
                self.assertEqual(record["modelSpanCount"], 3)
                self.assertEqual(len(record["modelRequestAttempts"]), 4)
                self.assertEqual(
                    [item["status"] for item in record["modelRequestAttempts"]],
                    ["stream_returned", "stream_returned", "error", "stream_returned"],
                )
                rejected = record["modelRequestAttempts"][2]
                self.assertEqual(rejected["error"]["Code"], "ValidationException")
                self.assertIn("toolConfig.toolChoice", rejected["error"]["Message"])
                self.assertEqual(
                    rejected["request"]["toolConfig"]["toolChoice"]["tool"]["name"],
                    "InvestigationReport",
                )
                self.assertIn("outputConfig", record["modelRequestAttempts"][3]["request"])
                self.assertEqual(record["reportSource"], "assistant_chat")
                self.assertEqual(record["ledger"]["reportSpanId"], record["ledger"]["modelCalls"][-1]["spanId"])
                self.assertEqual(record["report"], report)
                self.assertEqual(
                    len([span for span in native_spans if span["attributes"].get("gen_ai.operation.name") == "chat"]),
                    3,
                )
                self.assertFalse(any(
                    span.get("attributes", {}).get("gen_ai.tool.name") == "InvestigationReport"
                    for span in native_spans
                ))

                evaluate = RecordingEvaluate()
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
                self.assertEqual(len(evaluate.calls), 1)


if __name__ == "__main__":
    unittest.main()
