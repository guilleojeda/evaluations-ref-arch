# Turn a checkout failure into an AgentCore evaluation

Start with a completed investigation of this demo's Inventory incident. You will use its **actual trace**, write the answer you would accept, and score the recommendation the operator saw. The case and trace stay in your AWS account until you fetch them.

## Create the case in AWS

1. Open the investigation from the failure controller. Copy its trace ID. Look at the Inventory and Checkout `search_logs` tool results for the same request ID. Which operation failed? Open `read_configuration` to see which Inventory version and role were serving when the agent made its recommendation.
2. In **AgentCore > Observability > Traces**, check the box beside that trace. Choose **Add to dataset > Create new dataset** and select **Fixed**. Leave **Enable expected response** and **Enable expected trajectory** unchecked. This keeps the faulty answer out of the answer key.
3. Choose **Create and add to dataset > View dataset**. Click the scenario under **Dataset scenario drafts**. Match `metadata.source.trace_id` to the trace you showed and read the alarm in `turns[0].input`.
4. Write the answer you would accept in `turns[0].expected_response`. In the existing `metadata` object, add `expected_recommendation` for the code check. Keep the generated `source` and `generation_id` fields. Choose the answer using the state the agent could see at decision time:

   - **Access still denied:** Ask the agent to restore Inventory access at the same memory. In this JSON example, replace `"42"` with the healthy version from your configuration read.

     ```json
     "expected_recommendation": {"action": "Restore inventory access", "target": "inventory", "value": "42", "unit": "version"}
     ```

   - **Already recovered:** Ask for verification with no further configuration change. For this agent the structured action is `Other`; it writes its reasoning in `value`. The code checks the action, null target/unit and presence of an explanation. The judge assesses what that explanation says.

     ```json
     "expected_recommendation": {"action": "Other", "target": null, "unit": null}
     ```

   Click **Save**, then **Create version**. To add the code check to a previously published case, edit its draft and create a new version.
5. Under **Versions**, note the published version number. Copy the **full dataset ID**, including AWS's generated suffix. It is the segment after `/datasets/` in the dataset URL. The dataset name, scenario ID and trace ID are different identifiers.

## Download the published case in Codespaces

In the presenter workspace, right-click **Case and results > live-denial** and select **Open in Integrated Terminal**. In an ordinary repository checkout, open a terminal in `examples/live-denial`. Use an AWS CLI with `bedrock-agentcore-control list-dataset-examples`. The Codespace has its own AWS sign-in. For the talk, select its configured profile in this terminal. For your own deployment, use the profile and region for the account you opened in the AWS console.

```bash
export AWS_PROFILE=reinvent-2026-talk AWS_DEFAULT_REGION=us-east-1 AWS_PAGER=""
```

In the **prepared presenter workspace**, set up the integrated terminal once
before projecting it. Use the locked interpreter from the stage installation
and the editable agent source from S5. A plain terminal in a fresh Codespace
can otherwise resolve `python` to the system interpreter. When this prints the
stage interpreter and the two package versions, leave the terminal open.

```bash
stage=$(jq -er .session ../session.json)
source "$stage/S4/agent/.venv/bin/activate"
export PYTHONPATH="$stage/S5/agent"
python -c 'import sys, boto3; from importlib.metadata import version; print(sys.executable, version("boto3"), version("strands-agents-evals"))'
```

In an ordinary repository checkout, use the `uv run --project ../../agent --locked`
commands below. In either workflow, download the published example:

```bash
aws sts get-caller-identity --query Account --output text
aws bedrock-agentcore-control list-datasets --query 'datasets[].[datasetName,datasetId]' --output table
read -r -p 'Paste the full dataset ID: ' DATASET_ID
aws bedrock-agentcore-control list-dataset-versions --dataset-id "$DATASET_ID" --output table
read -r -p 'Published version number: ' DATASET_VERSION
aws bedrock-agentcore-control list-dataset-examples \
  --dataset-id "$DATASET_ID" --dataset-version "$DATASET_VERSION" \
  --query 'examples[0]' --output json > denial-case.tmp && mv denial-case.tmp denial-case.json
```

Open **denial-case.json** in Explorer. Show the trace ID, the alarm input and the two expectation fields you just wrote. This example creates a dataset with one scenario. If your dataset has several scenarios, list their IDs and select the row from the trace you showed.

```bash
aws bedrock-agentcore-control list-dataset-examples \
  --dataset-id "$DATASET_ID" --dataset-version "$DATASET_VERSION" \
  --query 'examples[].[scenario_id,metadata.source.trace_id]' --output table
read -r -p 'Paste the matching scenario ID: ' SCENARIO_ID
aws bedrock-agentcore-control list-dataset-examples \
  --dataset-id "$DATASET_ID" --dataset-version "$DATASET_VERSION" \
  --query "examples[?scenario_id=='$SCENARIO_ID'] | [0]" --output json > denial-case.tmp && \
  python -c 'import json; assert json.load(open("denial-case.tmp")) is not None, "No matching scenario"' && \
  mv denial-case.tmp denial-case.json
```

