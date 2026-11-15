"""Bounded, read-only application evidence tools for the operations agent.

The module intentionally owns the source boundary rather than exposing boto3
clients to the model.  All model-facing calls are finite, allowlisted, and
sanitized before they leave this module.  Capture writes are the only writes
performed here, and they are restricted to the configured per-run S3 prefix.
"""

from __future__ import annotations

import base64
import json
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterable, Mapping, Sequence
from urllib.parse import unquote

from botocore.exceptions import ClientError
from strands import tool


MAX_RESULT_BYTES = 12 * 1024
# Leave a little room for the model/tool wrapper when a result is serialized by
# the Runtime.  The result itself remains below the contract's 12 KiB bound.
RESULT_TARGET_BYTES = 11_500
MAX_CAPTURE_BYTES = 256 * 1024
MAX_PAGES = 8
MAX_ITEMS = 120
MAX_CAPTURE_RECORDS = MAX_PAGES * 100
# Source exports may retain every record from their bounded page budget.  The
# model-facing response still uses MAX_ITEMS and _bound_result; this larger
# sanitization cap prevents a valid 131-record export from being mistaken for
# a 120-record model result.
MAX_SANITIZED_ITEMS = MAX_PAGES * 100
MAX_WINDOW_SECONDS = 30 * 60

CHECKOUT_FUNCTION = "IncidentTriageDemoCheckout"
INVENTORY_FUNCTION = "IncidentTriageDemoInventory"
FUNCTIONS = (CHECKOUT_FUNCTION, INVENTORY_FUNCTION)
GATEWAY_LOG_GROUP = "/aws/apigateway/IncidentTriageDemoApp"
CHECKOUT_LOG_GROUP = f"/aws/lambda/{CHECKOUT_FUNCTION}"
INVENTORY_LOG_GROUP = f"/aws/lambda/{INVENTORY_FUNCTION}"
LOG_GROUPS = {
    "gateway": GATEWAY_LOG_GROUP,
    "checkout": CHECKOUT_LOG_GROUP,
    "inventory": INVENTORY_LOG_GROUP,
}
LOG_MESSAGE_FIELDS = {
    "timestamp", "service", "operation", "requestId", "lambdaRequestId",
    "functionVersion", "outcome", "durationMs", "statusCode", "errorCode",
    "errorName", "error", "dependencyErrorName", "dependencyFailureReason",
    "dependencyThrottleReason", "dependencyDurationMs", "inventoryExecutedVersion",
    "inventoryInvocationId", "routeKey", "responseLatency", "integrationLatency",
    "requestTimeEpoch", "status", "integrationStatus", "integrationError",
}
LAMBDA_THROTTLE_REASONS = frozenset({
    "CallerRateLimitExceeded",
    "ConcurrentInvocationLimitExceeded",
    "ConcurrentSnapshotCreateLimitExceeded",
    "FunctionInvocationRateLimitExceeded",
    "ReservedFunctionConcurrentInvocationLimitExceeded",
    "ReservedFunctionInvocationRateLimitExceeded",
})
INVENTORY_TABLE = "IncidentTriageDemoInventory"
INVENTORY_ROLE_NAMES = {
    "IncidentTriageDemoAppInventoryRole",
    "IncidentTriageDemoAppInventoryDeniedRole",
}
INVENTORY_DENY_POLICY_NAME = "IncidentTriageDemoInventoryReadDeny"
INVENTORY_TABLE_ARN_TEMPLATE = "arn:aws:dynamodb:{region}:{account}:table/IncidentTriageDemoInventory"
INVENTORY_DENY_POLICY_ARN_TEMPLATE = (
    "arn:aws:iam::{account}:policy/IncidentTriageDemoInventoryReadDeny"
)
GATEWAY_API_NAME = "IncidentTriageDemoApp"

METRIC_NAMES = {
    "gateway": ("5xx", "Count", "Latency", "IntegrationLatency"),
    "lambda": ("Invocations", "Errors", "Throttles", "Duration", "ConcurrentExecutions"),
}
SENSITIVE_KEY = re.compile(
    r"(?:authorization|bearer|credential|password|secret|token|api.?key|access.?key|"
    r"session|environment|controller.?baseline|truth|\bcode\b|"
    r"code(?:sha(?:256)?|uri|location|signing)|source.?zip)",
    re.IGNORECASE,
)
SENSITIVE_VALUE = re.compile(
    r"(?i)(bearer\s+|authorization\s*[:=]\s*|password\s*[:=]\s*|"
    r"secret\s*[:=]\s*|token\s*[:=]\s*)([^\s,;]+)"
)


