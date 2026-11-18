"""Acceptance tests for the six editable S0-S5 stage workspaces.

The fixture is deliberately a small, real Git repository.  It gives every
checkpoint a distinct commit, creates protected-looking frozen tags, and
advances ``demo-deploy`` one commit beyond the frozen S5 tag.  The launcher is
the product entry point under test; only the repository, checkpoint map, and
private session input are synthetic.

The test's small CLI/index contract is:

* ``checkpoints.json`` has ``schemaVersion: 1`` and a ``checkpoints`` map. Each
  S0-S5 entry names a tag and its expected peeled commit.
* ``session.json`` has ``schemaVersion: 1``, ``sessionId``, a per-stage
  ``stages`` identity map, and ``demoDeploy`` with the expected branch,
  qualified commit, candidate, and publication.
* ``prepare`` and ``status`` print JSON. A stage entry includes ``directory``,
  ``base`` (tag/branch and commit), ``dirty``, and ``identity``. Preparation
  persists the same stage records in ``session-index.json`` under the target
  directory. ``prepare --stage S3`` may select only the S3 checkpoint and its
  private inputs; it does not require an S5 branch/publication qualification.

Those fields are the minimum needed to prove the approved behavior.  The
fixture does not prescribe tag names, branch names other than the required
``demo-deploy`` branch, worktree implementation details, lock files, process
management, or any cloud/session service.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = ROOT / "scripts" / "talk-session.py"
STAGES = tuple(f"S{number}" for number in range(6))
FROZEN_STAGES = STAGES[:5]


class FixtureRepository:
    """Create a disposable Git repository with real refs and worktree state."""

    def __init__(self, root: Path) -> None:
        self.root = root / "fixture-repository"
        self.root.mkdir()
        self.checkpoints = self.root / "checkpoints.json"
        self.session = self.root / "session.json"
        self.destination = self.root / "stage-workspaces"
        self.commits: dict[str, str] = {}
        self.tags: dict[str, str] = {}
        self._git("init", "-q", "-b", "main")
        self._git("config", "user.name", "phase22-fixture")
        self._git("config", "user.email", "phase22-fixture@example.invalid")

        (self.root / "README.md").write_text("phase 22 fixture\n", encoding="utf-8")
        self._commit("fixture base")
        for stage in STAGES:
            (self.root / "checkpoint.txt").write_text(f"prepared {stage}\n", encoding="utf-8")
            self._commit(f"checkpoint {stage}")
            self.commits[stage] = self._rev_parse("HEAD")
            tag = f"demo-{stage.lower()}"
            self.tags[stage] = tag
            self._git("tag", "-a", tag, "-m", f"frozen {stage}")

        # S5 is a frozen software checkpoint, but the editable S5 workspace
        # follows the current qualified source on the long-lived branch.
        self._git("branch", "demo-deploy", self.commits["S5"])
        self._git("switch", "-q", "demo-deploy")
        (self.root / "qualified-source.txt").write_text(
            "qualified repaired source\n", encoding="utf-8"
        )
        self._commit("qualified repaired source on demo-deploy")
        self.demo_deploy_commit = self._rev_parse("HEAD")
        self._git("switch", "-q", "main")

        self.checkpoints.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "checkpoints": {
                        stage: {"tag": self.tags[stage], "commit": self.commits[stage]}
                        for stage in STAGES
                    },
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        self.session.write_text(
            json.dumps(self.session_input(), indent=2) + "\n", encoding="utf-8"
        )

    def session_input(self) -> dict[str, object]:
        return {
            "schemaVersion": 1,
            "sessionId": "phase22-fixture-session",
            "stages": {
                "S0": {"candidateId": "faulty", "inputId": "prepared-s0"},
                "S1": {"candidateId": "faulty", "inputId": "prepared-s1"},
                "S2": {"candidateId": "faulty", "inputId": "prepared-s2"},
                "S3": {"candidateId": "repaired", "inputId": "prepared-s3"},
                "S4": {"candidateId": "repaired", "inputId": "prepared-s4"},
                "S5": {
                    "candidateId": "repaired",
                    "inputId": "prepared-s5",
                    "publicationId": "prepared-repaired-publication",
                },
            },
            "demoDeploy": {
                "branch": "demo-deploy",
                "qualifiedCommit": self.demo_deploy_commit,
                "candidateId": "repaired",
                "publicationId": "prepared-repaired-publication",
            },
        }

    def _git(self, *args: str) -> str:
        return self._git_at(self.root, *args).strip()

    @staticmethod
    def _git_at(directory: Path, *args: str) -> str:
        completed = subprocess.run(
            ["git", *args],
            cwd=directory,
            capture_output=True,
            text=True,
            check=False,
        )
        if completed.returncode:
            raise AssertionError(
                f"git {' '.join(args)} failed ({completed.returncode}): {completed.stderr}"
            )
        return completed.stdout

    def _commit(self, message: str) -> None:
        self._git("add", "--", ".")
        self._git("commit", "-q", "-m", message)

    def _rev_parse(self, ref: str) -> str:
        return self._git("rev-parse", ref)

    def ref_state(self, *, extra_refs: tuple[str, ...] = ()) -> str:
        # Only refs whose movement would invalidate this preparation are
        # compared.  Other local presentation branches are valid
        # implementation details and are intentionally not treated as drift.
        refs = ["refs/heads/main", "refs/heads/demo-deploy"]
        refs.extend(f"refs/tags/{tag}" for tag in self.tags.values())
        refs.extend(extra_refs)
        return self._git(
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            *refs,
        )

    def worktree_paths(self) -> set[Path]:
        lines = self._git("worktree", "list", "--porcelain").splitlines()
        return {
            Path(line.removeprefix("worktree ")).resolve()
            for line in lines
            if line.startswith("worktree ")
        }


class FixtureValidity(unittest.TestCase):
    """Keep fixture failures distinct from missing/broken product behavior."""

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="phase22-fixture-")
        self.fixture = FixtureRepository(Path(self.temp.name))

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_real_fixture_has_distinct_frozen_commits_and_advancing_s5_branch(self):
        self.assertEqual(len(set(self.fixture.commits.values())), len(STAGES))
        for stage in STAGES:
            self.assertEqual(
                self.fixture.commits[stage],
                self.fixture._rev_parse(f"refs/tags/{self.fixture.tags[stage]}^{{commit}}"),
            )
        self.assertNotEqual(self.fixture.demo_deploy_commit, self.fixture.commits["S5"])
        self.assertEqual(self.fixture.demo_deploy_commit, self.fixture._rev_parse("demo-deploy"))
        self.assertEqual(self.fixture._rev_parse("main"), self.fixture.commits["S5"])
        # The checkpoint/session inputs intentionally live beside the fixture
        # repository as untracked operator inputs.  The source tree itself is
        # clean (the property preparation relies on).
        self.assertEqual(self.fixture._git("diff"), "")
        self.assertEqual(self.fixture._git("diff", "--cached"), "")


class StageWorkspaceAcceptance(unittest.TestCase):
    """Exercise preparation through the checked-out launcher and real Git."""

    maxDiff = None

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="phase22-stage-")
        self.fixture = FixtureRepository(Path(self.temp.name))

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _run(self, *args: str) -> subprocess.CompletedProcess[str]:
        # The launcher path is absolute, while cwd is the disposable Git repo;
        # this exercises the public command in the same shape as a checkout.
        return subprocess.run(
            [sys.executable, str(LAUNCHER), *args],
            cwd=self.fixture.root,
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )

    def _prepare(
        self,
        *,
        checkpoints: Path | None = None,
        session: Path | None = None,
        destination: Path | None = None,
        stage: str | None = None,
    ) -> dict[str, object]:
        command = [
            "prepare",
            "--checkpoints",
            str(checkpoints or self.fixture.checkpoints),
            "--session",
            str(session or self.fixture.session),
            "--directory",
            str(destination or self.fixture.destination),
        ]
        if stage is not None:
            command.extend(("--stage", stage))
        completed = self._run(*command)
        self.assertEqual(
            completed.returncode,
            0,
            f"prepare failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        try:
            return json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            self.fail(f"prepare did not print JSON: {exc}\n{completed.stdout}")

    def _prepare_rejected(
        self,
        *,
        checkpoints: Path | None = None,
        session: Path | None = None,
        destination: Path | None = None,
        stage: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        command = [
            "prepare",
            "--checkpoints",
            str(checkpoints or self.fixture.checkpoints),
            "--session",
            str(session or self.fixture.session),
            "--directory",
            str(destination or self.fixture.destination),
        ]
        if stage is not None:
            command.extend(("--stage", stage))
        completed = self._run(*command)
        self.assertNotEqual(
            completed.returncode,
            0,
            f"invalid preparation unexpectedly succeeded: {completed.stdout}",
        )
        return completed

    def _status(
        self,
        stage: str,
        *,
        destination: Path | None = None,
    ) -> dict[str, object]:
        completed = self._run(
            "status",
            "--directory",
            str(destination or self.fixture.destination),
            "--stage",
            stage,
        )
        self.assertEqual(
            completed.returncode,
            0,
            f"status {stage} failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        try:
            return json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            self.fail(f"status {stage} did not print JSON: {exc}\n{completed.stdout}")

    def _write_json(self, path: Path, value: object) -> Path:
        path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
        return path

    def _assert_stage_identity(
        self,
        stage: str,
        entry: dict[str, object],
        *,
        destination: Path | None = None,
        expected_identity: dict[str, object] | None = None,
    ) -> None:
        expected_directory = ((destination or self.fixture.destination) / stage).resolve()
        self.assertEqual(Path(str(entry["directory"])).resolve(), expected_directory)
        self.assertEqual(entry["stage"], stage)
        identity = entry["identity"]
        self.assertIsInstance(identity, dict)
        expected = expected_identity or self.fixture.session_input()["stages"][stage]
        for key, value in expected.items():
            self.assertEqual(identity.get(key), value)

    def _s3_direct_inputs(self) -> tuple[Path, Path]:
        """Return a maintained S3 generation and private direct-entry inputs."""

        generation = "phase22-s3-generation-2"
        generation_tag = "demo-s3-generation-2"
        self.fixture._git(
            "tag",
            "-a",
            generation_tag,
            "-m",
            generation,
            self.fixture.commits["S3"],
        )
        # The maintained map names its own generation/tag and pins its peeled
        # commit; it must not follow a retargeted remote-style tag alias.
        self.fixture._git("tag", "-f", self.fixture.tags["S3"], self.fixture.commits["S4"])
        mapping = {
            "schemaVersion": 1,
            "generation": generation,
            "checkpoints": {
                "S3": {
                    "tag": generation_tag,
                    "commit": self.fixture.commits["S3"],
                }
            },
        }
        mapping_path = self._write_json(self.fixture.root / "checkpoints-s3-generation-2.json", mapping)
        session = {
            "schemaVersion": 1,
            "sessionId": "phase22-s3-direct-session",
            "generation": generation,
            "stages": {
                "S3": {
                    "candidateId": "repaired",
                    "inputId": "prepared-s3-direct",
                }
            },
        }
        session_path = self._write_json(self.fixture.root / "session-s3-direct.json", session)
        return mapping_path, session_path

    def test_prepare_creates_exactly_six_editable_worktrees_and_inspectable_identity(self):
        before_refs = self.fixture.ref_state()
        payload = self._prepare()
        self.assertEqual(payload["schemaVersion"], 1)
        self.assertEqual(payload["sessionId"], "phase22-fixture-session")
        stages = payload["stages"]
        self.assertIsInstance(stages, dict)
        self.assertEqual(set(stages), set(STAGES))

        # Count registered Git worktrees rather than every directory below the
        # session root: saved inputs, run records, or an archive may coexist
        # beside the six editable stage roots.
        stage_worktrees = {
            path.name
            for path in self.fixture.worktree_paths()
            if path.parent == self.fixture.destination.resolve()
        }
        self.assertEqual(stage_worktrees, set(STAGES))
        self.assertEqual(before_refs, self.fixture.ref_state())

        for stage in STAGES:
            entry = stages[stage]
            self.assertIsInstance(entry, dict)
            self._assert_stage_identity(stage, entry)
            workspace = self.fixture.destination / stage
            self.assertTrue((workspace / ".git").exists(), f"{stage} is not a Git worktree")
            self.assertEqual(self.fixture._git_at(workspace, "status", "--porcelain"), "")
            expected_commit = (
                self.fixture.commits[stage]
                if stage in FROZEN_STAGES
                else self.fixture.demo_deploy_commit
            )
            self.assertEqual(self.fixture._git_at(workspace, "rev-parse", "HEAD").strip(), expected_commit)
            base = entry["base"]
            self.assertIsInstance(base, dict)
            self.assertEqual(base["commit"], expected_commit)
            if stage == "S5":
                self.assertEqual(base["kind"], "branch")
                self.assertEqual(base["name"], "demo-deploy")
                self.assertEqual(base["frozenTag"], self.fixture.tags["S5"])
                self.assertEqual(base["frozenCommit"], self.fixture.commits["S5"])
                self.assertEqual(self.fixture._git_at(workspace, "branch", "--show-current").strip(), "demo-deploy")

        index_path = self.fixture.destination / "session-index.json"
        self.assertTrue(index_path.is_file(), "prepare must leave a recoverable session index")
        index = json.loads(index_path.read_text(encoding="utf-8"))
        self.assertEqual(index["schemaVersion"], 1)
        self.assertEqual(index["sessionId"], "phase22-fixture-session")
        self.assertEqual(set(index["stages"]), set(STAGES))
        for stage in STAGES:
            self._assert_stage_identity(stage, index["stages"][stage])

    def test_direct_s3_entry_uses_maintained_pinned_generation_without_s5_qualification(self):
        """S3 can start alone while a full session honestly reports S5 unavailable."""

        mapping_path, direct_session_path = self._s3_direct_inputs()
        direct_mapping = json.loads(mapping_path.read_text(encoding="utf-8"))
        direct_session = json.loads(direct_session_path.read_text(encoding="utf-8"))
        self.assertEqual(set(direct_session["stages"]), {"S3"})
        self.assertNotIn("demoDeploy", direct_session)
        direct_destination = self.fixture.root / "direct-s3"
        generation_ref = f"refs/tags/{direct_mapping['checkpoints']['S3']['tag']}"
        before_refs = self.fixture.ref_state(extra_refs=(generation_ref,))

        payload = self._prepare(
            checkpoints=mapping_path,
            session=direct_session_path,
            destination=direct_destination,
            stage="S3",
        )
        self.assertEqual(payload["schemaVersion"], 1)
        self.assertEqual(payload["sessionId"], "phase22-s3-direct-session")
        self.assertEqual(set(payload["stages"]), {"S3"})
        s3_entry = payload["stages"]["S3"]
        self._assert_stage_identity(
            "S3",
            s3_entry,
            destination=direct_destination,
            expected_identity=direct_session["stages"]["S3"],
        )
        self.assertEqual(s3_entry["base"]["commit"], self.fixture.commits["S3"])

        stage_worktrees = {
            path.name
            for path in self.fixture.worktree_paths()
            if path.parent == direct_destination.resolve()
        }
        self.assertEqual(stage_worktrees, {"S3"})
        self.assertNotIn(
            "branch refs/heads/demo-deploy",
            self.fixture._git("worktree", "list", "--porcelain"),
            "direct S3 entry must not check out the S5 demo-deploy branch",
        )
        s3_workspace = direct_destination / "S3"
        self.assertEqual(self.fixture._git_at(s3_workspace, "rev-parse", "HEAD").strip(), self.fixture.commits["S3"])
        self.assertEqual(self.fixture._git_at(s3_workspace, "status", "--porcelain"), "")
        direct_index = json.loads(
            (direct_destination / "session-index.json").read_text(encoding="utf-8")
        )
        self.assertEqual(set(direct_index["stages"]), {"S3"})
        # The prepared source is editable even though no earlier stage or
        # live event was entered.
        (s3_workspace / "checkpoint.txt").write_text("direct S3 edit\n", encoding="utf-8")
        self.assertIn(
            "checkpoint.txt",
            self.fixture._git_at(s3_workspace, "status", "--porcelain"),
        )
        self.assertEqual(before_refs, self.fixture.ref_state(extra_refs=(generation_ref,)))

        # Keep the full map maintained, but remove its usable S5 qualification.
        # The old S3 tag is intentionally retargeted above; this map carries the
        # new generation's S3 pin and therefore does not silently follow it.
        full_mapping = json.loads(self.fixture.checkpoints.read_text(encoding="utf-8"))
        full_mapping["checkpoints"]["S3"] = direct_mapping["checkpoints"]["S3"]
        full_mapping["generation"] = "phase22-s3-generation-2"
        full_mapping_path = self._write_json(self.fixture.root / "checkpoints-full-generation-2.json", full_mapping)
        missing_s5_session = self.fixture.session_input()
        del missing_s5_session["demoDeploy"]
        missing_s5_session["sessionId"] = "phase22-full-session-without-s5-qualification"
        missing_s5_session_path = self._write_json(
            self.fixture.root / "session-full-without-s5.json", missing_s5_session
        )
        full_destination = self.fixture.root / "full-session"
        rejected = self._prepare_rejected(
            checkpoints=full_mapping_path,
            session=missing_s5_session_path,
            destination=full_destination,
        )
        self.assertRegex(
            rejected.stderr + rejected.stdout,
            r"(?i)S5|qualified|demo-deploy|publication|unready",
        )
        self.assertEqual(before_refs, self.fixture.ref_state(extra_refs=(generation_ref,)))

    def test_s5_status_keeps_frozen_anchor_and_reports_a_committed_branch_advance(self):
        self._prepare()
        s5_workspace = self.fixture.destination / "S5"
        (s5_workspace / "participant-regression.txt").write_text(
            "prepared regression\n", encoding="utf-8"
        )
        self.fixture._git_at(s5_workspace, "add", "--", "participant-regression.txt")
        self.fixture._git_at(s5_workspace, "commit", "-q", "-m", "participant regression")

        status = self._status("S5")
        self.assertEqual(status["base"]["commit"], self.fixture.demo_deploy_commit)
        self.assertEqual(status["base"]["frozenTag"], self.fixture.tags["S5"])
        self.assertEqual(status["base"]["frozenCommit"], self.fixture.commits["S5"])
        self.assertNotEqual(status["currentCommit"], status["base"]["commit"])
        self.assertFalse(status["baseMatchesCurrent"])
        self.assertFalse(status["dirty"])

    def test_status_resolves_replacement_root_instead_of_archived_absolute_stage_path(self):
        self._prepare()
        replacement = self.fixture.root / "replacement-session"
        replacement.mkdir()
        shutil.copy2(
            self.fixture.destination / "session-index.json",
            replacement / "session-index.json",
        )
        self.fixture._git(
            "worktree",
            "add",
            "--quiet",
            str(replacement / "S3"),
            f"refs/tags/{self.fixture.tags['S3']}",
        )
        try:
            # The original A path is dirty; the replacement S3 path is clean.
            # A status implementation that trusts the archived absolute path
            # reports the wrong directory and dirty state.
            (self.fixture.destination / "S3" / "checkpoint.txt").write_text(
                "old session edit\n", encoding="utf-8"
            )
            status = self._status("S3", destination=replacement)
            self.assertEqual(
                Path(status["directory"]).resolve(), (replacement / "S3").resolve()
            )
            self.assertFalse(status["dirty"])
            self.assertEqual(
                self.fixture._git_at(replacement / "S3", "status", "--porcelain"), ""
            )
        finally:
            self.fixture._git("worktree", "remove", "--force", str(replacement / "S3"))

    def test_status_reports_dirty_stage_and_retry_does_not_replace_saved_or_inflight_state(self):
        self._prepare()
        edited = self.fixture.destination / "S2" / "checkpoint.txt"
        edited.write_text("audience saved S2 edit\n", encoding="utf-8")
        untracked = self.fixture.destination / "S2" / "audience-notes.txt"
        untracked.write_text("keep this saved edit\n", encoding="utf-8")
        inflight = self.fixture.destination / "runs" / "s3-execution" / "status.json"
        inflight.parent.mkdir(parents=True)
        inflight.write_text('{"status":"running","executionId":"s3-live"}\n', encoding="utf-8")
        before_refs = self.fixture.ref_state()

        s2 = self._status("S2")
        self._assert_stage_identity("S2", s2)
        self.assertTrue(s2["dirty"])
        self.assertTrue(
            any("checkpoint.txt" in str(item) for item in s2.get("savedDifferences", [])),
            s2,
        )
        self.assertTrue(
            any("audience-notes.txt" in str(item) for item in s2.get("savedDifferences", [])),
            s2,
        )
        s3 = self._status("S3")
        self._assert_stage_identity("S3", s3)
        self.assertFalse(s3["dirty"])

        retry = self._run(
            "prepare",
            "--checkpoints",
            str(self.fixture.checkpoints),
            "--session",
            str(self.fixture.session),
            "--directory",
            str(self.fixture.destination),
        )
        if retry.returncode:
            self.assertRegex(retry.stderr + retry.stdout, r"(?i)dirty|modified|conflict|saved")
        else:
            # Reopening an existing session is also valid when it reports the
            # saved differences honestly instead of replacing the worktree.
            json.loads(retry.stdout)
        self.assertEqual(before_refs, self.fixture.ref_state())
        self.assertEqual(edited.read_text(encoding="utf-8"), "audience saved S2 edit\n")
        self.assertEqual(untracked.read_text(encoding="utf-8"), "keep this saved edit\n")
        self.assertEqual(
            inflight.read_text(encoding="utf-8"),
            '{"status":"running","executionId":"s3-live"}\n',
        )
        self._assert_stage_identity("S2", self._status("S2"))
        self._assert_stage_identity("S3", self._status("S3"))

    def test_missing_or_wrong_tag_rejects_without_moving_refs_and_allows_safe_retry(self):
        for variant in ("missing", "wrong"):
            with self.subTest(variant=variant):
                mapping = json.loads(self.fixture.checkpoints.read_text(encoding="utf-8"))
                if variant == "missing":
                    mapping["checkpoints"]["S2"]["tag"] = "does-not-exist"
                else:
                    wrong_tag = "demo-wrong-s2"
                    self.fixture._git("tag", "-a", wrong_tag, "-m", "wrong checkpoint", self.fixture.commits["S1"])
                    mapping["checkpoints"]["S2"]["tag"] = wrong_tag
                mapping_path = self._write_json(self.fixture.root / f"checkpoints-{variant}.json", mapping)
                destination = self.fixture.root / f"retry-{variant}"
                tracked_extra = (f"refs/tags/{wrong_tag}",) if variant == "wrong" else ()
                before_refs = self.fixture.ref_state(extra_refs=tracked_extra)
                rejected = self._prepare_rejected(checkpoints=mapping_path, destination=destination)
                self.assertRegex(rejected.stderr + rejected.stdout, r"(?i)S2|checkpoint|tag")
                self.assertEqual(before_refs, self.fixture.ref_state(extra_refs=tracked_extra))

                # A failed preparation must not make the same destination
                # unusable after the operator fixes the selected input.
                self._prepare(destination=destination)
                stage_worktrees = {
                    path.name
                    for path in self.fixture.worktree_paths()
                    if path.parent == destination.resolve()
                }
                self.assertEqual(stage_worktrees, set(STAGES))
                self.assertEqual(before_refs, self.fixture.ref_state(extra_refs=tracked_extra))
                for stage in STAGES:
                    self.fixture._git("worktree", "remove", "--force", str(destination / stage))

    def test_full_s5_requires_its_frozen_tag_while_s3_direct_entry_stays_independent(self):
        for variant in ("missing", "retargeted"):
            with self.subTest(variant=variant):
                mapping = json.loads(self.fixture.checkpoints.read_text(encoding="utf-8"))
                tracked_extra: tuple[str, ...] = ()
                if variant == "missing":
                    mapping["checkpoints"]["S5"]["tag"] = "demo-s5-missing"
                else:
                    wrong_tag = "demo-s5-retargeted"
                    self.fixture._git(
                        "tag", "-a", wrong_tag, "-m", "retargeted S5", self.fixture.commits["S4"]
                    )
                    mapping["checkpoints"]["S5"]["tag"] = wrong_tag
                    tracked_extra = (f"refs/tags/{wrong_tag}",)
                mapping_path = self._write_json(
                    self.fixture.root / f"checkpoints-{variant}-s5.json", mapping
                )
                before_refs = self.fixture.ref_state(extra_refs=tracked_extra)
                rejected = self._prepare_rejected(checkpoints=mapping_path)
                self.assertRegex(rejected.stderr + rejected.stdout, r"(?i)S5|checkpoint|tag|missing|peeled|commit")
                self.assertEqual(before_refs, self.fixture.ref_state(extra_refs=tracked_extra))

        s3_mapping, s3_session = self._s3_direct_inputs()
        self._prepare(
            checkpoints=s3_mapping,
            session=s3_session,
            destination=self.fixture.root / "independent-s3",
            stage="S3",
        )

    def test_wrong_or_foreign_s5_branch_or_candidate_rejects_without_ref_changes(self):
        for variant in ("branch", "candidate"):
            with self.subTest(variant=variant):
                session = copy.deepcopy(self.fixture.session_input())
                if variant == "branch":
                    self.fixture._git("branch", "foreign", self.fixture.demo_deploy_commit)
                    session["demoDeploy"]["branch"] = "foreign"
                    session["stages"]["S5"]["branch"] = "foreign"
                else:
                    session["demoDeploy"]["candidateId"] = "faulty"
                    session["stages"]["S5"]["candidateId"] = "faulty"
                session_path = self._write_json(self.fixture.root / f"session-{variant}.json", session)
                destination = self.fixture.root / f"invalid-{variant}"
                before_refs = self.fixture.ref_state()
                rejected = self._prepare_rejected(session=session_path, destination=destination)
                self.assertRegex(rejected.stderr + rejected.stdout, r"(?i)S5|demo-deploy|branch|candidate|repaired")
                self.assertEqual(before_refs, self.fixture.ref_state())

    def test_prior_s5_worktree_ownership_blocks_then_allows_a_clean_retry(self):
        prior = self.fixture.root / "prior-s5-owner"
        self.fixture._git("worktree", "add", "-q", str(prior), "demo-deploy")
        before_refs = self.fixture.ref_state()
        try:
            rejected = self._prepare_rejected()
            self.assertRegex(rejected.stderr + rejected.stdout, r"(?i)demo-deploy|already checked out|worktree|conflict")
            self.assertEqual(before_refs, self.fixture.ref_state())
            self.assertNotIn((self.fixture.destination / "S5").resolve(), self.fixture.worktree_paths())
        finally:
            self.fixture._git("worktree", "remove", "--force", str(prior))

        self._prepare()
        self.assertEqual(
            self.fixture._git_at(
                self.fixture.destination / "S5", "branch", "--show-current"
            ).strip(),
            "demo-deploy",
        )
        self.assertEqual(before_refs, self.fixture.ref_state())


if __name__ == "__main__":
    unittest.main()
