"""Compare two completed captured executions without contacting AWS."""

from __future__ import annotations

from collections.abc import Callable, Mapping
import hashlib
import json
from pathlib import Path
from typing import Any

from agentcore_evaluation import _mapped_row, _row_identity_error, case_assertions
from captured_execution import load_execution
from evaluation_telemetry import _span_roster_mismatch, _validate_session, timing_evidence_assertions


COMMON_SOURCE_FILES = (
    "agent/main.py",
    "agent/investigation.py",
    "agent/evidence.py",
    "agent/captured_execution.py",
    "agent/captured_evidence.py",
    "agent/evaluation_telemetry.py",
    "agent/reviewed_cases.py",
    "agent/deterministic_checks.py",
)

# The retained S2 run predates the advisory scorer and editable-run lifecycle
# changes. Only these reviewed source transitions preserve that comparison.
# New captures normally have identical common source digests.
RETAINED_S2_SOURCE_TRANSITIONS = {
    "agent/captured_execution.py": (
        "9bb669602dc6c19e7d4071c45cd65cf5e2030a24b3ad2af65af2c41e630f14b7",
        "20f51a6dc99404e94f0d402f31d65fbd5ab997431f263cc2535447a1a771db05",
    ),
    "agent/evaluation_telemetry.py": (
        "4ade4a1b761cf307a1f62237a3fdd78bae0a1d8d8a9b9ce17b35b9871bf6f732",
        "f36528dc97beb5ed557c4e57048d0bee9a322bec1d350f7c4018e0ea28060b7e",
    ),
}


def _digest(value: Any) -> str:
    body = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def _read(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_bytes())
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"saved result is unavailable: {path}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"saved result is not an object: {path}")
    return value


def _execution_identity(record: Mapping[str, Any]) -> dict[str, Any]:
    identity = record.get("identity")
    if not isinstance(identity, Mapping):
        raise ValueError("execution identity is missing")
    return dict(identity)


def _source_digests(record: Mapping[str, Any]) -> dict[str, str]:
    manifest = record.get("manifest")
    files = manifest.get("sourceFiles") if isinstance(manifest, Mapping) else None
    if not isinstance(files, Mapping):
        raise ValueError("execution source manifest is missing")
    return {str(name): str(digest) for name, digest in files.items()}


def _execution_view(run: Path, record: Mapping[str, Any], case: Mapping[str, Any]) -> dict[str, Any]:
    identity = _execution_identity(record)
    return {
        "runDirectory": str(run),
        "status": record.get("status"),
        "identity": identity,
        "sourceDigests": _source_digests(record),
        "report": record.get("report"),
        "deterministic": record.get("deterministic"),
        "usage": record.get("usage"),
        "modelRequestCount": record.get("modelRequestCount"),
        "evidenceToolCallCount": record.get("evidenceToolCallCount"),
        "case": {
            "caseSha256": case.get("caseSha256"),
            "bundleSha256": case.get("bundleSha256"),
            "originatingRunId": case.get("originatingRunId"),
            "referenceTime": case.get("referenceTime"),
        },
    }


def _attempt_paths(run: Path) -> list[Path]:
    scores = run / "scores"
    if not scores.is_dir():
        return []
    return sorted(path for path in scores.glob("*/result.json") if path.is_file())


def _select_attempt(
    run: Path,
    requested: str | None,
    load_score: Callable[[Path], Mapping[str, Any]],
) -> tuple[dict[str, Any] | None, str | None]:
    paths = _attempt_paths(run)
    if requested is not None:
        selected = [path for path in paths if path.parent.name == requested]
        if len(selected) != 1:
            return None, f"requested scoring attempt is unavailable: {requested}"
    elif len(paths) != 1:
        if not paths:
            return None, "scoring result is missing"
        return None, "multiple scoring attempts require an explicit attempt ID"
    else:
        selected = paths
    try:
        result = dict(load_score(selected[0]))
    except Exception as exc:
        return None, f"scoring result is unavailable: {type(exc).__name__}"
    if result.get("scoringAttemptId") != selected[0].parent.name:
        return None, "scoring result attempt identity does not match its directory"
    if result.get("kind") != "captured_execution_score":
        return None, "scoring result kind is unsupported"
    return result, None


