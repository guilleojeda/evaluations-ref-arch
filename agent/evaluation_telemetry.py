"""Collect and authenticate native Strands session telemetry before scoring.

The CloudWatch copy is the evidence submitted to AgentCore Evaluate.  Local
execution records are used only as an identity and content ledger; they are
never substituted for missing CloudWatch events.
"""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import math
import re
import time
import uuid
from typing import Any, Mapping, Sequence


class TelemetryIncomplete(ValueError):
    """CloudWatch did not provide a complete, identity-matched session."""


_DIMENSIONS = ("diagnosis_support", "evidence_grounding")
_REPORT_TOOL = "InvestigationReport"
_CLOUDWATCH_QUERY_TIMEOUT_SECONDS = 60.0
_CLOUDWATCH_POLL_SECONDS = 0.5
_SCORING_POLL_SECONDS = 1.0
_MAX_QUERY_SECONDS = 6 * 60 * 60
_MAX_QUERY_ROWS = 10_000


def _json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _sha256(value: Any) -> str:
    return hashlib.sha256(_json_bytes(value)).hexdigest()


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _native_value(value: Any) -> Any:
    """Unwrap the typed values used by some CloudWatch OTel encodings."""

    if isinstance(value, Mapping):
        for key in ("stringValue", "intValue", "doubleValue", "boolValue", "bytesValue"):
            if key in value and len(value) == 1:
                return value[key]
    return value


def _attributes(span: Mapping[str, Any]) -> Mapping[str, Any]:
    envelope = _mapping(span.get("attributes"))
    nested = envelope.get("attributes")
    return _mapping(nested) if isinstance(nested, Mapping) else envelope


def _attr(span: Mapping[str, Any], key: str) -> Any:
    return _native_value(_attributes(span).get(key))


def _events(span: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    raw_events = span.get("events")
    if not isinstance(raw_events, list):
        raise TelemetryIncomplete("span events are missing")
    events: list[Mapping[str, Any]] = []
    for event in raw_events:
        if not isinstance(event, Mapping) or not isinstance(event.get("name"), str):
            raise TelemetryIncomplete("a span event is malformed")
        attrs = event.get("attributes")
        if not isinstance(attrs, Mapping):
            raise TelemetryIncomplete("span event attributes are missing")
        events.append(event)
    return events


def _event_attrs(event: Mapping[str, Any]) -> Mapping[str, Any]:
    return _mapping(event.get("attributes"))


_CONTENT_BLOCK_KEYS = frozenset({"text", "toolUse", "toolResult", "image", "document", "guardContent", "video"})
_EVENT_TIME_KEYS = frozenset({"timestamp", "timeUnixNano", "timeUnixNanos", "time_unix_nano"})
_CLOUDWATCH_ATTRIBUTE_PREFIXES = ("aws.",)
_CLOUDWATCH_ATTRIBUTE_NAMES = frozenset({"PlatformType", "telemetry.extended", "gen_ai.provider.name"})


def _normalize_payload_value(value: Any) -> Any:
    value = _native_value(value)
    if isinstance(value, Mapping):
        return {key: _normalize_payload_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_normalize_payload_value(item) for item in value]
    return value


def _normalize_content_attribute(value: Any) -> Any:
    value = _native_value(value)
    if isinstance(value, str):
        try:
            decoded = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return value
        if (
            isinstance(decoded, list)
            and decoded
            and all(isinstance(item, Mapping) and bool(_CONTENT_BLOCK_KEYS.intersection(item)) for item in decoded)
        ):
            return _normalize_payload_value(decoded)
        return value
    return _normalize_payload_value(value)


def _project_events(span: Mapping[str, Any]) -> list[dict[str, Any]]:
    projected: list[dict[str, Any]] = []
    for event in _events(span):
        attrs: dict[str, Any] = {}
        for name, value in _event_attrs(event).items():
            if name in _EVENT_TIME_KEYS:
                continue
            if name in {"content", "message"}:
                attrs[name] = _normalize_content_attribute(value)
            else:
                attrs[name] = _normalize_payload_value(value)
        projected.append({"name": event["name"], "attributes": attrs})
    return projected


def _events_match(expected: Any, actual: Any) -> bool:
    if not isinstance(expected, list) or not isinstance(actual, list) or len(expected) != len(actual):
        return False
    for original, observed in zip(expected, actual):
        if not isinstance(original, Mapping) or not isinstance(observed, Mapping):
            return False
        if original.get("name") != observed.get("name"):
            return False
        original_attrs, observed_attrs = original.get("attributes"), observed.get("attributes")
        if not isinstance(original_attrs, Mapping) or not isinstance(observed_attrs, Mapping):
            return False
        if not _json_equivalent(original_attrs, observed_attrs):
            return False
    return True


def _span_attributes_match(expected: Mapping[str, Any], actual: Mapping[str, Any]) -> bool:
    normalized_expected = {key: _normalize_payload_value(value) for key, value in expected.items()}
    normalized_actual = {key: _normalize_payload_value(value) for key, value in actual.items()}
    for key, value in normalized_expected.items():
        if key not in normalized_actual or not _json_equivalent(value, normalized_actual[key]):
            return False
    for key in normalized_actual.keys() - normalized_expected.keys():
        if key not in _CLOUDWATCH_ATTRIBUTE_NAMES and not key.startswith(_CLOUDWATCH_ATTRIBUTE_PREFIXES):
            return False
    return True


def _time_ns(span: Mapping[str, Any], prefix: str) -> int | None:
    value = _native_value(span.get(f"{prefix}TimeUnixNano"))
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, str) and re.fullmatch(r"[0-9]+", value):
        return int(value)
    return None


