# Run the opening denial through native Strands

This example compares the operator action from one real AgentCore denial
decision with a prompt edit. It reads the downloaded `denial-case.json` and the
matching `original-trace.json`, then replays the recorded conversation through
the application agent with no new evidence reads.

The model receives the alarm input plus the public assistant/tool history from
the selected final `chat` span. Signed `reasoningContent` blocks are omitted;
they are private Bedrock reasoning and cannot be replayed under a new system
prompt. The case expectation is attached to `Case.expected_output` for the
evaluator and is never included in the model messages.

## Prepare the two inputs

Create a fixed AgentCore dataset scenario from the completed investigation
trace. Do not enable expected response or expected trajectory when creating the
dataset: the original answer must remain a candidate result, not the answer
key. Before publishing, author both fields: `turns[0].expected_response` is
the prose reference used by the hosted Correctness evaluator, while
`metadata.expected_recommendation` is the structured action checked by this
example.

For an access-denied Inventory incident, the expected structured action is:

```json
{
  "turns": [{
    "input": "Investigate this originating alarm transition. ...",
    "expected_response": "Restore Inventory access by routing the live alias to the healthy version 167 at the same 256 MB."
  }],
  "metadata": {
    "expected_recommendation": {
      "action": "Restore inventory access",
      "target": "inventory",
      "value": "167",
      "unit": "version"
    }
  }
}
```

`167` is an example value; use the healthy version observed in your own
configuration evidence.

Use the healthy published version from the configuration evidence and keep the
canonical decimal string. If the incident has already recovered, use
`{"action":"Other","target":null,"unit":null}`; the agent must put a
non-empty explanation in its returned `value`.

Download the published scenario and use the same source trace ID to fetch the
spans that produced it. The commands below are examples; choose the account,
profile, region and dataset version for the investigation you opened:

```bash
export AWS_PROFILE=reinvent-2026-talk AWS_DEFAULT_REGION=us-east-1 AWS_PAGER=""

aws bedrock-agentcore-control list-datasets \
  --query 'datasets[].[datasetName,datasetId]' --output table
read -r -p 'Published dataset ID: ' DATASET_ID
aws bedrock-agentcore-control list-dataset-versions \
  --dataset-id "$DATASET_ID" --output table
read -r -p 'Published dataset version: ' DATASET_VERSION

aws bedrock-agentcore-control list-dataset-examples \
  --dataset-id "$DATASET_ID" --dataset-version "$DATASET_VERSION" \
  --query 'examples[0]' --output json > denial-case.tmp && \
  mv denial-case.tmp denial-case.json
```

Then run `score_denial.py`. It verifies the authored expected action, scores the
recorded response with AgentCore, and writes the exact spans to
`original-trace.json`:

```bash
set -o pipefail
uv run --project ../../agent --locked python -u score_denial.py | tee evaluation.txt
```

The scenario's `metadata.source.trace_id` and the trace file are bound again by
the native example. A trace containing a different span, a different alarm
input, or a final model call without `InvestigationReport` is incomplete.

## Run the native example

From `examples/live-denial`, the default command reads exactly these files and
writes `strands-result.json`:

```bash
PYTHONPATH="$(cd ../../agent && pwd)" \
  uv run --project ../../agent --locked python -u strands_denial.py
```

Use explicit paths in CI or another working directory:

```bash
PYTHONPATH="$(cd ../../agent && pwd)" \
  uv run --project ../../agent --locked python -u strands_denial.py \
  --scenario "$SCENARIO" \
  --trace "$ORIGINAL_TRACE" \
  --result "$RUN_DIR/strands-result.json"
```

The prepared presenter terminal may instead put the editable agent checkout on
`PYTHONPATH` and invoke `python -u strands_denial.py` directly.

The code intentionally uses the application constructor:

1. `Case` is built from `turns[0].input` and the reviewed
   `metadata.expected_recommendation`.
2. The final decision `chat` span is selected by the trace ID and latest
   `startTimeUnixNano`; its original `InvestigationReport` response proves that
   this is the decision being replayed.
3. `investigation.create_agent` receives the same `MODEL_ID` and a provider
   whose `tools()` returns `[]`. The read phase is already in the trace, so the
   replay cannot make fresh application reads.
4. `Experiment.run_evaluations` makes one report-generation invocation with
   native `Equals`. Its bounded `turns: 2` allowance lets Strands perform its
   normal in-invocation structured-output follow-up when the first model turn
   ends in prose; a completed structured report is not rerun.
5. The separate exact-action check compares action, target, value and unit.

For a reviewed `Other` case, native `Equals` compares the canonical action,
target and unit after a non-empty explanation has been validated; the full
explanation remains in the regular local receipt and the exact-action check.
An empty explanation or another action fails both checks.

The input and result identities are visible in `strands-result.json`:

| Field | Meaning |
| --- | --- |
| `scenarioId` | AgentCore scenario ID used for `Case.name`. |
| `scenarioSha256` | SHA-256 of the exact scenario bytes read by the run. |
| `traceId` | Source trace ID from the scenario metadata. |
| `traceSha256` | SHA-256 of the exact trace bytes read by the run. |
| `sourceSessionId` | AgentCore session that produced the source trace. |
| `sessionId` | Fresh local native-inference session, distinct from `sourceSessionId`. |
| `promptSha256` | Digest of the prompt imported from the editable agent checkout. |
| `nativeEvaluator` | One native `Equals` result row. |
| `exactAction` | Operator-facing action check, independent of `Equals`. |
| `decision` | Selected span time, span count, and omitted signed-block count. |

Exit status is deliberately separate from evaluator labels:

- `0`: completed and the exact action passed.
- `1`: completed, but the exact action failed. This is a red regression, not an
  incomplete run.
- `2`: incomplete input, missing decision, model failure, or missing evaluator
  output. The result contains `{"status":"incomplete"}` and an error.

The normal output shows the scenario and trace digests, imported prompt and
investigation source paths, expected and actual structured actions, native
`Equals`, and exact-action status. `--safe-output` prints only
`Audience gate result: PASS`, `FAIL`, or `INCOMPLETE` and redacts free-form
`Other` explanations in the result receipt.

## Compare the prompt edit

Run the command once with the original memory-first prompt. The opening denial
is expected to complete with the wrong memory action and exit `1`:

```text
Exact action: FAIL
```

Edit only the recommendation rule in the stage's `agent/prompt.py` to:

```text
When Inventory reads are still denied, recommend restoring access. Identify the healthy version at the same memory from the configuration evidence. If access has already recovered, recommend no change.
```

Run the same command against the same scenario and exact trace. The repaired
prompt should return the reviewed version and exit `0`:

```text
Exact action: PASS
```

The two runs use the same case bytes, trace bytes, source session, model and
replayed read history. Only the imported prompt is expected to change. The
public example does not include a scenario, trace, credentials or model output;
downloaded inputs and `strands-result.json` are local run artifacts.
