#!/usr/bin/env python3
"""Run one reviewed denial case through native Strands.

The stage checkout supplies the editable prompt and real read-only agent on
``PYTHONPATH``. This file intentionally keeps the audience path visible:
``Case`` -> task -> ``Evaluator`` -> ``Experiment.run_evaluations``.

Exit status: 0 exact-action pass, 1 completed wrong action, 2 incomplete.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from threading import Event
from time import monotonic
from typing import Any, Mapping
from uuid import uuid4

from strands_evals import Case, Experiment
from strands_evals.evaluators import Evaluator
from strands_evals.types.evaluation import EvaluationOutput

from captured_evidence import CapturedEvidenceTools
from investigation import MODEL_ID, RUN_SECONDS, create_agent, invoke_agent
import investigation
import prompt
from score_denial import exact_action_matches
import strands_denial_io
from strands_denial_io import load_inputs, run_cli


class RecommendedAction(Evaluator):
    """Compare the operator-facing action, target, value, and unit."""

    def __init__(self):
        super().__init__(name="recommended-action")

    def evaluate(self, result):
        # The reviewed expectation is authenticated before Experiment. A
        # malformed expectation fails closed; only a valid wrong action is red.
        passed = exact_action_matches(result.expected_output, result.actual_output)
        return [EvaluationOutput(
            score=float(passed), test_pass=passed,
            label="PASS" if passed else "FAIL",
            reason=f"Expected {result.expected_output}; got {result.actual_output}",
        )]


def run_experiment(scenario_path: Path | None, case_path: Path, bundle_path: Path):
    frozen, identity = load_inputs(scenario_path, case_path, bundle_path)
    session_id, actual = str(uuid4()), None

    # The candidate receives exactly the frozen task. The authored expectation
    # stays on Case.expected_output for RecommendedAction only.
    case = Case(
        name=identity["frozenId"],
        input=frozen["task"],
        expected_output=identity["expected"],
        metadata={
            "nativeScenarioId": identity["nativeId"],
            "frozenCaseId": identity["frozenId"],
            "caseSha256": identity["caseSha256"],
            "traceId": identity["traceId"],
            "bundleSha256": identity["bundleSha256"],
        },
    )

    def investigate(test_case):
        nonlocal actual
        deadline, cancelled = monotonic() + RUN_SECONDS, Event()
        tools = CapturedEvidenceTools.load(
            bundle_path,
            reference_time=test_case.input["referenceTime"],
            expected_sha256=identity["bundleSha256"],
            allowed_resources=test_case.input["allowedResources"],
            deadline_monotonic=deadline,
        )
        if tools.origin.get("runId") != identity["originatingRunId"]:
            raise ValueError("captured bundle origin differs from frozen case")
        agent, _client = create_agent(
            tools,
            region_name=os.environ.get("AWS_DEFAULT_REGION") or os.environ.get("AWS_REGION") or "us-east-1",
            deadline_monotonic=deadline,
            cancel_signal=cancelled,
            trace_attributes={"session.id": session_id},
        )
        report = invoke_agent(
            agent,
            json.dumps(test_case.input, sort_keys=True),
            deadline_monotonic=deadline,
            cancel_signal=cancelled,
        )
        actual = report.get("recommendation") if isinstance(report, Mapping) else None
        if not isinstance(actual, Mapping):
            raise RuntimeError("agent did not return a completed structured recommendation")
        actual = dict(actual)
        return {"output": actual}

    report = Experiment(cases=[case], evaluators=[RecommendedAction()]).run_evaluations(investigate)
    rows = getattr(report, "detailed_results", [])
    if actual is None or len(rows) != 1 or len(rows[0]) != 1:
        raise RuntimeError(f"native evaluator output is incomplete: {getattr(report, 'reasons', [])}")
    row = rows[0][0]
    if type(row.test_pass) is not bool or not isinstance(row.reason, str) or not row.reason:
        raise RuntimeError("native evaluator row is incomplete")
    if exact_action_matches(identity["expected"], actual) != row.test_pass:
        raise RuntimeError("native evaluator disagrees with exact-action check")
    return identity, session_id, actual, row


def main(argv: list[str] | None = None) -> int:
    return run_cli(
        run_experiment,
        prompt_module=prompt,
        investigation_module=investigation,
        model_id=MODEL_ID,
        argv=argv,
    )


if __name__ == "__main__":
    raise SystemExit(main())
