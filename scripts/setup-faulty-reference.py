"""Restore the reviewed, intentionally faulty AgentCore reference.

This command is deliberately a fixed maintenance operation.  It reads the
descriptor stored beside this file and never accepts a candidate, endpoint,
artifact URI, or version from the caller.  The descriptor is the reviewable
boundary for the archive, source provenance, runtime configuration, and the
single ``faulty`` publication identity.

The operation is ordered so that every source object is verified before any
AgentCore, Lambda, or DynamoDB write.  Native writes are not treated as
atomic: a caller can rerun this command after a lost response, and every
subsequent step starts with a strong read of the state it owns.
"""

from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import json
import re
import time
from pathlib import Path
from typing import Any, Callable, Mapping
import zipfile
import io

import boto3
from botocore.exceptions import ClientError


REGION = "us-east-1"
ACCOUNT = "027224425948"
STACK_NAME = "IncidentTriageDemoAgent"
ADAPTER_FUNCTION_NAME = "IncidentTriageDemoAlarmAdapter"
SELECTION_TABLE_ENV = "AGENT_SELECTION_TABLE"
RUNTIME_VERSION_RE = re.compile(r"^[1-9][0-9]{0,4}$")
DESCRIPTOR_PATH = Path(__file__).with_name("faulty-reference.json")


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _attr(value: object) -> dict[str, str]:
    return {"S": str(value)}


def _not_found(error: BaseException) -> bool:
    return isinstance(error, ClientError) and error.response.get("Error", {}).get("Code") in {
        "ResourceNotFoundException",
        "ResourceNotFound",
        "NotFound",
    }


def _required_string(mapping: Mapping[str, Any], key: str, context: str) -> str:
    value = mapping.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{context}.{key} must be a non-empty string")
    return value


def _read_descriptor() -> dict[str, Any]:
    try:
        value = json.loads(DESCRIPTOR_PATH.read_text())
    except FileNotFoundError as error:
        raise RuntimeError(f"fixed descriptor is missing: {DESCRIPTOR_PATH.name}") from error
    except json.JSONDecodeError as error:
        raise ValueError("fixed faulty-reference descriptor is not valid JSON") from error
    if not isinstance(value, dict):
        raise ValueError("fixed faulty-reference descriptor must be a JSON object")
    return value


def _validate_descriptor(descriptor: Mapping[str, Any]) -> None:
    if descriptor.get("schemaVersion") != 1:
        raise ValueError("unsupported faulty-reference descriptor schema")
    if descriptor.get("candidateId") != "faulty":
        raise ValueError("the fixed publisher only accepts candidate faulty")
    if descriptor.get("endpointName") != "faulty":
        raise ValueError("the fixed publisher only accepts endpoint faulty")
    if descriptor.get("runtimeName") != STACK_NAME:
        raise ValueError("descriptor runtimeName must identify the agent stack")

    artifact = descriptor.get("artifact")
    source = descriptor.get("source")
    configuration = descriptor.get("configuration")
    for name, value in (("artifact", artifact), ("source", source), ("configuration", configuration)):
        if not isinstance(value, dict):
            raise ValueError(f"descriptor {name} is missing")
        _required_string(value, "bucket", name)
        _required_string(value, "key", name)
        _required_string(value, "sha256", name)
        if not re.fullmatch(r"[0-9a-f]{64}", value["sha256"]):
            raise ValueError(f"descriptor {name}.sha256 is not a lowercase SHA-256")
    _required_string(artifact, "versionId", "artifact")
    for name, value in (("source", source), ("configuration", configuration)):
        if "versionId" in value:
            _required_string(value, "versionId", name)
    for name in ("sourceManifest", "lock"):
        value = descriptor.get(name)
        if value is None:
            continue
        if not isinstance(value, dict):
            raise ValueError(f"descriptor {name} must be an object")
        _required_string(value, "bucket", name)
        _required_string(value, "key", name)
        _required_string(value, "sha256", name)
        if not re.fullmatch(r"[0-9a-f]{64}", value["sha256"]):
            raise ValueError(f"descriptor {name}.sha256 is not a lowercase SHA-256")
        _required_string(value, "versionId", name)

    for key in ("sourceRevision", "promptSha256", "modelId", "alarmArn"):
        _required_string(descriptor, key, "descriptor")
    if not re.fullmatch(r"[0-9a-f]{40}", descriptor["sourceRevision"]):
        raise ValueError("descriptor sourceRevision must be a Git commit identity")
    if not re.fullmatch(r"[0-9a-f]{64}", descriptor["promptSha256"]):
        raise ValueError("descriptor promptSha256 must be a lowercase SHA-256")

    controller = descriptor.get("controller")
    if not isinstance(controller, dict) or controller.get("tableName") != "IncidentTriageDemoControllerRun" or controller.get("pk") != "AGENT_PUBLICATION#faulty":
        raise ValueError("descriptor controller must identify the fixed publication record")

    environment = descriptor.get("runtimeEnvironment")
    runtime_configuration = descriptor.get("runtimeConfiguration")
    if not isinstance(environment, dict) or not environment or any(not isinstance(k, str) or not isinstance(v, str) for k, v in environment.items()):
        raise ValueError("descriptor runtimeEnvironment must be a string map")
    if environment.get("AGENT_CANDIDATE_ID") != "faulty" or environment.get("AGENT_ENDPOINT_NAME") != "faulty":
        raise ValueError("runtime environment must be pinned to faulty")
    if environment.get("AGENT_SOURCE_REVISION") != descriptor["sourceRevision"]:
        raise ValueError("runtime environment source revision differs from descriptor")
    if environment.get("AGENT_MODEL_ID") != descriptor["modelId"]:
        raise ValueError("runtime environment model differs from descriptor")
    if environment.get("AGENT_ALARM_ARN") != descriptor["alarmArn"]:
        raise ValueError("runtime environment alarm differs from descriptor")
    if environment.get("AGENT_ARTIFACT_SHA256") != artifact["sha256"]:
        raise ValueError("runtime environment artifact digest differs from descriptor")
    if not isinstance(runtime_configuration, dict):
        raise ValueError("descriptor runtimeConfiguration is missing")
    if runtime_configuration.get("environmentVariables") != environment:
        raise ValueError("runtimeConfiguration environment does not match runtimeEnvironment")

    runtime_artifact = runtime_configuration.get("agentRuntimeArtifact")
    if not isinstance(runtime_artifact, dict):
        raise ValueError("runtimeConfiguration artifact is missing")
    code = runtime_artifact.get("codeConfiguration")
    if not isinstance(code, dict):
        raise ValueError("runtimeConfiguration codeConfiguration is missing")
    s3 = code.get("code", {}).get("s3") if isinstance(code.get("code"), dict) else None
    if not isinstance(s3, dict):
        raise ValueError("runtimeConfiguration must use S3 code")
    if s3.get("bucket") != artifact["bucket"] or s3.get("prefix") != artifact["key"] or s3.get("versionId") != artifact["versionId"]:
        raise ValueError("runtimeConfiguration artifact does not pin the reviewed object/version")
    if code.get("runtime") != "PYTHON_3_13" or code.get("entryPoint") != ["opentelemetry-instrument", "main.py"]:
        raise ValueError("runtimeConfiguration entry point/runtime differs from the reviewed package")

    # Newer descriptors carry adapter code/provenance explicitly.  Keep these
    # values part of the fixed contract when present while remaining compatible
    # with the originally reviewed descriptor that predates those fields.
    adapter = descriptor.get("adapter")
    if adapter is not None:
        if not isinstance(adapter, dict):
            raise ValueError("descriptor adapter must be an object")
        if "functionArn" in adapter:
            _required_string(adapter, "functionArn", "adapter")
        if "codeSha256" in adapter:
            code_sha = _required_string(adapter, "codeSha256", "adapter")
            if not re.fullmatch(r"[0-9a-f]{64}", code_sha):
                raise ValueError("adapter.codeSha256 must be a lowercase SHA-256")
        if "tracingMode" in adapter and adapter["tracingMode"] != "Active":
            raise ValueError("the fixed alarm adapter must retain active tracing")
    provenance = descriptor.get("provenance")
    if provenance is not None:
        if not isinstance(provenance, dict):
            raise ValueError("descriptor provenance must be an object")
        for key in ("originalRevision", "manifestRevision", "lockSha256", "dependencyLockSha256", "buildSha256"):
            if key in provenance and (not isinstance(provenance[key], str) or not provenance[key].strip()):
                raise ValueError(f"provenance.{key} must be a non-empty string")
        for key in ("originalRevision",):
            if key in provenance and not re.fullmatch(r"[a-f0-9]{40}", provenance[key]):
                raise ValueError(f"provenance.{key} must be a Git commit identity")
        for key in ("lockSha256", "dependencyLockSha256", "buildSha256"):
            if key in provenance and not re.fullmatch(r"[0-9a-f]{64}", provenance[key]):
                raise ValueError(f"provenance.{key} must be a lowercase SHA-256")
        if ("lockSha256" in provenance or "dependencyLockSha256" in provenance) and descriptor.get("lock") is None:
            raise ValueError("lock provenance requires a versioned lock object")


