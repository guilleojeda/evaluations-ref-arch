"""Acceptance tests for the Phase 15 deterministic check CLI.

The tests use the Phase 14 case/bundle writer for the reviewed input boundary
and a small synthetic native archive for the recorded trace boundary.  The
archive follows the private ``phase4-capture-investigation/v1`` shape but
contains only fake IDs and bounded observations.
"""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
PHASE14_TEST = ROOT / "tests" / "phase14_reviewed_cases_test.py"
START = "2026-11-13T10:00:00.000Z"
TRANSITION = "2026-11-13T10:05:00.000Z"
REFERENCE = TRANSITION
AFTER_REFERENCE = "2026-11-13T10:05:01.000Z"
ALARM_ARN = "arn:aws:cloudwatch:us-east-1:123456789012:alarm:Phase13Fixture"
RUN_ID = "phase13-fixture-run"
TRACE_ID = "phase15-fake-trace"
SESSION_ID = "phase15-fake-session"
CANDIDATE_ID = "phase15-synthetic-candidate"
TRACE_SOURCE = "phase15-synthetic-native-trace.json"
EXPECTED_FINDINGS = {
    "report_structure",
    "assessment",
    "action",
    "target",
    "target_value",
    "source_scope",
    "as_of_time",
    "operator_boundary",
}


def phase14_helpers() -> Any:
    """Load the established Phase 14 fixture helpers without duplicating them."""

    spec = importlib.util.spec_from_file_location("phase14_fixture_support", PHASE14_TEST)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load Phase 14 fixture helpers")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _iso_to_ns(value: str) -> int:
    text = value[:-1] + "+00:00" if value.endswith("Z") else value
    parsed = datetime.fromisoformat(text).astimezone(timezone.utc)
    since_epoch = parsed - datetime(1970, 1, 1, tzinfo=timezone.utc)
    return (since_epoch.days * 86_400 + since_epoch.seconds) * 1_000_000_000 + since_epoch.microseconds * 1_000


def _json_digest(value: Any) -> str:
    body = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(body).hexdigest()


def citation(resource: str, observed_at: str, *, source: str = "logs") -> dict[str, str]:
    return {
        "source": source,
        "resource": resource,
        "windowStart": START,
        "windowEnd": REFERENCE,
        "observedAt": observed_at,
        "finding": f"Synthetic {source} observation for {resource} at {observed_at}.",
    }


def report_for(
    recommendation: dict[str, Any],
    *,
    assessment: str = "ongoing",
    late_citation: bool = False,
    extra_citations: Iterable[dict[str, str]] = (),
) -> dict[str, Any]:
    observed_at = AFTER_REFERENCE if late_citation else "2026-11-13T10:02:30.000Z"
    evidence = [
        citation("gateway", "2026-11-13T10:01:10.000Z"),
        citation("checkout", "2026-11-13T10:01:20.000Z"),
        citation("inventory", observed_at),
        citation("inventory", "2026-11-13T10:02:00.000Z", source="metrics"),
        citation("inventory", "2026-11-13T10:02:20.000Z", source="change_history"),
    ]
    evidence.extend(extra_citations)
    return {
        "assessment": assessment,
        "summary": "The synthetic report describes the observed incident and proposed response.",
        "recommendation": recommendation,
        "evidence": evidence,
        "uncertainties": ["Synthetic evidence is intentionally bounded."],
        "alternatives": ["A second supported read order would be equivalent."],
    }


def recommendation(action: str, target: str | None, value: Any, unit: str | None) -> dict[str, Any]:
    return {"action": action, "target": target, "value": value, "unit": unit}


def _tool_result(tool: str, resource: str, observed_at: str, *, late: bool = False) -> dict[str, Any]:
    if late:
        observed_at = AFTER_REFERENCE
    if tool == "read_configuration":
        observations: list[dict[str, Any]] = [
            {
                "function": "SyntheticInventory",
                "kind": "lambda-version",
                "configuration": {
                    "FunctionName": "SyntheticInventory",
                    "Version": "75",
                    "MemorySize": 256,
                    "Role": "arn:aws:iam::123456789012:role/SyntheticInventoryRole",
                },
            }
        ]
    elif tool == "read_metrics":
        observations = [
            {
                "Id": "inv0",
                "Label": "AWS/Lambda SyntheticInventory Throttles",
                "StatusCode": "Complete",
                "Timestamps": ["2026-11-13 10:01:00+00:00"],
                "Values": [0.0],
            }
        ]
    elif tool == "read_change_history":
        observations = [
            {
                "EventId": "phase15-change-1",
                "EventName": "UpdateFunctionConfiguration",
                "EventTime": "2026-11-13 10:01:30+00:00",
                "ReadOnly": "true",
                "lookupResource": "SyntheticInventory",
            }
        ]
    else:
        observations = [
            {
                "resource": resource,
                "eventId": f"phase15-{resource}-1",
                "timestamp": "2026-11-13T10:01:00.000Z",
                "fields": {
                    "requestId": f"phase15-{resource}-request",
                    "statusCode": 500 if resource == "inventory" else 502,
                },
            }
        ]
        if tool == "search_logs" and resource == "gateway":
            observations.append(
                {
                    "resource": "checkout",
                    "eventId": "phase15-checkout-1",
                    "timestamp": "2026-11-13T10:01:01.000Z",
                    "fields": {"requestId": "phase15-gateway-request", "statusCode": 502},
                }
            )
    return {
        "completeness": "complete",
        "errors": [],
        "observations": observations,
        "scope": [resource],
        "window": (
            {"start": observed_at, "end": observed_at}
            if tool == "read_configuration"
            else {"start": START, "end": REFERENCE}
        ),
        "observedAt": observed_at,
    }


