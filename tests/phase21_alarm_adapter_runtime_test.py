"""Acceptance for selected-publication alarm delivery into the shared Runtime.

These cases exercise the two production entrypoints that own this boundary:
``alarm_adapter.handler`` receives a native alarm delivery and ``main.invoke``
claims the originating transition.  The selected publication is represented by
the controller-table record written by the publisher; the adapter may read it,
but it must not claim or write an investigation itself.

The transport is controlled at the AWS boundary only.  The Runtime, report
validation, run-store claim and existing read-only tools remain the production
implementations from ``agent/``.  Publication records use the phase-20 tuple
fields and the single selected row is addressed by the controller table's
existing partition key ``AGENT_SELECTION``.
"""

from __future__ import annotations

import copy
import importlib
import io
import json
import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from botocore.exceptions import ReadTimeoutError

from support.phase4_agent_fakes import (
    ALARM_ARN,
    FakeAWSBoundary,
    AgentScript,
    alarm_event,
    isolated_runtime,
    report,
    runtime_context,
)


SELECTION_TABLE = "IncidentTriageDemoControllerRun"
SELECTION_PK = "AGENT_SELECTION"
RUNTIME_ARN = "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/IncidentTriageDemoAgent-test"
FAULTY_SOURCE_REVISION = "bd6f77df97933e3e675ee9c2a699db16e29ea1b6"
REPAIRED_SOURCE_REVISION = "62236d0e8731242d5a6468cf931f003a323b5349"
FAULTY_ARTIFACT_SHA256 = "e5ac2ee20d8f3947eb95ceb74094e882a3d8a4a010f2a8e7bf96700dd5906b33"
REPAIRED_ARTIFACT_SHA256 = "1f8e45fedee78cc9cc60c8b777c2b3ef51eee53ac00909a3bbf499c78de28cf7"
PUBLICATION_IDENTITIES = {
    "faulty": {
        "status": "reference",
        "version": "19",
        "sourceRevision": FAULTY_SOURCE_REVISION,
        "artifactSha256": FAULTY_ARTIFACT_SHA256,
        "artifactVersionId": "cfbeR.PYCX2qc8g9xWBJUzqWmTBXCyaw",
        "configurationVersionId": "BbCtgPF2Do16.BJ0oetJvN09pSFvW6fI",
        "promptSha256": "161aa4357b908cffe9691349d01da284411cd5d4689235717525d79e1073fffc",
        "configurationSha256": "7febe979fa1365360983d886f9d1dc78b55d9bde91a6fe7357e5f9fd97d2d7a7",
        "sourceManifestSha256": "2b1eccde2e92799fd24d21572576680a856c7aba9f0b3495831f2f76a34e0bab",
        "sourceSha256": "3d21155b9f9465a0ac11eb9fcaf761bfd19549cf6454ae3ac20c20044d57a9eb",
        "adapterCodeSha256": "a88f40a6d780c0342f5aea5ad7e5eac3f7f270c28ed209c51543c1801a66da56",
    },
    "repaired": {
        "status": "published",
        "version": "20",
        "sourceRevision": REPAIRED_SOURCE_REVISION,
        "artifactSha256": REPAIRED_ARTIFACT_SHA256,
        "artifactVersionId": "jSNSUJ_qWCBaBQdiQ3nlS7DgSvYbmwNl",
        "promptSha256": "0f8d10ce6f46302a00dbe60cb29ebfeb4212627000c78b3529e6e0c7696ff425",
        "configurationSha256": "c68bd2adda510445c119dbf933681f4189f3298711afa69d1f93936306a633ba",
        "sourceSha256": "88b8b94f2da13263407aadc1301bc5b4c2345fcec3ac2bd148fead9835807bdd",
        "adapterCodeSha256": "a88f40a6d780c0342f5aea5ad7e5eac3f7f270c28ed209c51543c1801a66da56",
        "caseSetSha256": "64e81d8ac825154dd49ee36ca750aca81bb4a07ab1612d1d00e6c28dba0a7bfe",
        "reportIdentitiesSha256": "6ad649f0da85194e6b8c9f3675fd24f3a15d275d206a92a63ece7a49d394f5ca",
        "experimentId": "facc9c90-882c-4e53-aa04-bceae858fdd9",
        "reviewEnvironment": "repaired-publication",
        "reviewRunId": "44265837592",
        "reviewManifestSha256": "29669b1dc3faa8a9bf7693aa5650937cd330741ebd02a1bc9ac80c549b06ec1b",
        "reviewer": "guilleojeda",
    },
}
DEPLOYMENT_FIELDS = frozenset(
    {"runtimeArn", "runtimeVersion", "endpointName", "sourceRevision", "artifactSha256"}
)
RUNTIME_ENV_NAMES = (
    "AGENT_RUN_TABLE",
    "AGENT_SOURCE_BUCKET",
    "AGENT_SOURCE_PREFIX",
    "AGENT_ALARM_ARN",
    "AGENT_MODEL_ID",
    "AGENT_ACCOUNT_ID",
    "AGENT_REGION",
    "AGENT_CANDIDATE_ID",
    "AGENT_SOURCE_REVISION",
    "AGENT_ARTIFACT_SHA256",
    "AGENT_ENDPOINT_NAME",
    "AGENT_APP_HTTP_API_ID",
)


