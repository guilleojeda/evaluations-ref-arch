"""Acceptance for restoring the fixed faulty reference with selection live.

Phase 19 proves the original faulty-reference setup in isolation.  Phase 21
adds the selected-publication boundary: the alarm adapter is a static router,
so restoring the historical faulty publication must not retarget that router
or disturb a currently selected repaired publication.

The test keeps the Phase 19 native-shaped transports and calls the maintenance
module's public ``setup_faulty_reference`` entry.  Only the transports are fakes;
the descriptor, source bytes, archive bytes, and publication code remain the
production inputs copied into the disposable installation by the Phase 19
fixture.
"""

from __future__ import annotations

import copy
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
TESTS_DIR = ROOT / "tests"
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

import phase19_faulty_reference_test as phase19  # noqa: E402


ADAPTER_ARN = phase19.ADAPTER_ARN
ALARM_ARN = phase19.ALARM_ARN
MODEL_ID = phase19.MODEL_ID
PUBLICATION_PK = phase19.PUBLICATION_PK
RUNTIME_ARN = phase19.RUNTIME_ARN
TABLE_NAME = phase19.TABLE_NAME
attr = phase19.attr


SELECTION_PK = "AGENT_SELECTION"
REPAIRED_PK = "AGENT_PUBLICATION#repaired"
REPAIRED_VERSION = "20"
REPAIRED_ARTIFACT_SHA256 = "c" * 64
REPAIRED_SOURCE_REVISION = "d" * 40
SELECTION_TABLE_ENV = "AGENT_SELECTION_TABLE"


