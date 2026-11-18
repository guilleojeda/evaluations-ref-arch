"""Acceptance checks for the versioned captured-evidence provider.

The fixtures are written through ``write_bundle`` on purpose.  The provider's
on-disk representation is an implementation detail; these tests describe the
observable source and query contract while retaining a small envelope check for
the integrity boundary.
"""

from __future__ import annotations

import json
import importlib
import sys
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Mapping
from unittest.mock import patch


AGENT_DIR = Path(__file__).resolve().parents[1] / "agent"
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

from evidence import EvidenceTools


START = "2026-11-13T10:00:00.000Z"
END = "2026-11-13T10:05:00.000Z"
CUTOFF_ONE = "2026-11-13T10:05:00.000Z"
CUTOFF_TWO = "2026-11-13T10:07:00.000Z"
CAPTURE_OBSERVED_AT = "2026-11-13T10:07:30.000Z"
ORIGIN = {
    "alarmArn": "arn:aws:cloudwatch:us-east-1:123456789012:alarm:Phase13Fixture",
    "transitionAt": CUTOFF_ONE,
    "runId": "phase13-fixture-run",
    "accountId": "123456789012",
    "region": "us-east-1",
    "apiId": "api-phase13",
    "startedAt": "2026-11-13T10:05:01.000Z",
    "capturedAt": "2026-11-13T10:07:30.000Z",
}


