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
            }
        )
        with tempfile.TemporaryDirectory(prefix="phase20-native-run-") as output:
            environment["PHASE20_OUTPUT_ROOT"] = output
            script = r'''
import contextlib
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import zipfile

import captured_execution
from phase15_deterministic_checks_test import recommendation, report_for
from phase16_baseline_test import ScriptedBedrock

runtime_zip = Path(os.environ["PHASE20_RUNTIME_ZIP"])
case = json.loads(Path(os.environ["PHASE20_CASE_PATH"]).read_text())["case"]
client = ScriptedBedrock(
    report_for(recommendation("Increase memory", "inventory", 512, "MB")),
    case["task"],
    reads=({"resource": "inventory"},),
)
class ScriptedClient:
    def __init__(self, delegate, metadata):
        self._delegate = delegate
        self.meta = metadata
    def client(self, service_name, **kwargs):
        raise AssertionError("the scripted Bedrock client must not create nested clients")
    def converse_stream(self, **kwargs):
        return self._delegate.converse_stream(**kwargs)

real_session_type = None
real_clients = []
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

original_snapshot_imports = captured_execution._snapshot_imports
posts = []
def fake_post(self, **kwargs):
    posts.append(kwargs)
    return SimpleNamespace(ok=True, reason="OK", status_code=200)
@contextlib.contextmanager
def patched_snapshot_imports(agent_source, **kwargs):
    with original_snapshot_imports(agent_source, **kwargs):
        import boto3 as runtime_boto3
        from amazon.opentelemetry.distro.exporter.otlp.aws.traces.otlp_aws_span_exporter import AwsAuthSession as PackageAwsAuthSession
        global real_session_type
        real_session_type = runtime_boto3.Session
        runtime_boto3.Session = TransportSession
        PackageAwsAuthSession.post = fake_post
        try:
            yield
        finally:
            pass
captured_execution._snapshot_imports = patched_snapshot_imports

from amazon.opentelemetry.distro.exporter.otlp.aws.traces.otlp_aws_span_exporter import AwsAuthSession
from amazon.opentelemetry.distro.exporter.otlp.aws.traces.otlp_aws_span_exporter import OTLPAwsSpanExporter as LauncherExporter
from opentelemetry.sdk.trace.export import SpanExportResult
LauncherExporter.export = lambda self, spans: SpanExportResult.SUCCESS
AwsAuthSession.post = fake_post

import development_experiment
with tempfile.TemporaryDirectory(prefix="phase20-runtime-package-") as package_dir:
    package_root = Path(package_dir) / "runtime"
    package_root.mkdir()
    with zipfile.ZipFile(runtime_zip) as archive:
        archive.extractall(package_root)
    modules = ("amazon", "boto3", "botocore", "opentelemetry", "pydantic", "strands")
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
            dependency_modules=modules,
            trusted_runner=True,
        )
        record = json.loads((Path(run_dir) / "execution.json").read_text())
        assert record["status"] == "complete", record
        assert real_clients and len(client.requests) >= 2, "the real packaged Bedrock client path did not observe model attempts"
        assert posts and posts[0]["data"], "the real package OTLP encoder emitted no payload"
        assert posts[0]["url"] == os.environ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"]
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
