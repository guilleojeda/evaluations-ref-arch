"""Exercise source export through the same bounded AWS reader as live tools."""

from __future__ import annotations

import importlib
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

AGENT_DIR = Path(__file__).resolve().parents[1] / "agent"
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

from evidence import EvidenceTools
from support.phase4_agent_fakes import ALARM_ARN, FakeAWSBoundary, SECRET_SENTINELS, SOURCE_BUCKET, SOURCE_PREFIX

START = "2026-11-09T23:08:00.000Z"
END = "2026-11-09T23:10:00.000Z"
ORIGIN = {"alarmArn": ALARM_ARN, "transitionAt": END, "runId": "retained-investigation",
          "accountId": "123456789012", "region": "us-east-1", "apiId": "api-123456"}
INVENTORY = "IncidentTriageDemoInventory"


class SourceExportTests(unittest.TestCase):
    def test_slow_gateway_pages_leave_time_for_inventory_and_the_other_sources(self):
        boundary = FakeAWSBoundary()
        evidence = EvidenceTools(
            boundary, account_id=ORIGIN["accountId"], region=ORIGIN["region"], app_http_api_id=ORIGIN["apiId"],
            source_bucket=SOURCE_BUCKET, source_prefix=SOURCE_PREFIX, run_id=ORIGIN["runId"], alarm_arn=ALARM_ARN,
            transition_at=END, started_at=END, deadline_monotonic=60,
            charge_tool_call=lambda: self.fail("an export does not charge model tool calls"),
        )
        elapsed = 0

        def logs(request, page):
            nonlocal elapsed
            if request["logGroupName"].endswith("IncidentTriageDemoApp"):
                elapsed += 4
                return {"events": [{"eventId": f"gateway-{page}", "message": "request observed"}], "nextToken": "more"}
            if request["logGroupName"].endswith(INVENTORY):
                return {"events": [{"eventId": "inventory", "message": "request observed"}]}
            return {"events": []}

        boundary.responses[("logs", "filter_log_events")] = logs
        with patch("evidence.time.monotonic", side_effect=lambda: elapsed):
            sources = evidence.collect_sources(START, END)

        log_events = {item["eventId"] for item in sources["logs"]["observations"]}
        self.assertTrue(any(event.startswith("gateway-") for event in log_events))
        self.assertIn("inventory", log_events)
        self.assertTrue(any("gateway" in error and "deadline" in error for error in sources["logs"]["errors"]))
        self.assertNotEqual("unavailable", sources["metrics"]["completeness"])
        self.assertNotEqual("unavailable", sources["configuration"]["completeness"])
        self.assertNotEqual("unavailable", sources["changeHistory"]["completeness"])

    def test_export_queries_all_four_sources_and_keeps_more_than_a_model_response(self):
        module = importlib.import_module("captured_evidence")
        boundary = FakeAWSBoundary()
        charges = []
        evidence = EvidenceTools(
            boundary, account_id=ORIGIN["accountId"], region=ORIGIN["region"], app_http_api_id=ORIGIN["apiId"],
            source_bucket=SOURCE_BUCKET, source_prefix=SOURCE_PREFIX, run_id=ORIGIN["runId"], alarm_arn=ALARM_ARN,
            transition_at=END, started_at=END, deadline_monotonic=time.monotonic() + 60,
            charge_tool_call=lambda: charges.append(1),
        )

        events = [
            {"eventId": f"inventory-event-{i:03}", "timestamp": 1794265710000 + i,
             "ingestionTime": 1794265712000 + i, "message": json.dumps({
                 "operation": "check stock", "outcome": "authorized", "requestId": f"known-public-id-{i:03}",
                 "authorization": SECRET_SENTINELS[0], "controllerTruth": SECRET_SENTINELS[2],
             })}
            for i in range(131)
        ]

        def logs(request, _page):
            if not request["logGroupName"].endswith(INVENTORY):
                return {"events": []}
            if request.get("nextToken") == "body":
                return {"events": events[:100], "nextToken": "tail"}
            if request.get("nextToken") == "tail":
                return {"events": events[100:]}
            return {"events": [], "nextToken": "body"}

        boundary.responses[("logs", "filter_log_events")] = logs
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "capture.json"
            module.export_bundle(path, origin=ORIGIN, evidence=evidence, start=START, end=END)
            raw = path.read_text()
            bundle = json.loads(raw)

        self.assertEqual({"logs", "metrics", "configuration", "changeHistory"}, set(bundle["sources"]))
        self.assertGreater(len(raw.encode()), 12 * 1024)
        self.assertIn("inventory-event-000", raw)
        self.assertIn("inventory-event-130", raw)
        self.assertIn(ALARM_ARN, raw)
        for secret in SECRET_SENTINELS:
            self.assertNotIn(secret, raw)
        self.assertNotIn('"Environment"', raw)
        requests = {(service, operation) for service, operation, _ in boundary.calls}
        self.assertLessEqual({("logs", "filter_log_events"), ("cloudwatch", "get_metric_data"),
                              ("lambda", "get_alias"), ("cloudtrail", "lookup_events")}, requests)
        self.assertFalse(any(service in {"bedrock-runtime", "bedrock-agentcore", "s3"} for service, _ in requests))
        self.assertEqual([], charges, "export is independent of model-selected tool calls")
        self.assertEqual([], boundary.s3_writes)


if __name__ == "__main__":
    unittest.main()
