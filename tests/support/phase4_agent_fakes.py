"""Controlled Strands and AWS boundaries for the Phase 4 acceptance suite."""

from __future__ import annotations

import contextlib
import importlib
import io
import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Iterator, Mapping, Sequence
from unittest.mock import patch

from botocore.exceptions import ClientError, ReadTimeoutError


AGENT_DIR = Path(__file__).resolve().parents[2] / "agent"
RUN_TABLE = "phase4-agent-runs"
SOURCE_BUCKET = "phase4-agent-evidence"
SOURCE_PREFIX = "agent-source/"
ALARM_ARN = "arn:aws:cloudwatch:us-east-1:123456789012:alarm:Phase4Test"
MODEL_ID = "us.anthropic.claude-sonnet-4-6"
SOURCE_REVISION = "development"
ARTIFACT_SHA256 = "a" * 64
_DEFAULT_EVENT = object()
SECRET_SENTINELS = ("app-secret-sentinel", "presenter-secret-sentinel", "controller-truth-sentinel")


@dataclass(frozen=True)
class ToolStep:
    name: str
    arguments: Mapping[str, Any] | Callable[[Any], Mapping[str, Any]] | None = None
    capture_error: bool = False


@dataclass
class AgentScript:
    """A model answer/query sequence; tools invoked are the product's functions."""

    steps: Sequence[ToolStep] = ()
    report: Mapping[str, Any] | None = None
    failure: BaseException | None = None
    after_invoke: Any = None
    tool_names: list[str] = field(default_factory=list)
    tool_results: list[tuple[str, Any]] = field(default_factory=list)
    prompts: list[str] = field(default_factory=list)
    constructions: list[dict[str, Any]] = field(default_factory=list)
    call_options: list[dict[str, Any]] = field(default_factory=list)
    invocations: int = 0


class ScriptedStrandsAgent:
    """Substitute only for model decisions; it runs the registered tools directly."""

    script: AgentScript

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self.tools = list(kwargs.get("tools") or [])
        self.output_model = kwargs.get("structured_output_model")
        self.script.constructions.append({"args": args, "kwargs": kwargs, "tools": self.tools})

    def __call__(self, prompt: Any = None, **kwargs: Any) -> Any:
        self.script.invocations += 1
        self.script.prompts.append(str(prompt))
        self.script.call_options.append(dict(kwargs))
        by_name = {getattr(tool, "tool_name", getattr(tool, "__name__", "")): tool for tool in self.tools}
        self.script.tool_names[:] = list(by_name)
        for step in self.script.steps:
            if step.name not in by_name:
                raise AssertionError(f"registered tool missing: {step.name}")
            try:
                args = dict(step.arguments(by_name[step.name])) if callable(step.arguments) else (
                    dict(step.arguments) if step.arguments is not None else tool_arguments(by_name[step.name])
                )
                result = by_name[step.name](**args)
            except Exception as exc:
                if not step.capture_error:
                    raise
                self.script.tool_results.append((step.name, exc))
            else:
                self.script.tool_results.append((step.name, result))
        if self.script.failure is not None:
            raise self.script.failure
        if self.script.after_invoke is not None:
            self.script.after_invoke()
        if self.script.report is None:
            return SimpleNamespace(structured_output=None)
        output_model = kwargs.get("structured_output_model") or self.output_model
        report: Any = dict(self.script.report)
        if output_model is not None and hasattr(output_model, "model_validate"):
            report = output_model.model_validate(report)
        return SimpleNamespace(structured_output=report)


class ConditionalClaimConflict(ClientError):
    def __init__(self, operation: str = "PutItem") -> None:
        super().__init__({"Error": {"Code": "ConditionalCheckFailedException"}}, operation)


def _decode(value: Any) -> Any:
    if isinstance(value, Mapping):
        for kind in ("S", "N", "BOOL", "NULL", "M", "L"):
            if kind in value:
                raw = value[kind]
                if kind == "NULL":
                    return None
                if kind == "N":
                    return int(raw) if str(raw).isdigit() else float(raw)
                if kind == "M":
                    return {key: _decode(item) for key, item in raw.items()}
                if kind == "L":
                    return [_decode(item) for item in raw]
                return raw
        return {key: _decode(item) for key, item in value.items()}
    return value


