"""Run the shared Strands agent against a private immutable evidence snapshot.

The CLI imports this module before a candidate is selected, so module-level
imports intentionally use only the standard library.  ``run_captured_case``
copies the selected inputs and source bytes first, then loads the copied code
for verification and execution.
"""

from __future__ import annotations

from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
import re
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from threading import Event, Timer
from typing import Any, Iterator, Mapping, Sequence


MODEL_ID = "us.anthropic.claude-sonnet-4-6"
CANDIDATE_ID = "faulty"
RUN_SECONDS = 240
MAX_TOOL_CALLS = 12
TRACE_SCOPE = "strands.telemetry.tracer"
EVALUATION_LOG_GROUP = "/aws/bedrock-agentcore/incident-triage-evaluation"
AWS_ACCOUNT_ID = "027224425948"
TRACE_ENDPOINT = "https://xray.us-east-1.amazonaws.com/v1/traces"
MAX_JSON_BYTES = 8 * 1024 * 1024

AGENT_DIRECTORY = Path(__file__).resolve().parent
SOURCE_FILES = (
    "main.py",
    "investigation.py",
    "evidence.py",
    "prompt.py",
    "captured_evidence.py",
    "reviewed_cases.py",
    "captured_execution.py",
    "evaluation_telemetry.py",
    "deterministic_checks.py",
    "agent-manifest.json",
)
DEPENDENCY_FILES = ("pyproject.toml", "uv.lock")
SNAPSHOT_MODULES = (
    "main",
    "prompt",
    "evidence",
    "investigation",
    "captured_evidence",
    "reviewed_cases",
    "evaluation_telemetry",
    "deterministic_checks",
)


def _json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _named_digest(files: Mapping[str, bytes]) -> str:
    digests = {name: _sha256(raw) for name, raw in sorted(files.items())}
    return _sha256(_json_bytes(digests))


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _decode_json(raw: bytes, label: str) -> Any:
    if len(raw) > MAX_JSON_BYTES:
        raise ValueError(f"{label} exceeds the local input size limit")
    try:
        return json.loads(
            raw.decode("utf-8"),
            parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)),
        )
    except (UnicodeError, json.JSONDecodeError, ValueError) as exc:
        raise ValueError(f"{label} is not valid UTF-8 JSON") from exc


def _read_input(path: str | Path, label: str) -> bytes:
    try:
        raw = Path(path).read_bytes()
    except OSError as exc:
        raise ValueError(f"cannot read {label}") from exc
    if len(raw) > MAX_JSON_BYTES:
        raise ValueError(f"{label} exceeds the local input size limit")
    return raw


