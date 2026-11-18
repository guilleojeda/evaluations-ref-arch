"""Run the native Strands development experiment for reviewed cases.

The module is intentionally a thin driver around the Phase 17 captured
executor, AgentCore scorer and offline comparator.  Strands owns task and
evaluator dispatch; this module owns immutable experiment snapshots and the
development-only policy view.
"""

from __future__ import annotations

import argparse
import importlib.util
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
from importlib.metadata import PackageNotFoundError, version as installed_version
import json
import os
from pathlib import Path, PureWindowsPath
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import uuid
import zipfile
from typing import Any, Mapping, Sequence

from strands_evals import Case, Experiment
from strands_evals.types.evaluation_report import EvaluationReport

import captured_execution
from captured_execution import load_execution, run_captured_case
from reviewed_cases import load_frozen_case


AGENT_DIRECTORY = Path(__file__).resolve().parent
MODEL_ID = captured_execution.MODEL_ID
TOOLING_FILES = (
    "development_experiment.py",
    "strands_evaluators.py",
    "evaluate_case.py",
    "agentcore_evaluation.py",
    "evaluation_telemetry.py",
    "deterministic_checks.py",
    "captured_execution.py",
    "evidence.py",
    "investigation.py",
    "captured_evidence.py",
    "reviewed_cases.py",
    "pyproject.toml",
    "uv.lock",
)
SOURCE_FILES = tuple(captured_execution.SOURCE_FILES)
DEPENDENCY_FILES = tuple(captured_execution.DEPENDENCY_FILES)
PACKAGE_SOURCE_FILES = frozenset(("main.py", "investigation.py", "evidence.py", "prompt.py"))
PACKAGE_REQUIRED_FILES = PACKAGE_SOURCE_FILES | frozenset(("agent-manifest.json", "pyproject.toml", "uv.lock"))
OBSERVABILITY_ENV = "AGENT_OBSERVABILITY_ENABLED"
FINDINGS = (
    "report_structure",
    "assessment",
    "action",
    "target",
    "target_value",
    "source_scope",
    "as_of_time",
    "operator_boundary",
)


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _digest(value: Any) -> str:
    return hashlib.sha256(_json_bytes(value)).hexdigest()


