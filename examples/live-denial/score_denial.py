"""Score the original investigation using the case downloaded from AgentCore."""

import json
from datetime import datetime, timedelta
from pathlib import Path

import boto3
from bedrock_agentcore.evaluation.utils.cloudwatch_span_helper import fetch_spans_from_cloudwatch

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
started = next(line for line in turn["input"].splitlines() if line.startswith("Started: "))
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
print("Actual:", report["recommendation"], flush=True)

result = aws.client("bedrock-agentcore").evaluate(
    evaluatorId="Builtin.Correctness",
    evaluationInput={"sessionSpans": spans},
    evaluationTarget={"traceIds": [source["trace_id"]]},
    evaluationReferenceInputs=[{
        "context": {"spanContext": {"sessionId": source["session_id"], "traceId": source["trace_id"]}},
        "expectedResponse": {"text": turn["expected_response"]},
    }],
)
score, = result["evaluationResults"]
if "value" not in score:
    raise SystemExit(f"AgentCore could not score the trace: {score}")
print("AgentCore:", score["label"], score["value"])
print(score["explanation"])