def _encode(value: Any) -> Any:
    if value is None:
        return {"NULL": True}
    if isinstance(value, bool):
        return {"BOOL": value}
    if isinstance(value, str):
        return {"S": value}
    if isinstance(value, (int, float)):
        return {"N": str(value)}
    if isinstance(value, list):
        return {"L": [_encode(item) for item in value]}
    if isinstance(value, Mapping):
        return {"M": {key: _encode(item) for key, item in value.items()}}
    return {"S": str(value)}


class FakeRunStore:
    """The one Runtime table, including conditional claim and owner-only finish."""

    def __init__(self) -> None:
        self.region_name = "us-east-1"
        self.rows: dict[tuple[str, str], dict[str, Any]] = {}
        self.operations: list[tuple[str, Mapping[str, Any]]] = []
        self.lose_next_put_ack = False

    def seed(self, item: Mapping[str, Any]) -> None:
        row = _decode(item)
        self.rows[(row["pk"], row["sk"])] = row

    def _key(self, key: Mapping[str, Any]) -> tuple[str, str]:
        decoded = _decode(key)
        return str(decoded["pk"]), str(decoded["sk"])

    def find(self, alarm_arn: str, transition_at: str) -> dict[str, Any] | None:
        return self.rows.get((alarm_arn, transition_at))

    def put(self, item: Mapping[str, Any], request: Mapping[str, Any]) -> dict[str, Any]:
        self.operations.append(("put_item", request))
        row = _decode(item)
        key = self._key(row)
        old = self.rows.get(key)
        if old is not None and request.get("ConditionExpression"):
            raise ConditionalClaimConflict()
        self.rows[key] = row
        if self.lose_next_put_ack:
            self.lose_next_put_ack = False
            raise ReadTimeoutError(endpoint_url="https://dynamodb.us-east-1.amazonaws.com")
        return old or {}

    def update(self, request: Mapping[str, Any]) -> dict[str, Any]:
        self.operations.append(("update_item", request))
        key = self._key(request["Key"])
        row = self.rows.get(key)
        if row is None:
            raise KeyError(key)
        names, values = request.get("ExpressionAttributeNames", {}), request.get("ExpressionAttributeValues", {})
        condition = request.get("ConditionExpression", "")
        # Terminal transitions may only be written by the active claim owner.
        if condition and not _condition_matches(condition, row, names, values):
            raise ConditionalClaimConflict("UpdateItem")
        expression = request.get("UpdateExpression", "").split("SET", 1)[-1]
        for assignment in expression.split(","):
            if "=" not in assignment:
                continue
            left, right = (part.strip() for part in assignment.split("=", 1))
            row[names.get(left, left.lstrip("#"))] = _decode(values.get(right))
        return row


def _condition_matches(condition: Any, row: Mapping[str, Any], names: Mapping[str, str], values: Mapping[str, Any]) -> bool:
    if isinstance(condition, str):
        for clause in condition.replace("(", "").replace(")", "").split(" AND "):
            if "=" not in clause:
                continue
            left, right = (part.strip() for part in clause.split("=", 1))
            field = names.get(left, left.lstrip("#"))
            if _decode(row.get(field)) != _decode(values.get(right)):
                return False
        return True
    if not hasattr(condition, "get_expression"):
        return True
    expression = condition.get_expression()
    operator, operands = expression.get("operator"), expression.get("values", ())
    if operator == "AND":
        return all(_condition_matches(part, row, names, values) for part in operands)
    if operator == "=":
        left, right = operands
        field = getattr(left, "name", None)
        return field is None or _decode(row.get(field)) == _decode(right)
    return True


