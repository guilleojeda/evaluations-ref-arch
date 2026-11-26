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