If there is no published version, you can inspect the draft first. Return to the console to review the expectation and create the version you want to score.

```bash
aws bedrock-agentcore-control list-dataset-examples \
  --dataset-id "$DATASET_ID" --dataset-version DRAFT --query 'examples[0]' --output json
```

## Score the recorded recommendation

Open [score_denial.py](score_denial.py) in the editor. `fetch_spans_from_cloudwatch` reads the original session's telemetry. The code selects the trace named in the case, saves its spans to `original-trace.json`, and prints the recommendation stored in the investigation span. `evaluate` sends those spans and your expected response to AgentCore's `Builtin.Correctness` evaluator.

In the presenter terminal, run:

```bash
set -o pipefail
python -u score_denial.py | tee evaluation.txt
```

From the `examples/live-denial` directory in a regular checkout, use the locked Python dependencies instead:

```bash
set -o pipefail
uv run --project ../../agent --locked python -u score_denial.py | tee evaluation.txt
```

Read **Expected action**, **Actual**, and **Exact action**. Then show the separate **AgentCore** label, score and explanation. An agent can diagnose IAM correctly in its prose and still tell an operator to increase memory. The exact field comparison catches that wrong action even if the judge credits the diagnosis. Both checks grade the existing report. `FAIL` or `Incorrect 0.0` is a completed check; a missing action reference prints `INCOMPLETE` and exits with status 2 after the native score.

## Bind the case to the captured evidence before native Strands

The downloaded scenario and original trace are native AgentCore inputs, while the
Strands agent needs the matching reviewed-case task and captured read-only
evidence. Run the bridge now, before the native experiment:

In the presenter terminal, where the current directory is
`Case and results/live-denial`, use `--output .`:

```bash
python native_case_bridge.py build \
  --scenario denial-case.json --trace original-trace.json --output .
```

In a normal repository checkout, from `examples/live-denial`, use `--output
bridge`:

```bash
uv run --project ../../agent --locked python ../../scripts/native_case_bridge.py build \
  --scenario denial-case.json --trace original-trace.json --output bridge
```

The presenter command creates `case.frozen.json`, `captured-bundle.json`,
`candidate-input.json`, and `bridge-manifest.json` in this folder. The checkout
command creates those same files under `bridge/`; the native command below uses
`bridge/case.frozen.json` and `bridge/captured-bundle.json` explicitly. The
bridge fails closed when the scenario trace, original trace, case digest, or
captured-bundle identity does not match; it never substitutes current AWS
state.

Require the bridge command to print `"status": "ready"` before opening the
generated files or starting Strands.

Read these three files together before continuing:

1. `denial-case.json` shows the hosted source trace, alarm input, and authored
   `metadata.expected_recommendation`.
2. `case.frozen.json` shows the authenticated reviewed task and the typed
   expectation reserved for evaluators.
3. `candidate-input.json` shows the exact alarm task and cutoff that the model
   receives; it contains no expected answer or private review fields.

For the presenter output use `bridge_dir=.`; for the repository output use
`bridge_dir=bridge`. This read-only check confirms the generated bytes and
identities still point to the hosted source trace:

```bash
bridge_dir=.
# In a normal repository checkout, use: bridge_dir=bridge
test -s "$bridge_dir/case.frozen.json" && test -s "$bridge_dir/captured-bundle.json" && test -s "$bridge_dir/bridge-manifest.json"
python - "$bridge_dir" <<'PY'
import hashlib, json, sys
from pathlib import Path
root = Path(sys.argv[1])
scenario = json.loads(Path("denial-case.json").read_text())
manifest = json.loads((root / "bridge-manifest.json").read_text())
frozen = json.loads((root / "case.frozen.json").read_text())
assert manifest["traceId"] == scenario["metadata"]["source"]["trace_id"]
assert manifest["caseSha256"] == frozen["caseSha256"]
assert manifest["bundleSha256"] == frozen["case"]["evidence"]["bundleSha256"]
assert manifest["bundleSha256"] == hashlib.sha256((root / "captured-bundle.json").read_bytes()).hexdigest()
print("Bridge identity verified:", manifest["traceId"], manifest["caseSha256"], manifest["bundleSha256"])
PY
```

The native loader verifies the case and bundle bytes again and returns status 2
for missing, malformed, or mismatched files. The opening hosted denial supplies
this walkthrough's reviewed case. A later new denial verifies hosted behavior
only; it does not automatically become an S5/CI case, which uses only the
explicitly selected private frozen-case and bundle archive.

