# Adapt the evaluation to your agent

Start with a behavior you care about and an example that distinguishes a
correct response from a plausible mistake. In this case, Inventory needs read
access. A report can name the right function and still recommend more memory.

## Run the offline Strands example

From the repository root, score the saved report that recommends restoring
access. Git and the pinned version of uv are the only prerequisites. The first
run installs dependencies; no AWS account or model call is needed.

```sh
uv run --project agent --locked python examples/inventory-denial/native.py
```

Expect six passing report checks and `Native result: PASS` (exit 0). Then score
the synthetic memory-first response against the same case.

```sh
uv run --project agent --locked python examples/inventory-denial/native.py \
  --report examples/inventory-denial/report-memory-regression.json
```

The second command exits 1. The `target` row passes; `action` and
`target_value` fail because extra memory cannot restore the denied permission.
Both runs mark execution-dependent checks incomplete because a saved report
has no tool-call trace.

The offline case is intentionally independent from the live talk case. Its
Inventory versions are 74 and 75, and its evidence is checked from files in
this repository.

## Score the published live case

The talk's live case follows a different boundary. A trace is first turned into
an AgentCore dataset scenario draft. Reviewers add `turns[0].expected_response`
and the typed `metadata.expected_recommendation` to that same draft, save it,
and create a version. Only the published version is downloaded into the
Codespace. A draft scenario ID alone is not a frozen input. For an ongoing
denial the typed recommendation is `Restore inventory access` for `inventory`,
the healthy version, and `version`; for recovered evidence it is `Other` with
null target and unit plus a separate free explanation. The exact healthy
version comes from the selected trace/configuration, not from this public text.

