# Slides plan

The [audience PDF](slides/audience.pdf) contains 16 projected pages. The
presenter deck has 42 physical slides, including hidden reference and
troubleshooting slides; holdout troubleshooting material is not part of the
visible calibration arc. See the [talk plan](talk-plan.md) for timing,
the [cue sheet](demo-script.md) for the screen order, and the [attendee
guide](attendee-guide.md) for the public walkthrough.

## Current normal route

After calibration, physical 16 is the authored **Two types of checks** slide:
contrast typed `expected_recommendation` with `Builtin.Correctness`; do not
look for a printed same-report pair. Then use one visible IDE loop: clean S5,
copy the prepared `before/faulty-prompt.py` reference into the active
`S5/agent/prompt.py`, show case
input/expected/fixed captured tools/evaluator, run the faulty prompt to actual
FAIL, say the required boundary sentence, and edit the active rule to:

```text
When Inventory reads are still denied, recommend restoring access. Identify the healthy version at the same memory from the configuration evidence. If access has already recovered, recommend no change.
```

Run the same command for a fresh result. Use the identical repaired prompt on
the pre-qualified endpoint for one real new denial and show that hosted behavior
only. Register the original scored case and matching case/bundle hashes once,
restore the original prompt, run local FAIL, say “assume I'm a careless dev and
I didn't run my tests locally before merging my changes”, and push. Leave the
required
`audience-case-gate` running; its failure/incomplete status blocks/skips
`evaluate-agent` qualification and publication. Slides 35 and 36 precede the
actual callback; return to the red/no-publication or pending state, then 37.

## What the talk should achieve

The central question is **What evidence would justify shipping this change to
my agent?** Follow the Inventory denial from a native trace to a reviewed
AgentCore dataset case. Score the original report, explain how to check the
judge, edit the prompt, compare reports in Strands, and use CI to check the
package proposed for release.

## Slide sequence

| Block | Audience message | Screen evidence |
| --- | --- | --- |
| Opening | An agent can find the right diagnosis and still choose the wrong action. | Loaded storefront and normal order path, then the alarm and completed faulty report with **target `INVENTORY`** and **value `512 MB`** before the memory action. |
| Trace | The agent actually saw the denied read and the two version configurations. | Native trace and configuration evidence. |
| Case | Expected behavior is reviewed separately from the prompt. | Fixed dataset scenario draft, expected response, and published version. |
| Original score | The exact structured recommendation is checked, then the evaluator scores the formal response against the written expectation. | Codespace `denial-case.json`, `score_denial.py`, and returned `Builtin.Correctness` label/value/explanation. |
| Calibration | Contrast the typed action check with the native judge, then explain human labels and holdouts without projecting a score pair. | Physical 16, 18, and 19; the current returned native result and one illustrative human-labeled sample. |
| Development | The reviewed case is converted to one native Strands case and the exact rule is tested on fixed input/tools. | IDE case input, expected output, captured bundle, evaluator, faulty FAIL, and fresh result. |
| Release | The original scored case is registered for the fast pushed-source check; the new hosted denial remains behavior evidence only. | `audience-case-gate` source/workflow row, downstream skip/block, and actual red/no-publication or pending state. |
| Close | Evidence supports a bounded release decision, not a claim of universal accuracy. | Case, candidate, evaluator, package, and publication identities. |

## Screen and transition notes

### Trace to dataset

Show the Inventory `AccessDeniedException`, matching Checkout 502, and
configuration showing the denied version versus the healthy version at the
same observed baseline memory. Add the selected trace to a fixed dataset.
During creation leave expected response and expected trajectory disabled; then
edit `turns[0].expected_response` and the typed
`metadata.expected_recommendation` in the scenario draft, save both, and create
the published version. Make clear that a draft is not yet the frozen download.

### Dataset to Codespace

In the `live-denial` folder, use the maintained [download and score command](../examples/live-denial/README.md#download-the-published-case-in-codespaces)
with the full dataset ID and published version. It selects `examples[0]` and
uses the locked scorer.

Show the input, both reviewed fields, and source metadata in the downloaded case.
Then show the script loading the original report from recorded CloudWatch
spans and calling `Builtin.Correctness`. The script does not rerun the agent.
Read the returned label, value, and explanation. Do not promise that repeated
judge attempts will return the same label; the written formal recommendation
must still be compared with the structured recommendation.

### 16 - Two types of checks

Use the current authored slide: compare the typed `expected_recommendation`
action/target/value/unit check with the independent `Builtin.Correctness`
result. Do not project a same-report pair on physical 16; any disagreement is
presenter-only historical context.

### 18 - What goes in a calibration sample?

Explain one illustrative sample: the log says the Inventory read was denied,
while the report claims Inventory ran out of memory. The human label is
**UNSUPPORTED**, because the permission error supplies no evidence about memory
usage. Keep this evidence-support label separate from the exact action check.

### 19 - Calibration set and holdout set

Explain that incidents are assigned before tuning. Human verdicts and reasons
guide the separate custom Opus rubric on calibration examples; freeze it before
checking the holdout against its human labels. If that check leads to a
revision, use a fresh holdout. The built-in judge can be tested as supplied.
Do not edit during this slide. Return to the native IDE handoff after the
calibration explanation, then show the fixed case, captured tools, and faulty
FAIL before applying the exact rule.

### Historical S3 and S4 fallback

The old S3/S4 workbench route remains a prepared/outage fallback. The normal
audience cue is the single native Strands IDE loop described above, followed by
the pre-qualified live endpoint and the fast CI gate. If the fallback is used,
label it prepared or recorded and never imply that the current audience edit
ran.

The runnable [native case bridge](../scripts/native_case_bridge.py), using the
build command in the [adaptation walkthrough](adapt-evaluations.md#bridge-the-live-case-into-s3s4),
binds the downloaded scenario and `original-trace.json` to the originating
RunTable row and S3 captures. Its `case.frozen.json` and `captured-bundle.json`
feed S3; its `suite.json` feeds S4. This is the same incident's normal task
projection and bounded evidence, not a new trace or an unreviewed native
expected-response string.

### Current fast release gate

After the original scored case and matching case/bundle hashes are registered,
restore the original prompt, show the same local case FAIL, and push normally.
The new hosted denial is not a CI input. `audience-case-gate` runs the native
exact-action check on the pushed source in parallel with ordinary checks. A
fast FAIL or incomplete result blocks/skips downstream `evaluate-agent`
exact-package qualification and publication; do not claim that skipped
qualification ran. A fast PASS only permits downstream qualification to start.
Return to the actual red/no-publication or pending state after slides 35 and
36. The older participant/five-case package workflow remains a prepared-stage
fallback.

## Appendix guidance

- **Architecture:** show the alarm-to-runtime path, read-only tools, captured
  case path, and independent application action. Keep live and captured sources
  distinct.
- **Case:** show the reviewed prose and typed recommendation with source metadata without exposing
  private trace identifiers or credentials.
- **Judge:** show the evaluator ID, returned label/value, and explanation for
  the scoring attempt. A semantic judge is not a replacement for an action
  check.
- **Measurement:** state the case count, candidate, evaluator, region, and
  evidence boundary before discussing a result.
- **Release policy:** required checks, incomplete-result handling, human review,
  and exact-package identity.

Share the [audience slides](slides/audience.pdf) and [attendee guide](attendee-guide.md).
The public repository intentionally omits private trace IDs, account-specific
roles, credentials, and presenter operating runbooks.
