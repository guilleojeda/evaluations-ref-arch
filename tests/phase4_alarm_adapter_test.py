"""Acceptance checks for the Lambda alarm adapter's forward-only boundary."""

from __future__ import annotations

import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from support.phase4_agent_fakes import ALARM_ARN, FakeAWSBoundary, alarm_event, isolated_adapter


def forwarded_alarm(request):
    payload = request["payload"]
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    if isinstance(payload, bytes):
        payload = json.loads(payload)
    return payload.get("event", payload.get("alarmEvent", payload))


class AlarmAdapterAcceptanceTests(unittest.TestCase):
    @staticmethod
    def call(handler, event):
        return handler(event, SimpleNamespace(aws_request_id="lambda-request-1"))

    def test_rejects_invalid_alarm_events_without_runtime_or_run_store_access(self):
        invalid_events = [
            {**alarm_event(), "source": "untrusted.source"},
            {**alarm_event(), "accountId": "999999999999"},
            {**alarm_event(), "region": "us-west-2"},
            alarm_event(alarm_arn="arn:aws:cloudwatch:us-east-1:123456789012:alarm:Other"),
            alarm_event(state="OK"),
            alarm_event(timestamp="not-a-timestamp"),
        ]
        for event in invalid_events:
            with self.subTest(event=event), isolated_adapter() as (module, boundary):
                try:
                    response = self.call(module.handler, event)
                except TypeError as exc:
                    self.fail(f"adapter rejection must be explicit, not a handler signature error: {exc}")
                except Exception:
                    response = None
                if response is not None:
                    status = str(response.get("status", "")).lower() if isinstance(response, dict) else ""
                    self.assertIn(status, {"invalid", "rejected", "error"}, response)
                self.assertEqual([], boundary.runtime.requests)
                self.assertEqual([], boundary.runs.operations, "the adapter must not claim or persist runs")
                self.assertEqual([], boundary.s3_writes)

    def test_retry_after_lost_adapter_reply_forwards_the_same_originating_alarm(self):
        event = alarm_event(timestamp="2026-11-09T18:10:00-05:00")
        with isolated_adapter() as (module, boundary):
            boundary.runtime.lose_next_reply = True
            with self.assertRaises(Exception) as failure:
                self.call(module.handler, event)
            self.assertNotIsInstance(failure.exception, TypeError,
                                     "a missing handler signature is not retryable delivery behavior")
            self.call(module.handler, event)

        self.assertEqual(2, len(boundary.runtime.requests))
        first, second = (forwarded_alarm(request) for request in boundary.runtime.requests)
        for forwarded in (first, second):
            self.assertEqual(ALARM_ARN, forwarded["alarmArn"])
            self.assertEqual("2026-11-09T18:10:00-05:00", forwarded["alarmData"]["state"]["timestamp"])
            self.assertEqual("ALARM", forwarded["alarmData"]["state"]["value"])
        self.assertEqual(first, second, "a Lambda retry must preserve the original event identity and payload")
        for request in boundary.runtime.requests:
            self.assertTrue(request.get("runtimeSessionId"), "Runtime sessions must be supplied by AgentCore's invocation API")
            self.assertIn("agentRuntimeArn", request)
            self.assertEqual("application/json", request["contentType"])
            self.assertEqual("application/json", request["accept"])
            attestation = json.loads(request["payload"])["deployment"]
            self.assertEqual("faulty", attestation["endpointName"])
            self.assertEqual("1", attestation["runtimeVersion"])
            self.assertEqual("a" * 40, attestation["sourceRevision"])
            self.assertEqual("a" * 64, attestation["artifactSha256"])
        self.assertEqual([], boundary.runs.operations)
        self.assertEqual([], boundary.s3_writes)

    def test_only_sampled_lambda_trace_context_is_forwarded(self):
        trace_header = "Root=1-672f1f7a-0123456789abcdef01234567;Parent=0123456789abcdef;Sampled=1"
        with isolated_adapter() as (module, boundary), patch.dict(os.environ, {"_X_AMZN_TRACE_ID": trace_header}):
            self.call(module.handler, alarm_event())
        self.assertEqual(trace_header, boundary.runtime.requests[0]["traceId"])

        unsampled = trace_header.replace("Sampled=1", "Sampled=0")
        with isolated_adapter() as (module, boundary), patch.dict(os.environ, {"_X_AMZN_TRACE_ID": unsampled}):
            self.call(module.handler, alarm_event())
        self.assertNotIn("traceId", boundary.runtime.requests[0])


if __name__ == "__main__":
    unittest.main()
