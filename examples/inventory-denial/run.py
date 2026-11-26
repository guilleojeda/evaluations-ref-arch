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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--case-dir", type=Path, default=EXAMPLE, help="directory with case.json and evidence.json"
    )
    parser.add_argument(
        "--report", type=Path, help="agent output to score (default: report.json in the case directory)"
    )
    args = parser.parse_args()

    evidence = args.case_dir / "evidence.json"
    try:
        with TemporaryDirectory() as scratch:
            frozen = Path(scratch) / "case.frozen.json"
            freeze_case(args.case_dir / "case.json", evidence, frozen)
            case = load_frozen_case(frozen, evidence)
        report_path = args.report or args.case_dir / "report.json"
        report = json.loads(report_path.read_text(encoding="utf-8"))
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

    # A saved report has no tool trace. Those two findings stay visible above.
    report_verdicts = [
        findings[name]["verdict"] for name in FINDINGS if name not in {"source_scope", "operator_boundary"}
    ]
    if "fail" in report_verdicts:
        print("Report checks: FAIL")
        return 1
    if not all(verdict == "pass" for verdict in report_verdicts):
        print("Report checks: INCOMPLETE")
        return 2
    print("Report checks: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
