"""Check the workflow's private-manifest readback against the selected roster."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ReviewRosterTest(unittest.TestCase):
    def verify(self, expected, cases, reports, manifest="approved-digest"):
        with tempfile.TemporaryDirectory() as directory:
            pointer = Path(directory) / "pointer.json"
            pointer.write_text(json.dumps({"caseIds": expected}), encoding="utf-8")
            observed = {
                "manifestSha256": manifest,
                "caseIdentities": [{"caseId": case_id} for case_id in cases],
                "reportIdentities": [{"caseId": case_id} for case_id in reports],
            }
            return subprocess.run(
                ["jq", "-e", "--arg", "digest", "approved-digest", "--slurpfile",
                 "pointer", str(pointer), "-f", str(ROOT / "scripts/verify-review-roster.jq")],
                input=json.dumps(observed), text=True, capture_output=True, check=False,
            ).returncode

    def test_stock_and_carried_suites_require_exact_cases_and_reports(self):
        stock = ["denial", "capacity", "recovery"]
        carried = stock + ["reviewed-live"]
        for roster in [stock, carried]:
            with self.subTest(roster=roster):
                self.assertEqual(self.verify(roster, roster, list(reversed(roster))), 0)
        self.assertNotEqual(self.verify(carried, stock, stock), 0)
        self.assertNotEqual(self.verify(carried, carried, stock + ["denial"]), 0)
        self.assertNotEqual(self.verify(carried, stock + ["different-case"], carried), 0)
        self.assertNotEqual(self.verify(carried, carried, carried, manifest="other-digest"), 0)
