"""Run the one-case Codespaces rehearsal against Amazon Nova Micro."""

import argparse
import sys
from pathlib import Path

from strands import Agent
from strands.models import BedrockModel
from strands_evals import Case, Experiment
from strands_evals.evaluators.deterministic import Equals


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report_path", type=Path, help="Path to the Strands JSON report")
    report_path = parser.parse_args().report_path

    prompt = Path(__file__).with_name("prompt.txt").read_text(encoding="utf-8")
    agent = Agent(
        model=BedrockModel(
            model_id="amazon.nova-micro-v1:0",
            region_name="us-east-1",
            temperature=0.0,
            streaming=False,
        ),
        system_prompt=prompt,
        callback_handler=None,
    )
    case = Case[str, str](
        name="inventory-access-denied",
        input="The inventory lookup failed with DynamoDB AccessDeniedException.",
        expected_output="RESTORE_ACCESS",
    )

    def run_agent(case: Case[str, str]) -> str:
        return str(agent(case.input)).strip()

    report = Experiment(cases=[case], evaluators=[Equals()]).run_evaluations(run_agent)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report.to_file(str(report_path))
    print(f"Report: {report_path}")

    actual = report.cases[0]["actual_output"]
    if actual is None:
        print(f"Execution error: {report.reasons[0]}", file=sys.stderr)
        return 2

    passed = report.test_passes[0]
    print(f"{case.name}: {'PASS' if passed else 'FAIL'}")
    print(f"Expected: {case.expected_output!r}  Actual: {actual!r}")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
