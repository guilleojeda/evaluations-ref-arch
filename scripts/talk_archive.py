"""Save and restore the private, portable files for a talk session.

The archive boundary is deliberately local.  An operator supplies a small
private inventory of relative paths; this module never walks a session root for
credentials or copies an entire worktree.  ``generate_inventory`` can derive
tracked Git diffs/deletions and selected untracked source files, while explicit
private case/run/CI files can be added by path.

The archive is a gzip-compressed tar containing a manifest, selected files, and
bounded Git bundles for local stage commits that are ahead of their frozen
base. Its SHA-256 is stored beside it as ``<archive>.sha256``. The format is an
implementation detail of this module; callers use the ``save`` and ``restore``
subcommands or the functions below.
"""

from __future__ import annotations

import argparse
from collections.abc import Iterable, Mapping, Sequence
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
from typing import Any


SCHEMA_VERSION = 1
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
STAGE_RE = re.compile(r"^S[0-5]$")
MANIFEST_NAME = "manifest.json"
FILES_PREFIX = "files/"
GIT_PREFIX = "git/"
CHECKSUM_SUFFIX = ".sha256"
INVENTORY_KEYS = {"schemaVersion", "sessionId", "sourceBase", "stageHeads", "historyPaths", "allowlist"}
ENTRY_KEYS = {"path", "sha256", "baseSha256", "overlaySha256", "state", "mode"}
MANIFEST_EXTRA_KEYS = {"gitBundles"}


