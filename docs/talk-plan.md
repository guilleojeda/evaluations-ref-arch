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
16 is **Two types of checks**, followed by 18 and 19), use one visible IDE
loop. Start from a clean qualified S5 and copy
the prepared `before/faulty-prompt.py` reference into the active
`S5/agent/prompt.py`. Show the audience case
input, expected output, fixed captured tools, and exact evaluator; run the
original prompt to the actual FAIL. Say:

> Earlier, we evaluated an already generated output. Now we're using fixed inputs, and letting the agent generate the output again

Replace only the active rule with this exact text and run the same command for a
fresh inference/session and actual recommendation:

```text
When Inventory reads are still denied, recommend restoring access. Identify the healthy version at the same memory from the configuration evidence. If access has already recovered, recommend no change.
```

Use the identical repaired prompt on the pre-qualified endpoint, induce one new
denial after verifying **OK**, and show the real restoration recommendation as
behavior evidence only. Register the original scored case and matching
case/bundle hashes once in the private suite; the new hosted denial is not a CI
input.

Restore the original source into the same S5 file, run the same local case to
FAIL, and say “assume I'm a careless dev and I didn't run my tests locally
before merging my changes”. Push normally. The required fast
`audience-case-gate` runs in parallel with ordinary checks; failure or
incomplete status blocks/skips downstream `evaluate-agent` exact-package
qualification and publication. Leave it running through slides 35 and 36,
return to the actual red/no-publication or pending state, then finish on 37.
The older S3/S4 table below is retained as a prepared-stage fallback, not the
normal audience cue.

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

Open with an Inventory access denial. The faulty report identifies the IAM
problem in its summary but formally recommends more memory. Configuration shows
the live alias on the denied version at the observed baseline memory, while a
healthy version uses the normal role at that same memory. A memory change
therefore leaves the denial in place and a fresh checkout still fails. Read the
exact version values from the trace and configuration during each performance.
The controller's automatic verification probe supplies the initial failure
evidence; keep the storefront untouched until the selected memory action is
complete and **Denied + 512 MB** is read back. Then make the one visible
storefront checkout and show its real 502/request ID or pending state.

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
| IDE repair | Convert the audience case to a native Strands case, show input/expected/fixed tools/evaluator, run original FAIL, edit the exact rule, and run the same command. | Fixed case and captured tools; fresh session and prompt digest. |
| Live repaired endpoint | Use the identical repaired prompt on the pre-qualified endpoint and show one new denial recommendation. | A real new event/run, not a prepared result; it is not the CI input. |
| Fast release check | Register the original scored case and matching case/bundle hashes, restore the faulty prompt, show local FAIL, and push normally. | `audience-case-gate` is required; failure/incomplete blocks `evaluate-agent` and publication. |

The IDE run and live endpoint are development evidence; they do not qualify or
publish a Runtime ZIP. The original scored case is registered once for the
fast check; the new hosted denial is behavior evidence only, not a CI input.
The required fast CI failure/incomplete result rejects or
blocks the proposed package; the previously qualified serving package remains
in place while the new one is reviewed.

Use the runnable [native case bridge](../scripts/native_case_bridge.py) with
the [build command](adapt-evaluations.md#bridge-the-live-case-into-s3s4)
to connect the downloaded case and `original-trace.json` to the originating
RunTable row and S3 captures. S3/S4 consume the same incident's normal task
projection and bounded evidence, while preserving the original trace as a
separate execution identity.

## Run of show

| Minutes | Stage | Audience-facing work |
| --- | --- | --- |
| 0-8 | S0 | Paper-plane opener, store failure, alarm, and faulty report. |
| 8-15 | S0 | Show the denied read and configuration; establish why memory is not the fix. |
| 15-22 | S1 | Add the selected trace to a fixed dataset, distinguish draft from published version, and write the reviewed prose and typed recommendation. |
| 22-28 | S2 | Download `examples[0]` from the published case and show the returned native label, value, and explanation for the original report. |
| 28-38 | IDE | Convert the audience case to native Strands, show the fixed inputs/tools/evaluator, run FAIL, apply the exact three-sentence rule, and run the same command fresh. |
| 38-45 | Live | Select the pre-qualified identical prompt, show the new denial recommendation as behavior evidence, then register the original scored case and matching case/bundle hashes. |
| 45-53 | Gate | Restore the original prompt, show local FAIL, say the careless-dev line, and push. Leave the fast gate running. |
| 53-60 | - | Closing and questions. |

Treat the timeline as a handoff schedule. A pending or recorded result remains
labelled as such; it is not silently substituted for a fresh execution.

## Audience participation

Use three bounded interactions:

- Ask what an acceptable response should recommend after the trace is visible.
- Ask whether the written diagnosis supports the formal action before revealing
  the `Builtin.Correctness` result.
- Have the participant, when available, or the presenter edit only the
  recommendation rule and predict the CI result. The ordinary push is the same
  either way; do not add a second prompt path.

Audience wording is normalized into the reviewed expected response. It is not
inserted into the agent prompt or evaluator instructions during the talk.

The current route registers the original scored case and matching case/bundle
hashes once after the pre-qualified endpoint handles a new denial. That hosted
denial is behavior evidence only, never a CI input. The ordinary push then starts
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
