# Demo cue sheet

Use this sheet with the [talk plan](talk-plan.md) and [slides plan](slides-plan.md).
The public cue sheet describes what to show, not private account setup. Keep
credentials, console locators, trace IDs, and presenter-only runbooks outside
the repository.

## Opening: load the store before the denial

Before triggering the incident, open the signed-in storefront and wait until
the catalog/product view is loaded. Teach the normal customer path - a shopper
is ready to place a quantity-one order - and keep that page visible. Do not
click **Place order** yet.

Trigger one fresh denial and wait for the new investigation to reach a
completed report. Read the structured recommendation before taking any
configuration action. The recorded opening trace and earlier local/CI runs
showed **target `INVENTORY`**, **value `512 MB`**, and **Increase memory**; a
later fresh named Codespace run with the unchanged prompt returned the reviewed
version and **PASS**. If the current report is incomplete or its target/value
is not readable, leave the step pending; do not adjust memory from a partial
report.

Only after a readable completed report decide whether a staged memory action is
supported by the current evidence, then read the actual configuration and
checkout result. This order keeps the report, configuration change, and
checkout outcome as separate pieces of evidence.

## Current normal cue

After the original score and calibration, use one clean qualified S5. Copy
the prepared `before/faulty-prompt.py` reference into the active
`S5/agent/prompt.py`. Open `denial-case.json` beside the matching final chat
input in `original-trace.json`. Take the trace ID from the case, select the
latest `name == "chat"` span by `startTimeUnixNano`, and project only its span
ID and event names (including `gen_ai.choice` when present); use editor search
on that span for the final chat input. Show the presenter-authored expectation,
same read-only history, and native `Equals`. Explicitly exclude the old answer,
system prompt, and signed-thinking/reasoning from the new task. Run the original
prompt and read the actual result. The recorded opening trace and earlier
local/CI runs showed the 512 MB recommendation and exact-action FAIL, while a
later fresh named Codespace run with the unchanged prompt returned the reviewed
version and PASS. Do not promise the direction of a fresh model run. Say:

> Earlier, we evaluated an already generated output. Now we're using fixed inputs, and letting the agent generate the output again

Replace only the active rule with this exact text; run the same command for a
fresh inference/session and actual recommendation:

```text
When Inventory reads are still denied, recommend restoring access. Identify the healthy version at the same memory from the configuration evidence. If access has already recovered, recommend no change.
```

Select the pre-qualified endpoint with the identical repaired prompt, verify
**OK**, and run one dedicated hosted full investigation for a new denial. Match
its event/run/trace and show the real restoration recommendation as behavior
evidence only. Register the presenter-authored original scored case and
matching case/trace identity once in the private suite; the new hosted denial
is not a CI input.

Restore the original source into the same S5 file, run the same local case and
record its actual result, and say “assume I'm a careless dev and I didn't run
my tests locally before merging my changes”. Hand the reviewed diff to the
participant for the ordinary push; the presenter takes over only if
unavailable. Leave
`audience-case-gate` running. Its failure/incomplete status blocks/skips
downstream `evaluate-agent` exact-package qualification and publication. Reach
slides 35/36 before the callback, read the current pass/fail/pending status,
and finish on slide 37. If it passes or remains pending, show the earlier
verified CI rejection as earlier evidence, not as the current run. The detailed
S3/S4 steps below are historical fallback only.

In an ordinary repository checkout, open a terminal at the repository root and
change to `examples/live-denial`. Do not run a bridge or freeze/transfer helper
during delivery. Open `denial-case.json` beside
the matching final chat input in `original-trace.json` and show the direct
native `Case`, the presenter-authored expectation, same read-only history, and
native `Equals`. The old answer, system prompt, and signed-thinking/reasoning
are explicitly excluded from the new task. From that terminal, run:

```bash
PYTHONPATH="$(cd ../../agent && pwd)" uv run --project ../../agent --locked python -u strands_denial.py
```

