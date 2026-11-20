"""Offline acceptance tests for the Phase 16 AgentCore scoring adapter.

The adapter receives an already validated session from the orchestrator. These
tests cover only the direct Evaluate request and its response mapping; the
session/trace execution gate is covered separately.
"""

from __future__ import annotations

import copy
import importlib
from pathlib import Path
import sys
import unittest
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
AGENT_DIR = ROOT / "agent"
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

EVALUATOR_ID = "Phase16Semantics-1234567890"
EVALUATOR_NAME = "Phase16Semantics"
EVALUATOR_ARN = (
    "arn:aws:bedrock-agentcore:us-east-1:123456789012:evaluator/"
    f"{EVALUATOR_ID}"
)
SESSION_ID = "phase16-session-001"
TRACE_ID = "6a827b653032d37116d7c1931a9835b5"
OTHER_SESSION_ID = "phase16-session-foreign"
OTHER_TRACE_ID = "6a827b653032d37116d7c1931a9835b6"
ASSERTIONS = [
    "The diagnosis must be supported by the queried incident evidence.",
    "The recommendation must stay within reviewed evidence and scope.",
]
SESSION_SPANS = [
    {
        "traceId": TRACE_ID,
        "id": "7b0c5b163e4a82f1",
        "name": "agent",
        "startTime": 1,
        "endTime": 2,
        "attributes": {"session.id": SESSION_ID, "gen_ai.operation.name": "invoke_agent"},
    },
    {
        "traceId": TRACE_ID,
        "id": "7b0c5b163e4a82f2",
        "name": "report",
        "startTime": 3,
        "endTime": 4,
        "attributes": {"session.id": SESSION_ID, "incident.report": "synthetic report"},
    },
]


class RecordingClient:
    """Strict transport double that records exactly one Evaluate operation."""

    def __init__(self, response: dict[str, Any] | None = None, error: Exception | None = None):
        self.response = copy.deepcopy(response)
        self.error = error
        self.calls: list[dict[str, Any]] = []

    def evaluate(self, **request: Any) -> dict[str, Any]:
        if self.calls:
            raise AssertionError("score_session must make only one Evaluate call")
        self.calls.append(copy.deepcopy(request))
        if self.error is not None:
            raise self.error
        if self.response is None:
            raise AssertionError("the test transport has no configured response")
        return copy.deepcopy(self.response)


def span_context(
    *,
    session_id: str = SESSION_ID,
    trace_id: str | None = TRACE_ID,
    span_id: str | None = None,
) -> dict[str, Any]:
    context: dict[str, str] = {"sessionId": session_id}
    if trace_id is not None:
        context["traceId"] = trace_id
    if span_id is not None:
        context["spanId"] = span_id
    return {"spanContext": context}


def result_row(
    dimension: str,
    label: str | None,
    *,
    explanation: str = "Synthetic judge explanation.",
    evaluator_id: str = EVALUATOR_ID,
    context: dict[str, Any] | None = None,
    token_usage: dict[str, int] | None = None,
    ignored_reference_fields: list[str] | None = None,
    error_code: str | None = None,
    error_message: str | None = None,
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "evaluatorArn": EVALUATOR_ARN,
        "evaluatorId": evaluator_id,
        "evaluatorName": EVALUATOR_NAME,
        "evaluationDimensionName": dimension,
        "context": copy.deepcopy(context if context is not None else span_context()),
    }
    if label is not None:
        row["label"] = label
    if explanation is not None:
        row["explanation"] = explanation
    if token_usage is not None:
        row["tokenUsage"] = copy.deepcopy(token_usage)
    if ignored_reference_fields is not None:
        row["ignoredReferenceInputFields"] = list(ignored_reference_fields)
    if error_code is not None:
        row["errorCode"] = error_code
    if error_message is not None:
        row["errorMessage"] = error_message
    return row


def response_with(*rows: dict[str, Any]) -> dict[str, Any]:
    return {"evaluationResults": [copy.deepcopy(row) for row in rows]}


def single_result_row(
    label: str | None,
    *,
    explanation: str = "Both diagnosis and source claims are supported by decisive evidence.",
    **kwargs: Any,
) -> dict[str, Any]:
    row = result_row("unused_dimension", label, explanation=explanation, **kwargs)
    row.pop("evaluationDimensionName", None)
    return row


