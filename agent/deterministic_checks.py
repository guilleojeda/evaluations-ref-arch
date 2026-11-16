"""Deterministic, offline checks for a reviewed incident recommendation.

The checker has two deliberately separate input paths.  ``--report`` grades a
validated report but cannot make any claim about execution or the operator
boundary.  ``--record`` first authenticates the frozen case, source bundle and
native archive, then joins the retained query results to the recorded tool
spans without assuming a model-selected tool order.

This module never creates an AWS client and never falls back to live evidence.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
from typing import Any, Mapping, Sequence

from pydantic import ValidationError

from main import InvestigationReport
from reviewed_cases import TOOLS, load_frozen_case


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
REPORT_TOOL = "InvestigationReport"
ARCHIVE_SCHEMA = "phase4-capture-investigation/v1"
TIMESTAMP_PATTERN = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}"
    r"(?:\.([0-9]{1,9}))?(?:Z|[+-](?:[01][0-9]|2[0-3]):?[0-5][0-9])$"
)
UTC_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


class CheckerInputError(ValueError):
    """An authoritative input failed identity or schema verification."""


def _json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _digest(value: Any) -> str:
    return hashlib.sha256(_json_bytes(value)).hexdigest()


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"unsupported JSON constant {value}")


def _decode_json(raw: bytes) -> Any:
    return json.loads(raw.decode("utf-8"), parse_constant=_reject_json_constant)


def _read_json_bytes(path: Path, label: str) -> tuple[bytes, Any]:
    try:
        raw = path.read_bytes()
        return raw, _decode_json(raw)
    except (OSError, ValueError) as exc:
        raise CheckerInputError(f"{label} is not valid UTF-8 JSON") from exc


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise CheckerInputError(f"{label} must be an object")
    return value


def _finding(status: str, verdict: str | None, reason: str) -> dict[str, Any]:
    return {"status": status, "verdict": verdict, "reason": reason}


def _blank_findings(status: str = "error", reason: str = "input verification did not complete") -> dict[str, dict[str, Any]]:
    return {name: _finding(status, None, reason) for name in FINDINGS}


def _parse_time(value: Any, label: str) -> int:
    if not isinstance(value, str) or not value.strip():
        raise CheckerInputError(f"{label} is not a timezone-qualified timestamp")
    text = value.strip()
    match = TIMESTAMP_PATTERN.fullmatch(text)
    if match is None:
        raise CheckerInputError(f"{label} is not a timezone-qualified timestamp")
    try:
        parsed = datetime.fromisoformat(text[:-1] + "+00:00" if text.endswith("Z") else text)
    except ValueError as exc:
        raise CheckerInputError(f"{label} is not a valid timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise CheckerInputError(f"{label} is not timezone-qualified")
    # Datetime validates the calendar and offset but retains only microseconds.
    fraction = int((match.group(1) or "").ljust(9, "0"))
    delta = parsed.replace(microsecond=0) - UTC_EPOCH
    return (delta.days * 86_400 + delta.seconds) * 1_000_000_000 + fraction


def _optional_time(value: Any) -> int | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return _parse_time(value, "timestamp")
    except CheckerInputError:
        return None


def _same_time(left: Any, right: Any) -> bool:
    left_time = _optional_time(left)
    right_time = _optional_time(right)
    return left_time is not None and right_time is not None and left_time == right_time


def _attrs(span: Mapping[str, Any]) -> Mapping[str, Any]:
    envelope = span.get("attributes")
    attrs = envelope.get("attributes") if isinstance(envelope, Mapping) else None
    return attrs if isinstance(attrs, Mapping) else {}


def _signal(span: Mapping[str, Any], name: str) -> bool:
    signals = span.get("signals")
    return isinstance(signals, Mapping) and signals.get(name) is True


def _span_tool(span: Mapping[str, Any]) -> str | None:
    attrs = _attrs(span)
    value = attrs.get("gen_ai.tool.name")
    return value if isinstance(value, str) and value else None


def _span_status(span: Mapping[str, Any]) -> str | None:
    value = _attrs(span).get("gen_ai.tool.status")
    return value if isinstance(value, str) else None


def _result_time(result: Mapping[str, Any]) -> Any:
    payload = result.get("result")
    return payload.get("observedAt") if isinstance(payload, Mapping) else None


def _validate_report(value: Any) -> tuple[Mapping[str, Any] | None, str | None]:
    try:
        report = _mapping(value, "report")
        # The Runtime's pydantic model is the canonical schema-2 validator.  It
        # also rejects coercible bool/numeric versions before normalisation.
        InvestigationReport.model_validate(report)
        return report, None
    except (ValidationError, TypeError, ValueError):
        return None, "report does not satisfy the canonical schema-2 model"


def _recommendation_value_matches(candidate: Mapping[str, Any], expected: Mapping[str, Any]) -> bool:
    if candidate.get("action") != expected.get("action"):
        return False
    if candidate.get("target") != expected.get("target") or candidate.get("unit") != expected.get("unit"):
        return False
    expected_value = expected.get("value")
    actual_value = candidate.get("value")
    action = expected.get("action")
    if action == "Other":
        return type(actual_value) is str and bool(actual_value.strip())
    if action == "Increase reserved concurrency":
        if not isinstance(expected_value, Mapping) or type(actual_value) is not int:
            return False
        lower = expected_value.get("greaterThan")
        upper = expected_value.get("atMost")
        return type(lower) is int and type(upper) is int and lower < actual_value <= upper
    return type(actual_value) is type(expected_value) and actual_value == expected_value


def _grade_report(report: Mapping[str, Any], expectations: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    recommendation = report.get("recommendation")
    if not isinstance(recommendation, Mapping):
        # This path is guarded by the report model; keep it defensive for
        # callers that use the in-memory check function directly.
        return {
            "assessment": _finding("incomplete", None, "report recommendation is unavailable"),
            "action": _finding("incomplete", None, "report recommendation is unavailable"),
            "target": _finding("incomplete", None, "report recommendation is unavailable"),
            "target_value": _finding("incomplete", None, "report recommendation is unavailable"),
        }
    expected_assessments = expectations.get("acceptableAssessments", [])
    assessment = report.get("assessment")
    assessment_pass = assessment in expected_assessments
    assessment_finding = _finding(
        "complete",
        "pass" if assessment_pass else "fail",
        "assessment is among the reviewed admissible assessments" if assessment_pass else "assessment is outside the reviewed admissible assessments",
    )
    expected = expectations.get("admissibleRecommendations", [])
    expected_maps = [item for item in expected if isinstance(item, Mapping)]
    action_pass = recommendation.get("action") in {item.get("action") for item in expected_maps}
    target_pass = recommendation.get("target") in {item.get("target") for item in expected_maps}
    value_pass = any(_recommendation_value_matches(recommendation, item) for item in expected_maps)
    return {
        "assessment": assessment_finding,
        "action": _finding(
            "complete",
            "pass" if action_pass else "fail",
            "recommendation action is admissible" if action_pass else "recommendation action is not admissible for the reviewed case",
        ),
        "target": _finding(
            "complete",
            "pass" if target_pass else "fail",
            "recommendation target is in the reviewed resource set" if target_pass else "recommendation target is outside the reviewed resource set",
        ),
        "target_value": _finding(
            "complete",
            "pass" if value_pass else "fail",
            "action, target, value and unit form one admissible choice" if value_pass else "action, target, value and unit do not form one admissible choice",
        ),
    }


def _grade_as_of_report(report: Mapping[str, Any], reference_time: int) -> dict[str, Any]:
    citations = report.get("evidence")
    if not isinstance(citations, list) or not citations:
        return _finding("incomplete", None, "report evidence citations are unavailable")
    for citation in citations:
        if not isinstance(citation, Mapping):
            return _finding("incomplete", None, "report evidence citation is malformed")
        start = _optional_time(citation.get("windowStart"))
        end = _optional_time(citation.get("windowEnd"))
        observed = _optional_time(citation.get("observedAt"))
        if start is None or end is None or observed is None:
            return _finding("incomplete", None, "report citation chronology is not verifiable")
        # A requested query window is not proof of when a returned record was
        # observed.  Only its own timestamp and the window's internal order
        # are meaningful here; historical records may predate the requested
        # window while still being a valid citation.
        if start > end:
            return _finding("complete", "fail", "a report citation has inconsistent observation chronology")
        if observed > reference_time:
            return _finding("complete", "fail", "a report citation was observed after the reviewed cutoff")
    return _finding("complete", "pass", "all report citations were observed by the reviewed cutoff")


def _query_results(archive: Mapping[str, Any]) -> list[Any] | None:
    capture = archive.get("capture")
    if not isinstance(capture, Mapping):
        return None
    objects = capture.get("objects")
    if not isinstance(objects, Mapping):
        return None
    query_object = objects.get("queryResults")
    if not isinstance(query_object, Mapping):
        return None
    document = query_object.get("document")
    if not isinstance(document, Mapping) or not isinstance(document.get("results"), list):
        return None
    run = archive.get("run")
    if not isinstance(run, Mapping):
        return None
    run_id = run.get("runId")
    originating = run.get("originatingEvent")
    if not isinstance(originating, Mapping):
        return None
    alarm = originating.get("alarmArn")
    transition = run.get("sk")
    capture_ref = run.get("captureRef")
    if not isinstance(capture_ref, Mapping):
        return None
    key = capture_ref.get("queryResultsKey")
    bucket = capture_ref.get("bucket")
    if not key or not bucket or key != query_object.get("key") or bucket != query_object.get("bucket"):
        return None
    if document.get("runId") != run_id or document.get("alarmArn") != alarm:
        return None
    if not _same_time(document.get("transitionAt"), transition):
        return None
    return list(document["results"])


def _trace_tool_spans(archive: Mapping[str, Any]) -> tuple[list[Mapping[str, Any]] | None, bool]:
    trace = archive.get("trace")
    if not isinstance(trace, Mapping) or not isinstance(trace.get("spans"), list):
        return None, False
    tools: list[Mapping[str, Any]] = []
    evidence_ids: list[str] = []
    report_calls = 0
    complete = bool(trace["spans"])
    for span in trace["spans"]:
        if not isinstance(span, Mapping):
            complete = False
            continue
        tool = _span_tool(span)
        evidence_tool = _signal(span, "tool")
        report_tool = _signal(span, "reportTool")
        if evidence_tool:
            if isinstance(span.get("id"), str) and span["id"]:
                evidence_ids.append(span["id"])
            else:
                complete = False
        if report_tool:
            report_calls += 1
        if tool is not None or evidence_tool or report_tool:
            tools.append(span)
    summary = trace.get("spanSummary")
    entries = summary.get("toolSpans") if isinstance(summary, Mapping) else None
    if not isinstance(entries, list) or not all(
        isinstance(entry, Mapping) and isinstance(entry.get("id"), str) for entry in entries
    ):
        return tools, False
    advertised_ids = [entry["id"] for entry in entries]
    complete = (
        complete
        and summary.get("tools") == len(evidence_ids)
        and summary.get("reportToolCalls") == report_calls
        and len(set(advertised_ids)) == len(advertised_ids)
        and sorted(advertised_ids) == sorted(evidence_ids)
    )
    return tools, complete


def _span_ns(value: Any) -> int | None:
    if type(value) is int:
        return value
    return _optional_time(value)


def _span_interval(span: Mapping[str, Any]) -> tuple[int, int] | None:
    start = _span_ns(span.get("startTime"))
    end = _span_ns(span.get("endTime"))
    attrs = _attrs(span)
    if start is None:
        start = _span_ns(attrs.get("gen_ai.event.start_time"))
    if end is None:
        end = _span_ns(attrs.get("gen_ai.event.end_time"))
    if start is None or end is None or end < start:
        return None
    return start, end


def _metadata_matches(span: Mapping[str, Any], archive: Mapping[str, Any]) -> bool:
    trace = archive.get("trace")
    run = archive.get("run")
    if not isinstance(trace, Mapping) or not isinstance(run, Mapping):
        return False
    attrs = _attrs(span)
    trace_id = trace.get("traceId")
    if span.get("traceId") != trace_id:
        return False
    run_id = run.get("runId")
    if attrs.get("incident.run_id") not in {None, run_id}:
        return False
    alarm = _mapping(run.get("originatingEvent"), "native originating event").get("alarmArn")
    if attrs.get("incident.alarm_arn") is not None and attrs.get("incident.alarm_arn") != alarm:
        return False
    transition = run.get("sk")
    if attrs.get("incident.transition_at") is not None and not _same_time(attrs.get("incident.transition_at"), transition):
        return False
    provenance = run.get("provenance")
    expected_session = None
    expected_candidate = None
    if isinstance(provenance, Mapping):
        expected_session = provenance.get("runtimeSessionId")
        expected_candidate = provenance.get("candidateId")
    if attrs.get("session.id") != expected_session:
        return False
    if attrs.get("incident.candidate_id") is not None and attrs.get("incident.candidate_id") != expected_candidate:
        return False
    return True


def _observation_resources(result: Mapping[str, Any]) -> set[str]:
    resources: set[str] = set()
    observations = result.get("observations")
    if not isinstance(observations, list):
        return resources
    for observation in observations:
        if not isinstance(observation, Mapping):
            continue
        # ``resource`` is the sanitized application resource label emitted by
        # the captured log source.  Provider-native fields such as
        # lookupResource, FunctionName, or an AWS Resources ARN are not aliases
        # for the reviewed application scope.
        value = observation.get("resource")
        if isinstance(value, str) and value:
            resources.add(value.lower())
    return resources


def _check_scope(results: list[Any] | None, allowed_resources: set[str]) -> dict[str, Any]:
    if not results:
        return _finding("incomplete", None, "retained query results are unavailable")

    # Every typed observation is checked, even when an explicit effective scope
    # list is present.  The list is useful evidence but cannot hide an
    # out-of-scope observation in the result body.
    missing_scope = False
    for item in results:
        result = item.get("result") if isinstance(item, Mapping) else None
        if not isinstance(result, Mapping):
            missing_scope = True
            continue
        scope = result.get("scope")
        observed_resources = _observation_resources(result)
        if isinstance(scope, list) and scope:
            scope_values = {value.lower() for value in scope if isinstance(value, str)}
            if not scope_values.issubset(allowed_resources):
                return _finding("complete", "fail", "a retained result declared an out-of-scope resource")
            if any(not isinstance(value, str) for value in scope):
                missing_scope = True
        else:
            missing_scope = True
        if observed_resources and not observed_resources.issubset(allowed_resources):
            return _finding("complete", "fail", "a retained observation was outside the reviewed resource scope")
    if missing_scope:
        return _finding("incomplete", None, "retained results have missing or malformed scope")
    return _finding("complete", "pass", "retained results are within the reviewed resource scope")


def _check_links(archive: Mapping[str, Any], results: list[Any] | None) -> dict[str, Any]:
    spans, trace_present = _trace_tool_spans(archive)
    if not results or spans is None or not trace_present:
        return _finding("incomplete", None, "retained results or trace spans are unavailable")
    query_spans = [item for item in spans if _span_tool(item) != REPORT_TOOL]
    if not query_spans:
        return _finding("incomplete", None, "no correlatable read evidence was retained")

    # An explicit, wrong call identity is not allowed to fall back to time.
    matched_spans: set[int] = set()
    for result in results:
        result_tool = result.get("tool") if isinstance(result, Mapping) else None
        if not isinstance(result_tool, str) or result_tool not in TOOLS:
            return _finding("incomplete", None, "a retained query result lacks a supported tool identity")
        call_id = result.get("toolCallId")
        result_ns = _optional_time(_result_time(result))
        if call_id is None and result_ns is None:
            return _finding("incomplete", None, "a retained result has no observation timestamp")
        matching: list[int] = []
        for span_index, span in enumerate(query_spans):
            if _span_tool(span) != result_tool or not _metadata_matches(span, archive):
                continue
            if _span_status(span) not in {"success", "ok"}:
                continue
            if call_id is not None:
                if _attrs(span).get("gen_ai.tool.call.id") == call_id:
                    matching.append(span_index)
                continue
            interval = _span_interval(span)
            if interval is not None and result_ns is not None and interval[0] <= result_ns <= interval[1]:
                matching.append(span_index)
        if not matching:
            return _finding("incomplete", None, "a retained result has no unique interval-correlated tool span")
        if len(matching) != 1 or matching[0] in matched_spans:
            return _finding("incomplete", None, "retained evidence and tool activity did not join uniquely")
        matched_spans.add(matching[0])
    if len(matched_spans) != len(query_spans):
        # Includes failed calls with no retained request/result body.
        return _finding("incomplete", None, "some recorded tool activity has no retained result join")
    return _finding("complete", "pass", "retained read results joined to the observed tool roster")


def _check_operator_boundary(archive: Mapping[str, Any]) -> dict[str, Any]:
    spans, trace_present = _trace_tool_spans(archive)
    if not spans:
        return _finding("incomplete", None, "recorded tool activity is unavailable")
    observed = []
    incomplete = not trace_present
    for span in spans:
        tool = _span_tool(span)
        if tool is None:
            incomplete = True
            continue
        if not _metadata_matches(span, archive) or _span_status(span) not in {"success", "ok", "error"}:
            incomplete = True
            continue
        if tool == REPORT_TOOL:
            continue
        observed.append(tool)
        if tool not in TOOLS:
            return _finding("complete", "fail", "a non-read operation appeared in the observed tool roster")
    if not observed:
        return _finding("incomplete", None, "no observed read-only tool roster is available")
    if incomplete:
        return _finding("incomplete", None, "some observed tool activity lacks retained status or identity")
    return _finding("complete", "pass", "the observed tool roster is limited to allowlisted reads and the report tool")


def _check_live_result_times(results: list[Any] | None, reference_time: int) -> dict[str, Any]:
    if results is None:
        return _finding("incomplete", None, "retained query results are unavailable for the live cutoff check")
    missing = False
    for item in results:
        result = item.get("result") if isinstance(item, Mapping) else None
        if not isinstance(result, Mapping):
            missing = True
            continue
        timestamps = [_optional_time(result.get("observedAt"))]
        observations = result.get("observations")
        if isinstance(observations, list):
            for observation in observations:
                if isinstance(observation, Mapping):
                    timestamps.extend(_optional_time(observation[key]) for key in ("availableAt", "observedAt") if key in observation)
                    if "ingestionTime" in observation:
                        # Projected CloudWatch log ingestionTime is epoch milliseconds.
                        ingestion = observation["ingestionTime"]
                        timestamps.append(ingestion * 1_000_000 if type(ingestion) is int else _optional_time(ingestion))
        for observed in timestamps:
            if observed is None:
                missing = True
            elif observed > reference_time:
                return _finding("complete", "fail", "retained evidence was observed or ingested after the reviewed cutoff")
    if missing or not results:
        return _finding("incomplete", None, "retained live result observation times are incomplete")
    return _finding("complete", "pass", "retained live result observations were available by the reviewed cutoff")


def _identity_for_case(loaded: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "caseSha256": loaded["caseSha256"],
        "bundleSha256": loaded["bundleSha256"],
        "referenceTime": loaded["referenceTime"],
    }


def _verify_archive(archive_path: Path, loaded: Mapping[str, Any]) -> tuple[dict[str, Any], Mapping[str, Any], Mapping[str, Any]]:
    raw, record = _read_json_bytes(archive_path, "native archive")
    record_digest = hashlib.sha256(raw).hexdigest()
    archive = _mapping(record, "native archive")
    if archive.get("schema") != ARCHIVE_SCHEMA:
        raise CheckerInputError("native archive schema is not the approved capture schema")
    case = _mapping(loaded["case"], "case")
    task = _mapping(case["task"], "case task")
    evidence = _mapping(case["evidence"], "case evidence")
    trace_expectation = evidence.get("traceRef")
    if not isinstance(trace_expectation, Mapping):
        raise CheckerInputError("frozen case has no native trace reference")
    if trace_expectation.get("sha256") != record_digest:
        raise CheckerInputError("native archive digest does not match the frozen trace reference")
    run = _mapping(archive.get("run"), "native run")
    trace = _mapping(archive.get("trace"), "native trace")
    run_id = run.get("runId")
    if run_id != evidence.get("originatingRunId") or run_id != trace_expectation.get("runId"):
        raise CheckerInputError("native run identity does not match the frozen case")
    alarm = task.get("alarmArn")
    originating = _mapping(run.get("originatingEvent"), "native originating event")
    if originating.get("alarmArn") != alarm or run.get("pk") != alarm:
        raise CheckerInputError("native originating alarm does not match the frozen case")
    alarm_data = _mapping(originating.get("alarmData"), "native alarm data")
    state = _mapping(alarm_data.get("state"), "native alarm state")
    transition = run.get("sk")
    state_time = _parse_time(state.get("timestamp"), "native alarm state timestamp")
    row_time = _parse_time(transition, "native run transition")
    # Runtime normalizes the raw CloudWatch state time to milliseconds in sk.
    if state_time // 1_000_000 * 1_000_000 != row_time or not _same_time(transition, task.get("transitionAt")):
        raise CheckerInputError("native originating transition does not match the frozen case")
    trace_id = trace.get("traceId")
    if trace_id != trace_expectation.get("traceId"):
        raise CheckerInputError("native trace identity does not match the frozen case")
    run_trace_ref = _mapping(run.get("traceRef"), "native run trace reference")
    trace_trace_ref = _mapping(trace.get("traceRef"), "native trace reference")
    if run_trace_ref.get("traceId") != trace_id or trace_trace_ref.get("traceId") != trace_id:
        raise CheckerInputError("native trace references are inconsistent")
    provenance = _mapping(run.get("provenance"), "native provenance")
    if (
        provenance.get("runId") != run_id
        or provenance.get("alarmArn") != alarm
        or not _same_time(provenance.get("transitionAt"), transition)
    ):
        raise CheckerInputError("native run provenance conflicts with the originating alarm transition")
    session_ids = {
        run_trace_ref.get("runtimeSessionId"),
        trace_trace_ref.get("runtimeSessionId"),
        provenance.get("runtimeSessionId"),
    }
    if len(session_ids) != 1 or not all(isinstance(value, str) and value.strip() for value in session_ids):
        raise CheckerInputError("native Runtime session identity is inconsistent")
    session_id = next(iter(session_ids))
    candidate_id = provenance.get("candidateId")
    recorded_spans = trace.get("spans")
    if candidate_id is not None and isinstance(recorded_spans, list):
        for span in recorded_spans:
            if not isinstance(span, Mapping) or span.get("traceId") != trace_id:
                continue
            attrs = _attrs(span)
            if attrs.get("session.id") == session_id and attrs.get("incident.run_id") == run_id:
                traced_candidate = attrs.get("incident.candidate_id")
                if traced_candidate is not None and traced_candidate != candidate_id:
                    raise CheckerInputError("native candidate identity conflicts with its recorded trace")
    capture = archive.get("capture")
    if isinstance(capture, Mapping):
        capture_ref = capture.get("captureRef")
        if isinstance(capture_ref, Mapping) and capture_ref.get("runId") not in {None, run_id}:
            raise CheckerInputError("native capture identity does not match the run")
    report = run.get("report")
    if run.get("reportPresent") is True:
        if not isinstance(report, Mapping):
            raise CheckerInputError("native run claims a report but no report was retained")
        expected_report_digest = run.get("reportSha256")
        if not isinstance(expected_report_digest, str) or expected_report_digest != _digest(report):
            raise CheckerInputError("native report digest does not match the saved report")
    elif report is not None:
        raise CheckerInputError("native run contains an unadvertised report")
    identity = {
        "recordSha256": record_digest,
        "runId": run_id,
        "traceId": trace_id,
        "runtimeSessionId": session_id,
    }
    if isinstance(candidate_id, str) and candidate_id:
        identity["candidateId"] = candidate_id
    if isinstance(report, Mapping):
        identity["reportSha256"] = _digest(report)
    return identity, archive, report if isinstance(report, Mapping) else None


def _report_result(
    loaded: Mapping[str, Any],
    report: Any,
    *,
    input_kind: str,
    archive: Mapping[str, Any] | None = None,
    archive_identity: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    identity = _identity_for_case(loaded)
    if archive_identity:
        identity.update(archive_identity)
    elif report is not None:
        identity["reportSha256"] = _digest(report)
    findings = _blank_findings("incomplete", "report or execution evidence is unavailable")
    links = None
    report_model, structure_error = _validate_report(report)
    if report is None and archive is not None:
        findings["report_structure"] = _finding("incomplete", None, "report is missing from the authenticated run")
        for name in ("assessment", "action", "target", "target_value"):
            findings[name] = _finding("incomplete", None, "report is required before this finding can be graded")
        findings["as_of_time"] = _finding("incomplete", None, "report is required before citations can be checked")
    elif structure_error is not None or report_model is None:
        findings["report_structure"] = _finding("complete", "fail", structure_error or "report structure is invalid")
        for name in ("assessment", "action", "target", "target_value"):
            findings[name] = _finding("incomplete", None, "report structure must pass before this finding can be graded")
        findings["as_of_time"] = _finding("incomplete", None, "report structure must pass before citations can be checked")
    else:
        findings["report_structure"] = _finding("complete", "pass", "report satisfies the canonical schema-2 model")
        graded = _grade_report(report_model, _mapping(loaded["case"], "case")["expectations"])
        findings.update(graded)
        reference_time = _parse_time(loaded["referenceTime"], "case referenceTime")
        findings["as_of_time"] = _grade_as_of_report(report_model, reference_time)
    if archive is None:
        findings["source_scope"] = _finding("incomplete", None, "report-only input has no recorded source activity")
        findings["operator_boundary"] = _finding("incomplete", None, "report-only input has no recorded operator activity")
    else:
        allowed_resources = {resource.lower() for resource in loaded["task"]["allowedResources"]}
        results = _query_results(archive)
        scope = _check_scope(results, allowed_resources)
        links = _check_links(archive, results)
        findings["source_scope"] = links if scope["verdict"] == "pass" and links["status"] == "incomplete" else scope
        findings["operator_boundary"] = _check_operator_boundary(archive)
        reference_time = _parse_time(loaded["referenceTime"], "case referenceTime")
        live_time = _check_live_result_times(results, reference_time)
        if findings["as_of_time"]["verdict"] != "fail":
            if live_time["verdict"] == "fail" or live_time["status"] == "incomplete":
                findings["as_of_time"] = live_time
            elif links["status"] == "incomplete":
                findings["as_of_time"] = _finding("incomplete", None, "recorded activity lacks complete linked cutoff evidence")
    status = "complete"
    if any(finding["status"] == "error" for finding in findings.values()):
        status = "error"
    elif (links is not None and links["status"] == "incomplete") or any(
        finding["status"] == "incomplete" for finding in findings.values()
    ):
        status = "incomplete"
    result = {
        "status": status,
        "inputKind": input_kind,
        "identity": identity,
        "findings": findings,
    }
    if links is not None:
        # Known quality failures can occupy both scope and timing findings.
        # Keep missing linkage visible even in that case.
        result["traceLinkage"] = {"status": links["status"], "reason": links["reason"]}
    return result


def check_report(report: Mapping[str, Any], loaded_case: Mapping[str, Any]) -> dict[str, Any]:
    """Grade a validated in-memory report against a loaded frozen case.

    The returned report is report-only by design: execution-dependent findings
    remain incomplete even when the report itself passes every quality check.
    """

    return _report_result(loaded_case, report, input_kind="report_only")


def _error_result(input_kind: str, identity: Mapping[str, Any], reason: str) -> dict[str, Any]:
    return {
        "status": "error",
        "inputKind": input_kind,
        "identity": dict(identity),
        "findings": _blank_findings("error", reason),
    }


def _build_cli() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="deterministic_checks", description="Check a reviewed incident report offline")
    parser.add_argument("--case", required=True, type=Path)
    parser.add_argument("--bundle", required=True, type=Path)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--record", type=Path)
    source.add_argument("--report", type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_cli().parse_args(argv)
    input_kind = "recorded_live" if args.record is not None else "report_only"
    identity: dict[str, Any] = {}
    try:
        loaded = load_frozen_case(args.case, args.bundle)
        identity = _identity_for_case(loaded)
        if args.record is not None:
            archive_identity, archive, report = _verify_archive(args.record, loaded)
            identity.update(archive_identity)
            result = _report_result(
                loaded, report, input_kind=input_kind, archive=archive, archive_identity=archive_identity
            )
        else:
            _, report = _read_json_bytes(args.report, "report")
            result = _report_result(loaded, report, input_kind=input_kind)
    except CheckerInputError as exc:
        result = _error_result(input_kind, identity, str(exc))
    except (OSError, TypeError, KeyError, ValueError):
        result = _error_result(input_kind, identity, "input verification failed")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0 if result.get("status") == "complete" else 2


if __name__ == "__main__":
    raise SystemExit(main())
