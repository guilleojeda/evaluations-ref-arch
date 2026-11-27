# Follow the Inventory denial from trace to CI

[Audience slides (PDF, 19 pages)](slides/audience.pdf) | [Stage checkpoints](checkpoints.md) | [Audience questions](questions.md)

A customer tries to place an order. Checkout returns HTTP 502. The operations
agent finds an Inventory `GetItem` denial and recommends increasing memory.
Increasing memory leaves the denied role in place, so the next checkout still
fails. The useful question is not whether the prose sounds plausible; it is
whether the formal recommendation fixes the failure mechanism.

> When the evidence shows an ongoing Inventory read denial, recommend restoring
> access by selecting the healthy Inventory version at the current memory.

## From the native trace to a reviewed case

Open the original investigation trace in AgentCore Observability. The
Inventory `search_logs` result contains `AccessDeniedException`; the matching
Checkout request returns 502. `read_configuration` shows the live alias on
the denied live version at the observed memory and the access-denying role. A
second observed version uses the same memory and the normal role. The trace
therefore supports restoring access to that healthy version, not increasing
memory. Use the exact version values shown in the trace and configuration when
writing the expected response; this guide does not freeze a rehearsal's
version numbers.

Use the trace itself to make the case. Select it, choose **Add to dataset** →
**Create new dataset**, use a fixed scenario, and leave expected response and
expected trajectory disabled while creating the scenario. AWS creates a
**dataset scenario draft**. Open that draft and add the reviewed expectation:

Record the prose response and the exact structured recommendation in that same
draft. For an ongoing denial, use the healthy version observed in
`read_configuration`:

```json
{
  "turns": [{
    "expected_response": "Recommend restoring Inventory access by moving the live alias from the denied version to the healthy version. Both use the observed baseline memory. The healthy version has the role that permits dynamodb:GetItem. Increasing memory alone does not restore access."
  }],
  "metadata": {
    "expected_recommendation": {
      "action": "Restore inventory access",
      "target": "inventory",
      "value": "<healthy-version>",
      "unit": "version"
    }
  }
}
```

If the selected evidence already shows recovery, keep the free explanation in
`turns[0].expected_response` and bind the structured recommendation in the same
published case as `{"action":"Other","target":null,"unit":null}`. Do not
repeat an access restore after the evidence shows recovery.

Save the draft, then choose **Create version**. The published version is the
frozen input for the walkthrough. A draft scenario ID is not a published case;
the download command must use the dataset ID and version number from the
published row.

## Download and score the original report

The public `examples/live-denial` folder contains a short AWS SDK example.
From a repository-root or Codespace terminal, download the one example from
the published version:

```sh
set -euo pipefail
cd examples/live-denial
export AWS_PROFILE="${AWS_PROFILE:?set the authorized AWS profile}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:?set the evaluation Region}"
dataset_id="${DATASET_ID:?copy the full dataset ID from the published Version row}"
dataset_version="${DATASET_VERSION:?copy the published dataset version}"
aws bedrock-agentcore-control list-dataset-examples \
  --dataset-id "$dataset_id" --dataset-version "$dataset_version" \
  --query 'examples[0]' --output json > denial-case.json
uv run --project ../../agent --locked python -u score_denial.py | tee evaluation.txt
```

Open `denial-case.json` beside `score_denial.py`. The file contains the alarm
input, the human-authored expected response, the typed recommendation from the
same published scenario, and source metadata. The script:

- reads `denial-case.json` with `Path(...).read_text()`;
- uses the case's session ID, log group, and recorded start time to fetch the
  original spans from CloudWatch;
- reads `incident.report` from the investigation span; and
- sends those recorded spans and the reviewed fields to
  `Builtin.Correctness`.

It does not invoke the agent again. First compare the exact structured
`recommendation` object with the reviewed action, target, value, and unit. Then
read the separate native evaluator label, value, and explanation. The initial
walkthrough readback returned the native label **Incorrect** and value **0.0**;
that is a completed scored quality failure for the attempt, not missing
evidence.
Its diagnosis is largely
right, but its formal recommendation is **Increase memory - Inventory - 512
MB**. A later judge attempt can return a different label for the same trace;
show the returned explanation and compare the formal recommendation with the
reviewed expectation. The evaluator is not a replacement for the deterministic
action check.

## How the case becomes a development and release test

| Stage | What happens | What stays fixed |
| --- | --- | --- |
| S0 | Observe the alarm, trace, failed read, configuration, and original report. | The original execution and its evidence. |
| S1 | Review the trace and publish the fixed AgentCore dataset version. | The input and both reviewed fields are separate from the agent prompt. |
| S2 | Show the original report's exact structured recommendation check, then the separate `Builtin.Correctness` result. | No agent rerun; both outputs belong to the original trace. |
| S3 | Edit the recommendation rule and run a fresh candidate. | The selected case and captured evidence. |
| S4 | Run the repaired candidate through the native Strands experiment. | The current native case plus four retained reviewed cases, with the same evidence bridge and evaluator. |
| S5 | Run CI against the exact ZIP proposed for release. | The five-case roster and candidate package identity. |

S3 and S4 are development feedback. They do not qualify or publish a Runtime
ZIP. S5 is the release decision: a required deterministic failure rejects the
candidate; complete checks still require source-backed human review of the
exact package. One participant commit contains the prompt edit and private
suite-pointer update. Presenter preparation already appends the current case
to the four retained reviewed cases and uploads the five-case archive
privately. CI downloads and verifies all five cases, then compares the source
run's case/bundle identity with the candidate CI result. A previously qualified serving package remains in place while a new candidate is evaluated; this flow does not guarantee a pass or
publication.

The [synthetic local case](../README.md#run-one-evaluation-locally) remains a
fully offline example. It uses versions 74 and 75, has no AWS dependency, and
is intentionally separate from the live trace and published dataset above.

## The rejected push

The participant changed the prompt and the pointer in one commit. Open those two files in the GitHub diff, then open the qualification job for that commit. Its suite includes the case created from the denial observed in the rehearsal. The reports and original trace stay in private storage. [Participant diff](https://github.com/guilleojeda/evaluations-ref-arch/commit/54873b6bdb6dfbed0bc6372a5ac2b09b7efe5dc7) and [qualification run](https://github.com/guilleojeda/evaluations-ref-arch/actions/runs/45913405212)

In this run, the audience case expected restoration of Inventory access at the original memory setting. The regressed agent recommended increasing memory to 512 MB. Its required action check failed. The overall gate rejected the package and skipped publication. The capacity control also failed and appears first in the aggregate gate message. Open the audience case row to see the denial's result.

To reproduce the deterministic failure without AWS, use the saved report in the
[synthetic case](../README.md#try-a-regression). The live score and the
offline check answer related questions with different evidence boundaries.
