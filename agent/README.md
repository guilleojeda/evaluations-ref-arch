# AgentCore runtime

The agent uses Python 3.13, `uv==0.13.6`, and locked ARM64 Linux
dependencies. Its runtime accepts only the CloudWatch delivery shape
`{event, deployment}`. The adapter forwards the event unchanged and adds a
release attestation containing the Runtime ARN and version, endpoint tuple,
source revision, and package SHA-256 values.

From the repository root:

```sh
uv sync --project agent --locked
uv run --project agent --locked python agent/package_runtime.py
```

The package command writes `.artifacts/agent/runtime.zip` for AgentCore Runtime
and `.artifacts/agent/alarm-adapter.zip` for the Lambda adapter. The Runtime ZIP
contains the application modules, locked dependencies, an
`opentelemetry-instrument` launcher, and a generated `agent-manifest.json` with
the source revision and prompt digest.
The source-tree manifest is a development template. Packaging writes the
generated identity into the ZIP. The complete Runtime ZIP digest is attested
outside the ZIP because a ZIP cannot contain a self-hash of its final bytes.
The checked release verifies both packages. The publisher reference operation
finalizes the publisher-owned endpoint and adapter tuple after reading back
MMDSv2 and the endpoint version.

## Choose the public or prepared route

The public route uses the local synthetic case. Start with the
[attendee guide](../docs/attendee-guide.md) or [adapt the evaluation](../docs/adapt-evaluations.md)
to run a saved report and the native Strands example without presenter
credentials, an AWS account, private evidence, or a model call.

The prepared route uses reviewed cases and evaluator inputs, outside-Runtime
telemetry, and the protected release workflow. Follow [talk preparation](../docs/preparation.md)
and the [deployment design](../docs/deployment.md). Keep private locators and
credentials out of this checkout. Preparation and inspection commands do not
run a model or send application traffic.

## Score the published live-denial case

The public live walkthrough starts from a native trace. In AgentCore, add that
trace to a fixed dataset, edit `turns[0].expected_response` and the typed
`metadata.expected_recommendation` in the scenario draft, save it, and create
a version. Only the published version is a frozen input.

