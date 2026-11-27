#!/usr/bin/env python3
"""Bridge one native AgentCore scenario into the normal reviewed-case runner.

The bridge has one job: bind the public native turn to the exact trace/session
and to the bounded evidence captured for that same run.  It reuses the normal
case and bundle validators; it never turns a native prose answer or a prior
fixture report into action expectations.  The typed native recommendation is
normalized into evaluator-only expectations in ``case.frozen.json``.

Examples::

    python scripts/native_case_bridge.py build \
      --scenario denial-case.json --trace original-trace.json \
      --run-record original-run.json --profile my-profile --output bridge

When the two source objects have already been downloaded, pass
``--baseline`` and ``--query-results`` instead of ``--run-record``.  A
verified bundle can be supplied directly with ``--bundle``.  The scenario's
typed ``metadata.expected_recommendation`` is the canonical reviewed action.
"""

from __future__ import annotations

import argparse
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from typing import Any, Mapping, Sequence


def _repository_root() -> Path:
    """Find the maintained checkout when this script is invoked by a kit."""

    candidates = [Path(__file__).resolve().parents[1], Path.cwd()]
    configured = os.environ.get("EVALUATIONS_REPO")
    if configured:
        candidates.append(Path(configured).expanduser())
    for candidate in candidates:
        if (candidate / "agent" / "captured_evidence.py").is_file():
            return candidate
    raise RuntimeError(
        "cannot locate the maintained evaluations checkout; run "
        "scripts/native_case_bridge.py from the repository or set EVALUATIONS_REPO"
    )


ROOT = _repository_root()
sys.path.insert(0, str(ROOT / "agent"))

from captured_evidence import write_bundle  # noqa: E402
from reviewed_cases import candidate_input, freeze_case, validate_case  # noqa: E402


SOURCES = ("logs", "metrics", "configuration", "changeHistory")
RESOURCES = ("gateway", "checkout", "inventory")
TOOLS = {"logs": "search_logs", "metrics": "read_metrics", "configuration": "read_configuration", "changeHistory": "read_change_history"}
DENIAL_MARKERS = ("accessdenied", "access_denied", "permissiondenied", "permission_denied", "explicitdeny", "explicit_deny")
BRIDGE_ARTIFACTS = (
    "captured-bundle.json",
    "case.json",
    "case.frozen.json",
    "suite.json",
    "candidate-input.json",
    "native-handoff.json",
    "bridge-manifest.json",
)


