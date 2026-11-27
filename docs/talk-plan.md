# Talk plan

**Ship Reliable AI Agents with Strands Evaluation and AgentCore Evaluations**
is a 60-minute Code Talk for engineers and architects building agents on AWS.
The practical question is: what evidence would justify shipping an agent
change?

The [demo cue sheet](demo-script.md) has the stage order, the [slides plan](slides-plan.md)
has the projected story, and the [attendee guide](attendee-guide.md) has the
public case walkthrough.

## Current audience route

After the opening trace, fixed case, original score, and calibration (physical
16 is **Two types of checks**, followed by 18 and 19), use one visible direct
Case loop. Start from a clean qualified S5 and copy
the prepared `before/faulty-prompt.py` reference into the active
`S5/agent/prompt.py`. Open `denial-case.json` beside the matching final chat
input in `original-trace.json`. Take the trace ID from the case, select the
latest `name == "chat"` span by `startTimeUnixNano`, and project only its span
ID and event names; use editor search on that span for the final chat input.
Show `Case.input = denial-case.json.turns[0].input`
(the original alarm), build `messages = alarm + history` separately, and show
the presenter-authored expected output, same read-only history, and native
`Equals`; explicitly exclude the old answer, system prompt, and
signed-thinking/reasoning from the new task. Run the original prompt and read
the actual result. The recorded opening trace and earlier local/CI runs showed
the 512 MB recommendation and exact-action FAIL, while a later fresh named
Codespace run with the unchanged prompt returned the reviewed version and
PASS. Do not promise the direction of a fresh model run. Say:

> Earlier, we evaluated an already generated output. Now we're using fixed inputs, and letting the agent generate the output again

Replace only the active rule with this exact text and run the same command for a
fresh inference/session and actual recommendation:

```text
When Inventory reads are still denied, recommend restoring access. Identify the healthy version at the same memory from the configuration evidence. If access has already recovered, recommend no change.
```

Use the identical repaired prompt on the pre-qualified endpoint, verify **OK**,
and run one dedicated hosted full investigation for a new denial. Match its
event/run/trace and show the real restoration recommendation as behavior
evidence only. Register the presenter-authored original scored case and
matching case/trace identity once in the private suite; the new hosted denial
is not a CI input.

Restore the original source into the same S5 file, run the same local case and
record its actual result, and say “assume I'm a careless dev and I didn't run
my tests locally before merging my changes”. Push normally. The required fast
`audience-case-gate` runs in parallel with ordinary checks; failure or
incomplete status blocks/skips downstream `evaluate-agent` exact-package
qualification and publication. Leave it running through slides 35 and 36,
read the current pass/fail/pending state, and finish on 37. If it passes or
remains pending, show the earlier verified CI rejection as earlier evidence,
not as the current run.
The gate uses the separate `agent/audience-input.json` pointer for this saved
Case/trace; it does not replace the standing `agent/qualification-input.json`.
The older S3/S4 table below is retained as independent preparation/recovery
material, not the normal audience cue. The participant pushes the final source;
the presenter takes over only if unavailable.

## Audience and intended outcome

Show the room how to:

1. Turn an observed failure into a reviewed, repeatable case.
2. Check actions and evidence separately from prose quality.
3. Check a judge against examples that people have labeled, including examples
   kept out of tuning.
4. Use a release gate that protects a known-good candidate when a later prompt
   change regresses.

The case uses the original trace, a reviewed expected response, AgentCore's
`Builtin.Correctness` score, a native Strands development run, and a CI
qualification for the exact package proposed for release.

## Incident story

Open the signed-in storefront before the incident and wait for its catalog and
product view to load. Teach the normal customer path - a shopper is ready to
place a quantity-one order - and keep that page visible without clicking
**Place order**. Then trigger one fresh Inventory access denial and wait for the
new investigation to reach a completed report. Read its structured
recommendation before any configuration action. The recorded opening trace and
earlier local/CI runs showed **target `INVENTORY`**, **value `512 MB`**, and
**Increase memory**; a later fresh named Codespace run with the unchanged prompt
returned the reviewed version and **PASS**. If either field is missing or the
report is incomplete, leave the step pending.

Only after a readable completed report decide whether a staged memory action is
supported by the current evidence, then read the actual configuration and
checkout result. Configuration shows the live alias on the denied version at
the observed baseline memory, while a healthy version uses the normal role at
that same memory. A memory change therefore leaves the denial in place. Read
the exact version values from the trace and configuration during each
performance.

Ask: **"Did the agent miss the clue, or did it see the clue and still recommend
the wrong fix?"** The trace answers the first part. The reviewed expectation
answers what the formal recommendation should have been: restore Inventory
access by selecting the healthy version identified in the trace.

## Code transformation

