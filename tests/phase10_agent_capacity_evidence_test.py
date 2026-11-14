"""Acceptance checks for evidence that can attribute Inventory throttling."""

from __future__ import annotations

import json
import sys
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

AGENT_DIR = Path(__file__).resolve().parents[1] / "agent"
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

from evidence import CHECKOUT_FUNCTION, INVENTORY_FUNCTION, EvidenceTools
from support.phase4_agent_fakes import (
    ALARM_ARN,
    SECRET_SENTINELS,
    SOURCE_BUCKET,
    SOURCE_PREFIX,
    FakeAWSBoundary,
)


START = "2026-11-13T10:00:00Z"
END = "2026-11-13T10:05:00Z"
REQUEST_ID = "capacity-request-123"


class InventoryCapacityEvidenceTests(unittest.TestCase):
    def make_tools(self, boundary: FakeAWSBoundary | None = None):
        boundary = boundary or FakeAWSBoundary()
        tools = EvidenceTools(
            boundary,
            account_id="123456789012",
            region="us-east-1",
            app_http_api_id="api-123456",
            source_bucket=SOURCE_BUCKET,
            source_prefix=SOURCE_PREFIX,
            run_id="phase10-capacity-evidence-test",
            alarm_arn=ALARM_ARN,
            transition_at="2026-11-13T10:05:00.000Z",
            started_at="2026-11-13T10:05:01.000Z",
            deadline_monotonic=time.monotonic() + 60,
            charge_tool_call=lambda: None,
        )
        return tools, boundary

    def test_inventory_metrics_preserve_native_statistics_dimensions_period_and_window(self):
        metric_values = {
            "Invocations": [0],
            "Errors": [0],
            "Throttles": [2],
            "Duration": [17.5],
            "ConcurrentExecutions": [3],
        }
        boundary = FakeAWSBoundary()
        boundary.responses[("cloudwatch", "get_metric_data")] = {
            "MetricDataResults": [
                {
                    "Id": f"inve{index}",
                    "Label": metric_name,
                    "Timestamps": ["2026-11-13T10:01:00Z"],
                    "Values": values,
                    "StatusCode": "Complete",
                }
                for index, (metric_name, values) in enumerate(metric_values.items())
            ]
        }
        tools, boundary = self.make_tools(boundary)

        result = tools.read_metrics(resource="inventory", start=START, end=END, period_seconds=60)

        request = next(
            request
            for service, operation, request in boundary.calls
            if service == "cloudwatch" and operation == "get_metric_data"
        )
        request_by_name = {
            item["MetricStat"]["Metric"]["MetricName"]: item
            for item in request["MetricDataQueries"]
        }
        request_by_id = {item["Id"]: item["MetricStat"] for item in request["MetricDataQueries"]}
        expected_statistics = {
            "Invocations": "Sum",
            "Throttles": "Sum",
            "ConcurrentExecutions": "Maximum",
        }
        expected_dimension = [{"Name": "FunctionName", "Value": INVENTORY_FUNCTION}]
        self.assertEqual(set(metric_values), set(request_by_name))
        for name, statistic in expected_statistics.items():
            with self.subTest(metric=name):
                metric_stat = request_by_name[name]["MetricStat"]
                self.assertEqual("AWS/Lambda", metric_stat["Metric"]["Namespace"])
                self.assertEqual(expected_dimension, metric_stat["Metric"]["Dimensions"])
                self.assertEqual(statistic, metric_stat["Stat"])
                self.assertEqual(60, metric_stat["Period"])

        self.assertEqual(datetime(2026, 11, 13, 10, 0, tzinfo=timezone.utc), request["StartTime"])
        self.assertEqual(datetime(2026, 11, 13, 10, 5, tzinfo=timezone.utc), request["EndTime"])
        self.assertEqual({"start": "2026-11-13T10:00:00.000Z", "end": "2026-11-13T10:05:00.000Z"}, result["window"])
        self.assertEqual("complete", result["completeness"])
        self.assertEqual(metric_values, {item["Label"]: item["Values"] for item in result.get("observations", [])})

        # Keep each native MetricStat beside its CloudWatch result ID so the
        # agent can associate values with their statistic and dimensions.
        returned_metrics = result["query"].get("metrics")
        if not isinstance(returned_metrics, list):
            returned_metrics = []
        returned_metadata_by_id = {
            item["Id"]: item["MetricStat"]
            for item in returned_metrics
        }
        with self.subTest(contract="native metric metadata"):
            self.assertEqual(request_by_id, returned_metadata_by_id)
        with self.subTest(contract="result IDs match query metadata IDs"):
            self.assertEqual(
                {observation["Id"] for observation in result["observations"]},
                set(returned_metadata_by_id),
            )

    def test_empty_inventory_metrics_remain_empty_instead_of_becoming_zero_samples(self):
        boundary = FakeAWSBoundary()
        boundary.responses[("cloudwatch", "get_metric_data")] = {"MetricDataResults": []}
        tools, _ = self.make_tools(boundary)

        result = tools.read_metrics(resource="inventory", start=START, end=END, period_seconds=60)

        self.assertEqual([], result.get("observations", []))
        self.assertEqual("complete", result["completeness"])
        self.assertFalse(result["truncated"])

    def test_gateway_and_checkout_logs_retain_safe_throttle_attribution_evidence(self):
        boundary = FakeAWSBoundary()
        gateway_log = {
            "requestId": REQUEST_ID,
            "routeKey": "GET /api/products",
            "status": "502",
            "integrationStatus": "200",
            "integrationError": "",
            "authorization": f"Bearer {SECRET_SENTINELS[0]}",
            "apiKey": SECRET_SENTINELS[1],
            "privateNote": SECRET_SENTINELS[2],
        }
        checkout_log = {
            "requestId": REQUEST_ID,
            "lambdaRequestId": "checkout-lambda-request-456",
            "operation": "products",
            "statusCode": 502,
            "errorCode": "INVENTORY_LOOKUP_FAILED",
            "errorName": "TooManyRequestsException",
            "dependencyErrorName": "TooManyRequestsException",
            "dependencyFailureReason": "transport_error",
            "dependencyThrottleReason": "ReservedFunctionInvocationRateLimitExceeded",
            "dependencyDurationMs": 12,
            "authorization": f"Bearer {SECRET_SENTINELS[0]}",
            "presenterToken": SECRET_SENTINELS[1],
            "controllerTruth": SECRET_SENTINELS[2],
        }

        def logs_for_resource(request: Mapping[str, Any], _page: int) -> dict[str, Any]:
            if request["logGroupName"] == "/aws/apigateway/IncidentTriageDemoApp":
                message = gateway_log
            elif request["logGroupName"] == f"/aws/lambda/{CHECKOUT_FUNCTION}":
                message = checkout_log
            else:
                return {"events": []}
            return {"events": [{"timestamp": 1_795_000_000_000, "message": json.dumps(message)}]}

        boundary.responses[("logs", "filter_log_events")] = logs_for_resource
        tools, _ = self.make_tools(boundary)

        gateway = tools.search_logs(resource="gateway", start=START, end=END)
        caller = tools.search_logs(resource="checkout", start=START, end=END)

        gateway_fields = gateway["observations"][0]["fields"]
        for field, expected in {
            "requestId": REQUEST_ID,
            "routeKey": "GET /api/products",
            "status": "502",
            "integrationStatus": "200",
            "integrationError": "",
        }.items():
            with self.subTest(source="gateway", field=field):
                self.assertEqual(expected, gateway_fields.get(field))

        caller_fields = caller["observations"][0]["fields"]
        with self.subTest(source="checkout caller"):
            self.assertEqual(REQUEST_ID, caller_fields["requestId"])
            self.assertEqual(502, caller_fields["statusCode"])
            self.assertEqual("INVENTORY_LOOKUP_FAILED", caller_fields["errorCode"])
            self.assertEqual("TooManyRequestsException", caller_fields["dependencyErrorName"])
            self.assertEqual("transport_error", caller_fields["dependencyFailureReason"])
            self.assertEqual("ReservedFunctionInvocationRateLimitExceeded", caller_fields.get("dependencyThrottleReason"))

        rendered = json.dumps({"gateway": gateway, "caller": caller})
        for value in (*SECRET_SENTINELS, "authorization", "apiKey", "presenterToken", "controllerTruth"):
            self.assertNotIn(value, rendered)


if __name__ == "__main__":
    unittest.main()
