"""Acceptance for the S1 -> S3 -> S4 stage handoff boundary.

The scenario uses the public reviewed-case commands to create the S1 input,
then composes the existing captured executor and native Strands experiment
entry points from two disposable source workspaces.  Bedrock and Evaluate are
controlled transports; the case, candidate source snapshot, native task, and
experiment snapshot are produced by the real implementations.
"""

from __future__ import annotations

import copy
from contextlib import redirect_stdout
import hashlib
import importlib
import json
import multiprocessing
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from io import StringIO
import unittest
from unittest.mock import patch

import boto3

TESTS = Path(__file__).resolve().parent
if str(TESTS) not in sys.path:
    sys.path.insert(0, str(TESTS))

from phase14_reviewed_cases_test import make_case, write_bundle
from phase16_baseline_test import MODEL_ID, ScriptedBedrock
from phase15_deterministic_checks_test import recommendation, report_for
from phase18_strands_experiment_test import (
    CaseDispatchSession,
    FakeAWS,
    RecordingBedrock,
)


ROOT = Path(__file__).resolve().parents[1]
AGENT = ROOT / "agent"
if str(AGENT) not in sys.path:
    sys.path.insert(0, str(AGENT))
import captured_execution


class BlockingBedrock(ScriptedBedrock):
    """Keep the S3 source execution in flight after its immutable snapshot."""

    def __init__(self, report, task, entered, release):
        super().__init__(report, task, reads=({"resource": "inventory"},))
        self.entered = entered
        self.release = release

    def converse_stream(self, **request):
        self.entered.set()
        if not self.release.wait(20):
            raise TimeoutError("phase22 source execution was not released")
        return super().converse_stream(**request)


def _run_active_s3_source(case, bundle, output_root, source_directory, entered, release):
    """Child target for a real captured S3 execution with a held model call."""

    from captured_execution import run_captured_case

    task = json.loads(Path(case).read_bytes())["case"]["task"]
    run_captured_case(
        case,
        bundle,
        output_root,
        candidate_id="repaired",
        source_directory=source_directory,
        model_session=BlockingBedrock(
            report_for(recommendation("Restore inventory access", "inventory", "75", "version")),
            task,
            entered,
            release,
        ),
    )


def _span_attributes(span):
    attributes = span.get("attributes", {}) if isinstance(span, dict) else {}
    if isinstance(attributes, dict) and isinstance(attributes.get("attributes"), dict):
        attributes = attributes["attributes"]
    return attributes if isinstance(attributes, dict) else {}


def _native_public_task(execution_directory: Path) -> dict:
    """Extract the task event emitted by the captured executor's root span."""

    native = json.loads((execution_directory / "strands.native-spans.json").read_bytes())
    spans = native.get("spans", native) if isinstance(native, dict) else native
    for span in spans:
        if _span_attributes(span).get("gen_ai.operation.name") != "invoke_agent":
            continue
        for event in span.get("events", []):
            if event.get("name") != "gen_ai.user.message":
                continue
            content = event.get("attributes", {}).get("content")
            if not isinstance(content, str):
                continue
            value = json.loads(content)
            if isinstance(value, list):
                content = "".join(
                    item.get("text", "") for item in value if isinstance(item, dict)
                )
            return json.loads(content)
    raise AssertionError("captured native trace has no public task event")


