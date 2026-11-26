#!/usr/bin/env python3
"""Prepare a carried S5 gate with one verified live audience case.

The command is intentionally local.  It reads the exact carried private gate,
the bridge artifacts, and the S5 qualification pointer; it never calls AWS or
GitHub and never changes the source archive or pointer.  ``prepare`` writes a
new deterministic archive and candidate-safe pointer.  ``verify`` authenticates
an already prepared pair.  ``publish-command`` prints the one bounded,
content-addressed S3 ``put-object`` command for a presenter who is already
authenticated through SSO.

The archive keeps the trusted qualifier's evaluator and every existing case
row byte-for-byte.  The new case/bundle pair is appended in suite order.  A
private member map preserves the bridge/case/bundle/trace relationship without
putting native identifiers into the pointer that may be committed to GitHub.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import stat
import sys
import tarfile
import tempfile
from typing import Any, Mapping


SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
S3_PREFIX = "agent-evaluation/phase18/inputs"
POINTER_FIELDS = {
    "schemaVersion",
    "purpose",
    "bucket",
    "s3Key",
    "sha256",
    "suiteSha256",
    "evaluatorSha256",
    "caseIds",
}
MAP_MEMBER = "staging/live-case-map.json"
BRIDGE_KIND = "native-case-bridge"
ARCHIVE_NAME = "staging.tar.gz"


class GatePreparationError(ValueError):
    """An input, identity, archive, or output safety check failed."""


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
        raise GatePreparationError(f"{label} is unavailable: {path}")
    try:
        return path.read_bytes()
    except OSError as exc:
        raise GatePreparationError(f"cannot read {label}: {path}") from exc


def _read_json(path: Path, label: str) -> dict[str, Any]:
    raw = _read_bytes(path, label)
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise GatePreparationError(f"{label} is not valid UTF-8 JSON: {path}") from exc
    if not isinstance(value, dict):
        raise GatePreparationError(f"{label} must be a JSON object: {path}")
    return value


def _require_sha(value: Any, label: str) -> str:
    if not isinstance(value, str) or SHA256_RE.fullmatch(value) is None:
        raise GatePreparationError(f"{label} must be a lowercase SHA-256 digest")
    return value


def _require_nonempty(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise GatePreparationError(f"{label} must be a non-empty string")
    return value


def _safe_member(name: str) -> None:
    path = PurePosixPath(name)
    if not name or path.is_absolute() or ".." in path.parts:
        raise GatePreparationError(f"archive member is unsafe: {name!r}")


def _read_archive(path: Path) -> dict[str, bytes]:
    raw = _read_bytes(path, "base staging archive")
    try:
        opened = tarfile.open(fileobj=io.BytesIO(raw), mode="r:*")
    except (OSError, tarfile.TarError) as exc:
        raise GatePreparationError("base staging archive is not a readable tar archive") from exc
    members: dict[str, bytes] = {}
    with opened:
        for member in opened.getmembers():
            _safe_member(member.name)
            if not member.isfile() or member.issym() or member.islnk():
                raise GatePreparationError(f"base staging archive contains a non-regular member: {member.name}")
            if member.name in members:
                raise GatePreparationError(f"base staging archive contains duplicate member: {member.name}")
            stream = opened.extractfile(member)
            if stream is None:
                raise GatePreparationError(f"base staging archive member is unreadable: {member.name}")
            members[member.name] = stream.read()
    if "staging/manifest.json" not in members or "staging/suite.json" not in members or "staging/evaluator.json" not in members:
        raise GatePreparationError("base staging archive is missing manifest, suite, or evaluator")
    return members


def _json_member(members: Mapping[str, bytes], name: str, label: str) -> dict[str, Any]:
    raw = members.get(name)
    if raw is None:
        raise GatePreparationError(f"archive is missing {label}: {name}")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise GatePreparationError(f"archive {label} is not valid JSON: {name}") from exc
    if not isinstance(value, dict):
        raise GatePreparationError(f"archive {label} must be an object: {name}")
    return value


def _case_body(envelope: Mapping[str, Any], label: str) -> tuple[dict[str, Any], str]:
    case = envelope.get("case")
    if not isinstance(case, dict):
        raise GatePreparationError(f"{label} has no case object")
    claimed = _require_sha(envelope.get("caseSha256"), f"{label}.caseSha256")
    actual = _sha(_canonical(case))
    if actual != claimed:
        raise GatePreparationError(f"{label}.caseSha256 does not match case content")
    _require_nonempty(case.get("caseId"), f"{label}.case.caseId")
    return case, claimed


def _load_reviewed_case_validator() -> Any:
    """Load the project's authoritative case validator when available."""

    agent_root = Path(__file__).resolve().parents[1] / "agent"
    if str(agent_root) not in sys.path:
        sys.path.insert(0, str(agent_root))
    try:
        from reviewed_cases import load_frozen_case
    except (ImportError, ModuleNotFoundError):
        return None
    return load_frozen_case