def _span_roster_mismatch(
    verified_spans: Sequence[Mapping[str, Any]],
    cloud_spans: Sequence[Mapping[str, Any]],
) -> str | None:
    """Bind CloudWatch to the exact locally saved Strands spans by identity and content."""

    try:
        local_by_id: dict[str, Mapping[str, Any]] = {}
        cloud_by_id: dict[str, Mapping[str, Any]] = {}
        for target, source, label in (
            (local_by_id, verified_spans, "saved"),
            (cloud_by_id, cloud_spans, "CloudWatch"),
        ):
            for raw in source:
                span = _normalize_span(raw)
                span_id = span.get("spanId")
                if not isinstance(span_id, str) or not span_id or span_id in target:
                    return f"{label} span IDs are missing or duplicated"
                target[span_id] = span
        if set(local_by_id) != set(cloud_by_id):
            return "CloudWatch span roster differs from the authenticated saved trace"
        for span_id, local in local_by_id.items():
            cloud = cloud_by_id[span_id]
            if local.get("traceId") != cloud.get("traceId"):
                return "CloudWatch trace IDs differ from the authenticated saved trace"
            if local.get("name") != cloud.get("name"):
                return "CloudWatch span names differ from the authenticated saved trace"
            if local.get("parentSpanId") != cloud.get("parentSpanId"):
                return "CloudWatch parent links differ from the authenticated saved trace"
            local_start, cloud_start = _time_ns(local, "start"), _time_ns(cloud, "start")
            local_end, cloud_end = _time_ns(local, "end"), _time_ns(cloud, "end")
            if None in (local_start, cloud_start, local_end, cloud_end):
                return "CloudWatch or saved span timestamps are incomplete"
            if local_start != cloud_start or local_end != cloud_end:
                return "CloudWatch span timestamps differ from the authenticated saved trace"
            if not _span_attributes_match(_attributes(local), _attributes(cloud)):
                return "CloudWatch span attributes differ from the authenticated saved trace"
            local_events = _project_events(local)
            cloud_events = _project_events(cloud)
            if len(local_events) != len(cloud_events):
                return "CloudWatch event roster differs from the authenticated saved trace"
            for expected_event, actual_event in zip(local_events, cloud_events):
                if expected_event["name"] != actual_event["name"] or not _json_equivalent(
                    expected_event["attributes"], actual_event["attributes"]
                ):
                    return "CloudWatch event payloads differ from the authenticated saved trace"
        return None
    except (KeyError, TypeError, ValueError, TelemetryIncomplete):
        return "saved or CloudWatch spans could not be normalized for comparison"


def _event_matches(span: Mapping[str, Any], operation: str) -> bool:
    return _attr(span, "gen_ai.operation.name") == operation


def _named_events(span: Mapping[str, Any], name: str) -> list[Mapping[str, Any]]:
    return [event for event in _events(span) if event.get("name") == name]


def _one_event(span: Mapping[str, Any], name: str) -> Mapping[str, Any]:
    matches = _named_events(span, name)
    if len(matches) != 1:
        raise TelemetryIncomplete(f"span must contain exactly one {name} event")
    return matches[0]


def _text_from_value(value: Any) -> str:
    value = _native_value(value)
    if isinstance(value, str):
        # Native Strands events encode content blocks as JSON in a string.
        try:
            decoded = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return value
        if isinstance(decoded, list) and decoded and all(isinstance(item, Mapping) for item in decoded):
            texts = [item.get("text") for item in decoded]
            if all(isinstance(text, str) for text in texts):
                return "".join(texts)
        if isinstance(decoded, Mapping) and isinstance(decoded.get("text"), str):
            return decoded["text"]
        return value
    if isinstance(value, list) and value and all(isinstance(item, Mapping) for item in value):
        texts = [item.get("text") for item in value]
        if all(isinstance(text, str) for text in texts):
            return "".join(texts)
    if isinstance(value, Mapping) and isinstance(value.get("text"), str):
        return value["text"]
    raise TelemetryIncomplete("event content is not text")


def _event_text(span: Mapping[str, Any], name: str, attribute: str) -> str:
    event = _one_event(span, name)
    value = _native_value(_event_attrs(event).get(attribute))
    if value is None:
        raise TelemetryIncomplete(f"{name} content is missing")
    return _text_from_value(value)


def _event_texts(span: Mapping[str, Any], name: str, attribute: str) -> list[str]:
    matches = _named_events(span, name)
    if not matches:
        raise TelemetryIncomplete(f"span must contain at least one {name} event")
    texts: list[str] = []
    for event in matches:
        value = _native_value(_event_attrs(event).get(attribute))
        if value is None:
            raise TelemetryIncomplete(f"{name} content is missing")
        texts.append(_text_from_value(value))
    return texts


def _json_payload(text: str, label: str) -> Any:
    try:
        return json.loads(text, parse_constant=lambda token: (_ for _ in ()).throw(ValueError(token)))
    except (json.JSONDecodeError, ValueError) as exc:
        raise TelemetryIncomplete(f"{label} is not complete JSON") from exc


def _payload_from_event(span: Mapping[str, Any], name: str) -> Any:
    text = _event_text(span, name, "message" if name == "gen_ai.choice" else "content")
    return _json_payload(text, f"{name} payload")


def _json_equivalent(left: Any, right: Any) -> bool:
    try:
        return _json_bytes(left) == _json_bytes(right)
    except (TypeError, ValueError):
        return False


def _session_task(root: Mapping[str, Any]) -> Mapping[str, Any]:
    event = _one_event(root, "gen_ai.user.message")
    text = _text_from_value(_native_value(_event_attrs(event).get("content")))
    task = _json_payload(text, "root task")
    if not isinstance(task, Mapping):
        raise TelemetryIncomplete("root task is not an object")
    return task


def _normalize_span(raw_span: Any) -> Mapping[str, Any]:
    """Accept CloudWatch spans or OpenTelemetry SDK ``to_json`` documents."""

    sdk_span = None
    if not isinstance(raw_span, Mapping):
        if hasattr(raw_span, "to_json") and callable(raw_span.to_json):
            sdk_span = raw_span
            raw_span = raw_span.to_json()
        if isinstance(raw_span, str):
            try:
                raw_span = json.loads(raw_span)
            except json.JSONDecodeError as exc:
                raise TelemetryIncomplete("an ended OpenTelemetry span is not valid JSON") from exc
    if not isinstance(raw_span, Mapping):
        raise TelemetryIncomplete("session contains a malformed span")
    span = dict(raw_span)
    # ReadableSpan.to_json() omits the exact timestamps exposed by the SDK
    # object. Preserve those native nanoseconds so the local projection can
    # identify the final assistant span without guessing from list order.
    if sdk_span is not None:
        for sdk_name, native_name in (
            ("start_time", "startTimeUnixNano"),
            ("end_time", "endTimeUnixNano"),
        ):
            timestamp = getattr(sdk_span, sdk_name, None)
            if native_name not in span and isinstance(timestamp, int) and not isinstance(timestamp, bool):
                span[native_name] = timestamp
    if "events" not in span:
        span["events"] = []
    context = _mapping(span.get("context"))

    def _hex_id(value: Any, label: str) -> str | None:
        if not isinstance(value, str):
            return None
        normalized = value[2:] if value.startswith("0x") else value
        if not normalized or any(char not in "0123456789abcdefABCDEF" for char in normalized):
            raise TelemetryIncomplete(f"{label} is malformed")
        return normalized.lower()

    if not isinstance(span.get("traceId"), str):
        span["traceId"] = _hex_id(context.get("trace_id"), "trace ID")
    if not isinstance(span.get("spanId"), str):
        span["spanId"] = _hex_id(context.get("span_id"), "span ID")
    if not isinstance(span.get("parentSpanId"), str) and span.get("parent_id") is not None:
        span["parentSpanId"] = _hex_id(span.get("parent_id"), "parent span ID")
    if not isinstance(span.get("scope"), Mapping):
        scope = _mapping(span.get("instrumentation_scope"))
        if isinstance(scope.get("name"), str):
            span["scope"] = {"name": scope["name"]}
    return span


