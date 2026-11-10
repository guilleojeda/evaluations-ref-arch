"""Bounded, event-deduplicated AgentCore investigation runtime."""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Event, Timer
from typing import Annotated, Any, Literal, Mapping

import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp, RequestContext
from botocore.config import Config
from botocore.exceptions import ClientError
from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode
from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.json_schema import WithJsonSchema
from strands import Agent
from strands.models import BedrockModel

from evidence import EvidenceTools
from prompt import PROMPT_SHA256, SYSTEM_PROMPT


MODEL_ID = "us.anthropic.claude-sonnet-4-6"
RUN_SECONDS = 240
MAX_MODEL_REQUESTS = 12
MAX_TOOL_CALLS = 12
FAULTY_ENDPOINT = "faulty"
RUNTIME_ARN_PREFIX = "arn:aws:bedrock-agentcore:"
MANIFEST_PATH = Path(__file__).with_name("agent-manifest.json")


class EvidenceCitation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: str = Field(min_length=1, max_length=80)
    resource: str = Field(min_length=1, max_length=240)
    windowStart: str = Field(min_length=1, max_length=64)
    windowEnd: str = Field(min_length=1, max_length=64)
    observedAt: str = Field(min_length=1, max_length=64)
    finding: str = Field(min_length=1, max_length=2000)


class Recommendation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: Literal[
        "Increase reserved concurrency",
        "Increase memory",
        "Restore inventory access",
        "Other",
    ]
    target: Literal["checkout", "inventory"] | None
    # Strands' locked JSON Schema converter omits the string branch of this union.
    value: Annotated[
        str | int | None,
        WithJsonSchema({
            "type": ["string", "integer", "null"],
            "description": (
                "For increase actions, provide the integer allocation (memory in MB); "
                "for Restore inventory access, provide a non-empty policy or version detail; "
                "for Other, provide a non-empty explanation."
            ),
        }),
    ]
    unit: str | None

    @model_validator(mode="after")
    def validate_supported_action_detail(self) -> "Recommendation":
        if self.action in {"Increase reserved concurrency", "Increase memory"}:
            if self.target not in {"checkout", "inventory"} or not isinstance(self.value, int):
                raise ValueError("resource recommendations require a target and integer value")
        if self.action == "Increase memory" and not 128 <= int(self.value or 0) <= 10240:
            raise ValueError("memory recommendation must use a supported Lambda allocation")
        if self.action == "Increase reserved concurrency" and int(self.value or 0) <= 0:
            raise ValueError("reserved concurrency recommendation must be positive")
        if self.action == "Restore inventory access":
            if self.target != "inventory" or not isinstance(self.value, str) or not self.value.strip():
                raise ValueError("inventory access recommendation requires inventory and a policy or version detail")
        if self.action == "Other" and (not isinstance(self.value, str) or not self.value.strip()):
            raise ValueError("Other recommendation requires an explanation")
        return self


class InvestigationReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    assessment: Literal["ongoing", "recovered", "unknown"]
    summary: str = Field(min_length=1, max_length=4000)
    recommendation: Recommendation
    evidence: list[EvidenceCitation] = Field(min_length=1, max_length=30)
    uncertainties: list[str] = Field(max_length=30)
    alternatives: list[str] = Field(max_length=30)


class InvalidInvocation(ValueError):
    """The payload is not a trusted, direct CloudWatch alarm invocation."""


class ToolBudgetExceeded(RuntimeError):
    pass


class ModelRequestBudgetExceeded(RuntimeError):
    pass


class BoundedBedrockClient:
    """Count every outbound ConverseStream request, including SDK fallbacks."""

    def __init__(self, client: Any, *, deadline_monotonic: float, cancel_signal: Event) -> None:
        self._client = client
        self.deadline_monotonic = deadline_monotonic
        self.cancel_signal = cancel_signal
        self.requests = 0

    def converse_stream(self, **request: Any) -> Any:
        if self.cancel_signal.is_set() or time.monotonic() >= self.deadline_monotonic:
            raise TimeoutError("investigation deadline exceeded before model request")
        if self.requests >= MAX_MODEL_REQUESTS:
            raise ModelRequestBudgetExceeded("model request limit reached")
        self.requests += 1
        return self._client.converse_stream(**request)

    def __getattr__(self, name: str) -> Any:
        # BedrockModel also reads public client metadata such as the operation
        # model; keep those public SDK surfaces intact while counting requests.
        return getattr(self._client, name)


