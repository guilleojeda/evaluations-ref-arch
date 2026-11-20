"""Run, score and reopen captured investigations from the development workspace."""

from __future__ import annotations

import argparse
from contextlib import redirect_stdout
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from typing import Any, Callable, Mapping
import uuid

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from agentcore_evaluation import (
    DEFAULT_MODE,
    HAIKU_45_MODEL_ID,
    judgment_assertions,
    MULTI_MODE,
    SINGLE_MODE,
    SONNET_46_MODEL_ID,
    evaluator_config,
    score_session,
)
from captured_execution import (
    acquire_operation_lock,
    load_execution,
    operation_lock_held,
    release_operation_lock,
    run_captured_case,
)
from evaluation_telemetry import (
    CloudWatchSession,
    evidence_assertions,
    execution_content,
    score_execution,
)


ACCOUNT = "027224425948"
REGION = "us-east-1"
LOG_GROUP = "/aws/bedrock-agentcore/incident-triage-evaluation"
DIMENSIONS = {"diagnosis_support", "evidence_grounding"}
SEMANTIC_MODES = (MULTI_MODE, SINGLE_MODE)
AWS_CONFIG = Config(connect_timeout=5, read_timeout=15, retries={"total_max_attempts": 1})
EVALUATE_CONFIG = Config(connect_timeout=5, read_timeout=180, retries={"total_max_attempts": 1})


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _digest(value: Any) -> str:
    body = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(body.encode()).hexdigest()


def _read(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_bytes())
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} must contain a JSON object")
    return value


def _write(path: Path, value: dict[str, Any]) -> None:
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as stream:
        temp = Path(stream.name)
        try:
            json.dump(value, stream, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)


def _aws() -> boto3.Session:
    session = boto3.Session(region_name=REGION)
    if session.client("sts", config=AWS_CONFIG).get_caller_identity()["Account"] != ACCOUNT:
        raise ValueError("evaluation credentials resolved to the wrong account")
    return session


def _configured(control: Any, pin: dict[str, Any]) -> dict[str, Any]:
    evaluator_id = pin.get("evaluatorId")
    mode = pin.get("evaluatorMode", DEFAULT_MODE)
    if mode not in SEMANTIC_MODES:
        raise ValueError(f"reviewed evaluator mode is unsupported: {mode!r}")
    expected = evaluator_config(pin.get("judgeModelId"), mode)
    if _digest(expected) != pin.get("configSha256"):
        raise ValueError("reviewed evaluator definition differs from its configuration digest")
    if not isinstance(evaluator_id, str) or not evaluator_id:
        raise ValueError("reviewed evaluator ID is missing")
    arn = f"arn:aws:bedrock-agentcore:{REGION}:{ACCOUNT}:evaluator/{evaluator_id}"
    if arn != pin.get("evaluatorArn"):
        raise ValueError("reviewed evaluator ARN differs from its ID, Region or account")
    actual = control.get_evaluator(evaluatorId=evaluator_id, includedData="ALL_DATA")
    if (
        actual.get("status") != "ACTIVE" or actual.get("level") != "SESSION"
        or actual.get("evaluatorArn") != arn or actual.get("evaluatorId") != evaluator_id
        or actual.get("evaluatorConfig") != expected
    ):
        raise ValueError("active evaluator does not match the reviewed SESSION configuration")
    return {
        key: actual.get(key)
        for key in ("evaluatorArn", "evaluatorId", "evaluatorName", "level", "status", "evaluatorConfig")
    } | {"evaluatorMode": mode}