def source_entry(
    scope: list[str],
    observations: list[Mapping[str, Any]],
    *,
    window: tuple[str, str] = (START, END),
    observed_at: str | None = None,
    completeness: str = "complete",
    errors: list[str] | None = None,
    truncated: bool = False,
    query: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build only the source fields accepted by the capture writer."""

    result: dict[str, Any] = {
        "scope": list(scope),
        "window": {"start": window[0], "end": window[1]},
        "completeness": completeness,
        "errors": list(errors or []),
        "truncated": bool(truncated),
        "observations": [dict(item) for item in observations],
    }
    if observed_at is not None:
        result["observedAt"] = observed_at
    if query is not None:
        # Metric query metadata is part of the existing EvidenceTools result
        # shape and is needed to preserve the native period/stat/dimensions.
        result["query"] = dict(query)
    return result


def metric_query(metric_name: str = "Throttles", *, period: int = 60, query_id: str = "inv0") -> dict[str, Any]:
    return {
        "metrics": [
            {
                "Id": query_id,
                "MetricStat": {
                    "Metric": {
                        "Namespace": "AWS/Lambda",
                        "MetricName": metric_name,
                        "Dimensions": [{"Name": "FunctionName", "Value": "IncidentTriageDemoInventory"}],
                    },
                    "Period": period,
                    "Stat": "Sum" if metric_name != "ConcurrentExecutions" else "Maximum",
                },
                "ReturnData": True,
            }
        ],
        "periodSeconds": period,
    }


def all_metric_query(*, period: int = 60) -> dict[str, Any]:
    result = metric_query(period=period)
    result["metrics"].extend(
        metric_query("Errors", period=period, query_id="inv1")["metrics"]
    )
    result["metrics"].extend(
        metric_query("Invocations", period=period, query_id="inv2")["metrics"]
    )
    return result


def fixture_sources() -> dict[str, dict[str, Any]]:
    """Return a coherent four-source incident capture with temporal clues."""

    logs = source_entry(
        ["inventory"],
        [
            {
                "resource": "inventory",
                "eventId": "log-early",
                "timestamp": "2026-11-13T10:01:00.000Z",
                "ingestionTime": "2026-11-13T10:01:10.000Z",
                "availableAt": "2026-11-13T10:01:10.000Z",
                "fields": {"requestId": "request-early", "errorCode": "INVENTORY_LOOKUP_FAILED"},
            },
            {
                "resource": "inventory",
                "eventId": "log-late",
                "timestamp": "2026-11-13T10:02:00.000Z",
                "ingestionTime": "2026-11-13T10:06:00.000Z",
                "availableAt": "2026-11-13T10:06:00.000Z",
                "fields": {"requestId": "request-late", "errorCode": "ACCESS_DENIED"},
            },
            {
                "resource": "inventory",
                "eventId": "log-future",
                "timestamp": "2026-11-13T10:06:00.000Z",
                "ingestionTime": "2026-11-13T10:06:01.000Z",
                "availableAt": "2026-11-13T10:06:01.000Z",
                "fields": {"requestId": "request-future"},
            },
        ],
        window=(START, CUTOFF_TWO),
        observed_at=CAPTURE_OBSERVED_AT,
    )

    metrics = source_entry(
        ["inventory"],
        [
            {
                "Id": "inv0",
                "Label": "Throttles",
                "Timestamps": ["2026-11-13T10:00:00.000Z"],
                "Values": [1],
                "StatusCode": "Complete",
                "availableAt": "2026-11-13T10:01:00.000Z",
            },
            {
                "Id": "inv0",
                "Label": "Throttles",
                "Timestamps": ["2026-11-13T10:01:00.000Z"],
                "Values": [2],
                "StatusCode": "Complete",
                "availableAt": "2026-11-13T10:02:15.000Z",
            },
            {
                "Id": "inv0",
                "Label": "Throttles",
                "Timestamps": ["2026-11-13T10:01:00.000Z"],
                "Values": [7],
                "StatusCode": "Complete",
                "availableAt": "2026-11-13T10:06:00.000Z",
            },
            {
                "Id": "inv0",
                "Label": "Throttles",
                "Timestamps": ["2026-11-13T10:02:00.000Z"],
                "Values": [3],
                "StatusCode": "Complete",
                "availableAt": "2026-11-13T10:03:15.000Z",
            },
            {
                "Id": "inv0",
                "Label": "Throttles",
                "Timestamps": ["2026-11-13T10:03:00.000Z"],
                "Values": [4],
                "StatusCode": "Complete",
                "availableAt": "2026-11-13T10:06:00.000Z",
            },
            {
                "Id": "inv1",
                "Label": "Errors",
                "Timestamps": ["2026-11-13T10:01:00.000Z"],
                "Values": [1],
                "StatusCode": "Complete",
                # Missing availability is intentionally not treated as known
                # to be visible at either reference cutoff.
            },
            {
                "Id": "inv2",
                "Label": "Invocations",
                "Timestamps": ["2026-11-13T10:01:00.000Z"],
                "Values": [0],
                "StatusCode": "Complete",
                "availableAt": "2026-11-13T10:02:00.000Z",
            },
        ],
        observed_at=CAPTURE_OBSERVED_AT,
        query=all_metric_query(),
    )

    configuration = source_entry(
        ["inventory"],
        [
            {
                "kind": "lambda",
                "function": "IncidentTriageDemoInventory",
                "observedAt": "2026-11-13T10:03:00.000Z",
                "availableAt": "2026-11-13T10:03:00.000Z",
                "alias": {"Name": "live", "FunctionVersion": "11", "RevisionId": "alias-rev-11"},
                "configuration": {"FunctionName": "IncidentTriageDemoInventory", "Version": "11", "MemorySize": 256},
                "concurrency": {"ReservedConcurrentExecutions": 3},
            },
            {
                "kind": "lambda",
                "function": "IncidentTriageDemoInventory",
                "observedAt": "2026-11-13T10:06:00.000Z",
                "availableAt": "2026-11-13T10:06:00.000Z",
                "alias": {"Name": "live", "FunctionVersion": "12", "RevisionId": "alias-rev-12"},
                "configuration": {"FunctionName": "IncidentTriageDemoInventory", "Version": "12", "MemorySize": 512},
                "concurrency": {"ReservedConcurrentExecutions": 3},
            },
        ],
        observed_at=CAPTURE_OBSERVED_AT,
    )

    change_history = source_entry(
        ["inventory", "gateway"],
        [
            {
                "EventId": "change-visible",
                "EventName": "UpdateFunctionConfiguration",
                "EventSource": "lambda.amazonaws.com",
                "EventTime": "2026-11-13T10:03:00.000Z",
                "availableAt": "2026-11-13T10:03:30.000Z",
                "ReadOnly": False,
                "Resources": [{"ResourceName": "IncidentTriageDemoInventory", "ResourceType": "AWS::Lambda::Function"}],
            },
            {
                # The event happened inside the query window, but CloudTrail
                # did not make it available until after the first cutoff.
                "EventId": "change-late",
                "EventName": "AttachRolePolicy",
                "EventSource": "iam.amazonaws.com",
                "EventTime": "2026-11-13T10:02:00.000Z",
                "availableAt": "2026-11-13T10:06:00.000Z",
                "ReadOnly": False,
                "Resources": [{"ResourceName": "IncidentTriageDemoAppInventoryDeniedRole", "ResourceType": "AWS::IAM::Role"}],
            },
        ],
        observed_at=CAPTURE_OBSERVED_AT,
    )
    return {
        "logs": logs,
        "metrics": metrics,
        "configuration": configuration,
        "changeHistory": change_history,
    }


def provider_module() -> Any:
    """Import the product module at use time so unittest discovers every case."""

    return importlib.import_module("captured_evidence")


def write_fixture(path: Path, sources: Mapping[str, Mapping[str, Any]] | None = None) -> None:
    provider_module().write_bundle(path, origin=ORIGIN, sources=sources or fixture_sources())


def observation_values(value: Any, key: str) -> list[Any]:
    """Collect values for a semantic field without coupling to result layout."""

    values: list[Any] = []
    if isinstance(value, Mapping):
        for name, item in value.items():
            if name == key:
                values.append(item)
            values.extend(observation_values(item, key))
    elif isinstance(value, list):
        for item in value:
            values.extend(observation_values(item, key))
    return values


def rendered(result: Mapping[str, Any]) -> str:
    return json.dumps(result, ensure_ascii=False, sort_keys=True, default=str)


class CapturedEvidenceTests(unittest.TestCase):
    def load(self, path: Path, reference_time: str, charges: list[int] | None = None) -> Any:
        charges = charges if charges is not None else []
        return provider_module().CapturedEvidenceTools.load(
            path,
            reference_time=reference_time,
            deadline_monotonic=time.monotonic() + 60,
            charge_tool_call=lambda: charges.append(1),
        )

    def call(self, tools: Any, name: str, **kwargs: Any) -> dict[str, Any]:
        return getattr(tools, name)(**kwargs)

    def test_writer_emits_one_versioned_envelope_with_source_digests_and_coverage(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "capture.json"
            write_fixture(path)

            payload = json.loads(path.read_text(encoding="utf-8"))
            self.assertIsInstance(payload, dict)
            self.assertIn("schemaVersion", payload)
            self.assertEqual(ORIGIN, payload["origin"])
            self.assertEqual({"logs", "metrics", "configuration", "changeHistory"}, set(payload["sources"]))
            self.assertEqual(1, len(list(Path(directory).iterdir())), "capture is a single envelope file")
            self.assertEqual(0o600, path.stat().st_mode & 0o777)

            manifest = payload.get("manifest")
            self.assertIsInstance(manifest, Mapping)
            manifest_sources = manifest["sources"]
            for name, source in payload["sources"].items():
                with self.subTest(source=name):
                    self.assertIsInstance(source.get("scope"), list)
                    self.assertEqual({"start", "end"}, set(source["window"]))
                    self.assertIn("completeness", source)
                    self.assertIn("errors", source)
                    self.assertIn("truncated", source)
                    self.assertIn("observations", source)
                    entry = manifest_sources[name]
                    digest = entry["sha256"]
                    self.assertRegex(str(digest), r"^[0-9a-f]{64}$")
                    self.assertEqual(source["scope"], entry["scope"])
                    self.assertEqual(source["window"], entry["window"])
                    self.assertEqual(source["completeness"], entry["completeness"])

    def test_round_trip_registers_the_same_four_decorated_methods_as_live_tools(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "capture.json"
            write_fixture(path)
            tools = self.load(path, CUTOFF_TWO)

            live = EvidenceTools.__new__(EvidenceTools)
            live_names = [item.tool_name for item in live.tools()]
            captured = tools.tools()
            self.assertEqual(live_names, [item.tool_name for item in captured])
            self.assertEqual(
                ["search_logs", "read_metrics", "read_configuration", "read_change_history"],
                live_names,
            )
            for item in captured:
                with self.subTest(tool=item.tool_name):
                    self.assertTrue(hasattr(item, "tool_name"))

            results = [
                tools.search_logs(resource="inventory", start=START, end=END),
                tools.read_metrics(resource="inventory", start=START, end=END, metric="Throttles", period_seconds=60),
                tools.read_configuration(resource="inventory"),
                tools.read_change_history(resource="inventory", start=START, end=END),
            ]
            for result in results:
                self.assertIsInstance(result, dict)
                self.assertTrue({"source", "scope", "window", "completeness", "truncated", "errors"}.issubset(result))
                self.assertIsInstance(result["scope"], list)

    def test_two_reference_cutoffs_filter_late_logs_and_cloudtrail_by_known_availability(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "capture.json"
            write_fixture(path)
            first = self.load(path, CUTOFF_ONE)
            second = self.load(path, CUTOFF_TWO)

            first_logs = first.search_logs(resource="inventory", start=START, end=END)
            second_logs = second.search_logs(resource="inventory", start=START, end=END)
            self.assertIn("log-early", rendered(first_logs))
            self.assertNotIn("log-late", rendered(first_logs))
            self.assertIn("log-late", rendered(second_logs))
            self.assertNotIn("log-future", rendered(second_logs), "reference time does not make future event time visible")
            filtered_late = second.search_logs(
                resource="inventory", start=START, end=END, query="request-late"
            )
            early_filtered = first.search_logs(resource="inventory", start=START, end=END, query="request-late")
            self.assertEqual("partial", early_filtered["completeness"])
            self.assertIn("log-late", rendered(filtered_late))
            self.assertNotIn("log-early", rendered(filtered_late), "the alternate predicate is applied to captured records")

            first_history = first.read_change_history(resource="inventory", start=START, end=END)
            second_history = second.read_change_history(resource="inventory", start=START, end=END)
            self.assertIn("change-visible", rendered(first_history))
            self.assertNotIn("change-late", rendered(first_history))
            self.assertIn("change-late", rendered(second_history))
            gateway_history = second.read_change_history(resource="gateway", start=START, end=END)
            self.assertEqual([], gateway_history.get("observations", []))
            # The late CloudTrail event has an old EventTime, so filtering only
            # on event time would incorrectly expose it at the first cutoff.
            self.assertIn("EventTime", rendered(second_history))

    def test_replay_omits_later_archive_metadata_only_from_model_results(self):
        sources = fixture_sources()
        for source in sources.values():
            source["acquiredAt"] = CAPTURE_OBSERVED_AT
        sources["logs"]["errors"] = ["retained source warning"]
        sources["logs"]["gaps"] = ["retained coverage note"]
        sources["logs"]["observations"].append({
            "resource": "inventory",
            "eventId": "log-without-availability",
            "timestamp": "2026-11-13T10:01:30.000Z",
            "fields": {"requestId": "request-without-availability"},
        })

        with TemporaryDirectory() as directory:
            path = Path(directory) / "capture.json"
            write_fixture(path, sources)
            frozen_bytes = path.read_bytes()
            tools = self.load(path, CUTOFF_ONE)
            results = {
                "search_logs": tools.search_logs(resource="inventory", start=START, end=END),
                "read_metrics": tools.read_metrics(
                    resource="inventory", start=START, end=END, metric="Throttles", period_seconds=60,
                ),
                "read_configuration": tools.read_configuration(target="inventory"),
                "read_change_history": tools.read_change_history(resource="inventory", start=START, end=END),
            }

            for name, result in results.items():
                with self.subTest(tool=name):
                    self.assertNotIn("observedAt", result)
                    self.assertNotIn("acquiredAt", result)
                    self.assertEqual(CUTOFF_ONE, result["referenceTime"])
                    self.assertIn("window", result)

            logs = results["search_logs"]
            self.assertIn("log-early", rendered(logs))
            self.assertNotIn("log-without-availability", rendered(logs))
            self.assertIn("retained source warning", logs["errors"])
            self.assertIn("retained coverage note", logs["gaps"])
            self.assertIn("matching logs include records without proven availability", " ".join(logs["gaps"]))
            log_row = next(item for item in logs["observations"] if item["eventId"] == "log-early")
            self.assertIn("timestamp", log_row)
            self.assertIn("ingestionTime", log_row)
            self.assertIn("availableAt", log_row)

            metrics = results["read_metrics"]
            metric_row = metrics["observations"][0]
            self.assertIn("Timestamps", metric_row)
            self.assertIn("availability", metric_row)
            self.assertIn("2026-11-13T10:01:00.000Z", metric_row["Timestamps"])

            configuration = results["read_configuration"]
            self.assertNotIn("sourceObservedAt", configuration["query"])
            config_row = configuration["observations"][0]
            self.assertIn("observedAt", config_row)
            self.assertIn("availableAt", config_row)

            history = results["read_change_history"]
            history_row = history["observations"][0]
            self.assertIn("EventTime", history_row)
            self.assertIn("availableAt", history_row)

            # The retained query ledger is faithful to the response the model
            # saw, while the verified bundle bytes remain unchanged.
            audit = {item["tool"]: item["result"] for item in tools._query_results}
            for name in results:
                with self.subTest(audit_tool=name):
                    self.assertEqual(results[name], audit[name])
                    self.assertNotIn("observedAt", audit[name])
                    self.assertNotIn("acquiredAt", audit[name])
            self.assertNotIn("sourceObservedAt", audit["read_configuration"]["query"])
            self.assertEqual(frozen_bytes, path.read_bytes())

            # The projection is strictly later-than-reference; metadata at
            # the reviewed cutoff remains available as a valid archive bound.
            boundary_sources = fixture_sources()
            boundary_sources["configuration"]["observedAt"] = CUTOFF_ONE
            boundary_sources["configuration"]["acquiredAt"] = CUTOFF_ONE
            boundary_path = Path(directory) / "boundary.json"
            write_fixture(boundary_path, boundary_sources)
            boundary = self.load(boundary_path, CUTOFF_ONE).read_configuration(target="inventory")
            self.assertEqual(CUTOFF_ONE, boundary["observedAt"])
            self.assertEqual(CUTOFF_ONE, boundary["acquiredAt"])
            self.assertEqual(CUTOFF_ONE, boundary["query"]["sourceObservedAt"])

    def test_replay_uses_nanoseconds_for_row_availability_while_projecting_archive_metadata(self):
        sources = fixture_sources()
        sources["logs"]["observations"].append({
            "resource": "inventory",
            "eventId": "log-one-nanosecond-late",
            "timestamp": "2026-11-13T10:04:00.000Z",
            "availableAt": "2026-11-13T10:05:00.000000001Z",
            "fields": {"requestId": "request-one-nanosecond-late"},
        })

        with TemporaryDirectory() as directory:
            path = Path(directory) / "capture.json"
            write_fixture(path, sources)
            first = self.load(path, CUTOFF_ONE)
            second = self.load(path, "2026-11-13T10:05:00.000000001Z")

            first_result = first.search_logs(resource="inventory", start=START, end=END)
            second_result = second.search_logs(resource="inventory", start=START, end=END)
            self.assertNotIn("log-one-nanosecond-late", rendered(first_result))
            self.assertIn("log-one-nanosecond-late", rendered(second_result))
            self.assertNotIn("observedAt", first_result)
            self.assertNotIn("acquiredAt", first_result)
            row = next(item for item in second_result["observations"] if item["eventId"] == "log-one-nanosecond-late")
            self.assertEqual("2026-11-13T10:05:00.000000001Z", row["availableAt"])

    def test_log_query_enforces_resource_scope_and_the_live_structured_predicate(self):
        sources = fixture_sources()
        sources["logs"]["scope"].append("gateway")
        inventory_record = sources["logs"]["observations"][0]
        inventory_record["fields"]["operation"] = "reserve inventory"
        sources["logs"]["observations"].append({**inventory_record, "eventId": "gateway-copy", "resource": "gateway"})

        with TemporaryDirectory() as directory:
            path = Path(directory) / "capture.json"
            provider_module().write_bundle(path, origin=ORIGIN, sources=sources)
            tools = self.load(path, CUTOFF_TWO)
            result = tools.search_logs(resource="inventory", start=START, end=END, operation="reserve inventory", limit=1)
            self.assertEqual(["log-early"], [item["eventId"] for item in result.get("observations", [])])
            self.assertFalse(result["truncated"])
            result = tools.search_logs(resource="inventory", start=START, end=END, operation="reserve")
            self.assertEqual([], result.get("observations", []))
            with self.assertRaisesRegex(ValueError, "unsupported CloudWatch filter syntax"):
                tools.search_logs(resource="inventory", start=START, end=END, filter_pattern='{ $.operation = "reserve inventory" }')

    def test_large_source_diagnostics_keep_the_reference_and_response_bound(self):
        sources = fixture_sources()
        sources["logs"]["errors"] = [f"coverage warning {index}: {'x' * 980}" for index in range(30)]
        with TemporaryDirectory() as directory:
            path = Path(directory) / "capture.json"
            provider_module().write_bundle(path, origin=ORIGIN, sources=sources)
            result = self.load(path, CUTOFF_TWO).search_logs(resource="inventory", start=START, end=END)
            self.assertLessEqual(len(rendered(result).encode()), 12 * 1024)
            self.assertEqual(CUTOFF_TWO, result["referenceTime"])
            self.assertEqual("partial", result["completeness"])

    def test_configuration_uses_latest_snapshot_known_at_each_reference_cutoff(self):
        sources = fixture_sources()
        sources["configuration"]["observations"].append({
            "kind": "lambda-version", "function": "IncidentTriageDemoInventory",
            "observedAt": "2026-11-13T10:06:30.000Z", "availableAt": "2026-11-13T10:06:30.000Z",
            "configuration": {"FunctionName": "IncidentTriageDemoInventory", "Version": "13"},
        })
        with TemporaryDirectory() as directory:
            path = Path(directory) / "capture.json"
            write_fixture(path, sources)
            first = self.load(path, CUTOFF_ONE)
            second = self.load(path, CUTOFF_TWO)

            first_result = first.read_configuration(target="inventory")
            second_result = second.read_configuration(target="inventory")
            first_versions = {str(value) for value in observation_values(first_result, "Version")}
            second_versions = {str(value) for value in observation_values(second_result, "Version")}
            first_alias_versions = {str(value) for value in observation_values(first_result, "FunctionVersion")}
            second_alias_versions = {str(value) for value in observation_values(second_result, "FunctionVersion")}
            self.assertIn("11", first_versions | first_alias_versions)
            self.assertNotIn("12", first_versions | first_alias_versions)
            self.assertIn("12", second_versions | second_alias_versions)
            self.assertNotIn("11", second_alias_versions, "the prior live alias is not the selected snapshot")
            self.assertNotIn("13", second_versions, "a later published version cannot become the active snapshot")

    def test_metrics_require_full_native_buckets_preserve_metadata_and_expose_late_samples_at_second_cutoff(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "capture.json"
            write_fixture(path)
            first = self.load(path, CUTOFF_ONE)
            second = self.load(path, CUTOFF_TWO)
            requested = metric_query()["metrics"][0]

            first_result = first.read_metrics(resource="inventory", start=START, end=END, metric="Throttles", period_seconds=60)
            second_result = second.read_metrics(resource="inventory", start=START, end=END, metric="Throttles", period_seconds=60)
            self.assertEqual("partial", first_result["completeness"])
            self.assertEqual("partial", second_result["completeness"])
            self.assertNotIn("2026-11-13T10:03:00.000Z", rendered(first_result))
            self.assertIn("2026-11-13T10:03:00.000Z", rendered(second_result))
            for result, expected in ((first_result, 2), (second_result, 7)):
                versions = [value for series in result["observations"]
                            for timestamp, value in zip(series["Timestamps"], series["Values"], strict=True)
                            if timestamp == "2026-11-13T10:01:00.000Z"]
                self.assertEqual([expected], versions)
            metadata = first_result.get("query", {}).get("metrics", [])[0]
            self.assertEqual(requested["MetricStat"], metadata["MetricStat"])
            self.assertEqual(60, first_result.get("query", {}).get("periodSeconds"))

            clipped = second.read_metrics(
                resource="inventory",
                start="2026-11-13T10:00:30.000Z",
                end="2026-11-13T10:02:30.000Z",
                metric="Throttles",
                period_seconds=60,
            )
            clipped_text = rendered(clipped)
            self.assertIn("2026-11-13T10:01:00.000Z", clipped_text)
            self.assertNotIn("2026-11-13T10:00:00.000Z", clipped_text)
            self.assertNotIn("2026-11-13T10:02:00.000Z", clipped_text)
            self.assertEqual("partial", clipped["completeness"])
            self.assertTrue(clipped.get("gaps") or clipped.get("errors") or clipped.get("truncated"))

            with self.assertRaisesRegex(ValueError, r"(?i)period|aggregation"):
                second.read_metrics(resource="inventory", start=START, end=END, metric="Throttles", period_seconds=300)

    def test_unknown_metric_availability_is_not_invented_as_a_sample(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "capture.json"
            write_fixture(path)
            tools = self.load(path, CUTOFF_TWO)

            result = tools.read_metrics(resource="inventory", start=START, end=END, metric="Errors", period_seconds=60)
            self.assertIn(result["completeness"], {"unavailable", "partial"})
            self.assertTrue(result.get("gaps") or result.get("errors"))
            self.assertNotIn('"Values": [1]', rendered(result))

    def test_known_zero_metric_is_distinct_from_unknown_availability_and_empty_source(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "capture.json"
            write_fixture(path)
            result = self.load(path, CUTOFF_TWO).read_metrics(
                resource="inventory", start="2026-11-13T10:01:00.000Z", end="2026-11-13T10:02:00.000Z",
                metric="Invocations", period_seconds=60,
            )
            self.assertEqual("complete", result["completeness"])
            self.assertIn('"Values": [0]', rendered(result))
            self.assertNotIn("unavailable", result.get("errors", []))

    def test_missing_source_is_unavailable_independently_and_empty_source_stays_complete(self):
        source_names_to_tools = {
            "logs": "search_logs",
            "metrics": "read_metrics",
            "configuration": "read_configuration",
            "changeHistory": "read_change_history",
        }
        calls = {
            "search_logs": {"resource": "inventory", "start": START, "end": END},
            "read_metrics": {"resource": "inventory", "start": START, "end": END, "metric": "Throttles"},
            "read_configuration": {"resource": "inventory"},
            "read_change_history": {"resource": "inventory", "start": START, "end": END},
        }
        with TemporaryDirectory() as directory:
            for missing_source, tool_name in source_names_to_tools.items():
                with self.subTest(missing_source=missing_source):
                    path = Path(directory) / f"missing-{missing_source}.json"
                    sources = fixture_sources()
                    sources[missing_source] = source_entry(
                        ["inventory"],
                        [],
                        completeness="unavailable",
                        errors=["source missing from capture"],
                        observed_at=CAPTURE_OBSERVED_AT,
                    )
                    write_fixture(path, sources)
                    tools = self.load(path, CUTOFF_TWO)
                    result = self.call(tools, tool_name, **calls[tool_name])
                    self.assertIn(result["completeness"], {"unavailable", "partial"})
                    self.assertTrue(result.get("gaps") or result.get("errors"))
                    self.assertNotIn("observedAt", result)
                    self.assertNotIn("acquiredAt", result)
                    if tool_name == "read_configuration":
                        self.assertNotIn("sourceObservedAt", result.get("query", {}))

            empty = fixture_sources()
            empty["logs"] = source_entry(["inventory"], [], completeness="complete")
            path = Path(directory) / "empty-logs.json"
            write_fixture(path, empty)
            result = self.load(path, CUTOFF_TWO).search_logs(resource="inventory", start=START, end=END)
            self.assertEqual("complete", result["completeness"])
            self.assertFalse(result.get("gaps"))
            self.assertFalse(result.get("errors"))
            self.assertIn(result.get("observations", []), ([], None))

    def test_out_of_scope_resource_is_a_visible_gap_and_supported_aliases_match_live_bounds(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "capture.json"
            write_fixture(path)
            tools = self.load(path, CUTOFF_TWO)

            gap = tools.search_logs(resource="checkout", start=START, end=END)
            self.assertIn(gap["completeness"], {"unavailable", "partial"})
            self.assertTrue(gap.get("gaps") or gap.get("errors"))
            with self.assertRaises(ValueError):
                tools.search_logs(resource="controller", start=START, end=END)
            with self.assertRaises(ValueError):
                tools.search_logs(resource="inventory", start=START, end="2026-11-13T10:31:00Z")

            # Alternate names used by the live EvidenceTools surface remain
            # valid for captured execution and do not widen the source scope.
            self.assertIsInstance(tools.search_logs(service="inventory", window={"start": START, "end": END}), dict)
            self.assertIsInstance(
                tools.read_metrics(service="inventory", window_start=START, window_end=END, metric="Throttles"), dict
            )
            self.assertIsInstance(tools.read_configuration(target="inventory"), dict)
            self.assertIsInstance(tools.read_change_history(service="inventory", window={"start": START, "end": END}), dict)

    def test_tampered_source_digest_is_rejected_before_tool_execution(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "capture.json"
            write_fixture(path)
            payload = json.loads(path.read_text(encoding="utf-8"))
            payload["sources"]["logs"]["observations"][0]["fields"]["requestId"] = "tampered"
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaises(ValueError):
                self.load(path, CUTOFF_TWO)

    def test_captured_execution_makes_no_aws_client_or_network_reads(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "capture.json"
            write_fixture(path)
            with patch("boto3.client", side_effect=AssertionError("captured execution attempted an AWS client")), patch(
                "boto3.resource", side_effect=AssertionError("captured execution attempted an AWS resource")
            ), patch("boto3.Session", side_effect=AssertionError("captured execution attempted an AWS session")), patch(
                "botocore.httpsession.URLLib3Session.send", side_effect=AssertionError("captured execution attempted network")
            ):
                tools = self.load(path, CUTOFF_TWO)
                self.assertIsInstance(tools.search_logs(resource="inventory", start=START, end=END), dict)
                self.assertIsInstance(tools.read_metrics(resource="inventory", start=START, end=END, metric="Throttles"), dict)
                self.assertIsInstance(tools.read_configuration(resource="inventory"), dict)
                self.assertIsInstance(tools.read_change_history(resource="inventory", start=START, end=END), dict)

    def test_result_is_bounded_below_twelve_kib_and_each_invocation_charges_once(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "large-capture.json"
            sources = fixture_sources()
            sources["logs"] = source_entry(
                ["inventory"],
                [
                    {
                        "resource": "inventory",
                        "eventId": f"large-{index}",
                        "timestamp": "2026-11-13T10:01:00.000Z",
                        "availableAt": "2026-11-13T10:01:00.000Z",
                        "message": "x" * 420,
                    }
                    for index in range(300)
                ],
            )
            write_fixture(path, sources)
            charges: list[int] = []
            tools = self.load(path, CUTOFF_TWO, charges)
            result = tools.search_logs(resource="inventory", start=START, end=END, limit=100)
            self.assertLessEqual(len(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")), 12 * 1024)
            self.assertTrue(result["truncated"])
            self.assertEqual("partial", result["completeness"])
            self.assertGreater(len(result.get("observations", [])), 0, "bounded output retains real records")
            self.assertLess(len(result["observations"]), 100)
            self.assertTrue(all(str(item.get("eventId", "")).startswith("large-") for item in result["observations"]))
            self.assertEqual(1, len(charges))

            with self.assertRaises(ValueError):
                tools.search_logs(resource="controller", start=START, end=END)
            self.assertEqual(2, len(charges), "rejected calls are charged once before validation")


if __name__ == "__main__":
    unittest.main()
