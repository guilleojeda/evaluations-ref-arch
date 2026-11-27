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
