"""Build the direct-deploy AgentCore ZIP from the locked Python workspace.

The AgentCore Runtime currently supports ARM64 Linux for Python ZIP deployments.
This script deliberately asks uv for aarch64-manylinux2014 wheels instead of
copying the host's macOS virtualenv.  The temporary requirements export is
derived from ``uv.lock`` with ``uv export --locked`` and is never written to the
repository.
"""

from __future__ import annotations

import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
import json
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
PROJECT = ROOT / "agent"
OUTPUT = ROOT / ".artifacts" / "agent" / "runtime.zip"
ADAPTER_OUTPUT = ROOT / ".artifacts" / "agent" / "alarm-adapter.zip"
RUNTIME_MODULES = ("main.py", "evidence.py", "prompt.py")


def run(*args: str, cwd: Path = ROOT, quiet: bool = False) -> None:
    command = [*args]
    print("+", " ".join(command))
    subprocess.run(
        command,
        cwd=cwd,
        check=True,
        stdout=subprocess.DEVNULL if quiet else None,
    )


def package_revision() -> str:
    value = os.environ.get("AGENT_BUILD_SOURCE_REVISION") or os.environ.get("GITHUB_SHA")
    if not value:
        value = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, check=True, capture_output=True, text=True
        ).stdout.strip()
    if len(value) != 40 or any(char not in "0123456789abcdef" for char in value.lower()):
        raise SystemExit("AGENT_BUILD_SOURCE_REVISION/GITHUB_SHA must be a 40-character commit SHA")
    return value.lower()


def write_zip(staging: Path, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_zip = output.with_suffix(output.suffix + ".tmp")
    if temporary_zip.exists():
        temporary_zip.unlink()
    with zipfile.ZipFile(
        temporary_zip,
        "w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=9,
    ) as archive:
        for path in sorted(staging.rglob("*")):
            if path.is_file() and not any(part == "__pycache__" for part in path.parts):
                name = path.relative_to(staging).as_posix()
                source_mode = stat.S_IMODE(path.stat().st_mode)
                mode = 0o755 if source_mode & 0o111 else 0o644
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = mode << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
    temporary_zip.replace(output)


def install_locked_dependencies(staging: Path, requirements: Path, *, adapter: bool) -> None:
    export_args = [
        "uv", "export", "--project", str(PROJECT), "--locked", "--no-dev", "--no-emit-project",
        "--format", "requirements.txt", "--output-file", str(requirements),
    ]
    if adapter:
        export_args.extend(("--only-group", "adapter"))
    run(*export_args, quiet=True)
    run(
        "uv", "pip", "install", "--python-platform", "aarch64-manylinux2014", "--python-version", "3.13",
        "--target", str(staging), "--only-binary", ":all:", "--require-hashes", "--requirements", str(requirements),
    )


def write_otel_launcher(staging: Path) -> None:
    launcher_source = (
        "#!/usr/bin/env python3\n"
        "from opentelemetry.instrumentation.auto_instrumentation import run\n"
        "run()\n"
    )
    for launcher in (staging / "opentelemetry-instrument", staging / "bin" / "opentelemetry-instrument"):
        launcher.parent.mkdir(parents=True, exist_ok=True)
        launcher.write_text(launcher_source, encoding="utf-8")
        launcher.chmod(0o755)


def main() -> None:
    if sys.version_info < (3, 13) or sys.version_info >= (3, 14):
        raise SystemExit(
            f"Python 3.13 is required to run the package command; got {sys.version.split()[0]}"
        )

    with tempfile.TemporaryDirectory(prefix="incident-triage-agent-") as temporary:
        temporary_root = Path(temporary)
        revision = package_revision()
        sys.path.insert(0, str(PROJECT))
        from prompt import PROMPT_SHA256

        runtime_staging = temporary_root / "runtime"
        runtime_requirements = temporary_root / "runtime-requirements.txt"
        runtime_staging.mkdir()
        install_locked_dependencies(runtime_staging, runtime_requirements, adapter=False)
        for module in RUNTIME_MODULES:
            shutil.copy2(PROJECT / module, runtime_staging / module)
        write_otel_launcher(runtime_staging)
        (runtime_staging / "agent-manifest.json").write_text(
            json.dumps({"sourceRevision": revision, "promptSha256": PROMPT_SHA256}, sort_keys=True, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        write_zip(runtime_staging, OUTPUT)

        adapter_staging = temporary_root / "adapter"
        adapter_requirements = temporary_root / "adapter-requirements.txt"
        adapter_staging.mkdir()
        install_locked_dependencies(adapter_staging, adapter_requirements, adapter=True)
        shutil.copy2(PROJECT / "alarm_adapter.py", adapter_staging / "alarm_adapter.py")
        write_zip(adapter_staging, ADAPTER_OUTPUT)

    print(f"Wrote {OUTPUT} ({OUTPUT.stat().st_size} bytes)")
    print(f"Wrote {ADAPTER_OUTPUT} ({ADAPTER_OUTPUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
