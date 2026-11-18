"""Acceptance for the fixed faulty-reference publisher operation.

The operation is exercised with small native-shaped SDK transports.  The
descriptor and all reference bytes live in a copied installation; the only
test substitution is the SDK session, so the tests do not add a production
override or call private helpers.
"""

from __future__ import annotations

import base64
import copy
from contextlib import ExitStack
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from botocore.exceptions import ClientError
from botocore.session import get_session
from botocore.validate import validate_parameters


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = "setup-faulty-reference.py"
REGION = "us-east-1"
ACCOUNT = "027224425948"
RUNTIME_ID = "IncidentTriageDemoAgent-Ab12Cd34E5"
CONTROL_MODEL = get_session().get_service_model("bedrock-agentcore-control")
RUNTIME_ARN = f"arn:aws:bedrock-agentcore:{REGION}:{ACCOUNT}:runtime/{RUNTIME_ID}"
ADAPTER_ARN = f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:IncidentTriageDemoAlarmAdapter"
ALARM_ARN = f"arn:aws:cloudwatch:{REGION}:{ACCOUNT}:alarm:IncidentTriageDemoAppStage5xx"
TABLE_NAME = "IncidentTriageDemoControllerRun"
PUBLICATION_PK = "AGENT_PUBLICATION#faulty"
MODEL_ID = "us.anthropic.claude-sonnet-4-6"
SOURCE_REVISION = "a" * 40


def effective_prompt_sha256() -> str:
    """Read the prompt identity the package builder writes for this checkout."""

    prompt_path = ROOT / "agent/prompt.py"
    spec = importlib.util.spec_from_file_location("phase19_effective_prompt", prompt_path)
    if spec is None or spec.loader is None:
        raise AssertionError("prompt fixture cannot be imported")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.PROMPT_SHA256


PROMPT_SHA256 = effective_prompt_sha256()


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def attr(value: str) -> dict[str, str]:
    return {"S": value}


def not_found(operation: str) -> ClientError:
    return ClientError(
        {"Error": {"Code": "ResourceNotFoundException", "Message": "not found"}},
        operation,
    )


class Body:
    def __init__(self, value: bytes):
        self.value = value

    def read(self, *_args, **_kwargs) -> bytes:
        return self.value


class NativeS3:
    """S3 GetObject shape for durable content-addressed bootstrap bytes."""

    def __init__(self, objects: dict[tuple[str, str, str], bytes]):
        self.objects = objects
        self.calls: list[dict[str, object]] = []

    def get_object(self, **request: object) -> dict[str, object]:
        self.calls.append(copy.deepcopy(request))
        key = (str(request["Bucket"]), str(request["Key"]), str(request.get("VersionId", "")))
        try:
            value = self.objects[key]
        except KeyError as error:
            raise not_found("GetObject") from error
        return {"Body": Body(value), "VersionId": key[2], "ContentLength": len(value)}