def _provision(model_id: str, mode: str = DEFAULT_MODE) -> dict[str, Any]:
    if mode not in SEMANTIC_MODES:
        raise ValueError(f"unsupported semantic evaluator mode {mode!r}")
    config = evaluator_config(model_id, mode)
    digest = _digest(config)
    name_prefix = "IncidentTriageSemanticSingle" if mode == SINGLE_MODE else "IncidentTriageSemantic"
    name = f"{name_prefix}_{digest[:18]}"
    control = _aws().client("bedrock-agentcore-control", config=AWS_CONFIG)
    evaluator_id = next(
        (
            item["evaluatorId"]
            for page in control.get_paginator("list_evaluators").paginate()
            for item in page["evaluators"]
            if item.get("evaluatorName") == name
        ),
        None,
    )
    if evaluator_id is None:
        # Bind idempotency to the complete immutable request identity. A
        # digest-only token could be reused by a differently named provisional
        # evaluator with the same configuration.
        client_token = _digest({"evaluatorName": name, "evaluatorConfig": config})
        response = control.create_evaluator(
            clientToken=client_token, evaluatorName=name, level="SESSION", evaluatorConfig=config,
            description="Captured incident diagnosis support and evidence grounding",
            tags={"Project": "IncidentTriageDemo"},
        )
        evaluator_id = response["evaluatorId"]
    end = time.monotonic() + 90
    while True:
        state = control.get_evaluator(evaluatorId=evaluator_id, includedData="METADATA_ONLY")
        status = state["status"]
        if status == "ACTIVE":
            break
        if status not in {"CREATING", "UPDATING"} or time.monotonic() >= end:
            raise ValueError(f"evaluator {evaluator_id} did not become ACTIVE (status {status})")
        time.sleep(2)
    pin = {
        "evaluatorId": evaluator_id,
        "evaluatorArn": state["evaluatorArn"],
        "judgeModelId": model_id,
        "configSha256": digest,
        "evaluatorMode": mode,
    }
    pin["configuration"] = _configured(control, pin)
    return pin


def _new_attempt(
    root: Path,
    *,
    execution: dict[str, Any],
    pending_callback: Callable[[Mapping[str, Any]], None] | None = None,
) -> tuple[Path, dict[str, Any], Any]:
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    attempt_id = str(uuid.uuid4())
    attempt = root / attempt_id
    attempt.mkdir(mode=0o700)
    pending = {
        "status": "pending",
        "phase": "starting",
        "scoringAttemptId": attempt_id,
        "startedAt": _now(),
        **execution,
    }
    receipt = attempt / "result.json"
    lock = acquire_operation_lock(attempt / ".owner.lock")
    try:
        _write(receipt, pending)
        # The receipt is the authoritative attempt identity.  Notify the
        # native experiment while the score lock is still held, before any
        # telemetry or judge request can block or terminate the process.
        if pending_callback is not None:
            pending_callback(dict(pending))
    except BaseException:
        release_operation_lock(lock)
        raise
    return receipt, pending, lock


def _finish(receipt: Path, pending: dict[str, Any], outcome: dict[str, Any], started: float) -> dict[str, Any]:
    result = {**pending, **outcome, "finishedAt": _now(), "elapsedSeconds": round(time.monotonic() - started, 3)}
    result.pop("phase", None)
    _write(receipt, result)
    return result


def _mark_interrupted(receipt: Path, *, reason: str) -> dict[str, Any]:
    value = _read(receipt)
    if value.get("status") == "pending":
        value = {**value, "status": "interrupted", "reason": reason}
    return value


def _load_score_receipt(path: Path) -> dict[str, Any]:
    value = _read(path)
    if value.get("status") == "pending" and not operation_lock_held(path.parent / ".owner.lock"):
        value = _mark_interrupted(path, reason="scoring process is no longer running")
    return value


def _summary(result: dict[str, Any]) -> dict[str, Any]:
    public = {
        key: result[key] for key in (
            "status", "kind", "executionId", "scoringAttemptId", "identity", "evaluator",
            "phase", "reason", "diagnostic", "deterministic", "elapsedSeconds", "waitSeconds", "scoringSeconds",
            "usage", "modelRequestCount", "evidenceToolCallCount", "evidenceProviderCallCount",
            "failure", "telemetryError", "telemetryWarning",
        ) if key in result
    }
    semantic = result.get("semantic")
    telemetry = result.get("telemetry")
    if isinstance(telemetry, dict):
        public["telemetry"] = {
            key: telemetry[key] for key in ("status", "spanCount", "sha256", "reason") if key in telemetry
        }
    if isinstance(semantic, dict):
        public["semantic"] = {
            key: semantic[key]
            for key in ("status", "mode", "findings", "finding", "verdict", "tokenUsage", "errorCode", "errorMessage", "validationError")
            if key in semantic
        }
    return public


