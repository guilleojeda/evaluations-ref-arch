"""Offline acceptance for the qualified repaired publication handoff.

The publisher is deliberately exercised through its public operation and its
fixed CLI.  The native-shaped transports record requests and retain the
serving state, so these cases distinguish a real publication from a result
that only reports success.  The fixture reuses the Phase 19 native response
shapes where they are useful, but gives the repaired endpoint its own state.

The protected GitHub environment is the only source of human approval.  The
receipt in this test represents the handoff produced by that gate; there is no
standalone local approval command or caller-selected candidate.
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
TESTS_DIR = ROOT / "tests"
AGENT_DIR = ROOT / "agent"
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

from prompt import PROMPT_SHA256 as EFFECTIVE_PROMPT_SHA256  # noqa: E402

from phase19_faulty_reference_test import (  # noqa: E402
    Body,
    NativeCloudFormation,
    NativeController,
    NativeS3,
    NativeSTS,
)

SCRIPT = "publish-repaired.py"
REGION = "us-east-1"
ACCOUNT = "027224425948"
RUNTIME_ID = "IncidentTriageDemoAgent-Ab12Cd34E5"
RUNTIME_ARN = f"arn:aws:bedrock-agentcore:{REGION}:{ACCOUNT}:runtime/{RUNTIME_ID}"
ADAPTER_ARN = f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:IncidentTriageDemoAlarmAdapter"
ALARM_ARN = f"arn:aws:cloudwatch:{REGION}:{ACCOUNT}:alarm:IncidentTriageDemoAppStage5xx"
TABLE_NAME = "IncidentTriageDemoControllerRun"
FAULTY_PK = "AGENT_PUBLICATION#faulty"
REPAIRED_PK = "AGENT_PUBLICATION#repaired"
MODEL_ID = "us.anthropic.claude-sonnet-4-6"
SOURCE_REVISION = "c" * 40
STALE_HEAD_REVISION = "d" * 40
CASE_IDS = (
    "phase14.denied-inventory-read.prepared",
    "phase14.inventory-capacity-overload.prepared",
    "phase14.recovery-with-old-alert.prepared",
)


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def attr(value: object) -> dict[str, str]:
    return {"S": str(value)}


def not_found(operation: str) -> ClientError:
    return ClientError(
        {"Error": {"Code": "ResourceNotFoundException", "Message": "not found"}},
        operation,
    )


class NativeControl:
    """AgentCore control shape retaining faulty and repaired publications."""

    def __init__(
        self,
        expected: dict[str, object],
        *,
        prior_repaired: bool = False,
        runtime_update_lost: bool = False,
        endpoint_create_lost: bool = False,
        endpoint_update_allowed: bool = False,
        corrupt_runtime_after_update: str | None = None,
        endpoint_live_override: str | None = None,
        endpoint_target_override: str | None = None,
    ):
        self.expected = expected
        self.calls: list[tuple[str, dict[str, object]]] = []
        self.runtime_updates: list[dict[str, object]] = []
        self.runtime_creates: list[dict[str, object]] = []
        self.endpoint_creates: list[dict[str, object]] = []
        self.endpoint_updates: list[dict[str, object]] = []
        self.runtime_update_lost = runtime_update_lost
        self.endpoint_create_lost = endpoint_create_lost
        self.endpoint_update_allowed = endpoint_update_allowed
        self.corrupt_runtime_after_update = corrupt_runtime_after_update
        self.endpoint_live_override = endpoint_live_override
        self.endpoint_target_override = endpoint_target_override
        self.next_version = "22"
        self.runtimes: dict[str, dict[str, object]] = {
            "19": self._runtime("19", "faulty", expected["faultyConfiguration"]),
        }
        self.endpoints: dict[str, dict[str, object]] = {
            "faulty": self._endpoint("faulty", "19"),
        }
        if prior_repaired:
            self.runtimes["21"] = self._runtime("21", "repaired", expected["repairedConfiguration"])
            self.endpoints["repaired"] = self._endpoint("repaired", "21")

    def _runtime(self, version: str, candidate: str, configuration: dict[str, object]) -> dict[str, object]:
        value = copy.deepcopy(configuration)
        value.update(
            {
                "agentRuntimeId": RUNTIME_ID,
                "agentRuntimeArn": RUNTIME_ARN,
                "agentRuntimeVersion": version,
                "status": "READY",
            }
        )
        value["environmentVariables"] = copy.deepcopy(configuration["environmentVariables"])
        return value

    def _endpoint(self, name: str, version: str) -> dict[str, object]:
        return {
            "status": "READY",
            "liveVersion": version,
            "targetVersion": version,
            "agentRuntimeArn": RUNTIME_ARN,
            "agentRuntimeEndpointArn": f"{RUNTIME_ARN}/runtime-endpoint/{name}",
        }

    def get_agent_runtime(self, **request: object) -> dict[str, object]:
        self.calls.append(("get_agent_runtime", copy.deepcopy(request)))
        version = str(request.get("agentRuntimeVersion", "19"))
        try:
            return copy.deepcopy(self.runtimes[version])
        except KeyError as error:
            raise not_found("GetAgentRuntime") from error

    def list_agent_runtime_versions(self, **request: object) -> dict[str, object]:
        self.calls.append(("list_agent_runtime_versions", copy.deepcopy(request)))
        return {"agentRuntimes": [{"agentRuntimeVersion": version} for version in sorted(self.runtimes)]}

    def update_agent_runtime(self, **request: object) -> dict[str, object]:
        self.calls.append(("update_agent_runtime", copy.deepcopy(request)))
        self.runtime_updates.append(copy.deepcopy(request))
        version = self.next_version
        configuration = {
            key: copy.deepcopy(request[key])
            for key in (
                "agentRuntimeArtifact",
                "roleArn",
                "environmentVariables",
                "networkConfiguration",
                "protocolConfiguration",
                "lifecycleConfiguration",
                "metadataConfiguration",
            )
            if key in request
        }
        self.runtimes[version] = self._runtime(version, "repaired", configuration)
        observed = self.runtimes[version]
        if self.corrupt_runtime_after_update == "role":
            observed["roleArn"] = f"arn:aws:iam::{ACCOUNT}:role/OtherRuntimeRole"
        elif self.corrupt_runtime_after_update == "metadata":
            observed["metadataConfiguration"] = {"requireMMDSV2": False}
        elif self.corrupt_runtime_after_update == "model":
            observed["environmentVariables"]["AGENT_MODEL_ID"] = "another-model"
        elif self.corrupt_runtime_after_update == "launch":
            observed["agentRuntimeArtifact"]["codeConfiguration"]["entryPoint"] = ["python", "main.py"]
        if self.runtime_update_lost:
            self.runtime_update_lost = False
            raise RuntimeError("Runtime update response lost after commit")
        return {"agentRuntimeArn": RUNTIME_ARN, "agentRuntimeVersion": version}

    def create_agent_runtime(self, **request: object) -> dict[str, object]:
        self.calls.append(("create_agent_runtime", copy.deepcopy(request)))
        self.runtime_creates.append(copy.deepcopy(request))
        raise AssertionError("publication must use the existing stack Runtime")

    def get_agent_runtime_endpoint(self, **request: object) -> dict[str, object]:
        self.calls.append(("get_agent_runtime_endpoint", copy.deepcopy(request)))
        name = str(request.get("endpointName", request.get("name")))
        try:
            return copy.deepcopy(self.endpoints[name])
        except KeyError as error:
            raise not_found("GetAgentRuntimeEndpoint") from error

    def create_agent_runtime_endpoint(self, **request: object) -> dict[str, object]:
        model = get_session().get_service_model("bedrock-agentcore-control")
        validate_parameters(request, model.operation_model("CreateAgentRuntimeEndpoint").input_shape)
        self.calls.append(("create_agent_runtime_endpoint", copy.deepcopy(request)))
        self.endpoint_creates.append(copy.deepcopy(request))
        name = str(request["name"])
        version = str(request["agentRuntimeVersion"])
        if version not in self.runtimes:
            raise AssertionError("endpoint must target a returned Runtime version")
        self.endpoints[name] = self._endpoint(name, version)
        if self.endpoint_live_override is not None:
            self.endpoints[name]["liveVersion"] = self.endpoint_live_override
        if self.endpoint_target_override is not None:
            self.endpoints[name]["targetVersion"] = self.endpoint_target_override
        if self.endpoint_create_lost:
            self.endpoint_create_lost = False
            raise RuntimeError("endpoint create response lost after commit")
        return {"agentRuntimeEndpointArn": self.endpoints[name]["agentRuntimeEndpointArn"]}

    def update_agent_runtime_endpoint(self, **request: object) -> dict[str, object]:
        self.calls.append(("update_agent_runtime_endpoint", copy.deepcopy(request)))
        self.endpoint_updates.append(copy.deepcopy(request))
        if not self.endpoint_update_allowed:
            raise AssertionError("unexpected endpoint repin")
        name = str(request["endpointName"])
        version = str(request["agentRuntimeVersion"])
        if version not in self.runtimes:
            raise AssertionError("endpoint repin must target a returned Runtime version")
        self.endpoints[name].update(
            status="READY",
            liveVersion=version,
            targetVersion=version,
        )
        return copy.deepcopy(self.endpoints[name])


class NativeLambda:
    def __init__(self):
        self.calls: list[tuple[str, dict[str, object]]] = []
        self.updates: list[dict[str, object]] = []
        self.environment = {
            "AGENT_RUNTIME_ARN": RUNTIME_ARN,
            "AGENT_ENDPOINT_NAME": "faulty",
            "AGENT_RUNTIME_VERSION": "19",
            "AGENT_SOURCE_REVISION": "bd6f77df97933e3e675ee9c2a699db16e29ea1b6",
            "AGENT_ARTIFACT_SHA256": "e5ac2ee20d8f3947eb95ceb74094e882a3d8a4a010f2a8e7bf96700dd5906b33",
            "AGENT_ALARM_ARN": ALARM_ARN,
        }
        self.config: dict[str, object] = {
            "LastUpdateStatus": "Successful",
            "FunctionArn": ADAPTER_ARN,
            "RevisionId": "adapter-revision-faulty",
            "CodeSha256": base64.b64encode(bytes.fromhex("a" * 64)).decode(),
            "TracingConfig": {"Mode": "Active"},
            "Environment": {"Variables": copy.deepcopy(self.environment)},
        }

    def get_function_configuration(self, **request: object) -> dict[str, object]:
        self.calls.append(("get_function_configuration", copy.deepcopy(request)))
        return copy.deepcopy(self.config)

    def update_function_configuration(self, **request: object) -> dict[str, object]:
        self.calls.append(("update_function_configuration", copy.deepcopy(request)))
        self.updates.append(copy.deepcopy(request))
        raise AssertionError("repaired publication must not switch the active faulty adapter")


class NativeSession:
    def __init__(self, s3, control, adapter, controller, cloudformation):
        self.region_name = REGION
        self.clients = {
            "s3": s3,
            "bedrock-agentcore-control": control,
            "lambda": adapter,
            "dynamodb": controller,
            "cloudformation": cloudformation,
            "sts": NativeSTS(),
        }

    def client(self, name: str, **_kwargs: object):
        return self.clients[name]


class RepairedPublicationAcceptance(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.install = self.root / "installation"
        self.scripts = self.install / "scripts"
        self.scripts.mkdir(parents=True)

        manifest = json.loads((ROOT / "agent/agent-manifest.json").read_text())
        manifest["sourceRevision"] = SOURCE_REVISION
        manifest["candidateId"] = "repaired"
        # This is the effective SYSTEM_PROMPT digest emitted by the package
        # builder.  It is intentionally distinct from sha256(prompt.py).
        self.prompt_sha256 = EFFECTIVE_PROMPT_SHA256
        self.assertEqual(self.prompt_sha256, manifest["promptSha256"])
        self.manifest_bytes = (json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n").encode()
        self.prompt_bytes = (ROOT / "agent/prompt.py").read_bytes()
        archive_io = io.BytesIO()
        with zipfile.ZipFile(archive_io, "w", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr("agent-manifest.json", self.manifest_bytes)
            archive.writestr("prompt.py", self.prompt_bytes)
        self.archive_bytes = archive_io.getvalue()

        self.bucket = f"cdk-evaltalk-assets-{ACCOUNT}-{REGION}"
        self.artifact_version = "repaired-artifact-v1"
        self.artifact_sha256 = sha256(self.archive_bytes)
        self.artifact_key = f"agent-qualified/{self.artifact_sha256}.zip"
        self.runtime_environment = {
            "AGENT_RUN_TABLE": "IncidentTriageDemoAgentRun",
            "AGENT_SOURCE_BUCKET": f"incident-triage-demo-evidence-{ACCOUNT}-{REGION}",
            "AGENT_SOURCE_PREFIX": "agent-source/",
            "AGENT_ALARM_ARN": ALARM_ARN,
            "AGENT_MODEL_ID": MODEL_ID,
            "AGENT_ACCOUNT_ID": ACCOUNT,
            "AGENT_REGION": REGION,
            "AGENT_CANDIDATE_ID": "repaired",
            "AGENT_SOURCE_REVISION": SOURCE_REVISION,
            "AGENT_ARTIFACT_SHA256": self.artifact_sha256,
            "AGENT_ENDPOINT_NAME": "repaired",
            "AGENT_APP_HTTP_API_ID": "api123",
        }
        self.runtime_configuration = {
            "agentRuntimeArtifact": {
                "codeConfiguration": {
                    "runtime": "PYTHON_3_13",
                    "entryPoint": ["opentelemetry-instrument", "main.py"],
                    "code": {
                        "s3": {
                            "bucket": self.bucket,
                            "prefix": self.artifact_key,
                            "versionId": self.artifact_version,
                        }
                    },
                }
            },
            "roleArn": f"arn:aws:iam::{ACCOUNT}:role/IncidentTriageDemoAgentRuntimeRole",
            "environmentVariables": self.runtime_environment,
            "networkConfiguration": {"networkMode": "PUBLIC"},
            "protocolConfiguration": {"serverProtocol": "HTTP"},
            "lifecycleConfiguration": {"idleRuntimeSessionTimeout": 300, "maxLifetime": 600},
            "metadataConfiguration": {"requireMMDSV2": True},
        }
        self.configuration_bytes = (
            json.dumps(self.runtime_configuration, sort_keys=True, separators=(",", ":")) + "\n"
        ).encode()
        self.source_version = "repaired-source-v1"
        self.configuration_version = "repaired-configuration-v1"
        self.source_key = f"agent-qualified/{sha256(self.prompt_bytes)}.py"
        self.configuration_key = f"agent-qualified/{sha256(self.configuration_bytes)}.json"
        self.faulty_configuration = copy.deepcopy(self.runtime_configuration)
        self.faulty_configuration["environmentVariables"] = copy.deepcopy(self.runtime_environment)
        self.faulty_configuration["environmentVariables"].update(
            {
                "AGENT_CANDIDATE_ID": "faulty",
                "AGENT_ENDPOINT_NAME": "faulty",
                "AGENT_SOURCE_REVISION": "bd6f77df97933e3e675ee9c2a699db16e29ea1b6",
                "AGENT_ARTIFACT_SHA256": "e5ac2ee20d8f3947eb95ceb74094e882a3d8a4a010f2a8e7bf96700dd5906b33",
            }
        )

        self.cases_bytes = b"reviewed-cases-v1:denial,capacity,recovery\n"
        self.cases_sha256 = sha256(self.cases_bytes)
        self.reports = [
            {"caseId": CASE_IDS[0], "executionId": "exec-denial", "traceId": "trace-denial", "reportSha256": "1" * 64},
            {"caseId": CASE_IDS[1], "executionId": "exec-capacity", "traceId": "trace-capacity", "reportSha256": "2" * 64},
            {"caseId": CASE_IDS[2], "executionId": "exec-recovery", "traceId": "trace-recovery", "reportSha256": "3" * 64},
        ]
        self.report_identities_sha256 = sha256(
            (json.dumps(self.reports, sort_keys=True, separators=(",", ":")) + "\n").encode()
        )
        # This is the digest of the machine evidence made available before
        # the GitHub review. The reviewer echoes precisely that digest.
        machine_identity = {
            "sourceRevision": SOURCE_REVISION, "artifactSha256": self.artifact_sha256,
            "configurationSha256": sha256(self.configuration_bytes),
            "caseSetSha256": self.cases_sha256, "reportIdentitiesSha256": self.report_identities_sha256,
        }
        self.manifest_sha256 = sha256(json.dumps(machine_identity, sort_keys=True).encode())
        self.review = {
            "status": "approved",
            "environment": "repaired-publication",
            "reviewer": "presenter",
            "runId": "github-run-20261118",
            "headSha": SOURCE_REVISION,
            "reviewManifestSha256": self.manifest_sha256,
        }
        self.qualification = {
            "schemaVersion": 1,
            "status": "eligible",
            "candidateId": "repaired",
            "endpointName": "repaired",
            "runtimeName": "IncidentTriageDemoAgent",
            "sourceRevision": SOURCE_REVISION,
            "promptSha256": self.prompt_sha256,
            "modelId": MODEL_ID,
            "alarmArn": ALARM_ARN,
            "artifact": {
                "bucket": self.bucket,
                "key": self.artifact_key,
                "versionId": self.artifact_version,
                "sha256": self.artifact_sha256,
            },
            "source": {
                "bucket": self.bucket,
                "key": self.source_key,
                "versionId": self.source_version,
                "sha256": sha256(self.prompt_bytes),
            },
            "configuration": {
                "bucket": self.bucket,
                "key": self.configuration_key,
                "versionId": self.configuration_version,
                "sha256": sha256(self.configuration_bytes),
            },
            "runtimeConfiguration": self.runtime_configuration,
            # The frozen suite is content-addressed but intentionally has no
            # S3 VersionId. The exact ZIP artifact is the versioned serving
            # object; the suite identity is its verified content digest.
            "caseSet": {"sha256": self.cases_sha256},
            "inputs": {"caseIds": list(CASE_IDS), "suiteSha256": self.cases_sha256},
            "evaluation": {
                "experimentId": "experiment-phase20-repaired",
                "reportIdentities": self.reports,
                "reportIdentitiesSha256": self.report_identities_sha256,
            },
            "reports": self.reports,
            "reportIdentitiesSha256": self.report_identities_sha256,
            "humanReview": self.review,
            "reviewManifestSha256": self.manifest_sha256,
            "adapter": {
                "functionArn": ADAPTER_ARN,
                "codeSha256": "a" * 64,
                "tracingMode": "Active",
            },
            "controller": {"tableName": TABLE_NAME, "pk": REPAIRED_PK},
        }
        self.current_demo_revision = SOURCE_REVISION
        self.initial_qualification = copy.deepcopy(self.qualification)
        self.trusted_qualification = copy.deepcopy(self.initial_qualification)
        # This is the output of the protected workflow/gate handoff.  It is
        # passed to the public operation by the trusted publisher job; it is
        # intentionally not loaded from a checkout-side descriptor.
        self.candidate_receipt = self.scripts / "repaired-qualification.json"
        self.candidate_receipt.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "status": "incomplete",
                    "candidateId": "repaired",
                    "humanReview": {
                        "status": "approved",
                        "environment": "repaired-publication",
                        "reviewer": "candidate",
                        "runId": "candidate-forged-run",
                        "headSha": STALE_HEAD_REVISION,
                        "reviewManifestSha256": "f" * 64,
                    },
                },
                sort_keys=True,
            )
            + "\n"
        )
        self.s3 = NativeS3(
            {
                (self.bucket, self.artifact_key, self.artifact_version): self.archive_bytes,
                (self.bucket, "agent-qualified/cases.json", ""): self.cases_bytes,
                (self.bucket, self.source_key, self.source_version): self.prompt_bytes,
                (self.bucket, self.configuration_key, self.configuration_version): self.configuration_bytes,
            }
        )
        self.control: NativeControl | None = None
        self.adapter: NativeLambda | None = None
        self.controller: NativeController | None = None
        self.cloudformation = NativeCloudFormation()
        self.module_counter = 0

    def _reset_object_store(self) -> None:
        """Reset S3 to pristine bytes before each integrity subcase."""

        self.s3 = NativeS3(
            {
                (self.bucket, self.artifact_key, self.artifact_version): self.archive_bytes,
                (self.bucket, "agent-qualified/cases.json", ""): self.cases_bytes,
                (self.bucket, self.source_key, self.source_version): self.prompt_bytes,
                (self.bucket, self.configuration_key, self.configuration_version): self.configuration_bytes,
            }
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _load(self):
        source = ROOT / "scripts" / SCRIPT
        self.assertTrue(source.is_file(), f"{SCRIPT} is missing")
        target = self.scripts / source.name
        shutil.copy2(source, target)
        self.module_counter += 1
        spec = importlib.util.spec_from_file_location(f"phase20_repaired_{self.module_counter}", target)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def _native(
        self,
        *,
        prior_repaired: bool = False,
        runtime_update_lost: bool = False,
        endpoint_create_lost: bool = False,
        endpoint_update_allowed: bool = False,
        corrupt_runtime_after_update: str | None = None,
        endpoint_live_override: str | None = None,
        endpoint_target_override: str | None = None,
        record_put_lost: bool = False,
        record_readback_wrong: bool = False,
    ):
        self.control = NativeControl(
            {
                "faultyConfiguration": self.faulty_configuration,
                "repairedConfiguration": self.runtime_configuration,
            },
            prior_repaired=prior_repaired,
            runtime_update_lost=runtime_update_lost,
            endpoint_create_lost=endpoint_create_lost,
            endpoint_update_allowed=endpoint_update_allowed,
            corrupt_runtime_after_update=corrupt_runtime_after_update,
            endpoint_live_override=endpoint_live_override,
            endpoint_target_override=endpoint_target_override,
        )
        self.adapter = NativeLambda()
        self.controller = NativeController(put_lost=record_put_lost, readback_wrong=record_readback_wrong)
        self.controller.items[FAULTY_PK] = {
            "pk": attr(FAULTY_PK),
            "candidateId": attr("faulty"),
            "status": attr("reference"),
            "runtimeVersion": attr("19"),
            "endpointName": attr("faulty"),
            "adapterArn": attr(ADAPTER_ARN),
        }
        return self.control, self.adapter, self.controller

    def _session(self):
        assert self.control is not None and self.adapter is not None and self.controller is not None
        return NativeSession(self.s3, self.control, self.adapter, self.controller, self.cloudformation)

    def _assert_no_serving_writes(self) -> None:
        assert self.control is not None and self.adapter is not None and self.controller is not None
        self.assertFalse(self.control.runtime_updates)
        self.assertFalse(self.control.runtime_creates)
        self.assertFalse(self.control.endpoint_creates)
        self.assertFalse(self.control.endpoint_updates)
        self.assertFalse(self.adapter.updates)
        self.assertNotIn(REPAIRED_PK, self.controller.items)

    def _call(self, module):
        operation = getattr(module, "publish_repaired", None)
        self.assertIsNotNone(operation, "the module must expose publish_repaired(session)")
        with ExitStack() as stack:
            if hasattr(module, "time"):
                stack.enter_context(patch.object(module.time, "sleep", return_value=None))
            return operation(self._session(), qualification=self.trusted_qualification,
                             current_demo_revision=self.current_demo_revision)

    def test_public_cli_has_no_candidate_or_approval_override(self):
        module = self._load()
        for args in (("faulty",), ("--candidate", "repaired"), ("--endpoint", "repaired"), ("--qualification", "other.json")):
            with self.subTest(args=args):
                with patch.object(module.boto3, "Session", side_effect=AssertionError("AWS must not be reached")):
                    with patch.object(sys, "argv", [str(self.scripts / SCRIPT), *args]):
                        with self.assertRaises(SystemExit):
                            module.main()

    def test_missing_or_failed_protected_clearance_has_no_native_mutation(self):
        module = self._load()
        for change in (
            {"status": "incomplete"},
            {"humanReview": {**self.review, "status": "rejected"}},
            {"humanReview": {**self.review, "reviewManifestSha256": "f" * 64}},
            {"status": "reject"},
            {"status": "superseded", "supersededBy": "github-run-newer"},
        ):
            with self.subTest(change=change):
                value = copy.deepcopy(self.initial_qualification)
                value.update(change)
                self.trusted_qualification = value
                self._native()
                with self.assertRaises((RuntimeError, ValueError, SystemExit)):
                    self._call(module)
                self._assert_no_serving_writes()

    def test_checkout_receipt_cannot_supply_clearance_for_publication(self):
        module = self._load()
        # A candidate can edit files in the checkout, but the operation must
        # consume the independently returned protected-workflow receipt above.
        self.candidate_receipt.write_text(
            json.dumps(
                {
                    **self.trusted_qualification,
                    "status": "eligible",
                    "humanReview": {
                        "status": "approved",
                        "environment": "repaired-publication",
                        "reviewer": "candidate",
                        "runId": "candidate-forged-run",
                        "headSha": STALE_HEAD_REVISION,
                        "reviewManifestSha256": "f" * 64,
                    },
                },
                sort_keys=True,
            )
            + "\n"
        )
        self.trusted_qualification = {**self.trusted_qualification, "status": "incomplete"}
        self._native()
        with self.assertRaises((RuntimeError, ValueError, SystemExit)):
            self._call(module)
        self._assert_no_serving_writes()

    def test_eligible_approved_release_is_rejected_when_protected_head_advances(self):
        """A valid approval for an older commit cannot publish after a new head."""

        module = self._load()
        self.trusted_qualification = copy.deepcopy(self.initial_qualification)
        self.assertEqual("eligible", self.trusted_qualification["status"])
        self.assertEqual("approved", self.trusted_qualification["humanReview"]["status"])
        # Keep the candidate receipt eligible and approved. The protected
        # workflow's current head is the independently returned input that has
        # advanced since this package was reviewed.
        self.current_demo_revision = STALE_HEAD_REVISION
        self._native()
        with self.assertRaises((RuntimeError, ValueError, SystemExit)):
            self._call(module)
        self._assert_no_serving_writes()

    def test_qualified_exact_bytes_publish_repaired_and_strongly_read_back_row(self):
        module = self._load()
        self._native()
        result = self._call(module)
        assert self.control is not None and self.adapter is not None and self.controller is not None
        self.assertEqual("repaired", result["candidateId"])
        self.assertEqual("repaired", result["endpointName"])
        version = str(result["runtimeVersion"])
        self.assertRegex(version, r"^[1-9][0-9]*$")
        self.assertEqual(1, len(self.control.runtime_updates))
        self.assertEqual(1, len(self.control.endpoint_creates))
        self.assertEqual([], self.control.runtime_creates)
        self.assertEqual([], self.control.endpoint_updates)
        with zipfile.ZipFile(io.BytesIO(self.archive_bytes)) as archive:
            manifest = json.loads(archive.read("agent-manifest.json"))
        self.assertEqual(self.prompt_sha256, manifest["promptSha256"])
        self.assertEqual(self.prompt_sha256, self.trusted_qualification["promptSha256"])
        self.assertNotEqual(self.prompt_sha256, sha256(self.prompt_bytes))
        runtime_request = self.control.runtime_updates[0]
        self.assertEqual(self.runtime_configuration["agentRuntimeArtifact"], runtime_request["agentRuntimeArtifact"])
        for field, expected in self.runtime_configuration.items():
            self.assertEqual(expected, runtime_request[field], field)
        endpoint_request = self.control.endpoint_creates[0]
        self.assertEqual("repaired", endpoint_request["name"])
        self.assertEqual(version, endpoint_request["agentRuntimeVersion"])
        self.assertNotEqual("DEFAULT", endpoint_request["agentRuntimeVersion"])
        row = self.controller.items[REPAIRED_PK]
        self.assertEqual(attr(REPAIRED_PK), row["pk"])
        self.assertEqual(attr("repaired"), row["candidateId"])
        self.assertIn(row["status"]["S"], ("qualified", "published"))
        self.assertEqual(attr(SOURCE_REVISION), row["sourceRevision"])
        self.assertEqual(attr(self.prompt_sha256), row["promptSha256"])
        self.assertEqual(attr(MODEL_ID), row["modelId"])
        self.assertEqual(attr(RUNTIME_ARN), row["runtimeArn"])
        self.assertEqual(attr(self.artifact_sha256), row["artifactSha256"])
        self.assertEqual(attr(self.artifact_version), row["artifactVersionId"])
        self.assertEqual(attr(self.cases_sha256), row["caseSetSha256"])
        self.assertEqual(attr(self.report_identities_sha256), row["reportIdentitiesSha256"])
        self.assertEqual(attr("repaired-publication"), row["reviewEnvironment"])
        self.assertEqual(attr("github-run-20261118"), row["reviewRunId"])
        self.assertEqual(attr(self.manifest_sha256), row["reviewManifestSha256"])
        self.assertEqual(attr("presenter"), row["reviewer"])
        self.assertTrue(all(request[1].get("ConsistentRead") is True for request in self.controller.calls if request[0] == "get_item"))
        self.assertEqual([], self.adapter.updates)
        self.assertEqual("faulty", self.adapter.environment["AGENT_ENDPOINT_NAME"])
        self.assertEqual("19", self.adapter.environment["AGENT_RUNTIME_VERSION"])
        self.assertTrue(any(call.get("Key") == self.artifact_key and call.get("VersionId") == self.artifact_version
                            for call in self.s3.calls))

    def test_valid_clearance_cannot_publish_tampered_or_unversioned_artifact_bytes(self):
        for mode in ("tampered", "missing", "wrong-version", "different-returned-version"):
            with self.subTest(mode=mode):
                module = self._load()
                self.trusted_qualification = copy.deepcopy(self.initial_qualification)
                self._reset_object_store()
                self._native()
                key = (self.bucket, self.artifact_key, self.artifact_version)
                if mode == "tampered":
                    self.s3.objects[key] = b"different ZIP bytes"
                elif mode == "missing":
                    self.s3.objects.pop(key)
                elif mode == "wrong-version":
                    self.trusted_qualification["artifact"]["versionId"] = "not-the-reviewed-version"
                else:
                    original_get = self.s3.get_object
                    def changed_version(**request):
                        response = original_get(**request)
                        return {**response, "VersionId": "different-native-version"}
                    self.s3.get_object = changed_version
                with self.assertRaises((RuntimeError, ValueError, SystemExit, ClientError)):
                    self._call(module)
                self._assert_no_serving_writes()

    def test_native_runtime_or_endpoint_readback_mismatch_never_qualifies_or_writes_row(self):
        for mode in ("role", "metadata", "model", "launch", "endpoint-live", "endpoint-target"):
            with self.subTest(mode=mode):
                module = self._load()
                self.trusted_qualification = copy.deepcopy(self.initial_qualification)
                self._native(
                    corrupt_runtime_after_update=mode if not mode.startswith("endpoint") else None,
                    endpoint_live_override="20" if mode == "endpoint-live" else None,
                    endpoint_target_override="20" if mode == "endpoint-target" else None,
                )
                with self.assertRaises((RuntimeError, ValueError, AssertionError, SystemExit)):
                    self._call(module)
                assert self.control is not None and self.adapter is not None and self.controller is not None
                self.assertNotIn(REPAIRED_PK, self.controller.items)
                self.assertFalse(self.adapter.updates)
                if not mode.startswith("endpoint"):
                    self.assertFalse(self.control.endpoint_creates)

    def test_repaired_publication_is_repair_only_and_preserves_active_faulty_history(self):
        module = self._load()
        self._native()
        assert self.control is not None and self.adapter is not None and self.controller is not None
        before_faulty = copy.deepcopy(self.control.endpoints["faulty"])
        before_faulty_row = copy.deepcopy(self.controller.items[FAULTY_PK])
        self.controller.items["AGENT_RUN#prior"] = {"pk": attr("AGENT_RUN#prior"), "status": attr("complete")}
        prior_history = copy.deepcopy(self.controller.items["AGENT_RUN#prior"])
        self._call(module)
        self.assertEqual(before_faulty, self.control.endpoints["faulty"])
        self.assertEqual(before_faulty_row, self.controller.items[FAULTY_PK])
        self.assertEqual(prior_history, self.controller.items["AGENT_RUN#prior"])
        self.assertEqual([], self.adapter.updates)
        self.assertEqual("faulty", self.adapter.environment["AGENT_ENDPOINT_NAME"])
        self.assertEqual("19", self.adapter.environment["AGENT_RUNTIME_VERSION"])
        self.assertEqual([], self.control.runtime_creates)
        self.assertTrue(all(request[1].get("name", "repaired") == "repaired" for request in self.control.calls if request[0].startswith("create_agent_runtime_endpoint")))

    def test_existing_repaired_endpoint_is_repaired_only_and_history_is_retained(self):
        module = self._load()
        self._native(prior_repaired=True)
        assert self.control is not None and self.adapter is not None and self.controller is not None
        self.controller.items["AGENT_RUN#old"] = {"pk": attr("AGENT_RUN#old"), "status": attr("complete"), "candidateId": attr("repaired")}
        before_versions = copy.deepcopy(self.control.runtimes)
        before_endpoint = copy.deepcopy(self.control.endpoints["repaired"])
        self.trusted_qualification["runtimeConfiguration"] = copy.deepcopy(self.runtime_configuration)
        self._call(module)
        self.assertEqual(before_versions, self.control.runtimes)
        self.assertEqual(before_endpoint, self.control.endpoints["repaired"])
        self.assertEqual([], self.control.runtime_updates)
        self.assertEqual([], self.control.endpoint_creates)
        self.assertEqual([], self.control.endpoint_updates)
        self.assertEqual("complete", self.controller.items["AGENT_RUN#old"]["status"]["S"])
        self.assertEqual([], self.adapter.updates)

    def test_stale_prior_repaired_endpoint_is_repaired_only_and_old_version_history_survives(self):
        module = self._load()
        self._native(prior_repaired=True, endpoint_update_allowed=True)
        assert self.control is not None and self.adapter is not None and self.controller is not None
        old_runtime = copy.deepcopy(self.control.runtimes.pop("21"))
        old_runtime["agentRuntimeVersion"] = "20"
        old_runtime["environmentVariables"]["AGENT_ARTIFACT_SHA256"] = "f" * 64
        self.control.runtimes["20"] = old_runtime
        self.control.endpoints["repaired"].update(liveVersion="20", targetVersion="20")
        self.controller.items["AGENT_RUN#repaired-old"] = {
            "pk": attr("AGENT_RUN#repaired-old"),
            "status": attr("complete"),
            "candidateId": attr("repaired"),
        }
        faulty_endpoint = copy.deepcopy(self.control.endpoints["faulty"])
        self._call(module)
        self.assertEqual("20", self.control.runtimes["20"]["agentRuntimeVersion"])
        self.assertIn("20", self.control.runtimes)
        self.assertEqual(1, len(self.control.runtime_updates))
        self.assertEqual(1, len(self.control.endpoint_updates))
        self.assertEqual("repaired", self.control.endpoint_updates[0]["endpointName"])
        self.assertEqual(faulty_endpoint, self.control.endpoints["faulty"])
        self.assertEqual("complete", self.controller.items["AGENT_RUN#repaired-old"]["status"]["S"])
        self.assertEqual([], self.adapter.updates)

    def test_lost_runtime_or_endpoint_or_row_response_retries_without_duplicate_repaired_writes(self):
        for lost in ("runtime", "endpoint", "row"):
            with self.subTest(lost=lost):
                module = self._load()
                self._native(
                    runtime_update_lost=lost == "runtime",
                    endpoint_create_lost=lost == "endpoint",
                    record_put_lost=lost == "row",
                )
                with self.assertRaises(RuntimeError):
                    self._call(module)
                assert self.control is not None and self.adapter is not None and self.controller is not None
                self._call(module)
                self.assertEqual(1, len(self.control.runtime_updates))
                self.assertLessEqual(len(self.control.endpoint_creates), 1)
                self.assertEqual([], self.adapter.updates)
                self.assertIn(REPAIRED_PK, self.controller.items)
                self.assertIn(self.controller.items[REPAIRED_PK]["status"]["S"], ("qualified", "published"))

    def test_row_readback_mismatch_blocks_completion_and_requires_strong_retry(self):
        module = self._load()
        self._native(record_readback_wrong=True)
        with self.assertRaises((RuntimeError, ValueError)):
            self._call(module)
        assert self.control is not None and self.adapter is not None and self.controller is not None
        self.assertTrue(all(request[1].get("ConsistentRead") is True for request in self.controller.calls if request[0] == "get_item"))
        self.assertEqual([], self.adapter.updates)
        self.controller.readback_wrong = False
        self._call(module)
        self.assertIn(REPAIRED_PK, self.controller.items)


if __name__ == "__main__":
    unittest.main()