def _semantic_row(score: Mapping[str, Any]) -> Mapping[str, Any] | None:
    semantic = score.get("semantic")
    if not isinstance(semantic, Mapping):
        return None
    findings = semantic.get("findings")
    if not isinstance(findings, Mapping):
        return None
    row = findings.get("semantic_quality")
    return row if isinstance(row, Mapping) else None


def _score_error(
    score: Mapping[str, Any],
    identity: Mapping[str, Any],
    record: Mapping[str, Any],
    loaded_case: Mapping[str, Any],
    saved_spans: list[Any],
) -> str | None:
    if score.get("status") != "complete":
        return "scoring result is incomplete"
    if score.get("executionId") != identity.get("executionId"):
        return "scoring result execution identity does not match the saved execution"
    score_identity = score.get("identity")
    if not isinstance(score_identity, Mapping):
        return "scoring result identity is missing"
    for field in identity:
        if score_identity.get(field) != identity.get(field):
            return f"scoring result {field} does not match the saved execution"
    telemetry = score.get("telemetry")
    if not isinstance(telemetry, Mapping) or telemetry.get("status") != "complete":
        return "scoring telemetry is incomplete"
    for field in ("sessionId", "traceId"):
        if telemetry.get(field) != identity.get(field):
            return f"scoring telemetry {field} does not match the saved execution"
    score_spans = telemetry.get("sessionSpans")
    if not isinstance(score_spans, list):
        return "scoring telemetry spans are missing"
    validated, validation_error = _validate_session(score_spans, record, loaded_case)
    if validation_error is not None:
        return f"scoring telemetry is invalid: {validation_error}"
    roster_error = _span_roster_mismatch(saved_spans, score_spans)
    if roster_error is not None:
        return f"scoring telemetry is invalid: {roster_error}"
    semantic = score.get("semantic")
    if not isinstance(semantic, Mapping) or semantic.get("status") != "complete":
        return "semantic verdict is incomplete"
    row = _semantic_row(score)
    if row is None or row.get("status") != "complete" or row.get("verdict") not in {"pass", "fail"}:
        return "semantic verdict row is invalid"
    raw_response = semantic.get("rawResponse")
    rows = raw_response.get("evaluationResults") if isinstance(raw_response, Mapping) else None
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], Mapping):
        return "semantic response must contain one result row"
    raw = rows[0]
    if raw.get("evaluatorId") != row.get("evaluatorId") or raw.get("label") != row.get("label"):
        return "semantic response does not match its normalized verdict"
    if raw.get("explanation") != row.get("explanation") or not isinstance(raw.get("explanation"), str) or not raw.get("explanation").strip():
        return "semantic response reason does not match its normalized result"
    if row.get("verdict") != raw.get("label") or row.get("errorCode") or row.get("errorMessage"):
        return "semantic response contains an error or inconsistent verdict"
    if row.get("ignoredReferenceInputFields") not in (None, [], ()):
        return "semantic response ignored evaluator references"
    evaluator = score.get("evaluator")
    if not isinstance(evaluator, Mapping) or not evaluator.get("evaluatorId") or not evaluator.get("configSha256"):
        return "scoring evaluator identity is missing"
    expected_evaluator_id = evaluator.get("evaluatorId")
    expected_evaluator_arn = evaluator.get("evaluatorArn")
    for candidate in (row, row.get("rawResult"), raw):
        if not isinstance(candidate, Mapping):
            continue
        if candidate.get("evaluatorId") != expected_evaluator_id:
            return "semantic response evaluator does not match the pinned evaluator"
        if expected_evaluator_arn is not None and candidate.get("evaluatorArn") is not None and candidate.get("evaluatorArn") != expected_evaluator_arn:
            return "semantic response evaluator ARN does not match the pinned evaluator"
    identity_error = _row_identity_error(
        raw,
        evaluator_id=expected_evaluator_id,
        session_id=identity["sessionId"],
        trace_id=identity.get("traceId"),
    )
    if identity_error is not None:
        return identity_error
    normalized = _mapped_row(raw, reject_ignored_reference_fields=True, reject_dimension_name=True)
    if normalized.get("status") != "complete":
        return normalized.get("validationError") or normalized.get("errorCode") or "semantic response row is invalid"
    if raw_response.get("errorCode") is not None or raw_response.get("errorMessage") is not None:
        return "semantic response contains a top-level error"
    for candidate in (row, row.get("rawResult"), raw):
        if isinstance(candidate, Mapping):
            context = candidate.get("context")
            span_context = context.get("spanContext") if isinstance(context, Mapping) else None
            if not isinstance(span_context, Mapping) or span_context.get("sessionId") != identity.get("sessionId"):
                return "semantic verdict session identity does not match the saved execution"
            if any(key in span_context for key in ("traceId", "trace_id", "traceID")):
                trace_value = next(span_context[key] for key in ("traceId", "trace_id", "traceID") if key in span_context)
                if trace_value != identity.get("traceId"):
                    return "semantic verdict trace identity does not match the saved execution"
    source = score.get("scoringSourceSha256")
    required_source = {"deterministic_checks.py", "evaluation_telemetry.py", "agentcore_evaluation.py"}
    if not isinstance(source, Mapping) or set(source) != required_source or any(
        not isinstance(value, str) or len(value) != 64 for value in source.values()
    ):
        return "scoring source identity is missing"
    assertions = score.get("assertions")
    expected_assertions = [
        *case_assertions(loaded_case),
        *timing_evidence_assertions(validated["content"]["toolCalls"]),
    ]
    if assertions != expected_assertions:
        return "scoring assertions do not match the authenticated session"
    if not isinstance(assertions, list) or score.get("assertionsSha256") != _digest(assertions):
        return "scoring assertions digest is invalid"
    evidence_digest = score.get("evidenceSha256")
    if telemetry.get("sha256") != _digest(score_spans) or telemetry.get("sha256") != evidence_digest:
        return "scoring evidence digest is invalid"
    configuration = score.get("evaluatorConfiguration")
    expected_config = configuration.get("evaluatorConfig") if isinstance(configuration, Mapping) else None
    if not isinstance(expected_config, Mapping) or evaluator.get("configSha256") != _digest(expected_config):
        return "scoring evaluator configuration digest is invalid"
    if evaluator.get("evaluatorId") != configuration.get("evaluatorId") or evaluator.get("evaluatorArn") != configuration.get("evaluatorArn"):
        return "scoring evaluator pin does not match its configuration"
    return None


