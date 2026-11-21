"""Versioned, offline replay for the four incident evidence tools.

The live provider in :mod:`evidence` owns the public tool signatures and the
AWS projections.  This module keeps the replay boundary deliberately small:
``CapturedEvidenceTools`` subclasses the live provider, but replaces every
source read with a deterministic in-memory filter over a verified bundle.

The bundle is one JSON envelope.  Its manifest contains a digest for each
source so a changed source cannot be mistaken for the originally exported
evidence.  Loading a bundle never imports or constructs an AWS client; boto3 is
imported only by the operator ``export`` command.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import re
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

from evidence import (
    CHECKOUT_FUNCTION,
    EvidenceTools,
    INVENTORY_DENY_POLICY_NAME,
    INVENTORY_FUNCTION,
    INVENTORY_ROLE_NAMES,
    MAX_CAPTURE_BYTES,
    MAX_CAPTURE_RECORDS,
    MAX_ITEMS,
)


SCHEMA_VERSION = 1
SOURCE_NAMES = ("logs", "metrics", "configuration", "changeHistory")
MAX_BUNDLE_BYTES = 2 * 1024 * 1024
SUPPORTED_METRIC_PERIODS = frozenset({1, 5, 10, 20, 30, 60, 120, 300, 600, 900, 1800})
_UTC_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
_FRACTION_RE = re.compile(r"[.,]([0-9]{1,9})(?=Z$|[+-][0-9]{2}:?[0-9]{2}$)")


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")


def _digest(value: Any) -> str:
    return hashlib.sha256(_json_bytes(value)).hexdigest()


def _as_path(value: str | Path) -> Path:
    return value if isinstance(value, Path) else Path(str(value))


def _parse_time(value: Any) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, (int, float)):
        # CloudWatch and CloudTrail records sometimes carry milliseconds.
        numeric = float(value)
        if abs(numeric) > 10_000_000_000:
            numeric /= 1000
        parsed = datetime.fromtimestamp(numeric, timezone.utc)
    else:
        text = str(value).strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _epoch_nanoseconds(value: Any) -> int:
    """Compare ISO instants at their supplied precision, up to nanoseconds."""

    if isinstance(value, (int, float, Decimal)) and not isinstance(value, bool):
        try:
            numeric = Decimal(str(value))
        except InvalidOperation as exc:
            raise ValueError("timestamp must be finite") from exc
        if not numeric.is_finite():
            raise ValueError("timestamp must be finite")
        if abs(numeric) > 10_000_000_000:
            numeric /= 1000
        return int(numeric * 1_000_000_000)
    if isinstance(value, datetime):
        if value.tzinfo is None or value.utcoffset() is None:
            value = value.replace(tzinfo=timezone.utc)
        parsed = value.astimezone(timezone.utc)
        delta = parsed.replace(microsecond=0) - _UTC_EPOCH
        return (delta.days * 86_400 + delta.seconds) * 1_000_000_000 + parsed.microsecond * 1_000

    text = str(value).strip()
    if text.endswith("Z"):
        parse_text = text[:-1] + "+00:00"
    else:
        parse_text = text
    fraction_match = _FRACTION_RE.search(text)
    fraction_ns = int(fraction_match.group(1).ljust(9, "0")) if fraction_match else 0
    if fraction_match:
        parse_text = parse_text[:fraction_match.start()] + parse_text[fraction_match.end():]
    try:
        parsed = datetime.fromisoformat(parse_text)
    except (TypeError, ValueError) as exc:
        raise ValueError("timestamp must be an ISO timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("timestamp must include a timezone")
    parsed_utc = parsed.astimezone(timezone.utc)
    delta = parsed_utc - _UTC_EPOCH
    seconds = delta.days * 86_400 + delta.seconds
    return seconds * 1_000_000_000 + fraction_ns


def _log_available_at(observation: Mapping[str, Any]) -> Any:
    for field in ("availableAt", "ingestionTime", "observedAt"):
        value = observation.get(field)
        if value is not None:
            return value
    return None


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _iso_nanoseconds(value: int) -> str:
    seconds, nanos = divmod(value, 1_000_000_000)
    base = datetime.fromtimestamp(seconds, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    fraction = f".{nanos:09d}".rstrip("0") if nanos else ""
    return f"{base}{fraction}Z"


def _window(value: Any, *, allow_snapshot: bool = False) -> tuple[str, str]:
    if not isinstance(value, Mapping) or "start" not in value or "end" not in value:
        raise ValueError("source window must contain start and end")
    start, end = _parse_time(value["start"]), _parse_time(value["end"])
    if end < start or (end == start and not allow_snapshot):
        raise ValueError("source window end must be after start")
    return _iso(start), _iso(end)


def _source_entry(source: Mapping[str, Any]) -> dict[str, Any]:
    """Validate and sanitize one source while retaining native fields."""

    if not isinstance(source, Mapping):
        raise ValueError("each source must be an object")
    scope = source.get("scope")
    if not isinstance(scope, list) or not all(isinstance(item, str) for item in scope):
        raise ValueError("source scope must be a list of strings")
    start, end = _window(source.get("window"), allow_snapshot=True)
    completeness = source.get("completeness")
    if completeness not in {"complete", "partial", "unavailable"}:
        raise ValueError("source completeness must be complete, partial, or unavailable")
    errors = source.get("errors", [])
    if not isinstance(errors, list) or not all(isinstance(item, (str, int, float, bool)) for item in errors):
        raise ValueError("source errors must be a list")
    observations = source.get("observations", [])
    if not isinstance(observations, list) or not all(isinstance(item, Mapping) for item in observations):
        raise ValueError("source observations must be a list of objects")

    # Reuse the live provider's field/value scrubber.  It removes presenter,
    # controller and credential fields while preserving approved native data.
    # The live model result sanitizer caps every list at MAX_ITEMS.  A bundle
    # has a separate source-record budget and must retain all bounded pages
    # (the acceptance fixture intentionally has 131 records), so sanitize each
    # observation independently instead of passing the observations list
    # through that model-result list cap.
    raw_source = copy.deepcopy(dict(source))
    raw_observations = raw_source.get("observations", [])
    record_limited = len(raw_observations) > MAX_CAPTURE_RECORDS
    sanitized = EvidenceTools._sanitize(raw_source)
    if isinstance(raw_observations, list):
        sanitized["observations"] = [EvidenceTools._sanitize(item) for item in raw_observations[:MAX_CAPTURE_RECORDS]]
    sanitized["scope"] = list(scope)
    sanitized["window"] = {"start": start, "end": end}
    for field in ("observedAt", "acquiredAt"):
        if source.get(field) is not None:
            sanitized[field] = _iso(_parse_time(source[field]))
    sanitized["completeness"] = str(completeness)
    sanitized["errors"] = [EvidenceTools._scrub_text(str(item))[:1000] for item in errors[:MAX_ITEMS]]
    sanitized["truncated"] = bool(source.get("truncated", False)) or record_limited
    if record_limited:
        sanitized["completeness"] = "partial" if completeness == "complete" else str(completeness)
        gaps = list(sanitized.get("gaps", [])) if isinstance(sanitized.get("gaps"), list) else []
        gaps.append(f"source record cap reached at {MAX_CAPTURE_RECORDS}")
        sanitized["gaps"] = gaps
    records = sanitized["observations"]
    if len(_json_bytes(sanitized)) > MAX_CAPTURE_BYTES:
        sanitized["truncated"] = True
        sanitized["completeness"] = "partial" if completeness == "complete" else str(completeness)
        sanitized.setdefault("gaps", []).append("source byte cap reached at 256 KiB")
        while records and len(_json_bytes(sanitized)) > MAX_CAPTURE_BYTES:
            del records[len(records) // 2:]
        if len(_json_bytes(sanitized)) > MAX_CAPTURE_BYTES:
            raise ValueError("source metadata exceeds 256 KiB")
    return dict(sanitized)


def _validate_origin(origin: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(origin, Mapping):
        raise ValueError("origin must be an object")
    required = ("alarmArn", "transitionAt", "runId", "accountId", "region")
    missing = [key for key in required if not str(origin.get(key, "")).strip()]
    if missing:
        raise ValueError(f"origin is missing required fields: {', '.join(missing)}")
    try:
        _parse_time(origin["transitionAt"])
    except (TypeError, ValueError) as exc:
        raise ValueError("origin transitionAt must be an ISO timestamp") from exc
    # Keep the provenance envelope as supplied, but scrub accidental secrets in
    # optional fields before writing it beside the public source observations.
    return dict(EvidenceTools._sanitize(copy.deepcopy(dict(origin))))


def write_bundle(path: str | Path, *, origin: Mapping[str, Any], sources: Mapping[str, Mapping[str, Any]]) -> Path:
    """Write one verified, sanitized source bundle and return its path."""

    target = _as_path(path)
    normalized_origin = _validate_origin(origin)
    if not isinstance(sources, Mapping) or set(sources) != set(SOURCE_NAMES):
        raise ValueError(f"sources must contain exactly: {', '.join(SOURCE_NAMES)}")
    normalized_sources = {name: _source_entry(sources[name]) for name in SOURCE_NAMES}
    manifest_sources = {
        name: {
            "sha256": _digest(source),
            "scope": source["scope"],
            "window": source["window"],
            "completeness": source["completeness"],
            "recordCount": len(source["observations"]),
        }
        for name, source in normalized_sources.items()
    }
    payload: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "origin": normalized_origin,
        "sources": normalized_sources,
        "manifest": {
            "schemaVersion": SCHEMA_VERSION,
            "sourceNames": list(SOURCE_NAMES),
            "sources": manifest_sources,
        },
    }
    body = json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8") + b"\n"
    if len(body) > MAX_BUNDLE_BYTES:
        raise ValueError(f"bundle exceeds {MAX_BUNDLE_BYTES} bytes")
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=target.parent, prefix=".capture-", delete=False) as temp:
        temp_path = Path(temp.name)
        try:
            temp.write(body)
            temp.close()
            os.replace(temp_path, target)
        finally:
            temp_path.unlink(missing_ok=True)
    return target


def _load_bundle(
    path: str | Path, *, expected_sha256: str | None = None
) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    target = _as_path(path)
    try:
        with target.open("rb") as stream:
            raw = stream.read(MAX_BUNDLE_BYTES + 1)
    except OSError as exc:
        raise ValueError(f"cannot read bundle: {target}") from exc
    if len(raw) > MAX_BUNDLE_BYTES:
        raise ValueError(f"bundle exceeds {MAX_BUNDLE_BYTES} bytes")
    if expected_sha256 is not None and hashlib.sha256(raw).hexdigest() != expected_sha256:
        raise ValueError("case evidence bundleSha256 does not match the selected bundle")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("bundle is not valid UTF-8 JSON") from exc
    if not isinstance(payload, Mapping):
        raise ValueError("bundle envelope must be an object")
    version = payload.get("schemaVersion")
    if version != SCHEMA_VERSION:
        raise ValueError(f"unsupported bundle schemaVersion: {version!r}")
    origin = _validate_origin(payload.get("origin", {}))
    raw_sources = payload.get("sources")
    if not isinstance(raw_sources, Mapping) or set(raw_sources) != set(SOURCE_NAMES):
        raise ValueError(f"bundle sources must contain exactly: {', '.join(SOURCE_NAMES)}")
    manifest = payload.get("manifest")
    if not isinstance(manifest, Mapping) or manifest.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError("bundle manifest is missing or has an unsupported schema")
    manifest_sources = manifest.get("sources")
    if not isinstance(manifest_sources, Mapping) or set(manifest_sources) != set(SOURCE_NAMES):
        raise ValueError("bundle manifest sources are incomplete")
    sources: dict[str, dict[str, Any]] = {}
    for name in SOURCE_NAMES:
        raw_source = raw_sources[name]
        entry = manifest_sources[name]
        if not isinstance(entry, Mapping) or not isinstance(raw_source, Mapping):
            raise ValueError(f"source manifest entry is invalid: {name}")
        # Check the bytes represented by the on-disk source before any
        # sanitizing/normalization.  Otherwise a tampered sensitive key could
        # be scrubbed first and accidentally preserve the old digest.
        if entry.get("sha256") != _digest(raw_source):
            raise ValueError(f"source digest mismatch: {name}")
        source = _source_entry(raw_source)
        if entry.get("sha256") != _digest(source):
            raise ValueError(f"source normalization mismatch: {name}")
        for key in ("scope", "window", "completeness"):
            if entry.get(key) != source.get(key):
                raise ValueError(f"source manifest mismatch: {name}.{key}")
        if entry.get("recordCount") != len(source["observations"]):
            raise ValueError(f"source manifest record count mismatch: {name}")
        sources[name] = source
    return {"schemaVersion": SCHEMA_VERSION, "origin": origin, "manifest": dict(manifest)}, sources


def export_bundle(
    path: str | Path,
    *,
    origin: Mapping[str, Any],
    evidence: EvidenceTools,
    start: str,
    end: str,
) -> Path:
    """Collect all four bounded sources independently and write a bundle.

    The existing provider projects the source records outside the decorated
    model calls, using a separate record and byte budget.
    """

    start_at, end_at = _parse_time(start), _parse_time(end)
    if end_at <= start_at:
        raise ValueError("export end must be after start")
    if (end_at - start_at).total_seconds() > 30 * 60:
        raise ValueError("export window cannot exceed 30 minutes")
    normalized_origin = _validate_origin(origin)
    normalized_origin.setdefault("capturedAt", _iso(datetime.now(timezone.utc)))
    window = (_iso(start_at), _iso(end_at))

    sources = evidence.collect_sources(*window)
    return write_bundle(path, origin=normalized_origin, sources=sources)


class CapturedEvidenceTools(EvidenceTools):
    """Offline provider that reuses the live decorated tool methods."""

    def __init__(
        self,
        payload: Mapping[str, Any],
        sources: Mapping[str, Mapping[str, Any]],
        *,
        reference_time: str,
        allowed_resources: Iterable[str] | None = None,
        deadline_monotonic: float | None = None,
        charge_tool_call: Callable[[], Any] | None = None,
    ) -> None:
        origin = payload["origin"]
        self.origin = dict(origin)
        self.session = None
        self.account_id = str(origin.get("accountId", ""))
        self.region = str(origin.get("region", ""))
        self.app_http_api_id = str(origin.get("apiId", origin.get("appHttpApiId", "")))
        self.source_bucket = "offline"
        self.source_prefix = ""
        self.run_id = self._safe_component(origin.get("runId", "capture"))
        self.alarm_arn = str(origin.get("alarmArn", ""))
        # Keep the reviewed cutoff byte-for-byte in returned evidence.  Its
        # comparisons below use nanosecond precision rather than datetime's
        # microsecond precision.
        self.transition_at = str(reference_time)
        self.started_at = str(origin.get("startedAt", self.transition_at))
        self.reference_time = self.transition_at
        self.allowed_resources = None if allowed_resources is None else frozenset(allowed_resources)
        if self.allowed_resources is not None and (
            not self.allowed_resources or not self.allowed_resources <= {"gateway", "checkout", "inventory"}
        ):
            raise ValueError("allowed_resources must contain supported application resources")
        self.deadline_monotonic = float(deadline_monotonic if deadline_monotonic is not None else time.monotonic() + 60)
        self.charge_tool_call = charge_tool_call or (lambda: None)
        self._query_results: list[dict[str, Any]] = []
        self._capture_metadata: dict[str, Any] = {}
        self._sources = {name: copy.deepcopy(dict(sources[name])) for name in SOURCE_NAMES}

    @classmethod
    def load(
        cls,
        path: str | Path,
        *,
        reference_time: str,
        expected_sha256: str | None = None,
        allowed_resources: Iterable[str] | None = None,
        deadline_monotonic: float | None = None,
        charge_tool_call: Callable[[], Any] | None = None,
    ) -> "CapturedEvidenceTools":
        payload, sources = _load_bundle(path, expected_sha256=expected_sha256)
        try:
            _epoch_nanoseconds(reference_time)
        except (TypeError, ValueError) as exc:
            raise ValueError("reference_time must be an ISO timestamp") from exc
        return cls(
            payload,
            sources,
            reference_time=reference_time,
            allowed_resources=allowed_resources,
            deadline_monotonic=deadline_monotonic,
            charge_tool_call=charge_tool_call,
        )

    def _check_allowed_resources(self, resources: Sequence[str]) -> tuple[str, ...]:
        selected = tuple(resources)
        if self.allowed_resources is not None:
            disallowed = sorted(set(selected) - self.allowed_resources)
            if disallowed:
                raise ValueError(f"out-of-scope captured resource: {', '.join(disallowed)}")
        return selected

    def _log_resources(self, resource: str) -> tuple[str, ...]:
        return self._check_allowed_resources(super()._log_resources(resource))

    def _metric_resources(self, resource: str) -> tuple[str, ...]:
        return self._check_allowed_resources(super()._metric_resources(resource))

    def _configuration_resources(self, resource: str) -> tuple[str, ...]:
        return self._check_allowed_resources(super()._configuration_resources(resource))

    def _history_resources(self, resource: str) -> tuple[str, ...]:
        return self._check_allowed_resources(super()._history_resources(resource))

    def _validated_window(self, start: str | None, end: str | None) -> tuple[str, str]:
        if start is None and end is None:
            end = self.reference_time
            start = _iso(_parse_time(end) - timedelta(minutes=10))
        elif start is None or end is None:
            raise ValueError("start and end must be supplied together")
        start_ns, end_ns = _epoch_nanoseconds(start), _epoch_nanoseconds(end)
        if end_ns <= start_ns:
            raise ValueError("evidence window end must be after start")
        if end_ns - start_ns > 1_800 * 1_000_000_000:
            raise ValueError("evidence window cannot exceed 30 minutes")
        return str(start), str(end)

    def _source(self, name: str, resources: Sequence[str]) -> tuple[dict[str, Any], list[str]]:
        source = self._sources[name]
        source_scope = source.get("scope", [])
        missing = [resource for resource in resources if resource not in source_scope]
        return source, missing

    def _source_result(
        self,
        source_name: str,
        source_label: str,
        resources: Sequence[str],
        window: tuple[str, str],
        query: Any,
        observations: list[dict[str, Any]],
        *,
        gaps: Iterable[str] = (),
        errors: Iterable[str] = (),
        truncated: bool = False,
        observed_at: str | None = None,
    ) -> dict[str, Any]:
        source = self._sources[source_name]
        source_errors = [str(item) for item in source.get("errors", [])]
        source_gaps = [str(item) for item in source.get("gaps", [])]
        all_errors = source_errors + [str(item) for item in errors]
        all_gaps = source_gaps + [str(item) for item in gaps]
        if source.get("completeness") == "unavailable":
            all_gaps.append(f"{source_name} source is unavailable")
        if source.get("truncated"):
            all_gaps.append(f"{source_name} source was truncated during capture")
        result: dict[str, Any] = {
            "source": source_label,
            "scope": list(resources),
            "query": query,
            "window": {"start": window[0], "end": window[1]},
            "referenceTime": self.reference_time,
            "completeness": "complete",
            "truncated": bool(truncated),
            "errors": all_errors,
        }
        observed_value = observed_at or source.get("observedAt") or source.get("acquiredAt")
        if observed_value is not None:
            result["observedAt"] = str(observed_value)
        if source.get("acquiredAt") is not None:
            result["acquiredAt"] = source["acquiredAt"]
        if observations:
            result["observations"] = observations
        if all_gaps:
            result["gaps"] = list(dict.fromkeys(all_gaps))
        if source.get("completeness") != "complete" or all_errors or all_gaps or truncated:
            result["completeness"] = "unavailable" if not observations and source.get("completeness") == "unavailable" else "partial"
        bounded = self._bound_result(self._sanitize(result))
        return self._project_model_result(bounded)

    def _project_model_result(self, result: dict[str, Any]) -> dict[str, Any]:
        """Omit later archive metadata from the already-bounded model result.

        ``result`` is a fresh sanitized projection, so this preserves the
        existing row truncation and leaves the verified source bundle intact.
        Per-row timestamps, availability, windows, gaps, errors and references
        are evidence semantics and therefore remain visible.
        """

        for field in ("observedAt", "acquiredAt"):
            if self._is_post_reference(result.get(field)):
                result.pop(field, None)

        query = result.get("query")
        if isinstance(query, dict):
            if self._is_post_reference(query.get("sourceObservedAt")):
                query.pop("sourceObservedAt", None)
        return result

    def _is_post_reference(self, value: Any) -> bool:
        if value is None:
            return False
        try:
            return _epoch_nanoseconds(value) > _epoch_nanoseconds(self.reference_time)
        except (TypeError, ValueError, OverflowError):
            return False

    def _coverage_gap(self, source: Mapping[str, Any], requested: tuple[str, str]) -> list[str]:
        try:
            captured = _window(source.get("window"))
            req_start, req_end = _epoch_nanoseconds(requested[0]), _epoch_nanoseconds(requested[1])
            cap_start, cap_end = _epoch_nanoseconds(captured[0]), _epoch_nanoseconds(captured[1])
            gaps: list[str] = []
            if req_start < cap_start:
                gaps.append(f"capture coverage starts at {captured[0]}")
            if req_end > cap_end:
                gaps.append(f"capture coverage ends at {captured[1]}")
            return gaps
        except (TypeError, ValueError):
            return ["source coverage window is unavailable"]

    def _available_at_ns(self, observation: Mapping[str, Any], source: Mapping[str, Any]) -> int | None:
        value = observation.get("availableAt")
        if value is None:
            value = source.get("acquiredAt", source.get("observedAt"))
        if value is None:
            return None
        try:
            return _epoch_nanoseconds(value)
        except (TypeError, ValueError, OverflowError):
            return None

    def _query_logs(
        self, resources: Sequence[str], window: tuple[str, str], filter_pattern: str | None, limit: int,
        *, predicate: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        source, missing = self._source("logs", resources)
        captured_resources = set(resources) - set(missing)
        gaps = self._coverage_gap(source, window) + [f"logs has no captured scope for {resource}" for resource in missing]
        start_ns, requested_end_ns = _epoch_nanoseconds(window[0]), _epoch_nanoseconds(window[1])
        reference_ns = _epoch_nanoseconds(self.reference_time)
        end_ns = min(requested_end_ns, reference_ns)
        if requested_end_ns > reference_ns:
            gaps.append("reference time clips the requested log window")
        if end_ns <= start_ns:
            gaps.append("requested log window is after the reference time")
        records: list[dict[str, Any]] = []
        unavailable_match = False
        source_observations = source.get("observations", [])
        if isinstance(source_observations, list):
            for item in source_observations:
                if not isinstance(item, Mapping) or item.get("resource") not in captured_resources:
                    continue
                try:
                    event_at_ns = _epoch_nanoseconds(item.get("timestamp"))
                except (TypeError, ValueError, OverflowError):
                    gaps.append("log record without a valid event timestamp")
                    continue
                available_at_ns = self._available_at_ns({"availableAt": _log_available_at(item)}, source)
                if event_at_ns < start_ns or event_at_ns >= end_ns:
                    continue
                if not self._matches_log_filter(item, filter_pattern, predicate):
                    continue
                if available_at_ns is None or available_at_ns > reference_ns:
                    unavailable_match = True
                    continue
                records.append(dict(item))
                if len(records) > limit:
                    break
        if unavailable_match:
            gaps.append("matching logs include records without proven availability at the reference time")
        return self._source_result("logs", "logs", resources, window, {"filter": filter_pattern} if filter_pattern else {}, records[:limit],
                                   gaps=gaps, truncated=len(records) > limit)

    def _metric_metadata(self, source: Mapping[str, Any], metric_name: str | None, period: int) -> tuple[list[dict[str, Any]], int]:
        query = source.get("query")
        if not isinstance(query, Mapping):
            raise ValueError("captured metrics lack native query metadata")
        native_period = query.get("periodSeconds")
        if native_period is None:
            entries = query.get("metrics")
            if isinstance(entries, list) and entries:
                native_period = entries[0].get("MetricStat", {}).get("Period")
        try:
            native_period = int(native_period)
        except (TypeError, ValueError) as exc:
            raise ValueError("captured metrics lack a native period") from exc
        if period != native_period:
            raise ValueError(f"period/aggregation {period} is not recorded; captured period is {native_period}")
        if period not in SUPPORTED_METRIC_PERIODS:
            raise ValueError(f"period/aggregation {period} is unsupported")
        entries = query.get("metrics")
        if not isinstance(entries, list):
            raise ValueError("captured metrics lack native metric metadata")
        selected: list[dict[str, Any]] = []
        for entry in entries:
            if not isinstance(entry, Mapping):
                continue
            stat = entry.get("MetricStat")
            metric = stat.get("Metric") if isinstance(stat, Mapping) else None
            name = metric.get("MetricName") if isinstance(metric, Mapping) else entry.get("Label")
            if metric_name is None or str(name).lower() == str(metric_name).lower() or str(entry.get("Label", "")).lower() == str(metric_name).lower():
                selected.append(dict(entry))
        if metric_name and not selected:
            raise ValueError(f"metric is not recorded: {metric_name}")
        return selected, native_period

    @staticmethod
    def _metric_entry_resource(entry: Mapping[str, Any]) -> str | None:
        stat = entry.get("MetricStat")
        metric = stat.get("Metric") if isinstance(stat, Mapping) else None
        dimensions = metric.get("Dimensions", []) if isinstance(metric, Mapping) else []
        for dimension in dimensions if isinstance(dimensions, list) else []:
            if not isinstance(dimension, Mapping):
                continue
            value = str(dimension.get("Value", ""))
            if value == CHECKOUT_FUNCTION:
                return "checkout"
            if value == INVENTORY_FUNCTION:
                return "inventory"
            if dimension.get("Name") == "ApiId":
                return "gateway"
        return None

    def _query_metrics(self, resources: Sequence[str], window: tuple[str, str], period: int, limit: int, metric_name: str | None = None) -> dict[str, Any]:
        source, missing = self._source("metrics", resources)
        if source.get("completeness") == "unavailable":
            return self._source_result(
                "metrics",
                "cloudwatch",
                resources,
                window,
                {"metrics": [], "periodSeconds": period},
                [],
                gaps=[f"metrics has no captured scope for {resource}" for resource in resources],
            )
        selected, native_period = self._metric_metadata(source, metric_name, period)
        captured_resources = set(resources) - set(missing)
        selected = [entry for entry in selected if self._metric_entry_resource(entry) in captured_resources]
        selected_ids = {str(entry.get("Id")) for entry in selected}
        query_metrics = [dict(item) for item in selected]
        gaps = self._coverage_gap(source, window) + [f"metrics has no captured scope for {resource}" for resource in missing]
        start_ns, requested_end_ns = _epoch_nanoseconds(window[0]), _epoch_nanoseconds(window[1])
        reference_ns = _epoch_nanoseconds(self.reference_time)
        end_ns = min(requested_end_ns, reference_ns)
        if requested_end_ns > reference_ns:
            gaps.append("reference time clips the requested metric window")
        # CloudWatch periods are intervals, not point samples.  A request that
        # cuts either boundary through a native bucket is necessarily partial,
        # even when one complete bucket remains in the returned observation.
        bucket_ns = native_period * 1_000_000_000
        if start_ns % bucket_ns or end_ns % bucket_ns:
            gaps.append("requested window cuts a native metric bucket")
        candidates: dict[tuple[str, str], tuple[int, dict[str, Any], int]] = {}
        observations = source.get("observations", [])
        if isinstance(observations, list):
            for order, item in enumerate(observations):
                if not isinstance(item, Mapping):
                    continue
                item_name = str(item.get("Label", ""))
                if str(item.get("Id")) not in selected_ids:
                    continue
                available_at_ns = self._available_at_ns(item, source)
                if available_at_ns is None or available_at_ns > reference_ns:
                    continue
                timestamps, values = item.get("Timestamps"), item.get("Values")
                if not isinstance(timestamps, list) or not isinstance(values, list):
                    gaps.append("metric observation lacks timestamps or values")
                    continue
                observed_times = item.get("observedAt")
                # Older metric exports store one observation clock for the entire series.
                if not isinstance(observed_times, list):
                    observed_times = [observed_times] * len(timestamps)
                for index, (timestamp, value) in enumerate(zip(timestamps, values)):
                    try:
                        bucket_start_ns = _epoch_nanoseconds(timestamp)
                    except (TypeError, ValueError, OverflowError):
                        gaps.append("metric observation has an invalid timestamp")
                        continue
                    bucket_end_ns = bucket_start_ns + bucket_ns
                    if bucket_start_ns < start_ns or bucket_end_ns > end_ns or bucket_start_ns >= reference_ns:
                        continue
                    if bucket_end_ns > reference_ns:
                        continue
                    observed_at = observed_times[index] if index < len(observed_times) else None
                    if observed_at is not None:
                        try:
                            observed_ns = _epoch_nanoseconds(observed_at)
                        except (TypeError, ValueError, OverflowError):
                            gaps.append("metric observation has an invalid observedAt")
                            continue
                        if observed_ns > reference_ns:
                            continue
                        if not isinstance(observed_at, str):
                            observed_at = _iso_nanoseconds(observed_ns)
                    bucket_start = _parse_time(timestamp)
                    key = (str(item.get("Id", item_name)), _iso(bucket_start))
                    previous = candidates.get(key)
                    if previous is None or (available_at_ns, order) >= (previous[0], previous[2]):
                        candidates[key] = (
                            available_at_ns,
                            {
                                "timestamp": _iso(bucket_start),
                                "value": value,
                                "observedAt": observed_at,
                                "item": dict(item),
                            },
                            order,
                        )

        by_series: dict[str, dict[str, Any]] = {}
        for (_, _), (available_at_ns, bucket, _) in sorted(candidates.items(), key=lambda pair: pair[0][1]):
            item = bucket["item"]
            series_id = str(item.get("Id", item.get("Label", "metric")))
            series = by_series.setdefault(series_id, {key: item[key] for key in ("Id", "Label", "StatusCode", "Messages") if key in item})
            series.setdefault("Timestamps", []).append(bucket["timestamp"])
            series.setdefault("Values", []).append(bucket["value"])
            series.setdefault("availability", []).append(_iso_nanoseconds(available_at_ns))
            series.setdefault("observedAt", []).append(bucket["observedAt"])
            if item.get("StatusCode") not in (None, "Complete"):
                gaps.append(f"metric {series_id} returned status {item.get('StatusCode')}")
        records = list(by_series.values())
        truncated = len(records) > limit
        if truncated:
            records = records[:limit]
        full_buckets = max(0, end_ns // bucket_ns - (start_ns + bucket_ns - 1) // bucket_ns)
        for series_id in sorted(selected_ids):
            sample_count = len(by_series.get(series_id, {}).get("Timestamps", []))
            if sample_count < full_buckets:
                gaps.append(f"metric {series_id} has {sample_count} of {full_buckets} complete buckets available at the reference time")
        if not selected_ids or full_buckets == 0:
            gaps.append("no native metric buckets cover the requested scope and window")
        result_query = {"metrics": query_metrics, "periodSeconds": native_period}
        return self._source_result("metrics", "cloudwatch", resources, window, result_query, records,
                                   gaps=gaps, truncated=truncated)

    def _query_configuration(self, resources: Sequence[str]) -> dict[str, Any]:
        source, missing = self._source("configuration", resources)
        captured_resources = set(resources) - set(missing)
        gaps = [f"configuration has no captured scope for {resource}" for resource in missing]
        records: list[dict[str, Any]] = []
        reference_ns = _epoch_nanoseconds(self.reference_time)
        observations = source.get("observations", [])
        if isinstance(observations, list):
            for item in observations:
                if not isinstance(item, Mapping):
                    continue
                function = str(item.get("function", ""))
                resource = "inventory" if function == INVENTORY_FUNCTION or not function and "inventory" in resources else "checkout" if function == CHECKOUT_FUNCTION else None
                if resource not in captured_resources:
                    continue
                observed_value = item.get("observedAt", source.get("observedAt"))
                try:
                    observed_at_ns = _epoch_nanoseconds(observed_value)
                except (TypeError, ValueError, OverflowError):
                    gaps.append("configuration snapshot has an invalid observation time")
                    continue
                available_at_ns = self._available_at_ns(item, source)
                if observed_at_ns > reference_ns or available_at_ns is None or available_at_ns > reference_ns:
                    continue
                projected = dict(item)
                projected["observedAt"] = str(observed_value)
                projected["observationAgeSeconds"] = max(0, (reference_ns - observed_at_ns) // 1_000_000_000)
                records.append(projected)
        # Select the latest eligible Lambda snapshot per resource first.  Only
        # records explicitly observed at that same snapshot time are allowed to
        # join it; this prevents a current IAM/table read from being mixed with
        # an older alias/configuration observation.
        lambda_latest: dict[str, int] = {}
        for item in records:
            function = str(item.get("function", ""))
            if not function or item.get("kind") != "lambda":
                continue
            resource = "inventory" if function == INVENTORY_FUNCTION else "checkout" if function == CHECKOUT_FUNCTION else None
            if resource is None:
                continue
            observed = _epoch_nanoseconds(item.get("observedAt", source.get("observedAt")))
            if resource not in lambda_latest or observed > lambda_latest[resource]:
                lambda_latest[resource] = observed
        selected: list[dict[str, Any]] = []
        for item in records:
            function = str(item.get("function", ""))
            resource = "inventory" if function == INVENTORY_FUNCTION or not function else "checkout" if function == CHECKOUT_FUNCTION else None
            if resource is None:
                continue
            observed = _epoch_nanoseconds(item.get("observedAt", source.get("observedAt")))
            anchor = lambda_latest.get(resource)
            if anchor is None or observed == anchor:
                selected.append(item)
        gaps.extend(f"no active {resource} configuration snapshot was available at the reference time"
                    for resource in sorted(captured_resources - lambda_latest.keys()))
        query = {"view": "asOf", "referenceTime": self.reference_time, "sourceObservedAt": source.get("observedAt")}
        return self._source_result("configuration", "configuration", resources, (self.reference_time, self.reference_time), query, selected,
                                   gaps=gaps)

    def _query_change_history(self, resources: Sequence[str], window: tuple[str, str], limit: int) -> dict[str, Any]:
        source, missing = self._source("changeHistory", resources)
        captured_resources = tuple(resource for resource in resources if resource not in missing)
        selected_names = set(self._history_resource_names(captured_resources))
        if "gateway" in captured_resources:
            selected_names.add(self.app_http_api_id)
        if "inventory" in captured_resources:
            selected_names.update(INVENTORY_ROLE_NAMES | {INVENTORY_DENY_POLICY_NAME})
        selected_names.discard("")
        gaps = self._coverage_gap(source, window) + [f"change history has no captured scope for {resource}" for resource in missing]
        start_ns, requested_end_ns = _epoch_nanoseconds(window[0]), _epoch_nanoseconds(window[1])
        reference_ns = _epoch_nanoseconds(self.reference_time)
        end_ns = min(requested_end_ns, reference_ns)
        if requested_end_ns > reference_ns:
            gaps.append("reference time clips the requested change window")
        records: list[dict[str, Any]] = []
        unavailable_match = False
        observations = source.get("observations", [])
        if isinstance(observations, list):
            for item in observations:
                if not isinstance(item, Mapping):
                    continue
                try:
                    event_at_ns = _epoch_nanoseconds(item.get("EventTime"))
                except (TypeError, ValueError, OverflowError):
                    gaps.append("change event without a valid EventTime")
                    continue
                available_at_ns = self._available_at_ns(item, source)
                if event_at_ns < start_ns or event_at_ns >= end_ns:
                    continue
                resource_values = {str(item["lookupResource"])} if item.get("lookupResource") else set()
                resource_values.update(str(entry["ResourceName"]) for entry in item.get("Resources", [])
                                       if isinstance(entry, Mapping) and entry.get("ResourceName"))
                if not resource_values:
                    gaps.append("a captured change event has no auditable resource scope")
                    continue
                if not any(selected_names.intersection(value.replace("/", ":").split(":")) for value in resource_values):
                    continue
                if available_at_ns is None or available_at_ns > reference_ns:
                    unavailable_match = True
                    continue
                records.append(dict(item))
                if len(records) > limit:
                    break
        if unavailable_match:
            gaps.append("matching change events include records without proven availability at the reference time")
        query = {"attribute": "ResourceName", "resources": list(resources), "referenceTime": self.reference_time}
        return self._source_result("changeHistory", "cloudtrail", resources, window, query, records[:limit],
                                   gaps=gaps, truncated=len(records) > limit)

def _build_cli() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="captured_evidence", description="Export or query versioned incident evidence bundles")
    subparsers = parser.add_subparsers(dest="command", required=True)
    export = subparsers.add_parser("export", help="collect bounded AWS sources into one local bundle")
    export.add_argument("--output", required=True, type=Path)
    export.add_argument("--alarm-arn", required=True)
    export.add_argument("--transition-at", required=True)
    export.add_argument("--run-id", required=True)
    export.add_argument("--account-id", required=True)
    export.add_argument("--region", required=True)
    export.add_argument("--api-id", required=True)
    export.add_argument("--start", required=True)
    export.add_argument("--end", required=True)
    export.add_argument("--profile")
    query = subparsers.add_parser("query", help="run one supported query without AWS")
    query.add_argument("--bundle", required=True, type=Path)
    query.add_argument("--reference-time", required=True)
    query.add_argument("--tool", required=True, choices=("search_logs", "read_metrics", "read_configuration", "read_change_history"))
    query.add_argument("--resource", default="all")
    query.add_argument("--start")
    query.add_argument("--end")
    query.add_argument("--query")
    query.add_argument("--filter-pattern")
    query.add_argument("--operation")
    query.add_argument("--error")
    query.add_argument("--metric")
    query.add_argument("--period-seconds", type=int, default=60)
    query.add_argument("--limit", type=int, default=100)
    return parser


def _cli_export(args: argparse.Namespace) -> int:
    # Deliberately lazy: importing this module and querying a bundle must work
    # on a machine with no AWS SDK credentials or network configuration.
    import boto3
    from botocore.config import Config

    alarm_parts = str(args.alarm_arn).split(":", 5)
    if (
        len(alarm_parts) != 6
        or alarm_parts[0] != "arn"
        or alarm_parts[2] != "cloudwatch"
        or alarm_parts[3] != args.region
        or alarm_parts[4] != args.account_id
        or not alarm_parts[5].startswith("alarm:")
    ):
        raise SystemExit("--alarm-arn must be a CloudWatch alarm ARN in --account-id/--region")
    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    # Keep each operator read below the exporter source/group slices; the
    # collector records the affected source as partial when its slice expires
    # and continues with the remaining sources.
    client_config = Config(connect_timeout=1, read_timeout=3, retries={"total_max_attempts": 1, "mode": "standard"})

    class BoundedSession:
        def client(self, service: str, *, region_name: str | None = None) -> Any:
            return session.client(service, region_name=region_name or args.region, config=client_config)

    bounded_session = BoundedSession()
    identity = bounded_session.client("sts").get_caller_identity()
    if str(identity.get("Account", "")) != str(args.account_id):
        raise SystemExit("AWS operator profile account does not match --account-id")
    evidence = EvidenceTools(
        bounded_session,
        account_id=args.account_id,
        region=args.region,
        app_http_api_id=args.api_id,
        source_bucket="offline-export",
        source_prefix="offline-export",
        run_id=args.run_id,
        alarm_arn=args.alarm_arn,
        transition_at=args.transition_at,
        # This is the operator's acquisition start, not the historical alarm's
        # originating investigation start.
        started_at=_iso(datetime.now(timezone.utc)),
        deadline_monotonic=time.monotonic() + 60,
        charge_tool_call=lambda: None,
    )
    origin = {
        "alarmArn": args.alarm_arn,
        "transitionAt": args.transition_at,
        "runId": args.run_id,
        "accountId": args.account_id,
        "region": args.region,
        "apiId": args.api_id,
        "exportStartedAt": _iso(datetime.now(timezone.utc)),
    }
    written = export_bundle(args.output, origin=origin, evidence=evidence, start=args.start, end=args.end)
    print(written)
    return 0


def _cli_query(args: argparse.Namespace) -> int:
    tools = CapturedEvidenceTools.load(args.bundle, reference_time=args.reference_time)
    kwargs: dict[str, Any] = {"resource": args.resource}
    if args.start is not None:
        kwargs["start"] = args.start
    if args.end is not None:
        kwargs["end"] = args.end
    if args.tool == "search_logs":
        kwargs["limit"] = args.limit
        kwargs.update({key: value for key, value in (("query", args.query), ("filter_pattern", args.filter_pattern), ("operation", args.operation), ("error", args.error)) if value is not None})
    elif args.tool == "read_metrics":
        kwargs["limit"] = args.limit
        kwargs.update({key: value for key, value in (("metric", args.metric), ("period_seconds", args.period_seconds)) if value is not None})
    elif args.tool == "read_change_history":
        kwargs["limit"] = args.limit
    result = getattr(tools, args.tool)(**kwargs)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_cli().parse_args(argv)
    try:
        return _cli_export(args) if args.command == "export" else _cli_query(args)
    except (ValueError, OSError) as exc:
        print(f"captured_evidence: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
