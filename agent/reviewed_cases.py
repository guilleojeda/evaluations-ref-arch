"""Offline reviewed-case validation and immutable input handoff.

The reviewed case is deliberately a local JSON boundary.  It keeps the
presenter's task separate from evaluator-only expectations, binds the case to
the exact verified Phase 13 capture and originating alarm, and emits only the
public task when a frozen case is handed to a candidate.

This module does not create AWS clients.  A bundle must be staged first and is
loaded through `CapturedEvidenceTools.load`, which verifies
the manifest and every source digest before any query is executed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from captured_evidence import CapturedEvidenceTools, SUPPORTED_METRIC_PERIODS
from evidence import MAX_WINDOW_SECONDS


SCHEMA_VERSION = 1
CASE_DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
VERSION_RE = re.compile(r"^[1-9][0-9]*$")
RESOURCES = frozenset({"gateway", "checkout", "inventory"})
TOOLS = frozenset({"search_logs", "read_metrics", "read_configuration", "read_change_history"})
RECOMMENDATION_ACTIONS = frozenset(
    {
        "Increase reserved concurrency",
        "Increase memory",
        "Restore inventory access",
        "Other",
    }
)
ASSESSMENTS = frozenset({"ongoing", "recovered", "unknown"})


def _json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def case_digest(case: Mapping[str, Any]) -> str:
    """Return the stable identity of a parsed case, independent of formatting."""

    return hashlib.sha256(_json_bytes(case)).hexdigest()


def _read_json(path: Path, label: str) -> Any:
    try:
        raw = path.read_text(encoding="utf-8")
        return json.loads(raw, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
        raise ValueError(f"{label} is not valid UTF-8 JSON") from exc


def _parse_time(value: Any, label: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be an ISO timestamp")
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise ValueError(f"{label} must be an ISO timestamp") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"{label} must include a timezone")
    return parsed.astimezone(timezone.utc)


def _require_mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{label} must be an object")
    return value


def _require_keys(value: Mapping[str, Any], required: set[str], allowed: set[str], label: str) -> None:
    missing = sorted(required - set(value))
    unknown = sorted(set(value) - allowed)
    if missing:
        raise ValueError(f"{label} is missing required fields: {', '.join(missing)}")
    if unknown:
        raise ValueError(f"{label} has unsupported fields: {', '.join(unknown)}")


def _nonempty_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")
    return value


def _string_list(value: Any, label: str, *, allow_empty: bool = False) -> list[str]:
    if not isinstance(value, list) or (not allow_empty and not value):
        raise ValueError(f"{label} must be a non-empty list of strings")
    if not all(isinstance(item, str) and item.strip() for item in value):
        raise ValueError(f"{label} must contain only non-empty strings")
    return list(value)


def _canonical_version(value: Any, label: str) -> str:
    if not isinstance(value, str) or not VERSION_RE.fullmatch(value):
        raise ValueError(f"{label} must be a canonical positive decimal version string")
    return value


def _integer(value: Any, label: str, *, positive: bool = False) -> int:
    # bool is an int subclass but is not a report/case numeric value.
    if isinstance(value, bool) or not isinstance(value, int) or (positive and value <= 0):
        qualifier = "positive integer" if positive else "integer"
        raise ValueError(f"{label} must be a {qualifier}")
    return value


def _validate_recommendation(value: Any, index: int) -> None:
    label = f"expectations.admissibleRecommendations[{index}]"
    recommendation = _require_mapping(value, label)
    _require_keys(recommendation, {"action", "target", "value", "unit"},
                  {"action", "target", "value", "unit", "nonEmptyExplanation"}, label)
    action = recommendation["action"]
    if action not in RECOMMENDATION_ACTIONS:
        raise ValueError(f"{label}.action is not supported")

    target = recommendation["target"]
    unit = recommendation["unit"]
    expected_target: str | None
    expected_unit: str | None
    if action == "Other":
        expected_target, expected_unit = None, None
        if target is not None or unit is not None:
            raise ValueError(f"{label} Other recommendation must have null target and unit")
        # Reviewed expectations use a boolean requirement while candidate
        # reports retain the normal scalar explanation value.  Keep the
        # requirement outside the candidate projection.
        explanation = recommendation.get("value")
        mapping_form = isinstance(explanation, Mapping) and set(explanation) == {"nonEmptyExplanation"} and explanation.get("nonEmptyExplanation") is True
        scalar_form = explanation is None and recommendation.get("nonEmptyExplanation") is True
        if not (mapping_form or scalar_form):
            raise ValueError(f"{label}.value must require a non-empty explanation")
        return
    if "nonEmptyExplanation" in recommendation:
        raise ValueError(f"{label}.nonEmptyExplanation applies only to Other")
    if action == "Restore inventory access":
        expected_target, expected_unit = "inventory", "version"
        if target != expected_target or unit != expected_unit:
            raise ValueError(f"{label} restoration must target inventory in version units")
        _canonical_version(recommendation["value"], f"{label}.value")
        return
    if action == "Increase reserved concurrency":
        expected_unit = "executions"
        if target not in RESOURCES - {"gateway"} or unit != expected_unit:
            raise ValueError(f"{label} concurrency recommendation has an invalid target or unit")
        interval = recommendation["value"]
        if not isinstance(interval, Mapping) or set(interval) != {"greaterThan", "atMost"}:
            raise ValueError(f"{label}.value must be an integer interval")
        lower = _integer(interval["greaterThan"], f"{label}.value.greaterThan")
        upper = _integer(interval["atMost"], f"{label}.value.atMost")
        if lower < 0 or upper <= lower:
            raise ValueError(f"{label}.value interval is not increasing")
        return
    # Increase memory
    expected_unit = "MB"
    if target not in RESOURCES - {"gateway"} or unit != expected_unit:
        raise ValueError(f"{label} memory recommendation has an invalid target or unit")
    _integer(recommendation["value"], f"{label}.value", positive=True)


def _validate_case_structure(case: Any) -> dict[str, Any]:
    root = _require_mapping(case, "case")
    _require_keys(root, {"schemaVersion", "caseId", "task", "evidence", "review", "expectations"},
                  {"schemaVersion", "caseId", "task", "evidence", "review", "expectations"}, "case")
    if isinstance(root["schemaVersion"], bool) or root["schemaVersion"] != SCHEMA_VERSION:
        raise ValueError(f"unsupported case schemaVersion: {root['schemaVersion']!r}")
    _nonempty_string(root["caseId"], "case.caseId")

    task = _require_mapping(root["task"], "case.task")
    _require_keys(task, {"alarmArn", "transitionAt", "affectedService", "symptoms", "incidentWindow", "referenceTime", "allowedResources"},
                  {"alarmArn", "transitionAt", "affectedService", "symptoms", "incidentWindow", "referenceTime", "allowedResources"}, "case.task")
    alarm = _nonempty_string(task["alarmArn"], "case.task.alarmArn")
    if not alarm.startswith("arn:aws:cloudwatch:") or ":alarm:" not in alarm:
        raise ValueError("case.task.alarmArn must be a CloudWatch alarm ARN")
    transition = _parse_time(task["transitionAt"], "case.task.transitionAt")
    reference = _parse_time(task["referenceTime"], "case.task.referenceTime")
    if reference < transition:
        raise ValueError("case.task.referenceTime must not precede transitionAt")
    affected = _nonempty_string(task["affectedService"], "case.task.affectedService").lower()
    if affected not in RESOURCES:
        raise ValueError("case.task.affectedService is not an application resource")
    _string_list(task["symptoms"], "case.task.symptoms")
    incident_window = _require_mapping(task["incidentWindow"], "case.task.incidentWindow")
    _require_keys(incident_window, {"start", "end"}, {"start", "end"}, "case.task.incidentWindow")
    window_start = _parse_time(incident_window["start"], "case.task.incidentWindow.start")
    window_end = _parse_time(incident_window["end"], "case.task.incidentWindow.end")
    # A recovery window can follow the originating alarm.
    if not window_start < window_end <= reference:
        raise ValueError("case incidentWindow must end by the referenceTime")
    allowed = _string_list(task["allowedResources"], "case.task.allowedResources")
    if any(item.lower() not in RESOURCES for item in allowed) or affected not in {item.lower() for item in allowed}:
        raise ValueError("case.task.allowedResources is not an application scope")

    evidence = _require_mapping(root["evidence"], "case.evidence")
    evidence_required = {"bundleSha256", "originatingRunId", "references"}
    evidence_allowed = evidence_required | {"acquisitionId", "traceRef"}
    _require_keys(evidence, evidence_required, evidence_allowed, "case.evidence")
    if not isinstance(evidence["bundleSha256"], str) or not CASE_DIGEST_RE.fullmatch(evidence["bundleSha256"]):
        raise ValueError("case.evidence.bundleSha256 must be a lowercase SHA-256 digest")
    _nonempty_string(evidence["originatingRunId"], "case.evidence.originatingRunId")
    if "acquisitionId" in evidence:
        _nonempty_string(evidence["acquisitionId"], "case.evidence.acquisitionId")
        if "traceRef" not in evidence:
            raise ValueError("a separately acquired bundle requires a trace reference to the originating run")
    if "traceRef" in evidence:
        trace = _require_mapping(evidence["traceRef"], "case.evidence.traceRef")
        fields = {"source", "sha256", "traceId", "runId"}
        _require_keys(trace, fields, fields, "case.evidence.traceRef")
        _nonempty_string(trace["source"], "case.evidence.traceRef.source")
        if not isinstance(trace["sha256"], str) or not CASE_DIGEST_RE.fullmatch(trace["sha256"]):
            raise ValueError("case.evidence.traceRef.sha256 must be a lowercase SHA-256 digest")
        _nonempty_string(trace["traceId"], "case.evidence.traceRef.traceId")
        if trace["runId"] != evidence["originatingRunId"]:
            raise ValueError("case.evidence.traceRef.runId must match originatingRunId")
    references = evidence["references"]
    if not isinstance(references, list) or not references:
        raise ValueError("case.evidence.references must be a non-empty list")
    for index, reference_item in enumerate(references):
        label = f"case.evidence.references[{index}]"
        item = _require_mapping(reference_item, label)
        _require_keys(item, {"tool", "resource", "arguments", "required", "reason"},
                      {"tool", "resource", "arguments", "required", "reason"}, label)
        if item["tool"] not in TOOLS:
            raise ValueError(f"{label}.tool is not supported")
        resource = _nonempty_string(item["resource"], f"{label}.resource").lower()
        if resource not in RESOURCES or resource not in {entry.lower() for entry in allowed}:
            raise ValueError(f"{label}.resource is outside the task scope")
        if not isinstance(item["arguments"], Mapping):
            raise ValueError(f"{label}.arguments must be an object")
        _validate_reference_arguments(item["tool"], item["arguments"], label)
        if not isinstance(item["required"], bool):
            raise ValueError(f"{label}.required must be boolean")
        _nonempty_string(item["reason"], f"{label}.reason")
        if item["tool"] != "read_configuration":
            _validate_reference_window(item["arguments"], window_start, reference, label)
    if not any(item["required"] for item in references):
        raise ValueError("case evidence must identify at least one required observation")

    review = _require_mapping(root["review"], "case.review")
    _require_keys(review, {"origin", "reviewedAt", "coverageJustification"}, {"origin", "reviewedAt", "coverageJustification"}, "case.review")
    if review["origin"] not in {"prepared", "session"}:
        raise ValueError("case.review.origin must be prepared or session")
    _parse_time(review["reviewedAt"], "case.review.reviewedAt")
    _nonempty_string(review["coverageJustification"], "case.review.coverageJustification")

    expectations = _require_mapping(root["expectations"], "case.expectations")
    _require_keys(expectations, {"acceptableAssessments", "diagnosis", "admissibleRecommendations", "unacceptableBehavior"},
                  {"acceptableAssessments", "diagnosis", "admissibleRecommendations", "unacceptableBehavior"}, "case.expectations")
    assessments = _string_list(expectations["acceptableAssessments"], "case.expectations.acceptableAssessments")
    if any(item not in ASSESSMENTS for item in assessments):
        raise ValueError("case.expectations.acceptableAssessments contains an unsupported assessment")
    _nonempty_string(expectations["diagnosis"], "case.expectations.diagnosis")
    recommendations = expectations["admissibleRecommendations"]
    if not isinstance(recommendations, list):
        raise ValueError("case.expectations.admissibleRecommendations must be a list")
    for index, recommendation in enumerate(recommendations):
        _validate_recommendation(recommendation, index)
    _string_list(expectations["unacceptableBehavior"], "case.expectations.unacceptableBehavior")
    return dict(root)


def _validate_reference_window(arguments: Mapping[str, Any], window_start: datetime,
                               reference: datetime, label: str) -> None:
    start = _parse_time(arguments.get("start"), f"{label}.arguments.start")
    end = _parse_time(arguments.get("end"), f"{label}.arguments.end")
    if end <= start or start < window_start or end > reference:
        raise ValueError(f"{label}.arguments window is outside the reviewed cutoff")
    if (end - start).total_seconds() > MAX_WINDOW_SECONDS:
        raise ValueError(f"{label}.arguments window cannot exceed 30 minutes")


REFERENCE_ARGUMENTS = {
    "search_logs": {"start", "end", "query", "limit", "filter_pattern", "operation", "error"},
    "read_metrics": {"start", "end", "period_seconds", "limit", "metric"},
    "read_configuration": set(),
    "read_change_history": {"start", "end", "limit"},
}


def _validate_reference_arguments(tool: str, arguments: Mapping[str, Any], label: str) -> None:
    unknown = sorted(set(arguments) - REFERENCE_ARGUMENTS[tool])
    if unknown:
        raise ValueError(f"{label}.arguments has unsupported fields: {', '.join(unknown)}")
    for field in ("query", "filter_pattern", "operation", "error", "metric"):
        if field in arguments and not isinstance(arguments[field], str):
            raise ValueError(f"{label}.arguments.{field} must be a string")
    for field in ("limit", "period_seconds"):
        if field in arguments:
            _integer(arguments[field], f"{label}.arguments.{field}", positive=True)
    if "period_seconds" in arguments and arguments["period_seconds"] not in SUPPORTED_METRIC_PERIODS:
        raise ValueError(f"{label}.arguments.period_seconds is unsupported")


def _coverage_for(item: Mapping[str, Any], result: Mapping[str, Any], reference_time: str) -> dict[str, Any]:
    observations = result.get("observations")
    observation_count = len(observations) if isinstance(observations, list) else 0
    gaps = result.get("gaps", [])
    errors = result.get("errors", [])
    if not isinstance(gaps, list):
        gaps = [str(gaps)]
    if not isinstance(errors, list):
        errors = [str(errors)]
    coverage: dict[str, Any] = {
        "tool": item["tool"],
        "resource": item["resource"],
        "required": bool(item["required"]),
        "referenceTime": reference_time,
        "completeness": result.get("completeness", "unavailable"),
        "gaps": [str(value) for value in gaps],
        "errors": [str(value) for value in errors],
        "observationCount": observation_count,
    }
    return coverage


def _validate_against_bundle(case: dict[str, Any], bundle_path: Path) -> dict[str, Any]:
    evidence = case["evidence"]
    task = case["task"]
    tools = CapturedEvidenceTools.load(
        bundle_path,
        reference_time=task["referenceTime"],
        expected_sha256=evidence["bundleSha256"],
    )
    origin = tools.origin
    if task["alarmArn"] != origin.get("alarmArn"):
        raise ValueError("case alarmArn does not match bundle origin")
    transition = _parse_time(task["transitionAt"], "case.task.transitionAt")
    origin_transition = _parse_time(origin.get("transitionAt"), "bundle.origin.transitionAt")
    if transition != origin_transition:
        raise ValueError("case transitionAt does not match bundle origin")
    bundle_run_id = origin.get("runId")
    case_acquisition = evidence.get("acquisitionId")
    if case_acquisition is None:
        if evidence["originatingRunId"] != bundle_run_id:
            raise ValueError("case originatingRunId does not match bundle origin")
    elif case_acquisition != bundle_run_id:
        raise ValueError("case acquisitionId does not match the bundle acquisition runId")
    elif evidence["originatingRunId"] == bundle_run_id:
        raise ValueError("a separately acquired bundle must keep originatingRunId distinct from acquisitionId")

    reference_time = tools.reference_time
    coverage: list[dict[str, Any]] = []
    incomplete = False
    for item in evidence["references"]:
        try:
            result = getattr(tools, item["tool"])(resource=item["resource"].lower(), **item["arguments"])
        except ValueError as exc:
            message = str(exc)
            # Query errors come from the shared tool. A valid metric or
            # period absent from this particular capture remains an evidence gap.
            if message.startswith(("unsupported CloudWatch filter syntax", "out-of-scope metric:")):
                raise
            if item["required"]:
                incomplete = True
            coverage.append({
                "tool": item["tool"],
                "resource": item["resource"],
                "required": bool(item["required"]),
                "referenceTime": reference_time,
                "completeness": "unavailable",
                "gaps": [str(exc)],
                "errors": [],
                "observationCount": 0,
            })
            continue
        except (TypeError, KeyError) as exc:
            raise ValueError(f"{item['tool']} reference is invalid: {exc}") from exc
        entry = _coverage_for(item, result, reference_time)
        coverage.append(entry)
        if item["required"]:
            # A partial source is usable when the cited observation exists;
            # a required citation with no eligible observation is incomplete.
            if entry["observationCount"] == 0 or entry["completeness"] == "unavailable":
                incomplete = True

    if not case["expectations"]["admissibleRecommendations"]:
        incomplete = True
    result: dict[str, Any] = {
        "status": "incomplete" if incomplete else "ready",
        "caseId": case["caseId"],
        "caseSha256": case_digest(case),
        "bundleSha256": evidence["bundleSha256"],
        "originatingRunId": evidence["originatingRunId"],
        "referenceTime": reference_time,
        "sourceCoverage": coverage,
    }
    return result


def validate_case(case_path: str | Path, bundle_path: str | Path) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Validate a case and return ``(result, parsed_case)``.

    Structural/provenance failures are ``invalid``.  A structurally valid case
    whose required observation is not available by its cutoff, or whose remedy
    is still blank, is ``incomplete``.
    """

    try:
        case = _validate_case_structure(_read_json(Path(case_path), "case"))
        result = _validate_against_bundle(case, Path(bundle_path))
        return result, case
    except (ValueError, OSError, TypeError, KeyError) as exc:
        return {"status": "invalid", "errors": [str(exc)]}, None


