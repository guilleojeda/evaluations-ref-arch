"""Regression checks for metric bucket, observation, availability, and cutoff clocks."""

from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch


TESTS_DIR = Path(__file__).resolve().parent
AGENT_DIR = TESTS_DIR.parent / "agent"
for path in (TESTS_DIR, AGENT_DIR):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from evidence import EvidenceTools
from support.phase4_agent_fakes import ALARM_ARN, SOURCE_BUCKET, SOURCE_PREFIX, FakeAWSBoundary
from phase13_captured_evidence_test import (
    CUTOFF_ONE,
    CUTOFF_TWO,
    END,
    ORIGIN,
    START,
    fixture_sources,
    provider_module,
)


class MetricObservationTimeTests(unittest.TestCase):
    def live_tools(self, boundary: FakeAWSBoundary) -> EvidenceTools:
        return EvidenceTools(
            boundary,
            account_id="123456789012",
            region="us-east-1",
            app_http_api_id="api-123456",
            source_bucket=SOURCE_BUCKET,
            source_prefix=SOURCE_PREFIX,
            run_id="metric-time-test",
            alarm_arn=ALARM_ARN,
            transition_at="2026-11-13T10:05:00.000Z",
            started_at="2026-11-13T10:05:01.000Z",
            deadline_monotonic=time.monotonic() + 60,
            charge_tool_call=lambda: None,
        )

    def test_live_uses_each_metric_response_retrieval_time_for_aligned_native_series(self):
        boundary = FakeAWSBoundary()

        def metric_pages(_request, page):
            if page == 0:
                return {
                    "MetricDataResults": [{
                        "Id": "inv0",
                        "Label": "Throttles",
                        "Timestamps": [
                            "2026-11-13T10:00:00.000Z",
                            "2026-11-13T10:01:00.000Z",
                        ],
                        "Values": [1, 2],
                        "StatusCode": "Complete",
                    }],
                    "NextToken": "page-2",
                }
            return {
                "MetricDataResults": [{
                    "Id": "inv0",
                    "Label": "Throttles",
                    "Timestamps": ["2026-11-13T10:00:00.000Z"],
                    "Values": [3],
                    "StatusCode": "Complete",
                }]
            }

        boundary.responses[("cloudwatch", "get_metric_data")] = metric_pages
        tools = self.live_tools(boundary)
        retrieval_times = [
            "2026-11-13T10:05:02.123Z",
            "2026-11-13T10:05:03.456Z",
            "2026-11-13T10:05:04.789Z",
        ]
        with patch.object(tools, "_utc_now", side_effect=retrieval_times):
            result = tools.read_metrics(
                resource="inventory",
                start=START,
                end=END,
                metric="Throttles",
                period_seconds=60,
            )

        self.assertEqual(retrieval_times[-1], result["observedAt"], "envelope records operation completion")
        self.assertEqual(2, len(result["observations"]))
        first, second = result["observations"]
        self.assertEqual([
            "2026-11-13T10:00:00.000Z",
            "2026-11-13T10:01:00.000Z",
        ], first["Timestamps"])
        self.assertEqual([1, 2], first["Values"])
        self.assertEqual([retrieval_times[0], retrieval_times[0]], first["observedAt"])
        self.assertEqual(["2026-11-13T10:00:00.000Z"], second["Timestamps"])
        self.assertEqual([3], second["Values"])
        self.assertEqual([retrieval_times[1]], second["observedAt"])
        for series in result["observations"]:
            self.assertEqual(len(series["Timestamps"]), len(series["Values"]))
            self.assertEqual(len(series["Values"]), len(series["observedAt"]))

    def test_replay_selects_one_acquisition_and_preserves_its_observed_at_by_cutoff(self):
        sources = fixture_sources()
        sources["metrics"]["observations"] = [
            {
                "Id": "inv0",
                "Label": "Throttles",
                "Timestamps": [
                    "2026-11-13T10:00:00.000Z",
                    "2026-11-13T10:01:00.000Z",
                ],
                "Values": [2, 4],
                "StatusCode": "Complete",
                "observedAt": [
                    "2026-11-13T10:02:00.000Z",
                    "2026-11-13T10:03:00.000Z",
                ],
                "availableAt": "2026-11-13T10:04:00.000Z",
            },
            {
                "Id": "inv0",
                "Label": "Throttles",
                "Timestamps": ["2026-11-13T10:00:00.000Z"],
                "Values": [7],
                "StatusCode": "Complete",
                "observedAt": ["2026-11-13T10:05:00.000Z"],
                "availableAt": "2026-11-13T10:05:30.000Z",
            },
        ]

        with TemporaryDirectory() as directory:
            path = Path(directory) / "capture.json"
            provider_module().write_bundle(path, origin=ORIGIN, sources=sources)
            early_tools = provider_module().CapturedEvidenceTools.load(
                path,
                reference_time=CUTOFF_ONE,
                deadline_monotonic=time.monotonic() + 60,
            )
            late_tools = provider_module().CapturedEvidenceTools.load(
                path,
                reference_time=CUTOFF_TWO,
                deadline_monotonic=time.monotonic() + 60,
            )
            early = early_tools.read_metrics(resource="inventory", start=START, end=END, metric="Throttles", period_seconds=60)
            late = late_tools.read_metrics(resource="inventory", start=START, end=END, metric="Throttles", period_seconds=60)

        early_series = early["observations"][0]
        late_series = late["observations"][0]
        self.assertEqual([2, 4], early_series["Values"])
        self.assertEqual([
            "2026-11-13T10:02:00.000Z",
            "2026-11-13T10:03:00.000Z",
        ], early_series["observedAt"])
        self.assertEqual(["2026-11-13T10:04:00Z", "2026-11-13T10:04:00Z"], early_series["availability"])
        self.assertEqual([7, 4], late_series["Values"])
        self.assertEqual([
            "2026-11-13T10:05:00.000Z",
            "2026-11-13T10:03:00.000Z",
        ], late_series["observedAt"])
        self.assertEqual(["2026-11-13T10:05:30Z", "2026-11-13T10:04:00Z"], late_series["availability"])
        for result, cutoff in ((early, CUTOFF_ONE), (late, CUTOFF_TWO)):
            self.assertEqual(cutoff, result["referenceTime"])
            self.assertNotIn("observedAt", result)
            series = result["observations"][0]
            self.assertEqual(len(series["Timestamps"]), len(series["Values"]))
            self.assertEqual(len(series["Values"]), len(series["observedAt"]))
            self.assertEqual(len(series["Values"]), len(series["availability"]))


if __name__ == "__main__":
    unittest.main()
