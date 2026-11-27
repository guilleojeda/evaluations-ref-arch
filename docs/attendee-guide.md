# Follow the Inventory denial from trace to CI

[Audience slides (PDF, 16 projected pages)](slides/audience.pdf) | [Stage checkpoints](checkpoints.md) | [Audience questions](questions.md)

A customer tries to place an order. Checkout returns HTTP 502. The operations
agent finds an Inventory `GetItem` denial and recommends increasing memory.
Increasing memory leaves the denied role in place, so the next checkout still
fails. The useful question is not whether the prose sounds plausible; it is
whether the formal recommendation fixes the failure mechanism.

> When the evidence shows an ongoing Inventory read denial, recommend restoring
> access by selecting the healthy Inventory version at the current memory.

## The opening sequence

The presenter loads the signed-in storefront and waits for the catalog/product
view before triggering the denial. This teaches the normal customer path: a
shopper is ready to place a quantity-one order, but the checkout is not clicked
yet.

After the fresh denial, the presenter waits for the investigation to finish.
The report is read before any configuration action. The recorded opening trace
and earlier local/CI runs showed **target `INVENTORY`**, **value `512 MB`**, and
**Increase memory**; a later fresh named Codespace run with the unchanged prompt
returned the reviewed version and **PASS**. A partial or incomplete report
stays pending. Only after a readable completed report does the presenter decide
whether a staged memory action is supported by the current evidence, then read
the actual configuration and checkout result. The resulting 502/request ID or
pending state is application evidence separate from the report and readback.

## The current IDE-to-CI route

After the fixed-case score and calibration, the presenter uses one clean S5
workspace. The audience sees `denial-case.json` with
`Case.input = denial-case.json.turns[0].input` (the original alarm), its
matching final chat input in `original-trace.json`, the presenter-authored
expected output, separately built `messages = alarm + history`, same read-only
history, and native `Equals`; the old answer, system prompt, and
signed-thinking/reasoning are excluded from the new task. Run the original
prompt and read the actual result. The recorded opening trace and earlier
local/CI runs showed the 512 MB recommendation and exact-action FAIL, while a
later fresh named Codespace run with the unchanged prompt returned the reviewed
version and PASS. Do not promise the direction of a fresh model run. The
presenter then
says:

> Earlier, we evaluated an already generated output. Now we're using fixed inputs, and letting the agent generate the output again

Only the active recommendation rule changes, using this exact text; the same
command runs again for a fresh recommendation:

```text
When Inventory reads are still denied, recommend restoring access. Identify the healthy version at the same memory from the configuration evidence. If access has already recovered, recommend no change.
```

The repaired prompt is then exercised once on the pre-qualified endpoint with
a dedicated full investigation for a new denial. Match its event/run/trace and
show the real recommendation as behavior evidence only. Register the
presenter-authored original scored case and matching case/trace identity once
in the private suite. The original prompt is restored, the same local case is
run and its actual result is recorded, the careless-dev line is spoken, and an
ordinary push starts the required `audience-case-gate`. The gate may pass, fail,
or remain pending; read its current Expected/Actual row and downstream state.
If it passes or remains pending, show the earlier verified CI rejection as
earlier evidence, not as the current run. A failure/incomplete fast result
blocks/skips downstream qualification and publication; return to the actual
state after slides 35 and 36, then 37.

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
draft. The presenter authors both fields; the audience watches. For an ongoing denial, use the healthy version observed in
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
fixed input for the walkthrough. A draft scenario ID is not a published case;
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

