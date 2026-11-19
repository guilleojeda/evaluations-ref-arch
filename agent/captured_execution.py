"""Run the shared Strands agent against a private immutable evidence snapshot.

The CLI imports this module before a candidate is selected, so module-level
imports intentionally use only the standard library.  ``run_captured_case``
copies the selected inputs and source bytes first, then loads the copied code
for verification and execution.
"""

from __future__ import annotations

from contextlib import contextmanager
from collections import deque
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import signal
import subprocess
import sys
import sysconfig
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from threading import Event, Thread, Timer
from typing import Any, Iterator, Mapping, Sequence


MODEL_ID = "us.anthropic.claude-sonnet-4-6"
CANDIDATE_ID = "faulty"
VALID_CANDIDATE_IDS = frozenset(("faulty", "repaired"))
RUN_SECONDS = 240
MAX_TOOL_CALLS = 12
TRACE_SCOPE = "strands.telemetry.tracer"
EVALUATION_LOG_GROUP = "/aws/bedrock-agentcore/incident-triage-evaluation"
AWS_ACCOUNT_ID = "027224425948"
TRACE_ENDPOINT = "https://xray.us-east-1.amazonaws.com/v1/traces"
MAX_JSON_BYTES = 8 * 1024 * 1024

AGENT_DIRECTORY = Path(__file__).resolve().parent
SOURCE_FILES = (
    "main.py",
    "investigation.py",
    "evidence.py",
    "prompt.py",
    "captured_evidence.py",
    "reviewed_cases.py",
    "captured_execution.py",
    "evaluation_telemetry.py",
    "deterministic_checks.py",
    "agent-manifest.json",
)
DEPENDENCY_FILES = ("pyproject.toml", "uv.lock")
SNAPSHOT_MODULES = (
    "main",
    "prompt",
    "evidence",
    "investigation",
    "captured_evidence",
    "reviewed_cases",
    "evaluation_telemetry",
    "deterministic_checks",
)


def _json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _named_digest(files: Mapping[str, bytes]) -> str:
    digests = {name: _sha256(raw) for name, raw in sorted(files.items())}
    return _sha256(_json_bytes(digests))


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _decode_json(raw: bytes, label: str) -> Any:
    if len(raw) > MAX_JSON_BYTES:
        raise ValueError(f"{label} exceeds the local input size limit")
    try:
        return json.loads(
            raw.decode("utf-8"),
            parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)),
        )
    except (UnicodeError, json.JSONDecodeError, ValueError) as exc:
        raise ValueError(f"{label} is not valid UTF-8 JSON") from exc


def _read_input(path: str | Path, label: str) -> bytes:
    try:
        raw = Path(path).read_bytes()
    except OSError as exc:
        raise ValueError(f"cannot read {label}") from exc
    if len(raw) > MAX_JSON_BYTES:
        raise ValueError(f"{label} exceeds the local input size limit")
    return raw


