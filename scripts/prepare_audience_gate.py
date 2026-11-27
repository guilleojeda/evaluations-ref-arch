#!/usr/bin/env python3
"""Prepare and verify the private native audience-gate inputs.

The audience gate deliberately carries the two inputs used by the public
native example: the published ``denial-case.json`` scenario and the
``original-trace.json`` captured from that scenario.  It does not build a
reviewed-case replay, append the release suite, or call AWS.  The resulting
archive and pointer are local artifacts; ``publish-command`` only prints the
bounded S3 command for the private presenter wrapper.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import shlex
import sys
import tarfile
from typing import Any, Mapping


ARCHIVE_NAME = "staging.tar.gz"
# The evaluation role already has read access to the Phase 20 evidence
# namespace.  Keep the audience object separate from the release input archive
# while avoiding any new IAM grant.
DEFAULT_PREFIX = "agent-evaluation/phase20/audience-inputs"
SCENARIO_MEMBER = "staging/denial-case.json"
TRACE_MEMBER = "staging/original-trace.json"
MANIFEST_MEMBER = "staging/manifest.json"
CHECKSUMS_MEMBER = "staging/SHA256SUMS"
POINTER_FIELDS = {
    "schemaVersion",
    "purpose",
    "bucket",
    "s3Key",
    "sha256",
    "scenarioSha256",
    "traceSha256",
}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
S3_KEY_RE = re.compile(
    rf"^{re.escape(DEFAULT_PREFIX)}/[0-9a-f]{{64}}/{re.escape(ARCHIVE_NAME)}$"
)


class AudiencePreparationError(ValueError):
    """An audience input, archive, pointer, or output safety check failed."""


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _canonical(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False).encode("utf-8") + b"\n"


def _read_bytes(path: Path, label: str) -> bytes:
    if path.is_symlink() or not path.is_file():
        raise AudiencePreparationError(f"{label} is unavailable: {path}")
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise AudiencePreparationError(f"cannot read {label}: {path}") from exc
    if not raw:
        raise AudiencePreparationError(f"{label} is empty: {path}")
    return raw


def _read_json_bytes(raw: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AudiencePreparationError(f"{label} is not valid UTF-8 JSON") from exc
    if not isinstance(value, dict):
        raise AudiencePreparationError(f"{label} must be a JSON object")
    return value


def _read_json(path: Path, label: str) -> tuple[dict[str, Any], bytes]:
    raw = _read_bytes(path, label)
    return _read_json_bytes(raw, label), raw


def _nonempty(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise AudiencePreparationError(f"{label} must be a non-empty string")
    return value


def _sha_field(value: Any, label: str) -> str:
    if not isinstance(value, str) or SHA256_RE.fullmatch(value) is None:
        raise AudiencePreparationError(f"{label} must be a lowercase SHA-256 digest")
    return value


def _validate_scenario(raw: bytes) -> dict[str, Any]:
    scenario = _read_json_bytes(raw, "native denial scenario")
    _nonempty(scenario.get("scenario_id"), "scenario_id")
    metadata = scenario.get("metadata")
    if not isinstance(metadata, Mapping):
        raise AudiencePreparationError("native scenario metadata is missing")
    source = metadata.get("source")
    if not isinstance(source, Mapping):
        raise AudiencePreparationError("native scenario metadata.source is missing")
    trace_id = _nonempty(source.get("trace_id"), "scenario metadata.source.trace_id")
    _nonempty(source.get("session_id"), "scenario metadata.source.session_id")
    turns = scenario.get("turns")
    if not isinstance(turns, list) or len(turns) != 1 or not isinstance(turns[0], Mapping):
        raise AudiencePreparationError("native scenario must contain exactly one turn")
    _nonempty(turns[0].get("input"), "scenario turns[0].input")
    _nonempty(turns[0].get("expected_response"), "scenario turns[0].expected_response")
    expected = metadata.get("expected_recommendation")
    if not isinstance(expected, Mapping):
        raise AudiencePreparationError("scenario metadata.expected_recommendation is missing")
    action = _nonempty(expected.get("action"), "scenario expected recommendation action")
    if action == "Other":
        if expected.get("target") is not None or expected.get("unit") is not None or expected.get("value") is not None:
            raise AudiencePreparationError("native Other recommendation has an invalid shape")
    else:
        for key in ("target", "value", "unit"):
            _nonempty(expected.get(key), f"scenario expected recommendation {key}")
    # Return the source identity used by trace validation without copying it
    # into the candidate-safe pointer.
    return {"scenarioId": scenario["scenario_id"], "traceId": trace_id}


def _trace_ids(value: Any) -> set[str]:
    ids: set[str] = set()
    if isinstance(value, Mapping):
        for key, item in value.items():
            if key in {"traceId", "trace_id"} and isinstance(item, str) and item:
                ids.add(item)
            ids.update(_trace_ids(item))
    elif isinstance(value, list):
        for item in value:
            ids.update(_trace_ids(item))
    return ids


def _validate_trace(raw: bytes, trace_id: str) -> None:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AudiencePreparationError("original trace is not valid UTF-8 JSON") from exc
    if not isinstance(value, (dict, list)):
        raise AudiencePreparationError("original trace must be a JSON object or span list")
    if trace_id not in _trace_ids(value):
        raise AudiencePreparationError("original trace does not contain the scenario source trace ID")


def _validate_inputs(scenario_path: Path, trace_path: Path) -> tuple[bytes, bytes, dict[str, Any]]:
    scenario_raw = _read_bytes(scenario_path, "native denial scenario")
    trace_raw = _read_bytes(trace_path, "original trace")
    identity = _validate_scenario(scenario_raw)
    _validate_trace(trace_raw, identity["traceId"])
    return scenario_raw, trace_raw, identity


def _safe_member(name: str) -> None:
    path = PurePosixPath(name)
    if not name or path.is_absolute() or ".." in path.parts:
        raise AudiencePreparationError(f"archive member is unsafe: {name!r}")


def _archive_bytes(members: Mapping[str, bytes]) -> bytes:
    for name in members:
        _safe_member(name)
    tar_raw = io.BytesIO()
    with gzip.GzipFile(fileobj=tar_raw, mode="wb", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as archive:
            for name in sorted(members):
                data = members[name]
                info = tarfile.TarInfo(name)
                info.size = len(data)
                info.mode = 0o600
                info.mtime = 0
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                archive.addfile(info, io.BytesIO(data))
    return tar_raw.getvalue()


def _archive_members(raw: bytes) -> dict[str, bytes]:
    try:
        opened = tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz")
    except (OSError, tarfile.TarError) as exc:
        raise AudiencePreparationError("audience archive is not a readable gzip tar archive") from exc
    members: dict[str, bytes] = {}
    with opened:
        for member in opened.getmembers():
            _safe_member(member.name)
            if not member.isfile() or member.issym() or member.islnk():
                raise AudiencePreparationError(f"audience archive contains a non-regular member: {member.name}")
            if member.name in members:
                raise AudiencePreparationError(f"audience archive contains duplicate member: {member.name}")
            stream = opened.extractfile(member)
            if stream is None:
                raise AudiencePreparationError(f"audience archive member is unreadable: {member.name}")
            members[member.name] = stream.read()
    return members


def _pointer(pointer: Mapping[str, Any]) -> dict[str, Any]:
    if set(pointer) != POINTER_FIELDS:
        raise AudiencePreparationError("audience pointer has unsupported or missing fields")
    if pointer.get("schemaVersion") != 1:
        raise AudiencePreparationError("audience pointer schemaVersion must be 1")
    _nonempty(pointer.get("purpose"), "audience pointer purpose")
    _nonempty(pointer.get("bucket"), "audience pointer bucket")
    archive_sha = _sha_field(pointer.get("sha256"), "audience pointer sha256")
    _sha_field(pointer.get("scenarioSha256"), "audience pointer scenarioSha256")
    _sha_field(pointer.get("traceSha256"), "audience pointer traceSha256")
    key = pointer.get("s3Key")
    if not isinstance(key, str) or not S3_KEY_RE.fullmatch(key) or key != f"{DEFAULT_PREFIX}/{archive_sha}/{ARCHIVE_NAME}":
        raise AudiencePreparationError("audience pointer s3Key must be content-addressed under the native audience prefix")
    return dict(pointer)


def _validate_archive(pointer: Mapping[str, Any], archive_path: Path) -> dict[str, Any]:
    pointer_value = _pointer(pointer)
    archive_raw = _read_bytes(archive_path, "audience archive")
    archive_sha = _sha(archive_raw)
    if archive_sha != pointer_value["sha256"]:
        raise AudiencePreparationError("audience pointer sha256 differs from archive bytes")
    members = _archive_members(archive_raw)
    required = {MANIFEST_MEMBER, SCENARIO_MEMBER, TRACE_MEMBER, CHECKSUMS_MEMBER}
    if set(members) != required:
        raise AudiencePreparationError("audience archive contains an unexpected or missing member")
    manifest = _read_json_bytes(members[MANIFEST_MEMBER], "audience archive manifest")
    if manifest.get("schemaVersion") != 1 or manifest.get("kind") != "native-audience-gate-inputs":
        raise AudiencePreparationError("audience archive manifest is not schemaVersion 1 native input data")
    files = manifest.get("files")
    digests = manifest.get("digests")
    if files != {"scenario": "denial-case.json", "trace": "original-trace.json"} or not isinstance(digests, Mapping):
        raise AudiencePreparationError("audience archive manifest has invalid input members")
    scenario_sha = _sha(members[SCENARIO_MEMBER])
    trace_sha = _sha(members[TRACE_MEMBER])
    if scenario_sha != pointer_value["scenarioSha256"] or scenario_sha != digests.get("scenarioSha256"):
        raise AudiencePreparationError("audience scenario digest does not match pointer and manifest")
    if trace_sha != pointer_value["traceSha256"] or trace_sha != digests.get("traceSha256"):
        raise AudiencePreparationError("audience trace digest does not match pointer and manifest")
    expected_checksums = (
        f"{_sha(members[MANIFEST_MEMBER])}  {MANIFEST_MEMBER}\n"
        f"{scenario_sha}  {SCENARIO_MEMBER}\n"
        f"{trace_sha}  {TRACE_MEMBER}\n"
    ).encode("ascii")
    if members[CHECKSUMS_MEMBER] != expected_checksums:
        raise AudiencePreparationError("audience archive checksums are not canonical")
    identity = _validate_scenario(members[SCENARIO_MEMBER])
    _validate_trace(members[TRACE_MEMBER], identity["traceId"])
    return {
        "archiveSha256": archive_sha,
        "scenarioSha256": scenario_sha,
        "traceSha256": trace_sha,
        "scenarioId": identity["scenarioId"],
    }


def _write_exclusive(path: Path, raw: bytes, label: str) -> None:
    if path.exists() or path.is_symlink():
        if path.is_file() and not path.is_symlink() and path.read_bytes() == raw:
            return
        raise AudiencePreparationError(f"refusing to replace existing {label}: {path}")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_bytes(raw)


def prepare(args: argparse.Namespace) -> dict[str, Any]:
    scenario_raw, trace_raw, identity = _validate_inputs(Path(args.scenario), Path(args.trace))
    manifest = {
        "schemaVersion": 1,
        "kind": "native-audience-gate-inputs",
        "files": {"scenario": "denial-case.json", "trace": "original-trace.json"},
        "digests": {
            "scenarioSha256": _sha(scenario_raw),
            "traceSha256": _sha(trace_raw),
        },
    }
    manifest_raw = _json_bytes(manifest)
    checksums = (
        f"{_sha(manifest_raw)}  {MANIFEST_MEMBER}\n"
        f"{_sha(scenario_raw)}  {SCENARIO_MEMBER}\n"
        f"{_sha(trace_raw)}  {TRACE_MEMBER}\n"
    ).encode("ascii")
    archive_raw = _archive_bytes({
        MANIFEST_MEMBER: manifest_raw,
        SCENARIO_MEMBER: scenario_raw,
        TRACE_MEMBER: trace_raw,
        CHECKSUMS_MEMBER: checksums,
    })
    archive_sha = _sha(archive_raw)
    bucket = _nonempty(args.bucket, "audience bucket")
    pointer = {
        "schemaVersion": 1,
        "purpose": "Phase 20 native audience gate input handoff",
        "bucket": bucket,
        "s3Key": f"{DEFAULT_PREFIX}/{archive_sha}/{ARCHIVE_NAME}",
        "sha256": archive_sha,
        "scenarioSha256": _sha(scenario_raw),
        "traceSha256": _sha(trace_raw),
    }
    pointer_raw = _json_bytes(pointer)
    output = Path(args.output_dir).resolve()
    verification = (
        _validate_archive(pointer, output / ARCHIVE_NAME)
        if (output / ARCHIVE_NAME).is_file()
        else {
            "archiveSha256": archive_sha,
            "scenarioSha256": _sha(scenario_raw),
            "traceSha256": _sha(trace_raw),
            "scenarioId": identity["scenarioId"],
        }
    )
    if getattr(args, "dry_run", False):
        return {
            "status": "dry-run",
            "externalWrites": 0,
            "archiveSha256": archive_sha,
            "scenarioSha256": _sha(scenario_raw),
            "traceSha256": _sha(trace_raw),
            "scenarioId": identity["scenarioId"],
            "verification": verification,
        }
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    archive_path = output / ARCHIVE_NAME
    pointer_path = output / "audience-input.json"
    _write_exclusive(archive_path, archive_raw, "audience archive")
    _write_exclusive(pointer_path, pointer_raw, "audience pointer")
    _validate_archive(pointer, archive_path)
    return {
        "status": "prepared",
        "externalWrites": 0,
        "archive": str(archive_path),
        "pointer": str(pointer_path),
        "archiveSha256": archive_sha,
        "scenarioSha256": _sha(scenario_raw),
        "traceSha256": _sha(trace_raw),
        "scenarioId": identity["scenarioId"],
        "s3Key": pointer["s3Key"],
    }


def _publish_command(pointer: Mapping[str, Any], archive_path: Path, *, profile: str, region: str, owner: str) -> str:
    pointer_value = _pointer(pointer)
    archive_raw = _read_bytes(archive_path, "audience archive")
    if _sha(archive_raw) != pointer_value["sha256"]:
        raise AudiencePreparationError("audience archive changed after pointer creation")
    checksum = base64.b64encode(bytes.fromhex(pointer_value["sha256"])).decode("ascii")
    command = [
        "aws", "--profile", profile, "--region", region, "s3api", "put-object",
        "--expected-bucket-owner", owner, "--bucket", pointer_value["bucket"],
        "--key", pointer_value["s3Key"], "--body", str(archive_path),
        "--checksum-algorithm", "SHA256", "--checksum-sha256", checksum,
        "--metadata", f"sha256={pointer_value['sha256']}",
        "--server-side-encryption", "AES256", "--if-none-match", "*",
    ]
    return " ".join(shlex.quote(part) for part in command)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="prepare_audience_gate.py", description=__doc__)
    sub = root.add_subparsers(dest="command", required=True)
    prep = sub.add_parser("prepare", help="prepare a content-addressed private native input archive")
    prep.add_argument("--scenario", required=True, type=Path)
    prep.add_argument("--trace", required=True, type=Path)
    prep.add_argument("--bucket", required=True)
    prep.add_argument("--output-dir", required=True, type=Path)
    prep.add_argument("--dry-run", action="store_true")
    ver = sub.add_parser("verify", help="verify a native input archive and pointer")
    ver.add_argument("--archive", required=True, type=Path)
    ver.add_argument("--pointer", required=True, type=Path)
    pub = sub.add_parser("publish-command", help="print the bounded private S3 upload command")
    pub.add_argument("--archive", required=True, type=Path)
    pub.add_argument("--pointer", required=True, type=Path)
    pub.add_argument("--profile", default="reinvent-2026-talk")
    pub.add_argument("--region", default="us-east-1")
    pub.add_argument("--expected-bucket-owner", default="027224425948")
    return root


def main(argv: list[str] | None = None) -> int:
    try:
        args = parser().parse_args(argv)
        if args.command == "prepare":
            result = prepare(args)
        elif args.command == "verify":
            pointer = _read_json(args.pointer, "audience pointer")[0]
            result = {"status": "verified", **_validate_archive(pointer, args.archive)}
        else:
            pointer = _read_json(args.pointer, "audience pointer")[0]
            result = {
                "status": "publish-command-ready",
                "externalWrites": 0,
                "archive": str(args.archive),
                "pointer": str(args.pointer),
                "publishCommand": _publish_command(
                    pointer, args.archive, profile=args.profile, region=args.region,
                    owner=args.expected_bucket_owner,
                ),
            }
        print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))
        return 0
    except (AudiencePreparationError, OSError, ValueError, TypeError, KeyError) as exc:
        print(f"prepare-audience-gate: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
