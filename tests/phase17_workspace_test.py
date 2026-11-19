"""Acceptance tests for the editable S3 candidate workflow.

These tests use the real captured-evidence runner and a scripted Bedrock
transport. They do not call AWS. The repaired-candidate test deliberately
leaves ``agent-manifest.json`` at its development value while changing the
saved prompt, because S3 must snapshot the editable prompt itself and keep
hosted-package validation separate.
"""

from __future__ import annotations

from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
import multiprocessing
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from threading import Event
import time
import unittest
from unittest.mock import patch

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider

from phase16_baseline_test import (
    ScriptedBedrock,
    make_case,
    recommendation,
    report_for,
    write_bundle,
)


ROOT = Path(__file__).resolve().parents[1]
AGENT = ROOT / "agent"
sys.path.insert(0, str(AGENT))

from captured_execution import run_captured_case  # noqa: E402
import captured_execution  # noqa: E402
import evaluate_case  # noqa: E402
from reviewed_cases import freeze_case  # noqa: E402


class BlockingBedrock(ScriptedBedrock):
    """Hold the first model request so another process can inspect the run."""

    def __init__(self, report, task):
        super().__init__(report, task)
        self.release = Event()

    def converse_stream(self, **request):
        if not self.release.wait(timeout=10):
            raise TimeoutError("test transport was not released")
        return super().converse_stream(**request)


def _child_run_blocking(case_path: str, bundle_path: str, runs_path: str, task: dict[str, object]) -> None:
    """Leave an active run behind so the parent can verify abrupt loss."""

    if not isinstance(trace.get_tracer_provider(), TracerProvider):
        trace.set_tracer_provider(TracerProvider())
    report = report_for(recommendation("Increase memory", "inventory", 512, "MB"))
    bedrock = BlockingBedrock(report, task)
    run_captured_case(case_path, bundle_path, runs_path, model_session=bedrock)


