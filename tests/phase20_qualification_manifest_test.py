"""Offline tamper checks for the private Phase 20 qualification bundle."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
import zipfile
from unittest.mock import patch

from botocore.exceptions import ClientError


ROOT = Path(__file__).resolve().parents[1]
TESTS = ROOT / "tests"
AGENT = ROOT / "agent"
if str(TESTS) not in sys.path:
    sys.path.insert(0, str(TESTS))
if str(AGENT) not in sys.path:
    sys.path.insert(0, str(AGENT))

from phase14_reviewed_cases_test import make_case, write_bundle  # noqa: E402
from reviewed_cases import freeze_case  # noqa: E402


def load_qualifier():
    spec = importlib.util.spec_from_file_location("phase20_qualify_manifest", ROOT / "scripts/qualify-repaired.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class QualificationManifestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.qualify = load_qualifier()
        bundle = self.root / "capture.json"
        origin = write_bundle(bundle)
        case = make_case(bundle, origin["runId"])
        case["caseId"] = "phase20.synthetic.case"
        draft = self.root / "case.json"
        draft.write_text(json.dumps(case), encoding="utf-8")
        frozen = self.root / "case.frozen.json"
        freeze_case(draft, bundle, frozen)
        self.suite = self.root / "suite.json"
        self.suite.write_text(json.dumps({"schemaVersion": 1, "cases": [{"case": frozen.name, "bundle": bundle.name}]}), encoding="utf-8")
        self.evaluator = self.root / "evaluator.json"
        self.evaluator.write_text(json.dumps({
            "evaluatorId": "synthetic-evaluator",
            "evaluatorArn": "arn:aws:bedrock-agentcore:us-east-1:1:evaluator/synthetic",
            "judgeModelId": "us.anthropic.claude-sonnet-4-6",
            "evaluatorMode": "single",
            "configSha256": "a" * 64,
        }), encoding="utf-8")
        self.runtime_zip = self.root / "runtime.zip"
        with zipfile.ZipFile(self.runtime_zip, "w") as archive:
            archive.writestr("agent-manifest.json", json.dumps({
                "schemaVersion": 2,
                "sourceRevision": "a" * 40,
                "promptSha256": "b" * 64,
            }))
        roster, _descriptor, _suite_sha = self.qualify._load_roster(self.suite)
        self.row = {
            "caseId": roster[0][0],
            "caseSha256": roster[0][1],
            "bundleSha256": roster[0][2],
            "executionId": "execution-1",
            "sessionId": "session-1",
            "traceId": "trace-1",
            "status": "complete",
            "scoringAttemptId": "score-1",
            "report": {"assessment": "ongoing", "evidence": [{"resource": "inventory", "observedAt": "2026-11-13T10:02:30Z"}]},
            "deterministic": {"findings": {
                name: {"status": "complete", "verdict": "pass", "reason": "synthetic pass"}
                for name in self.qualify.FINDINGS
            }},
            "score": {
                "status": "complete",
                "executionId": "execution-1",
                "scoringAttemptId": "score-1",
                "semantic": {"findings": {"semantic_quality": {
                    "status": "complete", "verdict": "pass", "explanation": "synthetic advisory reason"
                }}},
            },
        }
        self.package_sha = hashlib.sha256(self.runtime_zip.read_bytes()).hexdigest()
        snapshot = {
            "sourceSha256": "1" * 64,
            "dependencySha256": "2" * 64,
            "toolingSha256": "3" * 64,
            "toolingDependencySha256": "4" * 64,
            "sourceFiles": {}, "dependencyFiles": {}, "toolingFiles": {},
        }
        self.record = {
            "schemaVersion": 1,
            "experimentId": "synthetic-experiment",
            "status": "complete",
            "candidateId": "repaired",
            "modelId": "us.anthropic.claude-sonnet-4-6",
            "sourceOrigin": {"kind": "runtime_zip", "zipSha256": self.package_sha},
            "runtimeOrigin": {
                "kind": "runtime_zip", "zipSha256": self.package_sha,
                "manifestSha256": "5" * 64, "runtimeSourceSha256": "6" * 64,
                "dependencySha256": "2" * 64, "driver": {"toolingSha256": "3" * 64},
            },
            "runtime": {"sourceSha256": "1" * 64, "dependencySha256": "2" * 64},
            "tooling": {"sourceSha256": "3" * 64, "dependencySha256": "4" * 64},
            "snapshot": snapshot,
            "cases": [copy.deepcopy(self.row)],
        }
        self.shown = {**copy.deepcopy(self.record), "cases": [copy.deepcopy(self.row)], "decision": {"verdict": "review_required"}}
        self.configuration = {
            "agentRuntimeArtifact": {"codeConfiguration": {"runtime": "PYTHON_3_13", "entryPoint": ["opentelemetry-instrument", "main.py"], "code": {"s3": {"bucket": "b", "prefix": "k", "versionId": "v"}}}},
            "environmentVariables": {
                "AGENT_CANDIDATE_ID": "repaired", "AGENT_ENDPOINT_NAME": "repaired",
                "AGENT_SOURCE_REVISION": "a" * 40, "AGENT_MODEL_ID": "us.anthropic.claude-sonnet-4-6",
                "AGENT_ALARM_ARN": "arn:alarm", "AGENT_ARTIFACT_SHA256": self.package_sha,
            },
        }

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _build(self, *, rejected: bool = False):
        record = copy.deepcopy(self.record)
        shown = copy.deepcopy(self.shown)
        if rejected:
            record["cases"][0]["deterministic"]["findings"]["action"]["verdict"] = "fail"
            shown["cases"][0]["deterministic"]["findings"]["action"]["verdict"] = "fail"
            shown["decision"] = {"verdict": "reject", "reason": "deterministic check failed: action"}

        def run_package_experiment(**kwargs):
            directory = Path(kwargs["output_root"]) / "synthetic-experiment"
            directory.mkdir(parents=True, exist_ok=True)
            (directory / "experiment.json").write_text(json.dumps(record), encoding="utf-8")
            return directory

        def show_experiment(_directory):
            return shown

        development = types.SimpleNamespace(run_package_experiment=run_package_experiment, show_experiment=show_experiment)
        with patch.dict(sys.modules, {"development_experiment": development}):
            return self.qualify.build_qualification(
                runtime_zip=self.runtime_zip,
                suite_path=self.suite,
                evaluator_path=self.evaluator,
                output_root=self.root / "qualification",
                runtime_configuration=self.configuration,
                alarm_arn="arn:alarm",
            )

    def test_complete_manifest_rejects_each_changed_persisted_input(self):
        receipt_path, receipt = self._build()
        review = self.root / "qualification" / "review"
        self.assertEqual("eligible", receipt["status"])
        self.assertEqual(receipt["reviewManifestSha256"], self.qualify.verify_private_review(review)["manifestSha256"])
        candidates = [
            review / "cases" / "phase20.synthetic.case" / "index.json",
            review / "native" / "show-experiment.json",
            review / "native" / "attestation.json",
            review / "native" / "policy.json",
            review / "inputs" / "runtime-configuration.json",
            review / "inputs" / "evaluator.json",
            review / "inputs" / "suite.json",
            review / "inputs" / "bundles" / f"{self.row['bundleSha256']}.json",
            review / "experiment" / "experiment.json",
            review / "inputs" / "runtime.zip",
        ]
        for path in candidates:
            with self.subTest(path=path.relative_to(review)):
                original = path.read_bytes()
                path.write_bytes(original + b"tampered")
                with self.assertRaises(ValueError):
                    self.qualify.verify_private_review(review, manifest_sha256=receipt["reviewManifestSha256"])
                path.write_bytes(original)

    def test_known_reject_keeps_native_record_and_private_evidence(self):
        receipt_path, receipt = self._build(rejected=True)
        self.assertEqual("rejected", receipt["status"])
        self.assertEqual("reject", receipt["verdict"])
        review = self.root / "qualification" / "review"
        self.assertTrue((review / "native" / "show-experiment.json").is_file())
        self.qualify.verify_private_review(review, manifest_sha256=receipt["reviewManifestSha256"])

    def test_show_output_and_workspace_only_source_cannot_bypass_package_attestation(self):
        original_show = copy.deepcopy(self.shown)
        self.shown["cases"][0]["traceId"] = "foreign-trace"
        with self.assertRaises(ValueError):
            self._build()
        self.shown = original_show
        self.record["sourceOrigin"] = {"kind": "workspace", "directory": "/checkout/agent"}
        with self.assertRaises(ValueError):
            self._build()

    def test_read_only_clearance_is_private_and_safe(self):
        receipt_path, receipt = self._build()
        clearance_path = self.root / "clearance.json"
        clearance = self.qualify.verify_private_clearance(
            review_root=self.root / "qualification" / "review",
            qualification_path=receipt_path,
            current_head="a" * 40,
            clearance_output=clearance_path,
        )
        self.assertEqual("cleared", clearance["status"])
        self.assertEqual(receipt["reviewManifestSha256"], clearance["manifestSha256"])
        self.assertEqual(0o600, clearance_path.stat().st_mode & 0o777)

    def test_full_qualification_and_protected_verify_cli(self):
        config_path = self.root / "runtime-config.json"
        config_path.write_text(json.dumps(self.configuration), encoding="utf-8")
        artifact_spec_path = self.root / "artifact-spec.json"
        artifact_spec_path.write_text(json.dumps({
            "bucket": "private-evidence", "key": "agent-evaluation/phase20/runtime.zip",
            "sha256": self.package_sha,
        }), encoding="utf-8")
        source_spec_path = self.root / "source-spec.json"
        source_spec_path.write_text(json.dumps({
            "bucket": "private-evidence", "key": "agent-evaluation/phase20/prompt.py",
            "sha256": "b" * 64,
        }), encoding="utf-8")
        configuration_spec_path = self.root / "configuration-spec.json"
        configuration_spec_path.write_text(json.dumps({
            "bucket": "private-evidence", "key": "agent-evaluation/phase20/runtime-configuration.json",
            "sha256": self.qualify.sha256_json(self.configuration),
        }), encoding="utf-8")
        development = types.SimpleNamespace()
        record = copy.deepcopy(self.record)
        shown = copy.deepcopy(self.shown)

        def run_package_experiment(**kwargs):
            directory = Path(kwargs["output_root"]) / "synthetic-experiment"
            directory.mkdir(parents=True)
            (directory / "experiment.json").write_text(json.dumps(record), encoding="utf-8")
            return directory

        development.run_package_experiment = run_package_experiment
        development.show_experiment = lambda _directory: shown
        with patch.dict(sys.modules, {"development_experiment": development}):
            self.assertEqual(0, self.qualify.main([
                "--runtime-zip", str(self.runtime_zip), "--suite", str(self.suite),
                "--evaluator", str(self.evaluator), "--output-root", str(self.root / "cli"),
                "--runtime-configuration", str(config_path), "--alarm-arn", "arn:alarm",
                "--artifact-spec", str(artifact_spec_path), "--source-spec", str(source_spec_path),
                "--configuration-spec", str(configuration_spec_path),
            ]))
        receipt_path = self.root / "cli" / "repaired-qualification.json"
        receipt = json.loads(receipt_path.read_text())
        summary = json.loads((self.root / "cli" / "qualification-summary.json").read_text())
        self.assertNotIn("runtimeConfiguration", summary)
        self.assertNotIn("cases", summary)
        self.assertEqual("private-evidence", receipt["artifact"]["bucket"])
        self.assertEqual("agent-evaluation/phase20/runtime.zip", receipt["artifact"]["key"])
        self.assertEqual("private-evidence", receipt["source"]["bucket"])
        self.assertEqual("private-evidence", receipt["configuration"]["bucket"])
        self.assertEqual(receipt["reviewManifestSha256"], summary["reviewManifestSha256"])
        clearance_path = self.root / "cli-clearance.json"
        self.assertEqual(0, self.qualify.main([
            "verify-private", "--review-root", str(self.root / "cli" / "review"),
            "--qualification", str(receipt_path), "--current-head", "a" * 40,
            "--expected-manifest", receipt["reviewManifestSha256"],
            "--clearance-output", str(clearance_path),
        ]))
        self.assertEqual("cleared", json.loads(clearance_path.read_text())["status"])

    def test_private_upload_is_unversioned_conditional_and_rehashes_existing_bytes(self):
        review = self.root / "upload"
        review.mkdir()
        (review / "index.html").write_text("review", encoding="utf-8")

        class Body:
            def __init__(self, value):
                self.value = value

            def read(self):
                return self.value

        class S3:
            def __init__(self):
                self.objects = {}
                self.puts = []

            def head_object(self, **request):
                if (request["Bucket"], request["Key"]) not in self.objects:
                    raise ClientError({"Error": {"Code": "404"}}, "HeadObject")
                return {"Metadata": {"sha256": hashlib.sha256(self.objects[(request["Bucket"], request["Key"])]).hexdigest()}}

            def get_object(self, **request):
                return {"Body": Body(self.objects[(request["Bucket"], request["Key"])])}

            def put_object(self, **request):
                self.puts.append(request)
                self.objects[(request["Bucket"], request["Key"])] = request["Body"]
                return {}

        fake_s3 = S3()
        fake_boto3 = types.SimpleNamespace(Session=lambda **_kwargs: types.SimpleNamespace(client=lambda _name: fake_s3))
        with patch.dict(sys.modules, {"boto3": fake_boto3}):
            self.qualify._upload_private_bundle(review, bucket="bucket", prefix="agent-evaluation/phase20/x", region="us-east-1")
            self.qualify._upload_private_bundle(review, bucket="bucket", prefix="agent-evaluation/phase20/x", region="us-east-1")
        self.assertEqual(1, len(fake_s3.puts))
        self.assertEqual("*", fake_s3.puts[0]["IfNoneMatch"])
        self.assertNotIn("VersionId", fake_s3.puts[0])
        fake_s3.objects[("bucket", "agent-evaluation/phase20/x/index.html")] = b"tampered"
        with patch.dict(sys.modules, {"boto3": fake_boto3}):
            with self.assertRaises(RuntimeError):
                self.qualify._upload_private_bundle(review, bucket="bucket", prefix="agent-evaluation/phase20/x", region="us-east-1")


if __name__ == "__main__":
    unittest.main()
