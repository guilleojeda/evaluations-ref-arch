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

## Run the same case through native Strands

The public [strands_denial.py](strands_denial.py) is the small audience-facing native experiment. It creates one `Case`, one exact-action `Evaluator`, one `Experiment`, and calls `Experiment.run_evaluations` with an authentic live Strands agent. The agent receives only the frozen task and reads the matching captured evidence bundle through the four read-only tools. The expected action is attached to the native case for the evaluator; it is never put in the task sent to the model.

`Case.name` is always the canonical frozen case ID. When `denial-case.json` is
present, its authored `metadata.expected_recommendation` is checked against
the frozen recommendation before it becomes local `case.expected_output`;
`Other` must have null target/unit and no hidden value. In frozen-only CI mode,
the reviewed frozen recommendation is the canonical source and no native ID or
source session is invented.

This is deliberately one terminal and one working directory. The editable prompt and runtime modules come from the stage workspace you choose; the public experiment file is the only example code copied into this folder. There is no prompt copy in this directory.

```bash
# Run these from examples/live-denial.
export S5_AGENT=/absolute/path/to/S5/agent
export PATH="$S5_AGENT/.venv/bin:$PATH"
export PYTHONPATH="$PWD:$S5_AGENT"
python -u strands_denial.py
```

The command reads these files from the current directory:

| File | Role |
| --- | --- |
| `denial-case.json` | Native AgentCore scenario: native scenario ID, source trace/session and reviewed typed expectation. |
| `case.frozen.json` | Authenticated reviewed-case envelope used to derive the candidate task and exact evidence identity. |
| `captured-bundle.json` | The four bounded read-only evidence sources at the frozen cutoff. |
| `strands_denial.py` | This public native `Case`/`Evaluator`/`Experiment` example. |
| `strands_denial_io.py` | Small companion for frozen-input validation, CLI status handling, and receipts; keep it beside the main file. |

`S5_AGENT` supplies `prompt.py`, `investigation.py`, `captured_evidence.py`, and `reviewed_cases.py`. The program prints the resolved prompt and investigation source paths, the prompt digest, the native scenario ID, the frozen case ID, the source trace ID and the bundle digest. This makes the stage source and the public file visible on the same screen. The currently rehearsed short prompt has digest `fe5efb01c858278dc2b893d136485d0c9be22ed5f1d1af1e29bea7b5ac8396c2`; the original memory-first prompt has digest `161aa4357b908cffe9691349d01da284411cd5d4689235717525d79e1073fffc`.

The stage environment may use a different Strands package patch than an S4 archive. That does not change the inputs: both paths must use the same frozen case, the same bundle SHA-256, the same case cutoff and the same expected recommendation. The printed package versions and identity fields are part of the run readback. Only the bounded model inference is live; the evidence tools do not mutate AWS.

Run the same command after editing the single rule in the actual stage `agent/prompt.py` from the original memory-first text to the short repair. A completed wrong action returns status 1 and prints `Exact action: FAIL`; the repaired action returns status 0 and prints `Exact action: PASS`. Missing, invalid or incomplete input, model failure, missing native evaluator output or an identity mismatch returns status 2 and prints `INCOMPLETE`. A small `strands-result.json` readback is written beside the command and is ignored by Git. It contains only run identities, prompt digest, expected/actual structured action, exact verdict and the native evaluator row.

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

## Give the edited agent the incident it must investigate

Stay in the **live-denial** terminal. The dataset contains the original alarm and your answer. A new execution also needs data for its tools to read. Open the bridge script to see how it matches the trace to the originating investigation and reads that investigation's saved logs, metrics, configuration and change history.

In the presenter workspace, run:

```bash
python native_case_bridge.py build \
  --scenario denial-case.json --trace original-trace.json --output .
```

In a repository checkout, from `examples/live-denial`, run:

```bash
uv run --project ../../agent --locked python ../../scripts/native_case_bridge.py build \
  --scenario denial-case.json --trace original-trace.json --output bridge
```

Look for `"status": "ready"` and match `traceId` in `bridge-manifest.json` to the trace ID in `denial-case.json`. Open `candidate-input.json` to show the alarm and cutoff the edited agent receives. Its tools will read `captured-bundle.json`. Open `case.frozen.json` to show the expected response and action that only the evaluators receive. S3 creates a new trace. S4 and CI run this case alongside the previously reviewed cases. [Development and CI commands](https://github.com/guilleojeda/evaluations-ref-arch/blob/main/docs/adapt-evaluations.md)

See the AWS documentation for [generating cases from traces](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/dataset-generation.html) and [evaluation with ground truth](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/ground-truth-evaluations.html).
