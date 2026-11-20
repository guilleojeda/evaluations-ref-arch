"""Acceptance for the immutable faulty-reference generation rotation.

These tests use the existing native-shaped Phase 19 transports.  They prove
that a schema-2 descriptor can replace the named faulty publication only from
its exact reviewed predecessor (or an exact new/partial retry), while a
healthy repeat remains a no-op and arbitrary live/table drift is rejected
before the first native write.
"""

from __future__ import annotations

import copy
from contextlib import ExitStack
import hashlib
import io
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import zipfile
import unittest
from unittest.mock import patch

if str(Path(__file__).parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).parent))
import phase19_faulty_reference_test as phase19  # noqa: E402


ROOT = Path(__file__).resolve().parents[1]
OPUS_MODEL_ID = "us.anthropic.claude-opus-5-5"
NEW_REVISION = "b" * 40


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def plain_item(item: dict[str, dict[str, str]]) -> dict[str, str]:
    return {key: value["S"] for key, value in item.items()}


class RotatingControl(phase19.NativeControl):
    """Keep the old live version while publishing new-version Runtime shapes."""

    def __init__(self, old_descriptor, new_descriptor, **kwargs):
        self.new_descriptor = new_descriptor
        super().__init__(old_descriptor, **kwargs)

    def _runtime(self, version: str, *, compatible: bool):
        selected = self.expected
        if compatible and version != "7":
            self.expected = self.new_descriptor
        try:
            return super()._runtime(version, compatible=compatible)
        finally:
            self.expected = selected


