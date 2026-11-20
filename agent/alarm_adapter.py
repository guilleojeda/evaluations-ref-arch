"""Forward direct CloudWatch alarm deliveries to the selected AgentCore endpoint."""

from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime
from typing import Any, Mapping

import boto3
from botocore.config import Config
from boto3.dynamodb.types import TypeDeserializer


_SELECTION_PK = "AGENT_SELECTION"
_ALLOWED_ENDPOINTS = frozenset({"faulty", "repaired"})
_MODEL_ID = "us.anthropic.claude-opus-5-5"
_COMMON_SELECTION_FIELDS = frozenset(
    {
        "pk",
        "candidateId",
        "runtimeArn",
        "runtimeVersion",
        "endpointName",
        "endpointArn",
        "artifactSha256",
        "artifactVersionId",
        "configurationSha256",
        "sourceRevision",
        "sourceSha256",
        "promptSha256",
        "modelId",
        "alarmArn",
        "adapterArn",
        "adapterCodeSha256",
        "selectedAt",
    }
)
_REFERENCE_SELECTION_FIELDS = frozenset({"sourceManifestSha256"})
_REPAIRED_SELECTION_FIELDS = frozenset(
    {
        "caseSetSha256",
        "reportIdentitiesSha256",
        "experimentId",
        "reviewEnvironment",
        "reviewRunId",
        "reviewManifestSha256",
        "reviewer",
    }
)


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


def _runtime_arn() -> str:
    runtime_arn = _required("AGENT_RUNTIME_ARN")
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
    return runtime_arn


def _decode_selection(response: Any) -> Mapping[str, Any]:
    """Decode one low-level DynamoDB item without accepting an absent row."""

    item = response.get("Item") if isinstance(response, Mapping) else None
    if not isinstance(item, Mapping) or not item:
        raise ValueError("selected Runtime publication is missing")
    try:
        deserialize = TypeDeserializer().deserialize
        decoded = {str(key): deserialize(value) for key, value in item.items()}
    except (AttributeError, TypeError, ValueError, KeyError) as exc:
        raise ValueError("selected Runtime publication is malformed") from exc
    if not isinstance(decoded, Mapping):
        raise ValueError("selected Runtime publication is malformed")
    return decoded


def _selected_deployment() -> dict[str, str]:
    """Read and validate the one controller-owned routing row.

    The adapter intentionally does not retain static endpoint/version/source
    settings.  A missing or invalid selection is a hard rejection, while AWS
    transport exceptions remain uncaught so Lambda's delivery retry policy can
    redeliver the original alarm.
    """

    runtime_arn = _runtime_arn()
    table_name = _required("AGENT_SELECTION_TABLE")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{3,255}", table_name):
        raise ValueError("selected Runtime table name is invalid")
    alarm_arn = _required("AGENT_ALARM_ARN")
    alarm_parts = alarm_arn.split(":", 5)
    region = os.environ.get("AWS_REGION", alarm_parts[3])
    client = boto3.client(
        "dynamodb",
        region_name=region,
        config=Config(connect_timeout=10, read_timeout=10, retries={"total_max_attempts": 1}),
    )
    # Do not catch client/transport exceptions here: Lambda must retry a
    # transient selection read instead of turning it into a terminal result.
    response = client.get_item(
        TableName=table_name,
        Key={"pk": {"S": _SELECTION_PK}},
        ConsistentRead=True,
    )
    row = _decode_selection(response)

    if not _COMMON_SELECTION_FIELDS.issubset(row):
        raise ValueError("selected Runtime publication is incomplete")
    if row["pk"] != _SELECTION_PK:
        raise ValueError("selected Runtime publication key is invalid")
    candidate = row["candidateId"]
    endpoint = row["endpointName"]
    if not isinstance(candidate, str) or candidate not in _ALLOWED_ENDPOINTS:
        raise ValueError("selected Runtime candidate is not approved")
    candidate_fields = (
        _REFERENCE_SELECTION_FIELDS if candidate == "faulty" else _REPAIRED_SELECTION_FIELDS
    )
    if not candidate_fields.issubset(row):
        raise ValueError("selected Runtime publication provenance is incomplete")
    for field in candidate_fields:
        value = row[field]
        if not isinstance(value, str) or not value or len(value) > 1024:
            raise ValueError(f"selected Runtime {field} is invalid")
    for field in (
        "sourceManifestSha256",
        "caseSetSha256",
        "reportIdentitiesSha256",
        "reviewManifestSha256",
    ):
        if field in row and (
            not isinstance(row[field], str)
            or not re.fullmatch(r"[a-fA-F0-9]{64}", row[field])
        ):
            raise ValueError(f"selected Runtime {field} is invalid")
    if endpoint != candidate:
        raise ValueError("selected Runtime endpoint does not match its candidate")
    if row["runtimeArn"] != runtime_arn:
        raise ValueError("selected Runtime ARN does not match the fixed Runtime")
    version = row["runtimeVersion"]
    if not isinstance(version, str) or not re.fullmatch(r"[1-9][0-9]*", version):
        raise ValueError("selected Runtime version has not been verified")
    endpoint_arn = row["endpointArn"]
    if endpoint_arn != f"{runtime_arn}/runtime-endpoint/{candidate}":
        raise ValueError("selected Runtime endpoint ARN is invalid")
    source_revision = row["sourceRevision"]
    if not isinstance(source_revision, str) or not re.fullmatch(r"[a-fA-F0-9]{40}", source_revision):
        raise ValueError("selected Runtime source revision is invalid")
    artifact_sha = row["artifactSha256"]
    if not isinstance(artifact_sha, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", artifact_sha):
        raise ValueError("selected Runtime artifact digest is invalid")
    for field in (
        "configurationSha256",
        "sourceSha256",
        "promptSha256",
        "adapterCodeSha256",
    ):
        value = row[field]
        if not isinstance(value, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", value):
            raise ValueError(f"selected Runtime {field} is invalid")
    artifact_version = row["artifactVersionId"]
    if not isinstance(artifact_version, str) or not re.fullmatch(r"[^\s]{1,1024}", artifact_version):
        raise ValueError("selected Runtime artifact version is invalid")
    if row["alarmArn"] != alarm_arn:
        raise ValueError("selected Runtime alarm does not match the configured alarm")
    if row["modelId"] != _MODEL_ID:
        raise ValueError("selected Runtime model is not the approved model")
    return {
        "runtimeArn": runtime_arn,
        "runtimeVersion": version,
        "endpointName": candidate,
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
        deployment = _selected_deployment()
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