def _normalized_session_spans(
    spans: Sequence[Mapping[str, Any]],
    *,
    expected_session_id: str | None = None,
) -> tuple[list[Mapping[str, Any]], str, str]:
    if not isinstance(spans, Sequence) or isinstance(spans, (str, bytes)) or not spans:
        raise TelemetryIncomplete("session spans are empty")
    normalized: list[Mapping[str, Any]] = []
    ids: set[str] = set()
    trace_ids: set[str] = set()
    session_ids: set[str] = set()
    for raw_span in spans:
        span = _normalize_span(raw_span)
        span_id = span.get("spanId")
        trace_id = span.get("traceId")
        session_id = _attr(span, "session.id")
        if not isinstance(span_id, str) or not span_id:
            raise TelemetryIncomplete("session span ID is missing")
        if not isinstance(trace_id, str) or not trace_id:
            raise TelemetryIncomplete("session span trace ID is missing")
        if not isinstance(session_id, str) or not session_id:
            raise TelemetryIncomplete("session span session ID is missing")
        if expected_session_id is not None and session_id != expected_session_id:
            raise TelemetryIncomplete("interrupted span belongs to another session")
        if span_id in ids:
            raise TelemetryIncomplete("session span IDs are not unique")
        ids.add(span_id)
        trace_ids.add(trace_id)
        session_ids.add(session_id)
        normalized.append(span)
    if len(trace_ids) != 1 or len(session_ids) != 1:
        raise TelemetryIncomplete("session spans do not share one trace and session")
    return normalized, next(iter(trace_ids)), next(iter(session_ids))


def _model_call(span: Mapping[str, Any]) -> dict[str, Any]:
    span_id = span.get("spanId")
    if not isinstance(span_id, str) or not span_id:
        raise TelemetryIncomplete("model span ID is missing")
    inputs = _event_texts(span, "gen_ai.user.message", "content")
    model_call = {
        "spanId": span_id,
        # Keep the existing concise string for normal requests, while an array
        # gives repeated native input events an unambiguous, lossless form.
        "input": inputs[0] if len(inputs) == 1 else _json_bytes(inputs).decode("utf-8"),
        "output": _event_text(span, "gen_ai.choice", "message"),
        "events": _project_events(span),
    }
    fingerprints: dict[int, str] = {}
    for name, value in _attributes(span).items():
        match = re.fullmatch(r"incident\.model_request\.([0-9]+)\.sha256", str(name))
        if match is None:
            continue
        request_ordinal = int(match.group(1))
        request_sha256 = _native_value(value)
        if request_ordinal <= 0 or not isinstance(request_sha256, str):
            raise TelemetryIncomplete("native model request fingerprint is missing or malformed")
        if re.fullmatch(r"[0-9a-f]{64}", request_sha256) is None or request_ordinal in fingerprints:
            raise TelemetryIncomplete("native model request fingerprint is missing or malformed")
        fingerprints[request_ordinal] = request_sha256
    if not fingerprints:
        return model_call
    model_call["requestFingerprints"] = [
        {"ordinal": ordinal, "sha256": fingerprints[ordinal]}
        for ordinal in sorted(fingerprints)
    ]
    return model_call


def _assistant_report(model_spans: Sequence[Mapping[str, Any]]) -> tuple[str, dict[str, Any]]:
    """Read a schema-valid report from the final assistant chat response."""

    ended = [(_time_ns(span, "end"), span) for span in model_spans]
    if any(timestamp is None for timestamp, _span in ended):
        raise TelemetryIncomplete("assistant report span has no exact end timestamp")
    latest = max(timestamp for timestamp, _span in ended if timestamp is not None)
    final_spans = [span for timestamp, span in ended if timestamp == latest]
    if len(final_spans) != 1:
        raise TelemetryIncomplete("final assistant report span is ambiguous")
    final_span = final_spans[0]
    final_id = final_span.get("spanId")
    if not isinstance(final_id, str) or not final_id:
        raise TelemetryIncomplete("final assistant report span ID is missing")
    try:
        choice = _event_attrs(_one_event(final_span, "gen_ai.choice"))
        payload = _native_value(choice.get("message"))
        if isinstance(payload, str):
            payload = _json_payload(payload, "final assistant response")
        if isinstance(payload, list):
            # Strands validates only the assistant's concatenated text blocks.
            # Keep reasoning and other blocks in the full matched native events.
            report_text = "".join(
                block["text"] for block in payload
                if isinstance(block, Mapping) and isinstance(block.get("text"), str)
            )
            payload = _json_payload(report_text, "final assistant report")
        if not isinstance(payload, Mapping):
            raise TelemetryIncomplete("final assistant output is not a report object")
        from investigation import InvestigationReport

        report = InvestigationReport.model_validate(payload).model_dump(mode="json")
    except TelemetryIncomplete:
        raise
    except Exception as exc:
        raise TelemetryIncomplete("final assistant output does not satisfy report schema 2") from exc
    if not _json_equivalent(report, payload):
        raise TelemetryIncomplete("final assistant output is not a canonical report")
    return final_id, dict(report)


