"""Acceptance for the candidate and named-endpoint binding at Runtime invocation."""

import os
import unittest
from unittest.mock import patch

from support.phase4_agent_fakes import (
    AgentScript, isolated_runtime, report, runtime_context, runtime_payload,
)


def invoke(runtime, candidate, endpoint, *, attested=None, session="first", **deployment):
    payload = runtime_payload()
    payload["deployment"].update(deployment, endpointName=endpoint if attested is None else attested)
    settings = {"AGENT_CANDIDATE_ID": candidate, "AGENT_ENDPOINT_NAME": endpoint}
    with patch.dict(os.environ, settings):
        return runtime.invoke(payload, runtime_context(session))


class NamedRuntimePairs(unittest.TestCase):
    def check_matching_pair(self, label):
        script = AgentScript(report=report())
        with isolated_runtime(script) as (runtime, aws):
            response = invoke(runtime, label, label)
            self.assertEqual("complete", response["status"], response)
            row, = aws.runs.rows.values()
            self.assertEqual((label, label), (row["candidateId"], row["endpointName"]))
            self.assertEqual(runtime.PROMPT_SHA256, row["promptSha256"])
            self.assertEqual(runtime_payload()["deployment"]["artifactSha256"], row["artifactSha256"])
            self.assertEqual(1, script.invocations)
            trace = script.constructions[0]["kwargs"]["trace_attributes"]
            self.assertEqual(label, trace["incident.candidate_id"])
            self.assertEqual(row["runId"], trace["incident.run_id"])

    def test_faulty_pair_completes_and_records_its_identity(self):
        self.check_matching_pair("faulty")

    def test_repaired_pair_completes_and_records_its_identity(self):
        self.check_matching_pair("repaired")

    def check_rejected(self, candidate, endpoint, **kwargs):
        script = AgentScript(report=report())
        with isolated_runtime(script) as (runtime, aws):
            self.assertEqual("rejected", invoke(runtime, candidate, endpoint, **kwargs)["status"])
            self.assertEqual([], aws.runs.operations)
            self.assertEqual([], aws.calls)
            self.assertEqual([], aws.s3_writes)
            self.assertEqual([], script.constructions)
            self.assertEqual(0, script.invocations)

    def test_crossed_and_unknown_configurations_reject_before_claim(self):
        for pair in (("faulty", "repaired"), ("repaired", "faulty"), ("faulty", "DEFAULT"),
                     ("DEFAULT", "DEFAULT"), ("other", "faulty"), ("other", "other")):
            with self.subTest(pair=pair):
                self.check_rejected(*pair)

    def test_attestation_checks_apply_to_both_pairs(self):
        for label, other in (("faulty", "repaired"), ("repaired", "faulty")):
            for override in ({"attested": other}, {"sourceRevision": "b" * 40},
                             {"artifactSha256": "f" * 64}, {"runtimeVersion": "unverified"}):
                with self.subTest(label=label, override=override):
                    self.check_rejected(label, label, **override)

    def test_redelivery_under_the_other_valid_pair_keeps_the_original_claim(self):
        script = AgentScript(report=report())
        with isolated_runtime(script) as (runtime, aws):
            first = invoke(runtime, "faulty", "faulty")
            self.assertEqual("complete", first["status"])
            original, = aws.runs.rows.values()
            saved = dict(original)
            second = invoke(runtime, "repaired", "repaired", session="second")
            self.assertEqual("duplicate", second["status"], second)
            self.assertEqual(first["runId"], second["runId"])
            self.assertEqual([saved], list(aws.runs.rows.values()))
            self.assertEqual(1, script.invocations)