Use the maintained [live-denial Codespace command](../examples/live-denial/README.md#download-the-published-case-in-codespaces)
from the `examples/live-denial` directory. It copies the full published
dataset ID and version, selects `examples[0]`, and runs the locked `uv` scorer.

`score_denial.py` reads the downloaded case, fetches the original trace using
the case's session/log-group/start-time fields, writes `original-trace.json`,
extracts the original `incident.report`, and calls `Builtin.Correctness` with
the recorded spans and reviewed fields from the same published scenario. It does not call the
investigating agent again.
The initial walkthrough readback was **Incorrect, 0.0** because its formal
action is `Increase memory` even though its summary explains that restoring
access is the evidence-supported fix. A later native attempt can return a
different label for the same trace, so retain the returned explanation and
keep deterministic action checks separate.

## Bridge the live case into S3/S4

The live scorer and the normal captured-evidence runner have different input
shapes. Use the repository's [native case bridge](../scripts/native_case_bridge.py)
to bind the downloaded native scenario and the `original-trace.json` written by
the scorer. The bridge derives the structured expectation from the published
`metadata.expected_recommendation`; it can read the originating RunTable row
and the two captured source objects itself, verifies the trace/session/run
joins, and never turns native `expected_response` prose into hidden
expectations. No hand-written review file or typed restore-version argument is
needed on the normal route.

```sh
set -euo pipefail
cd ../..
export AWS_PROFILE="${AWS_PROFILE:?set the authorized AWS profile}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:?set the evaluation Region}"
bridge_root="$(mktemp -d "${TMPDIR:-/tmp}/native-case-bridge.XXXXXX")"
uv run --project agent --locked python scripts/native_case_bridge.py build \
  --scenario examples/live-denial/denial-case.json \
  --trace examples/live-denial/original-trace.json \
  --profile "$AWS_PROFILE" --region "$AWS_DEFAULT_REGION" \
  --output "$bridge_root"
```

The build reads the original RunTable row by the trace's alarm/transition and
downloads the bounded baseline/query captures from S3. It writes:

| Bridge output | Normal runner input |
| --- | --- |
| `case.frozen.json` | S3 `--case` |
| `captured-bundle.json` | S3 `--bundle` |
| `suite.json` | S4 `--suite` |
| `candidate-input.json` | Public agent task projection |

The normal S3 task uses `case.frozen.json` plus `captured-bundle.json`; the S4
experiment uses `suite.json`. The bridge carries the published prose verbatim
as evaluator-only diagnosis and the typed recommendation separately; neither
is copied into the candidate task. S3 uses the current native denial case and
its same-incident task projection. S4 and CI use that case alongside the four
retained reviewed gate cases, five cases total, each with its bounded evidence.
The native scenario and its original trace remain the reference execution; a
standalone synthetic case remains a known reference example, not a new trace.

### Run the edited agent

Use the [outside-Runtime telemetry setup](../agent/README.md) for the candidate checkout. From its repository root, the native execution command takes both private files you just built:

```bash
uv run --project agent --locked opentelemetry-instrument python agent/evaluate_case.py run \
  --candidate repaired --case "$bridge_root/case.frozen.json" \
  --bundle "$bridge_root/captured-bundle.json" --output-root "$bridge_root/executions"
```

Open the new execution's `execution.json`. Compare its structured recommendation to the one in `original-score.json`. A different trace ID is expected because the edited agent has just run.

### Put that case in the participant's CI run

In the presenter kit, preparation loads the existing private four-case suite from its qualified commit, appends the live case and uploads the new archive. The equivalent repository commands below show what gets added. They require read access to the previously qualified private suite. Run them in the checkout that contains the walkthrough tools.

```bash
read -r -p 'Previously qualified demo-deploy commit: ' QUALIFIED_COMMIT
git show "$QUALIFIED_COMMIT:agent/qualification-input.json" > "$bridge_root/previous-pointer.json"
bucket=$(jq -r .bucket "$bridge_root/previous-pointer.json")
key=$(jq -r .s3Key "$bridge_root/previous-pointer.json")
aws s3api get-object --bucket "$bucket" --key "$key" "$bridge_root/previous-suite.tar.gz" >/dev/null
python3 scripts/prepare_live_gate.py prepare \
  --qualification-input "$bridge_root/previous-pointer.json" --base-archive "$bridge_root/previous-suite.tar.gz" \
  --bridge-manifest "$bridge_root/bridge-manifest.json" --case "$bridge_root/case.frozen.json" \
  --bundle "$bridge_root/captured-bundle.json" --output-dir "$bridge_root/gate"
```

The output identifies the five cases and their archive. To see the exact private S3 upload the presenter wrapper performs, print it and inspect the bucket, content-addressed key and checksum:

```bash
python3 scripts/prepare_live_gate.py publish-command \
  --archive "$bridge_root/gate/staging.tar.gz" --pointer "$bridge_root/gate/qualification-input.json" \
  --profile "$AWS_PROFILE" --region "$AWS_DEFAULT_REGION" | jq -r .publishCommand
```

The carried suite entry is not replaced; the prepared suite appends one row. Inspect the old and new entries from the private archives, then inspect the exact frozen case and captured bundle selected by the private map:

```bash
old_suite_entry=$(tar -xOf "$bridge_root/previous-suite.tar.gz" staging/suite.json | jq -c '.cases[-1]')
new_suite_entry=$(tar -xOf "$bridge_root/gate/staging.tar.gz" staging/suite.json | jq -c '.cases[-1]')
live_case_member=$(tar -xOf "$bridge_root/gate/staging.tar.gz" staging/live-case-map.json | jq -er .members.case)
live_bundle_member=$(tar -xOf "$bridge_root/gate/staging.tar.gz" staging/live-case-map.json | jq -er .members.bundle)
printf 'old suite entry: %s\nnew suite entry: %s\n' "$old_suite_entry" "$new_suite_entry"
tar -xOf "$bridge_root/gate/staging.tar.gz" "staging/$live_case_member" > "$bridge_root/audience-case.frozen.json"
tar -xOf "$bridge_root/gate/staging.tar.gz" "staging/$live_bundle_member" > "$bridge_root/audience-bundle.json"
jq '{caseSha256, case: {caseId, task, evidence: {bundleSha256, traceRef}}}' \
  "$bridge_root/audience-case.frozen.json"
sha256sum "$bridge_root/audience-bundle.json"
```

The frozen case and bundle above are the audience trace's existing reviewed
inputs, not a synthetic replacement. They stay in private S3; the committed
`agent/qualification-input.json` contains only the content-addressed archive
pointer, archive/suite/evaluator digests, and case IDs. Do not commit the case,
bundle, map, trace, expectation, or report.

The pointer is also the roster binding: an unaugmented carried archive must
name exactly the four retained baseline cases; the prepared audience archive
must name those four in the same order plus the mapped audience case as the
fifth row. The fast helper rejects a pointer/manifest order or count mismatch.
It also binds the pointer's suite digest and suite case order before selecting
the mapped row, so a manifest-only handoff cannot green the early check.

### The fast audience row and the full package gate

On `demo-deploy`, `.github/workflows/deploy.yml` starts the **Gate audience case
(fast exact action)** job after routing, in parallel with the standard ARM64
checks. It reads only the committed pointer, downloads and hashes the private
archive, selects the map's `members` and `ci` rows, and runs this same public native
program:

```bash
PYTHONPATH=agent:examples/live-denial \
  uv run --offline --project agent --locked \
  opentelemetry-instrument python examples/live-denial/strands_denial.py \
  --frozen-only --safe-output \
  --case "$GATE_ROOT/inputs/case.frozen.json" \
  --bundle "$GATE_ROOT/inputs/captured-bundle.json" \
  --result "$GATE_ROOT/audience-row.json"
```

The command's `RecommendedAction` row uses
`score_denial.exact_action_matches`: it checks action, target, value and unit,
including a non-empty explanation for `Other`. A completed wrong action exits
1 and prints `Exact action: FAIL`; incomplete inputs, execution, or evaluator
output exit 2. The workflow preserves that status with `exit "$status"`, so a
red audience row blocks both the initial candidate deploy and
`evaluate-agent`; the later exact-ZIP five-case qualification and protected
review remain required for a successful candidate. The job summary shows the
mapped case ID, case/bundle digests, prompt digest, and evaluator row even if
another case in the later suite is red.

The existing `evaluate-agent` job then runs the checked Runtime ZIP through
`scripts/qualify-repaired.py` on the full suite. Its nonzero status is carried
to `publish-repaired`, whose `needs.evaluate-agent.result == 'success'` guard
is the publication boundary. A fast audience failure is visible first, and a
later package failure still blocks publication after the audience row passes.

CI redirects the native runner's verbose trace/report output to a private
runner log and passes `--safe-output`. Its receipt keeps only the opaque case
binding, hashes, verdict, action fields, numeric/canonical version values, and
`<explanation redacted>` for `Other`; trace IDs, sessions, evaluator prose and
free-form explanations never enter public logs or the summary. The summary
step emits the same one-line `AUDIENCE_GATE_ROW` in the Actions log and job
summary, bound to `GITHUB_SHA` and `GITHUB_RUN_ATTEMPT` with its 0/1/2 exit
code. The local presenter command remains verbose because it runs on the
presenter-owned screen.

An authentic carried suite from before the audience case has no live-case map;
the helper proves that no session-derived row is present and labels the
retained denial check `baseline-denial`. If a manifest does contain a
session-derived row but the map is missing, preparation fails closed instead of
silently selecting another case.

This is the precise common invariant between the local walkthrough and CI: the
same `strands_denial.py`, same frozen case task, same captured-bundle bytes,
same reviewed expectation projection, and same `exact_action_matches` function.
Local and CI intentionally differ in source checkout and output directory; the
fast gate is one audience exact-action row, while full qualification is a
package-bound five-case experiment with advisory scoring. It is therefore not
accurate to call the fast row the whole package test.

To pair the CI gate with a local previous-prompt failure, use the same extracted
case and bundle with a disposable copy of the historical prompt:

```bash
previous_root=$(mktemp -d "${TMPDIR:-/tmp}/previous-prompt.XXXXXX")
cp -a agent "$previous_root/agent"
cp tests/fixtures/phase20_faulty_prompt.py "$previous_root/agent/prompt.py"
PYTHONPATH="$previous_root/agent:examples/live-denial" \
  uv run --offline --project agent --locked \
  opentelemetry-instrument python examples/live-denial/strands_denial.py \
  --frozen-only \
  --case "$bridge_root/audience-case.frozen.json" \
  --bundle "$bridge_root/audience-bundle.json" \
  --result "$previous_root/audience-row.json"
```

That historical prompt is expected to return exit 1 and `Exact action: FAIL`
for the same audience case. CI does not trust this local result: it downloads
the private archive itself and reruns the checked-out prompt before any package
qualification or publication. [Suite preparation and verification](../scripts/prepare_live_gate.py)

## Where your agent fits

The offline example creates one native Strands `Case` with the public task as
input. Its task returns a saved report, and `InventoryReportEvaluator` uses the
reviewed expectations to grade it. `Experiment.run_evaluations(task)` returns
the findings. [Native example](../examples/inventory-denial/native.py) and
[reviewed case](../examples/inventory-denial/case.json)

To run your agent on the same task, replace the saved-report task with your
invocation. Supply the same [evidence](../examples/inventory-denial/evidence.json)
through your read tools and return the agent's real report. Give only the
evaluator the expected answer:

```python
def task(case):
    return {"output": investigate(case.input)}
```

For a different task, decide what the agent gets to see and how you will judge
the result.

| Decision | Inventory example | What to change |
| --- | --- | --- |
| What does the agent know? | Alarm, symptoms, allowed resources and evidence available by the cutoff | Supply a task and source snapshot from your workflow. |
| What can the agent do? | Read operational data and recommend a remedy | Connect its real tools and define the report or action arguments. |
| What can code decide? | Whether action, target and value form an allowed remedy | Write checks with an unambiguous pass condition. |
| What requires judgment? | Whether the diagnosis and factual claims are supported | Choose a rubric, review examples, and check the judge on held-back cases. |
| What should block shipping? | A required failure rejects the package; advisory results go to review | Choose blocking checks and review requirements for the consequences of errors. |

## Keep S3, S4, and CI identities aligned

The normal development path uses the current native denial case and its
same-incident captured evidence for the fresh S3 candidate. S4 adds that case
to the four retained reviewed cases, five cases total. The bridge between the
case and evaluator is part of the run identity; it does not copy a private
trace into the agent prompt. S3 and S4 create fresh executions and traces, so
their results are development feedback rather than a score for the original
trace.

CI repeats the selected cases against the exact Runtime ZIP proposed for
release. Its qualification row is not the same thing as a later live
investigation row. Keep candidate/package identity, case identity, evaluator
identity, and live alarm/run identity visible when comparing results.

Required deterministic findings reject the ZIP. Complete advisory scoring then
goes to source-backed human review of that exact package. A previously
qualified serving package remains available while a new ZIP is evaluated.

See the [attendee guide](attendee-guide.md), [evaluation approach](evaluations.md),
and [stage map](../TALK-STAGE.md) for the public flow.