def _score_view(score: Mapping[str, Any]) -> dict[str, Any]:
    view = dict(score)
    telemetry = view.get("telemetry")
    if isinstance(telemetry, Mapping):
        view["telemetry"] = {key: value for key, value in telemetry.items() if key != "sessionSpans"}
    return view


def _incomplete_score_view(score: Mapping[str, Any]) -> dict[str, Any]:
    return {
        key: score[key]
        for key in ("status", "scoringAttemptId", "phase", "diagnostic", "reason", "identity", "evaluator")
        if key in score
    }


def _common_checks(
    baseline_record: Mapping[str, Any],
    candidate_record: Mapping[str, Any],
    baseline_case: Mapping[str, Any],
    candidate_case: Mapping[str, Any],
    baseline_score: Mapping[str, Any],
    candidate_score: Mapping[str, Any],
) -> str | None:
    bi = _execution_identity(baseline_record)
    ci = _execution_identity(candidate_record)
    for field in ("caseSha256", "bundleSha256", "originatingRunId", "referenceTime", "modelId", "dependencySha256"):
        if bi.get(field) != ci.get(field):
            return f"candidate {field} does not match the baseline"
    for field in ("caseSha256", "bundleSha256", "originatingRunId", "referenceTime"):
        if baseline_case.get(field) != candidate_case.get(field):
            return f"candidate case {field} does not match the baseline"
    if _source_digests(baseline_record).get("agent/prompt.py") == _source_digests(candidate_record).get("agent/prompt.py"):
        return "candidate prompt source is unchanged"
    if bi.get("promptSha256") == ci.get("promptSha256"):
        return "candidate prompt identity is unchanged"
    bs, cs = _source_digests(baseline_record), _source_digests(candidate_record)
    for name in COMMON_SOURCE_FILES:
        if bs[name] != cs[name] and (bs[name], cs[name]) != RETAINED_S2_SOURCE_TRANSITIONS.get(name):
            return f"common execution source differs: {name}"
    be, ce = baseline_score.get("evaluator"), candidate_score.get("evaluator")
    if be != ce:
        return "candidate evaluator identity differs from the baseline"
    if baseline_score.get("scoringSourceSha256") != candidate_score.get("scoringSourceSha256"):
        return "scoring source identity differs from the baseline"
    return None


