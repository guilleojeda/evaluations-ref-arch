"""Deployment-only regression checks; no AWS request or inference is made."""
from __future__ import annotations
from datetime import datetime, timezone
import importlib.util
import json
from fnmatch import fnmatchcase
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest
from unittest.mock import patch
import yaml
class ReleaseTests(unittest.TestCase):
    """The ordinary release no longer owns native endpoint finalization."""

    def test_obsolete_native_finalizer_is_removed_and_release_shell_does_not_write_endpoint(self):
        root = Path(__file__).parents[1]
        self.assertFalse((root / "scripts/finalize-agent.py").exists())
        deploy = (root / "scripts/deploy-agent.sh").read_text()
        self.assertNotIn("finalize-agent.py", deploy)
        self.assertNotRegex(deploy, r"(?:update|create|delete)_agent_runtime_endpoint")

    def test_ordinary_release_carries_publisher_tuple_as_parameters(self):
        deploy = (Path(__file__).parents[1] / "scripts/deploy-agent.sh").read_text()
        for parameter in ("PublishedVersion", "PublishedCodeRevision", "PublishedArtifactDigest"):
            self.assertIn(parameter, deploy)
        for parameter in ("PublishedRuntimeAssetBucket", "PublishedRuntimeAssetKey", "PublishedRuntimeCodeRevision", "PublishedRuntimeArtifactDigest", "PublishedRuntimeBootstrapEnabled"):
            self.assertIn(parameter, deploy)
        self.assertIn("legacy_endpoint_managed", deploy)
        self.assertIn("list-stack-resources", deploy)

    def test_ordinary_release_requires_strong_publication_and_native_tuple_readback(self):
        deploy = (Path(__file__).parents[1] / "scripts/deploy-agent.sh").read_text()
        for token in (
            "dynamodb get-item",
            "--consistent-read",
            "AGENT_PUBLICATION#faulty",
            "bedrock-agentcore-control get-agent-runtime-endpoint",
            "adapterCodeSha256",
            "verify_prepared_publisher_parameters",
            "delete-change-set",
        ):
            self.assertIn(token, deploy)
        self.assertIn("No fixed AGENT_PUBLICATION#faulty record exists", deploy)
        self.assertIn("Adapter RevisionId changed during ordinary reconciliation", deploy)

    def test_ordinary_shell_reconciles_fresh_and_stale_same_revision_states(self):
        """Exercise the release shell with executable fake AWS/CDK transports."""
        root = Path(__file__).parents[1]
        deploy_source = (root / "scripts/deploy-agent.sh").read_text()
        sha = "a" * 40
        runtime_id = "IncidentTriageDemoAgent-Test123456"
        runtime_arn = f"arn:aws:bedrock-agentcore:us-east-1:027224425948:runtime/{runtime_id}"
        endpoint_arn = f"{runtime_arn}/runtime-endpoint/faulty"
        current_source = "b" * 40
        current_digest = "c" * 64
        adapter_code = "d" * 64
        bootstrap_revision = "e" * 40
        bootstrap_digest = "f" * 64

        fake_aws = textwrap.dedent(r'''
            #!/usr/bin/env python3
            import json, os, sys
            from pathlib import Path
            state_path = Path(os.environ["FIXTURE_STATE"])
            state = json.loads(state_path.read_text())
            args = sys.argv[1:]
            service, operation = args[0], args[1]
            def arg(name):
                try:
                    return args[args.index(name) + 1]
                except (ValueError, IndexError):
                    return None
            def save():
                state_path.write_text(json.dumps(state))
            def out(value):
                print(json.dumps(value))
            if service == "sts" and operation == "assume-role":
                out({"AccessKeyId": "access", "SecretAccessKey": "secret", "SessionToken": "token"})
            elif service == "sts" and operation == "get-caller-identity":
                print("arn:aws:sts::027224425948:assumed-role/cdk-evaltalk-deploy-role-027224425948-us-east-1/test" if arg("--output") == "text" else json.dumps({"Arn": "arn:aws:sts::027224425948:assumed-role/cdk-evaltalk-deploy-role-027224425948-us-east-1/test"}))
            elif service == "cloudformation" and operation == "describe-stacks":
                if arg("--stack-name") == "IncidentTriageDemoApp":
                    out({"Stacks": [{"Outputs": [{"OutputKey": "ApiUrl", "OutputValue": "https://api123.execute-api.us-east-1.amazonaws.com"}]}]})
                elif state.get("stack") is None:
                    print("Stack does not exist", file=sys.stderr)
                    raise SystemExit(255)
                else:
                    out({"Stacks": [state["stack"]]})
            elif service == "cloudformation" and operation == "list-stack-resources":
                out({"StackResourceSummaries": []})
            elif service == "cloudformation" and operation == "describe-change-set":
                if "--include-property-values" in args:
                    state["include_property_values_calls"] = state.get("include_property_values_calls", 0) + 1
                    save()
                if state.get("change_set") is None:
                    print("ChangeSet does not exist", file=sys.stderr)
                    raise SystemExit(255)
                out(state["change_set"])
            elif service == "cloudformation" and operation == "delete-change-set":
                state["delete_calls"] = state.get("delete_calls", 0) + 1
                state["change_set"] = None
                save()
            elif service == "cloudformation" and operation == "get-template":
                out({"TemplateBody": "{}"})
            elif service == "cloudformation" and operation == "execute-change-set":
                state["execute_calls"] = state.get("execute_calls", 0) + 1
                parameters = state["change_set"]["Parameters"]
                outputs = state["outputs"]
                state["stack"] = {"StackStatus": "UPDATE_COMPLETE", "StackId": "stack-id", "Parameters": parameters, "Outputs": outputs}
                save()
            elif service == "dynamodb" and operation == "get-item":
                state["ddb_calls"] = state.get("ddb_calls", 0) + 1
                save()
                out({"Item": state["publication"]} if state.get("publication") else {})
            elif service == "lambda" and operation == "get-function-configuration":
                out(state["adapter"])
            elif service == "bedrock-agentcore-control" and operation == "get-agent-runtime-endpoint":
                out(state["endpoint"])
            else:
                print(f"unexpected fake aws call: {args}", file=sys.stderr)
                raise SystemExit(2)
        ''').lstrip()
        fake_cdk = textwrap.dedent(r'''
            #!/usr/bin/env python3
            import json, os, sys
            from pathlib import Path
            state_path = Path(os.environ["FIXTURE_STATE"])
            state = json.loads(state_path.read_text())
            args = sys.argv[1:]
            parameters = []
            for index, value in enumerate(args):
                if value == "--parameters":
                    _stack_name, parameter = args[index + 1].split(":", 1)
                    key, value = parameter.split("=", 1)
                    parameters.append({"ParameterKey": key, "ParameterValue": value})
            state["cdk_calls"] = state.get("cdk_calls", 0) + 1
            state["change_set"] = {"ChangeSetId": "arn:aws:cloudformation:us-east-1:027224425948:changeSet/fake/11111111-1111-4111-8111-111111111111", "StackId": "stack-id", "StackName": "IncidentTriageDemoAgent", "Status": "CREATE_COMPLETE", "ExecutionStatus": "AVAILABLE", "Parameters": parameters}
            state_path.write_text(json.dumps(state))
        ''').lstrip()
        fake_node = "#!/bin/sh\nexit 0\n"
        fake_git = "#!/bin/sh\nexit 0\n"

        def run_fixture(kind: str, *, stale_change_set: bool = False, adapter_mismatch: bool = False):
            with tempfile.TemporaryDirectory(prefix="agent-release-fixture-") as temporary:
                fixture = Path(temporary)
                (fixture / "scripts").mkdir()
                (fixture / ".artifacts/agent/cdk").mkdir(parents=True)
                (fixture / "node_modules/.bin").mkdir(parents=True)
                (fixture / "bin").mkdir()
                (fixture / "scripts/deploy-agent.sh").write_text(deploy_source)
                (fixture / "scripts/deploy-agent.sh").chmod(0o755)
                (fixture / ".artifacts/agent/cdk/manifest.json").write_text(json.dumps({"artifacts": {"IncidentTriageDemoAgent": {"properties": {"templateFile": "template.json"}}}}))
                (fixture / ".artifacts/agent/cdk/template.json").write_text("{}")
                (fixture / "bin/aws").write_text(fake_aws)
                (fixture / "bin/aws").chmod(0o755)
                (fixture / "bin/node").write_text(fake_node)
                (fixture / "bin/node").chmod(0o755)
                (fixture / "bin/git").write_text(fake_git)
                (fixture / "bin/git").chmod(0o755)
                (fixture / "node_modules/.bin/cdk").write_text(fake_cdk)
                (fixture / "node_modules/.bin/cdk").chmod(0o755)
                outputs = [
                    {"OutputKey": "SourceRevision", "OutputValue": sha},
                    {"OutputKey": "RuntimeId", "OutputValue": runtime_id},
                    {"OutputKey": "RuntimeArn", "OutputValue": runtime_arn},
                    {"OutputKey": "FaultyEndpointArn", "OutputValue": endpoint_arn},
                    {"OutputKey": "EndpointName", "OutputValue": "faulty"},
                    {"OutputKey": "RunTableName", "OutputValue": "IncidentTriageDemoAgentRun"},
                    {"OutputKey": "RuntimeAssetObjectKey", "OutputValue": "bootstrap.zip"},
                    {"OutputKey": "RuntimeArtifactSha256", "OutputValue": bootstrap_digest},
                    {"OutputKey": "AlarmAdapterCodeSha256", "OutputValue": adapter_code},
                ]
                publication = {
                    "pk": {"S": "AGENT_PUBLICATION#faulty"},
                    "candidateId": {"S": "faulty"}, "status": {"S": "reference"},
                    "runtimeArn": {"S": runtime_arn}, "runtimeVersion": {"S": "19"},
                    "endpointName": {"S": "faulty"}, "endpointArn": {"S": endpoint_arn},
                    "sourceRevision": {"S": current_source}, "artifactSha256": {"S": current_digest},
                    "adapterArn": {"S": "arn:aws:lambda:us-east-1:027224425948:function:IncidentTriageDemoAlarmAdapter"},
                    "adapterRevisionId": {"S": "publisher-revision"}, "adapterCodeSha256": {"S": "0" * 64},
                }
                adapter_digest = "0" * 64 if adapter_mismatch else adapter_code
                import base64
                adapter = {
                    "FunctionArn": publication["adapterArn"]["S"], "RevisionId": "ordinary-refresh-revision",
                    "CodeSha256": base64.b64encode(bytes.fromhex(adapter_digest)).decode(),
                    "Environment": {"Variables": {
                        "AGENT_RUNTIME_ARN": runtime_arn, "AGENT_ENDPOINT_NAME": "faulty",
                        "AGENT_RUNTIME_VERSION": "19", "AGENT_SOURCE_REVISION": current_source,
                        "AGENT_ARTIFACT_SHA256": current_digest,
                    }},
                }
                stack = None
                if kind != "fresh":
                    stale = stale_change_set or kind == "same_revision_stale"
                    parameters = [
                        {"ParameterKey": "SourceRevision", "ParameterValue": sha},
                        {"ParameterKey": "AppHttpApiId", "ParameterValue": "api123"},
                        {"ParameterKey": "PublishedVersion", "ParameterValue": "18" if stale else "19"},
                        {"ParameterKey": "PublishedCodeRevision", "ParameterValue": "1" * 40 if stale else current_source},
                        {"ParameterKey": "PublishedArtifactDigest", "ParameterValue": "2" * 64 if stale else current_digest},
                        {"ParameterKey": "PublishedRuntimeAssetBucket", "ParameterValue": "assets"},
                        {"ParameterKey": "PublishedRuntimeAssetKey", "ParameterValue": "bootstrap.zip"},
                        {"ParameterKey": "PublishedRuntimeCodeRevision", "ParameterValue": bootstrap_revision},
                        {"ParameterKey": "PublishedRuntimeArtifactDigest", "ParameterValue": bootstrap_digest},
                        {"ParameterKey": "PublishedRuntimeBootstrapEnabled", "ParameterValue": "true"},
                    ]
                    stack = {"StackStatus": "UPDATE_COMPLETE", "StackId": "stack-id", "Parameters": parameters, "Outputs": outputs}
                state = {"stack": stack, "outputs": outputs, "publication": None if kind == "fresh" else publication, "adapter": adapter,
                         "endpoint": {"agentRuntimeArn": runtime_arn, "agentRuntimeEndpointArn": endpoint_arn, "status": "READY", "liveVersion": "19", "targetVersion": "19"},
                         "change_set": None, "cdk_calls": 0, "delete_calls": 0, "execute_calls": 0, "ddb_calls": 0,
                         "include_property_values_calls": 0}
                if stale_change_set:
                    state["change_set"] = {"ChangeSetId": "arn:aws:cloudformation:us-east-1:027224425948:changeSet/stale/11111111-1111-4111-8111-111111111111", "StackId": "stack-id", "StackName": "IncidentTriageDemoAgent", "Status": "CREATE_COMPLETE", "ExecutionStatus": "AVAILABLE", "Parameters": [{"ParameterKey": "PublishedVersion", "ParameterValue": "18"}]}
                state_path = fixture / "state.json"
                state_path.write_text(json.dumps(state))
                environment = {
                    **os.environ, "PATH": f"{fixture / 'bin'}:{os.environ['PATH']}", "FIXTURE_STATE": str(state_path),
                    "PHASE0_AGENT_STACK": "IncidentTriageDemoAgent", "PHASE0_APP_STACK": "IncidentTriageDemoApp",
                    "CDK_DEPLOY_ROLE_ARN": "arn:aws:iam::027224425948:role/deploy", "GITHUB_RUN_ID": "fixture",
                    "GITHUB_SHA": sha, "PHASE0_ASSET_BUCKET": "assets", "RUNNER_TEMP": str(fixture),
                    "GITHUB_STEP_SUMMARY": str(fixture / "summary.md"),
                }
                result = subprocess.run(["bash", "scripts/deploy-agent.sh"], cwd=fixture, env=environment, text=True, capture_output=True, timeout=30)
                return result, json.loads(state_path.read_text())

        fresh_result, fresh_state = run_fixture("fresh")
        self.assertEqual(0, fresh_result.returncode, fresh_result.stdout + fresh_result.stderr)
        self.assertEqual(1, fresh_state["cdk_calls"])
        self.assertEqual(1, fresh_state["execute_calls"])
        self.assertEqual(0, fresh_state["ddb_calls"])
        self.assertGreaterEqual(fresh_state["include_property_values_calls"], 1)

        stale_result, stale_state = run_fixture("same_revision_stale", stale_change_set=True)
        self.assertEqual(0, stale_result.returncode, stale_result.stdout + stale_result.stderr)
        self.assertEqual(1, stale_state["cdk_calls"], stale_result.stdout + stale_result.stderr)
        self.assertEqual(1, stale_state["delete_calls"])
        self.assertEqual(1, stale_state["execute_calls"])
        self.assertGreaterEqual(stale_state["include_property_values_calls"], 2)
        self.assertIn("stale", stale_result.stderr)

        mismatch_result, mismatch_state = run_fixture("existing", adapter_mismatch=True)
        self.assertNotEqual(0, mismatch_result.returncode)
        self.assertEqual(0, mismatch_state["cdk_calls"])
        self.assertEqual(0, mismatch_state["execute_calls"])
        self.assertIn("checked adapter-code authority", mismatch_result.stderr)

    def test_cutover_helper_has_only_prepare_and_execute_plan_operations(self):
        helper = (Path(__file__).parents[1] / "scripts/retire-agent-endpoint.py").read_text()
        self.assertIn('choices=("prepare", "execute")', helper)
        self.assertIn("--reference-cutover", helper)
        self.assertIn("already_detached", helper)
        self.assertIn("already_retired", helper)
        self.assertIn("rollback", helper)
        for mutable_flag in ("--candidate", "--endpoint", "--runtime", "--uri", "--version"):
            self.assertNotIn(f'add_argument("{mutable_flag}', helper)
        self.assertIn('"UsePreviousValue": True', helper)
        self.assertIn("SourceRevision parameter", helper)
        self.assertIn("get_agent_runtime_endpoint", helper)
        self.assertIn("native faulty endpoint remains visible", helper)

    def test_same_revision_retry_only_skips_after_preservation_parameters_exist(self):
        deploy = (Path(__file__).parents[1] / "scripts/deploy-agent.sh").read_text()
        self.assertIn("stack_has_parameter PublishedVersion", deploy)
        self.assertIn("stack_has_parameter PublishedRuntimeBootstrapEnabled", deploy)

    def test_cutover_accepts_resolved_use_previous_values_and_serializes_native_dates(self):
        root = Path(__file__).parents[1]
        spec = importlib.util.spec_from_file_location("phase19_retire_agent_endpoint", root / "scripts/retire-agent-endpoint.py")
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        source = "a" * 40
        previous = [
            {"ParameterKey": "SourceRevision", "ParameterValue": source},
            {"ParameterKey": "PublishedVersion", "ParameterValue": "7"},
        ]
        # AWS may omit UsePreviousValue and return the resolved value instead.
        described = {
            "Parameters": [dict(item) for item in previous],
            "CreationTime": datetime(2026, 11, 17, 12, 30, tzinfo=timezone.utc),
        }
        module._assert_source_revision_preserved(described, source, previous)
        safe = module._json_safe(described)
        self.assertEqual("2026-11-17T12:30:00Z", safe["CreationTime"])
        json.dumps(safe)

        class CloudFormation:
            def describe_change_set(self, **_request):
                return {
                    "Status": "CREATE_COMPLETE",
                    "ExecutionStatus": "AVAILABLE",
                    "CreationTime": datetime(2026, 11, 17, 12, 31, tzinfo=timezone.utc),
                    "Parameters": [dict(item) for item in previous],
                }

            def list_stack_resources(self, **_request):
                return {"StackResourceSummaries": [{
                    "LogicalResourceId": "FaultyEndpoint",
                    "LastUpdatedTimestamp": datetime(2026, 11, 17, 12, 32, tzinfo=timezone.utc),
                }]}

        native_description = module._describe_change_set(CloudFormation(), "change-set-id")
        self.assertEqual("2026-11-17T12:31:00Z", native_description["CreationTime"])
        native_resources = module._resources(CloudFormation())
        self.assertEqual("2026-11-17T12:32:00Z", native_resources[0]["LastUpdatedTimestamp"])
        described["Parameters"][1]["ParameterValue"] = "8"
        with self.assertRaisesRegex(RuntimeError, "changed legacy parameter"):
            module._assert_source_revision_preserved(described, source, previous)

    def test_cutover_waits_for_native_endpoint_deletion_propagation(self):
        root = Path(__file__).parents[1]
        spec = importlib.util.spec_from_file_location("phase19_retire_agent_endpoint", root / "scripts/retire-agent-endpoint.py")
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        class Control:
            def __init__(self):
                self.calls = 0

            def get_agent_runtime_endpoint(self, **_request):
                self.calls += 1
                if self.calls < 3:
                    return {"status": "DELETING"}
                error = module.ClientError(
                    {"Error": {"Code": "ResourceNotFoundException", "Message": "not found"}},
                    "GetAgentRuntimeEndpoint",
                )
                raise error

        control = Control()
        with patch.object(module.time, "sleep", return_value=None):
            result = module._wait_native_endpoint_absent(control, "IncidentTriageDemoAgent-7VWTOWDIs4", timeout=1)
        self.assertEqual({"status": "absent", "attempts": 3}, result)
        self.assertEqual(3, control.calls)