class StaticSelectorReferenceAcceptance(unittest.TestCase):
    """Reuse Phase 19 fixtures while exercising the Phase 21 boundary."""

    def setUp(self) -> None:
        # Compose the Phase 19 fixture instead of inheriting its test methods;
        # this keeps this file focused on the selected-publication contract
        # while retaining the exact native transports and archive setup.
        self.phase19 = phase19.FaultyReferenceAcceptance("runTest")
        self.phase19.setUp()
        self.addCleanup(self.phase19.tearDown)

    def __getattr__(self, name: str):
        fixture = self.__dict__.get("phase19")
        if fixture is not None:
            return getattr(fixture, name)
        raise AttributeError(name)

    def _load(self):
        module = self.phase19._load()
        self.assertTrue(
            hasattr(module, "setup_faulty_reference"),
            "the maintenance module must expose public setup_faulty_reference(session)",
        )
        return module

    def _static_selector_environment(self) -> dict[str, str]:
        """The only selector settings allowed on the shared alarm adapter."""

        return {
            "AGENT_RUNTIME_ARN": RUNTIME_ARN,
            "AGENT_ALARM_ARN": ALARM_ARN,
            SELECTION_TABLE_ENV: TABLE_NAME,
        }

    def _repaired_publication_row(self) -> dict[str, dict[str, str]]:
        endpoint_arn = f"{RUNTIME_ARN}/runtime-endpoint/repaired"
        values = {
            "pk": REPAIRED_PK,
            "candidateId": "repaired",
            "status": "published",
            "runtimeArn": RUNTIME_ARN,
            "runtimeVersion": REPAIRED_VERSION,
            "endpointName": "repaired",
            "endpointArn": endpoint_arn,
            "artifactSha256": REPAIRED_ARTIFACT_SHA256,
            "artifactVersionId": "repaired-artifact-v1",
            "sourceRevision": REPAIRED_SOURCE_REVISION,
            "alarmArn": ALARM_ARN,
            # Keep realistic publisher metadata so the test proves the
            # maintenance operation does not rewrite the repaired row merely
            # because it has a different adapter provenance.
            "adapterArn": ADAPTER_ARN,
            "adapterCodeSha256": "e" * 64,
        }
        return {key: attr(value) for key, value in values.items()}

    def _selection_row(self) -> dict[str, dict[str, str]]:
        endpoint_arn = f"{RUNTIME_ARN}/runtime-endpoint/repaired"
        values = {
            "pk": SELECTION_PK,
            "revision": "1",
            "candidateId": "repaired",
            "endpointName": "repaired",
            "endpointArn": endpoint_arn,
            "runtimeArn": RUNTIME_ARN,
            "runtimeVersion": REPAIRED_VERSION,
            "artifactSha256": REPAIRED_ARTIFACT_SHA256,
            "artifactVersionId": "repaired-artifact-v1",
            "configurationSha256": "e" * 64,
            "sourceRevision": REPAIRED_SOURCE_REVISION,
            "sourceSha256": "f" * 64,
            "promptSha256": "a" * 64,
            "modelId": MODEL_ID,
            "alarmArn": ALARM_ARN,
            "adapterArn": ADAPTER_ARN,
            "adapterCodeSha256": "b" * 64,
            "selectedAt": "2026-11-18T00:00:00.000Z",
            "caseSetSha256": "c" * 64,
            "reportIdentitiesSha256": "d" * 64,
            "experimentId": "phase21-repaired-experiment",
            "reviewEnvironment": "repaired-publication",
            "reviewRunId": "phase21-review",
            "reviewManifestSha256": "1" * 64,
            "reviewer": "phase21-reviewer",
        }
        return {key: attr(value) for key, value in values.items()}

    def _faulty_publication_row(self) -> dict[str, dict[str, str]]:
        """The complete saved Phase 19 row, including legacy adapter fields."""

        endpoint_arn = f"{RUNTIME_ARN}/runtime-endpoint/faulty"
        values = {
            "pk": PUBLICATION_PK,
            "candidateId": "faulty",
            "sourceRevision": self.descriptor["sourceRevision"],
            "promptSha256": self.descriptor["promptSha256"],
            "modelId": self.descriptor["modelId"],
            "artifactSha256": self.descriptor["artifact"]["sha256"],
            "runtimeArn": RUNTIME_ARN,
            "runtimeVersion": "7",
            "endpointName": "faulty",
            "endpointArn": endpoint_arn,
            "alarmArn": ALARM_ARN,
            "sourceSha256": self.descriptor["source"]["sha256"],
            "configurationSha256": self.descriptor["configuration"]["sha256"],
            "artifactVersionId": self.archive_version,
            "status": "reference",
            "adapterArn": ADAPTER_ARN,
            "adapterRevisionId": "adapter-revision-legacy",
            "adapterCodeSha256": "b" * 64,
        }
        # The original Phase 19 publisher retained empty VersionId fields for
        # unversioned source/configuration objects.  Keep those fields in the
        # saved row so a healthy repeat can prove that historical provenance
        # is preserved byte-for-byte, including legacy shape.
        values.update({"sourceVersionId": "", "configurationVersionId": ""})
        return {key: attr(value) for key, value in values.items()}

    def _prepare_selected_repaired(
        self,
        *,
        missing_faulty_row: bool = False,
        missing_faulty_endpoint: bool = False,
        record_put_lost: bool = False,
    ):
        """Build a stable faulty publication plus an independently selected repair."""

        control, adapter, controller = self._native(
            historical=True,
            endpoint_present=not missing_faulty_endpoint,
            record_put_lost=record_put_lost,
        )
        # The adapter is deliberately non-candidate-specific.  Its existing
        # code and environment represent the shared Phase 21 router and are
        # the state the faulty-reference maintenance operation must preserve.
        adapter.environment = self._static_selector_environment()
        adapter.config["Environment"] = {"Variables": copy.deepcopy(adapter.environment)}
        adapter.config["RevisionId"] = "adapter-revision-static-selector"

        # Add the already-published repaired pair.  This is intentionally
        # separate from the fixed faulty descriptor and is never an operation
        # target for setup_faulty_reference.
        repaired_runtime = copy.deepcopy(control.runtimes["7"])
        repaired_runtime["agentRuntimeVersion"] = REPAIRED_VERSION
        repaired_runtime["environmentVariables"].update(
            {
                "AGENT_CANDIDATE_ID": "repaired",
                "AGENT_ENDPOINT_NAME": "repaired",
                "AGENT_SOURCE_REVISION": REPAIRED_SOURCE_REVISION,
                "AGENT_ARTIFACT_SHA256": REPAIRED_ARTIFACT_SHA256,
            }
        )
        repaired_runtime["agentRuntimeArtifact"]["codeConfiguration"]["code"]["s3"].update(
            {
                "prefix": "agent-qualified/repaired.zip",
                "versionId": "repaired-artifact-v1",
            }
        )
        control.runtimes[REPAIRED_VERSION] = repaired_runtime
        control.endpoints["repaired"] = {
            "status": "READY",
            "liveVersion": REPAIRED_VERSION,
            "targetVersion": REPAIRED_VERSION,
            "agentRuntimeArn": RUNTIME_ARN,
            "agentRuntimeEndpointArn": f"{RUNTIME_ARN}/runtime-endpoint/repaired",
        }
        controller.items[SELECTION_PK] = self._selection_row()
        controller.items[REPAIRED_PK] = self._repaired_publication_row()
        if not missing_faulty_row:
            controller.items[PUBLICATION_PK] = self._faulty_publication_row()
        return control, adapter, controller

    def _call_setup(self, module, control, adapter, controller):
        session = self._session(control, adapter, controller)
        return module.setup_faulty_reference(session)

    def _session(self, control, adapter, controller):
        # NativeSession is intentionally created by the existing Phase 19
        # helper so the operation sees the same AWS-shaped transports as the
        # original setup tests.
        return phase19.NativeSession(self.s3, control, adapter, controller, self.cloudformation)

    def test_healthy_repeat_preserves_repaired_selection_router_and_history(self):
        """A healthy repeat is a verification/no-op for every other owner."""

        control, adapter, controller = self._prepare_selected_repaired()
        module = self._load()
        before_selection = copy.deepcopy(controller.items[SELECTION_PK])
        before_repaired = copy.deepcopy(controller.items[REPAIRED_PK])
        before_faulty = copy.deepcopy(controller.items[PUBLICATION_PK])
        before_repaired_endpoint = copy.deepcopy(control.endpoints["repaired"])
        before_adapter_config = copy.deepcopy(adapter.config)
        before_versions = copy.deepcopy(control.runtimes)
        before_objects = copy.deepcopy(self.s3.objects)

        result = self._call_setup(module, control, adapter, controller)

        self.assertEqual("reference", result["status"])
        self.assertEqual(before_selection, controller.items[SELECTION_PK])
        self.assertEqual(before_repaired, controller.items[REPAIRED_PK])
        self.assertEqual(before_faulty, controller.items[PUBLICATION_PK])
        self.assertEqual(before_repaired_endpoint, control.endpoints["repaired"])
        self.assertEqual(before_adapter_config, adapter.config)
        self.assertEqual(before_versions, control.runtimes)
        self.assertEqual(before_objects, self.s3.objects)
        self.assertEqual([], adapter.updates, "restore must not rewrite the shared static router")
        self.assertEqual([], control.runtime_updates, "a healthy repeat must not publish a Runtime version")
        self.assertEqual([], control.runtime_creates)
        self.assertEqual([], control.endpoint_creates)
        self.assertEqual([], control.endpoint_updates)
        self.assertEqual(
            [],
            [request for name, request in controller.calls if name == "put_item"],
            "a healthy repeat must not rewrite historic or selected controller rows",
        )
        self.assertFalse(
            any(
                name == "put_item" and request.get("Item", {}).get("pk") == {"S": SELECTION_PK}
                for name, request in controller.calls
            ),
            "restore must not change AGENT_SELECTION",
        )

    def test_preflight_reports_healthy_selector_and_faulty_binding_without_mutation(self):
        """Selector mode is ready from native endpoint/Runtime readback, not a repair gap."""

        control, adapter, controller = self._prepare_selected_repaired()
        module = self._load()
        self.cloudformation = phase19.NativePreflightCloudFormation()
        session = self._session(control, adapter, controller)
        session.clients["sts"] = phase19.NativeSTS()
        before_selection = copy.deepcopy(controller.items[SELECTION_PK])
        before_repaired = copy.deepcopy(controller.items[REPAIRED_PK])
        before_faulty_endpoint = copy.deepcopy(control.endpoints["faulty"])

        result = module.preflight_faulty_reference(session)

        self.assertEqual("ready", result["status"])
        self.assertIsNone(result["partialBinding"])
        self.assertFalse(result["trustedRollback"]["eligible"])
        self.assertTrue(result["endpoint"]["present"])
        self.assertEqual("7", result["endpoint"]["version"])
        self.assertEqual("descriptor", result["adapter"]["expectedCodeSource"])
        self.assertEqual(before_selection, controller.items[SELECTION_PK])
        self.assertEqual(before_repaired, controller.items[REPAIRED_PK])
        self.assertEqual(before_faulty_endpoint, control.endpoints["faulty"])
        self.assertEqual([], adapter.updates)
        self.assertEqual([], control.runtime_updates)
        self.assertEqual([], control.endpoint_updates)

    def test_incomplete_historical_adapter_provenance_fails_without_rewriting_selection_or_router(self):
        """A missing old adapter digest is not repairable reference evidence."""

        control, adapter, controller = self._prepare_selected_repaired()
        module = self._load()
        before_selection = copy.deepcopy(controller.items[SELECTION_PK])
        before_repaired = copy.deepcopy(controller.items[REPAIRED_PK])
        del controller.items[PUBLICATION_PK]["adapterCodeSha256"]
        before_faulty = copy.deepcopy(controller.items[PUBLICATION_PK])

        with self.assertRaisesRegex(RuntimeError, "adapter code provenance"):
            self._call_setup(module, control, adapter, controller)

        self.assertEqual(before_selection, controller.items[SELECTION_PK])
        self.assertEqual(before_repaired, controller.items[REPAIRED_PK])
        self.assertEqual(before_faulty, controller.items[PUBLICATION_PK])
        self.assertEqual([], adapter.updates)
        self.assertEqual([], control.runtime_updates)
        self.assertEqual([], control.endpoint_updates)

    def test_missing_faulty_endpoint_and_row_rebuild_only_faulty_history_while_repaired_stays_selected(self):
        """The exact archive can recreate both missing faulty native pieces."""

        control, adapter, controller = self._prepare_selected_repaired(
            missing_faulty_row=True,
            missing_faulty_endpoint=True,
        )
        module = self._load()
        before_selection = copy.deepcopy(controller.items[SELECTION_PK])
        before_repaired = copy.deepcopy(controller.items[REPAIRED_PK])
        before_repaired_endpoint = copy.deepcopy(control.endpoints["repaired"])
        before_adapter_config = copy.deepcopy(adapter.config)
        before_versions = copy.deepcopy(control.runtimes)
        before_objects = copy.deepcopy(self.s3.objects)

        result = self._call_setup(module, control, adapter, controller)

        self.assertEqual("reference", result["status"])
        self.assertIn(PUBLICATION_PK, controller.items)
        rebuilt = controller.items[PUBLICATION_PK]
        self.assertEqual(attr("faulty"), rebuilt["candidateId"])
        self.assertEqual(attr("reference"), rebuilt["status"])
        self.assertEqual(attr("faulty"), rebuilt["endpointName"])
        self.assertEqual(attr("7"), rebuilt["runtimeVersion"])
        self.assertEqual(before_selection, controller.items[SELECTION_PK])
        self.assertEqual(before_repaired, controller.items[REPAIRED_PK])
        self.assertEqual(before_repaired_endpoint, control.endpoints["repaired"])
        self.assertEqual(before_adapter_config, adapter.config)
        self.assertEqual(before_versions, control.runtimes)
        self.assertEqual(before_objects, self.s3.objects)
        self.assertEqual([], adapter.updates)
        self.assertEqual([], control.runtime_updates)
        self.assertEqual([], control.runtime_creates)
        self.assertEqual(1, len(control.endpoint_creates))
        self.assertEqual("faulty", control.endpoint_creates[0]["name"])
        self.assertEqual("7", control.endpoint_creates[0]["agentRuntimeVersion"])
        self.assertEqual([], control.endpoint_updates)
        self.assertEqual("7", control.endpoints["faulty"]["liveVersion"])
        writes = [request for name, request in controller.calls if name == "put_item"]
        self.assertEqual(1, len(writes))
        self.assertEqual({"S": PUBLICATION_PK}, writes[0]["Item"]["pk"])

    def test_frozen_inputs_fail_before_any_selection_router_or_publication_mutation(self):
        cases = (
            ("archive", self.archive_key, self.archive_version, b"changed archive"),
            ("source", self.source_key, "", b"changed source"),
            ("configuration", self.config_key, "", b"changed configuration"),
        )
        for label, key, version, replacement in cases:
            with self.subTest(label=label):
                control, adapter, controller = self._prepare_selected_repaired()
                module = self._load()
                object_key = (self.bucket, key, version)
                original_bytes = self.s3.objects[object_key]
                self.s3.objects[object_key] = replacement
                before_rows = copy.deepcopy(controller.items)
                try:
                    with self.assertRaises((RuntimeError, ValueError)):
                        self._call_setup(module, control, adapter, controller)
                finally:
                    self.s3.objects[object_key] = original_bytes
                self.assertEqual(before_rows, controller.items)
                self.assertEqual([], adapter.updates)
                self.assertEqual([], control.runtime_updates)
                self.assertEqual([], control.runtime_creates)
                self.assertEqual([], control.endpoint_creates)
                self.assertEqual([], control.endpoint_updates)

    def test_partial_faulty_row_write_is_not_reported_as_success_and_retry_converges(self):
        control, adapter, controller = self._prepare_selected_repaired(
            missing_faulty_row=True,
            record_put_lost=True,
        )
        module = self._load()
        before_selection = copy.deepcopy(controller.items[SELECTION_PK])
        before_repaired = copy.deepcopy(controller.items[REPAIRED_PK])

        with self.assertRaises(RuntimeError):
            self._call_setup(module, control, adapter, controller)
        self.assertIn(PUBLICATION_PK, controller.items, "the write may commit before its response is lost")
        self.assertEqual(before_selection, controller.items[SELECTION_PK])
        self.assertEqual(before_repaired, controller.items[REPAIRED_PK])
        self.assertEqual([], adapter.updates)
        self.assertEqual([], control.runtime_updates)
        self.assertEqual([], control.endpoint_creates)

        result = self._call_setup(module, control, adapter, controller)
        self.assertEqual("reference", result["status"])
        self.assertEqual(before_selection, controller.items[SELECTION_PK])
        self.assertEqual(before_repaired, controller.items[REPAIRED_PK])
        self.assertEqual([], adapter.updates)
        self.assertEqual([], control.runtime_updates)
        self.assertEqual([], control.endpoint_creates)
        self.assertEqual(
            1,
            len([call for call in controller.calls if call[0] == "put_item"]),
            "retry reconciles the committed faulty row instead of publishing or rewriting selection",
        )


if __name__ == "__main__":
    unittest.main()