def _encode(value: object) -> object:
    """Encode a value for the low-level DynamoDB client shape."""

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
    if isinstance(value, dict):
        return {"M": {key: _encode(item) for key, item in value.items()}}
    raise TypeError(f"unsupported DynamoDB fixture value: {value!r}")


def _selection_tuple(candidate: str, *, version: str | None = None) -> dict[str, object]:
    """Return one controller-shaped selected row from the phase-20 tuple."""

    identity = PUBLICATION_IDENTITIES[candidate]
    return {
        "pk": SELECTION_PK,
        "revision": 1,
        "candidateId": candidate,
        "runtimeArn": RUNTIME_ARN,
        "runtimeVersion": version or identity["version"],
        "endpointName": candidate,
        "endpointArn": f"{RUNTIME_ARN}/runtime-endpoint/{candidate}",
        "artifactSha256": identity["artifactSha256"],
        "artifactVersionId": identity["artifactVersionId"],
        "sourceRevision": identity["sourceRevision"],
        "selectedAt": "2026-11-18T12:00:00.000Z",
        "promptSha256": identity["promptSha256"],
        "configurationSha256": identity["configurationSha256"],
        **{
            key: identity[key]
            for key in ("configurationVersionId", "sourceManifestSha256")
            if key in identity
        },
        "sourceSha256": identity["sourceSha256"],
        "adapterCodeSha256": identity["adapterCodeSha256"],
        "alarmArn": ALARM_ARN,
        "modelId": "us.anthropic.claude-opus-5-5",
        "adapterArn": "arn:aws:lambda:us-east-1:123456789012:function:IncidentTriageDemoAlarmAdapter",
        **{
            key: identity[key]
            for key in (
                "caseSetSha256",
                "reportIdentitiesSha256",
                "experimentId",
                "reviewEnvironment",
                "reviewRunId",
                "reviewManifestSha256",
                "reviewer",
            )
            if key in identity
        },
    }


class SelectionTable:
    """A native-shaped strongly consistent read of the one selection record."""

    def __init__(self, row: dict[str, object] | None) -> None:
        self.row = row
        self.reads: list[dict[str, object]] = []
        self.after_read = None
        self.read_error: BaseException | None = None

    def get_item(self, **request: object) -> dict[str, object]:
        self.reads.append(copy.deepcopy(request))
        if request.get("Key") != {"pk": SELECTION_PK}:
            raise AssertionError(f"selection read used an unexpected key: {request!r}")
        if request.get("ConsistentRead") is not True:
            raise AssertionError("selected publication must be read strongly")
        if self.read_error is not None:
            raise self.read_error
        snapshot = copy.deepcopy(self.row)
        if self.after_read is not None:
            self.after_read()
        return {} if snapshot is None else {"Item": snapshot}


class SelectionResource:
    def __init__(self, boundary: "SelectionBoundary") -> None:
        self.boundary = boundary
        self.run_resource = super_resource(boundary)

    def Table(self, name: str):  # noqa: N802 - mirrors boto3's resource API
        if name == SELECTION_TABLE:
            return self.boundary.selection
        return self.run_resource.Table(name)


