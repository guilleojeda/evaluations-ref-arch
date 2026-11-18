#!/usr/bin/env python3
"""Prepare and inspect the editable S0-S5 talk workspaces.

The command deliberately owns only local Git/session preparation.  It does not
invoke AWS, the controller, an agent, a model, deployment, or a live event.
Portable session save/restore is registered by the separate ``talk_archive``
module when that module is available.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any, Mapping


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

STAGES = tuple(f"S{number}" for number in range(6))
S5 = "S5"
INDEX_NAME = "session-index.json"
SCHEMA_VERSION = 1
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")


class WorkspaceError(RuntimeError):
    """A user-correctable preparation/status error."""


class GitError(WorkspaceError):
    """A Git command failed without changing the requested contract."""

    def __init__(self, args: tuple[str, ...], returncode: int, stderr: str) -> None:
        self.args_used = args
        self.returncode = returncode
        self.stderr = stderr.strip()
        detail = f": {self.stderr}" if self.stderr else ""
        super().__init__(f"git {' '.join(args)} failed ({returncode}){detail}")


def _run_git(repository: Path, *args: str, preserve_whitespace: bool = False) -> str:
    completed = subprocess.run(
        ["git", *args],
        cwd=repository,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode:
        raise GitError(tuple(args), completed.returncode, completed.stderr)
    return completed.stdout if preserve_whitespace else completed.stdout.strip()


def _git(repository: Path, *args: str) -> str:
    return _run_git(repository, *args)


def _git_status(repository: Path) -> list[str]:
    output = _run_git(repository, "status", "--porcelain", preserve_whitespace=True)
    return output.splitlines()


def _read_json(path: Path, label: str) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise WorkspaceError(f"{label} is unavailable: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise WorkspaceError(f"{label} is not valid UTF-8 JSON: {path}") from exc
    if not isinstance(value, dict):
        raise WorkspaceError(f"{label} must be a JSON object: {path}")
    return value


def _write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(
            json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _stage_error(stage: str, message: str) -> WorkspaceError:
    return WorkspaceError(f"{stage}: {message}")


def _validate_commit(value: Any, label: str) -> str:
    if not isinstance(value, str) or not COMMIT_RE.fullmatch(value):
        raise WorkspaceError(f"{label} must be a 40-character lowercase Git commit")
    return value


def _validate_stage_map(raw: Any, label: str) -> dict[str, dict[str, Any]]:
    if not isinstance(raw, dict):
        raise WorkspaceError(f"{label} must be an object")
    result: dict[str, dict[str, Any]] = {}
    for stage, value in raw.items():
        if stage not in STAGES:
            raise WorkspaceError(f"{label} contains unknown stage: {stage}")
        if not isinstance(value, dict):
            raise _stage_error(stage, f"{label} entry must be an object")
        result[stage] = value
    return result


def _validate_s5_revision_consistency(
    document: Mapping[str, Any],
    stages: Mapping[str, Mapping[str, Any]],
    qualified_commit: str,
) -> None:
    """Reject contradictory rich publication/source identities.

    The minimal session carrier only needs ``qualifiedCommit``.  Verified
    bindings may additionally carry source, remote, publication, and receipt
    revisions; whenever those fields are present they must agree with the
    qualified branch commit.  This check intentionally does not depend on an
    optional stage publication identity being present.
    """

    scopes: list[tuple[str, Any]] = [
        ("demoDeploy", document.get("demoDeploy")),
        ("publication", document.get("publication")),
        ("S5 liveReleaseBinding", stages.get(S5, {}).get("liveReleaseBinding")),
    ]
    qualification = document.get("qualification")
    if isinstance(qualification, dict):
        scopes.append(("qualification", qualification))
        receipt = qualification.get("receipt")
        if isinstance(receipt, dict):
            scopes.append(("qualification.receipt", receipt))
    for label, value in scopes:
        if value is None:
            continue
        if not isinstance(value, dict):
            raise WorkspaceError(f"S5 qualification {label} must be an object")
        for field in ("qualifiedCommit", "sourceRevision", "remoteTip"):
            if field not in value or value[field] is None:
                continue
            observed = _validate_commit(value[field], f"S5 qualification {label}.{field}")
            if observed != qualified_commit:
                raise WorkspaceError(
                    "S5 qualification identity conflict: "
                    f"{label}.{field}={observed} differs from qualifiedCommit={qualified_commit}"
                )


def _load_checkpoints(
    path: Path, requested: tuple[str, ...]
) -> tuple[dict[str, dict[str, Any]], Any]:
    document = _read_json(path, "checkpoint map")
    if document.get("schemaVersion") != SCHEMA_VERSION:
        raise WorkspaceError("checkpoint map schemaVersion must be 1")
    generation = document.get("generation")
    if generation is not None and (not isinstance(generation, str) or not generation.strip()):
        raise WorkspaceError("checkpoint map generation must be a non-empty string")
    checkpoints = _validate_stage_map(document.get("checkpoints"), "checkpoint map")
    missing = [stage for stage in requested if stage not in checkpoints]
    if missing:
        raise WorkspaceError(
            "checkpoint map is missing requested stage(s): " + ", ".join(missing)
        )
    selected: dict[str, dict[str, Any]] = {}
    for stage in requested:
        entry = checkpoints[stage]
        tag = entry.get("tag")
        if not isinstance(tag, str) or not tag or tag.startswith("-") or any(
            character.isspace() for character in tag
        ):
            raise _stage_error(stage, "checkpoint tag is invalid")
        commit = _validate_commit(entry.get("commit"), f"{stage} checkpoint commit")
        selected[stage] = {"tag": tag, "commit": commit}
    return selected, generation


def _load_session(path: Path, requested: tuple[str, ...]) -> dict[str, Any]:
    document = _read_json(path, "session input")
    if document.get("schemaVersion") != SCHEMA_VERSION:
        raise WorkspaceError("session input schemaVersion must be 1")
    session_id = document.get("sessionId")
    if not isinstance(session_id, str) or not session_id.strip():
        raise WorkspaceError("session input requires a non-empty sessionId")
    generation = document.get("generation")
    if generation is not None and (not isinstance(generation, str) or not generation.strip()):
        raise WorkspaceError("session input generation must be a non-empty string")
    stages = _validate_stage_map(document.get("stages"), "session input stages")
    for stage in requested:
        if stage not in stages:
            raise _stage_error(stage, "session input is missing its private stage inputs")
        identity = stages[stage]
        if not identity.get("candidateId") or not identity.get("inputId"):
            raise _stage_error(stage, "private inputs require candidateId and inputId")
    if S5 in requested:
        qualified = document.get("demoDeploy")
        if not isinstance(qualified, dict):
            raise WorkspaceError("S5 is unready: session input lacks demo-deploy qualification")
        branch = qualified.get("branch")
        if branch != "demo-deploy":
            raise WorkspaceError("S5 is unready: qualified branch must be demo-deploy")
        _validate_commit(qualified.get("qualifiedCommit"), "S5 qualifiedCommit")
        if not qualified.get("candidateId") or not qualified.get("publicationId"):
            raise WorkspaceError(
                "S5 is unready: qualification requires candidateId and publicationId"
            )
        if qualified.get("candidateId") != "repaired":
            raise WorkspaceError("S5 is unready: qualified candidate must be repaired")
        stage_identity = stages[S5]
        if stage_identity.get("candidateId") != qualified.get("candidateId"):
            raise WorkspaceError("S5 is unready: stage candidate differs from qualification")
        if stage_identity.get("publicationId") not in (None, qualified.get("publicationId")):
            raise WorkspaceError("S5 is unready: stage publication differs from qualification")
        _validate_s5_revision_consistency(document, stages, qualified["qualifiedCommit"])
    return document


def _repository_root() -> Path:
    try:
        return Path(_git(Path.cwd(), "rev-parse", "--show-toplevel")).resolve()
    except WorkspaceError as exc:
        raise WorkspaceError("prepare/status must run inside a Git repository") from exc


def _tag_commit(repository: Path, stage: str, tag: str) -> str:
    try:
        tag_type = _git(repository, "cat-file", "-t", f"refs/tags/{tag}")
        if tag_type != "tag":
            raise _stage_error(stage, f"checkpoint ref is not an annotated tag: {tag}")
        return _git(repository, "rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}")
    except WorkspaceError as exc:
        raise _stage_error(stage, f"checkpoint tag is missing or unusable: {tag}") from exc


def _branch_commit(repository: Path, branch: str) -> str:
    try:
        return _git(repository, "rev-parse", "--verify", f"refs/heads/{branch}^{{commit}}")
    except WorkspaceError as exc:
        raise WorkspaceError(f"S5 is unready: branch is missing or unusable: {branch}") from exc


def _parse_worktrees(repository: Path) -> list[dict[str, str]]:
    output = _git(repository, "worktree", "list", "--porcelain")
    records: list[dict[str, str]] = []
    current: dict[str, str] = {}
    for line in output.splitlines() + [""]:
        if not line:
            if current:
                records.append(current)
                current = {}
            continue
        key, _, value = line.partition(" ")
        current[key] = value
    return records


def _worktree_for_path(records: list[dict[str, str]], path: Path) -> dict[str, str] | None:
    expected = path.resolve()
    for record in records:
        if Path(record.get("worktree", "")).resolve() == expected:
            return record
    return None


def _branch_owner(records: list[dict[str, str]], branch: str) -> dict[str, str] | None:
    ref = f"refs/heads/{branch}"
    for record in records:
        if record.get("branch") == ref:
            return record
    return None


def _preflight_stage(
    repository: Path,
    destination: Path,
    stage: str,
    checkpoint: dict[str, Any],
    qualified_commit: str | None,
    records: list[dict[str, str]],
) -> dict[str, Any]:
    stage_path = (destination / stage).resolve()
    expected_commit = qualified_commit if stage == S5 else checkpoint["commit"]
    existing = _worktree_for_path(records, stage_path)
    if existing is not None:
        try:
            current_commit = _git(stage_path, "rev-parse", "HEAD")
        except WorkspaceError as exc:
            raise _stage_error(stage, "existing worktree cannot be inspected") from exc
        if current_commit != expected_commit:
            raise _stage_error(
                stage,
                f"existing worktree commit {current_commit} differs from expected {expected_commit}",
            )
        differences = _git_status(stage_path)
        if differences:
            raise _stage_error(
                stage,
                "existing worktree is dirty; saved edits were not overwritten: "
                + ", ".join(differences),
            )
        if stage == S5 and existing.get("branch") != "refs/heads/demo-deploy":
            raise _stage_error(stage, "existing worktree does not own demo-deploy")
        return {"path": stage_path, "created": False}
    if stage_path.exists():
        try:
            nonempty = any(stage_path.iterdir())
        except OSError as exc:
            raise _stage_error(stage, f"existing path cannot be inspected: {stage_path}") from exc
        if nonempty:
            raise _stage_error(stage, f"existing path conflicts with workspace: {stage_path}")
    if stage == S5:
        owner = _branch_owner(records, "demo-deploy")
        if owner is not None:
            owner_path = owner.get("worktree", "unknown")
            raise WorkspaceError(
                f"S5 is unready: demo-deploy is already checked out by {owner_path}"
            )
    return {"path": stage_path, "created": True}


def _stage_entry(
    stage: str,
    stage_path: Path,
    checkpoint: dict[str, Any],
    identity: Mapping[str, Any],
    commit: str,
) -> dict[str, Any]:
    if stage == S5:
        base = {
            "kind": "branch",
            "name": "demo-deploy",
            "commit": commit,
            "frozenTag": checkpoint["tag"],
            "frozenCommit": checkpoint["commit"],
        }
    else:
        base = {"kind": "tag", "name": checkpoint["tag"], "commit": commit}
    return {
        "stage": stage,
        "directory": str(stage_path),
        "base": base,
        "dirty": False,
        "savedDifferences": [],
        "identity": copy.deepcopy(dict(identity)),
    }


def _identity_matches(actual: Any, expected: Mapping[str, Any]) -> bool:
    if not isinstance(actual, dict):
        return False
    return all(actual.get(key) == value for key, value in expected.items())


def _load_existing_index(destination: Path) -> dict[str, Any] | None:
    path = destination / INDEX_NAME
    if not path.exists():
        return None
    index = _read_json(path, "existing session index")
    if index.get("schemaVersion") != SCHEMA_VERSION:
        raise WorkspaceError("existing session index schemaVersion must be 1")
    _validate_stage_map(index.get("stages"), "existing session index stages")
    return index


def _prepare(args: argparse.Namespace) -> dict[str, Any]:
    repository = _repository_root()
    destination = Path(args.directory).expanduser().resolve()
    requested = (args.stage,) if args.stage else STAGES
    checkpoints, checkpoint_generation = _load_checkpoints(
        Path(args.checkpoints).expanduser().resolve(), requested
    )
    session = _load_session(Path(args.session).expanduser().resolve(), requested)
    if (
        checkpoint_generation is not None
        and session.get("generation") is not None
        and checkpoint_generation != session["generation"]
    ):
        raise WorkspaceError("checkpoint map and session input belong to different generations")
    qualified_commit: str | None = None
    if S5 in requested:
        qualified_commit = _branch_commit(repository, "demo-deploy")
        expected_qualified = session["demoDeploy"]["qualifiedCommit"]
        if qualified_commit != expected_qualified:
            raise WorkspaceError(
                "S5 is unready: demo-deploy tip "
                f"{qualified_commit} differs from qualified repaired commit {expected_qualified}"
            )

    verified_commits: dict[str, str] = {}
    for stage in requested:
        actual = _tag_commit(repository, stage, checkpoints[stage]["tag"])
        if actual != checkpoints[stage]["commit"]:
            raise _stage_error(
                stage,
                "checkpoint tag peeled commit "
                f"{actual} differs from maintained commit {checkpoints[stage]['commit']}",
            )
        if stage != S5:
            verified_commits[stage] = actual
    if S5 in requested:
        verified_commits[S5] = qualified_commit or ""

    destination.mkdir(parents=True, exist_ok=True)
    existing_index = _load_existing_index(destination)
    if existing_index is not None:
        if existing_index.get("sessionId") != session["sessionId"]:
            raise WorkspaceError(
                "destination already belongs to another session; refusing to replace its index"
            )
        existing_stages = _validate_stage_map(
            existing_index.get("stages"), "existing session index stages"
        )
        for stage in requested:
            if stage in existing_stages and not _identity_matches(
                existing_stages[stage].get("identity"), session["stages"][stage]
            ):
                raise _stage_error(
                    stage,
                    "existing session input identity differs; refusing to replace saved inputs",
                )
    records = _parse_worktrees(repository)
    plans = [
        _preflight_stage(
            repository,
            destination,
            stage,
            checkpoints[stage],
            qualified_commit,
            records,
        )
        for stage in requested
    ]

    created: list[Path] = []
    try:
        for plan, stage in zip(plans, requested):
            if not plan["created"]:
                continue
            stage_path = plan["path"]
            ref = "demo-deploy" if stage == S5 else f"refs/tags/{checkpoints[stage]['tag']}"
            _git(repository, "worktree", "add", "--quiet", str(stage_path), ref)
            created.append(stage_path)
    except WorkspaceError:
        # Remove only worktrees created by this invocation. Existing or dirty
        # session content is never touched.
        for stage_path in reversed(created):
            try:
                _git(repository, "worktree", "remove", "--force", str(stage_path))
            except WorkspaceError:
                pass
        raise

    entries = {
        stage: _stage_entry(
            stage,
            (destination / stage).resolve(),
            checkpoints[stage],
            session["stages"][stage],
            verified_commits[stage],
        )
        for stage in requested
    }
    if existing_index is not None:
        old_entries = _validate_stage_map(
            existing_index["stages"], "existing session index stages"
        )
        entries = {**old_entries, **entries}
    document: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "sessionId": session["sessionId"],
        "directory": str(destination),
        "stages": entries,
    }
    generation = session.get("generation", checkpoint_generation)
    if generation is not None:
        document["generation"] = generation
    _write_json(destination / INDEX_NAME, document)
    return document


def _status(args: argparse.Namespace) -> dict[str, Any]:
    destination = Path(args.directory).expanduser().resolve()
    index = _read_json(destination / INDEX_NAME, "session index")
    if index.get("schemaVersion") != SCHEMA_VERSION:
        raise WorkspaceError("session index schemaVersion must be 1")
    stages = _validate_stage_map(index.get("stages"), "session index stages")
    if args.stage not in stages:
        raise _stage_error(args.stage, "stage is not present in the session index")
    entry = copy.deepcopy(stages[args.stage])
    # The stored directory is provenance from the original session machine.
    # A replacement session may have a different root (or the old path may
    # still exist), so status always follows the caller-selected root.
    stage_path = (destination / args.stage).resolve()
    if not stage_path.is_dir():
        raise _stage_error(args.stage, f"workspace is unavailable: {stage_path}")
    try:
        actual_root = Path(_git(stage_path, "rev-parse", "--show-toplevel")).resolve()
    except WorkspaceError as exc:
        raise _stage_error(args.stage, f"workspace is not a Git worktree: {stage_path}") from exc
    if actual_root != stage_path:
        raise _stage_error(
            args.stage,
            f"workspace Git root differs from selected stage path: {actual_root}",
        )
    differences = _git_status(stage_path)
    entry["stage"] = args.stage
    entry["directory"] = str(stage_path)
    entry["dirty"] = bool(differences)
    entry["savedDifferences"] = differences
    current_commit = _git(stage_path, "rev-parse", "HEAD")
    entry["currentCommit"] = current_commit
    base = entry.get("base")
    if isinstance(base, dict) and isinstance(base.get("commit"), str):
        entry["baseMatchesCurrent"] = current_commit == base["commit"]
    return entry


def _load_archive_module():
    try:
        import talk_archive  # type: ignore
    except ModuleNotFoundError as exc:
        if exc.name != "talk_archive":
            raise
        return None
    return talk_archive


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    prepare = subparsers.add_parser("prepare", help="prepare editable stage worktrees")
    prepare.add_argument("--checkpoints", required=True, help="verified checkpoint map JSON")
    prepare.add_argument("--session", required=True, help="private session input JSON")
    prepare.add_argument("--directory", required=True, help="session workspace root")
    prepare.add_argument("--stage", choices=STAGES, help="prepare only this independently runnable stage")
    prepare.set_defaults(func=_prepare)

    status = subparsers.add_parser("status", help="inspect one existing stage workspace")
    status.add_argument("--directory", required=True, help="session workspace root")
    status.add_argument("--stage", required=True, choices=STAGES)
    status.set_defaults(func=_status)

    archive = _load_archive_module()
    if archive is not None:
        register = getattr(archive, "register", None)
        if not callable(register):
            raise WorkspaceError("talk_archive must expose register(subparsers)")
        register(subparsers)
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        parser = build_parser()
        args = parser.parse_args(argv)
        result = args.func(args)
        if result is not None:
            print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except (WorkspaceError, ValueError, OSError) as exc:
        print(str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