app = BedrockAgentCoreApp()
tracer = trace.get_tracer("incident-triage-agent")


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _parse_timestamp(value: Any) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise InvalidInvocation("alarm transition timestamp is missing")
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise InvalidInvocation("alarm transition timestamp is invalid") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise InvalidInvocation("alarm transition timestamp must include a timezone")
    return parsed.astimezone(timezone.utc)


def _manifest() -> dict[str, str]:
    try:
        value = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise InvalidInvocation("packaged identity manifest is unavailable") from exc
    if not isinstance(value, Mapping):
        raise InvalidInvocation("packaged identity manifest is invalid")
    source_revision = value.get("sourceRevision")
    prompt_sha256 = value.get("promptSha256")
    if not isinstance(source_revision, str) or not source_revision:
        raise InvalidInvocation("packaged source revision is invalid")
    if prompt_sha256 != PROMPT_SHA256:
        raise InvalidInvocation("packaged prompt digest does not match the runtime prompt")
    return {"sourceRevision": source_revision, "promptSha256": prompt_sha256}


def _config() -> dict[str, str]:
    required = (
        "AGENT_RUN_TABLE",
        "AGENT_SOURCE_BUCKET",
        "AGENT_SOURCE_PREFIX",
        "AGENT_ALARM_ARN",
        "AGENT_ACCOUNT_ID",
        "AGENT_REGION",
        "AGENT_CANDIDATE_ID",
        "AGENT_SOURCE_REVISION",
        "AGENT_ARTIFACT_SHA256",
        "AGENT_ENDPOINT_NAME",
        "AGENT_APP_HTTP_API_ID",
    )
    values: dict[str, str] = {}
    for name in required:
        value = os.environ.get(name, "").strip()
        if not value:
            raise InvalidInvocation(f"required runtime setting is missing: {name}")
        values[name] = value
    model_id = os.environ.get("AGENT_MODEL_ID", MODEL_ID).strip()
    if model_id != MODEL_ID:
        raise InvalidInvocation("runtime model does not match the approved initial profile")
    values["AGENT_MODEL_ID"] = model_id
    if values["AGENT_CANDIDATE_ID"] != "faulty":
        raise InvalidInvocation("runtime candidate does not match the pinned initial candidate")
    if values["AGENT_ENDPOINT_NAME"] != FAULTY_ENDPOINT:
        raise InvalidInvocation("runtime endpoint does not match the pinned initial endpoint")
    return values


def _arn_for_runtime(value: Any, account_id: str, region: str) -> str:
    if not isinstance(value, str) or not value.startswith(RUNTIME_ARN_PREFIX):
        raise InvalidInvocation("deployment Runtime ARN is invalid")
    parts = value.split(":", 5)
    if (
        len(parts) != 6
        or parts[0] != "arn"
        or parts[1] != "aws"
        or parts[2] != "bedrock-agentcore"
        or parts[3] != region
        or parts[4] != account_id
        or not re.fullmatch(r"runtime/IncidentTriageDemoAgent-[A-Za-z0-9_-]+", parts[5])
    ):
        raise InvalidInvocation("deployment Runtime ARN is outside the configured account")
    return value


