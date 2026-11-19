#!/usr/bin/env python3
"""Presenter preflight and prompt-edit guard for the S2/S3 stage cue.

This helper has no run-specific identities. The canonical stage cue keeps the
reviewed case, execution, evaluator, and baseline checks. Here we only bind
one selected workspace to one durable pre-edit prompt and validate the
AWS/native-OTel environment needed by the requested action.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
from typing import Any, Mapping, Sequence


REGION = "us-east-1"
LOG_GROUP = "/aws/bedrock-agentcore/incident-triage-evaluation"
TRACE_ENDPOINT = "https://xray.us-east-1.amazonaws.com/v1/traces"

OTEL_ENV = {
    "AGENT_OBSERVABILITY_ENABLED": "true",
    "AWS_GENAI_CONTENT_EXTRACTION_OPT_OUT": "true",
    "OTEL_PYTHON_DISTRO": "aws_distro",
    "OTEL_PYTHON_CONFIGURATOR": "aws_configurator",
    "OTEL_RESOURCE_ATTRIBUTES": f"service.name=incident-triage-evaluation,aws.log.group.names={LOG_GROUP}",
    "OTEL_EXPORTER_OTLP_TRACES_HEADERS": f"x-aws-log-group={LOG_GROUP},x-aws-log-stream=spans",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
    "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL": "http/protobuf",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": TRACE_ENDPOINT,
    "OTEL_TRACES_EXPORTER": "otlp",
    "OTEL_METRICS_EXPORTER": "none",
    "OTEL_LOGS_EXPORTER": "none",
    "OTEL_TRACES_SAMPLER": "always_on",
}


class StageError(RuntimeError):
    """A presenter-correctable setup or guard error."""


def digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def canonical(path: Path, label: str) -> Path:
    if path.is_symlink():
        raise StageError(f"{label} must not be a symlink: {path}")
    try:
        return path.expanduser().resolve(strict=True)
    except OSError as exc:
        raise StageError(f"{label} is unavailable: {path}") from exc


def read_json(path: Path, label: str) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
        raise StageError(f"{label} is missing or empty: {path}")
    try:
        value = json.loads(path.read_bytes())
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise StageError(f"{label} is not valid JSON: {path}") from exc
    if not isinstance(value, dict):
        raise StageError(f"{label} must be a JSON object: {path}")
    return value


def run(command: Sequence[str], *, cwd: Path | None = None, env: Mapping[str, str] | None = None, label: str) -> str:
    try:
        result = subprocess.run(
            list(command), cwd=cwd, env=dict(env) if env is not None else None,
            capture_output=True, text=True, timeout=90, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise StageError(f"{label} failed to start or timed out") from exc
    if result.returncode:
        detail = (result.stderr or result.stdout).strip().splitlines()
        suffix = f": {detail[-1]}" if detail else ""
        raise StageError(f"{label} failed ({result.returncode}){suffix}")
    return result.stdout.strip()


def git(workspace: Path, *args: str, label: str) -> str:
    return run(("git", *args), cwd=workspace, label=label)


def prompt_digest(path: Path) -> tuple[str, str]:
    """Return the digest of resolved SYSTEM_PROMPT and of its source bytes."""

    if path.is_symlink() or not path.is_file():
        raise StageError(f"prompt source is unavailable: {path}")
    source = path.read_bytes()
    # Compile exactly-read bytes.  Loading through a file loader may reuse a
    # timestamp/size-valid .pyc after a same-length editor save.
    namespace: dict[str, Any] = {"__file__": str(path), "__name__": "_talk_prompt"}
    try:
        exec(compile(source, str(path), "exec"), namespace, namespace)
    except Exception as exc:
        raise StageError(f"prompt module cannot be resolved: {exc}") from exc
    value, declared = namespace.get("SYSTEM_PROMPT"), namespace.get("PROMPT_SHA256")
    if not isinstance(value, str) or not isinstance(declared, str):
        raise StageError("prompt module must define SYSTEM_PROMPT and PROMPT_SHA256")
    effective = digest(value.encode("utf-8"))
    if declared != effective:
        raise StageError("prompt module declared digest differs from resolved SYSTEM_PROMPT")
    return effective, digest(source)


def aws_environment(profile: str, account: str, region: str) -> dict[str, str]:
    environment = os.environ.copy()
    existing = environment.get("AWS_PROFILE")
    if existing and existing != profile:
        raise StageError(f"AWS_PROFILE is {existing!r}; selected profile is {profile!r}")
    # The native SDK must use the same named SSO profile checked by STS.
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN"):
        environment.pop(key, None)
    environment.update({
        "AWS_PROFILE": profile, "AWS_DEFAULT_PROFILE": profile,
        "AWS_REGION": region, "AWS_DEFAULT_REGION": region,
        "AWS_ACCOUNT_ID": account, "AWS_PAGER": "", "AWS_SDK_LOAD_CONFIG": "1",
    })
    return environment


def check_aws(aws: str, profile: str, account: str, region: str) -> dict[str, str]:
    if region != REGION:
        raise StageError(f"the talk evaluation is pinned to {REGION}, not {region}")
    environment = aws_environment(profile, account, region)
    raw = run((aws, "sts", "get-caller-identity", "--profile", profile, "--region", region, "--output", "json"), env=environment, label="AWS STS identity check")
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise StageError("AWS STS identity response is not JSON") from exc
    if not isinstance(value, dict) or value.get("Account") != account:
        observed = value.get("Account") if isinstance(value, dict) else None
        raise StageError(f"AWS account mismatch: expected {account}, observed {observed}")
    if not isinstance(value.get("Arn"), str) or not value["Arn"]:
        raise StageError("AWS STS identity has no ARN")
    return {"profile": profile, "region": region, "account": account, "arn": value["Arn"]}


def check_otel(uv: str, workspace: Path, profile: str, account: str, region: str) -> None:
    environment = aws_environment(profile, account, region)
    environment.update(OTEL_ENV)
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    environment["PYTHONPATH"] = str(workspace / "agent")
    code = "from captured_execution import _verify_exporter_setup; _verify_exporter_setup()"
    run((uv, "run", "--offline", "--project", "agent", "--locked", "opentelemetry-instrument", "python", "-c", code), cwd=workspace, env=environment, label="locked native OTEL setup check")


def identity(workspace: Path, repository: Path, stage: str) -> dict[str, str]:
    launcher = canonical(repository / "scripts" / "talk-session.py", "maintained launcher")
    workspace = canonical(workspace, "stage workspace")
    repository = canonical(repository, "maintained repository")
    if launcher.is_relative_to(workspace):
        raise StageError("maintained launcher must be outside the selected stage workspace")
    return {
        "stage": stage, "workspace": str(workspace), "repository": str(repository),
        "launcher": str(launcher), "head": git(workspace, "rev-parse", "HEAD", label="workspace HEAD"),
    }


def status(workspace: Path) -> list[str]:
    try:
        result = subprocess.run(
            ["git", "status", "--porcelain=v1", "--untracked-files=all"],
            cwd=workspace, capture_output=True, text=True, timeout=30, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise StageError("workspace status failed to start or timed out") from exc
    if result.returncode:
        raise StageError(f"workspace status failed ({result.returncode})")
    return [line for line in result.stdout.splitlines() if line]


def write_once(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, sort_keys=True, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
    except FileExistsError as exc:
        raise StageError(f"setup receipt already exists; inspect it instead of overwriting: {path}") from exc


def setup(args: argparse.Namespace) -> dict[str, Any]:
    workspace = canonical(Path(args.workspace), "stage workspace")
    repository = canonical(Path(args.repository), "maintained repository")
    output = Path(args.output).expanduser().resolve()
    info = identity(workspace, repository, args.stage)
    receipt_path = output / f"{args.stage.lower()}-setup.json"
    if receipt_path.exists():
        saved = read_json(receipt_path, "setup receipt")
        if any(saved.get(key) != info[key] for key in ("stage", "workspace", "repository", "launcher", "head")):
            raise StageError("setup receipt belongs to another workspace or source")
        previous_aws = saved.get("aws")
        if not isinstance(previous_aws, Mapping) or any(previous_aws.get(key) != expected for key, expected in (("profile", args.profile), ("account", args.account), ("region", args.region))):
            raise StageError("setup receipt belongs to another AWS identity")
        check_aws(args.aws, args.profile, args.account, args.region)
        return {"status": "already-ready", "receipt": str(receipt_path), **saved}
    changed = status(workspace)
    if any(entry[:2] != " M" or entry[3:] != "agent/prompt.py" for entry in changed):
        raise StageError("workspace setup allows only one unstaged agent/prompt.py edit")
    session_root = canonical(Path(args.session_root), "session root") if args.session_root else workspace.parent
    stage_status = run((sys.executable, info["launcher"], "status", "--directory", str(session_root), "--stage", args.stage), cwd=repository, label=f"maintained {args.stage} launcher")
    try:
        stage_record = json.loads(stage_status)
    except json.JSONDecodeError as exc:
        raise StageError("maintained stage launcher returned invalid status") from exc
    if (stage_record.get("stage"), stage_record.get("directory"), stage_record.get("currentCommit")) != (args.stage, str(workspace), info["head"]):
        raise StageError(f"selected workspace differs from the prepared {args.stage} stage")
    aws = check_aws(args.aws, args.profile, args.account, args.region)
    receipt: dict[str, Any] = {"schemaVersion": 1, "kind": "talk-stage-setup", **info, "aws": aws}
    if args.stage == "S3":
        baseline = canonical(Path(args.baseline), "selected S3 baseline")
        expected, baseline_source = prompt_digest(baseline / "source" / "agent" / "prompt.py")
        actual, actual_source = prompt_digest(workspace / "agent" / "prompt.py")
        if actual != expected:
            raise StageError("S3 workspace is not at the selected faulty pre-edit SYSTEM_PROMPT")
        check_otel(args.uv, workspace, args.profile, args.account, args.region)
        receipt["preEdit"] = {
            "baseline": str(baseline), "baselinePromptSourceSha256": baseline_source,
            "effectivePromptSha256": expected, "workspacePromptSourceSha256": actual_source,
        }
        receipt["nativeOtel"] = {"required": True, "checked": True, "environment": OTEL_ENV}
    else:
        receipt["nativeOtel"] = {"required": False, "checked": False, "reason": "archived execution score only"}
    write_once(receipt_path, receipt)
    return {"status": "ready", "receipt": str(receipt_path), **receipt}


def guard(args: argparse.Namespace) -> dict[str, Any]:
    workspace = canonical(Path(args.workspace), "stage workspace")
    repository = canonical(Path(args.repository), "maintained repository")
    info = identity(workspace, repository, "S3")
    receipt_path = Path(args.output).expanduser().resolve() / "s3-setup.json"
    saved = read_json(receipt_path, "S3 setup receipt")
    if any(saved.get(key) != info[key] for key in ("stage", "workspace", "repository", "launcher", "head")):
        raise StageError("S3 setup receipt belongs to another workspace or source")
    aws = saved.get("aws")
    if not isinstance(aws, Mapping) or any(aws.get(key) != expected for key, expected in (("profile", args.profile), ("account", args.account), ("region", args.region))):
        raise StageError("S3 setup receipt belongs to another AWS identity")
    pre_edit = saved.get("preEdit")
    if not isinstance(pre_edit, Mapping) or not isinstance(pre_edit.get("effectivePromptSha256"), str):
        raise StageError("S3 setup receipt has no durable pre-edit prompt identity")
    changed = status(workspace)
    for entry in changed:
        if entry[:2] != " M" or entry[3:] != "agent/prompt.py":
            raise StageError(f"S3 allows only one unstaged edit to agent/prompt.py; observed {entry!r}")
    actual, source = prompt_digest(workspace / "agent" / "prompt.py")
    if actual == pre_edit["effectivePromptSha256"]:
        raise StageError("S3 edit leaves SYSTEM_PROMPT unchanged; refusing inference")
    return {"status": "ready", "stage": "S3", "receipt": str(receipt_path), "effectivePromptSha256": actual, "sourcePromptSha256": source, "preEditEffectivePromptSha256": pre_edit["effectivePromptSha256"]}


def emit_env(args: argparse.Namespace) -> int:
    if args.region != REGION:
        raise StageError(f"the talk evaluation is pinned to {REGION}, not {args.region}")
    values = {
        "AWS_PROFILE": args.profile, "AWS_DEFAULT_PROFILE": args.profile,
        "AWS_REGION": args.region, "AWS_DEFAULT_REGION": args.region,
        "AWS_ACCOUNT_ID": args.account, "AWS_PAGER": "", "AWS_SDK_LOAD_CONFIG": "1",
    }
    if args.stage == "S3":
        values.update(OTEL_ENV)
    for key, value in values.items():
        print(f"export {key}={shlex.quote(value)}")
    return 0


def run_native(args: argparse.Namespace) -> int:
    command = list(args.native_command)
    if command and command[0] == "--":
        command.pop(0)
    if not command:
        raise StageError("run requires a native command after --")
    workspace = canonical(Path(args.workspace), "stage workspace")
    repository = canonical(Path(args.repository), "maintained repository")
    if args.stage == "S3":
        guard(args)
    else:
        info = identity(workspace, repository, "S2")
        saved = read_json(Path(args.output).expanduser().resolve() / "s2-setup.json", "S2 setup receipt")
        if any(saved.get(key) != info[key] for key in ("stage", "workspace", "repository", "launcher", "head")):
            raise StageError("S2 setup receipt belongs to another workspace or source")
        aws = saved.get("aws")
        if not isinstance(aws, Mapping) or any(aws.get(key) != expected for key, expected in (("profile", args.profile), ("account", args.account), ("region", args.region))):
            raise StageError("S2 setup receipt belongs to another AWS identity")
    check_aws(args.aws, args.profile, args.account, args.region)
    environment = aws_environment(args.profile, args.account, args.region)
    if args.stage == "S3":
        environment.update(OTEL_ENV)
    os.chdir(workspace)
    try:
        os.execvpe(command[0], command, environment)
    except OSError as exc:
        raise StageError(f"native command could not start: {command[0]}") from exc
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    sub = root.add_subparsers(dest="command", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--stage", choices=("S2", "S3"), required=True)
    common.add_argument("--repository", type=Path, required=True)
    common.add_argument("--workspace", type=Path, required=True)
    common.add_argument("--output", type=Path, required=True)
    common.add_argument("--profile", required=True)
    common.add_argument("--account", required=True)
    common.add_argument("--region", default=REGION)
    common.add_argument("--aws", default="aws")
    setup_parser = sub.add_parser("setup", parents=[common])
    setup_parser.add_argument("--inputs", type=Path)
    setup_parser.add_argument("--baseline", type=Path)
    setup_parser.add_argument("--session-root", type=Path)
    setup_parser.add_argument("--uv", default="uv")
    sub.add_parser("guard", parents=[common])
    env_parser = sub.add_parser("env")
    env_parser.add_argument("--stage", choices=("S2", "S3"), required=True)
    env_parser.add_argument("--profile", required=True)
    env_parser.add_argument("--account", required=True)
    env_parser.add_argument("--region", default=REGION)
    run_parser = sub.add_parser("run", parents=[common])
    run_parser.add_argument("native_command", nargs=argparse.REMAINDER)
    return root


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "setup":
            if args.stage == "S3" and args.baseline is None:
                raise StageError("S3 setup requires --baseline")
            result = setup(args)
            print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        elif args.command == "guard":
            print(json.dumps(guard(args), ensure_ascii=False, sort_keys=True))
        elif args.command == "run":
            return run_native(args)
        else:
            return emit_env(args)
    except StageError as exc:
        print(f"talk-stage: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
