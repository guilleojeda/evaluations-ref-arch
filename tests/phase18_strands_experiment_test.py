"""Acceptance tests for the native Strands S4 development experiment.

The fixture is deliberately assembled with the Phase 14--17 helpers.  Model
calls still run through the real captured-evidence runner; the only external
boundaries replaced here are Bedrock and AgentCore Evaluate.  The fake
CloudWatch Logs client returns the exact native span documents saved by the
runner, in the same ``@message`` rows consumed by :class:`CloudWatchSession`.

The product module and ``strands_evals`` SDK are imported lazily, after the
fixtures have been validated.  On the pre-Phase-18 baseline this produces a
clear missing-product failure rather than a module-import error during test
collection.
"""

from __future__ import annotations

import copy
from contextlib import redirect_stdout
import hashlib
import importlib
import inspect
from io import StringIO
from importlib.metadata import PackageNotFoundError, version as package_version
import json
import multiprocessing
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import boto3
from botocore.exceptions import ClientError

from phase14_reviewed_cases_test import make_case, write_bundle
from phase15_deterministic_checks_test import recommendation, report_for
from phase16_baseline_test import EVALUATOR_ID, MODEL_ID, ScriptedBedrock

import evaluate_case
from agentcore_evaluation import evaluator_config
from reviewed_cases import freeze_case


ROOT = Path(__file__).resolve().parents[1]
AGENT = ROOT / "agent"
ACCOUNT = evaluate_case.ACCOUNT
REGION = evaluate_case.REGION
LOG_GROUP = evaluate_case.LOG_GROUP


class RecordingBedrock(ScriptedBedrock):
    """Scripted Bedrock with a one-shot hook after a request is recorded."""

    def __init__(self, report, task, *, reads=None, after_first=None, observe_env=None, before_first=None):
        super().__init__(report, task, reads=reads)
        self._after_first = after_first
        self._observe_env = observe_env
        self._before_first = before_first

    def converse_stream(self, **request):
        if not self.requests and self._before_first is not None:
            callback = self._before_first
            self._before_first = None
            callback()
        if self._observe_env is not None:
            self._observe_env(os.environ.get("AGENT_OBSERVABILITY_ENABLED"))
        response = super().converse_stream(**request)
        if len(self.requests) == 1 and self._after_first is not None:
            callback = self._after_first
            self._after_first = None
            callback()
        return response


class BlockingBedrock(RecordingBedrock):
    """Block one candidate request so a process can be terminated mid-suite."""

    def __init__(self, report, task, entered, release):
        super().__init__(report, task, reads=({"resource": "inventory"},))
        self.entered = entered
        self.release = release

    def converse_stream(self, **request):
        self.entered.set()
        if not self.release.wait(15):
            raise TimeoutError("phase18 process-loss fixture was not released")
        return super().converse_stream(**request)


class BlockingFirstBedrock(RecordingBedrock):
    """Block the first case while exposing whether the next case started."""

    def __init__(self, report, task, entered, release):
        super().__init__(report, task, reads=({"resource": "inventory"},))
        self.entered = entered
        self.release = release

    def converse_stream(self, **request):
        self.entered.set()
        if not self.release.wait(15):
            raise TimeoutError("phase18 first-case fixture was not released")
        return super().converse_stream(**request)


def _child_run_experiment_process(suite, output_root, evaluator, entered, release):
    """Run the two-case experiment until its second case is in-flight."""

    module = importlib.import_module("development_experiment")
    suite_path = Path(suite)
    cases = []
    for label, action in (
        ("denial", recommendation("Increase memory", "inventory", 512, "MB")),
        ("capacity", recommendation("Increase memory", "inventory", 512, "MB")),
    ):
        case_path = suite_path.parent / "cases" / f"{label}.frozen.json"
        case = json.loads(case_path.read_bytes()).get("case")
        cases.append(RecordingBedrock(report_for(action), case["task"], reads=({"resource": "inventory"},)))
    cases[1] = BlockingBedrock(
        report_for(recommendation("Increase memory", "inventory", 512, "MB")),
        json.loads((suite_path.parent / "cases/capacity.frozen.json").read_bytes())["case"]["task"],
        entered,
        release,
    )
    model_session = CaseDispatchSession(cases)
    aws = FakeAWS(output_root)
    with patch.object(boto3, "Session", side_effect=aws.session_factory):
        module.run_experiment(
            suite_path,
            Path(output_root),
            candidate_id="faulty",
            evaluator_path=Path(evaluator),
            wait_seconds=0,
            model_session=model_session,
        )


def _child_blocking_judge_process(suite, output_root, evaluator, entered, release):
    """Run a completed faulty execution, then hold its first semantic judge."""

    module = importlib.import_module("development_experiment")
    suite_path = Path(suite)
    clients = []
    for label in ("denial", "capacity"):
        case = json.loads((suite_path.parent / "cases" / f"{label}.frozen.json").read_bytes())["case"]
        clients.append(RecordingBedrock(report_for(recommendation("Increase memory", "inventory", 512, "MB")), case["task"], reads=({"resource": "inventory"},)))
    aws = FakeAWS(output_root)
    aws.evaluate = BlockingEvaluate(entered, release)
    aws.clients["bedrock-agentcore"] = aws.evaluate
    with patch.object(boto3, "Session", side_effect=aws.session_factory):
        module.run_experiment(
            suite_path,
            Path(output_root),
            candidate_id="faulty",
            evaluator_path=Path(evaluator),
            wait_seconds=0,
            model_session=CaseDispatchSession(clients),
        )


def _child_active_source_process(case_path, bundle_path, source_root, source_directory, task, entered, release):
    """Leave a real Phase 17 captured execution active after source snapshot."""

    from captured_execution import run_captured_case
    import captured_execution

    source = BlockingBedrock(report_for(recommendation("Restore inventory access", "inventory", "75", "version")), task, entered, release)
    with patch.object(captured_execution, "AGENT_DIRECTORY", Path(source_directory)):
        run_captured_case(case_path, bundle_path, source_root, candidate_id="repaired", model_session=source)


class CaseDispatchSession:
    """Return one real scripted Bedrock client per sequential case."""

    def __init__(self, clients):
        self.clients = list(clients)
        self.index = 0

    def client(self, service_name, **_kwargs):
        if service_name != "bedrock-runtime":
            raise AssertionError(f"model session requested unexpected service {service_name}")
        if self.index >= len(self.clients):
            raise AssertionError("experiment executed more candidate model sessions than selected cases")
        client = self.clients[self.index]
        self.index += 1
        return client


class RetryOnceAcquisitionSession:
    """Fail only the first Bedrock client acquisition, then serve case two."""

    def __init__(self, later_client):
        self.later_client = later_client
        self.calls = 0

    def client(self, service_name, **_kwargs):
        self.assert_service(service_name)
        self.calls += 1
        if self.calls == 1:
            raise ClientError(
                {"Error": {"Code": "ThrottlingException", "Message": "phase18 acquisition throttle"}},
                "CreateClient",
            )
        if self.calls == 2:
            return self.later_client
        raise AssertionError("native task retry or duplicate execution acquired another Bedrock client")

    @staticmethod
    def assert_service(service_name):
        if service_name != "bedrock-runtime":
            raise AssertionError(f"model session requested unexpected service {service_name}")


class FakeLogs:
    """CloudWatch Logs transport returning saved native span ``@message`` rows."""

    _SESSION = re.compile(r'"session\.id"(?:\\s\*|\s*):(?:\\s\*|\s*)"([A-Za-z0-9._:-]+)"')
    _TRACE = re.compile(r'"traceId"(?:\\s\*|\s*):(?:\\s\*|\s*)"([0-9a-fA-F]{32})"')

    def __init__(self, output_root):
        self.output_root = Path(output_root)
        self.queries = []
        self._results = {}
        self.write_calls = []

    def create_log_group(self, **request):
        self.write_calls.append(("create_log_group", request))
        return {}

    def create_log_stream(self, **request):
        self.write_calls.append(("create_log_stream", request))
        return {}

    def put_log_events(self, **request):
        self.write_calls.append(("put_log_events", request))
        return {"nextSequenceToken": "phase18"}

    def start_query(self, **request):
        query_id = f"phase18-query-{len(self.queries) + 1}"
        self.queries.append(request)
        query = request.get("queryString", "")
        session_match = self._SESSION.search(query)
        trace_match = self._TRACE.search(query)
        if session_match is None or trace_match is None:
            raise AssertionError(f"CloudWatch query did not bind session and trace: {query}")
        session_id, trace_id = session_match.group(1), trace_match.group(1)
        spans = []
        for native_path in sorted(self.output_root.rglob("strands.native-spans.json")):
            document = json.loads(native_path.read_bytes())
            for span in document.get("spans", []):
                attrs = span.get("attributes", {})
                nested = attrs.get("attributes", attrs) if isinstance(attrs, dict) else {}
                if nested.get("session.id") == session_id and span.get("traceId") == trace_id:
                    spans.append(span)
        self._results[query_id] = spans
        return {"queryId": query_id}

    def get_query_results(self, *, queryId):
        spans = self._results[queryId]
        rows = [[{"field": "@message", "value": json.dumps(span, separators=(",", ":"))}] for span in spans]
        return {"status": "Complete", "results": rows, "statistics": {"recordsMatched": len(rows)}}

    def stop_query(self, **_kwargs):
        return None


class FakeEvaluate:
    """Native Evaluate transport with a categorical row and call ledger."""

    def __init__(self, *, label="pass", explanation="The captured session supports the reviewed criteria.", error_code=None, retry_once=False, observe_env=None, token_usage=None):
        self.label = label
        self.explanation = explanation
        self.error_code = error_code
        self.retry_once = retry_once
        self.observe_env = observe_env
        self.token_usage = token_usage
        self.calls = []

    def evaluate(self, **request):
        if self.observe_env is not None:
            self.observe_env(os.environ.get("AGENT_OBSERVABILITY_ENABLED"))
        self.calls.append(copy.deepcopy(request))
        if self.error_code is not None and (not self.retry_once or len(self.calls) == 1):
            raise ClientError(
                {"Error": {"Code": self.error_code, "Message": "phase18 scripted evaluator failure"}},
                "Evaluate",
            )
        spans = request.get("evaluationInput", {}).get("sessionSpans", [])
        def session_from(span):
            attrs = span.get("attributes", {}) if isinstance(span, dict) else {}
            attrs = attrs.get("attributes", attrs) if isinstance(attrs, dict) else {}
            return attrs.get("session.id") if isinstance(attrs, dict) else None

        session_id = next((session_from(span) for span in spans if session_from(span)), "unknown-session")
        trace_id = next((span.get("traceId") for span in spans if isinstance(span, dict)), "0" * 32)
        result = {
            "evaluationResults": [{
                "evaluatorId": EVALUATOR_ID,
                "context": {"spanContext": {"sessionId": session_id, "traceId": trace_id}},
                "label": self.label,
                "explanation": self.explanation,
            }]
        }
        if self.token_usage is not None:
            result["evaluationResults"][0]["tokenUsage"] = copy.deepcopy(self.token_usage)
        return result


class BlockingEvaluate(FakeEvaluate):
    """Hold the first judge call while the saved rejection is inspected."""

    def __init__(self, entered, release):
        super().__init__(label="pass")
        self.entered = entered
        self.release = release

    def evaluate(self, **request):
        self.entered.set()
        if not self.release.wait(15):
            raise TimeoutError("phase18 judge fixture was not released")
        return super().evaluate(**request)


class FakeControl:
    def __init__(self, *, mode="single", error_code=None):
        self.mode = mode
        self.error_code = error_code
        self.calls = []

    def get_evaluator(self, **request):
        self.calls.append(request)
        if self.error_code is not None:
            raise ClientError(
                {"Error": {"Code": self.error_code, "Message": "phase18 scripted evaluator configuration failure"}},
                "GetEvaluator",
            )
        config = evaluator_config(MODEL_ID, self.mode)
        return {
            "evaluatorId": EVALUATOR_ID,
            "evaluatorArn": f"arn:aws:bedrock-agentcore:{REGION}:{ACCOUNT}:evaluator/{EVALUATOR_ID}",
            "evaluatorConfig": config,
            "status": "ACTIVE",
            "level": "SESSION",
        }