class S3WorkspaceAcceptance(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.bundle = self.root / "capture.json"
        origin = write_bundle(self.bundle)
        self.case = make_case(self.bundle, origin["runId"])
        self.case_path = self.root / "case.json"
        self.case_path.write_text(json.dumps(self.case), encoding="utf-8")
        self.frozen_case = self.root / "case.frozen.json"
        freeze_case(self.case_path, self.bundle, self.frozen_case)
        self.runs = self.root / "runs"
        self._set_tracer_provider()

    def tearDown(self) -> None:
        self.temp.cleanup()

    @staticmethod
    def _set_tracer_provider() -> None:
        # The SDK permits one global provider. Existing phase suites may have
        # installed one already, which is suitable for this transport test.
        if not isinstance(trace.get_tracer_provider(), TracerProvider):
            trace.set_tracer_provider(TracerProvider())

    def _show(self, run_dir: Path) -> dict[str, object]:
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
            AWS_EC2_METADATA_DISABLED="true",
            AWS_CONFIG_FILE=os.devnull,
            AWS_SHARED_CREDENTIALS_FILE=os.devnull,
        )
        completed = subprocess.run(
            [sys.executable, "agent/evaluate_case.py", "show", "--run", str(run_dir)],
            cwd=ROOT,
            env=environment,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def _editable_agent(self) -> Path:
        """Make a disposable editable source tree for a prompt-only candidate."""

        editable = self.root / "editable-agent"
        editable.mkdir()
        for name in (*captured_execution.SOURCE_FILES, *captured_execution.DEPENDENCY_FILES):
            target = editable / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((AGENT / name).read_bytes())
        return editable

    def _launch_repaired(self, agent_directory, bedrock):
        def with_scripted_bedrock(case_path, bundle_path, output_root, **kwargs):
            return run_captured_case(
                case_path, bundle_path, output_root, model_session=bedrock, **kwargs,
            )

        output = io.StringIO()
        with (
            patch.object(captured_execution, "AGENT_DIRECTORY", agent_directory),
            patch.object(evaluate_case, "run_captured_case", side_effect=with_scripted_bedrock),
            patch.object(sys, "argv", [
                "evaluate_case.py", "run", "--candidate", "repaired",
                "--case", str(self.frozen_case), "--bundle", str(self.bundle),
                "--output-root", str(self.runs),
            ]),
            redirect_stdout(output),
        ):
            try:
                code = evaluate_case.main()
            except SystemExit as exc:
                self.fail(f"public run command rejected --candidate repaired: {exc}")
        self.assertEqual(code, 0, output.getvalue())
        return Path(json.loads(output.getvalue())["runDirectory"])

    def test_saved_prompt_is_isolated_and_identical_inputs_run_again(self):
        report = report_for(recommendation("Restore inventory access", "inventory", "75", "version"))
        first_model = ScriptedBedrock(report, self.case["task"])
        editable_agent = self._editable_agent()
        prompt_path = editable_agent / "prompt.py"
        manifest_path = editable_agent / "agent-manifest.json"
        editor_manifest_before = manifest_path.read_bytes()
        marker = b"S3_SAVED_PROMPT"
        late_marker = b"S3_LATER_EDITOR_SAVE"
        edited_prompt = prompt_path.read_bytes().replace(
            b"Candidate recommendation rule:", marker + b" Candidate recommendation rule:", 1,
        )
        self.assertIn(marker, edited_prompt)
        prompt_path.write_bytes(edited_prompt)
        original_spec = importlib.util.spec_from_file_location
        expected = original_spec("phase17_saved_prompt", prompt_path)
        expected_prompt_module = importlib.util.module_from_spec(expected)
        expected.loader.exec_module(expected_prompt_module)

        edited_during_launch = []

        def save_after_snapshot(name, location, *args, **kwargs):
            if name.startswith("_captured_execution_snapshot_"):
                staged = Path(location).with_name("prompt.py")
                self.assertEqual(staged.read_bytes(), edited_prompt)
                prompt_path.write_bytes(edited_prompt.replace(marker, late_marker, 1))
                edited_during_launch.append(staged)
            return original_spec(name, location, *args, **kwargs)

        # Gate before any model construction can import prompt.py, after the
        # run has copied its source bytes into staging.
        with patch.object(importlib.util, "spec_from_file_location", side_effect=save_after_snapshot):
            first_dir = self._launch_repaired(editable_agent, first_model)
        self.assertEqual(len(edited_during_launch), 1)
        self.assertIn(late_marker, prompt_path.read_bytes())
        self.assertEqual((first_dir / "source/agent/prompt.py").read_bytes(), edited_prompt)
        self.assertEqual(manifest_path.read_bytes(), editor_manifest_before)

        prompt_path.write_bytes(edited_prompt)
        second_model = ScriptedBedrock(report, self.case["task"])
        second_dir = self._launch_repaired(editable_agent, second_model)
        before, after = self._show(first_dir), self._show(second_dir)
        for shown, model, run_dir in ((before, first_model, first_dir), (after, second_model, second_dir)):
            self.assertEqual(shown["status"], "complete")
            self.assertEqual(shown["identity"]["candidateId"], "repaired")
            self.assertEqual(shown["identity"]["originatingRunId"], self.case["evidence"]["originatingRunId"])
            self.assertEqual(shown["identity"]["promptSha256"], expected_prompt_module.PROMPT_SHA256)
            self.assertEqual(shown["manifest"]["sourceFiles"]["agent/prompt.py"], hashlib.sha256(edited_prompt).hexdigest())
            captured_manifest = json.loads((run_dir / "source/agent/agent-manifest.json").read_bytes())
            self.assertEqual(captured_manifest["promptSha256"], expected_prompt_module.PROMPT_SHA256)
            self.assertNotEqual(captured_manifest["promptSha256"], json.loads(editor_manifest_before)["promptSha256"])
            self.assertEqual(shown["report"]["recommendation"]["value"], "75")
            self.assertTrue(model.requests)
            for request in model.requests:
                self.assertEqual(request["system"][0]["text"], expected_prompt_module.SYSTEM_PROMPT)
        for key in ("caseSha256", "bundleSha256", "referenceTime", "sourceSha256", "promptSha256"):
            self.assertEqual(before["identity"][key], after["identity"][key])
        for key in ("executionId", "sessionId", "traceId"):
            self.assertNotEqual(before["identity"][key], after["identity"][key])

    def test_prepared_repair_patch_applies_in_a_clean_workspace(self):
        patch_file = AGENT / "prompts" / "s3-repair.patch"
        self.assertTrue(patch_file.is_file(), "prepared S3 repair patch is missing")
        checkout = self.root / "prepared-checkout"
        (checkout / "agent").mkdir(parents=True)
        for name in (*captured_execution.SOURCE_FILES, *captured_execution.DEPENDENCY_FILES):
            target = checkout / "agent" / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(AGENT / name, target)
        faulty_prompt = subprocess.check_output(
            ["git", "show", "bd6f77df97933e3e675ee9c2a699db16e29ea1b6:agent/prompt.py"],
            cwd=ROOT,
        )
        (checkout / "agent/prompt.py").write_bytes(faulty_prompt)
        subprocess.run(["git", "init", "-q"], cwd=checkout, check=True)
        subprocess.run(["git", "add", "agent"], cwd=checkout, check=True)
        subprocess.run(
            ["git", "-c", "user.name=S3", "-c", "user.email=s3@example.invalid", "commit", "-qm", "base"],
            cwd=checkout,
            check=True,
        )
        applied = subprocess.run(
            ["git", "apply", str(patch_file)],
            cwd=checkout,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(applied.returncode, 0, applied.stderr)
        repaired_prompt = (checkout / "agent/prompt.py").read_bytes()
        self.assertNotEqual(repaired_prompt, faulty_prompt)
        prompt_spec = importlib.util.spec_from_file_location(
            "phase17_prepared_prompt", checkout / "agent/prompt.py"
        )
        self.assertIsNotNone(prompt_spec)
        self.assertIsNotNone(prompt_spec.loader)
        prompt_module = importlib.util.module_from_spec(prompt_spec)
        prompt_spec.loader.exec_module(prompt_module)
        report = report_for(
            recommendation("Restore inventory access", "inventory", "75", "version")
        )
        bedrock = ScriptedBedrock(report, self.case["task"])

        run_dir = self._launch_repaired(checkout / "agent", bedrock)
        record = json.loads((run_dir / "execution.json").read_bytes())
        self.assertEqual(record["identity"]["candidateId"], "repaired")
        self.assertEqual(record["identity"]["promptSha256"], prompt_module.PROMPT_SHA256)
        self.assertTrue(bedrock.requests)
        self.assertEqual(bedrock.requests[0]["system"][0]["text"], prompt_module.SYSTEM_PROMPT)

    def test_abrupt_process_loss_leaves_interrupted_run_without_relaunch(self):
        context = multiprocessing.get_context("fork")
        process = context.Process(
            target=_child_run_blocking,
            args=(str(self.frozen_case), str(self.bundle), str(self.runs), self.case["task"]),
        )
        process.start()
        run_dir = None
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                candidates = list(self.runs.glob("*/execution.json"))
                if candidates:
                    run_dir = candidates[0].parent
                    break
                time.sleep(0.01)
            self.assertIsNotNone(run_dir, "child runner never created a running record")
            active = json.loads((run_dir / "execution.json").read_bytes())
            self.assertEqual(active["status"], "running")
            self.assertEqual(self._show(run_dir)["status"], "running")
        finally:
            process.terminate()
            process.join(timeout=10)
        self.assertFalse(process.is_alive())
        self.assertIsNotNone(run_dir)
        # Simulate an exporter flush that persisted spans immediately before
        # the process died, before execution.json could stamp their digest.
        (run_dir / "strands.native-spans.json").write_text('{"spans": []}\n', encoding="utf-8")
        from captured_execution import load_execution
        interrupted_record, _, interrupted_spans = load_execution(run_dir)
        self.assertEqual(interrupted_record["status"], "interrupted")
        self.assertEqual(interrupted_spans, [])
        raw_before_show = (run_dir / "execution.json").read_bytes()
        lock_before_show = (run_dir / ".owner.lock").read_bytes()
        interrupted = self._show(run_dir)
        self.assertEqual(interrupted["status"], "interrupted")
        self.assertEqual(interrupted["identity"]["executionId"], run_dir.name)
        self.assertEqual((run_dir / "execution.json").read_bytes(), raw_before_show)
        self.assertEqual((run_dir / ".owner.lock").read_bytes(), lock_before_show)


if __name__ == "__main__":
    unittest.main()