def _tool_payload(span: Mapping[str, Any]) -> dict[str, Any]:
    span_id = span.get("spanId")
    tool_name = _attr(span, "gen_ai.tool.name")
    call_id = _attr(span, "gen_ai.tool.call.id")
    status = _attr(span, "gen_ai.tool.status")
    if not isinstance(span_id, str) or not span_id:
        raise TelemetryIncomplete("tool span ID is missing")
    if not isinstance(tool_name, str) or not tool_name:
        raise TelemetryIncomplete("tool name is missing")
    if not isinstance(call_id, str) or not call_id:
        raise TelemetryIncomplete("tool call ID is missing")
    if status not in {"success", "error"}:
        raise TelemetryIncomplete("tool outcome is missing or unsupported")

    input_event = _one_event(span, "gen_ai.tool.message")
    output_event = _one_event(span, "gen_ai.choice")
    input_attrs = _event_attrs(input_event)
    output_attrs = _event_attrs(output_event)
    if _native_value(input_attrs.get("role")) != "tool":
        raise TelemetryIncomplete("tool input event has the wrong role")
    if _native_value(input_attrs.get("id")) != call_id or _native_value(output_attrs.get("id")) != call_id:
        raise TelemetryIncomplete("tool event IDs do not match the span call ID")
    arguments = _json_payload(
        _text_from_value(_native_value(input_attrs.get("content"))),
        "tool arguments",
    )
    result_text = _text_from_value(_native_value(output_attrs.get("message")))
    try:
        result = _json_payload(result_text, "tool result")
    except TelemetryIncomplete:
        if tool_name == _REPORT_TOOL and status == "success" and result_text.strip():
            # Strands emits an acknowledgment for the structured-output tool;
            # the actual report is its arguments, checked separately.
            result = {"acknowledgment": result_text}
        else:
            # Strands emits a plain error string for a rejected/raised tool
            # call. Preserve it, but don't reinterpret malformed JSON as a
            # complete error payload.
            if status != "error" or result_text.lstrip().startswith(("{", "[")):
                raise
            result = {"error": result_text}
    # A failed native tool call can retain the model's raw JSON request even
    # when the request is not an object (for example, a list rejected by the
    # tool schema).  Successful tools still need object arguments so their
    # recorded result can be joined to the reviewed tool contract.
    if status != "error" and not isinstance(arguments, Mapping):
        raise TelemetryIncomplete("tool arguments are not an object")
    if not isinstance(result, Mapping):
        raise TelemetryIncomplete("tool result is not an object")
    return {
        "spanId": span_id,
        "callId": call_id,
        "tool": tool_name,
        "arguments": arguments,
        "status": status,
        "result": dict(result),
    }


