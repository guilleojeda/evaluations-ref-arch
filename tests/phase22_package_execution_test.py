"""Focused checks for the checked-ZIP package execution process boundary."""

from __future__ import annotations

import io
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import sysconfig
import tempfile
import time
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
TESTS = ROOT / "tests"
AGENT = ROOT / "agent"
if str(TESTS) not in sys.path:
    sys.path.insert(0, str(TESTS))
if str(AGENT) not in sys.path:
    sys.path.insert(0, str(AGENT))

import captured_execution
from phase14_reviewed_cases_test import make_case, write_bundle
from reviewed_cases import freeze_case


class PackageEventFraming(unittest.TestCase):
    def test_streamed_text_ends_before_each_child_record(self):
        with patch("sys.stdout", new_callable=io.StringIO) as output:
            for kind in ("progress", "result", "error"):
                print("model output", end="")
                captured_execution._print_package_event({"kind": kind})
        lines = output.getvalue().splitlines()
        self.assertEqual(lines[::2], ["model output"] * 3)
        self.assertEqual(lines[1::2], [
            captured_execution._PACKAGE_CHILD_PROGRESS_PREFIX + json.dumps({"kind": kind}, separators=(",", ":"))
            for kind in ("progress", "result", "error")
        ])


class _FakeProcess:
    def __init__(self, output: str) -> None:
        self.stdout = io.StringIO(output)
        self.returncode = 0
        self.command = None
        self.environment = None

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        return self.returncode

    def send_signal(self, _signal):
        self.returncode = 130

    def terminate(self):
        self.returncode = 143

    def kill(self):
        self.returncode = -9