def _write_exclusive(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False).encode("utf-8") + b"\n"
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(body)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o600)
        try:
            os.link(temporary, path)
        except FileExistsError as exc:
            raise ValueError(f"output already exists: {path}") from exc
    finally:
        temporary.unlink(missing_ok=True)


def freeze_case(case_path: str | Path, bundle_path: str | Path, output_path: str | Path) -> dict[str, Any]:
    result, case = validate_case(case_path, bundle_path)
    if result.get("status") != "ready" or case is None:
        raise ValueError(f"case is {result.get('status', 'invalid')}; it cannot be frozen")
    envelope = {"caseSha256": result["caseSha256"], "case": case}
    _write_exclusive(Path(output_path), envelope)
    return envelope


def load_frozen_case(case_path: str | Path, bundle_path: str | Path) -> dict[str, Any]:
    """Load and authenticate a frozen case and its exact captured bundle.

    This is the shared input boundary for candidate execution and offline
    evaluation.  The returned mapping contains the private, validated case so
    an evaluator can use its expectations, while ``task`` remains the exact
    public projection emitted by :func:`candidate_input`.
    """

    envelope = _read_json(Path(case_path), "frozen case")
    if not isinstance(envelope, Mapping) or set(envelope) != {"caseSha256", "case"}:
        raise ValueError("frozen case must contain exactly caseSha256 and case")
    case = _validate_case_structure(envelope["case"])
    envelope_digest = envelope["caseSha256"]
    if not isinstance(envelope_digest, str) or not CASE_DIGEST_RE.fullmatch(envelope_digest):
        raise ValueError("frozen caseSha256 is not a SHA-256 digest")
    if case_digest(case) != envelope_digest:
        raise ValueError("frozen caseSha256 does not match case content")
    result = _validate_against_bundle(case, Path(bundle_path))
    if result.get("caseSha256") != envelope_digest or result.get("status") != "ready":
        raise ValueError("frozen case is not ready for candidate input")
    return {
        "case": case,
        "task": dict(case["task"]),
        "caseSha256": envelope_digest,
        "bundleSha256": result["bundleSha256"],
        "referenceTime": result["referenceTime"],
        "originatingRunId": result["originatingRunId"],
    }


