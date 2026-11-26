"""Score the original investigation using the case downloaded from AgentCore."""

import json
from datetime import datetime, timedelta
from pathlib import Path

import boto3
from bedrock_agentcore.evaluation.utils.cloudwatch_span_helper import fetch_spans_from_cloudwatch


def exact_action_matches(expected, actual):
    """Compare the operator-facing fields of this Inventory recommendation."""
    if expected == {"action": "Other", "target": None, "unit": None}:
        # The recovered case leaves the explanation to the agent and the judge.
        if not isinstance(actual, dict):
            return False
        explanation = actual.get("value")
        return (
            isinstance(explanation, str) and bool(explanation.strip())
            and actual == {**expected, "value": explanation}
        )
    version = expected.get("value") if isinstance(expected, dict) else None
    if not (
        isinstance(version, str) and version.isascii() and version.isdecimal()
        and not version.startswith("0")
        and expected == {"action": "Restore inventory access", "target": "inventory",
                         "value": version, "unit": "version"}
    ):
        raise SystemExit("Review metadata.expected_recommendation for this Inventory case, then publish a version.")
    return actual == expected


def score_trace(client, spans, *, trace_id, session_id, expected_response):
    """Score the supplied execution against the reviewed turn in AgentCore."""
    result = client.evaluate(
        evaluatorId="Builtin.Correctness",
        evaluationInput={"sessionSpans": spans},
        evaluationTarget={"traceIds": [trace_id]},
        evaluationReferenceInputs=[{
            "context": {"spanContext": {"sessionId": session_id, "traceId": trace_id}},
            "expectedResponse": {"text": expected_response},
        }],
    )
    score, = result["evaluationResults"]
    if "value" not in score:
        raise SystemExit(f"AgentCore could not score the trace: {score}")
    return score


def main():
    case_file = Path("denial-case.json")
    if not case_file.is_file() or not case_file.stat().st_size:
        raise SystemExit("Download your published case to denial-case.json in this folder first.")
    case = json.loads(case_file.read_text())
    if not isinstance(case, dict) or len(case.get("turns", [])) != 1:
        raise SystemExit("Choose one fixed, single-turn scenario from the incident trace.")
    turn = case["turns"][0]
    if not isinstance(turn.get("expected_response"), str) or not turn["expected_response"].strip():
        raise SystemExit("Add expected_response to the turn in AgentCore, publish a version, and download it.")
    source = case["metadata"]["source"]
    print("Source trace:", source["trace_id"])
    print("Expected:", turn["expected_response"], flush=True)

    # The recorded prompt contains the investigation start time.
    started = next((line for line in turn["input"].splitlines() if line.startswith("Started: ")), None)
    if started is None:
        raise SystemExit("Choose the investigation turn containing its Started: timestamp.")
    at = datetime.fromisoformat(started.removeprefix("Started: ").replace("Z", "+00:00"))
    aws = boto3.Session()
    if not aws.region_name:
        raise SystemExit("Set AWS_DEFAULT_REGION to the region containing your dataset and trace.")
    records = fetch_spans_from_cloudwatch(
        session_id=source["session_id"],
        event_log_group=source["cloudwatch_logs"]["log_group_names"][0],
        start_time=at - timedelta(minutes=1),
        end_time=at + timedelta(minutes=5),
        region=aws.region_name,
    )
    spans = [s for s in records if s.get("traceId") == source["trace_id"]]
    investigation = next((s for s in spans if s.get("name") == "incident_triage.investigation"), None)
    if investigation is None or "incident.report" not in investigation.get("attributes", {}):
        raise SystemExit("CloudWatch has no completed investigation report for this trace.")
    report = json.loads(investigation["attributes"]["incident.report"])
    Path("original-trace.json").write_text(json.dumps(spans) + "\n")
    print("CloudWatch spans:", len(spans))
    actual = report["recommendation"]
    expected = case["metadata"].get("expected_recommendation")
    print("Actual:", actual)
    action_check = "INCOMPLETE"
    if expected is None:
        print("Exact action: INCOMPLETE - add metadata.expected_recommendation and publish a new version.", flush=True)
    else:
        print("Expected action:", expected)
        action_check = "PASS" if exact_action_matches(expected, actual) else "FAIL"
        print("Exact action:", action_check, flush=True)

    score = score_trace(
        aws.client("bedrock-agentcore"), spans, trace_id=source["trace_id"],
        session_id=source["session_id"], expected_response=turn["expected_response"],
    )
    print("AgentCore:", score["label"], score["value"])
    print(score["explanation"])
    summary = {
        "scenarioId": case["scenario_id"], "traceId": source["trace_id"], "sessionId": source["session_id"],
        "expectedResponse": turn["expected_response"], "expectedAction": expected, "actualAction": actual,
        "exactAction": action_check, "agentcore": score,
    }
    Path("original-score.json").write_text(json.dumps(summary, indent=2) + "\n")
    if expected is None:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