def _validate_case_bundle(case_path: Path, bundle_path: Path, *, label: str) -> tuple[dict[str, Any], str, str, dict[str, Any]]:
    envelope = _read_json(case_path, f"{label} frozen case")
    case, case_sha = _case_body(envelope, label)
    bundle_raw = _read_bytes(bundle_path, f"{label} captured bundle")
    bundle_sha = _sha(bundle_raw)
    evidence = case.get("evidence")
    if not isinstance(evidence, dict) or evidence.get("bundleSha256") != bundle_sha:
        raise GatePreparationError(f"{label} case evidence bundleSha256 differs from captured bundle")
    validator = _load_reviewed_case_validator()
    if validator is not None:
        try:
            loaded = validator(case_path, bundle_path)
        except Exception as exc:
            raise GatePreparationError(f"{label} frozen case/bundle validation failed: {exc}") from exc
        if loaded.get("caseSha256") != case_sha or loaded.get("bundleSha256") != bundle_sha:
            raise GatePreparationError(f"{label} validator identity differs from the selected pair")
    return envelope, case_sha, bundle_sha, case


def _validate_bridge(bridge_path: Path, case_path: Path, bundle_path: Path) -> tuple[dict[str, Any], str, str, str, dict[str, Any]]:
    bridge = _read_json(bridge_path, "live bridge manifest")
    if bridge.get("kind") != BRIDGE_KIND or bridge.get("schemaVersion") != 1:
        raise GatePreparationError("live bridge manifest is not a schemaVersion 1 native-case-bridge")
    bridge_raw = _read_bytes(bridge_path, "live bridge manifest")
    bridge_sha = _sha(bridge_raw)
    envelope, case_sha, bundle_sha, case = _validate_case_bundle(case_path, bundle_path, label="live")
    if bridge.get("caseSha256") != case_sha:
        raise GatePreparationError("live bridge caseSha256 differs from case.frozen.json")
    if bridge.get("bundleSha256") != bundle_sha:
        raise GatePreparationError("live bridge bundleSha256 differs from captured-bundle.json")
    bridge_id = _require_nonempty(bridge.get("caseId"), "live bridge caseId")
    if case.get("caseId") != bridge_id:
        raise GatePreparationError("live bridge caseId differs from case.frozen.json")
    # The bridge producer must hand off an opaque ID.  Native IDs are retained
    # in private traceRef/native handoff fields, never in the CI roster key.
    if len(bridge_id) < 12 or any(identity in bridge_id for identity in (
        str(bridge.get("traceId", "")),
        str(bridge.get("sessionId", "")),
        str(bridge.get("runId") or bridge.get("originatingRunId") or ""),
    ) if identity):
        raise GatePreparationError("live bridge caseId embeds a native trace/session/run identity")
    if not re.search(r"(?:^|[.-])[0-9a-f]{12,}(?:$|[.-])", bridge_id):
        raise GatePreparationError("live bridge caseId is not opaque/digest-based")

    evidence = case.get("evidence")
    trace_ref = evidence.get("traceRef") if isinstance(evidence, dict) else None
    origin = _json_member({"bundle.json": _read_bytes(bundle_path, "captured bundle")}, "bundle.json", "bundle")
    bundle_origin = origin.get("origin")
    if not isinstance(trace_ref, dict) or not isinstance(bundle_origin, dict):
        raise GatePreparationError("live case/bundle lacks trace and origin provenance")
    if bridge.get("traceId") is not None and trace_ref.get("traceId") != bridge.get("traceId"):
        raise GatePreparationError("live traceRef.traceId differs from bridge manifest")
    bridge_run_id = bridge.get("runId") or bridge.get("originatingRunId")
    if bridge_run_id is not None and trace_ref.get("runId") != bridge_run_id:
        raise GatePreparationError("live traceRef.runId differs from bridge manifest")
    if trace_ref.get("traceId") != bundle_origin.get("sourceTraceId"):
        raise GatePreparationError("captured bundle sourceTraceId differs from case traceRef")
    if trace_ref.get("runId") != bundle_origin.get("runId"):
        raise GatePreparationError("captured bundle runId differs from case traceRef")
    return bridge, bridge_sha, case_sha, bundle_sha, {"envelope": envelope, "case": case, "bundle": origin}