def expected_request(
    assertions: list[str] = ASSERTIONS,
    session_spans: list[dict[str, Any]] = SESSION_SPANS,
) -> dict[str, Any]:
    return {
        "evaluatorId": EVALUATOR_ID,
        "evaluationInput": {"sessionSpans": copy.deepcopy(session_spans)},
        "evaluationReferenceInputs": [
            {
                "context": {"spanContext": {"sessionId": SESSION_ID}},
                "assertions": [{"text": assertion} for assertion in assertions],
            }
        ],
    }


def score(
    client: RecordingClient,
    assertions: list[str] = ASSERTIONS,
    *,
    mode: str | None = None,
) -> dict[str, Any]:
    """Import lazily so a missing Phase 16 adapter produces ordinary red tests."""

    module = importlib.import_module("agentcore_evaluation")
    kwargs: dict[str, Any] = {}
    if mode is not None:
        kwargs["mode"] = mode
    return module.score_session(
        client,
        evaluator_id=EVALUATOR_ID,
        session_id=SESSION_ID,
        trace_id=TRACE_ID,
        session_spans=copy.deepcopy(SESSION_SPANS),
        assertions=assertions,
        **kwargs,
    )


class AgentCoreRubricConfigurationTests(unittest.TestCase):
    def test_pins_separate_diagnosis_and_grounding_criteria(self):
        module = importlib.import_module("agentcore_evaluation")
        rubric = module.evaluator_config(module.SONNET_46_MODEL_ID)["llmAsAJudge"]
        dimensions = {
            item["dimensionName"]: item for item in rubric["ratingScale"]["multiDimensional"]
        }
        self.assertEqual("incident-triage.semantic.v4", module.RUBRIC_ID)
        self.assertIn("A bad inference alone affects diagnosis support", rubric["instructions"])
        self.assertIn("causal diagnosis", dimensions["diagnosis_support"]["dimensionInstruction"])
        grounding = dimensions["evidence_grounding"]["dimensionInstruction"]
        for rule in ("inference only", "matched source field and value", "ingestionTime",
                     "availableAt", "referenceTime", "repeat the request", "query requested a later end",
                     "quote the report text", "contradicting or missing eligible source fact",
                     "causal explanation or its premise alone"):
            with self.subTest(rule=rule):
                self.assertIn(rule, grounding)
        self.assertNotEqual(
            dimensions["diagnosis_support"]["dimensionRatingScale"],
            dimensions["evidence_grounding"]["dimensionRatingScale"],
        )
        self.assertNotEqual(
            "a361016a68fe9851b010123bde700dc9c635f4d4c832d2369e53e858eb753082",
            module.evaluator_config_digest(module.SONNET_46_MODEL_ID),
        )


