"""Run a native Strands experiment with a saved Inventory report and a local evaluator."""

import argparse
from pathlib import Path
import sys

from strands_evals import Case, Experiment
from strands_evals.evaluators import Evaluator
from strands_evals.types.evaluation import EvaluationOutput

from run import EXAMPLE, REPORT_ONLY_FINDINGS, check_report, load_case, load_report, report_verdict


class InventoryReportEvaluator(Evaluator):
    def __init__(self, reviewed_case):
        super().__init__(name="inventory-report")
        self.reviewed_case = reviewed_case

    def evaluate(self, evaluation_case):
        result = check_report(evaluation_case.actual_output, self.reviewed_case)
        rows = []
        for name in REPORT_ONLY_FINDINGS:
            finding = result["findings"][name]
            passed = finding["verdict"] == "pass"
            rows.append(EvaluationOutput(
                score=float(passed), test_pass=passed,
                label=finding["verdict"] or finding["status"],
                reason=finding["reason"], metadata={"finding": name},
            ))
        return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case-dir", type=Path, default=EXAMPLE)
    parser.add_argument("--report", type=Path, help="saved candidate report, defaults to report.json")
    args = parser.parse_args()
    try:
        reviewed_case = load_case(args.case_dir)
        saved_report = load_report(args.report or args.case_dir / "report.json")
    except (OSError, ValueError) as error:
        print(f"Could not load the example: {error}", file=sys.stderr)
        return 2

    case = Case(name=reviewed_case["case"]["caseId"], input=reviewed_case["task"])

    def task(_case):
        return {"output": saved_report}

    experiment = Experiment(cases=[case], evaluators=[InventoryReportEvaluator(reviewed_case)])
    report = experiment.run_evaluations(task)
    rows = report.detailed_results[0] if report.detailed_results else []
    if {(row.metadata or {}).get("finding") for row in rows} != set(REPORT_ONLY_FINDINGS):
        print("Native result: INCOMPLETE (missing report findings)", file=sys.stderr)
        return 2

    print(f"Case: {case.name}")
    print("Candidate: saved report")
    for row in rows:
        print(f"{row.label.upper():<10} {row.metadata['finding']} - {row.reason}")
    print("INCOMPLETE source_scope - requires a recorded tool trace")
    print("INCOMPLETE operator_boundary - requires a recorded tool trace")
    verdict, code = report_verdict([row.label for row in rows])
    print(f"Native result: {verdict}")
    return code


if __name__ == "__main__":
    sys.exit(main())