class FakeAWSBoundary:
    """Read-only application source APIs plus the Runtime-owned report table."""

    READS = {
        "logs": {"filter_log_events", "get_log_events", "get_query_results", "start_query"},
        "cloudwatch": {"get_metric_data", "get_metric_statistics", "list_metrics"},
        "lambda": {"get_alias", "get_function_configuration", "get_function_concurrency", "list_versions_by_function", "get_policy"},
        "dynamodb": {"get_resource_policy"},
        "iam": {"get_role", "get_role_policy", "list_role_policies", "list_attached_role_policies", "get_policy", "get_policy_version"},
        "cloudtrail": {"lookup_events"},
    }

    def __init__(self) -> None:
        self.region_name = "us-east-1"
        self.runs = FakeRunStore()
        self.calls: list[tuple[str, str, Mapping[str, Any]]] = []
        self.s3_writes: list[tuple[str, str, Any]] = []
        self.runtime = _FakeAgentCore(self)
        self.model_requests: list[Mapping[str, Any]] = []
        self.responses = self._default_responses()
        self.large_log_count = 0
        self.more_pages = False
        self.pages: dict[tuple[str, str], int] = {}

    @staticmethod
    def _default_responses() -> dict[tuple[str, str], Any]:
        env = {"CHECKOUT_BEARER": SECRET_SENTINELS[0], "PRESENTER_TOKEN": SECRET_SENTINELS[1], "CONTROLLER_BASELINE": SECRET_SENTINELS[2]}
        return {
            ("logs", "filter_log_events"): {"events": []},
            ("logs", "get_log_events"): {"events": []},
            ("logs", "start_query"): {"queryId": "query-1"},
            ("logs", "get_query_results"): {"status": "Complete", "results": []},
            ("cloudwatch", "get_metric_data"): {"MetricDataResults": []},
            ("cloudwatch", "get_metric_statistics"): {"Datapoints": []},
            ("cloudwatch", "list_metrics"): {"Metrics": []},
            ("lambda", "get_alias"): {"Name": "live", "FunctionVersion": "12", "RevisionId": "alias-rev-12"},
            ("lambda", "get_function_configuration"): {"FunctionName": "IncidentTriageDemoInventory", "Role": "arn:aws:iam::123456789012:role/IncidentTriageDemoAppInventoryDeniedRole", "Version": "12", "RevisionId": "function-rev-12", "MemorySize": 256, "ReservedConcurrentExecutions": 3, "Environment": {"Variables": env}},
            ("lambda", "get_function_concurrency"): {"ReservedConcurrentExecutions": 3},
            ("lambda", "list_versions_by_function"): {"Versions": [{"Version": "12", "MemorySize": 256}]},
            ("lambda", "get_policy"): {"Policy": json.dumps({"Statement": []})},
            ("iam", "get_role"): {"Role": {"RoleName": "IncidentTriageDemoAppInventoryDeniedRole", "Arn": "arn:aws:iam::123456789012:role/IncidentTriageDemoAppInventoryDeniedRole"}},
            ("iam", "get_role_policy"): {"PolicyDocument": {"Version": "2012-10-17", "Statement": []}},
            ("iam", "list_role_policies"): {"PolicyNames": []},
            ("iam", "list_attached_role_policies"): {"AttachedPolicies": []},
            ("iam", "get_policy"): {"Policy": {"DefaultVersionId": "v1"}},
            ("iam", "get_policy_version"): {"PolicyVersion": {"Document": {"Version": "2012-10-17", "Statement": []}}},
            ("cloudtrail", "lookup_events"): {"Events": []},
        }

    def client(self, service_name: str, **kwargs: Any) -> Any:
        if service_name == "dynamodb":
            return _FakeDynamoClient(self)
        if service_name == "s3":
            return _FakeS3(self)
        if service_name == "bedrock-agentcore":
            return self.runtime
        if service_name == "bedrock-runtime":
            return _FakeBedrockRuntime(self)
        if service_name not in self.READS:
            raise AssertionError(f"unexpected AWS client: {service_name}")
        return _FakeReadClient(self, service_name)

    def resource(self, service_name: str, **kwargs: Any) -> Any:
        if service_name == "dynamodb":
            return _FakeDynamoResource(self)
        raise AssertionError(f"unexpected AWS resource: {service_name}")

    def session(self, *args: Any, **kwargs: Any) -> "FakeAWSBoundary":
        return self