class AgentCoreScoringAdapterTests(unittest.TestCase):
    def assert_single_expected_call(self, client: RecordingClient) -> None:
        self.assertEqual([expected_request()], client.calls)
        self.assertEqual(
            {"evaluatorId", "evaluationInput", "evaluationReferenceInputs"},
            set(client.calls[0]),
            "scoring must not add a trace target, candidate data, or another request field",
        )

    def test_out_of_order_categorical_rows_without_numeric_values_are_complete(self):
        usage = {"inputTokens": 1015, "outputTokens": 316, "totalTokens": 1331}
        raw_response = response_with(
            result_row(
                "evidence_grounding",
                "pass",
                explanation="The recommendation stays within the reviewed evidence.",
                token_usage=usage,
            ),
            result_row(
                "diagnosis_support",
                "pass",
                explanation="The diagnosis follows from the queried evidence.",
            ),
        )
        client = RecordingClient(raw_response)

        result = score(client)

        self.assertEqual("complete", result.get("status"))
        self.assertEqual("pass", result["findings"]["diagnosis_support"]["verdict"])
        self.assertEqual("pass", result["findings"]["evidence_grounding"]["verdict"])
        self.assertEqual(
            "The diagnosis follows from the queried evidence.",
            result["findings"]["diagnosis_support"].get("explanation"),
        )
        self.assertEqual(
            "The recommendation stays within the reviewed evidence.",
            result["findings"]["evidence_grounding"].get("explanation"),
        )
        self.assertEqual(raw_response, result.get("rawResponse"))
        self.assertEqual(usage, result.get("tokenUsage"))
        self.assert_single_expected_call(client)


    def test_a_quality_failure_is_complete_and_does_not_become_transport_error(self):
        raw_response = response_with(
            result_row("diagnosis_support", "fail", explanation="The cause is unsupported."),
            result_row("evidence_grounding", "pass", explanation="The evidence scope is sound."),
        )
        client = RecordingClient(raw_response)

        result = score(client)

        self.assertEqual("complete", result.get("status"))
        self.assertEqual("complete", result["findings"]["diagnosis_support"].get("status"))
        self.assertEqual("fail", result["findings"]["diagnosis_support"].get("verdict"))
        self.assertEqual("pass", result["findings"]["evidence_grounding"].get("verdict"))
        self.assertIsNone(result.get("tokenUsage"))
        self.assertEqual(raw_response, result.get("rawResponse"))
        self.assert_single_expected_call(client)

    def test_dimension_error_keeps_error_metadata_and_the_other_dimension_result(self):
        raw_response = response_with(
            result_row(
                "diagnosis_support",
                None,
                explanation=None,
                error_code="INVALID_RATING",
                error_message="The judge returned an out-of-scale rating.",
            ),
            result_row("evidence_grounding", "pass", explanation="The source claims are supported."),
        )
        client = RecordingClient(raw_response)

        result = score(client)

        self.assertEqual("incomplete", result.get("status"))
        diagnosis = result["findings"]["diagnosis_support"]
        self.assertEqual("error", diagnosis.get("status"))
        self.assertIsNone(diagnosis.get("verdict"))
        self.assertEqual("INVALID_RATING", diagnosis.get("errorCode"))
        self.assertEqual("The judge returned an out-of-scale rating.", diagnosis.get("errorMessage"))
        self.assertEqual("complete", result["findings"]["evidence_grounding"].get("status"))
        self.assertEqual("pass", result["findings"]["evidence_grounding"].get("verdict"))
        self.assertEqual(raw_response, result.get("rawResponse"))
        self.assertIsNone(result.get("tokenUsage"))
        self.assert_single_expected_call(client)

    def test_absent_token_usage_is_none_and_usage_is_counted_once_per_call(self):
        usage = {"inputTokens": 17, "outputTokens": 9, "totalTokens": 26}
        raw_response = response_with(
            result_row("diagnosis_support", "pass", token_usage=usage),
            result_row("evidence_grounding", "pass", token_usage=usage),
        )
        client = RecordingClient(raw_response)

        result = score(client)

        self.assertEqual(usage, result.get("tokenUsage"), "one judge call must not double-count repeated row usage")
        self.assert_single_expected_call(client)

        no_usage = response_with(
            result_row("diagnosis_support", "pass"),
            result_row("evidence_grounding", "pass"),
        )
        missing_usage_client = RecordingClient(no_usage)
        no_usage_result = score(missing_usage_client)
        self.assertIsNone(no_usage_result.get("tokenUsage"))
        self.assert_single_expected_call(missing_usage_client)

    def test_missing_assertions_are_rejected_without_calling_evaluate(self):
        invalid_values: list[Any] = [None, [], [""], [" \t "], ["valid", 3]]
        for assertions in invalid_values:
            with self.subTest(assertions=assertions):
                client = RecordingClient(
                    response_with(
                        result_row("diagnosis_support", "pass"),
                        result_row("evidence_grounding", "pass"),
                    )
                )
                result = score(client, assertions=assertions)
                self.assertEqual("error", result.get("status"), result)
                self.assertEqual([], client.calls, "invalid reviewed assertions must fail before service I/O")

    def test_missing_duplicate_and_malformed_extra_rows_preserve_independent_findings(self):
        cases = {
            "missing evidence row": (
                response_with(result_row("diagnosis_support", "fail")),
                {"diagnosis_support": ("complete", "fail")},
            ),
            "duplicate diagnosis row": (
                response_with(
                    result_row("diagnosis_support", "pass"),
                    result_row("diagnosis_support", "pass"),
                    result_row("evidence_grounding", "fail"),
                ),
                {"evidence_grounding": ("complete", "fail")},
            ),
            "malformed extra dimension": (
                response_with(
                    result_row("diagnosis_support", "fail"),
                    result_row("evidence_grounding", "pass"),
                    result_row("unsupported_dimension", None, explanation="   "),
                ),
                {
                    "diagnosis_support": ("complete", "fail"),
                    "evidence_grounding": ("complete", "pass"),
                },
            ),
        }
        for name, (raw_response, preserved) in cases.items():
            with self.subTest(case=name):
                client = RecordingClient(raw_response)
                result = score(client)
                self.assertEqual("incomplete", result.get("status"), result)
                self.assertEqual(raw_response, result.get("rawResponse"))
                for dimension, (status, verdict) in preserved.items():
                    with self.subTest(dimension=dimension):
                        finding = result["findings"][dimension]
                        self.assertEqual(status, finding.get("status"))
                        self.assertEqual(verdict, finding.get("verdict"))
                self.assert_single_expected_call(client)

    def test_malformed_categorical_rows_for_both_dimensions_are_incomplete(self):
        malformed_rows = {
            "missing explanation": result_row("diagnosis_support", "pass", explanation=None),
            "blank explanation": result_row("diagnosis_support", "pass", explanation=" \t "),
            "out-of-scale label": result_row("diagnosis_support", "not-a-rating"),
            "missing label": result_row("diagnosis_support", None),
        }
        for dimension in ("diagnosis_support", "evidence_grounding"):
            sibling = "evidence_grounding" if dimension == "diagnosis_support" else "diagnosis_support"
            for case, template in malformed_rows.items():
                with self.subTest(dimension=dimension, case=case):
                    malformed = copy.deepcopy(template)
                    malformed["evaluationDimensionName"] = dimension
                    known_failure = result_row(sibling, "fail", explanation="This independent criterion fails.")
                    raw_response = response_with(malformed, known_failure)
                    client = RecordingClient(raw_response)

                    result = score(client)

                    self.assertEqual("incomplete", result.get("status"), result)
                    finding = result["findings"][dimension]
                    self.assertEqual("incomplete", finding.get("status"))
                    self.assertIsNone(finding.get("verdict"))
                    self.assertEqual("complete", result["findings"][sibling].get("status"))
                    self.assertEqual("fail", result["findings"][sibling].get("verdict"))
                    self.assertEqual(raw_response, result.get("rawResponse"))
                    self.assert_single_expected_call(client)

    def test_wrong_evaluator_or_session_and_unexpected_trace_or_span_context_never_complete(self):
        cases = {
            "wrong evaluator": result_row("diagnosis_support", "pass", evaluator_id="OtherEvaluator-1234567890"),
            "wrong session": result_row(
                "diagnosis_support", "pass", context=span_context(session_id=OTHER_SESSION_ID)
            ),
            "wrong trace": result_row(
                "diagnosis_support", "pass", context=span_context(trace_id=OTHER_TRACE_ID)
            ),
            "unexpected span": result_row(
                "diagnosis_support", "pass", context=span_context(span_id="7b0c5b163e4a82f9")
            ),
        }
        for name, invalid_diagnosis in cases.items():
            with self.subTest(context=name):
                raw_response = response_with(
                    invalid_diagnosis,
                    result_row("evidence_grounding", "pass"),
                )
                client = RecordingClient(raw_response)
                result = score(client)
                self.assertEqual("incomplete", result.get("status"), result)
                self.assertEqual("complete", result["findings"]["evidence_grounding"].get("status"))
                self.assertEqual("pass", result["findings"]["evidence_grounding"].get("verdict"))
                self.assertNotEqual("complete", result["findings"]["diagnosis_support"].get("status"))
                self.assertEqual(raw_response, result.get("rawResponse"))
                self.assert_single_expected_call(client)

    def test_missing_optional_trace_context_is_allowed_for_the_matching_session(self):
        raw_response = response_with(
            result_row("diagnosis_support", "pass", context=span_context(trace_id=None)),
            result_row("evidence_grounding", "pass", context=span_context(trace_id=None)),
        )
        client = RecordingClient(raw_response)

        result = score(client)

        self.assertEqual("complete", result.get("status"))
        self.assertEqual(raw_response, result.get("rawResponse"))
        self.assert_single_expected_call(client)

    def test_an_ignored_required_assertion_blocks_only_the_affected_dimension(self):
        raw_response = response_with(
            result_row(
                "diagnosis_support",
                "pass",
                ignored_reference_fields=["assertions"],
            ),
            result_row("evidence_grounding", "pass"),
        )
        client = RecordingClient(raw_response)

        result = score(client)

        self.assertEqual("incomplete", result.get("status"))
        diagnosis = result["findings"]["diagnosis_support"]
        self.assertEqual("incomplete", diagnosis.get("status"))
        self.assertIsNone(diagnosis.get("verdict"))
        self.assertEqual("complete", result["findings"]["evidence_grounding"].get("status"))
        self.assertEqual("pass", result["findings"]["evidence_grounding"].get("verdict"))
        self.assertEqual(raw_response, result.get("rawResponse"))
        self.assert_single_expected_call(client)

    def test_transport_exception_is_an_error_not_a_quality_failure(self):
        client = RecordingClient(error=RuntimeError("synthetic Evaluate transport failure"))

        result = score(client)

        self.assertEqual("error", result.get("status"))
        self.assertIsNone(result.get("rawResponse"))
        self.assertIsNone(result.get("tokenUsage"))
        self.assertEqual("error", result["findings"]["diagnosis_support"].get("status"))
        self.assertEqual("error", result["findings"]["evidence_grounding"].get("status"))
        self.assertIsNone(result["findings"]["diagnosis_support"].get("verdict"))
        self.assertTrue(result["findings"]["diagnosis_support"].get("errorMessage"))
        self.assert_single_expected_call(client)


