"""Deterministic public tests for the S5 live-gate preparation CLI."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts" / "prepare_live_gate.py"
BASE_CASE_IDS = [
    "carried.capacity",
    "carried.denial",
    "carried.recovery",
    "carried.audience",
]
LIVE_CASE_ID = "native.opaque-live-case-1234567890ab"
TRACE_ID = "trace-private-native-123"
SESSION_ID = "session-private-native-456"
RUN_ID = "run-private-native-789"


def load_cli_module():
    spec = importlib.util.spec_from_file_location("prepare_live_gate", CLI)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load prepare_live_gate.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def case_envelope(case_id: str, bundle_sha: str, run_id: str, *, trace_id: str | None = None) -> dict:
    case = {
        "schemaVersion": 1,
        "caseId": case_id,
        "task": {"referenceTime": "2026-11-26T19:46:31.000Z"},
        "evidence": {"bundleSha256": bundle_sha, "originatingRunId": run_id, "references": []},
        "review": {},
        "expectations": {},
    }
    if trace_id is not None:
        case["evidence"]["traceRef"] = {
            "source": "original-trace.json", "sha256": "f" * 64,
            "traceId": trace_id, "runId": run_id,
        }
    return {"caseSha256": hashlib.sha256(canonical(case)).hexdigest(), "case": case}


class LiveGateFixture:
    def __init__(self, root: Path, module) -> None:
        self.root = root
        self.module = module
        self.base_archive = root / "base-staging.tar.gz"
        self.base_pointer = root / "base-qualification-input.json"
        self.bridge_dir = root / "bridge"
        self.bridge_dir.mkdir()
        members: dict[str, bytes] = {}
        manifest_rows = []
        suite_rows = []
        for index, case_id in enumerate(BASE_CASE_IDS):
            bundle_name = f"bundles/{index}.json"
            case_name = f"cases/{index}.frozen.json"
            bundle_raw = json.dumps({
                "schemaVersion": 1,
                "origin": {"runId": f"carried-run-{index}", "sourceTraceId": f"carried-trace-{index}"},
                "sources": {},
            }, sort_keys=True, indent=2).encode() + b"\n"
            bundle_sha = hashlib.sha256(bundle_raw).hexdigest()
            envelope = case_envelope(case_id, bundle_sha, f"carried-run-{index}")
            case_raw = json.dumps(envelope, sort_keys=True, indent=2).encode() + b"\n"
            members[f"staging/{bundle_name}"] = bundle_raw
            members[f"staging/{case_name}"] = case_raw
            manifest_rows.append({
                "case": case_name, "bundle": bundle_name, "caseId": case_id,
                "caseSha256": envelope["caseSha256"], "bundleSha256": bundle_sha,
                "label": "synthetic",
            })
            suite_rows.append({"case": case_name, "bundle": bundle_name})

        evaluator_raw = b'{"evaluator":"synthetic","schemaVersion":1}\n'
        suite_raw = json.dumps({"schemaVersion": 1, "cases": suite_rows}, sort_keys=True, indent=2).encode() + b"\n"
        manifest_raw = json.dumps({"schemaVersion": 1, "purpose": "synthetic carried gate", "cases": manifest_rows}, sort_keys=True, indent=2).encode() + b"\n"
        members.update({
            "staging/evaluator.json": evaluator_raw,
            "staging/manifest.json": manifest_raw,
            "staging/suite.json": suite_raw,
        })
        members["SHA256SUMS"] = "".join(
            f"{hashlib.sha256(members[name]).hexdigest()}  {name}\n" for name in sorted(members)
        ).encode()
        self.base_archive.write_bytes(module._archive_bytes(members))
        archive_sha = hashlib.sha256(self.base_archive.read_bytes()).hexdigest()
        self.base_pointer.write_text(json.dumps({
            "schemaVersion": 1, "purpose": "synthetic carried gate", "bucket": "synthetic-bucket",
            "s3Key": f"agent-evaluation/phase18/inputs/{archive_sha}/staging.tar.gz",
            "sha256": archive_sha, "suiteSha256": hashlib.sha256(suite_raw).hexdigest(),
            "evaluatorSha256": hashlib.sha256(evaluator_raw).hexdigest(), "caseIds": BASE_CASE_IDS,
        }, indent=2) + "\n")

        live_bundle_path = self.bridge_dir / "captured-bundle.json"
        live_bundle_path.write_text(json.dumps({
            "schemaVersion": 1,
            "origin": {"runId": RUN_ID, "sourceTraceId": TRACE_ID, "sessionId": SESSION_ID,
                        "accountId": "000000000000", "region": "us-east-1",
                        "alarmArn": "arn:aws:cloudwatch:us-east-1:000000000000:alarm:Synthetic",
                        "transitionAt": "2026-11-26T19:46:00.000Z"},
            "sources": {},
        }, sort_keys=True, indent=2) + "\n")
        live_bundle_sha = hashlib.sha256(live_bundle_path.read_bytes()).hexdigest()
        live_case_path = self.bridge_dir / "case.frozen.json"
        live_case_path.write_text(json.dumps(case_envelope(LIVE_CASE_ID, live_bundle_sha, RUN_ID, trace_id=TRACE_ID), sort_keys=True, indent=2) + "\n")
        live_case = json.loads(live_case_path.read_text())
        (self.bridge_dir / "bridge-manifest.json").write_text(json.dumps({
            "schemaVersion": 1, "kind": "native-case-bridge", "caseId": LIVE_CASE_ID,
            "caseSha256": live_case["caseSha256"], "bundleSha256": live_bundle_sha,
            "traceId": TRACE_ID, "sessionId": SESSION_ID, "runId": RUN_ID,
        }, indent=2) + "\n")


class PrepareLiveGateTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="prepare-live-gate-public-")
        self.root = Path(self.temp.name)
        self.module = load_cli_module()
        self.fixture = LiveGateFixture(self.root, self.module)
        self.output = self.root / "prepared"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _args(self, *, dry_run: bool = False) -> argparse.Namespace:
        return argparse.Namespace(
            bridge_manifest=self.fixture.bridge_dir / "bridge-manifest.json",
            case=self.fixture.bridge_dir / "case.frozen.json",
            bundle=self.fixture.bridge_dir / "captured-bundle.json",
            qualification_input=self.fixture.base_pointer,
            base_archive=self.fixture.base_archive,
            output_dir=self.output, archive_out=None, pointer_out=None,
            dry_run=dry_run, label="audience-denial", profile="synthetic-sso",
            region="us-east-1", expected_bucket_owner="000000000000",
        )

    def _prepare(self, *, dry_run: bool = False) -> dict:
        with mock.patch.object(self.module, "_load_reviewed_case_validator", return_value=None):
            return self.module.prepare(self._args(dry_run=dry_run))

    def test_prepare_preserves_four_rows_and_appends_exact_fifth_pair(self) -> None:
        result = self._prepare()
        self.assertEqual(result["status"], "prepared")
        self.assertEqual(result["caseIds"], BASE_CASE_IDS + [LIVE_CASE_ID])
        pointer = json.loads((self.output / "qualification-input.json").read_text())
        pointer_text = json.dumps(pointer)
        self.assertNotIn(TRACE_ID, pointer_text)
        self.assertNotIn(SESSION_ID, pointer_text)
        self.assertNotIn(RUN_ID, pointer_text)
        self.assertIn("--if-none-match", result["publishCommand"])
        with tarfile.open(self.output / "staging.tar.gz", "r:gz") as archive:
            manifest = json.load(archive.extractfile("staging/manifest.json"))
            suite = json.load(archive.extractfile("staging/suite.json"))
            mapping = json.load(archive.extractfile("staging/live-case-map.json"))
        self.assertEqual([row["caseId"] for row in manifest["cases"]], BASE_CASE_IDS + [LIVE_CASE_ID])
        self.assertEqual(len(suite["cases"]), 5)
        self.assertEqual(mapping["ci"]["caseId"], LIVE_CASE_ID)
        self.assertEqual(mapping["traceToCi"]["traceId"], TRACE_ID)

    def test_prepare_is_idempotent_and_dry_run_is_read_only(self) -> None:
        base_before = self.fixture.base_archive.read_bytes()
        first = self._prepare()
        archive_before_retry = (self.output / "staging.tar.gz").read_bytes()
        second = self._prepare()
        self.assertEqual(first["archiveSha256"], second["archiveSha256"])
        self.assertEqual(archive_before_retry, (self.output / "staging.tar.gz").read_bytes())
        self.assertEqual(base_before, self.fixture.base_archive.read_bytes())
        dry = self._prepare(dry_run=True)
        self.assertEqual(dry["status"], "dry-run")
        self.assertEqual(dry["externalWrites"], 0)
        self.assertIsNone(dry["archive"])

    def test_verify_rejects_archive_or_pointer_tampering(self) -> None:
        self._prepare()
        archive = self.output / "staging.tar.gz"
        pointer = self.output / "qualification-input.json"
        archive.write_bytes(archive.read_bytes() + b"tampered")
        completed = subprocess.run(["python3", str(CLI), "verify", "--archive", str(archive), "--pointer", str(pointer)], cwd=ROOT, capture_output=True, text=True, check=False)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("sha256", completed.stderr)

        shutil.rmtree(self.output)
        self._prepare()
        tampered_pointer = json.loads(pointer.read_text())
        tampered_pointer["caseIds"][-1] = "unexpected-case"
        pointer.write_text(json.dumps(tampered_pointer) + "\n")
        completed = subprocess.run(["python3", str(CLI), "verify", "--archive", str(archive), "--pointer", str(pointer)], cwd=ROOT, capture_output=True, text=True, check=False)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("roster", completed.stderr)

    def test_publish_command_is_local_only(self) -> None:
        result = self._prepare()
        completed = subprocess.run(["python3", str(CLI), "publish-command", "--archive", str(self.output / "staging.tar.gz"), "--pointer", str(self.output / "qualification-input.json")], cwd=ROOT, capture_output=True, text=True, check=False)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        payload = json.loads(completed.stdout)
        self.assertEqual(payload["externalWrites"], 0)
        self.assertIn(result["archiveSha256"], payload["publishCommand"])


if __name__ == "__main__":
    unittest.main()
