# AgentCore runtime starter

The Python 3.13 workspace runs a credential-free `BedrockAgentCoreApp` starter.
It pins `uv==0.13.6` and Python `3.13.x`.

From the repository root:

```sh
uv sync --project agent --locked
uv run --project agent --locked python agent/package_runtime.py
```

Start the local runtime in another terminal and check its health and invocation
routes:

```sh
uv run --project agent --locked python agent/main.py
curl --fail http://127.0.0.1:8080/ping
curl --fail -sS -X POST http://127.0.0.1:8080/invocations \
  -H 'content-type: application/json' \
  -d '{"smoke":true}'
```

The `/ping` response is a successful HTTP response whose JSON has
`{"status":"Healthy"}` (the SDK's health response). The invocation response is
deterministic and contains `"status":"ok"`.

## Native ARM64 proof

AgentCore Runtime direct ZIP deployment supports Python 3.13 on ARM64 Linux.
On a native `ubuntu-24.04-arm` runner, install the locked project and run:

```sh
uv sync --project agent --locked
uv run --project agent --locked python agent/package_runtime.py
uv run --project agent --locked python agent/native_smoke.py .artifacts/agent/runtime.zip
```

`native_smoke.py` unpacks the ZIP and starts the entrypoint with Python `-E -S`.
The smoke check imports the packaged Strands dependencies and calls both `/ping`
and `/invocations`. Run it on Linux ARM64 to match the ZIP's wheels.

The package script uses the lockfile's exact versions and asks `uv` for
`aarch64-manylinux2014` binary wheels, so the native runner check imports the
same dependency set that is uploaded in the ZIP.