def _validate_invocation(payload: Any, context: RequestContext) -> tuple[dict[str, Any], dict[str, str], str]:
    if not isinstance(payload, Mapping) or set(payload) != {"event", "deployment"}:
        raise InvalidInvocation("runtime payload must contain only event and deployment")
    event, deployment = payload.get("event"), payload.get("deployment")
    if not isinstance(event, Mapping) or not isinstance(deployment, Mapping):
        raise InvalidInvocation("runtime event and deployment attestation are required")

    config = _config()
    if event.get("source") != "aws.cloudwatch":
        raise InvalidInvocation("event source is not CloudWatch")
    if event.get("alarmArn") != config["AGENT_ALARM_ARN"]:
        raise InvalidInvocation("event alarm is outside the configured application")
    if str(event.get("accountId", "")) != config["AGENT_ACCOUNT_ID"]:
        raise InvalidInvocation("event account does not match the configured account")
    if event.get("region") != config["AGENT_REGION"]:
        raise InvalidInvocation("event region does not match the configured Region")
    alarm_data = event.get("alarmData")
    state = alarm_data.get("state") if isinstance(alarm_data, Mapping) else None
    if not isinstance(state, Mapping) or state.get("value") != "ALARM":
        raise InvalidInvocation("event is not an ALARM state transition")
    transition_at = _iso(_parse_timestamp(state.get("timestamp")))

    if set(deployment) != {"runtimeArn", "runtimeVersion", "endpointName", "sourceRevision", "artifactSha256"}:
        raise InvalidInvocation("deployment attestation has an unexpected shape")
    runtime_arn = _arn_for_runtime(deployment.get("runtimeArn"), config["AGENT_ACCOUNT_ID"], config["AGENT_REGION"])
    version = deployment.get("runtimeVersion")
    if not isinstance(version, str) or not re.fullmatch(r"[1-9][0-9]*", version):
        raise InvalidInvocation("deployment Runtime version is not verified")
    if deployment.get("endpointName") != config["AGENT_ENDPOINT_NAME"]:
        raise InvalidInvocation("deployment endpoint is not the pinned candidate")
    manifest = _manifest()
    if deployment.get("sourceRevision") != config["AGENT_SOURCE_REVISION"]:
        raise InvalidInvocation("deployment source revision does not match runtime configuration")
    if deployment.get("sourceRevision") != manifest["sourceRevision"]:
        raise InvalidInvocation("deployment source revision does not match the packaged source")
    artifact_sha = config["AGENT_ARTIFACT_SHA256"]
    if not re.fullmatch(r"[a-fA-F0-9]{64}", artifact_sha) or deployment.get("artifactSha256") != artifact_sha:
        raise InvalidInvocation("deployment artifact digest does not match the release attestation")

    session_id = getattr(context, "session_id", None)
    if not isinstance(session_id, str) or not session_id.strip():
        raise InvalidInvocation("native Runtime session identity is missing")
    return dict(event), config, _iso(_parse_timestamp(state.get("timestamp")))


def _deployment_from(payload: Mapping[str, Any]) -> Mapping[str, Any]:
    return payload["deployment"]


def _failure_result() -> dict[str, str]:
    # Do not put provider exception text (which may contain request data) in the
    # durable controller-facing record.
    return {"code": "INVESTIGATION_FAILED", "message": "The investigation did not produce a validated report."}


def _trace_id() -> str | None:
    span_context = trace.get_current_span().get_span_context()
    return f"{span_context.trace_id:032x}" if span_context.is_valid else None


def _new_evidence(
    session: boto3.Session,
    config: Mapping[str, str],
    run_id: str,
    alarm_arn: str,
    transition_at: str,
    started_at: str,
    deadline_monotonic: float,
    charge_tool_call: Any,
) -> EvidenceTools:
    return EvidenceTools(
        session,
        account_id=config["AGENT_ACCOUNT_ID"],
        region=config["AGENT_REGION"],
        app_http_api_id=config["AGENT_APP_HTTP_API_ID"],
        source_bucket=config["AGENT_SOURCE_BUCKET"],
        source_prefix=config["AGENT_SOURCE_PREFIX"],
        run_id=run_id,
        alarm_arn=alarm_arn,
        transition_at=transition_at,
        started_at=started_at,
        deadline_monotonic=deadline_monotonic,
        charge_tool_call=charge_tool_call,
    )


def _read_existing(table: Any, alarm_arn: str, transition_at: str) -> dict[str, Any] | None:
    response = table.get_item(Key={"pk": alarm_arn, "sk": transition_at}, ConsistentRead=True)
    item = response.get("Item") if isinstance(response, Mapping) else None
    return dict(item) if isinstance(item, Mapping) else None


