"""Focused provider-boundary checks for the Phase 4 evidence tools."""

from __future__ import annotations

import json
import sys
import time
import unittest
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parents[1] / "agent"
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

from evidence import EvidenceTools
from support.phase4_agent_fakes import (
    ALARM_ARN,
    SECRET_SENTINELS,
    SOURCE_BUCKET,
    SOURCE_PREFIX,
    FakeAWSBoundary,
)


class _DynamoPolicyClient:
    def __init__(self, boundary: "_DynamoPolicyBoundary") -> None:
        self.boundary = boundary

    def get_resource_policy(self, **request):
        self.boundary.dynamodb_policy_calls.append(request)
        return {
            "Policy": json.dumps(
                {
                    "Version": "2012-10-17",
                    "Statement": [{"Effect": "Deny", "Action": "dynamodb:GetItem", "Resource": "*"}],
                }
            )
        }


class _DynamoPolicyBoundary(FakeAWSBoundary):
    def __init__(self) -> None:
        super().__init__()
        self.dynamodb_policy_calls: list[dict[str, object]] = []

    def client(self, service_name: str, **kwargs):
        if service_name == "dynamodb":
            return _DynamoPolicyClient(self)
        return super().client(service_name, **kwargs)


class EvidenceProviderTests(unittest.TestCase):
    def make_tools(self, boundary: FakeAWSBoundary | None = None):
        boundary = boundary or FakeAWSBoundary()
        charges: list[int] = []
        tools = EvidenceTools(
            boundary,
            account_id="123456789012",
            region="us-east-1",
            app_http_api_id="api-123456",
            source_bucket=SOURCE_BUCKET,
            source_prefix=SOURCE_PREFIX,
            run_id="evidence-test-run",
            alarm_arn=ALARM_ARN,
            transition_at="2026-11-09T23:10:00.000Z",
            started_at="2026-11-09T23:10:01.000Z",
            deadline_monotonic=time.monotonic() + 60,
            charge_tool_call=lambda: charges.append(1),
        )
        return tools, boundary, charges

    def test_public_surface_is_four_decorated_tools_and_each_call_is_charged(self):
        tools, boundary, charges = self.make_tools()
        self.assertEqual(
            ["search_logs", "read_metrics", "read_configuration", "read_change_history"],
            [item.tool_name for item in tools.tools()],
        )
        tools.search_logs(resource="inventory")
        tools.read_metrics(resource="inventory")
        tools.read_configuration(resource="inventory")
        tools.read_change_history(resource="inventory")
        self.assertEqual(4, len(charges))
        self.assertTrue(boundary.calls)
        self.assertTrue(all("Controller" not in json.dumps(request, default=str) for _, _, request in boundary.calls))

    def test_gateway_metrics_use_api_id_stage_and_preserve_status_code(self):
        boundary = FakeAWSBoundary()
        boundary.responses[("cloudwatch", "get_metric_data")] = {
            "MetricDataResults": [{"Id": "gw0", "StatusCode": "Complete", "Values": [1]}]
        }
        tools, boundary, _ = self.make_tools(boundary)
        result = tools.read_metrics(resource="gateway")
        metric_request = next(request for service, operation, request in boundary.calls if service == "cloudwatch" and operation == "get_metric_data")
        gateway_dimensions = metric_request["MetricDataQueries"][0]["MetricStat"]["Metric"]["Dimensions"]
        self.assertEqual(
            [{"Name": "ApiId", "Value": "api-123456"}, {"Name": "Stage", "Value": "$default"}],
            gateway_dimensions,
        )
        self.assertNotIn("ApiName", json.dumps(metric_request, default=str))
        self.assertEqual("Complete", result["observations"][0]["StatusCode"])

    def test_inventory_policy_uses_exact_resource_arn_and_projects_policy_shapes(self):
        boundary = _DynamoPolicyBoundary()
        tools, boundary, _ = self.make_tools(boundary)
        result = tools.read_configuration(resource="inventory")
        self.assertEqual(
            [{"ResourceArn": "arn:aws:dynamodb:us-east-1:123456789012:table/IncidentTriageDemoInventory"}],
            boundary.dynamodb_policy_calls,
        )
        table_policy = next(item for item in result["observations"] if item["kind"] == "dynamodb-resource-policy")
        self.assertEqual("Deny", table_policy["policy"]["Statement"][0]["Effect"])
        document = tools._project_policy({"PolicyDocument": {"Version": "2012-10-17", "Statement": [{"Effect": "Deny"}]}})
        self.assertEqual("Deny", document["Statement"][0]["Effect"])

    def test_scope_and_window_rejections_happen_before_source_calls(self):
        tools, boundary, charges = self.make_tools()
        with self.assertRaises(ValueError):
            tools.search_logs(resource="controller")
        with self.assertRaises(ValueError):
            tools.read_metrics(resource="inventory", start="2026-11-09T22:00:00Z", end="2026-11-09T23:00:00Z")
        self.assertEqual(2, len(charges))
        self.assertEqual([], boundary.calls)

    def test_large_paged_logs_are_finite_bounded_and_marked_partial(self):
        boundary = FakeAWSBoundary()
        boundary.large_log_count = 300
        boundary.more_pages = True
        tools, boundary, _ = self.make_tools(boundary)
        result = tools.search_logs(resource="inventory")
        self.assertLessEqual(len(json.dumps(result).encode("utf-8")), 12 * 1024)
        self.assertTrue(result["truncated"])
        self.assertEqual("partial", result["completeness"])
        self.assertLessEqual(max(boundary.pages.values()), 8)

    def test_json_log_messages_project_allowed_fields_and_drop_nested_secrets(self):
        boundary = FakeAWSBoundary()
        boundary.responses[("logs", "filter_log_events")] = {
            "events": [{
                "timestamp": 1_800_000_000_000,
                "message": json.dumps({
                    "requestId": "safe-request-id",
                    "operation": "checkout",
                    "statusCode": 502,
                    "outcome": "server_error",
                    "Environment": {"Variables": {"CHECKOUT_SECRET": SECRET_SENTINELS[0]}},
                    "authorization": SECRET_SENTINELS[1],
                    "controllerTruth": SECRET_SENTINELS[2],
                    "checkoutId": "private-business-id",
                }),
            }]
        }
        tools, boundary, _ = self.make_tools(boundary)
        result = tools.search_logs(resource="checkout")
        projected = result["observations"][0]
        self.assertEqual("safe-request-id", projected["fields"]["requestId"])
        self.assertEqual(502, projected["fields"]["statusCode"])
        rendered = json.dumps(projected)
        for value in (*SECRET_SENTINELS, "private-business-id", "Environment", "controllerTruth"):
            self.assertNotIn(value, rendered)
        tools.capture_baseline()
        for _, _, body in boundary.s3_writes:
            captured = body.decode("utf-8") if isinstance(body, bytes) else str(body)
            for value in (*SECRET_SENTINELS, "private-business-id", "controllerTruth"):
                self.assertNotIn(value, captured)

    def test_capture_reference_preserves_coverage_gaps_and_current_configuration_time(self):
        boundary = FakeAWSBoundary()

        def fail_metrics(_request, _page):
            raise RuntimeError("source unavailable")

        boundary.responses[("cloudwatch", "get_metric_data")] = fail_metrics
        tools, boundary, _ = self.make_tools(boundary)
        baseline = tools.capture_baseline()
        reference = baseline["captureRef"]
        self.assertEqual("partial", reference["completeness"])
        self.assertTrue(any("metrics" in gap for gap in reference["gaps"]))
        self.assertEqual({"logs", "metrics", "configuration", "changeHistory"}, set(reference["coverage"]))
        self.assertTrue(reference["configurationObservedAt"])
        query_result = tools.read_configuration(resource="inventory")
        self.assertEqual("current", query_result["query"]["view"])
        self.assertEqual("2026-11-09T23:10:00.000Z", query_result["query"]["referenceTransitionAt"])
        self.assertEqual(query_result["observedAt"], query_result["window"]["start"])
        combined = tools.persist_query_results([])["captureRef"]
        self.assertEqual("partial", combined["completeness"])
        self.assertIn("metrics", " ".join(combined["gaps"]))
        self.assertIn("queryResultsKey", combined)

    def test_cloudtrail_continuation_after_page_cap_is_marked_partial(self):
        boundary = FakeAWSBoundary()
        boundary.more_pages = True
        tools, boundary, _ = self.make_tools(boundary)
        result = tools.read_change_history(resource="inventory")
        self.assertTrue(result["truncated"])
        self.assertEqual("partial", result["completeness"])
        self.assertLessEqual(max(boundary.pages.values()), 8 * 3)

    def test_single_oversized_observation_is_omitted_without_hanging(self):
        tools, _, _ = self.make_tools()
        result = tools._bound_result({
            "source": "configuration",
            "scope": ["inventory"],
            "query": {},
            "window": {"start": "2026-11-09T23:10:00Z", "end": "2026-11-09T23:10:00Z"},
            "observedAt": "2026-11-09T23:10:00Z",
            "completeness": "complete",
            "truncated": False,
            "errors": [],
            "observations": [{"policy": "x" * 20_000}],
        })
        self.assertLessEqual(len(json.dumps(result).encode("utf-8")), 12 * 1024)
        self.assertTrue(result["truncated"])
        self.assertEqual("partial", result["completeness"])
        self.assertTrue(result["gaps"])

    def test_capture_and_query_persistence_are_private_and_sanitized(self):
        tools, boundary, _ = self.make_tools()
        baseline = tools.capture_baseline()
        query_capture = tools.persist_query_results(
            [{"source": "logs", "message": f"authorization: {SECRET_SENTINELS[0]}"}]
        )
        self.assertIn("captureRef", baseline)
        self.assertIn("gaps", baseline["captureRef"])
        self.assertIn("coverage", baseline["captureRef"])
        self.assertIn("configurationObservedAt", baseline["captureRef"])
        self.assertTrue(query_capture["persisted"])
        self.assertEqual(2, len(boundary.s3_writes))
        for bucket, key, body in boundary.s3_writes:
            self.assertEqual(SOURCE_BUCKET, bucket)
            self.assertTrue(key.startswith(SOURCE_PREFIX + "evidence-test-run/"))
            rendered = body.decode("utf-8") if isinstance(body, bytes) else str(body)
            for sentinel in SECRET_SENTINELS:
                self.assertNotIn(sentinel, rendered)
            self.assertNotIn("Environment", rendered)


if __name__ == "__main__":
    unittest.main()