class _FakeDynamoClient:
    class exceptions:
        ConditionalCheckFailedException = ConditionalClaimConflict

    def __init__(self, boundary: FakeAWSBoundary) -> None:
        self.boundary = boundary

    @staticmethod
    def _check_table(request: Mapping[str, Any]) -> None:
        if request.get("TableName") != RUN_TABLE:
            raise AssertionError(f"Runtime may write only its run table: {request.get('TableName')!r}")

    def put_item(self, **request: Any) -> dict[str, Any]:
        self._check_table(request)
        return {"Attributes": self.boundary.runs.put(request["Item"], request)}

    def get_item(self, **request: Any) -> dict[str, Any]:
        self._check_table(request)
        item = self.boundary.runs.find(*self.boundary.runs._key(request["Key"]))
        return {} if item is None else {"Item": {key: _encode(value) for key, value in item.items()}}

    def update_item(self, **request: Any) -> dict[str, Any]:
        self._check_table(request)
        item = self.boundary.runs.update(request)
        return {"Attributes": {key: _encode(value) for key, value in item.items()}}

    def get_resource_policy(self, **request: Any) -> dict[str, Any]:
        if request.get("ResourceArn") != "arn:aws:dynamodb:us-east-1:123456789012:table/IncidentTriageDemoInventory":
            raise AssertionError(f"Inventory resource-policy read escaped the configured table: {request}")
        self.boundary.calls.append(("dynamodb", "get_resource_policy", request))
        return {"Policy": json.dumps({"Version": "2012-10-17", "Statement": []})}

    def query(self, **request: Any) -> dict[str, Any]:
        self._check_table(request)
        self.boundary.runs.operations.append(("query", request))
        rows = sorted(self.boundary.runs.rows.values(), key=lambda item: item["sk"], reverse=True)
        return {"Items": [{key: _encode(value) for key, value in row.items()} for row in rows]}

    def __getattr__(self, operation: str) -> Any:
        raise AssertionError(f"DynamoDB operation outside Runtime run-store contract: {operation}")


class _FakeTable:
    def __init__(self, boundary: FakeAWSBoundary, name: str) -> None:
        if name != RUN_TABLE:
            raise AssertionError(f"Runtime may access only its run table: {name!r}")
        self.boundary = boundary

    def put_item(self, **request: Any) -> dict[str, Any]:
        self.boundary.runs.put(request["Item"], request)
        return {}

    def get_item(self, **request: Any) -> dict[str, Any]:
        item = self.boundary.runs.find(*self.boundary.runs._key(request["Key"]))
        return {} if item is None else {"Item": item}

    def update_item(self, **request: Any) -> dict[str, Any]:
        return {"Attributes": self.boundary.runs.update(request)}


class _FakeDynamoResource:
    def __init__(self, boundary: FakeAWSBoundary) -> None:
        self.boundary = boundary

    def Table(self, name: str) -> _FakeTable:
        return _FakeTable(self.boundary, name)


class _FakeReadClient:
    def __init__(self, boundary: FakeAWSBoundary, service: str) -> None:
        self.boundary, self.service = boundary, service

    def __getattr__(self, operation: str) -> Any:
        if operation not in self.boundary.READS[self.service]:
            raise AssertionError(f"source tool is read-only; rejected {self.service}.{operation}")

        def call(**request: Any) -> Any:
            self.boundary.calls.append((self.service, operation, request))
            key = self.service, operation
            page = self.boundary.pages.get(key, 0)
            self.boundary.pages[key] = page + 1
            if page >= 20:
                raise AssertionError(f"source pagination was not bounded: {key}")
            response = self.boundary.responses.get(key, {})
            response = response(request, page) if callable(response) else dict(response)
            if self.service == "logs" and operation in {"filter_log_events", "get_log_events"} and self.boundary.large_log_count:
                response = {"events": [{"timestamp": 1_800_000_000_000 + i, "message": "x" * 220} for i in range(self.boundary.large_log_count)]}
            if self.service == "logs" and operation == "get_query_results" and self.boundary.large_log_count:
                response = {"status": "Complete", "results": [[{"field": "@timestamp", "value": "2026-11-09T23:01:00Z"}, {"field": "@message", "value": "x" * 220}] for _ in range(self.boundary.large_log_count)]}
            if self.boundary.more_pages and operation in {"lookup_events", "get_metric_data", "get_query_results", "filter_log_events"}:
                token_name = "nextToken" if operation in {"get_query_results", "filter_log_events"} else "NextToken"
                response[token_name] = f"next-{page + 1}"
            return response

        return call