def _scoring_source_digests() -> dict[str, str]:
    return {
        name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
        for name in ("deterministic_checks.py", "evaluation_telemetry.py", "agentcore_evaluation.py")
    }


def _check_after_scoring(control: Any, pin: dict[str, Any], before: dict[str, Any], result: dict[str, Any]) -> None:
    if not isinstance(result.get("semantic"), dict):
        return
    try:
        if _configured(control, pin) == before:
            return
    except (ValueError, ClientError, BotoCoreError):
        pass
    result["status"] = "incomplete"
    result["reason"] = "evaluator configuration could not be confirmed after scoring"


def _score(
    run: Path,
    pin_path: Path,
    wait: int,
    requested_mode: str | None = None,
    *,
    pending_callback: Callable[[Mapping[str, Any]], None] | None = None,
) -> dict[str, Any]:
    record, loaded, native_spans = load_execution(run)
    if record.get("status") != "complete":
        raise ValueError("captured execution is incomplete or interrupted")
    pin = _read(pin_path)
    mode = pin.get("evaluatorMode", DEFAULT_MODE)
    if mode not in SEMANTIC_MODES:
        raise ValueError(f"reviewed evaluator mode is unsupported: {mode!r}")
    required_pin_fields = ("evaluatorId", "evaluatorArn", "judgeModelId", "configSha256")
    if not all(isinstance(pin.get(key), str) and pin[key].strip() for key in required_pin_fields):
        raise ValueError("pinned evaluator descriptor is incomplete")
    if requested_mode is not None and requested_mode != mode:
        raise ValueError("requested semantic evaluator mode does not match the pinned evaluator descriptor")
    received = record["identity"]
    receipt, pending, operation_lock = _new_attempt(
        run / "scores",
        execution={
            "kind": "captured_execution_score",
            "executionId": received["executionId"],
            "identity": received,
            "evaluator": {
                **{
                    key: pin[key]
                    for key in ("evaluatorId", "evaluatorArn", "judgeModelId", "configSha256")
                },
                "evaluatorMode": mode,
            },
            "evaluatorConfiguration": None,
            "scoringSourceSha256": _scoring_source_digests(),
        },
        pending_callback=pending_callback,
    )
    started = time.monotonic()
    before: dict[str, Any] | None = None
    session: boto3.Session | None = None
    control: Any = None

    class _PhaseClient:
        def __init__(self, client: Any) -> None:
            self._client = client

        def evaluate(self, **request: Any) -> Any:
            current = _read(receipt)
            if current.get("status") == "pending":
                current["phase"] = "scoring"
                _write(receipt, current)
            return self._client.evaluate(**request)

        def __getattr__(self, name: str) -> Any:
            return getattr(self._client, name)

    try:
        session = _aws()
        control = session.client("bedrock-agentcore-control", config=AWS_CONFIG)
        before = _configured(control, pin)
        pending["evaluatorConfiguration"] = before
        pending["phase"] = "waiting_for_telemetry"
        _write(receipt, pending)
        fetch = CloudWatchSession(
            session.client("logs", config=AWS_CONFIG), LOG_GROUP,
            started_at=record["startedAt"], finished_at=record["finishedAt"],
        )
        result = score_execution(
            record, loaded, fetch_session=fetch,
            evaluation_client=_PhaseClient(session.client("bedrock-agentcore", config=EVALUATE_CONFIG)),
            evaluator_id=pin["evaluatorId"], wait_seconds=wait,
            scoring_attempt_id=pending["scoringAttemptId"],
            verified_spans=native_spans,
            semantic_mode=mode,
        )
        if before is not None:
            _check_after_scoring(control, pin, before, result)
    except (ValueError, ClientError, BotoCoreError) as exc:
        result = {"status": "error", "reason": _error_message(exc)}
    try:
        return _finish(receipt, pending, result, started)
    finally:
        release_operation_lock(operation_lock)