class ReferenceRotationAcceptance(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = phase19.FaultyReferenceAcceptance("runTest")
        with patch.object(phase19, "MODEL_ID", "us.anthropic.claude-sonnet-4-6"):
            self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)

        # Establish the complete old publication in the native-shaped fakes.
        old_control, old_adapter, old_controller = self.fixture._native(
            historical=True, endpoint_present=True,
        )
        old_adapter.environment = {
            "AGENT_RUNTIME_ARN": phase19.RUNTIME_ARN,
            "AGENT_ALARM_ARN": phase19.ALARM_ARN,
            "AGENT_SELECTION_TABLE": phase19.TABLE_NAME,
        }
        old_adapter.config["Environment"] = {"Variables": copy.deepcopy(old_adapter.environment)}
        old_module = self.fixture._load()
        self._call(old_module, old_control, old_adapter, old_controller)
        self.old_row = copy.deepcopy(old_controller.items[phase19.PUBLICATION_PK])
        self.old_endpoint = copy.deepcopy(old_control.endpoints["faulty"])
        self.old_descriptor = copy.deepcopy(self.fixture.descriptor)

        self.new_descriptor, new_objects = self._new_descriptor(self.old_descriptor)
        self.fixture.scripts.joinpath("faulty-reference.json").write_text(
            json.dumps(self.new_descriptor, sort_keys=True) + "\n",
        )
        self.fixture.descriptor = self.new_descriptor

        self.control = RotatingControl(
            self.old_descriptor,
            self.new_descriptor,
            historical=True,
            endpoint_present=True,
            endpoint_update_allowed=True,
        )
        self.adapter = phase19.NativeLambda()
        self.adapter.environment = {
            "AGENT_RUNTIME_ARN": phase19.RUNTIME_ARN,
            "AGENT_ALARM_ARN": phase19.ALARM_ARN,
            "AGENT_SELECTION_TABLE": phase19.TABLE_NAME,
        }
        self.adapter.config["Environment"] = {"Variables": copy.deepcopy(self.adapter.environment)}
        self.controller = phase19.NativeController()
        self.controller.items[phase19.PUBLICATION_PK] = copy.deepcopy(self.old_row)
        self.cloudformation = phase19.NativeCloudFormation()
        objects = copy.deepcopy(self.fixture.s3.objects)
        objects.update(new_objects)
        self.s3 = phase19.NativeS3(objects)

    def _new_descriptor(self, old_descriptor):
        source = (ROOT / "agent/prompt.py").read_bytes() + b"\n# Opus 5.5 rotation fixture\n"
        prompt_sha = sha256(source)
        manifest = json.loads((ROOT / "agent/agent-manifest.json").read_text())
        manifest["sourceRevision"] = NEW_REVISION
        manifest["promptSha256"] = prompt_sha
        manifest_bytes = (json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n").encode()
        archive_io = io.BytesIO()
        with zipfile.ZipFile(archive_io, "w", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr("agent-manifest.json", manifest_bytes)
            archive.writestr("prompt.py", source)
        archive = archive_io.getvalue()
        artifact_sha = sha256(archive)
        environment = copy.deepcopy(old_descriptor["runtimeEnvironment"])
        environment.update({
            "AGENT_MODEL_ID": OPUS_MODEL_ID,
            "AGENT_SOURCE_REVISION": NEW_REVISION,
            "AGENT_ARTIFACT_SHA256": artifact_sha,
        })
        configuration = copy.deepcopy(old_descriptor["runtimeConfiguration"])
        configuration["environmentVariables"] = environment
        configuration["agentRuntimeArtifact"]["codeConfiguration"]["code"]["s3"] = {
            "bucket": old_descriptor["artifact"]["bucket"],
            "prefix": f"agent-reference/{artifact_sha}.zip",
            "versionId": "opus-artifact-v1",
        }
        configuration_bytes = (json.dumps(configuration, sort_keys=True, separators=(",", ":")) + "\n").encode()
        bucket = old_descriptor["artifact"]["bucket"]
        artifact_key = f"agent-reference/{artifact_sha}.zip"
        source_key = f"agent-reference/{prompt_sha}.py"
        configuration_key = f"agent-reference/{sha256(configuration_bytes)}.json"
        descriptor = copy.deepcopy(old_descriptor)
        descriptor.update({
            "schemaVersion": 2,
            "artifact": {"bucket": bucket, "key": artifact_key, "versionId": "opus-artifact-v1", "sha256": artifact_sha},
            "source": {"bucket": bucket, "key": source_key, "versionId": "opus-source-v1", "sha256": prompt_sha},
            "configuration": {"bucket": bucket, "key": configuration_key, "versionId": "opus-config-v1", "sha256": sha256(configuration_bytes)},
            "sourceRevision": NEW_REVISION,
            "promptSha256": prompt_sha,
            "modelId": OPUS_MODEL_ID,
            "runtimeEnvironment": environment,
            "runtimeConfiguration": configuration,
            "predecessor": {
                "publication": plain_item(self.old_row),
                "endpoint": self.old_endpoint,
                "publicationSha256": sha256(json.dumps(
                    plain_item(self.old_row), sort_keys=True, separators=(",", ":")
                ).encode()),
            },
        })
        return descriptor, {
            (bucket, artifact_key, "opus-artifact-v1"): archive,
            (bucket, source_key, "opus-source-v1"): source,
            (bucket, configuration_key, "opus-config-v1"): configuration_bytes,
        }

    def _call(self, module, control, adapter, controller):
        session = phase19.NativeSession(self.s3 if hasattr(self, "s3") else self.fixture.s3, control, adapter, controller, self.fixture.cloudformation)
        with ExitStack() as stack:
            stack.enter_context(patch.object(module.time, "sleep", return_value=None))
            return module.setup_faulty_reference(session)

    def _module(self):
        return self.fixture._load()

    def test_reviewed_predecessor_rotates_endpoint_and_publication(self):
        # The native read contains SDK dates as well as the endpoint identity.
        self.control.endpoints["faulty"]["createdAt"] = datetime(2026, 1, 1, tzinfo=timezone.utc)
        result = self._call(self._module(), self.control, self.adapter, self.controller)

        json.dumps(result)
        self.assertNotIn("createdAt", result["referenceGeneration"]["observedEndpoint"])
        self.assertEqual("predecessor", result["referenceGeneration"]["mode"])
        self.assertEqual(self.new_descriptor["predecessor"], result["historicalSnapshot"])
        self.assertEqual(OPUS_MODEL_ID, self.controller.items[phase19.PUBLICATION_PK]["modelId"]["S"])
        self.assertEqual(1, len(self.control.runtime_updates))
        self.assertEqual(1, len(self.control.endpoint_updates))
        self.assertEqual("10", self.control.endpoints["faulty"]["liveVersion"])
        self.assertEqual("10", self.controller.items[phase19.PUBLICATION_PK]["runtimeVersion"]["S"])
        self.assertEqual(
            self.new_descriptor["runtimeConfiguration"]["environmentVariables"],
            self.control.runtimes["10"]["environmentVariables"],
        )
        self.assertEqual(
            self.new_descriptor["runtimeConfiguration"]["agentRuntimeArtifact"],
            self.control.runtimes["10"]["agentRuntimeArtifact"],
        )
        self.assertEqual(
            self.new_descriptor["configuration"]["sha256"],
            self.controller.items[phase19.PUBLICATION_PK]["configurationSha256"]["S"],
        )

    def test_clean_archive_can_seed_empty_endpoint_and_publication(self):
        self.control.endpoints.clear()
        self.controller.items.clear()

        result = self._call(self._module(), self.control, self.adapter, self.controller)

        self.assertEqual("greenfield", result["referenceGeneration"]["mode"])
        self.assertEqual(1, len(self.control.runtime_updates))
        self.assertEqual(1, len(self.control.endpoint_creates))
        self.assertEqual(OPUS_MODEL_ID, self.controller.items[phase19.PUBLICATION_PK]["modelId"]["S"])
        self.assertEqual("10", self.control.endpoints["faulty"]["liveVersion"])

    def test_endpoint_creation_lost_response_resumes_with_empty_publication(self):
        self.control.endpoints.clear()
        self.controller.items.clear()
        self.control.endpoint_create_lost = True

        with self.assertRaisesRegex(RuntimeError, "create response lost"):
            self._call(self._module(), self.control, self.adapter, self.controller)
        self.assertNotIn(phase19.PUBLICATION_PK, self.controller.items)
        self.assertEqual("10", self.control.endpoints["faulty"]["liveVersion"])

        result = self._call(self._module(), self.control, self.adapter, self.controller)

        self.assertEqual("endpoint-advanced-empty", result["referenceGeneration"]["mode"])
        self.assertEqual(1, len(self.control.runtime_updates))
        self.assertEqual(1, len(self.control.endpoint_creates))
        self.assertEqual(OPUS_MODEL_ID, self.controller.items[phase19.PUBLICATION_PK]["modelId"]["S"])

    def test_old_endpoint_without_publication_is_a_conflicting_remnant(self):
        self.controller.items.clear()

        with self.assertRaisesRegex(RuntimeError, "without a reviewed publication"):
            self._call(self._module(), self.control, self.adapter, self.controller)

        self.assertFalse(self.control.runtime_updates)
        self.assertFalse(self.control.endpoint_updates)

    def test_old_publication_without_endpoint_is_a_conflicting_remnant(self):
        self.control.endpoints.clear()

        with self.assertRaisesRegex(RuntimeError, "exists without its endpoint"):
            self._call(self._module(), self.control, self.adapter, self.controller)

        self.assertFalse(self.control.runtime_updates)
        self.assertFalse(self.control.endpoint_creates)

    def test_new_tuple_repeat_is_idempotent(self):
        self._call(self._module(), self.control, self.adapter, self.controller)
        before_row = copy.deepcopy(self.controller.items[phase19.PUBLICATION_PK])
        before_runtime_updates = len(self.control.runtime_updates)
        before_endpoint_updates = len(self.control.endpoint_updates)
        before_puts = len([call for call in self.controller.calls if call[0] == "put_item"])

        result = self._call(self._module(), self.control, self.adapter, self.controller)

        self.assertEqual("new", result["referenceGeneration"]["mode"])
        self.assertEqual(before_row, self.controller.items[phase19.PUBLICATION_PK])
        self.assertEqual(before_runtime_updates, len(self.control.runtime_updates))
        self.assertEqual(before_endpoint_updates, len(self.control.endpoint_updates))
        self.assertEqual(before_puts, len([call for call in self.controller.calls if call[0] == "put_item"]))

    def test_arbitrary_publication_conflict_is_rejected_before_native_writes(self):
        self.controller.items[phase19.PUBLICATION_PK]["sourceRevision"] = {"S": "c" * 40}
        module = self._module()

        with self.assertRaisesRegex(RuntimeError, "predecessor or new tuple"):
            self._call(module, self.control, self.adapter, self.controller)

        self.assertFalse(self.control.runtime_updates)
        self.assertFalse(self.control.endpoint_updates)
        self.assertFalse(self.adapter.updates)
        self.assertEqual(1, len([call for call in self.controller.calls if call[0] == "get_item"]))

    def test_endpoint_and_publication_must_both_match_reviewed_predecessor(self):
        self.controller.items[phase19.PUBLICATION_PK]["modelId"] = {"S": OPUS_MODEL_ID}
        module = self._module()

        with self.assertRaisesRegex(RuntimeError, "predecessor or new tuple"):
            self._call(module, self.control, self.adapter, self.controller)

        self.assertFalse(self.control.runtime_updates)
        self.assertFalse(self.control.endpoint_updates)


if __name__ == "__main__":
    unittest.main()