After the edit, run that exact command again. The packaged presenter workspace
uses the same files in **Case and results > live-denial**. Its instructions
include the corresponding [Codespace commands](../examples/live-denial/README.md#run-the-native-example).

The app's real `investigation.create_agent` starts one fresh agent run per
prompt and produces one structured report; its normal bounded formatting
follow-up may occur inside that run. The runner reports the actual
recommendation and exact `Equals` result. A missing report is INCOMPLETE, not a
completed wrong action is FAIL, a correct action is PASS, and missing or
invalid inputs are INCOMPLETE; do not replace any of those outcomes with a
recorded color.

## Working run of show

| Minutes | Stage | Cue |
| --- | --- | --- |
| 0-8 | S0 | Paper-plane opener; load the storefront and teach the normal order path, trigger the denial, and wait for the completed report. Read the actual recommendation before any adjustment; the recorded opening trace and earlier local/CI evidence showed **target `INVENTORY`** and **value `512 MB`**, while a later fresh named Codespace run passed. |
| 8-15 | S0 | If the completed report and configuration readback support the staged memory action, apply it, await the actual readback, then make one visible checkout and explain why memory leaves access unchanged. |
| 15-22 | S1 | Select the original trace, create a fixed dataset scenario draft, add the expected response, save it, and create the published version. |
| 22-28 | S2 | In the Codespace `live-denial` folder, download `examples[0]` from the published dataset and run `score_denial.py`. Read the exact action check and the native verdict. Use slides 16, 18 and 19 to explain judge calibration, then return to the prompt edit. |
| 28-38 | IDE | Read `denial-case.json` directly into native Strands, show the matching final chat input/history from `original-trace.json`, run the original prompt and read the actual result, apply the exact three-sentence rule, and run the same command fresh. |
| 38-45 | Live | Use the identical repaired prompt on the pre-qualified endpoint for one dedicated full investigation, match its event/run/trace, and show the recommendation as behavior evidence. |
| 45-53 | Gate | Prepare `agent/audience-input.json`, restore the original prompt, record the local result, say the careless-dev line, hand the diff to the participant for the push, and leave the fast gate running. |
| 53-60 | - | Closing and questions. |

Treat the schedule as a handoff plan. A pending result remains pending. A
recorded fallback is labelled with its case, candidate, and execution identity.

## Trace and case

1. Open the original native trace and show the Inventory `AccessDeniedException`
   and matching Checkout 502.
2. Open configuration and show the denied version beside the healthy version at
   the same observed baseline memory and the normal access role.
3. Add the selected trace to a new fixed dataset. During creation, leave
   expected response and expected trajectory disabled; AWS creates a scenario
   draft.
4. In the draft, add the reviewed prose and typed expectation in the same
   published scenario:

   ```json
   "turns": [{"expected_response": "Recommend restoring Inventory access by moving the live alias from the denied version to the healthy version. Both use the observed baseline memory. The healthy version has the role that permits dynamodb:GetItem. Increasing memory alone does not restore access."}],
   "metadata": {"expected_recommendation": {"action": "Restore inventory access", "target": "inventory", "value": "<healthy-version>", "unit": "version"}}
   ```

5. Save the draft and create the published version. Explain that the draft is editable and
   the version is the frozen case used by the Codespace.

## Download and score

Use the public `examples/live-denial` terminal and the maintained [Codespace
download command](../examples/live-denial/README.md#prepare-the-two-inputs).
It uses the full published dataset ID and version, selects `examples[0]`, and
runs the locked scorer.

Open `denial-case.json` beside `score_denial.py`. Point out that the script
loads the case, fetches the original spans from CloudWatch using the case's
session/log-group/start-time fields, reads `incident.report`, and calls
`Builtin.Correctness` with the recorded spans and expected response. It does
not invoke the investigating agent again.

Read the returned **Expected** and exact structured **Actual** recommendation
first. Compare action, target, value, and unit. Then read the separate native
**label**, **value**, and **explanation**. The saved walkthrough readback may show `Incorrect, 0.0`; that is a completed scored quality failure for the attempt, but
the judge result is a property of that scoring attempt. A later native attempt
can return a different label; never hide the returned explanation. In every
case compare the formal recommendation with the reviewed expected response:
the summary's correct diagnosis does not make `Increase memory` the correct
action.

## Historical prepared-stage development and release (not the current cue)

The normal audience cue is the current one-case IDE route above. The S3/S4/S5
steps below remain useful for independent preparation and outage recovery only;
label their results prepared or recorded and never imply that the current
audience edit or live case ran.

1. S3 edits only the recommendation rule. Run a fresh candidate with the same
   selected dataset case and captured evidence. Its new trace is not the S2
   original trace.
2. S4 runs the repaired candidate through native Strands with the current
   denial case/evidence bridge plus the four retained reviewed cases (five
   cases total). It is development feedback, not package qualification.
3. S5 evaluates the exact Runtime ZIP proposed for release. The participant's
   presenter preparation appends the denial case to the four retained reviewed
   cases and uploads the five-case archive privately. One commit then changes
   the prompt and the private suite pointer. CI downloads/verifies all five and
   compares source-run case/bundle identity with the candidate's CI result. Keep the CI
   qualification row distinct from any later live alarm/run row. Required
   deterministic failures reject the ZIP; complete results then need
   source-backed human review of that package.
4. If a result is late, show a matching recorded result with its identity and
   say that it is recorded. Do not relabel a development or live row as CI.

Do not run a bridge or freeze/transfer helper during delivery. The current gate
uses the separate `agent/audience-input.json` prepared from the saved
`denial-case.json` and matching `original-trace.json`; it does not append the
case to the standing qualification suite. Historical S3/S4 preparation keeps
its own inputs and identities. For an independent adaptation, use [the direct
Case walkthrough](adapt-evaluations.md#generate-a-new-answer-from-the-same-inputs).

## Capacity comparison

Treat capacity as a separate scenario, not a prompt repair. Start healthy at
Inventory cap 16, run the saved finite surge profile, stop and settle it, raise
the cap to 32, repeat the same profile, and restore the baseline. Compare
actual starts, skips, arrivals, native throttles, caller outcomes, and settled
business effects. A configured cap or quiet request is not surge evidence.

See the [scenario contract](demo-scenarios.md#inventory-capacity-overload) for
the detailed invariants.

## Continuity

| Situation | Onstage response |
| --- | --- |
| Dataset draft or version is unavailable | Explain the draft/version distinction and use the matching recorded case; do not invent a download. |
| Score is late | Show the returned status when available, or a matching recorded scoring attempt with its explanation. |
| S3/S4 is late | Keep the selected case/evidence identity visible and label a prepared or recorded result. |
| CI is pending | Show pending status. A historical rejection is only a labelled fallback with its own package identity. |
| A live repair is not safe to trigger | Do not induce it; show a matching recorded live row and keep it separate from CI. |

Do not retry the audience request, fabricate an alarm, or call a development
result a release qualification.