def _load_pointer(path: Path, label: str = "qualification pointer") -> dict[str, Any]:
    pointer = _read_json(path, label)
    if set(pointer) != POINTER_FIELDS:
        raise GatePreparationError(f"{label} has unsupported or missing fields")
    if pointer.get("schemaVersion") != 1:
        raise GatePreparationError(f"{label} schemaVersion must be 1")
    _require_nonempty(pointer.get("purpose"), f"{label}.purpose")
    _require_nonempty(pointer.get("bucket"), f"{label}.bucket")
    archive_sha = _require_sha(pointer.get("sha256"), f"{label}.sha256")
    _require_sha(pointer.get("suiteSha256"), f"{label}.suiteSha256")
    _require_sha(pointer.get("evaluatorSha256"), f"{label}.evaluatorSha256")
    case_ids = pointer.get("caseIds")
    if not isinstance(case_ids, list) or not case_ids or not all(isinstance(value, str) and value for value in case_ids):
        raise GatePreparationError(f"{label}.caseIds must be a non-empty list of strings")
    if len(case_ids) != len(set(case_ids)):
        raise GatePreparationError(f"{label}.caseIds contains duplicates")
    key = pointer.get("s3Key")
    if not isinstance(key, str) or key != f"{S3_PREFIX}/{archive_sha}/staging.tar.gz":
        raise GatePreparationError(f"{label}.s3Key must be the content-addressed Phase 18 input key")
    return pointer


