"""Command-line acceptance for the private Phase 22 session-input index.

The fixture follows the fields in the maintained ``session-roster.json`` under
``.work/incident-triage-demo/phase22-private/stage-assets-full`` but keeps the
bytes small and local.  These tests exercise the public command, rather than
importing its implementation, and do not contact AWS or a remote Git host.
"""

from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
import shutil


ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts" / "talk-inputs.py"
FIXED_CASE_IDS = [
    "phase14.inventory-capacity-overload.prepared",
    "phase14.denied-inventory-read.prepared",
    "phase14.recovery-with-old-alert.prepared",
]
AUDIENCE_CASE_ID = "phase14.denied-inventory-read.session-draft"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class SessionInputFixture:
    """Write a minimal roster and canonical carried/stock gate archives."""

    def __init__(self, root: Path) -> None:
        self.root = root / "session-a"
        self.root.mkdir(parents=True)
        self.roster_path = self.root / "session-roster.json"
        self.binding_path = self.root / "live-release-binding.json"
        self.fixed_case_sha = {
            case_id: chr(ord("a") + index) * 64
            for index, case_id in enumerate(FIXED_CASE_IDS)
        }
        self.fixed_bundle_sha = {
            case_id: chr(ord("d") + index) * 64
            for index, case_id in enumerate(FIXED_CASE_IDS)
        }
        bundle_value = {"schemaVersion": 1, "bundle": "fixture-denial"}
        self.audience_bundle_sha = hashlib.sha256((json.dumps(bundle_value, sort_keys=True) + "\n").encode("utf-8")).hexdigest()
        self.fixed_bundle_sha[FIXED_CASE_IDS[1]] = self.audience_bundle_sha
        self.audience_case = {
            "caseId": AUDIENCE_CASE_ID,
            "task": {"referenceTime": "2026-11-16T03:02:30.000Z"},
            "evidence": {
                "bundleSha256": self.audience_bundle_sha,
                "originatingRunId": "run-fixture",
                "references": [],
            },
        }
        self.audience_case_sha = hashlib.sha256(
            json.dumps(
                self.audience_case,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        self.evaluator_sha = ""  # Filled after s2/evaluator.json is written.
        self.carried_suite_sha = "c" * 64
        self.stock_suite_sha = "b" * 64
        self._write("s2/capture-receipt.json", {"schemaVersion": 1, "stage": "S0"})
        self._write(
            "audience/denial-session.frozen.json",
            {
                "schemaVersion": 1,
                "caseSha256": self.audience_case_sha,
                "case": self.audience_case,
            },
        )
        self._write("prepared/denial.json", bundle_value)
        self._write("prepared/denial.frozen.json", {"schemaVersion": 1, "prepared": True})
        self._write("prepared/validation.json", {"schemaVersion": 1, "valid": True})
        self._write("s2/evaluator.json", {"evaluatorId": "fixture-evaluator"})
        self.evaluator_sha = sha256(self.root / "s2/evaluator.json")
        self._write(
            "s2/run/execution-fixture/execution.json",
            {
                "identity": {
                    "executionId": "execution-fixture",
                    "caseSha256": self.fixed_case_sha[FIXED_CASE_IDS[1]],
                    "bundleSha256": self.fixed_bundle_sha[FIXED_CASE_IDS[1]],
                }
            },
        )
        self._write(
            "s2/score-result.json",
            {"executionId": "execution-fixture", "scoringAttemptId": "score-fixture"},
        )
        self._write("s3/offline-comparison.json", {"stage": "S3"})
        self._write("s4/comparison.json", {"stage": "S4"})
        self._write_gate_archives()
        self._write_roster()

    def _write(self, relative: str, value: object) -> None:
        target = self.root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(value, str):
            target.write_text(value, encoding="utf-8")
        else:
            target.write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")

    def _write_archive(self, relative: str, rows: list[dict[str, object]], evaluator: dict[str, object]) -> str:
        target = self.root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        manifest = json.dumps({"schemaVersion": 1, "cases": rows}, sort_keys=True).encode()
        evaluator_bytes = (json.dumps(evaluator, sort_keys=True) + "\n").encode()
        with tarfile.open(target, "w:gz") as archive:
            for name, content in (
                ("staging/manifest.json", manifest),
                ("staging/evaluator.json", evaluator_bytes),
            ):
                info = tarfile.TarInfo(name)
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
        return sha256(target)

    def _write_gate_archives(self) -> None:
        evaluator = {
            "evaluatorId": "fixture-evaluator",
            "configuration": {"evaluatorArn": "arn:fixture:evaluator"},
            "configSha256": "f" * 64,
            "status": "recorded-active",
        }
        evaluator_bytes = (json.dumps(evaluator, sort_keys=True) + "\n").encode()
        # The selected gate archive, rather than s2/evaluator.json, is the
        # source of truth for the evaluator identity used by later stages.
        self.evaluator_sha = hashlib.sha256(evaluator_bytes).hexdigest()
        fixed_rows = [
            {
                "caseId": case_id,
                "caseSha256": self.fixed_case_sha[case_id],
                "bundleSha256": self.fixed_bundle_sha[case_id],
                "case": f"prepared/{case_id}.json",
                "bundle": f"prepared/{case_id}.tar.gz",
                "referenceTime": "2026-11-15T00:00:00.000Z",
            }
            for case_id in FIXED_CASE_IDS
        ]
        audience_row = {
            "caseId": AUDIENCE_CASE_ID,
            "caseSha256": self.audience_case_sha,
            "bundleSha256": self.audience_bundle_sha,
            "case": "audience/denial-session.frozen.json",
            "bundle": "audience/denial-session.bundle.tar.gz",
            "referenceTime": "2026-11-16T03:02:30.000Z",
        }
        carried_sha = self._write_archive(
            "gate/staging.tar.gz", fixed_rows + [audience_row], evaluator
        )
        stock_sha = self._write_archive("gate/stock-staging.tar.gz", fixed_rows, evaluator)
        self._write(
            "gate/qualification-input.json",
            {
                "schemaVersion": 1,
                "purpose": "phase22-qualification-input",
                "bucket": "fixture-bucket",
                "s3Key": f"agent-evaluation/phase18/inputs/{carried_sha}/staging.tar.gz",
                "sha256": carried_sha,
                "suiteSha256": self.carried_suite_sha,
                "evaluatorSha256": self.evaluator_sha,
                "caseIds": FIXED_CASE_IDS + [AUDIENCE_CASE_ID],
            },
        )
        self._write(
            "gate/stock-qualification-input.json",
            {
                "schemaVersion": 1,
                "purpose": "phase22-qualification-input",
                "bucket": "fixture-bucket",
                "s3Key": f"agent-evaluation/phase18/inputs/{stock_sha}/staging.tar.gz",
                "sha256": stock_sha,
                "suiteSha256": self.stock_suite_sha,
                "evaluatorSha256": self.evaluator_sha,
                "caseIds": FIXED_CASE_IDS,
            },
        )
        self.carried_archive_sha = carried_sha
        self.stock_archive_sha = stock_sha

    def _write_roster(self) -> None:
        stage_inputs = {
            "S0": ["s2/capture-receipt.json"],
            "S1": ["audience/denial-session.frozen.json", "prepared/denial.json"],
            "S2": [
                "gate/qualification-input.json",
                "gate/staging.tar.gz",
                "s2/run/execution-fixture",
                "s2/score-result.json",
            ],
            "S3": [
                "gate/staging.tar.gz",
                "audience/denial-session.frozen.json",
                "prepared/denial.json",
                "s3/offline-comparison.json",
            ],
            "S4": ["gate/staging.tar.gz", "s4/comparison.json"],
            "S5": [
                "gate/qualification-input.json",
                "gate/staging.tar.gz",
                "gate/import-check.json",
                "prepared/validation.json",
                "audience/denial-session.frozen.json",
            ],
        }
        self._write("gate/import-check.json", {"schemaVersion": 1, "checked": True})
        self.roster = {
            "schemaVersion": 1,
            "sessionId": "phase22-fixture-session",
            "generation": "talk/v1",
            "assetRoot": ".",
            "audienceCase": {
                "caseId": AUDIENCE_CASE_ID,
                "caseSha256": self.audience_case_sha,
                "bundleSha256": self.audience_bundle_sha,
            },
            "gate": {
                "archive": "gate/staging.tar.gz",
                "archiveSha256": self.carried_archive_sha,
                "suiteSha256": self.carried_suite_sha,
                "fixedDenialCaseId": FIXED_CASE_IDS[1],
                "caseIds": FIXED_CASE_IDS + [AUDIENCE_CASE_ID],
            },
            "stages": {
                stage: {
                    "candidateId": None,
                    "inputs": paths,
                    "checkpointTag": f"talk/v1/{stage}",
                    "sourceAnchor": f"{stage.lower()}-fixture-anchor",
                }
                for stage, paths in stage_inputs.items()
            },
        }
        selected_digests = {
            path: self._selected_digest(path)
            for paths in stage_inputs.values()
            for path in paths
        }
        for path in (
            "gate/stock-qualification-input.json",
            "gate/stock-staging.tar.gz",
            "prepared/denial.frozen.json",
        ):
            selected_digests[path] = self._selected_digest(path)
        self.roster["selectedDigests"] = selected_digests
        self.roster_path.write_text(json.dumps(self.roster, indent=2) + "\n", encoding="utf-8")

    def _selected_digest(self, relative: str) -> str:
        target = self.root / relative
        if target.is_file():
            return sha256(target)
        records = []
        for child in sorted(target.rglob("*")):
            if child.is_file():
                records.append(
                    f"{sha256(child)}  {child.relative_to(target).as_posix()}\n"
                )
        return hashlib.sha256("".join(records).encode()).hexdigest()

    def binding(self, suite: str = "stock") -> dict[str, object]:
        revision = "a" * 40
        manifest_sha = "2" * 64
        pointer_sha = "3" * 64
        selected_suite_sha = self.stock_suite_sha if suite == "stock" else self.carried_suite_sha
        selected_archive_sha = self.stock_archive_sha if suite == "stock" else self.carried_archive_sha
        selected_case_ids = FIXED_CASE_IDS if suite == "stock" else FIXED_CASE_IDS + [AUDIENCE_CASE_ID]
        publication_tuple = {
            "endpointName": "fixture-endpoint",
            "endpointArn": "arn:fixture:endpoint",
            "runtimeArn": "arn:fixture:runtime",
            "runtimeVersion": "fixture-runtime",
            "artifactSha256": "d" * 64,
            "artifactVersionId": "fixture-artifact",
            "configurationSha256": "e" * 64,
            "sourceSha256": "1" * 64,
            "promptSha256": "f" * 64,
        }
        demo_deploy = {
            "branch": "demo-deploy",
            "qualifiedCommit": revision,
            "candidateId": "repaired",
            "publicationId": "fixture-publication",
            "sourceRevision": revision,
            "remoteTip": revision,
            "qualificationManifestSha256": manifest_sha,
            "suiteSha256": selected_suite_sha,
            "evaluatorSha256": self.evaluator_sha,
            **publication_tuple,
        }
        publication = {
            "candidateId": "repaired",
            "sourceRevision": revision,
            "modelId": "fixture-model",
            **publication_tuple,
        }
        receipt = {
            "bucket": "fixture-bucket",
            "key": "fixture/receipt.json",
            "sha256": pointer_sha,
            "status": "review_required",
            "sourceRevision": revision,
            "manifestSha256": manifest_sha,
            "suiteSha256": selected_suite_sha,
            "evaluatorSha256": self.evaluator_sha,
            "caseIds": selected_case_ids,
            **{
                field: publication_tuple[field]
                for field in (
                    "artifactSha256",
                    "sourceSha256",
                    "configurationSha256",
                    "promptSha256",
                )
            },
        }
        review_manifest = {
            "bucket": "fixture-bucket",
            "key": "fixture/manifest.json",
            "sha256": manifest_sha,
            "artifactSha256": publication_tuple["artifactSha256"],
            "suiteSha256": selected_suite_sha,
            "evaluatorSha256": self.evaluator_sha,
            "caseIds": selected_case_ids,
            "reportCount": 3,
        }
        approval = {
            "runId": "fixture-run",
            "reviewer": "fixture-reviewer",
            "reviewerId": "fixture-reviewer-id",
            "environment": "repaired-publication",
            "environmentId": "fixture-environment",
            "comment": "approved fixture",
            "state": "approved",
            "headSha": revision,
        }
        qualification = {
            "receipt": receipt,
            "reviewManifest": review_manifest,
            "humanReview": {
                "status": "approved",
                "environment": "repaired-publication",
                "reviewer": "fixture-reviewer",
                "runId": "fixture-run",
                "manifestSha256": manifest_sha,
                "approval": approval,
            },
            "inputPointer": {
                "schemaVersion": 1,
                "purpose": "phase22-qualification-input",
                "bucket": "fixture-bucket",
                "s3Key": f"agent-evaluation/phase18/inputs/{selected_archive_sha}/staging.tar.gz",
                "sha256": selected_archive_sha,
                "suiteSha256": selected_suite_sha,
                "evaluatorSha256": self.evaluator_sha,
                "caseIds": selected_case_ids,
            },
        }
        return {
            "schemaVersion": 1,
            "kind": "phase22-s5-qualification-binding",
            "checkedAt": "2026-11-18T00:00:00.000Z",
            "demoDeploy": demo_deploy,
            "remote": {
                "repository": "fixture/repository",
                "branch": "demo-deploy",
                "gitTip": revision,
                "githubTip": revision,
                "pointerPath": "fixture/pointer.json",
                "pointerSha256": pointer_sha,
            },
            "publication": publication,
            "qualification": qualification,
        }

    def write_binding(self, value: dict[str, object] | None = None) -> None:
        self.binding_path.write_text(
            json.dumps(value if value is not None else self.binding(), indent=2) + "\n",
            encoding="utf-8",
        )


class SessionInputCommandTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="phase22-session-inputs-")
        self.fixture = SessionInputFixture(Path(self.temp.name))

    def tearDown(self) -> None:
        self.temp.cleanup()

    def run_cli(self, *, stage: str | None = None, suite: str = "carried", binding: bool = False) -> subprocess.CompletedProcess[str]:
        output = Path(self.temp.name) / f"output-{stage or 'all'}-{suite}.json"
        command = [
            sys.executable,
            str(CLI),
            "build",
            "--roster",
            str(self.fixture.roster_path),
            "--output",
            str(output),
            "--suite",
            suite,
        ]
        if stage:
            command.extend(("--stage", stage))
        if binding:
            command.extend(("--live-release-binding", str(self.fixture.binding_path)))
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, check=False)
        if result.returncode == 0:
            result.output_json = json.loads(output.read_text(encoding="utf-8"))  # type: ignore[attr-defined]
        return result

    def test_s0_is_independent_with_minimal_actual_contract_roster(self) -> None:
        result = self.run_cli(stage="S0")
        self.assertEqual(result.returncode, 0, result.stderr)
        identity = result.output_json["stages"]["S0"]  # type: ignore[attr-defined]
        self.assertEqual(identity["candidateId"], "faulty")
        self.assertEqual(identity["caseIds"], [])
        self.assertIsNone(identity["gateArchiveSha256"])
        self.assertEqual(identity["paths"], ["s2/capture-receipt.json"])

    def test_s1_uses_the_frozen_authenticated_cutoff_without_a_gate(self) -> None:
        result = self.run_cli(stage="S1")
        self.assertEqual(result.returncode, 0, result.stderr)
        identity = result.output_json["stages"]["S1"]  # type: ignore[attr-defined]
        self.assertEqual(identity["caseIds"], [AUDIENCE_CASE_ID])
        self.assertEqual(identity["cutoff"], "2026-11-16T03:02:30.000Z")
        self.assertEqual(identity["bundleSha256s"], [self.fixture.audience_bundle_sha])
        self.assertIsNone(identity["gateArchiveSha256"])

    def test_s1_rejects_missing_declared_bundle(self) -> None:
        (self.fixture.root / "prepared/denial.json").unlink()
        result = self.run_cli(stage="S1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("prepared/denial.json", result.stderr)

    def test_s1_rejects_declared_bundle_that_does_not_match_frozen_case(self) -> None:
        bundle = self.fixture.root / "prepared/denial.json"
        bundle.write_text('{"schemaVersion":1,"bundle":"tampered"}\n', encoding="utf-8")
        self.fixture.roster["selectedDigests"]["prepared/denial.json"] = sha256(bundle)  # type: ignore[index]
        self.fixture.roster_path.write_text(json.dumps(self.fixture.roster, indent=2) + "\n", encoding="utf-8")
        result = self.run_cli(stage="S1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("requested bundle digest differs", result.stderr)

    def test_carried_and_stock_use_their_matching_roster_and_manifest_fields(self) -> None:
        carried = self.run_cli(stage="S3", suite="carried")
        stock = self.run_cli(stage="S3", suite="stock")
        self.assertEqual(carried.returncode, 0, carried.stderr)
        self.assertEqual(stock.returncode, 0, stock.stderr)
        carried_identity = carried.output_json["stages"]["S3"]  # type: ignore[attr-defined]
        stock_identity = stock.output_json["stages"]["S3"]  # type: ignore[attr-defined]
        self.assertEqual(carried_identity["caseIds"], [AUDIENCE_CASE_ID])
        self.assertEqual(stock_identity["caseIds"], [FIXED_CASE_IDS[1]])
        self.assertEqual(carried_identity["gateArchiveSha256"], self.fixture.carried_archive_sha)
        self.assertEqual(stock_identity["gateArchiveSha256"], self.fixture.stock_archive_sha)
        self.assertEqual(carried_identity["paths"][0], "gate/staging.tar.gz")
        self.assertEqual(stock_identity["paths"][0], "gate/stock-staging.tar.gz")
        self.assertIn("audience/denial-session.frozen.json", carried_identity["paths"])
        self.assertIn("prepared/denial.frozen.json", stock_identity["paths"])
        self.assertEqual(carried.output_json["suiteMode"], "carried")  # type: ignore[attr-defined]
        self.assertEqual(stock.output_json["suiteMode"], "stock")  # type: ignore[attr-defined]

    def test_s2_direct_entry_does_not_require_the_unselected_s1_frozen_file(self) -> None:
        (self.fixture.root / "audience/denial-session.frozen.json").unlink()
        result = self.run_cli(stage="S2", suite="carried")
        self.assertEqual(result.returncode, 0, result.stderr)
        identity = result.output_json["stages"]["S2"]  # type: ignore[attr-defined]
        self.assertEqual(identity["caseIds"], [FIXED_CASE_IDS[1]])
        self.assertNotIn("audience/denial-session.frozen.json", identity["paths"])

    def test_stock_s3_direct_entry_does_not_require_the_unselected_s1_frozen_file(self) -> None:
        (self.fixture.root / "audience/denial-session.frozen.json").unlink()
        result = self.run_cli(stage="S3", suite="stock")
        self.assertEqual(result.returncode, 0, result.stderr)
        identity = result.output_json["stages"]["S3"]  # type: ignore[attr-defined]
        self.assertEqual(identity["caseIds"], [FIXED_CASE_IDS[1]])
        self.assertIn("prepared/denial.frozen.json", identity["paths"])
        self.assertNotIn("audience/denial-session.frozen.json", identity["paths"])

    def test_carried_gate_row_contradiction_is_rejected_before_stage_identity(self) -> None:
        source = self.fixture.root / "gate/staging.tar.gz"
        replacement = self.fixture.root / "gate/staging-contradictory.tar.gz"
        with tarfile.open(source, "r:gz") as incoming, tarfile.open(replacement, "w:gz") as outgoing:
            for member in incoming.getmembers():
                data = incoming.extractfile(member).read() if member.isfile() else None
                if member.name == "staging/manifest.json":
                    manifest = json.loads(data)
                    for row in manifest["cases"]:
                        if row["caseId"] == AUDIENCE_CASE_ID:
                            row["caseSha256"] = "f" * 64
                    data = json.dumps(manifest, sort_keys=True).encode()
                    member.size = len(data)
                if data is not None:
                    outgoing.addfile(member, io.BytesIO(data))
        replacement_sha = sha256(replacement)
        source.unlink()
        replacement.rename(source)
        self.fixture.roster["gate"]["archiveSha256"] = replacement_sha  # type: ignore[index]
        pointer = json.loads((self.fixture.root / "gate/qualification-input.json").read_text(encoding="utf-8"))
        pointer["sha256"] = replacement_sha
        pointer["s3Key"] = f"agent-evaluation/phase18/inputs/{replacement_sha}/staging.tar.gz"
        (self.fixture.root / "gate/qualification-input.json").write_text(json.dumps(pointer) + "\n", encoding="utf-8")
        self.fixture.roster["selectedDigests"]["gate/staging.tar.gz"] = replacement_sha  # type: ignore[index]
        self.fixture.roster_path.write_text(json.dumps(self.fixture.roster, indent=2) + "\n", encoding="utf-8")
        result = self.run_cli(stage="S3", suite="carried")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("audience case identity differs", result.stderr)

    def test_stock_all_stage_keeps_s1_audience_identity_outside_stock_gate_rows(self) -> None:
        self.fixture.write_binding()
        result = self.run_cli(suite="stock", binding=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        identity = result.output_json["stages"]["S1"]  # type: ignore[attr-defined]
        self.assertEqual(identity["caseIds"], [AUDIENCE_CASE_ID])
        self.assertEqual(identity["cutoff"], "2026-11-16T03:02:30.000Z")
        self.assertEqual(result.output_json["stages"]["S5"]["caseIds"], FIXED_CASE_IDS)  # type: ignore[attr-defined]

    def test_s5_rejects_qualified_source_revision_mismatch(self) -> None:
        binding = self.fixture.binding()
        valid = self.run_cli(stage="S5", suite="stock", binding=False)
        self.assertNotEqual(valid.returncode, 0)
        self.fixture.write_binding(binding)
        accepted = self.run_cli(stage="S5", suite="stock", binding=True)
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        binding["demoDeploy"]["sourceRevision"] = "b" * 40  # type: ignore[index]
        self.fixture.write_binding(binding)
        rejected = self.run_cli(stage="S5", suite="stock", binding=True)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("source/remote identity", rejected.stderr)

    def test_stock_s5_accepts_receipt_and_manifest_case_order_when_membership_matches(self) -> None:
        binding = self.fixture.binding("stock")
        qualification = binding["qualification"]  # type: ignore[index]
        qualification["receipt"]["caseIds"] = [FIXED_CASE_IDS[1], FIXED_CASE_IDS[0], FIXED_CASE_IDS[2]]  # type: ignore[index]
        qualification["reviewManifest"]["caseIds"] = [FIXED_CASE_IDS[1], FIXED_CASE_IDS[0], FIXED_CASE_IDS[2]]  # type: ignore[index]
        self.fixture.write_binding(binding)
        result = self.run_cli(stage="S5", suite="stock", binding=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_each_direct_stage_survives_without_other_stage_exclusive_directories(self) -> None:
        matrix = {
            ("S0", "carried"): {"audience", "gate", "prepared", "s3", "s4"},
            ("S0", "stock"): {"audience", "gate", "prepared", "s3", "s4"},
            ("S1", "carried"): {"gate", "s2", "s3", "s4"},
            ("S1", "stock"): {"gate", "s2", "s3", "s4"},
            ("S2", "carried"): {"audience", "s3", "s4"},
            ("S2", "stock"): {"audience", "s3", "s4"},
            ("S3", "carried"): {"s2", "s4"},
            ("S3", "stock"): {"audience", "s2", "s4"},
            ("S4", "carried"): {"audience", "prepared", "s2", "s3"},
            ("S4", "stock"): {"audience", "prepared", "s2", "s3"},
            ("S5", "carried"): {"s2", "s3", "s4"},
            ("S5", "stock"): {"audience", "s2", "s3", "s4"},
        }
        for (stage, suite), removed in matrix.items():
            with self.subTest(stage=stage, suite=suite):
                fixture = SessionInputFixture(Path(self.temp.name) / f"isolated-{stage}-{suite}")
                for directory in removed:
                    shutil.rmtree(fixture.root / directory)
                if stage == "S5":
                    fixture.write_binding(fixture.binding(suite))
                output = fixture.root / "isolated-output.json"
                command = [sys.executable, str(CLI), "build", "--roster", str(fixture.roster_path), "--output", str(output), "--suite", suite, "--stage", stage]
                if stage == "S5":
                    command.extend(("--live-release-binding", str(fixture.binding_path)))
                result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
