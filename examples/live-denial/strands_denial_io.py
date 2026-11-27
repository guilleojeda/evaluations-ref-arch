"""Small CLI and authenticated-input boundary for the public Strands example."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys
from typing import Any, Callable, Mapping, Sequence

from reviewed_cases import load_frozen_case


class InputMismatch(ValueError):
    """The native scenario, frozen case, or evidence bundle is not one input."""


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise InputMismatch(f"{label} must be an object")
    return value


def _nonempty(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise InputMismatch(f"{label} must be a non-empty string")
    return value


def _reviewed_expectation(frozen: Mapping[str, Any]) -> dict[str, Any]:
    recommendations = frozen["case"]["expectations"]["admissibleRecommendations"]
    if not isinstance(recommendations, list) or len(recommendations) != 1:
        raise InputMismatch("frozen case must contain exactly one canonical recommendation")
    recommendation = _mapping(recommendations[0], "frozen recommendation")
    if recommendation.get("action") == "Other":
        if (recommendation.get("target") is not None or recommendation.get("unit") is not None
                or recommendation.get("value") != {"nonEmptyExplanation": True}):
            raise InputMismatch("frozen Other recommendation has an invalid shape")
        return {"action": "Other", "target": None, "unit": None}
    if recommendation.get("action") != "Restore inventory access":
        raise InputMismatch("this denial example accepts Restore inventory access or Other")
    return dict(recommendation)


def load_inputs(scenario_path: Path | None, case_path: Path, bundle_path: Path):
    """Load the frozen task and bind optional native provenance to it."""

    frozen = load_frozen_case(case_path, bundle_path)
    case_data, expected = frozen["case"], _reviewed_expectation(frozen)
    task, evidence = frozen["task"], case_data["evidence"]
    if case_data["task"] != task or evidence["bundleSha256"] != frozen["bundleSha256"]:
        raise InputMismatch("frozen task and evidence identities do not match")
    identity = {
        "nativeId": None,
        "nativeSession": None,
        "frozenId": _nonempty(case_data["caseId"], "frozen caseId"),
        "caseSha256": _nonempty(frozen["caseSha256"], "frozen caseSha256"),
        "traceId": _nonempty(evidence["traceRef"]["traceId"], "frozen traceId"),
        "bundleSha256": _nonempty(frozen["bundleSha256"], "frozen bundleSha256"),
        "originatingRunId": _nonempty(evidence["originatingRunId"], "originating run ID"),
        "expected": expected,
    }
    if evidence["traceRef"]["runId"] != identity["originatingRunId"]:
        raise InputMismatch("frozen trace reference is not bound to its originating run")

    if scenario_path is not None:
        try:
            scenario = json.loads(scenario_path.read_text(encoding="utf-8"))
            metadata = _mapping(scenario.get("metadata"), "native scenario.metadata")
            source = _mapping(metadata.get("source"), "native scenario.metadata.source")
            native = _mapping(metadata.get("expected_recommendation"), "native expectation")
        except (OSError, UnicodeError, json.JSONDecodeError, KeyError) as exc:
            raise InputMismatch(f"native scenario is invalid: {scenario_path}") from exc
        if native.get("action") == "Other":
            if (native.get("target") is not None or native.get("unit") is not None
                    or native.get("value") is not None):
                raise InputMismatch("native Other recommendation has an invalid shape")
            native = {"action": "Other", "target": None, "unit": None}
        scenario_id = _nonempty(scenario.get("scenario_id"), "native scenario_id")
        session_id = _nonempty(source.get("session_id"), "native source session_id")
        if native != expected or source.get("trace_id") != identity["traceId"]:
            raise InputMismatch("native scenario does not match the frozen case or trace")
        identity.update(nativeId=scenario_id, nativeSession=session_id)
    return frozen, identity


def prompt_digest(prompt_module: Any) -> str:
    prompt = getattr(prompt_module, "SYSTEM_PROMPT", None)
    digest = hashlib.sha256(prompt.encode("utf-8")).hexdigest() if isinstance(prompt, str) else ""
    if not digest or getattr(prompt_module, "PROMPT_SHA256", digest) != digest:
        raise InputMismatch("stage prompt.py digest is unavailable or inconsistent")
    return digest


def package_version(name: str) -> str:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return "unavailable"


def _safe_recommendation(value: Any) -> dict[str, Any]:
    allowed_actions = {
        "Increase reserved concurrency",
        "Increase memory",
        "Restore inventory access",
        "Other",
    }
    allowed_units = {"MB", "executions", "version"}
    if not isinstance(value, Mapping):
        return {"action": "<unavailable>", "target": None, "value": "<redacted>", "unit": None}
    raw = value.get("value")
    if value.get("action") == "Other":
        safe_value: Any = "<explanation redacted>"
    elif isinstance(raw, (int, float)) and not isinstance(raw, bool):
        safe_value = raw
    elif isinstance(raw, str) and raw.isascii() and raw.isdecimal():
        safe_value = raw
    else:
        safe_value = "<redacted>"
    return {
        "action": value.get("action") if value.get("action") in allowed_actions else "<unavailable>",
        "target": value.get("target") if value.get("target") in {"checkout", "inventory"} else None,
        "value": safe_value,
        "unit": value.get("unit") if value.get("unit") in allowed_units else None,
    }


def write_result(path: Path, identity: Mapping[str, Any], session_id: str, actual: Mapping[str, Any], row: Any, digest: str, status: str, *, safe: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    result: dict[str, Any] = {
        "status": status,
        "frozenCaseId": identity["frozenId"],
        "caseSha256": identity["caseSha256"],
        "bundleSha256": identity["bundleSha256"],
        "promptSha256": digest,
        "expected": _safe_recommendation(identity["expected"]) if safe else identity["expected"],
        "actual": _safe_recommendation(actual) if safe else actual,
        "exactAction": "PASS" if status == "pass" else "FAIL",
        "evaluator": {"name": "recommended-action", "finding": "action", "score": row.score, "testPass": row.test_pass},
    }
    if not safe:
        result.update({
            "nativeScenarioId": identity["nativeId"],
            "sourceSessionId": identity["nativeSession"],
            "traceId": identity["traceId"],
            "sessionId": session_id,
            "model": identity["model"],
        })
        result["evaluator"]["reason"] = row.reason
    path.write_text(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run one reviewed denial case through native Strands")
    parser.add_argument("--scenario", type=Path, default=None)
    parser.add_argument("--frozen-only", action="store_true", help="explicit CI mode using only the frozen case and bundle")
    parser.add_argument("--case", type=Path, default=Path("case.frozen.json"))
    parser.add_argument("--bundle", type=Path, default=Path("captured-bundle.json"))
    parser.add_argument("--result", type=Path, default=Path("strands-result.json"))
    parser.add_argument("--safe-output", action="store_true", help="write a release-safe receipt without trace, session, or prose")
    return parser


def run_cli(run_experiment: Callable[..., Any], *, prompt_module: Any, investigation_module: Any, model_id: str, argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    digest = ""
    try:
        digest = prompt_digest(prompt_module)
        if args.frozen_only:
            if args.scenario is not None:
                raise InputMismatch("--frozen-only cannot be combined with --scenario")
            scenario = None
        else:
            scenario = args.scenario or Path("denial-case.json")
            if not scenario.is_file():
                raise InputMismatch(f"native scenario is required: {scenario}")
        identity, session_id, actual, row = run_experiment(scenario, args.case, args.bundle)
        identity = {**identity, "model": model_id}
        status = "pass" if row.test_pass else "fail"
        if args.safe_output:
            print(f"Audience gate result: {status.upper()}", flush=True)
        else:
            print("Native example: strands_denial.py")
            print("Native scenario:", identity["nativeId"] or "not supplied (frozen-only mode)")
            print("Frozen case:", identity["frozenId"])
            print("Source trace:", identity["traceId"], "Source session:", identity["nativeSession"] or "not supplied")
            print("Fresh session:", session_id)
            print("Evidence bundle:", identity["bundleSha256"])
            print("Model:", model_id, "Strands Agents:", package_version("strands-agents"), "Evaluations:", package_version("strands-agents-evals"))
            print("Prompt source:", Path(prompt_module.__file__).resolve())
            print("Investigation source:", Path(investigation_module.__file__).resolve())
            print("Prompt:", digest)
            print("Expected:", json.dumps(identity["expected"], sort_keys=True))
            print("Actual:", json.dumps(actual, sort_keys=True))
            print("Exact action:", "PASS" if row.test_pass else "FAIL")
            print("Evaluator:", row.reason, flush=True)
        write_result(args.result, identity, session_id, actual, row, digest, status, safe=args.safe_output)
        return 0 if row.test_pass else 1
    except (InputMismatch, OSError, RuntimeError, SystemExit, TypeError, ValueError, KeyError) as exc:
        print("Audience gate result: INCOMPLETE" if args.safe_output else f"INCOMPLETE: {exc}", file=None if args.safe_output else sys.stderr, flush=True)
        try:
            args.result.write_text(json.dumps({"status": "incomplete"} if args.safe_output else {"status": "incomplete", "reason": str(exc)}) + "\n", encoding="utf-8")
        except OSError:
            pass
        return 2