def _download_object(s3: Any, spec: Mapping[str, Any], *, required_version: bool) -> tuple[bytes, str]:
    request: dict[str, Any] = {"Bucket": spec["bucket"], "Key": spec["key"]}
    if required_version or spec.get("versionId"):
        request["VersionId"] = spec["versionId"]
    response = s3.get_object(**request)
    body = response.get("Body")
    if body is None or not hasattr(body, "read"):
        raise RuntimeError(f"S3 object {spec['key']} has no readable body")
    value = body.read()
    if not isinstance(value, bytes):
        raise RuntimeError(f"S3 object {spec['key']} returned a non-byte body")
    if _sha256(value) != spec["sha256"]:
        raise ValueError(f"S3 object digest mismatch for {spec['key']}")
    observed_version = str(response.get("VersionId", request.get("VersionId", "")))
    if (required_version or spec.get("versionId")) and observed_version != spec["versionId"]:
        raise ValueError(f"S3 object version mismatch for {spec['key']}")
    return value, observed_version


def _validate_archive(
    archive_bytes: bytes,
    descriptor: Mapping[str, Any],
    source_bytes: bytes,
    source_manifest_bytes: bytes | None = None,
    lock_bytes: bytes | None = None,
) -> None:
    try:
        archive = zipfile.ZipFile(io.BytesIO(archive_bytes))
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("reviewed archive contains duplicate paths")
        manifest_bytes = archive.read("agent-manifest.json")
        manifest = json.loads(manifest_bytes)
        packaged_prompt = archive.read("prompt.py")
    except (KeyError, ValueError, zipfile.BadZipFile, json.JSONDecodeError) as error:
        raise ValueError("reviewed faulty archive is not a valid package") from error
    if not isinstance(manifest, dict):
        raise ValueError("reviewed archive manifest is not an object")
    if manifest.get("sourceRevision") != descriptor["sourceRevision"]:
        raise ValueError("archive manifest source revision differs from descriptor")
    if manifest.get("promptSha256") != descriptor["promptSha256"]:
        raise ValueError("archive manifest prompt digest differs from descriptor")
    if packaged_prompt != source_bytes:
        raise ValueError("archive prompt source differs from the reviewed source object")
    if source_manifest_bytes is not None and source_manifest_bytes != manifest_bytes:
        raise ValueError("archive manifest differs from the reviewed source-manifest object")

    provenance = descriptor.get("provenance")
    if isinstance(provenance, Mapping):
        # The archive's identity is checked against the original reviewed
        # revision, not the later descriptor/workflow revision.
        original_revision = provenance.get("originalRevision", descriptor["sourceRevision"])
        if manifest.get("sourceRevision") != original_revision:
            raise ValueError("archive manifest does not retain the original source revision")
        for key in ("manifestRevision", "lockSha256", "dependencyLockSha256"):
            if key in provenance:
                if key not in manifest:
                    # A lock digest may be carried by the descriptor when the
                    # lock itself is archived outside the Runtime ZIP.
                    if key not in {"lockSha256", "dependencyLockSha256"}:
                        raise ValueError(f"archive manifest omits reviewed provenance field {key}")
                elif manifest.get(key) != provenance[key]:
                    raise ValueError(f"archive manifest provenance differs for {key}")
    if lock_bytes is not None:
        lock_spec = descriptor.get("lock")
        if not isinstance(lock_spec, Mapping) or _sha256(lock_bytes) != lock_spec.get("sha256"):
            raise ValueError("reviewed dependency lock digest does not match descriptor")
        if isinstance(provenance, Mapping):
            expected_lock_sha = provenance.get("lockSha256", provenance.get("dependencyLockSha256"))
            if expected_lock_sha is not None and _sha256(lock_bytes) != expected_lock_sha:
                raise ValueError("reviewed dependency lock differs from provenance")
        lock_path = descriptor.get("lockArchivePath")
        if lock_path:
            try:
                if archive.read(str(lock_path)) != lock_bytes:
                    raise ValueError("packaged dependency lock differs from the reviewed lock object")
            except KeyError as error:
                raise ValueError("reviewed archive omits the dependency lock") from error

    packaged_modules = descriptor.get("packagedModules")
    if packaged_modules is not None:
        if not isinstance(packaged_modules, Mapping) or not packaged_modules:
            raise ValueError("descriptor packagedModules must be a non-empty map")
        for name, expected in packaged_modules.items():
            if not isinstance(name, str) or not name:
                raise ValueError("descriptor packagedModules contains an invalid path")
            if isinstance(expected, Mapping):
                expected_sha = expected.get("sha256")
            else:
                expected_sha = expected
            if not isinstance(expected_sha, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_sha):
                raise ValueError(f"descriptor packagedModules.{name} must contain a SHA-256")
            try:
                packaged_bytes = archive.read(name)
            except KeyError as error:
                raise ValueError(f"reviewed archive omits checked module {name}") from error
            if _sha256(packaged_bytes) != expected_sha:
                raise ValueError(f"reviewed archive module digest mismatch for {name}")
    # The native Runtime entry point is pinned by runtimeConfiguration.  The
    # small offline acceptance fixture intentionally contains only the
    # manifest/prompt pair; a production archive may additionally carry the
    # entry-point module and dependency set.


