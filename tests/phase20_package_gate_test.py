"""S5 machine policy, source of human approval, and native ZIP execution.

Constructed, offline data exercises policy. The real three-case release and
private source-backed human review run through Actions during delivery.
"""

import copy
import hashlib
import importlib
import json
from pathlib import Path
import platform
import sys
import unittest
from unittest.mock import patch
import zipfile

import boto3

import phase18_strands_experiment_test as s4
from reviewed_cases import load_frozen_case


def gate():
    return importlib.import_module("release_gate")


class ReleasePolicy(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = s4.Phase18StrandsExperimentAcceptance("runTest")
        cls.fixture.setUp()
        cls.addClassCleanup(cls.fixture.tearDown)
        # Native Strands rows, selected AgentCore result and deterministic
        # findings come from the real saved-run path. Only AWS is substituted.
        exp, _, _ = cls.fixture.run_experiment(candidate="repaired", label="fail",
                                               explanation="Constructed advisory disagreement.")
        cls.record = cls.fixture._read_record(exp)
        cls.roster = []
        for entry in json.loads(cls.fixture.suite.read_bytes())["cases"]:
            folder = cls.fixture.suite.parent
            case = load_frozen_case(folder / entry["case"], folder / entry["bundle"])
            cls.roster.append((case["case"]["caseId"], case["caseSha256"], case["bundleSha256"]))

    def verdict(self, rows):
        return gate().machine_decision(expected_cases=self.roster, rows=rows)["verdict"]

    def test_real_complete_advisory_fail_with_deterministic_pass_requires_review(self):
        self.assertEqual("review_required", self.record["decision"]["verdict"])
        self.assertEqual("review_required", self.verdict(self.record["cases"]))

    def test_missing_extra_duplicate_and_substituted_results_are_incomplete(self):
        rows = self.record["cases"]
        wrong = copy.deepcopy(rows)
        wrong[0]["bundleSha256"] = "0" * 64
        for name, variation in (("empty", []), ("missing", rows[1:]),
                                ("extra", [*rows, rows[0]]), ("duplicate", [rows[0], rows[0]]),
                                ("changed capture", wrong)):
            with self.subTest(name=name):
                self.assertEqual("incomplete", self.verdict(variation))

    def test_missing_finding_or_advisory_reason_or_evaluator_error_blocks_review(self):
        for problem in ("missing finding", "empty reason", "score error"):
            with self.subTest(problem=problem):
                rows = copy.deepcopy(self.record["cases"])
                if problem == "missing finding":
                    del rows[0]["deterministic"]["findings"]["target_value"]
                elif problem == "empty reason":
                    rows[0]["score"]["semantic"]["findings"]["semantic_quality"]["explanation"] = " "
                else:
                    rows[0]["score"]["status"] = "error"
                self.assertEqual("incomplete", self.verdict(rows))

    def test_observed_wrong_action_rejects_even_if_other_results_are_pending(self):
        experiment, _, _ = self.fixture.run_experiment(candidate="faulty", label="pass")
        rows = self.fixture._read_record(experiment)["cases"]
        self.assertEqual("fail", rows[0]["deterministic"]["findings"]["action"]["verdict"])
        rows[0]["score"] = None
        rows[-1]["status"] = "pending"
        self.assertEqual("reject", self.verdict(rows))


class EnvironmentReview(unittest.TestCase):
    # GitHub supplies run ID via the requested review-history URL. A history
    # entry identifies user, environment, state and comment, not attempt ID.
    run_id = 101
    reviewer_id = 111
    environment_id = 222
    digest = hashlib.sha256(b"private frozen review manifest").hexdigest()

    def record(self):
        return {
            "state": "approved", "comment": f"approve {self.digest}",
            "user": {"id": self.reviewer_id, "login": "presenter"},
            "environments": [{"id": self.environment_id, "name": "repaired-publication"}],
        }

    def approved(self, history):
        queried = []

        def read_history(run_id):
            queried.append(run_id)
            return history.get(run_id, [])

        result = gate().has_matching_approval(
            read_history=read_history, run_id=self.run_id, environment_id=self.environment_id,
            reviewer_id=self.reviewer_id, manifest_sha256=self.digest,
        )
        self.assertEqual([self.run_id], queried)
        return result

    def test_current_run_reviewer_environment_and_exact_manifest_approve(self):
        self.assertIs(self.approved({self.run_id: [self.record()]}), True)

    def test_unrelated_pending_rejected_and_stale_reviews_cannot_approve(self):
        good = self.record()
        cases = {
            "pending": {},
            "other run": {102: [good]},
            "other user": {101: [{**good, "user": {"id": 333, "login": "other"}}]},
            "other environment": {101: [{**good, "environments": [{"id": 333, "name": "test"}]}]},
            "rejected": {101: [{**good, "state": "rejected"}]},
            "old manifest in same run": {101: [{**good, "comment": "approve " + "e" * 64}]},
        }
        for scenario, history in cases.items():
            with self.subTest(scenario=scenario):
                self.assertIs(self.approved(history), False)


@unittest.skipUnless(sys.platform == "linux" and platform.machine() in {"aarch64", "arm64"},
                     "the checked Runtime ZIP contains Linux ARM64 wheels")
class NativePackageExperiment(unittest.TestCase):
    def test_captured_task_runs_the_checked_prompt_and_runtime_libraries(self):
        fixture = s4.Phase18StrandsExperimentAcceptance("runTest")
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        runtime_zip = Path(__file__).resolve().parents[1] / ".artifacts/agent/runtime.zip"
        with zipfile.ZipFile(runtime_zip) as package:
            manifest = json.loads(package.read("agent-manifest.json"))
        session, clients = fixture._clients("repaired")
        aws = s4.FakeAWS(fixture.runs)
        # Phase 18's editable candidate adds this marker; the checked ZIP
        # carries its own actual prompt. Share the ordinary captured providers.
        import captured_execution
        with patch.object(captured_execution, "AGENT_DIRECTORY", fixture.source_workspaces["repaired"]), \
             patch.object(boto3, "Session", side_effect=aws.session_factory):
            result = fixture.product().run_package_experiment(
                runtime_zip=runtime_zip, suite_path=fixture.suite, evaluator_path=fixture.evaluator,
                output_root=fixture.runs, model_session=session, wait_seconds=0,
            )
        record = fixture._read_record(result)
        self.assertEqual("complete", record["status"])
        for client, row in zip(clients, record["cases"], strict=True):
            self.assertTrue(client.requests)
            system = client.requests[0]["system"]
            self.assertEqual(manifest["promptSha256"], hashlib.sha256(system[0]["text"].encode()).hexdigest())
            self.assertNotIn("PHASE18_REPAIRED_SOURCE_MARKER", json.dumps(system))
            execution = Path(result) / "executions" / row["executionId"] / "execution.json"
            self.assertEqual(manifest["promptSha256"], json.loads(execution.read_bytes())["identity"]["promptSha256"])
        # Exact core/dependency origins and runtime-versus-driver isolation
        # are read back for the native run during the Phase 20 release proof.