def super_resource(boundary: FakeAWSBoundary):
    """Build the existing fake run-table resource without duplicating it."""

    # The helper is intentionally imported lazily: it is an existing fixture,
    # not a second implementation of the Runtime's persistence behavior.
    from support.phase4_agent_fakes import _FakeDynamoResource

    return _FakeDynamoResource(boundary)


class SelectionClient:
    """Low-level DynamoDB view for adapters using the normal client API."""

    def __init__(self, boundary: "SelectionBoundary", base: object) -> None:
        self.boundary = boundary
        self.base = base

    def get_item(self, **request: object) -> dict[str, object]:
        # Keep the same observable contract as SelectionTable while allowing
        # either normal boto3 DynamoDB surface used by the adapter.
        low_level_key = request.get("Key")
        if not isinstance(low_level_key, dict):
            raise AssertionError("low-level selection read must provide a DynamoDB key")
        native_request = dict(request)
        native_request["Key"] = {
            name: value.get("S") if isinstance(value, dict) and "S" in value else value
            for name, value in low_level_key.items()
        }
        native = self.boundary.selection.get_item(**native_request)
        item = native.get("Item")
        return {"Item": {key: _encode(value) for key, value in item.items()}} if item else {}

    def __getattr__(self, name: str):
        return getattr(self.base, name)


class SelectionBoundary(FakeAWSBoundary):
    """Existing phase-4 AWS fake plus the publisher/controller selection row."""

    def __init__(self, row: dict[str, object] | None) -> None:
        super().__init__()
        self.selection = SelectionTable(row)
        self.runtime_bridge: RuntimeBridge | None = None

    def resource(self, service_name: str, **kwargs: object):
        if service_name == "dynamodb":
            return SelectionResource(self)
        return super().resource(service_name, **kwargs)

    def client(self, service_name: str, **kwargs: object):
        base = super().client(service_name, **kwargs)
        if service_name == "dynamodb":
            return SelectionClient(self, base)
        if service_name == "bedrock-agentcore" and self.runtime_bridge is not None:
            return self.runtime_bridge
        return base


class RuntimeBridge:
    """Invoke the real Runtime entrypoint through the adapter's public client."""

    def __init__(
        self,
        boundary: SelectionBoundary,
        runtime_module: object,
        runtime_environment: dict[str, str],
    ) -> None:
        self.boundary = boundary
        self.runtime_module = runtime_module
        self.runtime_environment = runtime_environment
        self.requests: list[dict[str, object]] = []
        self.results: list[dict[str, object]] = []
        self.lose_next_reply = False
        self.cross_qualifier: str | None = None

    def invoke_agent_runtime(self, **request: object) -> dict[str, object]:
        self.requests.append(copy.deepcopy(request))
        payload = request.get("payload")
        if isinstance(payload, str):
            payload = payload.encode("utf-8")
        if not isinstance(payload, bytes):
            raise AssertionError("adapter must send a JSON payload")
        decoded = json.loads(payload)
        deployment = decoded.get("deployment")
        if not isinstance(deployment, dict):
            raise AssertionError("adapter payload must contain a deployment attestation")
        candidate = request.get("qualifier")
        if candidate not in PUBLICATION_IDENTITIES:
            raise AssertionError(f"unexpected endpoint qualifier: {candidate!r}")
        package_candidate = self.cross_qualifier or candidate
        expected = PUBLICATION_IDENTITIES[package_candidate]
        expected_deployment = {
            "runtimeArn": RUNTIME_ARN,
            "runtimeVersion": expected["version"],
            "endpointName": package_candidate,
            "sourceRevision": expected["sourceRevision"],
            "artifactSha256": expected["artifactSha256"],
        }
        if self.cross_qualifier is None and deployment != expected_deployment:
            raise AssertionError(
                "the endpoint's fixed package must reject a crossed or forged deployment envelope"
            )
        # AgentCore resolves the named endpoint to an immutable Runtime version
        # whose environment/manifest carries that candidate's identity.  Keep
        # this endpoint-version detail in the transport fixture so the test
        # accepts the existing Runtime contract without changing ``main.py``.
        original_manifest = self.runtime_module.MANIFEST_PATH.read_text(encoding="utf-8")
        original_prompt_sha = self.runtime_module.PROMPT_SHA256
        manifest = json.loads(original_manifest)
        manifest["sourceRevision"] = expected["sourceRevision"]
        manifest["promptSha256"] = expected["promptSha256"]
        self.runtime_module.MANIFEST_PATH.write_text(json.dumps(manifest) + "\n", encoding="utf-8")
        self.runtime_module.PROMPT_SHA256 = expected["promptSha256"]
        runtime_environment = dict(self.runtime_environment)
        runtime_environment.update(
            {
                "AGENT_CANDIDATE_ID": package_candidate,
                "AGENT_ENDPOINT_NAME": package_candidate,
                "AGENT_SOURCE_REVISION": expected["sourceRevision"],
                "AGENT_ARTIFACT_SHA256": expected["artifactSha256"],
            }
        )
        with patch.dict(os.environ, runtime_environment):
            try:
                result = self.runtime_module.invoke(
                    decoded,
                    runtime_context(str(request.get("runtimeSessionId", "adapter-session"))),
                )
            finally:
                self.runtime_module.MANIFEST_PATH.write_text(original_manifest, encoding="utf-8")
                self.runtime_module.PROMPT_SHA256 = original_prompt_sha
        self.results.append(dict(result))
        if self.lose_next_reply:
            self.lose_next_reply = False
            raise ReadTimeoutError(endpoint_url="https://bedrock-agentcore.us-east-1.amazonaws.com")
        return {
            "response": io.BytesIO(json.dumps(result, separators=(",", ":")).encode("utf-8")),
            "statusCode": 200,
            "runtimeSessionId": request.get("runtimeSessionId"),
        }

    def __getattr__(self, name: str):
        raise AssertionError(f"adapter may only invoke AgentCore Runtime: {name}")


