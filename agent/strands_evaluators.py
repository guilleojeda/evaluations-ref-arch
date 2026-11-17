"""Native Strands evaluators for the development experiment.

The adapter deliberately keeps the native numeric contract separate from the
project's categorical AgentCore result.  Deterministic checks remain named
rows, while the AgentCore result is one advisory row with an explicit numeric
placeholder and the actual label/reason/status in metadata.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable, Mapping

from strands_evals.evaluators import Evaluator
from strands_evals.types.evaluation import EvaluationData, EvaluationOutput


FINDINGS = (
    "report_structure",
    "assessment",
    "action",
    "target",
    "target_value",
    "source_scope",
    "as_of_time",
    "operator_boundary",
)


def _context(evaluation_case: EvaluationData[Any, Any]) -> dict[str, Any]:
    """Return the private adapter context carried outside the candidate input."""

    metadata = evaluation_case.metadata
    if not isinstance(metadata, Mapping):
        return {}
    return dict(metadata)


def _execution_path(evaluation_case: EvaluationData[Any, Any]) -> Path | None:
    value = evaluation_case.actual_output
    if not isinstance(value, Mapping):
        return None
    directory = value.get("executionDirectory")
    if not isinstance(directory, str) or not directory:
        return None
    return Path(directory)


def _execution_record(evaluation_case: EvaluationData[Any, Any]) -> dict[str, Any] | None:
    value = evaluation_case.actual_output
    if not isinstance(value, Mapping):
        return None
    record = value.get("execution")
    return dict(record) if isinstance(record, Mapping) else None


def _identity(context: Mapping[str, Any], record: Mapping[str, Any] | None) -> dict[str, Any]:
    identity = record.get("identity") if isinstance(record, Mapping) else None
    if not isinstance(identity, Mapping):
        identity = {}
    return {
        "experimentId": context.get("experimentId"),
        "caseId": context.get("caseId"),
        "executionId": identity.get("executionId"),
        "sessionId": identity.get("sessionId"),
        "traceId": identity.get("traceId"),
    }


def _status_for(record: Mapping[str, Any] | None) -> str:
    if not isinstance(record, Mapping):
        return "incomplete"
    status = record.get("status")
    return status if isinstance(status, str) and status else "incomplete"


def _error_output(
    *,
    role: str,
    status: str,
    reason: str,
    context: Mapping[str, Any],
    record: Mapping[str, Any] | None,
    check_name: str | None = None,
    scoring_attempt_id: str | None = None,
) -> EvaluationOutput:
    metadata: dict[str, Any] = {
        **_identity(context, record),
        "role": role,
        "status": status,
        "numericPlaceholder": role == "advisory",
    }
    if check_name is not None:
        metadata["checkName"] = check_name
    if scoring_attempt_id is not None:
        metadata["scoringAttemptId"] = scoring_attempt_id
    return EvaluationOutput(
        score=0.0,
        test_pass=False,
        label=None,
        reason=reason,
        metadata=metadata,
    )


class DeterministicEvaluator(Evaluator[Any, Any]):
    """Project the existing eight deterministic findings one-for-one."""

    def __init__(self, *, on_result: Callable[[str, Mapping[str, Any]], None] | None = None):
        super().__init__(name="deterministic")
        self._on_result = on_result

    def evaluate(self, evaluation_case: EvaluationData[Any, Any]) -> list[EvaluationOutput]:
        context = _context(evaluation_case)
        record = _execution_record(evaluation_case)
        deterministic = record.get("deterministic") if isinstance(record, Mapping) else None
        findings = deterministic.get("findings") if isinstance(deterministic, Mapping) else None
        if not isinstance(findings, Mapping):
            reason = "captured execution did not produce deterministic findings"
            return [
                _error_output(
                    role="deterministic",
                    status=_status_for(record),
                    reason=reason,
                    context=context,
                    record=record,
                    check_name=name,
                )
                for name in FINDINGS
            ]

        case_id = str(context.get("caseId", ""))
        if self._on_result is not None:
            self._on_result(case_id, findings)
        outputs: list[EvaluationOutput] = []
        for name in FINDINGS:
            finding = findings.get(name)
            if not isinstance(finding, Mapping):
                outputs.append(
                    _error_output(
                        role="deterministic",
                        status="incomplete",
                        reason=f"deterministic finding is missing: {name}",
                        context=context,
                        record=record,
                        check_name=name,
                    )
                )
                continue
            status = finding.get("status")
            verdict = finding.get("verdict")
            reason = finding.get("reason")
            valid_status = status if isinstance(status, str) and status else "incomplete"
            valid_verdict = verdict if verdict in {"pass", "fail"} else None
            passed = valid_status == "complete" and valid_verdict == "pass"
            outputs.append(
                EvaluationOutput(
                    score=1.0 if passed else 0.0,
                    test_pass=passed,
                    label=valid_verdict,
                    reason=reason if isinstance(reason, str) else "deterministic finding is malformed",
                    metadata={
                        **_identity(context, record),
                        "role": "deterministic",
                        "checkName": name,
                        "status": valid_status,
                        "verdict": valid_verdict,
                    },
                )
            )
        return outputs


class AgentCoreAdvisory(Evaluator[Any, Any]):
    """Run the existing persisted AgentCore scoring operation once per case."""

    def __init__(
        self,
        evaluator_path: str | Path,
        *,
        wait_seconds: int = 300,
        on_result: Callable[[str, Mapping[str, Any]], None] | None = None,
        on_pending: Callable[[str, Mapping[str, Any]], None] | None = None,
        score_fn: Callable[..., Mapping[str, Any]] | None = None,
    ):
        super().__init__(name="advisory")
        self.evaluator_path = str(evaluator_path)
        self.wait_seconds = wait_seconds
        self._on_result = on_result
        self._on_pending = on_pending
        self._score_fn = score_fn

    def evaluate(self, evaluation_case: EvaluationData[Any, Any]) -> list[EvaluationOutput]:
        context = _context(evaluation_case)
        record = _execution_record(evaluation_case)
        path = _execution_path(evaluation_case)
        if path is None or _status_for(record) != "complete":
            status = "incomplete"
            reason = "captured execution is incomplete; semantic scoring was not started"
            result = {"status": status, "reason": reason}
            if self._on_result is not None:
                self._on_result(str(context.get("caseId", "")), result)
            return [
                _error_output(
                    role="advisory",
                    status=status,
                    reason=reason,
                    context=context,
                    record=record,
                )
            ]

        try:
            # Import lazily so importing deterministic tooling does not create
            # AWS clients or require a scoring operation.
            score_fn = self._score_fn
            if score_fn is None:
                from evaluate_case import _score

                score_fn = _score
            case_id = str(context.get("caseId", ""))
            if self._on_pending is None:
                result = score_fn(path, Path(self.evaluator_path), self.wait_seconds)
            else:
                result = score_fn(
                    path,
                    Path(self.evaluator_path),
                    self.wait_seconds,
                    pending_callback=lambda pending: self._on_pending(case_id, pending),
                )
        except Exception as exc:  # typed outcome; never let SDK retries rerun a judge
            result = {"status": "error", "reason": f"semantic scoring failed: {type(exc).__name__}: {exc}"}

        case_id = str(context.get("caseId", ""))
        if self._on_result is not None:
            self._on_result(case_id, result)

        score_status = result.get("status") if isinstance(result, Mapping) else "error"
        score_status = score_status if isinstance(score_status, str) and score_status else "error"
        attempt_id = result.get("scoringAttemptId") if isinstance(result, Mapping) else None
        semantic = result.get("semantic") if isinstance(result, Mapping) else None
        finding = semantic.get("findings", {}).get("semantic_quality") if isinstance(semantic, Mapping) else None
        if score_status == "complete" and isinstance(finding, Mapping):
            verdict = finding.get("verdict") if finding.get("verdict") in {"pass", "fail"} else None
            explanation = finding.get("explanation")
            explanation = explanation if isinstance(explanation, str) else "semantic verdict explanation is unavailable"
            metadata = {
                **_identity(context, record),
                "role": "advisory",
                "status": score_status,
                "verdict": verdict,
                "numericPlaceholder": True,
                "scoringAttemptId": attempt_id,
            }
            return [
                EvaluationOutput(
                    score=0.0,
                    test_pass=verdict == "pass",
                    label=verdict,
                    reason=explanation,
                    metadata=metadata,
                )
            ]

        reason = result.get("reason") if isinstance(result, Mapping) else None
        if not isinstance(reason, str) or not reason:
            reason = f"semantic scoring is {score_status}"
        return [
            _error_output(
                role="advisory",
                status=score_status,
                reason=reason,
                context=context,
                record=record,
                scoring_attempt_id=attempt_id if isinstance(attempt_id, str) else None,
            )
        ]
