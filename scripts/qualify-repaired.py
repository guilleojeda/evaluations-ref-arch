#!/usr/bin/env python3
"""Run and freeze the exact repaired package release qualification.

This command is the evaluation-side handoff.  It consumes the checked ZIP,
the frozen suite and the pinned evaluator, runs the package experiment, and
stores a private browser-readable review bundle.  It never publishes a
Runtime or assumes a publishing role.  A machine ``reject`` or ``incomplete``
result is retained for diagnosis and cannot open the protected review.

The optional S3 upload uses the evaluation role's bounded private evidence
permissions.  The emitted stdout is a safe summary; reports, source records,
judge explanations and raw execution output remain in the private directory
or private S3 prefix.
"""

from __future__ import annotations

import argparse
from collections.abc import Callable, Iterable, Mapping, Sequence
from datetime import datetime, timezone
import hashlib
import html
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
from typing import Any
import zipfile


ROOT = Path(__file__).resolve().parents[1]
AGENT = ROOT / "agent"
if str(AGENT) not in sys.path:
    sys.path.insert(0, str(AGENT))

from release_gate import (  # noqa: E402
    FINDINGS,
    canonical_bytes,
    has_matching_approval,
    machine_decision,
    sha256_bytes,
    sha256_json,
)


SCHEMA_VERSION = 1
CANDIDATE_ID = "repaired"
ENDPOINT_NAME = "repaired"
ENVIRONMENT_NAME = "repaired-publication"
DEFAULT_REGION = "us-east-1"
# Keep the prefix inside the evaluation role's explicitly scoped write
# boundary.  The manifest digest is appended per qualification below.
DEFAULT_PREFIX = "agent-evaluation/phase20/qualifications"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
REVISION_RE = re.compile(r"^[0-9a-f]{40}$")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _read_file(path: Path, label: str) -> bytes:
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"{label} is unavailable or is a symlink: {path}")
    try:
        return path.read_bytes()
    except OSError as exc:
        raise ValueError(f"{label} is unavailable: {path}") from exc


