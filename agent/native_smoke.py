"""Import and start the packaged runtime using its bundled native dependencies."""

from __future__ import annotations

import json
import platform
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


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
                (
                    "import strands; from main import app, invoke; "
                    "assert type(app).__name__ == 'BedrockAgentCoreApp'; "
                    "assert invoke({'native': True})['status'] == 'ok'; "
                    "print(strands.__file__)"
                ),
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
                    response = request_json("http://127.0.0.1:8080/invocations", {"native": True})
                    assert response["status"] == "ok"
                    break
                except (OSError, json.JSONDecodeError):
                    time.sleep(0.25)
            else:
                raise RuntimeError("native AgentCore /ping did not become healthy")
        finally:
            process.terminate()
            process.wait(timeout=10)

    print("native ARM64 ZIP import, invocation, and /ping smoke passed")


if __name__ == "__main__":
    main()