class NativeControl:
    """AgentCore control shape with latest, historical, and endpoint reads."""

    def __init__(self, expected: dict[str, object], *, historical: bool, stale_endpoint: bool = False, endpoint_present: bool = False, endpoint_version: str = "7", runtime_status: str = "READY", endpoint_error: bool = False, endpoint_create_lost: bool = False, runtime_update_lost: bool = False, endpoint_update_allowed: bool = False, endpoint_in_progress: bool = False):
        self.expected = expected
        self.calls: list[tuple[str, dict[str, object]]] = []
        self.runtime_updates: list[dict[str, object]] = []
        self.runtime_creates: list[dict[str, object]] = []
        self.endpoint_creates: list[dict[str, object]] = []
        self.endpoint_updates: list[dict[str, object]] = []
        self.stale_endpoint = stale_endpoint
        self.runtime_status = runtime_status
        self.endpoint_error = endpoint_error
        self.endpoint_create_lost = endpoint_create_lost
        self.runtime_update_lost = runtime_update_lost
        self.endpoint_update_allowed = endpoint_update_allowed
        self.endpoint_in_progress = endpoint_in_progress
        self.next_version = "10"
        self.runtimes = {"9": self._runtime("9", compatible=False)}
        if historical:
            self.runtimes["7"] = self._runtime("7", compatible=True)
        self.endpoints: dict[str, dict[str, object]] = {}
        if endpoint_present:
            self.endpoints["faulty"] = {
                "status": "UPDATING" if endpoint_in_progress else "READY", "liveVersion": endpoint_version, "targetVersion": endpoint_version,
                "agentRuntimeArn": RUNTIME_ARN,
                "agentRuntimeEndpointArn": RUNTIME_ARN + "/runtime-endpoint/faulty",
            }

    def _runtime(self, version: str, *, compatible: bool) -> dict[str, object]:
        if compatible:
            artifact = {"codeConfiguration": {
                "runtime": "PYTHON_3_13",
                "entryPoint": ["opentelemetry-instrument", "main.py"],
                "code": {"s3": {
                    "bucket": self.expected["artifact"]["bucket"],
                    "prefix": self.expected["artifact"]["key"],
                    "versionId": self.expected["artifact"]["versionId"],
                }},
            }}
            environment = copy.deepcopy(self.expected["runtimeEnvironment"])
        else:
            artifact = {"codeConfiguration": {
                "runtime": "PYTHON_3_13",
                "entryPoint": ["opentelemetry-instrument", "main.py"],
                "code": {"s3": {"bucket": "other-bucket", "prefix": "other.zip"}},
            }}
            environment = {"AGENT_CANDIDATE_ID": "repaired", "AGENT_SOURCE_REVISION": "other"}
        return {
            "agentRuntimeId": RUNTIME_ID,
            "agentRuntimeArn": RUNTIME_ARN,
            "agentRuntimeVersion": version,
            "status": self.runtime_status,
            "roleArn": f"arn:aws:iam::{ACCOUNT}:role/IncidentTriageDemoAgentRuntimeRole",
            "agentRuntimeArtifact": artifact,
            "environmentVariables": environment,
            "networkConfiguration": {"networkMode": "PUBLIC"},
            "protocolConfiguration": {"serverProtocol": "HTTP"},
            "lifecycleConfiguration": {"idleRuntimeSessionTimeout": 300, "maxLifetime": 600},
            "metadataConfiguration": {"requireMMDSV2": True},
        }

    def get_agent_runtime(self, **request: object) -> dict[str, object]:
        self.calls.append(("get_agent_runtime", copy.deepcopy(request)))
        version = str(request.get("agentRuntimeVersion", "9"))
        if version not in self.runtimes:
            raise not_found("GetAgentRuntime")
        return copy.deepcopy(self.runtimes[version])

    def list_agent_runtime_versions(self, **request: object) -> dict[str, object]:
        self.calls.append(("list_agent_runtime_versions", copy.deepcopy(request)))
        return {"agentRuntimes": [{"agentRuntimeVersion": version} for version in sorted(self.runtimes)]}

    def update_agent_runtime(self, **request: object) -> dict[str, object]:
        self.calls.append(("update_agent_runtime", copy.deepcopy(request)))
        self.runtime_updates.append(copy.deepcopy(request))
        version = self.next_version
        self.runtimes[version] = self._runtime(version, compatible=True)
        if self.runtime_update_lost:
            self.runtime_update_lost = False
            raise RuntimeError("runtime update response lost after commit")
        return {"agentRuntimeArn": RUNTIME_ARN, "agentRuntimeVersion": version}

    def create_agent_runtime(self, **request: object) -> dict[str, object]:
        self.calls.append(("create_agent_runtime", copy.deepcopy(request)))
        self.runtime_creates.append(copy.deepcopy(request))
        raise AssertionError("an existing Runtime must use UpdateAgentRuntime, never CreateAgentRuntime")

    def get_agent_runtime_endpoint(self, **request: object) -> dict[str, object]:
        self.calls.append(("get_agent_runtime_endpoint", copy.deepcopy(request)))
        if self.endpoint_error:
            raise ClientError({"Error": {"Code": "AccessDeniedException", "Message": "denied"}}, "GetAgentRuntimeEndpoint")
        endpoint = self.endpoints.get(str(request.get("endpointName", request.get("name"))))
        if endpoint is None:
            raise not_found("GetAgentRuntimeEndpoint")
        value = copy.deepcopy(endpoint)
        if self.stale_endpoint:
            value["liveVersion"] = "8"
        return value

    def create_agent_runtime_endpoint(self, **request: object) -> dict[str, object]:
        validate_parameters(request, CONTROL_MODEL.operation_model("CreateAgentRuntimeEndpoint").input_shape)
        self.calls.append(("create_agent_runtime_endpoint", copy.deepcopy(request)))
        self.endpoint_creates.append(copy.deepcopy(request))
        name = str(request["name"])
        version = str(request["agentRuntimeVersion"])
        arn = RUNTIME_ARN + f"/runtime-endpoint/{name}"
        self.endpoints[name] = {
            "status": "READY", "liveVersion": version,
            "agentRuntimeArn": RUNTIME_ARN, "agentRuntimeEndpointArn": arn,
        }
        if self.endpoint_create_lost:
            self.endpoint_create_lost = False
            raise RuntimeError("endpoint create response lost after commit")
        return {"agentRuntimeEndpointArn": arn}

    def update_agent_runtime_endpoint(self, **request: object) -> dict[str, object]:
        self.calls.append(("update_agent_runtime_endpoint", copy.deepcopy(request)))
        self.endpoint_updates.append(copy.deepcopy(request))
        if not self.endpoint_update_allowed:
            raise AssertionError("unexpected endpoint repin")
        self.endpoints["faulty"].update(status="READY", liveVersion=str(request["agentRuntimeVersion"]), targetVersion=str(request["agentRuntimeVersion"]))
        return copy.deepcopy(self.endpoints["faulty"])


class NativeLambda:
    def __init__(self, *, stale_reads: int = 0, stale_post_write: bool = False, fail_update_once: bool = False, update_lost: bool = False):
        self.stale_reads = stale_reads
        self.stale_post_write = stale_post_write
        self.post_write_stale_active = False
        self.fail_update_once = fail_update_once
        self.update_lost = update_lost
        self.calls: list[tuple[str, dict[str, object]]] = []
        self.updates: list[dict[str, object]] = []
        self.environment = {"AGENT_ENDPOINT_NAME": "faulty", "AGENT_RUNTIME_VERSION": "old"}
        self.config: dict[str, object] = {
            "LastUpdateStatus": "Successful", "FunctionArn": ADAPTER_ARN,
            "RevisionId": "adapter-revision-1",
            "CodeSha256": base64.b64encode(bytes.fromhex("b" * 64)).decode(),
            "TracingConfig": {"Mode": "Active"}, "Environment": {"Variables": copy.deepcopy(self.environment)},
        }

    def get_function_configuration(self, **request: object) -> dict[str, object]:
        self.calls.append(("get_function_configuration", copy.deepcopy(request)))
        value = copy.deepcopy(self.config)
        if self.post_write_stale_active:
            value["Environment"] = {"Variables": {"AGENT_ENDPOINT_NAME": "faulty", "AGENT_RUNTIME_VERSION": "old"}}
        elif self.stale_reads:
            self.stale_reads -= 1
            value["Environment"] = {"Variables": {"AGENT_ENDPOINT_NAME": "faulty", "AGENT_RUNTIME_VERSION": "old"}}
        return value

    def update_function_configuration(self, **request: object) -> dict[str, object]:
        self.calls.append(("update_function_configuration", copy.deepcopy(request)))
        self.updates.append(copy.deepcopy(request))
        if self.fail_update_once:
            self.fail_update_once = False
            raise RuntimeError("controlled adapter update failure")
        self.environment = copy.deepcopy(request["Environment"]["Variables"])
        self.config["Environment"] = {"Variables": copy.deepcopy(self.environment)}
        self.config["RevisionId"] = "adapter-revision-2"
        if self.stale_post_write:
            self.post_write_stale_active = True
        if self.update_lost:
            self.update_lost = False
            raise RuntimeError("adapter update response lost after commit")
        return copy.deepcopy(self.config)


