"""Focused checks for the native-to-reviewed-case bridge."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts import native_case_bridge as bridge
from scripts.native_case_bridge import (
    BridgeError,
    _merge_sources,
    _native_expectation_document,
    _resource,
    _run_record,
    _scenario,
    _verify_native_recommendation,
)


class NativeCaseBridgeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.scenario_path = Path(self.temp.name) / "scenario.json"
        self.scenario_path.write_text(
            json.dumps(
                {
                    "scenario_id": "synthetic-selected-scenario",
                    "metadata": {
                        "generation_id": "synthetic-generation",
                        "source": {
                            "trace_id": "synthetic-trace",
                            "session_id": "synthetic-session",
                        },
                    },
                    "turns": [
                        {
                            "input": "Alarm: selected\nState: ALARM ",
                            "expected_response": "Restore the selected access version.",
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_native_expected_response_is_not_consumed(self) -> None:
        scenario = {
            "scenario_id": "selected-scenario",
            "metadata": {
                "generation_id": "generation",
                "source": {"trace_id": "trace", "session_id": "session"},
            },
            "turns": [{"input": "Alarm: selected\nState: ALARM", "expected_response": "private prose"}],
        }
        values = _scenario(scenario)
        self.assertEqual(values[-2], "Alarm: selected\nState: ALARM")
        self.assertEqual(values[-1], "private prose")

    def test_filtered_rows_survive_merge_and_define_cutoff(self) -> None:
        broad = {
            "scope": ["inventory"],
            "window": {"start": "2026-11-26T19:30:00Z", "end": "2026-11-26T19:59:00Z"},
            "observedAt": "2026-11-26T19:46:20Z",
            "completeness": "partial",
            "truncated": True,
            "observations": [{"resource": "inventory", "timestamp": "2026-11-26T19:42:00Z", "eventId": "b", "fields": {"status": "500"}}],
        }
        filtered = {
            "query": {"filter": "AccessDenied"},
            "scope": ["inventory"],
            "window": {"start": "2026-11-26T19:41:00Z", "end": "2026-11-26T19:47:00Z"},
            "observedAt": "2026-11-26T19:46:31.452Z",
            "completeness": "complete",
            "observations": [
                {
                    "resource": "inventory",
                    "timestamp": "2026-11-26T19:45:23.222Z",
                    "eventId": "denial",
                    "fields": {"requestId": "selected", "error": "AccessDeniedException"},
                }
            ],
        }
        common = {
            "scope": ["inventory"],
            "window": {"start": "2026-11-26T19:30:00Z", "end": "2026-11-26T19:59:00Z"},
            "observedAt": "2026-11-26T19:46:23Z",
            "completeness": "complete",
            "observations": [],
        }
        baseline = {
            "runId": "run",
            "alarmArn": "arn:aws:cloudwatch:us-east-1:1:alarm:selected",
            "transitionAt": "2026-11-26T19:46:00Z",
            "observations": {
                "logs": broad,
                "metrics": {**common, "query": {"periodSeconds": 60, "metrics": []}},
                "configuration": common,
                "changeHistory": common,
            },
        }
        narrowed_configuration = {
            **common,
            "query": {"resource": "inventory", "limit": 1},
            "observations": [
                {
                    "resource": "inventory",
                    "eventId": "configuration-narrow",
                    "fields": {"version": "75"},
                }
            ],
        }
        narrowed_metrics = {
            **common,
            "query": {"metric": "Errors", "periodSeconds": 60},
            "observations": [{"resource": "inventory", "eventId": "metric-narrow", "value": 0}],
        }
        narrowed_history = {
            **common,
            "query": {"resource": "inventory", "limit": 1},
            "observations": [{"resource": "inventory", "eventId": "history-narrow", "change": "none"}],
        }
        query = {
            "runId": "run",
            "alarmArn": baseline["alarmArn"],
            "transitionAt": baseline["transitionAt"],
            "results": [
                {"tool": "search_logs", "result": filtered},
                {"tool": "read_configuration", "result": narrowed_configuration},
                {"tool": "read_metrics", "result": narrowed_metrics},
                {"tool": "read_change_history", "result": narrowed_history},
            ],
        }
        origin, sources = _merge_sources(baseline, query)
        self.assertEqual(origin["referenceTime"], "2026-11-26T19:46:31.452Z")
        self.assertEqual(len(sources["logs"]["observations"]), 2)
        self.assertEqual(sources["logs"]["captureWindows"][1]["query"], {"filter": "AccessDenied"})
        self.assertEqual(
            {item["eventId"] for item in sources["configuration"]["observations"]},
            {"configuration-narrow"},
        )
        self.assertEqual(
            {item["eventId"] for item in sources["metrics"]["observations"]},
            {"metric-narrow"},
        )
        self.assertEqual(
            {item["eventId"] for item in sources["changeHistory"]["observations"]},
            {"history-narrow"},
        )
        self.assertEqual(_resource(sources["logs"], "inventory"), "inventory")

    def test_run_record_must_match_trace_session_and_transition(self) -> None:
        trace_meta = {
            "sessionId": "session",
            "runIds": ["run"],
            "alarms": ["arn:aws:cloudwatch:us-east-1:1:alarm:selected"],
            "transitions": ["2026-11-26T19:46:00.400Z"],
        }
        run = {
            "runId": "run",
            "runtimeSessionId": "session",
            "pk": trace_meta["alarms"][0],
            "sk": "2026-11-26T19:46:00.400Z",
            "alarmArn": trace_meta["alarms"][0],
            "captureRef": {
                "bucket": "evidence",
                "baselineKey": "baseline.json",
                "queryResultsKey": "query-results.json",
            },
        }
        self.assertEqual(_run_record(run, trace_meta)["runId"], "run")
        foreign = dict(run, runtimeSessionId="other")
        with self.assertRaisesRegex(BridgeError, "session ID"):
            _run_record(foreign, trace_meta)

    def test_native_typed_recommendation_is_the_canonical_expectation_source(self) -> None:
        scenario = json.loads(self.scenario_path.read_text(encoding="utf-8"))
        scenario["metadata"]["expected_recommendation"] = {
            "action": "Restore inventory access",
            "target": "inventory",
            "value": "75",
            "unit": "version",
        }
        document, resource, _ = _native_expectation_document(scenario)
        self.assertEqual(resource, "inventory")
        self.assertEqual(
            document["expectations"]["admissibleRecommendations"][0]["value"],
            "75",
        )
        self.assertEqual(
            document["expectations"]["diagnosis"],
            scenario["turns"][0]["expected_response"],
        )
        mismatched = {
            **document["expectations"],
            "admissibleRecommendations": [
                {
                    "action": "Restore inventory access",
                    "target": "inventory",
                    "value": "76",
                    "unit": "version",
                }
            ],
        }
        with self.assertRaisesRegex(BridgeError, "does not match"):
            _verify_native_recommendation(scenario, mismatched)

    def test_exact_native_response_stays_in_frozen_evaluator_input_only(self) -> None:
        case = json.loads(Path("examples/inventory-denial/case.json").read_text(encoding="utf-8"))
        expected_response = "Exact audience wording: preserve the recovered access policy."
        case["expectations"]["diagnosis"] = expected_response
        case_path = Path(self.temp.name) / "case.json"
        frozen_path = Path(self.temp.name) / "case.frozen.json"
        case_path.write_text(json.dumps(case), encoding="utf-8")
        bridge.freeze_case(
            case_path,
            Path("examples/inventory-denial/evidence.json"),
            frozen_path,
        )
        frozen = json.loads(frozen_path.read_text(encoding="utf-8"))
        candidate = bridge.candidate_input(
            frozen_path,
            Path("examples/inventory-denial/evidence.json"),
        )
        self.assertEqual(frozen["case"]["expectations"]["diagnosis"], expected_response)
        self.assertNotIn(expected_response, json.dumps(candidate, ensure_ascii=False))

    def test_build_retry_after_validation_failure_has_no_partial_output(self) -> None:
        source_dir = Path(self.temp.name)
        trace_path = source_dir / "trace.json"
        trace_path.write_text("{}", encoding="utf-8")
        scenario = json.loads(self.scenario_path.read_text(encoding="utf-8"))
        scenario["metadata"]["expected_recommendation"] = {
            "action": "Restore inventory access",
            "target": "inventory",
            "value": "75",
            "unit": "version",
        }
        self.scenario_path.write_text(json.dumps(scenario), encoding="utf-8")
        bundle_path = source_dir / "bundle.json"
        source_window = {
            "start": "2026-11-26T11:00:00Z",
            "end": "2026-11-26T11:05:00Z",
        }
        source = {
            "scope": ["inventory"],
            "window": source_window,
            "observedAt": "2026-11-26T11:05:00Z",
            "completeness": "complete",
            "truncated": False,
            "observations": [],
        }
        bundle_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "origin": {
                        "alarmArn": "arn:aws:cloudwatch:us-east-1:000000000000:alarm:Synthetic",
                        "transitionAt": "2026-11-26T11:05:00Z",
                        "runId": "synthetic-run",
                        "accountId": "000000000000",
                        "region": "us-east-1",
                        "referenceTime": "2026-11-26T11:05:00Z",
                    },
                    "sources": {name: source for name in bridge.SOURCES},
                }
            ),
            encoding="utf-8",
        )
        args = argparse.Namespace(
            scenario=self.scenario_path,
            trace=trace_path,
            expectations=None,
            output=source_dir / "bridge",
            bundle=bundle_path,
            baseline=None,
            query_results=None,
            run_record=None,
            run_table="SyntheticRunTable",
            profile=None,
            region="us-east-1",
            reviewed_at=None,
            case_id=None,
            affected_service=None,
        )
        trace_meta = {}
        with patch.object(bridge, "_trace", return_value=trace_meta), patch.object(
            bridge, "_resource", return_value="inventory"
        ), patch.object(
            bridge, "_references", return_value=[]
        ), patch.object(bridge, "validate_case", return_value=({"status": "incomplete"}, None)):
            with self.assertRaisesRegex(BridgeError, "did not reach ready"):
                bridge.build(args)
        self.assertFalse(args.output.exists())

        def fake_freeze(_case: Path, _bundle: Path, frozen: Path) -> dict[str, str]:
            bridge._write(frozen, {"synthetic": True})
            return {"caseSha256": "a" * 64}

        def run_success() -> dict[str, object]:
            with patch.object(bridge, "_trace", return_value=trace_meta), patch.object(
                bridge, "_resource", return_value="inventory"
            ), patch.object(
                bridge, "_references", return_value=[]
            ), patch.object(bridge, "validate_case", return_value=({"status": "ready"}, None)), patch.object(
                bridge, "freeze_case", side_effect=fake_freeze
            ), patch.object(bridge, "candidate_input", return_value={"synthetic": True}):
                return bridge.build(args)

        result = run_success()

        self.assertEqual(result["status"], "ready")
        self.assertTrue(result["caseId"].startswith("native.inventory."))
        self.assertNotIn("synthetic-trace", result["caseId"])
        self.assertTrue((args.output / "bridge-manifest.json").is_file())
        self.assertEqual(
            sorted(path.name for path in args.output.iterdir()),
            sorted(bridge.BRIDGE_ARTIFACTS),
        )

        first_manifest = (args.output / "bridge-manifest.json").read_bytes()
        reused = run_success()
        self.assertTrue(reused["reusedExisting"])
        self.assertEqual((args.output / "bridge-manifest.json").read_bytes(), first_manifest)
        self.assertEqual(list(source_dir.glob("bridge.archive.*")), [])

        scenario["metadata"]["expected_recommendation"]["value"] = "76"
        self.scenario_path.write_text(json.dumps(scenario), encoding="utf-8")
        with patch.object(bridge, "_trace", return_value=trace_meta), patch.object(
            bridge, "_resource", return_value="inventory"
        ), patch.object(
            bridge, "_references", return_value=[]
        ), patch.object(bridge, "validate_case", return_value=({"status": "incomplete"}, None)):
            with self.assertRaisesRegex(BridgeError, "did not reach ready"):
                bridge.build(args)
        self.assertEqual((args.output / "bridge-manifest.json").read_bytes(), first_manifest)
        self.assertEqual(list(source_dir.glob("bridge.archive.*")), [])

        replaced = run_success()
        archive = Path(replaced["archivedPreviousOutput"])
        self.assertTrue(archive.is_dir())
        self.assertEqual((archive / "bridge-manifest.json").read_bytes(), first_manifest)
        self.assertNotEqual((args.output / "bridge-manifest.json").read_bytes(), first_manifest)


if __name__ == "__main__":
    unittest.main()
