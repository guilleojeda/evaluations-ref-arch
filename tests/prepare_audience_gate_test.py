"""Offline checks for the native audience input staging contract."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "prepare_audience_gate.py"


def load_script():
    spec = importlib.util.spec_from_file_location("prepare_audience_gate_subject", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load prepare_audience_gate.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class NativeAudienceFixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.scenario = root / "denial-case.json"
        self.trace = root / "original-trace.json"
        trace_id = "trace-1234567890abcdef"
        self.scenario.write_text(json.dumps({
            "scenario_id": "scenario-opaque-1234",
            "metadata": {
                "generation_id": "generation-1",
                "source": {"trace_id": trace_id, "session_id": "session-opaque-4567"},
                "expected_recommendation": {
                    "action": "Restore inventory access",
                    "target": "inventory",
                    "value": "75",
                    "unit": "version",
                },
            },
            "turns": [{
                "input": "Alarm: inventory read denied",
                "expected_response": "Restore Inventory access.",
            }],
        }, sort_keys=True), encoding="utf-8")
        self.trace.write_text(json.dumps([
            {"traceId": trace_id, "name": "root"},
            {"traceId": trace_id, "name": "investigation"},
        ], sort_keys=True), encoding="utf-8")


class PrepareAudienceGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="prepare-audience-gate-")
        self.root = Path(self.temp.name)
        self.module = load_script()
        self.fixture = NativeAudienceFixture(self.root)
        self.output = self.root / "prepared"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _args(self, *, dry_run: bool = False) -> argparse.Namespace:
        return argparse.Namespace(
            scenario=self.fixture.scenario,
            trace=self.fixture.trace,
            bucket="private-evidence.example",
            output_dir=self.output,
            dry_run=dry_run,
        )

    def test_prepare_carries_only_scenario_and_original_trace(self) -> None:
        result = self.module.prepare(self._args())
        self.assertEqual(result["status"], "prepared")
        pointer = json.loads((self.output / "audience-input.json").read_text(encoding="utf-8"))
        self.assertEqual(set(pointer), self.module.POINTER_FIELDS)
        pointer_text = json.dumps(pointer)
        self.assertNotIn("trace-1234567890abcdef", pointer_text)
        self.assertNotIn("session-opaque-4567", pointer_text)
        self.assertNotIn("scenario-opaque-1234", pointer_text)
        self.assertEqual(
            self.module.main([
                "verify", "--archive", str(self.output / "staging.tar.gz"),
                "--pointer", str(self.output / "audience-input.json"),
            ]),
            0,
        )
        with self.assertRaisesRegex(KeyError, "staging/case.frozen.json"):
            # The exact member set is the no-replay-builder contract.
            members = self.module._archive_members((self.output / "staging.tar.gz").read_bytes())
            members["staging/case.frozen.json"]
        members = self.module._archive_members((self.output / "staging.tar.gz").read_bytes())
        self.assertEqual(set(members), {
            "staging/manifest.json",
            "staging/denial-case.json",
            "staging/original-trace.json",
            "staging/SHA256SUMS",
        })

    def test_prepare_is_idempotent_and_dry_run_has_no_external_write(self) -> None:
        first = self.module.prepare(self._args())
        archive_before = (self.output / "staging.tar.gz").read_bytes()
        second = self.module.prepare(self._args())
        self.assertEqual(first["archiveSha256"], second["archiveSha256"])
        self.assertEqual(archive_before, (self.output / "staging.tar.gz").read_bytes())
        dry = self.module.prepare(self._args(dry_run=True))
        self.assertEqual(dry["status"], "dry-run")
        self.assertEqual(dry["externalWrites"], 0)

    def test_trace_identity_and_archive_tampering_fail_closed(self) -> None:
        self.fixture.trace.write_text(json.dumps([{"traceId": "different"}]), encoding="utf-8")
        with self.assertRaisesRegex(self.module.AudiencePreparationError, "source trace ID"):
            self.module.prepare(self._args())
        self.fixture = NativeAudienceFixture(self.root)
        self.module.prepare(self._args())
        archive = self.output / "staging.tar.gz"
        archive.write_bytes(archive.read_bytes() + b"tampered")
        pointer = json.loads((self.output / "audience-input.json").read_text(encoding="utf-8"))
        with self.assertRaisesRegex(self.module.AudiencePreparationError, "sha256"):
            self.module._validate_archive(pointer, archive)

    def test_publish_command_is_local_and_content_addressed(self) -> None:
        self.module.prepare(self._args())
        completed = self.module.main([
            "publish-command", "--archive", str(self.output / "staging.tar.gz"),
            "--pointer", str(self.output / "audience-input.json"),
        ])
        self.assertEqual(completed, 0)
        pointer = json.loads((self.output / "audience-input.json").read_text(encoding="utf-8"))
        self.assertEqual(pointer["s3Key"], f"{self.module.DEFAULT_PREFIX}/{pointer['sha256']}/staging.tar.gz")
        self.assertEqual(hashlib.sha256((self.output / "staging.tar.gz").read_bytes()).hexdigest(), pointer["sha256"])


if __name__ == "__main__":
    unittest.main()