The authored physical 16 slide contrasts the typed expected action with the
separate native judge; do not project a same-report pair. A captured trace can
vary when rejudged, so read the returned label and explanation. To check a
judge, first have people label representative reports and explain their
reasons. Use one set to investigate disagreements and refine a custom rubric.
Check the frozen judge on other incidents kept out of tuning. If those results
lead to another change, use a fresh holdout. [Calibration and holdouts](evaluations.md#calibration-holdouts-and-repeated-runs)

## How the case becomes a development and release test

| Stage | What happens | What stays fixed |
| --- | --- | --- |
| S0 | Observe the alarm, trace, failed read, configuration, and original report. | The original execution and its evidence. |
| S1 | Review the trace and publish the fixed AgentCore dataset version. | The input and both reviewed fields are separate from the agent prompt. |
| S2 | Show the original report's exact structured recommendation check, then the separate `Builtin.Correctness` result. | No agent rerun; both outputs belong to the original trace. |
| IDE repair | Read `denial-case.json` directly into native Strands, show the matching final chat input from `original-trace.json`, exclude old answer/system/signed-thinking fields, show native `Equals`, run the original prompt and read the actual result, edit the exact rule, and run the same command. | Presenter-authored expectation/history; fresh session and prompt digest. |
| Live repaired endpoint | Use the identical repaired prompt for one dedicated full investigation for a new denial. | A real new event/run/trace, not a prepared result. |
| Fast release check | Register the original scored case with matching case/trace identity, restore the faulty prompt, record the local result, and make the ordinary push. | The hosted denial is behavior evidence only; `audience-case-gate` uses the same saved Case/trace in parallel. Read the current pass/fail/pending state; failure/incomplete blocks/skips `evaluate-agent` and publication. |

Follow the prompt edit into the real call: `create_agent` imports
`SYSTEM_PROMPT` from `agent/prompt.py` and passes it to `Agent(system_prompt=...)`.
The next Python invocation starts one fresh agent run for the prompt, uses the
same reviewed history/read-only tools, and returns one structured report for
native `Equals`. Its normal bounded formatting follow-up may occur inside that
run; a missing report is **INCOMPLETE**, not a quality **FAIL**. [Agent construction](../agent/investigation.py)

The IDE run is development feedback, not package qualification. After the
fresh pass, the identical repaired prompt handles one new denial on the
pre-qualified endpoint. That hosted denial is behavior evidence only. Register
the presenter-authored original scored case and matching case/trace identity
for the private CI check. Prepare the separate `agent/audience-input.json`
from the saved case and original trace; keep the standing
`agent/qualification-input.json` unchanged. Restoring the original prompt and
recording the local result makes the ordinary push a real gate; the required
`audience-case-gate` then runs beside
ordinary checks on the same saved Case/trace identity. Its failure/incomplete status blocks/skips downstream
`evaluate-agent` exact-package qualification and publication. A previously
qualified serving package remains in place while the actual callback is
pending or red.

The [synthetic local case](../README.md#run-one-evaluation-locally) remains a
fully offline example. It uses versions 74 and 75, has no AWS dependency, and
is intentionally separate from the live trace and published dataset above.

## Verified audience gate exhibit

The opening case required restoring Inventory access to version 167. In an
earlier verified CI run, GitHub Actions invoked the application agent on the
same alarm and pre-report history used in the IDE. Its recommendation was to
increase Inventory memory to 512 MB; Strands `Equals` returned 0 and the job
exited 1. Open the **Expected** and **Actual** row to see exactly what
prevented publication. This is recorded earlier evidence, not a promise about
every fresh model run. [Earlier verified regression on the opening case](https://github.com/guilleojeda/evaluations-ref-arch/actions/runs/46020216978/job/140577710151)

You can match the two input files across runs. The published scenario digest begins with `aa756098` and the saved trace digest with `72ca97e7`. An earlier passing comparison with the repaired prompt recommended restoring version 167 on that pair. If both prompts pass in one pair, that single pair does not establish improvement. [Earlier passing CI comparison](https://github.com/guilleojeda/evaluations-ref-arch/actions/runs/46020463920/job/140578533381)

To reproduce the deterministic failure without AWS, use the saved report in the
[synthetic case](../README.md#try-a-regression). The live score and the
offline check answer related questions with different evidence boundaries.