class _FakeS3:
    def __init__(self, boundary: FakeAWSBoundary) -> None:
        self.boundary = boundary

    def put_object(self, **request: Any) -> dict[str, Any]:
        if request.get("Bucket") != SOURCE_BUCKET or not str(request.get("Key", "")).startswith(SOURCE_PREFIX):
            raise AssertionError("Runtime may write only the agent source prefix")
        self.boundary.s3_writes.append((request["Bucket"], request["Key"], request.get("Body")))
        return {"ETag": '"test"'}

    def __getattr__(self, operation: str) -> Any:
        raise AssertionError(f"S3 operation outside source-capture contract: {operation}")


class _FakeAgentCore:
    def __init__(self, boundary: FakeAWSBoundary) -> None:
        self.boundary = boundary
        self.requests: list[dict[str, Any]] = []
        self.lose_next_reply = False

    def invoke_agent_runtime(self, **request: Any) -> dict[str, Any]:
        self.requests.append(request)
        if self.lose_next_reply:
            self.lose_next_reply = False
            raise ReadTimeoutError(endpoint_url="https://bedrock-agentcore.us-east-1.amazonaws.com")
        return {"response": io.BytesIO(b'{"status":"running"}'), "statusCode": 200, "runtimeSessionId": request.get("runtimeSessionId")}

    def __getattr__(self, operation: str) -> Any:
        raise AssertionError(f"adapter may only invoke AgentCore Runtime: {operation}")


