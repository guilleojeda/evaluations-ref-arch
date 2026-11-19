"""Run a matching faulty Strands experiment from an immutable source snapshot.

S4 opens with the repaired prompt from source revision
``ea890c0cd166dfa33dce987e9f2d55dc08ce9670``.  The normal experiment CLI's candidate label
does not change source bytes, so this helper calls the same native
``run_experiment`` entry point with a temporary source directory containing the
current tooling and the verified Phase 19 faulty prompt.  The suite, evaluator,
locks, and output root are supplied by the presenter and remain outside Git.
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
    parser.add_argument("--suite", required=True, type=Path)
    parser.add_argument("--case", action="append", dest="selected_cases")
    parser.add_argument("--evaluator", required=True, type=Path)
    parser.add_argument("--output-root", required=True, type=Path)
    parser.add_argument("--wait-seconds", type=int, default=300)
    return parser


def main() -> int:
    args = _parser().parse_args()
    sys.path.insert(0, str(AGENT))
    import captured_execution
    from development_experiment import run_experiment

    with tempfile.TemporaryDirectory(prefix="phase22-faulty-experiment-") as name:
        source = Path(name) / "agent"
        source.mkdir()
        for filename in (*captured_execution.SOURCE_FILES, *captured_execution.DEPENDENCY_FILES):
            original = AGENT / filename
            if not original.is_file() or original.is_symlink():
                raise RuntimeError(f"selected source file is unavailable: {filename}")
            shutil.copyfile(original, source / filename)
        (source / "prompt.py").write_bytes(_faulty_prompt())
        experiment = run_experiment(
            args.suite,
            args.output_root,
            candidate_id="faulty",
            evaluator_path=args.evaluator,
            wait_seconds=args.wait_seconds,
            selected_cases=args.selected_cases,
            source_directory=source,
        )
    print(experiment)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