def _write_bytes(path: Path, raw: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("xb") as output:
        output.write(raw)
        output.flush()
        os.fsync(output.fileno())
    path.chmod(0o600)


def _write_json_atomic(path: Path, value: Mapping[str, Any]) -> None:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False).encode("utf-8") + b"\n"
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
        temporary.chmod(0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _copy_bytes_tree(root: Path, files: Mapping[str, bytes]) -> None:
    for name, raw in files.items():
        _write_bytes(root / name, raw)


def _read_source_bytes(agent_directory: str | Path | None = None) -> tuple[dict[str, bytes], dict[str, bytes]]:
    """Read the selected candidate source and locked dependency bytes.

    The normal Runtime path uses this module's own directory.  Development
    experiments pass an explicitly snapshotted candidate directory so the
    experiment cannot silently fall back to the current IDE workspace.
    """

    selected_directory = Path(agent_directory) if agent_directory is not None else AGENT_DIRECTORY
    source: dict[str, bytes] = {}
    dependencies: dict[str, bytes] = {}
    for name in SOURCE_FILES:
        try:
            source[f"agent/{name}"] = (selected_directory / name).read_bytes()
        except OSError as exc:
            raise ValueError(f"selected agent source is unavailable: {name}") from exc
    for name in DEPENDENCY_FILES:
        try:
            dependencies[f"agent/{name}"] = (selected_directory / name).read_bytes()
        except OSError as exc:
            raise ValueError(f"locked dependency input is unavailable: {name}") from exc
    return source, dependencies


def _parse_headers(value: str) -> dict[str, str]:
    headers: dict[str, str] = {}
    for item in value.split(","):
        key, separator, content = item.strip().partition("=")
        if separator and key.strip():
            headers[key.strip().lower()] = content.strip()
    return headers


def _verify_exporter_setup() -> Any:
    """Reject production runs that cannot export the approved CloudWatch trace."""

    required_equal = {
        "AGENT_OBSERVABILITY_ENABLED": "true",
        "AWS_GENAI_CONTENT_EXTRACTION_OPT_OUT": "true",
        "OTEL_PYTHON_DISTRO": "aws_distro",
        "OTEL_PYTHON_CONFIGURATOR": "aws_configurator",
        "AWS_REGION": "us-east-1",
        "AWS_DEFAULT_REGION": "us-east-1",
        "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
        "OTEL_TRACES_EXPORTER": "otlp",
        "OTEL_LOGS_EXPORTER": "none",
        "OTEL_METRICS_EXPORTER": "none",
        "OTEL_TRACES_SAMPLER": "always_on",
    }
    missing = [name for name, expected in required_equal.items() if os.environ.get(name) != expected]
    if os.environ.get("AWS_ACCOUNT_ID") != AWS_ACCOUNT_ID:
        missing.append("AWS_ACCOUNT_ID")
    resource_attributes: dict[str, str] = {}
    for entry in os.environ.get("OTEL_RESOURCE_ATTRIBUTES", "").split(","):
        key, separator, value = entry.strip().partition("=")
        if separator:
            resource_attributes[key.strip()] = value.strip()
    traces_headers = _parse_headers(os.environ.get("OTEL_EXPORTER_OTLP_TRACES_HEADERS", ""))
    if not resource_attributes.get("service.name"):
        missing.append("OTEL_RESOURCE_ATTRIBUTES.service.name")
    if resource_attributes.get("aws.log.group.names") != EVALUATION_LOG_GROUP:
        missing.append("OTEL_RESOURCE_ATTRIBUTES.aws.log.group.names")
    if traces_headers.get("x-aws-log-group") != EVALUATION_LOG_GROUP:
        missing.append("OTEL_EXPORTER_OTLP_TRACES_HEADERS.x-aws-log-group")
    if traces_headers.get("x-aws-log-stream") != "spans":
        missing.append("OTEL_EXPORTER_OTLP_TRACES_HEADERS.x-aws-log-stream")
    trace_endpoint = os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
    if trace_endpoint is None or trace_endpoint.rstrip("/") != TRACE_ENDPOINT:
        missing.append("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
    trace_protocol = os.environ.get("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL")
    if trace_protocol is not None and trace_protocol != "http/protobuf":
        missing.append("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL")
    if missing:
        raise ValueError("production telemetry exporter setup is incomplete: " + ", ".join(sorted(set(missing))))

    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider

    provider = trace.get_tracer_provider()
    if not isinstance(provider, TracerProvider):
        raise ValueError("production run must start through the locked ADOT opentelemetry-instrument launcher")
    try:
        from amazon.opentelemetry.distro.exporter.otlp.aws.traces.otlp_aws_span_exporter import OTLPAwsSpanExporter
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError as exc:
        raise ValueError("locked ADOT AWS OTLP trace exporter is unavailable") from exc
    active_processors = getattr(getattr(provider, "_active_span_processor", None), "_span_processors", None)
    sampled_exporters = [
        getattr(processor, "span_exporter", None)
        for processor in active_processors or ()
        if isinstance(processor, BatchSpanProcessor)
    ]
    if not any(isinstance(exporter, OTLPAwsSpanExporter) for exporter in sampled_exporters):
        raise ValueError("production telemetry sampled exporter is not the signed AWS X-Ray OTLP exporter")
    return provider


def _configure_packaged_exporter(launcher_provider: Any) -> Any:
    """Install the signed ADOT exporter using the Runtime ZIP's OTel modules.

    The ``opentelemetry-instrument`` launcher necessarily initializes a
    trusted driver provider before the package ZIP is loaded.  Reusing that
    provider after the package dependency scope is installed is unsafe: its
    exporter encoder keys the driver's ``SpanKind`` enum, while candidate
    spans carry the packaged enum.  The resulting ``KeyError`` drops every
    span before CloudWatch/X-Ray sees it.  Keep the launcher preflight as the
    authentication boundary, then construct the same AWS OTLP exporter from
    the package's own OTel modules so encoder and span types are identical.
    """

    # These imports intentionally resolve inside _snapshot_imports, where the
    # extracted Runtime ZIP is first on sys.path and ambient site-packages have
    # been removed.  Never use the launcher's driver OTel classes here.
    from amazon.opentelemetry.distro.aws_opentelemetry_configurator import AwsOpenTelemetryConfigurator

    # Use the signed package configurator rather than reconstructing ADOT's
    # exporter/resource/sampler settings. This keeps AWS auth, endpoint,
    # headers, resource detectors and BatchSpanProcessor behavior identical to
    # the production ``opentelemetry-instrument`` path, but with package-owned
    # OTel classes. The launcher provider is only the already-authenticated
    # preflight boundary; it is never mutated or shut down here.
    try:
        AwsOpenTelemetryConfigurator().configure()
        return _verify_exporter_setup()
    except BaseException:
        # The ADOT configurator may install a provider before a later
        # validation/import fails. Close only that package-owned provider;
        # the authenticated launcher provider belongs to the outer process.
        try:
            from opentelemetry import trace

            partial_provider = trace.get_tracer_provider()
            if partial_provider is not launcher_provider:
                try:
                    partial_provider.force_flush(timeout_millis=30_000)
                except Exception:
                    pass
                try:
                    partial_provider.shutdown()
                except Exception:
                    pass
        finally:
            raise


@contextmanager
def _snapshot_imports(
    agent_source: Path,
    *,
    dependency_root: Path | None = None,
    dependency_modules: Sequence[str] = (),
) -> Iterator[None]:
    """Load candidate code and, when selected, its packaged dependencies.

    The normal development path only snapshots the candidate source modules.
    Package qualification additionally supplies the extracted Runtime root and
    the top-level modules it contains.  Those modules are removed from the
    ambient interpreter for the duration of the task so a trusted driver
    installation cannot satisfy a missing candidate dependency.  All module
    identities are restored before the evaluator continues.
    """

    names = set(SNAPSHOT_MODULES)
    if dependency_root is not None:
        for name in dependency_modules:
            if isinstance(name, str) and name and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
                names.add(name)
    old_modules: dict[str, Any] = {}
    for loaded_name in list(sys.modules):
        if any(loaded_name == name or loaded_name.startswith(f"{name}.") for name in names):
            old_modules[loaded_name] = sys.modules.pop(loaded_name)
    if dependency_root is not None:
        # Keep the trusted Strands Evals SDK object alive; the native driver
        # already owns its Experiment class and the ZIP intentionally carries
        # only serving dependencies.  Every other ambient site distribution
        # is removed, including modules that are not present in the ZIP, so a
        # missing candidate import cannot be rescued by the driver cache.
        for loaded_name in list(sys.modules):
            if loaded_name.startswith("strands_evals") or loaded_name in old_modules:
                continue
            module = sys.modules.get(loaded_name)
            module_path = getattr(module, "__file__", None)
            if isinstance(module_path, str) and ("site-packages" in module_path or "dist-packages" in module_path):
                old_modules[loaded_name] = sys.modules.pop(loaded_name)
    old_path = list(sys.path)
    if dependency_root is None:
        sys.path.insert(0, str(agent_source))
    else:
        # The extracted Runtime root must win over the staging copy for
        # package qualification.  Remove ambient site-packages entirely: a
        # missing ZIP dependency must fail import rather than being silently
        # satisfied by the trusted driver's installation.  Standard-library
        # paths remain available for the trusted captured support closure.
        standard_library_paths = [
            path for path in old_path
            if "site-packages" not in path and "dist-packages" not in path
        ]
        sys.path[:] = [str(dependency_root), str(agent_source), *standard_library_paths]
    try:
        yield
    finally:
        sys.path[:] = old_path
        for loaded_name in list(sys.modules):
            if any(loaded_name == name or loaded_name.startswith(f"{name}.") for name in names):
                sys.modules.pop(loaded_name, None)
        sys.modules.update(old_modules)


def _standard_library_paths(initial_path: Sequence[str]) -> list[str]:
    """Return standard-library search paths, excluding ambient packages."""

    paths: list[str] = []
    for key in ("stdlib", "platstdlib"):
        value = sysconfig.get_path(key)
        if isinstance(value, str) and value and value not in paths:
            paths.append(value)
    value = sysconfig.get_config_var("DESTSHARED")
    if isinstance(value, str) and value and value not in paths:
        paths.append(value)
    # The -S child normally already has the standard-library zip or dynamic
    # module directory in sys.path. Preserve those entries, excluding the
    # current directory and any ambient third-party installation.
    for path in initial_path:
        if path and "site-packages" not in path and "dist-packages" not in path and path not in paths:
            paths.append(path)
    return paths


@contextmanager
def _package_process_imports(
    agent_source: Path,
    *,
    dependency_root: Path,
) -> Iterator[None]:
    """Expose only the checked package, trusted support and standard library.

    This context is used only in the fresh package-case interpreter.  That
    interpreter has no trusted third-party modules to evict, and the package
    ADOT provider is configured before the task starts.  Keeping modules alive
    for the whole process avoids the import-lock race that can occur when a
    background exporter imports a module while ``_snapshot_imports`` removes
    it from a live instrumented parent.
    """

    old_path = list(sys.path)
    sys.path[:] = [str(dependency_root), str(agent_source), *_standard_library_paths(old_path)]
    try:
        yield
    finally:
        sys.path[:] = old_path


def _private_directory(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        raise ValueError("output root must be a private directory")
    path.chmod(0o700)
    return path


def acquire_operation_lock(path: str | Path) -> Any:
    """Hold a stable POSIX lock for one active execution or score operation."""

    lock_path = Path(path)
    lock_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    stream = lock_path.open("a+")
    try:
        fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
    except BaseException:
        stream.close()
        raise
    return stream


def release_operation_lock(stream: Any) -> None:
    if stream is None:
        return
    try:
        fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
    finally:
        stream.close()


def operation_lock_held(path: str | Path) -> bool:
    """Probe whether another process currently owns the stable operation lock."""

    lock_path = Path(path)
    try:
        stream = lock_path.open("rb")
    except FileNotFoundError:
        return False
    try:
        try:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        return False
    finally:
        stream.close()


def run_captured_case(
    case_path: str | Path,
    bundle_path: str | Path,
    output_root: str | Path,
    *,
    model_session: Any = None,
    candidate_id: str | None = None,
    source_directory: str | Path | None = None,
    dependency_root: str | Path | None = None,
    dependency_modules: Sequence[str] = (),
    runtime_origin: Mapping[str, Any] | None = None,
    trusted_runner: bool = False,
    progress_callback: Any = None,
) -> Path:
    """Execute one immutable captured case and return its unique run directory.

    Supplying ``model_session`` injects a scripted Bedrock transport for tests.
    That path never constructs a boto3 session or client and skips the
    production exporter check.  A normal invocation requires the locked ADOT
    launcher, verified before any Bedrock request is constructed.
    """

    strict_manifest = candidate_id is None
    selected_candidate = CANDIDATE_ID if candidate_id is None else candidate_id
    if selected_candidate not in VALID_CANDIDATE_IDS:
        raise ValueError(f"unsupported candidate ID: {selected_candidate!r}")
    provider = None
    case_bytes = _read_input(case_path, "frozen case")
    bundle_bytes = _read_input(bundle_path, "source bundle")
    source_files, dependency_files = _read_source_bytes(source_directory)
    selected_dependency_root = Path(dependency_root).resolve() if dependency_root is not None else None

    with tempfile.TemporaryDirectory(prefix="incident-triage-captured-snapshot-") as temporary_name:
        staging = Path(temporary_name)
        agent_source = staging / "source" / "agent"
        _copy_bytes_tree(staging / "source", {**source_files, **dependency_files})
        staged_case = staging / "case.frozen.json"
        staged_bundle = staging / "bundle.json"
        _write_bytes(staged_case, case_bytes)
        _write_bytes(staged_bundle, bundle_bytes)

        # Authenticate the copied, immutable inputs before any telemetry
        # exporter preflight or model/client construction.  In particular,
        # callers must see a frozen ``caseSha256`` mismatch even when the
        # production ADOT environment is not configured.
        from reviewed_cases import load_frozen_case

        load_frozen_case(staged_case, staged_bundle)
        if model_session is None:
            # ``opentelemetry-instrument`` installs the trusted ADOT provider
            # before this function starts. Validate it while its host modules
            # are still available, then preserve that provider while the
            # package dependency scope is swapped.
            provider = _verify_exporter_setup()

        if trusted_runner:
            # The development driver itself is already executing an accepted
            # immutable runner snapshot.  Candidate source bytes remain the
            # Runtime identity and are loaded by _snapshot_imports below, but
            # an old candidate copy of this orchestration module must not
            # replace the trusted S4 runner.
            snapshot_module = sys.modules.get(__name__)
            if snapshot_module is None or not callable(getattr(snapshot_module, "_run_snapshot", None)):
                raise ValueError("trusted captured execution runner is unavailable")
        else:
            runner_path = agent_source / "captured_execution.py"
            module_name = f"_captured_execution_snapshot_{uuid.uuid4().hex}"
            spec = importlib.util.spec_from_file_location(module_name, runner_path)
            if spec is None or spec.loader is None:
                raise ValueError("captured execution snapshot cannot be loaded")
            snapshot_module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(snapshot_module)
        if selected_dependency_root is not None and model_session is None:
            # The checked Runtime ZIP must never be loaded by mutating the
            # trusted instrumented evaluator process.  A fresh child owns the
            # package dependency graph and its exporter threads; the native
            # Strands experiment and scorer remain in this parent.
            return _run_packaged_case_process(
                staging=staging,
                staged_case=staged_case,
                staged_bundle=staged_bundle,
                output_root=Path(output_root),
                candidate_id=selected_candidate,
                strict_manifest=strict_manifest,
                dependency_root=selected_dependency_root,
                dependency_modules=dependency_modules,
                runtime_origin=runtime_origin,
                progress_callback=progress_callback,
                runner_source=(
                    Path(__file__).read_bytes()
                    if trusted_runner
                    else (agent_source / "captured_execution.py").read_bytes()
                ),
            )
        return Path(snapshot_module._run_snapshot(
            staging=staging,
            staged_case=staged_case,
            staged_bundle=staged_bundle,
            output_root=Path(output_root),
            source_files=source_files,
            dependency_files=dependency_files,
            model_session=model_session,
            provider=provider,
            candidate_id=selected_candidate,
            strict_manifest=strict_manifest,
            progress_callback=progress_callback,
            dependency_root=selected_dependency_root,
            dependency_modules=dependency_modules,
            runtime_origin=runtime_origin,
        ))


_PACKAGE_CHILD_PROGRESS_PREFIX = "__CAPTURED_PACKAGE_PROGRESS__ "


def _package_child_main() -> int:
    """Bootstrap the package child from this trusted runner source file."""

    request_path = Path(sys.argv[1])
    request = json.loads(request_path.read_bytes())
    staging = Path(request["staging"])
    agent_source = staging / "source" / "agent"
    dependency_root = Path(request["dependencyRoot"])
    sys.path[:] = [str(dependency_root), str(agent_source), *_standard_library_paths(sys.path)]

    parent_watchdog_fd = request.get("parentWatchdogFd")
    if type(parent_watchdog_fd) is int and parent_watchdog_fd >= 0:
        def watch_parent() -> None:
            try:
                with os.fdopen(parent_watchdog_fd, "rb", closefd=True) as parent_pipe:
                    if parent_pipe.read(1) == b"":
                        os.kill(os.getpid(), signal.SIGINT)
            except (OSError, ValueError):
                # The child is already terminating or the parent pipe was
                # closed during process startup; no second failure is needed.
                return

        Thread(target=watch_parent, name="captured-parent-watchdog", daemon=True).start()

    def progress(run_dir: Path, record: Mapping[str, Any]) -> None:
        print(
            _PACKAGE_CHILD_PROGRESS_PREFIX
            + json.dumps(
                {
                    "kind": "progress",
                    "runDirectory": str(run_dir),
                    "record": record,
                },
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ),
            flush=True,
        )

    try:
        run_dir = _run_packaged_case_child(request, progress_callback=progress)
        print(
            _PACKAGE_CHILD_PROGRESS_PREFIX
            + json.dumps(
                {"kind": "result", "runDirectory": str(run_dir)},
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ),
            flush=True,
        )
    except BaseException as exc:
        print(
            _PACKAGE_CHILD_PROGRESS_PREFIX
            + json.dumps(
                {"kind": "error", "type": type(exc).__name__, "message": str(exc)[:500]},
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ),
            flush=True,
        )
        raise
    return 0


def _stop_package_child(process: subprocess.Popen[str]) -> None:
    """Ask a package child to persist its interrupted execution before exit."""

    if process.poll() is not None:
        return
    try:
        process.send_signal(signal.SIGINT)
        process.wait(timeout=10)
        return
    except (OSError, subprocess.TimeoutExpired):
        pass
    if process.poll() is None:
        try:
            process.terminate()
            process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            if process.poll() is None:
                process.kill()
                process.wait()


def _run_packaged_case_process(
    *,
    staging: Path,
    staged_case: Path,
    staged_bundle: Path,
    output_root: Path,
    candidate_id: str,
    strict_manifest: bool,
    dependency_root: Path,
    dependency_modules: Sequence[str],
    runtime_origin: Mapping[str, Any] | None,
    progress_callback: Any,
    runner_source: bytes,
) -> Path:
    """Run one checked package case in a fresh interpreter process."""

    request_path = staging / "package-child-request.json"
    runner_path = staging / "trusted-package-runner.py"
    _write_bytes(runner_path, runner_source)
    environment = os.environ.copy()
    # -S below excludes the parent virtualenv's site-packages.  Keep the
    # production telemetry variables, but do not inherit a workspace path that
    # could satisfy a missing package dependency.
    environment["PYTHONPATH"] = ""
    environment["PYTHONNOUSERSITE"] = "1"
    parent_watchdog_read, parent_watchdog_write = os.pipe()
    try:
        _write_json_atomic(
            request_path,
            {
                "staging": str(staging),
                "stagedCase": str(staged_case),
                "stagedBundle": str(staged_bundle),
                "outputRoot": str(output_root),
                "candidateId": candidate_id,
                "strictManifest": strict_manifest,
                "dependencyRoot": str(dependency_root),
                "dependencyModules": list(dependency_modules),
                "runtimeOrigin": dict(runtime_origin) if runtime_origin is not None else None,
                "parentWatchdogFd": parent_watchdog_read,
            },
        )
        process = subprocess.Popen(
            [sys.executable, "-S", str(runner_path), str(request_path)],
            cwd=str(staging),
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            pass_fds=(parent_watchdog_read,),
        )
    except BaseException:
        os.close(parent_watchdog_read)
        os.close(parent_watchdog_write)
        raise
    os.close(parent_watchdog_read)
    output_lines: deque[str] = deque(maxlen=20)
    result_directory: Path | None = None
    previous_sigterm = None
    sigterm_installed = False

    def forward_sigterm(_signum: int, _frame: Any) -> None:
        _stop_package_child(process)
        raise SystemExit(128 + signal.SIGTERM)

    try:
        try:
            previous_sigterm = signal.signal(signal.SIGTERM, forward_sigterm)
            sigterm_installed = True
        except ValueError:
            # A caller may execute a case from a worker thread.  Python only
            # allows signal handlers on the main thread; normal cancellation
            # and KeyboardInterrupt still use the cleanup path below.
            previous_sigterm = None
        assert process.stdout is not None
        for line in process.stdout:
            line = line.rstrip("\n")
            if not line.startswith(_PACKAGE_CHILD_PROGRESS_PREFIX):
                output_lines.append(line)
                continue
            payload = line[len(_PACKAGE_CHILD_PROGRESS_PREFIX):]
            try:
                event = json.loads(payload)
            except (TypeError, ValueError):
                output_lines.append(line)
                continue
            if not isinstance(event, Mapping):
                output_lines.append(line)
                continue
            kind = event.get("kind")
            if kind == "progress":
                run_directory = event.get("runDirectory")
                record = event.get("record")
                if isinstance(run_directory, str) and isinstance(record, dict) and callable(progress_callback):
                    progress_callback(Path(run_directory), record)
            elif kind == "result":
                run_directory = event.get("runDirectory")
                if isinstance(run_directory, str):
                    result_directory = Path(run_directory)
            elif kind == "error":
                output_lines.append(f"{event.get('type', 'ChildError')}: {event.get('message', '')}")
    except BaseException:
        _stop_package_child(process)
        raise
    finally:
        if sigterm_installed:
            signal.signal(signal.SIGTERM, previous_sigterm)
        if process.stdout is not None:
            process.stdout.close()
        os.close(parent_watchdog_write)
    return_code = process.wait()
    if return_code != 0:
        details = "\n".join(output_lines).strip()
        message = f"packaged case child exited with status {return_code}"
        if details:
            message += f": {details[:2000]}"
        raise ValueError(message)
    if result_directory is None:
        details = "\n".join(output_lines).strip()
        message = "packaged case child did not return an execution directory"
        if details:
            message += f": {details[:2000]}"
        raise ValueError(message)
    return result_directory


def _run_packaged_case_child(request: Mapping[str, Any], *, progress_callback: Any = None) -> Path:
    """Execute a parent-snapshotted package case inside the package process."""

    staging = Path(request["staging"])
    staged_case = Path(request["stagedCase"])
    staged_bundle = Path(request["stagedBundle"])
    output_root = Path(request["outputRoot"])
    dependency_root = Path(request["dependencyRoot"])
    agent_source = staging / "source" / "agent"
    source_files: dict[str, bytes] = {}
    dependency_files: dict[str, bytes] = {}
    for name in SOURCE_FILES:
        path = agent_source / name
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"selected agent source is unavailable: {name}")
        source_files[f"agent/{name}"] = path.read_bytes()
    for name in DEPENDENCY_FILES:
        path = agent_source / name
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"locked dependency input is unavailable: {name}")
        dependency_files[f"agent/{name}"] = path.read_bytes()
    runtime_origin = request.get("runtimeOrigin")
    if runtime_origin is not None and not isinstance(runtime_origin, Mapping):
        raise ValueError("package child Runtime origin is malformed")
    with _package_process_imports(agent_source, dependency_root=dependency_root):
        # This child has no inherited trusted provider.  Configure the signed
        # package exporter after its exact dependency path is established.
        provider = _configure_packaged_exporter(None)
        return Path(_run_snapshot(
            staging=staging,
            staged_case=staged_case,
            staged_bundle=staged_bundle,
            output_root=output_root,
            source_files=source_files,
            dependency_files=dependency_files,
            model_session=None,
            provider=provider,
            candidate_id=request["candidateId"],
            strict_manifest=bool(request["strictManifest"]),
            progress_callback=progress_callback,
            dependency_root=dependency_root,
            dependency_modules=request.get("dependencyModules", ()),
            runtime_origin=dict(runtime_origin) if runtime_origin is not None else None,
            package_process=True,
        ))


class _ToolBudget:
    def __init__(self) -> None:
        self.calls = 0

    def __call__(self) -> None:
        if self.calls >= MAX_TOOL_CALLS:
            from investigation import ToolBudgetExceeded

            raise ToolBudgetExceeded("tool call limit reached")
        self.calls += 1


def _span_observer() -> Any:
    """Build a real SDK processor without importing OTel before snapshotting."""

    from opentelemetry.sdk.trace import SpanProcessor

    class SpanObserver(SpanProcessor):
        def __init__(self) -> None:
            self.enabled = True
            self.spans: list[Any] = []

        def on_start(self, span: Any, parent_context: Any = None) -> None:
            return None

        def on_end(self, span: Any) -> None:
            if not self.enabled:
                return
            scope = getattr(span, "instrumentation_scope", None)
            if getattr(scope, "name", None) == TRACE_SCOPE:
                self.spans.append(span)

        def shutdown(self) -> None:
            self.enabled = False

        def force_flush(self, timeout_millis: int = 30_000) -> bool:
            return True

    return SpanObserver()


def _span_attributes(span: Any) -> Mapping[str, Any]:
    if isinstance(span, Mapping):
        values = span.get("attributes")
        if isinstance(values, Mapping) and isinstance(values.get("attributes"), Mapping):
            values = values["attributes"]
        return values if isinstance(values, Mapping) else {}
    values = getattr(span, "attributes", None)
    return values if isinstance(values, Mapping) else {}


def _span_operation(span: Any) -> Any:
    return _span_attributes(span).get("gen_ai.operation.name")


def _event_content(event: Any) -> str:
    attributes = event.get("attributes") if isinstance(event, Mapping) else getattr(event, "attributes", None)
    if not isinstance(attributes, Mapping) or "content" not in attributes:
        raise ValueError("native agent span is missing the public task event")
    value = attributes["content"]
    if not isinstance(value, str):
        raise ValueError("native task event content is not text")
    try:
        blocks = json.loads(value)
    except json.JSONDecodeError:
        return value
    if isinstance(blocks, list) and all(isinstance(item, Mapping) for item in blocks):
        texts = [item.get("text") for item in blocks]
        if all(isinstance(item, str) for item in texts):
            return "".join(texts)
    return value


def _verify_native_identity(
    spans: Sequence[Any],
    projection: Mapping[str, Any],
    *,
    task: Mapping[str, Any],
    identity: Mapping[str, Any],
) -> str:
    roots = [span for span in spans if _span_operation(span) == "invoke_agent"]
    if len(roots) != 1:
        raise ValueError("native trace does not contain one root Strands agent span")
    root = roots[0]
    attributes = _span_attributes(root)
    if isinstance(root, Mapping):
        parent_id = root.get("parentSpanId", root.get("parent_id"))
    else:
        parent_id = getattr(root, "parent", None)
    if parent_id not in (None, "", 0):
        raise ValueError("native Strands invoke_agent span is not the trace root")
    expected_attributes = {
        "session.id": identity["sessionId"],
        "incident.execution_id": identity["executionId"],
        "incident.originating_run_id": identity["originatingRunId"],
        "incident.case_sha256": identity["caseSha256"],
        "incident.bundle_sha256": identity["bundleSha256"],
        "incident.reference_time": identity["referenceTime"],
        "incident.candidate_id": identity["candidateId"],
        "incident.source_sha256": identity["sourceSha256"],
        "incident.prompt_sha256": identity["promptSha256"],
        "incident.dependency_sha256": identity["dependencySha256"],
        "gen_ai.request.model": identity["modelId"],
    }
    for name, expected in expected_attributes.items():
        if attributes.get(name) != expected:
            raise ValueError(f"native agent span identity does not match {name}")

    root_events = root.get("events", ()) if isinstance(root, Mapping) else getattr(root, "events", ())
    task_events = [
        event
        for event in root_events
        if (event.get("name") if isinstance(event, Mapping) else getattr(event, "name", None)) == "gen_ai.user.message"
    ]
    if len(task_events) != 1:
        raise ValueError("native agent span does not contain exactly one task event")
    try:
        actual_task = json.loads(_event_content(task_events[0]))
    except (json.JSONDecodeError, TypeError) as exc:
        raise ValueError("native agent span task is not valid JSON") from exc
    if _json_bytes(actual_task) != _json_bytes(task):
        raise ValueError("native agent span task differs from the frozen public task")

    trace_ids: set[str] = set()
    for span in spans:
        attributes = _span_attributes(span)
        if attributes.get("session.id") != identity["sessionId"]:
            raise ValueError("native Strands span is missing the captured session identity")
        if isinstance(span, Mapping):
            trace_value = span.get("traceId")
            if not isinstance(trace_value, str):
                context = span.get("context")
                trace_value = context.get("trace_id") if isinstance(context, Mapping) else None
            if not isinstance(trace_value, str):
                raise ValueError("native Strands span has an invalid trace identity")
            normalized_trace = trace_value[2:] if trace_value.startswith("0x") else trace_value
            trace_ids.add(normalized_trace.lower())
        else:
            context = span.get_span_context()
            if not context.is_valid:
                raise ValueError("native Strands span has an invalid trace identity")
            trace_ids.add(f"{context.trace_id:032x}")
    if len(trace_ids) != 1:
        raise ValueError("native Strands spans do not share one trace")
    trace_id = next(iter(trace_ids))
    model_spans = [span for span in spans if _span_operation(span) == "chat"]
    if len(model_spans) != len(projection.get("modelCalls", [])):
        raise ValueError("native model spans do not match the local execution ledger")
    for span in model_spans:
        if _span_attributes(span).get("gen_ai.request.model") != identity["modelId"]:
            raise ValueError("native model span used an unexpected model")
    if isinstance(root, Mapping):
        span_value = root.get("spanId")
        if not isinstance(span_value, str):
            context = root.get("context")
            span_value = context.get("span_id") if isinstance(context, Mapping) else None
        expected_span_id = span_value[2:] if isinstance(span_value, str) and span_value.startswith("0x") else span_value
        if isinstance(expected_span_id, str):
            expected_span_id = expected_span_id.lower()
    else:
        expected_span_id = f"{root.get_span_context().span_id:016x}"
    if projection.get("agentSpanId") != expected_span_id:
        raise ValueError("native root span does not match its ledger identity")
    return trace_id


def _span_documents(spans: Sequence[Any]) -> list[Any]:
    documents: list[Any] = []
    for span in spans:
        to_json = getattr(span, "to_json", None)
        if not callable(to_json):
            raise ValueError("native span cannot be serialized")
        raw = to_json()
        document = json.loads(raw) if isinstance(raw, str) else dict(raw)
        context = span.get_span_context()
        if not context.is_valid or not isinstance(span.start_time, int) or not isinstance(span.end_time, int):
            raise ValueError("native span is missing its exact trace identity or timestamps")
        document.update(
            {
                "traceId": f"{context.trace_id:032x}",
                "spanId": f"{context.span_id:016x}",
                "startTimeUnixNano": span.start_time,
                "endTimeUnixNano": span.end_time,
                "durationNano": span.end_time - span.start_time,
            }
        )
        if span.parent is not None and span.parent.is_valid:
            document["parentSpanId"] = f"{span.parent.span_id:016x}"
        else:
            document.pop("parentSpanId", None)
        scope = getattr(span, "instrumentation_scope", None)
        if scope is not None:
            document["scope"] = {
                "name": scope.name,
                **({"version": scope.version} if getattr(scope, "version", None) else {}),
            }
        documents.append(document)
    return documents


def _usage(spans: Sequence[Any]) -> dict[str, int]:
    root = next((span for span in spans if _span_operation(span) == "invoke_agent"), None)
    if root is None:
        return {}
    attrs = _span_attributes(root)
    names = {
        "inputTokens": "gen_ai.usage.input_tokens",
        "outputTokens": "gen_ai.usage.output_tokens",
        "totalTokens": "gen_ai.usage.total_tokens",
    }
    return {label: attrs[key] for label, key in names.items() if type(attrs.get(key)) is int}


def _snapshot_manifest(
    source_files: Mapping[str, bytes],
    dependency_files: Mapping[str, bytes],
    prompt_sha256: str,
    case_bytes: bytes,
    bundle_bytes: bytes,
) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "sourceFiles": {name: _sha256(raw) for name, raw in sorted(source_files.items())},
        "dependencyFiles": {name: _sha256(raw) for name, raw in sorted(dependency_files.items())},
        "sourceSha256": _named_digest(source_files),
        "dependencySha256": _named_digest(dependency_files),
        "promptSha256": prompt_sha256,
        "caseFileSha256": _sha256(case_bytes),
        "bundleSha256": _sha256(bundle_bytes),
    }


