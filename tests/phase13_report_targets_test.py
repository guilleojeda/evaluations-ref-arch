"""Acceptance tests for the canonical recommendation stored by AgentCore Runtime."""

from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from support.phase4_agent_fakes import (
    ALARM_ARN,
    AgentScript,
    FakeAWSBoundary,
    alarm_event,
    isolated_runtime,
    report,
    runtime_context,
    runtime_payload,
)


TRANSITION = "2026-11-09T23:10:00.000Z"
RESTORATION = {"action": "Restore inventory access", "target": "inventory", "value": "317", "unit": "version"}
MEMORY = {"action": "Increase memory", "target": "inventory", "value": 512, "unit": "MB"}
CONCURRENCY = {"action": "Increase reserved concurrency", "target": "inventory", "value": 32, "unit": "executions"}
OTHER = {"action": "Other", "target": None, "value": "The repeat observations do not support a change.", "unit": None}


def with_recommendation(recommendation):
    return {**report(), "recommendation": recommendation}


class CanonicalReportTargetsTests(unittest.TestCase):
    def test_each_action_accepts_its_canonical_fields_without_normalization(self):
        with isolated_runtime(AgentScript(), FakeAWSBoundary()) as (module, _):
            for recommendation in (RESTORATION, OTHER, MEMORY, CONCURRENCY,
                                   {**MEMORY, "target": "checkout"}, {**CONCURRENCY, "target": "checkout"}):
                with self.subTest(recommendation=recommendation):
                    submitted = with_recommendation(recommendation)
                    validated = module.InvestigationReport.model_validate(submitted)
                    self.assertEqual(submitted, validated.model_dump(mode="json"))

    def test_restoration_requires_exact_positive_version_string_and_inventory_target(self):
        invalid_fields = (
            {"value": "role policy permits dynamodb:GetItem"},
            {"value": "Inventory version 317"},
            {"value": "$LATEST"},
            {"value": 317},
            {"value": "0"},
            {"value": "0317"},
            {"value": " 317 "},
            {"value": "+317"},
            {"value": "３１７"},
            {"value": None},
            {"unit": None},
            {"unit": "policy"},
            {"target": "checkout"},
        )
        with isolated_runtime(AgentScript(), FakeAWSBoundary()) as (module, _):
            for invalid in invalid_fields:
                with self.subTest(invalid=invalid):
                    submitted = with_recommendation({**RESTORATION, **invalid})
                    submitted["summary"] = "Configuration evidence discusses published Inventory version 317."
                    with self.assertRaises(ValueError):
                        module.InvestigationReport.model_validate(submitted)

    def test_increases_require_integer_allocations_and_the_exact_unit(self):
        invalid_updates = (
            (MEMORY, ({"value": "512"}, {"value": 512.0}, {"value": 127}, {"value": 10241},
                      {"unit": "mb"}, {"unit": None}, {"target": None})),
            (CONCURRENCY, ({"value": "32"}, {"value": 32.0}, {"value": True}, {"value": 0},
                           {"value": -1}, {"unit": "MB"}, {"unit": None}, {"target": None})),
        )
        with isolated_runtime(AgentScript(), FakeAWSBoundary()) as (module, _):
            for recommendation, updates in invalid_updates:
                for invalid in updates:
                    with self.subTest(action=recommendation["action"], invalid=invalid):
                        with self.assertRaises(ValueError):
                            module.InvestigationReport.model_validate(with_recommendation({**recommendation, **invalid}))

    def test_other_requires_an_explanation_with_no_target_or_unit(self):
        with isolated_runtime(AgentScript(), FakeAWSBoundary()) as (module, _):
            for invalid in ({"target": "inventory"}, {"unit": "version"}, {"value": " \t "}, {"value": 317}):
                with self.subTest(invalid=invalid):
                    with self.assertRaises(ValueError):
                        module.InvestigationReport.model_validate(with_recommendation({**OTHER, **invalid}))

    def test_runtime_persists_versioned_reports_with_the_models_actual_recommendation(self):
        for recommendation in (RESTORATION, MEMORY):
            with self.subTest(action=recommendation["action"]):
                submitted = with_recommendation(recommendation)
                submitted["assessment"] = "ongoing"
                submitted["summary"] = "Inventory's read failed with AccessDenied while running at 256 MB."
                submitted["evidence"][0]["finding"] = "A correlated Inventory read returned AccessDenied."
                script = AgentScript(report=submitted)
                with isolated_runtime(script) as (module, boundary):
                    result = module.invoke(runtime_payload(alarm_event()), runtime_context("canonical-report-session"))
                    saved = boundary.runs.find(ALARM_ARN, TRANSITION)

                self.assertEqual("complete", result["status"])
                self.assertIsNotNone(saved)
                self.assertEqual("complete", saved["status"])
                self.assertEqual(submitted, saved["report"], "Validation must preserve even the incorrect memory action for denial.")
                self.assertEqual(2, saved.get("reportSchemaVersion"))

    def test_runtime_does_not_salvage_restoration_when_version_is_only_in_prose(self):
        submitted = with_recommendation({**RESTORATION, "value": "Select the healthy version 317"})

        class RawReportAgent:
            def __init__(self, *args, **kwargs):
                pass

            def __call__(self, *args, **kwargs):
                return SimpleNamespace(structured_output=submitted)

        with isolated_runtime(AgentScript()) as (module, boundary):
            with patch.object(module, "Agent", RawReportAgent):
                result = module.invoke(runtime_payload(alarm_event()), runtime_context("legacy-format-session"))
            saved = boundary.runs.find(ALARM_ARN, TRANSITION)

        self.assertEqual("failed", result["status"])
        self.assertIsNotNone(saved)
        self.assertEqual("failed", saved["status"])
        self.assertTrue(saved.get("failure"))
        self.assertNotIn("report", saved)
        self.assertNotIn("reportSchemaVersion", saved)

    def test_runtime_model_receives_canonical_format_guidance(self):
        script = AgentScript(report=with_recommendation(RESTORATION))
        with isolated_runtime(script) as (module, _):
            module.invoke(runtime_payload(alarm_event()), runtime_context("prompt-contract-session"))

        prompt = script.constructions[0]["kwargs"]["system_prompt"]
        for field_value in ("MB", "executions", "version", "null"):
            with self.subTest(field_value=field_value):
                self.assertRegex(prompt, rf"\b{field_value}\b")


if __name__ == "__main__":
    unittest.main()