Use the maintained [live-denial Codespace command](../examples/live-denial/README.md#prepare-the-two-inputs)
from a terminal whose working directory is `examples/live-denial`. It copies
the full published dataset ID and version into `DATASET_ID` and
`DATASET_VERSION`, selects `examples[0]`, and runs the locked `uv` scorer.

`score_denial.py` reads the case, fetches the original spans from CloudWatch
using the case's session/log-group/start-time fields, reads `incident.report`,
and calls `Builtin.Correctness` with the recorded spans and the reviewed fields
published in that same scenario. It does not invoke the agent again. Show the
exact structured `recommendation` object first, then the separate native
label, value, explanation, and scoring-attempt identity; a later attempt may
return a different label.

## Open a prepared stage

The [talk preparation runbook](../docs/preparation.md) owns the checkpoint map,
session input, editable worktrees, and replacement-browser archive. Every
performance needs a new non-empty `PHASE22_SESSION_ID`. Prepared asset archives
may be reused. Build the session input with `scripts/talk-inputs.py --session-id`
as described in the runbook, then prepare or inspect a stage from the repository
root:

```sh
python3 scripts/talk-session.py prepare \
  --checkpoints "$PHASE22_CHECKPOINTS" \
  --session "$PHASE22_SESSION" \
  --directory "$PHASE22_SESSION_ROOT"
python3 scripts/talk-session.py status \
  --directory "$PHASE22_SESSION_ROOT" --stage S3
```

Direct entry needs only the selected stage's pinned checkpoint and private
session input. For example, an S3-only entry is:

```sh
python3 scripts/talk-session.py prepare \
  --checkpoints "$PHASE22_S3_CHECKPOINTS" \
  --session "$PHASE22_S3_SESSION" \
  --directory "$PHASE22_S3_ROOT" --stage S3
```

The S5 worktree is the only stage that checks out the qualified `demo-deploy`
branch. Use `save` and `restore` with an explicit private inventory when moving
selected edits, inputs, or results. Do not archive credentials, Git metadata,
virtual environments, or build caches.

## Prepare the reviewed faulty reference

The named `faulty` publication is a publisher-owned fixture, not an ordinary
agent release or a quality qualification. Follow the single
[`demo-deploy`/`reference-setup` deployment runbook](../docs/deployment.md#restore-the-reviewed-faulty-reference)
for descriptor and archive checks, dispatch, ownership migration, repeat and
partial-run readback, and the denied witness. Ordinary agent releases preserve
the publisher tuple. Repaired candidate qualification belongs to the protected
release workflow.

## Export and query captured evidence

Use the verified demo operator profile and the originating alarm, Runtime run,
and app API identities. Keep `window_start` and `window_end` UTC timestamps no
more than 30 minutes apart. Export to a new private bundle path while the
relevant configuration is still observable:

```sh
uv run --project agent --locked python agent/captured_evidence.py export \
  --profile "$AWS_PROFILE" --account-id "$AWS_ACCOUNT_ID" --region "$AWS_REGION" \
  --api-id "$app_api_id" --alarm-arn "$alarm_arn" \
  --transition-at "$transition_at" --run-id "$run_id" \
  --start "$window_start" --end "$window_end" --output "$bundle"
```

The exporter records source scope, collection times, and gaps. It records
configuration when it was observed, independently of the requested log
window. Keep the bundle private and retain its digest with the incident.

Query a saved bundle locally with a UTC `reference_time`:

```sh
uv run --offline --project agent --locked python agent/captured_evidence.py query \
  --bundle "$bundle" --reference-time "$reference_time" \
  --tool search_logs --resource inventory --query "$request_id" \
  --start "$window_start" --end "$window_end"
```

The supported tools are `search_logs`, `read_metrics`, `read_configuration`,
and `read_change_history`. Use the native `--period-seconds` and a supported
`--metric` for metric queries. Use `--operation` and `--error` for projected log
fields. Inspect the returned window, observations, and completeness before
using a result as evidence. A partial or unavailable source leaves the related
conclusion uncertain.

## Review and freeze a case (S1)

For the public live-denial route, S1 is the AgentCore dataset workflow: add the
selected native trace to a fixed dataset, leave expected response and expected
trajectory disabled during creation, edit `turns[0].expected_response` and
the typed `metadata.expected_recommendation` in the scenario draft, save it,
and choose **Create version**. For ongoing evidence the typed value is
`Restore inventory access`/`inventory`/healthy-version/`version`; for
recovered evidence it is `Other` with null target and unit plus a separate
free explanation. A draft scenario ID is not a published case and must not be
used by the Codespace download command.

The repository's captured-evidence stages use the offline review commands
below. They preserve the same boundary: the expected remedy remains evaluator
input while the candidate sees only the public task and read-only evidence.

Use the verified portable inputs from [talk preparation](../docs/preparation.md)
and keep the editable draft and frozen envelope in separate private
directories:

```sh
umask 077
review_root="${PRIVATE_REVIEW_ROOT:?set a private directory outside the checkout}"
asset_extract="${asset_extract:?set the extracted portable inputs directory from preparation}"
mkdir -p "$review_root"
session="$(mktemp -d "$review_root/s1.XXXXXX")"
mkdir "$session/edit" "$session/frozen"
case_file="$session/edit/denial.reviewed.json"
bundle="$asset_extract/prepared/denial.json"
frozen="$session/frozen/denial.frozen.json"
candidate="$session/denial.candidate-task.json"
cp "$asset_extract/audience/denial-session-draft.json" "$case_file"
```

The draft starts with an empty `admissibleRecommendations` list. Inspect the
matched original trace and captured sources at the displayed cutoff, then fill
in the reviewed action, target, value, and unit. Validate the saved review
offline against its matching bundle. The result is `ready`, `incomplete`, or
`invalid`, and these commands do not query AWS or use a live fallback:

```sh
uv run --offline --project agent --locked python agent/reviewed_cases.py validate \
  --case "$case_file" --bundle "$bundle"
```

Freeze only a `ready` review. Use a new frozen path when the meaning, cutoff,
or evidence set changes:

```sh
uv run --offline --project agent --locked python agent/reviewed_cases.py freeze \
  --case "$case_file" --bundle "$bundle" --output "$frozen"
uv run --offline --project agent --locked python agent/reviewed_cases.py candidate-input \
  --case "$frozen" --bundle "$bundle" > "$candidate"
```

`candidate-input` emits only the public task projection. Expected actions,
diagnosis, reviewer notes, coverage references, observations, trace data, and
the original report stay evaluator-only. The frozen case retains the
originating alarm and transition, genuine originating run ID, bundle digest,
named tool and resource references with required or optional reasons, case
reference time, and `caseSha256`. A genuine `originatingRunId` remains distinct
from an acquisition. For a separate acquisition, `acquisitionId` matches the
bundle's `origin.runId`. Keep those IDs, source bytes, trace references, and
coverage justification in private evidence storage. Do not replace a missing
or mismatched asset with live state.

For prepared entry, inspect `prepared/validation.json`, then pass
`prepared/denial.frozen.json` as `--case` and `prepared/denial.json` as
`--bundle` to `candidate-input`.

## Check an investigation deterministically

Check a recorded execution with its frozen case and matching source bundle:

```sh
uv run --offline --project agent --locked python agent/deterministic_checks.py \
  --case "$frozen_case" --bundle "$source_bundle" --record "$native_archive"
```

Check a standalone structured report with the same case and bundle:

```sh
uv run --offline --project agent --locked python agent/deterministic_checks.py \
  --case "$frozen_case" --bundle "$source_bundle" --report "$report_json"
```

Both commands emit JSON. Results contain `status` (`complete`, `incomplete`,
or `error`), `inputKind` (`recorded_live` or `report_only`), verified identity
fields, and findings for `report_structure`, `assessment`, `action`, `target`,
`target_value`, `source_scope`, `as_of_time`, and `operator_boundary`. Each
finding has its own status, nullable `verdict` (`pass` or `fail`), and reason.
Recorded results also expose `traceLinkage` so missing joins remain visible.

Exit status 0 means every applicable check completed. Exit status 2 means an
input or check is incomplete or invalid. The recorded path verifies the case,
bundle, report, run, alarm transition, trace, and Runtime session identities.
The report-only path can check report fields and citation timing, but execution
dependent source and operator findings remain incomplete. Treat constructed
reports as controls and retain recorded identities for genuine results.

## Run the native Strands development experiment (S4)

For the opening incident, use the [native prompt comparison](../examples/live-denial/README.md#run-the-native-example). It generates a fresh recommendation using the application's constructor. The same published scenario and original trace are used locally and in the first CI job.

The commands below run the independent prepared S4 experiment. It uses native Strands cases, custom evaluators and the captured execution runner to evaluate the reviewed suite. Each selected case can exercise a full investigation using captured evidence.

Direct prepared entry does not require an S3 run prerequisite. The prepared
suite keeps case and bundle paths plus evaluator metadata outside
the public task input. Use `--case` for one named case. Use `--source-run` only
to continue from an authenticated immutable S3 execution, including an
accepted active execution. Set private paths outside the editable checkout:

```sh
reviewed_suite="${PHASE18_SUITE:?set the private suite JSON path}"
reviewed_evaluator="${PHASE18_EVALUATOR:?set the verified Opus 5.5 evaluator descriptor}"
private_experiments="${PHASE18_EXPERIMENTS:?set a private experiment directory}"
```

Run the selected reviewed cases with the repaired candidate:

```sh
uv sync --project agent --locked
uv run --project agent --locked opentelemetry-instrument \
  python agent/development_experiment.py run \
  --suite "$reviewed_suite" --candidate repaired \
  --evaluator "$reviewed_evaluator" --output-root "$private_experiments"
```

Run one focused case, optionally selecting an exact S3 source:

```sh
uv run --project agent --locked opentelemetry-instrument \
  python agent/development_experiment.py run \
  --suite "$reviewed_suite" --case "$reviewed_case_id" \
  --candidate repaired --source-run "$s3_run" \
  --evaluator "$reviewed_evaluator" --output-root "$private_experiments"
```

The run snapshots the candidate, evaluator and experiment code, lock, suite,
selected cases and bundles before the first case. Repeating a selection creates
a new experiment and fresh execution, session, and trace identities. Bounded
task and evaluator retries record an error once and allow later selected cases
to continue. The native report has one row per case and evaluator. With four reviewed cases and two evaluators, the full run produces eight rows.

The deterministic row contains the eight named findings. The advisory row
contains the pinned AgentCore Opus 5.5 `semantic_quality` categorical verdict,
reason, selected scoring attempt, and identity references. The current rubric
checks diagnosis support and source or coverage grounding in that verdict.
recommendation correctness remains deterministic. Its native numeric field is
not a release quality score. Always retain the returned label, value, and
explanation: a later judge attempt can disagree with an earlier one.

Inspect or compare saved experiments without credentials or new work:

```sh
uv run --offline --project agent --locked \
  python agent/development_experiment.py show --experiment "$experiment_dir"
uv run --offline --project agent --locked \
  python agent/development_experiment.py compare \
  --baseline "$faulty_experiment" --candidate "$repaired_experiment"
```

`show` reopens the saved native report and canonical records. `compare` joins
the exact selected cases and tooling, runtime, input, evaluator, and scorer
identities and retains each experiment's selected scoring attempt. It does not
rejudge or rerun. A known required deterministic failure yields `reject` even
while advisory scoring is pending. Missing, invalid, or error execution or
scoring yields `incomplete` when no deterministic failure has already rejected
the experiment. For `run`, exit 1
means `reject`, exit 0 means `review_required`, and exit 2 means incomplete or
invalid execution. `show` exits 0 when it can read the saved experiment even if
its decision is `reject` or `incomplete`, and exits 2 when authentication or
reading fails. `compare` exits 0 only for a complete matching comparison and
otherwise exits 2. `compare` never authorizes a release.

S4 is development feedback. It does not publish or qualify a Runtime ZIP. The
editable prompt snapshot is separate from the prompt bytes in a serving ZIP.
The participant's push selects the opening incident with `agent/audience-input.json`. Its CI job runs the same one-case prompt comparison used in the IDE. The checked Runtime ZIP must also qualify against the four cases in `agent/qualification-input.json` and pass protected review. A later hosted alarm has its own investigation and trace. [CI steps](../docs/adapt-evaluations.md#run-the-same-test-on-the-next-push)

## Run and score the captured baseline (S2)

For the public live-denial walkthrough, S2 is the published dataset download
and original-trace score. Use the maintained [live-denial Codespace command](../examples/live-denial/README.md#prepare-the-two-inputs)
from the `examples/live-denial` directory; it selects `examples[0]` and runs
the locked `uv` scorer.

`score_denial.py` reads `denial-case.json`, fetches the recorded spans using the
case's session/log-group/start-time fields, extracts `incident.report`, and
calls `Builtin.Correctness` with the reviewed fields from that same published
scenario. It does not rerun the investigating agent. First show the exact structured
`recommendation` object and compare its action, target, value, and unit with the
reviewed expectation. Then show the separate native label, value, and
explanation; keep both outputs tied to the original trace and scoring attempt.

### Generate a new recommendation from the opening case

Use the two files already in the IDE. The published alarm is `Case.input` and the presenter's expected recommendation is `Case.expected_output`. The example reads the public conversation before the final response from the matching trace. It passes the alarm and that conversation to the agent created by `investigation.create_agent`. A fresh structured recommendation becomes the output graded by native `Equals()`. Edit `agent/prompt.py`, save, and rerun the same command. [Runnable example and command](../examples/live-denial/README.md#run-the-native-example)

### Inspect or score a prepared S2 execution

Open the prepared S2 execution from private evidence and inspect its retained
report and deterministic findings:

```sh
uv run --offline --project agent --locked python agent/evaluate_case.py show \
  --run "$run_dir"
```

Score the matching CloudWatch session with the short-lived evaluation role and
reviewed evaluator descriptor:

```sh
uv run --project agent --locked python agent/evaluate_case.py score \
  --run "$run_dir" --evaluator "$reviewed_evaluator" --rubric single \
  --wait-seconds 300
```

Current S2-S5 inputs use the calibrated single-mode Opus evaluator. It returns
one advisory `semantic_quality` verdict. Retained earlier records can use the
historical multi-mode `diagnosis_support` and `evidence_grounding` findings,
the historical Sonnet single-verdict evaluator, or the original Opus judge.
Preserve those labels and each record's evaluator configuration and reviewed
reference inputs. Release decisions still require deterministic findings and
identity-bound human review of the exact report, trace, and pending artifact.

For a reviewed input without a matching execution, run the captured prompt
with its frozen case and source bundle. The evaluation role can invoke the
required models, send evaluation traces, read the dedicated evaluation log
group, and archive private evidence. Configure the locked AWS OpenTelemetry
distribution for the outside-Runtime trace destination:

```sh
export AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:?set the authorized account}" AWS_REGION="${AWS_REGION:?set the authorized region}" AWS_DEFAULT_REGION="$AWS_REGION"
export AGENT_OBSERVABILITY_ENABLED=true AWS_GENAI_CONTENT_EXTRACTION_OPT_OUT=true
export OTEL_PYTHON_DISTRO=aws_distro OTEL_PYTHON_CONFIGURATOR=aws_configurator
export OTEL_RESOURCE_ATTRIBUTES="service.name=incident-triage-evaluation,aws.log.group.names=${EVALUATION_LOG_GROUP:?set the evaluation log group}"
export OTEL_EXPORTER_OTLP_TRACES_HEADERS="x-aws-log-group=$EVALUATION_LOG_GROUP,x-aws-log-stream=$EVALUATION_LOG_STREAM"
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="${TRACE_ENDPOINT:?set the regional trace endpoint}" OTEL_TRACES_EXPORTER=otlp
export OTEL_METRICS_EXPORTER=none OTEL_LOGS_EXPORTER=none OTEL_TRACES_SAMPLER=always_on
```

Set `frozen_case`, `source_bundle`, and `private_runs` outside the checkout:

```sh
uv run --project agent --locked opentelemetry-instrument \
  python agent/evaluate_case.py run \
  --case "$frozen_case" --bundle "$source_bundle" --output-root "$private_runs"
```

The runner saves model and evidence-tool activity, report, and deterministic
findings. Scoring waits for matching CloudWatch spans and saves each explicit
attempt under the run. If spans are still arriving, score the same run again.
`show` reopens the saved report and scores without credentials. Exit status 0
means the requested operation completed. Keep the case, bundle, run, and judge
attempts private.

An administrator supplies the descriptor with
`evaluate_case.py provision --model --rubric single` using the reviewed judge
profile. Provisioning uses the existing Transaction Search configuration, the
dedicated evaluation log group with a pre-created `spans` stream, and scoped
evaluation permissions. Scoring verifies the active SESSION evaluator against
the descriptor. Evaluation permissions are separate from application and
controller permissions. Use `evaluate_case.py calibrate` for reviewed controls
and keep those calibration records separate from candidate scores.

## Run, score and compare the repaired candidate (S3)

Use the maintained stage boundary for a replacement terminal. It selects the
approved profile, `us-east-1`, STS account, and locked ADOT environment. Setup
checks the workspace and AWS identity, then captures the effective
`SYSTEM_PROMPT` from the selected faulty baseline before editing. Neither setup
invokes a model.

```sh
session="${PHASE22_SESSION_ROOT:?path to the selected session root}"
source="${PHASE22_SOURCE_REPO:?path to the maintained source checkout}"
profile="${PHASE22_AWS_PROFILE:?approved presenter profile}"
account="${PHASE22_AWS_ACCOUNT:?approved AWS account}"
checker="$source/scripts/talk_stage.py"
inputs="${PHASE22_INPUT_ROOT:?path to the selected private inputs}"
outputs="${PHASE22_STAGE_OUTPUT_ROOT:?path to durable stage outputs}"
s2_run="${PHASE22_S2_RUN:?selected retained S2 execution directory}"
s2_evaluator="${PHASE22_S2_EVALUATOR:?selected reviewed S2 evaluator descriptor}"
s3_baseline="${PHASE22_S3_BASELINE_ROOT:?selected case-matched archived S3 baseline}"
s3_case="${PHASE22_S3_CASE:?selected frozen S3 case}"
s3_bundle="${PHASE22_S3_BUNDLE:?selected S3 source bundle}"

python3 "$checker" setup --stage S2 --repository "$source" --workspace "$session/S2" \
  --session-root "$session" --inputs "$inputs" --output "$outputs" \
  --profile "$profile" --account "$account"
python3 "$checker" run --stage S2 --repository "$source" \
  --workspace "$session/S2" --output "$outputs" --profile "$profile" \
  --account "$account" -- uv run --project agent --locked python agent/evaluate_case.py score \
  --run "$s2_run" --evaluator "$s2_evaluator" --rubric single --wait-seconds 300

python3 "$checker" setup --stage S3 --repository "$source" --workspace "$session/S3" \
  --session-root "$session" --inputs "$inputs" --output "$outputs" \
  --baseline "$s3_baseline" --profile "$profile" --account "$account"
# Edit only "$session/S3/agent/prompt.py".
python3 "$checker" run --stage S3 --repository "$source" --workspace "$session/S3" \
  --output "$outputs" --profile "$profile" --account "$account" -- uv run \
  --project agent --locked opentelemetry-instrument \
  python agent/evaluate_case.py run --candidate repaired \
  --case "$s3_case" --bundle "$s3_bundle" --output-root "$outputs/S3/candidate"
```

S3 is a prompt-only edit. In a clean S3 workspace, apply the prepared patch
and compile the prompt:

```sh
git apply agent/prompts/s3-repair.patch
uv run --offline --project agent --locked python -m py_compile agent/prompt.py
```

The explicit `repaired` candidate records the editable prompt digest. The
default `faulty` path validates the checked-in manifest used by S2. The runner
prints a durable run directory after snapshotting the source, case, bundle,
and tooling. Inspect that immutable run while the model works:

```sh
uv run --offline --project agent --locked python agent/evaluate_case.py show \
  --run "$run_dir"
```

Score the fresh execution with the same verified active Opus 5.5 evaluator.
The score is advisory feedback and remains separate from deterministic
findings:

```sh
uv run --project agent --locked python agent/evaluate_case.py score \
  --run "$run_dir" --evaluator "$reviewed_evaluator" --rubric single \
  --wait-seconds 300
```

Run the saved edit directly when the stage wrapper is not being used:

```sh
uv run --project agent --locked opentelemetry-instrument \
  python agent/evaluate_case.py run --candidate repaired \
  --case "$frozen_case" --bundle "$source_bundle" \
  --output-root "$private_runs"
```

After both scores are complete, compare the retained S2 baseline with S3. The
offline comparison does not rerun the agent or call AWS. It verifies the frozen
case, evidence cutoff, model, runtime and tool sources, evaluator and scoring
contracts, then shows both reports, deterministic findings, and the native
verdict and reason:

```sh
uv run --offline --project agent --locked python agent/evaluate_case.py compare \
  --baseline "$s2_run_dir" --candidate "$run_dir"
```

If a run has multiple scoring attempts, pass its exact attempt ID with
`--baseline-attempt` or `--candidate-attempt`. Missing telemetry, a foreign
session or trace, changed reviewed inputs, or mismatched evaluator and scoring
identities remain incomplete. `show` and `compare` inspect existing records and
never start work. Keep edits, cases, bundles, runs, and judge receipts in
private presenter storage. S3 and S4 edits do not change either publisher-owned
serving endpoint.

## Local health and invalid-event smoke

Start the local Runtime entrypoint:

```sh
uv run --project agent --locked python agent/main.py
```

In another terminal, check health and submit an invalid payload:

```sh
curl --fail http://127.0.0.1:8080/ping
curl --silent --show-error -i -X POST http://127.0.0.1:8080/invocations \
  -H 'content-type: application/json' \
  -d '{"smoke":true}'
```

`/ping` returns `{"status":"Healthy"}`. The invocation is rejected because it
is not a trusted `{event, deployment}` CloudWatch delivery. It does not create
a run, read application sources, or perform inference. This checks health and
invalid-input handling only.

## Native ARM64 package smoke

Run the package check on a native Linux ARM64 runner so the wheels match the
Runtime target:

```sh
uv sync --project agent --locked
uv run --project agent --locked python agent/package_runtime.py
uv run --project agent --locked python agent/native_smoke.py \
  .artifacts/agent/runtime.zip .artifacts/agent/alarm-adapter.zip
```

`native_smoke.py` imports both packaged artifacts, starts the Runtime through
the bundled OpenTelemetry launcher, checks `/ping`, and confirms invalid Runtime
and adapter payloads are rejected. It does not claim an alarm run or exercise
model inference.