def _save_running_fields(table: Any, key: Mapping[str, str], owner: Mapping[str, str], **fields: Any) -> bool:
    names = {"#status": "status"}
    values: dict[str, Any] = {":running": "running", ":runtimeSessionId": owner["runtimeSessionId"], ":runId": owner["runId"]}
    assignments: list[str] = []
    for name, value in fields.items():
        token = f":v{len(assignments)}"
        field_name = f"#f{len(assignments)}"
        names[field_name] = name
        values[token] = value
        assignments.append(f"{field_name} = {token}")
    if not assignments:
        return True
    try:
        table.update_item(
            Key=dict(key),
            UpdateExpression="SET " + ", ".join(assignments),
            ConditionExpression="#status = :running AND runtimeSessionId = :runtimeSessionId AND runId = :runId",
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )
        return True
    except ClientError:
        return False


def _finish(
    table: Any,
    key: Mapping[str, str],
    owner: Mapping[str, str],
    *,
    status: str,
    finished_at: str,
    trace_ref: Mapping[str, Any],
    capture_ref: Mapping[str, Any],
    report: Mapping[str, Any] | None = None,
    failure: Mapping[str, str] | None = None,
) -> bool:
    names = {"#status": "status", "#traceRef": "traceRef", "#captureRef": "captureRef"}
    values: dict[str, Any] = {
        ":running": "running",
        ":runtimeSessionId": owner["runtimeSessionId"],
        ":runId": owner["runId"],
        ":status": status,
        ":finishedAt": finished_at,
        ":traceRef": dict(trace_ref),
        ":captureRef": dict(capture_ref),
    }
    assignments = ["#status = :status", "finishedAt = :finishedAt", "#traceRef = :traceRef", "#captureRef = :captureRef"]
    if report is not None:
        names["#report"] = "report"
        values[":report"] = dict(report)
        assignments.append("#report = :report")
    if failure is not None:
        names["#failure"] = "failure"
        values[":failure"] = dict(failure)
        assignments.append("#failure = :failure")
    try:
        table.update_item(
            Key=dict(key),
            UpdateExpression="SET " + ", ".join(assignments),
            ConditionExpression="#status = :running AND runtimeSessionId = :runtimeSessionId AND runId = :runId",
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )
        return True
    except ClientError:
        return False


def _start_claim(
    table: Any,
    *,
    event: Mapping[str, Any],
    config: Mapping[str, str],
    transition_at: str,
    session_id: str,
    deployment: Mapping[str, Any],
    started_at: str,
    deadline_at: str,
) -> tuple[dict[str, Any] | None, str]:
    alarm_arn = config["AGENT_ALARM_ARN"]
    run_id = str(uuid.uuid4())
    item = {
        "pk": alarm_arn,
        "sk": transition_at,
        "alarmArn": alarm_arn,
        "transitionAt": transition_at,
        "runId": run_id,
        "runtimeSessionId": session_id,
        "candidateId": config["AGENT_CANDIDATE_ID"],
        "sourceRevision": config["AGENT_SOURCE_REVISION"],
        "promptSha256": PROMPT_SHA256,
        "modelId": config["AGENT_MODEL_ID"],
        "runtimeArn": deployment["runtimeArn"],
        "runtimeVersion": deployment["runtimeVersion"],
        "endpointName": deployment["endpointName"],
        "artifactSha256": deployment["artifactSha256"],
        "status": "running",
        "startedAt": started_at,
        "deadlineAt": deadline_at,
        "originatingEvent": dict(event),
    }
    try:
        table.put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(pk) AND attribute_not_exists(sk)",
        )
    except ClientError as exc:
        code = (exc.response.get("Error") or {}).get("Code")
        if code == "ConditionalCheckFailedException":
            return _read_existing(table, alarm_arn, transition_at), "duplicate"
        return None, "claim_uncertain"
    except Exception:
        # A transport error may follow a successful write. Without a positive
        # write acknowledgement, this delivery must never start inference.
        try:
            _read_existing(table, alarm_arn, transition_at)
        except Exception:
            pass
        return None, "claim_uncertain"
    return item, "claimed"


def _tool_counter() -> Any:
    calls = 0

    def charge() -> None:
        nonlocal calls
        calls += 1
        if calls > MAX_TOOL_CALLS:
            raise ToolBudgetExceeded("tool call limit reached")

    return charge