class _FakeBedrockRuntime:
    """No-network Bedrock response stream that always asks the real Strands loop for a tool."""

    def __init__(self, boundary: FakeAWSBoundary) -> None:
        self.boundary = boundary
        self.meta = SimpleNamespace(region_name="us-east-1")

    def converse_stream(self, **request: Any) -> dict[str, Any]:
        self.boundary.model_requests.append(request)
        if len(self.boundary.model_requests) > 24:
            raise AssertionError("Strands exceeded the bounded model-request safety stop")
        tool_specs = request.get("toolConfig", {}).get("tools", [])
        if not tool_specs:
            raise AssertionError("budget probe expects registered read-only tools")
        spec = tool_specs[0].get("toolSpec", {})
        name = spec.get("name")
        args = _arguments_from_schema(spec.get("inputSchema", {}).get("json", {}))
        block = {
            "messageStart": {"role": "assistant"},
            "contentBlockStart": {"contentBlockIndex": 0, "start": {"toolUse": {"toolUseId": f"tool-{len(self.boundary.model_requests)}", "name": name}}},
            "contentBlockDelta": {"contentBlockIndex": 0, "delta": {"toolUse": {"input": json.dumps(args)}}},
            "contentBlockStop": {"contentBlockIndex": 0},
            "messageStop": {"stopReason": "tool_use"},
            "metadata": {"usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2}, "metrics": {"latencyMs": 1}},
        }
        return {"stream": iter({name: value} for name, value in block.items())}

    def __getattr__(self, operation: str) -> Any:
        raise AssertionError(f"test suite must not make a real model call: bedrock-runtime.{operation}")


def alarm_event(
    *, timestamp: str = "2026-11-09T23:10:00.000Z", alarm_arn: str = ALARM_ARN,
    account_id: str = "123456789012", region: str = "us-east-1", state: str = "ALARM",
    source: str = "aws.cloudwatch",
) -> dict[str, Any]:
    return {
        "source": source, "alarmArn": alarm_arn, "accountId": account_id, "region": region,
        "time": "2026-11-09T23:10:01.000Z",
        "alarmData": {
            "alarmName": "Phase4Test", "state": {"value": state, "timestamp": timestamp, "reason": "Threshold crossed"},
            "previousState": {"value": "OK", "timestamp": "2026-11-09T23:09:00.000Z"},
            "configuration": {"description": "Controlled test alarm"},
        },
    }


def runtime_payload(event: Any = _DEFAULT_EVENT, *, deployment: Mapping[str, Any] | None = None) -> dict[str, Any]:
    return {
        "event": alarm_event() if event is _DEFAULT_EVENT else event,
        "deployment": dict(deployment or {
            "runtimeArn": "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/IncidentTriageDemoAgent-test",
            "runtimeVersion": "1",
            "endpointName": "faulty",
            "sourceRevision": SOURCE_REVISION,
            "artifactSha256": ARTIFACT_SHA256,
        }),
    }


def report() -> dict[str, Any]:
    return {
        "assessment": "unknown",
        "summary": "The captured evidence is too narrow to determine current service state.",
        "recommendation": {"action": "Other", "target": None, "value": "No supported configuration change is established.", "unit": None},
        "evidence": [{"source": "cloudwatch", "resource": "IncidentTriageDemoInventory", "windowStart": "2026-11-09T23:00:00Z", "windowEnd": "2026-11-09T23:10:00Z", "observedAt": "2026-11-09T23:10:02Z", "finding": "No samples were returned in this controlled case."}],
        "uncertainties": ["No correlated request record was available."],
        "alternatives": ["The incident may have recovered before the observation window."],
    }


def _arguments_from_schema(schema: Mapping[str, Any], *, invalid_window: bool = False, invalid_resource: bool = False) -> dict[str, Any]:
    properties = schema.get("properties", {})
    values: dict[str, Any] = {}
    for name in properties:
        definition, key = properties.get(name, {}), name.lower()
        if invalid_resource and any(term in key for term in ("resource", "service", "function", "log_group", "target")):
            values[name] = "controller"
        elif "enum" in definition:
            enum = definition["enum"]
            values[name] = "inventory" if "inventory" in enum else enum[0]
        elif any(term in key for term in ("start", "from")):
            values[name] = "2026-11-09T22:00:00Z" if invalid_window else "2026-11-09T23:00:00Z"
        elif any(term in key for term in ("end", "to")):
            values[name] = "2026-11-09T23:00:00Z" if invalid_window else "2026-11-09T23:10:00Z"
        elif "lookback" in key or "minutes" in key:
            values[name] = 60 if invalid_window else 10
        elif definition.get("type") == "array":
            values[name] = ["controller" if invalid_resource else "inventory"]
        elif any(term in key for term in ("resource", "service", "function", "log_group", "target")):
            values[name] = "controller" if invalid_resource else "inventory"
        elif "filter" in key or "query" in key or "operation" in key or "error" in key:
            values[name] = "AccessDenied"
        elif "limit" in key or "page_size" in key or "max_results" in key or definition.get("type") in {"integer", "number"}:
            values[name] = 100 if "limit" in key or "page" in key else 60
        elif definition.get("type") == "object":
            values[name] = {}
        else:
            values[name] = "inventory"
    return values


def tool_arguments(tool: Any, *, invalid_window: bool = False, invalid_resource: bool = False) -> dict[str, Any]:
    schema = getattr(tool, "tool_spec", {}).get("inputSchema", {}).get("json", {})
    return _arguments_from_schema(schema, invalid_window=invalid_window, invalid_resource=invalid_resource)


def runtime_context(session_id: str) -> Any:
    from bedrock_agentcore.runtime import RequestContext

    return RequestContext(session_id=session_id)


def _patch_aws(boundary: FakeAWSBoundary) -> tuple[Any, ...]:
    import boto3
    import botocore.httpsession

    return (
        patch.object(boto3, "client", boundary.client),
        patch.object(boto3, "resource", boundary.resource),
        patch.object(boto3, "Session", boundary.session),
        patch.object(botocore.httpsession.URLLib3Session, "send", side_effect=AssertionError("live AWS request blocked")),
    )


@contextlib.contextmanager
def isolated_runtime(
    script: AgentScript,
    boundary: FakeAWSBoundary | None = None,
    *,
    real_strands: bool = False,
) -> Iterator[tuple[Any, FakeAWSBoundary]]:
    if str(AGENT_DIR) not in sys.path:
        sys.path.insert(0, str(AGENT_DIR))
    import strands

    boundary = boundary or FakeAWSBoundary()
    ScriptedStrandsAgent.script = script
    env = {
        "AWS_ACCESS_KEY_ID": "test-only", "AWS_SECRET_ACCESS_KEY": "test-only", "AWS_SESSION_TOKEN": "test-only",
        "AWS_REGION": "us-east-1", "AWS_DEFAULT_REGION": "us-east-1", "AWS_EC2_METADATA_DISABLED": "true",
        "AGENT_RUN_TABLE": RUN_TABLE, "AGENT_SOURCE_BUCKET": SOURCE_BUCKET, "AGENT_SOURCE_PREFIX": SOURCE_PREFIX,
        "AGENT_ALARM_ARN": ALARM_ARN, "AGENT_MODEL_ID": MODEL_ID, "AGENT_ACCOUNT_ID": "123456789012",
        "AGENT_REGION": "us-east-1", "AGENT_APP_HTTP_API_ID": "api-123456",
        "AGENT_CANDIDATE_ID": "faulty", "AGENT_SOURCE_REVISION": SOURCE_REVISION,
        "AGENT_ARTIFACT_SHA256": ARTIFACT_SHA256, "AGENT_ENDPOINT_NAME": "faulty",
    }
    with contextlib.ExitStack() as stack:
        stack.enter_context(patch.dict(os.environ, env))
        for aws_patch in _patch_aws(boundary):
            stack.enter_context(aws_patch)
        if not real_strands:
            stack.enter_context(patch.object(strands, "Agent", ScriptedStrandsAgent))
        module = importlib.reload(sys.modules["main"]) if "main" in sys.modules else importlib.import_module("main")
        yield module, boundary


@contextlib.contextmanager
def isolated_adapter(boundary: FakeAWSBoundary | None = None) -> Iterator[tuple[Any, FakeAWSBoundary]]:
    if str(AGENT_DIR) not in sys.path:
        sys.path.insert(0, str(AGENT_DIR))
    boundary = boundary or FakeAWSBoundary()
    env = {
        "AWS_ACCESS_KEY_ID": "test-only", "AWS_SECRET_ACCESS_KEY": "test-only", "AWS_SESSION_TOKEN": "test-only",
        "AWS_REGION": "us-east-1", "AWS_DEFAULT_REGION": "us-east-1", "AWS_EC2_METADATA_DISABLED": "true",
        "AGENT_ALARM_ARN": ALARM_ARN, "AGENT_ACCOUNT_ID": "123456789012", "AGENT_REGION": "us-east-1",
        "AGENT_RUNTIME_ARN": "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/IncidentTriageDemoAgent-test",
        "AGENT_RUNTIME_VERSION": "1", "AGENT_ENDPOINT_NAME": "faulty",
        "AGENT_SOURCE_REVISION": "a" * 40, "AGENT_ARTIFACT_SHA256": ARTIFACT_SHA256,
    }
    with contextlib.ExitStack() as stack:
        stack.enter_context(patch.dict(os.environ, env))
        for aws_patch in _patch_aws(boundary):
            stack.enter_context(aws_patch)
        module = importlib.reload(sys.modules["alarm_adapter"]) if "alarm_adapter" in sys.modules else importlib.import_module("alarm_adapter")
        yield module, boundary