def compare_runs(
    baseline: str | Path,
    candidate: str | Path,
    baseline_attempt: str | None = None,
    candidate_attempt: str | None = None,
    *,
    load_score: Callable[[Path], Mapping[str, Any]],
) -> dict[str, Any]:
    """Return a read-only comparison, preserving known findings on incompleteness."""

    baseline_path, candidate_path = Path(baseline), Path(candidate)
    try:
        baseline_record, baseline_case, baseline_spans = load_execution(baseline_path)
        candidate_record, candidate_case, candidate_spans = load_execution(candidate_path)
    except Exception as exc:
        return {"status": "error", "reason": f"saved execution is unavailable: {type(exc).__name__}"}
    baseline_view = _execution_view(baseline_path, baseline_record, baseline_case)
    candidate_view = _execution_view(candidate_path, candidate_record, candidate_case)
    if baseline_record.get("status") != "complete" or candidate_record.get("status") != "complete":
        return {"status": "incomplete", "reason": "both executions must be complete", "baseline": baseline_view, "candidate": candidate_view}
    baseline_score, reason = _select_attempt(baseline_path, baseline_attempt, load_score)
    if reason is not None:
        return {"status": "incomplete", "reason": reason, "baseline": baseline_view, "candidate": candidate_view}
    baseline_error = _score_error(
        baseline_score, _execution_identity(baseline_record), baseline_record, baseline_case, baseline_spans
    )
    if baseline_error is not None:
        if baseline_score.get("status") != "complete":
            baseline_view["score"] = _incomplete_score_view(baseline_score)
        return {"status": "incomplete", "reason": baseline_error, "baseline": baseline_view, "candidate": candidate_view}
    baseline_view["score"] = _score_view(baseline_score)
    candidate_score, reason = _select_attempt(candidate_path, candidate_attempt, load_score)
    if reason is not None:
        return {"status": "incomplete", "reason": reason, "baseline": baseline_view, "candidate": candidate_view}
    candidate_error = _score_error(
        candidate_score, _execution_identity(candidate_record), candidate_record, candidate_case, candidate_spans
    )
    if candidate_error is not None:
        # Keep the malformed receipt on disk for diagnosis, but do not present
        # its invalid semantic result as the candidate's accepted score.
        candidate_view["score"] = _incomplete_score_view(candidate_score)
        return {"status": "incomplete", "reason": candidate_error, "baseline": baseline_view, "candidate": candidate_view}
    candidate_view["score"] = _score_view(candidate_score)
    reason = _common_checks(baseline_record, candidate_record, baseline_case, candidate_case, baseline_score, candidate_score)
    if reason is not None:
        return {"status": "incomplete", "reason": reason, "baseline": baseline_view, "candidate": candidate_view}
    return {
        "status": "complete",
        "reason": "matching reviewed inputs and pinned scoring identities",
        "baseline": baseline_view,
        "candidate": candidate_view,
        "comparison": {
            "sameCase": True,
            "sameEvidence": True,
            "sameEvaluator": True,
            "sameScoringSource": True,
        },
    }
