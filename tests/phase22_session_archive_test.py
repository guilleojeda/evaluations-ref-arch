"""Offline acceptance for portable private session save/restore.

The public command under test is intentionally the operator CLI, rather than a
Python helper:

    python3 scripts/talk-session.py save|restore \
        --directory <session-root> --archive <path> \
        --inventory <private inventory.json>

Inventory schema v1 is deliberately small and private::

    {"schemaVersion": 1, "sessionId": "...", "sourceBase":
     {"kind": "git", "commit": "40 lowercase hex chars"},
     "allowlist": [
         {"path": "relative/posix/path", "sha256": "64 lowercase hex chars",
          "baseSha256": "64 lowercase hex chars or null", "mode": 493}
     ]}

Only relative allowlisted paths are selected.  ``baseSha256`` identifies the
clean frozen bytes that may already exist in a replacement worktree; ``null``
means the selected file is new and must be created. ``sourceBase`` is present
when the selected source is a frozen Git worktree. The fixture includes the
saved stage edits (including an intentionally untracked source file), reviewed
case, run/score and CI records, plus an explicitly incomplete run. Credentials
and private files exist under the source root but are intentionally omitted
from the inventory. No S3 checksum/put/get behavior belongs in this offline
test; that boundary remains live verification. Generated inventories may add
``state: deleted`` for tracked deletions, ``mode`` for executable preservation,
``stageHeads`` for local stage commits, and ``historyPaths`` for safe commit
paths whose final tree bytes returned to their frozen values.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import scripts.talk_archive as talk_archive


ROOT = Path(__file__).resolve().parents[1]
CLI = "scripts/talk-session.py"


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class SessionFixture:
    """Two local roots and a reviewed, content-addressed allowlist."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.source = root / "original-session"
        self.replacement = root / "replacement-session"
        self.inventory = root / "private-inventory.json"
        self.archive = root / "session-archive.tar.gz"
        self.base_expected: dict[str, bytes | None] = {}
        self.source_base: dict[str, str] | None = None

        self.expected: dict[str, bytes] = {
            "session-index.json": self._json(
                {
                    "schemaVersion": 1,
                    "sessionId": "phase22-portable-session",
                    "stages": {
                        "S3": {"candidateId": "repaired", "inputId": "reviewed-denial"},
                        "S5": {"candidateId": "repaired", "inputId": "prepared-regression"},
                    },
                }
            ),
            # This is an edited tracked source file in the prepared S3 copy.
            "S3/agent/prompt.py": (
                b"SYSTEM_PROMPT = 'saved audience repair'\n"
                b"# intentionally retained before the browser is replaced\n"
            ),
            # This source file is intentionally untracked and must still be
            # retained because the private inventory selects it explicitly.
            "S3/agent/untracked_experiment.py": (
                b"EXPERIMENT_MARKER = 'saved-untracked-source'\n"
            ),
            "S5/agent/prompt.py": b"SYSTEM_PROMPT = 'frozen checkpoint prompt'\n",
            "reviewed-cases/denial.json": self._json(
                {
                    "schemaVersion": 1,
                    "caseId": "phase22.reviewed.denial",
                    "status": "reviewed",
                    "originatingRunId": "phase21-denial-run",
                    "referenceTime": "2026-11-18T15:41:00.170Z",
                }
            ),
            "runs/s3-execution/execution.json": self._json(
                {
                    "schemaVersion": 1,
                    "executionId": "phase22-s3-execution",
                    "candidateId": "repaired",
                    "caseId": "phase22.reviewed.denial",
                    "status": "complete",
                }
            ),
            "runs/s3-execution/score.json": self._json(
                {
                    "schemaVersion": 1,
                    "executionId": "phase22-s3-execution",
                    "status": "complete",
                    "verdict": "pass",
                }
            ),
            "ci/demo-deploy-gate.json": self._json(
                {
                    "schemaVersion": 1,
                    "workflow": "demo-deploy",
                    "commit": "a" * 40,
                    "status": "failure",
                    "reason": "prepared prompt regression",
                }
            ),
            # Restore must preserve this unfinished state exactly.  It must not
            # convert it to success, restart it, or create a second attempt.
            "runs/s4-execution/status.json": self._json(
                {
                    "schemaVersion": 1,
                    "executionId": "phase22-s4-interrupted",
                    "status": "incomplete",
                    "reason": "process interrupted before scoring",
                    "attempt": 1,
                    "relaunchRequested": False,
                }
            ),
        }
        self.private: dict[str, bytes] = {
            ".aws/credentials": (
                b"[default]\naws_access_key_id=DO_NOT_COPY\n"
                b"aws_secret_access_key=DO_NOT_COPY\n"
            ),
            "private/presenter-token.json": b'{"token":"DO_NOT_COPY"}\n',
        }
        self._materialize()

    @staticmethod
    def _json(value: object) -> bytes:
        return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()

    def _materialize(self) -> None:
        for relative, contents in {**self.expected, **self.private}.items():
            path = self.source / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(contents)

        self.expected_hashes = {
            relative: _sha256(contents) for relative, contents in self.expected.items()
        }
        self.base_expected = {relative: None for relative in self.expected}
        self._write_inventory()

    def _write_inventory(self) -> None:
        inventory = {
            "schemaVersion": 1,
            "sessionId": "phase22-portable-session",
            "allowlist": [
                {
                    "path": relative,
                    "sha256": self.expected_hashes[relative],
                    "baseSha256": (
                        _sha256(base)
                        if (base := self.base_expected[relative]) is not None
                        else None
                    ),
                }
                for relative in self.expected
            ],
        }
        if self.source_base is not None:
            inventory["sourceBase"] = self.source_base
        self.inventory.write_text(
            json.dumps(inventory, indent=2) + "\n", encoding="utf-8"
        )

    def assert_inventory_shape(self, test: unittest.TestCase) -> None:
        inventory = json.loads(self.inventory.read_text(encoding="utf-8"))
        expected_keys = {"schemaVersion", "sessionId", "allowlist"}
        if self.source_base is not None:
            expected_keys.add("sourceBase")
        test.assertEqual(set(inventory), expected_keys)
        test.assertEqual(inventory["schemaVersion"], 1)
        test.assertEqual(inventory["sessionId"], "phase22-portable-session")
        if self.source_base is not None:
            test.assertEqual(inventory["sourceBase"], self.source_base)
        test.assertEqual(
            {entry["path"] for entry in inventory["allowlist"]}, set(self.expected)
        )
        for entry in inventory["allowlist"]:
            test.assertEqual(set(entry), {"path", "sha256", "baseSha256"})
            test.assertEqual(entry["sha256"], self.expected_hashes[entry["path"]])
            base = self.base_expected[entry["path"]]
            test.assertEqual(
                entry["baseSha256"], _sha256(base) if base is not None else None
            )
            test.assertFalse(Path(entry["path"]).is_absolute())
            test.assertEqual(len(entry["sha256"]), 64)
            test.assertTrue(
                all(character in "0123456789abcdef" for character in entry["sha256"])
            )
            if base is not None:
                test.assertEqual(len(entry["baseSha256"]), 64)
                test.assertTrue(
                    all(character in "0123456789abcdef" for character in entry["baseSha256"])
                )