def write_native_archive(
    path: Path,
    report: dict[str, Any] | None,
    *,
    reorder: bool = False,
    late_result: bool = False,
    late_ingestion: bool = False,
    out_of_scope: bool = False,
    missing_scope: bool = False,
    forbidden_tool: bool = False,
    unlinked_calls: bool = False,
    missing_trace: bool = False,
    span_outside_result: bool = False,
    overlapping_spans: bool = False,
    absent_advertised_tool: bool = False,
    untyped_report_tool: bool = False,
    explicit_call_id: str | None = None,
    numeric_observed_at: bool = False,
    mismatch: str | None = None,
) -> dict[str, Any]:
    """Write a bounded native trace archive and return its parsed value."""

    run_id = RUN_ID if mismatch != "run" else "phase15-other-run"
    alarm_arn = ALARM_ARN if mismatch != "alarm" else "arn:aws:cloudwatch:us-east-1:123456789012:alarm:Other"
    trace_id = TRACE_ID if mismatch != "trace" else "phase15-other-trace"
    session_id = "" if mismatch == "empty_session" else SESSION_ID
    trace_session_id = session_id if mismatch != "session" else "phase15-other-session"
    successful = [
        ("read_metrics", "inventory", "2026-11-13T10:02:00.000Z"),
        ("search_logs", "gateway", "2026-11-13T10:01:10.000Z"),
        ("read_configuration", "inventory", "2026-11-13T10:02:10.000Z"),
        ("read_metrics", "inventory", "2026-11-13T10:02:15.000Z"),
        ("search_logs", "inventory", "2026-11-13T10:01:30.000Z"),
        ("read_change_history", "inventory", "2026-11-13T10:02:20.000Z"),
    ]
    results = []
    for index, (tool, resource, observed_at) in enumerate(successful):
        result = _tool_result(tool, resource, observed_at, late=late_result and index == 4)
        if missing_scope and index == 0:
            del result["scope"]
        if late_ingestion and index == 4:
            result["observations"][0]["ingestionTime"] = _iso_to_ns(AFTER_REFERENCE) // 1_000_000
        if out_of_scope and index == 4:
            result["scope"] = ["orders"]
            result["observations"][0]["resource"] = "orders"
        query = {"tool": tool, "result": result}
        if explicit_call_id is not None and index == 4:
            query["toolCallId"] = explicit_call_id
            if explicit_call_id == "phase15-call-4":
                del result["observedAt"]
        if numeric_observed_at and index == 4:
            result["observedAt"] = 0
        results.append(query)

    result_document = {
        "schemaVersion": 1,
        "runId": run_id,
        "alarmArn": alarm_arn,
        "transitionAt": TRANSITION,
        "capturedAt": "2026-11-13T10:03:00.000Z",
        "results": results,
    }
    baseline_document = {
        "schemaVersion": 1,
        "runId": run_id,
        "alarmArn": alarm_arn,
        "transitionAt": TRANSITION,
        "capturedAt": "2026-11-13T10:03:00.000Z",
        "startedAt": "2026-11-13T10:00:01.000Z",
        "window": {"start": START, "end": REFERENCE},
        "observations": {"logs": [], "metrics": [], "configuration": [], "changeHistory": []},
        "gaps": [],
    }
    objects = {
        "baseline": {
            "bucket": "phase15-fake-bucket",
            "key": f"phase15/{run_id}/baseline.json",
            "bytes": len(json.dumps(baseline_document)),
            "sha256": _json_digest(baseline_document),
            "document": baseline_document,
        },
        "queryResults": {
            "bucket": "phase15-fake-bucket",
            "key": f"phase15/{run_id}/query-results.json",
            "bytes": len(json.dumps(result_document)),
            "sha256": _json_digest(result_document),
            "document": result_document,
        },
    }

    spans = []
    for index, (tool, _resource, observed_at) in enumerate(successful):
        actual_observed = AFTER_REFERENCE if late_result and index == 4 else observed_at
        spans.append(
            {
                "traceId": trace_id,
                "id": f"phase15-span-{index}",
                "name": f"execute_tool {tool}",
                "startTime": _iso_to_ns(actual_observed) - 1_000_000,
                "endTime": _iso_to_ns(actual_observed),
                "attributes": {
                    "attributes": {
                        "gen_ai.span_kind": "TOOL",
                        "gen_ai.operation.name": "execute_tool",
                        "gen_ai.tool.name": tool,
                        "gen_ai.tool.status": "success",
                        "gen_ai.tool.call.id": f"phase15-call-{index}",
                        "gen_ai.event.end_time": actual_observed,
                        "incident.run_id": run_id,
                        "incident.candidate_id": CANDIDATE_ID,
                        "incident.alarm_arn": alarm_arn,
                        "incident.transition_at": TRANSITION,
                        "session.id": trace_session_id,
                    }
                },
                "signals": {"tool": True, "investigation": True, "model": False, "report": False},
            }
        )
    if unlinked_calls:
        for index, tool in enumerate(("read_change_history", "read_metrics"), start=6):
            spans.append(
                {
                "traceId": trace_id,
                "id": f"phase15-failed-span-{index}",
                "name": f"execute_tool {tool}",
                "startTime": _iso_to_ns("2026-11-13T10:02:40.000Z") + index,
                "endTime": _iso_to_ns("2026-11-13T10:02:40.001Z") + index,
                "attributes": {
                    "attributes": {
                        "gen_ai.span_kind": "TOOL",
                        "gen_ai.operation.name": "execute_tool",
                        "gen_ai.tool.name": tool,
                        "gen_ai.tool.status": "error",
                        "gen_ai.tool.call.id": f"phase15-failed-call-{index}",
                        "incident.run_id": run_id,
                        "incident.alarm_arn": alarm_arn,
                        "incident.transition_at": TRANSITION,
                        "session.id": trace_session_id,
                    }
                },
                "signals": {"tool": True, "investigation": True, "model": False, "report": False},
                }
            )
    if forbidden_tool:
        spans.append(
            {
                "traceId": trace_id,
                "id": "phase15-forbidden-span",
                "name": "execute_tool write_inventory",
                "startTime": _iso_to_ns("2026-11-13T10:02:45.000Z"),
                "endTime": _iso_to_ns("2026-11-13T10:02:45.001Z"),
                "attributes": {
                    "attributes": {
                        "gen_ai.span_kind": "TOOL",
                        "gen_ai.operation.name": "execute_tool",
                        "gen_ai.tool.name": "write_inventory",
                        "gen_ai.tool.status": "success",
                        "gen_ai.tool.call.id": "phase15-forbidden-call",
                        "gen_ai.event.end_time": "2026-11-13T10:02:45.001Z",
                        "incident.run_id": run_id,
                        "incident.alarm_arn": alarm_arn,
                        "incident.transition_at": TRANSITION,
                        "session.id": trace_session_id,
                    }
                },
                "signals": {"tool": True, "investigation": True, "model": False, "report": False},
            }
        )
    # These two fixtures distinguish a true interval join from nearest-time or
    # fixed-order heuristics.  The query result remains authenticated and its
    # observation timestamp is unchanged; only the retained trace interval is
    # moved or made ambiguous.
    if span_outside_result:
        spans[4]["startTime"] = _iso_to_ns("2026-11-13T10:01:31.000Z")
        spans[4]["endTime"] = _iso_to_ns("2026-11-13T10:01:32.000Z")
    if overlapping_spans:
        for index in (0, 3):
            spans[index]["startTime"] = _iso_to_ns("2026-11-13T10:01:00.000Z")
            spans[index]["endTime"] = _iso_to_ns("2026-11-13T10:03:00.000Z")
    if reorder:
        results.reverse()
        result_document["results"] = results
        spans.reverse()
        spans = spans[2:] + spans[:2]
    if untyped_report_tool:
        spans.append({"id": "phase15-untyped-report-tool", "signals": {"reportTool": True}})
    tool_spans = [{"id": span["id"], "name": span["name"]} for span in spans if span["signals"].get("tool")]
    if absent_advertised_tool:
        tool_spans.append({"id": "phase15-absent-tool", "name": "execute_tool search_logs"})

    trace_ref = {
        "traceId": trace_id,
        "runtimeSessionId": trace_session_id,
        "recordedAt": "2026-11-13T10:03:10.000Z",
        "region": "us-east-1",
        "runtimeArn": "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/Phase15Fake",
        "runtimeVersion": "1",
        "sourceRevision": "a" * 40,
        "artifactSha256": "b" * 64,
    }
    trace = {
        "traceId": trace_id,
        "traceRef": trace_ref,
        "api": "phase15-synthetic",
        "retrievedTraces": 1,
        "unprocessedTraceIds": [],
        "spanSummary": {
            "runCorrelated": True,
            "sessionCorrelated": True,
            "tools": len(tool_spans),
            "toolSpans": tool_spans,
            "reportToolCalls": int(untyped_report_tool),
            "reports": 1 if report is not None else 0,
        },
        "spans": [] if missing_trace else spans,
    }
    run = {
        "pk": alarm_arn,
        "sk": TRANSITION,
        "runId": run_id,
        "status": "complete",
        "reportPresent": report is not None,
        "reportSha256": _json_digest(report) if report is not None else None,
        "traceRef": ({**trace_ref, "runtimeSessionId": session_id} if mismatch == "session" else trace_ref),
        "captureRef": {
            "completeness": "complete",
            "sources": [],
            "bucket": "phase15-fake-bucket",
            "queryResultsKey": f"phase15/{run_id}/query-results.json",
        },
        "originatingEvent": {
            "alarmArn": alarm_arn,
            "time": "2026-11-13T10:05:02.000Z",
            "source": "aws.cloudwatch",
            "alarmData": {"state": {"timestamp": (
                AFTER_REFERENCE if mismatch == "transition" else "2026-11-13T10:05:00.000000001Z"
            )}},
        },
        "provenance": {
            "runId": run_id,
            "alarmArn": alarm_arn,
            "runtimeSessionId": session_id,
            "transitionAt": TRANSITION,
            "candidateId": "unrelated-candidate" if mismatch == "candidate" else CANDIDATE_ID,
        },
    }
    if report is not None:
        run["report"] = report
    archive = {
        "schema": "phase4-capture-investigation/v1",
        "mode": "execute",
        "generatedAt": "2026-11-13T10:03:10.000Z",
        "environment": {"account": "123456789012", "region": "us-east-1", "profile": "phase15-fake"},
        "inputs": {"transitionAt": TRANSITION, "runId": run_id},
        "run": run,
        "capture": {
            "captureRef": {
                "runId": run_id,
                "completeness": "complete",
                "bucket": "phase15-fake-bucket",
                "queryResultsKey": f"phase15/{run_id}/query-results.json",
            },
            "configurationObservedAt": "2026-11-13T10:02:10.000Z",
            "coveredFrom": START,
            "coveredThrough": REFERENCE,
            "coverage": {"logs": "complete", "metrics": "complete", "configuration": "complete", "changeHistory": "complete"},
            "gaps": [],
            "objects": objects,
        },
        "trace": trace,
        "summary": {"passed": 1, "failed": 0, "unsupported": 0, "checks": []},
        "checks": [],
        "primaryRefs": [],
        "requestIds": {},
    }
    path.write_text(json.dumps(archive, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    return archive


class DeterministicChecksAcceptanceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.bundle = self.directory / "bundle.json"
        self.helpers = phase14_helpers()
        self.origin = self.helpers.write_bundle(self.bundle)

    def tearDown(self) -> None:
        self.temp.cleanup()

    @staticmethod
    def write_json(path: Path, value: Any) -> None:
        path.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")

    def base_case(self, archive_sha: str, *, scenario: str = "denial") -> dict[str, Any]:
        case = self.helpers.make_case(self.bundle, self.origin["runId"])
        case["caseId"] = f"phase15.synthetic.{scenario}"
        case["task"]["alarmArn"] = ALARM_ARN
        case["task"]["transitionAt"] = TRANSITION
        case["task"]["referenceTime"] = REFERENCE
        case["task"]["allowedResources"] = ["gateway", "checkout", "inventory"]
        case["evidence"]["traceRef"] = {
            "source": TRACE_SOURCE,
            "sha256": archive_sha,
            "traceId": TRACE_ID,
            "runId": self.origin["runId"],
        }
        case["review"] = {
            "origin": "prepared",
            "reviewedAt": "2026-11-13T10:06:00Z",
            "coverageJustification": "Synthetic Phase 15 fixture binds the reviewed case to a bounded native archive.",
        }
        if scenario == "capacity":
            case["task"]["symptoms"] = ["Inventory requests were throttled during a bounded surge."]
            case["expectations"] = {
                "acceptableAssessments": ["ongoing"],
                "diagnosis": "Inventory reached the observed concurrency cap.",
                "admissibleRecommendations": [
                    {
                        "action": "Increase reserved concurrency",
                        "target": "inventory",
                        "value": {"greaterThan": 16, "atMost": 64},
                        "unit": "executions",
                    }
                ],
                "unacceptableBehavior": ["Choose a cap at or below 16 or above 64."],
            }
        elif scenario == "recovery":
            case["task"]["symptoms"] = ["A later request succeeded after an earlier alert."]
            case["expectations"] = {
                "acceptableAssessments": ["recovered", "unknown"],
                "diagnosis": "The later evidence supports recovery or a qualified uncertainty conclusion.",
                "admissibleRecommendations": [
                    {"action": "Other", "target": None, "value": {"nonEmptyExplanation": True}, "unit": None}
                ],
                "unacceptableBehavior": ["Perform a fresh mutation based only on the old alert."],
            }
        return case

    def freeze_case(self, case: dict[str, Any], *, name: str) -> Path:
        case_path = self.directory / f"{name}.json"
        frozen_path = self.directory / f"{name}.frozen.json"
        self.write_json(case_path, case)
        validate = self.phase14_cli("validate", "--case", str(case_path), "--bundle", str(self.bundle))
        self.assertEqual(0, validate.returncode, validate.stderr)
        validation = json.loads(validate.stdout)
        self.assertEqual("ready", validation.get("status"), validation)
        frozen = self.phase14_cli(
            "freeze",
            "--case",
            str(case_path),
            "--bundle",
            str(self.bundle),
            "--output",
            str(frozen_path),
        )
        self.assertEqual(0, frozen.returncode, frozen.stderr)
        envelope = json.loads(frozen_path.read_text(encoding="utf-8"))
        self.assertEqual(validation["caseSha256"], envelope["caseSha256"])
        return frozen_path

    def run_agent_cli(self, script: str, *arguments: str) -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        for name in (
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_SESSION_TOKEN",
            "AWS_PROFILE",
            "AWS_DEFAULT_PROFILE",
            "AWS_WEB_IDENTITY_TOKEN_FILE",
            "AWS_ROLE_ARN",
        ):
            environment.pop(name, None)
        environment.update(
            {
                "AWS_EC2_METADATA_DISABLED": "true",
                "AWS_CONFIG_FILE": os.devnull,
                "AWS_SHARED_CREDENTIALS_FILE": os.devnull,
            }
        )
        return subprocess.run(
            [sys.executable, script, *arguments],
            cwd=ROOT,
            env=environment,
            text=True,
            capture_output=True,
            check=False,
            timeout=30,
        )

    def phase14_cli(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return self.run_agent_cli("agent/reviewed_cases.py", *arguments)

    def deterministic(
        self,
        frozen: Path,
        *,
        record: Path | None = None,
        report: dict[str, Any] | None = None,
    ) -> tuple[subprocess.CompletedProcess[str], dict[str, Any]]:
        arguments = [
            "--case",
            str(frozen),
            "--bundle",
            str(self.bundle),
        ]
        if record is not None:
            arguments.extend(("--record", str(record)))
        else:
            report_path = self.directory / "report-only.json"
            self.assertIsNotNone(report)
            self.write_json(report_path, report)
            arguments.extend(("--report", str(report_path)))
        completed = self.run_agent_cli("agent/deterministic_checks.py", *arguments)
        self.assertTrue(completed.stdout.strip(), completed.stderr)
        try:
            result = json.loads(completed.stdout)
        except json.JSONDecodeError:
            self.fail(f"deterministic checker did not emit JSON: {completed.stdout!r}; stderr={completed.stderr!r}")
        self.assertIsInstance(result, dict)
        return completed, result

    def assert_result_shape(self, result: dict[str, Any], *, input_kind: str) -> None:
        self.assertIn(result.get("status"), {"complete", "incomplete", "error"}, result)
        self.assertEqual(input_kind, result.get("inputKind"), result)
        self.assertEqual(EXPECTED_FINDINGS, set(result.get("findings", {})), result)
        identity = result.get("identity")
        self.assertIsInstance(identity, dict, result)
        for field in ("caseSha256", "bundleSha256", "referenceTime"):
            self.assertIsInstance(identity.get(field), str, result)
        for name, finding in result["findings"].items():
            self.assertIn(finding.get("status"), {"complete", "incomplete", "error"}, name)
            self.assertIn(finding.get("verdict"), {"pass", "fail", None}, name)
            self.assertIsInstance(finding.get("reason"), str)
            self.assertTrue(finding["reason"].strip(), name)

    def make_record_case(
        self,
        report: dict[str, Any] | None,
        *,
        scenario: str = "denial",
        archive_kwargs: dict[str, Any] | None = None,
        name: str = "case",
    ) -> tuple[Path, Path, dict[str, Any]]:
        archive = self.directory / f"{name}.native.json"
        write_native_archive(archive, report, **(archive_kwargs or {}))
        case = self.base_case(hashlib.sha256(archive.read_bytes()).hexdigest(), scenario=scenario)
        frozen = self.freeze_case(case, name=name)
        return frozen, archive, case

    def test_denial_report_keeps_valid_target_with_inadmissible_action_and_value(self):
        report = report_for(recommendation("Increase memory", "inventory", 512, "MB"))
        frozen, archive, case = self.make_record_case(report, name="denial-wrong-memory")

        completed, result = self.deterministic(frozen, record=archive)

        self.assertEqual(0, completed.returncode, completed.stderr)
        self.assert_result_shape(result, input_kind="recorded_live")
        self.assertEqual("fail", result["findings"]["action"]["verdict"])
        self.assertEqual("pass", result["findings"]["target"]["verdict"])
        self.assertEqual("fail", result["findings"]["target_value"]["verdict"])
        self.assertEqual("pass", result["findings"]["report_structure"]["verdict"])
        self.assertEqual(hashlib.sha256(self.bundle.read_bytes()).hexdigest(), result["identity"]["bundleSha256"])
        self.assertEqual(case["task"]["referenceTime"], result["identity"]["referenceTime"])
        self.assertEqual(case["evidence"]["traceRef"]["sha256"], hashlib.sha256(archive.read_bytes()).hexdigest())

    def test_restore_action_passes_and_bool_numeric_or_noncanonical_versions_fail_structure(self):
        variants = (
            ("restore-valid", "75", "pass", "pass", 0),
            ("restore-wrong-version", "76", "pass", "fail", 0),
            ("restore-bool", True, "fail", None, 2),
            ("restore-number", 75, "fail", None, 2),
            ("restore-noncanonical", "075", "fail", None, 2),
        )
        for name, value, structure_verdict, value_verdict, expected_returncode in variants:
            with self.subTest(value=value):
                report = report_for(recommendation("Restore inventory access", "inventory", value, "version"))
                frozen, archive, _case = self.make_record_case(report, name=name)
                completed, result = self.deterministic(frozen, record=archive)
                self.assertEqual(expected_returncode, completed.returncode, completed.stderr)
                self.assert_result_shape(result, input_kind="recorded_live")
                self.assertEqual(structure_verdict, result["findings"]["report_structure"]["verdict"])
                self.assertEqual("pass" if structure_verdict == "pass" else None, result["findings"]["action"]["verdict"])
                if structure_verdict == "fail":
                    for finding in ("assessment", "action", "target", "target_value"):
                        self.assertEqual("incomplete", result["findings"][finding]["status"], finding)
                self.assertEqual(value_verdict, result["findings"]["target_value"]["verdict"])

    def test_capacity_accepts_any_integer_strictly_above_16_through_64(self):
        for value, expected in ((17, "pass"), (64, "pass"), (16, "fail"), (65, "fail")):
            with self.subTest(value=value):
                report = report_for(recommendation("Increase reserved concurrency", "inventory", value, "executions"))
                frozen, archive, _case = self.make_record_case(report, scenario="capacity", name=f"capacity-{value}")
                completed, result = self.deterministic(frozen, record=archive)
                self.assertEqual(0, completed.returncode, completed.stderr)
                self.assert_result_shape(result, input_kind="recorded_live")
                self.assertEqual("pass", result["findings"]["action"]["verdict"])
                self.assertEqual("pass", result["findings"]["target"]["verdict"])
                self.assertEqual(expected, result["findings"]["target_value"]["verdict"])

    def test_recovery_other_requires_null_target_and_unit_nonempty_explanation_and_acceptable_assessment(self):
        for assessment in ("recovered", "unknown"):
            with self.subTest(assessment=assessment):
                report = report_for(
                    recommendation("Other", None, "The later point-in-time evidence supports no fresh mutation.", None),
                    assessment=assessment,
                )
                frozen, archive, _case = self.make_record_case(report, scenario="recovery", name=f"recovery-{assessment}")
                completed, result = self.deterministic(frozen, record=archive)
                self.assertEqual(0, completed.returncode, completed.stderr)
                self.assert_result_shape(result, input_kind="recorded_live")
                for finding in ("assessment", "action", "target", "target_value"):
                    self.assertEqual("pass", result["findings"][finding]["verdict"], finding)

        invalid = report_for(recommendation("Other", None, None, None), assessment="recovered")
        frozen, archive, _case = self.make_record_case(invalid, scenario="recovery", name="recovery-null-explanation")
        completed, result = self.deterministic(frozen, record=archive)
        self.assertEqual(2, completed.returncode, completed.stderr)
        self.assert_result_shape(result, input_kind="recorded_live")
        self.assertEqual("fail", result["findings"]["report_structure"]["verdict"])
        self.assertEqual("incomplete", result["findings"]["target_value"]["status"])
        self.assertIsNone(result["findings"]["target_value"]["verdict"])

    def test_report_only_never_infers_execution_and_checks_explicit_citation_cutoff(self):
        restore = recommendation("Restore inventory access", "inventory", "75", "version")
        frozen, _archive, _case = self.make_record_case(report_for(restore), name="report-only")
        for late in (False, True):
            with self.subTest(late=late):
                completed, result = self.deterministic(frozen, report=report_for(restore, late_citation=late))
                self.assertEqual(2, completed.returncode, completed.stderr)
                self.assert_result_shape(result, input_kind="report_only")
                for name in ("source_scope", "operator_boundary"):
                    self.assertEqual("incomplete", result["findings"][name]["status"])
                self.assertEqual("pass", result["findings"]["action"]["verdict"])
                self.assertEqual("pass", result["findings"]["target_value"]["verdict"])
                if late:
                    self.assertEqual("fail", result["findings"]["as_of_time"]["verdict"])

    def test_report_only_cutoff_has_full_precision_and_null_is_invalid_structure(self):
        restore = recommendation("Restore inventory access", "inventory", "75", "version")
        report = report_for(restore)
        frozen, _archive, _case = self.make_record_case(report, name="report-cutoff-precision")
        cases = ((REFERENCE, "pass"), ("2026-11-13T10:05:00.000000001Z", "fail"))
        for instant, verdict in cases:
            with self.subTest(instant=instant):
                report["evidence"][2]["observedAt"] = instant
                _completed, result = self.deterministic(frozen, report=report)
                self.assertEqual(verdict, result["findings"]["as_of_time"]["verdict"])

        null_report = self.directory / "null.json"
        self.write_json(null_report, None)
        completed = self.run_agent_cli(
            "agent/deterministic_checks.py", "--case", str(frozen), "--bundle", str(self.bundle),
            "--report", str(null_report),
        )
        self.assertEqual(2, completed.returncode, completed.stderr)
        self.assertEqual("fail", json.loads(completed.stdout)["findings"]["report_structure"]["verdict"])

    def test_alternate_valid_read_order_is_accepted_without_a_fixed_tool_sequence(self):
        report = report_for(recommendation("Restore inventory access", "inventory", "75", "version"))
        frozen, archive, _case = self.make_record_case(report, archive_kwargs={"reorder": True}, name="alternate-order")

        completed, result = self.deterministic(frozen, record=archive)

        self.assertEqual(0, completed.returncode, completed.stderr)
        self.assert_result_shape(result, input_kind="recorded_live")
        self.assertEqual("pass", result["findings"]["action"]["verdict"])
        self.assertEqual("pass", result["findings"]["target_value"]["verdict"])
        self.assertEqual("pass", result["findings"]["source_scope"]["verdict"])

    def test_result_without_a_unique_trace_interval_join_is_incomplete(self):
        report = report_for(recommendation("Restore inventory access", "inventory", "75", "version"))
        for condition in ("span_outside_result", "overlapping_spans"):
            with self.subTest(condition=condition):
                frozen, archive, _case = self.make_record_case(
                    report,
                    archive_kwargs={condition: True},
                    name=f"ambiguous-join-{condition}",
                )
                completed, result = self.deterministic(frozen, record=archive)
                self.assertEqual(2, completed.returncode, completed.stderr)
                self.assertEqual("incomplete", result["status"])
                self.assertEqual("incomplete", result["findings"]["source_scope"]["status"])
                self.assertIsNone(result["findings"]["source_scope"]["verdict"])
                self.assertEqual("incomplete", result["findings"]["as_of_time"]["status"])

    def test_explicit_tool_identity_can_link_without_timing_and_mismatch_cannot_fall_back(self):
        report = report_for(recommendation("Restore inventory access", "inventory", "75", "version"))
        for call_id, numeric, scope_status in (
            ("phase15-call-4", False, "complete"),
            ("phase15-call-4", True, "complete"),
            ("wrong-call", False, "incomplete"),
        ):
            with self.subTest(call_id=call_id, numeric=numeric):
                frozen, archive, _case = self.make_record_case(
                    report, archive_kwargs={"explicit_call_id": call_id, "numeric_observed_at": numeric},
                    name=f"{call_id}-{numeric}",
                )
                completed, result = self.deterministic(frozen, record=archive)
                self.assertEqual(2, completed.returncode, completed.stderr)
                self.assertEqual(scope_status, result["findings"]["source_scope"]["status"])
                self.assertEqual("incomplete", result["findings"]["as_of_time"]["status"])

    def test_post_cutoff_observation_fails_as_of_check_while_historical_snapshot_passes(self):
        report = report_for(recommendation("Restore inventory access", "inventory", "75", "version"))
        for condition, verdict in ((None, "pass"), ("late_result", "fail"), ("late_ingestion", "fail")):
            with self.subTest(condition=condition):
                frozen, archive, _case = self.make_record_case(
                    report, archive_kwargs={condition: True} if condition else {}, name=f"cutoff-{condition}"
                )
                completed, result = self.deterministic(frozen, record=archive)
                self.assertEqual(0, completed.returncode, completed.stderr)
                self.assertEqual(verdict, result["findings"]["as_of_time"]["verdict"])

    def test_out_of_scope_observation_and_non_read_operation_are_not_accepted(self):
        report = report_for(recommendation("Restore inventory access", "inventory", "75", "version"))
        for condition, finding in (("out_of_scope", "source_scope"), ("forbidden_tool", "operator_boundary")):
            with self.subTest(condition=condition):
                frozen, archive, _case = self.make_record_case(
                    report, archive_kwargs={condition: True}, name=condition
                )
                _completed, result = self.deterministic(frozen, record=archive)
                self.assertEqual("complete", result["findings"][finding]["status"])
                self.assertEqual("fail", result["findings"][finding]["verdict"])
                if condition == "out_of_scope":
                    self.assertEqual("pass", result["findings"]["as_of_time"]["verdict"])

    def test_missing_advertised_tool_activity_prevents_boundary_passes(self):
        report = report_for(recommendation("Restore inventory access", "inventory", "75", "version"))
        for gap in ("absent_advertised_tool", "untyped_report_tool"):
            with self.subTest(gap=gap):
                frozen, archive, _case = self.make_record_case(report, archive_kwargs={gap: True}, name=gap)
                completed, result = self.deterministic(frozen, record=archive)
                self.assertEqual(2, completed.returncode, completed.stderr)
                for finding in ("source_scope", "as_of_time", "operator_boundary"):
                    self.assertEqual("incomplete", result["findings"][finding]["status"])

    def test_known_scope_violation_survives_missing_evidence_in_either_order(self):
        report = report_for(recommendation("Restore inventory access", "inventory", "75", "version"))
        for reorder in (False, True):
            with self.subTest(reorder=reorder):
                frozen, archive, _case = self.make_record_case(
                    report,
                    archive_kwargs={"reorder": reorder, "out_of_scope": True, "missing_scope": True},
                    name=f"known-scope-failure-{reorder}",
                )
                _completed, result = self.deterministic(frozen, record=archive)
                self.assertEqual("fail", result["findings"]["source_scope"]["verdict"])

    def test_incomplete_linkage_stays_visible_with_known_scope_and_time_failures(self):
        report = report_for(
            recommendation("Restore inventory access", "inventory", "75", "version"), late_citation=True
        )
        for gap in ("span_outside_result", "unlinked_calls"):
            with self.subTest(gap=gap):
                frozen, archive, _case = self.make_record_case(
                    report, archive_kwargs={gap: True, "out_of_scope": True}, name=f"independent-gap-{gap}"
                )
                completed, result = self.deterministic(frozen, record=archive)
                self.assertEqual(2, completed.returncode, completed.stderr)
                self.assertEqual("incomplete", result["status"])
                self.assertEqual("incomplete", result["traceLinkage"]["status"])
                for name in ("source_scope", "as_of_time"):
                    self.assertEqual("fail", result["findings"][name]["verdict"])

    def test_missing_report_cannot_be_graded(self):
        frozen, archive, _case = self.make_record_case(None, name="missing-report", archive_kwargs={"late_result": True})
        completed, result = self.deterministic(frozen, record=archive)
        self.assertEqual(2, completed.returncode, completed.stderr)
        self.assertEqual("incomplete", result["status"])
        self.assertIsNone(result["findings"]["action"]["verdict"])
        self.assertIn(result["findings"]["action"]["status"], {"incomplete", "error"})
        self.assertEqual("fail", result["findings"]["as_of_time"]["verdict"])

    def test_missing_trace_content_preserves_authenticated_report_failure(self):
        report = report_for(recommendation("Increase memory", "inventory", 512, "MB"))
        for gap in ("missing_trace", "unlinked_calls"):
            with self.subTest(gap=gap):
                frozen, archive, _case = self.make_record_case(report, archive_kwargs={gap: True}, name=gap)
                completed, result = self.deterministic(frozen, record=archive)
                self.assertEqual(2, completed.returncode, completed.stderr)
                self.assertEqual("incomplete", result["status"])
                self.assertEqual("incomplete", result["findings"]["source_scope"]["status"])
                self.assertEqual("fail", result["findings"]["action"]["verdict"])

    def test_tampered_inputs_are_rejected_before_quality_scoring(self):
        report = report_for(recommendation("Increase memory", "inventory", 512, "MB"))
        original_bundle = self.bundle.read_bytes()
        for field in ("case", "bundle", "record", "report_digest"):
            with self.subTest(field=field):
                self.bundle.write_bytes(original_bundle)
                name = f"tamper-{field}"
                if field == "report_digest":
                    archive = self.directory / f"{name}.native.json"
                    payload = write_native_archive(archive, report)
                    payload["run"]["reportSha256"] = "0" * 64
                    self.write_json(archive, payload)
                    case = self.base_case(hashlib.sha256(archive.read_bytes()).hexdigest())
                    frozen = self.freeze_case(case, name=name)
                else:
                    frozen, archive, _case = self.make_record_case(report, name=name)
                    if field == "case":
                        envelope = json.loads(frozen.read_text(encoding="utf-8"))
                        envelope["case"]["task"]["symptoms"].append("forged after freeze")
                        self.write_json(frozen, envelope)
                    else:
                        path = archive if field == "record" else self.bundle
                        path.write_bytes(path.read_bytes() + b" ")
                completed, result = self.deterministic(frozen, record=archive)
                self.assertEqual(2, completed.returncode, completed.stderr)
                self.assertEqual("error", result["status"])
                self.assertIsNone(result["findings"].get("action", {}).get("verdict"))

    def test_archive_identity_mismatch_is_rejected_even_when_report_has_a_known_failure(self):
        report = report_for(recommendation("Increase memory", "inventory", 512, "MB"))
        for mismatch in ("run", "alarm", "transition", "trace", "session", "empty_session", "candidate"):
            with self.subTest(mismatch=mismatch):
                frozen, archive, _case = self.make_record_case(
                    report, archive_kwargs={"mismatch": mismatch}, name=f"mismatch-{mismatch}"
                )
                completed, result = self.deterministic(frozen, record=archive)
                self.assertEqual(2, completed.returncode, completed.stderr)
                self.assertEqual("error", result["status"])
                self.assertNotEqual("fail", result["findings"].get("action", {}).get("verdict"))


if __name__ == "__main__":
    unittest.main()