class ReleaseTemplateTests(unittest.TestCase):
    @staticmethod
    def agent_policy():
        class Loader(yaml.SafeLoader): pass
        Loader.add_multi_constructor("!", lambda loader, tag, node: {tag: loader.construct_scalar(node)})
        template = yaml.load((Path(__file__).parents[1] / "infrastructure/bootstrap/phase0-cfn-execution-policy.yaml").read_text(), Loader=Loader)
        return template["Resources"]["IncidentTriageDemoAgentCfnExecution"]["Properties"]["PolicyDocument"]

    def test_deploy_guard_decrypts_only_inventory_and_adapter_environment_contexts(self):
        template = yaml.safe_load((Path(__file__).parents[1] / "infrastructure/bootstrap/github-iam.yaml").read_text())
        guard = template["Resources"]["DedicatedCdkDeployRolePhase0Guard"]["Properties"]
        self.assertEqual([{"Fn::Sub": "cdk-evaltalk-deploy-role-${AWS::AccountId}-${AWS::Region}"}], guard["Roles"])
        statements = {statement["Sid"]: statement for statement in guard["PolicyDocument"]["Statement"]}
        environment_key = "arn:aws:kms:us-east-1:027224425948:key/9d894f12-dc33-4332-bb3e-df489928914b"
        decrypt = statements["DenyLambdaKeyOutsideApprovedEnvironments"]
        self.assertEqual("Deny", decrypt["Effect"])
        self.assertEqual("kms:Decrypt", decrypt["Action"])
        self.assertEqual(environment_key, decrypt["Resource"])
        inventory = "arn:aws:lambda:us-east-1:027224425948:function:IncidentTriageDemoInventory"
        adapter = "arn:aws:lambda:us-east-1:027224425948:function:IncidentTriageDemoAlarmAdapter"
        allowed = decrypt["Condition"]["StringNotLike"]["kms:EncryptionContext:aws:lambda:FunctionArn"]
        self.assertEqual([inventory, adapter], allowed)
        for context in [None, "", adapter + ":live", adapter.replace("AlarmAdapter", "ControllerHttp"), adapter.replace("AlarmAdapter", "ControllerWorker"), adapter.replace("AlarmAdapter", "Checkout"), adapter.replace("027224425948", "123456789012"), adapter.replace("us-east-1", "us-west-2")]:
            with self.subTest(context=context):
                self.assertFalse(any(fnmatchcase(context or "", value) for value in allowed))
        self.assertEqual([
            "arn:aws:kms:us-east-1:027224425948:key/b292b95c-709f-42c6-aa42-b934ba2c6f07", environment_key,
            "arn:aws:kms:us-east-1:027224425948:key/2a020640-e95b-4bec-8ae7-3f6d9fcb8e0d",
        ], statements["DenyDecryptOutsideBootstrapS3Key"]["NotResource"])
        self.assertEqual([
            "arn:aws:s3:::cdk-evaltalk-assets-027224425948-us-east-1/*.json",
            "arn:aws:s3:::cdk-evaltalk-assets-027224425948-us-east-1/*.zip",
            "arn:aws:s3:::cdk-evaltalk-assets-027224425948-us-east-1/agent-reference/*",
        ], statements["DenyBootstrapKeyOutsideBootstrapTemplates"]["Condition"]["StringNotLike"]["kms:EncryptionContext:aws:s3:arn"])
        # The explicit-deny boundary remains in the inline guard.  The
        # release-finalization and Phase 19 additive grants live in the
        # dedicated managed policy below so the two inline policies on the
        # pre-existing deploy role remain under IAM's 10,240-character limit.
        for sid in [
            "DenyNonAppDeploymentActions",
            "DenyProductActionsOutsideNamedStacks",
            "DenyAppReadsOutsideApprovedStacks",
            "DenyPassRoleOutsideCdkExecutionRole",
            "DenyDecryptOutsideBootstrapS3Key",
            "DenyBootstrapKeyOutsideBootstrapTemplates",
            "DenyLambdaKeyOutsideApprovedEnvironments",
            "DenyEncryptOutsideAdapterEnvironment",
            "DenyEncryptOrDescribeOtherKeys",
            "DenyEncryptOrDescribeOutsideLambda",
            "DenyPublishingOutsideAppWebObjects",
            "DenyOtherControllerRecords",
        ]:
            self.assertEqual("Deny", statements[sid]["Effect"], sid)
        self.assertIn("bedrock-agentcore:ListAgentRuntimeVersions", statements["DenyNonAppDeploymentActions"]["NotAction"])
        self.assertIn("bedrock-agentcore:CreateAgentRuntimeEndpoint", statements["DenyNonAppDeploymentActions"]["NotAction"])
        self.assertEqual(
            {"AGENT_PUBLICATION#faulty"},
            set(statements["DenyOtherControllerRecords"]["Condition"]["ForAnyValue:StringNotEquals"]["dynamodb:LeadingKeys"]),
        )
        for sid in [
            "FinalizeCheckedAgentRuntime",
            "ListRuntimeVersions",
            "AttestVerifiedRuntimeInAdapter",
            "PassCheckedAgentRole",
            "ReadInventoryReleaseManifestBucket",
            "PublishInventoryReleaseManifest",
            "ReadAgentReference",
            "PublishFaultyRecord",
            "DecryptFaultyControllerRecord",
        ]:
            self.assertNotIn(sid, statements)
        oidc = template["Resources"]["GitHubDeployRole"]["Properties"]["Policies"]
        self.assertEqual({"sts:AssumeRole"}, {statement["Action"] for policy in oidc for statement in policy["PolicyDocument"]["Statement"]})

    def test_phase19_publisher_managed_policy_preserves_scope_and_fits_iam_quotas(self):
        template = yaml.safe_load((Path(__file__).parents[1] / "infrastructure/bootstrap/github-iam.yaml").read_text())
        resources = template["Resources"]
        guard = resources["DedicatedCdkDeployRolePhase0Guard"]
        managed = resources["Phase19PublisherPermissions"]
        self.assertEqual("AWS::IAM::ManagedPolicy", managed["Type"])
        self.assertEqual("DedicatedCdkDeployRolePhase0Guard", managed["DependsOn"])
        properties = managed["Properties"]
        self.assertEqual("IncidentTriageDemoPhase19Publisher", properties["ManagedPolicyName"])
        self.assertEqual(
            [{"Fn::Sub": "cdk-evaltalk-deploy-role-${AWS::AccountId}-${AWS::Region}"}],
            properties["Roles"],
        )

        inline_statements = {statement["Sid"]: statement for statement in guard["Properties"]["PolicyDocument"]["Statement"]}
        managed_statements = {statement["Sid"]: statement for statement in properties["PolicyDocument"]["Statement"]}
        moved_sids = {
            "FinalizeCheckedAgentRuntime",
            "AttestVerifiedRuntimeInAdapter",
            "PassCheckedAgentRole",
            "ReadInventoryReleaseManifestBucket",
            "PublishInventoryReleaseManifest",
            "ListRuntimeVersions",
            "CreateCheckedAgentRuntimeEndpoint",
            "ReadAgentReference",
            "PublishFaultyRecord",
        }
        self.assertTrue(moved_sids.issubset(managed_statements))
        self.assertTrue(moved_sids.isdisjoint(inline_statements))

        runtime = managed_statements["FinalizeCheckedAgentRuntime"]
        self.assertEqual("Allow", runtime["Effect"])
        self.assertEqual(
            {
                "bedrock-agentcore:GetAgentRuntime",
                "bedrock-agentcore:UpdateAgentRuntime",
                "bedrock-agentcore:GetAgentRuntimeEndpoint",
                "bedrock-agentcore:UpdateAgentRuntimeEndpoint",
            },
            set(runtime["Action"]),
        )
        self.assertEqual(
            {
                "arn:aws:bedrock-agentcore:us-east-1:027224425948:runtime/IncidentTriageDemoAgent-??????????",
                "arn:aws:bedrock-agentcore:us-east-1:027224425948:runtime/IncidentTriageDemoAgent-??????????/runtime-endpoint/faulty",
            },
            set(runtime["Resource"]),
        )
        create = managed_statements["CreateCheckedAgentRuntimeEndpoint"]
        self.assertEqual("Allow", create["Effect"])
        self.assertEqual("bedrock-agentcore:CreateAgentRuntimeEndpoint", create["Action"])
        self.assertEqual(
            {
                "arn:aws:bedrock-agentcore:us-east-1:027224425948:runtime/IncidentTriageDemoAgent-7VWTOWDIs4",
                "arn:aws:bedrock-agentcore:us-east-1:027224425948:runtime/IncidentTriageDemoAgent-7VWTOWDIs4/runtime-endpoint/*",
            },
            set(create["Resource"]),
        )
        self.assertEqual(
            {"aws:RequestedRegion": "us-east-1"},
            managed_statements["ListRuntimeVersions"]["Condition"]["StringEquals"],
        )
        self.assertEqual("*", managed_statements["ListRuntimeVersions"]["Resource"])
        self.assertEqual(
            ["arn:aws:s3:::cdk-evaltalk-assets-027224425948-us-east-1/agent-reference/*"],
            [managed_statements["ReadAgentReference"]["Resource"]]
            if isinstance(managed_statements["ReadAgentReference"]["Resource"], str)
            else managed_statements["ReadAgentReference"]["Resource"],
        )
        self.assertEqual(
            {"AGENT_PUBLICATION#faulty"},
            set(managed_statements["PublishFaultyRecord"]["Condition"]["ForAllValues:StringEquals"]["dynamodb:LeadingKeys"]),
        )
        ddb_decrypt = managed_statements["DecryptFaultyControllerRecord"]
        self.assertEqual("kms:Decrypt", ddb_decrypt["Action"])
        self.assertEqual(
            "arn:aws:kms:us-east-1:027224425948:key/2a020640-e95b-4bec-8ae7-3f6d9fcb8e0d",
            ddb_decrypt["Resource"],
        )
        self.assertEqual(
            {
                "kms:ViaService": "dynamodb.us-east-1.amazonaws.com",
                "kms:EncryptionContext:aws:dynamodb:tableName": "IncidentTriageDemoControllerRun",
                "kms:EncryptionContext:aws:dynamodb:subscriberId": "027224425948",
            },
            ddb_decrypt["Condition"]["StringEquals"],
        )

        guard_size = len(json.dumps(guard["Properties"]["PolicyDocument"], separators=(",", ":")))
        managed_size = len(json.dumps(properties["PolicyDocument"], separators=(",", ":")))
        # The live, pre-existing `default` inline policy is 1,685 characters;
        # this baseline is recorded with the Phase 19 before-state evidence.
        self.assertLessEqual(guard_size + 1685, 10240, f"inline aggregate uses {guard_size + 1685}/10240 characters")
        self.assertLessEqual(managed_size, 6144, f"Phase 19 managed policy uses {managed_size}/6144 characters")

    def test_adapter_encrypt_requires_exact_lambda_key_function_context_and_service(self):
        template = yaml.safe_load((Path(__file__).parents[1] / "infrastructure/bootstrap/github-iam.yaml").read_text())
        statements = template["Resources"]["DedicatedCdkDeployRolePhase0Guard"]["Properties"]["PolicyDocument"]["Statement"]
        indexed = {statement["Sid"]: statement for statement in statements}
        actions = indexed["DenyNonAppDeploymentActions"]["NotAction"]
        self.assertEqual({"kms:Decrypt", "kms:Encrypt", "kms:DescribeKey"}, {action for action in actions if action.startswith("kms:")})
        key = "arn:aws:kms:us-east-1:027224425948:key/9d894f12-dc33-4332-bb3e-df489928914b"
        adapter = "arn:aws:lambda:us-east-1:027224425948:function:IncidentTriageDemoAlarmAdapter"
        context_key = "kms:EncryptionContext:aws:lambda:FunctionArn"
        self.assertEqual({"StringNotEquals": {context_key: adapter}}, indexed["DenyEncryptOutsideAdapterEnvironment"]["Condition"])
        self.assertEqual(key, indexed["DenyEncryptOrDescribeOtherKeys"]["NotResource"])
        self.assertEqual({"StringNotEquals": {"kms:ViaService": "lambda.us-east-1.amazonaws.com"}}, indexed["DenyEncryptOrDescribeOutsideLambda"]["Condition"])

        def explicitly_denied(resource, context):
            # Evaluate only the explicit Denies relevant to this one action.
            for statement in statements:
                if statement["Effect"] != "Deny": continue
                action_key = "NotAction" if "NotAction" in statement else "Action"
                values = statement[action_key]
                values = values if isinstance(values, list) else [values]
                matches = any(fnmatchcase("kms:Encrypt", value) for value in values)
                if matches == (action_key == "NotAction"): continue
                resource_key = "NotResource" if "NotResource" in statement else "Resource"
                values = statement[resource_key]
                values = values if isinstance(values, list) else [values]
                matches = any(fnmatchcase(resource, value) for value in values)
                if matches == (resource_key == "NotResource"): continue
                condition = statement.get("Condition", {})
                if condition:
                    self.assertEqual({"StringNotEquals"}, set(condition))
                    if not all(context.get(name) != value for name, value in condition["StringNotEquals"].items()): continue
                return True
            return False

        allowed = {context_key: adapter, "kms:ViaService": "lambda.us-east-1.amazonaws.com"}
        self.assertFalse(explicitly_denied(key, allowed))
        for resource, context in [
            (key.replace("9d894f12-dc33-4332-bb3e-df489928914b", "b292b95c-709f-42c6-aa42-b934ba2c6f07"), allowed),
            (key.replace("027224425948", "123456789012"), allowed),
            (key, {**allowed, context_key: adapter.replace("AlarmAdapter", "Inventory")}),
            (key, {**allowed, context_key: adapter.replace("AlarmAdapter", "ControllerHttp")}),
            (key, {**allowed, context_key: adapter + ":live"}),
            (key, {"kms:ViaService": allowed["kms:ViaService"]}),
            (key, {context_key: adapter}),
            (key, {**allowed, "kms:ViaService": "s3.us-east-1.amazonaws.com"}),
            (key, {**allowed, "kms:ViaService": "lambda.us-west-2.amazonaws.com"}),
        ]:
            with self.subTest(resource=resource, context=context):
                self.assertTrue(explicitly_denied(resource, context))

    def test_runtime_creation_dependencies_use_unnamed_arns_without_widening_ongoing_actions(self):
        statements = self.agent_policy()["Statement"]
        creation = next(s for s in statements if s["Sid"] == "CreateRuntimeDependencies")
        self.assertEqual({"bedrock-agentcore:CreateAgentRuntimeEndpoint", "bedrock-agentcore:CreateWorkloadIdentity"}, set(creation["Action"]))
        self.assertIn("arn:aws:bedrock-agentcore:us-east-1:027224425948:runtime/*", creation["Resource"])
        self.assertIn("arn:aws:bedrock-agentcore:us-east-1:027224425948:workload-identity-directory/default/workload-identity/*", creation["Resource"])
        self.assertEqual({"aws:RequestedRegion": "us-east-1", "aws:RequestTag/Project": "IncidentTriageDemo", "aws:RequestTag/Component": "agent"}, creation["Condition"]["StringEquals"])
        tags = next(s for s in statements if s["Sid"] == "TagRuntimeDuringCreation")
        self.assertEqual("bedrock-agentcore:TagResource", tags["Action"])
        self.assertEqual([
            "arn:aws:bedrock-agentcore:us-east-1:027224425948:runtime/*",
            "arn:aws:bedrock-agentcore:us-east-1:027224425948:workload-identity-directory/default/workload-identity/IncidentTriageDemoAgent-*",
            "arn:aws:bedrock-agentcore:us-east-1:027224425948:workload-identity-directory/default",
        ], tags["Resource"])
        self.assertEqual(creation["Condition"], tags["Condition"])
        outer_create = next(s for s in statements if s["Sid"] == "CreateTaggedAgent")
        self.assertEqual(creation["Condition"], outer_create["Condition"])
        for statement in statements:
            if statement is creation or statement is tags: continue
            actions = statement["Action"] if isinstance(statement["Action"], list) else [statement["Action"]]
            if any(action.startswith("bedrock-agentcore:") and not action.startswith("bedrock-agentcore:Create") for action in actions):
                resources = statement["Resource"] if isinstance(statement["Resource"], list) else [statement["Resource"]]
                self.assertNotIn("*", resources)
                self.assertNotIn("arn:aws:bedrock-agentcore:us-east-1:027224425948:runtime/*", resources)
                self.assertNotIn("arn:aws:bedrock-agentcore:us-east-1:027224425948:workload-identity-directory/default/workload-identity/*", resources)

    def test_workload_identity_tag_scope_excludes_other_names_accounts_regions_and_untag(self):
        statements = self.agent_policy()["Statement"]
        def resource_matches(action, resource):
            # Check the union of resource grants, even before their conditions.
            for statement in statements:
                actions = statement["Action"] if isinstance(statement["Action"], list) else [statement["Action"]]
                resources = statement["Resource"] if isinstance(statement["Resource"], list) else [statement["Resource"]]
                if statement["Effect"] == "Allow" and any(fnmatchcase(action, pattern) for pattern in actions):
                    if any(fnmatchcase(resource, pattern) for pattern in resources): return True
            return False

        identity = "arn:aws:bedrock-agentcore:us-east-1:027224425948:workload-identity-directory/default/workload-identity/IncidentTriageDemoAgent-JRWneh9GXf"
        self.assertTrue(resource_matches("bedrock-agentcore:TagResource", identity))
        parent = identity.rsplit("/workload-identity/", 1)[0]
        self.assertTrue(resource_matches("bedrock-agentcore:TagResource", parent))
        for resource in [
            identity.replace("IncidentTriageDemoAgent-JRWneh9GXf", "OtherAgent-JRWneh9GXf"),
            identity.replace("IncidentTriageDemoAgent-", "IncidentTriageDemoAgentOther-"),
            identity.replace("IncidentTriageDemoAgent-JRWneh9GXf", "IncidentTriageDemoAgent"),
            identity.replace("027224425948", "123456789012"),
            identity.replace("us-east-1", "us-west-2"),
            identity.replace("directory/default/", "directory/other/"),
            parent.replace("/default", "/other"),
        ]:
            with self.subTest(resource=resource):
                self.assertFalse(resource_matches("bedrock-agentcore:TagResource", resource))
        self.assertFalse(resource_matches("bedrock-agentcore:UntagResource", identity))
        self.assertFalse(resource_matches("bedrock-agentcore:UntagResource", parent))

    def test_agent_execution_policy_fits_managed_policy_quota(self):
        size = len(json.dumps(self.agent_policy(), separators=(",", ":")))
        self.assertLessEqual(size, 6144, f"Agent managed policy uses {size}/6144 characters")

    def test_bootstrap_templates_do_not_use_cloudformation_forbidden_yaml_aliases(self):
        for name in ["github-iam.yaml", "phase0-cfn-execution-policy.yaml"]:
            path = Path(__file__).parents[1] / "infrastructure/bootstrap" / name
            with self.subTest(template=name):
                aliases = [token for token in yaml.scan(path.read_text()) if isinstance(token, (yaml.tokens.AnchorToken, yaml.tokens.AliasToken))]
                self.assertEqual([], aliases, "CloudFormation rejects YAML aliases even when a YAML linter accepts them")

if __name__ == "__main__": unittest.main()