def _validate_control(control: dict[str, Any]) -> None:
    expected = control.get("expected")
    spans = control.get("sessionSpans")
    assertions = control.get("assertions")
    if (
        control.get("kind") != "calibration_control" or not all(
            isinstance(control.get(key), str) and control[key].strip()
            for key in ("id", "group", "sessionId", "traceId")
        )
        or not isinstance(control.get("provenance"), dict)
        or not isinstance(expected, dict) or set(expected) != DIMENSIONS
        or not all(isinstance(item, dict) and item.get("verdict") in {"pass", "fail"}
                   and isinstance(item.get("reason"), str) and item["reason"].strip() for item in expected.values())
        or not isinstance(assertions, list) or not assertions
        or not all(isinstance(item, str) and item.strip() for item in assertions)
        or not isinstance(spans, list) or not spans
        or not all(isinstance(span, dict) and span.get("traceId") == control["traceId"]
                   and isinstance(span.get("attributes"), dict)
                   and span["attributes"].get("session.id") == control["sessionId"] for span in spans)
    ):
        raise ValueError("constructed calibration control lacks verified shape, provenance or human labels")


def _reviewed_case_from_control(control: Mapping[str, Any]) -> Mapping[str, Any] | None:
    """Return the optional loaded ``reviewedCase`` carried by a calibration control."""

    if "reviewedCase" not in control:
        return None
    candidate = control["reviewedCase"]
    if not isinstance(candidate, Mapping):
        raise ValueError("calibration control reviewed case must be an object")
    if isinstance(candidate.get("case"), Mapping):
        return candidate
    if all(isinstance(candidate.get(key), Mapping) for key in ("expectations", "evidence", "review")):
        return {"case": candidate}
    raise ValueError("calibration control reviewed case lacks expectations, evidence, or review")


def _calibrate(
    source: Path,
    pin_path: Path,
    output: Path,
    requested_mode: str | None = None,
) -> dict[str, Any]:
    fixture = _read(source)
    _validate_control(fixture)
    observed = execution_content(fixture["sessionSpans"])
    reviewed_case = _reviewed_case_from_control(fixture)
    assertions = judgment_assertions(reviewed_case, existing_policy=fixture["assertions"])
    assertions.extend(evidence_assertions(observed))
    pin = _read(pin_path)
    mode = pin.get("evaluatorMode", DEFAULT_MODE)
    if mode not in SEMANTIC_MODES:
        raise ValueError(f"reviewed evaluator mode is unsupported: {mode!r}")
    if requested_mode is not None and requested_mode != mode:
        raise ValueError("requested semantic evaluator mode does not match the pinned evaluator descriptor")
    session = _aws()
    control = session.client("bedrock-agentcore-control", config=AWS_CONFIG)
    before = _configured(control, pin)
    receipt, pending, operation_lock = _new_attempt(output, execution={
        "kind": "calibration_control",
        "controlId": fixture["id"],
        "controlSha256": _digest(fixture),
        "evaluator": {
            **{
                key: pin[key]
                for key in ("evaluatorId", "evaluatorArn", "judgeModelId", "configSha256")
            },
            "evaluatorMode": mode,
        },
        "evaluatorConfiguration": before,
        "scoringSourceSha256": _scoring_source_digests(),
        "control": fixture,
        "assertions": assertions,
        "assertionsSha256": _digest(assertions),
    })
    started = time.monotonic()
    semantic = score_session(
        session.client("bedrock-agentcore", config=EVALUATE_CONFIG), evaluator_id=pin["evaluatorId"],
        session_id=fixture["sessionId"], trace_id=fixture["traceId"], session_spans=fixture["sessionSpans"],
        assertions=assertions,
        mode=mode,
    )
    result = {"status": semantic["status"], "semantic": semantic}
    _check_after_scoring(control, pin, before, result)
    try:
        return _finish(receipt, pending, result, started)
    finally:
        release_operation_lock(operation_lock)


def _show(run: Path) -> dict[str, Any]:
    """Read a saved execution without starting work or contacting AWS."""

    record, _, _ = load_execution(run)
    attempts = [
        _summary(_load_score_receipt(path))
        for path in sorted((run / "scores").glob("*/result.json"))
    ]
    return {**record, "scoringAttempts": attempts}


