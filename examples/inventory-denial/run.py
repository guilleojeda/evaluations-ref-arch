"""Score one saved report using the incident agent's offline checks."""

import argparse
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

EXAMPLE = Path(__file__).resolve().parent
sys.path.insert(0, str(EXAMPLE.parents[1] / "agent"))

from deterministic_checks import FINDINGS, check_report
from reviewed_cases import freeze_case, load_frozen_case

REPORT_ONLY_FINDINGS = tuple(name for name in FINDINGS if name not in {"source_scope", "operator_boundary"})


def load_case(case_dir: Path) -> dict:
    """Load the reviewed case through the same local validation as the CLI."""

    evidence = case_dir / "evidence.json"
    with TemporaryDirectory() as scratch:
        frozen = Path(scratch) / "case.frozen.json"
        freeze_case(case_dir / "case.json", evidence, frozen)
        return load_frozen_case(frozen, evidence)


def load_report(report_path: Path) -> dict:
    try:
        return json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"saved report is not valid UTF-8 JSON: {error}") from error


def report_verdict(verdicts) -> tuple[str, int]:
    """Return the report-only verdict and process code used by both runners."""

    if "fail" in verdicts:
        return "FAIL", 1
    if verdicts and all(verdict == "pass" for verdict in verdicts):
        return "PASS", 0
    return "INCOMPLETE", 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--case-dir", type=Path, default=EXAMPLE, help="directory with case.json and evidence.json"
    )
    parser.add_argument(
        "--report", type=Path, help="agent output to score (default: report.json in the case directory)"
    )
    args = parser.parse_args()

    try:
        case = load_case(args.case_dir)
        report_path = args.report or args.case_dir / "report.json"
        report = load_report(report_path)
        result = check_report(report, case)
    except (OSError, ValueError) as error:
        print(f"Could not evaluate the case: {error}", file=sys.stderr)
        return 2

    print(f"Case: {case['case']['caseId']}")
    findings = result["findings"]
    for name in FINDINGS:
        finding = findings[name]
        verdict = finding["verdict"] or finding["status"]
        reason = f" - {finding['reason']}" if verdict != "pass" else ""
        print(f"{verdict.upper():<10} {name}{reason}")

    verdict, code = report_verdict([findings[name]["verdict"] for name in REPORT_ONLY_FINDINGS])
    print(f"Report checks: {verdict}")
    return code


if __name__ == "__main__":
    sys.exit(main())