class AlarmAdapterRuntimeAcceptanceTests(unittest.TestCase):
    def _environment(self, *, legacy_static: bool) -> dict[str, str]:
        values = {
            "AGENT_SELECTION_TABLE": SELECTION_TABLE,
            "AGENT_RUNTIME_ARN": RUNTIME_ARN,
        }
        if legacy_static:
            # Deliberately keep stale static Runtime/adapter settings on the
            # faulty endpoint.  A repaired selection must win by server-read
            # tuple, not by changing these process values.
            values.update(
                {
                    "AGENT_RUNTIME_VERSION": "19",
                    "AGENT_ENDPOINT_NAME": "faulty",
                    "AGENT_SOURCE_REVISION": FAULTY_SOURCE_REVISION,
                    "AGENT_ARTIFACT_SHA256": FAULTY_ARTIFACT_SHA256,
                }
            )
        return values

    def _start(
        self,
        row: dict[str, object] | None,
        *,
        script: AgentScript | None = None,
        legacy_static: bool = True,
    ):
        """Return a managed stack for an integrated adapter/Runtime scenario."""

        boundary = SelectionBoundary(row)
        script = script or AgentScript(report=report())
        runtime_cm = isolated_runtime(script, boundary)
        runtime_module, _ = runtime_cm.__enter__()
        runtime_environment = {
            name: os.environ[name] for name in RUNTIME_ENV_NAMES if name in os.environ
        }
        env = self._environment(legacy_static=legacy_static)
        env_context = patch.dict(os.environ, env)
        env_context.__enter__()
        if not legacy_static:
            for name in set(RUNTIME_ENV_NAMES) | {"AGENT_RUNTIME_VERSION"}:
                if name == "AGENT_ALARM_ARN":
                    continue
                os.environ.pop(name, None)
        adapter_module = (
            importlib.reload(sys.modules["alarm_adapter"])
            if "alarm_adapter" in sys.modules
            else importlib.import_module("alarm_adapter")
        )
        boundary.runtime_bridge = RuntimeBridge(boundary, runtime_module, runtime_environment)
        boundary.runtime = boundary.runtime_bridge
        return env_context, runtime_cm, adapter_module, runtime_module, boundary, script

    @staticmethod
    def _stop(stack) -> None:
        env_context, runtime_cm, *_ = stack
        env_context.__exit__(None, None, None)
        runtime_cm.__exit__(None, None, None)

    @staticmethod
    def _call(adapter_module: object, event: dict[str, object]) -> dict[str, str]:
        result = adapter_module.handler(event, SimpleNamespace(aws_request_id="phase21-request"))
        if not isinstance(result, dict):
            raise AssertionError(f"adapter returned an unexpected response: {result!r}")
        return result

    @staticmethod
    def _request_deployment(boundary: SelectionBoundary, index: int = 0) -> dict[str, object]:
        payload = boundary.runtime_bridge.requests[index]["payload"]
        if isinstance(payload, bytes):
            payload = payload.decode("utf-8")
        return json.loads(payload)["deployment"]

    def test_one_strong_server_selection_read_routes_both_named_endpoints_and_claims_exact_identity(self):
        for candidate, version in (("faulty", "19"), ("repaired", "20")):
            with self.subTest(candidate=candidate):
                stack = self._start(_selection_tuple(candidate, version=version))
                try:
                    if candidate == "repaired":
                        self.assertEqual("faulty", os.environ["AGENT_ENDPOINT_NAME"])
                    result = self._call(stack[2], alarm_event())
                    self.assertEqual("forwarded", result["status"], result)
                    self.assertEqual("complete", stack[4].runtime_bridge.results[0]["status"])
                    self.assertEqual(1, len(stack[4].selection.reads))
                    self.assertEqual(
                        {"pk": SELECTION_PK},
                        stack[4].selection.reads[0]["Key"],
                    )
                    self.assertEqual(set(_selection_tuple(candidate)), set(stack[4].selection.row))
                    deployment = self._request_deployment(stack[4])
                    self.assertEqual(DEPLOYMENT_FIELDS, deployment.keys())
                    self.assertEqual(RUNTIME_ARN, deployment["runtimeArn"])
                    self.assertEqual(version, deployment["runtimeVersion"])
                    self.assertEqual(candidate, deployment["endpointName"])
                    identity = PUBLICATION_IDENTITIES[candidate]
                    self.assertEqual(identity["sourceRevision"], deployment["sourceRevision"])
                    self.assertEqual(identity["artifactSha256"], deployment["artifactSha256"])
                    self.assertEqual(1, len(stack[4].runs.rows))
                    row = next(iter(stack[4].runs.rows.values()))
                    self.assertEqual(candidate, row["candidateId"])
                    self.assertEqual(candidate, row["endpointName"])
                    self.assertEqual(version, row["runtimeVersion"])
                    self.assertEqual(identity["sourceRevision"], row["sourceRevision"])
                    self.assertEqual(identity["artifactSha256"], row["artifactSha256"])
                    self.assertEqual(1, stack[5].invocations)
                finally:
                    self._stop(stack)

    def test_cold_adapter_start_uses_selection_with_legacy_route_settings_absent(self):
        stack = self._start(_selection_tuple("repaired", version="20"), legacy_static=False)
        try:
            for name in (
                "AGENT_RUNTIME_VERSION",
                "AGENT_ENDPOINT_NAME",
                "AGENT_CANDIDATE_ID",
                "AGENT_SOURCE_REVISION",
                "AGENT_ARTIFACT_SHA256",
            ):
                self.assertNotIn(name, os.environ)
            result = self._call(stack[2], alarm_event())
            self.assertEqual("forwarded", result["status"], result)
            self.assertEqual("complete", stack[4].runtime_bridge.results[0]["status"])
            row = next(iter(stack[4].runs.rows.values()))
            self.assertEqual("repaired", row["candidateId"])
        finally:
            self._stop(stack)

    def test_configured_cloud_validation_rejects_before_selection_or_runtime(self):
        invalid_events = (
            {**alarm_event(), "source": "not-cloudwatch"},
            {**alarm_event(), "accountId": "999999999999"},
            {**alarm_event(), "region": "us-west-2"},
            alarm_event(alarm_arn="arn:aws:cloudwatch:us-east-1:123456789012:alarm:Other"),
            alarm_event(state="OK"),
            alarm_event(timestamp="2026-11-18T00:00:00"),
        )
        for event in invalid_events:
            with self.subTest(event=event):
                stack = self._start(_selection_tuple("repaired", version="20"))
                try:
                    result = self._call(stack[2], event)
                    self.assertEqual("rejected", result["status"], result)
                    self.assertEqual([], stack[4].selection.reads)
                    self.assertEqual([], stack[4].runtime_bridge.requests)
                    self.assertEqual({}, stack[4].runs.rows)
                    self.assertEqual(0, stack[5].invocations)
                finally:
                    self._stop(stack)

    def test_crossed_qualifier_and_envelope_is_rejected_by_the_fixed_runtime_package(self):
        stack = self._start(_selection_tuple("repaired", version="20"))
        try:
            self.assertEqual("repaired", stack[4].selection.row["endpointName"])
            stack[4].runtime_bridge.cross_qualifier = "faulty"
            result = self._call(stack[2], alarm_event())
            # AgentCore accepted the invocation transport, but the package
            # bound to the crossed qualifier rejected the mismatched envelope;
            # no shared claim or inference is allowed.
            self.assertEqual("forwarded", result["status"], result)
            self.assertEqual("rejected", stack[4].runtime_bridge.results[0]["status"])
            self.assertEqual({}, stack[4].runs.rows)
            self.assertEqual(0, stack[5].invocations)
        finally:
            self._stop(stack)

    def test_missing_or_malformed_selection_fails_closed_without_claim(self):
        missing_repaired_review = _selection_tuple("repaired", version="20")
        del missing_repaired_review["reviewManifestSha256"]
        malformed_rows = (
            None,
            {},
            missing_repaired_review,
            {**_selection_tuple("repaired", version="20"), "candidateId": "faulty"},
            {**_selection_tuple("repaired", version="20"), "endpointName": "faulty"},
            {**_selection_tuple("repaired", version="20"), "runtimeVersion": "not-verified"},
            {**_selection_tuple("repaired", version="20"), "artifactSha256": "short"},
            {
                **_selection_tuple("repaired", version="20"),
                "runtimeArn": "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/Other",
            },
        )
        for row in malformed_rows:
            with self.subTest(row=row):
                stack = self._start(row)
                try:
                    result = self._call(stack[2], alarm_event())
                    self.assertIn(result.get("status"), {"rejected", "failed"}, result)
                    self.assertEqual(1, len(stack[4].selection.reads))
                    self.assertEqual([], stack[4].runtime_bridge.requests)
                    self.assertEqual({}, stack[4].runs.rows)
                    self.assertEqual(0, stack[5].invocations)
                finally:
                    self._stop(stack)

    def test_transient_selection_read_error_is_retryable_before_runtime_and_retry_returns_terminal_result(self):
        stack = self._start(_selection_tuple("repaired", version="20"))
        try:
            stack[4].selection.read_error = ReadTimeoutError(
                endpoint_url="https://dynamodb.us-east-1.amazonaws.com"
            )
            with self.assertRaises(ReadTimeoutError):
                self._call(stack[2], alarm_event())
            self.assertEqual(1, len(stack[4].selection.reads))
            self.assertEqual([], stack[4].runtime_bridge.requests)
            self.assertEqual({}, stack[4].runs.rows)

            stack[4].selection.read_error = None
            result = self._call(stack[2], alarm_event())
            self.assertEqual("forwarded", result["status"], result)
            self.assertEqual(2, len(stack[4].selection.reads))
            self.assertEqual("complete", stack[4].runtime_bridge.results[0]["status"])
            row = next(iter(stack[4].runs.rows.values()))
            self.assertEqual("repaired", row["candidateId"])
        finally:
            self._stop(stack)

    def test_duplicate_redelivery_after_switch_returns_original_claim_without_inference(self):
        stack = self._start(_selection_tuple("faulty", version="19"))
        try:
            first = self._call(stack[2], alarm_event())
            original = copy.deepcopy(next(iter(stack[4].runs.rows.values())))
            stack[4].selection.row = _selection_tuple("repaired", version="20")
            second = self._call(stack[2], alarm_event())
            self.assertEqual("forwarded", first["status"])
            self.assertEqual("forwarded", second["status"])
            self.assertEqual(2, len(stack[4].selection.reads))
            self.assertEqual("repaired", self._request_deployment(stack[4], 1)["endpointName"])
            self.assertEqual("duplicate", stack[4].runtime_bridge.results[1]["status"])
            self.assertEqual(original, next(iter(stack[4].runs.rows.values())))
            self.assertEqual("faulty", original["candidateId"])
            self.assertEqual(1, stack[5].invocations)
        finally:
            self._stop(stack)

    def test_stranded_claim_after_switch_is_not_restarted_or_rerouted(self):
        stack = self._start(_selection_tuple("faulty", version="19"), script=AgentScript())
        try:
            # A delivery that lost its response remains owned by the original
            # tuple.  It is not safe to reclaim it merely because selection
            # changed; the durable Runtime row is the source of truth.
            transition = "2026-11-09T23:10:00.000Z"
            stack[4].runs.seed(
                {
                    "pk": ALARM_ARN,
                    "sk": transition,
                    "alarmArn": ALARM_ARN,
                    "transitionAt": transition,
                    "runId": "stranded-run",
                    "runtimeSessionId": "old-session",
                    "candidateId": "faulty",
                    "endpointName": "faulty",
                    "runtimeArn": RUNTIME_ARN,
                    "runtimeVersion": "19",
                    "sourceRevision": FAULTY_SOURCE_REVISION,
                    "artifactSha256": FAULTY_ARTIFACT_SHA256,
                    "status": "running",
                    "startedAt": transition,
                }
            )
            stack[4].selection.row = _selection_tuple("repaired", version="20")
            result = self._call(stack[2], alarm_event())
            self.assertEqual("forwarded", result["status"], result)
            row = next(iter(stack[4].runs.rows.values()))
            self.assertEqual("stranded-run", row["runId"])
            self.assertEqual("running", row["status"])
            self.assertEqual("faulty", row["candidateId"])
            self.assertEqual("repaired", self._request_deployment(stack[4])["endpointName"])
            self.assertEqual("duplicate", stack[4].runtime_bridge.results[0]["status"])
            self.assertEqual(0, stack[5].invocations)
        finally:
            self._stop(stack)

    def test_in_flight_delivery_uses_selection_snapshot_before_switch(self):
        stack = self._start(_selection_tuple("faulty", version="19"))
        try:
            stack[4].selection.after_read = lambda: setattr(
                stack[4].selection, "row", _selection_tuple("repaired", version="20")
            )
            result = self._call(stack[2], alarm_event())
            self.assertEqual("forwarded", result["status"], result)
            self.assertEqual(1, len(stack[4].selection.reads))
            self.assertEqual("faulty", self._request_deployment(stack[4])["endpointName"])
            row = next(iter(stack[4].runs.rows.values()))
            self.assertEqual("faulty", row["candidateId"])
            self.assertEqual("faulty", row["endpointName"])
        finally:
            self._stop(stack)

    def test_unseen_delayed_event_uses_current_selection_but_retains_old_origin_time(self):
        stack = self._start(_selection_tuple("repaired", version="20"))
        try:
            delayed = alarm_event(timestamp="2026-11-18T00:00:00.000Z")
            fresh = alarm_event(timestamp="2026-11-18T00:05:00.000Z")
            self.assertEqual("forwarded", self._call(stack[2], delayed)["status"])
            self.assertEqual("forwarded", self._call(stack[2], fresh)["status"])
            self.assertEqual(2, len(stack[4].selection.reads))
            self.assertEqual(2, len(stack[4].runs.rows))
            rows = sorted(stack[4].runs.rows.values(), key=lambda row: row["transitionAt"])
            self.assertEqual("2026-11-18T00:00:00.000Z", rows[0]["transitionAt"])
            self.assertEqual("2026-11-18T00:05:00.000Z", rows[1]["transitionAt"])
            self.assertTrue(all(row["candidateId"] == "repaired" for row in rows))
            self.assertTrue(all(row["endpointName"] == "repaired" for row in rows))
            self.assertEqual(2, stack[5].invocations)
        finally:
            self._stop(stack)


if __name__ == "__main__":
    unittest.main()
