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

    archive_path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / ".artifacts" / "agent" / "runtime.zip"
    if not archive_path.is_file():
        raise SystemExit(f"runtime ZIP is missing: {archive_path}")

    with tempfile.TemporaryDirectory(prefix="agentcore-native-") as temporary:
        runtime_root = Path(temporary)
        with zipfile.ZipFile(archive_path) as archive:
            archive.extractall(runtime_root)

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

        process = subprocess.Popen(
            [sys.executable, "-E", "-S", "main.py"],
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

    print("native ARM64 ZIP import, invalid-event rejection, and /ping smoke passed")


if __name__ == "__main__":
    main()
