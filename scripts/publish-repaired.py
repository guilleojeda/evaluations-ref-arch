"""Publish the protected, exactly qualified repaired AgentCore package.

The protected release job supplies the qualification receipt and the current
``demo-deploy`` head to :func:`publish_repaired`.  This module deliberately
does not read a checkout-side receipt: a candidate can edit such a file, but
only the protected workflow can supply publication authority.

All package/configuration/source reads happen before serving writes.  Native
AgentCore writes are not atomic, so every invocation reconciles committed
state by strong reads and a retry converges without creating another Runtime
version or endpoint.  The existing faulty endpoint, adapter binding, and
historical run records are never changed.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import re
import time
from typing import Any, Callable, Mapping
import zipfile

import boto3
from botocore.exceptions import ClientError


REGION = "us-east-1"
ACCOUNT = "027224425948"
STACK_NAME = "IncidentTriageDemoAgent"
TABLE_NAME = "IncidentTriageDemoControllerRun"
REPAIRED_PK = "AGENT_PUBLICATION#repaired"
EVIDENCE_BUCKET = f"incident-triage-demo-evidence-{ACCOUNT}-{REGION}"
STAGING_PREFIX = "agent-evaluation/phase20"
ASSET_BUCKET = f"cdk-evaltalk-assets-{ACCOUNT}-{REGION}"
RUNTIME_VERSION_RE = re.compile(r"^[1-9][0-9]{0,4}$")
REVISION_RE = re.compile(r"^[0-9a-f]{40}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _attr(value: object) -> dict[str, str]:
    return {"S": str(value)}


def _canonical(value: Any) -> Any:
    """Normalize response-only AWS defaults for configuration comparisons."""

    if isinstance(value, Mapping):
        result = {key: _canonical(item) for key, item in value.items()}
        protocol = result.get("protocolConfiguration")
        if isinstance(protocol, Mapping):
            protocol = dict(protocol)
            if protocol.get("port") == 8080:
                protocol.pop("port")
            if protocol.get("path") == "/invocations":
                protocol.pop("path")
            result["protocolConfiguration"] = protocol
        if result.get("port") == 8080:
            result.pop("port")
        if result.get("path") == "/invocations":
            result.pop("path")
        return result
    if isinstance(value, list):
        return [_canonical(item) for item in value]
    return value


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


def _required_sha(mapping: Mapping[str, Any], key: str, context: str) -> str:
    value = _required_string(mapping, key, context)
    if not SHA256_RE.fullmatch(value):
        raise ValueError(f"{context}.{key} must be a lowercase SHA-256")
    return value


def _validate_spec(spec: Any, context: str, *, require_version: bool) -> Mapping[str, Any]:
    if not isinstance(spec, Mapping):
        raise ValueError(f"qualification.{context} must be an object")
    _required_string(spec, "bucket", context)
    _required_string(spec, "key", context)
    _required_sha(spec, "sha256", context)
    if require_version or "versionId" in spec:
        version = _required_string(spec, "versionId", context)
        if version.lower() in {"null", "none"}:
            raise ValueError(f"{context}.versionId is not a concrete S3 VersionId")
    return spec


def _validate_qualification(
    qualification: Any,
    current_demo_revision: str,
    *,
    allow_unversioned_staging: bool = False,
) -> Mapping[str, Any]:
    if not isinstance(qualification, Mapping):
        raise ValueError("protected qualification must be a JSON object")
    if qualification.get("schemaVersion") != 1:
        raise ValueError("unsupported protected qualification schema")
    if qualification.get("status") != "eligible":
        raise ValueError("qualification is not eligible for publication")
    if qualification.get("candidateId") != "repaired":
        raise ValueError("protected qualification must identify repaired")
    if qualification.get("endpointName") != "repaired":
        raise ValueError("protected qualification must identify endpoint repaired")
    if qualification.get("runtimeName") != STACK_NAME:
        raise ValueError("qualification runtimeName must identify the agent stack")
    if "stagedArtifact" in qualification:
        raise ValueError("qualification.stagedArtifact is not a supported publication input")
    source_revision = _required_string(qualification, "sourceRevision", "qualification")
    if not REVISION_RE.fullmatch(source_revision):
        raise ValueError("qualification sourceRevision must be a Git commit identity")
    if source_revision != current_demo_revision:
        raise ValueError("qualification is for a superseded demo-deploy head")
    _required_sha(qualification, "promptSha256", "qualification")
    _required_string(qualification, "modelId", "qualification")
    _required_string(qualification, "alarmArn", "qualification")

    artifact_spec = qualification.get("artifact")
    artifact = _validate_spec(
        artifact_spec,
        "artifact",
        require_version=not (allow_unversioned_staging and isinstance(artifact_spec, Mapping)),
    )
    source = _validate_spec(
        qualification.get("source"),
        "source",
        require_version=not allow_unversioned_staging,
    )
    configuration = _validate_spec(
        qualification.get("configuration"),
        "configuration",
        require_version=not allow_unversioned_staging,
    )

    runtime_configuration = qualification.get("runtimeConfiguration")
    if not isinstance(runtime_configuration, Mapping):
        raise ValueError("qualification.runtimeConfiguration must be an object")
    runtime_artifact = runtime_configuration.get("agentRuntimeArtifact")
    if not isinstance(runtime_artifact, Mapping):
        raise ValueError("qualification runtime artifact is missing")
    code = runtime_artifact.get("codeConfiguration")
    if not isinstance(code, Mapping):
        raise ValueError("qualification codeConfiguration is missing")
    if code.get("runtime") != "PYTHON_3_13" or code.get("entryPoint") != ["opentelemetry-instrument", "main.py"]:
        raise ValueError("qualification Runtime entry point differs from the approved package")
    code_s3 = code.get("code", {}).get("s3") if isinstance(code.get("code"), Mapping) else None
    if not isinstance(code_s3, Mapping):
        raise ValueError("qualification Runtime must use S3 code")
    if code_s3.get("bucket") != artifact["bucket"] or code_s3.get("prefix") != artifact["key"]:
        raise ValueError("qualification Runtime is not pinned to the reviewed artifact/version")
    expected_artifact_version = artifact.get("versionId")
    if expected_artifact_version is not None and code_s3.get("versionId") != expected_artifact_version:
        raise ValueError("qualification Runtime is not pinned to the reviewed artifact/version")
    if expected_artifact_version is None and "versionId" in code_s3:
        raise ValueError("unversioned staging configuration unexpectedly carries a VersionId")

    environment = runtime_configuration.get("environmentVariables")
    if not isinstance(environment, Mapping) or not environment:
        raise ValueError("qualification Runtime environment is missing")
    if any(not isinstance(key, str) or not isinstance(value, str) for key, value in environment.items()):
        raise ValueError("qualification Runtime environment must be a string map")
    environment_checks = {
        "AGENT_CANDIDATE_ID": "repaired",
        "AGENT_ENDPOINT_NAME": "repaired",
        "AGENT_SOURCE_REVISION": source_revision,
        "AGENT_MODEL_ID": qualification["modelId"],
        "AGENT_ALARM_ARN": qualification["alarmArn"],
        "AGENT_ARTIFACT_SHA256": artifact["sha256"],
    }
    for key, expected in environment_checks.items():
        if environment.get(key) != expected:
            raise ValueError(f"qualification Runtime environment {key} is not pinned to repaired")

    controller = qualification.get("controller")
    if (
        not isinstance(controller, Mapping)
        or controller.get("tableName") != TABLE_NAME
        or controller.get("pk") != REPAIRED_PK
    ):
        raise ValueError("qualification controller record is not the repaired publication key")

    case_set = qualification.get("caseSet")
    if not isinstance(case_set, Mapping):
        raise ValueError("qualification caseSet is missing")
    _required_sha(case_set, "sha256", "caseSet")
    inputs = qualification.get("inputs")
    if not isinstance(inputs, Mapping) or not isinstance(inputs.get("caseIds"), list) or not inputs["caseIds"]:
        raise ValueError("qualification inputs must identify a non-empty case set")
    if inputs.get("suiteSha256") != case_set["sha256"]:
        raise ValueError("qualification case-set digest differs from inputs")

    evaluation = qualification.get("evaluation")
    reports = qualification.get("reports")
    if not isinstance(evaluation, Mapping) or not isinstance(reports, list) or not reports:
        raise ValueError("qualification evaluation reports are missing")
    report_digest = _required_sha(qualification, "reportIdentitiesSha256", "qualification")
    if evaluation.get("reportIdentitiesSha256") != report_digest or evaluation.get("reportIdentities") != reports:
        raise ValueError("qualification report identities are inconsistent")
    report_case_ids = [item.get("caseId") for item in reports if isinstance(item, Mapping)]
    if len(report_case_ids) != len(reports) or report_case_ids != inputs["caseIds"]:
        raise ValueError("qualification reports do not match the selected case roster")

    review = qualification.get("humanReview")
    if not isinstance(review, Mapping):
        raise ValueError("protected human review is missing")
    if review.get("status") != "approved" or review.get("environment") != "repaired-publication":
        raise ValueError("protected human review is not an approval for repaired-publication")
    _required_string(review, "reviewer", "humanReview")
    _required_string(review, "runId", "humanReview")
    if review.get("headSha") != current_demo_revision:
        raise ValueError("protected review does not approve the current demo-deploy head")
    manifest_sha = _required_sha(qualification, "reviewManifestSha256", "qualification")
    if review.get("reviewManifestSha256") != manifest_sha:
        raise ValueError("protected review manifest differs from qualification")

    adapter = qualification.get("adapter")
    if not isinstance(adapter, Mapping):
        raise ValueError("qualification adapter binding is missing")
    _required_string(adapter, "functionArn", "adapter")
    code_sha = _required_sha(adapter, "codeSha256", "adapter")
    if adapter.get("tracingMode") != "Active":
        raise ValueError("qualification adapter must retain active tracing")

    # Keep local variables used by static readers obvious; the mapping itself
    # remains the authoritative protected receipt passed by the workflow.
    _ = (source, configuration, code_sha)
    return qualification


def _read_body(response: Mapping[str, Any], label: str) -> bytes:
    body = response.get("Body")
    if body is None or not hasattr(body, "read"):
        raise RuntimeError(f"{label} has no readable body")
    value = body.read()
    if not isinstance(value, bytes):
        raise RuntimeError(f"{label} returned a non-byte body")
    return value


def _download_object(s3: Any, spec: Mapping[str, Any], *, required_version: bool, label: str) -> tuple[bytes, str]:
    request: dict[str, Any] = {"Bucket": spec["bucket"], "Key": spec["key"]}
    expected_version = spec.get("versionId")
    if expected_version is not None:
        request["VersionId"] = expected_version
    response = s3.get_object(**request)
    value = _read_body(response, label)
    expected_digest = spec["sha256"]
    if _sha256(value) != expected_digest:
        raise ValueError(f"{label} digest differs from the protected receipt")
    observed_version = str(response.get("VersionId", ""))
    if expected_version is not None and observed_version != expected_version:
        raise ValueError(f"{label} VersionId differs from the protected receipt")
    if required_version and not observed_version:
        raise ValueError(f"{label} has no required VersionId")
    return value, observed_version


def _validate_archive(archive_bytes: bytes, qualification: Mapping[str, Any], source_bytes: bytes) -> None:
    try:
        with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
            names = archive.namelist()
            if len(names) != len(set(names)):
                raise ValueError("qualified Runtime ZIP contains duplicate paths")
            manifest = json.loads(archive.read("agent-manifest.json"))
            packaged_prompt = archive.read("prompt.py")
    except (KeyError, ValueError, json.JSONDecodeError, zipfile.BadZipFile) as error:
        raise ValueError("qualified Runtime ZIP is not a valid package") from error
    if not isinstance(manifest, Mapping):
        raise ValueError("qualified Runtime manifest is not an object")
    if manifest.get("sourceRevision") != qualification["sourceRevision"]:
        raise ValueError("qualified Runtime manifest source revision differs")
    if manifest.get("promptSha256") != qualification["promptSha256"]:
        raise ValueError("qualified Runtime manifest prompt digest differs")
    if packaged_prompt != source_bytes:
        raise ValueError("qualified Runtime prompt differs from the protected source object")


def _verified_inputs(
    session: Any,
    qualification: Mapping[str, Any],
    *,
    pre_stage: bool = False,
    staged_sources: bool = False,
) -> dict[str, Any]:
    s3 = session.client("s3")
    artifact_bytes, artifact_version = _download_object(
        s3,
        qualification["artifact"],
        required_version=not pre_stage,
        label="private staged Runtime ZIP" if pre_stage else "qualified Runtime ZIP",
    )
    source_bytes, source_version = _download_object(
        s3,
        qualification["source"],
        required_version=not (pre_stage or staged_sources),
        label="qualified prompt source",
    )
    configuration_bytes, configuration_version = _download_object(
        s3,
        qualification["configuration"],
        required_version=not (pre_stage or staged_sources),
        label="qualified Runtime configuration",
    )
    try:
        configuration = json.loads(configuration_bytes)
    except json.JSONDecodeError as error:
        raise ValueError("qualified Runtime configuration is not valid JSON") from error
    expected_configuration = qualification.get(
        "stagedRuntimeConfiguration", qualification["runtimeConfiguration"]
    )
    if _canonical(configuration) != _canonical(expected_configuration):
        raise ValueError("qualified Runtime configuration differs from the protected receipt")
    _validate_archive(artifact_bytes, qualification, source_bytes)
    return {
        "s3": s3,
        "artifactBytes": artifact_bytes,
        "artifactVersionId": artifact_version,
        "sourceVersionId": source_version,
        "configurationVersionId": configuration_version,
    }


def _stack_outputs(cloudformation: Any, stack_name: str) -> dict[str, str]:
    response = cloudformation.describe_stacks(StackName=stack_name)
    stacks = response.get("Stacks")
    if not isinstance(stacks, list) or len(stacks) != 1:
        raise RuntimeError("agent stack read did not identify exactly one stack")
    outputs = stacks[0].get("Outputs", [])
    if not isinstance(outputs, list):
        raise RuntimeError("agent stack outputs are malformed")
    result: dict[str, str] = {}
    for item in outputs:
        if not isinstance(item, Mapping) or item.get("OutputKey") != "RuntimeId":
            continue
        value = item.get("OutputValue")
        if not isinstance(value, str) or not value:
            raise RuntimeError("agent stack RuntimeId output is invalid")
        if "RuntimeId" in result:
            raise RuntimeError("agent stack exposes duplicate RuntimeId outputs")
        result["RuntimeId"] = value
    if "RuntimeId" not in result:
        raise RuntimeError("agent stack does not expose a RuntimeId output")
    return result


def _runtime_arn(runtime_id: str) -> str:
    return f"arn:aws:bedrock-agentcore:{REGION}:{ACCOUNT}:runtime/{runtime_id}"


def _wait_read(
    read: Callable[[], Mapping[str, Any]],
    *,
    label: str,
    accept: Callable[[Mapping[str, Any]], bool] | None = None,
    attempts_limit: int = 12,
) -> dict[str, Any]:
    for attempt in range(attempts_limit):
        try:
            value = dict(read())
        except ClientError as error:
            if not _not_found(error):
                raise
            value = {}
        if value and (accept is None or accept(value)):
            return value
        status = value.get("status")
        if status is not None and any(token in str(status).upper() for token in ("FAILED", "ERROR")):
            raise RuntimeError(f"{label} failed with status {status}")
        if attempt + 1 < attempts_limit:
            time.sleep(5)
    raise RuntimeError(f"timed out or mismatched readback for {label}")


def _runtime_matches(runtime: Mapping[str, Any], qualification: Mapping[str, Any], runtime_arn: str) -> bool:
    if runtime.get("agentRuntimeArn") != runtime_arn or runtime.get("status") != "READY":
        return False
    wanted = qualification["runtimeConfiguration"]
    return all(_canonical(runtime.get(key)) == _canonical(expected) for key, expected in wanted.items())


def _list_versions(control: Any, runtime_id: str) -> list[str]:
    token: str | None = None
    versions: list[str] = []
    while True:
        request: dict[str, Any] = {"agentRuntimeId": runtime_id, "maxResults": 100}
        if token:
            request["nextToken"] = token
        response = control.list_agent_runtime_versions(**request)
        rows = response.get("agentRuntimes", [])
        if not isinstance(rows, list):
            raise RuntimeError("AgentCore Runtime version list is malformed")
        for row in rows:
            if isinstance(row, Mapping) and isinstance(row.get("agentRuntimeVersion"), str):
                version = row["agentRuntimeVersion"]
                if RUNTIME_VERSION_RE.fullmatch(version):
                    versions.append(version)
        token = response.get("nextToken")
        if not token:
            return sorted(set(versions), key=lambda value: int(value), reverse=True)


def _find_or_publish_runtime(
    control: Any,
    runtime_id: str,
    runtime_arn: str,
    qualification: Mapping[str, Any],
    existing_endpoint: Mapping[str, Any] | None,
) -> tuple[str, dict[str, Any]]:
    # A matching endpoint is the cheapest immutable-version hint.  The full
    # numbered Runtime read is still required before trusting it.
    if existing_endpoint and existing_endpoint.get("status") == "READY":
        bound = existing_endpoint.get("liveVersion")
        if (
            isinstance(bound, str)
            and RUNTIME_VERSION_RE.fullmatch(bound)
            and existing_endpoint.get("targetVersion", bound) == bound
        ):
            try:
                runtime = control.get_agent_runtime(agentRuntimeId=runtime_id, agentRuntimeVersion=bound)
            except ClientError as error:
                if not _not_found(error):
                    raise
            else:
                if _runtime_matches(runtime, qualification, runtime_arn):
                    return bound, dict(runtime)

    # The current read and every numbered version read are authoritative for
    # reconciliation.  A list summary alone is not sufficient.
    current = _wait_read(
        lambda: control.get_agent_runtime(agentRuntimeId=runtime_id),
        label="current AgentCore Runtime",
    )
    if current.get("agentRuntimeArn") not in (None, runtime_arn):
        raise RuntimeError("AgentCore Runtime identity differs from the stack Runtime")
    for version in _list_versions(control, runtime_id):
        try:
            runtime = control.get_agent_runtime(agentRuntimeId=runtime_id, agentRuntimeVersion=version)
        except ClientError as error:
            if _not_found(error):
                continue
            raise
        if _runtime_matches(runtime, qualification, runtime_arn):
            return version, dict(runtime)

    configuration = copy.deepcopy(dict(qualification["runtimeConfiguration"]))
    configuration.update(
        agentRuntimeId=runtime_id,
        clientToken=f"repaired-publication-{qualification['artifact']['sha256'][:24]}",
    )
    try:
        response = control.update_agent_runtime(**configuration)
    except Exception as error:
        # If only the acknowledgement was lost, preserve the committed
        # immutable version and let the next invocation reuse it.
        for version in _list_versions(control, runtime_id):
            try:
                runtime = control.get_agent_runtime(agentRuntimeId=runtime_id, agentRuntimeVersion=version)
            except ClientError as read_error:
                if _not_found(read_error):
                    continue
                raise
            if _runtime_matches(runtime, qualification, runtime_arn):
                raise RuntimeError("UpdateAgentRuntime response was lost; committed version is available") from error
        raise
    version = response.get("agentRuntimeVersion") if isinstance(response, Mapping) else None
    if not isinstance(version, str) or not RUNTIME_VERSION_RE.fullmatch(version):
        raise RuntimeError("UpdateAgentRuntime did not return a valid immutable version")
    runtime = _wait_read(
        lambda: control.get_agent_runtime(agentRuntimeId=runtime_id, agentRuntimeVersion=version),
        label=f"AgentCore Runtime version {version}",
        accept=lambda value: _runtime_matches(value, qualification, runtime_arn),
    )
    return version, runtime


def _endpoint_matches(endpoint: Mapping[str, Any], runtime_arn: str, endpoint_arn: str, version: str) -> bool:
    return (
        endpoint.get("agentRuntimeArn") == runtime_arn
        and endpoint.get("agentRuntimeEndpointArn") == endpoint_arn
        and endpoint.get("status") == "READY"
        and endpoint.get("liveVersion") == version
        and endpoint.get("targetVersion", version) == version
    )


def _read_endpoint(control: Any, runtime_id: str, endpoint_name: str) -> dict[str, Any] | None:
    try:
        return dict(control.get_agent_runtime_endpoint(agentRuntimeId=runtime_id, endpointName=endpoint_name))
    except ClientError as error:
        if _not_found(error):
            return None
        raise


def _ensure_endpoint(
    control: Any,
    runtime_id: str,
    runtime_arn: str,
    endpoint_name: str,
    version: str,
    qualification: Mapping[str, Any],
    endpoint: Mapping[str, Any] | None,
) -> dict[str, Any]:
    expected_arn = f"{runtime_arn}/runtime-endpoint/{endpoint_name}"
    created = endpoint is None
    if endpoint is not None and (
        endpoint.get("agentRuntimeArn") != runtime_arn
        or endpoint.get("agentRuntimeEndpointArn") != expected_arn
    ):
        raise RuntimeError("repaired endpoint identity differs from the stack Runtime")
    if endpoint is None:
        request = {
            "agentRuntimeId": runtime_id,
            "name": endpoint_name,
            "agentRuntimeVersion": version,
            "clientToken": f"repaired-publication-endpoint-{qualification['artifact']['sha256'][:24]}-{version}",
        }
        # A lost response is deliberately propagated.  The next invocation
        # starts with GetAgentRuntimeEndpoint and reconciles this write.
        control.create_agent_runtime_endpoint(**request)
        endpoint = _wait_read(
            lambda: control.get_agent_runtime_endpoint(agentRuntimeId=runtime_id, endpointName=endpoint_name),
            label="repaired AgentCore endpoint",
        )
    elif endpoint.get("status") != "READY":
        endpoint = _wait_read(
            lambda: control.get_agent_runtime_endpoint(agentRuntimeId=runtime_id, endpointName=endpoint_name),
            label="repaired AgentCore endpoint",
        )
    endpoint = dict(endpoint)
    if endpoint.get("agentRuntimeArn") != runtime_arn or endpoint.get("agentRuntimeEndpointArn") != expected_arn:
        raise RuntimeError("repaired endpoint identity differs from the stack Runtime")
    if (
        endpoint.get("status") == "READY"
        and "targetVersion" in endpoint
        and endpoint.get("targetVersion") != endpoint.get("liveVersion")
    ):
        raise RuntimeError("repaired endpoint returned inconsistent live/target versions")
    if not _endpoint_matches(endpoint, runtime_arn, expected_arn, version):
        # A malformed response immediately after a create is not evidence that
        # repinning is safe.  A pre-existing READY endpoint with a different
        # immutable version is the only supported repair path.
        if created:
            raise RuntimeError("new repaired endpoint does not serve the verified Runtime version")
        control.update_agent_runtime_endpoint(
            agentRuntimeId=runtime_id,
            endpointName=endpoint_name,
            agentRuntimeVersion=version,
            clientToken=f"repaired-publication-pin-{qualification['artifact']['sha256'][:24]}-{version}",
        )
        endpoint = _wait_read(
            lambda: control.get_agent_runtime_endpoint(agentRuntimeId=runtime_id, endpointName=endpoint_name),
            label="repaired AgentCore endpoint repin",
            accept=lambda value: _endpoint_matches(value, runtime_arn, expected_arn, version),
        )
    if not _endpoint_matches(endpoint, runtime_arn, expected_arn, version):
        raise RuntimeError("repaired endpoint does not serve the verified Runtime version")
    return dict(endpoint)


def _record_item(
    qualification: Mapping[str, Any],
    *,
    runtime_arn: str,
    version: str,
    endpoint: Mapping[str, Any],
    verified: Mapping[str, Any],
) -> dict[str, dict[str, str]]:
    artifact = qualification["artifact"]
    source = qualification["source"]
    configuration = qualification["configuration"]
    review = qualification["humanReview"]
    adapter = qualification["adapter"]
    evaluation = qualification["evaluation"]
    values: dict[str, object] = {
        "candidateId": "repaired",
        "sourceRevision": qualification["sourceRevision"],
        "promptSha256": qualification["promptSha256"],
        "modelId": qualification["modelId"],
        "artifactSha256": artifact["sha256"],
        "artifactVersionId": verified["artifactVersionId"],
        "sourceSha256": source["sha256"],
        "configurationSha256": configuration["sha256"],
        "runtimeArn": runtime_arn,
        "runtimeVersion": version,
        "endpointName": "repaired",
        "endpointArn": endpoint["agentRuntimeEndpointArn"],
        "alarmArn": qualification["alarmArn"],
        "status": "published",
        "caseSetSha256": qualification["caseSet"]["sha256"],
        "reportIdentitiesSha256": qualification["reportIdentitiesSha256"],
        "experimentId": evaluation.get("experimentId", ""),
        "reviewEnvironment": review["environment"],
        "reviewRunId": review["runId"],
        "reviewManifestSha256": qualification["reviewManifestSha256"],
        "reviewer": review["reviewer"],
        "adapterArn": adapter["functionArn"],
        "adapterCodeSha256": adapter["codeSha256"],
    }
    # The private staging bucket may be unversioned. Do not write an empty
    # DynamoDB string; preserve these fields when native staging readback did
    # provide a real optional VersionId.
    if verified.get("sourceVersionId"):
        values["sourceVersionId"] = verified["sourceVersionId"]
    if verified.get("configurationVersionId"):
        values["configurationVersionId"] = verified["configurationVersionId"]
    return {"pk": _attr(REPAIRED_PK), **{key: _attr(value) for key, value in values.items()}}


def _record_matches(item: Mapping[str, Any], expected: Mapping[str, Any]) -> bool:
    return all(item.get(key) == value for key, value in expected.items())


def _ensure_record(
    controller: Any,
    qualification: Mapping[str, Any],
    item: dict[str, dict[str, str]],
) -> dict[str, dict[str, str]]:
    table = qualification["controller"]["tableName"]
    key = {"pk": {"S": REPAIRED_PK}}
    existing_response = controller.get_item(TableName=table, Key=key, ConsistentRead=True)
    existing = existing_response.get("Item") or {}
    if existing and existing.get("candidateId") not in (None, item["candidateId"]):
        raise RuntimeError("repaired publication record belongs to a different candidate")
    if not _record_matches(existing, item):
        controller.put_item(TableName=table, Item=item)
    readback = controller.get_item(TableName=table, Key=key, ConsistentRead=True).get("Item") or {}
    if not _record_matches(readback, item):
        raise RuntimeError("repaired publication record strong readback does not match")
    return dict(readback)


def _with_serving_version(qualification: Mapping[str, Any], version_id: str) -> dict[str, Any]:
    """Return the qualification with one native serving VersionId everywhere."""

    if not version_id or version_id.lower() in {"null", "none"}:
        raise RuntimeError("versioned serving object has no concrete S3 VersionId")
    updated = copy.deepcopy(dict(qualification))
    artifact = dict(updated["artifact"])
    artifact["versionId"] = version_id
    updated["artifact"] = artifact
    updated["runtimeConfiguration"]["agentRuntimeArtifact"]["codeConfiguration"]["code"]["s3"][
        "versionId"
    ] = version_id
    return updated


def _reconcile_serving_object(s3: Any, target: Mapping[str, Any], expected_body: bytes) -> str | None:
    """Find and verify a committed version after a prior serving write."""

    versions: list[str] = []
    head = getattr(s3, "head_object", None)
    if callable(head):
        try:
            response = head(Bucket=target["bucket"], Key=target["key"])
        except ClientError as error:
            if not _not_found(error):
                raise
        else:
            value = response.get("VersionId") if isinstance(response, Mapping) else None
            if isinstance(value, str) and value:
                versions.append(value)
    list_versions = getattr(s3, "list_object_versions", None)
    if callable(list_versions):
        try:
            response = list_versions(Bucket=target["bucket"], Prefix=target["key"])
        except ClientError as error:
            if not _not_found(error):
                raise
        else:
            rows = response.get("Versions", []) if isinstance(response, Mapping) else []
            for row in rows:
                if (
                    isinstance(row, Mapping)
                    and row.get("Key") == target["key"]
                    and row.get("IsLatest")
                    and isinstance(row.get("VersionId"), str)
                ):
                    versions.append(row["VersionId"])
    for version_id in dict.fromkeys(versions):
        candidate = dict(target)
        candidate["versionId"] = version_id
        body, observed = _download_object(
            s3, candidate, required_version=True, label="versioned serving Runtime ZIP",
        )
        if body != expected_body:
            raise RuntimeError("existing versioned serving object differs from the staged ZIP")
        return observed

    # Some native-shaped transports expose only the current object read.  It
    # still carries the VersionId required to reconcile a lost PutObject ACK.
    try:
        response = s3.get_object(Bucket=target["bucket"], Key=target["key"])
    except ClientError as error:
        if _not_found(error):
            return None
        raise
    body = _read_body(response, "versioned serving Runtime ZIP")
    version_id = str(response.get("VersionId", ""))
    if body != expected_body:
        raise RuntimeError("existing versioned serving object differs from the staged ZIP")
    if not version_id:
        raise RuntimeError("existing serving object has no native S3 VersionId")
    if _sha256(body) != target["sha256"]:
        raise ValueError("versioned serving Runtime ZIP digest differs from the protected receipt")
    return version_id


def _stage_versioned_asset(
    s3: Any,
    qualification: Mapping[str, Any],
    staging_specs: Mapping[str, Mapping[str, Any]],
    staged_body: bytes,
) -> Mapping[str, Any]:
    """Promote one protected private-stage ZIP to the fixed versioned asset."""

    artifact = qualification["artifact"]
    staged = staging_specs["artifact"]
    if _sha256(staged_body) != staged["sha256"] or staged["sha256"] != artifact["sha256"]:
        raise ValueError("private staged Runtime ZIP differs from the reviewed artifact")
    existing_version = _reconcile_serving_object(s3, artifact, staged_body)
    if existing_version:
        return _with_serving_version(qualification, existing_version)
    try:
        put = s3.put_object(
            Bucket=artifact["bucket"],
            Key=artifact["key"],
            Body=staged_body,
            IfNoneMatch="*",
            ExpectedBucketOwner=ACCOUNT,
        )
    except Exception:
        # The write may have committed before its response was lost.  A strong
        # native read is authoritative; if it is absent, preserve the original
        # error and let the next invocation retry/reconcile.
        recovered = _reconcile_serving_object(s3, artifact, staged_body)
        if recovered:
            return _with_serving_version(qualification, recovered)
        raise
    observed_version = put.get("VersionId") if isinstance(put, Mapping) else None
    if not isinstance(observed_version, str) or not observed_version or observed_version.lower() in {"null", "none"}:
        raise RuntimeError("private staged upload returned no S3 VersionId")
    updated = _with_serving_version(qualification, observed_version)
    # The response is not the final proof: read the exact returned version and
    # hash it before allowing native Runtime publication to proceed.
    body, observed = _download_object(
        s3, updated["artifact"], required_version=True, label="versioned serving Runtime ZIP",
    )
    if body != staged_body or observed != observed_version:
        raise RuntimeError("versioned serving object does not match the staged ZIP")
    return updated


def _normalise_staged_qualification(
    qualification: Mapping[str, Any],
) -> tuple[dict[str, Any], dict[str, Mapping[str, Any]]]:
    """Bind private staging objects to the fixed content-addressed prefix.

    The evidence bucket is intentionally not treated as the serving bucket and
    need not have S3 versioning enabled.  A receipt may carry only content
    digests; keys and bucket are derived here and any caller-supplied values
    must agree with the fixed layout.  The final serving object is versioned
    after protected clearance and receives its native VersionId then.
    """

    result = copy.deepcopy(dict(qualification))
    artifact = result.get("artifact")
    if not isinstance(artifact, Mapping):
        raise ValueError("staged qualification artifact is missing")
    artifact_sha = _required_sha(artifact, "sha256", "artifact")
    prefix = f"{STAGING_PREFIX}/{artifact_sha}"
    expected_keys = {
        "artifact": f"{prefix}/runtime.zip",
        "source": f"{prefix}/prompt.py",
        "configuration": f"{prefix}/runtime-configuration.json",
    }
    for name in ("artifact", "source", "configuration"):
        value = result.get(name)
        if not isinstance(value, Mapping):
            raise ValueError(f"staged qualification {name} is missing")
        bucket = value.get("bucket", EVIDENCE_BUCKET)
        key = value.get("key", expected_keys[name])
        if bucket != EVIDENCE_BUCKET or key != expected_keys[name]:
            raise ValueError(f"staged qualification {name} is outside the fixed evidence prefix")
        updated = dict(value)
        updated["bucket"] = EVIDENCE_BUCKET
        updated["key"] = expected_keys[name]
        # A private evidence bucket may be unversioned. Preserve a supplied
        # version only as an optional read selector; it is never publication
        # identity and is not required for staging reads.
        result[name] = updated
    runtime_configuration = result.get("runtimeConfiguration")
    if not isinstance(runtime_configuration, Mapping):
        raise ValueError("staged qualification Runtime configuration is missing")
    runtime_configuration = copy.deepcopy(dict(runtime_configuration))
    code = runtime_configuration.get("agentRuntimeArtifact")
    if not isinstance(code, Mapping):
        raise ValueError("staged qualification Runtime artifact is missing")
    code_configuration = code.get("codeConfiguration")
    if not isinstance(code_configuration, Mapping):
        raise ValueError("staged qualification code configuration is missing")
    code_configuration = copy.deepcopy(dict(code_configuration))
    code_s3 = (
        code_configuration.get("code", {}).get("s3")
        if isinstance(code_configuration.get("code"), Mapping)
        else None
    )
    if not isinstance(code_s3, Mapping):
        raise ValueError("staged qualification Runtime must use S3 code")
    if (
        code_s3.get("bucket", EVIDENCE_BUCKET) != EVIDENCE_BUCKET
        or code_s3.get("prefix", expected_keys["artifact"]) != expected_keys["artifact"]
    ):
        raise ValueError("staged qualification Runtime artifact is outside the fixed evidence prefix")
    updated_s3 = {"bucket": EVIDENCE_BUCKET, "prefix": expected_keys["artifact"]}
    if code_s3.get("versionId") is not None:
        updated_s3["versionId"] = code_s3["versionId"]
    code_configuration["code"] = {"s3": updated_s3}
    code = copy.deepcopy(dict(code))
    code["codeConfiguration"] = code_configuration
    runtime_configuration["agentRuntimeArtifact"] = code
    result["runtimeConfiguration"] = runtime_configuration
    staging_specs = {
        name: copy.deepcopy(result[name]) for name in ("artifact", "source", "configuration")
    }
    return result, staging_specs


def _validate_session_scope(session: Any) -> None:
    """Reject an AWS session outside the fixed native publication account."""

    if getattr(session, "region_name", None) != REGION:
        raise RuntimeError("AWS session Region is outside the fixed publisher scope")
    identity = session.client("sts").get_caller_identity()
    if not isinstance(identity, Mapping) or identity.get("Account") != ACCOUNT:
        raise RuntimeError("AWS session account is outside the fixed publisher scope")


def publish_repaired(
    session: Any,
    *,
    qualification: Mapping[str, Any],
    current_demo_revision: str,
) -> dict[str, Any]:
    """Publish one protected repaired qualification through native AWS APIs."""

    if not isinstance(current_demo_revision, str) or not REVISION_RE.fullmatch(current_demo_revision):
        raise ValueError("current_demo_revision must be a Git commit identity")
    staged_mode = qualification.get("servingArtifact") is not None
    staging_specs: dict[str, Mapping[str, Any]] | None = None
    if staged_mode:
        qualification, staging_specs = _normalise_staged_qualification(qualification)
    qualification = _validate_qualification(
        qualification,
        current_demo_revision,
        allow_unversioned_staging=staged_mode,
    )
    serving = qualification.get("servingArtifact")
    if serving is not None:
        if not isinstance(serving, Mapping):
            raise ValueError("qualification.servingArtifact must be an object")
        _required_string(serving, "bucket", "servingArtifact")
        _required_string(serving, "key", "servingArtifact")
        staged_digest = _required_sha(qualification["artifact"], "sha256", "artifact")
        configured_bucket = os.environ.get("PHASE0_ASSET_BUCKET")
        if configured_bucket and configured_bucket != ASSET_BUCKET:
            raise ValueError("publisher asset bucket environment differs from the fixed serving bucket")
        expected_bucket = ASSET_BUCKET
        expected_key = f"agent-qualified/{staged_digest}.zip"
        if serving["bucket"] != expected_bucket or serving["key"] != expected_key:
            raise ValueError("qualification servingArtifact is outside the fixed repaired asset destination")
        if staging_specs is None:
            raise RuntimeError("staged serving publication has no private staging objects")
        _validate_session_scope(session)
        # Read and hash every staged input before any serving write.  The
        # configuration bytes here intentionally describe the private-stage
        # S3 location; the serving VersionId is resolved only after promotion.
        staged_verified = _verified_inputs(session, qualification, pre_stage=True)
        staged_body = staged_verified["artifactBytes"]
        qualification = copy.deepcopy(dict(qualification))
        staged = qualification["artifact"]
        qualification["stagedRuntimeConfiguration"] = copy.deepcopy(qualification["runtimeConfiguration"])
        target = {
            "bucket": serving["bucket"],
            "key": serving["key"],
            "sha256": staged["sha256"],
        }
        qualification["artifact"] = target
        configuration = qualification["runtimeConfiguration"]
        configuration["agentRuntimeArtifact"]["codeConfiguration"]["code"]["s3"] = {
            "bucket": target["bucket"],
            "prefix": target["key"],
        }
        qualification.pop("servingArtifact", None)
        qualification = _validate_qualification(
            qualification,
            current_demo_revision,
            allow_unversioned_staging=True,
        )
    if not staged_mode:
        _validate_session_scope(session)

    # The receipt and exact bytes are cleared before any serving mutation. A
    # protected workflow may retain the checked ZIP in private staging until
    # the GitHub environment approval; upload those exact bytes only after the
    # clearance checks above, then verify the returned VersionId.
    s3 = session.client("s3")
    if staged_mode:
        assert staging_specs is not None
        qualification = _stage_versioned_asset(s3, qualification, staging_specs, staged_body)
        qualification = _validate_qualification(
            qualification,
            current_demo_revision,
            allow_unversioned_staging=True,
        )
    verified = _verified_inputs(session, qualification, staged_sources=staged_mode)

    cloudformation = session.client("cloudformation")
    runtime_id = _stack_outputs(cloudformation, qualification["runtimeName"])["RuntimeId"]
    runtime_arn = _runtime_arn(runtime_id)
    control = session.client("bedrock-agentcore-control")
    existing_endpoint = _read_endpoint(control, runtime_id, "repaired")
    version, _runtime = _find_or_publish_runtime(
        control, runtime_id, runtime_arn, qualification, existing_endpoint,
    )
    endpoint = _ensure_endpoint(
        control, runtime_id, runtime_arn, "repaired", version, qualification, existing_endpoint,
    )

    # Final native readbacks precede the DynamoDB claim.  The record is only a
    # completed publication when both those reads and its own strong readback
    # agree with the protected tuple.
    runtime = _wait_read(
        lambda: control.get_agent_runtime(agentRuntimeId=runtime_id, agentRuntimeVersion=version),
        label=f"final AgentCore Runtime version {version}",
        accept=lambda value: _runtime_matches(value, qualification, runtime_arn),
    )
    endpoint = _wait_read(
        lambda: control.get_agent_runtime_endpoint(agentRuntimeId=runtime_id, endpointName="repaired"),
        label="final repaired AgentCore endpoint",
        accept=lambda value: _endpoint_matches(value, runtime_arn, f"{runtime_arn}/runtime-endpoint/repaired", version),
    )
    item = _record_item(qualification, runtime_arn=runtime_arn, version=version, endpoint=endpoint, verified=verified)
    record = _ensure_record(session.client("dynamodb"), qualification, item)
    return {
        "status": "published",
        "candidateId": "repaired",
        "endpointName": "repaired",
        "runtimeArn": runtime_arn,
        "runtimeVersion": version,
        "endpointArn": endpoint["agentRuntimeEndpointArn"],
        "artifactSha256": qualification["artifact"]["sha256"],
        "artifactVersionId": qualification["artifact"]["versionId"],
        "record": record,
        "runtime": runtime,
        "endpoint": endpoint,
    }


def _load_protected_qualification() -> Mapping[str, Any]:
    """Read the protected workflow handoff, never a checkout-side receipt."""

    path_value = os.environ.get("PHASE20_QUALIFICATION_PATH")
    try:
        if path_value:
            qualification = json.loads(Path(path_value).read_text())
        else:
            raise RuntimeError("protected qualification handoff is missing")
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError("protected qualification handoff is unreadable") from error
    if not isinstance(qualification, Mapping):
        raise RuntimeError("protected qualification handoff is malformed")
    return qualification


def _verify_checked_artifact(qualification: Mapping[str, Any]) -> None:
    """Ensure the publisher is still holding the ZIP that was reviewed."""

    path_value = os.environ.get("PHASE20_ARTIFACT_PATH")
    if not path_value:
        return
    artifact = qualification.get("artifact")
    if not isinstance(artifact, Mapping) or not isinstance(artifact.get("sha256"), str):
        raise RuntimeError("protected qualification has no artifact digest")
    checked = Path(path_value)
    if checked.is_symlink() or not checked.is_file():
        raise RuntimeError("checked Runtime ZIP is unavailable or is a symlink")
    try:
        value = checked.read_bytes()
    except OSError as error:
        raise RuntimeError("checked Runtime ZIP is unavailable") from error
    observed = _sha256(value)
    if observed != artifact["sha256"]:
        raise RuntimeError("checked Runtime ZIP differs from the protected qualification")
    declared = os.environ.get("PHASE20_ARTIFACT_SHA256")
    if declared and declared != observed:
        raise RuntimeError("publisher artifact digest environment differs from the checked ZIP")
    declared_review = os.environ.get("PHASE20_REVIEW_MANIFEST_SHA256")
    if declared_review and qualification.get("reviewManifestSha256") != declared_review:
        raise RuntimeError("publisher review manifest differs from the protected qualification")


def main() -> int:
    # No candidate, endpoint, artifact, or qualification path is accepted as a
    # command-line argument.  The protected job supplies only its verified
    # handoff through the environment and the current GitHub head.
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.parse_args()
    qualification = _load_protected_qualification()
    _verify_checked_artifact(qualification)
    # GITHUB_SHA identifies the candidate that opened the workflow; it is not
    # proof that demo-deploy is still at that head after the approval wait.
    # The protected clearance step supplies this independently queried value
    # after the publication-job concurrency lock is held.
    current_revision = os.environ.get("PHASE20_CURRENT_HEAD") or os.environ.get("PHASE20_VERIFIED_HEAD")
    if not isinstance(current_revision, str) or not current_revision:
        raise RuntimeError("current demo-deploy head is missing")
    session = boto3.Session(region_name=REGION)
    result = publish_repaired(session, qualification=qualification, current_demo_revision=current_revision)
    print(json.dumps(result, sort_keys=True, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