class FakeAWS:
    """Global boto3.Session substitute for STS, control, Logs and Evaluate."""

    def __init__(self, output_root, *, label="pass", explanation=None, error_code=None, retry_once=False, observe_judge_env=None, token_usage=None, control_error=None):
        self.output_root = Path(output_root)
        self.control = FakeControl(error_code=control_error)
        self.evaluate = FakeEvaluate(
            label=label,
            explanation=explanation or "The captured session supports the reviewed criteria.",
            error_code=error_code,
            retry_once=retry_once,
            observe_env=observe_judge_env,
            token_usage=token_usage,
        )
        self.logs = FakeLogs(self.output_root)
        self.clients = {
            "sts": SimpleNamespace(get_caller_identity=lambda: {"Account": ACCOUNT}),
            "bedrock-agentcore-control": self.control,
            "logs": self.logs,
            "bedrock-agentcore": self.evaluate,
        }
        self.sessions = []

    def session_factory(self, **_kwargs):
        self.sessions.append(self)
        return self

    def client(self, name, **_kwargs):
        try:
            return self.clients[name]
        except KeyError as exc:
            raise AssertionError(f"AWS substitute requested unexpected service {name}") from exc


class Phase18StrandsExperimentAcceptance(unittest.TestCase):
    """Phase 18 acceptance at the public development experiment boundary."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.bundle = self.root / "capture.json"
        self.origin = write_bundle(self.bundle)
        self.cases_dir = self.root / "cases"
        self.cases_dir.mkdir()
        self.runs = self.root / "experiments"
        self.suite = self.root / "suite.json"
        self.source_workspaces = {}
        self.case_paths = {}
        for label in ("denial", "capacity"):
            case = make_case(self.bundle, self.origin["runId"])
            case["caseId"] = f"phase18.synthetic-{label}"
            if label == "capacity":
                case["task"]["symptoms"] = ["Inventory throttling increased during a finite catalog surge."]
                case["expectations"]["diagnosis"] = "Inventory capacity was insufficient for the observed surge."
            source = self.cases_dir / f"{label}.json"
            source.write_text(json.dumps(case, indent=2) + "\n", encoding="utf-8")
            frozen = self.cases_dir / f"{label}.frozen.json"
            freeze_case(source, self.bundle, frozen)
            self.case_paths[label] = frozen
        self.suite_data = {
            "schemaVersion": 1,
            "cases": [
                {"case": "cases/denial.frozen.json", "bundle": "capture.json"},
                {"case": "cases/capacity.frozen.json", "bundle": "capture.json"},
            ],
        }
        self.suite.write_text(json.dumps(self.suite_data, indent=2) + "\n", encoding="utf-8")
        self.evaluator = self.root / "evaluator.json"
        config = evaluator_config(MODEL_ID, "single")
        self.evaluator.write_text(json.dumps({
            "evaluatorId": EVALUATOR_ID,
            "evaluatorArn": f"arn:aws:bedrock-agentcore:{REGION}:{ACCOUNT}:evaluator/{EVALUATOR_ID}",
            "judgeModelId": MODEL_ID,
            "evaluatorMode": "single",
            "configSha256": self._digest(config),
        }, indent=2) + "\n", encoding="utf-8")
        self.source_workspaces["faulty"] = self._make_source_workspace("faulty")
        self.source_workspaces["repaired"] = self._make_source_workspace("repaired")

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def _digest(value):
        return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

    def _make_source_workspace(self, candidate):
        import captured_execution

        workspace = self.root / f"source-{candidate}"
        workspace.mkdir()
        for name in (*captured_execution.SOURCE_FILES, *captured_execution.DEPENDENCY_FILES):
            target = workspace / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(AGENT / name, target)
        for name in (
            "development_experiment.py",
            "strands_evaluators.py",
            "evaluate_case.py",
            "agentcore_evaluation.py",
            "evaluation_telemetry.py",
            "deterministic_checks.py",
        ):
            source = AGENT / name
            if source.is_file():
                shutil.copy2(source, workspace / name)
        if candidate == "repaired":
            prompt = workspace / "prompt.py"
            original_manifest = (workspace / "agent-manifest.json").read_bytes()
            prompt.write_bytes(prompt.read_bytes().replace(
                b"Candidate recommendation rule:",
                b"Candidate recommendation rule: PHASE18_REPAIRED_SOURCE_MARKER",
                1,
            ))
            # Reproduce a prompt-only editor save: the checked-in development
            # manifest remains untouched and is bound during snapshotting.
            self.assertEqual((workspace / "agent-manifest.json").read_bytes(), original_manifest)
        return workspace

    def product(self):
        """Import the product only after fixture setup, with a clear baseline error."""

        module_path = AGENT / "development_experiment.py"
        if not module_path.is_file():
            self.fail("Phase 18 product module is missing: agent/development_experiment.py")
        importlib.invalidate_caches()
        try:
            return importlib.import_module("development_experiment")
        except ModuleNotFoundError as exc:
            self.fail(f"Phase 18 product module exists but its native SDK dependency is unavailable: {exc}")
        except Exception as exc:
            self.fail(f"Phase 18 product module failed to import: {type(exc).__name__}: {exc}")

    def native_types(self):
        """Require the real 1.9.0 SDK types after the product module exists."""

        self.product()
        try:
            try:
                self.assertEqual(package_version("strands-agents-evals"), "1.9.0")
            except PackageNotFoundError as exc:
                self.fail(f"native strands-agents-evals 1.9.0 distribution is unavailable: {exc}")
            sdk = importlib.import_module("strands_evals")
            evaluator_types = importlib.import_module("strands_evals.evaluators")
            report_types = importlib.import_module("strands_evals.types.evaluation_report")
            return sdk.Case, sdk.Experiment, evaluator_types.Evaluator, report_types.EvaluationReport
        except (ImportError, AttributeError) as exc:
            self.fail(f"native strands_evals 1.9.0 API is unavailable: {exc}")

    def invoke(self, module, *arguments):
        """Invoke either supported public ``main(argv)`` or repository-style ``main()``."""

        output = StringIO()
        main = getattr(module, "main", None)
        if not callable(main):
            self.fail("development_experiment.py does not expose public main")
        with redirect_stdout(output):
            if "argv" in inspect.signature(main).parameters:
                code = main(list(map(str, arguments)))
            else:
                with patch.object(sys, "argv", ["development_experiment.py", *map(str, arguments)]):
                    code = main()
        text = output.getvalue().strip()
        self.assertTrue(text, "public CLI did not emit a JSON result")
        try:
            result = json.loads(text)
        except json.JSONDecodeError:
            result = json.loads(text.splitlines()[-1])
        return (0 if code is None else code), result

    def rescore_saved_execution(self, run_dir, output_root):
        """Use the existing Phase 17 score CLI to add an explicit rejudge."""

        aws = FakeAWS(output_root)
        output = StringIO()
        with patch.object(boto3, "Session", side_effect=aws.session_factory):
            with patch.object(sys, "argv", [
                "evaluate_case.py", "score", "--run", str(run_dir),
                "--evaluator", str(self.evaluator), "--wait-seconds", "0",
            ]), redirect_stdout(output):
                code = evaluate_case.main()
        text = output.getvalue().strip()
        result = json.loads(text.splitlines()[-1]) if text else {}
        return (0 if code is None else code), result, aws

    def _clients(self, candidate, *, after_first=None, reports=None, reads_by_label=None, observe_env=None):
        reports = reports or {}
        clients = []
        for label in ("denial", "capacity"):
            action = (
                recommendation("Restore inventory access", "inventory", "75", "version")
                if candidate == "repaired"
                else recommendation("Increase memory", "inventory", 512, "MB")
            )
            if label in reports:
                action = reports[label]
            report = report_for(action)
            callback = after_first if not clients else None
            reads = (reads_by_label or {}).get(label, ({"resource": "inventory"},))
            clients.append(RecordingBedrock(report, self._case(label)["task"], reads=reads, after_first=callback, observe_env=observe_env))
        return CaseDispatchSession(clients), clients

    def _case(self, label):
        value = json.loads(self.case_paths[label].read_bytes())
        return value.get("case", value)

    def _read_record(self, experiment):
        for path in sorted(Path(experiment).rglob("*.json")):
            try:
                value = json.loads(path.read_bytes())
            except (OSError, ValueError):
                continue
            if isinstance(value, dict) and isinstance(value.get("experimentId"), str) and isinstance(value.get("cases"), list):
                return value
        self.fail(f"canonical experiment record missing under {experiment}")

    @staticmethod
    def _rows(record):
        rows = record.get("cases")
        if not isinstance(rows, list):
            raise AssertionError("canonical experiment record must contain a cases list")
        return rows

    def _record_path(self, experiment):
        for path in sorted(Path(experiment).rglob("*.json")):
            try:
                value = json.loads(path.read_bytes())
            except (OSError, ValueError):
                continue
            if isinstance(value, dict) and isinstance(value.get("experimentId"), str) and isinstance(value.get("cases"), list):
                return path
        self.fail(f"canonical experiment record missing under {experiment}")

    def _native_report_path(self, experiment):
        EvaluationReport = self.native_types()[3]
        for path in sorted(Path(experiment).rglob("*.json")):
            try:
                if isinstance(EvaluationReport.from_file(str(path)), EvaluationReport):
                    return path
            except Exception:
                continue
        self.fail(f"native evaluation report missing under {experiment}")

    def _source_run(self, candidate="faulty"):
        """Create an authenticated Phase 17 execution usable as a source snapshot."""

        import captured_execution
        from captured_execution import run_captured_case
        from opentelemetry import trace
        from opentelemetry.sdk.trace import TracerProvider

        if not isinstance(trace.get_tracer_provider(), TracerProvider):
            trace.set_tracer_provider(TracerProvider())

        source_root = self.root / "source-runs"
        source_root.mkdir()
        report = report_for(recommendation("Increase memory", "inventory", 512, "MB"))
        source = ScriptedBedrock(report, self._case("denial")["task"], reads=({"resource": "inventory"},))
        with patch.object(captured_execution, "AGENT_DIRECTORY", self.source_workspaces[candidate]):
            return Path(run_captured_case(
                self.case_paths["denial"], self.bundle, source_root,
                candidate_id=candidate, model_session=source,
            ))

    def run_experiment(self, candidate="faulty", *, selected=None, after_first=None, reports=None, label="pass", explanation=None, source_run=None, reads_by_label=None, evaluate_error=None, retry_once=False, observe_env=None, observe_judge_env=None, token_usage=None, control_error=None):
        module = self.product()
        model_session, clients = self._clients(candidate, after_first=after_first, reports=reports, reads_by_label=reads_by_label, observe_env=observe_env)
        aws = FakeAWS(self.runs, label=label, explanation=explanation, error_code=evaluate_error, retry_once=retry_once, observe_judge_env=observe_judge_env, token_usage=token_usage, control_error=control_error)
        kwargs = {
            "suite_path": self.suite,
            "output_root": self.runs,
            "candidate_id": candidate,
            "evaluator_path": self.evaluator,
            "wait_seconds": 0,
            "model_session": model_session,
        }
        if selected is not None:
            kwargs["selected_cases"] = selected
        if source_run is not None:
            kwargs["source_run"] = source_run
        source_directory = self.source_workspaces[candidate]
        if "source_directory" in inspect.signature(module.run_experiment).parameters:
            kwargs["source_directory"] = source_directory
            with patch.object(boto3, "Session", side_effect=aws.session_factory):
                result = module.run_experiment(**kwargs)
        else:
            import captured_execution
            with patch.object(captured_execution, "AGENT_DIRECTORY", source_directory):
                with patch.object(boto3, "Session", side_effect=aws.session_factory):
                    result = module.run_experiment(**kwargs)
        return Path(result), clients, aws

    def test_phase17_saved_spans_round_trip_through_real_cloudwatch_session_fixture(self):
        # This contract check is intentionally independent of the missing
        # Phase 18 module: it proves the transport substitute emits the exact
        # saved native spans that the existing scorer authenticates.
        with redirect_stdout(StringIO()):
            source = self._source_run()
        code, result, aws = self.rescore_saved_execution(source, self.root / "source-runs")
        self.assertEqual(code, 0, result)
        self.assertEqual(result.get("status"), "complete", result)
        self.assertEqual(result.get("semantic", {}).get("status"), "complete", result)
        self.assertEqual(len(aws.logs.queries), 1)
        self.assertEqual(len(aws.logs._results["phase18-query-1"]), len(json.loads((source / "strands.native-spans.json").read_bytes())["spans"]))
        self.assertEqual(len(aws.evaluate.calls), 1)

    def test_sdk_observability_flag_does_not_autopublish_numeric_results_or_create_log_resources(self):
        # Strands Evals' optional numeric logger is not the evidence path. The
        # experiment must keep the existing ADOT/native trace transport and
        # leave the SDK logger disabled even when this process-wide flag is on.
        module = self.product()
        from opentelemetry import trace
        from opentelemetry.sdk.trace import TracerProvider

        if not isinstance(trace.get_tracer_provider(), TracerProvider):
            trace.set_tracer_provider(TracerProvider())
        observed = []
        judge_observed = []
        flush_observed = []
        provider = trace.get_tracer_provider()
        original_flush = provider.force_flush

        def spy_flush(*args, **kwargs):
            flush_observed.append(os.environ.get("AGENT_OBSERVABILITY_ENABLED"))
            return original_flush(*args, **kwargs)

        with patch.dict(os.environ, {"AGENT_OBSERVABILITY_ENABLED": "sentinel"}):
            with patch.object(provider, "force_flush", side_effect=spy_flush):
                experiment, _clients, aws = self.run_experiment(
                    candidate="repaired",
                    selected=["phase18.synthetic-denial"],
                    observe_env=observed.append,
                    observe_judge_env=judge_observed.append,
                )
            self.assertEqual(os.environ.get("AGENT_OBSERVABILITY_ENABLED"), "sentinel")
        self.assertTrue(experiment.is_dir())
        self.assertTrue(observed)
        self.assertEqual(set(observed), {"true"})
        self.assertTrue(flush_observed)
        self.assertEqual(set(flush_observed), {"true"})
        self.assertEqual(set(judge_observed), {""})
        self.assertEqual(aws.logs.write_calls, [])
        self.assertEqual(len(aws.evaluate.calls), 1)

    def test_validation_rejects_duplicate_case_ids_and_missing_selected_inputs_before_inference(self):
        module = self.product()
        duplicate = self.root / "duplicate-suite.json"
        duplicate.write_text(json.dumps({"schemaVersion": 1, "cases": [
            {"case": "cases/denial.frozen.json", "bundle": "capture.json"},
            {"case": "cases/denial.frozen.json", "bundle": "capture.json"},
        ]}), encoding="utf-8")
        calls = []
        session = SimpleNamespace(client=lambda *_args, **_kwargs: calls.append(True))
        with self.assertRaises((ValueError, SystemExit)) as duplicate_error:
            module.run_experiment(duplicate, self.runs, candidate_id="faulty", evaluator_path=self.evaluator, wait_seconds=0, model_session=session)
        self.assertRegex(str(duplicate_error.exception).lower(), r"duplicate|case")
        missing = self.root / "missing-suite.json"
        missing.write_text(json.dumps({"schemaVersion": 1, "cases": [
            {"case": "cases/no-such.frozen.json", "bundle": "capture.json"},
        ]}), encoding="utf-8")
        with self.assertRaises((ValueError, FileNotFoundError, SystemExit)) as missing_error:
            module.run_experiment(missing, self.runs, candidate_id="faulty", evaluator_path=self.evaluator, wait_seconds=0, model_session=session)
        self.assertRegex(str(missing_error.exception).lower(), r"missing|not found|case|input")
        self.assertEqual(calls, [], "input validation must finish before model construction/inference")

        for selected in ([""], ["phase18.synthetic-denial", "phase18.synthetic-denial"], ["phase18.unknown"]):
            with self.subTest(selected=selected):
                with self.assertRaises((ValueError, SystemExit)) as focus_error:
                    module.run_experiment(
                        self.suite,
                        self.runs,
                        candidate_id="faulty",
                        evaluator_path=self.evaluator,
                        wait_seconds=0,
                        selected_cases=selected,
                        model_session=session,
                    )
                self.assertRegex(str(focus_error.exception).lower(), r"case|selected|unknown|empty|duplicate")
                self.assertEqual(calls, [], "focus validation must finish before model construction/inference")

    def test_selected_cases_run_sequentially_once_and_snapshot_all_inputs_before_first_model_call(self):
        original_case = self._case("capacity")
        original_bundle = self.bundle.read_bytes()
        original_suite = self.suite.read_bytes()
        original_evaluator = self.evaluator.read_bytes()
        mutated = copy.deepcopy(original_case)
        mutated["task"]["referenceTime"] = "2099-01-01T00:00:00.000Z"
        mutated["task"]["incidentWindow"]["end"] = mutated["task"]["referenceTime"]
        mutated["review"]["coverageJustification"] = "mutated after the first model call"

        def mutate_later_case():
            self.case_paths["capacity"].write_text(json.dumps(mutated), encoding="utf-8")
            bundle = json.loads(self.bundle.read_bytes())
            bundle["origin"]["runId"] = "phase18-late-bundle-edit"
            self.bundle.write_text(json.dumps(bundle), encoding="utf-8")
            prompt = self.source_workspaces["faulty"] / "prompt.py"
            prompt.write_text(prompt.read_text(encoding="utf-8") + "\nPHASE18_LATE_PROMPT_EDIT\n", encoding="utf-8")
            tooling = self.source_workspaces["faulty"] / "captured_execution.py"
            tooling.write_text(tooling.read_text(encoding="utf-8") + "\nPHASE18_LATE_TOOLING_EDIT\n", encoding="utf-8")
            for name in ("development_experiment.py", "strands_evaluators.py", "evaluate_case.py", "agentcore_evaluation.py", "evaluation_telemetry.py", "deterministic_checks.py"):
                path = self.source_workspaces["faulty"] / name
                if path.is_file():
                    path.write_text(path.read_text(encoding="utf-8") + "\nPHASE18_LATE_DRIVER_EDIT\n", encoding="utf-8")
            self.suite.write_text(json.dumps({"schemaVersion": 1, "cases": []}), encoding="utf-8")
            self.evaluator.write_text("{}", encoding="utf-8")

        experiment, clients, _aws = self.run_experiment(after_first=mutate_later_case)
        self.assertEqual(len(clients), 2)
        self.assertEqual(len(clients[0].requests) >= 1, True)
        self.assertEqual(len(clients[1].requests) >= 1, True)
        all_requests = json.dumps([*clients[0].requests, *clients[1].requests])
        self.assertNotIn("2099-01-01T00:00:00.000Z", all_requests)
        self.assertNotIn("admissibleRecommendations", all_requests)
        self.assertNotIn("coverageJustification", all_requests)
        self.assertNotIn("PHASE18_LATE_PROMPT_EDIT", all_requests)
        record = self._read_record(experiment)
        self.assertEqual(record.get("status"), "complete")
        self.assertEqual(record.get("candidateId"), "faulty")
        self.assertEqual(len(record.get("cases", [])), 2)
        self.assertTrue(record.get("snapshot", {}).get("caseSetSha256") or record.get("caseSetSha256"))
        self.assertTrue(any(path.read_bytes() == original_bundle for path in experiment.rglob("bundle.json")))
        self.assertTrue(any(path.read_bytes() == original_suite for path in experiment.rglob("suite.json")))
        self.assertTrue(any(path.read_bytes() == original_evaluator for path in experiment.rglob("evaluator.json")))
        prompt_snapshots = list(experiment.rglob("prompt.py"))
        self.assertTrue(prompt_snapshots)
        self.assertTrue(all("PHASE18_LATE_PROMPT_EDIT" not in path.read_text(encoding="utf-8") for path in prompt_snapshots))
        tooling_snapshots = list(experiment.rglob("captured_execution.py"))
        self.assertTrue(tooling_snapshots)
        self.assertTrue(all("PHASE18_LATE_TOOLING_EDIT" not in path.read_text(encoding="utf-8") for path in tooling_snapshots))
        for name in ("development_experiment.py", "strands_evaluators.py", "evaluate_case.py", "agentcore_evaluation.py", "evaluation_telemetry.py", "deterministic_checks.py"):
            snapshots = list(experiment.rglob(name))
            self.assertTrue(snapshots, f"experiment did not snapshot required tooling file {name}")
            self.assertTrue(all("PHASE18_LATE_DRIVER_EDIT" not in path.read_text(encoding="utf-8") for path in snapshots))

    def test_second_case_transport_does_not_start_until_first_case_completes(self):
        import captured_execution

        module = self.product()
        entered = threading.Event()
        release = threading.Event()
        first_case = self._case("denial")
        second_case = self._case("capacity")
        first = BlockingFirstBedrock(
            report_for(recommendation("Increase memory", "inventory", 512, "MB")),
            first_case["task"],
            entered,
            release,
        )
        first_complete_before_second = []

        def observe_second_start():
            execution_records = []
            for path in self.runs.rglob("execution.json"):
                try:
                    execution_records.append(json.loads(path.read_bytes()))
                except (OSError, ValueError):
                    continue
            first_complete_before_second.append(any(
                row.get("status") == "complete"
                and row.get("identity", {}).get("caseSha256") == json.loads(self.case_paths["denial"].read_bytes())["caseSha256"]
                for row in execution_records
            ))

        second = RecordingBedrock(
            report_for(recommendation("Increase memory", "inventory", 512, "MB")),
            second_case["task"],
            reads=({"resource": "inventory"},),
            before_first=observe_second_start,
        )
        model_session = CaseDispatchSession([first, second])
        aws = FakeAWS(self.runs)
        outcome = {}

        def launch():
            try:
                with patch.object(captured_execution, "AGENT_DIRECTORY", self.source_workspaces["faulty"]):
                    with patch.object(boto3, "Session", side_effect=aws.session_factory):
                        outcome["experiment"] = Path(module.run_experiment(
                            self.suite,
                            self.runs,
                            candidate_id="faulty",
                            evaluator_path=self.evaluator,
                            wait_seconds=0,
                            model_session=model_session,
                        ))
            except BaseException as exc:
                outcome["error"] = exc

        thread = threading.Thread(target=launch)
        thread.start()
        self.assertTrue(entered.wait(10), "first case never reached its model transport")
        self.assertEqual(model_session.index, 1)
        self.assertEqual(second.requests, [], "second case transport started before first case completed")
        release.set()
        thread.join(20)
        self.assertFalse(thread.is_alive())
        self.assertNotIn("error", outcome)
        self.assertTrue(second.requests)
        self.assertEqual(first_complete_before_second, [True])
        self.assertEqual(len(aws.evaluate.calls), 2)
        self.assertEqual(self._read_record(outcome["experiment"])["status"], "complete")

    def test_task_acquisition_throttle_is_one_typed_incomplete_case_then_later_case_runs_once(self):
        import captured_execution

        module = self.product()
        later_case = self._case("capacity")
        later_client = RecordingBedrock(
            report_for(recommendation("Increase memory", "inventory", 512, "MB")),
            later_case["task"],
            reads=({"resource": "inventory"},),
        )
        model_session = RetryOnceAcquisitionSession(later_client)
        aws = FakeAWS(self.runs)
        with patch.object(captured_execution, "AGENT_DIRECTORY", self.source_workspaces["faulty"]):
            with patch.object(boto3, "Session", side_effect=aws.session_factory):
                experiment = Path(module.run_experiment(
                    self.suite,
                    self.runs,
                    candidate_id="faulty",
                    evaluator_path=self.evaluator,
                    wait_seconds=0,
                    model_session=model_session,
                ))
        self.assertEqual(model_session.calls, 2)
        self.assertEqual(later_client.requests != [], True)
        self.assertEqual(len(aws.evaluate.calls), 1)
        rows = self._rows(self._read_record(experiment))
        self.assertEqual(rows[0]["caseId"], "phase18.synthetic-denial")
        self.assertIn(rows[0]["status"], {"incomplete", "error", "failed"})
        self.assertNotIn("semantic", rows[0])
        self.assertEqual(rows[1]["caseId"], "phase18.synthetic-capacity")
        self.assertEqual(rows[1]["status"], "complete")

    def test_each_case_reopens_through_existing_native_root_trace_validation(self):
        from captured_execution import load_execution

        experiment, _clients, _aws = self.run_experiment(candidate="faulty")
        execution_paths = sorted(experiment.rglob("execution.json"))
        self.assertEqual(len(execution_paths), 2)
        for path in execution_paths:
            record, _case, spans = load_execution(path.parent)
            self.assertEqual(record.get("status"), "complete")
            roots = []
            for span in spans:
                attrs = span.get("attributes", {}) if isinstance(span, dict) else {}
                attrs = attrs.get("attributes", attrs) if isinstance(attrs, dict) else {}
                if attrs.get("gen_ai.operation.name") == "invoke_agent":
                    roots.append(span)
            self.assertEqual(len(roots), 1)
            self.assertFalse(roots[0].get("parentSpanId") or roots[0].get("parent_id"), path)

    def test_process_loss_keeps_first_case_and_marks_second_incomplete_without_show_mutation(self):
        module = self.product()
        context = multiprocessing.get_context("fork")
        entered = context.Event()
        release = context.Event()
        process = context.Process(
            target=_child_run_experiment_process,
            args=(str(self.suite), str(self.runs), str(self.evaluator), entered, release),
        )
        process.start()
        experiment = None
        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                records = list(self.runs.rglob("*.json"))
                for path in records:
                    try:
                        value = json.loads(path.read_bytes())
                    except (OSError, ValueError):
                        continue
                    if isinstance(value, dict) and isinstance(value.get("experimentId"), str):
                        experiment = path.parent
                        break
                if experiment is not None and entered.wait(0.05):
                    break
                time.sleep(0.01)
            self.assertIsNotNone(experiment, "child experiment did not create a canonical record")
            self.assertTrue(entered.is_set(), "child never reached the second candidate execution")
            before_record = self._read_record(experiment)
            before_rows = self._rows(before_record)
            first_execution_id = before_rows[0].get("executionId")
            self.assertIsInstance(first_execution_id, str)
            self.assertTrue((experiment / "executions" / first_execution_id / "execution.json").is_file())
            before = {path.relative_to(experiment): path.read_bytes() for path in experiment.rglob("*") if path.is_file()}
        finally:
            if process.is_alive():
                process.terminate()
            process.join(10)
        self.assertFalse(process.is_alive())
        self.assertIsNotNone(experiment)
        with patch.object(boto3, "Session", side_effect=AssertionError("show must not open AWS")):
            code, shown = self.invoke(module, "show", "--experiment", experiment)
        self.assertEqual(code, 0, shown)
        self.assertIn(shown["status"], {"interrupted", "incomplete"})
        rows = self._rows(shown)
        self.assertEqual(rows[0]["caseId"], "phase18.synthetic-denial")
        self.assertEqual(rows[0]["executionId"], first_execution_id)
        self.assertIn("report", rows[0])
        self.assertEqual(rows[1]["caseId"], "phase18.synthetic-capacity")
        self.assertNotEqual(rows[1].get("status"), "complete")
        self.assertIsNone(rows[1].get("report"))
        rendered = json.dumps(shown).lower()
        self.assertIn("increase memory", rendered)
        self.assertRegex(rendered, r"incomplete|interrupted|pending|running")
        after = {path.relative_to(experiment): path.read_bytes() for path in experiment.rglob("*") if path.is_file()}
        self.assertEqual(before, after, "read-only show changed the process-loss experiment")

    def test_show_during_blocked_judge_exposes_deterministic_reject_without_starting_work(self):
        module = self.product()
        context = multiprocessing.get_context("fork")
        entered = context.Event()
        release = context.Event()
        process = context.Process(
            target=_child_blocking_judge_process,
            args=(str(self.suite), str(self.runs), str(self.evaluator), entered, release),
        )
        process.start()
        experiment = None
        try:
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                for path in self.runs.rglob("*.json"):
                    try:
                        value = json.loads(path.read_bytes())
                    except (OSError, ValueError):
                        continue
                    if isinstance(value, dict) and isinstance(value.get("experimentId"), str) and isinstance(value.get("cases"), list):
                        experiment = path.parent
                        break
                if experiment is not None and entered.wait(0.05):
                    break
                time.sleep(0.01)
            self.assertIsNotNone(experiment, "blocked judge did not create a canonical experiment")
            self.assertTrue(entered.is_set(), "blocked judge was not reached")
            pending_record = self._read_record(experiment)
            pending_row = self._rows(pending_record)[0]
            execution_id = pending_row.get("executionId")
            self.assertIsInstance(execution_id, str)
            score_receipts = sorted((experiment / "executions" / execution_id / "scores").glob("*/result.json"))
            self.assertEqual(len(score_receipts), 1)
            pending_receipt_path = score_receipts[0]
            pending_receipt = json.loads(pending_receipt_path.read_bytes())
            self.assertEqual(pending_receipt.get("status"), "pending")
            self.assertIn(pending_receipt.get("phase"), {"waiting_for_telemetry", "scoring"})
            selected_attempt = pending_receipt.get("scoringAttemptId")
            self.assertIsInstance(selected_attempt, str)
            self.assertEqual(pending_row.get("scoringAttemptId"), selected_attempt)
            self.assertEqual(pending_row.get("executionId"), pending_receipt.get("executionId"))
            before = {path.relative_to(experiment): path.read_bytes() for path in experiment.rglob("*") if path.is_file()}
            with patch.object(boto3, "Session", side_effect=AssertionError("show must not open AWS")):
                pre_code, pre_shown = self.invoke(module, "show", "--experiment", experiment)
            self.assertEqual(pre_code, 0, pre_shown)
            self.assertEqual(pre_shown["decision"]["verdict"], "reject")
            self.assertEqual(pre_shown["cases"][0]["deterministic"]["findings"]["action"]["verdict"], "fail")
            self.assertEqual(pre_shown["cases"][0].get("scoringAttemptId"), selected_attempt)
            self.assertEqual(pre_shown["cases"][0]["score"].get("status"), "pending")
            self.assertEqual(json.loads(pending_receipt_path.read_bytes()).get("status"), "pending")
            if process.is_alive():
                process.terminate()
            process.join(10)
            self.assertFalse(process.is_alive())
            with patch.object(boto3, "Session", side_effect=AssertionError("show must not open AWS")):
                code, shown = self.invoke(module, "show", "--experiment", experiment)
            self.assertEqual(code, 0, shown)
            self.assertEqual(shown["decision"]["verdict"], "reject")
            self.assertEqual(shown["cases"][0]["deterministic"]["findings"]["action"]["verdict"], "fail")
            self.assertIn(shown["cases"][0]["status"], {"interrupted", "incomplete"})
            interrupted_row = shown["cases"][0]
            self.assertEqual(interrupted_row.get("executionId"), execution_id)
            self.assertEqual(interrupted_row.get("scoringAttemptId"), selected_attempt)
            self.assertIsInstance(interrupted_row.get("score"), dict)
            self.assertEqual(interrupted_row["score"].get("scoringAttemptId"), selected_attempt)
            self.assertEqual(interrupted_row["score"].get("status"), "interrupted")
            self.assertIn("interrupted", json.dumps(interrupted_row).lower())
            self.assertEqual(json.loads(pending_receipt_path.read_bytes()).get("status"), "pending")
            after = {path.relative_to(experiment): path.read_bytes() for path in experiment.rglob("*") if path.is_file()}
            self.assertEqual(before, after)
        finally:
            if process.is_alive():
                process.terminate()
            process.join(10)
        self.assertFalse(process.is_alive())

    def test_selected_case_filter_runs_only_that_case_and_records_the_exact_selection(self):
        module = self.product()
        model_session, clients = self._clients("faulty")
        aws = FakeAWS(self.runs)
        selected = ["phase18.synthetic-denial"]
        with patch.object(boto3, "Session", side_effect=aws.session_factory):
            experiment = Path(module.run_experiment(
                self.suite,
                self.runs,
                candidate_id="faulty",
                evaluator_path=self.evaluator,
                wait_seconds=0,
                selected_cases=selected,
                model_session=model_session,
            ))
        self.assertEqual(model_session.index, 1)
        self.assertEqual(len(clients[0].requests) > 0, True)
        self.assertEqual(len(clients[1].requests), 0)
        record = self._read_record(experiment)
        self.assertEqual([row["caseId"] for row in self._rows(record)], ["phase18.synthetic-denial"])

    def test_repeating_identical_suite_creates_fresh_experiment_and_execution_ids(self):
        first, first_clients, first_aws = self.run_experiment(candidate="faulty")
        second, second_clients, second_aws = self.run_experiment(candidate="faulty")
        self.assertNotEqual(first, second)
        self.assertEqual(len(first_clients), 2)
        self.assertEqual(len(second_clients), 2)
        self.assertTrue(all(client.requests for client in first_clients))
        self.assertTrue(all(client.requests for client in second_clients))
        self.assertEqual(len(first_aws.evaluate.calls), 2)
        self.assertEqual(len(second_aws.evaluate.calls), 2)
        first_record = self._read_record(first)
        second_record = self._read_record(second)
        self.assertNotEqual(first_record.get("experimentId"), second_record.get("experimentId"))
        first_rows = self._rows(first_record)
        second_rows = self._rows(second_record)
        self.assertEqual([row["caseId"] for row in first_rows], [row["caseId"] for row in second_rows])
        first_ids = {row["executionId"] for row in first_rows}
        second_ids = {row["executionId"] for row in second_rows}
        self.assertTrue(all(first_ids), first_rows)
        self.assertTrue(all(second_ids), second_rows)
        self.assertFalse(first_ids & second_ids)
        first_prompts = {row["promptSha256"] for row in first_rows}
        second_prompts = {row["promptSha256"] for row in second_rows}
        self.assertTrue(all(re.fullmatch(r"[0-9a-f]{64}", value) for value in first_prompts))
        self.assertTrue(all(re.fullmatch(r"[0-9a-f]{64}", value) for value in second_prompts))
        self.assertEqual(first_prompts, second_prompts)
        first_sessions = {row["sessionId"] for row in first_rows}
        second_sessions = {row["sessionId"] for row in second_rows}
        first_traces = {row["traceId"] for row in first_rows}
        second_traces = {row["traceId"] for row in second_rows}
        self.assertTrue(all(first_sessions), first_rows)
        self.assertTrue(all(second_sessions), second_rows)
        self.assertTrue(all(first_traces), first_rows)
        self.assertTrue(all(second_traces), second_rows)
        self.assertFalse(first_sessions & second_sessions)
        self.assertFalse(first_traces & second_traces)

    def test_show_reopens_native_report_details_without_aws_or_rerunning(self):
        experiment, clients, aws = self.run_experiment(candidate="repaired")
        before_requests = sum(len(client.requests) for client in clients)
        before_judge_calls = copy.deepcopy(aws.evaluate.calls)
        self.assertEqual(len(before_judge_calls), 2)
        module = self.product()
        with patch.object(boto3, "Session", side_effect=AssertionError("show must not open AWS")):
            code, shown = self.invoke(module, "show", "--experiment", experiment)
        self.assertEqual(code, 0, shown)
        self.assertEqual(sum(len(client.requests) for client in clients), before_requests)
        self.assertEqual(aws.evaluate.calls, before_judge_calls, "show must not rescore a saved experiment")
        self.assertEqual(shown.get("experimentId"), self._read_record(experiment).get("experimentId"))
        cases = shown["cases"]
        self.assertIsInstance(cases, list, shown)
        self.assertEqual(len(cases), 2)
        self.assertTrue(any("details" in json.dumps(row) or "report" in json.dumps(row) for row in cases))

    def test_source_run_selects_authenticated_saved_runtime_snapshot_without_fallback(self):
        source_run = self._source_run("repaired")
        prompt = self.source_workspaces["repaired"] / "prompt.py"
        prompt.write_text(prompt.read_text(encoding="utf-8") + "\nPHASE18_LATE_WORKSPACE_EDIT\n", encoding="utf-8")
        experiment, clients, _aws = self.run_experiment(candidate="faulty", selected=["phase18.synthetic-denial"], source_run=source_run)
        record = self._read_record(experiment)
        rendered = json.dumps(record)
        self.assertIn(source_run.name, rendered)
        self.assertIn("PHASE18_REPAIRED_SOURCE_MARKER", json.dumps(clients[0].requests))
        self.assertNotIn("PHASE18_LATE_WORKSPACE_EDIT", json.dumps(clients[0].requests))
        self.assertNotIn("fallback", rendered.lower())

    def test_source_run_tamper_or_unavailability_is_rejected_before_candidate_inference(self):
        source_run = self._source_run()
        execution_path = source_run / "execution.json"
        original = execution_path.read_bytes()
        try:
            execution = json.loads(original)
            execution["identity"]["sourceSha256"] = "0" * 64
            execution_path.write_text(json.dumps(execution), encoding="utf-8")
            module = self.product()
            model_session, clients = self._clients("repaired")
            with self.assertRaises((ValueError, FileNotFoundError, SystemExit)) as tamper_error:
                module.run_experiment(self.suite, self.runs, candidate_id="repaired", evaluator_path=self.evaluator, wait_seconds=0, source_run=source_run, model_session=model_session)
            self.assertRegex(str(tamper_error.exception).lower(), r"source|digest|identity|tamper|auth")
            self.assertEqual(model_session.index, 0)
            self.assertEqual(sum(len(client.requests) for client in clients), 0)
        finally:
            execution_path.write_bytes(original)

        model_session, clients = self._clients("repaired")
        with self.assertRaises((ValueError, FileNotFoundError, SystemExit)) as missing_error:
            module.run_experiment(self.suite, self.runs, candidate_id="repaired", evaluator_path=self.evaluator, wait_seconds=0, source_run=self.root / "no-source-run", model_session=model_session)
        self.assertRegex(str(missing_error.exception).lower(), r"source|missing|unavailable|not found")
        self.assertEqual(model_session.index, 0)
        self.assertEqual(sum(len(client.requests) for client in clients), 0)

    def test_source_run_accepts_active_authenticated_p17_snapshot_and_uses_its_prompt(self):
        module = self.product()
        context = multiprocessing.get_context("fork")
        entered = context.Event()
        release = context.Event()
        source_root = self.root / "active-source-runs"
        source_root.mkdir()
        process = context.Process(
            target=_child_active_source_process,
            args=(
                str(self.case_paths["denial"]),
                str(self.bundle),
                str(source_root),
                str(self.source_workspaces["repaired"]),
                self._case("denial")["task"],
                entered,
                release,
            ),
        )
        process.start()
        active_run = None
        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                for path in source_root.rglob("execution.json"):
                    try:
                        value = json.loads(path.read_bytes())
                    except (OSError, ValueError):
                        continue
                    if value.get("status") == "running":
                        active_run = path.parent
                        break
                if active_run is not None and entered.wait(0.05):
                    break
                time.sleep(0.01)
            self.assertIsNotNone(active_run, "active P17 source run was not created")
            self.assertTrue(entered.is_set())
            experiment, clients, _aws = self.run_experiment(candidate="faulty", selected=["phase18.synthetic-denial"], source_run=active_run)
            self.assertTrue(experiment.is_dir())
            self.assertIn("PHASE18_REPAIRED_SOURCE_MARKER", json.dumps(clients[0].requests))
        finally:
            release.set()
            if process.is_alive():
                process.terminate()
            process.join(10)
        self.assertFalse(process.is_alive())

    def test_authenticated_source_with_incompatible_locked_python_requirement_is_rejected_before_inference(self):
        import captured_execution

        source_run = self._source_run("repaired")
        execution_path = source_run / "execution.json"
        native_path = source_run / "strands.native-spans.json"
        record = json.loads(execution_path.read_bytes())
        manifest = record["manifest"]
        dependency_files = {}
        for name in ("agent/pyproject.toml", "agent/uv.lock"):
            path = source_run / "source" / name
            raw = path.read_bytes()
            if name.endswith("pyproject.toml"):
                raw = raw.replace(b'requires-python = ">=3.13,<3.14"', b'requires-python = ">=3.12,<3.13"')
            else:
                raw += b"\n# PHASE18_INCOMPATIBLE_LOCK\n"
            path.write_bytes(raw)
            dependency_files[name] = raw
        dep_digest = captured_execution._named_digest(dependency_files)
        manifest["dependencyFiles"] = {name: hashlib.sha256(raw).hexdigest() for name, raw in sorted(dependency_files.items())}
        manifest["dependencySha256"] = dep_digest
        record["manifest"] = manifest
        record["identity"]["dependencySha256"] = dep_digest
        native = json.loads(native_path.read_bytes())
        for span in native["spans"]:
            attrs = span.get("attributes", {})
            attrs = attrs.get("attributes", attrs) if isinstance(attrs, dict) else {}
            if isinstance(attrs, dict):
                attrs["incident.dependency_sha256"] = dep_digest
        native_path.write_text(json.dumps(native), encoding="utf-8")
        record["nativeSpansSha256"] = hashlib.sha256(
            json.dumps(native, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        execution_path.write_text(json.dumps(record), encoding="utf-8")

        module = self.product()
        model_session, clients = self._clients("faulty")
        with self.assertRaises((ValueError, SystemExit)) as incompatible_error:
            module.run_experiment(
                self.suite,
                self.runs,
                candidate_id="faulty",
                evaluator_path=self.evaluator,
                wait_seconds=0,
                source_run=source_run,
                model_session=model_session,
            )
        self.assertRegex(str(incompatible_error.exception).lower(), r"incompat|python|requirement|lock|runtime|version")
        self.assertEqual(model_session.index, 0)
        self.assertEqual(sum(len(client.requests) for client in clients), 0)

    def test_cli_forwards_source_run_and_required_exit_policy(self):
        module = self.product()
        source_run = self._source_run()
        existing_experiment, _clients, _aws = self.run_experiment(candidate="repaired", selected=["phase18.synthetic-denial"])
        captured = {}

        def fake_run_experiment(**kwargs):
            captured.update(kwargs)
            return existing_experiment

        with patch.object(module, "run_experiment", side_effect=fake_run_experiment):
            code, _result = self.invoke(
                module,
                "run",
                "--suite", self.suite,
                "--candidate", "repaired",
                "--evaluator", self.evaluator,
                "--output-root", self.runs,
                "--source-run", source_run,
                "--case", "phase18.synthetic-denial",
                "--wait-seconds", "0",
            )
        self.assertEqual(code, 0)
        self.assertEqual(Path(captured["source_run"]), source_run)
        self.assertEqual(captured["selected_cases"], ["phase18.synthetic-denial"])
        self.assertEqual(captured["wait_seconds"], 0)

    def test_cli_returns_one_for_known_deterministic_failure_and_zero_for_review_required_pass(self):
        faulty, _clients, _aws = self.run_experiment(candidate="faulty", selected=["phase18.synthetic-denial"])
        repaired, _clients, _aws = self.run_experiment(candidate="repaired", selected=["phase18.synthetic-denial"])
        module = self.product()

        with patch.object(module, "run_experiment", return_value=faulty):
            code, result = self.invoke(module, "run", "--suite", self.suite, "--candidate", "faulty", "--evaluator", self.evaluator, "--output-root", self.runs, "--case", "phase18.synthetic-denial", "--wait-seconds", "0")
        self.assertEqual(code, 1, result)
        self.assertRegex(json.dumps(result).lower(), r"reject|failure|action")

        with patch.object(module, "run_experiment", return_value=repaired):
            code, result = self.invoke(module, "run", "--suite", self.suite, "--candidate", "repaired", "--evaluator", self.evaluator, "--output-root", self.runs, "--case", "phase18.synthetic-denial", "--wait-seconds", "0")
        self.assertEqual(code, 0, result)
        self.assertIn("review", json.dumps(result).lower())

    def test_public_cli_dispatches_real_native_experiment_runner_and_scorer(self):
        import captured_execution

        module = self.product()
        model_session, clients = self._clients("faulty")
        aws = FakeAWS(self.runs, label="pass")
        original_run = module.run_experiment
        _Case, Experiment, _Evaluator, EvaluationReport = self.native_types()
        original_dispatch = Experiment.run_evaluations
        dispatch = {}
        returned = []

        def delegated_run(*args, **kwargs):
            kwargs["model_session"] = model_session
            with patch.object(captured_execution, "AGENT_DIRECTORY", self.source_workspaces["faulty"]):
                with patch.object(boto3, "Session", side_effect=aws.session_factory):
                    result = original_run(*args, **kwargs)
            returned.append(Path(result))
            return result

        def real_dispatch(experiment, *args, **kwargs):
            dispatch["cases"] = list(experiment.cases)
            dispatch["evaluators"] = list(experiment.evaluators)
            return original_dispatch(experiment, *args, **kwargs)

        with patch.object(Experiment, "run_evaluations", new=real_dispatch):
            with patch.object(module, "run_experiment", side_effect=delegated_run):
                code, result = self.invoke(
                    module,
                    "run",
                    "--suite", self.suite,
                    "--candidate", "faulty",
                    "--evaluator", self.evaluator,
                    "--output-root", self.runs,
                    "--wait-seconds", "0",
                )
        self.assertEqual(code, 1, result)
        self.assertEqual(len(returned), 1)
        self.assertEqual(len(dispatch["cases"]), 2)
        self.assertEqual(len(dispatch["evaluators"]), 2)
        self.assertTrue(all(isinstance(case, _Case) for case in dispatch["cases"]))
        self.assertTrue(all(isinstance(evaluator, _Evaluator) for evaluator in dispatch["evaluators"]))
        self.assertTrue(all(client.requests for client in clients))
        self.assertEqual(len(aws.evaluate.calls), 2)
        experiment = returned[0]
        self.assertEqual({row["caseId"] for row in self._read_record(experiment)["cases"]}, {"phase18.synthetic-denial", "phase18.synthetic-capacity"})
        report = EvaluationReport.from_file(str(self._native_report_path(experiment)))
        self.assertIsInstance(report, EvaluationReport)
        self.assertIn("phase18.synthetic-denial", json.dumps(self._read_record(experiment)))
        self.assertNotIn("admissibleRecommendations", json.dumps([request for client in clients for request in client.requests]))

    def test_cli_returns_two_for_incomplete_or_error_without_a_known_deterministic_failure(self):
        experiment, _clients, _aws = self.run_experiment(
            candidate="repaired",
            selected=["phase18.synthetic-denial"],
            evaluate_error="ThrottlingException",
        )
        record = self._read_record(experiment)
        self.assertEqual(record["decision"]["verdict"], "incomplete")
        module = self.product()
        with patch.object(module, "run_experiment", return_value=experiment):
            code, result = self.invoke(module, "run", "--suite", self.suite, "--candidate", "repaired", "--evaluator", self.evaluator, "--output-root", self.runs, "--case", "phase18.synthetic-denial", "--wait-seconds", "0")
        self.assertEqual(code, 2, result)
        self.assertEqual(result["experimentId"], record["experimentId"])
        self.assertEqual(result["decision"]["verdict"], record["decision"]["verdict"])

    def test_faulty_deterministic_failure_rejects_even_with_complete_advisory_score(self):
        experiment, _clients, aws = self.run_experiment(candidate="faulty", label="pass", explanation="Semantic advisory pass.")
        self.assertEqual(len(aws.evaluate.calls), 2)
        record = self._read_record(experiment)
        decision = record.get("decision") or record.get("policy") or {}
        self.assertIn(str(decision.get("verdict", decision.get("status", ""))).lower(), {"reject", "rejected"})
        rows = self._rows(record)
        self.assertTrue(rows)
        for row in rows:
            rendered = json.dumps(row)
            self.assertIn("Increase memory", rendered)
            self.assertRegex(rendered.lower(), r"action.{0,120}(fail|reject)")
            self.assertRegex(rendered.lower(), r"semantic.{0,240}(pass|complete|advisory)")
            self.assertIn("numericPlaceholder", rendered)

    def test_evaluator_transport_error_is_typed_incomplete_and_never_an_extra_candidate_run(self):
        experiment, clients, aws = self.run_experiment(candidate="repaired", selected=["phase18.synthetic-denial"], evaluate_error="ThrottlingException")
        self.assertEqual(len(clients), 2)
        self.assertEqual(len(clients[0].requests) > 0, True)
        self.assertEqual(len(clients[1].requests), 0)
        self.assertEqual(len(aws.evaluate.calls), 1)
        record = self._read_record(experiment)
        rendered = json.dumps(record).lower()
        self.assertRegex(rendered, r"throttl|error|incomplete")
        self.assertNotRegex(rendered, r'"verdict"\s*:\s*"fail"')
        self.assertEqual(record["decision"]["verdict"], "incomplete")
        rows = self._rows(record)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["scoringAttemptId"], rows[0]["score"]["scoringAttemptId"])
        EvaluationReport = self.native_types()[3]
        native_report = EvaluationReport.from_file(str(self._native_report_path(experiment)))
        advisory = [output for outputs in native_report.detailed_results for output in outputs
                    if output.metadata["role"] == "advisory"]
        self.assertEqual(len(advisory), 1)
        self.assertEqual(advisory[0].metadata["status"], rows[0]["score"]["status"])
        self.assertNotEqual(advisory[0].metadata["status"], "complete")
        self.assertIsNone(advisory[0].label)
        self.assertTrue(advisory[0].metadata["numericPlaceholder"])

    def test_evaluator_configuration_failure_before_score_receipt_remains_visible_offline(self):
        """A pre-GetEvaluator control-plane error stays typed in the report and show."""

        experiment, clients, aws = self.run_experiment(
            candidate="repaired",
            control_error="AccessDeniedException",
        )
        self.assertEqual(len(clients), 2)
        self.assertTrue(all(client.requests for client in clients))
        self.assertEqual(len(aws.control.calls), 2)
        self.assertEqual(aws.evaluate.calls, [])
        record = self._read_record(experiment)
        self.assertEqual(record["decision"]["verdict"], "incomplete")
        rows = self._rows(record)
        self.assertEqual(len(rows), 2)
        for row in rows:
            self.assertIsInstance(row.get("scoringAttemptId"), str)
            self.assertTrue(row["scoringAttemptId"])
            self.assertEqual(row["score"]["status"], "error")
            self.assertRegex(json.dumps(row).lower(), r"accessdenied|configuration|semantic scoring failed")
            receipt = experiment / "executions" / row["executionId"] / "scores" / row["scoringAttemptId"] / "result.json"
            self.assertTrue(receipt.is_file(), receipt)
            saved_score = json.loads(receipt.read_bytes())
            self.assertEqual(saved_score["status"], "error")
            self.assertEqual(saved_score["scoringAttemptId"], row["scoringAttemptId"])
            self.assertRegex(json.dumps(saved_score).lower(), r"accessdenied|configuration|semantic scoring failed")

        EvaluationReport = self.native_types()[3]
        native_report = EvaluationReport.from_file(str(self._native_report_path(experiment)))
        advisory = [
            output
            for outputs in native_report.detailed_results
            for output in outputs
            if output.metadata["role"] == "advisory"
        ]
        self.assertEqual(len(advisory), 2)
        for output in advisory:
            self.assertEqual(output.metadata["status"], "error")
            self.assertIsNone(output.label)
            self.assertRegex(output.reason.lower(), r"accessdenied|configuration|semantic scoring failed")

        module = self.product()
        with patch.object(boto3, "Session", side_effect=AssertionError("show must be offline")):
            code, shown = self.invoke(module, "show", "--experiment", experiment)
        self.assertEqual(code, 0, shown)
        self.assertEqual(shown["decision"]["verdict"], "incomplete")
        shown_rows = self._rows(shown)
        self.assertEqual(len(shown_rows), 2)
        for shown_row in shown_rows:
            self.assertIsInstance(shown_row.get("score"), dict)
            self.assertEqual(shown_row["score"].get("status"), "error")
            self.assertRegex(json.dumps(shown_row).lower(), r"accessdenied|configuration|semantic scoring failed")

    def test_usage_is_recorded_from_actual_model_metadata_without_zeroing_unknowns(self):
        experiment, clients, _aws = self.run_experiment(candidate="faulty", selected=["phase18.synthetic-denial"])
        record = self._read_record(experiment)
        # ScriptedBedrock returns 3 input and 2 output tokens per physical
        # response. Counting both aggregate and model spans would double them.
        actual_requests = sum(len(client.requests) for client in clients)
        actual_input = actual_requests * 3
        actual_output = actual_requests * 2
        agent_usage = record["usage"]["agent"]
        self.assertEqual(agent_usage["inputTokens"], actual_input)
        self.assertEqual(agent_usage["outputTokens"], actual_output)
        self.assertEqual(agent_usage["totalTokens"], actual_input + actual_output)
        semantic_usage = record["usage"]["semantic"]
        self.assertIsNone(semantic_usage["inputTokens"])
        self.assertIsNone(semantic_usage["outputTokens"])
        self.assertIsNone(semantic_usage["totalTokens"])
        self.assertNotEqual(agent_usage["totalTokens"], 0)
        self.assertEqual(len(clients[0].requests) >= 1, True)

    def test_known_semantic_usage_is_preserved_once_and_missing_usage_stays_unknown(self):
        experiment, _clients, _aws = self.run_experiment(
            candidate="repaired",
            selected=["phase18.synthetic-denial"],
            token_usage={"inputTokens": 11, "outputTokens": 7, "totalTokens": 18},
        )
        record = self._read_record(experiment)
        self.assertEqual(record["usage"]["semantic"], {"inputTokens": 11, "outputTokens": 7, "totalTokens": 18})

        missing, _clients, _aws = self.run_experiment(candidate="repaired", selected=["phase18.synthetic-denial"])
        missing_record = self._read_record(missing)
        self.assertEqual(missing_record["usage"]["semantic"], {"inputTokens": None, "outputTokens": None, "totalTokens": None})

    def test_all_deterministic_pass_with_complete_advisory_is_review_required_not_release_pass(self):
        repaired = {label: recommendation("Restore inventory access", "inventory", "75", "version") for label in ("denial", "capacity")}
        for label in ("pass", "fail"):
            with self.subTest(label=label):
                experiment, _clients, _aws = self.run_experiment(candidate="repaired", reports=repaired, label=label)
                record = self._read_record(experiment)
                decision = record["decision"]
                self.assertEqual(decision["verdict"], "review_required")
                self.assertNotIn("release", decision["verdict"].lower())

    def test_native_report_round_trip_uses_sdk_to_file_and_from_file(self):
        _Case, _Experiment, _Evaluator, EvaluationReport = self.native_types()
        experiment, _clients, _aws = self.run_experiment(candidate="faulty")
        report_candidates = list(experiment.rglob("*.json"))
        self.assertTrue(report_candidates, f"no native report file under {experiment}")
        loaded = []
        for path in report_candidates:
            try:
                report = EvaluationReport.from_file(str(path))
            except Exception:
                continue
            if isinstance(report, EvaluationReport):
                loaded.append(report)
        self.assertEqual(len(loaded), 1, report_candidates)
        report = loaded[0]
        detailed_results = report.detailed_results
        native_cases = report.cases
        record = self._read_record(experiment)
        self.assertEqual(len(native_cases), len(self._rows(record)) * 2)
        self.assertEqual(len(detailed_results), len(native_cases))
        grouped = {}
        for native_case, outputs in zip(native_cases, detailed_results):
            metadata = native_case["metadata"]
            self.assertTrue(native_case["evaluator"])
            self.assertTrue(native_case["evaluator_type"])
            roles = {output.metadata["role"] for output in outputs}
            self.assertEqual(len(roles), 1)
            key = (metadata["caseId"], roles.pop())
            self.assertNotIn(key, grouped)
            grouped[key] = outputs
        self.assertEqual(
            {case_id for case_id, _evaluator_type in grouped},
            {row["caseId"] for row in self._rows(record)},
        )
        self.assertEqual(
            {evaluator_type for _case_id, evaluator_type in grouped},
            {"deterministic", "advisory"},
        )
        for row in self._rows(record):
            case_id = row["caseId"]
            deterministic_outputs = grouped[(case_id, "deterministic")]
            advisory_outputs = grouped[(case_id, "advisory")]
            self.assertEqual(len(deterministic_outputs), 8)
            self.assertEqual(len(advisory_outputs), 1)
            execution_path = next(
                path for path in experiment.rglob("execution.json")
                if json.loads(path.read_bytes())["identity"]["executionId"] == row["executionId"]
            )
            execution_record, _loaded_case, _spans = __import__("captured_execution").load_execution(execution_path.parent)
            identity = execution_record["identity"]
            findings = execution_record["deterministic"]["findings"]
            deterministic_names = set(findings)
            self.assertEqual(
                {output.metadata["checkName"] for output in deterministic_outputs},
                deterministic_names,
            )
            for output in deterministic_outputs:
                metadata = output.metadata
                check_name = metadata["checkName"]
                self.assertEqual(metadata["role"], "deterministic")
                self.assertEqual(metadata["caseId"], row["caseId"])
                self.assertEqual(metadata["executionId"], identity["executionId"])
                self.assertEqual(metadata["sessionId"], identity["sessionId"])
                self.assertEqual(metadata["traceId"], identity["traceId"])
                self.assertEqual(metadata["status"], findings[check_name]["status"])
                self.assertEqual(metadata["verdict"], findings[check_name]["verdict"])
            semantic = advisory_outputs[0]
            semantic_metadata = semantic.metadata
            semantic_finding = row["score"]["semantic"]["findings"]["semantic_quality"]
            self.assertEqual(semantic.score, 0.0)
            self.assertTrue(semantic_metadata["numericPlaceholder"])
            self.assertEqual(semantic_metadata["role"], "advisory")
            self.assertEqual(semantic_metadata["status"], row["score"]["status"])
            self.assertEqual(semantic.label, semantic_finding["verdict"])
            self.assertEqual(semantic.reason, semantic_finding["explanation"])
            self.assertEqual(semantic_metadata["caseId"], row["caseId"])
            self.assertEqual(semantic_metadata["executionId"], identity["executionId"])
            self.assertEqual(semantic_metadata["sessionId"], identity["sessionId"])
            self.assertEqual(semantic_metadata["traceId"], identity["traceId"])
            self.assertEqual(semantic_metadata["scoringAttemptId"], row["scoringAttemptId"])

    def test_missing_foreign_or_tampered_native_report_roster_is_incomplete_with_rows_preserved(self):
        baseline, _clients, _aws = self.run_experiment(candidate="faulty")
        candidate, _clients, _aws = self.run_experiment(candidate="repaired")
        report_path = self._native_report_path(candidate)
        original = report_path.read_bytes()
        module = self.product()

        def mutate(value, kind):
            if isinstance(value, dict):
                if kind == "foreign" and ("score" in value or "label" in value):
                    value["metadata"] = {**(value.get("metadata") or {}), "experimentId": "foreign-experiment"}
                    return True
                if kind == "tampered" and isinstance(value.get("score"), (int, float)):
                    value["score"] = 999
                    return True
                for key in ("results", "detailed_results", "detailedResults"):
                    rows = value.get(key)
                    if isinstance(rows, list) and rows:
                        if kind == "missing":
                            rows.pop()
                            return True
                        return mutate(rows[0], kind)
                return any(mutate(item, kind) for item in value.values())
            if isinstance(value, list):
                return any(mutate(item, kind) for item in value)
            return False

        try:
            for kind in ("missing", "foreign", "tampered"):
                with self.subTest(kind=kind):
                    document = json.loads(original)
                    self.assertTrue(mutate(document, kind), f"native report has no result roster for {kind}")
                    report_path.write_text(json.dumps(document), encoding="utf-8")
                    self.assertNotEqual(report_path.read_bytes(), original)
                    with patch.object(boto3, "Session", side_effect=AssertionError("compare must not open AWS")):
                        code, result = self.invoke(module, "compare", "--baseline", baseline, "--candidate", candidate)
                    self.assertEqual(code, 2, result)
                    self.assertRegex(json.dumps(result).lower(), r"incomplete|report|roster|identity|digest")
                    self.assertTrue(result.get("baseline") or result.get("available"), result)
                    self.assertTrue(result.get("candidate") or result.get("available"), result)
                    report_path.write_bytes(original)
        finally:
            report_path.write_bytes(original)

    def test_compare_accepts_same_case_set_with_different_valid_tool_queries_and_is_read_only(self):
        baseline, baseline_clients, baseline_aws = self.run_experiment(
            candidate="faulty",
            reads_by_label={"denial": ({"resource": "inventory", "service": "gateway"}, {"resource": "inventory"})},
        )
        candidate, candidate_clients, candidate_aws = self.run_experiment(
            candidate="repaired",
            reads_by_label={"denial": ({"resource": "inventory"},)},
        )
        module = self.product()
        before = (sum(len(client.requests) for client in baseline_clients), sum(len(client.requests) for client in candidate_clients))
        with patch.object(boto3, "Session", side_effect=AssertionError("compare must not open AWS")):
            code, result = self.invoke(module, "compare", "--baseline", baseline, "--candidate", candidate)
        self.assertEqual(code, 0, result)
        self.assertIn(str(result.get("status", "")).lower(), {"complete", "review_required", "rejected"})
        self.assertEqual(len(baseline_aws.evaluate.calls), 2)
        self.assertEqual(len(candidate_aws.evaluate.calls), 2)
        self.assertEqual(before, (sum(len(client.requests) for client in baseline_clients), sum(len(client.requests) for client in candidate_clients)))
        self.assertTrue(result.get("baseline"))
        self.assertTrue(result.get("candidate"))

    def test_compare_rejects_mismatched_selected_case_set_but_preserves_available_rows(self):
        baseline, _clients, _aws = self.run_experiment(candidate="faulty", selected=["phase18.synthetic-denial"])
        candidate, _clients, _aws = self.run_experiment(candidate="repaired")
        module = self.product()
        with patch.object(boto3, "Session", side_effect=AssertionError("compare must not open AWS")):
            code, result = self.invoke(module, "compare", "--baseline", baseline, "--candidate", candidate)
        self.assertEqual(code, 2, result)
        self.assertRegex(json.dumps(result).lower(), r"case|selected|digest|mismatch")
        self.assertTrue(result.get("baseline") or result.get("available"), result)
        self.assertTrue(result.get("candidate") or result.get("available"), result)

    def test_compare_keeps_manifest_selected_attempt_after_an_explicit_phase17_rejudge(self):
        baseline, _clients, _aws = self.run_experiment(candidate="faulty")
        candidate, _clients, _aws = self.run_experiment(candidate="repaired")
        baseline_record = self._read_record(baseline)
        candidate_record = self._read_record(candidate)
        baseline_rows = self._rows(baseline_record)
        candidate_rows = self._rows(candidate_record)
        baseline_map = {row["caseId"]: row["scoringAttemptId"] for row in baseline_rows}
        candidate_map = {row["caseId"]: row["scoringAttemptId"] for row in candidate_rows}
        self.assertEqual(set(baseline_map), {"phase18.synthetic-denial", "phase18.synthetic-capacity"})
        self.assertEqual(set(candidate_map), set(baseline_map))
        self.assertTrue(all(isinstance(value, str) and value for value in baseline_map.values()))
        self.assertTrue(all(isinstance(value, str) and value for value in candidate_map.values()))
        execution_dirs = sorted(path.parent for path in baseline.rglob("execution.json"))
        self.assertTrue(execution_dirs, f"experiment did not retain Phase 17 execution records under {baseline}")
        score_code, _score_result, _score_aws = self.rescore_saved_execution(execution_dirs[0], baseline)
        self.assertEqual(score_code, 0)
        module = self.product()
        with patch.object(boto3, "Session", side_effect=AssertionError("compare must not rescore")):
            code, result = self.invoke(module, "compare", "--baseline", baseline, "--candidate", candidate)
        self.assertEqual(code, 0, result)
        comparison_rows = result["cases"]
        self.assertEqual({row["caseId"] for row in comparison_rows}, set(baseline_map))
        for row in comparison_rows:
            case_id = row["caseId"]
            self.assertEqual(row["baseline"]["scoringAttemptId"], baseline_map[case_id])
            self.assertEqual(row["candidate"]["scoringAttemptId"], candidate_map[case_id])

    def test_compare_rejects_tampered_tooling_lock_or_foreign_report_identity(self):
        baseline, _clients, _aws = self.run_experiment(candidate="faulty")
        candidate, _clients, _aws = self.run_experiment(candidate="repaired")
        record_path = self._record_path(candidate)
        original = record_path.read_bytes()
        try:
            record = json.loads(original)
            changed = False
            def tamper_existing(value):
                nonlocal changed
                if isinstance(value, dict):
                    for key in ("toolingSha256", "lockSha256", "dependencySha256", "sourceSha256", "scoringSourceSha256"):
                        if isinstance(value.get(key), str) and re.fullmatch(r"[0-9a-f]{64}", value[key]):
                            value[key] = "0" * 64
                            changed = True
                            return
                    for item in value.values():
                        tamper_existing(item)
                        if changed:
                            return
                elif isinstance(value, list):
                    for item in value:
                        tamper_existing(item)
                        if changed:
                            return
            for section in ("tooling", "runtime", "snapshot", "dependencies", "locks"):
                if isinstance(record.get(section), (dict, list)):
                    tamper_existing(record[section])
                    if changed:
                        break
            if not changed:
                tamper_existing(record)
            self.assertTrue(changed, "canonical record had no authenticated tooling/lock digest to tamper")
            record_path.write_text(json.dumps(record), encoding="utf-8")
            module = self.product()
            with patch.object(boto3, "Session", side_effect=AssertionError("compare must not open AWS")):
                code, result = self.invoke(module, "compare", "--baseline", baseline, "--candidate", candidate)
            self.assertNotEqual(code, 0, result)
            self.assertRegex(json.dumps(result).lower(), r"tool|lock|source|identity")
        finally:
            record_path.write_bytes(original)

        # A foreign native report/result identity must not be accepted merely
        # because the surrounding experiment record still has the right case set.
        EvaluationReport = self.native_types()[3]
        report_files = []
        for path in candidate.rglob("*.json"):
            if path == record_path:
                continue
            try:
                if isinstance(EvaluationReport.from_file(str(path)), EvaluationReport):
                    report_files.append(path)
            except Exception:
                continue
        self.assertTrue(report_files, f"native evaluation report missing under {candidate}")
        report_path = report_files[0]
        report_original = report_path.read_bytes()
        try:
            tampered = json.loads(report_original)
            if isinstance(tampered, dict):
                tampered["metadata"] = {**(tampered.get("metadata") or {}), "experimentId": "foreign-experiment"}
                report_path.write_text(json.dumps(tampered), encoding="utf-8")
            with patch.object(boto3, "Session", side_effect=AssertionError("compare must not open AWS")):
                code, result = self.invoke(module, "compare", "--baseline", baseline, "--candidate", candidate)
            self.assertNotEqual(code, 0, result)
            self.assertRegex(json.dumps(result).lower(), r"report|identity|foreign|digest")
        finally:
            report_path.write_bytes(report_original)

    def test_controlled_compare_requires_distinct_saved_prompt_workspaces(self):
        """Candidate labels cannot manufacture a faulty/repaired comparison."""

        faulty, _faulty_clients, _faulty_aws = self.run_experiment(
            candidate="faulty", selected=["phase18.synthetic-denial"]
        )
        repaired, _repaired_clients, _repaired_aws = self.run_experiment(
            candidate="repaired", selected=["phase18.synthetic-denial"]
        )
        faulty_record = self._read_record(faulty)
        repaired_record = self._read_record(repaired)
        faulty_snapshot = faulty_record["snapshot"]
        repaired_snapshot = repaired_record["snapshot"]

        # The comparison is controlled by the saved prompt bytes, not only by
        # the candidate labels in the two experiment records.  Runtime/tooling
        # and lock identities must still be common.
        self.assertEqual(faulty_record["candidateId"], "faulty")
        self.assertEqual(repaired_record["candidateId"], "repaired")
        self.assertNotEqual(faulty_snapshot["sourceSha256"], repaired_snapshot["sourceSha256"])
        self.assertNotEqual(faulty_snapshot["sourceFiles"]["agent/prompt.py"], repaired_snapshot["sourceFiles"]["agent/prompt.py"])
        self.assertEqual(faulty_snapshot["toolingSha256"], repaired_snapshot["toolingSha256"])
        self.assertEqual(faulty_snapshot["toolingDependencySha256"], repaired_snapshot["toolingDependencySha256"])
        self.assertEqual(faulty_snapshot["dependencySha256"], repaired_snapshot["dependencySha256"])

        module = self.product()
        with patch.object(boto3, "Session", side_effect=AssertionError("compare must be offline")):
            code, result = self.invoke(module, "compare", "--baseline", faulty, "--candidate", repaired)
        self.assertEqual(code, 0, result)
        self.assertEqual(result.get("status"), "complete")

    def test_imported_launcher_uses_prelaunch_saved_tooling_after_late_workspace_edit(self):
        """A frozen driver must use accepted adapter bytes, not cached/later files."""

        # Import the launcher before changing the accepted tooling copy.  The
        # launch must still snapshot the accepted copy and reconstruct it in a
        # fresh frozen-tooling scope.
        module = self.product()
        accepted = self.root / "accepted-tooling"
        shutil.copytree(AGENT, accepted, ignore=shutil.ignore_patterns("__pycache__"))
        adapter = accepted / "strands_evaluators.py"
        adapter_text = adapter.read_text(encoding="utf-8")
        marker = "PHASE18_PRELAUNCH_ACCEPTED_ADAPTER"
        late_marker = "PHASE18_POSTSTART_LATE_ADAPTER"
        needle = '        "traceId": identity.get("traceId"),\n'
        self.assertIn(needle, adapter_text)
        adapter.write_text(
            adapter_text.replace(needle, needle + f'        "acceptedAdapterMarker": "{marker}",\n'),
            encoding="utf-8",
        )

        def edit_after_first_model_call():
            current = adapter.read_text(encoding="utf-8")
            self.assertIn(marker, current)
            adapter.write_text(current.replace(marker, late_marker), encoding="utf-8")

        model_session, clients = self._clients("repaired", after_first=edit_after_first_model_call)
        aws = FakeAWS(self.runs)
        with patch.object(module, "AGENT_DIRECTORY", accepted):
            with patch.object(boto3, "Session", side_effect=aws.session_factory):
                experiment = Path(module.run_experiment(
                    self.suite,
                    self.runs,
                    candidate_id="repaired",
                    evaluator_path=self.evaluator,
                    wait_seconds=0,
                    selected_cases=["phase18.synthetic-denial"],
                    model_session=model_session,
                    source_directory=self.source_workspaces["repaired"],
                ))
        self.assertTrue(clients[0].requests)
        rendered = json.dumps(self._read_record(experiment))
        self.assertNotIn(marker, rendered)
        self.assertNotIn(late_marker, rendered)
        EvaluationReport = self.native_types()[3]
        native_report = EvaluationReport.from_file(str(experiment / "native-report.json"))
        native_metadata = json.dumps([
            output.metadata
            for outputs in native_report.detailed_results
            for output in outputs
        ])
        self.assertIn(marker, native_metadata)
        self.assertNotIn(late_marker, native_metadata)
        snapshot = self._read_record(experiment)["snapshot"]
        self.assertEqual(snapshot["toolingFiles"]["agent/strands_evaluators.py"], hashlib.sha256(
            (accepted / "strands_evaluators.py").read_bytes().replace(late_marker.encode(), marker.encode())
        ).hexdigest())

    def test_source_run_rejects_installed_runtime_package_mismatch_from_locked_export(self):
        """A valid Python range is not enough when a locked runtime package differs."""

        import captured_execution

        source_run = self._source_run("repaired")
        execution_path = source_run / "execution.json"
        native_path = source_run / "strands.native-spans.json"
        record = json.loads(execution_path.read_bytes())
        manifest = record["manifest"]
        lock_path = source_run / "source" / "agent/uv.lock"
        lock_raw = lock_path.read_bytes()
        self.assertIn(b'name = "attrs"\nversion = "26.1.0"', lock_raw)
        self.assertIn(b"attrs-26.1.0", lock_raw)
        lock_path.write_bytes(
            lock_raw
            .replace(b'name = "attrs"\nversion = "26.1.0"', b'name = "attrs"\nversion = "26.0.0"')
            .replace(b"attrs-26.1.0", b"attrs-26.0.0")
        )
        dependency_files = {
            name: (source_run / "source" / name).read_bytes()
            for name in ("agent/pyproject.toml", "agent/uv.lock")
        }
        dependency_digest = captured_execution._named_digest(dependency_files)
        manifest["dependencyFiles"] = {
            name: hashlib.sha256(raw).hexdigest()
            for name, raw in sorted(dependency_files.items())
        }
        manifest["dependencySha256"] = dependency_digest
        record["identity"]["dependencySha256"] = dependency_digest
        native = json.loads(native_path.read_bytes())
        for span in native["spans"]:
            attrs = span.get("attributes", {})
            attrs = attrs.get("attributes", attrs) if isinstance(attrs, dict) else {}
            if isinstance(attrs, dict):
                attrs["incident.dependency_sha256"] = dependency_digest
        native_path.write_text(json.dumps(native), encoding="utf-8")
        record["nativeSpansSha256"] = hashlib.sha256(
            json.dumps(native, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        execution_path.write_text(json.dumps(record), encoding="utf-8")

        module = self.product()
        model_session, clients = self._clients("faulty")
        with self.assertRaises((ValueError, SystemExit)) as mismatch:
            module.run_experiment(
                self.suite,
                self.runs,
                candidate_id="faulty",
                evaluator_path=self.evaluator,
                wait_seconds=0,
                source_run=source_run,
                model_session=model_session,
            )
        self.assertRegex(str(mismatch.exception).lower(), r"attrs|package|installed|incompat|runtime|requirement")
        self.assertEqual(model_session.index, 0)
        self.assertEqual(sum(len(client.requests) for client in clients), 0)

    def test_offline_policy_needs_native_report_and_selected_score_receipt(self):
        """Saved rows cannot claim review when required native evidence is gone."""

        module = self.product()

        repaired, _clients, _aws = self.run_experiment(
            candidate="repaired", selected=["phase18.synthetic-denial"]
        )
        native_path = repaired / "native-report.json"
        native_raw = native_path.read_bytes()
        native_path.unlink()
        with patch.object(boto3, "Session", side_effect=AssertionError("show must be offline")):
            code, shown = self.invoke(module, "show", "--experiment", repaired)
        self.assertEqual(code, 0, shown)
        self.assertEqual(shown["status"], "incomplete")
        self.assertNotEqual(shown["decision"]["verdict"], "review_required")
        native_path.write_bytes(native_raw)

        faulty, _clients, _aws = self.run_experiment(
            candidate="faulty", selected=["phase18.synthetic-denial"]
        )
        faulty_native = faulty / "native-report.json"
        faulty_native_raw = faulty_native.read_bytes()
        faulty_native.unlink()
        with patch.object(boto3, "Session", side_effect=AssertionError("show must be offline")):
            code, shown = self.invoke(module, "show", "--experiment", faulty)
        self.assertEqual(code, 0, shown)
        self.assertEqual(shown["decision"]["verdict"], "reject")
        faulty_native.write_bytes(faulty_native_raw)

        receipt_record = self._read_record(repaired)
        row = self._rows(receipt_record)[0]
        receipt = repaired / "executions" / row["executionId"] / "scores" / row["scoringAttemptId"] / "result.json"
        self.assertTrue(receipt.is_file(), receipt)
        receipt_raw = receipt.read_bytes()
        receipt.unlink()
        with patch.object(boto3, "Session", side_effect=AssertionError("show must be offline")):
            code, shown = self.invoke(module, "show", "--experiment", repaired)
        self.assertEqual(code, 0, shown)
        self.assertEqual(shown["status"], "incomplete")
        self.assertNotEqual(shown["decision"]["verdict"], "review_required")
        receipt.write_bytes(receipt_raw)

        modified_receipt = json.loads(receipt_raw)
        modified_receipt["executionId"] = "foreign-execution"
        receipt.write_text(json.dumps(modified_receipt), encoding="utf-8")
        with patch.object(boto3, "Session", side_effect=AssertionError("show must be offline")):
            code, shown = self.invoke(module, "show", "--experiment", repaired)
        self.assertEqual(code, 0, shown)
        self.assertEqual(shown["status"], "incomplete")
        self.assertNotEqual(shown["decision"]["verdict"], "review_required")
        receipt.write_bytes(receipt_raw)

    def test_offline_inspect_and_compare_reject_saved_lock_inputs_and_bindings(self):
        """Candidate, case, bundle and execution bindings are authenticated offline."""

        baseline, _clients, _aws = self.run_experiment(candidate="faulty")
        candidate, _clients, _aws = self.run_experiment(candidate="repaired")
        module = self.product()
        record_path = self._record_path(candidate)
        record_raw = record_path.read_bytes()
        record = json.loads(record_raw)
        first_row, second_row = self._rows(record)
        mutation_paths = {
            "candidate-lock": candidate / "candidate/source/agent/uv.lock",
            "case": candidate / "inputs/cases/phase18.synthetic-denial.frozen.json",
            "bundle": candidate / "inputs/bundles" / f"{first_row['bundleSha256']}.json",
            "execution-binding": record_path,
        }
        for kind, path in mutation_paths.items():
            with self.subTest(kind=kind):
                original = path.read_bytes()
                try:
                    if kind == "execution-binding":
                        changed = json.loads(original)
                        changed["cases"][0]["executionId"] = changed["cases"][1]["executionId"]
                        path.write_text(json.dumps(changed), encoding="utf-8")
                    else:
                        path.write_bytes(original + b"\nPHASE18_TAMPERED_SAVED_INPUT\n")
                    with patch.object(boto3, "Session", side_effect=AssertionError("offline inspect only")):
                        show_code, shown = self.invoke(module, "show", "--experiment", candidate)
                    self.assertEqual(show_code, 0, shown)
                    self.assertEqual(shown["status"], "incomplete", shown)
                    self.assertNotEqual(shown["decision"]["verdict"], "review_required", shown)
                    with patch.object(boto3, "Session", side_effect=AssertionError("offline compare only")):
                        compare_code, compared = self.invoke(
                            module, "compare", "--baseline", baseline, "--candidate", candidate
                        )
                    self.assertEqual(compare_code, 2, compared)
                    self.assertEqual(compared.get("status"), "incomplete", compared)
                finally:
                    path.write_bytes(original)

    def test_native_report_mutations_and_required_finding_errors_never_claim_review(self):
        """Native SDK-valid mutations still need project identity and finding checks."""

        module = self.product()
        experiment, _clients, _aws = self.run_experiment(
            candidate="repaired", selected=["phase18.synthetic-denial"]
        )
        report_path = experiment / "native-report.json"
        record_path = self._record_path(experiment)
        report_raw = report_path.read_bytes()
        record_raw = record_path.read_bytes()
        EvaluationReport = self.native_types()[3]

        for kind in ("score", "label", "foreign-case"):
            with self.subTest(kind=kind):
                document = json.loads(report_raw)
                output = document["detailed_results"][0][0]
                if kind == "score":
                    output["score"] = 0.0
                    output["test_pass"] = False
                    output["label"] = "fail"
                    output["reason"] = "phase18 native score mutation"
                    output["metadata"]["verdict"] = "fail"
                    document["scores"][0] = 0.0
                    document["test_passes"][0] = False
                    document["reasons"][0] = "phase18 native score mutation"
                    document["overall_score"] = sum(document["scores"]) / len(document["scores"])
                elif kind == "label":
                    output["label"] = "fail"
                else:
                    output["metadata"]["caseId"] = "phase18.foreign-case"
                report_path.write_text(json.dumps(document), encoding="utf-8")
                self.assertIsInstance(EvaluationReport.from_file(str(report_path)), EvaluationReport)
                changed_record = json.loads(record_raw)
                changed_record["nativeReport"]["sha256"] = hashlib.sha256(report_path.read_bytes()).hexdigest()
                record_path.write_text(json.dumps(changed_record), encoding="utf-8")
                try:
                    with patch.object(boto3, "Session", side_effect=AssertionError("show must be offline")):
                        code, shown = self.invoke(module, "show", "--experiment", experiment)
                    self.assertEqual(code, 0, shown)
                    self.assertEqual(shown["status"], "incomplete", shown)
                    self.assertNotEqual(shown["decision"]["verdict"], "review_required", shown)
                finally:
                    report_path.write_bytes(report_raw)
                    record_path.write_bytes(record_raw)

        for kind in ("missing-finding", "errored-finding"):
            with self.subTest(kind=kind):
                changed_record = json.loads(record_raw)
                execution_id = changed_record["cases"][0]["executionId"]
                execution_path = experiment / "executions" / execution_id / "execution.json"
                execution_raw = execution_path.read_bytes()
                execution_record = json.loads(execution_raw)
                findings = execution_record["deterministic"]["findings"]
                if kind == "missing-finding":
                    findings.pop("action")
                else:
                    findings["action"]["status"] = "error"
                execution_path.write_text(json.dumps(execution_record), encoding="utf-8")
                try:
                    with patch.object(boto3, "Session", side_effect=AssertionError("show must be offline")):
                        code, shown = self.invoke(module, "show", "--experiment", experiment)
                    self.assertEqual(code, 0, shown)
                    self.assertEqual(shown["status"], "incomplete", shown)
                    self.assertNotEqual(shown["decision"]["verdict"], "review_required", shown)
                finally:
                    execution_path.write_bytes(execution_raw)

    def test_self_valid_experiments_with_different_tooling_do_not_compare(self):
        """A valid experiment with changed adapter/tooling is not a controlled pair."""

        baseline, _clients, _aws = self.run_experiment(
            candidate="faulty", selected=["phase18.synthetic-denial"]
        )
        module = self.product()
        alternate = self.root / "alternate-tooling"
        shutil.copytree(AGENT, alternate, ignore=shutil.ignore_patterns("__pycache__"))
        adapter = alternate / "strands_evaluators.py"
        adapter.write_text(
            adapter.read_text(encoding="utf-8") + "\n# PHASE18_SELF_VALID_ALTERNATE_TOOLING\n",
            encoding="utf-8",
        )
        model_session, _clients = self._clients("repaired")
        aws = FakeAWS(self.runs)
        with patch.object(module, "AGENT_DIRECTORY", alternate):
            with patch.object(boto3, "Session", side_effect=aws.session_factory):
                candidate = Path(module.run_experiment(
                    self.suite,
                    self.runs,
                    candidate_id="repaired",
                    evaluator_path=self.evaluator,
                    wait_seconds=0,
                    selected_cases=["phase18.synthetic-denial"],
                    model_session=model_session,
                    source_directory=self.source_workspaces["repaired"],
                ))
        module = self.product()
        with patch.object(boto3, "Session", side_effect=AssertionError("show must be offline")):
            baseline_code, baseline_view = self.invoke(module, "show", "--experiment", baseline)
            candidate_code, candidate_view = self.invoke(module, "show", "--experiment", candidate)
        self.assertEqual(baseline_code, 0, baseline_view)
        self.assertEqual(candidate_code, 0, candidate_view)
        self.assertEqual(baseline_view["status"], "complete", baseline_view)
        self.assertEqual(candidate_view["status"], "complete", candidate_view)
        self.assertNotEqual(
            self._read_record(baseline)["snapshot"]["toolingSha256"],
            self._read_record(candidate)["snapshot"]["toolingSha256"],
        )
        with patch.object(boto3, "Session", side_effect=AssertionError("compare must be offline")):
            code, result = self.invoke(module, "compare", "--baseline", baseline, "--candidate", candidate)
        self.assertEqual(code, 2, result)
        self.assertEqual(result.get("status"), "incomplete")
        self.assertRegex(json.dumps(result).lower(), r"tool|identity|mismatch")


if __name__ == "__main__":
    unittest.main()