def _runtime_arn(runtime_id: str) -> str:
    return f"arn:aws:bedrock-agentcore:{REGION}:{ACCOUNT}:runtime/{runtime_id}"


def _verified_inputs(session: Any, descriptor: Mapping[str, Any]) -> dict[str, Any]:
    """Read and verify every fixed archive input before native mutation."""
    s3 = session.client("s3")
    artifact_bytes, artifact_version = _download_object(s3, descriptor["artifact"], required_version=True)
    source_bytes, source_version = _download_object(
        s3,
        descriptor["source"],
        required_version=bool(descriptor["source"].get("versionId")),
    )
    configuration_bytes, configuration_version = _download_object(
        s3,
        descriptor["configuration"],
        required_version=bool(descriptor["configuration"].get("versionId")),
    )
    source_manifest_bytes = None
    source_manifest_version = ""
    if descriptor.get("sourceManifest") is not None:
        source_manifest_bytes, source_manifest_version = _download_object(
            s3, descriptor["sourceManifest"], required_version=True,
        )
    lock_bytes = None
    lock_version = ""
    if descriptor.get("lock") is not None:
        lock_bytes, lock_version = _download_object(s3, descriptor["lock"], required_version=True)
    try:
        configuration = json.loads(configuration_bytes)
    except json.JSONDecodeError as error:
        raise ValueError("reviewed runtime configuration object is not valid JSON") from error
    if _canonical(configuration) != _canonical(descriptor["runtimeConfiguration"]):
        raise ValueError("reviewed runtime configuration object differs from descriptor")
    _validate_archive(artifact_bytes, descriptor, source_bytes, source_manifest_bytes, lock_bytes)
    return {
        "artifactBytes": artifact_bytes,
        "artifactVersionId": artifact_version,
        "sourceBytes": source_bytes,
        "sourceVersionId": source_version,
        "sourceManifestBytes": source_manifest_bytes,
        "sourceManifestVersionId": source_manifest_version,
        "lockBytes": lock_bytes,
        "lockVersionId": lock_version,
        "configurationBytes": configuration_bytes,
        "configurationVersionId": configuration_version,
    }


def _canonical(value: Any) -> Any:
    """Normalize response-only optional AWS defaults for config comparison."""
    if isinstance(value, dict):
        result = {key: _canonical(item) for key, item in value.items()}
        protocol = result.get("protocolConfiguration")
        if isinstance(protocol, dict):
            # The service may materialize these documented HTTP defaults.
            if protocol.get("port") == 8080:
                protocol.pop("port")
            if protocol.get("path") == "/invocations":
                protocol.pop("path")
        # _runtime_matches compares each configuration member independently,
        # so protocolConfiguration itself can arrive here rather than through
        # the containing Runtime object.
        if result.get("port") == 8080:
            result.pop("port")
        if result.get("path") == "/invocations":
            result.pop("path")
        return result
    if isinstance(value, list):
        return [_canonical(item) for item in value]
    return value


def _runtime_matches(runtime: Mapping[str, Any], descriptor: Mapping[str, Any], runtime_arn: str) -> bool:
    if runtime.get("agentRuntimeArn") != runtime_arn or runtime.get("status") != "READY":
        return False
    wanted = descriptor["runtimeConfiguration"]
    for key, expected in wanted.items():
        actual = runtime.get(key)
        if _canonical(actual) != _canonical(expected):
            return False
    return True


