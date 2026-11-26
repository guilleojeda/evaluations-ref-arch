# Talk plan

**Ship Reliable AI Agents with Strands Evaluation and AgentCore Evaluations**
is a 60-minute Code Talk for engineers and architects building agents on AWS.
The practical question is: what evidence would justify shipping an agent
change?

The [demo cue sheet](demo-script.md) has the stage order, the [slides plan](slides-plan.md)
has the projected story, and the [attendee guide](attendee-guide.md) has the
public case walkthrough.

## Audience and intended outcome

Show the room how to:

1. Turn an observed failure into a reviewed, repeatable case.
2. Check actions and evidence separately from prose quality.
3. Use a release gate that protects a known-good candidate when a later prompt
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

Ask: **"Did the agent miss the clue, or did it see the clue and still recommend
the wrong fix?"** The trace answers the first part. The reviewed expectation
answers what the formal recommendation should have been: restore Inventory
access by selecting the healthy version identified in the trace.

## Code transformation

| Stage | What changes | What stays fixed |
| --- | --- | --- |
| S0 - Native trace | Observe the alarm, read-only tool calls, source results, and original report. | The original execution and evidence. |
| S1 - Dataset case | Create a fixed AgentCore dataset scenario draft from the selected trace, add the prose and typed expected recommendation, and publish the version. | Both reviewed fields remain evaluator input, not agent prompt input. |
| S2 - Original score | Show the exact structured recommendation check, then score the original report with `Builtin.Correctness`. | No agent rerun; both outputs belong to the original trace and scoring attempt. |
| S3 - Development repair | Edit only the recommendation rule and run a fresh candidate. | Selected case, captured evidence, report shape, and evaluator. |
| S4 - Native experiment | Run the repaired candidate through Strands with the current native case/evidence bridge plus the four retained reviewed cases. | Five-case suite; case meaning and evaluator remain fixed. |
| S5 - Release gate | Run CI against the exact Runtime ZIP proposed for release. | Package identity and reviewed case roster. |

S3 and S4 are development feedback. They do not qualify or publish a Runtime
ZIP. A required CI failure rejects the proposed package; the previously
qualified serving package remains in place while the new one is reviewed.

Use the runnable [native case bridge](../scripts/native_case_bridge.py) with
the [build command](adapt-evaluations.md#bridge-the-live-case-into-s3-s4)
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
| 28-35 | S3 | Edit the recommendation rule and start a fresh candidate against the same case/evidence. |
| 35-42 | S4 | Run the native Strands experiment; show the current denial case alongside the four retained reviewed cases. |
| 42-53 | S5 | Show the participant's prompt edit plus private suite-pointer update, CI qualification for the exact ZIP, and publication decision. |
| 53-60 | - | Closing and questions. |

Treat the timeline as a handoff schedule. A pending or recorded result remains
labelled as such; it is not silently substituted for a fresh execution.

## Audience participation

Use three bounded interactions:

- Ask what an acceptable response should recommend after the trace is visible.
- Ask whether the written diagnosis supports the formal action before revealing
  the `Builtin.Correctness` result.
- Have the participant edit only the recommendation rule and predict the CI
  result.

Audience wording is normalized into the reviewed expected response. It is not
inserted into the agent prompt or evaluator instructions during the talk.

Presenter preparation appends the current denial case to the four retained
reviewed gate cases and uploads the resulting five-case archive privately. S5
then has one participant commit containing only the prompt edit and private
suite pointer. CI downloads and verifies all five cases against the exact
package, then compares the source run's case/bundle identity with the
candidate's CI result. The pointer and source records stay private. This does
not guarantee a pass or publication.

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
