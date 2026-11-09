"""Import and start the packaged runtime using its bundled native dependencies."""

from __future__ import annotations

import json
import platform
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError
import urllib.request
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
RUNTIME_ARCHIVE = ROOT / ".artifacts" / "agent" / "runtime.zip"
ADAPTER_ARCHIVE = ROOT / ".artifacts" / "agent" / "alarm-adapter.zip"
NATIVE_IMPORT_CHECK = """\
import strands
from bedrock_agentcore.runtime import RequestContext
from main import app, invoke
assert type(app).__name__ == 'BedrockAgentCoreApp'
try:
    smoke_result = invoke({'smoke': True}, RequestContext(session_id='native-smoke-session'))
except ValueError:
    pass
else:
    assert isinstance(smoke_result, dict) and smoke_result.get('status') in {'invalid', 'rejected', 'error'}, smoke_result
print(strands.__file__)
"""
NATIVE_ADAPTER_CHECK = """\
import alarm_adapter
result = alarm_adapter.handler({'smoke': True}, None)
assert result.get('status') == 'rejected', result
print(alarm_adapter.__file__)
"""


def request_json(url: str, payload: dict[str, object] | None = None) -> dict[str, object]:
    body = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(
        url,
        data=body,
        headers={"content-type": "application/json"} if body is not None else {},
        method="POST" if body is not None else "GET",
    )
    with urllib.request.urlopen(request, timeout=1) as response:
        assert response.status == 200, f"{url} returned HTTP {response.status}"
        return json.load(response)


def rejected_invocation(url: str, payload: dict[str, object]) -> None:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=1) as response:
            body = json.load(response)
            assert body.get("status") in {"invalid", "rejected", "error"}, body
    except HTTPError as error:
        assert 400 <= error.code < 500, f"invalid smoke invocation returned HTTP {error.code}"


def main() -> None:
    if platform.machine() not in {"aarch64", "arm64"}:
        raise SystemExit(f"native ARM64 proof requires an ARM64 runner; got {platform.machine()}")

    runtime_archive = Path(sys.argv[1]) if len(sys.argv) > 1 else RUNTIME_ARCHIVE
    adapter_archive = Path(sys.argv[2]) if len(sys.argv) > 2 else ADAPTER_ARCHIVE
    if not runtime_archive.is_file():
        raise SystemExit(f"runtime ZIP is missing: {runtime_archive}")
    if not adapter_archive.is_file():
        raise SystemExit(f"alarm adapter ZIP is missing: {adapter_archive}")

    with tempfile.TemporaryDirectory(prefix="agentcore-native-") as temporary:
        runtime_root = Path(temporary) / "runtime"
        adapter_root = Path(temporary) / "adapter"
        runtime_root.mkdir()
        adapter_root.mkdir()
        with zipfile.ZipFile(runtime_archive) as archive:
            archive.extractall(runtime_root)
            launcher_info = archive.getinfo("opentelemetry-instrument")
            launcher_mode = (launcher_info.external_attr >> 16) & 0o777
            if not launcher_mode & 0o111:
                raise RuntimeError("Runtime ZIP launcher is not marked executable")
            (runtime_root / "opentelemetry-instrument").chmod(launcher_mode)
        with zipfile.ZipFile(adapter_archive) as archive:
            archive.extractall(adapter_root)

        import_check = subprocess.run(
            [
                sys.executable,
                "-E",
                "-S",
                "-c",
                NATIVE_IMPORT_CHECK,
            ],
            cwd=runtime_root,
            check=True,
            capture_output=True,
            text=True,
        )
        assert str(runtime_root) in import_check.stdout, import_check.stdout

        adapter_check = subprocess.run(
            [sys.executable, "-E", "-S", "-c", NATIVE_ADAPTER_CHECK],
            cwd=adapter_root,
            check=True,
            capture_output=True,
            text=True,
        )
        assert str(adapter_root) in adapter_check.stdout, adapter_check.stdout

        process = subprocess.Popen(
            [str(runtime_root / "opentelemetry-instrument"), sys.executable, "main.py"],
            cwd=runtime_root,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            for _ in range(80):
                try:
                    health = request_json("http://127.0.0.1:8080/ping")
                    assert health["status"] == "Healthy"
                    rejected_invocation("http://127.0.0.1:8080/invocations", {"smoke": True})
                    break
                except (OSError, json.JSONDecodeError):
                    time.sleep(0.25)
            else:
                raise RuntimeError("native AgentCore /ping did not become healthy")
        finally:
            process.terminate()
            process.wait(timeout=10)

    print("native ARM64 Runtime and adapter ZIP imports, invalid-event rejection, and /ping smoke passed")


if __name__ == "__main__":
    main()