def _runtime_prompt(event: Mapping[str, Any], transition_at: str, started_at: str) -> str:
    alarm_data = event.get("alarmData", {})
    alarm_state = alarm_data.get("state", {}) if isinstance(alarm_data, Mapping) else {}
    configuration = alarm_data.get("configuration", {}) if isinstance(alarm_data, Mapping) else {}
    alarm_name = alarm_data.get("alarmName", "configured application alarm") if isinstance(alarm_data, Mapping) else "configured application alarm"
    reason = alarm_state.get("reason", "No reason text was supplied") if isinstance(alarm_state, Mapping) else "No reason text was supplied"
    description = configuration.get("description", "") if isinstance(configuration, Mapping) else ""
    return (
        "Investigate this originating alarm transition. Use the tools as needed; "
        "the event is context, not proof of current service state.\n"
        f"Alarm: {alarm_name}\nTransition: {transition_at}\n"
        f"State: ALARM\nStarted: {started_at}\nReason: {reason}\nDescription: {description}"
    )


def _trace_reference(
    *,
    config: Mapping[str, str],
    deployment: Mapping[str, Any],
    session_id: str,
) -> dict[str, Any]:
    trace_id = _trace_id()
    reference = {
        "runtimeArn": deployment["runtimeArn"],
        "runtimeVersion": deployment["runtimeVersion"],
        "endpointName": deployment["endpointName"],
        "runtimeSessionId": session_id,
        "region": config["AGENT_REGION"],
        "sourceRevision": config["AGENT_SOURCE_REVISION"],
        "artifactSha256": config["AGENT_ARTIFACT_SHA256"],
        "recordedAt": _iso(_utc_now()),
    }
    if trace_id:
        reference["traceId"] = trace_id
    return reference