class GitSessionFixture(SessionFixture):
    """Six stage worktrees with session-private runtime assets beside them."""

    stages = tuple(f"S{number}" for number in range(6))
    untracked_source = "S3/agent/untracked_experiment.py"

    def __init__(self, root: Path) -> None:
        super().__init__(root)
        self.base_prompt = b"SYSTEM_PROMPT = 'frozen checkpoint prompt'\n"
        self.repository = root / "stage-source-repository"
        self.repository.mkdir(parents=True, exist_ok=True)

        # The session root is not itself a Git repository. Stage roots are
        # independent worktrees; private runs/cases/CI records stay alongside
        # them and are not accidentally committed or copied as source.
        for stage in self.stages:
            stage_root = self.source / stage
            if stage_root.exists():
                shutil.rmtree(stage_root)

        self.base_expected = {
            relative: contents for relative, contents in self.expected.items()
        }
        self.base_expected["S3/agent/prompt.py"] = self.base_prompt
        self.base_expected[self.untracked_source] = None
        self._git("init", "-q", "-b", "main")
        self._git("config", "user.name", "phase22-session-fixture")
        self._git("config", "user.email", "phase22-session@example.invalid")

        # Build one frozen stage source. The prompt is tracked at its frozen
        # bytes; the selected untracked source is intentionally absent from
        # the commit and will only be restored from the archive.
        base_prompt_path = self.repository / "agent/prompt.py"
        base_prompt_path.parent.mkdir(parents=True, exist_ok=True)
        base_prompt_path.write_bytes(self.base_prompt)
        (self.repository / "README.md").write_text("frozen stage source\n", encoding="utf-8")
        self._git("add", "--", "agent/prompt.py", "README.md")
        self._git("commit", "-q", "-m", "frozen stage source")
        self.base_commit = self._git("rev-parse", "HEAD")
        self.source_base = {"kind": "git", "commit": self.base_commit}

        for stage in self.stages:
            self._git("worktree", "add", "-q", str(self.source / stage), self.base_commit)

        # The actual saved session has an edited tracked S3 prompt and a new
        # untracked source file. S5 remains the clean selected source copy.
        (self.source / "S3/agent/prompt.py").write_bytes(self.expected["S3/agent/prompt.py"])
        (self.source / self.untracked_source).write_bytes(self.expected[self.untracked_source])
        self._write_inventory()

        # Prepare the replacement worktree before restore. It has six clean
        # stage roots at the same frozen commit, and private selected records
        # prepopulated outside those Git worktrees with their base bytes.
        self.replacement.mkdir(parents=True, exist_ok=True)
        for stage in self.stages:
            self._git("worktree", "add", "-q", str(self.replacement / stage), self.base_commit)
        for relative, contents in self.base_expected.items():
            if relative.startswith("S3/") or relative.startswith("S5/"):
                continue
            if contents is None:
                continue
            destination = self.replacement / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(contents)

    def _git(self, *args: str, cwd: Path | None = None, preserve_whitespace: bool = False) -> str:
        completed = subprocess.run(
            ["git", *args],
            cwd=cwd or self.repository,
            capture_output=True,
            text=True,
            check=False,
            timeout=20,
        )
        if completed.returncode:
            raise AssertionError(
                f"git {' '.join(args)} failed ({completed.returncode}): {completed.stderr}"
            )
        return completed.stdout if preserve_whitespace else completed.stdout.strip()

    def stage_git(self, stage: str, *args: str) -> str:
        return self._git(
            *args,
            cwd=self.source / stage,
            preserve_whitespace=args[:2] == ("status", "--porcelain"),
        )

    def replacement_stage_git(self, stage: str, *args: str) -> str:
        return self._git(
            *args,
            cwd=self.replacement / stage,
            preserve_whitespace=args[:2] == ("status", "--porcelain"),
        )

    def private_records_are_outside_git(self, test: unittest.TestCase) -> None:
        test.assertTrue((self.source / "runs/s3-execution/execution.json").is_file())
        test.assertEqual(self.stage_git("S3", "ls-files"), "README.md\nagent/prompt.py")
        test.assertNotIn("runs/", self.stage_git("S3", "ls-files"))
        test.assertNotIn("reviewed-cases/", self.stage_git("S3", "ls-files"))

    def assert_clean_stage_worktrees(self, test: unittest.TestCase, *, replacement: bool) -> None:
        git = self.replacement_stage_git if replacement else self.stage_git
        root = self.replacement if replacement else self.source
        for stage in self.stages:
            test.assertEqual(git(stage, "status", "--porcelain"), "")
            test.assertEqual(git(stage, "rev-parse", "HEAD"), self.base_commit)
            test.assertTrue((root / stage / "agent/prompt.py").is_file())

    # Keep the test fixture's source-side status check explicit: the leading
    # space means the tracked prompt is modified in the worktree.
    def assert_saved_source_status(self, test: unittest.TestCase) -> None:
        status = self.stage_git("S3", "status", "--porcelain")
        test.assertIn(" M agent/prompt.py", status)
        test.assertIn("?? agent/untracked_experiment.py", status)



