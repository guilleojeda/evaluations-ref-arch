"""Prepare and execute the one-time CloudFormation endpoint ownership cutover.

The command has two explicit steps. ``prepare`` verifies the fixed Phase19
archive and the live stack, saves a complete rollback snapshot, derives a
template that removes only the legacy ``FaultyEndpoint`` from that live
template, and creates a fully inspected change set. ``execute`` accepts only
the saved plan, repeats the endpoint/change-set/template checks, executes that
exact change set once, and verifies that the Runtime survived unchanged.

This command never accepts a Runtime, endpoint, ZIP, URI, digest, or version
from the caller. The checked agent assembly and the fixed archive descriptor
are the inputs owned by the trusted workflow.
"""
from __future__ import annotations

import argparse
import copy
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import time
from typing import Any, Mapping

import boto3
from botocore.exceptions import ClientError


ACCOUNT = "027224425948"
REGION = "us-east-1"
STACK_NAME = "IncidentTriageDemoAgent"
ENDPOINT_LOGICAL_ID = "FaultyEndpoint"
ENDPOINT_TYPE = "AWS::BedrockAgentCore::RuntimeEndpoint"
LEGACY_ENDPOINT_ARN = (
    "arn:aws:bedrock-agentcore:us-east-1:027224425948:runtime/"
    "IncidentTriageDemoAgent-7VWTOWDIs4/runtime-endpoint/faulty"
)
ROOT = Path(__file__).resolve().parents[1]
SETUP_SCRIPT = ROOT / "scripts" / "setup-faulty-reference.py"


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _json_safe(value: Any) -> Any:
    """Convert native SDK response values to durable JSON plan values."""
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    if isinstance(value, tuple):
        return [_json_safe(item) for item in value]
    return value


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical(value).encode()).hexdigest()


def _load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"cannot read JSON artifact {path}") from error