def _read_json(path: Path, label: str) -> Any:
    raw = _read_file(path, label)
    try:
        return json.loads(raw.decode("utf-8"), parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise ValueError(f"{label} is not valid UTF-8 JSON") from exc


def _private_root(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        raise ValueError("qualification output root must be a private directory")
    path.chmod(0o700)
    return path


def _write_private(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    if temporary.exists() or temporary.is_symlink():
        temporary.unlink()
    try:
        with temporary.open("xb") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(stat.S_IRUSR | stat.S_IWUSR)
        os.replace(temporary, path)
        path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    finally:
        temporary.unlink(missing_ok=True)


def _copy_private(source: Path, destination: Path, label: str) -> tuple[bytes, str]:
    raw = _read_file(source, label)
    digest = sha256_bytes(raw)
    _write_private(destination, raw)
    # Reopen the private copy before it becomes part of the review bundle.
    # This catches partial writes and ensures the reviewer receives the exact
    # bytes that were authenticated at the evaluation boundary.
    copied = _read_file(destination, f"private {label} copy")
    if sha256_bytes(copied) != digest:
        raise RuntimeError(f"private {label} copy digest differs")
    return copied, digest


def _write_json_private(path: Path, value: Any) -> str:
    raw = canonical_bytes(value) + b"\n"
    _write_private(path, raw)
    copied = _read_file(path, f"private JSON {path.name}")
    digest = sha256_bytes(copied)
    if copied != raw:
        raise RuntimeError(f"private JSON readback differs: {path}")
    return digest


def _tree_files(root: Path, *, exclude: Iterable[str] = ()) -> dict[str, str]:
    excluded = set(exclude)
    result: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        relative = path.relative_to(root).as_posix()
        if relative in excluded:
            continue
        result[relative] = sha256_bytes(path.read_bytes())
    return result


def _safe_case_name(value: str) -> str:
    if not isinstance(value, str) or not value.strip() or not re.fullmatch(r"[A-Za-z0-9._-]{1,160}", value):
        raise ValueError("case ID is not safe for a private review path")
    return value


def _load_roster(suite_path: Path) -> tuple[list[tuple[str, str, str]], dict[str, Any], str]:
    """Verify each frozen case/bundle and return the expected machine roster."""

    suite_raw = _read_file(suite_path, "reviewed suite")
    suite_digest = sha256_bytes(suite_raw)
    try:
        suite = json.loads(suite_raw.decode("utf-8"), parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise ValueError("reviewed suite is not valid UTF-8 JSON") from exc
    if not isinstance(suite, Mapping) or suite.get("schemaVersion") != 1 or not isinstance(suite.get("cases"), list) or not suite["cases"]:
        raise ValueError("reviewed suite must contain a non-empty schemaVersion 1 cases list")
    from reviewed_cases import load_frozen_case

    roster: list[tuple[str, str, str]] = []
    seen: set[str] = set()
    entries: list[dict[str, Any]] = []
    for entry in suite["cases"]:
        if not isinstance(entry, Mapping) or not isinstance(entry.get("case"), str) or not isinstance(entry.get("bundle"), str):
            raise ValueError("reviewed suite entries must identify case and bundle files")
        case_path = (suite_path.parent / entry["case"]).resolve()
        bundle_path = (suite_path.parent / entry["bundle"]).resolve()
        try:
            case_path.relative_to(suite_path.parent.resolve())
            bundle_path.relative_to(suite_path.parent.resolve())
        except ValueError as exc:
            raise ValueError("reviewed suite paths must remain below the suite directory") from exc
        loaded = load_frozen_case(case_path, bundle_path)
        case_id = loaded["case"]["caseId"]
        _safe_case_name(case_id)
        if case_id in seen:
            raise ValueError(f"reviewed suite contains duplicate case: {case_id}")
        seen.add(case_id)
        case_sha = loaded["caseSha256"]
        bundle_sha = loaded["bundleSha256"]
        roster.append((case_id, case_sha, bundle_sha))
        entries.append(
            {
                "caseId": case_id,
                "caseSha256": case_sha,
                "bundleSha256": bundle_sha,
                "casePath": str(case_path),
                "bundlePath": str(bundle_path),
                "referenceTime": loaded.get("referenceTime"),
            }
        )
    return roster, {"schemaVersion": suite.get("schemaVersion"), "cases": entries}, suite_digest


def _load_manifest_from_zip(runtime_zip: Path) -> tuple[dict[str, Any], str, str]:
    """Read the schema-v2 manifest and the packaged prompt.py identity.

    ``promptSha256`` in the manifest is the effective ``SYSTEM_PROMPT``
    digest.  It is intentionally different from the digest of the packaged
    ``prompt.py`` source file, which is the object the publisher later reads
    from S3.  Keep both identities at the qualification boundary.
    """

    raw = _read_file(runtime_zip, "Runtime ZIP")
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            names = archive.namelist()
            if len(names) != len(set(names)):
                raise ValueError("Runtime ZIP contains duplicate paths")
            manifest = json.loads(archive.read("agent-manifest.json").decode("utf-8"))
            prompt_file = archive.read("prompt.py")
    except (zipfile.BadZipFile, KeyError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("Runtime ZIP is not a valid package with agent-manifest.json") from exc
    if not isinstance(manifest, dict):
        raise ValueError("Runtime ZIP manifest is not an object")
    if manifest.get("schemaVersion") != 2:
        raise ValueError("Runtime ZIP manifest schema is unsupported")
    prompt_sha = manifest.get("promptSha256")
    revision = manifest.get("sourceRevision")
    if not isinstance(prompt_sha, str) or not SHA256_RE.fullmatch(prompt_sha):
        raise ValueError("Runtime ZIP manifest promptSha256 is invalid")
    if not isinstance(revision, str) or not REVISION_RE.fullmatch(revision):
        raise ValueError("Runtime ZIP manifest sourceRevision is invalid")
    prompt_file_sha256 = sha256_bytes(prompt_file)
    runtime_sources = manifest.get("runtimeSourceFiles")
    if not isinstance(runtime_sources, Mapping) or runtime_sources.get("prompt.py") != prompt_file_sha256:
        raise ValueError("Runtime ZIP manifest prompt.py source digest differs")
    return manifest, sha256_bytes(raw), prompt_file_sha256


def _row_identity(row: Mapping[str, Any]) -> dict[str, Any]:
    identity: dict[str, Any] = {}
    for key in ("caseId", "caseSha256", "bundleSha256", "executionId", "sessionId", "traceId", "promptSha256"):
        value = row.get(key)
        if value is not None:
            identity[key] = value
    execution = row.get("execution")
    if isinstance(execution, Mapping) and isinstance(execution.get("identity"), Mapping):
        for key in ("executionId", "sessionId", "traceId", "reportSha256", "referenceTime"):
            if execution["identity"].get(key) is not None:
                identity[key] = execution["identity"][key]
    deterministic = row.get("deterministic")
    if isinstance(deterministic, Mapping) and isinstance(deterministic.get("identity"), Mapping):
        identity["deterministicIdentity"] = dict(deterministic["identity"])
    report = row.get("report")
    if isinstance(report, Mapping):
        identity["reportSha256"] = sha256_json(report)
    score = row.get("score")
    if isinstance(score, Mapping):
        for key in ("scoringAttemptId", "status"):
            if score.get(key) is not None:
                identity[key] = score[key]
        semantic = score.get("semantic")
        if isinstance(semantic, Mapping):
            evaluator = semantic.get("evaluator")
            if isinstance(evaluator, Mapping):
                identity["evaluator"] = dict(evaluator)
            findings = semantic.get("findings")
            if isinstance(findings, Mapping):
                quality = findings.get("semantic_quality")
                if isinstance(quality, Mapping):
                    identity["advisory"] = {
                        key: quality.get(key)
                        for key in ("status", "verdict", "explanation")
                        if quality.get(key) is not None
                    }
    return identity


def _safe_case_review(case_id: str, row: Mapping[str, Any], roster_entry: Mapping[str, Any]) -> dict[str, Any]:
    report = row.get("report") if isinstance(row.get("report"), Mapping) else None
    score = row.get("score") if isinstance(row.get("score"), Mapping) else None
    deterministic = row.get("deterministic") if isinstance(row.get("deterministic"), Mapping) else None
    evidence = report.get("evidence") if isinstance(report, Mapping) else None
    sources: list[dict[str, Any]] = []
    if isinstance(evidence, list):
        for item in evidence:
            if isinstance(item, Mapping):
                # Reports are already source-backed and are retained privately;
                # this projection keeps the browser index small and explicit.
                sources.append({
                    key: item.get(key)
                    for key in ("source", "resource", "observedAt", "windowStart", "windowEnd", "finding")
                    if item.get(key) is not None
                })
    semantic: dict[str, Any] = {}
    if isinstance(score, Mapping):
        semantic_value = score.get("semantic")
        if isinstance(semantic_value, Mapping):
            findings = semantic_value.get("findings")
            quality = findings.get("semantic_quality") if isinstance(findings, Mapping) else None
            if isinstance(quality, Mapping):
                semantic = {
                    "status": quality.get("status"),
                    "verdict": quality.get("verdict"),
                    "reason": quality.get("explanation"),
                }
    source_bundle: dict[str, Any] = {
        "sha256": roster_entry.get("bundleSha256"),
        "path": f"../../inputs/bundles/{roster_entry.get('bundleSha256')}.json",
    }
    try:
        bundle = _read_json(Path(str(roster_entry["bundlePath"])), "source bundle")
    except (KeyError, ValueError):
        bundle = None
    if isinstance(bundle, Mapping):
        coverage: dict[str, Any] = {}
        sources = bundle.get("sources")
        if isinstance(sources, Mapping):
            for tool, value in sources.items():
                if not isinstance(value, Mapping):
                    continue
                coverage[str(tool)] = {
                    key: value.get(key)
                    for key in (
                        "resource", "referenceTime", "windowStart", "windowEnd", "completeness",
                        "gaps", "errors", "coverageGaps", "returnedRows", "observations",
                    )
                    if value.get(key) is not None
                }
        source_bundle["coverage"] = coverage
    return {
        "schemaVersion": SCHEMA_VERSION,
        "caseId": case_id,
        "caseSha256": roster_entry.get("caseSha256"),
        "bundleSha256": roster_entry.get("bundleSha256"),
        "referenceTime": roster_entry.get("referenceTime"),
        "status": row.get("status"),
        "identity": _row_identity(row),
        "report": report,
        "sources": sources,
        "sourceBundle": source_bundle,
        "deterministic": deterministic,
        "advisory": semantic,
        "score": score,
    }


def _experiment_attestation(
    experiment_dir: Path,
    canonical_record: Mapping[str, Any],
    shown: Mapping[str, Any],
    *,
    artifact_sha256: str,
    effective_prompt_sha256: str,
) -> dict[str, Any]:
    """Authenticate ``show_experiment`` against the durable native record.

    ``show_experiment`` is deliberately the read path used by the protected
    review.  It must not be possible to hand the gate an arbitrary rendered
    rows object while retaining a different native experiment on disk.
    """

    if shown.get("experimentId") != canonical_record.get("experimentId"):
        raise ValueError("native show_experiment identity differs from experiment.json")
    canonical_cases = canonical_record.get("cases")
    shown_cases = shown.get("cases")
    if not isinstance(canonical_cases, list) or not isinstance(shown_cases, list):
        raise ValueError("native experiment case roster is missing")
    canonical_by_id = {
        row.get("caseId"): row for row in canonical_cases if isinstance(row, Mapping) and isinstance(row.get("caseId"), str)
    }
    shown_by_id = {
        row.get("caseId"): row for row in shown_cases if isinstance(row, Mapping) and isinstance(row.get("caseId"), str)
    }
    if set(canonical_by_id) != set(shown_by_id) or not canonical_by_id:
        raise ValueError("native show_experiment roster differs from experiment.json")
    for case_id, canonical in canonical_by_id.items():
        shown_row = shown_by_id[case_id]
        if canonical.get("promptSha256") != effective_prompt_sha256 or shown_row.get("promptSha256") != effective_prompt_sha256:
            raise ValueError(f"native prompt identity differs from the schema-v2 package manifest for {case_id}")
        for key in (
            "caseSha256", "bundleSha256", "executionId", "sessionId", "traceId",
            "scoringAttemptId", "promptSha256",
        ):
            if canonical.get(key) != shown_row.get(key):
                raise ValueError(f"native show_experiment {key} differs for {case_id}")
        # A shown row is permitted to contain authenticated report/score
        # renderings that are not copied into the running record.  If the
        # durable record has one, however, the values must agree exactly.
        for key in ("status", "deterministic", "report", "score", "usage"):
            canonical_value = canonical.get(key)
            shown_value = shown_row.get(key)
            if key == "deterministic" and isinstance(canonical_value, Mapping) and isinstance(shown_value, Mapping):
                # The durable case row stores the findings projection; the
                # authenticated execution reader adds its report identity and
                # linkage fields when reopening the native run.
                canonical_value = canonical_value.get("findings")
                shown_value = shown_value.get("findings")
            if key in canonical and key in shown_row and canonical_value != shown_value:
                raise ValueError(f"native show_experiment {key} differs for {case_id}")
    runtime_origin = canonical_record.get("runtimeOrigin")
    if not isinstance(runtime_origin, Mapping) or runtime_origin.get("kind") != "runtime_zip":
        raise ValueError("package experiment has no authenticated Runtime ZIP origin")
    if runtime_origin.get("zipSha256") != artifact_sha256:
        raise ValueError("package experiment Runtime ZIP identity differs")
    source_origin = canonical_record.get("sourceOrigin")
    if not isinstance(source_origin, Mapping) or source_origin.get("kind") != "runtime_zip" or source_origin.get("zipSha256") != artifact_sha256:
        raise ValueError("package experiment source is not authenticated to the Runtime ZIP")
    for key in ("manifestSha256", "runtimeSourceSha256", "dependencySha256"):
        if not isinstance(runtime_origin.get(key), str) or not SHA256_RE.fullmatch(runtime_origin[key]):
            raise ValueError(f"package experiment origin is missing {key}")
    driver = runtime_origin.get("driver")
    if not isinstance(driver, Mapping) or not isinstance(driver.get("toolingSha256"), str) or not SHA256_RE.fullmatch(driver["toolingSha256"]):
        raise ValueError("package experiment driver/tooling identity is missing")
    snapshot = canonical_record.get("snapshot")
    tooling = canonical_record.get("tooling")
    runtime = canonical_record.get("runtime")
    if not isinstance(snapshot, Mapping) or not isinstance(tooling, Mapping) or not isinstance(runtime, Mapping):
        raise ValueError("package experiment lock or policy snapshot is missing")
    for key in ("sourceSha256", "dependencySha256", "toolingSha256", "toolingDependencySha256"):
        value = snapshot.get(key)
        if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
            raise ValueError(f"package experiment snapshot identity is missing {key}")
    if runtime.get("dependencySha256") != snapshot.get("dependencySha256"):
        raise ValueError("package runtime lock identity differs from its snapshot")
    if tooling.get("dependencySha256") != snapshot.get("toolingDependencySha256"):
        raise ValueError("package driver lock identity differs from its snapshot")
    return {
        "experimentPath": str(experiment_dir),
        "canonicalRecordSha256": sha256_bytes(_read_file(experiment_dir / "experiment.json", "experiment record")),
        "runtimeOrigin": dict(runtime_origin),
        "runtime": dict(runtime),
        "tooling": dict(tooling),
        "snapshot": dict(snapshot),
        "showDecision": shown.get("decision"),
        "showReadErrors": shown.get("readErrors", []),
    }


def _console_url(bucket: str, prefix: str, region: str) -> str:
    from urllib.parse import quote

    encoded = quote(prefix.strip("/") + "/", safe="/")
    return f"https://s3.console.aws.amazon.com/s3/buckets/{quote(bucket, safe='')}?region={quote(region, safe='')}&prefix={encoded}"


def _console_object_url(bucket: str, key: str, region: str) -> str:
    from urllib.parse import quote

    return (
        f"https://s3.console.aws.amazon.com/s3/object/{quote(bucket, safe='')}"
        f"?region={quote(region, safe='')}&prefix={quote(key.strip('/'), safe='/')}"
    )


def _safe_prefix_component(value: Any, label: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,120}", value):
        raise ValueError(f"{label} is missing or unsafe for a private S3 prefix")
    return value


def _review_s3_prefix(
    base_prefix: str | None,
    *,
    manifest_sha256: str,
    github: Mapping[str, Any],
) -> str:
    """Return a retry-isolated private prefix.

    A GitHub retry must never reuse the previous attempt's browser pages or
    receipt.  The owner/run/attempt components are therefore part of the key,
    with the manifest digest retaining content identity within that attempt.
    Local runs use an explicit ``local`` component and remain deterministic.
    """

    root = (base_prefix or DEFAULT_PREFIX).strip("/")
    if not root:
        raise ValueError("private S3 prefix must not be empty")
    run_id = github.get("runId")
    run_attempt = github.get("runAttempt")
    if (run_id is None) != (run_attempt is None):
        raise ValueError("GitHub run ID and run attempt must be supplied together")
    if run_id is not None and run_attempt is not None:
        owner = github.get("repositoryOwner")
        if owner is None:
            repository = github.get("repository")
            owner = repository.split("/", 1)[0] if isinstance(repository, str) and "/" in repository else None
        owner = _safe_prefix_component(owner, "GitHub repository owner")
        run_id = _safe_prefix_component(str(run_id), "GitHub run ID")
        run_attempt = _safe_prefix_component(str(run_attempt), "GitHub run attempt")
        return f"{root}/{owner}/{run_id}/{run_attempt}/{manifest_sha256}"
    return f"{root}/local/{manifest_sha256}"


def _private_browser_bundle(
    output_root: Path,
    *,
    suite_path: Path,
    suite_descriptor: Mapping[str, Any],
    suite_sha256: str,
    evaluator_path: Path,
    evaluator_sha256: str,
    runtime_zip: Path,
    artifact_sha256: str,
    package_manifest: Mapping[str, Any],
    prompt_file_sha256: str,
    runtime_configuration_sha256: str,
    experiment_dir: Path,
    experiment_record: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
) -> tuple[Path, dict[str, Any], str]:
    root = _private_root(output_root / "review")
    roster_by_id = {entry["caseId"]: entry for entry in suite_descriptor["cases"]}
    # Keep exact frozen inputs next to the browser projection.  Reviewers can
    # download these private copies and replay tamper checks without relying
    # on a mutable checkout or a second source lookup.
    for entry in suite_descriptor["cases"]:
        case_id = _safe_case_name(entry["caseId"])
        case_path = Path(entry["casePath"])
        bundle_path = Path(entry["bundlePath"])
        _copy_private(case_path, root / "inputs" / "cases" / f"{case_id}.frozen.json", "frozen case")
        _copy_private(bundle_path, root / "inputs" / "bundles" / f"{entry['bundleSha256']}.json", "source bundle")
    cases_index: list[dict[str, Any]] = []
    for row in rows:
        case_id = row.get("caseId")
        if not isinstance(case_id, str) or case_id not in roster_by_id:
            continue
        review = _safe_case_review(case_id, row, roster_by_id[case_id])
        relative = Path("cases") / _safe_case_name(case_id)
        _write_private(root / relative / "index.json", json.dumps(review, ensure_ascii=False, sort_keys=True, indent=2).encode() + b"\n")
        cases_index.append({
            "caseId": case_id,
            "path": (relative / "index.json").as_posix(),
            "caseSha256": review["caseSha256"],
            "bundleSha256": review["bundleSha256"],
            "executionId": review["identity"].get("executionId"),
            "sessionId": review["identity"].get("sessionId"),
            "traceId": review["identity"].get("traceId"),
            "reportSha256": review["identity"].get("reportSha256"),
        })
    manifest_identity = {
        "schemaVersion": SCHEMA_VERSION,
        "candidateId": CANDIDATE_ID,
        "artifactSha256": artifact_sha256,
        "promptFileSha256": prompt_file_sha256,
        "packageManifest": dict(package_manifest),
        "suiteSha256": suite_sha256,
        "caseIdentities": [
            {key: value for key, value in entry.items() if key in {"caseId", "caseSha256", "bundleSha256", "referenceTime"}}
            for entry in suite_descriptor["cases"]
        ],
        "evaluatorSha256": evaluator_sha256,
        "runtimeConfigurationSha256": runtime_configuration_sha256,
        "experimentId": experiment_record.get("experimentId"),
        "reportIdentities": cases_index,
    }
    manifest_sha256 = sha256_json(manifest_identity)
    index = {
        **manifest_identity,
        "manifestSha256": manifest_sha256,
        "experimentPath": str(experiment_dir),
        "evaluatorPath": str(evaluator_path),
        "suitePath": str(suite_path),
        "cases": cases_index,
        "createdAt": _now(),
    }
    _write_private(root / "index.json", json.dumps(index, ensure_ascii=False, sort_keys=True, indent=2).encode() + b"\n")
    return root, index, manifest_sha256


def _render_browser_index(
    root: Path,
    index: Mapping[str, Any],
    *,
    bucket: str | None,
    prefix: str | None,
    region: str,
) -> None:
    """Render the final browser view after the manifest is immutable.

    ``index.html`` is intentionally excluded from ``contentFiles``.  It is a
    derived view, so it can contain the final manifest digest and stable S3
    console object links without introducing a circular tree hash.  When an
    S3 destination is known, every link is absolute; a downloaded HTML file
    does not depend on a relative working directory or a checkout path.
    """

    if bucket and prefix:
        index_href = _console_object_url(bucket, f"{prefix.strip('/')}/index.json", region)
        case_href = lambda path: _console_object_url(bucket, f"{prefix.strip('/')}/{path}", region)
    else:
        index_href = "index.json"
        case_href = lambda path: path
    browser_lines = [
        "<!doctype html><meta charset=utf-8><title>Repaired agent private review</title>",
        "<h1>Repaired agent private review</h1>",
        f'<p>Manifest <code>{html.escape(str(index.get("manifestSha256", "")))}</code> '
        f'<a href="{html.escape(index_href, quote=True)}">authenticated index</a></p>',
        "<ul>",
    ]
    cases = index.get("cases")
    if isinstance(cases, list):
        for entry in cases:
            if not isinstance(entry, Mapping) or not isinstance(entry.get("path"), str):
                continue
            href = case_href(entry["path"])
            browser_lines.append(
                f'<li><a href="{html.escape(href, quote=True)}">{html.escape(str(entry.get("caseId", "case")))}</a></li>'
            )
    browser_lines.append("</ul>")
    _write_private(root / "index.html", "\n".join(browser_lines).encode("utf-8") + b"\n")


def _upload_private_bundle(root: Path, *, bucket: str, prefix: str, region: str) -> dict[str, Any]:
    try:
        import boto3
    except ImportError as exc:
        raise RuntimeError("boto3 is required for private evidence upload") from exc

    client = boto3.Session(region_name=region).client("s3")
    uploaded = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        key = f"{prefix.strip('/')}/{path.relative_to(root).as_posix()}"
        mime = {".html": "text/html", ".json": "application/json"}.get(path.suffix, "application/octet-stream")
        _put_verified_object(client, bucket, key, path.read_bytes(), mime)
        uploaded.append(key)
    case_urls: dict[str, str] = {}
    index_data = _read_json(root / "index.json", "private review index") if (root / "index.json").is_file() else None
    if isinstance(index_data, Mapping) and isinstance(index_data.get("cases"), list):
        for entry in index_data["cases"]:
            if isinstance(entry, Mapping) and isinstance(entry.get("caseId"), str) and isinstance(entry.get("path"), str):
                case_urls[entry["caseId"]] = _console_object_url(
                    bucket, f"{prefix.strip('/')}/{entry['path']}", region,
                )
    return {
        "bucket": bucket,
        "prefix": prefix.strip("/"),
        "indexKey": f"{prefix.strip('/')}/index.html",
        "manifestKey": f"{prefix.strip('/')}/index.json",
        "consoleUrl": _console_url(bucket, prefix, region),
        "indexConsoleUrl": _console_object_url(bucket, f"{prefix.strip('/')}/index.html", region),
        "manifestConsoleUrl": _console_object_url(bucket, f"{prefix.strip('/')}/index.json", region),
        "caseConsoleUrls": case_urls,
        "objectCount": str(len(uploaded)),
    }


def _upload_private_object(*, bucket: str, key: str, body: bytes, region: str, content_type: str = "application/json") -> None:
    """Conditionally create one private unversioned S3 object and rehash it."""

    import boto3

    client = boto3.Session(region_name=region).client("s3")
    _put_verified_object(client, bucket, key, body, content_type)


def _put_verified_object(client, bucket: str, key: str, body: bytes, content_type: str) -> None:
    """Create immutable evidence, or verify the bytes a previous attempt retained."""
    from botocore.exceptions import ClientError

    digest = sha256_bytes(body)
    try:
        client.put_object(
            Bucket=bucket, Key=key, Body=body, ContentType=content_type,
            Metadata={"sha256": digest}, ServerSideEncryption="AES256", IfNoneMatch="*",
        )
    except ClientError as error:
        if str(error.response.get("Error", {}).get("Code")) not in {"412", "PreconditionFailed"}:
            raise
    existing = client.get_object(Bucket=bucket, Key=key)
    if sha256_bytes(existing["Body"].read()) != digest:
        raise RuntimeError(f"private S3 object content readback differs: {key}")


def _finalize_private_review(
    root: Path,
    initial_index: Mapping[str, Any],
    *,
    canonical_record: Mapping[str, Any],
    shown: Mapping[str, Any],
    attestation: Mapping[str, Any],
    runtime_configuration: Mapping[str, Any],
    github: Mapping[str, Any],
) -> tuple[dict[str, Any], str]:
    """Persist all review inputs, then bind one immutable content manifest."""

    native_dir = root / "native"
    record_source = Path(str(attestation.get("experimentPath", ""))) / "experiment.json"
    if record_source.is_file() and not record_source.is_symlink():
        _copy_private(record_source, native_dir / "experiment-record.json", "native experiment record")
    else:
        _write_json_private(native_dir / "experiment-record.json", canonical_record)
    _write_json_private(native_dir / "show-experiment.json", shown)
    _write_json_private(native_dir / "attestation.json", attestation)
    _write_json_private(root / "inputs" / "runtime-configuration.json", runtime_configuration)

    policy_source = AGENT / "release_gate.py"
    _, policy_sha256 = _copy_private(policy_source, root / "inputs" / "release_gate.py", "release policy")
    policy = {"module": "release_gate.py", "sha256": policy_sha256, "findings": list(FINDINGS)}
    _write_json_private(native_dir / "policy.json", policy)

    # Do not hash the mutable index or HTML shell into their own manifest.
    # Everything else—including experiment executions, native report, raw
    # traces, score receipts, frozen inputs, policy, configuration and package
    # metadata—is content addressed here.
    content_files = _tree_files(root, exclude={"index.json", "index.html"})
    identity = {
        key: initial_index.get(key)
        for key in (
            "schemaVersion", "candidateId", "artifactSha256", "promptFileSha256", "packageManifest",
            "suiteSha256", "caseIdentities", "evaluatorSha256", "experimentId", "reportIdentities",
        )
    }
    identity.update(
        {
            "runtimeConfigurationSha256": sha256_json(runtime_configuration),
            "sourceOrigin": canonical_record.get("sourceOrigin"),
            "runtimeOrigin": attestation.get("runtimeOrigin"),
            "runtime": attestation.get("runtime"),
            "tooling": attestation.get("tooling"),
            "snapshot": attestation.get("snapshot"),
            "canonicalRecordSha256": sha256_bytes(_read_file(native_dir / "experiment-record.json", "native experiment record")),
            "showExperimentSha256": sha256_bytes(_read_file(native_dir / "show-experiment.json", "native show output")),
            "policy": policy,
            "github": dict(github),
            "contentFiles": content_files,
        }
    )
    manifest_sha256 = sha256_json(identity)
    index = {
        **identity,
        "manifestSha256": manifest_sha256,
        "experimentPath": str(attestation.get("experimentPath", "")),
        "evaluatorPath": initial_index.get("evaluatorPath"),
        "suitePath": initial_index.get("suitePath"),
        "cases": initial_index.get("cases", []),
        "native": {
            "recordPath": "native/experiment-record.json",
            "showPath": "native/show-experiment.json",
            "attestationPath": "native/attestation.json",
            "policyPath": "native/policy.json",
        },
        "createdAt": _now(),
    }
    _write_json_private(root / "index.json", index)
    return index, manifest_sha256


def _verify_manifest_identity(index: Mapping, manifest_sha256: str | None) -> str:
    expected_keys = (
        "schemaVersion", "candidateId", "artifactSha256", "promptFileSha256", "packageManifest",
        "suiteSha256", "caseIdentities", "evaluatorSha256", "experimentId", "reportIdentities",
        "runtimeConfigurationSha256", "sourceOrigin", "runtimeOrigin", "runtime", "tooling", "snapshot",
        "canonicalRecordSha256", "showExperimentSha256", "policy", "github", "contentFiles",
    )
    identity = {key: index.get(key) for key in expected_keys}
    actual_manifest = sha256_json(identity)
    expected_manifest = index.get("manifestSha256")
    if not isinstance(expected_manifest, str) or actual_manifest != expected_manifest:
        raise ValueError("private review manifest digest differs")
    if manifest_sha256 is not None and manifest_sha256 != expected_manifest:
        raise ValueError("private review manifest is not the expected qualification")
    return expected_manifest


def fetch_private_review(client, bucket: str, prefix: str, root: Path, expected_manifest: str) -> None:
    """Read exactly the approved keys, without bucket enumeration."""
    if not SHA256_RE.fullmatch(expected_manifest):
        raise ValueError("a valid expected manifest is required")
    _private_root(root)
    key_root = prefix.rstrip("/") + "/"

    def read(name: str) -> bytes:
        return client.get_object(Bucket=bucket, Key=key_root + name)["Body"].read()

    raw_index = read("index.json")
    index = json.loads(raw_index)
    _verify_manifest_identity(index, expected_manifest)
    _write_private(root / "index.json", raw_index)
    for name, digest in index["contentFiles"].items():
        path = Path(name)
        if path.is_absolute() or ".." in path.parts or path.as_posix() != name:
            raise ValueError("private review contains an invalid path")
        body = read(name)
        if sha256_bytes(body) != digest:
            raise ValueError("downloaded private review content differs")
        _write_private(root / path, body)


def verify_private_review(review_root: str | Path, *, manifest_sha256: str | None = None) -> dict[str, Any]:
    """Reverify a persisted browser bundle without model or AWS access.

    This is the direct tamper/replay check used before a qualification receipt
    is handed to the protected workflow.  It authenticates the manifest,
    copied ZIP/suite/evaluator and every frozen case/bundle referenced by the
    review index; no mutable checkout path is trusted.
    """

    root = Path(review_root).resolve()
    if root.is_symlink() or not root.is_dir():
        raise ValueError("private review bundle is unavailable")
    index = _read_json(root / "index.json", "private review index")
    if not isinstance(index, Mapping):
        raise ValueError("private review index is malformed")
    expected_manifest = _verify_manifest_identity(index, manifest_sha256)
    if index.get("candidateId") != CANDIDATE_ID:
        raise ValueError("private review candidate is not repaired")
    github = index.get("github")
    package_manifest = index.get("packageManifest")
    if not isinstance(github, Mapping) or not isinstance(package_manifest, Mapping):
        raise ValueError("private review GitHub/package identity is missing")
    if github.get("headSha") != package_manifest.get("sourceRevision"):
        raise ValueError("private review GitHub head differs from package revision")
    prompt_file_sha256 = index.get("promptFileSha256")
    if not isinstance(prompt_file_sha256, str) or not SHA256_RE.fullmatch(prompt_file_sha256):
        raise ValueError("private review packaged prompt.py identity is missing")
    for key in ("runId", "runAttempt"):
        if github.get(key) is not None and (not str(github[key]).isdigit() or int(github[key]) <= 0):
            raise ValueError(f"private review GitHub {key} is malformed")
    content_files = index.get("contentFiles")
    if not isinstance(content_files, Mapping):
        raise ValueError("private review content manifest is missing")
    actual_files = _tree_files(root, exclude={"index.json", "index.html"})
    if dict(content_files) != actual_files:
        raise ValueError("private review content tree differs from its manifest")
    for relative, expected in content_files.items():
        if not isinstance(relative, str) or not isinstance(expected, str) or not SHA256_RE.fullmatch(expected):
            raise ValueError("private review content manifest is malformed")
        relative_path = Path(relative)
        if relative_path.is_absolute() or ".." in relative_path.parts or not relative_path.parts:
            raise ValueError("private review content path is unsafe")
        if sha256_bytes(_read_file(root / relative_path, "private review content")) != expected:
            raise ValueError(f"private review content digest differs: {relative}")
    for name, expected in (
        ("runtime.zip", index.get("artifactSha256")),
        ("suite.json", index.get("suiteSha256")),
        ("evaluator.json", index.get("evaluatorSha256")),
    ):
        raw = _read_file(root / "inputs" / name, f"private {name}")
        if not isinstance(expected, str) or sha256_bytes(raw) != expected:
            raise ValueError(f"private {name} digest differs")
    package_manifest_from_zip, package_sha256, prompt_file_sha256_from_zip = _load_manifest_from_zip(root / "inputs" / "runtime.zip")
    if package_sha256 != index.get("artifactSha256") or package_manifest_from_zip != package_manifest:
        raise ValueError("private Runtime ZIP manifest differs")
    if prompt_file_sha256_from_zip != prompt_file_sha256:
        raise ValueError("private packaged prompt.py digest differs")
    prompt_bytes = _read_file(root / "inputs" / "prompt.py", "private packaged prompt.py")
    if sha256_bytes(prompt_bytes) != prompt_file_sha256:
        raise ValueError("private packaged prompt.py content differs")
    runtime_sources = package_manifest.get("runtimeSourceFiles")
    if not isinstance(runtime_sources, Mapping) or runtime_sources.get("prompt.py") != prompt_file_sha256:
        raise ValueError("private Runtime manifest prompt.py identity differs")
    native_record = _read_json(root / "native" / "experiment-record.json", "native experiment record")
    native_show = _read_json(root / "native" / "show-experiment.json", "native show output")
    native_attestation = _read_json(root / "native" / "attestation.json", "native package attestation")
    if not isinstance(native_record, Mapping) or not isinstance(native_show, Mapping) or not isinstance(native_attestation, Mapping):
        raise ValueError("private native experiment evidence is malformed")
    if sha256_bytes(_read_file(root / "native" / "experiment-record.json", "native experiment record")) != index.get("canonicalRecordSha256"):
        raise ValueError("native experiment record digest differs")
    if sha256_bytes(_read_file(root / "native" / "show-experiment.json", "native show output")) != index.get("showExperimentSha256"):
        raise ValueError("native show output digest differs")
    _experiment_attestation(
        root / "experiment",
        native_record,
        native_show,
        artifact_sha256=str(index.get("artifactSha256")),
        effective_prompt_sha256=str(package_manifest.get("promptSha256")),
    )
    if sha256_json(index.get("policy")) != sha256_json(_read_json(root / "native" / "policy.json", "release policy")):
        raise ValueError("private release policy identity differs")
    case_entries = index.get("caseIdentities")
    if not isinstance(case_entries, list):
        raise ValueError("private review case identities are missing")
    by_case = {entry.get("caseId"): entry for entry in case_entries if isinstance(entry, Mapping)}
    cases = index.get("cases")
    if not isinstance(cases, list) or set(by_case) != {entry.get("caseId") for entry in cases if isinstance(entry, Mapping)}:
        raise ValueError("private review case index is incomplete")
    for entry in case_entries:
        if not isinstance(entry, Mapping):
            raise ValueError("private review case identity is malformed")
        case_id = _safe_case_name(entry.get("caseId"))
        case_bytes = _read_file(root / "inputs" / "cases" / f"{case_id}.frozen.json", "private frozen case")
        bundle_sha = entry.get("bundleSha256")
        bundle_bytes = _read_file(root / "inputs" / "bundles" / f"{bundle_sha}.json", "private source bundle")
        if sha256_bytes(bundle_bytes) != bundle_sha:
            raise ValueError(f"private source bundle digest differs: {case_id}")
        try:
            case = json.loads(case_bytes)
        except json.JSONDecodeError as exc:
            raise ValueError(f"private frozen case is malformed: {case_id}") from exc
        if not isinstance(case, Mapping) or case.get("caseSha256") != entry.get("caseSha256"):
            raise ValueError(f"private frozen case identity differs: {case_id}")
    return dict(index)


def _configuration_descriptor(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise ValueError("runtime configuration must be an object")
    # Keep the full intended configuration private in the qualification.  A
    # content digest is sufficient for public summaries and approval comments.
    return json.loads(json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False))


def build_qualification(
    *,
    runtime_zip: str | Path,
    suite_path: str | Path,
    evaluator_path: str | Path,
    output_root: str | Path,
    candidate_id: str = CANDIDATE_ID,
    wait_seconds: int = 300,
    model_session: Any = None,
    runtime_configuration: Mapping[str, Any] | None = None,
    source_revision: str | None = None,
    runtime_name: str = "IncidentTriageDemoAgent",
    alarm_arn: str | None = None,
    artifact_spec: Mapping[str, Any] | None = None,
    source_spec: Mapping[str, Any] | None = None,
    configuration_spec: Mapping[str, Any] | None = None,
    adapter: Mapping[str, Any] | None = None,
    controller: Mapping[str, Any] | None = None,
    bucket: str | None = None,
    prefix: str | None = None,
    region: str = DEFAULT_REGION,
) -> tuple[Path, dict[str, Any]]:
    """Evaluate and freeze a candidate, returning its private receipt path."""

    if candidate_id != CANDIDATE_ID:
        raise ValueError("the S5 release gate only accepts candidate repaired")
    if type(wait_seconds) is not int or not 0 <= wait_seconds <= 600:
        raise ValueError("wait_seconds must be between 0 and 600")
    zip_path = Path(runtime_zip).resolve()
    suite = Path(suite_path).resolve()
    evaluator = Path(evaluator_path).resolve()
    private = _private_root(Path(output_root).resolve())
    package_manifest, artifact_sha256, prompt_file_sha256 = _load_manifest_from_zip(zip_path)
    roster, suite_descriptor, suite_sha256 = _load_roster(suite)
    evaluator_raw = _read_file(evaluator, "evaluator descriptor")
    evaluator_sha256 = sha256_bytes(evaluator_raw)
    evaluator_descriptor = _read_json(evaluator, "evaluator descriptor")
    if not isinstance(evaluator_descriptor, Mapping):
        raise ValueError("evaluator descriptor must be an object")
    if source_revision is not None and (not REVISION_RE.fullmatch(source_revision) or package_manifest.get("sourceRevision") != source_revision):
        raise ValueError("requested source revision does not match the package manifest")
    if package_manifest.get("sourceRevision") is None:
        raise ValueError("package manifest source revision is missing")
    configuration = _configuration_descriptor(runtime_configuration)
    if configuration is None:
        # The machine experiment is still useful for diagnosis, but the
        # release receipt must not claim a publishable candidate without the
        # intended serving configuration bound to its reviewed identity.
        raise ValueError("intended Runtime configuration is required for qualification")

    if not isinstance(runtime_name, str) or not runtime_name.strip():
        raise ValueError("runtime name is required")
    alarm_value = alarm_arn or os.environ.get("PHASE20_ALARM_ARN")
    if not isinstance(alarm_value, str) or not alarm_value.strip():
        raise ValueError("alarm ARN is required for a publishable qualification")

    try:
        import development_experiment
    except ImportError as exc:
        raise RuntimeError("the locked development experiment is unavailable") from exc
    run_package = getattr(development_experiment, "run_package_experiment", None)
    if not callable(run_package):
        raise RuntimeError("development_experiment.run_package_experiment is unavailable")
    run_kwargs: dict[str, Any] = {
        "runtime_zip": zip_path,
        "suite_path": suite,
        "evaluator_path": evaluator,
        "output_root": private / "experiments",
        "model_session": model_session,
        "wait_seconds": wait_seconds,
    }
    experiment_dir = Path(run_package(**run_kwargs)).resolve()
    show = getattr(development_experiment, "show_experiment", None)
    if not callable(show):
        raise RuntimeError("development_experiment.show_experiment is unavailable")
    canonical_record = _read_json(experiment_dir / "experiment.json", "experiment record")
    shown = show(experiment_dir)
    if not isinstance(canonical_record, Mapping) or not isinstance(shown, Mapping):
        raise ValueError("package experiment record is malformed")
    attestation = _experiment_attestation(
        experiment_dir,
        canonical_record,
        shown,
        artifact_sha256=artifact_sha256,
        effective_prompt_sha256=package_manifest["promptSha256"],
    )
    rows = shown.get("cases")
    if not isinstance(rows, Sequence) or isinstance(rows, (str, bytes, bytearray)):
        raise ValueError("package experiment case rows are missing")
    decision = machine_decision(expected_cases=roster, rows=rows)
    show_decision = shown.get("decision")
    if isinstance(show_decision, Mapping):
        shown_verdict = show_decision.get("verdict")
        if shown.get("readErrors") and decision.get("verdict") != "reject":
            decision = {"verdict": "incomplete", "reason": "authenticated native show_experiment evidence is incomplete"}
        elif shown_verdict == "reject" and decision.get("verdict") != "reject":
            decision = {"verdict": "reject", "reason": "native show_experiment reported a deterministic rejection"}
        elif shown_verdict == "incomplete" and decision.get("verdict") == "review_required":
            decision = {"verdict": "incomplete", "reason": "native show_experiment evidence is incomplete"}
    review_root, review_index, manifest_sha256 = _private_browser_bundle(
        private,
        suite_path=suite,
        suite_descriptor=suite_descriptor,
        suite_sha256=suite_sha256,
        evaluator_path=evaluator,
        evaluator_sha256=evaluator_sha256,
        runtime_zip=zip_path,
        artifact_sha256=artifact_sha256,
        package_manifest=package_manifest,
        prompt_file_sha256=prompt_file_sha256,
        runtime_configuration_sha256=sha256_json(configuration),
        experiment_dir=experiment_dir,
        experiment_record=canonical_record,
        rows=rows,
    )
    # Preserve the exact selected inputs beside the browser review.  The
    # package experiment has its own authenticated snapshots; these copies
    # make offline tamper/replay checks independent of the checkout.
    inputs_dir = review_root / "inputs"
    _copy_private(zip_path, inputs_dir / "runtime.zip", "Runtime ZIP")
    with zipfile.ZipFile(io.BytesIO(_read_file(zip_path, "Runtime ZIP"))) as archive:
        packaged_prompt = archive.read("prompt.py")
    if sha256_bytes(packaged_prompt) != prompt_file_sha256:
        raise ValueError("Runtime ZIP prompt.py digest changed during qualification")
    _write_private(inputs_dir / "prompt.py", packaged_prompt)
    _copy_private(suite, inputs_dir / "suite.json", "reviewed suite")
    _copy_private(evaluator, inputs_dir / "evaluator.json", "evaluator descriptor")
    # The native experiment is already private, but retaining it under the
    # review prefix makes selected report/trace/session identities and raw SDK
    # output available to the replacement-browser reviewer.
    experiment_copy = review_root / "experiment"
    if experiment_copy.exists():
        if experiment_copy.is_symlink() or not experiment_copy.is_dir():
            raise ValueError("private experiment review path is not a directory")
        shutil.rmtree(experiment_copy)
    shutil.copytree(experiment_dir, experiment_copy, symlinks=False)
    for copied in experiment_copy.rglob("*"):
        if copied.is_symlink():
            raise ValueError("experiment contains an unsafe symlink")
        if copied.is_dir():
            copied.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
        if copied.is_file():
            copied.chmod(stat.S_IRUSR | stat.S_IWUSR)
    github = {
        "runId": os.environ.get("GITHUB_RUN_ID"),
        "runAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
        "headSha": os.environ.get("GITHUB_SHA") or package_manifest.get("sourceRevision"),
        "repositoryOwner": os.environ.get("GITHUB_REPOSITORY_OWNER"),
        "repository": os.environ.get("GITHUB_REPOSITORY"),
        "workflow": os.environ.get("GITHUB_WORKFLOW"),
        "ref": os.environ.get("GITHUB_REF"),
    }
    github_head = github.get("headSha")
    if not isinstance(github_head, str) or not REVISION_RE.fullmatch(github_head):
        raise ValueError("GitHub build head SHA is missing or malformed")
    if github_head != package_manifest.get("sourceRevision"):
        raise ValueError("GitHub build head differs from the packaged source revision")
    if github.get("runId") is not None and (not str(github["runId"]).isdigit() or int(github["runId"]) <= 0):
        raise ValueError("GitHub build run ID is malformed")
    if github.get("runAttempt") is not None and (not str(github["runAttempt"]).isdigit() or int(github["runAttempt"]) <= 0):
        raise ValueError("GitHub build run attempt is malformed")
    review_index, manifest_sha256 = _finalize_private_review(
        review_root,
        review_index,
        canonical_record=canonical_record,
        shown=shown,
        attestation=attestation,
        runtime_configuration=configuration,
        github=github,
    )
    report_identities: list[dict[str, Any]] = []
    for entry in review_index.get("cases", []):
        report_identities.append({
            key: entry.get(key)
            for key in ("caseId", "executionId", "traceId", "reportSha256")
            if entry.get(key) is not None
        })
    report_identities_sha256 = sha256_json(report_identities)

    # The package gate owns this identity tuple; when a release workflow has
    # already staged serving objects, their immutable descriptors are carried
    # forward unchanged for the protected publisher.  Local-only runs retain
    # their paths and remain useful for review, but cannot be published.
    package_s3 = None
    if isinstance(configuration.get("agentRuntimeArtifact"), Mapping):
        package_code = configuration["agentRuntimeArtifact"].get("codeConfiguration")
        if isinstance(package_code, Mapping) and isinstance(package_code.get("code"), Mapping):
            package_s3 = package_code["code"].get("s3")
    artifact_value = dict(artifact_spec) if isinstance(artifact_spec, Mapping) else (
        {"bucket": package_s3.get("bucket"), "key": package_s3.get("prefix"), "versionId": package_s3.get("versionId"), "sha256": artifact_sha256}
        if isinstance(package_s3, Mapping) and all(package_s3.get(key) for key in ("bucket", "prefix", "versionId"))
        else {"sha256": artifact_sha256, "path": "inputs/runtime.zip"}
    )
    if artifact_value.get("sha256") != artifact_sha256:
        raise ValueError("serving artifact descriptor digest differs from the checked ZIP")
    source_value = dict(source_spec) if isinstance(source_spec, Mapping) else {}
    declared_source_sha = source_value.get("sha256")
    if declared_source_sha is not None and declared_source_sha != prompt_file_sha256:
        raise ValueError("source descriptor sha256 must identify the packaged prompt.py bytes")
    declared_effective_sha = source_value.get("effectivePromptSha256")
    if declared_effective_sha is not None and declared_effective_sha != package_manifest.get("promptSha256"):
        raise ValueError("source descriptor effectivePromptSha256 differs from the schema-v2 package manifest")
    source_value.update(
        {
            "sha256": prompt_file_sha256,
            "effectivePromptSha256": package_manifest["promptSha256"],
            "path": source_value.get("path", "inputs/prompt.py"),
        }
    )
    configuration_value = dict(configuration_spec) if isinstance(configuration_spec, Mapping) else {
        "sha256": sha256_json(configuration),
        "path": "inputs/runtime-configuration.json",
    }
    receipt: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "status": {
            "review_required": "review_required",
            "reject": "rejected",
            "incomplete": "incomplete",
        }.get(decision.get("verdict"), "incomplete"),
        "verdict": decision.get("verdict"),
        "reason": decision.get("reason"),
        "candidateId": CANDIDATE_ID,
        "endpointName": ENDPOINT_NAME,
        "runtimeName": runtime_name,
        "sourceRevision": package_manifest["sourceRevision"],
        "promptSha256": package_manifest["promptSha256"],
        "promptFileSha256": prompt_file_sha256,
        "modelId": evaluator_descriptor.get("judgeModelId"),
        "alarmArn": alarm_value,
        "artifact": artifact_value,
        "source": source_value,
        "configuration": configuration_value,
        "suite": {"sha256": suite_sha256, "path": "inputs/suite.json", "caseIds": [row[0] for row in roster]},
        "evaluator": {"sha256": evaluator_sha256, "path": "inputs/evaluator.json", "descriptor": dict(evaluator_descriptor)},
        "runtimeConfiguration": configuration,
        "runtimeConfigurationSha256": sha256_json(configuration),
        "caseSet": {"sha256": suite_sha256},
        "inputs": {"caseIds": [row[0] for row in roster], "suiteSha256": suite_sha256},
        "reports": report_identities,
        "reportIdentitiesSha256": report_identities_sha256,
        "evaluation": {
            "experimentId": canonical_record.get("experimentId"),
            "reportIdentities": report_identities,
            "reportIdentitiesSha256": report_identities_sha256,
        },
        "adapter": dict(adapter) if isinstance(adapter, Mapping) else {},
        "controller": dict(controller) if isinstance(controller, Mapping) else {},
        "experiment": {
            "experimentId": canonical_record.get("experimentId"),
            "path": str(experiment_dir),
            "status": canonical_record.get("status"),
            "decision": decision,
            "reportSha256": review_index.get("reportIdentities"),
            "canonicalRecordSha256": review_index.get("canonicalRecordSha256"),
            "showExperimentSha256": review_index.get("showExperimentSha256"),
        },
        "github": github,
        "packageOrigin": attestation.get("runtimeOrigin"),
        "driver": attestation.get("runtimeOrigin", {}).get("driver") if isinstance(attestation.get("runtimeOrigin"), Mapping) else None,
        "policy": review_index.get("policy"),
        "reviewManifestSha256": manifest_sha256,
        "privateReview": {"path": str(review_root), "index": "index.html", "manifest": "index.json"},
        "createdAt": _now(),
    }
    if artifact_spec is not None:
        # The serving key is known before human review. Only the protected
        # publisher can write it and obtain its immutable S3 VersionId.
        receipt["servingArtifact"] = {
            "bucket": "cdk-evaltalk-assets-027224425948-us-east-1",
            "key": f"agent-qualified/{artifact_sha256}.zip",
        }
    remote_prefix = None
    if bucket:
        remote_prefix = _review_s3_prefix(prefix, manifest_sha256=manifest_sha256, github=github)
        _render_browser_index(review_root, review_index, bucket=bucket, prefix=remote_prefix, region=region)
        receipt["privateReview"]["s3"] = _upload_private_bundle(review_root, bucket=bucket, prefix=remote_prefix, region=region)
    else:
        _render_browser_index(review_root, review_index, bucket=None, prefix=None, region=region)
    receipt_path = private / "repaired-qualification.json"
    summary_path = private / "qualification-summary.json"
    receipt["safeSummaryPath"] = str(summary_path)
    qualification_key = None
    if bucket:
        qualification_key = f"{receipt['privateReview']['s3']['prefix'].strip('/')}/qualification.json"
        receipt["privateReview"]["s3"]["qualificationKey"] = qualification_key
    _write_private(receipt_path, json.dumps(receipt, ensure_ascii=False, sort_keys=True, indent=2).encode() + b"\n")
    # Keep a separately safe descriptor for Actions summaries/artifacts.  The
    # full receipt remains a protected local handoff and must not be uploaded
    # as a public workflow artifact.
    safe_summary = {
        "schemaVersion": SCHEMA_VERSION,
        "status": receipt.get("status"),
        "verdict": receipt.get("verdict"),
        "candidateId": CANDIDATE_ID,
        "sourceRevision": receipt.get("sourceRevision"),
        "promptSha256": receipt.get("promptSha256"),
        "promptFileSha256": receipt.get("promptFileSha256"),
        "artifactSha256": artifact_sha256,
        "suiteSha256": suite_sha256,
        "evaluatorSha256": evaluator_sha256,
        "runtimeConfigurationSha256": receipt.get("runtimeConfigurationSha256"),
        "reviewManifestSha256": manifest_sha256,
        "github": github,
        "privateReview": receipt.get("privateReview", {}).get("s3", {}),
    }
    _write_json_private(summary_path, safe_summary)
    if bucket and qualification_key is not None:
        _upload_private_object(
            bucket=bucket,
            key=qualification_key,
            body=_read_file(receipt_path, "qualification receipt"),
            region=region,
        )
    # A receipt is itself an authenticated input to the publisher.  Reopen it
    # and check its digest before returning, so a partial local write cannot be
    # reported as a successful machine review.
    reopened = _read_json(receipt_path, "qualification receipt")
    if not isinstance(reopened, Mapping) or reopened.get("reviewManifestSha256") != manifest_sha256:
        raise RuntimeError("qualification receipt readback does not match the review manifest")
    return receipt_path, dict(receipt)


def verify_approval(
    *,
    qualification: Mapping[str, Any],
    read_history: Callable[[int], Iterable[Mapping[str, Any]]],
    run_id: int,
    environment_id: int,
    reviewer_id: int,
) -> bool:
    """Check a protected approval against the exact private manifest."""

    if qualification.get("status") != "eligible":
        return False
    manifest = qualification.get("reviewManifestSha256")
    if not isinstance(manifest, str):
        return False
    return has_matching_approval(
        read_history=read_history,
        run_id=run_id,
        environment_id=environment_id,
        reviewer_id=reviewer_id,
        manifest_sha256=manifest,
    )


def verify_private_clearance(
    *,
    review_root: str | Path,
    qualification_path: str | Path | None = None,
    expected_manifest: str | None = None,
    current_head: str | None = None,
    clearance_output: str | Path,
) -> dict[str, Any]:
    """Reverify private evidence before publisher credentials are acquired.

    The returned clearance contains only safe identities and is written to a
    private local file.  It is intentionally separate from the public Actions
    summary and does not contain approval credentials or raw reports.
    """

    index = verify_private_review(review_root, manifest_sha256=expected_manifest)
    manifest = index["manifestSha256"]
    qualification = None
    if qualification_path is not None:
        qualification = _read_json(Path(qualification_path), "qualification receipt")
        if not isinstance(qualification, Mapping):
            raise ValueError("qualification receipt is malformed")
        if qualification.get("status") not in {"review_required", "eligible"}:
            raise ValueError("qualification is not a successful machine review")
        if qualification.get("reviewManifestSha256") != manifest:
            raise ValueError("qualification manifest differs from private review")
        artifact = qualification.get("artifact")
        suite = qualification.get("suite")
        source = qualification.get("source")
        evaluator = qualification.get("evaluator")
        if not isinstance(artifact, Mapping) or artifact.get("sha256") != index.get("artifactSha256"):
            raise ValueError("qualification artifact differs from private review")
        if not isinstance(suite, Mapping) or suite.get("sha256") != index.get("suiteSha256"):
            raise ValueError("qualification suite differs from private review")
        package_manifest = index.get("packageManifest")
        if not isinstance(source, Mapping) or not isinstance(package_manifest, Mapping):
            raise ValueError("qualification source or private package identity is missing")
        if source.get("sha256") != index.get("promptFileSha256"):
            raise ValueError("qualification source does not identify the packaged prompt.py bytes")
        if source.get("effectivePromptSha256") != package_manifest.get("promptSha256"):
            raise ValueError("qualification source effective prompt digest differs from the schema-v2 package manifest")
        if qualification.get("promptSha256") != package_manifest.get("promptSha256"):
            raise ValueError("qualification effective prompt digest differs from the private package identity")
        if not isinstance(evaluator, Mapping) or evaluator.get("sha256") != index.get("evaluatorSha256"):
            raise ValueError("qualification evaluator differs from private review")
        case_ids = index.get("caseIdentities")
        if not isinstance(case_ids, list) or suite.get("caseIds") != [entry.get("caseId") for entry in case_ids]:
            raise ValueError("qualification case roster differs from private review")
        reports = qualification.get("reports")
        expected_reports = [
            {key: entry.get(key) for key in ("caseId", "executionId", "traceId", "reportSha256") if entry.get(key) is not None}
            for entry in index.get("reportIdentities", [])
        ] if isinstance(index.get("reportIdentities"), list) else None
        if not isinstance(reports, list) or reports != expected_reports:
            raise ValueError("qualification report identities differ from private review")
        if qualification.get("reportIdentitiesSha256") != sha256_json(reports):
            raise ValueError("qualification report identity digest differs from private review")
        if qualification.get("runtimeConfigurationSha256") != index.get("runtimeConfigurationSha256"):
            raise ValueError("qualification Runtime configuration differs from private review")
    github = index.get("github")
    if current_head is not None:
        if not REVISION_RE.fullmatch(current_head) or not isinstance(github, Mapping) or github.get("headSha") != current_head:
            raise ValueError("private review is not for the current GitHub head")
    clearance = {
        "schemaVersion": SCHEMA_VERSION,
        "status": "cleared",
        "candidateId": CANDIDATE_ID,
        "manifestSha256": manifest,
        "artifactSha256": index.get("artifactSha256"),
        "suiteSha256": index.get("suiteSha256"),
        "evaluatorSha256": index.get("evaluatorSha256"),
        "runtimeConfigurationSha256": index.get("runtimeConfigurationSha256"),
        "contentTreeSha256": sha256_json(index.get("contentFiles")),
        "github": dict(github) if isinstance(github, Mapping) else {},
        "verifiedAt": _now(),
    }
    destination = Path(clearance_output).resolve()
    try:
        destination.relative_to(Path(review_root).resolve())
    except ValueError:
        pass
    else:
        raise ValueError("clearance must be written outside the immutable review bundle")
    _write_json_private(destination, clearance)
    reopened = _read_json(destination, "private clearance")
    if not isinstance(reopened, Mapping) or reopened.get("manifestSha256") != manifest or reopened.get("status") != "cleared":
        raise RuntimeError("private clearance readback differs")
    return clearance


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", nargs="?", choices=("qualify", "fetch-private", "verify-private"), default="qualify")
    parser.add_argument("--runtime-zip", type=Path)
    parser.add_argument("--suite", type=Path)
    parser.add_argument("--evaluator", type=Path)
    parser.add_argument("--output-root", type=Path)
    parser.add_argument("--runtime-configuration", type=Path)
    parser.add_argument("--artifact-spec", type=Path)
    parser.add_argument("--source-spec", type=Path)
    parser.add_argument("--configuration-spec", type=Path)
    parser.add_argument("--adapter", type=Path)
    parser.add_argument("--controller", type=Path)
    parser.add_argument("--source-revision")
    parser.add_argument("--runtime-name", default="IncidentTriageDemoAgent")
    parser.add_argument("--alarm-arn", default=os.environ.get("PHASE20_ALARM_ARN"))
    parser.add_argument("--wait-seconds", type=int, default=300)
    parser.add_argument("--bucket", help="Upload private evidence to this explicitly selected S3 bucket")
    parser.add_argument("--prefix")
    parser.add_argument("--region", default=os.environ.get("AWS_REGION", DEFAULT_REGION))
    parser.add_argument("--review-root", type=Path)
    parser.add_argument("--qualification", type=Path)
    parser.add_argument("--expected-manifest")
    parser.add_argument("--current-head")
    parser.add_argument("--clearance-output", type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "fetch-private":
            import boto3
            if not all((args.bucket, args.prefix, args.review_root, args.expected_manifest)):
                raise ValueError("fetch-private requires bucket, prefix, review root and manifest")
            s3 = boto3.Session(region_name=args.region).client("s3")
            fetch_private_review(s3, args.bucket, args.prefix, args.review_root, args.expected_manifest)
            return 0
        if args.command == "verify-private":
            if args.review_root is None or args.clearance_output is None:
                raise ValueError("verify-private requires --review-root and --clearance-output")
            clearance = verify_private_clearance(
                review_root=args.review_root,
                qualification_path=args.qualification,
                expected_manifest=args.expected_manifest,
                current_head=args.current_head,
                clearance_output=args.clearance_output,
            )
            print(json.dumps({
                "status": clearance["status"],
                "manifestSha256": clearance["manifestSha256"],
                "clearancePath": str(args.clearance_output.resolve()),
            }, sort_keys=True))
            return 0
        if args.runtime_zip is None or args.suite is None or args.evaluator is None or args.output_root is None:
            raise ValueError("qualify requires --runtime-zip, --suite, --evaluator, and --output-root")
        configuration = _read_json(args.runtime_configuration, "Runtime configuration") if args.runtime_configuration else None
        artifact_spec = _read_json(args.artifact_spec, "artifact descriptor") if args.artifact_spec else None
        source_spec = _read_json(args.source_spec, "source descriptor") if args.source_spec else None
        configuration_spec = _read_json(args.configuration_spec, "configuration descriptor") if args.configuration_spec else None
        adapter = _read_json(args.adapter, "adapter descriptor") if args.adapter else None
        controller = _read_json(args.controller, "controller descriptor") if args.controller else None
        path, receipt = build_qualification(
            runtime_zip=args.runtime_zip,
            suite_path=args.suite,
            evaluator_path=args.evaluator,
            output_root=args.output_root,
            wait_seconds=args.wait_seconds,
            runtime_configuration=configuration,
            artifact_spec=artifact_spec,
            source_spec=source_spec,
            configuration_spec=configuration_spec,
            adapter=adapter,
            controller=controller,
            source_revision=args.source_revision,
            runtime_name=args.runtime_name,
            alarm_arn=args.alarm_arn,
            bucket=args.bucket,
            prefix=args.prefix,
            region=args.region,
        )
        # Public Actions output is deliberately limited to safe identities and
        # a local receipt path; the browser index itself stays private.
        safe = {
            "status": receipt.get("status"),
            "verdict": receipt.get("verdict"),
            "candidateId": receipt.get("candidateId"),
            "sourceRevision": receipt.get("sourceRevision"),
            "promptSha256": receipt.get("promptSha256"),
            "promptFileSha256": receipt.get("promptFileSha256"),
            "artifactSha256": receipt.get("artifact", {}).get("sha256"),
            "suiteSha256": receipt.get("suite", {}).get("sha256"),
            "evaluatorSha256": receipt.get("evaluator", {}).get("sha256"),
            "reviewManifestSha256": receipt.get("reviewManifestSha256"),
            "receiptPath": str(path),
            "privateReview": receipt.get("privateReview", {}).get("s3", {}),
        }
        print(json.dumps(safe, sort_keys=True))
        return 0 if receipt.get("status") in {"review_required", "eligible"} else 1 if receipt.get("status") == "rejected" else 2
    except (OSError, ValueError, TypeError, RuntimeError) as exc:
        print(json.dumps({"status": "error", "reason": f"{type(exc).__name__}: {exc}"}, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