class SessionArchiveAcceptance(unittest.TestCase):
    """Use the real save/restore command with no cloud or credential boundary."""

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="phase22-session-")
        self.fixture = SessionFixture(Path(self.temp.name))

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _run(
        self,
        operation: str,
        *,
        directory: Path | None = None,
        archive: Path | None = None,
        inventory: Path | None = None,
    ) -> subprocess.CompletedProcess[str]:
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
        return subprocess.run(
            [
                "python3",
                CLI,
                operation,
                "--directory",
                str(directory or self.fixture.source),
                "--archive",
                str(archive or self.fixture.archive),
                "--inventory",
                str(inventory or self.fixture.inventory),
            ],
            cwd=ROOT,
            env=environment,
            capture_output=True,
            text=True,
            check=False,
            timeout=20,
        )

    def _save(self) -> subprocess.CompletedProcess[str]:
        completed = self._run("save")
        self.assertEqual(
            completed.returncode,
            0,
            f"save failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        self.assertTrue(self.fixture.archive.is_file(), "save did not create an archive")
        for relative, expected in self.fixture.expected.items():
            self.assertEqual((self.fixture.source / relative).read_bytes(), expected)
        return completed

    def _assert_round_trip_contents(self) -> None:
        for relative, expected in self.fixture.expected.items():
            restored = self.fixture.replacement / relative
            self.assertTrue(restored.is_file(), f"missing restored file: {relative}")
            self.assertEqual(restored.read_bytes(), expected, relative)
            self.assertEqual(_sha256(expected), self.fixture.expected_hashes[relative], relative)
            self.assertEqual(
                _sha256(restored.read_bytes()), self.fixture.expected_hashes[relative], relative
            )

    def test_round_trip_preserves_allowlisted_files_hashes_status_and_excludes_private_files(self):
        self.fixture.assert_inventory_shape(self)
        self._save()

        restored = self._run("restore", directory=self.fixture.replacement)
        self.assertEqual(
            restored.returncode,
            0,
            f"restore failed\nstdout:\n{restored.stdout}\nstderr:\n{restored.stderr}",
        )
        self._assert_round_trip_contents()

        unfinished = self.fixture.replacement / "runs/s4-execution/status.json"
        unfinished_record = json.loads(unfinished.read_text(encoding="utf-8"))
        self.assertEqual(unfinished_record["status"], "incomplete")
        self.assertEqual(unfinished_record["attempt"], 1)
        self.assertFalse(unfinished_record["relaunchRequested"])
        self.assertFalse(
            (self.fixture.replacement / "runs/s4-execution/result.json").exists(),
            "restore relaunched the unfinished execution",
        )

        for relative in self.fixture.private:
            self.assertFalse(
                (self.fixture.replacement / relative).exists(),
                f"private file was bulk-copied: {relative}",
            )

        # A replacement root uses the same relative session paths; no source
        # absolute path or environment-specific path is needed to restore it.
        self.assertNotEqual(self.fixture.source.resolve(), self.fixture.replacement.resolve())
        self.assertTrue((self.fixture.replacement / "S3/agent/prompt.py").is_file())

    def test_restore_applies_saved_edits_into_clean_matching_frozen_worktree(self):
        # Prepare the replacement worktree first at the exact frozen commit;
        # save the edited source second; restore into that clean worktree last.
        self.fixture = GitSessionFixture(Path(self.temp.name) / "git-replacement")
        self.fixture.assert_inventory_shape(self)
        self.fixture.private_records_are_outside_git(self)
        self.fixture.assert_saved_source_status(self)
        self.fixture.assert_clean_stage_worktrees(self, replacement=True)
        frozen_prompt = self.fixture.replacement / "S3/agent/prompt.py"
        self.assertEqual(frozen_prompt.read_bytes(), self.fixture.base_prompt)
        self.assertNotEqual(
            frozen_prompt.read_bytes(), self.fixture.expected["S3/agent/prompt.py"]
        )
        self.assertEqual(
            self.fixture.replacement_stage_git("S3", "status", "--porcelain"), ""
        )

        self._save()
        restored = self._run("restore", directory=self.fixture.replacement)
        self.assertEqual(
            restored.returncode,
            0,
            f"restore failed\nstdout:\n{restored.stdout}\nstderr:\n{restored.stderr}",
        )
        self._assert_round_trip_contents()
        self.assertEqual(
            self.fixture.replacement_stage_git("S3", "rev-parse", "HEAD"),
            self.fixture.base_commit,
        )
        replacement_status = self.fixture.replacement_stage_git(
            "S3", "status", "--porcelain"
        )
        self.assertIn(" M agent/prompt.py", replacement_status)
        self.assertIn("?? agent/untracked_experiment.py", replacement_status)

    def test_save_and_restore_reject_omitted_or_corrupt_selected_data(self):
        missing = SessionFixture(Path(self.temp.name) / "missing")
        missing_file = missing.source / "S3/agent/untracked_experiment.py"
        missing_file.unlink()
        omitted = self._run(
            "save",
            directory=missing.source,
            archive=missing.archive,
            inventory=missing.inventory,
        )
        self.assertNotEqual(omitted.returncode, 0)
        self.assertFalse(missing.archive.exists())
        self.assertRegex(
            omitted.stderr + omitted.stdout,
            r"(?i)missing|inventory|selected|not found|digest|checksum|hash|mismatch",
        )

        self._save()
        inventory = json.loads(self.fixture.inventory.read_text(encoding="utf-8"))
        selected = next(
            entry
            for entry in inventory["allowlist"]
            if entry["path"] == "S3/agent/prompt.py"
        )
        selected["sha256"] = "0" * 64
        self.fixture.inventory.write_text(
            json.dumps(inventory, indent=2) + "\n", encoding="utf-8"
        )
        corrupt_target = self.fixture.root / "corrupt-restore"
        corrupt = self._run("restore", directory=corrupt_target)
        self.assertNotEqual(corrupt.returncode, 0)
        self.assertRegex(
            corrupt.stderr + corrupt.stdout,
            r"(?i)corrupt|digest|archive|integrity|checksum|invalid|hash|mismatch",
        )
        self.assertFalse(
            (corrupt_target / "S3/agent/prompt.py").exists(),
            "corrupt archive partially restored selected data",
        )

    def test_restore_rejects_dirty_conflicting_content_without_overwrite(self):
        self.fixture = GitSessionFixture(Path(self.temp.name) / "git-dirty")
        self._save()
        dirty = self.fixture.replacement / "S3/agent/prompt.py"
        dirty.parent.mkdir(parents=True, exist_ok=True)
        dirty_bytes = b"local replacement edit must survive\n"
        dirty.write_bytes(dirty_bytes)
        local_only = self.fixture.replacement / "operator-notes.txt"
        local_only.write_text("do not remove local notes\n", encoding="utf-8")

        rejected = self._run("restore", directory=self.fixture.replacement)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertRegex(
            rejected.stderr + rejected.stdout,
            r"(?i)dirty|conflict|overwrite|modified|existing|occupied|non-empty|untracked",
        )
        self.assertEqual(dirty.read_bytes(), dirty_bytes)
        self.assertEqual(local_only.read_text(encoding="utf-8"), "do not remove local notes\n")
        self.assertIn(
            " M agent/prompt.py",
            self.fixture.replacement_stage_git("S3", "status", "--porcelain"),
        )

    def test_generated_inventory_preserves_reverted_local_commit_history(self):
        self.fixture = GitSessionFixture(Path(self.temp.name) / "git-history")
        stage = self.fixture.source / "S3"
        prompt = stage / "agent/prompt.py"
        original = prompt.read_bytes()
        prompt.write_bytes(b"temporary committed edit\n")
        subprocess.run(["git", "add", "agent/prompt.py"], cwd=stage, check=True)
        subprocess.run(["git", "commit", "-qm", "temporary edit"], cwd=stage, check=True)
        prompt.write_bytes(original)
        subprocess.run(["git", "add", "agent/prompt.py"], cwd=stage, check=True)
        subprocess.run(["git", "commit", "-qm", "revert temporary edit"], cwd=stage, check=True)

        inventory = talk_archive.generate_inventory(
            self.fixture.source,
            session_id="phase22-reverted-history",
            selected_untracked=["S3/agent/untracked_experiment.py"],
            source_base={"kind": "git", "commit": self.fixture.base_commit},
        )
        self.assertIn("S3/agent/prompt.py", {entry["path"] for entry in inventory["allowlist"]})
        inventory_path = self.fixture.root / "generated-inventory.json"
        inventory_path.write_text(json.dumps(inventory), encoding="utf-8")
        talk_archive.save_session(self.fixture.source, self.fixture.archive, inventory_path)
        talk_archive.restore_session(self.fixture.replacement, self.fixture.archive, inventory_path)
        self.assertEqual(
            self.fixture.replacement_stage_git("S3", "rev-parse", "HEAD"),
            self.fixture.stage_git("S3", "rev-parse", "HEAD"),
        )
        self.assertEqual(
            (self.fixture.replacement / "S3/agent/prompt.py").read_bytes(), original
        )

    def test_restore_preserves_an_executable_saved_edit(self):
        self.fixture = SessionFixture(Path(self.temp.name) / "executable")
        source = self.fixture.source / "S3/agent/prompt.py"
        replacement = self.fixture.replacement / "S3/agent/prompt.py"
        source.chmod(0o755)
        replacement.parent.mkdir(parents=True, exist_ok=True)
        replacement.write_bytes(source.read_bytes())
        replacement.chmod(0o644)
        talk_archive.save_session(self.fixture.source, self.fixture.archive, self.fixture.inventory)
        talk_archive.restore_session(self.fixture.replacement, self.fixture.archive, self.fixture.inventory)
        self.assertEqual(replacement.stat().st_mode & 0o777, 0o755)

    def test_staged_rename_inventory_uses_explicit_deletion_and_addition(self):
        self.fixture = GitSessionFixture(Path(self.temp.name) / "rename")
        stage = self.fixture.source / "S3"
        subprocess.run(
            ["git", "mv", "agent/prompt.py", "agent/renamed_prompt.py"],
            cwd=stage,
            check=True,
        )
        inventory = talk_archive.generate_inventory(
            self.fixture.source,
            session_id="phase22-rename",
            selected_untracked=["S3/agent/untracked_experiment.py"],
            source_base={"kind": "git", "commit": self.fixture.base_commit},
        )
        selected = {entry["path"]: entry for entry in inventory["allowlist"]}
        self.assertEqual(selected["S3/agent/prompt.py"]["state"], "deleted")
        self.assertEqual(selected["S3/agent/renamed_prompt.py"]["state"], "file")


if __name__ == "__main__":
    unittest.main()