class BridgeError(ValueError):
    """A provenance, shape, or bounded-source error."""


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _read(path: Path, label: str) -> Any:
    try:
        return json.loads(path.read_bytes().decode("utf-8"), parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
        raise BridgeError(f"{label} is not valid UTF-8 JSON: {path}") from exc


def _obj(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise BridgeError(f"{label} must be an object")
    return dict(value)


def _str(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise BridgeError(f"{label} must be a non-empty string")
    return value.strip()


def _time(value: Any, label: str) -> datetime:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        numeric = float(value)
        if abs(numeric) > 10_000_000_000:
            numeric /= 1000
        try:
            return datetime.fromtimestamp(numeric, timezone.utc)
        except (OverflowError, OSError, ValueError) as exc:
            raise BridgeError(f"{label} is not a timestamp") from exc
    if not isinstance(value, str) or not value.strip():
        raise BridgeError(f"{label} is not a timezone-qualified timestamp")
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise BridgeError(f"{label} is not a timezone-qualified timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise BridgeError(f"{label} must include a timezone")
    return parsed.astimezone(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _hash_file(path: Path) -> str:
    try:
        return _sha(path.read_bytes())
    except OSError as exc:
        raise BridgeError(f"cannot read {path}") from exc


def _scenario(scenario: Mapping[str, Any]) -> tuple[str, str, str, str, str, str]:
    scenario_id = _str(scenario.get("scenario_id"), "scenario.scenario_id")
    metadata = _obj(scenario.get("metadata"), "scenario.metadata")
    generation = _str(metadata.get("generation_id"), "scenario.metadata.generation_id")
    source = _obj(metadata.get("source"), "scenario.metadata.source")
    trace_id = _str(source.get("trace_id"), "scenario.metadata.source.trace_id")
    session_id = _str(source.get("session_id"), "scenario.metadata.source.session_id")
    turns = scenario.get("turns")
    if not isinstance(turns, list) or len(turns) != 1 or not isinstance(turns[0], Mapping):
        raise BridgeError("scenario must contain exactly one turn")
    prompt = turns[0].get("input")
    expected = turns[0].get("expected_response")
    if not isinstance(prompt, str) or not prompt.strip():
        raise BridgeError("scenario.turns[0].input must be a non-empty string")
    if not isinstance(expected, str) or not expected.strip():
        raise BridgeError("scenario.turns[0].expected_response must be a non-empty string")
    # The native answer is retained only in the authenticated handoff below;
    # it is never projected into the candidate task or inferred into case
    # expectations.
    return scenario_id, generation, trace_id, session_id, prompt, expected


def _trace(path: Path, expected_trace: str, expected_session: str) -> dict[str, Any]:
    value = _read(path, "original trace")
    spans = value.get("spans") if isinstance(value, Mapping) else value
    if not isinstance(spans, list) or not spans:
        raise BridgeError("original trace must contain a non-empty span list")
    trace_ids: set[str] = set()
    all_trace_ids: set[str] = set()
    sessions: set[str] = set()
    run_ids: set[str] = set()
    alarms: set[str] = set()
    transitions: set[str] = set()
    matching = 0
    for span in spans:
        if not isinstance(span, Mapping):
            continue
        trace_id = span.get("traceId")
        if isinstance(trace_id, str):
            all_trace_ids.add(trace_id)
        if trace_id != expected_trace:
            continue
        matching += 1
        attrs = span.get("attributes")
        attrs = attrs.get("attributes") if isinstance(attrs, Mapping) and isinstance(attrs.get("attributes"), Mapping) else attrs
        if not isinstance(attrs, Mapping):
            continue
        if isinstance(attrs.get("session.id"), str):
            sessions.add(attrs["session.id"])
        if isinstance(attrs.get("incident.run_id"), str):
            run_ids.add(attrs["incident.run_id"])
        if isinstance(attrs.get("incident.alarm_arn"), str):
            alarms.add(attrs["incident.alarm_arn"])
        if isinstance(attrs.get("incident.transition_at"), str):
            transitions.add(_iso(_time(attrs["incident.transition_at"], "incident.transition_at")))
        trace_ids.add(trace_id)
    if matching == 0:
        raise BridgeError("original trace has no span for the scenario trace ID")
    if sessions and sessions != {expected_session}:
        raise BridgeError("original trace session identity differs from the scenario")
    if len(trace_ids) != 1 or next(iter(trace_ids)) != expected_trace or all_trace_ids != {expected_trace}:
        raise BridgeError("original trace contains a foreign trace ID")
    return {
        "spanCount": len(spans),
        "matchingSpanCount": matching,
        "sha256": _hash_file(path),
        "sessionId": expected_session,
        "runIds": sorted(run_ids),
        "alarms": sorted(alarms),
        "transitions": sorted(transitions),
    }


def _run_record(value: Mapping[str, Any], trace_meta: Mapping[str, Any]) -> dict[str, Any]:
    run = value.get("run") if isinstance(value.get("run"), Mapping) else value
    run_id = _str(run.get("runId"), "run.runId")
    capture = run.get("captureRef")
    if not isinstance(capture, Mapping):
        capture = value.get("captureRef") if isinstance(value.get("captureRef"), Mapping) else None
    if not isinstance(capture, Mapping):
        raise BridgeError("run record has no captureRef")
    bucket = _str(capture.get("bucket"), "captureRef.bucket")
    baseline_key = _str(capture.get("baselineKey") or capture.get("manifestKey"), "captureRef.baselineKey")
    query_key = _str(capture.get("queryResultsKey"), "captureRef.queryResultsKey")
    alarm = _str(run.get("alarmArn"), "run.alarmArn")
    parts = alarm.split(":")
    if len(parts) < 6 or parts[0:3] != ["arn", "aws", "cloudwatch"]:
        raise BridgeError("run alarm ARN is malformed")
    if trace_meta.get("runIds") and trace_meta["runIds"] != [run_id]:
        raise BridgeError("run record and original trace disagree on run ID")
    if run.get("runtimeSessionId") != trace_meta.get("sessionId"):
        raise BridgeError("run record and original trace disagree on session ID")
    if run.get("pk") != alarm:
        raise BridgeError("run record partition key differs from the selected alarm")
    if run.get("sk") is not None and _iso(_time(run["sk"], "run.sk")) != trace_meta.get("transitions", [None])[0]:
        raise BridgeError("run record sort key differs from the selected transition")
    return {"runId": run_id, "bucket": bucket, "baselineKey": baseline_key, "queryResultsKey": query_key, "accountId": parts[4], "region": parts[3]}


def _fetch_run_record(
    *,
    trace_meta: Mapping[str, Any],
    table_name: str,
    profile: str | None,
    region: str,
) -> dict[str, Any]:
    """Read exactly one retained run by the trace's alarm and transition."""

    alarms = trace_meta.get("alarms")
    transitions = trace_meta.get("transitions")
    if not isinstance(alarms, list) or len(alarms) != 1 or not isinstance(transitions, list) or len(transitions) != 1:
        raise BridgeError("original trace does not identify one alarm transition")
    try:
        import boto3
    except ImportError as exc:
        raise BridgeError("boto3 is required to read the originating run") from exc
    session = boto3.Session(profile_name=profile, region_name=region)
    alarm = alarms[0]
    account = alarm.split(":")[4] if isinstance(alarm, str) and len(alarm.split(":")) > 4 else None
    try:
        identity = session.client("sts").get_caller_identity()
    except Exception as exc:
        raise BridgeError(f"read-only AWS identity check failed: {type(exc).__name__}") from exc
    if account and identity.get("Account") != account:
        raise BridgeError("AWS credentials resolve to a different account than the selected alarm")
    try:
        response = session.resource("dynamodb").Table(table_name).get_item(
            Key={"pk": alarm, "sk": transitions[0]}, ConsistentRead=True
        )
    except Exception as exc:
        raise BridgeError(f"read-only RunTable lookup failed: {type(exc).__name__}") from exc
    item = response.get("Item") if isinstance(response, Mapping) else None
    if not isinstance(item, Mapping):
        raise BridgeError("RunTable has no retained run for the selected alarm transition")
    return dict(item)


def _download_sources(run: Mapping[str, Any], profile: str | None, region: str | None) -> tuple[dict[str, Any], dict[str, Any]]:
    try:
        import boto3
    except ImportError as exc:
        raise BridgeError("boto3 is required to download the selected capture") from exc
    session = boto3.Session(profile_name=profile, region_name=region)
    client = session.client("s3")
    def get(key: str, label: str) -> dict[str, Any]:
        try:
            body = client.get_object(Bucket=run["bucket"], Key=key, ExpectedBucketOwner=run["accountId"])["Body"].read()
        except Exception as exc:
            raise BridgeError(f"read-only S3 download failed for {label}: {type(exc).__name__}") from exc
        value = json.loads(body.decode("utf-8"))
        if not isinstance(value, Mapping):
            raise BridgeError(f"downloaded {label} is not an object")
        return dict(value)
    return get(run["baselineKey"], "baseline"), get(run["queryResultsKey"], "query results")


def _source_rows(baseline: Mapping[str, Any], query: Mapping[str, Any]) -> dict[str, list[dict[str, Any]]]:
    rows: dict[str, list[dict[str, Any]]] = {name: [] for name in SOURCES}
    observations = baseline.get("observations")
    if isinstance(observations, Mapping):
        for name in SOURCES:
            if isinstance(observations.get(name), Mapping):
                rows[name].append(dict(observations[name]))
    for entry in query.get("results", []) if isinstance(query.get("results"), list) else []:
        if not isinstance(entry, Mapping) or not isinstance(entry.get("result"), Mapping):
            continue
        name = next((name for name, tool in TOOLS.items() if tool == entry.get("tool")), None)
        if name:
            rows[name].append(dict(entry["result"]))
    return rows


def _scope(rows: Sequence[Mapping[str, Any]]) -> list[str]:
    values = {str(value).lower() for row in rows for value in row.get("scope", []) if isinstance(row.get("scope"), list)}
    return [resource for resource in RESOURCES if resource in values]


def _window(rows: Sequence[Mapping[str, Any]], label: str) -> dict[str, str]:
    values = [row.get("window") for row in rows if isinstance(row.get("window"), Mapping)]
    if not values:
        raise BridgeError(f"{label} has no source window")
    starts = [_time(value.get("start"), f"{label}.window.start") for value in values]
    ends = [_time(value.get("end"), f"{label}.window.end") for value in values]
    return {"start": _iso(min(starts)), "end": _iso(max(ends))}


def _merge_sources(baseline: Mapping[str, Any], query: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    rows = _source_rows(baseline, query)
    merged: dict[str, dict[str, Any]] = {}
    for name, values in rows.items():
        if not values:
            raise BridgeError(f"capture has no {name} source")
        source = copy.deepcopy(dict(values[-1]))
        source["scope"] = _scope(values)
        source["window"] = _window(values, name)
        source["completeness"] = "partial" if any(row.get("completeness") != "complete" for row in values) else "complete"
        source["truncated"] = any(bool(row.get("truncated")) for row in values)
        source["errors"] = list(dict.fromkeys(str(item) for row in values for item in row.get("errors", []) if isinstance(row.get("errors"), list)))
        source["gaps"] = list(dict.fromkeys(str(item) for row in values for item in row.get("gaps", []) if isinstance(row.get("gaps"), list)))
        times = [_time(row["observedAt"], f"{name}.observedAt") for row in values if isinstance(row.get("observedAt"), str)]
        if times:
            source["observedAt"] = _iso(max(times))
        observations: list[dict[str, Any]] = []
        seen: set[str] = set()
        for row in values:
            for item in row.get("observations", []) if isinstance(row.get("observations"), list) else []:
                if not isinstance(item, Mapping):
                    continue
                digest = _sha(_json_bytes(item))
                if digest not in seen:
                    seen.add(digest)
                    observations.append(dict(item))
        source["observations"] = observations
        if name == "logs":
            observations.sort(
                key=lambda item: (
                    _time(item.get("timestamp"), "log timestamp")
                    if item.get("timestamp") is not None
                    else datetime.min.replace(tzinfo=timezone.utc),
                    str(item.get("eventId", "")),
                )
            )
            source["observations"] = observations
            source["captureWindows"] = [
                {"query": row.get("query", {}), "window": row.get("window"), "observedAt": row.get("observedAt")}
                for row in values if isinstance(row.get("window"), Mapping)
            ]
        merged[name] = source
    times = [_time(source["observedAt"], "source observedAt") for source in merged.values() if isinstance(source.get("observedAt"), str)]
    reference = _iso(max(times))
    alarm = _str(query.get("alarmArn") or baseline.get("alarmArn"), "capture.alarmArn")
    transition = _iso(_time(query.get("transitionAt") or baseline.get("transitionAt"), "capture.transitionAt"))
    run_ids = {_str(value, "capture.runId") for value in (query.get("runId"), baseline.get("runId")) if value is not None}
    if len(run_ids) != 1:
        raise BridgeError("baseline and query results disagree on run ID")
    account, region = alarm.split(":")[4], alarm.split(":")[3]
    origin = {
        "alarmArn": alarm,
        "transitionAt": transition,
        "runId": next(iter(run_ids)),
        "accountId": account,
        "region": region,
        "capturedAt": query.get("capturedAt") or baseline.get("capturedAt"),
        "referenceTime": reference,
    }
    return origin, merged


def _resource(source: Mapping[str, Any], explicit: str | None) -> str:
    if explicit is None:
        raise BridgeError("affected service must be supplied by the reviewed expectation binding")
    if explicit not in RESOURCES:
        raise BridgeError("reviewed affected service is unsupported")
    scope = {str(item).lower() for item in source.get("scope", []) if isinstance(source.get("scope"), list)}
    if explicit not in scope:
        raise BridgeError("reviewed affected service is outside the captured source scope")
    for item in source.get("observations", []) if isinstance(source.get("observations"), list) else []:
        if not isinstance(item, Mapping) or str(item.get("resource", "")).lower() != explicit:
            continue
        values = item.get("fields") if isinstance(item.get("fields"), Mapping) else {}
        text = " ".join(str(value) for value in values.values()).lower()
        if any(marker in text for marker in DENIAL_MARKERS):
            return explicit
    raise BridgeError("reviewed affected service has no retained denial evidence")


def _recommendation_identity(value: Any, label: str) -> tuple[Any, ...]:
    """Normalize one typed native recommendation for exact verification."""

    recommendation = _obj(value, label)
    action = recommendation.get("action")
    target = recommendation.get("target")
    unit = recommendation.get("unit")
    if not isinstance(action, str) or not action.strip():
        raise BridgeError(f"{label}.action must be a non-empty string")
    if action == "Other":
        if target is not None or unit is not None:
            raise BridgeError(f"{label} Other recommendation must have null target and unit")
        # Native metadata describes the action; reviewed expectations add the
        # separate non-empty explanation requirement for candidate reports.
        return action, None, None, "non-empty-explanation"
    if "value" not in recommendation:
        raise BridgeError(f"{label}.value is required for a typed action")
    return action, target, recommendation["value"], unit


def _verify_native_recommendation(scenario: Mapping[str, Any], expectations: Mapping[str, Any]) -> None:
    """Reject reviewed expectations that disagree with native typed metadata."""

    metadata = scenario.get("metadata")
    if not isinstance(metadata, Mapping) or "expected_recommendation" not in metadata:
        return
    native = _recommendation_identity(
        metadata["expected_recommendation"],
        "scenario.metadata.expected_recommendation",
    )
    recommendations = expectations.get("admissibleRecommendations")
    if not isinstance(recommendations, list) or len(recommendations) != 1:
        raise BridgeError(
            "structured expectations must contain exactly one recommendation "
            "when native expected_recommendation metadata is present"
        )
    reviewed = _recommendation_identity(
        recommendations[0],
        "expectations.admissibleRecommendations[0]",
    )
    if reviewed != native:
        raise BridgeError(
            "structured recommendation does not match "
            "scenario.metadata.expected_recommendation"
        )


def _scenario_resource(
    scenario: Mapping[str, Any], recommendation: Mapping[str, Any], explicit: str | None
) -> str:
    metadata = scenario.get("metadata")
    metadata_resource = None
    if isinstance(metadata, Mapping):
        for key in ("affected_service", "affectedService"):
            if metadata.get(key) is not None:
                metadata_resource = metadata.get(key)
                break
    candidates = [value for value in (explicit, metadata_resource) if value is not None]
    if candidates:
        resource = candidates[0]
        if not isinstance(resource, str) or resource not in RESOURCES:
            raise BridgeError("reviewed affected service is unsupported")
        if any(value != resource for value in candidates[1:]):
            raise BridgeError("affected service disagrees with native scenario metadata")
    else:
        target = recommendation.get("target")
        # Recovered Other has no target. This bridge's reviewed lesson is
        # Inventory; future cases must carry affected_service metadata or pass
        # --affected-service explicitly.
        resource = target if target in RESOURCES else "inventory"
    return resource


def _native_expectation_document(
    scenario: Mapping[str, Any], *, affected_service: str | None = None
) -> tuple[dict[str, Any], str, str]:
    """Derive normal reviewed expectations from typed native metadata."""

    scenario_id, _generation, trace_id, session_id, _prompt, expected_response = _scenario(scenario)
    metadata = _obj(scenario.get("metadata"), "scenario.metadata")
    if "expected_recommendation" not in metadata:
        raise BridgeError(
            "scenario.metadata.expected_recommendation is required for the "
            "normal reviewed-case bridge"
        )
    native = _obj(
        metadata["expected_recommendation"],
        "scenario.metadata.expected_recommendation",
    )
    action = native.get("action")
    resource = _scenario_resource(scenario, native, affected_service)
    if action == "Restore inventory access":
        if resource != "inventory":
            raise BridgeError("Restore inventory access must bind the Inventory service")
        recommendation = {
            "action": action,
            "target": "inventory",
            "value": native.get("value"),
            "unit": native.get("unit"),
        }
        assessment = "ongoing"
        unacceptable = [
            "Claim the selected incident is recovered while the reviewed state is ongoing.",
            "Choose a non-access remediation while the reviewed access denial remains.",
        ]
    elif action == "Other":
        recommendation = {
            "action": "Other",
            "target": None,
            "value": {"nonEmptyExplanation": True},
            "unit": None,
        }
        assessment = "recovered"
        unacceptable = [
            "Repeat access restoration after the reviewed incident is recovered.",
            "Represent the selected recovered state as ongoing without new evidence.",
        ]
    else:
        raise BridgeError(
            "scenario.metadata.expected_recommendation.action is unsupported by "
            "the reviewed bridge schema"
        )
    document = {
        "binding": {
            "scenarioId": scenario_id,
            "traceId": trace_id,
            "sessionId": session_id,
            "affectedService": resource,
            "expectedResponseSha256": _sha(expected_response.encode()),
        },
        "review": {
            "origin": "session",
            "coverageJustification": (
                "The structured recommendation came from native case metadata; "
                "native expected_response is retained only for digest binding."
            ),
        },
        "expectations": {
            "acceptableAssessments": [assessment],
            "diagnosis": expected_response,
            "admissibleRecommendations": [recommendation],
            "unacceptableBehavior": unacceptable,
        },
    }
    _verify_native_recommendation(scenario, document["expectations"])
    return document, resource, expected_response


def _references(sources: Mapping[str, Any], resource: str, reference: datetime) -> list[dict[str, Any]]:
    logs = sources["logs"]
    rows = [
        item
        for item in logs.get("observations", [])
        if isinstance(item, Mapping)
        and str(item.get("resource", "")).lower() == resource
        and any(
            marker in " ".join(str(v) for v in (item.get("fields") or {}).values()).lower()
            for marker in DENIAL_MARKERS
        )
    ]
    if not rows:
        raise BridgeError("selected service has no retained denial row")
    rows.sort(key=lambda item: _time(item.get("timestamp"), "denial timestamp"), reverse=True)
    fields = rows[0].get("fields")
    request_id = fields.get("requestId") if isinstance(fields, Mapping) else None
    if not isinstance(request_id, str) or not request_id:
        raise BridgeError("selected denial row has no request identity")
    windows = logs.get("captureWindows") if isinstance(logs.get("captureWindows"), list) else []
    filtered = [entry for entry in windows if isinstance(entry, Mapping) and isinstance(entry.get("query"), Mapping) and entry.get("query")]
    if filtered:
        selected = min(filtered, key=lambda entry: _time(entry["window"]["end"], "log query end") - _time(entry["window"]["start"], "log query start"))
        start = _time(selected["window"]["start"], "log query start")
        end = min(_time(selected["window"]["end"], "log query end"), reference)
    else:
        start = _time(logs["window"]["start"], "logs.window.start")
        end = min(_time(logs["window"]["end"], "logs.window.end"), reference)
    refs = [
        {
            "tool": "search_logs",
            "resource": resource,
            "arguments": {
                "start": _iso(start),
                "end": _iso(end),
                "query": request_id,
                "limit": 100,
            },
            "required": True,
            "reason": "Correlate the latest retained denial request selected from the capture.",
        }
    ]
    paired = next(
        (
            item
            for item in logs.get("observations", [])
            if isinstance(item, Mapping)
            and item.get("resource") != resource
            and isinstance(item.get("fields"), Mapping)
            and item["fields"].get("requestId") == request_id
        ),
        None,
    )
    if paired is not None:
        refs.append(
            {
                "tool": "search_logs",
                "resource": str(paired["resource"]).lower(),
                "arguments": {
                    "start": _iso(start),
                    "end": _iso(end),
                    "query": request_id,
                    "limit": 100,
                },
                "required": True,
                "reason": "Correlate the downstream response for the same captured request.",
            }
        )
    refs.append(
        {
            "tool": "read_configuration",
            "resource": resource,
            "arguments": {},
            "required": True,
            "reason": "Read configuration at the captured cutoff.",
        }
    )
    query = sources["metrics"].get("query", {})
    names = []
    for entry in query.get("metrics", []) if isinstance(query, Mapping) and isinstance(query.get("metrics"), list) else []:
        metric = entry.get("MetricStat", {}).get("Metric", {}) if isinstance(entry, Mapping) else {}
        if (
            isinstance(metric, Mapping)
            and isinstance(metric.get("MetricName"), str)
            and any(
                resource in str(d.get("Value", "")).lower()
                for d in metric.get("Dimensions", [])
                if isinstance(d, Mapping)
            )
        ):
            names.append(metric["MetricName"])
    names = list(dict.fromkeys(names))
    metric_name = next((name for name in ("Errors", "Throttles") if name in names), names[0] if names else None)
    if metric_name:
        period = query.get("periodSeconds", 60) if isinstance(query, Mapping) else 60
        metric_window = sources["metrics"]["window"]
        end_metric = min(_time(metric_window["end"], "metrics.window.end"), reference)
        start_metric = _time(metric_window["start"], "metrics.window.start")
        # CloudWatch periods are interval boundaries.  Do not cite a partial
        # bucket merely because the source was observed with millisecond
        # precision after the last complete minute.
        epoch = int(end_metric.timestamp())
        end_metric = datetime.fromtimestamp(epoch - (epoch % int(period)), timezone.utc)
        if end_metric - start_metric > timedelta(minutes=30):
            start_metric = end_metric - timedelta(minutes=30)
        refs.append(
            {
                "tool": "read_metrics",
                "resource": resource,
                "arguments": {
                    "start": _iso(start_metric),
                    "end": _iso(end_metric),
                    "period_seconds": period,
                    "limit": 100,
                    "metric": metric_name,
                },
                "required": True,
                "reason": f"Check the captured {metric_name} series.",
            }
        )
    history = sources["changeHistory"]
    history_end = min(_time(history["window"]["end"], "history.window.end"), reference)
    history_start = _time(history["window"]["start"], "history.window.start")
    if history_end > history_start:
        refs.append(
            {
                "tool": "read_change_history",
                "resource": resource,
                "arguments": {
                    "start": _iso(history_start),
                    "end": _iso(history_end),
                    "limit": 100,
                },
                "required": False,
                "reason": "Retain bounded history without asserting an unobserved cause.",
            }
        )
    return refs


def _write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temp.write_bytes(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False).encode() + b"\n")
    temp.chmod(0o600)
    os.replace(temp, path)


def _copy_bytes(source: Path, target: Path) -> None:
    if source.is_symlink() or not source.is_file():
        raise BridgeError(f"bundle is unavailable: {source}")
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    try:
        shutil.copyfile(source, temporary)
        temporary.chmod(0o600)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def _build_staged(args: argparse.Namespace, output: Path) -> dict[str, Any]:
    """Build and validate every artifact below a private staging directory."""

    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    scenario_path, trace_path = args.scenario.resolve(), args.trace.resolve()
    scenario = _obj(_read(scenario_path, "scenario"), "scenario")
    scenario_id, generation, trace_id, session_id, prompt, expected_response = _scenario(scenario)
    trace_meta = _trace(trace_path, trace_id, session_id)
    baseline: dict[str, Any]
    query: dict[str, Any]
    source_inputs: dict[str, Any] = {}
    if args.bundle:
        bundle_path = args.bundle.resolve()
        bundle = _obj(_read(bundle_path, "bundle"), "bundle")
        origin = _obj(bundle.get("origin"), "bundle.origin")
        sources = _obj(bundle.get("sources"), "bundle.sources")
        if set(sources) != set(SOURCES):
            raise BridgeError("bundle does not contain all four captured sources")
        if not isinstance(origin.get("referenceTime"), str):
            times = [_time(source["observedAt"], "source observedAt") for source in sources.values() if isinstance(source, Mapping) and isinstance(source.get("observedAt"), str)]
            if not times:
                raise BridgeError("bundle has no source observation cutoff")
            origin["referenceTime"] = _iso(max(times))
        capture = {"origin": origin, "sources": sources, "bundleSha256": _hash_file(bundle_path)}
        _copy_bytes(bundle_path, output / "captured-bundle.json")
        source_inputs["bundle"] = str(bundle_path)
    else:
        if args.baseline and args.query_results:
            baseline = _obj(_read(args.baseline.resolve(), "baseline"), "baseline")
            query = _obj(_read(args.query_results.resolve(), "query results"), "query results")
            source_inputs.update({"baseline": str(args.baseline.resolve()), "queryResults": str(args.query_results.resolve())})
        elif args.run_record:
            run_meta = _run_record(_obj(_read(args.run_record.resolve(), "run record"), "run record"), trace_meta)
            if run_meta["region"] != args.region:
                raise BridgeError("selected AWS Region differs from the originating run")
            baseline, query = _download_sources(run_meta, args.profile, args.region)
            source_inputs["runRecord"] = str(args.run_record.resolve())
        else:
            fetched = _fetch_run_record(
                trace_meta=trace_meta,
                table_name=args.run_table,
                profile=args.profile,
                region=args.region,
            )
            run_meta = _run_record(fetched, trace_meta)
            if run_meta["region"] != args.region:
                raise BridgeError("selected AWS Region differs from the originating run")
            baseline, query = _download_sources(run_meta, args.profile, args.region)
            source_inputs["runTable"] = args.run_table
        origin, sources = _merge_sources(baseline, query)
        origin.update({"sourceTraceId": trace_id, "sourceSessionId": session_id, "scenarioId": scenario_id, "generationId": generation})
        capture = {"origin": origin, "sources": sources, "bundleSha256": None}
        write_bundle(output / "captured-bundle.json", origin=origin, sources=sources)
        capture["bundleSha256"] = _hash_file(output / "captured-bundle.json")
    origin = capture["origin"]
    if origin.get("sourceTraceId") not in (None, trace_id):
        raise BridgeError("bundle and scenario trace identities differ")
    if origin.get("sourceSessionId") not in (None, session_id):
        raise BridgeError("bundle and scenario session identities differ")
    if trace_meta.get("runIds") and origin.get("runId") and trace_meta["runIds"] != [origin["runId"]]:
        raise BridgeError("bundle and original trace run identities differ")
    if trace_meta.get("alarms") and trace_meta["alarms"] != [origin.get("alarmArn")]:
        raise BridgeError("bundle and original trace alarm identities differ")
    source_times = [_time(source["observedAt"], "source observedAt") for source in sources.values() if isinstance(source, Mapping) and isinstance(source.get("observedAt"), str)]
    if not source_times:
        raise BridgeError("bundle has no source observation cutoff")
    derived_reference = max(source_times)
    if origin.get("referenceTime") is not None and _time(origin["referenceTime"], "bundle.referenceTime") != derived_reference:
        raise BridgeError("bundle referenceTime differs from its source observation clocks")
    origin["referenceTime"] = _iso(derived_reference)
    reference = derived_reference
    transition = _time(origin.get("transitionAt"), "transitionAt")
    if trace_meta.get("transitions") and trace_meta["transitions"] != [_iso(transition)]:
        raise BridgeError("bundle and original trace transition identities differ")
    if reference < transition:
        raise BridgeError("evidence cutoff precedes the alarm transition")
    alarm = _str(origin.get("alarmArn"), "bundle.origin.alarmArn")
    generated, reviewed_resource, _ = _native_expectation_document(
        scenario,
        affected_service=args.affected_service,
    )
    expectations = generated["expectations"]
    review = generated["review"]
    resource = _resource(sources["logs"], reviewed_resource)
    review_at = _iso(_time(review.get("reviewedAt", args.reviewed_at or origin["referenceTime"]), "review.reviewedAt"))
    coverage = review.get("coverageJustification") or (
        f"Selected from scenario {scenario_id} and exact run {origin.get('runId')} "
        f"at cutoff {origin['referenceTime']}; no later observations are included."
    )
    case_identity = {
        "scenarioId": scenario_id,
        "generationId": generation,
        "traceId": trace_id,
        "sessionId": session_id,
        "runId": origin["runId"],
        "alarmArn": alarm,
        "transitionAt": _iso(transition),
        "bundleSha256": capture["bundleSha256"],
    }
    case_identity_digest = _sha(_json_bytes(case_identity))
    case_id = f"native.{resource}.{case_identity_digest[:20]}"
    symptoms = [
        line.strip()
        for line in prompt.splitlines()
        if line.strip().startswith(("Alarm:", "State:", "Reason:"))
    ] or ["The selected incident has bounded captured evidence."]
    allowed_resources = [
        resource_name
        for resource_name in RESOURCES
        if resource_name
        in {
            str(item).lower()
            for source in sources.values()
            for item in source.get("scope", [])
        }
    ]
    task = {
        "alarmArn": alarm,
        "transitionAt": _iso(transition),
        "affectedService": resource,
        "symptoms": symptoms,
        "incidentWindow": {
            "start": min(source["window"]["start"] for source in sources.values()),
            "end": origin["referenceTime"],
        },
        "referenceTime": origin["referenceTime"],
        "allowedResources": allowed_resources,
    }
    case = {
        "schemaVersion": 1,
        "caseId": case_id,
        "task": task,
        "evidence": {
            "bundleSha256": capture["bundleSha256"],
            "originatingRunId": origin["runId"],
            "traceRef": {
                "source": trace_path.name,
                "sha256": _hash_file(trace_path),
                "traceId": trace_id,
                "runId": origin["runId"],
            },
            "references": _references(sources, resource, reference),
        },
        "review": {
            "origin": review.get("origin", "session"),
            "reviewedAt": review_at,
            "coverageJustification": coverage,
        },
        "expectations": expectations,
    }
    _write(output / "case.json", case)
    result, _ = validate_case(output / "case.json", output / "captured-bundle.json")
    if result.get("status") != "ready":
        raise BridgeError("normal case validation did not reach ready: " + json.dumps(result, sort_keys=True))
    envelope = freeze_case(output / "case.json", output / "captured-bundle.json", output / "case.frozen.json")
    public_task = candidate_input(output / "case.frozen.json", output / "captured-bundle.json")
    _write(output / "candidate-input.json", public_task)
    _write(output / "suite.json", {"schemaVersion": 1, "cases": [{"case": "case.frozen.json", "bundle": "captured-bundle.json"}]})
    native_handoff = {
        "schemaVersion": 1,
        "kind": "native-reference-handoff",
        "evaluatorOnly": True,
        "scenarioId": scenario_id,
        "scenarioSha256": _hash_file(scenario_path),
        "traceId": trace_id,
        "sessionId": session_id,
        "input": prompt,
        "expectedResponse": expected_response,
        "expectedResponseSha256": _sha(expected_response.encode()),
    }
    _write(output / "native-handoff.json", native_handoff)
    manifest = {
        "schemaVersion": 1,
        "kind": "native-case-bridge",
        "scenarioId": scenario_id,
        "generationId": generation,
        "traceId": trace_id,
        "sessionId": session_id,
        "runId": origin["runId"],
        "alarmArn": alarm,
        "transitionAt": case["task"]["transitionAt"],
        "referenceTime": origin["referenceTime"],
        "caseId": case_id,
        "caseSha256": envelope["caseSha256"],
        "bundleSha256": capture["bundleSha256"],
        "partialSources": [
            name
            for name, source in sources.items()
            if source.get("completeness") != "complete" or source.get("truncated")
        ],
        "sourceInputs": {
            "scenario": str(scenario_path),
            "trace": str(trace_path),
            **source_inputs,
        },
        "traceSha256": _hash_file(trace_path),
        "nativeHandoffSha256": _hash_file(output / "native-handoff.json"),
        "nativeInputSha256": _sha(prompt.encode()),
        "candidateUsesNativeInput": False,
        "candidateInputFormat": "normal-reviewed-case-task-json",
        "nativeInputPreservedIn": "native-handoff.json",
    }
    manifest["sourceInputs"]["expectations"] = "scenario.metadata.expected_recommendation"
    _write(output / "bridge-manifest.json", manifest)
    return {"status": "ready", **manifest, "output": str(output)}


def _archive_generated(output: Path) -> Path:
    """Retain a completed generated bridge before replacing it."""

    manifest = output / BRIDGE_ARTIFACTS[-1]
    if manifest.is_symlink() or not manifest.is_file():
        raise BridgeError("completed bridge manifest is unavailable for archival")
    digest = _hash_file(manifest)
    archive = output.parent / f"{output.name}.archive.{digest[:20]}"
    if archive.exists():
        if archive.is_symlink() or not archive.is_dir():
            raise BridgeError(f"bridge archive path is not a directory: {archive}")
    else:
        archive.mkdir(parents=True, mode=0o700)
    for name in BRIDGE_ARTIFACTS:
        source = output / name
        if source.is_symlink() or not source.is_file():
            raise BridgeError(f"completed bridge is missing generated artifact: {name}")
        target = archive / name
        if target.exists():
            if target.is_symlink() or not target.is_file() or _hash_file(target) != _hash_file(source):
                raise BridgeError(f"bridge archive conflicts with generated artifact: {name}")
            continue
        _copy_bytes(source, target)
    return archive


def _staged_matches_output(staging: Path, output: Path) -> bool:
    return all(
        (staging / name).is_file()
        and (output / name).is_file()
        and not (staging / name).is_symlink()
        and not (output / name).is_symlink()
        and _hash_file(staging / name) == _hash_file(output / name)
        for name in BRIDGE_ARTIFACTS
    )


def _publish_staged(staging: Path, output: Path) -> dict[str, Any]:
    """Promote validated artifacts, with the manifest as the commit marker."""

    if output.is_symlink() or (output.exists() and not output.is_dir()):
        raise BridgeError(f"bridge output is not a directory: {output}")
    if (output / BRIDGE_ARTIFACTS[-1]).exists():
        if _staged_matches_output(staging, output):
            return {"reusedExisting": True}
        archive = _archive_generated(output)
    else:
        archive = None
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name in BRIDGE_ARTIFACTS[:-1]:
        source = staging / name
        target = output / name
        if not source.is_file():
            raise BridgeError(f"staged bridge artifact is unavailable: {name}")
        if target.is_symlink() or (target.exists() and not target.is_file()):
            raise BridgeError(f"bridge output contains a non-file artifact: {name}")
        os.replace(source, target)

    # A manifest means every preceding artifact is ready for consumers.  Do
    # this last so a retry can safely replace a failed, manifest-less publish.
    manifest = staging / BRIDGE_ARTIFACTS[-1]
    if not manifest.is_file():
        raise BridgeError("staged bridge manifest is unavailable")
    target = output / BRIDGE_ARTIFACTS[-1]
    if target.is_symlink() or (target.exists() and not target.is_file()):
        raise BridgeError("bridge output contains a non-file manifest")
    os.replace(manifest, target)
    return {
        "reusedExisting": False,
        **({"archivedPreviousOutput": str(archive)} if archive is not None else {}),
    }


def build(args: argparse.Namespace) -> dict[str, Any]:
    output = args.output.resolve()
    if output.is_symlink() or (output.exists() and not output.is_dir()):
        raise BridgeError(f"bridge output is not a directory: {output}")
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(
        prefix=f".{output.name}.native-case-",
        dir=str(output.parent),
    ) as directory:
        staging = Path(directory)
        result = _build_staged(args, staging)
        publication = _publish_staged(staging, output)
        result["output"] = str(output)
        result.update(publication)
        return result


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build")
    for name in ("scenario", "trace", "output"):
        build.add_argument(f"--{name}", required=True, type=Path)
    build.add_argument("--bundle", type=Path)
    build.add_argument("--baseline", type=Path)
    build.add_argument("--query-results", type=Path)
    build.add_argument("--run-record", type=Path, help="saved RunTable item; omit to read it by the trace alarm/transition")
    build.add_argument("--run-table", default=os.environ.get("AGENT_RUN_TABLE", "IncidentTriageDemoAgentRun"))
    build.add_argument("--profile")
    build.add_argument("--region", default="us-east-1")
    build.add_argument("--reviewed-at")
    build.add_argument("--affected-service", choices=RESOURCES)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = _parser().parse_args(argv)
        if args.command == "build":
            print(json.dumps(build(args), ensure_ascii=False, sort_keys=True))
            return 0
    except (BridgeError, OSError, TypeError, ValueError, KeyError) as exc:
        print(json.dumps({"status": "error", "reason": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False, sort_keys=True))
        return 2
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
