"""Run an immutable faulty S3 comparison source without changing the S3 folder.

The S3 checkpoint opens with the repaired prompt from source revision
``bd8f59cbf60e2cd75477ff92dfc5a74b885f9daf``.  ``evaluate_case.py
run --candidate faulty`` labels the current source; it does not switch the
prompt.  This helper snapshots the current agent files into a temporary source
directory, replaces only ``prompt.py`` with the verified Phase 19 faulty bytes,
and asks the real captured runner to execute that immutable source.  The S3
worktree, reviewed case, bundle, and future repaired run remain untouched.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
AGENT = ROOT / "agent"
FAULTY_REVISION = "bd6f77df97933e3e675ee9c2a699db16e29ea1b6"


def _faulty_prompt() -> bytes:
    try:
        return subprocess.check_output(
            ["git", "show", f"{FAULTY_REVISION}:agent/prompt.py"],
            cwd=ROOT,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise RuntimeError(
            f"cannot read verified faulty prompt at {FAULTY_REVISION}"
        ) from exc


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", required=True, type=Path)
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--output-root", required=True, type=Path)
    return parser


def main() -> int:
    args = _parser().parse_args()
    sys.path.insert(0, str(AGENT))
    from captured_execution import DEPENDENCY_FILES, SOURCE_FILES, run_captured_case

    with tempfile.TemporaryDirectory(prefix="phase22-faulty-baseline-") as name:
        source = Path(name) / "agent"
        source.mkdir()
        for filename in (*SOURCE_FILES, *DEPENDENCY_FILES):
            original = AGENT / filename
            if not original.is_file() or original.is_symlink():
                raise RuntimeError(f"selected source file is unavailable: {filename}")
            shutil.copyfile(original, source / filename)
        (source / "prompt.py").write_bytes(_faulty_prompt())
        run_directory = run_captured_case(
            args.case,
            args.bundle,
            args.output_root,
            candidate_id="faulty",
            source_directory=source,
        )
    print(run_directory)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