class StageHandoffAcceptance(unittest.TestCase):
    """Exercise a real S1 input through an explicit S3-to-S4 handoff."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.s1 = self.root / "s1"
        self.s1.mkdir()
        self.bundle = self.s1 / "denial.capture.json"
        self.origin = write_bundle(self.bundle)
        case = make_case(self.bundle, self.origin["runId"])
        case["caseId"] = "phase22.s1-denial"
        self.draft = self.s1 / "denial.reviewed.json"
        self.draft.write_text(json.dumps(case, indent=2) + "\n", encoding="utf-8")
        self.frozen = self.s1 / "denial.frozen.json"
        self._reviewed_cli(
            "freeze",
            "--case", self.draft,
            "--bundle", self.bundle,
            "--output", self.frozen,
            expected=0,
        )
        candidate = self._reviewed_cli(
            "candidate-input",
            "--case", self.frozen,
            "--bundle", self.bundle,
            expected=0,
        )
        self.public_task = json.loads(candidate.stdout)

        self.cases = self.root / "cases"
        self.cases.mkdir()
        shutil.copy2(self.frozen, self.cases / self.frozen.name)
        shutil.copy2(self.bundle, self.root / self.bundle.name)
        self.suite = self.root / "suite.json"
        self.suite.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "cases": [{"case": f"cases/{self.frozen.name}", "bundle": self.bundle.name}],
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        self.evaluator = self.root / "evaluator.json"
        module = importlib.import_module("agentcore_evaluation")
        config = module.evaluator_config(MODEL_ID, "single")
        self.evaluator.write_text(
            json.dumps(
                {
                    "evaluatorId": "Phase22Handoff-1234567890",
                    "evaluatorArn": "arn:aws:bedrock-agentcore:us-east-1:027224425948:evaluator/Phase22Handoff-1234567890",
                    "judgeModelId": MODEL_ID,
                    "evaluatorMode": "single",
                    "configSha256": hashlib.sha256(
                        json.dumps(config, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
                    ).hexdigest(),
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        self.s3_workspace = self._workspace("s3", "PHASE22_S3_SOURCE_MARKER")
        self.s4_workspace = self._workspace("s4", "PHASE22_S4_PREPARED_MARKER")

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def _environment():
        environment = os.environ.copy()
        for name in (
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_SESSION_TOKEN",
            "AWS_PROFILE",
            "AWS_DEFAULT_PROFILE",
            "AWS_WEB_IDENTITY_TOKEN_FILE",
            "AWS_ROLE_ARN",
        ):
            environment.pop(name, None)
        environment.update(
            {
                "AWS_EC2_METADATA_DISABLED": "true",
                "AWS_CONFIG_FILE": os.devnull,
                "AWS_SHARED_CREDENTIALS_FILE": os.devnull,
            }
        )
        return environment

    def _reviewed_cli(self, command, *arguments, expected):
        completed = subprocess.run(
            [sys.executable, str(AGENT / "reviewed_cases.py"), command, *map(str, arguments)],
            cwd=ROOT,
            env=self._environment(),
            text=True,
            capture_output=True,
            check=False,
            timeout=20,
        )
        self.assertEqual(expected, completed.returncode, completed.stderr)
        return completed

    def _workspace(self, name: str, marker: str) -> Path:
        import captured_execution

        workspace = self.root / name
        workspace.mkdir()
        for filename in (*captured_execution.SOURCE_FILES, *captured_execution.DEPENDENCY_FILES):
            target = workspace / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(AGENT / filename, target)
        prompt = workspace / "prompt.py"
        prompt.write_text(
            prompt.read_text(encoding="utf-8").replace(
                "Candidate recommendation rule:",
                f"Candidate recommendation rule:\\n{marker}",
                1,
            ),
            encoding="utf-8",
        )
        return workspace

    def _record(self, experiment: Path) -> dict:
        return json.loads((experiment / "experiment.json").read_bytes())

    def _wait_for_running(self, output_root: Path, entered) -> Path:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            for path in output_root.rglob("execution.json"):
                try:
                    record = json.loads(path.read_bytes())
                except (OSError, ValueError):
                    continue
                if record.get("status") == "running" and entered.wait(0.05):
                    return path.parent
            time.sleep(0.01)
        self.fail("the S3 source did not reach its in-flight model call")

    def test_public_s1_task_handoff_uses_exact_active_s3_source_across_workspaces(self):
        """S4 consumes the selected S3 snapshot, exact S1 case, and no fallback."""

        import development_experiment

        context = multiprocessing.get_context("fork")
        entered = context.Event()
        release = context.Event()
        source_root = self.root / "s3-runs"
        source_root.mkdir()
        process = context.Process(
            target=_run_active_s3_source,
            args=(self.frozen, self.bundle, source_root, self.s3_workspace, entered, release),
        )
        process.start()
        active_source = None
        try:
            active_source = self._wait_for_running(source_root, entered)
            source_identity = json.loads((active_source / "execution.json").read_bytes())["identity"]
            editor_manifest = self.s3_workspace / "agent-manifest.json"
            editor_manifest_before = editor_manifest.read_bytes()
            captured_manifest = json.loads(
                (active_source / "source" / "agent" / "agent-manifest.json").read_bytes()
            )
            self.assertNotEqual(
                json.loads(editor_manifest_before)["promptSha256"],
                source_identity["promptSha256"],
                "the edited workspace keeps its historical manifest",
            )
            self.assertEqual(captured_manifest["promptSha256"], source_identity["promptSha256"])
            source_files = {
                f"agent/{name}": (active_source / "source" / "agent" / name).read_bytes()
                for name in captured_execution.SOURCE_FILES
            }
            dependency_files = {
                f"agent/{name}": (active_source / "source" / "agent" / name).read_bytes()
                for name in captured_execution.DEPENDENCY_FILES
            }
            self.assertEqual(source_identity["sourceSha256"], captured_execution._named_digest(source_files))
            self.assertEqual(source_identity["dependencySha256"], captured_execution._named_digest(dependency_files))
            self.assertEqual(editor_manifest.read_bytes(), editor_manifest_before)

            # The S3 snapshot is immutable even while its owning process is in
            # flight.  The S4 checkout has a different prepared source marker.
            prompt = self.s3_workspace / "prompt.py"
            prompt.write_text(prompt.read_text(encoding="utf-8") + "\nPHASE22_LATE_S3_EDIT\n", encoding="utf-8")
            s4_client = RecordingBedrock(
                report_for(recommendation("Restore inventory access", "inventory", "75", "version")),
                self.public_task,
                reads=({"resource": "inventory"},),
            )
            model_session = CaseDispatchSession([s4_client])
            aws = FakeAWS(self.root / "s4-runs")
            with patch.object(boto3, "Session", side_effect=aws.session_factory):
                experiment = Path(
                    development_experiment.run_experiment(
                        self.suite,
                        self.root / "s4-runs",
                        candidate_id="repaired",
                        evaluator_path=self.evaluator,
                        wait_seconds=0,
                        selected_cases=["phase22.s1-denial"],
                        source_run=active_source,
                        source_directory=self.s4_workspace,
                        model_session=model_session,
                    )
                )

            record = self._record(experiment)
            self.assertEqual([row["caseId"] for row in record["cases"]], ["phase22.s1-denial"])
            self.assertEqual(record["sourceRun"]["executionId"], source_identity["executionId"])
            self.assertEqual(record["sourceRun"]["sourceSha256"], source_identity["sourceSha256"])
            self.assertIn("PHASE22_S3_SOURCE_MARKER", json.dumps(s4_client.requests))
            self.assertNotIn("PHASE22_S4_PREPARED_MARKER", json.dumps(s4_client.requests))
            self.assertNotIn("PHASE22_LATE_S3_EDIT", json.dumps(s4_client.requests))

            row = record["cases"][0]
            execution = experiment / "executions" / row["executionId"]
            self.assertEqual(json.loads((execution / "case.frozen.json").read_bytes())["caseSha256"], json.loads(self.frozen.read_bytes())["caseSha256"])
            self.assertEqual(_native_public_task(execution), self.public_task)
            self.assertEqual(json.loads((execution / "execution.json").read_bytes())["identity"]["candidateId"], "repaired")

            # The public open/show command reads the saved native report; it
            # must not acquire AWS, call the model, or create a second run.
            request_count = len(s4_client.requests)
            judge_calls = copy.deepcopy(aws.evaluate.calls)
            output = StringIO()
            with patch.object(boto3, "Session", side_effect=AssertionError("show must be read-only")):
                with redirect_stdout(output):
                    code = development_experiment.main(["show", "--experiment", str(experiment)])
            self.assertEqual(code, 0)
            self.assertEqual(len(s4_client.requests), request_count)
            self.assertEqual(aws.evaluate.calls, judge_calls)
            self.assertEqual(json.loads(output.getvalue())["experimentId"], record["experimentId"])
        finally:
            release.set()
            if process.is_alive():
                process.terminate()
            process.join(10)
        self.assertFalse(process.is_alive())

    def test_s4_keeps_explicit_candidate_and_case_inputs_separate(self):
        """A source candidate and independently selected valid case keep separate provenance."""

        import captured_execution
        import development_experiment
        from opentelemetry import trace
        from opentelemetry.sdk.trace import TracerProvider

        if not isinstance(trace.get_tracer_provider(), TracerProvider):
            trace.set_tracer_provider(TracerProvider())
        source_root = self.root / "s3-complete"
        source_root.mkdir()
        source_run = captured_execution.run_captured_case(
            self.frozen,
            self.bundle,
            source_root,
            candidate_id="repaired",
            source_directory=self.s3_workspace,
            model_session=ScriptedBedrock(
                report_for(recommendation("Restore inventory access", "inventory", "75", "version")),
                self.public_task,
                reads=({"resource": "inventory"},),
            ),
        )

        alternate_bundle = self.s1 / "alternate.capture.json"
        write_bundle(alternate_bundle)
        alternate_payload = json.loads(alternate_bundle.read_bytes())
        alternate_payload["origin"]["runId"] = "phase22-alternate-capture"
        alternate_bundle.write_text(json.dumps(alternate_payload, sort_keys=True) + "\n", encoding="utf-8")
        alternate_case = make_case(alternate_bundle, "phase22-alternate-capture")
        alternate_case["caseId"] = "phase22.s1-denial-alternate"
        alternate_draft = self.s1 / "alternate.reviewed.json"
        alternate_draft.write_text(json.dumps(alternate_case, indent=2) + "\n", encoding="utf-8")
        alternate_frozen = self.s1 / "alternate.frozen.json"
        self._reviewed_cli(
            "freeze", "--case", alternate_draft, "--bundle", alternate_bundle, "--output", alternate_frozen, expected=0
        )

        mismatched_cases = self.root / "mismatched-cases"
        mismatched_cases.mkdir()
        shutil.copy2(alternate_frozen, mismatched_cases / alternate_frozen.name)
        shutil.copy2(alternate_bundle, self.root / alternate_bundle.name)
        mismatched_suite = self.root / "mismatched-suite.json"
        mismatched_suite.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "cases": [{"case": f"mismatched-cases/{alternate_frozen.name}", "bundle": alternate_bundle.name}],
                }
            ),
            encoding="utf-8",
        )
        alternate_client = RecordingBedrock(
            report_for(recommendation("Restore inventory access", "inventory", "75", "version")),
            json.loads(alternate_frozen.read_bytes())["case"]["task"],
            reads=({"resource": "inventory"},),
        )
        calls = CaseDispatchSession([
            alternate_client,
        ])
        aws = FakeAWS(self.root / "alternate-runs")
        with patch.object(boto3, "Session", side_effect=aws.session_factory):
            experiment = Path(
                development_experiment.run_experiment(
                    mismatched_suite,
                    self.root / "alternate-runs",
                    candidate_id="repaired",
                    evaluator_path=self.evaluator,
                    wait_seconds=0,
                    selected_cases=["phase22.s1-denial-alternate"],
                    source_run=source_run,
                    source_directory=self.s4_workspace,
                    model_session=calls,
                )
            )
        record = self._record(experiment)
        row = record["cases"][0]
        source_identity = json.loads((Path(source_run) / "execution.json").read_bytes())["identity"]
        alternate_identity = json.loads(
            (experiment / "executions" / row["executionId"] / "execution.json").read_bytes()
        )["identity"]
        self.assertEqual(row["caseId"], "phase22.s1-denial-alternate")
        self.assertEqual(row["caseSha256"], json.loads(alternate_frozen.read_bytes())["caseSha256"])
        self.assertEqual(row["bundleSha256"], hashlib.sha256(alternate_bundle.read_bytes()).hexdigest())
        self.assertEqual(record["sourceRun"]["executionId"], source_identity["executionId"])
        self.assertNotEqual(row["caseSha256"], source_identity["caseSha256"])
        self.assertEqual(alternate_identity["caseSha256"], row["caseSha256"])
        self.assertEqual(alternate_identity["bundleSha256"], row["bundleSha256"])
        self.assertEqual(calls.index, 1)

        # A requested case absent from the explicitly selected suite is a
        # rejected input, not permission to substitute the suite's only case.
        missing_calls = CaseDispatchSession([
            RecordingBedrock(
                report_for(recommendation("Restore inventory access", "inventory", "75", "version")),
                self.public_task,
            )
        ])
        with self.assertRaises((ValueError, FileNotFoundError, SystemExit)) as mismatch:
            development_experiment.run_experiment(
                self.suite,
                self.root / "missing-case-runs",
                candidate_id="repaired",
                evaluator_path=self.evaluator,
                wait_seconds=0,
                selected_cases=["phase22.not-in-suite"],
                source_run=source_run,
                source_directory=self.s4_workspace,
                model_session=missing_calls,
            )
        self.assertRegex(str(mismatch.exception).lower(), r"case|selected|unknown|suite")
        self.assertEqual(missing_calls.index, 0, "an unknown selected case must fail before candidate inference")


if __name__ == "__main__":
    unittest.main()