class PackageExecutionIsolationTests(unittest.TestCase):
    def test_package_scope_does_not_evict_loaded_host_module(self):
        import urllib3.response

        loaded = sys.modules["urllib3.response"]
        with tempfile.TemporaryDirectory() as temporary:
            with captured_execution._package_process_imports(
                Path(temporary) / "agent",
                dependency_root=Path(temporary) / "runtime",
            ):
                self.assertIs(sys.modules["urllib3.response"], loaded)
        self.assertIs(sys.modules["urllib3.response"], loaded)

    def test_package_scope_excludes_ambient_site_packages_from_search_path(self):
        original = list(sys.path)
        with tempfile.TemporaryDirectory() as temporary:
            ambient = str(Path(temporary) / "site-packages")
            sys.path.insert(0, ambient)
            try:
                with captured_execution._package_process_imports(
                    Path(temporary) / "agent",
                    dependency_root=Path(temporary) / "runtime",
                ):
                    self.assertNotIn(ambient, sys.path)
                    self.assertEqual(sys.path[:2], [str(Path(temporary) / "runtime"), str(Path(temporary) / "agent")])
            finally:
                sys.path[:] = original

    def test_checked_package_dispatches_to_child_without_snapshot_eviction(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bundle = root / "bundle.json"
            origin = write_bundle(bundle)
            draft = root / "case.json"
            draft.write_text(json.dumps(make_case(bundle, origin["runId"])), encoding="utf-8")
            case = root / "case.frozen.json"
            freeze_case(draft, bundle, case)
            expected = root / "child-run"
            with (
                patch.object(captured_execution, "_verify_exporter_setup", return_value=object()),
                patch.object(captured_execution, "_snapshot_imports", side_effect=AssertionError("parent eviction")),
                patch.object(captured_execution, "_run_packaged_case_process", return_value=expected) as child,
            ):
                actual = captured_execution.run_captured_case(
                    case,
                    bundle,
                    root / "runs",
                    candidate_id="repaired",
                    source_directory=AGENT,
                    dependency_root=root / "runtime",
                    dependency_modules=("urllib3",),
                    trusted_runner=True,
                )
            self.assertEqual(actual, expected)
            self.assertEqual(child.call_count, 1)
            self.assertTrue(child.call_args.kwargs["runner_source"])

    def test_injected_session_keeps_offline_package_path_in_process(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bundle = root / "bundle.json"
            origin = write_bundle(bundle)
            draft = root / "case.json"
            draft.write_text(json.dumps(make_case(bundle, origin["runId"])), encoding="utf-8")
            case = root / "case.frozen.json"
            freeze_case(draft, bundle, case)
            expected = root / "in-process-run"
            with (
                patch.object(captured_execution, "_verify_exporter_setup", return_value=None),
                patch.object(captured_execution, "_run_snapshot", return_value=expected) as snapshot,
                patch.object(captured_execution, "_run_packaged_case_process", side_effect=AssertionError("child")),
            ):
                actual = captured_execution.run_captured_case(
                    case,
                    bundle,
                    root / "runs",
                    model_session=object(),
                    candidate_id="repaired",
                    source_directory=AGENT,
                    dependency_root=root / "runtime",
                    trusted_runner=True,
                )
            self.assertEqual(actual, expected)
            self.assertEqual(snapshot.call_count, 1)

    def test_child_protocol_preserves_progress_and_exact_path_environment(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            staging = root / "staging"
            staging.mkdir()
            fake_output = (
                captured_execution._PACKAGE_CHILD_PROGRESS_PREFIX
                + json.dumps(
                    {"kind": "progress", "runDirectory": str(root / "run"), "record": {"status": "running"}},
                    separators=(",", ":"),
                )
                + "\n"
                + captured_execution._PACKAGE_CHILD_PROGRESS_PREFIX
                + json.dumps({"kind": "result", "runDirectory": str(root / "run")}, separators=(",", ":"))
                + "\n"
            )
            fake = _FakeProcess(fake_output)
            progress = []

            def start(*args, **kwargs):
                fake.command = args[0]
                fake.environment = kwargs["env"]
                fake.pass_fds = kwargs["pass_fds"]
                return fake

            with patch.object(captured_execution.subprocess, "Popen", side_effect=start):
                result = captured_execution._run_packaged_case_process(
                    staging=staging,
                    staged_case=staging / "case.json",
                    staged_bundle=staging / "bundle.json",
                    output_root=root / "runs",
                    candidate_id="repaired",
                    strict_manifest=False,
                    dependency_root=root / "runtime",
                    dependency_modules=("urllib3",),
                    runtime_origin={"kind": "runtime_zip"},
                    progress_callback=lambda run_dir, record: progress.append((run_dir, record)),
                    runner_source=Path(captured_execution.__file__).read_bytes(),
                )
            self.assertEqual(result, root / "run")
            self.assertEqual(progress, [(root / "run", {"status": "running"})])
            self.assertIn("-S", fake.command)
            self.assertEqual(fake.environment["PYTHONPATH"], "")
            self.assertEqual(fake.environment["PYTHONNOUSERSITE"], "1")
            self.assertEqual(len(fake.pass_fds), 1)

    def test_child_does_not_resolve_dependency_from_parent_pythonpath(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ambient = root / "ambient"
            ambient.mkdir()
            (ambient / "phase22_ambient_only.py").write_text("VALUE = 'ambient'\n", encoding="utf-8")
            staging = root / "staging"
            staging.mkdir()
            runner_source = b'''import json, os, sys\nfrom pathlib import Path\ndef _package_child_main():\n    request = json.loads(Path(sys.argv[1]).read_bytes())\n    try:\n        import phase22_ambient_only\n    except ModuleNotFoundError:\n        result = "missing"\n    else:\n        result = phase22_ambient_only.VALUE\n    (Path(request["staging"]) / "ambient-result").write_text(result)\n    print("__CAPTURED_PACKAGE_PROGRESS__ " + json.dumps({"kind": "result", "runDirectory": request["outputRoot"]}), flush=True)\nif __name__ == "__main__": _package_child_main()\n'''
            with patch.dict(os.environ, {"PYTHONPATH": str(ambient)}):
                captured_execution._run_packaged_case_process(
                    staging=staging,
                    staged_case=staging / "case.json",
                    staged_bundle=staging / "bundle.json",
                    output_root=root / "runs",
                    candidate_id="repaired",
                    strict_manifest=False,
                    dependency_root=root / "runtime",
                    dependency_modules=(),
                    runtime_origin=None,
                    progress_callback=None,
                    runner_source=runner_source,
                )
            self.assertEqual((staging / "ambient-result").read_text(), "missing")

    def test_real_trusted_child_entry_reaches_package_preflight(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            staging = root / "staging"
            agent_source = staging / "source" / "agent"
            agent_source.mkdir(parents=True)
            for name in (*captured_execution.SOURCE_FILES, *captured_execution.DEPENDENCY_FILES):
                shutil.copy2(AGENT / name, agent_source / name)
            environment = {
                "AGENT_OBSERVABILITY_ENABLED": "true",
                "AWS_GENAI_CONTENT_EXTRACTION_OPT_OUT": "true",
                "AWS_ACCOUNT_ID": captured_execution.AWS_ACCOUNT_ID,
                "AWS_REGION": "us-east-1",
                "AWS_DEFAULT_REGION": "us-east-1",
                "AWS_ACCESS_KEY_ID": "dummy",
                "AWS_SECRET_ACCESS_KEY": "dummy",
                "AWS_SESSION_TOKEN": "dummy",
                "AWS_EC2_METADATA_DISABLED": "true",
                "OTEL_PYTHON_DISTRO": "aws_distro",
                "OTEL_PYTHON_CONFIGURATOR": "aws_configurator",
                "OTEL_RESOURCE_ATTRIBUTES": f"service.name=phase22-child,aws.log.group.names={captured_execution.EVALUATION_LOG_GROUP}",
                "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
                "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": captured_execution.TRACE_ENDPOINT,
                "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL": "http/protobuf",
                "OTEL_EXPORTER_OTLP_TRACES_HEADERS": f"x-aws-log-group={captured_execution.EVALUATION_LOG_GROUP},x-aws-log-stream=spans",
                "OTEL_TRACES_EXPORTER": "otlp",
                "OTEL_LOGS_EXPORTER": "none",
                "OTEL_METRICS_EXPORTER": "none",
                "OTEL_TRACES_SAMPLER": "always_on",
            }
            with patch.dict(os.environ, environment, clear=False):
                with self.assertRaises(ValueError) as failure:
                    captured_execution._run_packaged_case_process(
                        staging=staging,
                        staged_case=staging / "missing-case.json",
                        staged_bundle=staging / "missing-bundle.json",
                        output_root=root / "runs",
                        candidate_id="repaired",
                        strict_manifest=False,
                        dependency_root=Path(sysconfig.get_path("purelib")),
                        dependency_modules=(),
                        runtime_origin=None,
                        progress_callback=None,
                        runner_source=Path(captured_execution.__file__).read_bytes(),
                    )
            self.assertIn("frozen case is not valid UTF-8 JSON", str(failure.exception))
            self.assertNotIn("positional", str(failure.exception))

    def test_worker_thread_parent_termination_does_not_orphan_child(self):
        runner_source = b'''import json, os, signal, sys, threading, time\nfrom pathlib import Path\ndef _package_child_main():\n    request = json.loads(Path(sys.argv[1]).read_bytes())\n    def watch_parent():\n        with os.fdopen(request["parentWatchdogFd"], "rb") as pipe:\n            if pipe.read(1) == b"":\n                os.kill(os.getpid(), signal.SIGINT)\n    threading.Thread(target=watch_parent, daemon=True).start()\n    (Path(request["staging"]) / "child.pid").write_text(str(os.getpid()))\n    while True:\n        time.sleep(1)\nif __name__ == "__main__":\n    _package_child_main()\n'''
        wrapper = r'''
import os
from pathlib import Path
import threading
import captured_execution

root = Path(os.environ["PHASE22_ROOT"])
staging = root / "staging"
staging.mkdir()
runner_source = Path(os.environ["PHASE22_RUNNER"]).read_bytes()

def run():
    captured_execution._run_packaged_case_process(
        staging=staging,
        staged_case=staging / "case.json",
        staged_bundle=staging / "bundle.json",
        output_root=root / "runs",
        candidate_id="repaired",
        strict_manifest=False,
        dependency_root=root / "runtime",
        dependency_modules=(),
        runtime_origin=None,
        progress_callback=None,
        runner_source=runner_source,
    )

worker = threading.Thread(target=run)
worker.start()
worker.join()
'''
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runner_path = root / "runner.py"
            runner_path.write_bytes(runner_source)
            environment = os.environ.copy()
            environment.update(
                {
                    "PHASE22_ROOT": str(root),
                    "PHASE22_RUNNER": str(runner_path),
                    "PYTHONPATH": str(AGENT),
                }
            )
            parent = subprocess.Popen([sys.executable, "-c", wrapper], env=environment)
            child_pid_path = root / "staging" / "child.pid"
            try:
                for _ in range(100):
                    if child_pid_path.is_file():
                        break
                    time.sleep(0.05)
                self.assertTrue(child_pid_path.is_file(), "worker-thread child did not start")
                child_pid = int(child_pid_path.read_text())
                parent.send_signal(signal.SIGTERM)
                self.assertIn(parent.wait(timeout=10), {-signal.SIGTERM, 128 + signal.SIGTERM})
                time.sleep(0.2)
                with self.assertRaises(ProcessLookupError):
                    os.kill(child_pid, 0)
            finally:
                if parent.poll() is None:
                    parent.kill()
                    parent.wait()


if __name__ == "__main__":
    unittest.main()