The later S3/S4 commands and the full qualification workflow are documented
in [Development and CI commands](https://github.com/guilleojeda/evaluations-ref-arch/blob/main/docs/adapt-evaluations.md).

## Run the same case through native Strands

The public [strands_denial.py](strands_denial.py) is the small audience-facing native experiment. It creates one `Case`, one exact-action `Evaluator`, one `Experiment`, and calls `Experiment.run_evaluations` with an authentic live Strands agent. The agent receives only the frozen task and reads the matching captured evidence bundle through the four read-only tools. The expected action is attached to the native case for the evaluator; it is never put in the task sent to the model.

`Case.name` is always the canonical frozen case ID. When `denial-case.json` is
present, its authored `metadata.expected_recommendation` is checked against
the frozen recommendation before it becomes local `case.expected_output`;
`Other` must have null target/unit and no hidden value. In frozen-only CI mode,
the reviewed frozen recommendation is the canonical source and no native ID or
source session is invented.

This is deliberately one terminal and one working directory. The workbench
already exports `PATH` and `PYTHONPATH` for its selected stage, so the prepared
presenter terminal runs the public file directly:

```bash
# Presenter terminal, from Case and results/live-denial.
python -u strands_denial.py
```

If the presenter terminal needs the stage path restored, derive it from the
workbench session record rather than hard-coding a machine path:

```bash
stage="$(python3 -c 'import json; print(json.load(open("../session.json"))["session"])')"
source "$stage/S4/agent/.venv/bin/activate"
export PYTHONPATH="$PWD:$stage/S5/agent"
python -u strands_denial.py
```

For a normal git clone, use the repository's locked interpreter and agent
modules explicitly:

```bash
# Repository terminal, from examples/live-denial.
PYTHONPATH="$(cd ../../agent && pwd)" uv run --project ../../agent --locked python -u strands_denial.py \
  --scenario denial-case.json \
  --case bridge/case.frozen.json \
  --bundle bridge/captured-bundle.json
```

The command reads these files from the current directory:

| File | Role |
| --- | --- |
| `denial-case.json` | Native AgentCore scenario: native scenario ID, source trace/session and reviewed typed expectation. |
| `case.frozen.json` | Authenticated reviewed-case envelope used to derive the candidate task and exact evidence identity. |
| `captured-bundle.json` | The four bounded read-only evidence sources at the frozen cutoff. |
| `strands_denial.py` | This public native `Case`/`Evaluator`/`Experiment` example. |
| `strands_denial_io.py` | Small companion for frozen-input validation, CLI status handling, and receipts; keep it beside the main file. |

The selected stage or repository agent supplies `prompt.py`, `investigation.py`, `captured_evidence.py`, and `reviewed_cases.py`. The program prints the resolved prompt and investigation source paths, the prompt digest, the native scenario ID, the frozen case ID, the source trace ID and the bundle digest. This makes the source and the public file visible on the same screen. The currently rehearsed short prompt has digest `fe5efb01c858278dc2b893d136485d0c9be22ed5f1d1af1e29bea7b5ac8396c2`; the original memory-first prompt has digest `161aa4357b908cffe9691349d01da284411cd5d4689235717525d79e1073fffc`.

The stage environment may use a different Strands package patch than an S4 archive. That does not change the inputs: both paths must use the same frozen case, the same bundle SHA-256, the same case cutoff and the same expected recommendation. The printed package versions and identity fields are part of the run readback. Only the bounded model inference is live; the evidence tools do not mutate AWS.

Run the same command after editing the single rule in the actual stage
`agent/prompt.py` from the original memory-first text to this exact repair:

```text
When Inventory reads are still denied, recommend restoring access. Identify the healthy version at the same memory from the configuration evidence. If access has already recovered, recommend no change.
```

A completed wrong action returns status 1 and prints `Exact action: FAIL`; the repaired action returns status 0 and prints `Exact action: PASS`. Missing, invalid or incomplete input, model failure, missing native evaluator output or an identity mismatch returns status 2 and prints `INCOMPLETE`. A small `strands-result.json` readback is written beside the command and is ignored by Git. It contains only run identities, prompt digest, expected/actual structured action, exact verdict and the native evaluator row.

For a private one-case gate with a native scenario, keep this same command and
code path but pass the downloaded files explicitly:

```bash
python -u strands_denial.py \
  --scenario "$NATIVE_SCENARIO" \
  --case "$FROZEN_CASE" \
  --bundle "$CAPTURED_BUNDLE" \
  --result "$RUN_DIR/strands-result.json"
```

For an archive that intentionally carries only the frozen case and bundle, opt
into that boundary explicitly:

```bash
python -u strands_denial.py --frozen-only \
  --case "$FROZEN_CASE" --bundle "$CAPTURED_BUNDLE" \
  --result "$RUN_DIR/strands-result.json"
```

Without `--frozen-only`, a missing or misspelled `denial-case.json` is
incomplete and returns status 2. In either mode the native `Case.name` is the
canonical frozen case ID; a native scenario ID and source session are optional
provenance fields, never invented identifiers. The fresh session ID printed by
the run belongs to the new model execution and is distinct from the source
trace/session. A full S5 suite still requires the normal qualification runner;
this one-case command is an early, inspectable regression witness.

See the AWS documentation for [generating cases from traces](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/dataset-generation.html) and [evaluation with ground truth](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/ground-truth-evaluations.html).
