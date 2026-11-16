"""Shared, bounded Strands construction and report validation.

The Runtime and captured execution use the same model, tools, report schema,
and invocation limits.  This module owns that common agent path; callers own
their event, claim, evidence, and persistence boundaries.
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
import time
from datetime import datetime
from threading import Event
from typing import Annotated, Any, Literal, Mapping

from botocore.config import Config
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.json_schema import WithJsonSchema
from strands import Agent
from strands.models import BedrockModel


MODEL_ID = "us.anthropic.claude-sonnet-4-6"
REPORT_SCHEMA_VERSION = 2
RUN_SECONDS = 240
MAX_MODEL_REQUESTS = 12
MAX_TOOL_CALLS = 12
MAX_TURNS = MAX_MODEL_REQUESTS
MAX_TOKENS = 64_000
CITATION_TIMESTAMP_PATTERN = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-](?:[01][0-9]|2[0-3]):?[0-5][0-9])"
)


class EvidenceCitation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: str = Field(min_length=1, max_length=80)
    resource: str = Field(min_length=1, max_length=240)
    windowStart: str = Field(min_length=1, max_length=64)
    windowEnd: str = Field(min_length=1, max_length=64)
    observedAt: str = Field(min_length=1, max_length=64)
    finding: str = Field(min_length=1, max_length=2000)

    @field_validator("windowStart", "windowEnd", "observedAt")
    @classmethod
    def validate_timezone_qualified_timestamp(cls, value: str) -> str:
        if not CITATION_TIMESTAMP_PATTERN.fullmatch(value):
            raise ValueError("citation timestamps must be timezone-qualified ISO-8601 values")
        try:
            parsed = datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)
        except ValueError as exc:
            raise ValueError("citation timestamps must be valid calendar and clock values") from exc
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise ValueError("citation timestamps must include a timezone")
        return value


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
                "For Increase memory, provide an integer allocation in MB; for Increase "
                "reserved concurrency, provide a positive integer in executions; for "
                "Restore inventory access, provide a canonical positive published version "
                "string; for Other, provide a non-empty explanation."
            ),
        }),
    ]
    unit: str | None

    @model_validator(mode="before")
    @classmethod
    def validate_canonical_fields(cls, value: Any) -> Any:
        """Reject coercible values before Pydantic can normalize them."""
        if not isinstance(value, Mapping):
            return value
        action = value.get("action")
        target = value.get("target")
        recommendation_value = value.get("value")
        unit = value.get("unit")
        if action == "Increase memory":
            if target not in {"checkout", "inventory"} or type(recommendation_value) is not int or unit != "MB":
                raise ValueError("memory recommendations require a resource, integer allocation, and unit MB")
            if not 128 <= recommendation_value <= 10240:
                raise ValueError("memory recommendation must use a supported Lambda allocation")
        elif action == "Increase reserved concurrency":
            if target not in {"checkout", "inventory"} or type(recommendation_value) is not int or unit != "executions":
                raise ValueError("reserved concurrency recommendations require a resource, integer allocation, and unit executions")
            if recommendation_value <= 0:
                raise ValueError("reserved concurrency recommendation must be positive")
        elif action == "Restore inventory access":
            if (
                target != "inventory"
                or type(recommendation_value) is not str
                or re.fullmatch(r"[1-9][0-9]*", recommendation_value) is None
                or unit != "version"
            ):
                raise ValueError("inventory access recommendation requires a canonical positive version and unit version")
        elif action == "Other":
            if target is not None or type(recommendation_value) is not str or not recommendation_value.strip() or unit is not None:
                raise ValueError("Other recommendation requires explanation text with null target and unit")
        return value

    @model_validator(mode="after")
    def validate_supported_action_detail(self) -> "Recommendation":
        if self.action == "Increase memory" and (self.target not in {"checkout", "inventory"} or type(self.value) is not int or self.unit != "MB"):
            raise ValueError("memory recommendations require a resource, integer allocation, and unit MB")
        if self.action == "Increase reserved concurrency" and (self.target not in {"checkout", "inventory"} or type(self.value) is not int or self.value <= 0 or self.unit != "executions"):
            raise ValueError("reserved concurrency recommendations require a resource, integer allocation, and unit executions")
        if self.action == "Restore inventory access" and (self.target != "inventory" or type(self.value) is not str or re.fullmatch(r"[1-9][0-9]*", self.value) is None or self.unit != "version"):
            raise ValueError("inventory access recommendation requires a canonical positive version and unit version")
        if self.action == "Other" and (self.target is not None or type(self.value) is not str or not self.value.strip() or self.unit is not None):
            raise ValueError("Other recommendation requires explanation text with null target and unit")
        return self


class InvestigationReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    assessment: Literal["ongoing", "recovered", "unknown"]
    summary: str = Field(min_length=1, max_length=4000)
    recommendation: Recommendation
    evidence: list[EvidenceCitation] = Field(min_length=1, max_length=30)
    uncertainties: list[str] = Field(max_length=30)
    alternatives: list[str] = Field(max_length=30)


class ToolBudgetExceeded(RuntimeError):
    pass


class ModelRequestBudgetExceeded(RuntimeError):
    pass


class BoundedBedrockClient:
    """Count every outbound ConverseStream request, including SDK fallbacks."""

    def __init__(
        self,
        client: Any,
        *,
        deadline_monotonic: float,
        cancel_signal: Event,
        capture_requests: bool = False,
    ) -> None:
        self._client = client
        self.deadline_monotonic = deadline_monotonic
        self.cancel_signal = cancel_signal
        self.capture_requests = capture_requests
        self.requests = 0
        self.attempts: list[dict[str, Any]] = []

    def converse_stream(self, **request: Any) -> Any:
        if self.cancel_signal.is_set() or time.monotonic() >= self.deadline_monotonic:
            raise TimeoutError("investigation deadline exceeded before model request")
        if self.requests >= MAX_MODEL_REQUESTS:
            raise ModelRequestBudgetExceeded("model request limit reached")
        self.requests += 1
        attempt: dict[str, Any] | None = None
        if self.capture_requests:
            request_snapshot = copy.deepcopy(request)
            request_bytes = json.dumps(
                request_snapshot,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            ).encode("utf-8")
            request_sha256 = hashlib.sha256(request_bytes).hexdigest()
            from opentelemetry import trace

            active_span = trace.get_current_span()
            if (
                getattr(active_span, "name", None) != "chat"
                or not active_span.is_recording()
            ):
                raise RuntimeError("captured model request was not made inside a recording Strands chat span")
            active_span.set_attribute(
                f"incident.model_request.{self.requests}.sha256",
                request_sha256,
            )
            attempt = {
                "ordinal": self.requests,
                "modelId": request.get("modelId"),
                "requestSha256": request_sha256,
                "request": request_snapshot,
                "status": "in_flight",
            }
            self.attempts.append(attempt)
        try:
            response = self._client.converse_stream(**request)
        except Exception as exc:
            if attempt is not None:
                error = getattr(exc, "response", None)
                error_details = error.get("Error") if isinstance(error, Mapping) else None
                if isinstance(error_details, Mapping):
                    attempt["error"] = {
                        key: error_details[key]
                        for key in ("Code", "Message")
                        if isinstance(error_details.get(key), str)
                    }
                    metadata = error.get("ResponseMetadata")
                    if isinstance(metadata, Mapping) and isinstance(metadata.get("RequestId"), str):
                        attempt["requestId"] = metadata["RequestId"]
                else:
                    attempt["error"] = {
                        "type": type(exc).__name__,
                        "message": str(exc)[:1000],
                    }
                attempt["status"] = "error"
            raise
        if attempt is not None:
            attempt["status"] = "stream_returned"
            metadata = response.get("ResponseMetadata") if isinstance(response, Mapping) else None
            if isinstance(metadata, Mapping) and isinstance(metadata.get("RequestId"), str):
                attempt["requestId"] = metadata["RequestId"]
        return response

    def __getattr__(self, name: str) -> Any:
        # BedrockModel also reads public client metadata such as the operation
        # model; keep those public SDK surfaces intact while counting requests.
        return getattr(self._client, name)


def create_agent(
    evidence_tools: Any,
    *,
    region_name: str,
    deadline_monotonic: float,
    cancel_signal: Event,
    trace_attributes: Mapping[str, Any],
    model_session: Any = None,
    capture_model_requests: bool = False,
    agent_class: Any = Agent,
) -> tuple[Any, BoundedBedrockClient]:
    """Construct the one approved agent, optionally using an injected session.

    ``model_session`` is for controlled transports in tests and captured runs.
    When absent, BedrockModel creates its normal production client in the given
    Region.  No test needs to create a boto3 Bedrock client.
    """

    from prompt import SYSTEM_PROMPT

    client_config = Config(
        connect_timeout=10,
        read_timeout=180,
        retries={"total_max_attempts": 1},
    )
    model_options: dict[str, Any] = {
        "model_id": MODEL_ID,
        "max_tokens": MAX_TOKENS,
        "boto_client_config": client_config,
    }
    if model_session is None:
        model_options["region_name"] = region_name
    else:
        model_options["boto_session"] = model_session
    model = BedrockModel(**model_options)
    bounded_model = BoundedBedrockClient(
        model.client,
        deadline_monotonic=deadline_monotonic,
        cancel_signal=cancel_signal,
        capture_requests=capture_model_requests,
    )
    model.client = bounded_model
    agent = agent_class(
        model=model,
        tools=evidence_tools.tools(),
        system_prompt=SYSTEM_PROMPT,
        structured_output_model=InvestigationReport,
        trace_attributes=dict(trace_attributes),
        # Provider and Strands retries would add unbudgeted model requests.
        retry_strategy=None,
    )
    return agent, bounded_model


def invoke_agent(
    agent: Any,
    prompt: str,
    *,
    deadline_monotonic: float,
    cancel_signal: Event,
) -> dict[str, Any] | None:
    """Invoke once; return None only when a normal result arrives after cancellation."""

    result = agent(
        prompt,
        limits={"turns": MAX_TURNS, "structured_output_attempts": 1},
        cancel_signal=cancel_signal,
    )
    if cancel_signal.is_set() or time.monotonic() >= deadline_monotonic:
        return None
    structured = getattr(result, "structured_output", None)
    if isinstance(structured, InvestigationReport):
        return structured.model_dump(mode="json")
    if isinstance(structured, Mapping):
        return InvestigationReport.model_validate(structured).model_dump(mode="json")
    raise ValueError("model did not return a structured report")