class NativeController:
    def __init__(self, *, put_lost: bool = False, readback_wrong: bool = False):
        self.calls: list[tuple[str, dict[str, object]]] = []
        self.items: dict[str, dict[str, object]] = {}
        self.put_lost = put_lost
        self.readback_wrong = readback_wrong

    def get_item(self, **request: object) -> dict[str, object]:
        self.calls.append(("get_item", copy.deepcopy(request)))
        key = request["Key"]["pk"]["S"]
        if key not in self.items:
            return {}
        item = copy.deepcopy(self.items[key])
        if self.readback_wrong:
            item["status"] = attr("wrong")
        return {"Item": item}

    def put_item(self, **request: object) -> dict[str, object]:
        self.calls.append(("put_item", copy.deepcopy(request)))
        item = request["Item"]
        self.items[item["pk"]["S"]] = copy.deepcopy(item)
        if self.put_lost:
            self.put_lost = False
            raise RuntimeError("prepared-record response lost after commit")
        return {}


class NativeCloudFormation:
    def __init__(self, adapter_code_sha: str | None = None, extra_outputs: list[dict[str, str]] | None = None):
        self.calls: list[tuple[str, dict[str, object]]] = []
        self.adapter_code_sha = adapter_code_sha
        self.extra_outputs = extra_outputs or []

    def describe_stacks(self, **request: object) -> dict[str, object]:
        self.calls.append(("describe_stacks", copy.deepcopy(request)))
        outputs: list[dict[str, str]] = [{"OutputKey": "RuntimeId", "OutputValue": RUNTIME_ID}]
        if self.adapter_code_sha is not None:
            outputs.append({"OutputKey": "AlarmAdapterCodeSha256", "OutputValue": self.adapter_code_sha})
        outputs.extend(copy.deepcopy(self.extra_outputs))
        return {"Stacks": [{"Outputs": outputs}]}


class NativePreflightCloudFormation(NativeCloudFormation):
    def __init__(self, adapter_code_sha: str | None = None, extra_outputs: list[dict[str, str]] | None = None):
        super().__init__(adapter_code_sha, extra_outputs)

    def describe_stacks(self, **request: object) -> dict[str, object]:
        self.calls.append(("describe_stacks", copy.deepcopy(request)))
        outputs: list[dict[str, str]] = [{"OutputKey": "RuntimeId", "OutputValue": RUNTIME_ID}]
        if self.adapter_code_sha is not None:
            outputs.append({"OutputKey": "AlarmAdapterCodeSha256", "OutputValue": self.adapter_code_sha})
        outputs.extend(copy.deepcopy(self.extra_outputs))
        return {"Stacks": [{
            "StackId": f"arn:aws:cloudformation:{REGION}:{ACCOUNT}:stack/IncidentTriageDemoAgent/id",
            "StackStatus": "UPDATE_COMPLETE",
            "Outputs": outputs,
        }]}

    def list_stack_resources(self, **request: object) -> dict[str, object]:
        self.calls.append(("list_stack_resources", copy.deepcopy(request)))
        return {"StackResourceSummaries": [
            {"LogicalResourceId": "Runtime", "PhysicalResourceId": RUNTIME_ID, "ResourceType": "AWS::BedrockAgentCore::Runtime"},
            {"LogicalResourceId": "FaultyEndpoint", "PhysicalResourceId": RUNTIME_ARN + "/runtime-endpoint/faulty", "ResourceType": "AWS::BedrockAgentCore::RuntimeEndpoint"},
        ]}


class NativeSTS:
    def __init__(self):
        self.calls: list[tuple[str, dict[str, object]]] = []

    def get_caller_identity(self, **request: object) -> dict[str, object]:
        self.calls.append(("get_caller_identity", copy.deepcopy(request)))
        return {"Account": ACCOUNT, "Arn": f"arn:aws:iam::{ACCOUNT}:role/phase19-test"}

class NativeSession:
    def __init__(self, s3, control, adapter, controller, cloudformation):
        self.clients = {"s3": s3, "bedrock-agentcore-control": control, "lambda": adapter, "dynamodb": controller, "cloudformation": cloudformation}

    def client(self, name: str, **_kwargs: object):
        return self.clients[name]


