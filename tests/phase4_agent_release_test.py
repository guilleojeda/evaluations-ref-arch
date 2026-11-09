"""Deployment-only regression checks; no AWS request or inference is made."""
from __future__ import annotations
import base64
import copy
from fnmatch import fnmatchcase
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
import yaml
spec = importlib.util.spec_from_file_location("finalize_agent", Path(__file__).parents[1] / "scripts/finalize-agent.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

class Native:
    def __init__(self):
        self.updates = []
        self.pin_updates = []
        self.runtime = {"agentRuntimeId": "IncidentTriageDemoAgent-abcdefghij", "agentRuntimeArn": "arn:aws:bedrock-agentcore:us-east-1:027224425948:runtime/IncidentTriageDemoAgent-abcdefghij", "agentRuntimeVersion": "1", "status": "READY", "roleArn": "arn:aws:iam::027224425948:role/IncidentTriageDemoAgentRuntimeRole", "agentRuntimeArtifact": {"codeConfiguration": {"runtime": "PYTHON_3_13", "entryPoint": ["opentelemetry-instrument", "main.py"], "code": {"s3": {"bucket": "assets", "prefix": "checked.zip"}}}}, "environmentVariables": {"SOURCE": "checked"}, "networkConfiguration": {"networkMode": "PUBLIC"}, "protocolConfiguration": {"serverProtocol": "HTTP"}, "lifecycleConfiguration": {"idleRuntimeSessionTimeout": 300, "maxLifetime": 600}, "metadataConfiguration": {"requireMMDSV2": False}}
        keys = set(self.runtime) - {"status", "agentRuntimeArn", "agentRuntimeVersion"}
        self.meta = SimpleNamespace(service_model=SimpleNamespace(operation_model=lambda _: SimpleNamespace(input_shape=SimpleNamespace(members=keys))))
        self.endpoint = {"status": "READY", "liveVersion": "1", "targetVersion": "1", "agentRuntimeArn": self.runtime["agentRuntimeArn"], "agentRuntimeEndpointArn": self.runtime["agentRuntimeArn"] + "/runtime-endpoint/faulty"}
    def get_agent_runtime(self, **kwargs): return copy.deepcopy(self.runtime)
    def update_agent_runtime(self, **kwargs):
        self.updates.append(kwargs)
        self.runtime.update(metadataConfiguration=kwargs["metadataConfiguration"], agentRuntimeVersion="2")
        return {"agentRuntimeVersion": "2"}
    def get_agent_runtime_endpoint(self, **kwargs): return copy.deepcopy(self.endpoint)
    def update_agent_runtime_endpoint(self, **kwargs):
        self.pin_updates.append(kwargs)
        self.endpoint.update(liveVersion=kwargs["agentRuntimeVersion"], targetVersion=kwargs["agentRuntimeVersion"])

class Adapter:
    def __init__(self, native):
        self.updates = []
        self.config = {"LastUpdateStatus": "Successful", "FunctionArn": "adapter", "RevisionId": "revision-1", "CodeSha256": base64.b64encode(bytes.fromhex("b" * 64)).decode(), "TracingConfig": {"Mode": "Active"}, "Environment": {"Variables": {"AGENT_RUNTIME_ARN": native.runtime["agentRuntimeArn"], "AGENT_ENDPOINT_NAME": "faulty", "AGENT_RUNTIME_VERSION": "unverified", "AGENT_ALARM_ARN": "arn:aws:cloudwatch:us-east-1:027224425948:alarm:IncidentTriageDemoAppStage5xx", "AGENT_SOURCE_REVISION": "c" * 40, "AGENT_ARTIFACT_SHA256": "a" * 64}}}
    def get_function_configuration(self, **kwargs): return copy.deepcopy(self.config)
    def update_function_configuration(self, **kwargs):
        self.updates.append(kwargs)
        self.config["Environment"] = kwargs["Environment"]
        return copy.deepcopy(self.config)

class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.native = Native()
        self.adapter = Adapter(self.native)
        self.xray = SimpleNamespace(get_trace_segment_destination=lambda: {"Destination": "CloudWatchLogs", "Status": "ACTIVE"})
    def finalize(self):
        return release.finalize(self.native, self.adapter, self.xray, runtime_id="IncidentTriageDemoAgent-abcdefghij", revision="c" * 40, artifact_sha256="a" * 64, adapter_sha256="b" * 64, bucket="assets", key="checked.zip", api_id="api", expected_environment={"SOURCE": "checked"})
    def test_mmdsv2_preserves_checked_configuration_and_attests_final_native_version(self):
        result = self.finalize()
        self.assertEqual("2", result["runtimeVersion"])
        self.assertEqual("2", self.native.endpoint["liveVersion"])
        self.assertEqual("2", self.adapter.config["Environment"]["Variables"]["AGENT_RUNTIME_VERSION"])
        update = self.native.updates[0]
        self.assertEqual(self.native.runtime["agentRuntimeArtifact"], update["agentRuntimeArtifact"])
        self.assertEqual(self.native.runtime["roleArn"], update["roleArn"])
        self.assertEqual("revision-1", self.adapter.updates[0]["RevisionId"])
    def test_same_revision_recovery_finishes_attestation_without_creating_another_version(self):
        self.finalize()
        self.adapter.config["Environment"]["Variables"]["AGENT_RUNTIME_VERSION"] = "unverified"
        self.finalize()
        self.assertEqual(1, len(self.native.updates))
        self.assertEqual(1, len(self.native.pin_updates))
        self.assertEqual(2, len(self.adapter.updates))
    def test_rejects_unchecked_runtime_or_adapter_bytes_before_attesting(self):
        for kind in ["runtime", "adapter"]:
            with self.subTest(kind=kind):
                self.setUp()
                if kind == "runtime": self.native.runtime["environmentVariables"]["SOURCE"] = "different"
                else: self.adapter.config["CodeSha256"] = "other"
                with self.assertRaises(RuntimeError): self.finalize()
                self.assertEqual([], self.adapter.updates)
    def test_missing_transaction_search_never_attests_a_ready_adapter(self):
        self.xray.get_trace_segment_destination = lambda: {"Destination": "XRay"}
        with self.assertRaisesRegex(RuntimeError, "Transaction Search"): self.finalize()
        self.assertEqual([], self.adapter.updates)

class ReleaseTemplateTests(unittest.TestCase):
    @staticmethod
    def agent_policy():
        class Loader(yaml.SafeLoader): pass
        Loader.add_multi_constructor("!", lambda loader, tag, node: {tag: loader.construct_scalar(node)})
        template = yaml.load((Path(__file__).parents[1] / "infrastructure/bootstrap/phase0-cfn-execution-policy.yaml").read_text(), Loader=Loader)
        return template["Resources"]["IncidentTriageDemoAgentCfnExecution"]["Properties"]["PolicyDocument"]

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
        for resource in [
            identity.replace("IncidentTriageDemoAgent-JRWneh9GXf", "OtherAgent-JRWneh9GXf"),
            identity.replace("IncidentTriageDemoAgent-", "IncidentTriageDemoAgentOther-"),
            identity.replace("IncidentTriageDemoAgent-JRWneh9GXf", "IncidentTriageDemoAgent"),
            identity.replace("027224425948", "123456789012"),
            identity.replace("us-east-1", "us-west-2"),
            identity.replace("directory/default/", "directory/other/"),
            identity.rsplit("/workload-identity/", 1)[0],
        ]:
            with self.subTest(resource=resource):
                self.assertFalse(resource_matches("bedrock-agentcore:TagResource", resource))
        self.assertFalse(resource_matches("bedrock-agentcore:UntagResource", identity))

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