| Stage | What changes | What stays fixed |
| --- | --- | --- |
| S0 - Native trace | Observe the alarm, read-only tool calls, source results, and original report. | The original execution and evidence. |
| S1 - Dataset case | Create a fixed AgentCore dataset scenario draft from the selected trace, add the prose and typed expected recommendation, and publish the version. | Both reviewed fields remain evaluator input, not agent prompt input. |
| S2 - Original score | Show the exact structured recommendation check, then score the original report with `Builtin.Correctness` and explain the calibration/holdout boundary. | No agent rerun; both outputs belong to the original trace and scoring attempt. |
| IDE repair | Read `denial-case.json` directly into a native Strands Case, show `Case.input = turns[0].input`, matching final chat input/history from `original-trace.json`, exclude old answer/system/signed-thinking fields, show native `Equals`, run the original prompt and read the actual result, edit the exact rule, and run the same command. | Presenter-authored expectation; history is supplied separately; fresh candidate session. |
| Live repaired endpoint | Use the identical repaired prompt on the pre-qualified endpoint and run one dedicated full investigation for a new denial. | A real new event/run/trace, not a prepared result; it is not the CI input. |
| Fast release check | Prepare separate `agent/audience-input.json` from the original case/trace, restore the faulty prompt, record the local result, and hand the diff to the participant for the push. | `audience-case-gate` uses the same saved Case/trace; read its current pass/fail/pending state, and failure/incomplete blocks `evaluate-agent` and publication. |

The IDE run and live endpoint are development evidence; they do not qualify or
publish a Runtime ZIP. The original scored case is registered once for the
fast check; the new hosted denial is behavior evidence only, not a CI input.
The required fast CI failure/incomplete result rejects or
blocks the proposed package; the previously qualified serving package remains
in place while the new one is reviewed.

The delivery path does not run a bridge, freeze a second case, or use a hidden
transfer command. `denial-case.json` is the direct Case input; the matching
final chat input in `original-trace.json` is history/provenance only. S3/S4
artifacts remain independent preparation/recovery material and preserve their
own execution identities.

## Run of show

| Minutes | Stage | Audience-facing work |
| --- | --- | --- |
| 0-8 | S0 | Load the storefront and teach the normal order path, trigger the denial, and await the completed report. Read the actual target/value before any adjustment; the recorded opening trace and earlier local/CI evidence showed **target `INVENTORY`** and **value `512 MB`**, while a later fresh named Codespace run passed. |
| 8-15 | S0 | If the completed report and configuration readback support the staged memory action, apply it, await the actual readback, then make one visible checkout and establish why memory is not the fix. |
| 15-22 | S1 | Add the selected trace to a fixed dataset, distinguish draft from published version, and write the reviewed prose and typed recommendation. |
| 22-28 | S2 | Download `examples[0]` from the published case and show the returned native label, value, and explanation for the original report. |
| 28-38 | IDE | Convert the audience case to native Strands, show the fixed inputs/tools/evaluator, run the original prompt and read the actual result, apply the exact three-sentence rule, and run the same command fresh. |
| 38-45 | Live | Select the pre-qualified identical prompt, run one dedicated full investigation for a new denial, match its event/run/trace, and show the recommendation as behavior evidence; then register the original scored case and matching case/trace identity. |
| 45-53 | Gate | Prepare `agent/audience-input.json`, restore the original prompt, record the local result, say the careless-dev line, and hand the diff to the participant for the push. Leave the fast gate running. |
| 53-60 | - | Closing and questions. |

Treat the timeline as a handoff schedule. A pending or recorded result remains
labelled as such; it is not silently substituted for a fresh execution.

## Audience participation

Use three bounded interactions:

- The presenter authors the expected recommendation after the trace is visible.
- The presenter shows whether the written diagnosis supports the formal action
  before revealing the `Builtin.Correctness` result.
- The participant performs the ordinary push after the presenter restores the
  faulty rule; the presenter takes over only if unavailable. Do not add a second
  prompt or expectation path.

The expected response is authored from the reviewed evidence. It is not
inserted from audience wording into the agent prompt or evaluator instructions
during the talk.

The current route registers the original scored case and matching case/trace
identity once after the pre-qualified endpoint handles a new denial. Prepare
`agent/audience-input.json` from `denial-case.json` and `original-trace.json`;
keep `agent/qualification-input.json` unchanged. That hosted denial is behavior
evidence only, never a CI input. The ordinary push then starts
`audience-case-gate` in parallel with ordinary checks; a failure/incomplete
status blocks or skips downstream `evaluate-agent` exact-package qualification
and publication. The older five-case package workflow remains documented as a
prepared-stage fallback and is not a normal audience cue.

## Public and private boundaries

The repository's offline synthetic case remains runnable without AWS. The live
walkthrough uses a published dataset ID and version, then a Codespace file
(`examples/live-denial/denial-case.json`) and the public
`examples/live-denial/score_denial.py` example. The public docs do not publish
trace IDs, console URLs, account-specific roles, credentials, or presenter
runbooks.

For application and capacity invariants, see [demo scenarios](demo-scenarios.md).
For evaluation semantics, see [evaluations](evaluations.md). For the stable
stage source map, see [checkpoints](checkpoints.md) and [TALK-STAGE](../TALK-STAGE.md).

## Closing

> Your agent is non-deterministic, but you can still test whether its behavior
> is acceptable. Define what good looks like, check that the evaluation
> recognizes it, and stop regressions before they ship.
