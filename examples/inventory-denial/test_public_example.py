"""Run the two documented public examples against the same passing and failing reports."""

import json
from pathlib import Path
import re
import subprocess
import sys

EXAMPLE = Path(__file__).resolve().parent
EXPECTED = {
    "report_structure": "PASS",
    "assessment": "PASS",
    "action": "PASS",
    "target": "PASS",
    "target_value": "PASS",
    "as_of_time": "PASS",
    "source_scope": "INCOMPLETE",
    "operator_boundary": "INCOMPLETE",
}


def verify(script, summary, arguments, exit_code, expected_findings):
    process = subprocess.run(
        [sys.executable, str(EXAMPLE / script), *arguments], capture_output=True, text=True
    )
    rows = re.findall(r"^(PASS|FAIL|INCOMPLETE)\s+([a-z_]+)\b", process.stdout, re.MULTILINE)
    findings = {name: verdict for verdict, name in rows}
    if (
        process.returncode != exit_code
        or summary not in process.stdout.splitlines()
        or findings != expected_findings
        or len(rows) != len(expected_findings)
    ):
        raise AssertionError(f"{script} exited {process.returncode}\n{process.stdout}\n{process.stderr}")


def main():
    changed = EXAMPLE / "report-memory-regression.json"
    proposal = json.loads(changed.read_text(encoding="utf-8"))["recommendation"]
    assert proposal == {"action": "Increase memory", "target": "inventory", "value": 512, "unit": "MB"}
    for script, label in [("run.py", "Report checks"), ("native.py", "Native result")]:
        verify(script, f"{label}: PASS", [], 0, EXPECTED)
        verify(
            script, f"{label}: FAIL", ["--report", str(changed)], 1,
            dict(EXPECTED, action="FAIL", target_value="FAIL"),
        )
    print("Public Inventory example checks passed")


if __name__ == "__main__":
    main()
