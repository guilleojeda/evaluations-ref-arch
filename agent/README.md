# AgentCore runtime

The agent workspace uses Python 3.13, `uv==0.13.6`, and locked ARM64 Linux
dependencies. The runtime accepts only the checked alarm adapter payload:
`{event, deployment}`. The adapter forwards the verbatim CloudWatch event and a
release attestation containing the Runtime ARN/version, pinned endpoint,
source revision, and runtime ZIP SHA-256.

From the repository root:

```sh
uv sync --project agent --locked
uv run --project agent --locked python agent/package_runtime.py
```

The package command writes two artifacts: `.artifacts/agent/runtime.zip` for
AgentCore Runtime and `.artifacts/agent/alarm-adapter.zip` for the Lambda
adapter. The Runtime ZIP contains the application modules, locked dependencies,
an `opentelemetry-instrument` launcher, and a generated `agent-manifest.json`
with the source revision and prompt digest. The source-tree manifest is a
development template; packaging writes the generated identity into the ZIP.
The checked release attests the
complete ZIP SHA-256 externally; a ZIP cannot contain a self-hash of its final
bytes. The checked release finalizes the endpoint and adapter attestation after
MMDSv2 and the endpoint version have been read back.

## Export and query captured evidence

Use the verified demo operator profile and the originating alarm, Runtime run,
and app API identities from the incident. Set `window_start` and `window_end`
to UTC timestamps at most 30 minutes apart. Set `bundle` to a new path in
private evidence storage. Export while the relevant configuration can still be
observed.

```sh
uv run --project agent --locked python agent/captured_evidence.py export \
  --profile reinvent-2026-talk --account-id 027224425948 --region us-east-1 \
  --api-id "$app_api_id" --alarm-arn "$alarm_arn" \
  --transition-at "$transition_at" --run-id "$run_id" \
  --start "$window_start" --end "$window_end" --output "$bundle"
```

Export reads the ordinary sources independently and records the scope,
collection times and gaps. Configuration records when the exporter observed
it, independently of the requested log window.
Keep the bundle private and retain its digest with the incident record.

Choose a UTC `reference_time` and run the following locally. The query verifies
the bundle and uses its saved observations.

```sh
uv run --offline --project agent --locked python agent/captured_evidence.py query \
  --bundle "$bundle" --reference-time "$reference_time" \
  --tool search_logs --resource inventory --query "$request_id" \
  --start "$window_start" --end "$window_end"
```

The other tool names are `read_metrics`, `read_configuration`, and
`read_change_history`. Supply the native `--period-seconds` and a supported
`--metric` when narrowing a metric query. Use `--operation` and `--error` to
narrow logs by projected fields. Inspect the returned window, observations and
completeness before using a result as evidence. A partial or unavailable source
can leave a conclusion uncertain.

## Local health and invalid-event smoke

Start the local Runtime entrypoint in one terminal:

```sh
uv run --project agent --locked python agent/main.py
```

In another terminal, check health and submit a deliberately invalid payload:

```sh
curl --fail http://127.0.0.1:8080/ping
curl --silent --show-error -i -X POST http://127.0.0.1:8080/invocations \
  -H 'content-type: application/json' \
  -d '{"smoke":true}'
```

`/ping` returns `{"status":"Healthy"}`. The invocation must be rejected
because it is not a trusted `{event, deployment}` CloudWatch delivery. It does
not create a run, read application sources, or perform inference. This smoke
checks only health and invalid-input handling; it is not proof of a live
alarm-triggered investigation.

## Native ARM64 package smoke

Run the package check on a native Linux ARM64 runner, matching the ZIP wheels:

```sh
uv sync --project agent --locked
uv run --project agent --locked python agent/package_runtime.py
uv run --project agent --locked python agent/native_smoke.py \
  .artifacts/agent/runtime.zip .artifacts/agent/alarm-adapter.zip
```

`native_smoke.py` imports both packaged artifacts, checks `/ping`, and confirms
that the invalid Runtime and adapter smoke payloads are rejected. It starts the
Runtime through the packaged OpenTelemetry launcher. A rejected-event smoke
does not claim an alarm run or exercise model inference.
