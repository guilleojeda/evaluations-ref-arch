"""Native package-OTel exporter regression coverage for the Phase 20 runner."""

from __future__ import annotations

import os
import json
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
LOG_GROUP = "/aws/bedrock-agentcore/incident-triage-evaluation"
TRACE_ENDPOINT = "https://xray.us-east-1.amazonaws.com/v1/traces"


@unittest.skipUnless(
    sys.platform == "linux" and platform.machine() in {"aarch64", "arm64"},
    "the checked Runtime ZIP contains Linux ARM64 wheels",
)
class NativePackagedExporter(unittest.TestCase):
    def test_real_package_encoder_handles_internal_span_without_driver_enum_mismatch(self):
        environment = os.environ.copy()
        environment.update(
            {
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
                "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": TRACE_ENDPOINT,
                "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL": "http/protobuf",
                "OTEL_EXPORTER_OTLP_TRACES_HEADERS": f"x-aws-log-group={LOG_GROUP},x-aws-log-stream=spans",
                "OTEL_TRACES_EXPORTER": "otlp",
                "OTEL_LOGS_EXPORTER": "none",
                "OTEL_METRICS_EXPORTER": "none",
                "OTEL_TRACES_SAMPLER": "always_on",
                "PYTHONPATH": str(ROOT / "agent"),
                "PHASE20_RUNTIME_ZIP": str(ROOT / ".artifacts/agent/runtime.zip"),
                "PHASE20_AGENT_ROOT": str(ROOT / "agent"),
            }
        )
        script = r'''
import inspect
import os
from pathlib import Path
import tempfile
import zipfile
from types import SimpleNamespace

from captured_execution import (
    _configure_packaged_exporter,
    _snapshot_imports,
    _verify_exporter_setup,
)

# Authenticate the actual launcher exporter first, but prevent the preflight
# provider's background worker from making a network call in this test.
from amazon.opentelemetry.distro.exporter.otlp.aws.traces.otlp_aws_span_exporter import (
    OTLPAwsSpanExporter as LauncherExporter,
)
from opentelemetry.sdk.trace.export import SpanExportResult
LauncherExporter.export = lambda self, spans: SpanExportResult.SUCCESS
launcher_provider = _verify_exporter_setup()

runtime_zip = Path(os.environ["PHASE20_RUNTIME_ZIP"])
with tempfile.TemporaryDirectory(prefix="phase20-package-exporter-") as temporary:
    package_root = Path(temporary) / "runtime"
    package_root.mkdir()
    with zipfile.ZipFile(runtime_zip) as archive:
        archive.extractall(package_root)
    modules = ("amazon", "boto3", "botocore", "opentelemetry", "pydantic", "strands")
    with _snapshot_imports(
        Path(os.environ["PHASE20_AGENT_ROOT"]),
        dependency_root=package_root,
        dependency_modules=modules,
    ):
        from amazon.opentelemetry.distro.exporter.otlp.aws.traces.otlp_aws_span_exporter import (
            AwsAuthSession,
            OTLPAwsSpanExporter,
        )
        from opentelemetry import trace
        from opentelemetry.sdk.trace import TracerProvider

        posts = []
        def fake_post(self, **kwargs):
            posts.append(kwargs)
            return SimpleNamespace(ok=True, reason="OK", status_code=200)
        AwsAuthSession.post = fake_post

        provider = _configure_packaged_exporter(launcher_provider)
        assert isinstance(provider, TracerProvider)
        assert Path(inspect.getfile(OTLPAwsSpanExporter)).is_relative_to(package_root)
        assert Path(inspect.getfile(TracerProvider)).is_relative_to(package_root)
        with trace.get_tracer("phase20.native-exporter").start_as_current_span("internal"):
            pass
        assert provider.force_flush(timeout_millis=30_000)
        provider.shutdown()
        assert posts and posts[0]["url"] == os.environ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"]
        assert posts[0]["data"], "the real package OTLP encoder emitted no payload"
'''
        result = subprocess.run(
            [
                "uv",
                "run",
                "--offline",
                "--project",
                "agent",
                "--locked",
                "opentelemetry-instrument",
                sys.executable,
                "-c",
                script,
            ],
            cwd=ROOT,
            env=environment,
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_unmocked_captured_runner_uses_packaged_provider_with_mocked_model_and_aws_transports(self):
        """Run the real captured path with only Bedrock/OTLP transports mocked."""

        if str(ROOT / "tests") not in sys.path:
            sys.path.insert(0, str(ROOT / "tests"))
        from phase18_strands_experiment_test import Phase18StrandsExperimentAcceptance

        fixture = Phase18StrandsExperimentAcceptance("runTest")
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        environment = os.environ.copy()
        environment.update(
            {
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
                "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": TRACE_ENDPOINT,
                "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL": "http/protobuf",
                "OTEL_EXPORTER_OTLP_TRACES_HEADERS": f"x-aws-log-group={LOG_GROUP},x-aws-log-stream=spans",
                "OTEL_TRACES_EXPORTER": "otlp",
                "OTEL_LOGS_EXPORTER": "none",
                "OTEL_METRICS_EXPORTER": "none",
                "OTEL_TRACES_SAMPLER": "always_on",
                "PYTHONPATH": f"{ROOT / 'agent'}:{ROOT / 'tests'}",
                "PHASE20_RUNTIME_ZIP": str(ROOT / ".artifacts/agent/runtime.zip"),
                "PHASE20_AGENT_ROOT": str(ROOT / "agent"),
                "PHASE20_CASE_PATH": str(fixture.case_paths["denial"]),
                "PHASE20_BUNDLE_PATH": str(fixture.bundle),
                "PHASE20_TEST_OUTPUT": "phase20-package-child.json",
            }
        )
        with tempfile.TemporaryDirectory(prefix="phase20-native-run-") as output:
            environment["PHASE20_OUTPUT_ROOT"] = output
            script = r'''
import json
import os
from pathlib import Path
import tempfile

import captured_execution
from amazon.opentelemetry.distro.exporter.otlp.aws.traces.otlp_aws_span_exporter import OTLPAwsSpanExporter as LauncherExporter
from opentelemetry.sdk.trace.export import SpanExportResult
import development_experiment

# Keep the parent launcher preflight offline; the actual package exporter and
# model transport are patched inside the fresh package child below.
LauncherExporter.export = lambda self, spans: SpanExportResult.SUCCESS

child_runner_source = r"""
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace

request = json.loads(Path(sys.argv[1]).read_text())
staging = Path(request["staging"])
dependency_root = Path(request["dependencyRoot"])
agent_source = staging / "source" / "agent"
stdlib = [path for path in sys.path if path and "site-packages" not in path and "dist-packages" not in path]
sys.path[:] = [str(dependency_root), str(agent_source), *stdlib]

import boto3
from botocore.session import get_session

case = json.loads(Path(request["stagedCase"]).read_text())["case"]
task = case["task"]
report = {
    "assessment": "ongoing",
    "summary": "The packaged child produced a bounded synthetic report.",
    "recommendation": {"action": "Increase memory", "target": "inventory", "value": 512, "unit": "MB"},
    "evidence": [{
        "source": "logs",
        "resource": "inventory",
        "windowStart": task["incidentWindow"]["start"],
        "windowEnd": task["referenceTime"],
        "observedAt": task["referenceTime"],
        "finding": "Synthetic packaged child observation.",
    }],
    "uncertainties": ["Synthetic package-process evidence is intentionally bounded."],
    "alternatives": [],
}

class ScriptedBedrock:
    def __init__(self):
        self.requests = []
        self.reads = iter(({"resource": "inventory"},))
        self.meta = SimpleNamespace(
            region_name="us-east-1",
            service_model=get_session().get_service_model("bedrock-runtime"),
        )

    def converse_stream(self, **request):
        self.requests.append(request)
        forced = request.get("toolConfig", {}).get("toolChoice", {}).get("tool", {}).get("name")
        if forced == "InvestigationReport":
            name, arguments = "InvestigationReport", report
        else:
            scope = next(self.reads, None)
            name = "search_logs" if scope is not None else None
            arguments = {**(scope or {}), "start": task["incidentWindow"]["start"], "end": task["referenceTime"]}
        events = [{"messageStart": {"role": "assistant"}}]
        if name is None:
            events.append({"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "I inspected the packaged evidence."}}})
        else:
            events.extend((
                {"contentBlockStart": {"contentBlockIndex": 0, "start": {"toolUse": {"toolUseId": f"tool-{len(self.requests)}", "name": name}}}},
                {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"toolUse": {"input": json.dumps(arguments)}}}},
            ))
        events.extend((
            {"contentBlockStop": {"contentBlockIndex": 0}},
            {"messageStop": {"stopReason": "tool_use" if name else "end_turn"}},
            {"metadata": {"usage": {"inputTokens": 3, "outputTokens": 2, "totalTokens": 5}, "metrics": {"latencyMs": 1}}},
        ))
        return {"stream": iter(events)}

client = ScriptedBedrock()
real_session_type = boto3.Session
real_clients = []

class ScriptedClient:
    def __init__(self, delegate, metadata):
        self._delegate = delegate
        self.meta = metadata
        self.region_name = metadata.region_name

    def converse_stream(self, **kwargs):
        return self._delegate.converse_stream(**kwargs)

class TransportSession:
    def __init__(self, *args, **kwargs):
        self._real = real_session_type(*args, **kwargs)
        self.region_name = self._real.region_name

    def client(self, service_name, **kwargs):
        real_client = self._real.client(service_name, **kwargs)
        if service_name != "bedrock-runtime":
            return real_client
        assert real_client.meta.service_model.service_name == "bedrock-runtime"
        assert real_client.meta.region_name == "us-east-1"
        real_clients.append(real_client)
        return ScriptedClient(client, real_client.meta)

posts = []
def fake_post(self, **kwargs):
    posts.append({"url": kwargs.get("url"), "dataBytes": len(kwargs.get("data", b""))})
    return SimpleNamespace(ok=True, reason="OK", status_code=200)

from amazon.opentelemetry.distro.exporter.otlp.aws.traces.otlp_aws_span_exporter import AwsAuthSession
AwsAuthSession.post = fake_post
boto3.Session = TransportSession

import captured_execution
try:
    assert captured_execution._snapshot_imports.__name__ == "_snapshot_imports"
    captured_execution._package_child_main()
finally:
    output = Path(request["outputRoot"]) / os.environ["PHASE20_TEST_OUTPUT"]
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"posts": posts, "modelRequests": len(client.requests), "clients": len(real_clients)}))
"""

original_child = captured_execution._run_packaged_case_process
original_snapshot_imports = captured_execution._snapshot_imports
def run_test_child(**kwargs):
    kwargs["runner_source"] = child_runner_source.encode()
    return original_child(**kwargs)
captured_execution._run_packaged_case_process = run_test_child
captured_execution._snapshot_imports = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("parent package scope must not evict modules"))

try:
    runtime_zip = Path(os.environ["PHASE20_RUNTIME_ZIP"])
    with development_experiment._extract_runtime_package(runtime_zip) as (package_root, package_origin, dependency_modules):
        with tempfile.TemporaryDirectory(prefix="phase20-package-candidate-") as candidate_dir:
            candidate_source = development_experiment._assemble_package_candidate(package_root, Path(candidate_dir) / "agent")
            run_dir = captured_execution.run_captured_case(
                os.environ["PHASE20_CASE_PATH"],
                os.environ["PHASE20_BUNDLE_PATH"],
                os.environ["PHASE20_OUTPUT_ROOT"],
                model_session=None,
                candidate_id="repaired",
                source_directory=candidate_source,
                dependency_root=package_root,
                dependency_modules=dependency_modules,
                runtime_origin=package_origin,
                trusted_runner=True,
            )
finally:
    captured_execution._snapshot_imports = original_snapshot_imports

record = json.loads((Path(run_dir) / "execution.json").read_text())
telemetry = json.loads((Path(os.environ["PHASE20_OUTPUT_ROOT"]) / os.environ["PHASE20_TEST_OUTPUT"]).read_text())
assert record["status"] == "complete", record
assert telemetry["clients"] >= 1 and telemetry["modelRequests"] >= 2, telemetry
assert telemetry["posts"] and telemetry["posts"][0]["dataBytes"] > 0, telemetry
assert telemetry["posts"][0]["url"] == os.environ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"]
assert record["modelResponseCount"] == record["modelSpanCount"] > 0, record
spans = json.loads((Path(run_dir) / "strands.native-spans.json").read_text())["spans"]
def operation(span):
    attributes = span.get("attributes", {}) if isinstance(span, dict) else {}
    if isinstance(attributes, dict) and isinstance(attributes.get("attributes"), dict):
        attributes = attributes["attributes"]
    return attributes.get("gen_ai.operation.name") if isinstance(attributes, dict) else None
assert any(operation(span) == "invoke_agent" for span in spans), "captured Strands root span missing"
assert record["identity"]["runtimeOrigin"]["moduleOrigins"]["strands"]["loaded"] is True
'''
            result = subprocess.run(
                [
                    "uv", "run", "--offline", "--project", "agent", "--locked",
                    "opentelemetry-instrument", sys.executable, "-c", script,
                ],
                cwd=ROOT,
                env=environment,
                capture_output=True,
                text=True,
                timeout=90,
            )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