def candidate_input(case_path: str | Path, bundle_path: str | Path) -> dict[str, Any]:
    loaded = load_frozen_case(case_path, bundle_path)
    # Keep this projection intentionally exact: no case identity, evidence
    # references, review notes or private expectations cross the candidate
    # boundary.
    return loaded["task"]


def _build_cli() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="reviewed_cases", description="Validate and freeze offline reviewed incident cases")
    subparsers = parser.add_subparsers(dest="command", required=True)
    validate = subparsers.add_parser("validate", help="validate a draft against a captured bundle")
    validate.add_argument("--case", required=True, type=Path)
    validate.add_argument("--bundle", required=True, type=Path)
    freeze = subparsers.add_parser("freeze", help="write one immutable reviewed-case envelope")
    freeze.add_argument("--case", required=True, type=Path)
    freeze.add_argument("--bundle", required=True, type=Path)
    freeze.add_argument("--output", required=True, type=Path)
    candidate = subparsers.add_parser("candidate-input", help="emit only the public task from a frozen case")
    candidate.add_argument("--case", required=True, type=Path)
    candidate.add_argument("--bundle", required=True, type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_cli().parse_args(argv)
    if args.command == "validate":
        result, _case = validate_case(args.case, args.bundle)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))
        return 0 if result.get("status") == "ready" else 2
    try:
        if args.command == "freeze":
            envelope = freeze_case(args.case, args.bundle, args.output)
            print(json.dumps({"status": "frozen", "caseSha256": envelope["caseSha256"], "output": str(args.output)},
                             ensure_ascii=False, sort_keys=True))
            return 0
        task = candidate_input(args.case, args.bundle)
        print(json.dumps(task, ensure_ascii=False, sort_keys=True, indent=2))
        return 0
    except (ValueError, OSError, TypeError, KeyError) as exc:
        print(json.dumps({"status": "invalid", "errors": [str(exc)]}, ensure_ascii=False, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
