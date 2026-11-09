"""Forward direct CloudWatch alarm deliveries to the pinned AgentCore endpoint."""

from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime
from typing import Any, Mapping

import boto3
from botocore.config import Config


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"required adapter setting is missing: {name}")
    return value


def _validate_event(event: Any) -> dict[str, Any]:
    if not isinstance(event, Mapping):
        raise ValueError("CloudWatch alarm event must be an object")
    alarm_arn = _required("AGENT_ALARM_ARN")
    alarm_parts = alarm_arn.split(":", 5)
    if len(alarm_parts) != 6 or alarm_parts[:3] != ["arn", "aws", "cloudwatch"]:
        raise ValueError("configured alarm ARN is invalid")
    account_id, alarm_region = alarm_parts[4], alarm_parts[3]
    region = os.environ.get("AWS_REGION", alarm_region)
    if event.get("source") != "aws.cloudwatch":
        raise ValueError("event source is not CloudWatch")
    if event.get("alarmArn") != alarm_arn:
        raise ValueError("event alarm ARN does not match the configured alarm")
    if str(event.get("accountId", "")) != account_id:
        raise ValueError("event account does not match the configured account")
    if event.get("region") != region:
        raise ValueError("event Region does not match the configured Region")
    alarm_data = event.get("alarmData")
    state = alarm_data.get("state") if isinstance(alarm_data, Mapping) else None
    if not isinstance(state, Mapping) or state.get("value") != "ALARM":
        raise ValueError("event is not an ALARM state transition")
    timestamp = state.get("timestamp")
    if not isinstance(timestamp, str) or not timestamp.strip():
        raise ValueError("alarm transition timestamp is missing")
    parsed_text = timestamp.strip()
    if parsed_text.endswith("Z"):
        parsed_text = parsed_text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(parsed_text)
    except ValueError as exc:
        raise ValueError("alarm transition timestamp is invalid") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("alarm transition timestamp must include a timezone")
    return dict(event)


def _deployment() -> dict[str, str]:
    runtime_arn = _required("AGENT_RUNTIME_ARN")
    endpoint = _required("AGENT_ENDPOINT_NAME")
    version = _required("AGENT_RUNTIME_VERSION")
    source_revision = _required("AGENT_SOURCE_REVISION")
    artifact_sha = _required("AGENT_ARTIFACT_SHA256")
    alarm_parts = _required("AGENT_ALARM_ARN").split(":", 5)
    if len(alarm_parts) != 6:
        raise ValueError("configured alarm ARN is invalid")
    region, account = os.environ.get("AWS_REGION", alarm_parts[3]), alarm_parts[4]
    parts = runtime_arn.split(":", 5)
    if (
        len(parts) != 6
        or parts[:3] != ["arn", "aws", "bedrock-agentcore"]
        or parts[3] != region
        or parts[4] != account
        or not re.fullmatch(r"runtime/IncidentTriageDemoAgent-[A-Za-z0-9_-]+", parts[5])
    ):
        raise ValueError("configured Runtime ARN is outside the approved account and Region")
    if endpoint != "faulty":
        raise ValueError("configured Runtime endpoint is not the pinned faulty candidate")
    if not re.fullmatch(r"[1-9][0-9]*", version):
        raise ValueError("Runtime endpoint version has not been verified")
    if not re.fullmatch(r"[a-fA-F0-9]{40}", source_revision):
        raise ValueError("configured source revision is invalid")
    if not re.fullmatch(r"[a-fA-F0-9]{64}", artifact_sha):
        raise ValueError("configured Runtime artifact digest is invalid")
    return {
        "runtimeArn": runtime_arn,
        "runtimeVersion": version,
        "endpointName": endpoint,
        "sourceRevision": source_revision,
        "artifactSha256": artifact_sha,
    }


def _sampled_trace_id() -> str | None:
    value = os.environ.get("_X_AMZN_TRACE_ID", "").strip()
    if not value:
        return None
    match = re.search(r"(?:^|;)\s*Sampled=([01])(?:;|$)", value)
    if not match or match.group(1) != "1":
        return None
    return value


def _drain(response: Any) -> None:
    body = response.get("response") if isinstance(response, Mapping) else None
    if body is None:
        return
    read = getattr(body, "read", None)
    if callable(read):
        while read(64 * 1024):
            pass
        return
    if hasattr(body, "__iter__"):
        for _ in body:
            pass


def handler(event: Any, context: Any) -> dict[str, str]:
    """Validate and forward; Runtime exclusively owns claim and investigation state."""

    try:
        originating_event = _validate_event(event)
        deployment = _deployment()
    except (ValueError, TypeError, IndexError) as exc:
        return {"status": "rejected", "reason": str(exc)}

    session_id = str(uuid.uuid4())
    payload = json.dumps(
        {"event": originating_event, "deployment": deployment},
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    request: dict[str, Any] = {
        "agentRuntimeArn": deployment["runtimeArn"],
        "qualifier": deployment["endpointName"],
        "runtimeSessionId": session_id,
        "payload": payload,
        "contentType": "application/json",
        "accept": "application/json",
    }
    trace_id = _sampled_trace_id()
    if trace_id:
        request["traceId"] = trace_id
    client = boto3.client(
        "bedrock-agentcore",
        region_name=os.environ.get("AWS_REGION", deployment["runtimeArn"].split(":")[3]),
        config=Config(connect_timeout=10, read_timeout=270, retries={"total_max_attempts": 1}),
    )
    response = client.invoke_agent_runtime(**request)
    status_code = int(response.get("statusCode", 200)) if isinstance(response, Mapping) else 200
    if status_code >= 400:
        raise RuntimeError(f"AgentCore Runtime returned HTTP {status_code}")
    _drain(response)
    return {"status": "forwarded", "runtimeSessionId": session_id}
