"""Offline tests for the durable S2/S3 presenter boundary."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "scripts" / "talk_stage.py"


class TalkStageChecks(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="talk-stage-")
        root = Path(self.temp.name)
        self.repo = root / "maintained"
        self.workspace = root / "session" / "S3"
        self.s2_workspace = root / "session" / "S2"
        self.session = self.workspace.parent
        self.baseline = root / "baseline"
        self.output = root / "output"
        self.uv_log = root / "uv.log"
        (self.repo / "scripts").mkdir(parents=True)
        (self.workspace / "agent").mkdir(parents=True)
        (self.baseline / "source" / "agent").mkdir(parents=True)
        self._write(self.repo / "scripts" / "talk-session.py", """#!/usr/bin/env python3
import json, subprocess, sys
from pathlib import Path
stage = sys.argv[sys.argv.index('--stage') + 1]
workspace = Path(sys.argv[sys.argv.index('--directory') + 1]) / stage
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=workspace, text=True).strip()
print(json.dumps({'stage': stage, 'directory': str(workspace.resolve()), 'currentCommit': head}))
""", executable=True)
        prompt = "import hashlib\nSYSTEM_PROMPT = 'faulty'\nPROMPT_SHA256 = hashlib.sha256(SYSTEM_PROMPT.encode()).hexdigest()\n"
        (self.workspace / "agent" / "prompt.py").write_text(prompt, encoding="utf-8")
        (self.baseline / "source" / "agent" / "prompt.py").write_text(prompt, encoding="utf-8")
        self._git("init", "-q", "-b", "main")
        self._git("config", "user.name", "talk-stage-test")
        self._git("config", "user.email", "talk-stage-test@example.invalid")
        self._git("add", "agent/prompt.py")
        self._git("commit", "-q", "-m", "faulty prompt")
        shutil.copytree(self.workspace, self.s2_workspace)
        self.aws = root / "aws"
        self._write(
            self.aws,
            "#!/bin/sh\n"
            "case \"$1 $2\" in\n"
            "configure\\ list-profiles) echo approved ;;\n"
            "sts\\ get-caller-identity) echo '{\"Account\":\"123\",\"Arn\":\"arn:aws:iam::123:role/test\"}' ;;\n"
            "*) exit 1 ;;\nesac\n",
            executable=True,
        )
        self.uv = root / "uv"
        self._write(self.uv, f"#!/bin/sh\necho called >> {self.uv_log}\nexit 0\n", executable=True)

    def tearDown(self) -> None:
        self.temp.cleanup()

    @staticmethod
    def _write(path: Path, content: str, *, executable: bool = False) -> None:
        path.write_text(content, encoding="utf-8")
        if executable:
            path.chmod(0o700)

    def _git(self, *args: str) -> str:
        result = subprocess.run(["git", *args], cwd=self.workspace, text=True, capture_output=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def _run(self, action: str, *, stage: str = "S3", workspace: Path | None = None, aws: Path | None = None, native: bool = False) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env.pop("AWS_PROFILE", None)
        command = [
            sys.executable, str(CHECKER), action, "--stage", stage,
            "--repository", str(self.repo), "--workspace", str(workspace or (self.s2_workspace if stage == "S2" else self.workspace)),
            "--output", str(self.output), "--profile", "approved", "--account", "123",
            "--aws", str(aws or self.aws),
        ]
        if action == "setup":
            command += ["--session-root", str(self.session), "--uv", str(self.uv)]
            if stage == "S3":
                command += ["--baseline", str(self.baseline)]
        if native:
            command += ["--", sys.executable, "-c", "import os; from pathlib import Path; Path('native-env.txt').write_text(os.environ['AWS_PROFILE'] + '|' + os.environ['OTEL_TRACES_EXPORTER'])"]
        return subprocess.run(command, text=True, capture_output=True, env=env, check=False)

    def test_effective_preimage_and_comment_only_guard(self) -> None:
        ready = self._run("setup")
        self.assertEqual(ready.returncode, 0, ready.stderr)
        receipt = json.loads((self.output / "s3-setup.json").read_text(encoding="utf-8"))
        self.assertEqual(receipt["preEdit"]["effectivePromptSha256"], hashlib.sha256(b"faulty").hexdigest())
        prompt = self.workspace / "agent" / "prompt.py"
        prompt.write_text(prompt.read_text(encoding="utf-8") + "# comment-only edit\n", encoding="utf-8")
        rejected = self._run("guard")
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("SYSTEM_PROMPT unchanged", rejected.stderr)
        prompt.write_text(prompt.read_text(encoding="utf-8").replace("'faulty'", "'repaired'"), encoding="utf-8")
        accepted = self._run("guard")
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        self.assertEqual(len(self.uv_log.read_text(encoding="utf-8").splitlines()), 1)

    def test_aws_failure_prevents_native_launcher(self) -> None:
        bad = self.aws.with_name("aws-bad")
        self._write(bad, "#!/bin/sh\necho approved\n", executable=True)
        rejected = self._run("setup", aws=bad)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertFalse(self.uv_log.exists())
        self.assertFalse((self.output / "s3-setup.json").exists())

    def test_s2_setup_checks_identity_without_native_otel(self) -> None:
        ready = self._run("setup", stage="S2")
        self.assertEqual(ready.returncode, 0, ready.stderr)
        receipt = json.loads((self.output / "s2-setup.json").read_text(encoding="utf-8"))
        self.assertFalse(receipt["nativeOtel"]["required"])
        self.assertFalse(self.uv_log.exists())

    def test_receipt_is_bound_to_workspace_and_head(self) -> None:
        self.assertEqual(self._run("setup").returncode, 0)
        other = self.workspace.parent / "other"
        shutil.copytree(self.workspace, other)
        rejected = self._run("guard", workspace=other)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("another workspace", rejected.stderr)

    def test_setup_rejects_other_prepared_stage(self) -> None:
        result = self._run("setup", stage="S3", workspace=self.s2_workspace)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("differs from the prepared S3 stage", result.stderr)
        self.assertFalse(self.uv_log.exists())

    def test_clean_exact_repair_from_repaired_head_passes(self) -> None:
        prompt = self.workspace / "agent" / "prompt.py"
        repaired = prompt.read_text(encoding="utf-8").replace("'faulty'", "'repaired'")
        prompt.write_text(repaired, encoding="utf-8")
        self._git("add", "agent/prompt.py")
        self._git("commit", "-q", "-m", "repaired checkpoint")
        baseline_prompt = self.baseline / "source" / "agent" / "prompt.py"
        prompt.write_text(baseline_prompt.read_text(encoding="utf-8"), encoding="utf-8")
        self.assertEqual(self._run("setup").returncode, 0)
        prompt.write_text(repaired, encoding="utf-8")
        accepted = self._run("guard")
        self.assertEqual(accepted.returncode, 0, accepted.stderr)

    def test_run_exports_verified_environment_only_after_guard(self) -> None:
        self.assertEqual(self._run("setup").returncode, 0)
        prompt = self.workspace / "agent" / "prompt.py"
        prompt.write_text(prompt.read_text(encoding="utf-8").replace("'faulty'", "'repaired'"), encoding="utf-8")
        started = self._run("run", native=True)
        self.assertEqual(started.returncode, 0, started.stderr)
        self.assertEqual((self.workspace / "native-env.txt").read_text(encoding="utf-8"), "approved|otlp")


if __name__ == "__main__":
    unittest.main()
