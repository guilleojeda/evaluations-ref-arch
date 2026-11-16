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

## Review and freeze a case (S1)

Use the private S1 archive from the verified S3 manifest. Compare its SHA-256
with the recorded archive digest before extraction, then verify every imported
file against `SHA256SUMS`. In the browser IDE terminal, from the repository root:

```sh
umask 077
review_root="${PRIVATE_REVIEW_ROOT:?set a directory outside the editable checkout}"
archive="${PHASE14_IMPORT_ARCHIVE:?set the verified private archive path}"
mkdir -p "$review_root"
session="$(mktemp -d "$review_root/s1.XXXXXX")"
mkdir "$session/import" "$session/edit" "$session/frozen"
sha256sum "$archive" # Compare with the recorded archive SHA-256.
tar -xzf "$archive" -C "$session/import"
(cd "$session/import" && sha256sum -c SHA256SUMS)

case_file="$session/edit/denial.reviewed.json"
bundle="$session/import/denial.json"
frozen="$session/frozen/denial.frozen.json"
candidate="$session/denial.candidate-task.json"
cp "$session/import/denial-session-draft.json" "$case_file"
code -r "$session/import/denial-trace-pointer.json" "$case_file"
```

The draft starts with an empty `admissibleRecommendations` list. Run
`validate` once to see the incomplete review and its source coverage. Inspect
the matched original trace reference and the captured sources at the displayed
cutoff, then fill in and save the reviewed action, target, value, and unit in
the browser editor.

Validate the saved review against the same staged bundle before freezing it.
This command is offline: it does not discover credentials, query AWS, or use a
live fallback. It reports `ready`, `incomplete`, or `invalid` and shows
required/optional source coverage:

```sh
uv run --offline --project agent --locked python agent/reviewed_cases.py validate \
  --case "$case_file" --bundle "$bundle"
```

Freeze only a `ready` review. The frozen envelope is immutable input for later
evaluation, so put it in the separate private frozen directory and choose a new
path for every changed meaning, cutoff, or evidence set:

```sh
uv run --offline --project agent --locked python agent/reviewed_cases.py freeze \
  --case "$case_file" --bundle "$bundle" --output "$frozen"
```

Hand the candidate runner only the public task projection. It verifies the
frozen envelope and bundle, then writes JSON containing the allowlisted alarm,
time/window, service, symptoms, and resource-scope fields; expected actions,
diagnosis, reviewer notes, coverage references, tool observations, trace data,
and the original report remain evaluator-only:

```sh
uv run --offline --project agent --locked python agent/reviewed_cases.py candidate-input \
  --case "$frozen" --bundle "$bundle" > "$candidate"
```

The case retains provenance independently of that projection: the originating
alarm and transition, genuine originating run ID, bundle SHA-256, named
tool/resource/argument references with required or optional reasons, and the
case reference time. A genuine `originatingRunId` stays distinct from any
acquisition; when a bundle came from a separate acquisition, its `acquisitionId`
matches the bundle's `origin.runId`. The frozen `caseSha256` binds
the reviewed meaning to the verified bundle digest. Keep those IDs, exact
source bytes, trace references, and the review coverage justification in the
private incident record; never replace a missing or mismatched asset with live
state.

For independent entry, use the prepared case and bundle pair from the verified
manifest. Review coverage using the corresponding `*-prepared.json` file.
For the candidate task, pass the matching `*-prepared.frozen.json` envelope
directly to `candidate-input`.

## Check an investigation deterministically

Pass a frozen case and its matching captured bundle. The recorded native
archive supplies the run, trace, session, and report provenance.

```sh
uv run --offline --project agent --locked python agent/deterministic_checks.py \
  --case "$frozen_case" --bundle "$source_bundle" --record "$native_archive"
```

Pass a standalone structured report to check its fields and citations.

```sh
uv run --offline --project agent --locked python agent/deterministic_checks.py \
  --case "$frozen_case" --bundle "$source_bundle" --report "$report_json"
```

Both commands emit JSON only on standard output. The result has `status`
(`complete`, `incomplete`, or `error`), `inputKind` (`recorded_live` or
`report_only`), verified identity fields, and separate findings for
`report_structure`, `assessment`, `action`, `target`, `target_value`,
`source_scope`, `as_of_time`, and `operator_boundary`. Each finding includes
its own status, nullable `verdict` (`pass` or `fail`), and reason. Recorded
results also show `traceLinkage` so missing joins remain visible alongside
known scope or timing failures.

Exit status 0 means every applicable check completed. Read the individual
verdicts to see which findings passed or failed. Exit status 2 means an input
or check is incomplete or invalid. The recorded path verifies the case,
bundle, report, run, alarm transition, trace, and Runtime session identities.
Equivalent read-only query orders are accepted, while missing or unlinked
activity remains incomplete. The report-only path can check report fields and
explicit citation timing, but its execution-dependent source and operator
findings remain incomplete. Treat constructed reports as controls and retain
the recorded identity when showing a genuine saved result.

Keep cases, bundles, reports, and native spans in private evidence storage or a
private operator workspace. The checker runs offline and emits only the findings and their input
identities. Semantic evaluation and release policy use separate steps.

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
