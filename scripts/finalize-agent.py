"""Finalize the checked native Runtime version without invoking an investigation.

CloudFormation currently omits MMDSv2. This deployment-only step preserves the
checked Runtime configuration, applies MMDSv2 once, pins/readbacks its actual
version, and only then lets the forward-only adapter attest that version.
"""
from __future__ import annotations
import argparse
import base64
import copy
import re
import hashlib
import json
import time
from pathlib import Path
import boto3


def wait_ready(read, *, status_key="status", success="READY", timeout=600, accept=None):
    until = time.monotonic() + timeout
    while True:
        value = read()
        status = value.get(status_key)
        if status == success and (accept is None or accept(value)):
            return value
        if "FAILED" in str(status) or time.monotonic() >= until:
            raise RuntimeError(f"Native resource failed or timed out: {status}")
        time.sleep(5)


def finalize(control, lambdas, xray, *, runtime_id, revision, artifact_sha256, adapter_sha256, bucket, key, api_id, expected_environment):
    runtime_arn = f"arn:aws:bedrock-agentcore:us-east-1:027224425948:runtime/{runtime_id}"
    role = "arn:aws:iam::027224425948:role/IncidentTriageDemoAgentRuntimeRole"
    artifact = {"codeConfiguration": {"runtime": "PYTHON_3_13", "entryPoint": ["opentelemetry-instrument", "main.py"], "code": {"s3": {"bucket": bucket, "prefix": key}}}}
    expected = {"agentRuntimeArn": runtime_arn, "roleArn": role, "agentRuntimeArtifact": artifact,
                "environmentVariables": expected_environment, "networkConfiguration": {"networkMode": "PUBLIC"},
                "protocolConfiguration": {"serverProtocol": "HTTP"},
                "lifecycleConfiguration": {"idleRuntimeSessionTimeout": 300, "maxLifetime": 600}}
    def validate(value):
        for name, wanted in expected.items():
            actual = copy.deepcopy(value.get(name))
            if name == "agentRuntimeArtifact" and isinstance(actual, dict):
                # The service may resolve the immutable object's S3 version.
                actual.get("codeConfiguration", {}).get("code", {}).get("s3", {}).pop("versionId", None)
            if name == "protocolConfiguration" and isinstance(actual, dict):
                # Current service responses may materialize these HTTP defaults.
                if actual.get("port") == 8080: actual.pop("port")
                if actual.get("path") == "/invocations": actual.pop("path")
            if actual != wanted:
                raise RuntimeError(f"Native Runtime differs from checked release: {name}")
    current = wait_ready(lambda: control.get_agent_runtime(agentRuntimeId=runtime_id))
    validate(current)
    if current.get("metadataConfiguration", {}).get("requireMMDSV2") is not True:
        preserved = {k: v for k, v in current.items() if k in control.meta.service_model.operation_model("UpdateAgentRuntime").input_shape.members}
        preserved.update(agentRuntimeId=runtime_id, metadataConfiguration={"requireMMDSV2": True}, clientToken=f"{revision}-mmdsv2")
        update = control.update_agent_runtime(**preserved)
        version = update["agentRuntimeVersion"]
        current = wait_ready(lambda: control.get_agent_runtime(agentRuntimeId=runtime_id, agentRuntimeVersion=version))
    version = current["agentRuntimeVersion"]
    if not re.fullmatch(r"[1-9][0-9]{0,4}", version):
        raise RuntimeError("Native Runtime returned an invalid version")
    validate(current)
    if current.get("metadataConfiguration", {}).get("requireMMDSV2") is not True:
        raise RuntimeError("Native MMDSv2 readback failed")
    def endpoint_pins_version(value):
        # Stable READY responses may omit the optional targetVersion field.
        return value.get("status") == "READY" and value.get("liveVersion") == version and value.get("targetVersion", version) == version
    endpoint = wait_ready(lambda: control.get_agent_runtime_endpoint(agentRuntimeId=runtime_id, endpointName="faulty"))
    if not endpoint_pins_version(endpoint):
        control.update_agent_runtime_endpoint(agentRuntimeId=runtime_id, endpointName="faulty", agentRuntimeVersion=version, clientToken=f"{revision}-pin-{version}")
        endpoint = wait_ready(lambda: control.get_agent_runtime_endpoint(agentRuntimeId=runtime_id, endpointName="faulty"), accept=endpoint_pins_version)
    if not endpoint_pins_version(endpoint) or endpoint.get("agentRuntimeArn") != runtime_arn:
        raise RuntimeError("Endpoint does not pin the verified final version")
    destination = xray.get_trace_segment_destination()
    if destination.get("Destination") != "CloudWatchLogs" or destination.get("Status") != "ACTIVE":
        raise RuntimeError("CloudWatch Transaction Search trace destination is not configured")
    name = "IncidentTriageDemoAlarmAdapter"
    adapter = wait_ready(lambda: lambdas.get_function_configuration(FunctionName=name), status_key="LastUpdateStatus", success="Successful")
    if adapter.get("CodeSha256") != base64.b64encode(bytes.fromhex(adapter_sha256)).decode():
        raise RuntimeError("Alarm adapter code differs from checked ZIP")
    desired = {"AGENT_RUNTIME_ARN": runtime_arn, "AGENT_ENDPOINT_NAME": "faulty", "AGENT_RUNTIME_VERSION": version,
               "AGENT_ALARM_ARN": "arn:aws:cloudwatch:us-east-1:027224425948:alarm:IncidentTriageDemoAppStage5xx",
               "AGENT_SOURCE_REVISION": revision, "AGENT_ARTIFACT_SHA256": artifact_sha256}
    actual = adapter.get("Environment", {}).get("Variables", {})
    if {k: v for k, v in actual.items() if k != "AGENT_RUNTIME_VERSION"} != {k: v for k, v in desired.items() if k != "AGENT_RUNTIME_VERSION"}:
        raise RuntimeError("Adapter configuration differs from checked release")
    if actual != desired:
        lambdas.update_function_configuration(FunctionName=name, RevisionId=adapter["RevisionId"], Environment={"Variables": desired})
        adapter = wait_ready(lambda: lambdas.get_function_configuration(FunctionName=name), status_key="LastUpdateStatus", success="Successful", accept=lambda value: value.get("Environment", {}).get("Variables") == desired)
    if adapter.get("Environment", {}).get("Variables") != desired or adapter.get("TracingConfig", {}).get("Mode") != "Active":
        raise RuntimeError("Adapter attestation/tracing readback failed")
    final = control.get_agent_runtime(agentRuntimeId=runtime_id, agentRuntimeVersion=version)
    validate(final)
    endpoint = control.get_agent_runtime_endpoint(agentRuntimeId=runtime_id, endpointName="faulty")
    if final.get("metadataConfiguration", {}).get("requireMMDSV2") is not True or not endpoint_pins_version(endpoint):
        raise RuntimeError("Endpoint changed during finalization")
    return {"sourceRevision": revision, "runtimeArn": runtime_arn, "runtimeVersion": version,
            "endpointArn": endpoint["agentRuntimeEndpointArn"], "endpointName": "faulty", "artifactSha256": artifact_sha256,
            "metadataV2": True, "adapterArn": adapter["FunctionArn"], "adapterCodeSha256": adapter_sha256}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["runtime-id", "revision", "asset-bucket", "asset-key", "api-id", "template"]:
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    runtime_sha = hashlib.sha256(Path(".artifacts/agent/runtime.zip").read_bytes()).hexdigest()
    adapter_sha = hashlib.sha256(Path(".artifacts/agent/alarm-adapter.zip").read_bytes()).hexdigest()
    template = json.loads(Path(args.template).read_text())
    runtime = next(r["Properties"] for r in template["Resources"].values() if r["Type"] == "AWS::BedrockAgentCore::Runtime")
    checked_code = runtime["AgentRuntimeArtifact"]["CodeConfiguration"]
    if checked_code != {"Runtime": "PYTHON_3_13", "EntryPoint": ["opentelemetry-instrument", "main.py"], "Code": {"S3": {"Bucket": args.asset_bucket, "Prefix": args.asset_key}}}:
        raise RuntimeError("Stack outputs do not identify the checked Runtime artifact")
    refs = {"SourceRevision": args.revision, "AppHttpApiId": args.api_id, "RunTable": "IncidentTriageDemoAgentRun"}
    environment = {k: refs[v["Ref"]] if isinstance(v, dict) and set(v) == {"Ref"} else v for k, v in runtime["EnvironmentVariables"].items()}
    if any(not isinstance(value, str) for value in environment.values()) or environment.get("AGENT_ARTIFACT_SHA256") != runtime_sha:
        raise RuntimeError("Checked template does not bind the checked Runtime ZIP/environment")
    session = boto3.Session(region_name="us-east-1")
    result = finalize(session.client("bedrock-agentcore-control"), session.client("lambda"), session.client("xray"),
                      runtime_id=args.runtime_id, revision=args.revision, artifact_sha256=runtime_sha,
                      adapter_sha256=adapter_sha, bucket=args.asset_bucket, key=args.asset_key,
                      api_id=args.api_id, expected_environment=environment)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
