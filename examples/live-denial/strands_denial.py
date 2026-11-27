#!/usr/bin/env python3
"""Run the opening denial decision through the application's native Strands agent.

The case supplies the task and reviewed expectation. The exact original trace
supplies the conversation through the original final decision; signed private
reasoning blocks are omitted before replay. At this fixed decision there are no
new reads, so the application constructor receives a provider whose ``tools``
method returns an empty list.

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
from strands_evals.evaluators.deterministic import Equals

from investigation import MODEL_ID, RUN_SECONDS, create_agent
from score_denial import exact_action_matches
import investigation
import prompt
import strands_denial_io
from strands_denial_io import InputMismatch, load_inputs, run_cli


class NoNewReads:
    """Provider used after the recorded read phase; it exposes no tools."""

    def tools(self) -> list[Any]:
        return []


def native_evaluator_output(expected: Mapping[str, Any], actual: Mapping[str, Any]) -> Mapping[str, Any]:
    """Canonicalize a valid recovered-case explanation for native ``Equals``."""

    if (
        expected == {"action": "Other", "target": None, "unit": None}
        and set(actual) == {"action", "target", "value", "unit"}
        and actual.get("action") == "Other"
        and actual.get("target") is None
        and actual.get("unit") is None
        and isinstance(actual.get("value"), str)
        and bool(actual["value"].strip())
    ):
        return {"action": "Other", "target": None, "unit": None}
    return actual


def select_decision(scenario: Mapping[str, Any], spans: list[Mapping[str, Any]]) -> Mapping[str, Any]:
    """Select and authenticate the final model decision from the exact trace."""

    trace_id = scenario["metadata"]["source"]["trace_id"]
    source_session_id = scenario["metadata"]["source"]["session_id"]
    chats = [span for span in spans if span["traceId"] == trace_id and span["name"] == "chat"]
    if not chats:
        raise InputMismatch("trace has no chat decision spans")
    decision = max(chats, key=lambda span: int(span["startTimeUnixNano"]))
    if decision["attributes"].get("session.id") != source_session_id:
        raise InputMismatch("selected decision chat session does not match the scenario source session")
    events = decision["events"]
    choice_events = [event for event in events if event["name"] == "gen_ai.choice"]
    if len(choice_events) != 1 or not isinstance(choice_events[0]["attributes"].get("message"), str):
        raise InputMismatch("selected decision span must contain one gen_ai.choice event")
    original_response = json.loads(choice_events[0]["attributes"]["message"])
    if not isinstance(original_response, list) or not any(
        isinstance(block, Mapping)
        and isinstance(block.get("toolUse"), Mapping)
        and block["toolUse"].get("name") == "InvestigationReport"
        for block in original_response
    ):
        raise InputMismatch("selected decision did not produce the original InvestigationReport")
    return decision


def public_decision_messages(case_input: str, events: list[Mapping[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    """Build the replay conversation while dropping signed reasoning blocks."""

    user_messages: list[list[Mapping[str, Any]]] = []
    history: list[dict[str, Any]] = []
    signed_blocks_omitted = 0
    for event in events:
        name = event["name"]
        if name not in {"gen_ai.user.message", "gen_ai.assistant.message", "gen_ai.tool.message"}:
            continue
        original_content = json.loads(event["attributes"]["content"])
        if not isinstance(original_content, list) or any(not isinstance(block, Mapping) for block in original_content):
            raise InputMismatch("decision message content must be a list of objects")
        if name == "gen_ai.user.message":
            user_messages.append(original_content)
            continue
        role = "assistant" if name == "gen_ai.assistant.message" else "user"
        signed_blocks_omitted += sum("reasoningContent" in block for block in original_content)
        # The signed reasoning block cannot be replayed under a new prompt.
        content = [block for block in original_content if "reasoningContent" not in block]
        if content:
            history.append({"role": role, "content": content})
    if user_messages != [[{"text": case_input}]]:
        raise InputMismatch("selected decision trace does not contain the case's single alarm message")
    return ([{"role": "user", "content": [{"text": case_input}]}, *history], signed_blocks_omitted)


def run_experiment(scenario_path: Path, trace_path: Path):
    """Run one report generation and return its native and exact findings."""

    identity = load_inputs(scenario_path, trace_path)
    session_id = str(uuid4())
    scenario = identity["scenario"]
    decision = select_decision(scenario, identity["trace"])
    # Keep the direct AgentCore-to-Strands mapping visible in this example.
    case = Case(
        name=scenario["scenario_id"],
        input=scenario["turns"][0]["input"],
        expected_output=scenario["metadata"]["expected_recommendation"],
        metadata={
            "scenarioSha256": identity["scenarioSha256"],
            "traceSha256": identity["traceSha256"],
            "traceId": identity["traceId"],
            "sourceSessionId": identity["sourceSessionId"],
        },
    )
    messages, signed_blocks_omitted = public_decision_messages(case.input, decision["events"])
    identity = {
        **identity,
        "sessionId": session_id,
        "signedBlocksOmitted": signed_blocks_omitted,
        "decisionStartTimeUnixNano": str(decision["startTimeUnixNano"]),
    }
    actual: Mapping[str, Any] | None = None

    def generate_recommendation(test_case: Any) -> dict[str, Any]:
        nonlocal actual
        deadline = monotonic() + RUN_SECONDS
        cancelled = Event()
        agent, _bounded_model = create_agent(
            NoNewReads(),
            region_name=os.environ.get("AWS_DEFAULT_REGION") or os.environ.get("AWS_REGION") or "us-east-1",
            deadline_monotonic=deadline,
            cancel_signal=cancelled,
            trace_attributes={"session.id": session_id},
        )
        # Keep the case's first user message authoritative while replaying only
        # the public assistant/tool history from the exact source decision.
        replay_messages = [
            {"role": "user", "content": [{"text": test_case.input}]},
            *messages[1:],
        ]
        result = agent(
            replay_messages,
            # Strands may need one prose-format follow-up and one correction
            # after schema validation. These remain inside this invocation;
            # there are still no operational read tools and no outer rerun.
            limits={"turns": 3, "structured_output_attempts": 2},
            cancel_signal=cancelled,
        )
        if result.structured_output is None:
            raise RuntimeError("agent did not return a structured report")
        actual = result.structured_output.recommendation.model_dump()
        return {"output": native_evaluator_output(test_case.expected_output, actual)}

    report = Experiment(cases=[case], evaluators=[Equals()]).run_evaluations(generate_recommendation)
    rows = getattr(report, "detailed_results", [])
    if actual is None or len(rows) != 1 or len(rows[0]) != 1:
        raise RuntimeError(f"native evaluator output is incomplete: {getattr(report, 'reasons', [])}")
    row = rows[0][0]
    if type(row.test_pass) is not bool or not isinstance(row.reason, str) or not row.reason:
        raise RuntimeError("native evaluator row is incomplete")
    try:
        exact_action = "PASS" if exact_action_matches(identity["expected"], actual) else "FAIL"
    except SystemExit as exc:
        raise InputMismatch(str(exc)) from exc
    return identity, actual, row, exact_action


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
