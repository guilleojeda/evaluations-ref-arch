# Turn a checkout failure into an AgentCore evaluation

Start with a completed investigation of this demo's Inventory incident. You will use its **actual trace**, write the answer you would accept, and score the recommendation the operator saw. The case and trace stay in your AWS account until you fetch them.

## Create the case in AWS

1. Open the investigation from the failure controller. Copy its trace ID. Look at the Inventory and Checkout `search_logs` tool results for the same request ID. Which operation failed? Open `read_configuration` to see which Inventory version and role were serving when the agent made its recommendation.
2. In **AgentCore > Observability > Traces**, check the box beside that trace. Choose **Add to dataset > Create new dataset** and select **Fixed**. Leave **Enable expected response** and **Enable expected trajectory** unchecked. This keeps the faulty answer out of the answer key.
3. Choose **Create and add to dataset > View dataset**. Click the scenario under **Dataset scenario drafts**. Match `metadata.source.trace_id` to the trace you showed and read the alarm in `turns[0].input`.
4. In that same turn, add a sibling string field named `expected_response`. If the live alias still points at the denied role, specify restoration to the observed healthy version at the same memory. If the healthy version is already serving successful requests, ask for verification and no further change. The evidence at decision time determines the answer. Save, then choose **Create version**.
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

Open **denial-case.json** in Explorer. Show the trace ID, the alarm input and the expected response you just wrote. This example creates a dataset with one scenario. For a dataset containing several scenarios, select the matching scenario ID.

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

Read **Expected**, **Actual**, then the **AgentCore** label, numeric score and explanation. A completed evaluation can say `Incorrect 0.0` even when the command succeeds. The evaluator just graded an existing report. To test an edited agent, run it on the same alarm with incident-time evidence available to its tools and score its new trace against the same expectation.

See the AWS documentation for [generating cases from traces](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/dataset-generation.html) and [evaluation with ground truth](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/ground-truth-evaluations.html).
