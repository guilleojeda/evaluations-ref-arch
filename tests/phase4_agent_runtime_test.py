"""Acceptance tests for the bounded Python AgentCore Runtime entrypoint."""

from __future__ import annotations

import json
from datetime import datetime
import unittest

from support.phase4_agent_fakes import (
    ALARM_ARN,
    MODEL_ID,
    RUN_TABLE,
    SECRET_SENTINELS,
    AgentScript,
    FakeAWSBoundary,
    ToolStep,
    alarm_event,
    isolated_runtime,
    report,
    runtime_context,
    tool_arguments,
)


TOOLS = {"search_logs", "read_metrics", "read_configuration", "read_change_history"}
TRANSITION = "2026-11-09T23:10:00.000Z"
APP_FUNCTIONS = {"IncidentTriageDemoCheckout", "IncidentTriageDemoInventory"}
APP_LOG_GROUPS = {
    "/aws/lambda/IncidentTriageDemoCheckout",
    "/aws/lambda/IncidentTriageDemoInventory",
    "/aws/apigateway/IncidentTriageDemoApp",
}


class RuntimeAcceptanceTests(unittest.TestCase):
    def invoke(self, module, event=None, session_id="runtime-session-1"):
        return module.invoke(event if event is not None else alarm_event(), runtime_context(session_id))

    @staticmethod
    def run_row(boundary):
        row = boundary.runs.find(ALARM_ARN, TRANSITION)
        if row is None:
            raise AssertionError("Runtime did not persist the originating event row")
        return row

    def assert_invalid_without_claim(self, module, boundary, script, event):
        try:
            response = module.invoke(event, runtime_context("invalid-session"))
        except TypeError as exc:
            self.fail(f"invalid-event rejection must be explicit, not an entrypoint signature error: {exc}")
        except Exception:
            response = None
        if response is not None:
            status = str(response.get("status", "")).lower() if isinstance(response, dict) else ""
            self.assertIn(status, {"invalid", "rejected", "error"}, response)
        self.assertEqual({}, boundary.runs.rows)
        self.assertEqual(0, script.invocations)
        self.assertEqual([], boundary.calls)

    def test_invalid_alarm_events_are_rejected_before_claim_or_model(self):
        invalid = [
            None,
            [],
            {**alarm_event(), "source": "untrusted.source"},
            {**alarm_event(), "accountId": "999999999999"},
            {**alarm_event(), "region": "us-west-2"},
            alarm_event(alarm_arn="arn:aws:cloudwatch:us-east-1:123456789012:alarm:Other"),
            alarm_event(state="OK"),
            alarm_event(timestamp="not-a-timestamp"),
        ]
        for event in invalid:
            with self.subTest(event=event):
                script, boundary = AgentScript(report=report()), FakeAWSBoundary()
                with isolated_runtime(script, boundary) as (module, _):
                    self.assert_invalid_without_claim(module, boundary, script, event)

    def test_normalized_equivalent_transition_uses_one_claim_and_preserves_report(self):
        expected = report()
        script, boundary = AgentScript(report=expected), FakeAWSBoundary()
        with isolated_runtime(script, boundary) as (module, _):
            first = self.invoke(module, session_id="runtime-session-1")
            original = dict(self.run_row(boundary))
            first_claim = next(request["Item"] for operation, request in boundary.runs.operations if operation == "put_item")
            first_claim_status = first_claim["status"]
            if isinstance(first_claim_status, dict):
                first_claim_status = first_claim_status.get("S")
            self.assertEqual("running", first_claim_status)
            second_event = alarm_event(timestamp="2026-11-09T18:10:00-05:00")
            second = self.invoke(module, second_event, session_id="runtime-session-2")

        row = self.run_row(boundary)
        self.assertEqual(1, script.invocations)
        self.assertEqual(1, len(boundary.runs.rows))
        self.assertEqual(ALARM_ARN, row["alarmArn"])
        self.assertEqual(TRANSITION, row["transitionAt"])
        self.assertEqual("complete", row["status"])
        self.assertEqual(expected, row["report"])
        self.assertEqual(original, row, "duplicate delivery must not rewrite the terminal row")
        self.assertEqual(original.get("runId"), row.get("runId"))
        self.assertEqual("runtime-session-1", row["runtimeSessionId"])
        self.assertIsNotNone(first)
        self.assertIsNotNone(second)
        self.assertEqual(MODEL_ID, row["modelId"])

    def test_existing_claim_and_ambiguous_insert_ack_never_start_second_model(self):
        for ambiguous in (False, True):
            with self.subTest(ambiguous=ambiguous):
                script, boundary = AgentScript(report=report()), FakeAWSBoundary()
                if ambiguous:
                    boundary.runs.lose_next_put_ack = True
                else:
                    boundary.runs.seed({
                        "pk": ALARM_ARN, "sk": TRANSITION, "alarmArn": ALARM_ARN,
                        "transitionAt": TRANSITION, "runId": "prior-run", "runtimeSessionId": "prior-session",
                        "status": "running", "startedAt": TRANSITION,
                    })
                with isolated_runtime(script, boundary) as (module, _):
                    if ambiguous:
                        try:
                            self.invoke(module, session_id="redelivered-session")
                        except TypeError as exc:
                            self.fail(f"ambiguous-claim behavior requires invoke(payload, context): {exc}")
                        except Exception:
                            pass
                    else:
                        self.invoke(module, session_id="redelivered-session")
                self.assertEqual(0, script.invocations)
                self.assertEqual(1, len(boundary.runs.rows))
                row = self.run_row(boundary)
                self.assertEqual("running", row["status"])
                if not ambiguous:
                    self.assertEqual("prior-session", row["runtimeSessionId"])

    def test_model_failure_is_failed_while_unknown_report_is_completed(self):
        script, boundary = AgentScript(failure=RuntimeError("controlled model failure")), FakeAWSBoundary()
        with isolated_runtime(script, boundary) as (module, _):
            try:
                self.invoke(module)
            except RuntimeError:
                pass
        failed = self.run_row(boundary)
        self.assertEqual("failed", failed["status"])
        self.assertNotIn("report", failed)
        self.assertTrue(failed.get("failure"))

        script, boundary = AgentScript(report=report()), FakeAWSBoundary()
        with isolated_runtime(script, boundary) as (module, _):
            self.invoke(module)
        complete = self.run_row(boundary)
        self.assertEqual("complete", complete["status"])
        self.assertEqual("unknown", complete["report"]["assessment"])

    def test_invalid_structured_report_fails_instead_of_becoming_unknown(self):
        invalid_report = report()
        invalid_report["recommendation"]["action"] = "Invented action"
        script, boundary = AgentScript(report=invalid_report), FakeAWSBoundary()
        with isolated_runtime(script, boundary) as (module, _):
            try:
                self.invoke(module)
            except TypeError as exc:
                self.fail(f"report validation requires invoke(payload, context): {exc}")
            except Exception:
                pass
        row = self.run_row(boundary)
        self.assertEqual("failed", row["status"])
        self.assertNotIn("report", row)

    def test_four_readonly_tools_run_in_model_chosen_order_and_project_configuration(self):
        order = ("read_change_history", "read_metrics", "search_logs", "read_configuration")
        script = AgentScript(steps=tuple(ToolStep(name) for name in order), report=report())
        boundary = FakeAWSBoundary()
        with isolated_runtime(script, boundary) as (module, _):
            self.invoke(module)

        self.assertEqual(1, script.invocations)
        self.assertEqual(TOOLS, set(script.tool_names))
        self.assertEqual(list(order), [name for name, _ in script.tool_results])
        self.assertTrue(all(not isinstance(result, Exception) for _, result in script.tool_results))
        self.assertEqual(TOOLS, {name for name, _ in script.tool_results})
        self.assertTrue(boundary.calls)
        self.assertTrue(all(operation in FakeAWSBoundary.READS[service] for service, operation, _ in boundary.calls))
        for value in SECRET_SENTINELS:
            rendered = json.dumps(script.tool_results, default=str)
            self.assertNotIn(value, rendered)
        rendered = json.dumps(script.tool_results, default=str).lower()
        self.assertNotIn("environment", rendered)
        self.assertNotIn("controller_baseline", rendered)
        self.assertNotIn("controller-truth", rendered)
        self.assertIn("source", rendered)
        self.assertTrue(any(field in rendered for field in ("windowStart", "window", "timeWindow")))
        self.assertIn("observedAt", rendered)
        for source in ("logs", "cloudwatch", "lambda", "iam", "cloudtrail"):
            self.assertTrue(any(service == source for service, _, _ in boundary.calls), source)
        self.assertTrue(any(source == "lambda" and operation == "get_function_configuration" for source, operation, _ in boundary.calls))
        self.assertTrue(all(op in {"put_item", "update_item", "query", "get_item"} for op, _ in boundary.runs.operations))
        self.assertTrue(all(request.get("TableName", RUN_TABLE) == RUN_TABLE for _, request in boundary.runs.operations))
        self.assert_allowlisted_source_requests(boundary.calls)

    def assert_allowlisted_source_requests(self, calls):
        for service, operation, request in calls:
            serialized = json.dumps(request, default=str)
            self.assertNotIn("IncidentTriageDemoController", serialized)
            if service == "lambda" and request.get("FunctionName"):
                function = str(request["FunctionName"])
                self.assertTrue(any(name in function for name in APP_FUNCTIONS), request)
            if service == "logs":
                log_groups = request.get("logGroupNames", request.get("logGroupName", []))
                if isinstance(log_groups, str):
                    log_groups = [log_groups]
                self.assertTrue(set(log_groups).issubset(APP_LOG_GROUPS), request)
                for log_group in APP_LOG_GROUPS:
                    if log_group in str(request.get("queryString", "")):
                        break
                else:
                    self.assertFalse("/aws/" in str(request.get("queryString", "")), request)
            self.assertNotIn("controller", serialized.lower())

    def test_tool_rejects_out_of_scope_resource_and_windows_before_source_reads(self):
        for name, option in (("search_logs", "invalid_resource"), ("search_logs", "invalid_window")):
            with self.subTest(tool=name, option=option):
                supplied: list[dict[str, object]] = []

                def invalid_arguments(tool):
                    args = tool_arguments(tool, **{option: True})
                    supplied.append(args)
                    return args

                script = AgentScript(steps=(ToolStep(name, invalid_arguments, capture_error=True),), report=report())
                boundary = FakeAWSBoundary()
                with isolated_runtime(script, boundary) as (module, _):
                    self.invoke(module)
                self.assertTrue(supplied)
                if option == "invalid_resource":
                    exercised = "controller" in json.dumps(supplied).lower()
                    source_calls = [call for call in boundary.calls if call[0] == "logs"]
                    if exercised:
                        self.assertIsInstance(script.tool_results[0][1], Exception)
                        self.assertEqual([], source_calls, "out-of-scope resource must be rejected before AWS")
                    else:
                        self.assertFalse(isinstance(script.tool_results[0][1], Exception))
                        self.assert_allowlisted_source_requests(boundary.calls)
                else:
                    exercised = any(
                        (any(part in key.lower() for part in ("start", "from")) and value == "2026-11-09T22:00:00Z")
                        or (any(part in key.lower() for part in ("lookback", "minute")) and value == 60)
                        for key, value in supplied[0].items()
                    )
                    source_calls = [call for call in boundary.calls if call[0] == "logs"]
                    if exercised:
                        self.assertIsInstance(script.tool_results[0][1], Exception)
                        self.assertEqual([], source_calls, "query outside the supported window must be rejected before AWS")
                    else:
                        self.assertFalse(isinstance(script.tool_results[0][1], Exception))
                        self.assert_query_windows_within_30_minutes(source_calls)

    def assert_query_windows_within_30_minutes(self, calls):
        for _, operation, request in calls:
            start, end = request.get("startTime", request.get("StartTime")), request.get("endTime", request.get("EndTime"))
            if isinstance(start, (int, float)) and isinstance(end, (int, float)):
                seconds = end - start
                self.assertLessEqual(seconds, 1_800_000 if operation in {"filter_log_events", "get_log_events"} else 1_800,
                                     (operation, request))
            elif isinstance(start, str) and isinstance(end, str):
                start_at = datetime.fromisoformat(start.replace("Z", "+00:00"))
                end_at = datetime.fromisoformat(end.replace("Z", "+00:00"))
                self.assertLessEqual((end_at - start_at).total_seconds(), 1_800, (operation, request))

    def test_model_request_budget_stops_after_twelve_requests(self):
        # Use the real locked Strands Agent loop and BedrockModel, with only its
        # streaming API replaced by a no-network model that keeps requesting tools.
        script, boundary = AgentScript(), FakeAWSBoundary()
        with isolated_runtime(script, boundary, real_strands=True) as (module, _):
            try:
                self.invoke(module)
            except TypeError as exc:
                self.fail(f"model request budget requires invoke(payload, context): {exc}")
            except Exception:
                pass  # Exhausting the turn budget must not produce a completed report.
        self.assertEqual(12, len(boundary.model_requests),
                         "the deliberately unending model must reach the limit; an earlier unrelated failure is not budget proof")
        row = self.run_row(boundary)
        self.assertNotEqual("complete", row["status"])
        self.assertNotIn("report", row)

    def test_query_output_and_pagination_are_bounded_and_mark_truncation(self):
        script = AgentScript(steps=(ToolStep("search_logs"),), report=report())
        boundary = FakeAWSBoundary()
        boundary.more_pages = True
        boundary.large_log_count = 300
        with isolated_runtime(script, boundary) as (module, _):
            self.invoke(module)

        results = json.dumps(script.tool_results, default=str)
        self.assertLessEqual(len(results.encode("utf-8")), 12 * 1024)
        self.assertRegex(results.lower(), r"truncat.{0,24}(true|yes|partial)")
        self.assertTrue(boundary.calls)
        self.assertLess(max(boundary.pages.values()), 20)
        for service, operation, params in boundary.calls:
            start = params.get("startTime", params.get("StartTime"))
            end = params.get("endTime", params.get("EndTime"))
            if isinstance(start, (int, float)) and isinstance(end, (int, float)):
                window = end - start
                self.assertLessEqual(window, 1_800_000 if operation in {"filter_log_events", "get_log_events"} else 1_800)
            elif isinstance(start, str) and isinstance(end, str):
                start_at = datetime.fromisoformat(start.replace("Z", "+00:00"))
                end_at = datetime.fromisoformat(end.replace("Z", "+00:00"))
                self.assertLessEqual((end_at - start_at).total_seconds(), 1_800)

    def test_claim_persists_the_approved_240_second_deadline(self):
        script, boundary = AgentScript(report=report()), FakeAWSBoundary()
        with isolated_runtime(script, boundary) as (module, _):
            self.invoke(module)
        row = self.run_row(boundary)
        started = datetime.fromisoformat(str(row["startedAt"]).replace("Z", "+00:00"))
        deadline = datetime.fromisoformat(str(row["deadlineAt"]).replace("Z", "+00:00"))
        self.assertEqual(240.0, (deadline - started).total_seconds())


if __name__ == "__main__":
    unittest.main()