def _load_setup_module() -> Any:
    spec = importlib.util.spec_from_file_location("phase19_setup_faulty_reference", SETUP_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("fixed faulty-reference helper is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _stack(cf: Any) -> dict[str, Any]:
    response = cf.describe_stacks(StackName=STACK_NAME)
    stacks = response.get("Stacks")
    if not isinstance(stacks, list) or len(stacks) != 1:
        raise RuntimeError("agent stack read did not identify exactly one stack")
    return dict(stacks[0])


def _stack_template(cf: Any) -> dict[str, Any]:
    response = cf.get_template(StackName=STACK_NAME, TemplateStage="Original")
    body = response.get("TemplateBody")
    if isinstance(body, str):
        body = json.loads(body)
    if not isinstance(body, dict):
        raise RuntimeError("agent stack template read is not an object")
    return body


def _resources(cf: Any) -> list[dict[str, Any]]:
    response = cf.list_stack_resources(StackName=STACK_NAME)
    summaries = response.get("StackResourceSummaries")
    if not isinstance(summaries, list) or response.get("NextToken"):
        raise RuntimeError("agent stack resource read is paginated or malformed")
    # Resource summaries contain native datetime values.  They are used in the
    # rollback identity and must therefore be safe to persist in the plan.
    return [_json_safe(dict(item)) for item in summaries]


def _legacy_resource(summaries: list[Mapping[str, Any]]) -> dict[str, Any] | None:
    endpoints = [
        item for item in summaries
        if item.get("ResourceType") == ENDPOINT_TYPE
    ]
    if not endpoints:
        return None
    if len(endpoints) != 1:
        raise RuntimeError("agent stack has more than one RuntimeEndpoint")
    resource = endpoints[0]
    if resource.get("LogicalResourceId") != ENDPOINT_LOGICAL_ID:
        raise RuntimeError("agent stack RuntimeEndpoint is not the fixed FaultyEndpoint")
    if resource.get("PhysicalResourceId") != LEGACY_ENDPOINT_ARN:
        raise RuntimeError("agent stack FaultyEndpoint physical ID differs from the inspected legacy resource")
    return dict(resource)


def _checked_template() -> tuple[Path, dict[str, Any]]:
    assembly = ROOT / ".artifacts" / "agent" / "cdk"
    manifest = _load_json(assembly / "manifest.json")
    template_name = manifest["artifacts"][STACK_NAME]["properties"]["templateFile"]
    path = assembly / template_name
    template = _load_json(path)
    resources = template.get("Resources")
    if not isinstance(resources, dict):
        raise RuntimeError("checked agent template has no Resources object")
    if any(value.get("Type") == ENDPOINT_TYPE for value in resources.values() if isinstance(value, dict)):
        raise RuntimeError("checked agent template still owns a RuntimeEndpoint")
    table = resources.get("RunTable")
    if not isinstance(table, dict) or table.get("Type") != "AWS::DynamoDB::Table" or table.get("Properties", {}).get("TableName") != "IncidentTriageDemoAgentRun" or table.get("DeletionPolicy") != "Retain" or table.get("UpdateReplacePolicy") != "Retain":
        raise RuntimeError("checked agent template does not retain the exact agent run table")
    logs = [
        resource for resource in resources.values()
        if isinstance(resource, dict)
        and resource.get("Type") == "AWS::Logs::LogGroup"
        and resource.get("Properties", {}).get("LogGroupName") == "/aws/lambda/IncidentTriageDemoAlarmAdapter"
    ]
    if len(logs) != 1 or logs[0].get("DeletionPolicy") != "Retain" or logs[0].get("UpdateReplacePolicy") != "Retain":
        raise RuntimeError("checked agent template does not retain the adapter log group")
    return path, template


def _endpoint_expression(runtime_logical_id: str = "Runtime") -> dict[str, Any]:
    return {"Fn::Join": ["", [{"Fn::GetAtt": [runtime_logical_id, "AgentRuntimeArn"]}, "/runtime-endpoint/faulty"]]}


def _remove_endpoint_references(value: Any) -> Any:
    if isinstance(value, list):
        return [_remove_endpoint_references(item) for item in value if item != ENDPOINT_LOGICAL_ID]
    if isinstance(value, dict):
        if value.get("Fn::GetAtt") == [ENDPOINT_LOGICAL_ID, "AgentRuntimeEndpointArn"]:
            return _endpoint_expression()
        if value.get("Ref") == ENDPOINT_LOGICAL_ID:
            return _endpoint_expression()
        if "DependsOn" in value:
            depends = value["DependsOn"]
            if depends == ENDPOINT_LOGICAL_ID:
                value = {key: item for key, item in value.items() if key != "DependsOn"}
            elif isinstance(depends, list):
                value = {**value, "DependsOn": [item for item in depends if item != ENDPOINT_LOGICAL_ID]}
        return {key: _remove_endpoint_references(item) for key, item in value.items()}
    return value


def _derive_transition(live: Mapping[str, Any], checked: Mapping[str, Any]) -> dict[str, Any]:
    """Derive the narrow migration template from the deployed template."""
    transition = copy.deepcopy(dict(live))
    resources = transition.get("Resources")
    if not isinstance(resources, dict):
        raise RuntimeError("live agent template has no Resources object")
    endpoint = resources.get(ENDPOINT_LOGICAL_ID)
    if not isinstance(endpoint, dict) or endpoint.get("Type") != ENDPOINT_TYPE:
        raise RuntimeError("live agent template does not contain the fixed FaultyEndpoint")
    del resources[ENDPOINT_LOGICAL_ID]
    transition = _remove_endpoint_references(transition)

    checked_resources = checked.get("Resources", {})
    if not isinstance(checked_resources, dict):
        raise RuntimeError("checked agent template has no Resources object")
    # The checked post-cutover assembly must retain every live logical resource
    # except the one endpoint. This catches a stale or unrelated assembly
    # before a migration change set can be created.
    live_ids = set(live.get("Resources", {})) - {ENDPOINT_LOGICAL_ID}
    if not live_ids.issubset(checked_resources):
        missing = sorted(live_ids - set(checked_resources))
        raise RuntimeError(f"checked agent template omits live resources: {','.join(missing)}")
    output = transition.get("Outputs", {}).get("FaultyEndpointArn")
    if output is None or "FaultyEndpoint" in _canonical(output):
        raise RuntimeError("derived transition does not preserve a stable endpoint ARN output")
    if "FaultyEndpoint" in _canonical(transition["Resources"]):
        raise RuntimeError("derived transition still references the removed endpoint")
    return transition


def _run_guard(template_path: Path, description: Mapping[str, Any]) -> None:
    result = subprocess.run(
        ["node", str(ROOT / "scripts" / "check-agent-change-set.mjs"), "--reference-cutover", str(template_path)],
        input=json.dumps(description), text=True, capture_output=True, cwd=ROOT,
    )
    if result.returncode != 0:
        raise RuntimeError(f"agent cutover change set rejected: {result.stderr.strip() or result.stdout.strip()}")


def _parameter_value(parameters: Any, key: str) -> Any:
    if not isinstance(parameters, list):
        return None
    values = [item.get("ParameterValue") for item in parameters
              if isinstance(item, Mapping) and item.get("ParameterKey") == key]
    return values[0] if len(values) == 1 else None


def _assert_source_revision_preserved(
    description: Mapping[str, Any],
    expected_source_revision: str,
    expected_parameters: Any = None,
) -> None:
    parameters = description.get("Parameters")
    if not isinstance(parameters, list):
        raise RuntimeError("agent cutover change set has no complete parameter readback")
    source = [item for item in parameters if item.get("ParameterKey") == "SourceRevision"]
    if len(source) != 1:
        raise RuntimeError("agent cutover must preserve the legacy SourceRevision parameter")
    # CloudFormation's native DescribeChangeSet response commonly resolves a
    # UsePreviousValue request into ParameterValue and omits the flag.  The
    # effective value, captured before cutover, is the durable invariant.
    if "ParameterValue" in source[0]:
        if source[0].get("ParameterValue") != expected_source_revision:
            raise RuntimeError("agent cutover must preserve the legacy SourceRevision parameter")
    elif source[0].get("UsePreviousValue") is not True:
        raise RuntimeError("agent cutover must preserve the legacy SourceRevision parameter")

    if expected_parameters is None:
        return
    if not isinstance(expected_parameters, list):
        raise RuntimeError("agent cutover has no complete pre-cutover parameter snapshot")
    expected = {
        item.get("ParameterKey"): item.get("ParameterValue")
        for item in expected_parameters
        if isinstance(item, Mapping) and item.get("ParameterKey")
    }
    observed = {
        item.get("ParameterKey"): item
        for item in parameters
        if isinstance(item, Mapping) and item.get("ParameterKey")
    }
    if set(observed) != set(expected):
        raise RuntimeError("agent cutover change set parameter readback is incomplete")
    for key, value in expected.items():
        item = observed[key]
        if "ParameterValue" in item:
            if item.get("ParameterValue") != value:
                raise RuntimeError(f"agent cutover changed legacy parameter {key}")
        elif item.get("UsePreviousValue") is not True:
            raise RuntimeError(f"agent cutover has no resolved value for legacy parameter {key}")


def _describe_change_set(cf: Any, change_set_id: str) -> dict[str, Any]:
    response = cf.describe_change_set(ChangeSetName=change_set_id, StackName=STACK_NAME)
    if response.get("NextToken"):
        raise RuntimeError("agent cutover change set description is paginated")
    if response.get("Status") not in {"CREATE_COMPLETE", "UPDATE_COMPLETE"} or response.get("ExecutionStatus") != "AVAILABLE":
        raise RuntimeError("agent cutover change set is not available for execution")
    return _json_safe(dict(response))


def _read_change_set_template(cf: Any, change_set_id: str) -> dict[str, Any]:
    response = cf.get_template(ChangeSetName=change_set_id, TemplateStage="Original")
    body = response.get("TemplateBody")
    if isinstance(body, str):
        body = json.loads(body)
    if not isinstance(body, dict):
        raise RuntimeError("change set template readback is not an object")
    return body


def _wait_stack(cf: Any, expected_runtime_id: str) -> dict[str, Any]:
    deadline = time.monotonic() + 1800
    while True:
        stack = _stack(cf)
        status = stack.get("StackStatus")
        if status == "UPDATE_COMPLETE":
            runtime = next((item for item in _resources(cf) if item.get("LogicalResourceId") == "Runtime"), None)
            if not runtime or runtime.get("PhysicalResourceId") != expected_runtime_id:
                raise RuntimeError("Runtime physical ID changed during endpoint cutover")
            return stack
        if status and ("FAILED" in status or "ROLLBACK" in status):
            raise RuntimeError(f"agent stack cutover failed with status {status}")
        if time.monotonic() >= deadline:
            raise RuntimeError(f"timed out waiting for agent stack cutover ({status})")
        time.sleep(10)


def _native_not_found(error: BaseException) -> bool:
    return isinstance(error, ClientError) and error.response.get("Error", {}).get("Code") in {
        "ResourceNotFoundException", "ResourceNotFound", "NotFoundException", "NotFound",
    }


def _wait_native_endpoint_absent(control: Any, runtime_id: str, *, timeout: float = 600.0) -> dict[str, Any]:
    """Wait for native deletion propagation before the publisher can recreate it."""
    deadline = time.monotonic() + timeout
    attempts = 0
    while True:
        attempts += 1
        try:
            endpoint = control.get_agent_runtime_endpoint(agentRuntimeId=runtime_id, endpointName="faulty")
        except ClientError as error:
            if _native_not_found(error):
                return {"status": "absent", "attempts": attempts}
            raise
        if not isinstance(endpoint, Mapping):
            raise RuntimeError("native faulty endpoint readback is malformed")
        if time.monotonic() >= deadline:
            raise RuntimeError("native faulty endpoint remains visible after the CloudFormation cutover")
        time.sleep(5)


def _default_plan_path() -> Path:
    return Path(os.environ.get("RUNNER_TEMP", "/tmp")) / "agent-reference-cutover.json"


def prepare(plan_path: Path) -> dict[str, Any]:
    session = boto3.Session(region_name=REGION)
    cf = session.client("cloudformation")
    stack = _stack(cf)
    if stack.get("StackStatus") not in {"CREATE_COMPLETE", "UPDATE_COMPLETE"}:
        raise RuntimeError(f"agent stack is not settled for cutover ({stack.get('StackStatus')})")
    resources = _resources(cf)
    legacy = _legacy_resource(resources)
    # Reuse the fixed publisher's complete read-only preflight.  It verifies
    # the live account/scope, archive bytes, adapter code/tracing, Runtime and
    # endpoint identities before this function creates any change set.
    helper = _load_setup_module()
    preflight = _json_safe(helper.preflight_faulty_reference(session, require_rollback=legacy is not None))
    if legacy is None:
        return {
            "status": "already_detached",
            "stackName": STACK_NAME,
            "stackId": stack.get("StackId"),
            "preflight": preflight,
        }

    archive = preflight["archive"]
    checked_path, checked = _checked_template()
    live = _stack_template(cf)
    transition = _derive_transition(live, checked)
    adapter = _json_safe(session.client("lambda").get_function_configuration(FunctionName="IncidentTriageDemoAlarmAdapter"))
    parameters_before_cutover = stack.get("Parameters", [])
    source_revision_before_cutover = _parameter_value(parameters_before_cutover, "SourceRevision")
    if not isinstance(source_revision_before_cutover, str):
        raise RuntimeError("live agent stack has no single resolved SourceRevision parameter")
    rollback = plan_path.with_suffix(".rollback.json")
    rollback_payload = {
        "stackName": STACK_NAME,
        "stackId": stack.get("StackId"),
        "runtimeId": next((item.get("PhysicalResourceId") for item in resources if item.get("LogicalResourceId") == "Runtime"), None),
        "legacyEndpoint": legacy,
        "template": live,
        "parameters": parameters_before_cutover,
        "adapterConfiguration": adapter,
        "archivePreflight": archive,
        "fullPreflight": preflight,
    }
    rollback.write_text(json.dumps(rollback_payload, indent=2, sort_keys=True) + "\n")
    transition_path = plan_path.with_suffix(".template.json")
    transition_path.write_text(json.dumps(transition, indent=2, sort_keys=True) + "\n")

    reviewed_release_sha = os.environ.get("GITHUB_SHA", "")
    if not re.fullmatch(r"[a-f0-9]{40}", reviewed_release_sha):
        raise RuntimeError("trusted workflow must provide a 40-character GITHUB_SHA")
    change_set_name = f"phase19-agent-cutover-{reviewed_release_sha}"
    parameters = []
    for item in stack.get("Parameters", []):
        key = item.get("ParameterKey")
        parameters.append({"ParameterKey": key, "UsePreviousValue": True})
    try:
        existing = cf.describe_change_set(StackName=STACK_NAME, ChangeSetName=change_set_name)
    except ClientError as error:
        if "not exist" not in str(error).lower() and "not found" not in str(error).lower():
            raise
        existing = None
    if existing is None:
        cf.create_change_set(
            StackName=STACK_NAME,
            ChangeSetName=change_set_name,
            ChangeSetType="UPDATE",
            TemplateBody=_canonical(transition),
            Parameters=parameters,
            Capabilities=["CAPABILITY_NAMED_IAM"],
            Description="Phase19 one-time removal of the legacy publisher endpoint",
        )
        # Keep this waiter bounded and inspect the exact native object before
        # returning control to the workflow for its review gate.
        deadline = time.monotonic() + 900
        while True:
            existing = cf.describe_change_set(StackName=STACK_NAME, ChangeSetName=change_set_name)
            if existing.get("Status") in {"CREATE_COMPLETE", "FAILED"}:
                break
            if time.monotonic() >= deadline:
                raise RuntimeError("timed out waiting for the agent cutover change set")
            time.sleep(5)
    description = _describe_change_set(cf, existing.get("ChangeSetId", change_set_name))
    _assert_source_revision_preserved(description, source_revision_before_cutover, parameters_before_cutover)
    _run_guard(transition_path, description)
    actual = _read_change_set_template(cf, description["ChangeSetId"])
    if _digest(actual) != _digest(transition):
        raise RuntimeError("native change-set template readback differs from the derived transition")
    plan = {
        "status": "prepared",
        "stackName": STACK_NAME,
        "stackId": stack.get("StackId"),
        "runtimeId": rollback_payload["runtimeId"],
        "legacyEndpoint": legacy,
        "changeSetId": description["ChangeSetId"],
        "changeSetName": change_set_name,
        "reviewedReleaseSha": reviewed_release_sha,
        "sourceRevisionBeforeCutover": source_revision_before_cutover,
        "changeSetDescription": description,
        "rollbackPath": str(rollback),
        "transitionTemplatePath": str(transition_path),
        "transitionTemplateSha256": _digest(transition),
        "checkedTemplatePath": str(checked_path),
        "checkedTemplateSha256": _digest(checked),
        "archivePreflight": archive,
        "fullPreflight": preflight,
    }
    plan_path.write_text(json.dumps(plan, indent=2, sort_keys=True) + "\n")
    return plan


def execute(plan_path: Path) -> dict[str, Any]:
    plan = _load_json(plan_path)
    if plan.get("status") == "already_detached":
        return dict(plan)
    if plan.get("status") != "prepared" or not plan.get("changeSetId"):
        raise RuntimeError("cutover plan is not an inspectable prepared plan")
    transition_path = Path(plan["transitionTemplatePath"])
    transition = _load_json(transition_path)
    if _digest(transition) != plan.get("transitionTemplateSha256"):
        raise RuntimeError("cutover transition template changed after preparation")
    rollback_path = Path(plan.get("rollbackPath", ""))
    rollback = _load_json(rollback_path)
    if rollback.get("stackId") != plan.get("stackId") or rollback.get("runtimeId") != plan.get("runtimeId"):
        raise RuntimeError("cutover rollback snapshot belongs to a different stack or Runtime")
    if rollback.get("legacyEndpoint", {}).get("PhysicalResourceId") != plan.get("legacyEndpoint", {}).get("PhysicalResourceId"):
        raise RuntimeError("cutover rollback snapshot does not retain the inspected endpoint")
    if rollback.get("fullPreflight") != plan.get("fullPreflight"):
        raise RuntimeError("cutover rollback snapshot does not retain the inspected preflight")
    parameters_before_cutover = rollback.get("parameters")
    source_revision_before_cutover = _parameter_value(parameters_before_cutover, "SourceRevision")
    if not isinstance(source_revision_before_cutover, str) or source_revision_before_cutover != plan.get("sourceRevisionBeforeCutover"):
        raise RuntimeError("cutover rollback snapshot does not retain the observed SourceRevision")
    session = boto3.Session(region_name=REGION)
    cf = session.client("cloudformation")
    stack = _stack(cf)
    if stack.get("StackId") != plan.get("stackId"):
        raise RuntimeError("cutover plan belongs to a different CloudFormation stack")
    if stack.get("StackStatus") not in {"CREATE_COMPLETE", "UPDATE_COMPLETE"}:
        if stack.get("StackStatus") == "UPDATE_IN_PROGRESS":
            stack = _wait_stack(cf, plan["runtimeId"])
        else:
            raise RuntimeError(f"agent stack is not settled for cutover execution ({stack.get('StackStatus')})")
    legacy = _legacy_resource(_resources(cf))
    if legacy is None:
        if stack.get("StackStatus") == "UPDATE_COMPLETE":
            native_endpoint = _wait_native_endpoint_absent(
                session.client("bedrock-agentcore-control"), plan["runtimeId"],
            )
            result = {
                "status": "already_retired",
                "stackName": STACK_NAME,
                "stackId": plan["stackId"],
                "runtimeId": plan["runtimeId"],
                "changeSetId": plan["changeSetId"],
                "rollbackPath": plan["rollbackPath"],
                "transitionTemplateSha256": plan["transitionTemplateSha256"],
                "nativeEndpoint": native_endpoint,
            }
            plan["status"] = "retired"
            plan["result"] = result
            plan_path.write_text(json.dumps(plan, indent=2, sort_keys=True) + "\n")
            return result
        raise RuntimeError("cutover endpoint is already absent without a confirmed completed stack update; refusing a second irreversible removal")
    if legacy.get("PhysicalResourceId") != plan.get("legacyEndpoint", {}).get("PhysicalResourceId"):
        raise RuntimeError("live legacy endpoint differs from the prepared rollback identity")
    helper = _load_setup_module()
    current_preflight = helper.preflight_faulty_reference(session, require_rollback=True)
    planned_preflight = plan.get("fullPreflight")
    if not isinstance(planned_preflight, Mapping) or current_preflight.get("status") != "ready":
        raise RuntimeError("cutover no longer has a trusted rollback preflight")
    for key in ("archive", "runtime", "endpoint", "adapter", "trustedRollback"):
        if current_preflight.get(key) != planned_preflight.get(key):
            raise RuntimeError(f"cutover preflight changed before execution: {key}")
    description = _describe_change_set(cf, plan["changeSetId"])
    _assert_source_revision_preserved(description, source_revision_before_cutover, parameters_before_cutover)
    _run_guard(transition_path, description)
    actual = _read_change_set_template(cf, plan["changeSetId"])
    if _digest(actual) != _digest(transition):
        raise RuntimeError("native change-set template readback differs from the prepared transition")
    cf.execute_change_set(ChangeSetName=plan["changeSetId"], StackName=STACK_NAME)
    _wait_stack(cf, plan["runtimeId"])
    if _legacy_resource(_resources(cf)) is not None:
        raise RuntimeError("CloudFormation cutover completed but the legacy endpoint remains managed")
    native_endpoint = _wait_native_endpoint_absent(
        session.client("bedrock-agentcore-control"), plan["runtimeId"],
    )
    result = {
        "status": "retired",
        "stackName": STACK_NAME,
        "stackId": plan["stackId"],
        "runtimeId": plan["runtimeId"],
        "changeSetId": plan["changeSetId"],
        "legacyEndpointPhysicalId": plan["legacyEndpoint"]["PhysicalResourceId"],
        "rollbackPath": plan["rollbackPath"],
        "transitionTemplateSha256": plan["transitionTemplateSha256"],
        "nativeEndpoint": native_endpoint,
    }
    plan["status"] = "retired"
    plan["result"] = result
    plan_path.write_text(json.dumps(plan, indent=2, sort_keys=True) + "\n")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("prepare", "execute"))
    parser.add_argument("--plan", type=Path, default=_default_plan_path())
    args = parser.parse_args()
    result = prepare(args.plan) if args.operation == "prepare" else execute(args.plan)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