class EvidenceTools:
    """Allowlisted source readers and private per-run source capture.

    ``charge_tool_call`` is deliberately supplied by the Runtime owner.  It is
    called once, before validation or source access, for every decorated tool
    invocation.  Capture methods are not model-facing and do not consume that
    budget.
    """

    def __init__(
        self,
        session: Any,
        *,
        account_id: str,
        region: str,
        app_http_api_id: str,
        source_bucket: str,
        source_prefix: str,
        run_id: str,
        alarm_arn: str,
        transition_at: str,
        started_at: str,
        deadline_monotonic: float,
        charge_tool_call: Callable[[], Any],
    ) -> None:
        self.session = session
        self.account_id = str(account_id)
        self.region = str(region)
        self.app_http_api_id = str(app_http_api_id)
        self.source_bucket = str(source_bucket)
        prefix_parts = [
            self._safe_component(part)
            for part in str(source_prefix).split("/")
            if part not in {"", ".", ".."}
        ]
        self.source_prefix = "/".join(prefix_parts)
        self.run_id = self._safe_component(run_id)
        self.alarm_arn = str(alarm_arn)
        self.transition_at = str(transition_at)
        self.started_at = str(started_at)
        self.deadline_monotonic = float(deadline_monotonic)
        self.charge_tool_call = charge_tool_call
        self._query_results: list[dict[str, Any]] = []
        self._capture_metadata: dict[str, Any] = {}

    # ------------------------------------------------------------------
    # Public model-facing surface
    # ------------------------------------------------------------------

    def tools(self) -> list[Any]:
        """Return exactly the four Strands-decorated read tools."""

        return [
            self.search_logs,
            self.read_metrics,
            self.read_configuration,
            self.read_change_history,
        ]

    @tool
    def search_logs(
        self,
        resource: str = "all",
        start: str | None = None,
        end: str | None = None,
        query: str | None = None,
        limit: int = 100,
        service: str | None = None,
        window_start: str | None = None,
        window_end: str | None = None,
        window: Mapping[str, Any] | None = None,
        lookback_minutes: int | None = None,
        filter_pattern: str | None = None,
        operation: str | None = None,
        error: str | None = None,
    ) -> dict[str, Any]:
        """Search only the three application CloudWatch log groups."""

        self._begin_tool_call()
        start, end = self._window_aliases(start, end, window_start, window_end, window, lookback_minutes)
        window_value = self._validated_window(start, end)
        resources = self._log_resources(service or resource)
        if filter_pattern and re.search(r"^\s*(?:\{|\[.*[,=]|%|\?)", filter_pattern):
            raise ValueError("unsupported CloudWatch filter syntax; use literal terms or operation/error fields")
        literal_filter = self._safe_filter(" ".join(value for value in (query, filter_pattern) if value))
        filter_pattern = self._safe_filter(" ".join(value for value in (query, filter_pattern, operation, error) if value))
        bounded_limit = self._bounded_limit(limit)
        predicate = {
            "literal": literal_filter,
            "operation": self._safe_filter(operation),
            "error": self._safe_filter(error),
        }
        result = self._query_logs(resources, window_value, filter_pattern, bounded_limit, predicate=predicate)
        self._record_query_result("search_logs", result)
        return result

    @tool
    def read_metrics(
        self,
        resource: str = "all",
        start: str | None = None,
        end: str | None = None,
        period_seconds: int = 60,
        limit: int = 100,
        service: str | None = None,
        window_start: str | None = None,
        window_end: str | None = None,
        window: Mapping[str, Any] | None = None,
        metric: str | None = None,
        lookback_minutes: int | None = None,
    ) -> dict[str, Any]:
        """Read only the app Gateway and Lambda operational metrics."""

        self._begin_tool_call()
        start, end = self._window_aliases(start, end, window_start, window_end, window, lookback_minutes)
        window_value = self._validated_window(start, end)
        resources = self._metric_resources(service or resource)
        period = self._bounded_period(period_seconds)
        bounded_limit = self._bounded_limit(limit)
        metric_name = None if metric in (None, "", "inventory") else metric
        if metric_name is not None and not self._metric_name_allowed(resources, metric_name):
            raise ValueError(f"out-of-scope metric: {metric}")
        result = self._query_metrics(resources, window_value, period, bounded_limit, metric_name)
        self._record_query_result("read_metrics", result)
        return result

    @tool
    def read_configuration(
        self,
        resource: str = "all",
        target: str | None = None,
    ) -> dict[str, Any]:
        """Read sanitized app function and Inventory access configuration."""

        self._begin_tool_call()
        resources = self._configuration_resources(target or resource)
        self._check_deadline()
        result = self._query_configuration(resources)
        self._record_query_result("read_configuration", result)
        return result

    @tool
    def read_change_history(
        self,
        resource: str = "all",
        start: str | None = None,
        end: str | None = None,
        limit: int = 50,
        service: str | None = None,
        window_start: str | None = None,
        window_end: str | None = None,
        window: Mapping[str, Any] | None = None,
        lookback_minutes: int | None = None,
    ) -> dict[str, Any]:
        """Read ordinary bounded CloudTrail management events for app resources."""

        self._begin_tool_call()
        start, end = self._window_aliases(start, end, window_start, window_end, window, lookback_minutes)
        window_value = self._validated_window(start, end)
        resources = self._history_resources(service or resource)
        bounded_limit = self._bounded_limit(limit, maximum=50)
        result = self._query_change_history(resources, window_value, bounded_limit)
        self._record_query_result("read_change_history", result)
        return result

    # ------------------------------------------------------------------
    # Capture surface
    # ------------------------------------------------------------------

    def capture_baseline(self) -> dict[str, Any]:
        """Capture bounded source observations before model inference.

        Each source is attempted independently.  A failing source does not
        prevent the private capture object from being written with the other
        observations and an explicit gap.
        """

        captured_at = self._utc_now()
        gaps: list[str] = []
        observations: dict[str, Any] = {}
        window = self._baseline_window()
        source_queries = (
            ("logs", lambda: self._query_logs(tuple(LOG_GROUPS), window, None, MAX_ITEMS)),
            ("metrics", lambda: self._query_metrics(("gateway", "checkout", "inventory"), window, 60, MAX_ITEMS, None)),
            ("configuration", lambda: self._query_configuration(("checkout", "inventory"))),
            ("changeHistory", lambda: self._query_change_history(("gateway", "checkout", "inventory"), window, 50)),
        )
        for name, query in source_queries:
            try:
                self._check_deadline()
                observations[name] = query()
            except Exception as exc:  # capture remains useful when one provider is unavailable
                gaps.append(f"{name}: {self._safe_error(exc)}")
                observations[name] = self._unavailable(name, str(window[0]), str(window[1]), self._safe_error(exc))

        source_coverage: list[dict[str, Any]] = []
        for name, result in observations.items():
            completeness = result.get("completeness", "unavailable") if isinstance(result, Mapping) else "unavailable"
            source_coverage.append(
                {
                    "source": name,
                    "completeness": completeness,
                    "truncated": bool(result.get("truncated", False)) if isinstance(result, Mapping) else False,
                    "errors": result.get("errors", []) if isinstance(result, Mapping) else [],
                }
            )
            result_gaps = result.get("gaps", []) if isinstance(result, Mapping) else []
            result_errors = result.get("errors", []) if isinstance(result, Mapping) else []
            if completeness != "complete" or result_gaps or result_errors:
                details = list(result_gaps) + list(result_errors)
                gaps.append(f"{name}: " + ("; ".join(str(item) for item in details[:3]) if details else str(completeness)))

        payload = {
            "schemaVersion": 1,
            "runId": self.run_id,
            "alarmArn": self.alarm_arn,
            "transitionAt": self.transition_at,
            "startedAt": self.started_at,
            "capturedAt": captured_at,
            "window": {"start": window[0], "end": window[1]},
            "observations": observations,
            "gaps": gaps,
        }
        baseline_key = self._capture_key("baseline.json")
        write_error = self._write_json(baseline_key, payload)
        if write_error:
            gaps.append(f"capture write: {write_error}")
        completeness = "complete" if not gaps else "partial"
        if not observations:
            completeness = "unavailable"
        capture_ref = {
            "bucket": self.source_bucket,
            "prefix": self._run_prefix(),
            "manifestKey": baseline_key,
            "baselineKey": baseline_key,
            "capturedAt": captured_at,
            "coveredFrom": window[0],
            "coveredThrough": window[1],
            "configurationObservedAt": observations.get("configuration", {}).get("observedAt"),
            "completeness": completeness,
            "sources": source_coverage,
            "coverage": {source["source"]: source["completeness"] for source in source_coverage},
            "gaps": gaps,
        }
        self._capture_metadata = dict(capture_ref)
        return {"captureRef": capture_ref, "capturedAt": captured_at, "completeness": completeness, "complete": completeness == "complete", "gaps": gaps}

    def persist_query_results(self, results: Any) -> dict[str, Any]:
        """Persist actual sanitized model query results, safely after failure."""

        safe_results = self._normalize_query_results(results)
        self._query_results.extend(safe_results)
        key = self._capture_key("query-results.json")
        query_gaps: list[str] = []
        for item in self._query_results:
            result = item.get("result", {}) if isinstance(item, Mapping) else {}
            if isinstance(result, Mapping) and (
                result.get("completeness") != "complete" or result.get("truncated") or result.get("errors") or result.get("gaps")
            ):
                query_gaps.append(f"{item.get('tool', 'query')}: query result was partial or unavailable")
        payload = {
            "schemaVersion": 1,
            "runId": self.run_id,
            "alarmArn": self.alarm_arn,
            "transitionAt": self.transition_at,
            "capturedAt": self._utc_now(),
            "results": self._query_results,
        }
        error = self._write_json(key, payload)
        gaps = list(self._capture_metadata.get("gaps", [])) + query_gaps
        if error:
            gaps.append(f"query capture write: {error}")
        completeness = "complete" if not gaps and self._capture_metadata.get("completeness") == "complete" else "partial"
        capture_ref = {
            **self._capture_metadata,
            "bucket": self.source_bucket,
            "prefix": self._run_prefix(),
            "manifestKey": self._capture_key("baseline.json"),
            "baselineKey": self._capture_key("baseline.json"),
            "queryResultsKey": key,
            "completeness": completeness,
            "gaps": gaps,
        }
        return {
            "captureRef": capture_ref,
            "capturedAt": payload["capturedAt"],
            "persisted": error is None,
            "completeness": "complete" if error is None and not query_gaps else "partial",
            "complete": error is None,
            "gaps": [] if error is None else [f"query capture write: {error}"],
        }

    def collect_sources(
        self,
        start: str,
        end: str,
        *,
        limit: int = MAX_CAPTURE_RECORDS,
    ) -> dict[str, dict[str, Any]]:
        """Collect the four sanitized sources outside the model result bound.

        Operator export uses this path instead of changing ``_bound_result``
        on a live provider instance.  It retains the existing per-source page
        and byte limits while making the larger source-record budget explicit;
        decorated model calls continue to use ``MAX_ITEMS`` and 12 KiB.
        """

        bounded_limit = self._bounded_limit(limit, maximum=MAX_CAPTURE_RECORDS)
        window = self._validated_window(start, end)
        collectors: tuple[tuple[str, Callable[[], dict[str, Any]]], ...] = (
            ("logs", lambda: self._query_logs(tuple(LOG_GROUPS), window, None, bounded_limit)),
            ("metrics", lambda: self._query_metrics(("gateway", "checkout", "inventory"), window, 60, bounded_limit, None)),
            ("configuration", lambda: self._query_configuration(("checkout", "inventory"), bound=False)),
            ("changeHistory", lambda: self._query_change_history(("gateway", "checkout", "inventory"), window, bounded_limit)),
        )
        collected: dict[str, dict[str, Any]] = {}
        global_deadline = self.deadline_monotonic
        remaining_sources = len(collectors)
        for name, collector in collectors:
            now = time.monotonic()
            remaining = max(0.0, global_deadline - now)
            source_deadline = min(global_deadline, now + (remaining / max(1, remaining_sources)))
            try:
                if now >= global_deadline:
                    raise TimeoutError("source export deadline exceeded before collection")
                if name == "logs":
                    collected[name] = self._query_logs(
                        tuple(LOG_GROUPS), window, None, bounded_limit, deadline_monotonic=source_deadline
                    )
                else:
                    # Existing non-log collectors use the provider deadline
                    # directly. Temporarily narrowing it gives each source a
                    # fair acquisition slice while preserving the global
                    # deadline for the next source.
                    saved_deadline = self.deadline_monotonic
                    self.deadline_monotonic = source_deadline
                    try:
                        collected[name] = collector()
                    finally:
                        self.deadline_monotonic = saved_deadline
            except Exception as exc:
                if isinstance(exc, TimeoutError):
                    error = f"{name}: acquisition deadline slice expired before source completion"
                else:
                    error = self._safe_error(exc)
                unavailable = self._unavailable(name, *window, error)
                unavailable["scope"] = []
                if isinstance(exc, TimeoutError):
                    unavailable["gaps"] = [error]
                collected[name] = unavailable
            collected[name]["acquiredAt"] = self._utc_now()
            remaining_sources -= 1
        return collected

    # ------------------------------------------------------------------
    # Provider implementations
    # ------------------------------------------------------------------

    def _query_logs(
        self,
        resources: Sequence[str],
        window: tuple[str, str],
        filter_pattern: str | None,
        limit: int,
        *,
        predicate: Mapping[str, Any] | None = None,
        deadline_monotonic: float | None = None,
    ) -> dict[str, Any]:
        events: list[dict[str, Any]] = []
        errors: list[str] = []
        truncated = False
        start_ms, end_ms = self._epoch_ms(window[0]), self._epoch_ms(window[1])
        logs_client = self._client("logs")
        # Keep a bounded share for each selected group.  A busy Gateway must
        # not consume the entire response before the Inventory group is read.
        # The caller can still request a larger source bundle; the public
        # wrapper bounds the serialized model response separately.
        events_by_resource: dict[str, list[dict[str, Any]]] = {resource: [] for resource in resources}
        query_deadline = min(self.deadline_monotonic, deadline_monotonic) if deadline_monotonic is not None else self.deadline_monotonic
        remaining_groups = len(resources)
        for resource in resources:
            token: str | None = None
            resource_events = 0
            now = time.monotonic()
            group_remaining = max(0.0, query_deadline - now)
            group_deadline = min(query_deadline, now + (group_remaining / max(1, remaining_groups)))
            try:
                for _ in range(MAX_PAGES):
                    self._check_deadline()
                    if time.monotonic() >= group_deadline:
                        raise TimeoutError("log-group acquisition deadline slice expired")
                    request: dict[str, Any] = {
                        "logGroupName": LOG_GROUPS[resource],
                        "startTime": start_ms,
                        "endTime": end_ms,
                        "limit": min(limit, 100),
                    }
                    if token:
                        request["nextToken"] = token
                    try:
                        response = logs_client.filter_log_events(**request)
                    except Exception as exc:
                        errors.append(f"{resource}: {self._safe_error(exc)}")
                        break
                    raw_events = response.get("events", []) if isinstance(response, Mapping) else []
                    for event in raw_events:
                        if resource_events >= limit:
                            truncated = True
                            break
                        projected = self._project_log_event(event, resource)
                        if projected and self._matches_log_filter(projected, filter_pattern, predicate):
                            events_by_resource[resource].append(projected)
                            resource_events += 1
                    token = response.get("nextToken") if isinstance(response, Mapping) else None
                    if resource_events >= limit:
                        if token:
                            truncated = True
                        break
                    if not token:
                        break
                else:
                    truncated = True
            except TimeoutError:
                errors.append(f"{resource}: log-group acquisition deadline slice expired")
                truncated = True
            remaining_groups -= 1
        # Interleave groups before applying the model byte bound so a large
        # Gateway response cannot hide all Checkout/Inventory observations.
        events = []
        for index in range(limit):
            for resource in resources:
                group = events_by_resource[resource]
                if index < len(group):
                    events.append(group[index])
        if len(events) > limit:
            truncated = True
            events = events[:limit]
        if len(events) > MAX_SANITIZED_ITEMS:
            events = events[:MAX_SANITIZED_ITEMS]
            truncated = True
        observed_at = self._utc_now()
        return self._result(
            source="logs",
            scope=list(resources),
            query={"filter": filter_pattern} if filter_pattern else {},
            window=window,
            observed_at=observed_at,
            observations=events,
            errors=errors,
            truncated=truncated,
            bound=limit <= MAX_ITEMS,
        )

    def _query_metrics(
        self,
        resources: Sequence[str],
        window: tuple[str, str],
        period: int,
        limit: int,
        metric_name: str | None = None,
    ) -> dict[str, Any]:
        errors: list[str] = []
        metric_results: list[dict[str, Any]] = []
        start_at, end_at = window
        queries: list[dict[str, Any]] = []
        for resource in resources:
            if resource == "gateway":
                namespace = "AWS/ApiGateway"
                dimensions = [
                    {"Name": "ApiId", "Value": self.app_http_api_id},
                    {"Name": "Stage", "Value": "$default"},
                ]
                names = METRIC_NAMES["gateway"]
            else:
                namespace = "AWS/Lambda"
                function = CHECKOUT_FUNCTION if resource == "checkout" else INVENTORY_FUNCTION
                dimensions = [{"Name": "FunctionName", "Value": function}]
                names = METRIC_NAMES["lambda"]
            selected_names = (metric_name,) if metric_name else names
            for index, selected_metric in enumerate(selected_names):
                queries.append(
                    {
                        "Id": f"{resource[:4]}{index}",
                        "MetricStat": {
                            "Metric": {
                                "Namespace": namespace,
                                "MetricName": selected_metric,
                                "Dimensions": dimensions,
                            },
                            "Period": period,
                            "Stat": (
                                "Maximum" if selected_metric == "ConcurrentExecutions"
                                else "Average" if selected_metric in {"Latency", "IntegrationLatency", "Duration"}
                                else "Sum"
                            ),
                        },
                        "ReturnData": True,
                    }
                )
        client = self._client("cloudwatch")
        token: str | None = None
        for _ in range(MAX_PAGES):
            self._check_deadline()
            request: dict[str, Any] = {
                "MetricDataQueries": queries,
                "StartTime": self._datetime(start_at),
                "EndTime": self._datetime(end_at),
                "ScanBy": "TimestampDescending",
            }
            if token:
                request["NextToken"] = token
            try:
                response = client.get_metric_data(**request)
            except Exception as exc:
                errors.append(self._safe_error(exc))
                break
            raw = response.get("MetricDataResults", []) if isinstance(response, Mapping) else []
            for item in raw:
                if len(metric_results) >= limit:
                    break
                projected = self._project_metric(item)
                if projected:
                    metric_results.append(projected)
            token = response.get("NextToken") if isinstance(response, Mapping) else None
            if len(metric_results) >= limit:
                break
            if not token:
                break
        truncated = bool(token) or len(metric_results) >= limit
        observed_at = self._utc_now()
        return self._result(
            source="cloudwatch",
            scope=list(resources),
            query={
                "metrics": [
                    {"Id": item["Id"], "MetricStat": item["MetricStat"]}
                    for item in queries
                ],
                "periodSeconds": period,
            },
            window=window,
            observed_at=observed_at,
            observations=metric_results,
            errors=errors,
            truncated=truncated,
            bound=limit <= MAX_ITEMS,
        )

    def _query_configuration(self, resources: Sequence[str], *, bound: bool = True) -> dict[str, Any]:
        errors: list[str] = []
        observations: list[dict[str, Any]] = []
        for resource in resources:
            if resource in {"checkout", "inventory"}:
                function = CHECKOUT_FUNCTION if resource == "checkout" else INVENTORY_FUNCTION
                current: dict[str, Any] | None = None
                try:
                    current = self._read_function_configuration(function)
                    observations.append(current)
                except Exception as exc:
                    errors.append(f"{resource}: {self._safe_error(exc)}")
                if resource == "inventory":
                    role_access: dict[str, list[dict[str, Any]]] = {}
                    inventory_access: list[dict[str, Any]] = []
                    try:
                        access, _ = self._read_inventory_access(current, role_access)
                        inventory_access = access
                    except Exception as exc:
                        errors.append(f"inventory access: {self._safe_error(exc)}")
                    version_observations: list[dict[str, Any]] = []
                    other_role_access: list[dict[str, Any]] = []
                    try:
                        version_observations, other_role_access, version_errors, version_truncated = self._read_inventory_versions(
                            current, role_access
                        )
                        errors.extend(version_errors)
                        if version_truncated:
                            errors.append("inventory versions: source page or record cap reached")
                    except Exception as exc:
                        errors.append(f"inventory versions: {self._safe_error(exc)}")
                    # Keep the active and best compatible alternative plus
                    # policy evidence ahead of older versions in the result.
                    observations.extend(version_observations[:2])
                    observations.extend(inventory_access)
                    observations.extend(other_role_access)
                    observations.extend(version_observations[2:])
        for observation in observations:
            if isinstance(observation, Mapping) and observation.get("error"):
                errors.append(str(observation["error"]))
            concurrency = observation.get("concurrency") if isinstance(observation, Mapping) else None
            if isinstance(concurrency, Mapping) and concurrency.get("unavailable"):
                errors.append(f"{observation.get('function', 'Lambda')} concurrency: {concurrency['unavailable']}")
        # ``observedAt`` is an acquisition/availability bound.  Capture it
        # after all provider reads, never at the beginning of a slow read.
        observed_at = self._utc_now()
        return self._result(
            source="configuration",
            scope=list(resources),
            query={"view": "current", "referenceTransitionAt": self.transition_at},
            window=(observed_at, observed_at),
            observed_at=observed_at,
            observations=observations,
            errors=errors,
            truncated=False,
            bound=bound,
        )

    def _read_function_configuration(self, function: str) -> dict[str, Any]:
        lambda_client = self._client("lambda")
        alias = lambda_client.get_alias(FunctionName=function, Name="live")
        version = str(alias.get("FunctionVersion", ""))
        configuration_request: dict[str, Any] = {"FunctionName": function}
        if version:
            configuration_request["Qualifier"] = version
        configuration = lambda_client.get_function_configuration(**configuration_request)
        try:
            concurrency = lambda_client.get_function_concurrency(FunctionName=function)
        except Exception as exc:
            concurrency = {"unavailable": self._safe_error(exc)}
        projected_configuration = self._project_function_config(configuration)
        code_digest = self._hex_digest(configuration.get("CodeSha256"))
        if code_digest:
            projected_configuration["artifactSha256"] = code_digest
        description = configuration.get("Description")
        if isinstance(description, str) and re.fullmatch(r"[0-9a-fA-F]{40}", description.strip()):
            projected_configuration["sourceRevision"] = description.strip()
        output: dict[str, Any] = {
            "kind": "lambda",
            "function": function,
            "alias": self._project_alias(alias),
            "configuration": projected_configuration,
            "concurrency": self._project_concurrency(concurrency),
        }
        return output

    def _read_inventory_access(
        self,
        current: Mapping[str, Any] | None = None,
        role_access: dict[str, list[dict[str, Any]]] | None = None,
    ) -> tuple[list[dict[str, Any]], str | None]:
        outputs: list[dict[str, Any]] = []
        # The exact inventory table policy read is part of the access diagnosis.
        # PolicyNotFoundException is a known absent policy; other provider errors
        # remain visible and make configuration coverage partial.
        table_arn = INVENTORY_TABLE_ARN_TEMPLATE.format(region=self.region, account=self.account_id)
        try:
            table_client = self._client("dynamodb")
            table_policy = table_client.get_resource_policy(ResourceArn=table_arn)
            outputs.append({"kind": "dynamodb-resource-policy", "table": INVENTORY_TABLE, "tableArn": table_arn, "policyStatus": "present", "policy": self._project_policy(table_policy)})
        except ClientError as exc:
            code = (exc.response.get("Error") or {}).get("Code")
            if code == "PolicyNotFoundException":
                outputs.append({"kind": "dynamodb-resource-policy", "table": INVENTORY_TABLE, "tableArn": table_arn, "policyStatus": "absent"})
            else:
                outputs.append({"kind": "dynamodb-resource-policy", "table": INVENTORY_TABLE, "tableArn": table_arn, "error": self._safe_error(exc)})
        except Exception as exc:
            outputs.append({"kind": "dynamodb-resource-policy", "table": INVENTORY_TABLE, "tableArn": table_arn, "error": self._safe_error(exc)})

        configuration = current.get("configuration", {}) if isinstance(current, Mapping) else {}
        role_arn = str(configuration.get("Role", ""))
        role_name = role_arn.rsplit("/", 1)[-1]
        if role_name not in INVENTORY_ROLE_NAMES:
            # Do not follow arbitrary role values returned by a provider.
            raise ValueError("Inventory execution role is outside the configured app roles")
        cache = role_access if role_access is not None else {}
        if role_name not in cache:
            cache[role_name] = self._read_inventory_role_access(role_name)
        outputs.extend(cache[role_name])
        return outputs, role_name

    def _read_inventory_versions(
        self,
        current: Mapping[str, Any] | None = None,
        role_access: dict[str, list[dict[str, Any]]] | None = None,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str], bool]:
        """Read ordinary published Inventory alternatives and related policy.

        This intentionally follows only the fixed Inventory function and the
        two application-owned roles.  ``$LATEST`` and arbitrary role values do
        not become model-facing alternatives.  Pagination is finite and a
        missing release or code digest remains an explicit observation error.
        """

        lambda_client = self._client("lambda")
        errors: list[str] = []
        marker: str | None = None
        truncated = False
        seen_versions: set[str] = set()
        versions: list[Mapping[str, Any]] = []
        for _ in range(MAX_PAGES):
            self._check_deadline()
            request: dict[str, Any] = {"FunctionName": INVENTORY_FUNCTION}
            if marker:
                request["Marker"] = marker
            try:
                response = lambda_client.list_versions_by_function(**request)
            except Exception as exc:
                errors.append(self._safe_error(exc))
                break
            raw_versions = response.get("Versions", []) if isinstance(response, Mapping) else []
            for version in raw_versions if isinstance(raw_versions, list) else []:
                if isinstance(version, Mapping):
                    versions.append(version)
            marker = response.get("NextMarker") if isinstance(response, Mapping) else None
            if not marker:
                break
        else:
            if marker:
                truncated = True

        # Read both fixed roles exactly once, even when the bounded version
        # pages contain no admissible numeric alternatives.  This gives the
        # caller an honest policy gap instead of inferring access from a role
        # ARN or an empty version page.
        cache = role_access if role_access is not None else {}
        role_observations: list[dict[str, Any]] = []
        for role_name in sorted(INVENTORY_ROLE_NAMES):
            self._check_deadline()
            if role_name in cache:
                continue
            try:
                cache[role_name] = self._read_inventory_role_access(role_name)
            except Exception as exc:
                errors.append(f"role {role_name}: {self._safe_error(exc)}")
                cache[role_name] = [{"kind": "iam-role", "roleName": role_name, "error": self._safe_error(exc)}]
            role_observations.extend(cache[role_name])

        active_configuration = current.get("configuration", {}) if isinstance(current, Mapping) else {}
        active_alias = current.get("alias", {}) if isinstance(current, Mapping) else {}
        active_version = str(
            active_configuration.get("Version", active_alias.get("FunctionVersion", ""))
            if isinstance(active_configuration, Mapping) and isinstance(active_alias, Mapping)
            else ""
        )
        active_memory = active_configuration.get("MemorySize") if isinstance(active_configuration, Mapping) else None
        active_role = str(active_configuration.get("Role", "")) if isinstance(active_configuration, Mapping) else ""
        active_role_name = active_role.rsplit("/", 1)[-1]
        active_digest = str(active_configuration.get("artifactSha256", "")) if isinstance(active_configuration, Mapping) else ""
        active_release = str(active_configuration.get("sourceRevision", "")) if isinstance(active_configuration, Mapping) else ""
        if not active_release and isinstance(active_alias, Mapping):
            active_release = str(active_alias.get("Description", ""))
        candidates: list[tuple[tuple[bool, bool, bool, bool, bool, int], dict[str, Any]]] = []
        invalid_versions = 0
        for version in versions:
            number = str(version.get("Version", ""))
            if not re.fullmatch(r"[1-9][0-9]*", number) or number in seen_versions:
                continue
            role_arn = str(version.get("Role", ""))
            if not role_arn:
                continue
            role_name = role_arn.rsplit("/", 1)[-1]
            if role_name not in INVENTORY_ROLE_NAMES:
                invalid_versions += 1
                continue
            projected = self._project_published_version(version, role_name)
            configuration = projected.get("configuration", {})
            release = str(configuration.get("sourceRevision", ""))
            digest = str(configuration.get("artifactSha256", ""))
            if not re.fullmatch(r"[0-9a-fA-F]{40}", release) or not re.fullmatch(r"[0-9a-fA-F]{64}", digest):
                invalid_versions += 1
                continue
            seen_versions.add(number)
            memory = configuration.get("MemorySize")
            score = (
                number == active_version,
                bool(active_release and active_release == release),
                bool(active_digest and digest == active_digest),
                active_memory is not None and memory == active_memory,
                bool(active_role_name and role_name != active_role_name),
                int(number),
            )
            candidates.append((score, projected))
        candidates.sort(key=lambda item: item[0], reverse=True)
        numeric_versions = {str(item.get("Version", "")) for item in versions}
        if active_version and active_version not in numeric_versions:
            errors.append("active Inventory version was not found within the bounded version pages")
        if invalid_versions:
            errors.append(f"{invalid_versions} published Inventory versions lacked a valid fixed-role, release, or code identity")

        # Current-compatible candidates come first; only then apply the
        # bounded model-result observation budget.  Fixed-role policy records
        # above remain available independently of archived version count.
        if len(candidates) > MAX_ITEMS:
            truncated = True
        return [projected for _, projected in candidates[:MAX_ITEMS]], role_observations, errors, truncated

    def _project_published_version(self, version: Mapping[str, Any], role_name: str) -> dict[str, Any]:
        configuration: dict[str, Any] = {
            key: version[key]
            for key in ("FunctionName", "Version", "Role", "MemorySize", "Timeout", "LastModified", "Architectures")
            if key in version
        }
        description = version.get("Description")
        if isinstance(description, str) and description.strip():
            release = description.strip()
            if re.fullmatch(r"[0-9a-fA-F]{40}", release):
                configuration["sourceRevision"] = release
            else:
                configuration.setdefault("errors", []).append("published description was not a 40-hex release identifier")
        else:
            configuration.setdefault("errors", []).append("published description did not establish a release identifier")

        code_sha = version.get("CodeSha256")
        artifact_sha = self._hex_digest(code_sha)
        if artifact_sha is None:
            configuration.setdefault("errors", []).append("published code metadata did not establish a SHA-256 digest")
        else:
            configuration["artifactSha256"] = artifact_sha
        return {
            "kind": "lambda-version",
            "function": INVENTORY_FUNCTION,
            "roleName": role_name,
            "configuration": configuration,
        }

    @staticmethod
    def _hex_digest(value: Any) -> str | None:
        if not isinstance(value, str):
            return None
        try:
            raw = base64.b64decode(value, validate=True)
        except (ValueError, TypeError):
            return None
        return raw.hex() if len(raw) == 32 else None

    def _read_inventory_role_access(self, role_name: str) -> list[dict[str, Any]]:
        iam_client = self._client("iam")
        outputs: list[dict[str, Any]] = []
        role = iam_client.get_role(RoleName=role_name)
        outputs.append({"kind": "iam-role", "role": self._project_role(role)})
        try:
            names: list[str] = []
            marker: str | None = None
            inline_truncated = False
            for _ in range(MAX_PAGES):
                self._check_deadline()
                request: dict[str, Any] = {"RoleName": role_name}
                if marker:
                    request["Marker"] = marker
                inline = iam_client.list_role_policies(**request)
                names.extend(str(name) for name in (inline.get("PolicyNames", []) if isinstance(inline, Mapping) else []))
                marker = self._iam_page_marker(inline)
                if not marker:
                    break
            else:
                inline_truncated = bool(marker)
            relevant_names = [name for name in names if self._is_inventory_policy_name(name)]
            outputs.append({"kind": "iam-inline-policy-names", "roleName": role_name, "policyNames": self._bounded_strings(relevant_names)})
            if inline_truncated:
                outputs.append({"kind": "iam-inline-policies", "roleName": role_name, "error": "policy-name pagination reached the bounded page limit"})
            for policy_name in relevant_names[:20]:
                self._check_deadline()
                document = iam_client.get_role_policy(RoleName=role_name, PolicyName=policy_name)
                outputs.append({"kind": "iam-inline-policy", "roleName": role_name, "policyName": policy_name, "document": self._project_policy(document)})
        except Exception as exc:
            outputs.append({"kind": "iam-inline-policies", "roleName": role_name, "error": self._safe_error(exc)})
        try:
            attached_items: list[Any] = []
            marker = None
            attached_truncated = False
            for _ in range(MAX_PAGES):
                self._check_deadline()
                request = {"RoleName": role_name}
                if marker:
                    request["Marker"] = marker
                attached = iam_client.list_attached_role_policies(**request)
                attached_items.extend(attached.get("AttachedPolicies", []) if isinstance(attached, Mapping) else [])
                marker = self._iam_page_marker(attached)
                if not marker:
                    break
            else:
                attached_truncated = bool(marker)
            attached_policies = [
                item for item in attached_items
                if isinstance(item, Mapping) and self._is_inventory_policy_name(str(item.get("PolicyName", "")))
            ]
            outputs.append({"kind": "iam-attached-policy-names", "roleName": role_name, "policies": self._project_attached_policies(attached_policies)})
            if attached_truncated:
                outputs.append({"kind": "iam-attached-policies", "roleName": role_name, "error": "attached-policy pagination reached the bounded page limit"})
            for policy in attached_policies:
                if str(policy.get("PolicyName", "")) != INVENTORY_DENY_POLICY_NAME:
                    continue
                policy_arn = str(policy.get("PolicyArn", ""))
                expected_arn = INVENTORY_DENY_POLICY_ARN_TEMPLATE.format(account=self.account_id)
                if policy_arn != expected_arn:
                    outputs.append({"kind": "iam-deny-policy", "error": "configured Inventory deny policy ARN did not match"})
                    continue
                self._check_deadline()
                metadata = iam_client.get_policy(PolicyArn=policy_arn)
                default_version = metadata.get("Policy", {}).get("DefaultVersionId")
                if default_version:
                    self._check_deadline()
                    version_response = iam_client.get_policy_version(PolicyArn=policy_arn, VersionId=default_version)
                    outputs.append({"kind": "iam-deny-policy", "policyArn": policy_arn, "defaultVersionId": default_version, "document": self._project_policy(version_response)})
        except Exception as exc:
            outputs.append({"kind": "iam-attached-policies", "roleName": role_name, "error": self._safe_error(exc)})
        return outputs

    @staticmethod
    def _is_inventory_policy_name(name: str) -> bool:
        value = str(name).lower()
        return any(token in value for token in ("inventory", "dynamodb"))

    @staticmethod
    def _iam_page_marker(response: Any) -> str | None:
        """Read the bounded IAM list response marker without guessing pages."""

        if not isinstance(response, Mapping):
            return None
        if response.get("IsTruncated"):
            marker = response.get("Marker") or response.get("NextMarker")
            return str(marker) if marker else None
        return None

    def _query_change_history(
        self,
        resources: Sequence[str],
        window: tuple[str, str],
        limit: int,
    ) -> dict[str, Any]:
        events: list[dict[str, Any]] = []
        errors: list[str] = []
        truncated = False
        client = self._client("cloudtrail")
        # CloudTrail LookupEvents accepts one resource name per request.  Keep
        # the set small and use only ordinary app resource identifiers.
        resource_names = self._history_resource_names(resources)
        for resource_name in resource_names:
            token: str | None = None
            for _ in range(MAX_PAGES):
                self._check_deadline()
                request: dict[str, Any] = {
                    "LookupAttributes": [{"AttributeKey": "ResourceName", "AttributeValue": resource_name}],
                    "StartTime": self._datetime(window[0]),
                    "EndTime": self._datetime(window[1]),
                    "MaxResults": min(limit, 50),
                }
                if token:
                    request["NextToken"] = token
                try:
                    response = client.lookup_events(**request)
                except Exception as exc:
                    errors.append(f"{resource_name}: {self._safe_error(exc)}")
                    break
                raw_events = response.get("Events", []) if isinstance(response, Mapping) else []
                for event in raw_events:
                    if len(events) >= limit:
                        break
                    projected = self._project_cloudtrail_event(event)
                    if projected:
                        projected["lookupResource"] = resource_name
                        events.append(projected)
                token = response.get("NextToken") if isinstance(response, Mapping) else None
                if len(events) >= limit or not token:
                    break
            else:
                if token:
                    truncated = True
            if len(events) >= limit:
                truncated = True
                break
        observed_at = self._utc_now()
        return self._result(
            source="cloudtrail",
            scope=list(resources),
            query={"attribute": "ResourceName", "resources": resource_names},
            window=window,
            observed_at=observed_at,
            observations=events,
            errors=errors,
            truncated=truncated,
            bound=limit <= MAX_ITEMS,
        )

    # ------------------------------------------------------------------
    # Validation, time, and result helpers
    # ------------------------------------------------------------------

    def _begin_tool_call(self) -> None:
        # Charge exactly once even when validation rejects the model request.
        self.charge_tool_call()
        self._check_deadline()

    def _check_deadline(self) -> None:
        if time.monotonic() >= self.deadline_monotonic:
            raise TimeoutError("evidence tool deadline exceeded")

    def _validated_window(self, start: str | None, end: str | None) -> tuple[str, str]:
        if start is None and end is None:
            end_at = self._parse_time(self.transition_at)
            start_at = end_at - timedelta(minutes=10)
        elif start is None or end is None:
            raise ValueError("start and end must be supplied together")
        else:
            start_at, end_at = self._parse_time(start), self._parse_time(end)
        if end_at <= start_at:
            raise ValueError("evidence window end must be after start")
        if (end_at - start_at).total_seconds() > MAX_WINDOW_SECONDS:
            raise ValueError("evidence window cannot exceed 30 minutes")
        return self._iso(start_at), self._iso(end_at)

    def _baseline_window(self) -> tuple[str, str]:
        try:
            return self._validated_window(None, None)
        except Exception:
            now = self._parse_time(self.started_at)
            return self._iso(now - timedelta(minutes=10)), self._iso(now)

    @staticmethod
    def _parse_time(value: Any) -> datetime:
        if isinstance(value, datetime):
            parsed = value
        elif isinstance(value, (int, float)):
            parsed = datetime.fromtimestamp(value, timezone.utc)
        else:
            text = str(value).strip()
            if text.endswith("Z"):
                text = text[:-1] + "+00:00"
            parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)

    @classmethod
    def _iso(cls, value: datetime) -> str:
        return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    @classmethod
    def _datetime(cls, value: str) -> datetime:
        return cls._parse_time(value)

    @classmethod
    def _epoch_ms(cls, value: str) -> int:
        return int(cls._parse_time(value).timestamp() * 1000)

    @staticmethod
    def _bounded_limit(value: int, maximum: int = MAX_ITEMS) -> int:
        try:
            number = int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError("limit must be an integer") from exc
        if number < 1:
            raise ValueError("limit must be positive")
        return min(number, maximum)

    @staticmethod
    def _bounded_period(value: int) -> int:
        try:
            period = int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError("period_seconds must be an integer") from exc
        if period < 1 or period > MAX_WINDOW_SECONDS:
            raise ValueError("period_seconds must be between 1 and 1800")
        return period

    @staticmethod
    def _safe_component(value: Any) -> str:
        text = re.sub(r"[^A-Za-z0-9._=-]+", "-", str(value)).strip("-.")
        return text[:128] or "run"

    def _log_resources(self, resource: str) -> tuple[str, ...]:
        return self._resources(resource, tuple(LOG_GROUPS), "log resource")

    def _metric_resources(self, resource: str) -> tuple[str, ...]:
        return self._resources(resource, ("gateway", "checkout", "inventory"), "metric resource")

    def _configuration_resources(self, resource: str) -> tuple[str, ...]:
        resource = {
            CHECKOUT_FUNCTION.lower(): "checkout",
            INVENTORY_FUNCTION.lower(): "inventory",
            "inventory_table": "inventory",
            "inventory_policy": "inventory",
            "inventory_role": "inventory",
            "table": "inventory",
            "policy": "inventory",
            "role": "inventory",
        }.get(str(resource).strip().lower(), resource)
        return self._resources(resource, ("checkout", "inventory"), "configuration resource")

    def _history_resources(self, resource: str) -> tuple[str, ...]:
        return self._resources(resource, ("gateway", "checkout", "inventory"), "history resource")

    def _window_aliases(
        self,
        start: str | None,
        end: str | None,
        window_start: str | None,
        window_end: str | None,
        window: Mapping[str, Any] | None,
        lookback_minutes: int | None,
    ) -> tuple[str | None, str | None]:
        if start is None:
            start = window_start
        if end is None:
            end = window_end
        if isinstance(window, Mapping):
            if start is None:
                start = window.get("start", window.get("from"))
            if end is None:
                end = window.get("end", window.get("to"))
        if start is None and end is None and lookback_minutes is not None:
            try:
                minutes = int(lookback_minutes)
            except (TypeError, ValueError) as exc:
                raise ValueError("lookback_minutes must be an integer") from exc
            if minutes <= 0:
                raise ValueError("lookback_minutes must be positive")
            end_at = self._parse_time(self.transition_at)
            start = self._iso(end_at - timedelta(minutes=minutes))
            end = self._iso(end_at)
        return start, end

    @staticmethod
    def _metric_name_allowed(resources: Sequence[str], metric: str) -> bool:
        if len(resources) == 1 and resources[0] == "gateway":
            return metric in METRIC_NAMES["gateway"]
        if len(resources) == 1 and resources[0] in {"checkout", "inventory"}:
            return metric in METRIC_NAMES["lambda"]
        return metric in set(METRIC_NAMES["gateway"]) | set(METRIC_NAMES["lambda"])

    @staticmethod
    def _resources(resource: str, allowed: Sequence[str], label: str) -> tuple[str, ...]:
        value = str(resource).strip().lower()
        if value == "all":
            return tuple(allowed)
        for name, log_group in LOG_GROUPS.items():
            if value == log_group.lower():
                value = name
                break
        value = {
            CHECKOUT_FUNCTION.lower(): "checkout",
            INVENTORY_FUNCTION.lower(): "inventory",
            GATEWAY_API_NAME.lower(): "gateway",
        }.get(value, value)
        aliases = {"api": "gateway", "apigateway": "gateway", "lambda-checkout": "checkout", "lambda-inventory": "inventory"}
        value = aliases.get(value, value)
        if value not in allowed:
            raise ValueError(f"out-of-scope {label}: {resource}")
        return (value,)

    @staticmethod
    def _safe_filter(value: str | None) -> str | None:
        if value is None:
            return None
        text = str(value).strip()
        if not text:
            return None
        if len(text) > 256:
            raise ValueError("log query is too long")
        if re.search(r"controller|orders|secret|credential|environment|baseline|truth", text, re.IGNORECASE):
            raise ValueError("log query contains an out-of-scope resource or private field")
        return text

    @staticmethod
    def _matches_log_filter(
        event: Mapping[str, Any],
        filter_pattern: str | None,
        predicate: Mapping[str, Any] | None = None,
    ) -> bool:
        """Apply the portable literal portion of a log predicate locally.

        CloudWatch's filter-pattern language is not available to captured
        providers (and fake/read-only boundaries need not implement it).  The
        public contract therefore treats supplied terms as literals: every
        whitespace-delimited term must occur in the projected, sanitized event.
        Structured ``operation``/``error`` predicates are passed through the
        same representation by the live and captured readers.  This keeps a
        prefixed Lambda JSON record queryable without leaking its raw message.
        """

        rendered = json.dumps(event, ensure_ascii=False, sort_keys=True, default=str).casefold()
        if predicate:
            literal = predicate.get("literal")
            terms = [term.casefold() for term in str(literal).split() if term] if literal else []
            if not all(term in rendered for term in terms):
                return False
            fields = event.get("fields")
            if not isinstance(fields, Mapping):
                fields = {}
            operation = predicate.get("operation")
            if operation and str(fields.get("operation", "")).casefold() != str(operation).casefold():
                return False
            error = predicate.get("error")
            if error:
                error_fields = ("errorName", "errorCode", "error", "dependencyErrorName", "dependencyFailureReason")
                if not any(str(fields.get(key, "")).casefold() == str(error).casefold() for key in error_fields):
                    return False
            return True
        if not filter_pattern:
            return True
        terms = [term.casefold() for term in str(filter_pattern).split() if term]
        return all(term in rendered for term in terms)

    def _history_resource_names(self, resources: Sequence[str]) -> tuple[str, ...]:
        names: list[str] = []
        if "gateway" in resources:
            names.append(GATEWAY_API_NAME)
        if "checkout" in resources:
            names.append(CHECKOUT_FUNCTION)
        if "inventory" in resources:
            names.extend((INVENTORY_FUNCTION, INVENTORY_TABLE))
        return tuple(dict.fromkeys(names))

    # ------------------------------------------------------------------
    # Projections and bounded serialization
    # ------------------------------------------------------------------

    def _result(
        self,
        *,
        source: str,
        scope: Any,
        query: Any,
        window: tuple[str, str],
        observed_at: str,
        observations: Any,
        errors: Sequence[str],
        truncated: bool,
        bound: bool = True,
    ) -> dict[str, Any]:
        result: dict[str, Any] = {
            "source": source,
            "scope": scope,
            "query": query,
            "window": {"start": window[0], "end": window[1]},
            "observedAt": observed_at,
            "completeness": "partial" if errors or truncated else "complete",
            "truncated": bool(truncated),
            "errors": list(errors),
        }
        if observations:
            result["observations"] = observations
        elif errors:
            result["gaps"] = ["source did not provide an observation"]
        result = self._sanitize(result)
        return self._bound_result(result) if bound else result

    @staticmethod
    def _unavailable(source: str, start: str, end: str, error: str) -> dict[str, Any]:
        return {
            "source": source,
            "scope": "configured application sources",
            "query": {},
            "window": {"start": start, "end": end},
            "observedAt": EvidenceTools._utc_now(),
            "completeness": "unavailable",
            "truncated": False,
            "errors": [error],
            "gaps": ["source did not provide an observation"],
        }

    def _bound_result(self, result: dict[str, Any]) -> dict[str, Any]:
        encoded = self._json_bytes(result)
        if len(encoded) <= RESULT_TARGET_BYTES:
            return result
        observations = result.get("observations")
        if isinstance(observations, list):
            # Halve repeatedly so large logs/metrics converge quickly while
            # preserving returned records and explicit truncation. A single
            # oversized policy/record is omitted with an explicit gap rather
            # than making no progress or blocking the Runtime.
            while observations and len(self._json_bytes(result)) > RESULT_TARGET_BYTES:
                if len(observations) > 1:
                    observations[:] = observations[: len(observations) // 2]
                else:
                    observations.clear()
                    result.setdefault("gaps", []).append("one observation exceeded the model result size bound and was omitted")
                    result.setdefault("errors", []).append("one observation exceeded the model result size bound")
                    break
            result["truncated"] = True
            result["completeness"] = "partial"
        encoded = self._json_bytes(result)
        if len(encoded) <= RESULT_TARGET_BYTES:
            return result
        # Last-resort projection retains the required provenance fields and an
        # explicit gap rather than silently dropping evidence.
        compact = {
            key: result.get(key)
            for key in ("source", "scope", "query", "window", "observedAt", "acquiredAt", "referenceTime", "completeness", "truncated")
            if key in result
        }
        compact["truncated"] = True
        compact["completeness"] = "partial"
        compact["errors"] = ["result payload was bounded before returning"]
        compact["errors"].extend(str(item)[:512] for item in result.get("errors", [])[:2])
        compact["gaps"] = [str(item)[:512] for item in result.get("gaps", [])[:2]]
        if len(self._json_bytes(compact)) > RESULT_TARGET_BYTES:
            compact["query"] = {}
        return compact

    @classmethod
    def _json_bytes(cls, value: Any) -> bytes:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")

    def _record_query_result(self, name: str, result: Mapping[str, Any]) -> None:
        self._query_results.append({"tool": name, "result": self._bound_result(dict(result))})

    def _normalize_query_results(self, results: Any) -> list[dict[str, Any]]:
        if isinstance(results, Mapping):
            values: Iterable[Any] = (results,)
        elif isinstance(results, Sequence) and not isinstance(results, (str, bytes, bytearray)):
            values = results
        else:
            values = (results,)
        normalized: list[dict[str, Any]] = []
        for value in values:
            safe = self._sanitize(value)
            if isinstance(safe, Mapping):
                item = dict(safe)
            else:
                item = {"value": safe}
            encoded = self._json_bytes(item)
            if len(encoded) > RESULT_TARGET_BYTES:
                item = {"value": "[bounded]", "truncated": True, "source": item.get("source", "unknown")}
            normalized.append(item)
        return normalized

    # ------------------------------------------------------------------
    # AWS projections
    # ------------------------------------------------------------------

    def _project_log_event(self, event: Any, resource: str) -> dict[str, Any] | None:
        if not isinstance(event, Mapping):
            return None
        output: dict[str, Any] = {"resource": resource}
        for key in ("timestamp", "ingestionTime", "eventId", "logStreamName"):
            if key in event:
                output[key] = event[key]
        message = event.get("message", "")
        structured: Any = None
        if isinstance(message, str):
            structured = self._decode_prefixed_json(message)
        if isinstance(structured, Mapping):
            fields: dict[str, Any] = {}
            for key, value in structured.items():
                if key not in LOG_MESSAGE_FIELDS or SENSITIVE_KEY.search(str(key)):
                    continue
                safe_value = self._sanitize(value, key=key)
                if key == "dependencyThrottleReason":
                    if not isinstance(safe_value, str) or safe_value not in LAMBDA_THROTTLE_REASONS:
                        continue
                if key in {"requestTimeEpoch", "status", "integrationStatus", "integrationError"}:
                    if not isinstance(safe_value, str):
                        continue
                    safe_value = safe_value[:256 if key == "integrationError" else 32]
                fields[key] = safe_value
            if fields:
                output["fields"] = fields
        elif message:
            # JSON records are field-projected above; only bounded ordinary
            # plaintext records pass through the token scrubber.
            output["message"] = self._scrub_text(message)[:1000]
        return output

    @staticmethod
    def _decode_prefixed_json(message: str) -> Any:
        """Decode a JSON object embedded after Lambda's text prefix.

        Lambda log lines commonly contain an ISO timestamp, level and logger
        prefix before the structured payload.  Decode only the first JSON
        value; raw text remains subject to the normal scrubber/projection.
        """

        text = message.strip()
        candidates = [index for index in (text.find("{"), text.find("[")) if index >= 0]
        if not candidates:
            return None
        start = min(candidates)
        try:
            value, _ = json.JSONDecoder().raw_decode(text[start:])
        except (json.JSONDecodeError, TypeError, ValueError):
            return None
        return value

    @staticmethod
    def _project_metric(item: Any) -> dict[str, Any] | None:
        if not isinstance(item, Mapping):
            return None
        output: dict[str, Any] = {}
        for key in ("Id", "Label", "Timestamps", "Values", "StatusCode", "Messages"):
            if key in item:
                output[key] = item[key]
        return output or None

    def _project_alias(self, item: Mapping[str, Any]) -> dict[str, Any]:
        return {key: item[key] for key in ("Name", "FunctionVersion", "RevisionId", "Description") if key in item}

    def _project_function_config(self, item: Mapping[str, Any]) -> dict[str, Any]:
        allowed = ("FunctionName", "Version", "Role", "RevisionId", "MemorySize", "Timeout", "LastModified", "State", "StateReason", "Architectures")
        return {key: item[key] for key in allowed if key in item}

    @staticmethod
    def _project_concurrency(item: Mapping[str, Any]) -> dict[str, Any]:
        if "ReservedConcurrentExecutions" in item:
            return {"ReservedConcurrentExecutions": item["ReservedConcurrentExecutions"]}
        if "unavailable" in item:
            return {"unavailable": item["unavailable"]}
        return {"state": "unreserved"}

    def _project_role(self, item: Mapping[str, Any]) -> dict[str, Any]:
        role = item.get("Role", item)
        if not isinstance(role, Mapping):
            return {}
        return {key: role[key] for key in ("RoleName", "Arn", "CreateDate", "RoleLastUsed", "MaxSessionDuration") if key in role}

    @staticmethod
    def _project_attached_policies(items: Any) -> list[dict[str, Any]]:
        output = []
        for item in items if isinstance(items, list) else []:
            if isinstance(item, Mapping):
                output.append({key: item[key] for key in ("PolicyName", "PolicyArn") if key in item})
        return output[:20]

    def _project_policy(self, item: Mapping[str, Any]) -> Any:
        policy: Any = item
        if "PolicyVersion" in item:
            policy = item["PolicyVersion"]
        if "Policy" in item:
            policy = item["Policy"]
        if "PolicyDocument" in item:
            policy = item["PolicyDocument"]
        if isinstance(policy, Mapping) and "Document" in policy:
            policy = policy["Document"]
        if isinstance(policy, str):
            try:
                policy = json.loads(unquote(policy))
            except (TypeError, ValueError):
                return {"document": "unavailable"}
        if not isinstance(policy, Mapping):
            return {}
        # Keep the exact policy semantics needed for the denied-read diagnosis,
        # while excluding unrelated metadata and identity/authentication data.
        output: dict[str, Any] = {}
        if "Version" in policy:
            output["Version"] = policy["Version"]
        statements = policy.get("Statement")
        if isinstance(statements, Mapping):
            statements = [statements]
        if isinstance(statements, list):
            projected = []
            for statement in statements:
                if not isinstance(statement, Mapping):
                    continue
                projected.append({key: self._sanitize(statement[key]) for key in ("Sid", "Effect", "Action", "Resource", "Condition") if key in statement})
            output["Statement"] = projected
        return output

    def _project_cloudtrail_event(self, event: Any) -> dict[str, Any] | None:
        if not isinstance(event, Mapping):
            return None
        output: dict[str, Any] = {}
        for key in ("EventId", "EventName", "EventSource", "EventTime", "ReadOnly"):
            if key in event:
                output[key] = event[key]
        resources = event.get("Resources")
        if isinstance(resources, list):
            output["Resources"] = [
                {key: item[key] for key in ("ResourceName", "ResourceType") if key in item}
                for item in resources
                if isinstance(item, Mapping) and self._is_app_resource(str(item.get("ResourceName", "")))
            ]
        return output or None

    @staticmethod
    def _is_app_resource(value: str) -> bool:
        return any(
            token in value
            for token in (
                CHECKOUT_FUNCTION,
                INVENTORY_FUNCTION,
                INVENTORY_TABLE,
                GATEWAY_API_NAME,
                "IncidentTriageDemoAppInventoryRole",
                "IncidentTriageDemoAppInventoryDeniedRole",
                INVENTORY_DENY_POLICY_NAME,
            )
        )

    # ------------------------------------------------------------------
    # Sanitization and S3 capture
    # ------------------------------------------------------------------

    @classmethod
    def _sanitize(cls, value: Any, *, key: str | None = None) -> Any:
        if key and SENSITIVE_KEY.search(str(key)):
            return "[redacted]"
        if isinstance(value, Mapping):
            return {str(k): cls._sanitize(v, key=str(k)) for k, v in value.items() if not SENSITIVE_KEY.search(str(k))}
        if isinstance(value, (list, tuple)):
            return [cls._sanitize(item) for item in value[:MAX_SANITIZED_ITEMS]]
        if isinstance(value, str):
            return cls._scrub_text(value)
        if isinstance(value, (str, int, float, bool)) or value is None:
            return value
        return str(value)

    @staticmethod
    def _scrub_text(value: Any) -> str:
        text = str(value)
        text = SENSITIVE_VALUE.sub(lambda match: f"{match.group(1)}[redacted]", text)
        return text.replace("controller-baseline", "[redacted]").replace("controller_truth", "[redacted]")

    @staticmethod
    def _bounded_strings(value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        return [str(item)[:128] for item in value[:20]]

    def _run_prefix(self) -> str:
        if self.source_prefix:
            return f"{self.source_prefix}/{self.run_id}/"
        return f"{self.run_id}/"

    def _capture_key(self, filename: str) -> str:
        return f"{self._run_prefix()}{filename}"

    def _write_json(self, key: str, payload: Mapping[str, Any]) -> str | None:
        try:
            body = self._json_bytes(self._sanitize(payload))
            if len(body) > MAX_CAPTURE_BYTES:
                return "capture object exceeded 256 KiB"
            client = self._client("s3")
            client.put_object(
                Bucket=self.source_bucket,
                Key=key,
                Body=body,
                ContentType="application/json",
                ServerSideEncryption="AES256",
            )
            return None
        except Exception as exc:
            return self._safe_error(exc)

    def _client(self, service: str) -> Any:
        return self.session.client(service, region_name=self.region)

    @staticmethod
    def _safe_error(error: Exception) -> str:
        response = getattr(error, "response", {})
        error_code = response.get("Error", {}).get("Code") if isinstance(response, Mapping) else None
        detail = f" ({error_code})" if isinstance(error_code, str) and error_code else ""
        return f"{type(error).__name__}{detail}"

    @staticmethod
    def _utc_now() -> str:
        return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


__all__ = ["EvidenceTools"]