def _write_bytes(path: Path, raw: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("xb") as output:
        output.write(raw)
        output.flush()
        os.fsync(output.fileno())
    path.chmod(0o600)


def _write_json_atomic(path: Path, value: Mapping[str, Any]) -> None:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False).encode("utf-8") + b"\n"
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
        temporary.chmod(0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _copy_bytes_tree(root: Path, files: Mapping[str, bytes]) -> None:
    for name, raw in files.items():
        _write_bytes(root / name, raw)


def _read_source_bytes() -> tuple[dict[str, bytes], dict[str, bytes]]:
    source: dict[str, bytes] = {}
    dependencies: dict[str, bytes] = {}
    for name in SOURCE_FILES:
        try:
            source[f"agent/{name}"] = (AGENT_DIRECTORY / name).read_bytes()
        except OSError as exc:
            raise ValueError(f"selected agent source is unavailable: {name}") from exc
    for name in DEPENDENCY_FILES:
        try:
            dependencies[f"agent/{name}"] = (AGENT_DIRECTORY / name).read_bytes()
        except OSError as exc:
            raise ValueError(f"locked dependency input is unavailable: {name}") from exc
    return source, dependencies


def _parse_headers(value: str) -> dict[str, str]:
    headers: dict[str, str] = {}
    for item in value.split(","):
        key, separator, content = item.strip().partition("=")
        if separator and key.strip():
            headers[key.strip().lower()] = content.strip()
    return headers


def _verify_exporter_setup() -> Any:
    """Reject production runs that cannot export the approved CloudWatch trace."""

    required_equal = {
        "AGENT_OBSERVABILITY_ENABLED": "true",
        "AWS_GENAI_CONTENT_EXTRACTION_OPT_OUT": "true",
        "OTEL_PYTHON_DISTRO": "aws_distro",
        "OTEL_PYTHON_CONFIGURATOR": "aws_configurator",
        "AWS_REGION": "us-east-1",
        "AWS_DEFAULT_REGION": "us-east-1",
        "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
        "OTEL_TRACES_EXPORTER": "otlp",
        "OTEL_LOGS_EXPORTER": "none",
        "OTEL_METRICS_EXPORTER": "none",
        "OTEL_TRACES_SAMPLER": "always_on",
    }
    missing = [name for name, expected in required_equal.items() if os.environ.get(name) != expected]
    if os.environ.get("AWS_ACCOUNT_ID") != AWS_ACCOUNT_ID:
        missing.append("AWS_ACCOUNT_ID")
    resource_attributes: dict[str, str] = {}
    for entry in os.environ.get("OTEL_RESOURCE_ATTRIBUTES", "").split(","):
        key, separator, value = entry.strip().partition("=")
        if separator:
            resource_attributes[key.strip()] = value.strip()
    traces_headers = _parse_headers(os.environ.get("OTEL_EXPORTER_OTLP_TRACES_HEADERS", ""))
    if not resource_attributes.get("service.name"):
        missing.append("OTEL_RESOURCE_ATTRIBUTES.service.name")
    if resource_attributes.get("aws.log.group.names") != EVALUATION_LOG_GROUP:
        missing.append("OTEL_RESOURCE_ATTRIBUTES.aws.log.group.names")
    if traces_headers.get("x-aws-log-group") != EVALUATION_LOG_GROUP:
        missing.append("OTEL_EXPORTER_OTLP_TRACES_HEADERS.x-aws-log-group")
    if traces_headers.get("x-aws-log-stream") != "spans":
        missing.append("OTEL_EXPORTER_OTLP_TRACES_HEADERS.x-aws-log-stream")
    trace_endpoint = os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
    generic_endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    if trace_endpoint is not None and trace_endpoint.rstrip("/") != TRACE_ENDPOINT:
        missing.append("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
    if generic_endpoint is not None and generic_endpoint.rstrip("/") not in {
        "https://xray.us-east-1.amazonaws.com",
    }:
        missing.append("OTEL_EXPORTER_OTLP_ENDPOINT")
    if missing:
        raise ValueError("production telemetry exporter setup is incomplete: " + ", ".join(sorted(set(missing))))

    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider

    provider = trace.get_tracer_provider()
    if not isinstance(provider, TracerProvider):
        raise ValueError("production run must start through the locked ADOT opentelemetry-instrument launcher")
    return provider


@contextmanager
def _snapshot_imports(agent_source: Path) -> Iterator[None]:
    """Load runtime dependencies from the captured files, then restore callers."""

    old_modules = {name: sys.modules.pop(name, None) for name in SNAPSHOT_MODULES}
    sys.path.insert(0, str(agent_source))
    try:
        yield
    finally:
        try:
            sys.path.remove(str(agent_source))
        except ValueError:
            pass
        for name in SNAPSHOT_MODULES:
            sys.modules.pop(name, None)
            old = old_modules[name]
            if old is not None:
                sys.modules[name] = old


def _private_directory(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        raise ValueError("output root must be a private directory")
    path.chmod(0o700)
    return path


def run_captured_case(
    case_path: str | Path,
    bundle_path: str | Path,
    output_root: str | Path,
    *,
    model_session: Any = None,
) -> Path:
    """Execute one immutable captured case and return its unique run directory.

    Supplying ``model_session`` injects a scripted Bedrock transport for tests.
    That path never constructs a boto3 session or client and skips the
    production exporter check.  A normal invocation requires the locked ADOT
    launcher, verified before any Bedrock request is constructed.
    """

    provider = None
    case_bytes = _read_input(case_path, "frozen case")
    bundle_bytes = _read_input(bundle_path, "source bundle")
    source_files, dependency_files = _read_source_bytes()

    with tempfile.TemporaryDirectory(prefix="incident-triage-captured-snapshot-") as temporary_name:
        staging = Path(temporary_name)
        agent_source = staging / "source" / "agent"
        _copy_bytes_tree(staging / "source", {**source_files, **dependency_files})
        staged_case = staging / "case.frozen.json"
        staged_bundle = staging / "bundle.json"
        _write_bytes(staged_case, case_bytes)
        _write_bytes(staged_bundle, bundle_bytes)

        runner_path = agent_source / "captured_execution.py"
        module_name = f"_captured_execution_snapshot_{uuid.uuid4().hex}"
        spec = importlib.util.spec_from_file_location(module_name, runner_path)
        if spec is None or spec.loader is None:
            raise ValueError("captured execution snapshot cannot be loaded")
        snapshot_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(snapshot_module)
        return Path(snapshot_module._run_snapshot(
            staging=staging,
            staged_case=staged_case,
            staged_bundle=staged_bundle,
            output_root=Path(output_root),
            source_files=source_files,
            dependency_files=dependency_files,
            model_session=model_session,
            provider=provider,
        ))


class _ToolBudget:
    def __init__(self) -> None:
        self.calls = 0

    def __call__(self) -> None:
        self.calls += 1
        if self.calls > MAX_TOOL_CALLS:
            from investigation import ToolBudgetExceeded

            raise ToolBudgetExceeded("tool call limit reached")


def _span_observer() -> Any:
    """Build a real SDK processor without importing OTel before snapshotting."""

    from opentelemetry.sdk.trace import SpanProcessor

    class SpanObserver(SpanProcessor):
        def __init__(self) -> None:
            self.enabled = True
            self.spans: list[Any] = []

        def on_start(self, span: Any, parent_context: Any = None) -> None:
            return None

        def on_end(self, span: Any) -> None:
            if not self.enabled:
                return
            scope = getattr(span, "instrumentation_scope", None)
            if getattr(scope, "name", None) == TRACE_SCOPE:
                self.spans.append(span)

        def shutdown(self) -> None:
            self.enabled = False

        def force_flush(self, timeout_millis: int = 30_000) -> bool:
            return True

    return SpanObserver()


def _span_attributes(span: Any) -> Mapping[str, Any]:
    if isinstance(span, Mapping):
        values = span.get("attributes")
        if isinstance(values, Mapping) and isinstance(values.get("attributes"), Mapping):
            values = values["attributes"]
        return values if isinstance(values, Mapping) else {}
    values = getattr(span, "attributes", None)
    return values if isinstance(values, Mapping) else {}


def _span_operation(span: Any) -> Any:
    return _span_attributes(span).get("gen_ai.operation.name")


def _event_content(event: Any) -> str:
    attributes = event.get("attributes") if isinstance(event, Mapping) else getattr(event, "attributes", None)
    if not isinstance(attributes, Mapping) or "content" not in attributes:
        raise ValueError("native agent span is missing the public task event")
    value = attributes["content"]
    if not isinstance(value, str):
        raise ValueError("native task event content is not text")
    try:
        blocks = json.loads(value)
    except json.JSONDecodeError:
        return value
    if isinstance(blocks, list) and all(isinstance(item, Mapping) for item in blocks):
        texts = [item.get("text") for item in blocks]
        if all(isinstance(item, str) for item in texts):
            return "".join(texts)
    return value


def _verify_native_identity(
    spans: Sequence[Any],
    projection: Mapping[str, Any],
    *,
    task: Mapping[str, Any],
    identity: Mapping[str, Any],
) -> str:
    roots = [span for span in spans if _span_operation(span) == "invoke_agent"]
    if len(roots) != 1:
        raise ValueError("native trace does not contain one root Strands agent span")
    root = roots[0]
    attributes = _span_attributes(root)
    if isinstance(root, Mapping):
        parent_id = root.get("parentSpanId", root.get("parent_id"))
    else:
        parent_id = getattr(root, "parent", None)
    if parent_id not in (None, "", 0):
        raise ValueError("native Strands invoke_agent span is not the trace root")
    expected_attributes = {
        "session.id": identity["sessionId"],
        "incident.execution_id": identity["executionId"],
        "incident.originating_run_id": identity["originatingRunId"],
        "incident.case_sha256": identity["caseSha256"],
        "incident.bundle_sha256": identity["bundleSha256"],
        "incident.reference_time": identity["referenceTime"],
        "incident.candidate_id": identity["candidateId"],
        "incident.source_sha256": identity["sourceSha256"],
        "incident.prompt_sha256": identity["promptSha256"],
        "incident.dependency_sha256": identity["dependencySha256"],
        "gen_ai.request.model": identity["modelId"],
    }
    for name, expected in expected_attributes.items():
        if attributes.get(name) != expected:
            raise ValueError(f"native agent span identity does not match {name}")

    root_events = root.get("events", ()) if isinstance(root, Mapping) else getattr(root, "events", ())
    task_events = [
        event
        for event in root_events
        if (event.get("name") if isinstance(event, Mapping) else getattr(event, "name", None)) == "gen_ai.user.message"
    ]
    if len(task_events) != 1:
        raise ValueError("native agent span does not contain exactly one task event")
    try:
        actual_task = json.loads(_event_content(task_events[0]))
    except (json.JSONDecodeError, TypeError) as exc:
        raise ValueError("native agent span task is not valid JSON") from exc
    if _json_bytes(actual_task) != _json_bytes(task):
        raise ValueError("native agent span task differs from the frozen public task")

    trace_ids: set[str] = set()
    for span in spans:
        attributes = _span_attributes(span)
        if attributes.get("session.id") != identity["sessionId"]:
            raise ValueError("native Strands span is missing the captured session identity")
        if isinstance(span, Mapping):
            trace_value = span.get("traceId")
            if not isinstance(trace_value, str):
                context = span.get("context")
                trace_value = context.get("trace_id") if isinstance(context, Mapping) else None
            if not isinstance(trace_value, str):
                raise ValueError("native Strands span has an invalid trace identity")
            normalized_trace = trace_value[2:] if trace_value.startswith("0x") else trace_value
            trace_ids.add(normalized_trace.lower())
        else:
            context = span.get_span_context()
            if not context.is_valid:
                raise ValueError("native Strands span has an invalid trace identity")
            trace_ids.add(f"{context.trace_id:032x}")
    if len(trace_ids) != 1:
        raise ValueError("native Strands spans do not share one trace")
    trace_id = next(iter(trace_ids))
    model_spans = [span for span in spans if _span_operation(span) == "chat"]
    if len(model_spans) != len(projection.get("modelCalls", [])):
        raise ValueError("native model spans do not match the local execution ledger")
    for span in model_spans:
        if _span_attributes(span).get("gen_ai.request.model") != identity["modelId"]:
            raise ValueError("native model span used an unexpected model")
    if isinstance(root, Mapping):
        span_value = root.get("spanId")
        if not isinstance(span_value, str):
            context = root.get("context")
            span_value = context.get("span_id") if isinstance(context, Mapping) else None
        expected_span_id = span_value[2:] if isinstance(span_value, str) and span_value.startswith("0x") else span_value
        if isinstance(expected_span_id, str):
            expected_span_id = expected_span_id.lower()
    else:
        expected_span_id = f"{root.get_span_context().span_id:016x}"
    if projection.get("agentSpanId") != expected_span_id:
        raise ValueError("native root span does not match its ledger identity")
    return trace_id


def _span_documents(spans: Sequence[Any]) -> list[Any]:
    documents: list[Any] = []
    for span in spans:
        to_json = getattr(span, "to_json", None)
        if not callable(to_json):
            raise ValueError("native span cannot be serialized")
        raw = to_json()
        document = json.loads(raw) if isinstance(raw, str) else dict(raw)
        context = span.get_span_context()
        if not context.is_valid or not isinstance(span.start_time, int) or not isinstance(span.end_time, int):
            raise ValueError("native span is missing its exact trace identity or timestamps")
        document.update(
            {
                "traceId": f"{context.trace_id:032x}",
                "spanId": f"{context.span_id:016x}",
                "startTimeUnixNano": span.start_time,
                "endTimeUnixNano": span.end_time,
                "durationNano": span.end_time - span.start_time,
            }
        )
        if span.parent is not None and span.parent.is_valid:
            document["parentSpanId"] = f"{span.parent.span_id:016x}"
        else:
            document.pop("parentSpanId", None)
        scope = getattr(span, "instrumentation_scope", None)
        if scope is not None:
            document["scope"] = {
                "name": scope.name,
                **({"version": scope.version} if getattr(scope, "version", None) else {}),
            }
        documents.append(document)
    return documents


def _usage(spans: Sequence[Any]) -> dict[str, int]:
    root = next((span for span in spans if _span_operation(span) == "invoke_agent"), None)
    if root is None:
        return {}
    attrs = _span_attributes(root)
    names = {
        "inputTokens": "gen_ai.usage.input_tokens",
        "outputTokens": "gen_ai.usage.output_tokens",
        "totalTokens": "gen_ai.usage.total_tokens",
    }
    return {label: attrs[key] for label, key in names.items() if type(attrs.get(key)) is int}


def _snapshot_manifest(
    source_files: Mapping[str, bytes],
    dependency_files: Mapping[str, bytes],
    prompt_sha256: str,
    case_bytes: bytes,
    bundle_bytes: bytes,
) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "sourceFiles": {name: _sha256(raw) for name, raw in sorted(source_files.items())},
        "dependencyFiles": {name: _sha256(raw) for name, raw in sorted(dependency_files.items())},
        "sourceSha256": _named_digest(source_files),
        "dependencySha256": _named_digest(dependency_files),
        "promptSha256": prompt_sha256,
        "caseFileSha256": _sha256(case_bytes),
        "bundleSha256": _sha256(bundle_bytes),
    }


def _persist_interrupted(
    run_dir: Path,
    record: dict[str, Any],
    *,
    failure_type: str,
    error: str,
    started_monotonic: float,
) -> None:
    record["status"] = "interrupted"
    record["finishedAt"] = _utc_now()
    record["elapsedSeconds"] = round(max(0.0, time.monotonic() - started_monotonic), 6)
    record["failure"] = {"type": failure_type, "message": error[:500]}
    _write_json_atomic(run_dir / "execution.json", record)


def _run_snapshot(
    *,
    staging: Path,
    staged_case: Path,
    staged_bundle: Path,
    output_root: Path,
    source_files: Mapping[str, bytes],
    dependency_files: Mapping[str, bytes],
    model_session: Any,
    provider: Any,
) -> Path:
    agent_source = staging / "source" / "agent"
    with _snapshot_imports(agent_source):
        from captured_evidence import CapturedEvidenceTools
        from deterministic_checks import check_captured_report
        from evaluation_telemetry import execution_content
        from investigation import MODEL_ID as SHARED_MODEL_ID, RUN_SECONDS as SHARED_RUN_SECONDS, create_agent, invoke_agent
        from prompt import PROMPT_SHA256
        from reviewed_cases import load_frozen_case

        if SHARED_MODEL_ID != MODEL_ID or SHARED_RUN_SECONDS != RUN_SECONDS:
            raise ValueError("shared investigation settings do not match the approved captured runner")
        manifest_value = _decode_json((agent_source / "agent-manifest.json").read_bytes(), "agent manifest")
        if not isinstance(manifest_value, Mapping) or manifest_value.get("promptSha256") != PROMPT_SHA256:
            raise ValueError("packaged prompt digest does not match the source snapshot")

        # Validate both inputs from the copied bytes before creating a run
        # directory or constructing a model/client.
        loaded_case = load_frozen_case(staged_case, staged_bundle)
        task = loaded_case["task"]
        if model_session is None:
            provider = _verify_exporter_setup()
        output_directory = _private_directory(output_root)
        execution_id = str(uuid.uuid4())
        session_id = f"incident-triage-eval-{execution_id}"
        run_dir = output_directory / execution_id
        run_dir.mkdir(mode=0o700, exist_ok=False)
        run_dir.chmod(0o700)
        _write_bytes(run_dir / "case.frozen.json", staged_case.read_bytes())
        _write_bytes(run_dir / "bundle.json", staged_bundle.read_bytes())
        _copy_bytes_tree(run_dir / "source", {**source_files, **dependency_files})

        source_sha256 = _named_digest(source_files)
        dependency_sha256 = _named_digest(dependency_files)
        manifest = _snapshot_manifest(
            source_files,
            dependency_files,
            PROMPT_SHA256,
            staged_case.read_bytes(),
            staged_bundle.read_bytes(),
        )
        started_at = _utc_now()
        started_monotonic = time.monotonic()
        identity: dict[str, Any] = {
            "executionId": execution_id,
            "sessionId": session_id,
            "traceId": None,
            "candidateId": CANDIDATE_ID,
            "modelId": MODEL_ID,
            "originatingRunId": loaded_case["originatingRunId"],
            "caseSha256": loaded_case["caseSha256"],
            "bundleSha256": loaded_case["bundleSha256"],
            "referenceTime": loaded_case["referenceTime"],
            "sourceSha256": source_sha256,
            "promptSha256": PROMPT_SHA256,
            "dependencySha256": dependency_sha256,
            "reportSha256": None,
        }
        ledger: dict[str, Any] = {
            "agentSpanId": None,
            "modelCalls": [],
            "toolCalls": [],
            "reportSpanId": None,
        }
        record: dict[str, Any] = {
            "status": "running",
            "startedAt": started_at,
            "identity": identity,
            "manifest": manifest,
            "report": None,
            "ledger": ledger,
            "deterministic": None,
            "modelRequestCount": 0,
            "evidenceToolCallCount": 0,
            "usage": {},
        }
        _write_json_atomic(run_dir / "execution.json", record)

        timer: Timer | None = None
        cancel_signal = Event()
        observer: Any = None
        try:
            if provider is None:
                # Tests inject a fake session; production passes the provider
                # already verified before the source snapshot was loaded.
                from opentelemetry import trace
                from opentelemetry.sdk.trace import TracerProvider

                provider = trace.get_tracer_provider()
                if not isinstance(provider, TracerProvider):
                    raise ValueError("captured run has no installed ADOT tracer provider")
            observer = _span_observer()
            provider.add_span_processor(observer)
            tool_budget = _ToolBudget()
            deadline = started_monotonic + RUN_SECONDS
            evidence = CapturedEvidenceTools.load(
                staged_bundle,
                reference_time=loaded_case["referenceTime"],
                expected_sha256=loaded_case["bundleSha256"],
                allowed_resources=task["allowedResources"],
                deadline_monotonic=deadline,
                charge_tool_call=tool_budget,
            )
            span_attributes = {
                "session.id": session_id,
                "incident.execution_id": execution_id,
                "incident.originating_run_id": loaded_case["originatingRunId"],
                "incident.case_sha256": loaded_case["caseSha256"],
                "incident.bundle_sha256": loaded_case["bundleSha256"],
                "incident.reference_time": loaded_case["referenceTime"],
                "incident.candidate_id": CANDIDATE_ID,
                "incident.source_sha256": source_sha256,
                "incident.prompt_sha256": PROMPT_SHA256,
                "incident.dependency_sha256": dependency_sha256,
                "gen_ai.request.model": MODEL_ID,
            }
            trace_attributes = {**span_attributes}
            from opentelemetry import baggage
            from opentelemetry.context import attach, detach

            baggage_token = attach(baggage.set_baggage("session.id", session_id))
            try:
                agent, bounded_model = create_agent(
                    evidence,
                    region_name="us-east-1",
                    deadline_monotonic=deadline,
                    cancel_signal=cancel_signal,
                    trace_attributes=trace_attributes,
                    model_session=model_session,
                )
                remaining = max(0.0, deadline - time.monotonic())
                if remaining <= 0:
                    raise TimeoutError("captured investigation deadline elapsed before inference")
                timer = Timer(remaining, cancel_signal.set)
                timer.daemon = True
                timer.start()
                public_task = json.dumps(task, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                report = invoke_agent(agent, public_task, cancel_signal=cancel_signal)
            finally:
                detach(baggage_token)
            if timer is not None:
                timer.cancel()
                timer = None
            if not provider.force_flush(timeout_millis=30_000):
                raise ValueError("native telemetry provider did not flush the captured session")

            record["report"] = report
            identity["reportSha256"] = _sha256(_json_bytes(report))
            record["modelRequestCount"] = bounded_model.requests
            record["evidenceToolCallCount"] = tool_budget.calls
            record["usage"] = _usage(observer.spans)
            raw_spans = _span_documents(observer.spans)
            _write_json_atomic(run_dir / "strands.native-spans.json", {"spans": raw_spans})
            record["nativeSpansSha256"] = _sha256(_json_bytes({"spans": raw_spans}))

            projection = execution_content(observer.spans)
            if _json_bytes(projection.get("report")) != _json_bytes(report):
                raise ValueError("structured report differs from the actual InvestigationReport span")
            if bounded_model.requests != len(projection.get("modelCalls", [])):
                raise ValueError("actual Bedrock request count differs from native model spans")
            if tool_budget.calls != len(projection.get("toolCalls", [])):
                raise ValueError("captured evidence tool count differs from native tool spans")
            trace_id = _verify_native_identity(
                observer.spans,
                projection,
                task=task,
                identity=identity,
            )
            identity["traceId"] = trace_id
            record["ledger"] = {
                name: projection[name]
                for name in ("agentSpanId", "modelCalls", "toolCalls", "reportSpanId")
            }
            record["deterministic"] = check_captured_report(report, loaded_case, record["ledger"])
            record["status"] = "complete"
            record["finishedAt"] = _utc_now()
            record["elapsedSeconds"] = round(max(0.0, time.monotonic() - started_monotonic), 6)
            _write_json_atomic(run_dir / "execution.json", record)
            return run_dir
        except BaseException as exc:
            if observer is not None:
                try:
                    observer.enabled = True
                    raw_spans = _span_documents(observer.spans)
                    _write_json_atomic(run_dir / "strands.native-spans.json", {"spans": raw_spans})
                    record["nativeSpansSha256"] = _sha256(_json_bytes({"spans": raw_spans}))
                    record["modelRequestCount"] = locals().get("bounded_model").requests if "bounded_model" in locals() else 0
                    record["evidenceToolCallCount"] = locals().get("tool_budget").calls if "tool_budget" in locals() else 0
                    record["usage"] = _usage(observer.spans)
                    projection = execution_content(observer.spans)
                    record["ledger"] = {
                        name: projection[name]
                        for name in ("agentSpanId", "modelCalls", "toolCalls", "reportSpanId")
                    }
                    if record.get("report") is not None and _json_bytes(projection.get("report")) != _json_bytes(record["report"]):
                        record["telemetryError"] = "structured report differs from the actual report span"
                    else:
                        record["telemetryError"] = str(exc)[:500]
                    root_span = next((span for span in observer.spans if _span_operation(span) == "invoke_agent"), None)
                    if root_span is not None and getattr(root_span, "get_span_context", None):
                        context = root_span.get_span_context()
                        if context.is_valid:
                            record["identity"]["traceId"] = f"{context.trace_id:032x}"
                except Exception as telemetry_exc:
                    record["telemetryError"] = str(telemetry_exc)[:500]
            _persist_interrupted(
                run_dir,
                record,
                failure_type=type(exc).__name__,
                error=str(exc) or type(exc).__name__,
                started_monotonic=started_monotonic,
            )
            if isinstance(exc, (KeyboardInterrupt, SystemExit)):
                raise
            return run_dir
        finally:
            if timer is not None:
                timer.cancel()
            if observer is not None:
                observer.shutdown()


def _load_record_json(path: Path, label: str) -> Any:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise ValueError(f"{label} is unavailable") from exc
    return _decode_json(raw, label)


def _safe_relative(root: Path, relative: str) -> Path:
    path = Path(relative)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError("execution manifest contains an unsafe source path")
    target = root / path
    if target.is_symlink() or not target.is_file():
        raise ValueError("execution snapshot file is missing or is a symlink")
    try:
        target.resolve().relative_to(root.resolve())
    except ValueError as exc:
        raise ValueError("execution snapshot file escapes the run directory") from exc
    return target


def load_execution(run_dir: str | Path) -> tuple[dict[str, Any], dict[str, Any], list[Any]]:
    """Verify one saved run and reopen its frozen case without cloud access."""

    from deterministic_checks import check_captured_report
    from evaluation_telemetry import execution_content
    from investigation import InvestigationReport
    from reviewed_cases import load_frozen_case

    directory = Path(run_dir)
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("execution run directory is unavailable")
    record = _load_record_json(directory / "execution.json", "execution record")
    if not isinstance(record, dict):
        raise ValueError("execution record must be an object")
    if record.get("status") == "running":
        # A killed process cannot write its terminal update.  Never treat its
        # durable running marker as a completed or scoreable execution.
        record = dict(record)
        record["status"] = "interrupted"
        record.setdefault("failure", {"type": "ProcessInterrupted", "message": "run ended before a terminal record was saved"})
    if record.get("status") not in {"complete", "interrupted"}:
        raise ValueError("execution record has an unsupported status")

    identity = record.get("identity")
    if not isinstance(identity, Mapping):
        raise ValueError("execution identity is missing")
    required_identity = {
        "executionId", "sessionId", "traceId", "candidateId", "modelId", "originatingRunId",
        "caseSha256", "bundleSha256", "referenceTime", "sourceSha256", "promptSha256",
        "dependencySha256", "reportSha256",
    }
    if not required_identity <= set(identity):
        raise ValueError("execution identity is incomplete")
    if identity.get("candidateId") != CANDIDATE_ID or identity.get("modelId") != MODEL_ID:
        raise ValueError("execution candidate or model identity is unsupported")

    manifest = record.get("manifest")
    if not isinstance(manifest, Mapping) or manifest.get("schemaVersion") != 1:
        raise ValueError("execution snapshot manifest is missing or invalid")
    source_manifest = manifest.get("sourceFiles")
    dependency_manifest = manifest.get("dependencyFiles")
    if not isinstance(source_manifest, Mapping) or not isinstance(dependency_manifest, Mapping):
        raise ValueError("execution source digests are missing")
    source_files: dict[str, bytes] = {}
    dependency_files: dict[str, bytes] = {}
    for table, destination in ((source_manifest, source_files), (dependency_manifest, dependency_files)):
        for name, digest in table.items():
            if not isinstance(name, str) or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
                raise ValueError("execution snapshot digest is malformed")
            target = _safe_relative(directory / "source", name)
            raw = target.read_bytes()
            if _sha256(raw) != digest:
                raise ValueError("execution source snapshot digest does not match its manifest")
            destination[name] = raw
    source_sha256 = _named_digest(source_files)
    dependency_sha256 = _named_digest(dependency_files)
    if (
        manifest.get("sourceSha256") != source_sha256
        or identity.get("sourceSha256") != source_sha256
        or manifest.get("dependencySha256") != dependency_sha256
        or identity.get("dependencySha256") != dependency_sha256
        or manifest.get("promptSha256") != identity.get("promptSha256")
    ):
        raise ValueError("execution source, prompt, or dependency identity does not match its snapshot")

    expected_sources = {f"agent/{name}" for name in SOURCE_FILES}
    expected_dependencies = {f"agent/{name}" for name in DEPENDENCY_FILES}
    if set(source_manifest) != expected_sources or set(dependency_manifest) != expected_dependencies:
        raise ValueError("execution snapshot manifest does not contain the selected source and lock files")

    case_path = directory / "case.frozen.json"
    bundle_path = directory / "bundle.json"
    if _sha256(case_path.read_bytes()) != manifest.get("caseFileSha256"):
        raise ValueError("frozen case file digest does not match the execution manifest")
    bundle_raw = bundle_path.read_bytes()
    if _sha256(bundle_raw) != identity.get("bundleSha256") or manifest.get("bundleSha256") != identity.get("bundleSha256"):
        raise ValueError("source bundle digest does not match the execution identity")
    native_spans: list[Any] = []
    loaded_case = load_frozen_case(case_path, bundle_path)
    if (
        loaded_case.get("caseSha256") != identity.get("caseSha256")
        or loaded_case.get("bundleSha256") != identity.get("bundleSha256")
        or loaded_case.get("originatingRunId") != identity.get("originatingRunId")
        or loaded_case.get("referenceTime") != identity.get("referenceTime")
    ):
        raise ValueError("execution inputs do not match the frozen case identity")

    report = record.get("report")
    if record["status"] == "complete":
        if not isinstance(report, Mapping):
            raise ValueError("completed execution report is missing")
        try:
            InvestigationReport.model_validate(report)
        except Exception as exc:
            raise ValueError("completed execution report does not match schema 2") from exc
        if _sha256(_json_bytes(report)) != identity.get("reportSha256"):
            raise ValueError("report digest does not match the execution identity")
        native_path = directory / "strands.native-spans.json"
        native = _load_record_json(native_path, "native Strands spans")
        if not isinstance(native, Mapping) or not isinstance(native.get("spans"), list):
            raise ValueError("native Strands span file is malformed")
        if _sha256(_json_bytes(native)) != record.get("nativeSpansSha256"):
            raise ValueError("native Strands span digest does not match the execution record")
        native_spans = native["spans"]
        projection = execution_content(native["spans"])
        if _json_bytes(projection.get("report")) != _json_bytes(report):
            raise ValueError("saved report differs from the authenticated native report span")
        expected_ledger = {
            name: projection[name]
            for name in ("agentSpanId", "modelCalls", "toolCalls", "reportSpanId")
        }
        if _json_bytes(record.get("ledger")) != _json_bytes(expected_ledger):
            raise ValueError("saved execution ledger differs from authenticated native spans")
        observed_trace = _verify_native_identity(
            native["spans"], projection, task=loaded_case["task"], identity=identity
        )
        if identity.get("traceId") != observed_trace:
            raise ValueError("saved trace ID differs from the authenticated native spans")
        if record.get("modelRequestCount") != len(expected_ledger["modelCalls"]):
            raise ValueError("saved model request count differs from native spans")
        if record.get("evidenceToolCallCount") != len(expected_ledger["toolCalls"]):
            raise ValueError("saved evidence-tool count differs from native spans")
        findings = check_captured_report(report, loaded_case, expected_ledger)
        if _json_bytes(record.get("deterministic")) != _json_bytes(findings):
            raise ValueError("saved deterministic findings differ from the authenticated report and ledger")
    elif report is not None:
        if not isinstance(report, Mapping) or _sha256(_json_bytes(report)) != identity.get("reportSha256"):
            raise ValueError("interrupted report digest does not match the execution identity")
    if record["status"] == "interrupted":
        native_path = directory / "strands.native-spans.json"
        if native_path.is_file() and not native_path.is_symlink():
            native = _load_record_json(native_path, "interrupted native Strands spans")
            if not isinstance(native, Mapping) or not isinstance(native.get("spans"), list):
                raise ValueError("interrupted native Strands span file is malformed")
            if _sha256(_json_bytes(native)) != record.get("nativeSpansSha256"):
                raise ValueError("interrupted native Strands span digest does not match the execution record")
            native_spans = native["spans"]
    return record, loaded_case, native_spans
