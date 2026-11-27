"""Input binding and result handling for the public native Strands example.

The native example deliberately consumes the two files produced by the opening
walkthrough directly. No bridge or current AWS reads are needed: the case
provides the task and expected action, while the matching trace provides the
conversation up to the original final decision.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys
from typing import Any, Callable, Mapping, Sequence


class InputMismatch(ValueError):
    """The case or trace is not a single, matching native input."""


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise InputMismatch(f"{label} must be an object")
    return value


def _nonempty(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise InputMismatch(f"{label} must be a non-empty string")
    return value


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _read_json(path: Path, label: str) -> tuple[Any, str]:
    try:
        raw = path.read_bytes()
        value = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise InputMismatch(f"{label} is not valid UTF-8 JSON: {path}") from exc
    return value, _sha256(raw)


def _expected_recommendation(value: Any) -> dict[str, Any]:
    """Validate the reviewed expectation before attaching it to ``Case``."""

    expected = _mapping(value, "metadata.expected_recommendation")
    if expected.get("action") == "Other":
        if set(expected) != {"action", "target", "unit"} or expected != {
            "action": "Other", "target": None, "unit": None,
        }:
            raise InputMismatch("Other expectation must have only null target and unit")
        return dict(expected)
    if (
        set(expected) != {"action", "target", "value", "unit"}
        or expected.get("action") != "Restore inventory access"
        or expected.get("target") != "inventory"
        or expected.get("unit") != "version"
        or not isinstance(expected.get("value"), str)
        or not expected["value"].isascii()
        or not expected["value"].isdecimal()
        or expected["value"].startswith("0")
    ):
        raise InputMismatch(
            "expected_recommendation must be Restore inventory access with a canonical version"
        )
    return dict(expected)


def load_inputs(scenario_path: Path, trace_path: Path) -> dict[str, Any]:
    """Load and bind one downloaded scenario to its exact original trace."""

    scenario, scenario_sha256 = _read_json(scenario_path, "scenario")
    trace, trace_sha256 = _read_json(trace_path, "trace")
    scenario = _mapping(scenario, "scenario")
    turns = scenario.get("turns")
    if not isinstance(turns, list) or len(turns) != 1:
        raise InputMismatch("scenario must contain exactly one turn")
    turn = _mapping(turns[0], "scenario turn")
    case_input = _nonempty(turn.get("input"), "scenario turn input")
    scenario_id = _nonempty(scenario.get("scenario_id"), "scenario_id")
    metadata = _mapping(scenario.get("metadata"), "scenario metadata")
    expected = _expected_recommendation(metadata.get("expected_recommendation"))
    source = _mapping(metadata.get("source"), "scenario metadata.source")
    trace_id = _nonempty(source.get("trace_id"), "source trace_id")
    source_session_id = _nonempty(source.get("session_id"), "source session_id")
    if not isinstance(trace, list) or not trace:
        raise InputMismatch("trace must be a non-empty span list")
    spans = [_mapping(span, f"trace span {index}") for index, span in enumerate(trace)]
    if any(span.get("traceId") != trace_id for span in spans):
        raise InputMismatch("trace file contains a span from a different trace")
    return {
        "scenario": scenario,
        "trace": spans,
        "scenarioId": scenario_id,
        "scenarioSha256": scenario_sha256,
        "traceSha256": trace_sha256,
        "traceId": trace_id,
        "sourceSessionId": source_session_id,
        "expected": expected,
        "spanCount": len(spans),
    }


def prompt_digest(prompt_module: Any) -> str:
    prompt = getattr(prompt_module, "SYSTEM_PROMPT", None)
    digest = _sha256(prompt.encode("utf-8")) if isinstance(prompt, str) else ""
    if not digest or getattr(prompt_module, "PROMPT_SHA256", digest) != digest:
        raise InputMismatch("stage prompt.py digest is unavailable or inconsistent")
    return digest


def package_version(name: str) -> str:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return "unavailable"


def _safe_recommendation(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {"action": "<unavailable>", "target": None, "value": "<redacted>", "unit": None}
    if value.get("action") == "Other":
        safe_value: Any = "<explanation redacted>"
    else:
        raw = value.get("value")
        safe_value = raw if isinstance(raw, (str, int, float)) and not isinstance(raw, bool) else "<redacted>"
    return {
        "action": value.get("action") if isinstance(value.get("action"), str) else "<unavailable>",
        "target": value.get("target") if value.get("target") in {"checkout", "inventory"} else None,
        "value": safe_value,
        "unit": value.get("unit") if isinstance(value.get("unit"), str) else None,
    }


def write_result(
    path: Path,
    identity: Mapping[str, Any],
    actual: Mapping[str, Any],
    native_row: Any,
    prompt_sha256: str,
    status: str,
    *,
    exact_action: str,
    model_id: str,
    safe: bool = False,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    result: dict[str, Any] = {
        "status": status,
        "scenarioId": identity["scenarioId"],
        "scenarioSha256": identity["scenarioSha256"],
        "traceSha256": identity["traceSha256"],
        "traceId": identity["traceId"],
        "sourceSessionId": identity["sourceSessionId"],
        "sessionId": identity["sessionId"],
        "model": model_id,
        "promptSha256": prompt_sha256,
        "expected": _safe_recommendation(identity["expected"]) if safe else identity["expected"],
        "actual": _safe_recommendation(actual) if safe else actual,
        "exactAction": exact_action,
        "nativeEvaluator": {
            "name": "Equals",
            "score": native_row.score,
            "testPass": native_row.test_pass,
            "reason": native_row.reason,
        },
        "decision": {
            "startTimeUnixNano": identity["decisionStartTimeUnixNano"],
            "spanCount": identity["spanCount"],
            "signedBlocksOmitted": identity["signedBlocksOmitted"],
        },
    }
    if safe:
        result.pop("sessionId", None)
    path.write_text(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def write_incomplete(path: Path, *, reason: str, identity: Mapping[str, Any] | None = None) -> None:
    result: dict[str, Any] = {"status": "incomplete", "error": reason}
    if identity is not None:
        for key in (
            "scenarioId", "scenarioSha256", "traceSha256", "traceId", "sourceSessionId",
        ):
            if key in identity:
                result[key] = identity[key]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the opening denial decision through native Strands")
    parser.add_argument("--scenario", type=Path, default=Path("denial-case.json"))
    parser.add_argument("--trace", type=Path, default=Path("original-trace.json"))
    parser.add_argument("--result", type=Path, default=Path("strands-result.json"))
    parser.add_argument("--safe-output", action="store_true", help="print and write only release-safe verdict fields")
    return parser


def run_cli(
    run_experiment: Callable[..., Any],
    *,
    prompt_module: Any,
    investigation_module: Any,
    model_id: str,
    argv: Sequence[str] | None = None,
) -> int:
    args = _parser().parse_args(argv)
    digest = ""
    identity: Mapping[str, Any] | None = None
    try:
        digest = prompt_digest(prompt_module)
        identity, actual, native_row, exact_action = run_experiment(args.scenario, args.trace)
        status = "pass" if exact_action == "PASS" else "fail"
        if args.safe_output:
            print(f"Audience gate result: {status.upper()}", flush=True)
        else:
            print("Native example: strands_denial.py")
            print("Scenario:", identity["scenarioId"])
            print("Scenario SHA-256:", identity["scenarioSha256"])
            print("Source trace:", identity["traceId"], "Trace SHA-256:", identity["traceSha256"])
            print("Source session:", identity["sourceSessionId"])
            print("Model:", model_id, "Strands Agents:", package_version("strands-agents"), "Evaluations:", package_version("strands-agents-evals"))
            print("Prompt source:", Path(prompt_module.__file__).resolve())
            print("Investigation source:", Path(investigation_module.__file__).resolve())
            print("Prompt SHA-256:", digest)
            print("Signed reasoning blocks omitted:", identity["signedBlocksOmitted"])
            print("Expected:", json.dumps(identity["expected"], sort_keys=True))
            print("Actual:", json.dumps(actual, sort_keys=True))
            print("Native Equals:", "PASS" if native_row.test_pass else "FAIL")
            print("Exact action:", exact_action, flush=True)
        write_result(
            args.result, identity, actual, native_row, digest, status,
            exact_action=exact_action, model_id=model_id, safe=args.safe_output,
        )
        return 0 if status == "pass" else 1
    except (AttributeError, InputMismatch, OSError, RuntimeError, SystemExit, TypeError, ValueError, KeyError) as exc:
        message = str(exc) or type(exc).__name__
        print(
            "Audience gate result: INCOMPLETE" if args.safe_output else f"INCOMPLETE: {message}",
            file=None if args.safe_output else sys.stderr,
            flush=True,
        )
        try:
            write_incomplete(args.result, reason=message, identity=identity)
        except OSError:
            pass
        return 2
