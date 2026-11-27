#!/usr/bin/env python3
"""Prepare the private input for the fast, exact-action audience gate.

The archive is the private input selected by ``agent/qualification-input.json``.
Its ``staging/live-case-map.json`` names the case that came from the audience
trace.  This command deliberately prepares only that case.  The caller then
invokes ``examples/live-denial/strands_denial.py`` with these files; that
public native Strands program is the one-case gate and the same command used
for the local walkthrough.  This command never supplies an expected answer on
the command line: the frozen case and bundle remain the evaluator input.

Only the action finding is a release gate here.  The full five-case Runtime
ZIP qualification still runs later and remains required before publication.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import tarfile
from typing import Any, Mapping, Sequence

from reviewed_cases import load_frozen_case


ROOT = Path(__file__).resolve().parents[1]
MAP_MEMBER = "staging/live-case-map.json"
MANIFEST_MEMBER = "staging/manifest.json"
SUITE_MEMBER = "staging/suite.json"
# The mapless carried archive is the already qualified four-case baseline. Its
# suite digest is a release input, not a caller-selected audience identity.
CARRIED_BASELINE_SUITE_SHA256 = "4617201adf7d4c8c3df80b52892312cbe516d2064783545762b6297c5a55b178"


class AudienceGateError(ValueError):
    """Raised when the private archive cannot identify one authentic case."""


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _safe_member(name: str) -> None:
    path = PurePosixPath(name)
    if not name or path.is_absolute() or ".." in path.parts:
        raise AudienceGateError(f"archive member is unsafe: {name!r}")


def _archive_members(path: Path) -> dict[str, bytes]:
    try:
        archive = tarfile.open(path, "r:*")
    except (OSError, tarfile.TarError) as exc:
        raise AudienceGateError("private gate archive is not a readable tar archive") from exc
    members: dict[str, bytes] = {}
    with archive:
        for member in archive.getmembers():
            _safe_member(member.name)
            if member.isdir():
                continue
            if not member.isfile() or member.issym() or member.islnk():
                raise AudienceGateError(f"archive contains a non-regular member: {member.name}")
            if member.name in members:
                raise AudienceGateError(f"archive contains duplicate member: {member.name}")
            stream = archive.extractfile(member)
            if stream is None:
                raise AudienceGateError(f"archive member is unreadable: {member.name}")
            members[member.name] = stream.read()
    return members


def _json_member(members: Mapping[str, bytes], name: str, label: str) -> dict[str, Any]:
    raw = members.get(name)
    if raw is None:
        raise AudienceGateError(f"archive is missing {label}: {name}")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AudienceGateError(f"archive {label} is not valid JSON: {name}") from exc
    if not isinstance(value, dict):
        raise AudienceGateError(f"archive {label} must be an object: {name}")
    return value


def _member_name(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise AudienceGateError(f"audience map {label} is missing")
    _safe_member("staging/" + value.removeprefix("staging/"))
    return value.removeprefix("staging/")


def _pointer_case_ids(pointer_path: str | Path | None) -> list[str] | None:
    if pointer_path is None:
        return None
    path = Path(pointer_path)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AudienceGateError("qualification pointer is not valid UTF-8 JSON") from exc
    case_ids = value.get("caseIds") if isinstance(value, Mapping) else None
    if not isinstance(case_ids, list) or not case_ids or any(not isinstance(item, str) or not item.strip() for item in case_ids):
        raise AudienceGateError("qualification pointer caseIds are missing or malformed")
    if len(set(case_ids)) != len(case_ids):
        raise AudienceGateError("qualification pointer caseIds contain duplicates")
    return case_ids


def _pointer_suite_sha(pointer_path: str | Path | None) -> str | None:
    if pointer_path is None:
        return None
    path = Path(pointer_path)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AudienceGateError("qualification pointer is not valid UTF-8 JSON") from exc
    suite_sha = value.get("suiteSha256") if isinstance(value, Mapping) else None
    if not isinstance(suite_sha, str) or len(suite_sha) != 64 or any(char not in "0123456789abcdef" for char in suite_sha):
        raise AudienceGateError("qualification pointer suiteSha256 is missing or malformed")
    return suite_sha


def _suite_case_rows(members: Mapping[str, bytes]) -> list[tuple[str, str, str]]:
    suite = _json_member(members, SUITE_MEMBER, "suite")
    entries = suite.get("cases")
    if suite.get("schemaVersion") != 1 or not isinstance(entries, list) or not entries:
        raise AudienceGateError("archive suite is not a non-empty schemaVersion 1 case list")
    case_rows: list[tuple[str, str, str]] = []
    for entry in entries:
        if not isinstance(entry, Mapping):
            raise AudienceGateError("archive suite contains a malformed case row")
        case_member = _member_name(entry.get("case"), "suite case member")
        bundle_member = _member_name(entry.get("bundle"), "suite bundle member")
        envelope = _json_member(members, "staging/" + case_member, "suite frozen case")
        if "staging/" + bundle_member not in members:
            raise AudienceGateError("archive suite points to a missing bundle")
        case = envelope.get("case")
        case_id = case.get("caseId") if isinstance(case, Mapping) else None
        if not isinstance(case_id, str) or not case_id.strip() or any(row[0] == case_id for row in case_rows):
            raise AudienceGateError("archive suite case IDs are malformed or duplicated")
        case_rows.append((case_id, case_member, bundle_member))
    return case_rows


def _carried_audience_row(
    rows: Sequence[Mapping[str, Any]], pointer_ids: Sequence[str] | None, mapping_raw: bytes | None,
) -> Mapping[str, Any] | None:
    """Select the appended audience row in a carried archive without a map."""

    if mapping_raw is not None or pointer_ids is None or len(pointer_ids) != 4:
        return None
    row = next((item for item in rows if item.get("caseId") == pointer_ids[-1]), None)
    provenance = row.get("provenance") if isinstance(row, Mapping) else None
    if not isinstance(provenance, str) or "audience" not in provenance.casefold():
        return None
    return row


def select_audience_case(archive_path: str | Path, output_root: str | Path, pointer_path: str | Path | None = None) -> dict[str, Any]:
    """Copy and authenticate the mapped audience case/bundle for one run."""

    archive_members = _archive_members(Path(archive_path))
    manifest = _json_member(archive_members, MANIFEST_MEMBER, "manifest")
    rows = manifest.get("cases")
    if not isinstance(rows, list):
        raise AudienceGateError("archive manifest has no case rows")
    pointer_ids = _pointer_case_ids(pointer_path)
    pointer_suite_sha = _pointer_suite_sha(pointer_path)
    manifest_ids = [item.get("caseId") for item in rows if isinstance(item, Mapping)]
    if any(not isinstance(item, str) or not item.strip() for item in manifest_ids):
        raise AudienceGateError("archive manifest case IDs are malformed")
    if pointer_ids is not None and pointer_ids != manifest_ids:
        raise AudienceGateError("qualification pointer caseIds do not match the archive manifest")
    mapping_raw = archive_members.get(MAP_MEMBER)
    if pointer_ids is not None and mapping_raw is None and pointer_suite_sha != CARRIED_BASELINE_SUITE_SHA256:
        raise AudienceGateError("mapless carried archive is not the approved qualified suite")
    if pointer_ids is not None:
        expected_count = 5 if mapping_raw is not None else 4
        if len(pointer_ids) != expected_count:
            raise AudienceGateError(
                "audience qualification pointer must name four baseline cases plus one audience case"
                if mapping_raw is not None
                else "unaugmented qualification pointer must name exactly four baseline cases"
            )
    if pointer_ids is not None:
        suite_raw = archive_members.get(SUITE_MEMBER)
        if suite_raw is None or pointer_suite_sha is None:
            raise AudienceGateError("archive is missing the pointer-bound suite")
        if _sha(suite_raw) != pointer_suite_sha:
            raise AudienceGateError("qualification pointer suiteSha256 does not match archive bytes")
        manifest_rows = [
            (
                item["caseId"],
                _member_name(item.get("case"), "manifest case member"),
                _member_name(item.get("bundle"), "manifest bundle member"),
            )
            for item in rows
            if isinstance(item, Mapping)
        ]
        if _suite_case_rows(archive_members) != manifest_rows:
            raise AudienceGateError("archive suite case roster does not match the manifest")
    if mapping_raw is None:
        carried = _carried_audience_row(rows, pointer_ids, mapping_raw)
        if carried is not None:
            # The current carried four-case archive appends the audience review
            # row directly and has no live-case map. The pointer and suite
            # roster already authenticate its identity; provenance is required
            # so an ordinary baseline row cannot be mistaken for this case.
            row = carried
            ci = row
            case_id = row.get("caseId")
            case_member = _member_name(row.get("case"), "carried audience case member")
            bundle_member = _member_name(row.get("bundle"), "carried audience bundle member")
            case_raw = archive_members.get("staging/" + case_member)
            bundle_raw = archive_members.get("staging/" + bundle_member)
            if case_raw is None or bundle_raw is None:
                raise AudienceGateError("carried audience row points to missing case or bundle bytes")
            map_kind = "audience-carried"
        else:
            # A carried baseline predates the audience case. Prove that it has
            # no session-derived live row before selecting its denial witness.
            # If a live row exists, a missing map must fail closed.
            live_rows = [
                item for item in rows
                if isinstance(item, Mapping) and isinstance(item.get("provenance"), str) and item.get("provenance").strip()
            ]
            if live_rows:
                raise AudienceGateError("archive contains a live case but no live-case member map")
            candidates: list[tuple[Mapping[str, Any], str, str, bytes, bytes]] = []
            for item in rows:
                if not isinstance(item, Mapping):
                    continue
                try:
                    case_member = _member_name(item.get("case"), "baseline case member")
                    bundle_member = _member_name(item.get("bundle"), "baseline bundle member")
                    case_raw = archive_members.get("staging/" + case_member)
                    bundle_raw = archive_members.get("staging/" + bundle_member)
                    if case_raw is None or bundle_raw is None:
                        continue
                    case_envelope = _json_member(archive_members, "staging/" + case_member, "baseline frozen case")
                    case_body = case_envelope.get("case")
                    recs = case_body.get("expectations", {}).get("admissibleRecommendations", []) if isinstance(case_body, Mapping) else []
                    if isinstance(recs, list) and recs and isinstance(recs[0], Mapping) and recs[0].get("action") == "Restore inventory access":
                        candidates.append((item, case_member, bundle_member, case_raw, bundle_raw))
                except AudienceGateError:
                    continue
            if not candidates:
                raise AudienceGateError("baseline archive has no retained denial row for the quick gate")
            row, case_member, bundle_member, case_raw, bundle_raw = candidates[0]
            ci = row
            case_id = row.get("caseId")
            map_kind = "baseline-denial"
    else:
        mapping = _json_member(archive_members, MAP_MEMBER, "live-case member map")
        if mapping.get("schemaVersion") != 1 or mapping.get("kind") != "live-case-kit-member-map":
            raise AudienceGateError("live-case member map is not schemaVersion 1")
        ci = mapping.get("ci")
        if not isinstance(ci, Mapping):
            raise AudienceGateError("live-case member map has no CI row")
        map_members = mapping.get("members")
        if not isinstance(map_members, Mapping):
            raise AudienceGateError("live-case member map has no archive members")
        case_id = ci.get("caseId")
        if not isinstance(case_id, str) or not case_id.strip():
            raise AudienceGateError("live-case CI row has no case ID")
        if pointer_ids is not None and case_id != pointer_ids[-1]:
            raise AudienceGateError("live-case CI row is not the appended audience case in the qualification pointer")
        case_member = _member_name(map_members.get("case"), "case member")
        bundle_member = _member_name(map_members.get("bundle"), "bundle member")
        case_raw = archive_members.get("staging/" + case_member)
        bundle_raw = archive_members.get("staging/" + bundle_member)
        if case_raw is None or bundle_raw is None:
            raise AudienceGateError("live-case CI row points to missing case or bundle bytes")
        map_kind = "audience-live"
    row = next((item for item in rows if isinstance(item, Mapping) and item.get("caseId") == case_id), None)
    if row is None:
        raise AudienceGateError("live-case CI row is absent from the archive manifest")
    if row.get("case") != case_member or row.get("bundle") != bundle_member:
        raise AudienceGateError("live-case CI row does not match the archive manifest")
    frozen_envelope = _json_member(archive_members, "staging/" + case_member, "frozen case")
    claimed_case_sha = frozen_envelope.get("caseSha256")
    claimed_bundle_sha = _sha(bundle_raw)
    if not isinstance(claimed_case_sha, str) or claimed_case_sha != ci.get("caseSha256") or claimed_case_sha != row.get("caseSha256"):
        raise AudienceGateError("live-case caseSha256 does not match the frozen case envelope")
    if ci.get("bundleSha256") != claimed_bundle_sha or row.get("bundleSha256") != claimed_bundle_sha:
        raise AudienceGateError("live-case bundleSha256 does not match archive bytes")
    root = Path(output_root).resolve()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    case_path = root / "case.frozen.json"
    bundle_path = root / "captured-bundle.json"
    case_path.write_bytes(case_raw)
    bundle_path.write_bytes(bundle_raw)
    loaded = load_frozen_case(case_path, bundle_path)
    if loaded["case"]["caseId"] != case_id:
        raise AudienceGateError("live-case frozen case ID differs from CI row")
    if loaded["caseSha256"] != claimed_case_sha or loaded["bundleSha256"] != claimed_bundle_sha:
        raise AudienceGateError("live-case frozen identity differs from CI row")
    return {
        "caseId": case_id,
        "caseSha256": loaded["caseSha256"],
        "bundleSha256": loaded["bundleSha256"],
        "gateKind": map_kind,
        "casePath": case_path,
        "bundlePath": bundle_path,
        "task": loaded["task"],
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--pointer", type=Path, help="committed qualification-input.json for roster binding")
    parser.add_argument("--output-root", required=True, type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = _parser().parse_args(argv)
        selected = select_audience_case(args.archive, args.output_root / "inputs", args.pointer)
        args.output_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        prepared = {
            "status": "prepared",
            "gateKind": selected["gateKind"],
            "caseId": selected["caseId"],
            "caseSha256": selected["caseSha256"],
            "bundleSha256": selected["bundleSha256"],
            "case": str(selected["casePath"]),
            "bundle": str(selected["bundlePath"]),
        }
        (args.output_root / "audience-input.json").write_text(
            json.dumps(prepared, ensure_ascii=False, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        print(json.dumps(prepared, ensure_ascii=False, sort_keys=True), flush=True)
        return 0
    except (AudienceGateError, OSError, ValueError, TypeError) as exc:
        print(json.dumps({"status": "error", "reason": f"{type(exc).__name__}: {exc}"}, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