def _bytes_digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _named_digest(files: Mapping[str, bytes]) -> str:
    return _digest({name: _bytes_digest(raw) for name, raw in sorted(files.items())})


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _read_json(path: Path, label: str) -> Any:
    try:
        return json.loads(path.read_bytes(), parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
        raise ValueError(f"{label} is not valid UTF-8 JSON") from exc


def _write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False).encode("utf-8") + b"\n")
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _write_bytes(path: Path, raw: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _private_directory(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        raise ValueError("experiment output root must be a private directory")
    path.chmod(0o700)
    return path


def _zip_member_destination(root: Path, member: zipfile.ZipInfo) -> Path:
    """Return a safe extraction target for one Runtime ZIP member."""

    name = member.filename
    if not name or "\x00" in name:
        raise ValueError("Runtime ZIP contains an invalid member name")
    relative = Path(name)
    windows_relative = PureWindowsPath(name)
    if (
        relative.is_absolute()
        or windows_relative.is_absolute()
        or windows_relative.drive
        or "." in relative.parts
        or ".." in relative.parts
        or "." in windows_relative.parts
        or ".." in windows_relative.parts
    ):
        raise ValueError("Runtime ZIP contains an unsafe member path")
    target = root / relative
    try:
        target.resolve().relative_to(root.resolve())
    except ValueError as exc:
        raise ValueError("Runtime ZIP member escapes its extraction root") from exc
    mode = (member.external_attr >> 16) & 0o170000
    if mode == 0o120000:
        raise ValueError("Runtime ZIP symlinks are not accepted")
    return target


def _prompt_digest(path: Path) -> str:
    module_name = f"_phase20_package_prompt_{uuid.uuid4().hex}"
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise ValueError("packaged prompt cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
        value = module.SYSTEM_PROMPT
    except (AttributeError, OSError, TypeError, ValueError) as exc:
        raise ValueError("packaged prompt cannot be authenticated") from exc
    if not isinstance(value, str):
        raise ValueError("packaged prompt is not text")
    return _bytes_digest(value.encode("utf-8"))


@contextmanager
def _extract_runtime_package(runtime_zip: str | Path) -> Any:
    """Extract and authenticate one immutable Runtime ZIP for qualification."""

    archive_input = Path(runtime_zip)
    if archive_input.is_symlink():
        raise ValueError("Runtime ZIP symlinks are not accepted")
    archive_path = archive_input.resolve()
    if not archive_path.is_file():
        raise ValueError("Runtime ZIP is unavailable")
    try:
        archive_bytes = archive_path.read_bytes()
    except OSError as exc:
        raise ValueError("Runtime ZIP is unreadable") from exc
    archive_sha256 = _bytes_digest(archive_bytes)
    with tempfile.TemporaryDirectory(prefix="phase20-runtime-package-") as temporary_name:
        root = Path(temporary_name) / "runtime"
        root.mkdir(mode=0o700)
        try:
            archive = zipfile.ZipFile(archive_path)
        except (OSError, zipfile.BadZipFile) as exc:
            raise ValueError("Runtime ZIP is invalid") from exc
        with archive:
            seen: set[str] = set()
            for member in archive.infolist():
                target = _zip_member_destination(root, member)
                if member.filename in seen:
                    raise ValueError("Runtime ZIP contains duplicate members")
                seen.add(member.filename)
                if member.is_dir():
                    target.mkdir(parents=True, exist_ok=True, mode=0o700)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                raw = archive.read(member)
                target.write_bytes(raw)
                target.chmod(0o755 if ((member.external_attr >> 16) & 0o111) else 0o644)

        missing = sorted(name for name in PACKAGE_REQUIRED_FILES if not (root / name).is_file())
        if missing:
            raise ValueError("Runtime ZIP is missing required package files: " + ", ".join(missing))
        try:
            manifest = _read_json(root / "agent-manifest.json", "packaged agent manifest")
        except ValueError as exc:
            raise ValueError("packaged agent manifest is invalid") from exc
        if not isinstance(manifest, Mapping) or manifest.get("schemaVersion") != 2:
            raise ValueError("packaged agent manifest schema is unsupported")
        source_entries = manifest.get("runtimeSourceFiles")
        dependency_entries = manifest.get("dependencyFiles")
        expected_source = {name: _bytes_digest((root / name).read_bytes()) for name in PACKAGE_SOURCE_FILES}
        expected_dependency = {name: _bytes_digest((root / name).read_bytes()) for name in ("pyproject.toml", "uv.lock")}
        if source_entries != expected_source or dependency_entries != expected_dependency:
            raise ValueError("packaged source or dependency manifest does not match ZIP contents")
        source_sha256 = _named_digest({f"agent/{name}": (root / name).read_bytes() for name in PACKAGE_SOURCE_FILES})
        dependency_sha256 = _named_digest({f"agent/{name}": (root / name).read_bytes() for name in ("pyproject.toml", "uv.lock")})
        if manifest.get("runtimeSourceSha256") != source_sha256 or manifest.get("dependencySha256") != dependency_sha256:
            raise ValueError("packaged source or dependency identity is invalid")
        actual_prompt_sha256 = _prompt_digest(root / "prompt.py")
        if manifest.get("promptSha256") != actual_prompt_sha256:
            raise ValueError("packaged prompt digest does not match the ZIP source")
        package_origin = {
            "kind": "runtime_zip",
            "zipSha256": archive_sha256,
            "zipBytes": len(archive_bytes),
            "archivePath": str(archive_path),
            "manifestSha256": _bytes_digest((root / "agent-manifest.json").read_bytes()),
            "sourceRevision": manifest.get("sourceRevision"),
            "promptSha256": actual_prompt_sha256,
            "runtimeSourceSha256": source_sha256,
            "dependencySha256": dependency_sha256,
            "sourceFiles": expected_source,
            "dependencyFiles": expected_dependency,
        }
        module_names: set[str] = set()
        for path in root.iterdir():
            if path.is_dir() and path.name not in {"bin", "__pycache__"}:
                name = path.name
            elif path.is_file() and path.suffix in {".py", ".so", ".pyd"}:
                name = path.name.split(".", 1)[0]
            else:
                continue
            if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
                module_names.add(name)
        dependency_modules = tuple(sorted(module_names))
        yield root, package_origin, dependency_modules


def _copy_file(path: Path, destination: Path) -> bytes:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise ValueError(f"required experiment input is unavailable: {path}") from exc
    _write_bytes(destination, raw)
    return raw


def _source_bytes(directory: Path) -> tuple[dict[str, bytes], dict[str, bytes]]:
    source: dict[str, bytes] = {}
    dependencies: dict[str, bytes] = {}
    for name in SOURCE_FILES:
        path = directory / name
        try:
            source[f"agent/{name}"] = path.read_bytes()
        except OSError as exc:
            raise ValueError(f"selected candidate source is unavailable: {name}") from exc
    for name in DEPENDENCY_FILES:
        path = directory / name
        try:
            dependencies[f"agent/{name}"] = path.read_bytes()
        except OSError as exc:
            raise ValueError(f"selected candidate dependency is unavailable: {name}") from exc
    return source, dependencies


def _read_suite(suite_path: Path, selected_cases: Sequence[str] | None) -> list[dict[str, Any]]:
    suite = _read_json(suite_path, "suite")
    if not isinstance(suite, Mapping) or suite.get("schemaVersion") != 1 or not isinstance(suite.get("cases"), list):
        raise ValueError("suite must contain schemaVersion 1 and a cases list")
    if not suite["cases"]:
        raise ValueError("suite contains no cases")
    selected = list(selected_cases) if selected_cases is not None else None
    if selected is not None:
        if not selected or any(not isinstance(item, str) or not item.strip() for item in selected):
            raise ValueError("selected cases must be non-empty case IDs")
        if len(set(selected)) != len(selected):
            raise ValueError("selected cases contain duplicates")
        selected_set = set(selected)
    else:
        selected_set = None
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in suite["cases"]:
        if not isinstance(entry, Mapping) or not isinstance(entry.get("case"), str) or not isinstance(entry.get("bundle"), str):
            raise ValueError("suite case entries must contain case and bundle paths")
        case_path = (suite_path.parent / entry["case"]).resolve()
        bundle_path = (suite_path.parent / entry["bundle"]).resolve()
        loaded = load_frozen_case(case_path, bundle_path)
        case_id = loaded["case"]["caseId"]
        if case_id in seen:
            raise ValueError(f"duplicate case ID in suite: {case_id}")
        seen.add(case_id)
        if selected_set is None or case_id in selected_set:
            result.append({"caseId": case_id, "casePath": case_path, "bundlePath": bundle_path, "loaded": loaded})
    if selected_set is not None:
        unknown = selected_set - seen
        if unknown:
            raise ValueError(f"selected case is unknown: {sorted(unknown)!r}")
        if not result:
            raise ValueError("selected cases are empty")
    return result


def _safe_relative(root: Path, relative: str) -> Path:
    path = Path(relative)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError("snapshot contains an unsafe relative path")
    target = root / path
    if target.is_symlink() or not target.is_file():
        raise ValueError("snapshot file is unavailable or is a symlink")
    target.resolve().relative_to(root.resolve())
    return target


def _manifest_files(root: Path, manifest: Mapping[str, Any], key: str) -> dict[str, bytes]:
    entries = manifest.get(key)
    if not isinstance(entries, Mapping):
        raise ValueError("source snapshot manifest is missing")
    files: dict[str, bytes] = {}
    for name, digest in entries.items():
        if not isinstance(name, str) or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("source snapshot manifest is malformed")
        target = _safe_relative(root, name)
        raw = target.read_bytes()
        if _bytes_digest(raw) != digest:
            raise ValueError("source snapshot digest does not match its manifest")
        files[name] = raw
    return files


def _python_requirement_compatible(pyproject: bytes) -> None:
    try:
        import tomllib
        from packaging.specifiers import SpecifierSet
        document = tomllib.loads(pyproject.decode("utf-8"))
        requirement = document["project"]["requires-python"]
        specifier = SpecifierSet(requirement)
    except (KeyError, TypeError, UnicodeDecodeError, ValueError, ImportError) as exc:
        raise ValueError("selected source lock has an invalid Python requirement") from exc
    version = ".".join(str(item) for item in sys.version_info[:3])
    if not specifier.contains(version, prereleases=True):
        raise ValueError(f"selected source Python requirement excludes runtime {version}")


def _locked_runtime_compatible(dependencies: Mapping[str, bytes]) -> None:
    """Check the selected runtime lock against this installed interpreter."""

    try:
        from packaging.requirements import Requirement
        from packaging.markers import default_environment
    except ImportError as exc:
        raise ValueError("runtime compatibility checker is unavailable") from exc
    with tempfile.TemporaryDirectory(prefix="phase18-runtime-lock-") as temporary_name:
        temporary = Path(temporary_name)
        (temporary / "pyproject.toml").write_bytes(dependencies["agent/pyproject.toml"])
        (temporary / "uv.lock").write_bytes(dependencies["agent/uv.lock"])
        output = temporary / "requirements.txt"
        result = subprocess.run(
            ["uv", "export", "--locked", "--no-dev", "--offline", "--no-hashes", "--no-emit-project", "-o", str(output)],
            cwd=temporary,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            raise ValueError("selected locked runtime requirements cannot be exported offline")
        try:
            lines = output.read_text(encoding="utf-8").splitlines()
        except OSError as exc:
            raise ValueError("selected locked runtime requirements are unavailable") from exc
    environment = default_environment()
    for line in lines:
        text = line.strip()
        if not text or text.startswith("#") or text.startswith("--"):
            continue
        try:
            requirement = Requirement(text)
        except Exception as exc:
            raise ValueError("selected locked runtime requirements are malformed") from exc
        if requirement.marker is not None and not requirement.marker.evaluate(environment):
            continue
        try:
            actual = installed_version(requirement.name)
        except PackageNotFoundError as exc:
            raise ValueError(f"selected locked runtime package is not installed: {requirement.name}") from exc
        if requirement.specifier and not requirement.specifier.contains(actual, prereleases=True):
            raise ValueError(f"installed runtime package is incompatible: {requirement.name}=={actual}")


def _verify_prompt_snapshot(source: Mapping[str, bytes], identity: Mapping[str, Any]) -> None:
    """Bind the selected source's executable prompt to the retained identity."""

    manifest_raw = source.get("agent/agent-manifest.json")
    prompt_raw = source.get("agent/prompt.py")
    if manifest_raw is None or prompt_raw is None:
        raise ValueError("selected source prompt or manifest is missing")
    try:
        manifest = json.loads(manifest_raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("selected source agent manifest is malformed") from exc
    expected = manifest.get("promptSha256") if isinstance(manifest, Mapping) else None
    if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise ValueError("selected source prompt digest is missing")
    module_name = f"_phase18_prompt_{uuid.uuid4().hex}"
    prompt_path = Path(tempfile.mkdtemp(prefix="phase18-prompt-")) / "prompt.py"
    try:
        prompt_path.write_bytes(prompt_raw)
        spec = importlib.util.spec_from_file_location(module_name, prompt_path)
        if spec is None or spec.loader is None:
            raise ValueError("selected source prompt cannot be loaded")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        actual = hashlib.sha256(module.SYSTEM_PROMPT.encode("utf-8")).hexdigest()
    except (OSError, AttributeError, TypeError, ValueError) as exc:
        raise ValueError("selected source prompt cannot be authenticated") from exc
    finally:
        shutil.rmtree(prompt_path.parent, ignore_errors=True)
    if expected != actual or identity.get("promptSha256") != actual:
        raise ValueError("selected source prompt digest does not match its execution identity")


def _source_run_snapshot(source_run: Path) -> tuple[dict[str, bytes], dict[str, bytes], dict[str, Any]]:
    """Authenticate a complete or still-owned Phase17 execution snapshot."""

    if source_run.is_symlink() or not source_run.is_dir():
        raise ValueError("source run is unavailable")
    execution_path = source_run / "execution.json"
    record = _read_json(execution_path, "source execution")
    if not isinstance(record, Mapping):
        raise ValueError("source execution record is malformed")
    status = record.get("status")
    if status == "running" and not captured_execution.operation_lock_held(source_run / ".owner.lock"):
        # load_execution gives the same stale-running semantics for completed
        # records, but an ownerless running source is never an accepted source.
        raise ValueError("source run is no longer active")
    if status not in {"complete", "running"}:
        raise ValueError("source run is incomplete or interrupted")
    if status == "complete":
        load_execution(source_run)
    identity = record.get("identity")
    manifest = record.get("manifest")
    if not isinstance(identity, Mapping) or not isinstance(manifest, Mapping):
        raise ValueError("source run identity or manifest is missing")
    source_root = source_run / "source"
    source = _manifest_files(source_root, manifest, "sourceFiles")
    dependencies = _manifest_files(source_root, manifest, "dependencyFiles")
    expected_source = {f"agent/{name}" for name in SOURCE_FILES}
    expected_dependencies = {f"agent/{name}" for name in DEPENDENCY_FILES}
    if set(source) != expected_source or set(dependencies) != expected_dependencies:
        raise ValueError("source run does not contain the required source and lock files")
    source_digest = _named_digest(source)
    dependency_digest = _named_digest(dependencies)
    if identity.get("sourceSha256") != source_digest or manifest.get("sourceSha256") != source_digest:
        raise ValueError("source run source identity does not match its snapshot")
    if identity.get("dependencySha256") != dependency_digest or manifest.get("dependencySha256") != dependency_digest:
        raise ValueError("source run dependency identity does not match its snapshot")
    _python_requirement_compatible(dependencies["agent/pyproject.toml"])
    _locked_runtime_compatible(dependencies)
    _verify_prompt_snapshot(source, identity)
    return source, dependencies, {
        "runDirectory": str(source_run),
        "executionId": identity.get("executionId"),
        "sourceSha256": source_digest,
        "dependencySha256": dependency_digest,
        "promptSha256": identity.get("promptSha256"),
    }


@contextmanager
def _empty_otel_parent():
    """Detach Strands' native task span while candidate execution runs."""

    from opentelemetry import context as otel_context, trace

    token = otel_context.attach(trace.set_span_in_context(trace.INVALID_SPAN))
    try:
        yield
    finally:
        otel_context.detach(token)


@contextmanager
def _agent_observability_enabled():
    previous = os.environ.get(OBSERVABILITY_ENV)
    os.environ[OBSERVABILITY_ENV] = "true"
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop(OBSERVABILITY_ENV, None)
        else:
            os.environ[OBSERVABILITY_ENV] = previous


@contextmanager
def _blank_native_publisher():
    previous = os.environ.get(OBSERVABILITY_ENV)
    os.environ[OBSERVABILITY_ENV] = ""
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop(OBSERVABILITY_ENV, None)
        else:
            os.environ[OBSERVABILITY_ENV] = previous


def _ensure_tracer_provider() -> None:
    """Provide the same local SDK tracer boundary used by Phase17 tests."""

    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider

    if not isinstance(trace.get_tracer_provider(), TracerProvider):
        trace.set_tracer_provider(TracerProvider())


def _decision(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    for row in rows:
        deterministic = row.get("deterministic")
        findings = deterministic.get("findings") if isinstance(deterministic, Mapping) else None
        if isinstance(findings, Mapping):
            for name, finding in findings.items():
                if isinstance(finding, Mapping) and finding.get("status") == "complete" and finding.get("verdict") == "fail":
                    return {"verdict": "reject", "reason": f"deterministic check failed: {name}"}
    for row in rows:
        deterministic = row.get("deterministic")
        findings = deterministic.get("findings") if isinstance(deterministic, Mapping) else None
        if not isinstance(findings, Mapping) or set(findings) != set(FINDINGS):
            return {"verdict": "incomplete", "reason": "the named deterministic finding matrix is incomplete"}
        for name in FINDINGS:
            finding = findings.get(name)
            if not isinstance(finding, Mapping) or finding.get("status") != "complete" or finding.get("verdict") != "pass":
                return {"verdict": "incomplete", "reason": f"deterministic check is incomplete: {name}"}
        score = row.get("score")
        semantic = score.get("semantic") if isinstance(score, Mapping) else None
        semantic_finding = semantic.get("findings", {}).get("semantic_quality") if isinstance(semantic, Mapping) else None
        if (
            row.get("status") != "complete"
            or not isinstance(score, Mapping)
            or score.get("status") != "complete"
            or not isinstance(semantic_finding, Mapping)
            or semantic_finding.get("status") != "complete"
            or semantic_finding.get("verdict") not in {"pass", "fail"}
        ):
            return {"verdict": "incomplete", "reason": "required execution or scoring result is incomplete"}
    return {"verdict": "review_required", "reason": "deterministic checks and advisory results are complete; human review remains required"}


class _ExperimentState:
    def __init__(self, directory: Path, record: dict[str, Any]):
        self.directory = directory
        self.path = directory / "experiment.json"
        self.record = record
        self.lock = threading.Lock()

    def save(self) -> None:
        with self.lock:
            _write_json(self.path, self.record)

    def update_case(self, case_id: str, updates: Mapping[str, Any]) -> None:
        with self.lock:
            for row in self.record["cases"]:
                if row.get("caseId") == case_id:
                    row.update(dict(updates))
                    break
            _write_json(self.path, self.record)


class _ModelSessionAdapter:
    """Add the public boto session attributes BedrockModel reads."""

    region_name = "us-east-1"

    def __init__(self, session: Any):
        self._session = session

    def client(self, service_name: str, **kwargs: Any) -> Any:
        return self._session.client(service_name, **kwargs)


_FROZEN_MODULES = (
    "strands_evaluators",
    "evaluate_case",
    "agentcore_evaluation",
    "evaluation_telemetry",
    "deterministic_checks",
    "captured_execution",
    "reviewed_cases",
    "captured_evidence",
    "evidence",
    "investigation",
)
_FROZEN_LOAD_ORDER = (
    "evidence",
    "investigation",
    "captured_evidence",
    "reviewed_cases",
    "captured_execution",
    "evaluation_telemetry",
    "agentcore_evaluation",
    "deterministic_checks",
    "evaluate_case",
    "strands_evaluators",
)


def _load_module(path: Path, name: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ValueError(f"frozen tooling module cannot be loaded: {path.name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@contextmanager
def _frozen_tooling_scope(directory: Path):
    """Load the accepted tooling closure while retaining SDK/OTel identities."""

    saved = {name: sys.modules.get(name) for name in _FROZEN_MODULES}
    driver_name = f"_phase18_frozen_driver_{uuid.uuid4().hex}"
    try:
        for name in _FROZEN_MODULES:
            sys.modules.pop(name, None)
        tooling_root = directory / "tooling" / "agent"
        loaded: dict[str, Any] = {}
        for name in _FROZEN_LOAD_ORDER:
            loaded[name] = _load_module(tooling_root / f"{name}.py", name)
        driver = _load_module(tooling_root / "development_experiment.py", driver_name)
        yield driver
    finally:
        sys.modules.pop(driver_name, None)
        for name in reversed(_FROZEN_MODULES):
            sys.modules.pop(name, None)
            previous = saved[name]
            if previous is not None:
                sys.modules[name] = previous


def _snapshot_experiment(
    suite_path: Path,
    selected: Sequence[Mapping[str, Any]],
    evaluator_path: Path,
    output_root: Path,
    candidate_id: str,
    source_directory: Path | None,
    source_run: Path | None,
    runtime_origin: Mapping[str, Any] | None,
) -> tuple[_ExperimentState, Path, Path, Path, dict[str, Any]]:
    root = _private_directory(output_root)
    experiment_dir = root / str(uuid.uuid4())
    experiment_dir.mkdir(mode=0o700)
    experiment_dir.chmod(0o700)
    operation_lock = captured_execution.acquire_operation_lock(experiment_dir / ".owner.lock")
    try:
        source, dependencies = _source_bytes(source_directory or AGENT_DIRECTORY)
        source_origin: dict[str, Any] = {"kind": "workspace", "directory": str(source_directory or AGENT_DIRECTORY)}
        if runtime_origin is not None:
            source_origin = {
                "kind": runtime_origin.get("kind", "runtime_zip"),
                "zipSha256": runtime_origin.get("zipSha256"),
                "runtimeSourceSha256": runtime_origin.get("runtimeSourceSha256"),
                "dependencySha256": runtime_origin.get("dependencySha256"),
            }
        if source_run is not None:
            source, dependencies, source_origin = _source_run_snapshot(source_run)
        tooling: dict[str, bytes] = {}
        for name in TOOLING_FILES:
            tooling[f"agent/{name}"] = (AGENT_DIRECTORY / name).read_bytes()
        suite_raw = suite_path.read_bytes()
        evaluator_raw = evaluator_path.read_bytes()
        inputs_root = experiment_dir / "inputs"
        for item in selected:
            _copy_file(item["casePath"], inputs_root / "cases" / f"{item['caseId']}.frozen.json")
            _copy_file(item["bundlePath"], inputs_root / "bundles" / f"{item['loaded']['bundleSha256']}.json")
        _write_bytes(experiment_dir / "suite.json", suite_raw)
        _write_bytes(experiment_dir / "evaluator.json", evaluator_raw)
        for name, raw in source.items():
            _write_bytes(experiment_dir / "candidate" / "source" / name, raw)
        for name, raw in dependencies.items():
            _write_bytes(experiment_dir / "candidate" / "source" / name, raw)
        for name, raw in tooling.items():
            _write_bytes(experiment_dir / "tooling" / name, raw)
        source_sha = _named_digest(source)
        dependency_sha = _named_digest(dependencies)
        tooling_sha = _named_digest(tooling)
        tooling_dependencies = {
            name: raw for name, raw in tooling.items() if name in {"agent/pyproject.toml", "agent/uv.lock"}
        }
        tooling_dependency_sha = _named_digest(tooling_dependencies)
        case_set = {item["caseId"]: _bytes_digest(item["casePath"].read_bytes()) for item in selected}
        bundle_set = {item["caseId"]: _bytes_digest(item["bundlePath"].read_bytes()) for item in selected}
        record: dict[str, Any] = {
            "schemaVersion": 1,
            "experimentId": experiment_dir.name,
            "status": "running",
            "phase": "executing",
            "candidateId": candidate_id,
            "modelId": MODEL_ID,
            "startedAt": _now(),
            "suiteSha256": _bytes_digest(suite_raw),
            "evaluatorSha256": _bytes_digest(evaluator_raw),
            "sourceOrigin": source_origin,
            "sourceRun": source_origin if source_run is not None else None,
            "runtimeOrigin": dict(runtime_origin) if runtime_origin is not None else None,
            "runtime": {
                "sourceSha256": source_sha,
                "dependencySha256": dependency_sha,
            },
            "tooling": {
                "sourceSha256": tooling_sha,
                "dependencySha256": tooling_dependency_sha,
            },
            "snapshot": {
                "caseFiles": case_set,
                "bundleFiles": bundle_set,
                "caseSetSha256": _digest(case_set),
                "bundleSetSha256": _digest(bundle_set),
                "sourceFiles": {name: _bytes_digest(raw) for name, raw in sorted(source.items())},
                "dependencyFiles": {name: _bytes_digest(raw) for name, raw in sorted(dependencies.items())},
                "toolingFiles": {name: _bytes_digest(raw) for name, raw in sorted(tooling.items())},
                "sourceSha256": source_sha,
                "dependencySha256": dependency_sha,
                "toolingSha256": tooling_sha,
                "toolingDependencySha256": tooling_dependency_sha,
            },
            "cases": [
                {
                    "caseId": item["caseId"],
                    "caseSha256": item["loaded"]["caseSha256"],
                    "bundleSha256": item["loaded"]["bundleSha256"],
                    "status": "pending",
                }
                for item in selected
            ],
            "usage": {
                "agent": {"inputTokens": None, "outputTokens": None, "totalTokens": None},
                "semantic": {"inputTokens": None, "outputTokens": None, "totalTokens": None},
            },
        }
        state = _ExperimentState(experiment_dir, record)
        state.save()
        return state, experiment_dir / "candidate" / "source" / "agent", experiment_dir / "inputs", operation_lock, source_origin
    except BaseException:
        captured_execution.release_operation_lock(operation_lock)
        raise


def _render_row(directory: Path, row: Mapping[str, Any]) -> dict[str, Any]:
    result = dict(row)
    execution_id = result.get("executionId")
    if isinstance(execution_id, str):
        execution_dir = directory / "executions" / execution_id
        if execution_dir.is_dir():
            try:
                record, _case, _spans = load_execution(execution_dir)
                result.setdefault("report", record.get("report"))
                result.setdefault("execution", {key: record.get(key) for key in ("status", "identity", "deterministic", "usage")})
            except Exception as exc:
                result.setdefault("executionError", f"{type(exc).__name__}: {exc}")
    return result


def _authenticated_rows(directory: Path, record: Mapping[str, Any]) -> tuple[list[dict[str, Any]], list[str]]:
    errors: list[str] = []
    rows: list[dict[str, Any]] = []
    from compare_executions import _score_error
    from evaluate_case import _load_score_receipt
    def clear_untrusted(row: dict[str, Any]) -> None:
        for key in ("report", "deterministic", "score", "usage", "execution"):
            row.pop(key, None)
        row["status"] = "incomplete"
    for source_row in record.get("cases", []):
        if not isinstance(source_row, Mapping):
            continue
        row = dict(source_row)
        execution_id = row.get("executionId")
        if not isinstance(execution_id, str):
            if row.get("status") == "complete":
                errors.append(f"case {row.get('caseId')} execution identity is missing")
            clear_untrusted(row)
            rows.append(row)
            continue
        execution_path = directory / "executions" / execution_id
        try:
            execution, loaded_case, spans = load_execution(execution_path)
        except Exception as exc:
            errors.append(f"case {row.get('caseId')} execution is unavailable: {type(exc).__name__}")
            clear_untrusted(row)
            rows.append(row)
            continue
        identity = execution.get("identity") if isinstance(execution.get("identity"), Mapping) else {}
        if identity.get("executionId") != execution_id or identity.get("caseSha256") != row.get("caseSha256"):
            errors.append(f"case {row.get('caseId')} execution identity differs")
        snapshot = record.get("snapshot") if isinstance(record.get("snapshot"), Mapping) else {}
        experiment_origin = record.get("runtimeOrigin")
        execution_origin = identity.get("runtimeOrigin")
        if experiment_origin is not None:
            if not isinstance(experiment_origin, Mapping) or not isinstance(execution_origin, Mapping):
                errors.append(f"case {row.get('caseId')} package origin is missing")
            else:
                for origin_key in ("zipSha256", "manifestSha256", "runtimeSourceSha256", "dependencySha256"):
                    if execution_origin.get(origin_key) != experiment_origin.get(origin_key):
                        errors.append(f"case {row.get('caseId')} package origin differs")
                        break
                module_origins = execution_origin.get("moduleOrigins")
                if not isinstance(module_origins, Mapping):
                    errors.append(f"case {row.get('caseId')} package module origins are missing")
                else:
                    for module_name in ("investigation", "evidence", "prompt", "strands", "boto3"):
                        module_origin = module_origins.get(module_name)
                        if (
                            not isinstance(module_origin, Mapping)
                            or module_origin.get("kind") != "runtime_zip"
                            or module_origin.get("loaded") is not True
                        ):
                            errors.append(f"case {row.get('caseId')} package module origin is invalid: {module_name}")
        if (
            identity.get("sourceSha256") != snapshot.get("sourceSha256")
            or identity.get("dependencySha256") != snapshot.get("dependencySha256")
            or identity.get("bundleSha256") != row.get("bundleSha256")
        ):
            errors.append(f"case {row.get('caseId')} execution snapshot identity differs")
        row["report"] = execution.get("report")
        row["deterministic"] = execution.get("deterministic")
        row["usage"] = execution.get("usage")
        row["execution"] = {
            key: execution.get(key)
            for key in ("status", "identity", "deterministic", "usage", "runtimeOrigin")
        }
        score = None
        attempt_id = row.get("scoringAttemptId")
        if isinstance(attempt_id, str) and attempt_id:
            try:
                score = dict(_load_score_receipt(execution_path / "scores" / attempt_id / "result.json"))
                if score.get("scoringAttemptId") != attempt_id or score.get("executionId") != execution_id:
                    raise ValueError("selected score identity differs")
                binding_error = _score_binding_error(directory, record, score)
                if binding_error is not None:
                    raise ValueError(binding_error)
                if score.get("status") == "complete":
                    score_error = _score_error(score, identity, execution, loaded_case, spans)
                    if score_error is not None:
                        raise ValueError(score_error)
            except Exception as exc:
                errors.append(f"case {row.get('caseId')} score is unavailable: {type(exc).__name__}")
                score = None
                row["status"] = "incomplete"
        elif row.get("status") == "complete":
            errors.append(f"case {row.get('caseId')} selected scoring attempt is missing")
            row["status"] = "incomplete"
        row["score"] = score
        if execution.get("status") == "running" or (score is not None and score.get("status") == "pending"):
            row["status"] = "running"
        elif execution.get("status") != "complete":
            row["status"] = "incomplete"
        elif score is not None and score.get("status") == "complete":
            row["status"] = "complete"
        elif score is not None:
            row["status"] = "incomplete"
        elif row.get("status") != "incomplete":
            row["status"] = "running"
        rows.append(row)
    return rows, errors


def _score_binding_error(directory: Path, record: Mapping[str, Any], score: Mapping[str, Any]) -> str | None:
    try:
        descriptor = _read_json(directory / "evaluator.json", "frozen evaluator")
        evaluator = score.get("evaluator")
        if not isinstance(descriptor, Mapping) or not isinstance(evaluator, Mapping):
            return "score evaluator binding is missing"
        for key in ("evaluatorId", "evaluatorArn", "judgeModelId", "configSha256"):
            if descriptor.get(key) != evaluator.get(key):
                return "score evaluator binding differs from frozen evaluator"
        snapshot = record.get("snapshot")
        tooling_files = snapshot.get("toolingFiles") if isinstance(snapshot, Mapping) else None
        source = score.get("scoringSourceSha256")
        expected_names = ("deterministic_checks.py", "evaluation_telemetry.py", "agentcore_evaluation.py")
        if not isinstance(tooling_files, Mapping) or not isinstance(source, Mapping) or set(source) != set(expected_names):
            return "score source binding is missing"
        for name in expected_names:
            if source.get(name) != tooling_files.get(f"agent/{name}"):
                return "score source binding differs from frozen tooling"
    except (OSError, KeyError, TypeError, ValueError):
        return "score binding cannot be authenticated"
    return None


def _validate_experiment_read(
    directory: Path,
    record: Mapping[str, Any],
    *,
    require_report: bool,
) -> tuple[list[dict[str, Any]], list[str]]:
    errors: list[str] = []
    snapshot_error = _verify_snapshot(directory, record)
    if snapshot_error:
        errors.append(snapshot_error)
    rows, row_errors = _authenticated_rows(directory, record)
    errors.extend(row_errors)
    _report, report_error = _read_native_report(directory, record, strict=require_report, rows=rows)
    if report_error and (require_report or (directory / "native-report.json").is_file()):
        errors.append(report_error)
    return rows, errors


def _read_native_report(
    directory: Path,
    record: Mapping[str, Any],
    *,
    strict: bool = False,
    rows: Sequence[Mapping[str, Any]] | None = None,
) -> tuple[EvaluationReport | None, str | None]:
    path = directory / "native-report.json"
    if not path.is_file():
        return None, "native report is missing"
    try:
        if strict:
            retained = record.get("nativeReport")
            if not isinstance(retained, Mapping) or retained.get("sha256") != _bytes_digest(path.read_bytes()):
                return None, "native report digest does not match the experiment record"
        raw = _read_json(path, "native report")
        if not isinstance(raw, Mapping):
            return None, "native report is malformed"
        metadata = raw.get("metadata")
        if isinstance(metadata, Mapping) and metadata.get("experimentId") != record.get("experimentId"):
            return None, "native report identity is foreign"
        report = EvaluationReport.from_file(str(path))
        expected = len(record.get("cases", [])) * 2
        if len(report.cases) != expected or len(report.detailed_results) != expected:
            return None, "native report row roster is incomplete"
        seen: set[tuple[str, str]] = set()
        selected_rows = rows if rows is not None else record.get("cases", [])
        rows_by_case = {
            row.get("caseId"): row
            for row in selected_rows
            if isinstance(row, Mapping) and isinstance(row.get("caseId"), str)
        }
        for index, (case_row, outputs) in enumerate(zip(report.cases, report.detailed_results)):
            metadata = case_row.get("metadata") if isinstance(case_row, Mapping) else None
            case_id = metadata.get("caseId") if isinstance(metadata, Mapping) else None
            evaluator = case_row.get("evaluator") if isinstance(case_row, Mapping) else None
            evaluator_type = case_row.get("evaluator_type") if isinstance(case_row, Mapping) else None
            role = "deterministic" if evaluator == "deterministic" else "advisory" if evaluator == "advisory" else None
            if (
                not isinstance(metadata, Mapping)
                or metadata.get("experimentId") != record.get("experimentId")
                or not isinstance(case_id, str)
                or case_id not in rows_by_case
                or role is None
                or (case_row.get("name") if isinstance(case_row, Mapping) else None) != case_id
            ):
                return None, "native report case identity is foreign"
            key = (case_id, role)
            if key in seen:
                return None, "native report has duplicate case/evaluator rows"
            seen.add(key)
            row = rows_by_case[case_id]
            expected_evaluator_type = "DeterministicEvaluator" if role == "deterministic" else "AgentCoreAdvisory"
            if (
                evaluator_type != expected_evaluator_type
                or metadata.get("caseSha256") != row.get("caseSha256")
                or metadata.get("bundleSha256") != row.get("bundleSha256")
                or metadata.get("candidateId") != record.get("candidateId")
            ):
                return None, "native report case metadata differs"
            execution_id = row.get("executionId")
            execution = None
            if isinstance(execution_id, str):
                execution_path = directory / "executions" / execution_id
                try:
                    execution, _loaded_case, _spans = load_execution(execution_path)
                except Exception as exc:
                    return None, f"saved execution is unavailable: {type(exc).__name__}"
            if not isinstance(execution, Mapping):
                return None, "native report execution identity is missing"
            if not isinstance(outputs, list) or not outputs:
                return None, "native report detailed results are incomplete"
            expected_status = row.get("score", {}).get("status") if isinstance(row.get("score"), Mapping) else None
            expected_findings = row.get("deterministic", {}).get("findings") if isinstance(row.get("deterministic"), Mapping) else None
            if role == "deterministic":
                if len(outputs) != len(FINDINGS):
                    return None, "native report deterministic roster is incomplete"
                if not isinstance(expected_findings, Mapping) or set(expected_findings) != set(FINDINGS):
                    if row.get("status") == "complete":
                        return None, "native report deterministic roster is incomplete"
                    for output in outputs:
                        output_metadata = output.metadata if hasattr(output, "metadata") else None
                        if not isinstance(output_metadata, Mapping) or output_metadata.get("role") != role or output_metadata.get("caseId") != case_id:
                            return None, "native report incomplete deterministic identity is malformed"
                    continue
                output_checks: set[str] = set()
                for output in outputs:
                    output_metadata = output.metadata if hasattr(output, "metadata") else None
                    check_name = output_metadata.get("checkName") if isinstance(output_metadata, Mapping) else None
                    if not isinstance(output_metadata, Mapping) or output_metadata.get("role") != role or check_name not in FINDINGS:
                        return None, "native report deterministic identity is malformed"
                    if output_metadata.get("caseId") != case_id or output_metadata.get("experimentId") != record.get("experimentId"):
                        return None, "native report deterministic case identity differs"
                    identity = execution.get("identity") if isinstance(execution.get("identity"), Mapping) else {}
                    if any(output_metadata.get(field) != identity.get(field) for field in ("executionId", "sessionId", "traceId")):
                        return None, "native report deterministic execution identity differs"
                    finding = expected_findings.get(check_name)
                    if not isinstance(finding, Mapping) or output_metadata.get("status") != finding.get("status") or output_metadata.get("verdict") != finding.get("verdict"):
                        return None, "native report deterministic finding differs"
                    expected_score = 1.0 if finding.get("status") == "complete" and finding.get("verdict") == "pass" else 0.0
                    if output.score != expected_score or output.test_pass != (expected_score == 1.0):
                        return None, "native report deterministic numeric result differs"
                    if getattr(output, "label", None) != finding.get("verdict") or getattr(output, "reason", None) != finding.get("reason"):
                        return None, "native report deterministic output differs"
                    output_checks.add(check_name)
                if output_checks != set(FINDINGS):
                    return None, "native report deterministic check roster is incomplete"
            else:
                if len(outputs) != 1:
                    return None, "native report advisory roster is incomplete"
                output = outputs[0]
                output_metadata = output.metadata if hasattr(output, "metadata") else None
                if not isinstance(output_metadata, Mapping) or output_metadata.get("role") != role or output_metadata.get("caseId") != case_id:
                    return None, "native report advisory identity is malformed"
                if output_metadata.get("experimentId") != record.get("experimentId") or output_metadata.get("status") != expected_status:
                    return None, "native report advisory status identity differs"
                identity = execution.get("identity") if isinstance(execution.get("identity"), Mapping) else {}
                if any(output_metadata.get(field) != identity.get(field) for field in ("executionId", "sessionId", "traceId")):
                    return None, "native report advisory execution identity differs"
                if output.score != 0.0 or output_metadata.get("numericPlaceholder") is not True:
                    return None, "native report advisory numeric placeholder is invalid"
                if isinstance(row.get("scoringAttemptId"), str) and output_metadata.get("scoringAttemptId") != row.get("scoringAttemptId"):
                    return None, "native report advisory scoring attempt differs"
                if expected_status == "complete" and (
                    not isinstance(row.get("scoringAttemptId"), str)
                    or output_metadata.get("scoringAttemptId") != row.get("scoringAttemptId")
                ):
                    return None, "native report completed advisory attempt is missing"
                semantic = row.get("score", {}).get("semantic") if isinstance(row.get("score"), Mapping) else None
                finding = semantic.get("findings", {}).get("semantic_quality") if isinstance(semantic, Mapping) else None
                if expected_status == "complete":
                    if (
                        not isinstance(finding, Mapping)
                        or output.label != finding.get("verdict")
                        or output.reason != finding.get("explanation")
                        or output_metadata.get("verdict") != finding.get("verdict")
                    ):
                        return None, "native report advisory verdict differs"
                elif output.label is not None:
                    return None, "native report incomplete advisory has a verdict"
            if report.scores[index] != sum(output.score for output in outputs) / len(outputs):
                return None, "native report aggregate score differs"
            if report.test_passes[index] != all(output.test_pass for output in outputs):
                return None, "native report aggregate pass differs"
            for output in outputs:
                output_metadata = output.metadata if hasattr(output, "metadata") else None
                if not isinstance(output_metadata, Mapping) or output_metadata.get("experimentId") != record.get("experimentId"):
                    return None, "native report output identity is foreign"
                if getattr(output, "score", None) not in {0.0, 1.0}:
                    return None, "native report output score is tampered"
        if seen != {(case_id, role) for case_id in rows_by_case for role in ("deterministic", "advisory") }:
            return None, "native report case/evaluator roster is incomplete"
        return report, None
    except Exception as exc:
        return None, f"native report is unavailable: {type(exc).__name__}"


def run_experiment(
    suite_path: str | Path,
    output_root: str | Path,
    *,
    candidate_id: str,
    evaluator_path: str | Path,
    wait_seconds: int = 300,
    selected_cases: Sequence[str] | None = None,
    source_run: str | Path | None = None,
    model_session: Any = None,
    source_directory: str | Path | None = None,
    _dependency_root: str | Path | None = None,
    _dependency_modules: Sequence[str] = (),
    _runtime_origin: Mapping[str, Any] | None = None,
    _snapshot_bundle: Mapping[str, Any] | None = None,
) -> Path:
    if candidate_id not in captured_execution.VALID_CANDIDATE_IDS:
        raise ValueError(f"unsupported candidate ID: {candidate_id!r}")
    if type(wait_seconds) is not int or not 0 <= wait_seconds <= 600:
        raise ValueError("wait_seconds must be between 0 and 600")
    suite = Path(suite_path).resolve()
    evaluator = Path(evaluator_path).resolve()
    if _snapshot_bundle is None:
        selected = _read_suite(suite, selected_cases)
        # Read and validate the evaluator before any model/client construction.
        evaluator_raw = evaluator.read_bytes()
        evaluator_descriptor = _read_json(evaluator, "evaluator descriptor")
        required_evaluator_fields = ("evaluatorId", "evaluatorArn", "judgeModelId", "configSha256")
        if (
            not isinstance(evaluator_descriptor, Mapping)
            or not all(
                isinstance(evaluator_descriptor.get(key), str)
                and evaluator_descriptor[key].strip()
                for key in required_evaluator_fields
            )
            or evaluator_descriptor.get("evaluatorMode") != "single"
            or evaluator_descriptor.get("judgeModelId") != MODEL_ID
        ):
            raise ValueError("evaluator descriptor must pin the single-mode Sonnet 4.6 evaluator")
        source_run_path = Path(source_run).resolve() if source_run is not None else None
        source_directory_path = Path(source_directory).resolve() if source_directory is not None else None
        state, candidate_source, inputs_root, operation_lock, source_origin = _snapshot_experiment(
            suite,
            selected,
            evaluator,
            Path(output_root),
            candidate_id,
            source_directory_path,
            source_run_path,
            _runtime_origin,
        )
        del evaluator_raw
    else:
        state = _ExperimentState(Path(_snapshot_bundle["directory"]), dict(_snapshot_bundle["record"]))
        candidate_source = Path(_snapshot_bundle["candidateSource"])
        inputs_root = Path(_snapshot_bundle["inputsRoot"])
        operation_lock = None
        source_origin = _snapshot_bundle.get("sourceOrigin")
        _dependency_root = _snapshot_bundle.get("dependencyRoot")
        _dependency_modules = tuple(_snapshot_bundle.get("dependencyModules") or ())
        _runtime_origin = _snapshot_bundle.get("runtimeOrigin")
        selected = list(_snapshot_bundle["selected"])

    if _snapshot_bundle is None:
        bundle = {
            "directory": str(state.directory),
            "record": json.loads(json.dumps(state.record, ensure_ascii=False, allow_nan=False)),
            "candidateSource": str(candidate_source),
            "inputsRoot": str(inputs_root),
            "sourceOrigin": source_origin,
            "dependencyRoot": str(Path(_dependency_root).resolve()) if _dependency_root is not None else None,
            "dependencyModules": list(_dependency_modules),
            "runtimeOrigin": dict(_runtime_origin) if _runtime_origin is not None else None,
            "selected": [
                {"caseId": item["caseId"], "loaded": item["loaded"]}
                for item in selected
            ],
        }
        try:
            with _frozen_tooling_scope(state.directory) as frozen_driver:
                return frozen_driver.run_experiment(
                    suite,
                    state.directory.parent,
                    candidate_id=candidate_id,
                    evaluator_path=state.directory / "evaluator.json",
                    wait_seconds=wait_seconds,
                    selected_cases=None,
                    source_run=None,
                    model_session=model_session,
                    source_directory=candidate_source,
                    _dependency_root=_dependency_root,
                    _dependency_modules=_dependency_modules,
                    _runtime_origin=_runtime_origin,
                    _snapshot_bundle=bundle,
                )
        finally:
            captured_execution.release_operation_lock(operation_lock)

    items_by_id = {item["caseId"]: item for item in selected}
    # These imports intentionally resolve inside the scoped frozen tooling
    # module set.  The bootstrap never executes mutable workspace adapters.
    from captured_execution import load_execution as frozen_load_execution
    from captured_execution import run_captured_case as frozen_run_captured_case
    from evaluate_case import _score as frozen_score
    from strands_evaluators import AgentCoreAdvisory, DeterministicEvaluator

    row_lock = state.lock
    runner_session = _ModelSessionAdapter(model_session) if model_session is not None else None

    def update_score(case_id: str, result: Mapping[str, Any]) -> None:
        with row_lock:
            for row in state.record["cases"]:
                if row.get("caseId") == case_id:
                    attempt = result.get("scoringAttemptId")
                    selected = row.get("scoringAttemptId")
                    if (
                        isinstance(attempt, str)
                        and isinstance(selected, str)
                        and selected != attempt
                    ):
                        # An explicit later rejudge must never replace the
                        # attempt selected by this experiment.
                        row["status"] = "incomplete"
                        _write_json(state.path, state.record)
                        return
                    row["score"] = dict(result)
                    row["numericPlaceholder"] = True
                    if isinstance(attempt, str) and attempt:
                        if not isinstance(selected, str):
                            row["scoringAttemptId"] = attempt
                    if result.get("status") == "complete":
                        row["status"] = "complete"
                    elif row.get("status") != "complete":
                        row["status"] = "incomplete"
                    break
            _write_json(state.path, state.record)

    def update_pending_score(case_id: str, pending: Mapping[str, Any]) -> None:
        attempt = pending.get("scoringAttemptId")
        if not isinstance(attempt, str) or not attempt:
            raise ValueError("semantic scoring attempt identity is missing")
        with row_lock:
            for row in state.record["cases"]:
                if row.get("caseId") == case_id:
                    selected = row.get("scoringAttemptId")
                    if isinstance(selected, str) and selected != attempt:
                        raise ValueError("semantic scoring attempt was already selected")
                    row["scoringAttemptId"] = attempt
                    row["status"] = "running"
                    _write_json(state.path, state.record)
                    return
        raise ValueError(f"selected case is unavailable: {case_id}")

    def update_deterministic(case_id: str, findings: Mapping[str, Any]) -> None:
        state.update_case(case_id, {"deterministic": {"findings": dict(findings)}})

    cases: list[Case[Any, Any]] = []
    for item in selected:
        cases.append(
            Case(
                name=item["caseId"],
                input=item["loaded"]["task"],
                metadata={
                    "experimentId": state.record["experimentId"],
                    "caseId": item["caseId"],
                    "caseSha256": item["loaded"]["caseSha256"],
                    "bundleSha256": item["loaded"]["bundleSha256"],
                    "candidateId": candidate_id,
                },
            )
        )

    native_experiment = Experiment(
        cases=cases,
        evaluators=[
            DeterministicEvaluator(on_result=update_deterministic),
            AgentCoreAdvisory(
                evaluator,
                wait_seconds=wait_seconds,
                on_result=update_score,
                on_pending=update_pending_score,
                score_fn=frozen_score,
            ),
        ],
    )

    def task(native_case: Case[Any, Any]) -> dict[str, Any]:
        case_id = native_case.name or ""
        item = items_by_id[case_id]
        case_path = inputs_root / "cases" / f"{case_id}.frozen.json"
        bundle_path = inputs_root / "bundles" / f"{item['loaded']['bundleSha256']}.json"
        state.update_case(case_id, {"status": "running"})

        def execution_started(_run_dir: Path, execution_record: Mapping[str, Any]) -> None:
            identity = execution_record.get("identity")
            if not isinstance(identity, Mapping):
                raise ValueError("captured execution identity is missing")
            state.update_case(
                case_id,
                {
                    "executionId": identity.get("executionId"),
                    "promptSha256": identity.get("promptSha256"),
                    "sessionId": identity.get("sessionId"),
                    "traceId": identity.get("traceId"),
                    "status": "running",
                },
            )

        try:
            with _agent_observability_enabled():
                with _empty_otel_parent():
                    run_dir = frozen_run_captured_case(
                        case_path,
                        bundle_path,
                        state.directory / "executions",
                        model_session=runner_session,
                        candidate_id=candidate_id,
                        source_directory=candidate_source,
                        dependency_root=_dependency_root,
                        dependency_modules=_dependency_modules,
                        runtime_origin=_runtime_origin,
                        trusted_runner=True,
                        progress_callback=execution_started,
                    )
            execution, _loaded_case, _spans = frozen_load_execution(run_dir)
        except Exception as exc:
            state.update_case(case_id, {"status": "error", "error": f"{type(exc).__name__}: {exc}"})
            return {"output": {"status": "error", "reason": str(exc)}}

        identity = execution.get("identity") if isinstance(execution.get("identity"), Mapping) else {}
        updates: dict[str, Any] = {
            "executionId": identity.get("executionId"),
            "promptSha256": identity.get("promptSha256"),
            "sessionId": identity.get("sessionId"),
            "traceId": identity.get("traceId"),
            # Keep the case visibly active until both native evaluators have
            # finished.  This matters when show inspects a process blocked in
            # the semantic judge after candidate execution already completed.
            "status": "running" if execution.get("status") == "complete" else "incomplete",
        }
        if execution.get("status") == "complete":
            updates.update(
                {
                    "report": execution.get("report"),
                    "deterministic": execution.get("deterministic"),
                    "usage": execution.get("usage"),
                }
            )
            state.update_case(case_id, updates)
        else:
            updates["failure"] = execution.get("failure")
            state.update_case(case_id, updates)
        return {
            "output": {
                "executionDirectory": str(run_dir),
                "status": execution.get("status"),
                "execution": execution,
                "report": execution.get("report"),
            }
        }

    try:
        _ensure_tracer_provider()
        with _blank_native_publisher():
            report = native_experiment.run_evaluations(task)
        report_path = state.directory / "native-report.json"
        report.to_file(str(report_path))
        reopened, report_error = _read_native_report(state.directory, state.record)
        if reopened is None:
            raise ValueError(report_error or "native report could not be reopened")
        state.record["nativeReport"] = {
            "path": "native-report.json",
            "sha256": _bytes_digest(report_path.read_bytes()),
            "caseCount": len(reopened.cases),
        }
        state.record["status"] = "complete"
        state.record["phase"] = "finished"
        state.record["finishedAt"] = _now()
        state.record["decision"] = _decision(state.record["cases"])
        # Aggregate known usage once per execution. A missing field in any
        # selected score keeps that aggregate field explicitly unknown.
        agent_values = [row.get("usage", {}) for row in state.record["cases"]]
        aggregate: dict[str, int | None] = {}
        for key in ("inputTokens", "outputTokens", "totalTokens"):
            values = [item.get(key) for item in agent_values if isinstance(item, Mapping) and type(item.get(key)) is int]
            aggregate[key] = sum(values) if len(values) == len(agent_values) and values else None
        semantic_values = []
        for row in state.record["cases"]:
            score = row.get("score")
            semantic = score.get("semantic") if isinstance(score, Mapping) else None
            usage = semantic.get("tokenUsage") if isinstance(semantic, Mapping) else None
            semantic_values.append(usage if isinstance(usage, Mapping) else {})
        semantic_aggregate: dict[str, int | None] = {}
        for key in ("inputTokens", "outputTokens", "totalTokens"):
            values = [item.get(key) for item in semantic_values if type(item.get(key)) is int]
            semantic_aggregate[key] = sum(values) if len(values) == len(semantic_values) and values else None
        state.record["usage"] = {
            "agent": aggregate,
            "semantic": semantic_aggregate,
        }
        state.save()
        return state.directory
    except BaseException:
        # The native SDK or a process owner can leave a useful running record.
        # Preserve all completed rows and let show classify an ownerless record.
        raise
    finally:
        captured_execution.release_operation_lock(operation_lock)


def _assemble_package_candidate(package_root: Path, destination: Path) -> Path:
    """Combine ZIP serving code with the trusted offline support closure."""

    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    for name in SOURCE_FILES:
        source = package_root / name if name in PACKAGE_SOURCE_FILES or name == "agent-manifest.json" else AGENT_DIRECTORY / name
        if source.is_symlink() or not source.is_file():
            raise ValueError(f"package experiment source is unavailable: {name}")
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        _write_bytes(target, source.read_bytes())
    for name in DEPENDENCY_FILES:
        source = package_root / name
        if source.is_symlink() or not source.is_file():
            raise ValueError(f"package experiment dependency is unavailable: {name}")
        _write_bytes(destination / name, source.read_bytes())
    return destination


def run_package_experiment(
    *,
    runtime_zip: str | Path,
    suite_path: str | Path,
    evaluator_path: str | Path,
    output_root: str | Path,
    model_session: Any = None,
    wait_seconds: int = 300,
    candidate_id: str = "repaired",
    selected_cases: Sequence[str] | None = None,
) -> Path:
    """Run the S4 experiment using only one authenticated Runtime ZIP.

    The package supplies serving modules and all runtime distributions.  The
    checkout contributes only the trusted captured-provider/evaluator support
    closure and is recorded separately by the experiment snapshot.  The
    returned directory has the same ``experiment.json`` and ``show_experiment``
    contract as :func:`run_experiment`.
    """

    if candidate_id not in captured_execution.VALID_CANDIDATE_IDS:
        raise ValueError(f"unsupported candidate ID: {candidate_id!r}")
    with _extract_runtime_package(runtime_zip) as (package_root, package_origin, dependency_modules):
        with tempfile.TemporaryDirectory(prefix="phase20-package-candidate-") as candidate_name:
            candidate_source = _assemble_package_candidate(package_root, Path(candidate_name) / "agent")
            driver_files: dict[str, bytes] = {}
            for name in TOOLING_FILES:
                path = AGENT_DIRECTORY / name
                if path.is_file():
                    driver_files[f"agent/{name}"] = path.read_bytes()
            package_origin = {
                **package_origin,
                "driver": {
                    "kind": "trusted_tooling_workspace",
                    "directory": str(AGENT_DIRECTORY),
                    "toolingSha256": _named_digest(driver_files),
                },
            }
            return run_experiment(
                suite_path=suite_path,
                output_root=output_root,
                candidate_id=candidate_id,
                evaluator_path=evaluator_path,
                wait_seconds=wait_seconds,
                selected_cases=selected_cases,
                model_session=model_session,
                source_directory=candidate_source,
                _dependency_root=package_root,
                _dependency_modules=dependency_modules,
                _runtime_origin=package_origin,
            )


def show_experiment(directory: str | Path) -> dict[str, Any]:
    path = Path(directory)
    record = _read_json(path / "experiment.json", "experiment record")
    if not isinstance(record, Mapping):
        raise ValueError("experiment record must be an object")
    rendered_rows, read_errors = _validate_experiment_read(path, record, require_report=record.get("status") == "complete")
    output = dict(record)
    output["cases"] = rendered_rows
    stale = output.get("status") == "running" and not captured_execution.operation_lock_held(path / ".owner.lock")
    if stale:
        output["status"] = "interrupted"
    if read_errors and output.get("status") == "complete":
        output["status"] = "incomplete"
    decision = _decision(rendered_rows)
    if read_errors and decision.get("verdict") != "reject":
        decision = {"verdict": "incomplete", "reason": "authenticated experiment evidence is incomplete"}
    output["decision"] = decision
    if read_errors:
        output["readErrors"] = read_errors
    return output


def _verify_snapshot(path: Path, record: Mapping[str, Any]) -> str | None:
    snapshot = record.get("snapshot")
    if not isinstance(snapshot, Mapping):
        return "experiment snapshot metadata is missing"
    runtime_origin = record.get("runtimeOrigin")
    if runtime_origin is not None:
        if not isinstance(runtime_origin, Mapping) or runtime_origin.get("kind") != "runtime_zip":
            return "experiment Runtime package origin is malformed"
        for key in ("zipSha256", "manifestSha256", "runtimeSourceSha256", "dependencySha256"):
            if not isinstance(runtime_origin.get(key), str) or re.fullmatch(r"[0-9a-f]{64}", runtime_origin[key]) is None:
                return "experiment Runtime package origin identity is malformed"
        if runtime_origin.get("dependencySha256") != snapshot.get("dependencySha256"):
            return "experiment Runtime package dependency identity differs"
    for directory_key, files_key, digest_key, relative in (
        ("tooling", "toolingFiles", "toolingSha256", "tooling"),
        ("candidate", "sourceFiles", "sourceSha256", "candidate/source"),
    ):
        entries = snapshot.get(files_key)
        if not isinstance(entries, Mapping):
            return f"experiment {directory_key} snapshot manifest is missing"
        root = path / relative
        actual: dict[str, bytes] = {}
        for name, expected in entries.items():
            try:
                raw = _safe_relative(root, str(name)).read_bytes()
            except Exception:
                return f"experiment {directory_key} snapshot is unavailable"
            if _bytes_digest(raw) != expected:
                return f"experiment {directory_key} snapshot digest differs"
            actual[str(name)] = raw
        if snapshot.get(digest_key) != _named_digest(actual):
            return f"experiment {directory_key} snapshot identity differs"
        if directory_key == "tooling":
            tooling_dependencies = {
                name: raw for name, raw in actual.items() if name in {"agent/pyproject.toml", "agent/uv.lock"}
            }
            if snapshot.get("toolingDependencySha256") != _named_digest(tooling_dependencies):
                return "experiment tooling dependency identity differs"
            tooling_record = record.get("tooling")
            if (
                not isinstance(tooling_record, Mapping)
                or tooling_record.get("sourceSha256") != snapshot.get("toolingSha256")
                or tooling_record.get("dependencySha256") != snapshot.get("toolingDependencySha256")
            ):
                return "experiment tooling identity differs"
        elif (
            not isinstance(record.get("runtime"), Mapping)
            or record["runtime"].get("sourceSha256") != snapshot.get("sourceSha256")
            or record["runtime"].get("dependencySha256") != snapshot.get("dependencySha256")
        ):
            return "experiment runtime identity differs"
    for key, relative in (("suiteSha256", "suite.json"), ("evaluatorSha256", "evaluator.json")):
        try:
            if _bytes_digest((path / relative).read_bytes()) != record.get(key):
                return f"experiment {relative} digest differs"
        except OSError:
            return f"experiment {relative} is unavailable"
    for entries_key, digest_key in (("sourceFiles", "sourceSha256"), ("dependencyFiles", "dependencySha256")):
        entries = snapshot.get(entries_key)
        if not isinstance(entries, Mapping):
            return f"experiment runtime {entries_key} manifest is missing"
        actual: dict[str, bytes] = {}
        for name, expected in entries.items():
            try:
                raw = _safe_relative(path / "candidate" / "source", str(name)).read_bytes()
            except Exception:
                return f"experiment runtime {entries_key} snapshot is unavailable"
            if _bytes_digest(raw) != expected:
                return f"experiment runtime {entries_key} snapshot digest differs"
            actual[str(name)] = raw
        if snapshot.get(digest_key) != _named_digest(actual):
            return f"experiment runtime {entries_key} identity differs"
    case_files = snapshot.get("caseFiles")
    bundle_files = snapshot.get("bundleFiles")
    rows = [row for row in record.get("cases", []) if isinstance(row, Mapping)]
    case_ids = {row.get("caseId") for row in rows}
    if not isinstance(case_files, Mapping) or not isinstance(bundle_files, Mapping) or set(case_files) != case_ids or set(bundle_files) != case_ids:
        return "experiment selected case or bundle roster differs"
    for case_id in case_ids:
        if not isinstance(case_id, str):
            return "experiment selected case ID is malformed"
        case_path = path / "inputs" / "cases" / f"{case_id}.frozen.json"
        try:
            case_raw = case_path.read_bytes()
        except OSError:
            return "experiment selected frozen case is unavailable"
        if _bytes_digest(case_raw) != case_files.get(case_id):
            return "experiment selected frozen case digest differs"
        row = next(row for row in rows if row.get("caseId") == case_id)
        try:
            loaded = _read_json(case_path, "frozen case")
            bundle_sha = loaded["case"]["evidence"]["bundleSha256"]
            bundle_path = path / "inputs" / "bundles" / f"{bundle_sha}.json"
            if _bytes_digest(bundle_path.read_bytes()) != bundle_files.get(case_id):
                return "experiment selected bundle digest differs"
            if loaded.get("caseSha256") != row.get("caseSha256") or bundle_sha != row.get("bundleSha256"):
                return "experiment selected input identity differs"
        except (OSError, KeyError, TypeError):
            return "experiment selected input is malformed"
    return None


def _execution_for_row(experiment: Path, row: Mapping[str, Any]) -> Path | None:
    execution_id = row.get("executionId")
    if not isinstance(execution_id, str) or not execution_id:
        return None
    path = experiment / "executions" / execution_id
    return path if path.is_dir() else None


def compare_experiments(baseline: str | Path, candidate: str | Path) -> dict[str, Any]:
    baseline_path, candidate_path = Path(baseline), Path(candidate)
    try:
        baseline_record = _read_json(baseline_path / "experiment.json", "baseline experiment")
        candidate_record = _read_json(candidate_path / "experiment.json", "candidate experiment")
    except ValueError as exc:
        return {"status": "incomplete", "reason": str(exc), "baseline": {"runDirectory": str(baseline_path)}, "candidate": {"runDirectory": str(candidate_path)}}
    if not isinstance(baseline_record, Mapping) or not isinstance(candidate_record, Mapping):
        return {"status": "incomplete", "reason": "experiment records are malformed", "baseline": {}, "candidate": {}}
    snapshot_errors: list[str] = []
    for label, path, record in (("baseline", baseline_path, baseline_record), ("candidate", candidate_path, candidate_record)):
        error = _verify_snapshot(path, record)
        if error:
            snapshot_errors.append(f"{label}: {error}")
    baseline_snapshot = baseline_record.get("snapshot")
    candidate_snapshot = candidate_record.get("snapshot")
    if isinstance(baseline_snapshot, Mapping) and isinstance(candidate_snapshot, Mapping):
        for key in ("toolingSha256", "toolingDependencySha256"):
            if baseline_snapshot.get(key) != candidate_snapshot.get(key):
                snapshot_errors.append(f"experiment tooling identity differs: {key}")
    base_rows = {row.get("caseId"): row for row in baseline_record.get("cases", []) if isinstance(row, Mapping)}
    cand_rows = {row.get("caseId"): row for row in candidate_record.get("cases", []) if isinstance(row, Mapping)}
    baseline_rows, baseline_errors = _validate_experiment_read(baseline_path, baseline_record, require_report=True)
    candidate_rows, candidate_errors = _validate_experiment_read(candidate_path, candidate_record, require_report=True)
    base_rows = {row.get("caseId"): row for row in baseline_rows if isinstance(row, Mapping)}
    cand_rows = {row.get("caseId"): row for row in candidate_rows if isinstance(row, Mapping)}

    from compare_executions import compare_runs
    from evaluate_case import _load_score_receipt

    cases: list[dict[str, Any]] = []
    errors: list[str] = [*snapshot_errors, *baseline_errors, *candidate_errors]
    for case_id in sorted(set(base_rows) | set(cand_rows)):
        baseline_row = base_rows.get(case_id)
        candidate_row = cand_rows.get(case_id)
        baseline_view = dict(baseline_row) if isinstance(baseline_row, Mapping) else None
        candidate_view = dict(candidate_row) if isinstance(candidate_row, Mapping) else None
        baseline_error = any(f"case {case_id} " in error for error in baseline_errors)
        candidate_error = any(f"case {case_id} " in error for error in candidate_errors)
        if baseline_row is None or candidate_row is None or baseline_error or candidate_error:
            cases.append({
                "caseId": case_id,
                "status": "incomplete",
                "reason": "one or both authenticated case views are unavailable",
                "baseline": baseline_view,
                "candidate": candidate_view,
            })
            errors.append(f"case {case_id}: one or both authenticated case views are unavailable")
            continue
        baseline_execution = _execution_for_row(baseline_path, baseline_row)
        candidate_execution = _execution_for_row(candidate_path, candidate_row)
        baseline_attempt = baseline_row.get("scoringAttemptId")
        candidate_attempt = candidate_row.get("scoringAttemptId")
        if baseline_execution is None or candidate_execution is None or not isinstance(baseline_attempt, str) or not isinstance(candidate_attempt, str):
            errors.append(f"case {case_id} execution is unavailable")
            cases.append({"caseId": case_id, "status": "incomplete", "reason": "explicit selected scoring attempt or execution is unavailable", "baseline": baseline_view, "candidate": candidate_view})
            continue
        result = compare_runs(
            baseline_execution,
            candidate_execution,
            baseline_attempt,
            candidate_attempt,
            load_score=_load_score_receipt,
        )
        baseline_view = dict(result.get("baseline") or baseline_view or {})
        candidate_view = dict(result.get("candidate") or candidate_view or {})
        baseline_view["scoringAttemptId"] = baseline_attempt
        candidate_view["scoringAttemptId"] = candidate_attempt
        case_result = {
            "caseId": case_id,
            "status": result.get("status"),
            "reason": result.get("reason"),
            "baseline": baseline_view,
            "candidate": candidate_view,
        }
        cases.append(case_result)
        if result.get("status") != "complete":
            errors.append(f"case {case_id}: {result.get('reason', 'comparison incomplete')}")
    status = "complete" if not errors and len(cases) == len(base_rows) and set(base_rows) == set(cand_rows) else "incomplete"
    return {
        "status": status,
        "reason": "matching reviewed case set and authenticated per-case identities" if status == "complete" else "; ".join(errors),
        "baseline": {"experimentId": baseline_record.get("experimentId"), "candidateId": baseline_record.get("candidateId")},
        "candidate": {"experimentId": candidate_record.get("experimentId"), "candidateId": candidate_record.get("candidateId")},
        "cases": cases,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run")
    run.add_argument("--suite", required=True, type=Path)
    run.add_argument("--candidate", choices=tuple(captured_execution.VALID_CANDIDATE_IDS), required=True)
    run.add_argument("--evaluator", required=True, type=Path)
    run.add_argument("--output-root", required=True, type=Path)
    run.add_argument("--source-run", type=Path)
    run.add_argument("--case", action="append", dest="selected_cases")
    run.add_argument("--wait-seconds", type=int, choices=range(0, 601), default=300)
    show = commands.add_parser("show")
    show.add_argument("--experiment", required=True, type=Path)
    compare = commands.add_parser("compare")
    compare.add_argument("--baseline", required=True, type=Path)
    compare.add_argument("--candidate", required=True, type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "run":
            experiment = run_experiment(
                suite_path=args.suite,
                output_root=args.output_root,
                candidate_id=args.candidate,
                evaluator_path=args.evaluator,
                wait_seconds=args.wait_seconds,
                selected_cases=args.selected_cases,
                source_run=args.source_run,
            )
            result = show_experiment(experiment)
            verdict = result.get("decision", {}).get("verdict")
            code = 1 if verdict == "reject" else 0 if verdict == "review_required" else 2
        elif args.command == "show":
            result = show_experiment(args.experiment)
            code = 0
        else:
            result = compare_experiments(args.baseline, args.candidate)
            code = 0 if result.get("status") == "complete" else 2
    except (OSError, ValueError, TypeError) as exc:
        result = {"status": "error", "reason": f"{type(exc).__name__}: {exc}"}
        code = 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, default=str))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