def _error_message(exc: Exception) -> str:
    if isinstance(exc, ClientError):
        return f"{exc.operation_name} returned {exc.response.get('Error', {}).get('Code', 'unknown service error')}"
    if isinstance(exc, BotoCoreError):
        return type(exc).__name__
    return str(exc)


def _add_semantic_mode_arg(command: argparse.ArgumentParser, *, default: str | None = None) -> None:
    """Add the explicit evaluator-rubric selector without changing old defaults."""

    command.add_argument(
        "--rubric",
        dest="semantic_mode", choices=SEMANTIC_MODES, default=default,
        help="semantic evaluator rubric (single is an experimental native categorical verdict)",
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run")
    run.add_argument("--case", required=True, type=Path)
    run.add_argument("--bundle", required=True, type=Path)
    run.add_argument("--output-root", required=True, type=Path)
    run.add_argument("--candidate", choices=("faulty", "repaired"), default=None)
    score = commands.add_parser("score")
    score.add_argument("--run", required=True, type=Path)
    score.add_argument("--evaluator", required=True, type=Path, help="reviewed evaluator descriptor from provision")
    score.add_argument("--wait-seconds", type=int, choices=range(0, 601), default=300, metavar="0-600")
    _add_semantic_mode_arg(score)
    show = commands.add_parser("show")
    show.add_argument("--run", required=True, type=Path)
    compare = commands.add_parser("compare")
    compare.add_argument("--baseline", required=True, type=Path)
    compare.add_argument("--candidate", required=True, type=Path)
    compare.add_argument("--baseline-attempt")
    compare.add_argument("--candidate-attempt")
    calibration = commands.add_parser("calibrate")
    calibration.add_argument("--control", required=True, type=Path)
    calibration.add_argument("--evaluator", required=True, type=Path)
    calibration.add_argument("--output-root", required=True, type=Path)
    _add_semantic_mode_arg(calibration)
    provision = commands.add_parser("provision", help="prepare an immutable evaluator definition with administrator access")
    provision.add_argument("--model", required=True, choices=(HAIKU_45_MODEL_ID, SONNET_46_MODEL_ID))
    _add_semantic_mode_arg(provision, default=DEFAULT_MODE)
    return parser


def main() -> int:
    args = _parser().parse_args()
    code = 0
    try:
        if args.command == "run":
            def progress(run_dir: Path, record: dict[str, Any]) -> None:
                print(json.dumps({"status": "running", "runDirectory": str(run_dir)}), file=sys.stderr, flush=True)

            with redirect_stdout(sys.stderr):
                run = run_captured_case(
                    args.case, args.bundle, args.output_root,
                    candidate_id=args.candidate,
                    progress_callback=progress,
                )
            record, _, _ = load_execution(run)
            output = {"runDirectory": str(run), **_summary(record), "report": record.get("report")}
            code = 0 if record.get("status") == "complete" else 2
        elif args.command == "score":
            result = _score(args.run, args.evaluator, args.wait_seconds, args.semantic_mode)
            output, code = _summary(result), 0 if result["status"] == "complete" else 2
        elif args.command == "calibrate":
            result = _calibrate(args.control, args.evaluator, args.output_root, args.semantic_mode)
            output, code = _summary(result), 0 if result["status"] == "complete" else 2
        elif args.command == "provision":
            output = _provision(args.model, args.semantic_mode)
        elif args.command == "compare":
            from compare_executions import compare_runs

            def load_score(path: Path) -> dict[str, Any]:
                return _load_score_receipt(path)

            output = compare_runs(
                args.baseline,
                args.candidate,
                args.baseline_attempt,
                args.candidate_attempt,
                load_score=load_score,
            )
            code = 0 if output.get("status") == "complete" else 2
        else:
            output = _show(args.run)
    except (OSError, ValueError, BotoCoreError, ClientError) as exc:
        output, code = {"status": "error", "reason": _error_message(exc)}, 2
    print(json.dumps(output, ensure_ascii=False, sort_keys=True))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
