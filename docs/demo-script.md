# Demo cue sheet

Use this sheet with the [talk plan](talk-plan.md) and [slides plan](slides-plan.md).
The public cue sheet describes what to show, not private account setup. Keep
credentials, console locators, trace IDs, and presenter-only runbooks outside
the repository.

## Current normal cue

After the original score and calibration, use one clean qualified S5. Copy
the prepared `before/faulty-prompt.py` reference into the active
`S5/agent/prompt.py`, show the audience case
input, expected output, fixed captured tools, and exact evaluator, and run the
original prompt to its actual FAIL. Say:

> Earlier, we evaluated an already generated output. Now we're using fixed inputs, and letting the agent generate the output again

Replace only the active rule with this exact text; run the same command for a
fresh inference/session and actual recommendation:

```text
When Inventory reads are still denied, recommend restoring access. Identify the healthy version at the same memory from the configuration evidence. If access has already recovered, recommend no change.
```

Select the pre-qualified endpoint with the identical repaired prompt, verify
**OK**, induce one new denial, and show the real restoration recommendation as
behavior evidence only. Register the original scored case and matching
case/bundle hashes once in the private suite; the new hosted denial is not a CI
input.

Restore the original source into the same S5 file, run the same local case to
FAIL, and say “assume I'm a careless dev and I didn't run my tests locally
before merging my changes”. Push normally and leave
`audience-case-gate` running. Its failure/incomplete status blocks/skips
downstream `evaluate-agent` exact-package qualification and publication. Reach
slides 35/36 before the callback, return to actual red/no-publication or
pending status, and finish on slide 37. The detailed S3/S4 steps below are
historical fallback only.

In an ordinary repository checkout, open a terminal at the repository root.
Build the tool snapshot for the opening case before the first inference:

```bash
cd examples/live-denial
uv run --project ../../agent --locked python ../../scripts/native_case_bridge.py build \
  --scenario denial-case.json --trace original-trace.json --output bridge
```

Match the original trace ID in `denial-case.json` and `bridge/bridge-manifest.json`.
Show `bridge/candidate-input.json` (the alarm and cutoff), `bridge/captured-bundle.json`
(the tool observations) and `bridge/case.frozen.json` (the reviewed expectation).
Open `strands_denial.py` to show the `Case`, `investigate`, `RecommendedAction`,
and `Experiment.run_evaluations`. From that same terminal, run:

```bash
PYTHONPATH="$(cd ../../agent && pwd)" uv run --project ../../agent --locked python -u strands_denial.py \
  --scenario denial-case.json --case bridge/case.frozen.json --bundle bridge/captured-bundle.json
```

After the edit, run that exact command again. The packaged presenter workspace
uses the same files in **Case and results > live-denial**. Its instructions
include the corresponding [Codespace commands](../examples/live-denial/README.md#bind-the-case-to-the-captured-evidence-before-native-strands).

The runner reports the actual recommendation and exact action result. A
completed wrong action is FAIL, a correct action is PASS, and missing or
invalid inputs are INCOMPLETE; do not replace any of those outcomes with a
recorded color.

## Working run of show

| Minutes | Stage | Cue |
| --- | --- | --- |
| 0-8 | S0 | Paper-plane opener, store failure, alarm, and faulty report. |
| 8-15 | S0 | Show the Inventory denial and the observed denied-version configuration. Explain why a memory increase leaves access unchanged. |
| 15-22 | S1 | Select the original trace, create a fixed dataset scenario draft, add the expected response, save it, and create the published version. |
| 22-28 | S2 | In the Codespace `live-denial` folder, download `examples[0]` from the published dataset and run `score_denial.py`. Read the exact action check and the native verdict. Use slides 16, 18 and 19 to explain judge calibration, then return to the prompt edit. |
| 28-38 | IDE | Convert the audience case to native Strands, run the faulty prompt to FAIL, apply the exact three-sentence rule, and run the same command fresh. |
| 38-45 | Live | Use the identical repaired prompt on the pre-qualified endpoint, show one new denial recommendation as behavior evidence, and register the original scored case with matching case/bundle hashes. |
| 45-53 | Gate | Restore the original prompt, run local FAIL, say the careless-dev line, push, and leave the fast gate running. |
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
download command](../examples/live-denial/README.md#download-the-published-case-in-codespaces).
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

Use the runnable [native case bridge](../scripts/native_case_bridge.py) to make
that transfer visible. Run the build command in the [adaptation
walkthrough](adapt-evaluations.md#bridge-the-live-case-into-s3s4). It reads
the published structured recommendation, originating RunTable row and S3 captures, then writes
`case.frozen.json` and `captured-bundle.json` for S3 plus `suite.json` for S4.
The normal task projection and bounded evidence stay tied to the same incident;
the bridge validates trace/session/run joins and keeps native
`expected_response` prose separate from reviewed fields.

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
