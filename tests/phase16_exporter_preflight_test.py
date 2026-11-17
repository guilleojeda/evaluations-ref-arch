"""Acceptance for the locked ADOT exporter preflight boundary."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
LOG_GROUP = "/aws/bedrock-agentcore/incident-triage-evaluation"
TRACE_ENDPOINT = "https://xray.us-east-1.amazonaws.com/v1/traces"


class ExporterPreflightAcceptance(unittest.TestCase):
    def run_preflight(self, **overrides: str) -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        for name in (
            "AGENT_OBSERVABILITY_ENABLED",
            "AWS_GENAI_CONTENT_EXTRACTION_OPT_OUT",
            "AWS_ACCOUNT_ID",
            "AWS_REGION",
            "AWS_DEFAULT_REGION",
            "OTEL_PYTHON_DISTRO",
            "OTEL_PYTHON_CONFIGURATOR",
            "OTEL_RESOURCE_ATTRIBUTES",
            "OTEL_EXPORTER_OTLP_PROTOCOL",
            "OTEL_EXPORTER_OTLP_ENDPOINT",
            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
            "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
            "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
            "OTEL_TRACES_EXPORTER",
            "OTEL_LOGS_EXPORTER",
            "OTEL_METRICS_EXPORTER",
            "OTEL_TRACES_SAMPLER",
        ):
            environment.pop(name, None)
        environment.update({
            "AGENT_OBSERVABILITY_ENABLED": "true",
            "AWS_GENAI_CONTENT_EXTRACTION_OPT_OUT": "true",
            "AWS_ACCOUNT_ID": "027224425948",
            "AWS_REGION": "us-east-1",
            "AWS_DEFAULT_REGION": "us-east-1",
            "AWS_ACCESS_KEY_ID": "dummy",
            "AWS_SECRET_ACCESS_KEY": "dummy",
            "AWS_SESSION_TOKEN": "dummy",
            "AWS_EC2_METADATA_DISABLED": "true",
            "OTEL_PYTHON_DISTRO": "aws_distro",
            "OTEL_PYTHON_CONFIGURATOR": "aws_configurator",
            "OTEL_RESOURCE_ATTRIBUTES": f"service.name=incident-triage-evaluation,aws.log.group.names={LOG_GROUP}",
            "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
            "OTEL_EXPORTER_OTLP_TRACES_HEADERS": f"x-aws-log-group={LOG_GROUP},x-aws-log-stream=spans",
            "OTEL_TRACES_EXPORTER": "otlp",
            "OTEL_LOGS_EXPORTER": "none",
            "OTEL_METRICS_EXPORTER": "none",
            "OTEL_TRACES_SAMPLER": "always_on",
            "PYTHONPATH": str(ROOT / "agent"),
            **overrides,
        })
        script = """
import os
from captured_execution import _verify_exporter_setup

try:
    _verify_exporter_setup()
except Exception as exc:
    print(f"{type(exc).__name__}: {exc}", flush=True)
    os._exit(2)

print("INFERENCE_STARTED", flush=True)
os._exit(0)
"""
        return subprocess.run(
            [
                "uv", "run", "--offline", "--project", "agent", "--locked",
                "opentelemetry-instrument", sys.executable, "-c", script,
            ],
            cwd=ROOT,
            env=environment,
            capture_output=True,
            text=True,
            timeout=30,
        )

    def test_documented_launcher_reaches_preflight_without_inference(self):
        result = self.run_preflight()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("INFERENCE_STARTED", result.stdout)

    def test_unsigned_otlp_overrides_fail_before_inference(self):
        cases = (
            {"OTEL_EXPORTER_OTLP_ENDPOINT": "https://xray.us-east-1.amazonaws.com"},
            {"OTEL_EXPORTER_OTLP_TRACES_PROTOCOL": "grpc"},
        )
        for override in cases:
            with self.subTest(override=override):
                result = self.run_preflight(**override)
                output = result.stdout + result.stderr
                self.assertNotEqual(result.returncode, 0, output)
                self.assertNotIn("INFERENCE_STARTED", output)
                self.assertIn("production telemetry", output)

    def test_effective_signed_trace_route_allows_generic_endpoint_setting(self):
        result = self.run_preflight(
            OTEL_EXPORTER_OTLP_ENDPOINT="https://xray.us-east-1.amazonaws.com",
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=TRACE_ENDPOINT,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("INFERENCE_STARTED", result.stdout)


if __name__ == "__main__":
    unittest.main()
