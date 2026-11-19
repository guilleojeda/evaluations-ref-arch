#!/usr/bin/env python3
"""Build a validated private session-input index from a Phase 22 roster.

This command only authenticates selected local private bytes and writes the
small JSON input consumed by ``talk-session.py``.  It does not copy assets,
run an agent, call a model, query AWS, change a branch, or publish a release.
Use ``--stage S3`` for independent S3 entry.  Include ``--live-release-binding``
when producing an all-stage input; S5 remains tied to the exact output schema
from ``verify-talk-publication.ts``. A hand-written or contradictory binding is
rejected, and a missing binding leaves S5 unready.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys
import tarfile
from typing import Any


STAGES = tuple(f"S{number}" for number in range(6))
EXPECTED_CANDIDATES = {"S0": "faulty", "S1": "faulty", "S2": "faulty", "S3": "repaired", "S4": "repaired", "S5": "repaired"}
FIXED_CASE_IDS = [
    "phase14.inventory-capacity-overload.prepared",
    "phase14.denied-inventory-read.prepared",
    "phase14.recovery-with-old-alert.prepared",
]
HISTORICAL_OVERLOAD_CASE_ID = FIXED_CASE_IDS[0]
FIXED_NON_OVERLOAD_CASE_IDS = FIXED_CASE_IDS[1:]
SHA256_LENGTH = 64


class InputError(ValueError):
    pass


def read_json(path: Path, label: str) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise InputError(f"{label} is unavailable: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise InputError(f"{label} is not valid UTF-8 JSON: {path}") from exc
    if not isinstance(value, dict):
        raise InputError(f"{label} must be an object")
    return value


def digest(path: Path) -> str:
    if path.is_symlink() or not path.is_file():
        raise InputError(f"selected input is unavailable: {path}")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tree_digest(path: Path) -> str:
    if path.is_symlink() or not path.is_dir():
        raise InputError(f"selected input tree is unavailable: {path}")
    records: list[str] = []
    for child in sorted(path.rglob("*")):
        if child.is_symlink():
            raise InputError(f"selected input tree contains a symlink: {child}")
        if child.is_file():
            records.append(f"{digest(child)}  {child.relative_to(path).as_posix()}\n")
    if not records:
        raise InputError(f"selected input tree is empty: {path}")
    return hashlib.sha256("".join(records).encode()).hexdigest()


def require_sha(value: Any, label: str) -> str:
    if not isinstance(value, str) or len(value) != SHA256_LENGTH or any(c not in "0123456789abcdef" for c in value):
        raise InputError(f"{label} must be a lowercase SHA-256 digest")
    return value


def require_case_membership(value: Any, expected: list[str], label: str) -> None:
    if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
        raise InputError(f"{label} must be a list of case IDs")
    if len(value) != len(set(value)) or set(value) != set(expected):
        raise InputError(f"{label} does not match the selected case membership")


def reviewed_case_digest(case: dict[str, Any]) -> str:
    """Use the shared reviewed-case identity algorithm when its project deps exist."""
    agent_root = Path(__file__).resolve().parents[1] / "agent"
    try:
        import sys
        if str(agent_root) not in sys.path:
            sys.path.insert(0, str(agent_root))
        from reviewed_cases import case_digest
    except ModuleNotFoundError:
        # Keep the portable CLI usable outside the uv project; this is the
        # exact canonicalization used by reviewed_cases.case_digest.
        return hashlib.sha256(json.dumps(case, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    return case_digest(case)


def selected_paths(root: Path, roster: dict[str, Any], stage: str, suite: str) -> list[str]:
    entry = roster["stages"][stage]
    paths = entry.get("inputs")
    if not isinstance(paths, list) or not paths or not all(isinstance(item, str) and item for item in paths):
        raise InputError(f"{stage} roster inputs must be non-empty relative paths")
    selected: list[str] = []
    for value in paths:
        if suite == "stock" and value == "gate/qualification-input.json":
            value = "gate/stock-qualification-input.json"
        elif suite == "stock" and value == "gate/staging.tar.gz":
            value = "gate/stock-staging.tar.gz"
        elif suite == "stock" and value == "gate/import-check.json":
            continue
        elif suite == "stock" and stage in {"S3", "S5"} and value == "audience/denial-session.frozen.json":
            # S1 always carries the separately reviewed audience case.  Later
            # stock stages must use only the preserved prepared denial row.
            value = "prepared/denial.frozen.json"
        path = Path(value)
        if path.is_absolute() or ".." in path.parts:
            raise InputError(f"{stage} input path is not relative: {value}")
        selected_input = root / path
        if not selected_input.is_file() and not selected_input.is_dir():
            raise InputError(f"{stage} selected input is missing: {value}")
        selected_digests = roster.get("selectedDigests")
        expected = selected_digests.get(value) if isinstance(selected_digests, dict) else None
        if not isinstance(expected, str):
            raise InputError(f"{stage} selected input has no recorded roster digest: {value}")
        observed = digest(selected_input) if selected_input.is_file() else tree_digest(selected_input)
        if observed != expected:
            raise InputError(f"{stage} selected input digest differs from roster: {value}")
        selected.append(value)
    return selected


def gate_rows(root: Path, gate: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], dict[str, Any], str]:
    archive = root / ("gate/stock-staging.tar.gz" if gate.get("stock") else "gate/staging.tar.gz")
    observed_archive_sha = digest(archive)
    if observed_archive_sha != gate.get("archiveSha256"):
        raise InputError("selected gate archive digest differs from its pointer")
    try:
        with tarfile.open(archive, "r:gz") as tar:
            manifest = json.load(tar.extractfile("staging/manifest.json"))
            evaluator_bytes = tar.extractfile("staging/evaluator.json").read()
            evaluator = json.loads(evaluator_bytes)
    except (OSError, KeyError, tarfile.TarError, TypeError, json.JSONDecodeError) as exc:
        raise InputError("selected gate archive is not a valid private staging archive") from exc
    rows = manifest.get("cases")
    if not isinstance(rows, list) or not rows:
        raise InputError("selected gate manifest has no case rows")
    index: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("caseId"), str):
            raise InputError("selected gate manifest has an invalid case row")
        if row["caseId"] in index:
            raise InputError("selected gate manifest contains duplicate case IDs")
        for field in ("caseSha256", "bundleSha256", "case", "bundle"):
            if not isinstance(row.get(field), str) or not row[field]:
                raise InputError(f"selected gate case row is missing {field}")
        index[row["caseId"]] = row
    if not isinstance(evaluator, dict):
        raise InputError("selected gate evaluator is invalid")
    return index, evaluator, hashlib.sha256(evaluator_bytes).hexdigest()


def authenticated_audience(root: Path, roster: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    metadata = roster.get("audienceCase")
    if not isinstance(metadata, dict) or not isinstance(metadata.get("caseId"), str) or not require_sha(metadata.get("bundleSha256"), "audienceCase.bundleSha256"):
        raise InputError("S1 requires the reviewed audience case identity")
    frozen = read_json(root / "audience/denial-session.frozen.json", "S1 frozen audience case")
    frozen_case = frozen.get("case") if isinstance(frozen.get("case"), dict) else frozen
    if not isinstance(frozen_case, dict) or frozen_case.get("caseId") != metadata["caseId"]:
        raise InputError("S1 frozen audience case ID differs from the reviewed roster")
    case_sha = require_sha(frozen.get("caseSha256"), "S1 frozen audience caseSha256")
    if case_sha != metadata.get("caseSha256") or case_sha != reviewed_case_digest(frozen_case):
        raise InputError("S1 frozen audience case digest differs from the reviewed identity")
    evidence = frozen_case.get("evidence")
    if not isinstance(evidence, dict) or evidence.get("bundleSha256") != metadata.get("bundleSha256"):
        raise InputError("S1 frozen audience bundle digest differs from the reviewed identity")
    task = frozen_case.get("task")
    reference_time = task.get("referenceTime") if isinstance(task, dict) else None
    if not isinstance(reference_time, str) or not reference_time:
        raise InputError("S1 frozen audience case has no referenceTime")
    audience = {**metadata, "caseSha256": case_sha, "referenceTime": reference_time}
    row = {"caseId": metadata["caseId"], "caseSha256": case_sha, "bundleSha256": metadata["bundleSha256"], "referenceTime": reference_time}
    return audience, row


def case_rows(root: Path, roster: dict[str, Any], suite: str, *, authenticate_audience: bool) -> tuple[list[str], dict[str, Any], dict[str, dict[str, Any]], dict[str, Any], str]:
    gate = roster.get("gate")
    if not isinstance(gate, dict):
        raise InputError("roster gate section is missing")
    gate = dict(gate)
    gate["stock"] = suite == "stock"
    rows, evaluator, evaluator_sha = gate_rows(root, gate)
    case_ids = list(rows)
    fixed = set(FIXED_CASE_IDS)
    if not set(FIXED_NON_OVERLOAD_CASE_IDS) <= set(case_ids) or gate.get("fixedDenialCaseId") != FIXED_NON_OVERLOAD_CASE_IDS[0]:
        raise InputError("proposed gate does not retain the fixed denial/recovery coverage")
    audience: dict[str, Any] = {}
    if authenticate_audience:
        audience, audience_row = authenticated_audience(root, roster)
    if suite == "carried":
        if len(case_ids) != 4:
            raise InputError("carried gate must contain the selected overload, fixed denial/recovery, and audience cases")
        # Older carried archives predate the replacement pointer.  Their
        # historical capacity row remains a supported replay input; a new
        # roster explicitly selects the replacement row by its case ID.
        current_overload = gate.get("currentOverloadCaseId", HISTORICAL_OVERLOAD_CASE_ID)
        if not isinstance(current_overload, str) or not current_overload:
            raise InputError("carried gate must declare currentOverloadCaseId")
        current_row = rows.get(current_overload)
        if not isinstance(current_row, dict) or current_row.get("label") != "capacity":
            raise InputError("carried gate currentOverloadCaseId is not an authenticated capacity case")
        if sum(row.get("label") == "capacity" for row in rows.values()) != 1:
            raise InputError("carried gate must contain exactly one authenticated capacity case")
        if authenticate_audience:
            if audience.get("caseId") not in case_ids:
                raise InputError("audience case is not part of the carried gate roster")
            gate_audience = rows.get(audience["caseId"])
            if not isinstance(gate_audience, dict) or gate_audience.get("label") != "audience-denial" or audience.get("caseId") == current_overload or any(gate_audience.get(field) != audience_row.get(field) for field in ("caseSha256", "bundleSha256", "referenceTime")):
                raise InputError("audience case identity differs from the verified carried gate row")
    else:
        if set(case_ids) != fixed:
            raise InputError("stock gate must retain exactly the historical fixed denial/capacity/recovery cases")
        case_ids = list(FIXED_CASE_IDS)
    return case_ids, audience, rows, evaluator, evaluator_sha


def build_stage_identity(root: Path, roster: dict[str, Any], stage: str, paths: list[str], case_ids: list[str], audience: dict[str, Any], rows: dict[str, dict[str, Any]], evaluator: dict[str, Any], suite: str, gate: dict[str, Any]) -> dict[str, Any]:
    candidate = EXPECTED_CANDIDATES[stage]
    gate_sha = require_sha(gate["archiveSha256"], "gate.archiveSha256") if stage in {"S2", "S3", "S4", "S5"} else None
    bundle_ids = {case_id: require_sha(row["bundleSha256"], f"gate case {case_id} bundleSha256") for case_id, row in rows.items()}
    stage_cases = [] if stage == "S0" else ["phase14.denied-inventory-read.prepared"]
    if stage == "S1":
        stage_cases = [audience["caseId"]]
    elif stage == "S3":
        stage_cases = [audience["caseId"] if suite == "carried" else "phase14.denied-inventory-read.prepared"]
    elif stage in {"S4", "S5"}:
        stage_cases = list(case_ids)
    bundle_digests = [bundle_ids[item] for item in stage_cases]
    case_digests = [require_sha(rows[item].get("caseSha256"), f"gate case {item} caseSha256") for item in stage_cases]
    cutoff = rows[stage_cases[0]].get("referenceTime") if len(stage_cases) == 1 else None
    evaluator_identity = None
    if stage in {"S2", "S3", "S4", "S5"}:
        configuration = evaluator.get("configuration") if isinstance(evaluator.get("configuration"), dict) else {}
        evaluator_identity = {"id": configuration.get("evaluatorArn") or evaluator.get("evaluatorId"), "configSha256": evaluator.get("configSha256"), "status": evaluator.get("status", "recorded-active")}
    immutable_basis = json.dumps({"stage": stage, "candidate": candidate, "gate": gate_sha, "cases": stage_cases, "caseDigests": case_digests, "bundles": bundle_digests, "paths": paths}, sort_keys=True).encode()
    input_id = f"phase22-{stage.lower()}-{hashlib.sha256(immutable_basis).hexdigest()[:16]}"
    identity: dict[str, Any] = {
        "candidateId": candidate,
        "inputId": input_id,
        "caseIds": stage_cases,
        "caseSha256s": case_digests,
        "bundleSha256s": bundle_digests,
        "cutoff": cutoff,
        "evaluator": evaluator_identity,
        "gateArchiveSha256": gate_sha,
        "paths": paths,
        "checkpointTag": roster["stages"][stage].get("checkpointTag"),
        "sourceAnchor": roster["stages"][stage].get("sourceAnchor"),
    }
    if stage == "S2":
        run_paths = [root / value for value in paths if value.startswith("s2/run/")]
        if len(run_paths) != 1 or not run_paths[0].is_dir():
            raise InputError("S2 requires exactly one authenticated native execution directory")
        execution = read_json(run_paths[0] / "execution.json", "S2 execution snapshot")
        score = read_json(root / "s2/score-result.json", "S2 scoring result")
        execution_identity = execution.get("identity")
        if not isinstance(execution_identity, dict) or not isinstance(execution_identity.get("executionId"), str):
            raise InputError("S2 execution snapshot has no immutable executionId")
        if not isinstance(score.get("scoringAttemptId"), str) or not score["scoringAttemptId"]:
            raise InputError("S2 scoring result has no immutable scoringAttemptId")
        if score.get("executionId") != execution_identity["executionId"]:
            raise InputError("S2 score result executionId differs from the loaded execution")
        denial_row = rows.get("phase14.denied-inventory-read.prepared")
        if not isinstance(denial_row, dict) or execution_identity.get("caseSha256") != denial_row.get("caseSha256") or execution_identity.get("bundleSha256") != denial_row.get("bundleSha256"):
            raise InputError("S2 execution identity does not match the selected fixed denial row")
        identity.update({"executionId": execution_identity["executionId"], "scoringAttemptId": score["scoringAttemptId"], "recordedFallback": "s2/advisory-result.json"})
    if stage in {"S3", "S4"}:
        identity["recordedFallback"] = f"{stage.lower()}/offline-comparison.json" if stage == "S3" else "s4/offline-show.json"
    if stage == "S5":
        identity["qualificationInput"] = {"suiteMode": suite, "suiteSha256": gate.get("suiteSha256"), "fixedDenialCaseId": gate.get("fixedDenialCaseId"), "audienceCaseId": audience["caseId"] if suite == "carried" else None}
    return identity


def build(args: argparse.Namespace) -> dict[str, Any]:
    roster_path = Path(args.roster).expanduser().resolve()
    roster = read_json(roster_path, "stage roster")
    if roster.get("schemaVersion") != 1 or not isinstance(roster.get("stages"), dict):
        raise InputError("stage roster schemaVersion/stages are invalid")
    asset_root = roster.get("assetRoot", "stage-assets/session-a")
    if not isinstance(asset_root, str) or Path(asset_root).is_absolute() or ".." in Path(asset_root).parts:
        raise InputError("stage roster assetRoot must be a relative path")
    root = roster_path.parent / asset_root
    if not root.is_dir():
        raise InputError(f"stage roster asset root is unavailable: {root}")
    requested = (args.stage,) if args.stage else STAGES
    suite = args.suite
    for stage in requested:
        if stage not in roster["stages"]:
            raise InputError(f"stage roster is missing {stage}")
        if roster["stages"][stage].get("candidateId") not in (None, EXPECTED_CANDIDATES[stage]):
            raise InputError(f"{stage} candidate identity differs from the approved stage default")
    requires_gate = any(stage in {"S2", "S3", "S4", "S5"} for stage in requested)
    if requires_gate:
        if suite == "carried":
            gate = dict(roster["gate"])
        else:
            stock_pointer = read_json(root / "gate/stock-qualification-input.json", "stock qualification pointer")
            stock_archive = root / "gate/stock-staging.tar.gz"
            stock_sha = digest(stock_archive)
            if stock_pointer.get("sha256") != stock_sha or stock_pointer.get("s3Key", "").startswith("agent-evaluation/phase18/inputs/") is False:
                raise InputError("stock qualification pointer does not match its content-addressed archive")
            gate = {"archiveSha256": stock_sha, "suiteSha256": stock_pointer.get("suiteSha256"), "evaluatorSha256": stock_pointer.get("evaluatorSha256"), "fixedDenialCaseId": "phase14.denied-inventory-read.prepared", "caseIds": list(FIXED_CASE_IDS)}
        pointer_name = "gate/stock-qualification-input.json" if suite == "stock" else "gate/qualification-input.json"
        pointer = read_json(root / pointer_name, "selected qualification pointer")
        archive_sha = require_sha(gate.get("archiveSha256"), "selected gate archiveSha256")
        pointer_fields = {"schemaVersion", "purpose", "bucket", "s3Key", "sha256", "suiteSha256", "evaluatorSha256", "caseIds"}
        if set(pointer) != pointer_fields or pointer.get("schemaVersion") != 1 or pointer.get("sha256") != archive_sha or pointer.get("s3Key") != f"agent-evaluation/phase18/inputs/{archive_sha}/staging.tar.gz":
            raise InputError("selected qualification pointer is not content-addressed to the requested archive")
        gate.update({"bucket": pointer.get("bucket"), "s3Key": pointer.get("s3Key"), "pointerCaseIds": pointer.get("caseIds"), "pointerSha256": pointer.get("sha256"), "pointerDocument": pointer, "evaluatorSha256": pointer.get("evaluatorSha256")})
        need_audience = "S1" in requested or (suite == "carried" and any(stage in {"S3", "S5"} for stage in requested))
        case_ids, audience, rows, evaluator, evaluator_sha = case_rows(root, {**roster, "gate": gate}, suite, authenticate_audience=need_audience)
        if gate.get("pointerCaseIds") != case_ids or gate.get("evaluatorSha256") != evaluator_sha:
            raise InputError("selected qualification pointer case roster differs from its authenticated manifest")
        gate["evaluatorSha256"] = evaluator_sha
    else:
        gate = {"archiveSha256": None, "suiteSha256": None, "fixedDenialCaseId": "phase14.denied-inventory-read.prepared"}
        if "S1" in requested:
            audience, audience_row = authenticated_audience(root, roster)
            rows = {audience["caseId"]: audience_row}
            case_ids = [audience["caseId"]]
        else:
            audience = {"caseId": "phase14.denied-inventory-read.session-draft", "bundleSha256": "0" * 64}
            rows = {}
            case_ids = []
        evaluator = {}
    identities = {}
    for stage in requested:
        paths = selected_paths(root, roster, stage, suite)
        if stage in {"S1", "S3"}:
            if "prepared/denial.json" not in paths:
                raise InputError(f"{stage} requires the reviewed denial bundle in its declared inputs")
            requested_bundle_sha = digest(root / "prepared/denial.json")
            expected_bundle_sha = audience.get("bundleSha256") if stage == "S1" or suite == "carried" else rows["phase14.denied-inventory-read.prepared"].get("bundleSha256")
            if requested_bundle_sha != expected_bundle_sha:
                raise InputError(f"{stage} requested bundle digest differs from the reviewed case identity")
        # S0/S1 are preparation-only and must not be made dependent on the
        # evaluator or gate bytes used by later stages.
        stage_gate = gate if stage in {"S2", "S3", "S4", "S5"} else {"archiveSha256": None, "suiteSha256": None, "fixedDenialCaseId": gate.get("fixedDenialCaseId")}
        stage_rows = rows
        if stage == "S1" and audience:
            stage_rows = {**rows, audience["caseId"]: {"caseId": audience["caseId"], "caseSha256": audience["caseSha256"], "bundleSha256": audience["bundleSha256"], "referenceTime": audience["referenceTime"]}}
        identities[stage] = build_stage_identity(root, roster, stage, paths, case_ids, audience, stage_rows, evaluator, suite, stage_gate)
    generation = roster.get("generation")
    if not isinstance(generation, str) or not generation.strip():
        raise InputError("stage roster must carry the canonical checkpoint generation")
    requested_session_id = getattr(args, "session_id", None)
    if requested_session_id is not None and (not isinstance(requested_session_id, str) or not requested_session_id.strip()):
        raise InputError("--session-id must be a non-empty performance identifier")
    session_id = requested_session_id or f"{roster.get('sessionId')}-{suite}"
    result: dict[str, Any] = {"schemaVersion": 1, "sessionId": session_id, "sourceAssetSessionId": roster.get("sessionId"), "generation": generation, "suiteMode": suite, "stages": identities}
    if "S5" in requested:
        if not args.live_release_binding:
            raise InputError("all-stage/S5 input requires --live-release-binding from verified live-release evidence")
        binding = read_json(Path(args.live_release_binding).expanduser().resolve(), "live-release binding")
        expected_binding_keys = {"schemaVersion", "kind", "checkedAt", "demoDeploy", "remote", "publication", "qualification"}
        if set(binding) != expected_binding_keys or binding.get("schemaVersion") != 1 or binding.get("kind") != "phase22-s5-qualification-binding":
            raise InputError("live-release binding must be the exact verify-talk-publication.ts SessionBinding schema")
        demo_deploy = binding.get("demoDeploy")
        if not isinstance(demo_deploy, dict) or demo_deploy.get("branch") != "demo-deploy" or demo_deploy.get("candidateId") != "repaired":
            raise InputError("live-release binding must identify the repaired demo-deploy publication")
        required_demo_fields = ("branch", "qualifiedCommit", "candidateId", "publicationId", "sourceRevision", "remoteTip", "endpointName", "endpointArn", "runtimeArn", "runtimeVersion", "artifactSha256", "artifactVersionId", "configurationSha256", "promptSha256", "sourceSha256", "qualificationManifestSha256", "suiteSha256", "evaluatorSha256")
        if set(demo_deploy) - set(required_demo_fields) - {"configurationVersionId"} or any(field not in demo_deploy for field in required_demo_fields):
            raise InputError("live-release binding demoDeploy fields do not match verify-talk-publication.ts")
        for field in required_demo_fields:
            if not isinstance(demo_deploy.get(field), str) or not demo_deploy[field]:
                raise InputError(f"live-release binding is missing demoDeploy.{field}")
        if demo_deploy["sourceRevision"] != demo_deploy["qualifiedCommit"] or demo_deploy["remoteTip"] != demo_deploy["qualifiedCommit"]:
            raise InputError("live-release binding demoDeploy source/remote identity differs from qualifiedCommit")
        remote = binding.get("remote")
        remote_fields = {"repository", "branch", "gitTip", "githubTip", "pointerPath", "pointerSha256"}
        if not isinstance(remote, dict) or set(remote) != remote_fields or remote.get("branch") != "demo-deploy" or remote.get("gitTip") != demo_deploy["remoteTip"] or remote.get("githubTip") != demo_deploy["remoteTip"]:
            raise InputError("live-release binding remote tip does not exactly match demoDeploy.remoteTip")
        publication = binding.get("publication")
        publication_fields = {"candidateId", "endpointName", "endpointArn", "runtimeArn", "runtimeVersion", "artifactSha256", "artifactVersionId", "configurationSha256", "sourceRevision", "sourceSha256", "promptSha256", "modelId"}
        if not isinstance(publication, dict) or set(publication) - publication_fields - {"configurationVersionId"} or any(field not in publication for field in publication_fields) or publication.get("candidateId") != "repaired":
            raise InputError("live-release binding publication is not repaired")
        for field in ("sourceRevision", "runtimeVersion", "artifactSha256", "artifactVersionId", "endpointName", "endpointArn", "runtimeArn", "configurationSha256", "promptSha256", "sourceSha256"):
            if publication.get(field) != demo_deploy.get(field):
                raise InputError(f"live-release binding publication.{field} differs from demoDeploy")
        qualification = binding.get("qualification")
        if not isinstance(qualification, dict) or set(qualification) != {"receipt", "reviewManifest", "humanReview", "inputPointer"}:
            raise InputError("live-release binding qualification shape differs from verify-talk-publication.ts")
        receipt_fields = {"bucket", "key", "sha256", "status", "sourceRevision", "artifactSha256", "sourceSha256", "configurationSha256", "promptSha256", "manifestSha256", "suiteSha256", "evaluatorSha256", "caseIds"}
        review_fields = {"bucket", "key", "sha256", "artifactSha256", "suiteSha256", "evaluatorSha256", "caseIds", "reportCount"}
        human_fields = {"status", "environment", "reviewer", "runId", "manifestSha256", "approval"}
        approval_fields = {"runId", "reviewer", "reviewerId", "environment", "environmentId", "comment", "state", "headSha"}
        for label, value, fields in (("receipt", qualification.get("receipt"), receipt_fields), ("reviewManifest", qualification.get("reviewManifest"), review_fields), ("humanReview", qualification.get("humanReview"), human_fields)):
            if not isinstance(value, dict) or set(value) != fields:
                raise InputError(f"live-release binding qualification.{label} shape differs from verify-talk-publication.ts")
        if not isinstance(qualification["humanReview"].get("approval"), dict) or set(qualification["humanReview"]["approval"]) != approval_fields or qualification["humanReview"].get("status") != "approved":
            raise InputError("live-release binding human review does not match verify-talk-publication.ts")
        receipt = qualification["receipt"]
        review_manifest = qualification["reviewManifest"]
        human_review = qualification["humanReview"]
        approval = human_review["approval"]
        if receipt.get("status") not in {"review_required", "eligible"}:
            raise InputError("live-release binding qualification receipt is not a successful verifier handoff")
        if receipt.get("sourceRevision") != demo_deploy["sourceRevision"] or receipt.get("artifactSha256") != demo_deploy["artifactSha256"] or receipt.get("sourceSha256") != demo_deploy["sourceSha256"] or receipt.get("configurationSha256") != demo_deploy["configurationSha256"] or receipt.get("promptSha256") != demo_deploy["promptSha256"]:
            raise InputError("live-release binding receipt does not match the published tuple")
        try:
            require_case_membership(receipt.get("caseIds"), case_ids, "qualification receipt caseIds")
        except InputError:
            raise
        if receipt.get("manifestSha256") != demo_deploy["qualificationManifestSha256"] or receipt.get("suiteSha256") != gate.get("suiteSha256") or receipt.get("evaluatorSha256") != gate.get("evaluatorSha256"):
            raise InputError("live-release binding receipt does not match the selected qualification")
        try:
            require_case_membership(review_manifest.get("caseIds"), case_ids, "review manifest caseIds")
        except InputError:
            raise
        if review_manifest.get("sha256") != demo_deploy["qualificationManifestSha256"] or review_manifest.get("artifactSha256") != demo_deploy["artifactSha256"] or review_manifest.get("suiteSha256") != gate.get("suiteSha256") or review_manifest.get("evaluatorSha256") != gate.get("evaluatorSha256"):
            raise InputError("live-release binding review manifest does not match the selected qualification")
        if human_review.get("manifestSha256") != demo_deploy["qualificationManifestSha256"] or approval.get("state") != "approved" or approval.get("environment") != "repaired-publication" or approval.get("headSha") != demo_deploy["sourceRevision"]:
            raise InputError("live-release binding human review tuple does not match the published source")
        pointer = qualification.get("inputPointer")
        if not isinstance(pointer, dict) or set(pointer) != pointer_fields or pointer != gate.get("pointerDocument") or pointer.get("schemaVersion") != 1 or pointer.get("bucket") != gate.get("bucket") or pointer.get("s3Key") != gate.get("s3Key") or pointer.get("sha256") != gate.get("archiveSha256") or pointer.get("s3Key") != f"agent-evaluation/phase18/inputs/{gate.get('archiveSha256')}/staging.tar.gz" or pointer.get("suiteSha256") != gate.get("suiteSha256") or pointer.get("caseIds") != case_ids or pointer.get("evaluatorSha256") != gate.get("evaluatorSha256"):
            raise InputError("live-release binding input pointer does not exactly match the selected suite")
        if demo_deploy.get("suiteSha256") != gate.get("suiteSha256") or demo_deploy.get("evaluatorSha256") != gate.get("evaluatorSha256"):
            raise InputError("live-release binding qualified suite/evaluator does not exactly match the selected suite")
        result["demoDeploy"] = demo_deploy
        result["stages"]["S5"]["liveReleaseBinding"] = {
            "publicationId": demo_deploy["publicationId"],
            "qualifiedCommit": demo_deploy["qualifiedCommit"],
            "runtimeVersion": demo_deploy["runtimeVersion"],
            "artifactSha256": demo_deploy["artifactSha256"],
            "qualifiedSuiteSha256": demo_deploy.get("suiteSha256"),
            "requestedSuiteSha256": gate.get("suiteSha256"),
            "requiresNewQualification": False,
        }
    output = Path(args.output).expanduser().resolve() if args.output else None
    if output:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("build", nargs="?", default="build", choices=("build",))
    parser.add_argument("--roster", required=True)
    parser.add_argument("--output")
    parser.add_argument("--session-id", help="distinct performance/session identifier; input identities remain tied to the private roster")
    parser.add_argument("--stage", choices=STAGES)
    parser.add_argument("--suite", choices=("carried", "stock"), default="carried", help="explicitly choose the audience-carried four-case suite or the preserved stock three-case fallback")
    parser.add_argument("--live-release-binding")
    args = parser.parse_args(argv)
    try:
        print(json.dumps(build(args), indent=2, sort_keys=True))
        return 0
    except (InputError, OSError, TypeError, KeyError) as exc:
        print(str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