def _manifest_rows(members: Mapping[str, bytes]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    manifest = _json_member(members, "staging/manifest.json", "manifest")
    rows = manifest.get("cases")
    if not isinstance(rows, list) or not rows:
        raise GatePreparationError("staging manifest has no case rows")
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            raise GatePreparationError("staging manifest contains a malformed case row")
        case_id = _require_nonempty(row.get("caseId"), "staging manifest caseId")
        if case_id in seen:
            raise GatePreparationError(f"staging manifest contains duplicate case ID: {case_id}")
        seen.add(case_id)
        _require_sha(row.get("caseSha256"), f"staging manifest {case_id}.caseSha256")
        _require_sha(row.get("bundleSha256"), f"staging manifest {case_id}.bundleSha256")
        case_name = _require_nonempty(row.get("case"), f"staging manifest {case_id}.case")
        bundle_name = _require_nonempty(row.get("bundle"), f"staging manifest {case_id}.bundle")
        _safe_member("staging/" + case_name)
        _safe_member("staging/" + bundle_name)
        case = _json_member(members, "staging/" + case_name, f"case {case_id}")
        parsed_case, case_sha = _case_body(case, f"staging case {case_id}")
        if parsed_case.get("caseId") != case_id or case_sha != row["caseSha256"]:
            raise GatePreparationError(f"staging case row identity differs: {case_id}")
        bundle_raw = members.get("staging/" + bundle_name)
        if bundle_raw is None or _sha(bundle_raw) != row["bundleSha256"]:
            raise GatePreparationError(f"staging bundle row digest differs: {case_id}")
        evidence = parsed_case.get("evidence")
        if not isinstance(evidence, dict) or evidence.get("bundleSha256") != row["bundleSha256"]:
            raise GatePreparationError(f"staging case evidence differs from row bundle: {case_id}")
    return manifest, rows


def _suite_rows(members: Mapping[str, bytes]) -> tuple[dict[str, Any], list[dict[str, str]]]:
    suite = _json_member(members, "staging/suite.json", "suite")
    rows = suite.get("cases")
    if suite.get("schemaVersion") != 1 or not isinstance(rows, list) or not rows:
        raise GatePreparationError("staging suite must be a non-empty schemaVersion 1 case list")
    normalized: list[dict[str, str]] = []
    for entry in rows:
        if not isinstance(entry, dict):
            raise GatePreparationError("staging suite contains a malformed case entry")
        case = _require_nonempty(entry.get("case"), "staging suite case")
        bundle = _require_nonempty(entry.get("bundle"), "staging suite bundle")
        normalized.append({"case": case, "bundle": bundle})
    return suite, normalized


def _archive_bytes(members: Mapping[str, bytes]) -> bytes:
    tar_raw = io.BytesIO()
    with tarfile.open(fileobj=tar_raw, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for name in sorted(members):
            _safe_member(name)
            data = members[name]
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = stat.S_IRUSR | stat.S_IWUSR
            info.mtime = 0
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            archive.addfile(info, io.BytesIO(data))
    compressed = io.BytesIO()
    with gzip.GzipFile(fileobj=compressed, mode="wb", compresslevel=9, mtime=0, filename="") as stream:
        stream.write(tar_raw.getvalue())
    return compressed.getvalue()


def _write_exclusive(path: Path, raw: bytes, label: str) -> None:
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise GatePreparationError(f"{label} is not a regular file: {path}")
    if path.exists():
        if _read_bytes(path, label) != raw:
            raise GatePreparationError(f"refusing to overwrite existing {label}: {path}")
        return
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_bytes(raw)
        temporary.chmod(stat.S_IRUSR | stat.S_IWUSR)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def _validate_pointer_archive(pointer: Mapping[str, Any], archive_path: Path, *, expected_base: Mapping[str, Any] | None = None) -> dict[str, Any]:
    archive_raw = _read_bytes(archive_path, "prepared staging archive")
    archive_sha = _sha(archive_raw)
    if pointer.get("sha256") != archive_sha:
        raise GatePreparationError("qualification pointer sha256 differs from archive bytes")
    members = _read_archive(archive_path)
    manifest, manifest_rows = _manifest_rows(members)
    suite, suite_rows = _suite_rows(members)
    suite_raw = members["staging/suite.json"]
    suite_sha = _sha(suite_raw)
    if pointer.get("suiteSha256") != suite_sha:
        raise GatePreparationError("qualification pointer suiteSha256 differs from suite bytes")
    evaluator_sha = _sha(members["staging/evaluator.json"])
    if pointer.get("evaluatorSha256") != evaluator_sha:
        raise GatePreparationError("qualification pointer evaluatorSha256 differs from evaluator bytes")
    manifest_ids = [row["caseId"] for row in manifest_rows]
    suite_ids: list[str] = []
    for entry in suite_rows:
        case = _json_member(members, "staging/" + entry["case"], "suite case")
        body, _ = _case_body(case, "suite case")
        suite_ids.append(_require_nonempty(body.get("caseId"), "suite caseId"))
    if manifest_ids != suite_ids or pointer.get("caseIds") != manifest_ids:
        raise GatePreparationError("pointer, manifest, and suite case roster/order differ")
    sums_raw = members.get("SHA256SUMS")
    if sums_raw is None:
        raise GatePreparationError("archive is missing SHA256SUMS")
    expected_sums = {
        name: _sha(data)
        for name, data in members.items()
        if name != "SHA256SUMS"
    }
    observed_sums: dict[str, str] = {}
    for line in sums_raw.decode("ascii").splitlines():
        parts = line.split()
        if len(parts) != 2 or parts[1] in observed_sums:
            raise GatePreparationError("SHA256SUMS is malformed")
        observed_sums[parts[1]] = _require_sha(parts[0], f"SHA256SUMS {parts[1]}")
    if observed_sums != expected_sums:
        raise GatePreparationError("SHA256SUMS does not cover the exact archive members")
    map_value = _json_member(members, MAP_MEMBER, "live-case member map")
    if map_value.get("schemaVersion") != 1 or map_value.get("kind") != "live-case-kit-member-map":
        raise GatePreparationError("live-case member map is invalid")
    ci = map_value.get("ci")
    if not isinstance(ci, dict) or ci.get("caseId") not in manifest_ids:
        raise GatePreparationError("live-case member map does not identify a selected CI row")
    if expected_base is not None:
        base_ids = expected_base.get("caseIds")
        if not isinstance(base_ids, list) or manifest_ids[: len(base_ids)] != base_ids:
            raise GatePreparationError("prepared archive does not preserve the base roster prefix")
    return {
        "status": "verified",
        "archiveSha256": archive_sha,
        "suiteSha256": suite_sha,
        "evaluatorSha256": evaluator_sha,
        "caseIds": manifest_ids,
        "memberCount": len(members),
        "liveCaseId": ci["caseId"],
    }


def _member_map(*, bridge: Mapping[str, Any], bridge_path: Path, bridge_sha: str, case_path: Path, case_file_sha: str, source_case_sha: str, bundle_path: Path, source_bundle_sha: str, case_id: str, case_sha: str, bundle_sha: str, case: Mapping[str, Any], archive_case: str, archive_bundle: str) -> dict[str, Any]:
    evidence = case.get("evidence")
    trace_ref = evidence.get("traceRef") if isinstance(evidence, Mapping) else {}
    return {
        "schemaVersion": 1,
        "kind": "live-case-kit-member-map",
        "privateOnly": True,
        "source": {
            "bridgeManifest": {"path": str(bridge_path), "sha256": bridge_sha},
            "case": {"path": str(case_path), "fileSha256": case_file_sha, "caseSha256": source_case_sha},
            "bundle": {"path": str(bundle_path), "fileSha256": source_bundle_sha},
        },
        "members": {"case": archive_case, "bundle": archive_bundle, "map": MAP_MEMBER},
        "ci": {
            "caseId": case_id,
            "caseSha256": case_sha,
            "bundleSha256": bundle_sha,
            "suiteMember": "staging/suite.json",
            "manifestMember": "staging/manifest.json",
        },
        "traceToCi": {
            "traceId": trace_ref.get("traceId"),
            "runId": trace_ref.get("runId"),
            "traceSha256": trace_ref.get("sha256"),
            "bridgeCaseId": bridge.get("caseId"),
            "bridgeCaseSha256": bridge.get("caseSha256"),
            "bridgeBundleSha256": bridge.get("bundleSha256"),
        },
    }


def prepare(args: argparse.Namespace) -> dict[str, Any]:
    pointer = _load_pointer(Path(args.qualification_input), "base qualification pointer")
    base_archive = Path(args.base_archive)
    base_members = _read_archive(base_archive)
    base_manifest, base_rows = _manifest_rows(base_members)
    base_suite, base_suite_rows = _suite_rows(base_members)
    if _sha(_read_bytes(base_archive, "base staging archive")) != pointer["sha256"]:
        raise GatePreparationError("base qualification pointer sha256 does not match carried archive")
    if [row["caseId"] for row in base_rows] != pointer["caseIds"]:
        raise GatePreparationError("base pointer caseIds do not match carried archive roster")
    suite_ids = []
    for entry in base_suite_rows:
        suite_case = _json_member(base_members, "staging/" + entry["case"], "base suite case")
        suite_body, _ = _case_body(suite_case, "base suite case")
        suite_ids.append(_require_nonempty(suite_body.get("caseId"), "base suite caseId"))
    if suite_ids != pointer["caseIds"]:
        raise GatePreparationError("base suite roster does not match carried manifest roster")
    if _sha(base_members["staging/suite.json"]) != pointer["suiteSha256"]:
        raise GatePreparationError("base pointer suiteSha256 does not match carried archive")
    if _sha(base_members["staging/evaluator.json"]) != pointer["evaluatorSha256"]:
        raise GatePreparationError("base pointer evaluatorSha256 does not match carried archive")
    bridge, bridge_sha, source_case_sha, source_bundle_sha, live = _validate_bridge(
        Path(args.bridge_manifest), Path(args.case), Path(args.bundle)
    )
    case = live["case"]
    case_id = _require_nonempty(case.get("caseId"), "live case.caseId")
    if case_id in pointer["caseIds"] or case_id in {row["caseId"] for row in base_rows}:
        raise GatePreparationError(f"live case is already present in carried roster: {case_id}")
    case_member = f"staging/cases/live-{case_id}.frozen.json"
    bundle_member = f"staging/bundles/live-{case_id}.json"
    for name in (case_member, bundle_member):
        _safe_member(name)
        if name in base_members:
            raise GatePreparationError(f"new live member collides with carried archive: {name}")
    case_raw = _read_bytes(Path(args.case), "live frozen case")
    bundle_raw = _read_bytes(Path(args.bundle), "live captured bundle")
    case_sha = source_case_sha
    bundle_sha = source_bundle_sha
    new_row: dict[str, Any] = {
        "case": case_member.removeprefix("staging/"),
        "bundle": bundle_member.removeprefix("staging/"),
        "caseId": case_id,
        "caseSha256": case_sha,
        "bundleSha256": bundle_sha,
        "label": args.label,
        "originatingRunId": bridge.get("runId") or bridge.get("originatingRunId"),
        "referenceTime": case.get("task", {}).get("referenceTime") if isinstance(case.get("task"), Mapping) else None,
        "provenance": "Verified native live bridge; candidate receives only the normal reviewed-case task.",
        "sourceDigests": {
            "caseFileSha256": _sha(case_raw),
            "bundleFileSha256": bundle_sha,
            "bridgeManifestSha256": bridge_sha,
        },
    }
    if not isinstance(new_row["originatingRunId"], str) or not isinstance(new_row["referenceTime"], str):
        raise GatePreparationError("live bridge/case does not carry originating run and referenceTime")
    map_value = _member_map(
        bridge=bridge,
        bridge_path=Path(args.bridge_manifest),
        bridge_sha=bridge_sha,
        case_path=Path(args.case),
        case_file_sha=_sha(case_raw),
        source_case_sha=source_case_sha,
        bundle_path=Path(args.bundle),
        source_bundle_sha=source_bundle_sha,
        case_id=case_id,
        case_sha=case_sha,
        bundle_sha=bundle_sha,
        case=case,
        archive_case=case_member,
        archive_bundle=bundle_member,
    )
    suite_cases = [dict(entry) for entry in base_suite_rows]
    suite_cases.append({"case": new_row["case"], "bundle": new_row["bundle"]})
    suite = {**base_suite, "cases": suite_cases, "schemaVersion": 1}
    suite_raw = _json_bytes(suite)
    manifest = json.loads(json.dumps(base_manifest))
    manifest_rows = [dict(row) for row in base_rows]
    manifest_rows.append(new_row)
    manifest["cases"] = manifest_rows
    if isinstance(manifest.get("suite"), dict):
        manifest["suite"] = {**manifest["suite"], "sha256": _sha(suite_raw), "caseCount": len(suite_cases)}
    manifest["liveCaseMap"] = MAP_MEMBER.removeprefix("staging/")
    manifest_raw = _json_bytes(manifest)
    members = dict(base_members)
    members[case_member] = case_raw
    members[bundle_member] = bundle_raw
    members["staging/suite.json"] = suite_raw
    members["staging/manifest.json"] = manifest_raw
    members[MAP_MEMBER] = _json_bytes(map_value)
    sums = "".join(f"{_sha(members[name])}  {name}\n" for name in sorted(members) if name != "SHA256SUMS").encode("ascii")
    members["SHA256SUMS"] = sums
    archive_raw = _archive_bytes(members)
    archive_sha = _sha(archive_raw)
    out_dir = Path(args.output_dir)
    archive_path = Path(args.archive_out) if args.archive_out else out_dir / ARCHIVE_NAME
    pointer_path = Path(args.pointer_out) if args.pointer_out else out_dir / "qualification-input.json"
    pointer_out = {
        "schemaVersion": 1,
        "purpose": pointer["purpose"],
        "bucket": pointer["bucket"],
        "s3Key": f"{S3_PREFIX}/{archive_sha}/{ARCHIVE_NAME}",
        "sha256": archive_sha,
        "suiteSha256": _sha(suite_raw),
        "evaluatorSha256": pointer["evaluatorSha256"],
        "caseIds": [row["caseId"] for row in manifest_rows],
    }
    if getattr(args, "dry_run", False):
        with tempfile.NamedTemporaryFile(prefix="prepare-live-gate-", suffix=".tar.gz") as temporary:
            temporary.write(archive_raw)
            temporary.flush()
            verified = _validate_pointer_archive(pointer_out, Path(temporary.name), expected_base=pointer)
        archive_path = None
        pointer_path = None
        command = None
    else:
        _write_exclusive(archive_path, archive_raw, "prepared archive")
        _write_exclusive(pointer_path, _json_bytes(pointer_out), "candidate-safe qualification pointer")
        verified = _validate_pointer_archive(pointer_out, archive_path, expected_base=pointer)
        command = publish_command(pointer_out, archive_path, profile=args.profile, region=args.region, expected_bucket_owner=args.expected_bucket_owner)
    return {
        "status": "dry-run" if getattr(args, "dry_run", False) else "prepared",
        "archive": str(archive_path) if archive_path else None,
        "pointer": str(pointer_path) if pointer_path else None,
        "archiveSha256": archive_sha,
        "suiteSha256": pointer_out["suiteSha256"],
        "evaluatorSha256": pointer_out["evaluatorSha256"],
        "caseIds": pointer_out["caseIds"],
        "liveCaseId": case_id,
        "liveCaseSha256": case_sha,
        "liveBundleSha256": bundle_sha,
        "privateMapMember": MAP_MEMBER,
        "verification": verified,
        "externalWrites": 0,
        "publishCommand": command,
    }


def publish_command(pointer: Mapping[str, Any], archive_path: Path, *, profile: str, region: str, expected_bucket_owner: str) -> str:
    bucket = _require_nonempty(pointer.get("bucket"), "pointer.bucket")
    key = _require_nonempty(pointer.get("s3Key"), "pointer.s3Key")
    archive_sha = _require_sha(pointer.get("sha256"), "pointer.sha256")
    checksum = base64.b64encode(bytes.fromhex(archive_sha)).decode("ascii")
    args = [
        "AWS_PROFILE=" + profile,
        "AWS_DEFAULT_REGION=" + region,
        "aws", "s3api", "put-object",
        "--bucket", bucket,
        "--key", key,
        "--body", str(archive_path),
        "--checksum-algorithm", "SHA256",
        "--checksum-sha256", checksum,
        "--expected-bucket-owner", expected_bucket_owner,
        "--if-none-match", "*",
    ]
    return " ".join(shlex.quote(value) for value in args)


def verify(args: argparse.Namespace) -> dict[str, Any]:
    pointer_path = Path(args.pointer)
    pointer = _load_pointer(pointer_path)
    result = _validate_pointer_archive(pointer, Path(args.archive))
    if args.base_archive:
        base_pointer = _load_pointer(Path(args.base_pointer), "base qualification pointer") if args.base_pointer else None
        if base_pointer is None:
            raise GatePreparationError("--base-pointer is required with --base-archive")
        base_members = _read_archive(Path(args.base_archive))
        _, base_rows = _manifest_rows(base_members)
        expected = {"caseIds": [row["caseId"] for row in base_rows]}
        if pointer["caseIds"][: len(expected["caseIds"])] != expected["caseIds"]:
            raise GatePreparationError("prepared roster does not preserve base case rows")
        if len(pointer["caseIds"]) != len(expected["caseIds"]) + 1:
            raise GatePreparationError("prepared S5 roster must append exactly one live case")
    result["pointer"] = str(pointer_path)
    result["archive"] = str(args.archive)
    result["externalWrites"] = 0
    result["publishCommand"] = publish_command(pointer, Path(args.archive), profile=args.profile, region=args.region, expected_bucket_owner=args.expected_bucket_owner)
    return result


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="prepare_live_gate.py", description=__doc__)
    sub = root.add_subparsers(dest="command", required=True)
    prep = sub.add_parser("prepare", help="append the verified live bridge pair to a private carried gate")
    prep.add_argument("--bridge-manifest", required=True, type=Path)
    prep.add_argument("--case", required=True, type=Path, help="verified case.frozen.json")
    prep.add_argument("--bundle", required=True, type=Path, help="verified captured-bundle.json")
    prep.add_argument("--qualification-input", required=True, type=Path, help="committed S5 qualification-input.json")
    prep.add_argument("--base-archive", required=True, type=Path, help="existing private carried staging.tar.gz")
    prep.add_argument("--output-dir", type=Path, default=Path(".work/live-gate"))
    prep.add_argument("--archive-out", type=Path)
    prep.add_argument("--pointer-out", type=Path)
    prep.add_argument("--dry-run", action="store_true", help="validate and build in memory without writing local output")
    prep.add_argument("--label", default="audience-denial")
    prep.add_argument("--profile", default="reinvent-2026-talk")
    prep.add_argument("--region", default="us-east-1")
    prep.add_argument("--expected-bucket-owner", default="027224425948")
    ver = sub.add_parser("verify", help="verify a prepared private archive and candidate-safe pointer")
    ver.add_argument("--archive", required=True, type=Path)
    ver.add_argument("--pointer", required=True, type=Path)
    ver.add_argument("--base-archive", type=Path)
    ver.add_argument("--base-pointer", type=Path)
    ver.add_argument("--profile", default="reinvent-2026-talk")
    ver.add_argument("--region", default="us-east-1")
    ver.add_argument("--expected-bucket-owner", default="027224425948")
    pub = sub.add_parser("publish-command", help="print the bounded idempotent presenter SSO upload command")
    pub.add_argument("--archive", required=True, type=Path)
    pub.add_argument("--pointer", required=True, type=Path)
    pub.add_argument("--profile", default="reinvent-2026-talk")
    pub.add_argument("--region", default="us-east-1")
    pub.add_argument("--expected-bucket-owner", default="027224425948")
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "prepare":
            result = prepare(args)
        elif args.command == "verify":
            result = verify(args)
        else:
            pointer = _load_pointer(args.pointer)
            archive = Path(args.archive)
            _validate_pointer_archive(pointer, archive)
            result = {
                "status": "publish-command-ready",
                "archive": str(archive),
                "pointer": str(args.pointer),
                "externalWrites": 0,
                "publishCommand": publish_command(pointer, archive, profile=args.profile, region=args.region, expected_bucket_owner=args.expected_bucket_owner),
            }
        print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))
        return 0
    except (GatePreparationError, OSError, tarfile.TarError, ValueError) as exc:
        print(f"prepare-live-gate: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