def _module_origins(
    names: Sequence[str],
    *,
    dependency_root: Path,
    agent_source: Path,
) -> dict[str, dict[str, Any]]:
    """Return stable source/content identities for modules used by the task."""

    origins: dict[str, dict[str, Any]] = {}
    package_root = dependency_root.resolve()
    support_root = agent_source.resolve()
    for name in names:
        module = sys.modules.get(name)
        path_value = getattr(module, "__file__", None) if module is not None else None
        if not isinstance(path_value, str):
            origins[name] = {"loaded": False}
            continue
        path = Path(path_value)
        try:
            resolved = path.resolve()
            if resolved.is_relative_to(package_root):
                relative = resolved.relative_to(package_root).as_posix()
                origin = {"kind": "runtime_zip", "path": relative}
            elif resolved.is_relative_to(support_root):
                relative = resolved.relative_to(support_root).as_posix()
                origin = {"kind": "trusted_support_snapshot", "path": relative}
            else:
                origin = {"kind": "ambient", "path": str(resolved)}
            if resolved.is_file():
                origin["sha256"] = _sha256(resolved.read_bytes())
        except (OSError, ValueError):
            origin = {"kind": "unavailable", "path": str(path)}
        origin["loaded"] = True
        origins[name] = origin
    return origins


def _persist_interrupted(
    run_dir: Path,
    record: dict[str, Any],
    *,
    failure_type: str,
    error: str,
    started_monotonic: float,
) -> None:
    record["status"] = "interrupted"
    record["finishedAt"] = _utc_now()
    record["elapsedSeconds"] = round(max(0.0, time.monotonic() - started_monotonic), 6)
    record["failure"] = {"type": failure_type, "message": error[:500]}
    _write_json_atomic(run_dir / "execution.json", record)


