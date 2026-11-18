"""Pure policy and approval checks for the repaired-agent release gate.

The release workflow deliberately keeps this module free of AWS and GitHub
clients.  The evaluation job supplies authenticated, already-read experiment
rows and the publisher supplies the authenticated review history reader.  This
keeps the decision deterministic and makes it possible to replay the gate
against a private copy of the exact inputs without acquiring publishing
credentials.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable, Iterable, Mapping, Sequence
from typing import Any


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
MANIFEST_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def canonical_bytes(value: Any) -> bytes:
    """Return the canonical bytes used for private release identities."""

    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_json(value: Any) -> str:
    return sha256_bytes(canonical_bytes(value))


def _incomplete(reason: str) -> dict[str, str]:
    return {"verdict": "incomplete", "reason": reason}


def _reject(reason: str) -> dict[str, str]:
    return {"verdict": "reject", "reason": reason}


def _expected_roster(expected_cases: Iterable[Sequence[str]]) -> tuple[dict[str, tuple[str, str]], str | None]:
    roster: dict[str, tuple[str, str]] = {}
    try:
        entries = list(expected_cases)
    except (TypeError, ValueError):
        return {}, "the expected case roster is not iterable"
    if not entries:
        return {}, "the expected case roster is empty"
    for entry in entries:
        if not isinstance(entry, (tuple, list)) or len(entry) != 3:
            return {}, "the expected case roster has malformed identity"
        case_id, case_sha, bundle_sha = entry
        if not all(isinstance(value, str) and value.strip() for value in (case_id, case_sha, bundle_sha)):
            return {}, "the expected case roster has an empty identity"
        if case_id in roster:
            return {}, f"the expected case roster contains duplicate case {case_id}"
        roster[case_id] = (case_sha, bundle_sha)
    return roster, None


def _row_identity(row: Mapping[str, Any]) -> tuple[str, str, str] | None:
    values = (row.get("caseId"), row.get("caseSha256"), row.get("bundleSha256"))
    if not all(isinstance(value, str) and value.strip() for value in values):
        return None
    return values  # type: ignore[return-value]


def _deterministic_finding(finding: Any, name: str) -> tuple[str, str | None]:
    if not isinstance(finding, Mapping):
        return "incomplete", f"deterministic finding is missing or malformed: {name}"
    status = finding.get("status")
    verdict = finding.get("verdict")
    reason = finding.get("reason")
    if status == "complete" and verdict == "fail":
        return "reject", f"deterministic check failed: {name}"
    if status != "complete" or verdict != "pass":
        return "incomplete", f"deterministic check is incomplete: {name}"
    if not isinstance(reason, str) or not reason.strip():
        return "incomplete", f"deterministic finding reason is missing: {name}"
    return "pass", None


def _advisory_complete(row: Mapping[str, Any]) -> tuple[bool, str | None]:
    score = row.get("score")
    if not isinstance(score, Mapping) or score.get("status") != "complete":
        return False, "required advisory score is incomplete"
    semantic = score.get("semantic")
    if not isinstance(semantic, Mapping):
        return False, "required advisory semantic result is missing"
    findings = semantic.get("findings")
    if not isinstance(findings, Mapping):
        return False, "required advisory finding is missing"
    quality = findings.get("semantic_quality")
    if not isinstance(quality, Mapping):
        return False, "required advisory semantic_quality result is missing"
    if quality.get("status") != "complete" or quality.get("verdict") not in {"pass", "fail"}:
        return False, "required advisory semantic result is incomplete"
    # The reason is part of the human-review evidence.  A numeric score or a
    # native SDK placeholder is not enough to authorize review.
    explanation = quality.get("explanation")
    if not isinstance(explanation, str) or not explanation.strip():
        return False, "required advisory reason is missing"
    return True, None


def _execution_binding_complete(row: Mapping[str, Any]) -> tuple[bool, str | None]:
    """Require the selected report, execution, trace and score to agree."""

    ids = {key: row.get(key) for key in ("executionId", "sessionId", "traceId")}
    if any(not isinstance(value, str) or not value.strip() for value in ids.values()):
        return False, "selected execution/session/trace identity is incomplete"
    report = row.get("report")
    if not isinstance(report, Mapping):
        return False, "selected report is missing"
    score = row.get("score")
    if not isinstance(score, Mapping):
        return False, "selected advisory score is missing"
    if score.get("executionId") not in (None, ids["executionId"]):
        return False, "selected score execution identity differs"
    selected_attempt = row.get("scoringAttemptId")
    score_attempt = score.get("scoringAttemptId")
    if not isinstance(selected_attempt, str) or not selected_attempt.strip() or score_attempt not in (None, selected_attempt):
        return False, "selected scoring attempt identity differs"
    deterministic = row.get("deterministic")
    if isinstance(deterministic, Mapping):
        deterministic_identity = deterministic.get("identity")
        if isinstance(deterministic_identity, Mapping):
            for key in ("executionId", "sessionId", "traceId"):
                if deterministic_identity.get(key) not in (None, ids[key]):
                    return False, f"deterministic {key} identity differs"
            expected_report = deterministic_identity.get("reportSha256")
            if isinstance(expected_report, str) and expected_report != sha256_json(report):
                return False, "selected report digest differs"
    return True, None


def machine_decision(
    *,
    expected_cases: Iterable[Sequence[str]],
    rows: Sequence[Mapping[str, Any]],
) -> dict[str, str]:
    """Classify an authenticated experiment matrix.

    ``reject`` has precedence over incompleteness: an observed deterministic
    failure is a known quality failure and must stop the release without
    waiting for remaining evaluators.  No other status authorizes publication.
    """

    roster, roster_error = _expected_roster(expected_cases)
    if roster_error:
        return _incomplete(roster_error)
    if not isinstance(rows, Sequence) or isinstance(rows, (str, bytes, bytearray)):
        return _incomplete("experiment case rows are not a sequence")

    # A known deterministic quality failure is terminal even when another
    # case is still pending or its identity cannot be rendered yet.  This is
    # what lets the workflow stop a bad release without waiting for the full
    # advisory matrix.
    for row in rows:
        if not isinstance(row, Mapping):
            continue
        deterministic = row.get("deterministic")
        findings = deterministic.get("findings") if isinstance(deterministic, Mapping) else None
        if not isinstance(findings, Mapping):
            continue
        for name in FINDINGS:
            verdict, reason = _deterministic_finding(findings.get(name), name)
            if verdict == "reject":
                case_id = row.get("caseId", "unknown")
                return _reject(f"{case_id}: {reason}")

    observed: dict[str, Mapping[str, Any]] = {}
    for row in rows:
        if not isinstance(row, Mapping):
            return _incomplete("experiment case row is malformed")
        identity = _row_identity(row)
        if identity is None:
            return _incomplete("experiment case identity is malformed")
        case_id, case_sha, bundle_sha = identity
        if case_id not in roster:
            return _incomplete(f"experiment contains an unexpected case: {case_id}")
        if case_id in observed:
            return _incomplete(f"experiment contains duplicate case: {case_id}")
        if roster[case_id] != (case_sha, bundle_sha):
            return _incomplete(f"experiment case identity differs: {case_id}")
        observed[case_id] = row
    if set(observed) != set(roster):
        missing = sorted(set(roster) - set(observed))
        return _incomplete(f"experiment case roster is incomplete: {missing}")

    for case_id, row in observed.items():
        deterministic = row.get("deterministic")
        findings = deterministic.get("findings") if isinstance(deterministic, Mapping) else None
        if not isinstance(findings, Mapping) or set(findings) != set(FINDINGS):
            return _incomplete(f"{case_id}: deterministic finding matrix is incomplete")
        for name in FINDINGS:
            verdict, reason = _deterministic_finding(findings.get(name), name)
            if verdict != "pass":
                return _incomplete(f"{case_id}: {reason}")
        bound, reason = _execution_binding_complete(row)
        if not bound:
            return _incomplete(f"{case_id}: {reason}")
        if row.get("status") != "complete":
            return _incomplete(f"{case_id}: required execution is incomplete")
        complete, reason = _advisory_complete(row)
        if not complete:
            return _incomplete(f"{case_id}: {reason}")

    return {
        "verdict": "review_required",
        "reason": "deterministic checks and advisory results are complete; human review remains required",
    }


def _approval_manifest(comment: Any) -> str | None:
    """Extract an exact manifest digest from a review comment.

    Comments are intentionally parsed conservatively.  A standalone
    64-character lowercase digest, or the workflow's ``approve <digest>``
    form, is accepted; arbitrary prose containing a digest is not.
    """

    if not isinstance(comment, str):
        return None
    stripped = comment.strip()
    match = re.fullmatch(r"(?:approve\s+)?([0-9a-f]{64})", stripped)
    return match.group(1) if match else None


def has_matching_approval(
    *,
    read_history: Callable[[int], Iterable[Mapping[str, Any]]],
    run_id: int,
    environment_id: int,
    reviewer_id: int,
    manifest_sha256: str,
) -> bool:
    """Return whether GitHub review history contains the exact approval.

    The caller supplies a reader bound to GitHub's authenticated review-history
    API.  The function checks the current run, protected environment, required
    reviewer, approved state, and exact manifest digest.  Missing or malformed
    history fails closed.
    """

    if type(run_id) is not int or type(environment_id) is not int or type(reviewer_id) is not int:
        return False
    if not MANIFEST_SHA256_RE.fullmatch(manifest_sha256):
        return False
    try:
        history = read_history(run_id)
    except Exception:
        return False
    if isinstance(history, Mapping):
        # The GitHub REST client returns a list for this endpoint, while a
        # thin authenticated adapter may retain the response envelope.
        history = history.get("reviews", history.get("environmentReviews"))
    if isinstance(history, (str, bytes, bytearray)):
        return False
    try:
        entries = list(history)
    except (TypeError, ValueError):
        return False
    for entry in entries:
        if not isinstance(entry, Mapping) or entry.get("state") != "approved":
            continue
        user = entry.get("user")
        if not isinstance(user, Mapping) or user.get("id") != reviewer_id:
            continue
        environments = entry.get("environments")
        if not isinstance(environments, Sequence) or isinstance(environments, (str, bytes, bytearray)):
            continue
        if not any(
            isinstance(environment, Mapping)
            and environment.get("id") == environment_id
            and environment.get("name") == "repaired-publication"
            for environment in environments
        ):
            continue
        if _approval_manifest(entry.get("comment")) == manifest_sha256:
            return True
    return False


__all__ = [
    "FINDINGS",
    "canonical_bytes",
    "sha256_bytes",
    "sha256_json",
    "machine_decision",
    "has_matching_approval",
]