def execution_content(spans: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Project complete native spans into the execution ledger's content shape.

    This helper parses only observed ended spans.  It does not fill missing
    values from local model/tool records.  Scoring separately re-runs these
    checks against the CloudWatch result and the saved ledger.
    """

    normalized, _trace_id, _session_id = _normalized_session_spans(spans)

    roots = [span for span in normalized if _event_matches(span, "invoke_agent")]
    if len(roots) != 1:
        raise TelemetryIncomplete("session must contain one root agent span")
    root = roots[0]
    root_id = root["spanId"]
    model_spans = [span for span in normalized if _event_matches(span, "chat")]
    tool_spans = [span for span in normalized if _event_matches(span, "execute_tool")]
    if not model_spans:
        raise TelemetryIncomplete("session has no model spans")

    calls = [_model_call(span) for span in model_spans]
    tools = [_tool_payload(span) for span in tool_spans]
    report_tools = [item for item in tools if item["tool"] == _REPORT_TOOL]
    if len(report_tools) > 1:
        raise TelemetryIncomplete("session contains duplicate investigation report tools")
    if report_tools:
        report_call = report_tools[0]
        if report_call["status"] != "success":
            raise TelemetryIncomplete("investigation report tool did not succeed")
        report_span_id, report = report_call["spanId"], report_call["arguments"]
        report_source = "report_tool"
    else:
        report_span_id, report = _assistant_report(model_spans)
        report_source = "assistant_chat"
    return {
        "agentSpanId": root_id,
        "modelCalls": calls,
        "toolCalls": [item for item in tools if item["tool"] != _REPORT_TOOL],
        "reportSpanId": report_span_id,
        "report": report,
        "reportSource": report_source,
    }


def interrupted_execution_content(
    spans: Sequence[Mapping[str, Any]],
    *,
    expected_session_id: str | None = None,
) -> dict[str, Any]:
    """Project independently ended native calls for an interrupted run.

    Unlike :func:`execution_content`, this deliberately omits an incomplete
    model call rather than fabricating its output or rejecting otherwise
    complete tool spans.  The raw span archive remains the authoritative
    record; this projection is only the truthful local ledger available before
    a completed report exists.
    """

    normalized, trace_id, _session_id = _normalized_session_spans(
        spans,
        expected_session_id=expected_session_id,
    )

    roots = [span for span in normalized if _event_matches(span, "invoke_agent")]
    if len(roots) != 1:
        raise TelemetryIncomplete("interrupted session must contain one root agent span")
    root_id = roots[0]["spanId"]
    model_spans = [span for span in normalized if _event_matches(span, "chat")]
    tool_spans = [span for span in normalized if _event_matches(span, "execute_tool")]
    model_calls: list[dict[str, Any]] = []
    for span in model_spans:
        try:
            model_calls.append(_model_call(span))
        except TelemetryIncomplete:
            # A request that failed before a choice was emitted has no output
            # to record, but must not hide other independently ended calls.
            continue
    tool_calls: list[dict[str, Any]] = []
    report_span_id: str | None = None
    report_source: str | None = None
    for span in tool_spans:
        try:
            tool = _tool_payload(span)
        except TelemetryIncomplete:
            continue
        if tool["tool"] == _REPORT_TOOL:
            if tool["status"] == "success" and report_span_id is None:
                report_span_id = tool["spanId"]
                report_source = "report_tool"
            continue
        tool_calls.append(tool)
    evidence_tool_count = sum(
        _attr(span, "gen_ai.tool.name") != _REPORT_TOOL
        for span in tool_spans
    )
    return {
        "agentSpanId": root_id,
        "modelCalls": model_calls,
        "toolCalls": tool_calls,
        "reportSpanId": report_span_id,
        "reportSource": report_source,
        "modelSpanCount": len(model_spans),
        "evidenceToolCallCount": evidence_tool_count,
        "traceId": trace_id,
    }


def _timestamp_seconds(value: Any, label: str) -> float:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        if not math.isfinite(float(value)):
            raise ValueError(f"{label} must be finite")
        return float(value)
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            raise ValueError(f"{label} must not be empty")
        try:
            parsed = datetime.fromisoformat(text[:-1] + "+00:00" if text.endswith("Z") else text)
        except ValueError as exc:
            raise ValueError(f"{label} must be an ISO timestamp") from exc
    else:
        raise ValueError(f"{label} must be an ISO timestamp or epoch value")
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{label} must include a timezone")
    return parsed.astimezone(timezone.utc).timestamp()


def _row_field(row: Sequence[Mapping[str, Any]], field: str) -> str | None:
    values = [item.get("value") for item in row if item.get("field") == field]
    if len(values) != 1 or not isinstance(values[0], str):
        return None
    return values[0]


class CloudWatchSession:
    """Read one bounded native session query from a CloudWatch log group."""

    def __init__(
        self,
        logs_client: Any,
        log_group: str,
        *,
        started_at: Any,
        finished_at: Any,
    ) -> None:
        if not isinstance(log_group, str) or not log_group.strip():
            raise ValueError("log_group must be a non-empty string")
        start = _timestamp_seconds(started_at, "started_at")
        finish = _timestamp_seconds(finished_at, "finished_at")
        if finish <= start:
            raise ValueError("finished_at must be later than started_at")
        if finish - start > _MAX_QUERY_SECONDS:
            raise ValueError("CloudWatch session query window exceeds six hours")
        self.logs_client = logs_client
        self.log_group = log_group
        self.start_time = math.floor(start)
        self.end_time = math.ceil(finish)
        if self.end_time <= self.start_time:
            self.end_time = self.start_time + 1
        self.max_query_timeout_seconds = _CLOUDWATCH_QUERY_TIMEOUT_SECONDS
        self.timeout_seconds = self.max_query_timeout_seconds

    def __call__(self, session_id: str, trace_id: str) -> list[dict[str, Any]]:
        if not isinstance(session_id, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,256}", session_id):
            raise ValueError("session_id must use only letters, digits, dot, underscore, colon or hyphen")
        if not isinstance(trace_id, str) or not re.fullmatch(r"[0-9a-fA-F]{32}", trace_id):
            raise ValueError("trace_id must be a 32-character hexadecimal OTel trace ID")
        session_pattern = session_id.replace(".", r"\.")
        timeout_value = float(self.timeout_seconds)
        if not math.isfinite(timeout_value) or timeout_value < 0:
            raise ValueError("CloudWatch query timeout must be finite and non-negative")
        bounded_timeout = min(timeout_value, self.max_query_timeout_seconds)
        deadline = time.monotonic() + bounded_timeout
        response = self.logs_client.start_query(
            logGroupName=self.log_group,
            startTime=self.start_time,
            endTime=self.end_time,
            queryString=(
                "fields @message | filter @message like /strands\\.telemetry\\.tracer/ "
                f'and @message like /"session.id"\\s*:\\s*"{session_pattern}"/ '
                f'and @message like /"traceId"\\s*:\\s*"{trace_id}"/ '
                "| sort @timestamp asc | limit 10000"
            ),
            limit=_MAX_QUERY_ROWS,
        )
        query_id = response.get("queryId") if isinstance(response, Mapping) else None
        if not isinstance(query_id, str) or not query_id:
            raise TelemetryIncomplete("CloudWatch did not return a query ID")

        result: Mapping[str, Any] | None = None
        while True:
            try:
                response = self.logs_client.get_query_results(queryId=query_id)
            except Exception as exc:
                try:
                    self.logs_client.stop_query(queryId=query_id)
                except Exception:
                    pass
                raise TelemetryIncomplete(
                    f"CloudWatch query polling failed ({type(exc).__name__})"
                ) from exc
            if not isinstance(response, Mapping):
                try:
                    self.logs_client.stop_query(queryId=query_id)
                except Exception:
                    pass
                raise TelemetryIncomplete("CloudWatch returned a malformed query response")
            status = response.get("status")
            if status == "Complete":
                result = response
                break
            if status in {"Failed", "Cancelled", "Timeout", "Unknown"}:
                raise TelemetryIncomplete(f"CloudWatch query ended with status {status}")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                try:
                    self.logs_client.stop_query(queryId=query_id)
                except Exception:
                    # Preserve the bounded-query timeout as the primary failure.
                    pass
                raise TelemetryIncomplete(
                    f"CloudWatch session query exceeded its {bounded_timeout:g}-second collection deadline"
                )
            time.sleep(min(_CLOUDWATCH_POLL_SECONDS, remaining))

        rows = result.get("results")
        if not isinstance(rows, list):
            raise TelemetryIncomplete("CloudWatch query results are missing")
        statistics = _mapping(result.get("statistics"))
        matched = statistics.get("recordsMatched")
        if len(rows) >= _MAX_QUERY_ROWS or (
            isinstance(matched, (int, float)) and matched > len(rows)
        ):
            raise TelemetryIncomplete("CloudWatch query may have been truncated at its row limit")
        spans: list[dict[str, Any]] = []
        for row in rows:
            if not isinstance(row, list):
                raise TelemetryIncomplete("CloudWatch returned a malformed result row")
            message = _row_field(row, "@message")
            if message is None:
                raise TelemetryIncomplete("CloudWatch result row has no @message")
            try:
                document = json.loads(message, parse_constant=lambda token: (_ for _ in ()).throw(ValueError(token)))
            except (json.JSONDecodeError, ValueError) as exc:
                raise TelemetryIncomplete("CloudWatch @message is not valid JSON") from exc
            if not isinstance(document, Mapping):
                raise TelemetryIncomplete("CloudWatch @message is not a span object")
            spans.append(dict(document))
        return spans


def _identity_mismatch(record: Mapping[str, Any], loaded_case: Mapping[str, Any]) -> str | None:
    if record.get("status") != "complete":
        return "execution is not complete"
    identity = _mapping(record.get("identity"))
    required = (
        "executionId",
        "sessionId",
        "traceId",
        "candidateId",
        "sourceSha256",
        "promptSha256",
        "dependencySha256",
        "modelId",
        "originatingRunId",
        "caseSha256",
        "bundleSha256",
        "referenceTime",
        "reportSha256",
    )
    if any(not isinstance(identity.get(key), str) or not identity[key].strip() for key in required):
        return "execution identity is incomplete"
    for field in ("originatingRunId", "caseSha256", "bundleSha256", "referenceTime"):
        if identity.get(field) != loaded_case.get(field):
            return f"execution {field} does not match the frozen case"
    report = record.get("report")
    if not isinstance(report, Mapping):
        return "execution report is missing"
    try:
        report_digest = _sha256(report)
    except (TypeError, ValueError):
        return "execution report cannot be digested"
    if report_digest != identity.get("reportSha256"):
        return "execution report digest does not match its identity"
    ledger = _mapping(record.get("ledger"))
    if not isinstance(ledger.get("agentSpanId"), str) or not ledger.get("agentSpanId"):
        return "execution ledger root span is missing"
    if not isinstance(ledger.get("reportSpanId"), str) or not ledger.get("reportSpanId"):
        return "execution ledger report span is missing"
    if not isinstance(ledger.get("modelCalls"), list) or not ledger["modelCalls"]:
        return "execution model-call ledger is missing"
    if not isinstance(ledger.get("toolCalls"), list):
        return "execution tool-call ledger is missing"
    return None


def _validate_session(
    spans: Sequence[Mapping[str, Any]],
    record: Mapping[str, Any],
    loaded_case: Mapping[str, Any],
    *,
    require_scope: bool = True,
) -> tuple[dict[str, Any], str | None]:
    """Return normalized evidence content and a safe reason when it is unready."""

    try:
        if not isinstance(spans, Sequence) or isinstance(spans, (str, bytes)) or not spans:
            raise TelemetryIncomplete("CloudWatch returned no session spans")
        identity = record["identity"]
        session_id, trace_id = identity["sessionId"], identity["traceId"]
        span_ids: set[str] = set()
        for span in spans:
            if not isinstance(span, Mapping):
                raise TelemetryIncomplete("CloudWatch session contains a malformed span")
            span_id = span.get("spanId")
            if not isinstance(span_id, str) or not span_id:
                raise TelemetryIncomplete("CloudWatch span ID is missing")
            if span_id in span_ids:
                raise TelemetryIncomplete("CloudWatch returned duplicate span IDs")
            span_ids.add(span_id)
            if span.get("traceId") != trace_id:
                raise TelemetryIncomplete("CloudWatch span belongs to another trace")
            if _attr(span, "session.id") != session_id:
                raise TelemetryIncomplete("CloudWatch span belongs to another session")
            if require_scope:
                scope = _mapping(span.get("scope"))
                if scope.get("name") != "strands.telemetry.tracer":
                    raise TelemetryIncomplete("CloudWatch span is outside the native Strands scope")

        content = execution_content(spans)
        if content["agentSpanId"] != record["ledger"]["agentSpanId"]:
            raise TelemetryIncomplete("CloudWatch root span does not match the execution ledger")
        if content["reportSpanId"] != record["ledger"]["reportSpanId"]:
            raise TelemetryIncomplete("CloudWatch report span does not match the execution ledger")
        roots = [span for span in spans if span.get("spanId") == content["agentSpanId"]]
        root = roots[0]
        if root.get("parentSpanId") not in (None, ""):
            raise TelemetryIncomplete("CloudWatch agent span is not a root span")
        expected_root_attrs = {
            "incident.execution_id": identity["executionId"],
            "incident.originating_run_id": loaded_case["originatingRunId"],
            "incident.case_sha256": identity["caseSha256"],
            "incident.bundle_sha256": identity["bundleSha256"],
            "incident.reference_time": identity["referenceTime"],
            "incident.candidate_id": identity["candidateId"],
            "incident.source_sha256": identity["sourceSha256"],
            "incident.prompt_sha256": identity["promptSha256"],
            "incident.dependency_sha256": identity["dependencySha256"],
        }
        for key, expected in expected_root_attrs.items():
            if _attr(root, key) != expected:
                raise TelemetryIncomplete("CloudWatch root input identity does not match the execution")
        if not _json_equivalent(_session_task(root), loaded_case["task"]):
            raise TelemetryIncomplete("CloudWatch root task differs from the reviewed public task")

        expected_models = record["ledger"]["modelCalls"]
        actual_models = content["modelCalls"]
        if not isinstance(expected_models, list) or len(actual_models) != len(expected_models):
            raise TelemetryIncomplete("CloudWatch model-call count does not match the execution ledger")
        by_model_id: dict[str, Mapping[str, Any]] = {}
        for model in expected_models:
            if not isinstance(model, Mapping) or not isinstance(model.get("spanId"), str):
                raise TelemetryIncomplete("execution model-call ledger is malformed")
            span_id = model["spanId"]
            if span_id in by_model_id:
                raise TelemetryIncomplete("execution model-call IDs are not unique")
            by_model_id[span_id] = model
        actual_by_model_id = {model["spanId"]: model for model in actual_models}
        if set(actual_by_model_id) != set(by_model_id):
            raise TelemetryIncomplete("CloudWatch model span IDs do not match the execution ledger")
        for model_span in (span for span in spans if _event_matches(span, "chat")):
            model_id = _attr(model_span, "gen_ai.request.model")
            if model_id != identity["modelId"]:
                raise TelemetryIncomplete("CloudWatch model ID differs from the execution identity")
        for span_id, expected in by_model_id.items():
            actual = actual_by_model_id[span_id]
            if actual.get("input") != expected.get("input") or actual.get("output") != expected.get("output"):
                raise TelemetryIncomplete("CloudWatch model content differs from the execution ledger")
            if actual.get("requestFingerprints") != expected.get("requestFingerprints"):
                raise TelemetryIncomplete("CloudWatch model request fingerprint differs from the execution ledger")
            if not _events_match(expected.get("events"), actual.get("events")):
                raise TelemetryIncomplete("CloudWatch model request context differs from the execution ledger")

        expected_tools = record["ledger"]["toolCalls"]
        if not isinstance(expected_tools, list):
            raise TelemetryIncomplete("execution tool-call ledger is malformed")
        expected_by_call: dict[str, Mapping[str, Any]] = {}
        for tool in expected_tools:
            if not isinstance(tool, Mapping) or not isinstance(tool.get("callId"), str):
                raise TelemetryIncomplete("execution tool-call ledger is malformed")
            if tool.get("tool") == _REPORT_TOOL:
                # The report has a separate ID field in this execution contract.
                if tool.get("spanId") != record["ledger"]["reportSpanId"]:
                    raise TelemetryIncomplete("execution report call conflicts with its report span ID")
                continue
            call_id = tool["callId"]
            if call_id in expected_by_call:
                raise TelemetryIncomplete("execution tool call IDs are not unique")
            expected_by_call[call_id] = tool
        actual_tools = content["toolCalls"]
        actual_by_call: dict[str, Mapping[str, Any]] = {}
        for tool in actual_tools:
            call_id = tool["callId"]
            if call_id in actual_by_call:
                raise TelemetryIncomplete("CloudWatch tool call IDs are not unique")
            actual_by_call[call_id] = tool
        if set(actual_by_call) != set(expected_by_call):
            raise TelemetryIncomplete("CloudWatch tool call IDs do not match the execution ledger")
        for call_id, expected in expected_by_call.items():
            actual = actual_by_call[call_id]
            if actual.get("spanId") != expected.get("spanId"):
                raise TelemetryIncomplete("CloudWatch tool span ID does not match the execution ledger")
            if actual.get("tool") != expected.get("tool"):
                raise TelemetryIncomplete("CloudWatch tool name does not match the execution ledger")
            if actual.get("status") != expected.get("status"):
                raise TelemetryIncomplete("CloudWatch tool status does not match the execution ledger")
            if not _json_equivalent(actual.get("arguments"), expected.get("arguments")):
                raise TelemetryIncomplete("CloudWatch tool arguments differ from the execution ledger")
            if not _json_equivalent(actual.get("result"), expected.get("result")):
                raise TelemetryIncomplete("CloudWatch tool result differs from the execution ledger")

        report_tools = [
            span for span in spans
            if _event_matches(span, "execute_tool") and _attr(span, "gen_ai.tool.name") == _REPORT_TOOL
        ]
        if content["reportSource"] == "report_tool":
            if len(report_tools) != 1:
                raise TelemetryIncomplete("CloudWatch report tool span is missing or duplicated")
            report_tool = _tool_payload(report_tools[0])
            if report_tool["spanId"] != record["ledger"]["reportSpanId"] or report_tool["status"] != "success":
                raise TelemetryIncomplete("CloudWatch report tool did not match the successful execution")
            acknowledged = (
                report_tool["result"].get("status") == "success"
                or bool(report_tool["result"].get("acknowledgment", "").strip())
            )
            if not acknowledged:
                raise TelemetryIncomplete("CloudWatch report acknowledgement is unsuccessful")
        elif content["reportSource"] == "assistant_chat":
            if report_tools:
                raise TelemetryIncomplete("CloudWatch report source is ambiguous")
            final_chat = next(
                (span for span in spans if span.get("spanId") == record["ledger"]["reportSpanId"]),
                None,
            )
            if final_chat is None or not _event_matches(final_chat, "chat"):
                raise TelemetryIncomplete("CloudWatch assistant report span does not match the execution")
        else:
            raise TelemetryIncomplete("CloudWatch report source is missing or unsupported")
        if not _json_equivalent(content["report"], record["report"]):
            raise TelemetryIncomplete("CloudWatch report differs from the saved report")
        if _sha256(content["report"]) != identity["reportSha256"]:
            raise TelemetryIncomplete("CloudWatch report digest differs from the execution identity")
        return {"content": content, "sessionSpans": [dict(span) for span in spans]}, None
    except (KeyError, TypeError, ValueError) as exc:
        return {}, str(exc) if isinstance(exc, TelemetryIncomplete) else "CloudWatch content could not be validated"


def _blank_semantic(status: str, message: str) -> dict[str, Any]:
    return {
        "status": status,
        "findings": {
            name: {"status": status, "verdict": None, "explanation": None, "errorMessage": message}
            for name in _DIMENSIONS
        },
        "rawResponse": None,
        "tokenUsage": None,
    }


def _score_result(
    *,
    status: str,
    execution_id: str | None,
    attempt_id: str,
    identity: Mapping[str, Any] | None = None,
    semantic: Mapping[str, Any] | None = None,
    deterministic: Mapping[str, Any] | None = None,
    telemetry: Mapping[str, Any] | None = None,
    assertions: Sequence[str] | None = None,
    diagnostic: str | None = None,
    requested_wait_seconds: float = 0,
    collection_seconds: float = 0,
    scoring_seconds: float = 0,
    evidence_sha256: str | None = None,
    assertions_sha256: str | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "status": status,
        "executionId": execution_id,
        "scoringAttemptId": attempt_id,
        "identity": dict(identity or {}),
        "semantic": dict(semantic or _blank_semantic("incomplete", "scoring did not run")),
        "deterministic": dict(deterministic or {}),
        "telemetry": dict(telemetry or {"status": "incomplete"}),
        "assertions": list(assertions) if assertions is not None else None,
        "waitSeconds": {
            "requested": requested_wait_seconds,
            "collection": max(0.0, collection_seconds),
        },
        "scoringSeconds": max(0.0, scoring_seconds),
    }
    if evidence_sha256 is not None:
        result["evidenceSha256"] = evidence_sha256
    if assertions_sha256 is not None:
        result["assertionsSha256"] = assertions_sha256
    if diagnostic:
        result["diagnostic"] = diagnostic
    return result


def score_execution(
    record: Mapping[str, Any],
    loaded_case: Mapping[str, Any],
    *,
    fetch_session: Any,
    evaluation_client: Any,
    evaluator_id: str,
    wait_seconds: float,
    verified_spans: Sequence[Mapping[str, Any]] | None = None,
    scoring_attempt_id: str | None = None,
) -> dict[str, Any]:
    """Wait for CloudWatch content matching native spans verified by the loader.

    Production callers pass the native span documents returned by
    ``load_execution`` after its stored-file digest and ledger checks. Direct
    synthetic callers without that source can receive report-only findings,
    but cannot submit session context to Evaluate.
    """

    attempt_id = scoring_attempt_id if isinstance(scoring_attempt_id, str) and scoring_attempt_id.strip() else str(uuid.uuid4())
    execution_id = None
    identity = _mapping(record.get("identity")) if isinstance(record, Mapping) else {}
    if isinstance(identity.get("executionId"), str):
        execution_id = identity["executionId"]
    try:
        wait_value = float(wait_seconds)
        if not math.isfinite(wait_value) or wait_value < 0 or wait_value > _MAX_QUERY_SECONDS:
            raise ValueError("wait_seconds must be between 0 and six hours")
    except (TypeError, ValueError):
        return _score_result(
            status="error", execution_id=execution_id, attempt_id=attempt_id, identity=identity,
            diagnostic="invalid bounded telemetry wait", requested_wait_seconds=0,
        )
    mismatch = _identity_mismatch(record, loaded_case)
    if mismatch is not None:
        return _score_result(
            status="incomplete", execution_id=execution_id, attempt_id=attempt_id, identity=identity,
            diagnostic=mismatch, requested_wait_seconds=wait_value,
        )
    if not isinstance(evaluator_id, str) or not evaluator_id.strip():
        return _score_result(
            status="error", execution_id=execution_id, attempt_id=attempt_id, identity=identity,
            diagnostic="evaluator ID is missing", requested_wait_seconds=wait_value,
        )
    if not callable(fetch_session):
        return _score_result(
            status="error", execution_id=execution_id, attempt_id=attempt_id, identity=identity,
            diagnostic="CloudWatch session fetcher is not callable", requested_wait_seconds=wait_value,
        )

    try:
        from agentcore_evaluation import case_assertions, score_session
        from deterministic_checks import check_captured_report, check_report

        assertions = case_assertions(loaded_case)
        if not isinstance(assertions, list) or not assertions or not all(
            isinstance(item, str) and item.strip() for item in assertions
        ):
            raise ValueError("reviewed case assertions are invalid")
    except (ImportError, AttributeError, TypeError, ValueError) as exc:
        detail = str(exc) if isinstance(exc, ValueError) else type(exc).__name__
        return _score_result(
            status="error", execution_id=execution_id, attempt_id=attempt_id, identity=identity,
            diagnostic=f"reviewed scoring contract is unavailable: {detail}",
            requested_wait_seconds=wait_value,
        )

    deterministic = check_report(record["report"], loaded_case)
    if deterministic.get("findings", {}).get("report_structure", {}).get("verdict") != "pass":
        return _score_result(
            status="incomplete", execution_id=execution_id, attempt_id=attempt_id, identity=identity,
            deterministic=deterministic,
            assertions=assertions, diagnostic="saved report does not satisfy the canonical schema",
            requested_wait_seconds=wait_value,
        )
    if verified_spans is None:
        return _score_result(
            status="incomplete", execution_id=execution_id, attempt_id=attempt_id, identity=identity,
            deterministic=deterministic,
            assertions=assertions,
            diagnostic="authenticated saved native spans are required for CloudWatch scoring",
            requested_wait_seconds=wait_value,
        )

    locally_validated, local_reason = _validate_session(
        verified_spans, record, loaded_case, require_scope=False
    )
    if local_reason is not None:
        return _score_result(
            status="incomplete", execution_id=execution_id, attempt_id=attempt_id, identity=identity,
            deterministic=deterministic,
            assertions=assertions,
            diagnostic=f"saved native spans do not authenticate the execution: {local_reason}",
            requested_wait_seconds=wait_value,
        )
    for recorded_report_source in (
        record.get("reportSource"),
        _mapping(record.get("ledger")).get("reportSource"),
    ):
        if recorded_report_source is not None and recorded_report_source != locally_validated["content"]["reportSource"]:
            return _score_result(
                status="incomplete", execution_id=execution_id, attempt_id=attempt_id, identity=identity,
                deterministic=deterministic,
                assertions=assertions,
                diagnostic="saved report-source marker differs from authenticated native spans",
                requested_wait_seconds=wait_value,
            )
    deterministic = check_captured_report(record["report"], loaded_case, record["ledger"])

    started = time.monotonic()
    deadline = started + wait_value
    last_reason = "CloudWatch has not returned the matching session"
    validated: dict[str, Any] = {}
    while True:
        if isinstance(fetch_session, CloudWatchSession):
            fetch_session.timeout_seconds = min(
                fetch_session.max_query_timeout_seconds,
                max(0.0, deadline - time.monotonic()),
            )
        try:
            spans = fetch_session(identity["sessionId"], identity["traceId"])
        except Exception as exc:
            if isinstance(exc, TelemetryIncomplete):
                last_reason = str(exc)
            else:
                last_reason = f"CloudWatch collection failed ({type(exc).__name__})"
        else:
            validated, reason = _validate_session(spans, record, loaded_case)
            if reason is None:
                if validated["content"]["reportSource"] != locally_validated["content"]["reportSource"]:
                    reason = "CloudWatch report source differs from the authenticated saved trace"
                roster_reason = _span_roster_mismatch(verified_spans, spans)
                if reason is None and roster_reason is not None:
                    reason = roster_reason
                if reason is None:
                    break
            last_reason = reason
        now = time.monotonic()
        remaining = deadline - now
        if wait_value <= 0 or remaining <= 0:
            return _score_result(
                status="incomplete", execution_id=execution_id, attempt_id=attempt_id, identity=identity,
                deterministic=deterministic,
                semantic=_blank_semantic("incomplete", last_reason),
                telemetry={"status": "incomplete", "reason": last_reason},
                assertions=assertions, diagnostic=last_reason, requested_wait_seconds=wait_value,
                collection_seconds=now - started,
            )
        time.sleep(min(_SCORING_POLL_SECONDS, remaining))

    session_spans = validated["sessionSpans"]
    telemetry_digest = _sha256(session_spans)
    collection_seconds = max(0.0, time.monotonic() - started)
    deterministic = check_captured_report(record["report"], loaded_case, record["ledger"])

    scoring_started = time.monotonic()
    try:
        semantic = score_session(
            evaluation_client,
            evaluator_id=evaluator_id,
            session_id=identity["sessionId"],
            trace_id=identity["traceId"],
            session_spans=session_spans,
            assertions=assertions,
        )
    except Exception as exc:
        semantic = _blank_semantic("error", f"AgentCore Evaluate failed ({type(exc).__name__})")
    scoring_seconds = max(0.0, time.monotonic() - scoring_started)
    status = semantic.get("status") if isinstance(semantic, Mapping) else "error"
    if status not in {"complete", "incomplete", "error"}:
        status = "error"
    result = _score_result(
        status=status, execution_id=execution_id, attempt_id=attempt_id, identity=identity,
        semantic=semantic, deterministic=deterministic,
        telemetry={
            "status": "complete",
            "sessionId": identity["sessionId"],
            "traceId": identity["traceId"],
            "sha256": telemetry_digest,
            "spanCount": len(session_spans),
            "sessionSpans": session_spans,
        },
        assertions=assertions, requested_wait_seconds=wait_value,
        collection_seconds=collection_seconds,
        scoring_seconds=scoring_seconds,
        evidence_sha256=telemetry_digest,
        assertions_sha256=_sha256(assertions),
    )
    return result


__all__ = [
    "CloudWatchSession",
    "TelemetryIncomplete",
    "execution_content",
    "interrupted_execution_content",
    "score_execution",
]