class ArchiveError(ValueError):
    """An invalid inventory, archive, or destination conflict."""


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _canonical_json(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _read_bytes(path: Path, label: str) -> bytes:
    if path.is_symlink() or not path.is_file():
        raise ArchiveError(f"{label} is missing or is a symlink: {path}")
    try:
        return path.read_bytes()
    except OSError as error:
        raise ArchiveError(f"unable to read {label}: {path}") from error


def _read_json(path: Path, label: str) -> Any:
    raw = _read_bytes(path, label)
    try:
        return json.loads(
            raw.decode("utf-8"),
            parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise ArchiveError(f"{label} is not valid UTF-8 JSON: {path}") from error


def _safe_relative(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise ArchiveError(f"{label} must be a relative POSIX path")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ArchiveError(f"{label} must remain below the session directory: {value!r}")
    normalized = path.as_posix()
    if normalized != value:
        raise ArchiveError(f"{label} must use its normalized relative path: {value!r}")
    return normalized


def _is_credential_path(relative: str) -> bool:
    parts = {part.lower() for part in PurePosixPath(relative).parts}
    basename = PurePosixPath(relative).name.lower()
    suffix = PurePosixPath(relative).suffix.lower()
    return bool(
        {".aws", ".ssh"} & parts
        or basename in {".env", "credentials", "credentials.json", "secrets.json"}
        or suffix in {".pem", ".key", ".p12", ".pfx"}
        or any(
            basename == marker
            or basename.startswith(f"{marker}-")
            or basename.startswith(f"{marker}_")
            or basename.startswith(f"{marker}.")
            for marker in ("credential", "secret", "token")
        )
    )


def _validate_digest(value: Any, label: str, *, allow_null: bool = False) -> str | None:
    if value is None and allow_null:
        return None
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        raise ArchiveError(f"{label} must be a lowercase SHA-256 digest")
    return value


def _validate_commit(value: Any, label: str) -> str:
    if not isinstance(value, str) or not COMMIT_RE.fullmatch(value):
        raise ArchiveError(f"{label} must be a 40-character Git commit")
    return value


def _normalize_entry(value: Any, index: int) -> dict[str, Any]:
    label = f"allowlist[{index}]"
    if not isinstance(value, Mapping):
        raise ArchiveError(f"{label} must be an object")
    unknown = set(value) - ENTRY_KEYS
    if unknown:
        raise ArchiveError(f"{label} has unsupported fields: {', '.join(sorted(unknown))}")
    missing = {"path", "sha256", "baseSha256"} - set(value)
    if missing:
        raise ArchiveError(f"{label} is missing required fields: {', '.join(sorted(missing))}")
    path = _safe_relative(value["path"], f"{label}.path")
    if _is_credential_path(path):
        raise ArchiveError(f"{label}.path identifies a credential/private key and is not archivable")
    state = value.get("state", "file")
    if state not in {"file", "deleted"}:
        raise ArchiveError(f"{label}.state must be file or deleted")
    digest = _validate_digest(value["sha256"], f"{label}.sha256", allow_null=state == "deleted")
    base_digest = _validate_digest(value["baseSha256"], f"{label}.baseSha256", allow_null=True)
    overlay_digest = _validate_digest(value.get("overlaySha256"), f"{label}.overlaySha256", allow_null=True)
    mode = value.get("mode")
    if mode is not None and (isinstance(mode, bool) or not isinstance(mode, int) or not 0 <= mode <= 0o777):
        raise ArchiveError(f"{label}.mode must be a Unix file mode between 0 and 0777")
    if state == "deleted":
        if digest is not None or (base_digest is None and overlay_digest is None):
            raise ArchiveError(f"{label} deleted entries require null sha256 and a baseSha256 or overlaySha256")
    elif digest is None:
        raise ArchiveError(f"{label} file entries require sha256")
    elif overlay_digest is not None:
        raise ArchiveError(f"{label} file entries cannot carry overlaySha256")
    return {
        "path": path,
        "sha256": digest,
        "baseSha256": base_digest,
        "overlaySha256": overlay_digest,
        "state": state,
        "mode": mode,
    }


def _validate_inventory(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ArchiveError("private inventory must be a JSON object")
    unknown = set(value) - INVENTORY_KEYS
    if unknown:
        raise ArchiveError(f"private inventory has unsupported fields: {', '.join(sorted(unknown))}")
    if value.get("schemaVersion") != SCHEMA_VERSION:
        raise ArchiveError("private inventory schemaVersion must be 1")
    session_id = value.get("sessionId")
    if not isinstance(session_id, str) or not session_id.strip():
        raise ArchiveError("private inventory sessionId must be a non-empty string")
    raw_entries = value.get("allowlist")
    if not isinstance(raw_entries, list) or not raw_entries:
        raise ArchiveError("private inventory allowlist must be a non-empty list")
    entries = [_normalize_entry(entry, index) for index, entry in enumerate(raw_entries)]
    paths = [entry["path"] for entry in entries]
    if len(paths) != len(set(paths)):
        raise ArchiveError("private inventory allowlist contains duplicate paths")

    source_base = value.get("sourceBase")
    if source_base is not None:
        if not isinstance(source_base, Mapping) or source_base.get("kind") != "git":
            raise ArchiveError("inventory sourceBase must identify Git")
        if set(source_base) == {"kind", "commit"}:
            source_base = {"kind": "git", "commit": _validate_commit(source_base.get("commit"), "sourceBase.commit")}
        elif set(source_base) == {"kind", "commits"}:
            commits = source_base.get("commits")
            if not isinstance(commits, Mapping) or not commits:
                raise ArchiveError("inventory sourceBase.commits must be a non-empty object")
            if any(not isinstance(stage, str) or not STAGE_RE.fullmatch(stage) for stage in commits):
                raise ArchiveError("inventory sourceBase.commits has an invalid stage")
            source_base = {
                "kind": "git",
                "commits": {
                    stage: _validate_commit(commit, f"sourceBase.commits.{stage}")
                    for stage, commit in commits.items()
                },
            }
        else:
            raise ArchiveError("inventory sourceBase must contain commit or commits")

    stage_heads = value.get("stageHeads")
    if stage_heads is not None:
        if not isinstance(stage_heads, Mapping) or not stage_heads:
            raise ArchiveError("inventory stageHeads must be a non-empty object")
        normalized_heads: dict[str, str] = {}
        for stage, commit in stage_heads.items():
            if not isinstance(stage, str) or not STAGE_RE.fullmatch(stage):
                raise ArchiveError(f"inventory stageHeads has invalid stage: {stage!r}")
            normalized_heads[stage] = _validate_commit(commit, f"stageHeads.{stage}")
        stage_heads = normalized_heads

    history_paths = value.get("historyPaths")
    if history_paths is not None:
        if not isinstance(history_paths, Mapping):
            raise ArchiveError("inventory historyPaths must be an object")
        normalized_history: dict[str, list[str]] = {}
        for stage, raw_paths in history_paths.items():
            if not isinstance(stage, str) or not STAGE_RE.fullmatch(stage):
                raise ArchiveError(f"inventory historyPaths has invalid stage: {stage!r}")
            if not isinstance(raw_paths, list):
                raise ArchiveError(f"inventory historyPaths.{stage} must be a list")
            paths = [_safe_relative(path, f"historyPaths.{stage}") for path in raw_paths]
            if any(_is_credential_path(path) for path in paths):
                raise ArchiveError(f"inventory historyPaths.{stage} contains a credential/private path")
            if len(paths) != len(set(paths)):
                raise ArchiveError(f"inventory historyPaths.{stage} contains duplicates")
            normalized_history[stage] = sorted(paths)
        history_paths = normalized_history

    result: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "sessionId": session_id,
        "allowlist": entries,
    }
    if source_base is not None:
        result["sourceBase"] = source_base
    if stage_heads is not None:
        result["stageHeads"] = stage_heads
    if history_paths is not None:
        result["historyPaths"] = history_paths
    return result


def _inventory_entry_map(inventory: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    return {entry["path"]: entry for entry in inventory["allowlist"]}


def _validate_git_bundles(value: Any) -> dict[str, dict[str, str]]:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise ArchiveError("archive gitBundles must be an object")
    result: dict[str, dict[str, str]] = {}
    for stage, raw in value.items():
        if not isinstance(stage, str) or not STAGE_RE.fullmatch(stage):
            raise ArchiveError(f"archive gitBundles has an invalid stage: {stage!r}")
        if not isinstance(raw, Mapping) or set(raw) != {"base", "head", "sha256"}:
            raise ArchiveError(f"archive gitBundles.{stage} must contain base, head, and sha256")
        result[stage] = {
            "base": _validate_commit(raw["base"], f"gitBundles.{stage}.base"),
            "head": _validate_commit(raw["head"], f"gitBundles.{stage}.head"),
            "sha256": _validate_digest(raw["sha256"], f"gitBundles.{stage}.sha256"),
        }
    return result


def _resolve_below(root: Path, relative: str, label: str) -> Path:
    root = root.resolve()
    candidate = root / relative
    try:
        candidate.resolve().relative_to(root)
    except ValueError as error:
        raise ArchiveError(f"{label} escapes the session directory: {relative}") from error
    return candidate


def _check_no_symlink_ancestors(root: Path, relative: str, label: str) -> Path:
    if root.is_symlink() or not root.is_dir():
        raise ArchiveError(f"{label} must be a real directory: {root}")
    candidate = _resolve_below(root, relative, label)
    current = root
    parts = PurePosixPath(relative).parts
    for part in parts[:-1]:
        current = current / part
        if current.is_symlink():
            raise ArchiveError(f"{label} has a symlinked parent: {relative}")
    return candidate


def _atomic_write(path: Path, data: bytes, *, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists() and path.is_symlink():
        raise ArchiveError(f"refusing to replace symlink: {path}")
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    if temporary.exists() or temporary.is_symlink():
        temporary.unlink()
    try:
        with temporary.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(mode)
        os.replace(temporary, path)
        path.chmod(mode)
    finally:
        temporary.unlink(missing_ok=True)


def checksum_path(archive: Path) -> Path:
    """Return the sidecar checksum path for an archive."""

    return Path(f"{archive}{CHECKSUM_SUFFIX}")


def _write_checksum(archive: Path, archive_bytes: bytes) -> str:
    digest = _sha256(archive_bytes)
    _atomic_write(checksum_path(archive), f"{digest}  {archive.name}\n".encode("ascii"))
    return digest


def _read_checksum(archive: Path, archive_bytes: bytes) -> str:
    sidecar = checksum_path(archive)
    raw = _read_bytes(sidecar, "archive checksum")
    try:
        text = raw.decode("ascii").strip()
    except UnicodeDecodeError as error:
        raise ArchiveError("archive checksum is not ASCII") from error
    parts = text.split()
    if len(parts) != 2 or parts[1] != archive.name or not SHA256_RE.fullmatch(parts[0]):
        raise ArchiveError("archive checksum sidecar is malformed")
    observed = _sha256(archive_bytes)
    if observed != parts[0]:
        raise ArchiveError("archive checksum mismatch")
    return observed


def _archive_member(name: str, *, label: str) -> str:
    safe = _safe_relative(name, label)
    if safe == MANIFEST_NAME:
        return safe
    if not safe.startswith((FILES_PREFIX, GIT_PREFIX)):
        raise ArchiveError(f"archive contains an unsupported member: {name}")
    return safe


def _read_archive(
    archive: Path, inventory: Mapping[str, Any]
) -> tuple[dict[str, Any], dict[str, bytes], dict[str, bytes]]:
    archive_bytes = _read_bytes(archive, "session archive")
    _read_checksum(archive, archive_bytes)
    try:
        opened = tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:*")
    except (tarfile.TarError, OSError) as error:
        raise ArchiveError("session archive is corrupt or unsupported") from error
    with opened:
        members = opened.getmembers()
        names = [_archive_member(member.name, label="archive member") for member in members]
        if len(names) != len(set(names)):
            raise ArchiveError("session archive contains duplicate members")
        if MANIFEST_NAME not in names:
            raise ArchiveError("session archive has no manifest")
        if any(not member.isfile() for member in members):
            raise ArchiveError("session archive may contain regular files only")
        manifest_member = members[names.index(MANIFEST_NAME)]
        manifest_stream = opened.extractfile(manifest_member)
        if manifest_stream is None:
            raise ArchiveError("session archive manifest is unreadable")
        try:
            manifest = json.loads(manifest_stream.read().decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            raise ArchiveError("session archive manifest is invalid JSON") from error
        normalized_manifest = _validate_manifest(manifest)
        if normalized_manifest["sessionId"] != inventory["sessionId"]:
            raise ArchiveError("archive sessionId differs from private inventory")
        for key in ("sourceBase", "stageHeads"):
            if normalized_manifest.get(key) != inventory.get(key):
                raise ArchiveError(f"archive {key} differs from private inventory")
        if normalized_manifest.get("historyPaths") != inventory.get("historyPaths"):
            raise ArchiveError("archive historyPaths differs from private inventory")
        if _entry_projection(normalized_manifest) != _entry_projection(inventory):
            raise ArchiveError("archive manifest differs from private inventory")
        inventory_entries = _inventory_entry_map(inventory)
        for manifest_entry in normalized_manifest["allowlist"]:
            expected_mode = inventory_entries[manifest_entry["path"]].get("mode")
            if expected_mode is not None and expected_mode != manifest_entry.get("mode"):
                raise ArchiveError(f"archive mode differs from private inventory: {manifest_entry['path']}")

        files: dict[str, bytes] = {}
        bundles: dict[str, bytes] = {}
        for member, name in zip(members, names, strict=True):
            if name == MANIFEST_NAME:
                continue
            if name.startswith(GIT_PREFIX):
                stage = name.removeprefix(GIT_PREFIX).removesuffix(".bundle")
                if not STAGE_RE.fullmatch(stage) or name != f"{GIT_PREFIX}{stage}.bundle":
                    raise ArchiveError(f"archive contains an invalid Git bundle member: {name}")
                bundle_stream = opened.extractfile(member)
                if bundle_stream is None:
                    raise ArchiveError(f"archive Git bundle is unreadable: {name}")
                bundles[stage] = bundle_stream.read()
                continue
            relative = name.removeprefix(FILES_PREFIX)
            stream = opened.extractfile(member)
            if stream is None:
                raise ArchiveError(f"archive member is unreadable: {name}")
            content = stream.read()
            entry = _inventory_entry_map(normalized_manifest)[relative]
            if entry["state"] != "file":
                raise ArchiveError(f"deleted entry has archive bytes: {relative}")
            if _sha256(content) != entry["sha256"]:
                raise ArchiveError(f"archive file digest mismatch: {relative}")
            files[relative] = content
        expected_files = {
            entry["path"]
            for entry in normalized_manifest["allowlist"]
            if entry["state"] == "file"
        }
        if set(files) != expected_files:
            raise ArchiveError("archive file members do not match the manifest")
        git_bundles = normalized_manifest.get("gitBundles", {})
        if set(bundles) != set(git_bundles):
            raise ArchiveError("archive Git bundle members do not match the manifest")
        for stage, content in bundles.items():
            if _sha256(content) != git_bundles[stage]["sha256"]:
                raise ArchiveError(f"archive Git bundle digest mismatch: {stage}")
        return normalized_manifest, files, bundles


def _validate_manifest(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ArchiveError("archive manifest must be an object")
    allowed = {"schemaVersion", "sessionId", "sourceBase", "stageHeads", "historyPaths", "allowlist", *MANIFEST_EXTRA_KEYS}
    if set(value) - allowed:
        raise ArchiveError("archive manifest has unsupported fields")
    # Reuse inventory validation; a manifest has the same immutable selection
    # and identity fields, even though the archive carries bytes separately.
    inventory = _validate_inventory({key: value[key] for key in allowed if key in value and key != "gitBundles"})
    git_bundles = _validate_git_bundles(value.get("gitBundles"))
    stage_heads = inventory.get("stageHeads", {})
    source_base = inventory.get("sourceBase")
    if git_bundles:
        if not stage_heads or source_base is None:
            raise ArchiveError("archive Git bundles require stageHeads and sourceBase")
        for stage, bundle in git_bundles.items():
            if stage_heads.get(stage) != bundle["head"]:
                raise ArchiveError(f"archive Git bundle head differs from stageHeads.{stage}")
            if "commit" in source_base and source_base["commit"] != bundle["base"]:
                raise ArchiveError(f"archive Git bundle base differs from sourceBase for {stage}")
            if "commits" in source_base and source_base["commits"].get(stage) != bundle["base"]:
                raise ArchiveError(f"archive Git bundle base differs from sourceBase.{stage}")
    if stage_heads and source_base is not None:
        for stage, head in stage_heads.items():
            if "commit" in source_base:
                base = source_base["commit"]
            else:
                base = source_base["commits"].get(stage)
            if base is None:
                raise ArchiveError(f"archive sourceBase has no base for {stage}")
            if head != base and stage not in git_bundles:
                raise ArchiveError(f"archive is missing the local Git bundle for {stage}")
    if git_bundles:
        inventory["gitBundles"] = git_bundles
    return inventory


def _entry_projection(value: Mapping[str, Any]) -> tuple[object, ...]:
    return tuple(
        (
            entry["path"],
            entry["sha256"],
            entry["baseSha256"],
            entry["overlaySha256"],
            entry["state"],
        )
        for entry in value["allowlist"]
    )


def _load_inventory(path: Path) -> dict[str, Any]:
    return _validate_inventory(_read_json(path, "private inventory"))


def _read_source_entries(directory: Path, inventory: Mapping[str, Any]) -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    for entry in inventory["allowlist"]:
        target = _check_no_symlink_ancestors(directory, entry["path"], "session source")
        if entry["state"] == "deleted":
            if target.exists() or target.is_symlink():
                raise ArchiveError(f"deleted selected file still exists: {entry['path']}")
            continue
        content = _read_bytes(target, f"selected file {entry['path']}")
        if _sha256(content) != entry["sha256"]:
            raise ArchiveError(f"selected file digest mismatch: {entry['path']}")
        observed_mode = stat.S_IMODE(target.stat().st_mode)
        if entry.get("mode") is not None and entry["mode"] != observed_mode:
            raise ArchiveError(f"selected file mode mismatch: {entry['path']}")
        entry["mode"] = observed_mode
        files[entry["path"]] = content
    return files


def _bundle_base_for_stage(source_base: Any, stage: str) -> str | None:
    if source_base is None:
        return None
    if "commit" in source_base:
        return source_base["commit"]
    commits = source_base.get("commits", {})
    return commits.get(stage)


def _git_history_paths(directory: Path, base: str, head: str) -> set[str]:
    """List paths touched by every bundled commit without reading file bodies."""

    commits = _git_bytes(directory, "rev-list", f"{base}..{head}").splitlines()
    paths: set[str] = set()
    for commit in commits:
        commit_id = commit.decode("ascii")
        changed = _git_bytes(
            directory,
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "-r",
            "-m",
            "--root",
            commit_id,
            "--",
        )
        for raw_path in changed.splitlines():
            try:
                paths.add(_safe_relative(raw_path.decode("utf-8"), "local commit path"))
            except UnicodeDecodeError as error:
                raise ArchiveError(f"local commit {commit_id} has a non-UTF-8 path") from error
    return paths


def _build_git_bundles(directory: Path, inventory: Mapping[str, Any]) -> dict[str, tuple[dict[str, str], bytes]]:
    """Create bounded local commit bundles for stages ahead of their frozen base."""

    stage_heads = inventory.get("stageHeads", {})
    source_base = inventory.get("sourceBase")
    if not stage_heads:
        return {}
    if source_base is None:
        raise ArchiveError("stageHeads require sourceBase to preserve local commits")
    bundles: dict[str, tuple[dict[str, str], bytes]] = {}
    for stage, head in stage_heads.items():
        base = _bundle_base_for_stage(source_base, stage)
        if base is None or head == base:
            continue
        stage_root = directory / stage
        if stage_root.is_symlink() or not stage_root.is_dir() or not (stage_root / ".git").exists():
            raise ArchiveError(f"stage {stage} is not a Git worktree for commit preservation")
        actual_head = _git(stage_root, "rev-parse", "HEAD").strip()
        if actual_head != head:
            raise ArchiveError(f"inventory stageHeads.{stage} differs from the current Git HEAD")
        ancestor = subprocess.run(
            ["git", "merge-base", "--is-ancestor", base, head],
            cwd=stage_root,
            capture_output=True,
            check=False,
            timeout=20,
        )
        if ancestor.returncode:
            raise ArchiveError(f"stage {stage} local HEAD is not descended from its frozen base")
        selected_paths = set(_inventory_entry_map(inventory))
        selected_paths.update(
            f"{stage}/{relative}"
            for relative in inventory.get("historyPaths", {}).get(stage, [])
        )
        for relative in _git_history_paths(stage_root, base, head):
            path = f"{stage}/{relative}"
            if _is_credential_path(path):
                raise ArchiveError(f"local commit history contains a credential/private path: {path}")
            if path not in selected_paths:
                raise ArchiveError(f"local commit path is not in the reviewed inventory: {path}")
        with tempfile.NamedTemporaryFile(prefix=f"talk-session-{stage}-", suffix=".bundle") as temporary:
            completed = subprocess.run(
                # HEAD is the selected worktree's actual local commit.  Git's
                # bundle range parser accepts the symbolic endpoint reliably;
                # an explicit object ID can be treated as an empty revision
                # range by older Git versions.
                ["git", "bundle", "create", temporary.name, f"{base}..HEAD"],
                cwd=stage_root,
                capture_output=True,
                check=False,
                timeout=30,
            )
            if completed.returncode:
                detail = completed.stderr.decode(errors="replace").strip()
                raise ArchiveError(f"git bundle failed for {stage}: {detail}")
            content = Path(temporary.name).read_bytes()
        if not content:
            raise ArchiveError(f"git bundle for {stage} is empty")
        bundles[stage] = (
            {"base": base, "head": head, "sha256": _sha256(content)},
            content,
        )
    return bundles


def _write_archive(
    path: Path,
    inventory: Mapping[str, Any],
    files: Mapping[str, bytes],
    bundles: Mapping[str, tuple[dict[str, str], bytes]] | None = None,
) -> bytes:
    manifest = {
        "schemaVersion": inventory["schemaVersion"],
        "sessionId": inventory["sessionId"],
        "allowlist": inventory["allowlist"],
    }
    for key in ("sourceBase", "stageHeads", "historyPaths"):
        if key in inventory:
            manifest[key] = inventory[key]
    if bundles:
        manifest["gitBundles"] = {
            stage: metadata for stage, (metadata, _content) in bundles.items()
        }
    manifest_bytes = _canonical_json(manifest) + b"\n"
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        manifest_info = tarfile.TarInfo(MANIFEST_NAME)
        manifest_info.size = len(manifest_bytes)
        manifest_info.mode = stat.S_IRUSR | stat.S_IWUSR
        manifest_info.mtime = 0
        archive.addfile(manifest_info, io.BytesIO(manifest_bytes))
        for relative in sorted(files):
            content = files[relative]
            info = tarfile.TarInfo(f"{FILES_PREFIX}{relative}")
            info.size = len(content)
            info.mode = _inventory_entry_map(inventory)[relative].get("mode") or (stat.S_IRUSR | stat.S_IWUSR)
            info.mtime = 0
            archive.addfile(info, io.BytesIO(content))
        for stage in sorted(bundles):
            content = bundles[stage][1]
            info = tarfile.TarInfo(f"{GIT_PREFIX}{stage}.bundle")
            info.size = len(content)
            info.mode = stat.S_IRUSR | stat.S_IWUSR
            info.mtime = 0
            archive.addfile(info, io.BytesIO(content))
    archive_bytes = output.getvalue()
    _atomic_write(path, archive_bytes)
    _write_checksum(path, archive_bytes)
    return archive_bytes


def _preflight_restore(directory: Path, inventory: Mapping[str, Any], files: Mapping[str, bytes]) -> list[tuple[dict[str, Any], Path, bytes | None]]:
    if directory.exists() and (directory.is_symlink() or not directory.is_dir()):
        raise ArchiveError(f"restore directory is not a real directory: {directory}")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if directory.is_symlink():
        raise ArchiveError(f"restore directory is a symlink: {directory}")

    operations: list[tuple[dict[str, Any], Path, bytes | None]] = []
    for entry in inventory["allowlist"]:
        target = _check_no_symlink_ancestors(directory, entry["path"], "restore target")
        current: bytes | None
        if target.exists() or target.is_symlink():
            if target.is_symlink() or not target.is_file():
                raise ArchiveError(f"restore target is not a regular file: {entry['path']}")
            current = _read_bytes(target, f"restore target {entry['path']}")
        else:
            current = None
        if entry["state"] == "deleted":
            if current is None:
                if entry.get("overlaySha256") is None:
                    raise ArchiveError(f"restore target is missing for selected deletion: {entry['path']}")
            elif _sha256(current) != (entry.get("baseSha256") or entry.get("overlaySha256")):
                raise ArchiveError(f"restore target has dirty conflicting content: {entry['path']}")
            operations.append((entry, target, None))
            continue

        if current is None:
            if entry["baseSha256"] is not None:
                raise ArchiveError(f"restore target is missing frozen base content: {entry['path']}")
        else:
            current_digest = _sha256(current)
            if current_digest not in {entry["sha256"], entry["baseSha256"]}:
                raise ArchiveError(f"restore target has dirty conflicting content: {entry['path']}")
        if entry["path"] not in files:
            raise ArchiveError(f"archive is missing selected file: {entry['path']}")
        operations.append((entry, target, files[entry["path"]]))
    return operations


def _git_command(directory: Path, *args: str, check: bool = True) -> str:
    completed = subprocess.run(
        ["git", *args],
        cwd=directory,
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    if check and completed.returncode:
        raise ArchiveError(f"git {' '.join(args)} failed: {completed.stderr.strip()}")
    if not check and completed.returncode:
        return ""
    return completed.stdout.strip()


def _restore_git_bundles(directory: Path, manifest: Mapping[str, Any], bundles: Mapping[str, bytes]) -> None:
    """Import selected local commits into clean replacement stage worktrees."""

    metadata = manifest.get("gitBundles", {})
    for stage, bundle_meta in metadata.items():
        stage_root = directory / stage
        if stage_root.is_symlink() or not stage_root.is_dir() or not (stage_root / ".git").exists():
            raise ArchiveError(f"restore stage {stage} is not a Git worktree")
        current_head = _git_command(stage_root, "rev-parse", "HEAD")
        if current_head not in {bundle_meta["base"], bundle_meta["head"]}:
            raise ArchiveError(f"restore stage {stage} is not at its frozen base or saved head")
        if _git_command(stage_root, "status", "--porcelain"):
            raise ArchiveError(f"restore stage {stage} has dirty unselected content")
        if current_head == bundle_meta["head"]:
            continue

        bundle_content = bundles.get(stage)
        if bundle_content is None:
            raise ArchiveError(f"restore is missing Git bundle for {stage}")
        with tempfile.NamedTemporaryFile(
            prefix=f"talk-session-restore-{stage}-", suffix=".bundle", delete=False
        ) as temporary:
            bundle_path = Path(temporary.name)
            temporary.write(bundle_content)
        try:
            reference = f"refs/talk-session/{stage}/{bundle_meta['head']}"
            _git_command(stage_root, "fetch", "--quiet", str(bundle_path), f"HEAD:{reference}")
            if _git_command(stage_root, "rev-parse", reference) != bundle_meta["head"]:
                raise ArchiveError(f"restored Git bundle head differs for {stage}")
            branch = _git_command(stage_root, "symbolic-ref", "--quiet", "--short", "HEAD", check=False)
            if branch:
                _git_command(stage_root, "reset", "--hard", "--quiet", reference)
            else:
                _git_command(stage_root, "checkout", "--detach", "--quiet", reference)
            if _git_command(stage_root, "rev-parse", "HEAD") != bundle_meta["head"]:
                raise ArchiveError(f"restore did not select saved Git head for {stage}")
        finally:
            bundle_path.unlink(missing_ok=True)


def _apply_restore(operations: Iterable[tuple[dict[str, Any], Path, bytes | None]]) -> None:
    for entry, target, content in operations:
        if entry["state"] == "deleted":
            if target.exists():
                target.unlink()
        else:
            assert content is not None
            _atomic_write(target, content, mode=entry.get("mode") or 0o600)


def save_session(directory: Path | str, archive: Path | str, inventory: Path | str) -> dict[str, Any]:
    """Save exactly the selected private inventory paths to an archive."""

    source = Path(directory)
    archive_path = Path(archive)
    inventory_path = Path(inventory)
    loaded = _load_inventory(inventory_path)
    files = _read_source_entries(source, loaded)
    bundles = _build_git_bundles(source, loaded)
    archive_bytes = _write_archive(archive_path, loaded, files, bundles)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "sessionId": loaded["sessionId"],
        "archive": str(archive_path),
        "archiveSha256": _sha256(archive_bytes),
        "checksum": str(checksum_path(archive_path)),
        "files": len(files),
        "gitBundles": len(bundles),
    }


def restore_session(directory: Path | str, archive: Path | str, inventory: Path | str) -> dict[str, Any]:
    """Restore selected files into a clean or matching-base session root."""

    destination = Path(directory)
    archive_path = Path(archive)
    loaded = _load_inventory(Path(inventory))
    manifest, files, bundles = _read_archive(archive_path, loaded)
    operations = _preflight_restore(destination, manifest, files)
    _restore_git_bundles(destination, manifest, bundles)
    _apply_restore(operations)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "sessionId": loaded["sessionId"],
        "directory": str(destination),
        "archiveSha256": _sha256(_read_bytes(archive_path, "session archive")),
        "files": len(files),
        "gitBundles": len(bundles),
    }


def _git(directory: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", *args], cwd=directory, capture_output=True, text=True, check=False, timeout=20
    )
    if completed.returncode:
        raise ArchiveError(f"git {' '.join(args)} failed: {completed.stderr.strip()}")
    return completed.stdout


def _git_bytes(directory: Path, *args: str) -> bytes:
    completed = subprocess.run(
        ["git", *args], cwd=directory, capture_output=True, check=False, timeout=20
    )
    if completed.returncode:
        raise ArchiveError(f"git {' '.join(args)} failed: {completed.stderr.decode(errors='replace').strip()}")
    return completed.stdout


def _git_show(directory: Path, revision: str, relative: str) -> bytes | None:
    completed = subprocess.run(
        ["git", "show", f"{revision}:{relative}"],
        cwd=directory,
        capture_output=True,
        check=False,
        timeout=20,
    )
    if completed.returncode:
        return None
    return completed.stdout


def _parse_git_diff(raw: bytes) -> list[tuple[str, str]]:
    tokens = raw.split(b"\0")
    result: list[tuple[str, str]] = []
    index = 0
    while index < len(tokens) - 1:
        status = tokens[index].decode("ascii", errors="strict")
        index += 1
        if not status:
            continue
        if status[0] in {"R", "C"}:
            if index + 1 >= len(tokens):
                raise ArchiveError("git diff returned a malformed rename")
            index += 1
            path = tokens[index].decode("utf-8")
            index += 1
        else:
            path = tokens[index].decode("utf-8")
            index += 1
        result.append((status[0], path))
    return result


def _git_untracked_paths(directory: Path) -> set[str]:
    """Return only untracked paths, avoiding porcelain rename payloads."""

    raw = _git_bytes(directory, "ls-files", "--others", "--exclude-standard", "-z")
    result: set[str] = set()
    for token in raw.split(b"\0"):
        if not token:
            continue
        try:
            result.add(_safe_relative(token.decode("utf-8"), "untracked Git path"))
        except UnicodeDecodeError as error:
            raise ArchiveError("git returned a non-UTF-8 untracked path") from error
    return result


def _git_stage_paths(directory: Path) -> list[Path]:
    if directory.is_symlink() or not directory.is_dir():
        raise ArchiveError(f"session directory is not a real directory: {directory}")
    return sorted(
        path
        for path in directory.iterdir()
        if path.is_dir()
        and not path.is_symlink()
        and STAGE_RE.fullmatch(path.name)
        and (path / ".git").exists()
    )


def _session_index_bases(directory: Path, stages: Iterable[str]) -> dict[str, str]:
    """Derive each prepared stage's current base from the private index."""

    index_path = directory / "session-index.json"
    if not index_path.exists():
        return {}
    value = _read_json(index_path, "session index")
    raw_stages = value.get("stages") if isinstance(value, Mapping) else None
    if not isinstance(raw_stages, Mapping):
        raise ArchiveError("session index stages must be an object")
    bases: dict[str, str] = {}
    for stage in stages:
        entry = raw_stages.get(stage)
        if not isinstance(entry, Mapping) or not isinstance(entry.get("base"), Mapping):
            raise ArchiveError(f"session index has no base for {stage}")
        bases[stage] = _validate_commit(entry["base"].get("commit"), f"session index {stage} base.commit")
    return bases


def _source_base_for_stage(source_base: Any, stage: str, head: str) -> str:
    if source_base is None:
        return head
    if isinstance(source_base, Mapping) and "commit" in source_base:
        return _validate_commit(source_base["commit"], "sourceBase.commit")
    if isinstance(source_base, Mapping) and "commits" in source_base:
        commits = source_base.get("commits")
        if not isinstance(commits, Mapping) or stage not in commits:
            raise ArchiveError(f"sourceBase.commits has no base for {stage}")
        return _validate_commit(commits[stage], f"sourceBase.commits.{stage}")
    if isinstance(source_base, Mapping):
        value = source_base.get(stage)
        if isinstance(value, Mapping):
            value = value.get("commit")
        return _validate_commit(value, f"sourceBase.{stage}")
    if isinstance(source_base, str):
        return _validate_commit(source_base, "sourceBase")
    raise ArchiveError("source_base must be a Git commit or stage mapping")


def generate_inventory(
    directory: Path | str,
    *,
    session_id: str | None = None,
    selected_untracked: Sequence[str] = (),
    include_paths: Sequence[str] = (),
    source_base: Mapping[str, Any] | str | None = None,
    output: Path | str | None = None,
) -> dict[str, Any]:
    """Generate a reviewed inventory from tracked diffs and explicit paths.

    Stage worktrees are compared to ``source_base`` when supplied, which keeps
    committed local edits visible even when ``git status`` is clean.  Without a
    supplied base, the current stage HEAD is the base and only working-tree
    changes are selected.  Untracked files are never selected implicitly.
    """

    root = Path(directory)
    if session_id is None:
        session_id = root.name
    if not isinstance(session_id, str) or not session_id.strip():
        raise ArchiveError("session_id must be a non-empty string")
    selected = {_safe_relative(path, "selected untracked path") for path in selected_untracked}
    includes = {_safe_relative(path, "included private path") for path in include_paths}
    entries: dict[str, dict[str, Any]] = {}
    stage_heads: dict[str, str] = {}
    history_paths: dict[str, list[str]] = {}
    stage_roots = _git_stage_paths(root)
    effective_source_base: Mapping[str, Any] | str | None = source_base
    if effective_source_base is None and stage_roots:
        derived_bases = _session_index_bases(root, (stage.name for stage in stage_roots))
        if derived_bases:
            effective_source_base = {"kind": "git", "commits": derived_bases}

    for stage_root in stage_roots:
        stage = stage_root.name
        head = _validate_commit(_git(stage_root, "rev-parse", "HEAD").strip(), f"{stage} HEAD")
        base = _source_base_for_stage(effective_source_base, stage, head)
        stage_heads[stage] = head
        # Compare the full working tree with the frozen source, including
        # committed local stage edits and staged/uncommitted changes.
        diff = _parse_git_diff(
            _git_bytes(stage_root, "diff", "--name-status", "--no-renames", "-z", base, "--")
        )
        for status, relative_inner in diff:
            relative_inner = _safe_relative(relative_inner, f"{stage} tracked path")
            if relative_inner == ".git" or relative_inner.startswith(".git/"):
                continue
            path = f"{stage}/{relative_inner}"
            target = _check_no_symlink_ancestors(stage_root, relative_inner, "tracked source")
            base_bytes = _git_show(stage_root, base, relative_inner)
            base_digest = _sha256(base_bytes) if base_bytes is not None else None
            if status == "D" or not target.exists():
                if base_digest is None:
                    raise ArchiveError(f"tracked deletion has no base bytes: {path}")
                entry = {"path": path, "sha256": None, "baseSha256": base_digest, "state": "deleted"}
            else:
                content = _read_bytes(target, f"tracked source {path}")
                entry = {
                    "path": path,
                    "sha256": _sha256(content),
                    "baseSha256": base_digest,
                    "state": "file",
                    "mode": stat.S_IMODE(target.stat().st_mode),
                }
            entries[path] = entry

        if head != base:
            for relative_inner in _git_history_paths(stage_root, base, head):
                path = f"{stage}/{relative_inner}"
                if path in entries:
                    continue
                if _is_credential_path(path):
                    raise ArchiveError(f"local commit history contains a credential/private path: {path}")
                target = _check_no_symlink_ancestors(stage_root, relative_inner, "local commit path")
                base_bytes = _git_show(stage_root, base, relative_inner)
                base_digest = _sha256(base_bytes) if base_bytes is not None else None
                if target.exists():
                    content = _read_bytes(target, f"local commit path {path}")
                    entries[path] = {
                        "path": path,
                        "sha256": _sha256(content),
                        "baseSha256": base_digest,
                        "state": "file",
                        "mode": stat.S_IMODE(target.stat().st_mode),
                    }
                elif base_digest is not None:
                    entries[path] = {
                        "path": path,
                        "sha256": None,
                        "baseSha256": base_digest,
                        "state": "deleted",
                    }
                else:
                    head_bytes = _git_show(stage_root, head, relative_inner)
                    if head_bytes is None:
                        history_paths.setdefault(stage, []).append(relative_inner)
                    else:
                        # The frozen base never had this file, but a local
                        # commit did.  The working tree removed it without a
                        # follow-up commit.  Preserve the deletion as an
                        # explicit post-bundle overlay rather than letting
                        # checkout of the saved commit recreate it.
                        entries[path] = {
                            "path": path,
                            "sha256": None,
                            "baseSha256": None,
                            "overlaySha256": _sha256(head_bytes),
                            "state": "deleted",
                        }

        # Select only explicit untracked files below this stage.
        stage_selected = {
            path.removeprefix(f"{stage}/") for path in selected if path.startswith(f"{stage}/")
        }
        untracked = _git_untracked_paths(stage_root)
        for relative_inner in stage_selected:
            relative_inner = _safe_relative(relative_inner, "selected untracked path")
            if relative_inner not in untracked:
                raise ArchiveError(f"selected path is not an untracked file: {stage}/{relative_inner}")
            target = _check_no_symlink_ancestors(stage_root, relative_inner, "selected untracked source")
            content = _read_bytes(target, f"selected untracked source {stage}/{relative_inner}")
            path = f"{stage}/{relative_inner}"
            if path in entries:
                raise ArchiveError(f"selected untracked path overlaps tracked diff: {path}")
            entries[path] = {
                "path": path,
                "sha256": _sha256(content),
                "baseSha256": None,
                "state": "file",
                "mode": stat.S_IMODE(target.stat().st_mode),
            }

    for relative in includes:
        if relative in entries:
            continue
        target = _check_no_symlink_ancestors(root, relative, "included private path")
        content = _read_bytes(target, f"included private path {relative}")
        entries[relative] = {
            "path": relative,
            "sha256": _sha256(content),
            "baseSha256": None,
            "state": "file",
            "mode": stat.S_IMODE(target.stat().st_mode),
        }

    missing_selected = sorted(path for path in selected if path not in entries)
    if missing_selected:
        raise ArchiveError(f"selected untracked paths are outside prepared stage worktrees: {', '.join(missing_selected)}")
    if not entries:
        raise ArchiveError("inventory has no tracked diff, selected untracked file, or included private path")

    result: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "sessionId": session_id,
        "allowlist": [entries[path] for path in sorted(entries)],
    }
    if effective_source_base is not None:
        if isinstance(effective_source_base, Mapping) and "commit" in effective_source_base:
            result["sourceBase"] = {
                "kind": "git",
                "commit": _validate_commit(effective_source_base["commit"], "sourceBase.commit"),
            }
        elif isinstance(effective_source_base, Mapping) and "commits" in effective_source_base:
            commits = effective_source_base["commits"]
            if not isinstance(commits, Mapping):
                raise ArchiveError("source_base.commits must be a mapping")
            result["sourceBase"] = {
                "kind": "git",
                "commits": {
                    stage: _validate_commit(commit, f"sourceBase.commits.{stage}")
                    for stage, commit in commits.items()
                },
            }
        elif isinstance(effective_source_base, Mapping):
            commits: dict[str, str] = {}
            for stage, value in effective_source_base.items():
                if isinstance(value, Mapping):
                    value = value.get("commit")
                commits[stage] = _validate_commit(value, f"sourceBase.{stage}")
            result["sourceBase"] = {"kind": "git", "commits": commits}
        elif isinstance(effective_source_base, str):
            result["sourceBase"] = {"kind": "git", "commit": _validate_commit(effective_source_base, "sourceBase")}
        else:
            raise ArchiveError("generated inventory requires one shared source_base commit")
    if stage_heads:
        result["stageHeads"] = stage_heads
    if history_paths:
        result["historyPaths"] = {
            stage: sorted(paths) for stage, paths in sorted(history_paths.items())
        }
    result = _validate_inventory(result)
    if output is not None:
        _atomic_write(Path(output), _canonical_json(result) + b"\n")
    return result


# Descriptive aliases for callers that prefer the operation names.
build_inventory = generate_inventory
save = save_session
restore = restore_session


def _add_common_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--directory", type=Path, required=True, help="session root")
    parser.add_argument("--archive", type=Path, required=True, help="private archive path")
    parser.add_argument("--inventory", type=Path, required=True, help="private reviewed inventory JSON")


def _save_command(args: argparse.Namespace) -> dict[str, Any]:
    return save_session(args.directory, args.archive, args.inventory)


def _restore_command(args: argparse.Namespace) -> dict[str, Any]:
    return restore_session(args.directory, args.archive, args.inventory)


def _inventory_command(args: argparse.Namespace) -> dict[str, Any]:
    source_base = _parse_source_base_arguments(args.source_base)
    return generate_inventory(
        args.directory,
        session_id=args.session_id,
        selected_untracked=args.selected_untracked,
        include_paths=args.include_path,
        source_base=source_base,
        output=args.output,
    )


def _parse_source_base_arguments(values: Sequence[str]) -> Mapping[str, Any] | str | None:
    if not values:
        return None
    if len(values) == 1 and "=" not in values[0]:
        return values[0]
    commits: dict[str, str] = {}
    for value in values:
        stage, separator, commit = value.partition("=")
        if not separator or not STAGE_RE.fullmatch(stage) or not commit:
            raise ArchiveError("--source-base accepts one commit or repeated STAGE=COMMIT values")
        commits[stage] = commit
    return {"kind": "git", "commits": commits}


def register(subparsers: Any) -> None:
    """Register archive commands on an existing argparse subparser group."""

    save_parser = subparsers.add_parser("save", help="save selected private session files")
    _add_common_arguments(save_parser)
    save_parser.set_defaults(func=_save_command)

    restore_parser = subparsers.add_parser("restore", help="restore selected private session files")
    _add_common_arguments(restore_parser)
    restore_parser.set_defaults(func=_restore_command)

    inventory_parser = subparsers.add_parser("inventory", help="generate a private session inventory")
    inventory_parser.add_argument("--directory", type=Path, required=True, help="session root")
    inventory_parser.add_argument("--session-id", default=None, help="session identity")
    inventory_parser.add_argument("--output", type=Path, required=True, help="private inventory JSON")
    inventory_parser.add_argument(
        "--selected-untracked",
        "--select-untracked",
        dest="selected_untracked",
        action="append",
        default=[],
        help="relative untracked source path to include; repeatable",
    )
    inventory_parser.add_argument(
        "--include-path",
        dest="include_path",
        action="append",
        default=[],
        help="relative private record to include; repeatable",
    )
    inventory_parser.add_argument(
        "--source-base",
        action="append",
        default=[],
        help="frozen Git commit, or repeated STAGE=COMMIT values for per-stage bases",
    )
    inventory_parser.set_defaults(func=_inventory_command)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    register(subparsers)
    args = parser.parse_args(argv)
    try:
        result = args.func(args)
        if result is not None:
            print(json.dumps(result, sort_keys=True))
        return 0
    except (ArchiveError, OSError, tarfile.TarError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