def _wait_read(read: Callable[[], Mapping[str, Any]], *, success: str = "READY", status_key: str = "status", accept: Callable[[Mapping[str, Any]], bool] | None = None, label: str, timeout: float = 600.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    attempts = 0
    while True:
        try:
            value = dict(read())
        except ClientError as error:
            # Native creation/update responses can become readable shortly
            # after the control-plane acknowledgement.  Reconcile a bounded
            # NotFound window; all other errors remain fail-closed.
            if not _not_found(error):
                raise
            attempts += 1
            if time.monotonic() >= deadline or attempts >= 120:
                raise RuntimeError(f"timed out waiting for {label}") from error
            time.sleep(5)
            continue
        status = value.get(status_key)
        if status == success and (accept is None or accept(value)):
            return value
        if status is not None and ("FAILED" in str(status) or "ERROR" in str(status)):
            raise RuntimeError(f"{label} failed with status {status}")
        attempts += 1
        if time.monotonic() >= deadline or attempts >= 120:
            raise RuntimeError(f"timed out waiting for {label}")
        time.sleep(5)


def _stack_runtime_id(cloudformation: Any, stack_name: str) -> str:
    return _stack_outputs(cloudformation, stack_name)["RuntimeId"]


def _stack_outputs(cloudformation: Any, stack_name: str) -> dict[str, str]:
    response = cloudformation.describe_stacks(StackName=stack_name)
    stacks = response.get("Stacks")
    if not isinstance(stacks, list) or len(stacks) != 1:
        raise RuntimeError("agent stack read did not identify exactly one stack")
    outputs = stacks[0].get("Outputs", [])
    if not isinstance(outputs, list):
        raise RuntimeError("agent stack outputs are malformed")
    values: dict[str, str] = {}
    consumed = {"RuntimeId", "AlarmAdapterCodeSha256"}
    for item in outputs:
        if not isinstance(item, Mapping) or item.get("OutputKey") not in consumed:
            continue
        key, value = item.get("OutputKey"), item.get("OutputValue")
        if not isinstance(key, str) or not isinstance(value, str) or not value:
            raise RuntimeError("agent stack output has an invalid identity")
        if key in values:
            raise RuntimeError(f"agent stack exposes duplicate {key} outputs")
        values[key] = value
    if not values.get("RuntimeId"):
        raise RuntimeError("agent stack does not expose one RuntimeId output")
    return values


def _expected_adapter_code_sha(outputs: Mapping[str, str], descriptor: Mapping[str, Any]) -> tuple[str | None, str]:
    """Prefer the deployed stack's checked adapter asset over archive metadata."""
    if "AlarmAdapterCodeSha256" in outputs:
        value = outputs["AlarmAdapterCodeSha256"]
        if not re.fullmatch(r"[0-9a-f]{64}", value):
            raise ValueError("agent stack AlarmAdapterCodeSha256 output is invalid")
        return value, "stack"
    adapter = descriptor.get("adapter")
    if isinstance(adapter, Mapping) and adapter.get("codeSha256"):
        value = adapter["codeSha256"]
        if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
            raise ValueError("descriptor adapter.codeSha256 is invalid")
        return value, "descriptor"
    return None, "native"


def _list_versions(control: Any, runtime_id: str) -> list[str]:
    token: str | None = None
    versions: list[str] = []
    while True:
        request: dict[str, Any] = {"agentRuntimeId": runtime_id, "maxResults": 100}
        if token:
            request["nextToken"] = token
        response = control.list_agent_runtime_versions(**request)
        for row in response.get("agentRuntimes", []):
            version = row.get("agentRuntimeVersion")
            if isinstance(version, str) and RUNTIME_VERSION_RE.fullmatch(version):
                versions.append(version)
        token = response.get("nextToken")
        if not token:
            break
    return sorted(set(versions), key=lambda value: int(value), reverse=True)


def _find_or_publish_runtime(control: Any, runtime_id: str, descriptor: Mapping[str, Any], runtime_arn: str, existing_endpoint: Mapping[str, Any] | None = None) -> tuple[str, dict[str, Any]]:
    # A serving endpoint is the strongest existing publication hint.  Read its
    # numbered version in full before scanning unrelated historical versions.
    if existing_endpoint is not None and existing_endpoint.get("status") == "READY":
        bound_version = existing_endpoint.get("liveVersion")
        if (
            isinstance(bound_version, str)
            and RUNTIME_VERSION_RE.fullmatch(bound_version)
            and existing_endpoint.get("targetVersion", bound_version) == bound_version
        ):
            try:
                bound = control.get_agent_runtime(agentRuntimeId=runtime_id, agentRuntimeVersion=bound_version)
            except ClientError as error:
                if not _not_found(error):
                    raise
            else:
                if _runtime_matches(bound, descriptor, runtime_arn):
                    return bound_version, dict(bound)
    current = _wait_read(lambda: control.get_agent_runtime(agentRuntimeId=runtime_id), label="current AgentCore Runtime")
    if current.get("agentRuntimeId") not in (None, runtime_id):
        raise RuntimeError("AgentCore Runtime identity differs from the intended stack")

    # Read every numbered version's full details.  A list summary is not enough
    # to establish the package/configuration identity.
    for version in _list_versions(control, runtime_id):
        try:
            candidate = control.get_agent_runtime(agentRuntimeId=runtime_id, agentRuntimeVersion=version)
        except ClientError as error:
            if _not_found(error):
                continue
            raise
        if _runtime_matches(candidate, descriptor, runtime_arn):
            return version, dict(candidate)

    configuration = copy.deepcopy(descriptor["runtimeConfiguration"])
    configuration["agentRuntimeId"] = runtime_id
    configuration["clientToken"] = f"faulty-reference-{descriptor['artifact']['sha256'][:24]}"
    try:
        response = control.update_agent_runtime(**configuration)
    except Exception as publish_error:
        # An update acknowledgement can be lost after the immutable version
        # commits.  Probe the bounded version list before returning the unknown
        # result so a subsequent invocation will not publish a duplicate when
        # the native list becomes eventually consistent.
        for _ in range(12):
            for candidate_version in _list_versions(control, runtime_id):
                try:
                    candidate = control.get_agent_runtime(
                        agentRuntimeId=runtime_id,
                        agentRuntimeVersion=candidate_version,
                    )
                except ClientError as error:
                    if _not_found(error):
                        continue
                    raise
                if _runtime_matches(candidate, descriptor, runtime_arn):
                    raise RuntimeError("UpdateAgentRuntime response was lost; verified committed version is available") from publish_error
            time.sleep(5)
        raise
    version = response.get("agentRuntimeVersion")
    if not isinstance(version, str) or not RUNTIME_VERSION_RE.fullmatch(version):
        raise RuntimeError("UpdateAgentRuntime did not return a valid immutable version")
    candidate = _wait_read(
        lambda: control.get_agent_runtime(agentRuntimeId=runtime_id, agentRuntimeVersion=version),
        label=f"AgentCore Runtime version {version}",
        accept=lambda value: _runtime_matches(value, descriptor, runtime_arn),
    )
    return version, candidate


def _endpoint_matches(endpoint: Mapping[str, Any], runtime_arn: str, version: str, expected_arn: str) -> bool:
    return (
        endpoint.get("agentRuntimeArn") == runtime_arn
        and endpoint.get("agentRuntimeEndpointArn") == expected_arn
        and endpoint.get("status") == "READY"
        and endpoint.get("liveVersion") == version
        and endpoint.get("targetVersion", version) == version
    )


def _ensure_endpoint(control: Any, runtime_id: str, runtime_arn: str, endpoint_name: str, version: str, descriptor: Mapping[str, Any]) -> dict[str, Any]:
    expected_arn = f"{runtime_arn}/runtime-endpoint/{endpoint_name}"
    try:
        endpoint = control.get_agent_runtime_endpoint(agentRuntimeId=runtime_id, endpointName=endpoint_name)
        exists = True
    except ClientError as error:
        if not _not_found(error):
            raise
        endpoint = None
        exists = False

    if not exists:
        request = {
            "agentRuntimeId": runtime_id,
            "name": endpoint_name,
            "agentRuntimeVersion": version,
            "clientToken": f"faulty-reference-endpoint-{descriptor['artifact']['sha256'][:24]}",
        }
        # A lost response is intentionally propagated.  The next invocation
        # begins with GetAgentRuntimeEndpoint and reconciles the committed one.
        control.create_agent_runtime_endpoint(**request)
        endpoint = _wait_read(
            lambda: control.get_agent_runtime_endpoint(agentRuntimeId=runtime_id, endpointName=endpoint_name),
            label="new faulty AgentCore endpoint",
        )
    elif endpoint.get("status") != "READY":
        endpoint = _wait_read(
            lambda: control.get_agent_runtime_endpoint(agentRuntimeId=runtime_id, endpointName=endpoint_name),
            label="faulty AgentCore endpoint",
        )

    if endpoint.get("agentRuntimeArn") != runtime_arn or endpoint.get("agentRuntimeEndpointArn") != expected_arn:
        raise RuntimeError("faulty endpoint identity differs from the intended Runtime")
    # A READY response whose optional target disagrees with its live version is
    # not a confirmed corrupt binding: it is a stale/transitioning observation.
    # Do not repin on that evidence.  A genuinely corrupt READY endpoint has
    # matching live/target values and may be corrected by this maintenance
    # operation.
    if endpoint.get("status") == "READY" and "targetVersion" in endpoint and endpoint.get("targetVersion") != endpoint.get("liveVersion"):
        raise RuntimeError("faulty endpoint returned an inconsistent live/target version")
    if not _endpoint_matches(endpoint, runtime_arn, version, expected_arn):
        # A READY endpoint with a verified foreign version is the only binding
        # this fixed maintenance command may repin.  In-progress/unknown reads
        # were handled above and never reach this mutation.
        control.update_agent_runtime_endpoint(
            agentRuntimeId=runtime_id,
            endpointName=endpoint_name,
            agentRuntimeVersion=version,
            clientToken=f"faulty-reference-pin-{descriptor['artifact']['sha256'][:24]}-{version}",
        )
        endpoint = _wait_read(
            lambda: control.get_agent_runtime_endpoint(agentRuntimeId=runtime_id, endpointName=endpoint_name),
            label="faulty AgentCore endpoint repin",
            accept=lambda value: _endpoint_matches(value, runtime_arn, version, expected_arn),
        )
    if not _endpoint_matches(endpoint, runtime_arn, version, expected_arn):
        raise RuntimeError("faulty endpoint does not serve the verified Runtime version")
    return dict(endpoint)


def _read_existing_endpoint(control: Any, runtime_id: str, endpoint_name: str) -> dict[str, Any] | None:
    try:
        return dict(control.get_agent_runtime_endpoint(agentRuntimeId=runtime_id, endpointName=endpoint_name))
    except ClientError as error:
        if _not_found(error):
            return None
        raise


def _adapter_function_name(descriptor: Mapping[str, Any]) -> str:
    adapter = descriptor.get("adapter")
    if isinstance(adapter, dict) and isinstance(adapter.get("functionName"), str) and adapter["functionName"]:
        return adapter["functionName"]
    return ADAPTER_FUNCTION_NAME


def _adapter_code_hash(config: Mapping[str, Any]) -> str | None:
    value = config.get("CodeSha256")
    if not isinstance(value, str) or not value:
        return None
    try:
        raw = base64.b64decode(value, validate=True)
    except ValueError:
        return None
    return raw.hex()


def _ensure_adapter(
    adapter_client: Any,
    descriptor: Mapping[str, Any],
    runtime_arn: str,
    version: str,
    expected_code_sha256: str | None = None,
) -> dict[str, Any]:
    function_name = _adapter_function_name(descriptor)
    config = _wait_read(
        lambda: adapter_client.get_function_configuration(FunctionName=function_name),
        success="Successful",
        status_key="LastUpdateStatus",
        label="alarm adapter",
    )
    expected_adapter = descriptor.get("adapter")
    if isinstance(expected_adapter, dict):
        if expected_adapter.get("functionArn") and config.get("FunctionArn") != expected_adapter["functionArn"]:
            raise RuntimeError("alarm adapter ARN differs from the fixed descriptor")
        if expected_adapter.get("tracingMode") and config.get("TracingConfig", {}).get("Mode") != expected_adapter["tracingMode"]:
            raise RuntimeError("alarm adapter tracing differs from the fixed descriptor")

    # The adapter is a shared selector router after the Phase 21 cutover. A
    # fixed-reference repeat must never repin it to ``faulty``: that would
    # silently undo an independently selected repaired publication. Keep the
    # legacy candidate-specific environment as a compatibility path for the
    # one-time pre-cutover publisher fixtures; once the selection-table key is
    # present, any mismatch is a hard error rather than a repair target.
    selector_environment = {
        "AGENT_RUNTIME_ARN": runtime_arn,
        "AGENT_ALARM_ARN": descriptor["alarmArn"],
        SELECTION_TABLE_ENV: descriptor["controller"]["tableName"],
    }
    legacy_environment = {
        "AGENT_RUNTIME_ARN": runtime_arn,
        "AGENT_ENDPOINT_NAME": "faulty",
        "AGENT_RUNTIME_VERSION": version,
        "AGENT_ALARM_ARN": descriptor["alarmArn"],
        "AGENT_SOURCE_REVISION": descriptor["sourceRevision"],
        "AGENT_ARTIFACT_SHA256": descriptor["artifact"]["sha256"],
    }
    observed = config.get("Environment", {}).get("Variables", {})
    if SELECTION_TABLE_ENV in observed:
        if observed != selector_environment:
            raise RuntimeError("alarm adapter selector environment differs from the fixed binding")
        environment = selector_environment
    else:
        # Legacy source assertions and the pre-cutover migration still use a
        # candidate-specific router. This path is intentionally one-way:
        # selector-mode environments are never overwritten by this operation.
        environment = legacy_environment
        if observed != environment:
            request: dict[str, Any] = {"FunctionName": function_name, "Environment": {"Variables": environment}}
            if config.get("RevisionId"):
                request["RevisionId"] = config["RevisionId"]
            adapter_client.update_function_configuration(**request)
            config = _wait_read(
                lambda: adapter_client.get_function_configuration(FunctionName=function_name),
                success="Successful",
                status_key="LastUpdateStatus",
                label="alarm adapter update",
            )
    expected_function_arn = None
    if isinstance(expected_adapter, dict) and expected_adapter.get("functionArn"):
        expected_function_arn = expected_adapter["functionArn"]
    else:
        expected_function_arn = f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:{function_name}"
    if config.get("FunctionArn") != expected_function_arn:
        raise RuntimeError("alarm adapter function identity differs from the fixed binding")
    observed_code_sha = _adapter_code_hash(config)
    if observed_code_sha is None:
        raise RuntimeError("alarm adapter code hash is unavailable")
    if expected_code_sha256 and observed_code_sha != expected_code_sha256:
        raise RuntimeError("alarm adapter code differs from the deployed stack/reference binding")
    if config.get("Environment", {}).get("Variables") != environment:
        raise RuntimeError("alarm adapter environment readback does not match the verified publication")
    if config.get("TracingConfig", {}).get("Mode") != "Active":
        raise RuntimeError("alarm adapter tracing readback is not active")
    return config


def _record_item(
    descriptor: Mapping[str, Any],
    *,
    runtime_arn: str,
    version: str,
    endpoint: Mapping[str, Any],
    adapter: Mapping[str, Any],
    artifact_version: str,
    source_version: str,
    source_manifest_version: str,
    lock_version: str,
    configuration_version: str,
) -> dict[str, dict[str, str]]:
    values: dict[str, object] = {
        "candidateId": "faulty",
        "sourceRevision": descriptor["sourceRevision"],
        "promptSha256": descriptor["promptSha256"],
        "modelId": descriptor["modelId"],
        "artifactSha256": descriptor["artifact"]["sha256"],
        "runtimeArn": runtime_arn,
        "runtimeVersion": version,
        "endpointName": "faulty",
        "endpointArn": endpoint["agentRuntimeEndpointArn"],
        "alarmArn": descriptor["alarmArn"],
        "sourceSha256": descriptor["source"]["sha256"],
        "configurationSha256": descriptor["configuration"]["sha256"],
        "artifactVersionId": artifact_version,
        "status": "reference",
        "adapterArn": adapter.get("FunctionArn", ""),
        "adapterRevisionId": adapter.get("RevisionId", ""),
        "sourceVersionId": source_version,
        "configurationVersionId": configuration_version,
    }
    if descriptor.get("sourceManifest") is not None:
        values["sourceManifestSha256"] = descriptor["sourceManifest"]["sha256"]
        values["sourceManifestVersionId"] = source_manifest_version
    if descriptor.get("lock") is not None:
        values["lockSha256"] = descriptor["lock"]["sha256"]
        values["lockVersionId"] = lock_version
    adapter_hash = _adapter_code_hash(adapter)
    if adapter_hash:
        values["adapterCodeSha256"] = adapter_hash
    provenance = descriptor.get("provenance")
    if isinstance(provenance, dict):
        for key in ("originalRevision", "manifestRevision", "lockSha256", "dependencyLockSha256", "buildSha256"):
            if key in provenance:
                values[key] = provenance[key]
    return {"pk": _attr(descriptor["controller"]["pk"]), **{key: _attr(value) for key, value in values.items()}}


def _record_matches(item: Mapping[str, Any], expected: Mapping[str, Any]) -> bool:
    # Compare every field this publisher writes.  In particular, optional
    # source-manifest/lock versions, adapter digest/revision, and provenance
    # are part of the fixed tuple when present; a stale partial record is not a
    # completed publication merely because its primary version still matches.
    return all(item.get(key) == value for key, value in expected.items())


def _ensure_record(
    controller: Any,
    descriptor: Mapping[str, Any],
    item: dict[str, dict[str, str]],
    *,
    preserve_existing: bool = False,
) -> dict[str, dict[str, str]]:
    table = descriptor["controller"]["tableName"]
    key = {"pk": {"S": descriptor["controller"]["pk"]}}
    existing_response = controller.get_item(TableName=table, Key=key, ConsistentRead=True)
    existing = existing_response.get("Item") or {}
    if existing and existing.get("candidateId") not in (None, item["candidateId"]):
        raise RuntimeError("fixed publication record belongs to a different candidate")
    expected_readback = item
    if existing and preserve_existing:
        # Adapter revision/digest are historical provenance. They can differ
        # from the current shared selector router even when the fixed faulty
        # publication itself is unchanged. Preserve the existing row exactly
        # after validating every fixed archive/runtime identity field. A
        # partial or conflicting existing row is not safe to overwrite.
        preserved_fields = {
            key_name: value for key_name, value in item.items()
            if key_name not in {"adapterArn", "adapterRevisionId", "adapterCodeSha256"}
        }
        if not _record_matches(existing, preserved_fields):
            raise RuntimeError("existing fixed publication record conflicts with the reviewed archive")
        expected_readback = preserved_fields
    elif existing:
        # Before the selector cutover the fixed publisher owned the complete
        # legacy row, including its adapter attestation. Retain that repair
        # behavior for the compatibility path; selector mode above is the
        # explicit no-overwrite boundary.
        expected_readback = item
    if not existing or (not preserve_existing and not _record_matches(existing, item)):
        controller.put_item(TableName=table, Item=item)
    readback = controller.get_item(TableName=table, Key=key, ConsistentRead=True).get("Item") or {}
    if existing and preserve_existing and readback != existing:
        raise RuntimeError("fixed publication historical provenance changed during readback")
    if not _record_matches(readback, expected_readback):
        raise RuntimeError("fixed publication record strong readback does not match")
    return dict(readback)


def _preflight_stack(cloudformation: Any, runtime_id: str, runtime_arn: str) -> dict[str, Any]:
    response = cloudformation.describe_stacks(StackName=STACK_NAME)
    stacks = response.get("Stacks")
    if not isinstance(stacks, list) or len(stacks) != 1:
        raise RuntimeError("agent stack preflight did not identify exactly one stack")
    stack = stacks[0]
    status = stack.get("StackStatus")
    if status not in {"CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "IMPORT_COMPLETE"}:
        raise RuntimeError(f"agent stack is not settled for reference migration: {status}")
    resources: list[dict[str, Any]] = []
    token: str | None = None
    while True:
        request: dict[str, Any] = {"StackName": STACK_NAME}
        if token:
            request["NextToken"] = token
        page = cloudformation.list_stack_resources(**request)
        page_items = page.get("StackResourceSummaries")
        if not isinstance(page_items, list):
            raise RuntimeError("agent stack resource preflight is malformed")
        resources.extend(dict(item) for item in page_items)
        token = page.get("NextToken")
        if not token:
            break
    runtime_resources = [item for item in resources if item.get("LogicalResourceId") == "Runtime"]
    if len(runtime_resources) != 1 or runtime_resources[0].get("PhysicalResourceId") != runtime_id:
        raise RuntimeError("agent stack Runtime physical identity differs from its output")
    endpoint_resources = [
        item for item in resources
        if item.get("ResourceType") == "AWS::BedrockAgentCore::RuntimeEndpoint"
    ]
    if len(endpoint_resources) > 1 or (endpoint_resources and endpoint_resources[0].get("LogicalResourceId") != "FaultyEndpoint"):
        raise RuntimeError("agent stack has an unexpected RuntimeEndpoint owner")
    endpoint_resource = endpoint_resources[0] if endpoint_resources else None
    if endpoint_resource is not None:
        expected_endpoint_arn = f"{runtime_arn}/runtime-endpoint/faulty"
        if endpoint_resource.get("PhysicalResourceId") != expected_endpoint_arn:
            raise RuntimeError("agent stack owns a foreign faulty endpoint")
    return {
        "stackId": stack.get("StackId"),
        "stackStatus": status,
        "runtimeId": runtime_id,
        "runtimeArn": runtime_arn,
        "legacyEndpointPresent": endpoint_resource is not None,
        "legacyEndpointArn": endpoint_resource.get("PhysicalResourceId") if endpoint_resource else None,
        "resourceCount": len(resources),
    }


def preflight_faulty_reference(session: Any, *, require_rollback: bool = False) -> dict[str, Any]:
    """Perform the complete read-only migration/reference preflight.

    This is intentionally separate from :func:`setup_faulty_reference`: the
    latter has a no-argument write entry point for the fixed workflow, while
    migration can call this operation before removing the legacy CloudFormation
    endpoint.  The function performs only native reads and returns identity and
    digest evidence safe to retain in the cutover rollback record.  Set
    ``require_rollback`` for the destructive migration gate; its default allows
    a known endpoint/adapter version gap to be reported as a recoverable
    partial publication after cutover.
    """
    descriptor = _read_descriptor()
    _validate_descriptor(descriptor)
    region = getattr(session, "region_name", None)
    if region not in (None, REGION):
        raise RuntimeError("AWS session Region is outside the fixed reference scope")
    sts = session.client("sts")
    identity = sts.get_caller_identity()
    if identity.get("Account") != ACCOUNT:
        raise RuntimeError("AWS caller account is outside the fixed reference scope")

    verified = _verified_inputs(session, descriptor)
    archive = {
        "artifactSha256": _sha256(verified["artifactBytes"]),
        "artifactVersionId": verified["artifactVersionId"],
        "sourceSha256": _sha256(verified["sourceBytes"]),
        "sourceVersionId": verified["sourceVersionId"],
        "configurationSha256": _sha256(verified["configurationBytes"]),
        "configurationVersionId": verified["configurationVersionId"],
        "reviewedArtifactSha256": descriptor["artifact"]["sha256"],
        "sourceRevision": descriptor["sourceRevision"],
    }
    if descriptor.get("sourceManifest") is not None:
        archive.update({
            "sourceManifestSha256": _sha256(verified["sourceManifestBytes"]),
            "sourceManifestVersionId": verified["sourceManifestVersionId"],
        })
    if descriptor.get("lock") is not None:
        archive.update({
            "lockSha256": _sha256(verified["lockBytes"]),
            "lockVersionId": verified["lockVersionId"],
        })

    cloudformation = session.client("cloudformation")
    stack_outputs = _stack_outputs(cloudformation, descriptor["runtimeName"])
    runtime_id = stack_outputs["RuntimeId"]
    runtime_arn = _runtime_arn(runtime_id)
    expected_adapter_code_sha, adapter_code_source = _expected_adapter_code_sha(stack_outputs, descriptor)
    stack = _preflight_stack(cloudformation, runtime_id, runtime_arn)
    control = session.client("bedrock-agentcore-control")
    current = _wait_read(
        lambda: control.get_agent_runtime(agentRuntimeId=runtime_id),
        label="current AgentCore Runtime preflight",
    )
    if current.get("agentRuntimeArn") != runtime_arn:
        raise RuntimeError("current AgentCore Runtime ARN differs from the stack identity")
    existing_endpoint = _read_existing_endpoint(control, runtime_id, descriptor["endpointName"])
    if existing_endpoint is not None:
        expected_endpoint_arn = f"{runtime_arn}/runtime-endpoint/faulty"
        if existing_endpoint.get("agentRuntimeArn") != runtime_arn or existing_endpoint.get("agentRuntimeEndpointArn") != expected_endpoint_arn:
            raise RuntimeError("native faulty endpoint preflight identity differs from the stack")
        if existing_endpoint.get("status") != "READY":
            existing_endpoint = _wait_read(
                lambda: control.get_agent_runtime_endpoint(agentRuntimeId=runtime_id, endpointName="faulty"),
                label="faulty AgentCore endpoint preflight",
            )
        live_version = existing_endpoint.get("liveVersion")
        if not isinstance(live_version, str) or not RUNTIME_VERSION_RE.fullmatch(live_version):
            raise RuntimeError("native faulty endpoint has no immutable live version")
        target_version = existing_endpoint.get("targetVersion", live_version)
        if target_version != live_version:
            raise RuntimeError("native faulty endpoint has an unresolved target version")
        serving_runtime = control.get_agent_runtime(agentRuntimeId=runtime_id, agentRuntimeVersion=live_version)
        if serving_runtime.get("agentRuntimeArn") != runtime_arn or serving_runtime.get("status") != "READY":
            raise RuntimeError("native rollback Runtime version is not READY under the intended Runtime")
    else:
        live_version = None
        serving_runtime = None

    adapter = _wait_read(
        lambda: session.client("lambda").get_function_configuration(FunctionName=_adapter_function_name(descriptor)),
        success="Successful",
        status_key="LastUpdateStatus",
        label="alarm adapter preflight",
    )
    expected_adapter = descriptor.get("adapter")
    expected_function_arn = (
        expected_adapter.get("functionArn") if isinstance(expected_adapter, Mapping) and expected_adapter.get("functionArn")
        else f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:{_adapter_function_name(descriptor)}"
    )
    if adapter.get("FunctionArn") != expected_function_arn:
        raise RuntimeError("alarm adapter preflight ARN differs from the fixed binding")
    if adapter.get("TracingConfig", {}).get("Mode") != "Active":
        raise RuntimeError("alarm adapter preflight tracing is not active")
    adapter_code_sha = _adapter_code_hash(adapter)
    if adapter_code_sha is None:
        raise RuntimeError("alarm adapter preflight code hash is unavailable")
    if expected_adapter_code_sha and adapter_code_sha != expected_adapter_code_sha:
        raise RuntimeError("alarm adapter preflight code differs from the deployed stack/reference binding")
    environment = adapter.get("Environment", {}).get("Variables", {})
    selector_mode = SELECTION_TABLE_ENV in environment
    if selector_mode:
        expected_selector = {
            "AGENT_RUNTIME_ARN": runtime_arn,
            "AGENT_ALARM_ARN": descriptor["alarmArn"],
            SELECTION_TABLE_ENV: descriptor["controller"]["tableName"],
        }
        if environment != expected_selector:
            raise RuntimeError("alarm adapter preflight selector binding differs from the fixed table")
    elif environment.get("AGENT_RUNTIME_ARN") != runtime_arn or environment.get("AGENT_ENDPOINT_NAME") != "faulty":
        raise RuntimeError("alarm adapter preflight is bound outside the fixed Runtime endpoint")
    adapter_version = environment.get("AGENT_RUNTIME_VERSION")
    adapter_runtime = None
    adapter_version_matches = live_version is None or (not selector_mode and adapter_version == live_version)
    if live_version is not None and not adapter_version_matches:
        # After a successful endpoint create/update, the adapter may still
        # attest the prior valid immutable version because its configuration
        # update was lost or failed.  This is a known, recoverable partial
        # publication for the setup operation, but never a trusted rollback
        # state for destructive legacy migration.
        if not selector_mode:
            if not isinstance(adapter_version, str) or not RUNTIME_VERSION_RE.fullmatch(adapter_version):
                raise RuntimeError("alarm adapter preflight has no valid prior Runtime binding")
            adapter_runtime = control.get_agent_runtime(
                agentRuntimeId=runtime_id,
                agentRuntimeVersion=adapter_version,
            )
            if adapter_runtime.get("agentRuntimeArn") != runtime_arn or adapter_runtime.get("status") != "READY":
                raise RuntimeError("alarm adapter prior Runtime binding is not a READY immutable version")
        if require_rollback:
            raise RuntimeError("alarm adapter preflight has no legacy version for trusted rollback")
    trusted_rollback = {
        "eligible": bool(existing_endpoint is not None and serving_runtime is not None and adapter_version_matches),
        "runtimeId": runtime_id,
        "runtimeArn": runtime_arn,
        "endpointArn": existing_endpoint.get("agentRuntimeEndpointArn") if existing_endpoint else None,
        "runtimeVersion": live_version,
        "adapterArn": adapter.get("FunctionArn"),
        "adapterRevisionId": adapter.get("RevisionId"),
        "adapterCodeSha256": adapter_code_sha,
    }
    partial_binding = None
    if existing_endpoint is not None and serving_runtime is not None and not adapter_version_matches:
        partial_binding = {
            "endpointVersion": live_version,
            "adapterVersion": adapter_version,
            "adapterRuntimeArn": adapter_runtime.get("agentRuntimeArn") if adapter_runtime else None,
            "adapterRuntimeStatus": adapter_runtime.get("status") if adapter_runtime else None,
            "needsAdapterUpdate": True,
        }
    if require_rollback and not trusted_rollback["eligible"]:
        raise RuntimeError("trusted rollback preflight is incomplete")
    rollback_runtime = serving_runtime or current
    runtime_configuration = {
        key: copy.deepcopy(rollback_runtime.get(key))
        for key in (
            "agentRuntimeArtifact",
            "roleArn",
            "environmentVariables",
            "networkConfiguration",
            "protocolConfiguration",
            "lifecycleConfiguration",
            "metadataConfiguration",
        )
        if key in rollback_runtime
    }
    return {
        "status": "ready" if trusted_rollback["eligible"] else ("partial" if partial_binding else "already_detached"),
        "account": identity.get("Account"),
        "region": REGION,
        "stack": stack,
        "runtime": {
            "runtimeId": runtime_id,
            "runtimeArn": runtime_arn,
            "status": current.get("status"),
            "version": rollback_runtime.get("agentRuntimeVersion"),
            "configuration": runtime_configuration,
        },
        "endpoint": {
            "present": existing_endpoint is not None,
            "arn": existing_endpoint.get("agentRuntimeEndpointArn") if existing_endpoint else None,
            "version": live_version,
            "status": existing_endpoint.get("status") if existing_endpoint else None,
        },
        "adapter": {
            "arn": adapter.get("FunctionArn"),
            "revisionId": adapter.get("RevisionId"),
            "codeSha256": adapter_code_sha,
            "expectedCodeSha256": expected_adapter_code_sha,
            "expectedCodeSource": adapter_code_source,
            "tracing": adapter.get("TracingConfig", {}).get("Mode"),
        },
        "archive": archive,
        "trustedRollback": trusted_rollback,
        "partialBinding": partial_binding,
    }


def setup_faulty_reference(session: Any) -> dict[str, Any]:
    """Restore/verify the fixed faulty publication using a boto3-like session."""
    descriptor = _read_descriptor()
    _validate_descriptor(descriptor)
    # Every input object is checked before resolving or mutating any native
    # resource.  The versioned ZIP is the immutable publication bytes.
    verified = _verified_inputs(session, descriptor)

    cloudformation = session.client("cloudformation")
    stack_outputs = _stack_outputs(cloudformation, descriptor["runtimeName"])
    runtime_id = stack_outputs["RuntimeId"]
    runtime_arn = _runtime_arn(runtime_id)
    expected_adapter_code_sha, _adapter_code_source = _expected_adapter_code_sha(stack_outputs, descriptor)
    control = session.client("bedrock-agentcore-control")
    existing_endpoint = _read_existing_endpoint(control, runtime_id, descriptor["endpointName"])
    if existing_endpoint is not None:
        expected_endpoint_arn = f"{runtime_arn}/runtime-endpoint/{descriptor['endpointName']}"
        if existing_endpoint.get("agentRuntimeArn") != runtime_arn or existing_endpoint.get("agentRuntimeEndpointArn") != expected_endpoint_arn:
            raise RuntimeError("faulty endpoint identity differs from the intended Runtime")
    version, _runtime = _find_or_publish_runtime(control, runtime_id, descriptor, runtime_arn, existing_endpoint)
    endpoint = _ensure_endpoint(control, runtime_id, runtime_arn, descriptor["endpointName"], version, descriptor)

    adapter_client = session.client("lambda")
    adapter = _ensure_adapter(adapter_client, descriptor, runtime_arn, version, expected_adapter_code_sha)
    item = _record_item(
        descriptor,
        runtime_arn=runtime_arn,
        version=version,
        endpoint=endpoint,
        adapter=adapter,
        artifact_version=verified["artifactVersionId"],
        source_version=verified["sourceVersionId"],
        source_manifest_version=verified["sourceManifestVersionId"],
        lock_version=verified["lockVersionId"],
        configuration_version=verified["configurationVersionId"],
    )
    preserve_existing = SELECTION_TABLE_ENV in adapter.get("Environment", {}).get("Variables", {})
    _ensure_record(
        session.client("dynamodb"), descriptor, item,
        preserve_existing=preserve_existing,
    )
    return {
        "status": "reference",
        "candidateId": "faulty",
        "runtimeArn": runtime_arn,
        "runtimeVersion": version,
        "endpointName": "faulty",
        "endpointArn": endpoint["agentRuntimeEndpointArn"],
        "artifactSha256": descriptor["artifact"]["sha256"],
        "sourceRevision": descriptor["sourceRevision"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    # The only accepted positional is the fixed read-only preflight.  The
    # no-argument form remains the sole write operation; parsing happens before
    # boto3.Session so mutable caller overrides cannot reach AWS.
    parser.add_argument("operation", nargs="?", choices=("preflight",))
    args = parser.parse_args()
    session = boto3.Session(region_name=REGION)
    result = preflight_faulty_reference(session) if args.operation == "preflight" else setup_faulty_reference(session)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
