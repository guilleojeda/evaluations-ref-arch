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
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
PROJECT = ROOT / "agent"
OUTPUT = ROOT / ".artifacts" / "agent" / "runtime.zip"


def run(*args: str, cwd: Path = ROOT, quiet: bool = False) -> None:
    command = [*args]
    print("+", " ".join(command))
    subprocess.run(
        command,
        cwd=cwd,
        check=True,
        stdout=subprocess.DEVNULL if quiet else None,
    )


def copy_entrypoint(staging: Path) -> None:
    shutil.copy2(PROJECT / "main.py", staging / "main.py")


def write_zip(staging: Path) -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    temporary_zip = OUTPUT.with_suffix(".zip.tmp")
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
    temporary_zip.replace(OUTPUT)


def main() -> None:
    if sys.version_info < (3, 13) or sys.version_info >= (3, 14):
        raise SystemExit(
            f"Python 3.13 is required to run the package command; got {sys.version.split()[0]}"
        )

    with tempfile.TemporaryDirectory(prefix="incident-triage-agent-") as temporary:
        temporary_root = Path(temporary)
        staging = temporary_root / "deployment"
        requirements = temporary_root / "requirements.txt"
        staging.mkdir()

        # Export the exact resolved package set.  Do not include the local project
        # itself: the ZIP's root main.py is the AgentCore entrypoint.
        run(
            "uv",
            "export",
            "--project",
            str(PROJECT),
            "--locked",
            "--no-dev",
            "--no-emit-project",
            "--format",
            "requirements.txt",
            "--output-file",
            str(requirements),
            quiet=True,
        )
        run(
            "uv",
            "pip",
            "install",
            "--python-platform",
            "aarch64-manylinux2014",
            "--python-version",
            "3.13",
            "--target",
            str(staging),
            "--only-binary",
            ":all:",
            "--require-hashes",
            "--requirements",
            str(requirements),
        )
        copy_entrypoint(staging)
        write_zip(staging)

    print(f"Wrote {OUTPUT} ({OUTPUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