def _run_snapshot(
    *,
    staging: Path,
    staged_case: Path,
    staged_bundle: Path,
    output_root: Path,
    source_files: Mapping[str, bytes],
    dependency_files: Mapping[str, bytes],
    model_session: Any,
    provider: Any,
    candidate_id: str,
    strict_manifest: bool,
    progress_callback: Any,
    dependency_root: Path | None,
    dependency_modules: Sequence[str],
    runtime_origin: Mapping[str, Any] | None,
    package_process: bool = False,
) -> Path:
    agent_source = staging / "source" / "agent"
    import_scope = (
        _package_process_imports(agent_source, dependency_root=dependency_root)
        if package_process and dependency_root is not None
        else _snapshot_imports(
            agent_source,
            dependency_root=dependency_root,
            dependency_modules=dependency_modules,
        )
    )
    with import_scope:
        from captured_evidence import CapturedEvidenceTools
        from deterministic_checks import check_captured_report, check_report
        from evaluation_telemetry import execution_content, interrupted_execution_content
        from investigation import MODEL_ID as SHARED_MODEL_ID, RUN_SECONDS as SHARED_RUN_SECONDS, create_agent, invoke_agent
        from prompt import PROMPT_SHA256, SYSTEM_PROMPT
        from reviewed_cases import load_frozen_case

        if SHARED_MODEL_ID != MODEL_ID or SHARED_RUN_SECONDS != RUN_SECONDS:
            raise ValueError("shared investigation settings do not match the approved captured runner")
        actual_prompt_sha256 = hashlib.sha256(SYSTEM_PROMPT.encode("utf-8")).hexdigest()
        if PROMPT_SHA256 != actual_prompt_sha256:
            raise ValueError("prompt digest does not match the saved system prompt")
        manifest_value = _decode_json((agent_source / "agent-manifest.json").read_bytes(), "agent manifest")
        if (
            not isinstance(manifest_value, Mapping)
            or (strict_manifest and manifest_value.get("promptSha256") != actual_prompt_sha256)
        ):
            raise ValueError("packaged prompt digest does not match the source snapshot")

        task_runtime_origin = dict(runtime_origin) if runtime_origin is not None else None
        if dependency_root is not None:
            # Import these distributions while the ambient site-packages paths
            # are removed.  The captured task does not call Runtime ``main``,
            # but boto3 remains part of the package's serving dependency set
            # and is therefore included in the origin receipt.
            for dependency_name in ("main", "strands", "boto3", "botocore", "pydantic", "opentelemetry"):
                __import__(dependency_name)
            if task_runtime_origin is not None:
                task_runtime_origin["moduleOrigins"] = _module_origins(
                    ("main", "investigation", "evidence", "prompt", "strands", "boto3", "botocore", "pydantic", "opentelemetry"),
                    dependency_root=dependency_root,
                    agent_source=agent_source,
                )

        # Validate both inputs from the copied bytes before creating a run
        # directory or constructing a model/client.
        loaded_case = load_frozen_case(staged_case, staged_bundle)
        task = loaded_case["task"]
        output_directory = _private_directory(output_root)
        execution_id = str(uuid.uuid4())
        session_id = f"incident-triage-eval-{execution_id}"
        run_dir = output_directory / execution_id
        run_dir.mkdir(mode=0o700, exist_ok=False)
        run_dir.chmod(0o700)
        operation_lock = acquire_operation_lock(run_dir / ".owner.lock")
        _write_bytes(run_dir / "case.frozen.json", staged_case.read_bytes())
        _write_bytes(run_dir / "bundle.json", staged_bundle.read_bytes())
        _copy_bytes_tree(run_dir / "source", {**source_files, **dependency_files})

        source_sha256 = _named_digest(source_files)
        dependency_sha256 = _named_digest(dependency_files)
        manifest = _snapshot_manifest(
            source_files,
            dependency_files,
            actual_prompt_sha256,
            staged_case.read_bytes(),
            staged_bundle.read_bytes(),
        )
        started_at = _utc_now()
        started_monotonic = time.monotonic()
        identity: dict[str, Any] = {
            "executionId": execution_id,
            "sessionId": session_id,
            "traceId": None,
            "candidateId": candidate_id,
            "modelId": MODEL_ID,
            "originatingRunId": loaded_case["originatingRunId"],
            "caseSha256": loaded_case["caseSha256"],
            "bundleSha256": loaded_case["bundleSha256"],
            "referenceTime": loaded_case["referenceTime"],
            "sourceSha256": source_sha256,
            "promptSha256": actual_prompt_sha256,
            "dependencySha256": dependency_sha256,
            "reportSha256": None,
        }
        if task_runtime_origin is not None:
            identity["runtimeOrigin"] = task_runtime_origin
        ledger: dict[str, Any] = {
            "agentSpanId": None,
            "modelCalls": [],
            "toolCalls": [],
            "reportSpanId": None,
        }
        record: dict[str, Any] = {
            "status": "running",
            "startedAt": started_at,
            "identity": identity,
            "manifest": manifest,
            "report": None,
            "ledger": ledger,
            "deterministic": None,
            "modelRequestCount": 0,
            "modelResponseCount": 0,
            "modelSpanCount": 0,
            "modelRequestAttempts": [],
            "evidenceToolCallCount": 0,
            "evidenceProviderCallCount": 0,
            "usage": {},
        }
        if task_runtime_origin is not None:
            record["runtimeOrigin"] = task_runtime_origin
        _write_json_atomic(run_dir / "execution.json", record)
        if callable(progress_callback):
            progress_callback(run_dir, record)

        timer: Timer | None = None
        cancel_signal = Event()
        observer: Any = None
        packaged_provider = package_process and provider is not None and model_session is None
        try:
            # Tests inject a fake session; production normally passes the
            # provider already verified before the package snapshot loaded.
            from opentelemetry import trace
            from opentelemetry.sdk.trace import TracerProvider

            if provider is not None and model_session is None and dependency_root is not None and not package_process:
                # The launcher provider was authenticated before package
                # imports. Rebuild its exporter with the package's own OTel
                # classes to keep SpanKind/resource/encoder identities
                # consistent across the genuine Runtime dependency scope.
                provider = _configure_packaged_exporter(provider)
                packaged_provider = True
            elif provider is None:
                provider = trace.get_tracer_provider()
                if not isinstance(provider, TracerProvider):
                    if model_session is None:
                        raise ValueError("captured run has no installed ADOT tracer provider")
                    # Package tests intentionally load the candidate's OTel
                    # distribution in isolation from the trusted driver. A
                    # scripted transport does not need ADOT export, so give
                    # that isolated SDK a local provider just as the normal
                    # development harness does for its host SDK.
                    provider = TracerProvider()
                    trace.set_tracer_provider(provider)
            observer = _span_observer()
            provider.add_span_processor(observer)
            tool_budget = _ToolBudget()
            deadline = started_monotonic + RUN_SECONDS
            evidence = CapturedEvidenceTools.load(
                staged_bundle,
                reference_time=loaded_case["referenceTime"],
                expected_sha256=loaded_case["bundleSha256"],
                allowed_resources=task["allowedResources"],
                deadline_monotonic=deadline,
                charge_tool_call=tool_budget,
            )
            span_attributes = {
                "session.id": session_id,
                "incident.execution_id": execution_id,
                "incident.originating_run_id": loaded_case["originatingRunId"],
                "incident.case_sha256": loaded_case["caseSha256"],
                "incident.bundle_sha256": loaded_case["bundleSha256"],
                "incident.reference_time": loaded_case["referenceTime"],
                "incident.candidate_id": candidate_id,
                "incident.source_sha256": source_sha256,
                "incident.prompt_sha256": actual_prompt_sha256,
                "incident.dependency_sha256": dependency_sha256,
                "gen_ai.request.model": MODEL_ID,
            }
            trace_attributes = {**span_attributes}
            from opentelemetry import baggage
            from opentelemetry.context import attach, detach

            # Captured evidence calls are part of the persisted ledger and
            # must retain model-request order when the budget rejects the
            # final call.  The hosted Runtime keeps the shared factory's
            # native default executor; only this captured path is serialized.
            from strands import Agent
            from strands.tools.executors.sequential import SequentialToolExecutor

            def captured_agent_class(**kwargs: Any) -> Any:
                kwargs["tool_executor"] = SequentialToolExecutor()
                return Agent(**kwargs)

            baggage_token = attach(baggage.set_baggage("session.id", session_id))
            try:
                agent, bounded_model = create_agent(
                    evidence,
                    region_name="us-east-1",
                    deadline_monotonic=deadline,
                    cancel_signal=cancel_signal,
                    trace_attributes=trace_attributes,
                    model_session=model_session,
                    capture_model_requests=True,
                    agent_class=captured_agent_class,
                )
                remaining = max(0.0, deadline - time.monotonic())
                if remaining <= 0:
                    raise TimeoutError("captured investigation deadline elapsed before inference")
                timer = Timer(remaining, cancel_signal.set)
                timer.daemon = True
                timer.start()
                public_task = json.dumps(task, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                report = invoke_agent(
                    agent,
                    public_task,
                    deadline_monotonic=deadline,
                    cancel_signal=cancel_signal,
                )
                if report is None:
                    raise TimeoutError("captured investigation deadline exceeded after agent returned")
            finally:
                detach(baggage_token)
            if timer is not None:
                timer.cancel()
                timer = None
            record["report"] = report
            identity["reportSha256"] = _sha256(_json_bytes(report))
            record["deterministic"] = check_report(report, loaded_case)
            if not provider.force_flush(timeout_millis=30_000):
                record["telemetryWarning"] = "trace exporter did not confirm export during flush"

            record["modelRequestCount"] = bounded_model.requests
            record["modelRequestAttempts"] = bounded_model.attempts
            record["modelResponseCount"] = sum(
                item.get("status") == "stream_returned" for item in bounded_model.attempts
            )
            record["evidenceProviderCallCount"] = tool_budget.calls
            record["usage"] = _usage(observer.spans)
            raw_spans = _span_documents(observer.spans)
            _write_json_atomic(run_dir / "strands.native-spans.json", {"spans": raw_spans})
            record["nativeSpansSha256"] = _sha256(_json_bytes({"spans": raw_spans}))

            projection = execution_content(raw_spans)
            if _json_bytes(projection.get("report")) != _json_bytes(report):
                raise ValueError("structured report differs from the actual InvestigationReport span")
            record["modelSpanCount"] = len(projection.get("modelCalls", []))
            if record["modelResponseCount"] != record["modelSpanCount"]:
                raise ValueError("successful physical model responses differ from native model spans")
            tool_attempts = projection.get("toolCalls", [])
            if tool_budget.calls > len(tool_attempts) or tool_budget.calls > MAX_TOOL_CALLS:
                raise ValueError("captured provider tool count exceeds observed attempts or its shared cap")
            record["evidenceToolCallCount"] = len(tool_attempts)
            trace_id = _verify_native_identity(
                observer.spans,
                projection,
                task=task,
                identity=identity,
            )
            identity["traceId"] = trace_id
            record["ledger"] = {
                name: projection[name]
                for name in ("agentSpanId", "modelCalls", "toolCalls", "reportSpanId")
            }
            record["reportSource"] = projection["reportSource"]
            record["deterministic"] = check_captured_report(report, loaded_case, record["ledger"])
            record["status"] = "complete"
            record["finishedAt"] = _utc_now()
            record["elapsedSeconds"] = round(max(0.0, time.monotonic() - started_monotonic), 6)
            _write_json_atomic(run_dir / "execution.json", record)
            return run_dir
        except BaseException as exc:
            if observer is not None:
                try:
                    observer.enabled = True
                    raw_spans = _span_documents(observer.spans)
                    _write_json_atomic(run_dir / "strands.native-spans.json", {"spans": raw_spans})
                    record["nativeSpansSha256"] = _sha256(_json_bytes({"spans": raw_spans}))
                    record["modelRequestCount"] = locals().get("bounded_model").requests if "bounded_model" in locals() else 0
                    if "bounded_model" in locals():
                        record["modelRequestAttempts"] = bounded_model.attempts
                        record["modelResponseCount"] = sum(
                            item.get("status") == "stream_returned" for item in bounded_model.attempts
                        )
                    record["evidenceProviderCallCount"] = locals().get("tool_budget").calls if "tool_budget" in locals() else 0
                    record["usage"] = _usage(observer.spans)
                    partial = False
                    try:
                        projection = execution_content(raw_spans)
                    except Exception:
                        partial = True
                        projection = interrupted_execution_content(
                            raw_spans,
                            expected_session_id=record["identity"]["sessionId"],
                        )
                    record["ledger"] = {
                        name: projection[name]
                        for name in ("agentSpanId", "modelCalls", "toolCalls", "reportSpanId")
                    }
                    record["modelSpanCount"] = (
                        projection["modelSpanCount"]
                        if partial else len(projection["modelCalls"])
                    )
                    record["reportSource"] = projection.get("reportSource")
                    record["evidenceToolCallCount"] = (
                        projection["evidenceToolCallCount"]
                        if partial else len(projection["toolCalls"])
                    )
                    if partial:
                        record["identity"]["traceId"] = projection["traceId"]
                    else:
                        root_span = next((span for span in observer.spans if _span_operation(span) == "invoke_agent"), None)
                        if root_span is not None and getattr(root_span, "get_span_context", None):
                            context = root_span.get_span_context()
                            if context.is_valid:
                                record["identity"]["traceId"] = f"{context.trace_id:032x}"
                    if not partial and record.get("report") is not None and _json_bytes(projection.get("report")) != _json_bytes(record["report"]):
                        record["telemetryError"] = "structured report differs from the actual report span"
                    else:
                        record["telemetryError"] = str(exc)[:500]
                except Exception as telemetry_exc:
                    record["telemetryError"] = str(telemetry_exc)[:500]
            _persist_interrupted(
                run_dir,
                record,
                failure_type=type(exc).__name__,
                error=str(exc) or type(exc).__name__,
                started_monotonic=started_monotonic,
            )
            if isinstance(exc, (KeyboardInterrupt, SystemExit)):
                raise
            return run_dir
        finally:
            if timer is not None:
                timer.cancel()
            if packaged_provider:
                # The package provider owns package OTel modules and must be
                # drained and closed before _snapshot_imports restores the
                # trusted driver modules. Never flush or shut down the shared
                # launcher provider here.
                try:
                    provider.force_flush(timeout_millis=30_000)
                except Exception:
                    pass
                try:
                    provider.shutdown()
                except Exception:
                    pass
            if observer is not None:
                observer.shutdown()
            release_operation_lock(operation_lock)


def _load_record_json(path: Path, label: str) -> Any:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise ValueError(f"{label} is unavailable") from exc
    return _decode_json(raw, label)


def _safe_relative(root: Path, relative: str) -> Path:
    path = Path(relative)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError("execution manifest contains an unsafe source path")
    target = root / path
    if target.is_symlink() or not target.is_file():
        raise ValueError("execution snapshot file is missing or is a symlink")
    try:
        target.resolve().relative_to(root.resolve())
    except ValueError as exc:
        raise ValueError("execution snapshot file escapes the run directory") from exc
    return target


def _verify_model_request_attempts(
    record: Mapping[str, Any],
    *,
    model_id: str,
    model_span_count: int,
    model_calls: Sequence[Mapping[str, Any]],
    max_requests: int,
) -> None:
    """Bind physical client attempts to their retained requests and native chat roster."""

    from strands.models import _native_output

    fingerprints: dict[int, str] = {}
    for model in model_calls:
        if not isinstance(model, Mapping):
            raise ValueError("execution model-call ledger is malformed")
        model_fingerprints = model.get("requestFingerprints")
        if model_fingerprints is None:
            continue
        if not isinstance(model_fingerprints, list):
            raise ValueError("native model request fingerprint is malformed")
        for fingerprint in model_fingerprints:
            if not isinstance(fingerprint, Mapping):
                raise ValueError("native model request fingerprint is malformed")
            ordinal = fingerprint.get("ordinal")
            digest = fingerprint.get("sha256")
            if type(ordinal) is not int or ordinal <= 0 or not isinstance(digest, str):
                raise ValueError("native model request fingerprint is malformed")
            if re.fullmatch(r"[0-9a-f]{64}", digest) is None or ordinal in fingerprints:
                raise ValueError("native model request fingerprint is malformed")
            fingerprints[ordinal] = digest

    if "modelRequestAttempts" not in record:
        # Earlier Phase 16 runs retained only Strands chat spans. Keep those
        # complete archives readable when every physical call had a span.
        if fingerprints:
            raise ValueError("physical model request attempts are missing from the saved execution")
        if "modelResponseCount" in record or "modelSpanCount" in record:
            raise ValueError("physical model request attempts are missing from the saved execution")
        if record.get("modelRequestCount") != model_span_count:
            raise ValueError("legacy model request count differs from native model spans")
        return
    attempts = record["modelRequestAttempts"]
    if not isinstance(attempts, list) or not attempts or len(attempts) > max_requests:
        raise ValueError("physical model request attempts are missing or exceed the shared limit")
    if len(fingerprints) != len(attempts):
        raise ValueError("native model request fingerprints are missing from the execution ledger")
    if record.get("modelRequestCount") != len(attempts):
        raise ValueError("saved physical model request count differs from retained attempts")
    returned = 0
    returned_ordinals: set[int] = set()
    for ordinal, attempt in enumerate(attempts, 1):
        if (
            not isinstance(attempt, Mapping)
            or type(attempt.get("ordinal")) is not int
            or attempt.get("ordinal") != ordinal
        ):
            raise ValueError("physical model request attempt order is malformed")
        if attempt.get("modelId") != model_id:
            raise ValueError("physical model request used an unexpected model")
        request = attempt.get("request")
        if not isinstance(request, Mapping) or request.get("modelId") != model_id:
            raise ValueError("physical model request is missing its model identity")
        if attempt.get("requestSha256") != _sha256(_json_bytes(request)):
            raise ValueError("physical model request digest does not match its retained request")
        status = attempt.get("status")
        if status == "stream_returned":
            returned += 1
            request_ordinal = attempt["ordinal"]
            if request_ordinal in returned_ordinals:
                raise ValueError("physical model request fingerprint differs from native chat telemetry")
            returned_ordinals.add(request_ordinal)
            continue
        if status != "error":
            raise ValueError("physical model request has an unsupported outcome")
        error = attempt.get("error")
        if not isinstance(error, Mapping) or error.get("Code") != "ValidationException":
            raise ValueError("completed run contains an unclassified failed model request")
        message = error.get("Message")
        if not isinstance(message, str) or not message.strip():
            raise ValueError("failed model request is missing its validation reason")
        tool_config = request.get("toolConfig")
        choice = tool_config.get("toolChoice") if isinstance(tool_config, Mapping) else None
        if isinstance(choice, Mapping) and choice.get("tool") == {"name": "InvestigationReport"}:
            recognized = _native_output._is_unsupported_mechanism_message(message, "forced")
        elif isinstance(request.get("outputConfig"), Mapping):
            recognized = _native_output._is_unsupported_mechanism_message(message, "native") or any(
                signal in message for signal in _native_output._NATIVE_OUTPUT_REJECTED_MESSAGES
            )
        else:
            recognized = False
        if not recognized:
            raise ValueError("completed run contains an unrecognized structured-output validation failure")
    for attempt in attempts:
        if fingerprints.get(attempt["ordinal"]) != attempt.get("requestSha256"):
            raise ValueError("physical model request fingerprint differs from native chat telemetry")
    if record.get("modelResponseCount") != returned or record.get("modelSpanCount") != model_span_count:
        raise ValueError("successful physical responses do not match the native model span roster")
    if returned != model_span_count:
        raise ValueError("successful physical response count differs from native model spans")


def load_execution(run_dir: str | Path) -> tuple[dict[str, Any], dict[str, Any], list[Any]]:
    """Verify one saved run and reopen its frozen case without cloud access."""

    from deterministic_checks import check_captured_report
    from evaluation_telemetry import execution_content
    from investigation import InvestigationReport, MAX_MODEL_REQUESTS
    from reviewed_cases import load_frozen_case

    directory = Path(run_dir)
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("execution run directory is unavailable")
    record = _load_record_json(directory / "execution.json", "execution record")
    if not isinstance(record, dict):
        raise ValueError("execution record must be an object")
    if record.get("status") == "running":
        if operation_lock_held(directory / ".owner.lock"):
            loaded_case = load_frozen_case(directory / "case.frozen.json", directory / "bundle.json")
            return record, loaded_case, []
        # The owner may have written the terminal record immediately after
        # the first read. Re-read before classifying a stale running marker.
        latest = _load_record_json(directory / "execution.json", "execution record")
        if latest.get("status") != "running":
            record = latest
        else:
            record = dict(record)
            record["status"] = "interrupted"
            record.setdefault("failure", {"type": "ProcessInterrupted", "message": "run ended before a terminal record was saved"})
    if record.get("status") not in {"complete", "interrupted"}:
        raise ValueError("execution record has an unsupported status")

    identity = record.get("identity")
    if not isinstance(identity, Mapping):
        raise ValueError("execution identity is missing")
    required_identity = {
        "executionId", "sessionId", "traceId", "candidateId", "modelId", "originatingRunId",
        "caseSha256", "bundleSha256", "referenceTime", "sourceSha256", "promptSha256",
        "dependencySha256", "reportSha256",
    }
    if not required_identity <= set(identity):
        raise ValueError("execution identity is incomplete")
    if identity.get("candidateId") not in VALID_CANDIDATE_IDS or identity.get("modelId") != MODEL_ID:
        raise ValueError("execution candidate or model identity is unsupported")
    runtime_origin = identity.get("runtimeOrigin")
    if runtime_origin is not None:
        if not isinstance(runtime_origin, Mapping) or runtime_origin.get("kind") != "runtime_zip":
            raise ValueError("execution Runtime package origin is malformed")
        for key in ("zipSha256", "manifestSha256", "runtimeSourceSha256", "dependencySha256"):
            if not isinstance(runtime_origin.get(key), str) or re.fullmatch(r"[0-9a-f]{64}", runtime_origin[key]) is None:
                raise ValueError("execution Runtime package origin identity is malformed")
        module_origins = runtime_origin.get("moduleOrigins")
        if not isinstance(module_origins, Mapping):
            raise ValueError("execution Runtime package module origins are missing")
        for module_name in ("main", "investigation", "evidence", "prompt", "strands", "boto3"):
            module_origin = module_origins.get(module_name)
            if (
                not isinstance(module_origin, Mapping)
                or module_origin.get("kind") != "runtime_zip"
                or module_origin.get("loaded") is not True
                or not isinstance(module_origin.get("sha256"), str)
            ):
                raise ValueError(f"execution Runtime package module origin is invalid: {module_name}")

    manifest = record.get("manifest")
    if not isinstance(manifest, Mapping) or manifest.get("schemaVersion") != 1:
        raise ValueError("execution snapshot manifest is missing or invalid")
    source_manifest = manifest.get("sourceFiles")
    dependency_manifest = manifest.get("dependencyFiles")
    if not isinstance(source_manifest, Mapping) or not isinstance(dependency_manifest, Mapping):
        raise ValueError("execution source digests are missing")
    source_files: dict[str, bytes] = {}
    dependency_files: dict[str, bytes] = {}
    for table, destination in ((source_manifest, source_files), (dependency_manifest, dependency_files)):
        for name, digest in table.items():
            if not isinstance(name, str) or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
                raise ValueError("execution snapshot digest is malformed")
            target = _safe_relative(directory / "source", name)
            raw = target.read_bytes()
            if _sha256(raw) != digest:
                raise ValueError("execution source snapshot digest does not match its manifest")
            destination[name] = raw
    source_sha256 = _named_digest(source_files)
    dependency_sha256 = _named_digest(dependency_files)
    if (
        manifest.get("sourceSha256") != source_sha256
        or identity.get("sourceSha256") != source_sha256
        or manifest.get("dependencySha256") != dependency_sha256
        or identity.get("dependencySha256") != dependency_sha256
        or manifest.get("promptSha256") != identity.get("promptSha256")
    ):
        raise ValueError("execution source, prompt, or dependency identity does not match its snapshot")

    expected_sources = {f"agent/{name}" for name in SOURCE_FILES}
    expected_dependencies = {f"agent/{name}" for name in DEPENDENCY_FILES}
    if set(source_manifest) != expected_sources or set(dependency_manifest) != expected_dependencies:
        raise ValueError("execution snapshot manifest does not contain the selected source and lock files")

    case_path = directory / "case.frozen.json"
    bundle_path = directory / "bundle.json"
    if _sha256(case_path.read_bytes()) != manifest.get("caseFileSha256"):
        raise ValueError("frozen case file digest does not match the execution manifest")
    bundle_raw = bundle_path.read_bytes()
    if _sha256(bundle_raw) != identity.get("bundleSha256") or manifest.get("bundleSha256") != identity.get("bundleSha256"):
        raise ValueError("source bundle digest does not match the execution identity")
    native_spans: list[Any] = []
    loaded_case = load_frozen_case(case_path, bundle_path)
    if (
        loaded_case.get("caseSha256") != identity.get("caseSha256")
        or loaded_case.get("bundleSha256") != identity.get("bundleSha256")
        or loaded_case.get("originatingRunId") != identity.get("originatingRunId")
        or loaded_case.get("referenceTime") != identity.get("referenceTime")
    ):
        raise ValueError("execution inputs do not match the frozen case identity")

    report = record.get("report")
    if record["status"] == "complete":
        if not isinstance(report, Mapping):
            raise ValueError("completed execution report is missing")
        try:
            InvestigationReport.model_validate(report)
        except Exception as exc:
            raise ValueError("completed execution report does not match schema 2") from exc
        if _sha256(_json_bytes(report)) != identity.get("reportSha256"):
            raise ValueError("report digest does not match the execution identity")
        native_path = directory / "strands.native-spans.json"
        native = _load_record_json(native_path, "native Strands spans")
        if not isinstance(native, Mapping) or not isinstance(native.get("spans"), list):
            raise ValueError("native Strands span file is malformed")
        if _sha256(_json_bytes(native)) != record.get("nativeSpansSha256"):
            raise ValueError("native Strands span digest does not match the execution record")
        native_spans = native["spans"]
        projection = execution_content(native["spans"])
        if _json_bytes(projection.get("report")) != _json_bytes(report):
            raise ValueError("saved report differs from the authenticated native report span")
        expected_ledger = {
            name: projection[name]
            for name in ("agentSpanId", "modelCalls", "toolCalls", "reportSpanId")
        }
        if _json_bytes(record.get("ledger")) != _json_bytes(expected_ledger):
            raise ValueError("saved execution ledger differs from authenticated native spans")
        observed_trace = _verify_native_identity(
            native["spans"], projection, task=loaded_case["task"], identity=identity
        )
        if identity.get("traceId") != observed_trace:
            raise ValueError("saved trace ID differs from the authenticated native spans")
        _verify_model_request_attempts(
            record,
            model_id=identity["modelId"],
            model_span_count=len(expected_ledger["modelCalls"]),
            model_calls=expected_ledger["modelCalls"],
            max_requests=MAX_MODEL_REQUESTS,
        )
        if record.get("reportSource") is not None and record.get("reportSource") != projection.get("reportSource"):
            raise ValueError("saved report source differs from native spans")
        if record.get("evidenceToolCallCount") != len(expected_ledger["toolCalls"]):
            raise ValueError("saved evidence-tool count differs from native spans")
        provider_call_count = record.get("evidenceProviderCallCount")
        if (
            type(provider_call_count) is not int
            or provider_call_count < 0
            or provider_call_count > MAX_TOOL_CALLS
            or provider_call_count > len(expected_ledger["toolCalls"])
        ):
            raise ValueError("saved provider-call count exceeds observed attempts or the shared cap")
        findings = check_captured_report(report, loaded_case, expected_ledger)
        if _json_bytes(record.get("deterministic")) != _json_bytes(findings):
            raise ValueError("saved deterministic findings differ from the authenticated report and ledger")
    elif report is not None:
        if not isinstance(report, Mapping) or _sha256(_json_bytes(report)) != identity.get("reportSha256"):
            raise ValueError("interrupted report digest does not match the execution identity")
    if record["status"] == "interrupted":
        native_path = directory / "strands.native-spans.json"
        # A process can die after atomically writing spans but before stamping
        # their digest into execution.json. Those spans are orphaned and must
        # not be treated as authenticated interrupted evidence.
        if (
            isinstance(record.get("nativeSpansSha256"), str)
            and native_path.is_file()
            and not native_path.is_symlink()
        ):
            native = _load_record_json(native_path, "interrupted native Strands spans")
            if not isinstance(native, Mapping) or not isinstance(native.get("spans"), list):
                raise ValueError("interrupted native Strands span file is malformed")
            if _sha256(_json_bytes(native)) != record.get("nativeSpansSha256"):
                raise ValueError("interrupted native Strands span digest does not match the execution record")
            native_spans = native["spans"]
    return record, loaded_case, native_spans


if __name__ == "__main__":
    raise SystemExit(_package_child_main())