class FaultyReferenceAcceptance(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.install = self.root / "installation"
        self.scripts = self.install / "scripts"
        self.scripts.mkdir(parents=True)
        manifest = json.loads((ROOT / "agent/agent-manifest.json").read_text())
        manifest["sourceRevision"] = SOURCE_REVISION
        # The package builder computes the manifest identity from prompt.py;
        # do the same for this disposable archive instead of pairing a
        # materialized repaired prompt with the stale development manifest.
        manifest["promptSha256"] = PROMPT_SHA256
        self.manifest_bytes = (json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n").encode()
        self.source_bytes = (ROOT / "agent/prompt.py").read_bytes()
        self.runtime_environment = {
            "AGENT_RUN_TABLE": "IncidentTriageDemoAgentRun",
            "AGENT_SOURCE_BUCKET": f"incident-triage-demo-evidence-{ACCOUNT}-{REGION}",
            "AGENT_SOURCE_PREFIX": "agent-source/",
            "AGENT_ALARM_ARN": ALARM_ARN,
            "AGENT_MODEL_ID": MODEL_ID,
            "AGENT_ACCOUNT_ID": ACCOUNT,
            "AGENT_REGION": REGION,
            "AGENT_CANDIDATE_ID": "faulty",
            "AGENT_SOURCE_REVISION": SOURCE_REVISION,
            "AGENT_ARTIFACT_SHA256": "pending",
            "AGENT_ENDPOINT_NAME": "faulty",
            "AGENT_APP_HTTP_API_ID": "api123",
        }
        archive_io = io.BytesIO()
        with zipfile.ZipFile(archive_io, "w", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr("agent-manifest.json", self.manifest_bytes)
            archive.writestr("prompt.py", self.source_bytes)
        self.archive_bytes = archive_io.getvalue()
        self.runtime_environment["AGENT_ARTIFACT_SHA256"] = sha256(self.archive_bytes)
        self.runtime_configuration = {
            "agentRuntimeArtifact": {"codeConfiguration": {
                "runtime": "PYTHON_3_13",
                "entryPoint": ["opentelemetry-instrument", "main.py"],
                "code": {"s3": {"bucket": f"cdk-evaltalk-assets-{ACCOUNT}-{REGION}", "prefix": f"agent-reference/{sha256(self.archive_bytes)}.zip", "versionId": "bootstrap-version-1"}},
            }},
            "roleArn": f"arn:aws:iam::{ACCOUNT}:role/IncidentTriageDemoAgentRuntimeRole",
            "environmentVariables": self.runtime_environment,
            "networkConfiguration": {"networkMode": "PUBLIC"},
            "protocolConfiguration": {"serverProtocol": "HTTP"},
            "lifecycleConfiguration": {"idleRuntimeSessionTimeout": 300, "maxLifetime": 600},
            "metadataConfiguration": {"requireMMDSV2": True},
        }
        self.config_bytes = (json.dumps({
            **self.runtime_configuration,
        }, sort_keys=True, separators=(",", ":")) + "\n").encode()
        self.bucket = f"cdk-evaltalk-assets-{ACCOUNT}-{REGION}"
        self.archive_key = f"agent-reference/{sha256(self.archive_bytes)}.zip"
        self.source_key = f"agent-reference/{sha256(self.source_bytes)}.py"
        self.config_key = f"agent-reference/{sha256(self.config_bytes)}.json"
        self.archive_version = "bootstrap-version-1"
        self.descriptor = {
            "schemaVersion": 1, "candidateId": "faulty", "runtimeName": "IncidentTriageDemoAgent", "endpointName": "faulty",
            "artifact": {"bucket": self.bucket, "key": self.archive_key, "versionId": self.archive_version, "sha256": sha256(self.archive_bytes)},
            "source": {"bucket": self.bucket, "key": self.source_key, "sha256": sha256(self.source_bytes)},
            "configuration": {"bucket": self.bucket, "key": self.config_key, "sha256": sha256(self.config_bytes)},
            "sourceRevision": SOURCE_REVISION, "promptSha256": PROMPT_SHA256, "modelId": MODEL_ID, "alarmArn": ALARM_ARN,
            "controller": {"tableName": TABLE_NAME, "pk": PUBLICATION_PK},
            "runtimeEnvironment": self.runtime_environment,
            "runtimeConfiguration": self.runtime_configuration,
            "adapter": {"functionArn": ADAPTER_ARN, "functionName": "IncidentTriageDemoAlarmAdapter", "codeSha256": "b" * 64, "tracingMode": "Active"},
        }
        descriptor_path = self.scripts / "faulty-reference.json"
        descriptor_path.write_text(json.dumps(self.descriptor, sort_keys=True) + "\n")
        self.s3 = NativeS3({
            (self.bucket, self.archive_key, self.archive_version): self.archive_bytes,
            (self.bucket, self.source_key, ""): self.source_bytes,
            (self.bucket, self.config_key, ""): self.config_bytes,
        })
        self.expected_environment = {
            "AGENT_RUNTIME_ARN": RUNTIME_ARN, "AGENT_ENDPOINT_NAME": "faulty", "AGENT_RUNTIME_VERSION": "7",
            "AGENT_ALARM_ARN": ALARM_ARN, "AGENT_SOURCE_REVISION": SOURCE_REVISION,
            "AGENT_ARTIFACT_SHA256": sha256(self.archive_bytes),
        }
        self.control = self.adapter = self.controller = None
        self.module_counter = 0

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _script_path(self) -> Path:
        path = ROOT / "scripts" / SCRIPT
        self.assertTrue(path.is_file(), f"{SCRIPT} is missing")
        return path

    def _load(self):
        source = self._script_path()
        target = self.scripts / source.name
        shutil.copy2(source, target)
        self.module_counter += 1
        spec = importlib.util.spec_from_file_location(f"phase19_reference_{self.module_counter}", target)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def _native(self, *, historical: bool = True, stale_endpoint: bool = False, endpoint_present: bool = False, endpoint_version: str = "7", runtime_status: str = "READY", endpoint_error: bool = False, endpoint_create_lost: bool = False, runtime_update_lost: bool = False, endpoint_update_allowed: bool = False, endpoint_in_progress: bool = False, stale_adapter: int = 0, stale_post_write: bool = False, fail_update_once: bool = False, adapter_update_lost: bool = False, record_put_lost: bool = False, record_readback_wrong: bool = False):
        self.control = NativeControl(self.descriptor, historical=historical, stale_endpoint=stale_endpoint, endpoint_present=endpoint_present, endpoint_version=endpoint_version, runtime_status=runtime_status, endpoint_error=endpoint_error, endpoint_create_lost=endpoint_create_lost, runtime_update_lost=runtime_update_lost, endpoint_update_allowed=endpoint_update_allowed, endpoint_in_progress=endpoint_in_progress)
        self.adapter = NativeLambda(stale_reads=stale_adapter, stale_post_write=stale_post_write, fail_update_once=fail_update_once, update_lost=adapter_update_lost)
        self.controller = NativeController(put_lost=record_put_lost, readback_wrong=record_readback_wrong)
        self.cloudformation = NativeCloudFormation()
        return self.control, self.adapter, self.controller

    def _call_operation(self, module, control, adapter, controller):
        operation = getattr(module, "setup_faulty_reference", None)
        self.assertIsNotNone(operation, "the helper must expose setup_faulty_reference as a public operation")
        session = NativeSession(self.s3, control, adapter, controller, self.cloudformation)
        with ExitStack() as stack:
            if hasattr(module, "time"):
                stack.enter_context(patch.object(module.time, "sleep", return_value=None))
            return operation(session)

    def _operation(self, *, historical=True, stale_endpoint=False, endpoint_present=False, endpoint_version="7", runtime_status="READY", endpoint_error=False, endpoint_create_lost=False, runtime_update_lost=False, endpoint_update_allowed=False, endpoint_in_progress=False, stale_adapter=0, stale_post_write=False, fail_update_once=False, adapter_update_lost=False, record_put_lost=False, record_readback_wrong=False):
        control, adapter, controller = self._native(historical=historical, stale_endpoint=stale_endpoint, endpoint_present=endpoint_present, endpoint_version=endpoint_version, runtime_status=runtime_status, endpoint_error=endpoint_error, endpoint_create_lost=endpoint_create_lost, runtime_update_lost=runtime_update_lost, endpoint_update_allowed=endpoint_update_allowed, endpoint_in_progress=endpoint_in_progress, stale_adapter=stale_adapter, stale_post_write=stale_post_write, fail_update_once=fail_update_once, adapter_update_lost=adapter_update_lost, record_put_lost=record_put_lost, record_readback_wrong=record_readback_wrong)
        module = self._load()
        return self._call_operation(module, control, adapter, controller), module

    def _run_cli(self, args: list[str]):
        module = self._load()
        control, adapter, controller = self._native()
        session = NativeSession(self.s3, control, adapter, controller, self.cloudformation)
        with ExitStack() as stack:
            stack.enter_context(patch.object(module.boto3, "Session", return_value=session))
            stack.enter_context(patch.object(sys, "argv", [str(self.scripts / self._script_path().name), *args]))
            try:
                result = module.main()
            except SystemExit as exc:
                result = exc.code
        return result, control, adapter, controller

    def test_fixed_cli_entrypoint_rejects_caller_overrides_before_sdk_session(self):
        self.assertTrue((ROOT / "scripts" / SCRIPT).is_file())
        for args in (["--candidate", "repaired"], ["--endpoint-name", "repaired"], ["--archive-key", "other.zip"], ["preflight", "--candidate", "repaired"]):
            with self.subTest(args=args):
                result, control, adapter, controller = self._run_cli(args)
                self.assertNotEqual(result, 0)
                self.assertFalse(control.calls)
                self.assertFalse(adapter.calls)
                self.assertFalse(controller.calls)

    def test_historical_compatible_runtime_is_reused_and_faulty_endpoint_is_created(self):
        self._operation(historical=True)
        self.assertTrue(self.cloudformation.calls)
        self.assertEqual("IncidentTriageDemoAgent", self.cloudformation.calls[0][1]["StackName"])
        create = self.control.endpoint_creates
        self.assertEqual(1, len(create))
        self.assertEqual("faulty", create[0].get("name", create[0].get("endpointName")))
        self.assertEqual("7", create[0]["agentRuntimeVersion"])
        self.assertFalse(self.control.runtime_updates)
        self.assertFalse(self.control.runtime_creates)
        listed = [call for name, call in self.control.calls if name == "list_agent_runtime_versions"]
        self.assertTrue(listed, "historical reuse must discover versions through the native list operation")
        self.assertIn("7", {row["agentRuntimeVersion"] for row in self.control.runtimes.values()})
        self.assertNotEqual(self.control.runtimes["9"]["environmentVariables"], self.descriptor["runtimeEnvironment"])
        self.assertEqual("7", self.controller.items[PUBLICATION_PK]["runtimeVersion"]["S"])
        self.assertEqual("reference", self.controller.items[PUBLICATION_PK]["status"]["S"])
        artifact_reads = [call for call in self.s3.calls if call["Key"] == self.archive_key]
        self.assertEqual(1, len(artifact_reads))
        self.assertEqual(self.archive_version, artifact_reads[0]["VersionId"])

    def test_no_compatible_version_updates_runtime_from_verified_s3_bytes(self):
        self._operation(historical=False)
        self.assertEqual(1, len(self.control.runtime_updates))
        self.assertFalse(self.control.runtime_creates)
        mutation = self.control.runtime_updates[0]
        self.assertIn(self.archive_key, json.dumps(mutation, sort_keys=True))
        self.assertIn(self.archive_version, json.dumps(mutation, sort_keys=True))
        validate_parameters(mutation, CONTROL_MODEL.operation_model("UpdateAgentRuntime").input_shape)
        self.assertEqual(RUNTIME_ID, mutation["agentRuntimeId"])
        normalized = {key: mutation[key] for key in self.descriptor["runtimeConfiguration"]}
        self.assertEqual(self.descriptor["runtimeConfiguration"], normalized)
        config = json.loads(self.config_bytes)
        self.assertEqual(config, self.descriptor["runtimeConfiguration"])
        self.assertEqual("10", self.control.endpoint_creates[0]["agentRuntimeVersion"])
        self.assertEqual("10", self.controller.items[PUBLICATION_PK]["runtimeVersion"]["S"])
        artifact_reads = [call for call in self.s3.calls if call["Key"] == self.archive_key]
        self.assertEqual(1, len(artifact_reads))
        self.assertEqual(self.archive_version, artifact_reads[0]["VersionId"])

    def test_manifest_source_config_and_full_publication_tuple_are_attested(self):
        self._operation(historical=True)
        self.assertEqual({self.archive_key, self.source_key, self.config_key}, {call["Key"] for call in self.s3.calls})
        with zipfile.ZipFile(io.BytesIO(self.archive_bytes)) as archive:
            manifest = json.loads(archive.read("agent-manifest.json"))
            self.assertEqual(SOURCE_REVISION, manifest["sourceRevision"])
            self.assertEqual(PROMPT_SHA256, manifest["promptSha256"])
        item = self.controller.items[PUBLICATION_PK]
        expected = {
            "candidateId": "faulty", "sourceRevision": SOURCE_REVISION, "promptSha256": PROMPT_SHA256,
            "modelId": MODEL_ID, "artifactSha256": sha256(self.archive_bytes), "runtimeArn": RUNTIME_ARN,
            "runtimeVersion": "7", "endpointName": "faulty", "endpointArn": RUNTIME_ARN + "/runtime-endpoint/faulty",
            "alarmArn": ALARM_ARN, "sourceSha256": sha256(self.source_bytes),
            "configurationSha256": sha256(self.config_bytes), "status": "reference",
        }
        for key, value in expected.items():
            with self.subTest(key=key):
                self.assertEqual(attr(value), item[key])
        self.assertNotIn("controllerPublicKey", item)
        self.assertEqual(self.expected_environment, self.adapter.environment)

    def test_production_archive_shape_checks_source_manifest_modules_and_lock(self):
        module = self._load()
        module_bytes = {
            name: (ROOT / "agent" / name).read_bytes()
            for name in ("main.py", "investigation.py", "evidence.py", "prompt.py")
        }
        lock_bytes = (ROOT / "agent" / "uv.lock").read_bytes()
        archive_io = io.BytesIO()
        with zipfile.ZipFile(archive_io, "w", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr("agent-manifest.json", self.manifest_bytes)
            for name, value in module_bytes.items():
                archive.writestr(name, value)
            archive.writestr("uv.lock", lock_bytes)
        descriptor = copy.deepcopy(self.descriptor)
        descriptor["sourceManifest"] = {
            "bucket": self.bucket,
            "key": "agent-reference/manifest.json",
            "versionId": "manifest-version-1",
            "sha256": sha256(self.manifest_bytes),
        }
        descriptor["lock"] = {
            "bucket": self.bucket,
            "key": "agent-reference/uv.lock",
            "versionId": "lock-version-1",
            "sha256": sha256(lock_bytes),
        }
        descriptor["lockArchivePath"] = "uv.lock"
        descriptor["provenance"] = {"originalRevision": SOURCE_REVISION, "lockSha256": sha256(lock_bytes)}
        descriptor["packagedModules"] = {name: {"sha256": sha256(value)} for name, value in module_bytes.items()}
        archive_bytes = archive_io.getvalue()
        module._validate_descriptor(descriptor)
        module._validate_archive(archive_bytes, descriptor, self.source_bytes, self.manifest_bytes, lock_bytes)
        tampered = archive_bytes.replace(module_bytes["evidence.py"], b"tampered evidence", 1)
        with self.assertRaises(ValueError):
            module._validate_archive(tampered, descriptor, self.source_bytes, self.manifest_bytes, lock_bytes)

    def test_full_preflight_is_read_only_and_checks_live_scope_rollback_and_adapter(self):
        module = self._load()
        control, adapter, controller = self._native(historical=True, endpoint_present=True)
        adapter.environment = {
            "AGENT_RUNTIME_ARN": RUNTIME_ARN,
            "AGENT_ENDPOINT_NAME": "faulty",
            "AGENT_RUNTIME_VERSION": "7",
            "AGENT_ALARM_ARN": ALARM_ARN,
            "AGENT_SOURCE_REVISION": SOURCE_REVISION,
            "AGENT_ARTIFACT_SHA256": sha256(self.archive_bytes),
        }
        adapter.config["Environment"] = {"Variables": copy.deepcopy(adapter.environment)}
        preflight_session = NativeSession(self.s3, control, adapter, controller, NativePreflightCloudFormation())
        preflight_session.clients["sts"] = NativeSTS()
        result = module.preflight_faulty_reference(preflight_session)
        self.assertEqual("ready", result["status"])
        self.assertTrue(result["trustedRollback"]["eligible"])
        self.assertEqual("7", result["trustedRollback"]["runtimeVersion"])
        self.assertEqual("b" * 64, result["adapter"]["codeSha256"])
        self.assertEqual("descriptor", result["adapter"]["expectedCodeSource"])
        self.assertFalse(control.runtime_updates)
        self.assertFalse(control.endpoint_creates)
        self.assertFalse(adapter.updates)
        self.assertFalse(controller.items)

    def test_stack_adapter_output_overrides_archive_sha_for_legitimate_adapter_release(self):
        module = self._load()
        control, adapter, controller = self._native(historical=True, endpoint_present=True)
        deployed_adapter_sha = "c" * 64
        adapter.config["CodeSha256"] = base64.b64encode(bytes.fromhex(deployed_adapter_sha)).decode()
        adapter.environment = {
            "AGENT_RUNTIME_ARN": RUNTIME_ARN,
            "AGENT_ENDPOINT_NAME": "faulty",
            "AGENT_RUNTIME_VERSION": "7",
            "AGENT_ALARM_ARN": ALARM_ARN,
            "AGENT_SOURCE_REVISION": SOURCE_REVISION,
            "AGENT_ARTIFACT_SHA256": sha256(self.archive_bytes),
        }
        adapter.config["Environment"] = {"Variables": copy.deepcopy(adapter.environment)}
        preflight_session = NativeSession(self.s3, control, adapter, controller, NativePreflightCloudFormation(deployed_adapter_sha))
        preflight_session.clients["sts"] = NativeSTS()
        result = module.preflight_faulty_reference(preflight_session)
        self.assertEqual("ready", result["status"])
        self.assertEqual(deployed_adapter_sha, result["adapter"]["codeSha256"])
        self.assertEqual(deployed_adapter_sha, result["adapter"]["expectedCodeSha256"])
        self.assertEqual("stack", result["adapter"]["expectedCodeSource"])

    def test_stack_adapter_output_rejects_unknown_native_code_drift(self):
        module = self._load()
        control, adapter, controller = self._native(historical=True, endpoint_present=True)
        adapter.environment = {
            "AGENT_RUNTIME_ARN": RUNTIME_ARN,
            "AGENT_ENDPOINT_NAME": "faulty",
            "AGENT_RUNTIME_VERSION": "7",
            "AGENT_ALARM_ARN": ALARM_ARN,
            "AGENT_SOURCE_REVISION": SOURCE_REVISION,
            "AGENT_ARTIFACT_SHA256": sha256(self.archive_bytes),
        }
        adapter.config["Environment"] = {"Variables": copy.deepcopy(adapter.environment)}
        preflight_session = NativeSession(self.s3, control, adapter, controller, NativePreflightCloudFormation("c" * 64))
        preflight_session.clients["sts"] = NativeSTS()
        with self.assertRaisesRegex(RuntimeError, "code"):
            module.preflight_faulty_reference(preflight_session)
        self.assertFalse(adapter.updates)
        self.assertFalse(controller.items)

    def test_setup_uses_deployed_stack_adapter_output_for_publication_record(self):
        deployed_adapter_sha = "c" * 64
        control, adapter, controller = self._native(historical=True)
        adapter.config["CodeSha256"] = base64.b64encode(bytes.fromhex(deployed_adapter_sha)).decode()
        self.cloudformation = NativeCloudFormation(deployed_adapter_sha)
        module = self._load()
        self._call_operation(module, control, adapter, controller)
        self.assertEqual(attr(deployed_adapter_sha), controller.items[PUBLICATION_PK]["adapterCodeSha256"])
        self.assertEqual("reference", controller.items[PUBLICATION_PK]["status"]["S"])

    def test_fresh_stack_empty_publication_outputs_are_ignored_by_setup(self):
        control, adapter, controller = self._native(historical=True)
        self.cloudformation = NativeCloudFormation(extra_outputs=[
            {"OutputKey": "PublishedVersion", "OutputValue": ""},
            {"OutputKey": "PublishedCodeRevision", "OutputValue": ""},
            {"OutputKey": "PublishedArtifactSha256", "OutputValue": ""},
        ])
        module = self._load()
        self.assertEqual({"RuntimeId": RUNTIME_ID}, module._stack_outputs(self.cloudformation, module.STACK_NAME))
        self._call_operation(module, control, adapter, controller)
        self.assertEqual("reference", controller.items[PUBLICATION_PK]["status"]["S"])

    def test_preflight_reports_reconcilable_endpoint_adapter_version_gap(self):
        module = self._load()
        control, adapter, controller = self._native(historical=True, endpoint_present=True, endpoint_version="10")
        control.runtimes["10"] = control._runtime("10", compatible=True)
        adapter.environment = {
            "AGENT_RUNTIME_ARN": RUNTIME_ARN,
            "AGENT_ENDPOINT_NAME": "faulty",
            "AGENT_RUNTIME_VERSION": "7",
            "AGENT_ALARM_ARN": ALARM_ARN,
            "AGENT_SOURCE_REVISION": SOURCE_REVISION,
            "AGENT_ARTIFACT_SHA256": sha256(self.archive_bytes),
        }
        adapter.config["Environment"] = {"Variables": copy.deepcopy(adapter.environment)}
        preflight_session = NativeSession(self.s3, control, adapter, controller, NativePreflightCloudFormation())
        preflight_session.clients["sts"] = NativeSTS()
        result = module.preflight_faulty_reference(preflight_session)
        self.assertEqual("partial", result["status"])
        self.assertFalse(result["trustedRollback"]["eligible"])
        self.assertEqual({"endpointVersion": "10", "adapterVersion": "7", "adapterRuntimeArn": RUNTIME_ARN, "adapterRuntimeStatus": "READY", "needsAdapterUpdate": True}, result["partialBinding"])
        with self.assertRaises(RuntimeError):
            module.preflight_faulty_reference(preflight_session, require_rollback=True)
        self.assertFalse(control.runtime_updates)
        self.assertFalse(control.endpoint_updates)
        self.assertFalse(adapter.updates)

    def test_optional_target_version_is_not_required_when_live_version_is_ready(self):
        self._operation(historical=True)
        self.assertNotIn("targetVersion", self.control.endpoints["faulty"])
        self.assertEqual("reference", self.controller.items[PUBLICATION_PK]["status"]["S"])

    def test_existing_faulty_endpoint_is_verified_without_moving_any_pin(self):
        self._operation(historical=True, endpoint_present=True)
        self.assertFalse(self.control.endpoint_creates)
        self.assertFalse(self.control.endpoint_updates)
        self.assertEqual("7", self.control.endpoints["faulty"]["liveVersion"])

    def test_healthy_repeat_reuses_exact_publication_and_strong_readback(self):
        control, adapter, controller = self._native(historical=True, endpoint_present=True)
        module = self._load()
        first = self._call_operation(module, control, adapter, controller)
        first_item = copy.deepcopy(controller.items[PUBLICATION_PK])
        first_puts = len([call for call in controller.calls if call[0] == "put_item"])
        first_adapter_updates = len(adapter.updates)
        second = self._call_operation(module, control, adapter, controller)
        self.assertEqual(first, second)
        self.assertEqual(first_item, controller.items[PUBLICATION_PK])
        self.assertEqual(first_puts, len([call for call in controller.calls if call[0] == "put_item"]))
        self.assertFalse(control.endpoint_updates)
        self.assertEqual(first_adapter_updates, len(adapter.updates))
        self.assertTrue(all(request.get("ConsistentRead") is True for name, request in controller.calls if name == "get_item"))

    def test_runtime_default_protocol_fields_are_normalized_for_effective_config(self):
        control, _adapter, _controller = self._native(historical=True)
        control.runtimes["7"]["protocolConfiguration"].update({"port": 8080, "path": "/invocations"})
        module = self._load()
        self._call_operation(module, control, self.adapter, self.controller)
        self.assertEqual("7", self.controller.items[PUBLICATION_PK]["runtimeVersion"]["S"])

    def test_false_adapter_readback_does_not_write_a_prepared_reference(self):
        with self.assertRaises((RuntimeError, ValueError)):
            self._operation(historical=True, stale_post_write=True)
        self.assertFalse(self.controller.items)
        self.assertEqual(1, len(self.adapter.updates))

    def test_legitimate_endpoint_mismatch_does_not_qualify_or_repin(self):
        with self.assertRaises((RuntimeError, ValueError)):
            self._operation(historical=True, endpoint_present=True, endpoint_version="8", endpoint_in_progress=True)
        self.assertFalse(self.controller.items)
        self.assertFalse(self.control.endpoint_updates)

        with self.assertRaises((RuntimeError, ValueError, ClientError)):
            self._operation(historical=True, endpoint_error=True)
        self.assertFalse(self.control.endpoint_creates)
        self.assertFalse(self.control.endpoint_updates)
        self.assertFalse(self.controller.items)

    def test_confirmed_corrupt_faulty_binding_repairs_only_that_endpoint_and_version(self):
        self._operation(historical=True, endpoint_present=True, endpoint_version="8", endpoint_update_allowed=True)
        self.assertEqual(1, len(self.control.endpoint_updates))
        update = self.control.endpoint_updates[0]
        self.assertEqual("faulty", update["endpointName"])
        self.assertEqual("7", update["agentRuntimeVersion"])
        self.assertEqual("7", self.control.endpoints["faulty"]["liveVersion"])
        self.assertEqual("reference", self.controller.items[PUBLICATION_PK]["status"]["S"])

    def test_changed_archived_bytes_are_rejected_before_any_native_mutation(self):
        original = self.s3.objects[(self.bucket, self.archive_key, self.archive_version)]
        self.s3.objects[(self.bucket, self.archive_key, self.archive_version)] = b"changed archive"
        with self.assertRaises((RuntimeError, ValueError)):
            self._operation(historical=True)
        self.assertFalse(self.control.endpoint_creates)
        self.assertFalse(self.control.runtime_updates)
        self.assertFalse(self.control.runtime_creates)
        self.assertFalse(self.adapter.updates)
        self.assertFalse(self.controller.items)
        self.s3.objects[(self.bucket, self.archive_key, self.archive_version)] = original

    def test_changed_source_or_configuration_bytes_are_rejected_before_mutation(self):
        for key, replacement in ((self.source_key, b"changed source"), (self.config_key, b"changed config")):
            with self.subTest(key=key):
                original = self.s3.objects[(self.bucket, key, "")]
                self.s3.objects[(self.bucket, key, "")] = replacement
                with self.assertRaises((RuntimeError, ValueError)):
                    self._operation(historical=True)
                self.assertFalse(self.control.endpoint_creates)
                self.assertFalse(self.control.runtime_updates)
                self.assertFalse(self.control.runtime_creates)
                self.assertFalse(self.adapter.updates)
                self.assertFalse(self.controller.items)
                self.s3.objects[(self.bucket, key, "")] = original

    def test_repaired_or_arbitrary_descriptor_and_failed_candidate_cannot_qualify(self):
        descriptor = self.scripts / "faulty-reference.json"
        original = descriptor.read_bytes()
        for changes in ({"candidateId": "repaired"}, {"endpointName": "repaired"}, {"controller": {"tableName": TABLE_NAME, "pk": "arbitrary"}}):
            with self.subTest(changes=changes):
                value = copy.deepcopy(self.descriptor)
                value.update(changes)
                descriptor.write_text(json.dumps(value, sort_keys=True) + "\n")
                with self.assertRaises((RuntimeError, ValueError)):
                    self._operation(historical=True)
                self.assertFalse(self.control.endpoint_creates)
                self.assertFalse(self.controller.items)
        descriptor.write_bytes(original)

        with self.assertRaises((RuntimeError, ValueError)):
            self._operation(historical=True, runtime_status="FAILED")
        self.assertFalse(self.control.endpoint_creates)
        self.assertFalse(self.control.runtime_updates)
        self.assertFalse(self.control.runtime_creates)
        self.assertFalse(self.controller.items)

    def test_partial_adapter_update_can_retry_without_duplicate_endpoint_or_false_record(self):
        control, adapter, controller = self._native(historical=True, fail_update_once=True)
        module = self._load()
        with self.assertRaisesRegex(RuntimeError, "update|failure"):
            self._call_operation(module, control, adapter, controller)
        self.assertFalse(controller.items)
        self.assertEqual(1, len(control.endpoint_creates))

        self._call_operation(module, control, adapter, controller)
        self.assertEqual(1, len(control.endpoint_creates))
        self.assertEqual("reference", controller.items[PUBLICATION_PK]["status"]["S"])

    def test_lost_runtime_update_reconciles_the_committed_version_before_rerun(self):
        control, adapter, controller = self._native(historical=False, runtime_update_lost=True)
        module = self._load()
        with self.assertRaises(RuntimeError):
            self._call_operation(module, control, adapter, controller)
        self.assertEqual(1, len(control.runtime_updates))
        self.assertFalse(control.endpoint_creates)
        self._call_operation(module, control, adapter, controller)
        self.assertEqual(1, len(control.runtime_updates))
        self.assertEqual(1, len(control.endpoint_creates))
        self.assertEqual("10", controller.items[PUBLICATION_PK]["runtimeVersion"]["S"])

    def test_committed_endpoint_adapter_and_record_writes_converge_on_retry(self):
        cases = ("endpoint_create_lost", "adapter_update_lost", "record_put_lost")
        for case in cases:
            with self.subTest(case=case):
                control, adapter, controller = self._native(
                    historical=True,
                    endpoint_create_lost=case == "endpoint_create_lost",
                    adapter_update_lost=case == "adapter_update_lost",
                    record_put_lost=case == "record_put_lost",
                )
                module = self._load()
                with self.assertRaises(RuntimeError):
                    self._call_operation(module, control, adapter, controller)
                if case == "record_put_lost":
                    self.assertIn(PUBLICATION_PK, controller.items)
                else:
                    self.assertFalse(controller.items)
                self._call_operation(module, control, adapter, controller)
                self.assertEqual(1, len(control.endpoint_creates))
                self.assertEqual("reference", controller.items[PUBLICATION_PK]["status"]["S"])
                if case == "adapter_update_lost":
                    self.assertEqual(1, len(adapter.updates))
                if case == "record_put_lost":
                    self.assertEqual(1, len([call for call in controller.calls if call[0] == "put_item"]))

    def test_inconsistent_table_readback_blocks_qualification_then_retry_reads_strongly(self):
        control, adapter, controller = self._native(historical=True, record_readback_wrong=True)
        module = self._load()
        with self.assertRaises((RuntimeError, ValueError)):
            self._call_operation(module, control, adapter, controller)
        self.assertIn(PUBLICATION_PK, controller.items)
        reads = [request for name, request in controller.calls if name == "get_item"]
        self.assertTrue(reads)
        self.assertTrue(all(request.get("ConsistentRead") is True for request in reads))
        controller.readback_wrong = False
        self._call_operation(module, control, adapter, controller)
        self.assertEqual(1, len([call for call in controller.calls if call[0] == "put_item"]))

    def test_stale_optional_record_tuple_fields_are_not_accepted(self):
        control, adapter, controller = self._native(historical=True)
        module = self._load()
        self._call_operation(module, control, adapter, controller)
        controller.items[PUBLICATION_PK]["artifactVersionId"] = attr("stale-version")
        self._call_operation(module, control, adapter, controller)
        writes = [call for call in controller.calls if call[0] == "put_item"]
        self.assertEqual(2, len(writes))
        self.assertEqual(attr(self.archive_version), controller.items[PUBLICATION_PK]["artifactVersionId"])


if __name__ == "__main__":
    unittest.main()