class AgentCoreSingleCategoricalScoringTests(unittest.TestCase):
    def assert_single_expected_call(self, client: RecordingClient) -> None:
        self.assertEqual([expected_request()], client.calls)
        self.assertEqual(
            {"evaluatorId", "evaluationInput", "evaluationReferenceInputs"},
            set(client.calls[0]),
        )

    def test_single_config_is_native_categorical_and_keeps_both_requirements(self):
        module = importlib.import_module("agentcore_evaluation")
        config = module.evaluator_config(module.SONNET_46_MODEL_ID, module.SINGLE_MODE)
        rubric = config["llmAsAJudge"]
        self.assertEqual(module.SINGLE_RUBRIC_ID, "incident-triage.semantic.single.v2")
        self.assertIn("categorical", rubric["ratingScale"])
        self.assertNotIn("multiDimensional", rubric["ratingScale"])
        self.assertEqual(
            {"temperature": 0.0, "maxTokens": 2400},
            rubric["modelConfig"]["bedrockEvaluatorModelConfig"]["inferenceConfig"],
        )
        compatibility = module.evaluator_config(module.SONNET_46_MODEL_ID, module.MULTI_MODE)
        self.assertEqual(
            {"temperature": 0.0, "maxTokens": 2000},
            compatibility["llmAsAJudge"]["modelConfig"]["bedrockEvaluatorModelConfig"]["inferenceConfig"],
        )
        for phrase in (
            "BOTH requirements",
            "assessment and uncertainty",
            "source claims, timestamps, and cutoff-bounded coverage",
            "HARD CUTOFF RULE",
            "Do not accept a later partial or empty result",
            "eventTime, ingestionTime, availableAt",
            "Recommendation action, target, and value correctness",
        ):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, rubric["instructions"])

    def test_single_categorical_row_has_one_canonical_finding(self):
        raw_response = response_with(single_result_row("pass"))
        client = RecordingClient(raw_response)

        result = score(client, mode="single")

        self.assertEqual("complete", result["status"])
        self.assertEqual("single", result["mode"])
        self.assertEqual("pass", result["findings"]["semantic_quality"]["verdict"])
        self.assertEqual(raw_response, result["rawResponse"])
        self.assert_single_expected_call(client)

    def test_single_requires_exactly_one_identity_matched_row_and_no_ignored_references(self):
        cases = {
            "missing": response_with(),
            "duplicate": response_with(single_result_row("pass"), single_result_row("pass")),
            "foreign evaluator": response_with(single_result_row("pass", evaluator_id="OtherEvaluator-1234567890")),
            "ignored assertion": response_with(single_result_row("pass", ignored_reference_fields=["assertions"])),
            "ignored unknown field": response_with(single_result_row("pass", ignored_reference_fields=["other"])),
        }
        for name, raw_response in cases.items():
            with self.subTest(case=name):
                client = RecordingClient(raw_response)
                result = score(client, mode="single")
                self.assertEqual("incomplete", result["status"])
                self.assertIsNone(result["findings"]["semantic_quality"].get("verdict"))
                self.assertEqual(raw_response, result["rawResponse"])
                self.assert_single_expected_call(client)

    def test_single_rejects_dimension_name_and_service_error_without_quality_verdict(self):
        dimension_row = result_row("diagnosis_support", "pass")
        error_row = single_result_row("pass", error_code="JUDGE_FAILED", error_message="judge failed")
        for raw_response in (response_with(dimension_row), response_with(error_row)):
            with self.subTest(response=raw_response):
                client = RecordingClient(raw_response)
                result = score(client, mode="single")
                self.assertEqual("incomplete", result["status"])
                self.assertIsNone(result["findings"]["semantic_quality"].get("verdict"))
                self.assert_single_expected_call(client)


if __name__ == "__main__":
    unittest.main()