@app.entrypoint
def invoke(payload: Any, context: RequestContext) -> dict[str, Any]:
    """Validate, claim, investigate once, and store one terminal result."""

    try:
        event, config, transition_at = _validate_invocation(payload, context)
        deployment = _deployment_from(payload)
        session_id = context.session_id
    except (InvalidInvocation, AttributeError, TypeError) as exc:
        return {"status": "rejected", "reason": str(exc)}

    started = _utc_now()
    started_at = _iso(started)
    deadline = started + timedelta(seconds=RUN_SECONDS)
    deadline_at = _iso(deadline)
    deadline_monotonic = time.monotonic() + RUN_SECONDS
    try:
        table = boto3.resource("dynamodb", region_name=config["AGENT_REGION"]).Table(config["AGENT_RUN_TABLE"])
    except Exception:
        return {"status": "failed", "reason": "run store is unavailable"}

    claim, claim_status = _start_claim(
        table,
        event=event,
        config=config,
        transition_at=transition_at,
        session_id=session_id,
        deployment=deployment,
        started_at=started_at,
        deadline_at=deadline_at,
    )
    if claim_status != "claimed" or claim is None:
        existing = claim if isinstance(claim, Mapping) else {}
        return {
            "status": claim_status,
            "runId": existing.get("runId"),
            "runStatus": existing.get("status"),
            "transitionAt": transition_at,
        }

    run_id = claim["runId"]
    key = {"pk": config["AGENT_ALARM_ARN"], "sk": transition_at}
    owner = {"runId": run_id, "runtimeSessionId": session_id}
    session = boto3.Session(region_name=config["AGENT_REGION"])
    charge_tool_call = _tool_counter()
    evidence = _new_evidence(
        session,
        config,
        run_id,
        config["AGENT_ALARM_ARN"],
        transition_at,
        started_at,
        deadline_monotonic,
        charge_tool_call,
    )
    capture_ref: dict[str, Any] = {}
    timer: Timer | None = None
    cancel_signal = Event()
    trace_ref: dict[str, Any] = {}

    span_attributes = {
        "incident.alarm_arn": config["AGENT_ALARM_ARN"],
        "incident.transition_at": transition_at,
        "incident.run_id": run_id,
        "session.id": session_id,
        "incident.candidate_id": config["AGENT_CANDIDATE_ID"],
        "incident.source_revision": config["AGENT_SOURCE_REVISION"],
        "incident.prompt_sha256": PROMPT_SHA256,
        "gen_ai.request.model": config["AGENT_MODEL_ID"],
    }
    with tracer.start_as_current_span("incident_triage.investigation", attributes=span_attributes) as span:
        try:
            capture_ref = dict(evidence.capture_baseline().get("captureRef", {}))
            _save_running_fields(table, key, owner, captureRef=capture_ref)
            if time.monotonic() >= deadline_monotonic:
                return {"status": "running", "runId": run_id, "transitionAt": transition_at}

            model = BedrockModel(
                model_id=config["AGENT_MODEL_ID"],
                region_name=config["AGENT_REGION"],
                max_tokens=64_000,
                boto_client_config=Config(
                    connect_timeout=10,
                    read_timeout=180,
                    retries={"total_max_attempts": 1},
                ),
            )
            model.client = BoundedBedrockClient(
                model.client,
                deadline_monotonic=deadline_monotonic,
                cancel_signal=cancel_signal,
            )
            agent = Agent(
                model=model,
                tools=evidence.tools(),
                system_prompt=SYSTEM_PROMPT,
                structured_output_model=InvestigationReport,
                trace_attributes=span_attributes,
                # Provider and Strands retries would add unbudgeted model
                # requests. Event-loop turns include structured-output cycles.
                retry_strategy=None,
            )
            remaining = max(0.0, deadline_monotonic - time.monotonic())
            if remaining <= 0:
                return {"status": "running", "runId": run_id, "transitionAt": transition_at}
            timer = Timer(remaining, cancel_signal.set)
            timer.daemon = True
            timer.start()
            result = agent(
                _runtime_prompt(event, transition_at, started_at),
                limits={"turns": MAX_MODEL_REQUESTS, "structured_output_attempts": 1},
                cancel_signal=cancel_signal,
            )
            if cancel_signal.is_set() or time.monotonic() >= deadline_monotonic:
                return {"status": "running", "runId": run_id, "transitionAt": transition_at}
            structured = getattr(result, "structured_output", None)
            if isinstance(structured, InvestigationReport):
                report_value = structured.model_dump(mode="json")
            elif isinstance(structured, Mapping):
                report_value = InvestigationReport.model_validate(structured).model_dump(mode="json")
            else:
                raise ValueError("model did not return a structured report")

            query_capture = evidence.persist_query_results([])
            capture_ref.update(query_capture.get("captureRef", {}))
            _save_running_fields(table, key, owner, captureRef=capture_ref)
            sanitized_trace_report = EvidenceTools._sanitize(report_value)
            span.set_attribute("incident.report", json.dumps(sanitized_trace_report, ensure_ascii=False, separators=(",", ":"))[:12000])
            span.set_attribute("incident.assessment", report_value["assessment"])
            span.set_attribute("incident.recommendation", report_value["recommendation"]["action"])
            trace_ref = _trace_reference(config=config, deployment=deployment, session_id=session_id)
            finished_at = _iso(_utc_now())
            if not _finish(
                table,
                key,
                owner,
                status="complete",
                finished_at=finished_at,
                trace_ref=trace_ref,
                capture_ref=capture_ref,
                report=report_value,
            ):
                return {"status": "running", "runId": run_id, "transitionAt": transition_at}
            return {"status": "complete", "runId": run_id, "transitionAt": transition_at}
        except Exception as exc:
            try:
                query_capture = evidence.persist_query_results([])
                capture_ref.update(query_capture.get("captureRef", {}))
                _save_running_fields(table, key, owner, captureRef=capture_ref)
            except Exception:
                pass
            trace_ref = _trace_reference(config=config, deployment=deployment, session_id=session_id)
            if cancel_signal.is_set() or time.monotonic() >= deadline_monotonic:
                return {"status": "running", "runId": run_id, "transitionAt": transition_at}
            span.set_status(Status(StatusCode.ERROR, type(exc).__name__))
            finished_at = _iso(_utc_now())
            if not _finish(
                table,
                key,
                owner,
                status="failed",
                finished_at=finished_at,
                trace_ref=trace_ref,
                capture_ref=capture_ref,
                failure=_failure_result(),
            ):
                return {"status": "running", "runId": run_id, "transitionAt": transition_at}
            return {"status": "failed", "runId": run_id, "transitionAt": transition_at}
        finally:
            if timer is not None:
                timer.cancel()


if __name__ == "__main__":
    app.run()
