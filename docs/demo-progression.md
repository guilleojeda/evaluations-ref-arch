# Demo progression

Follow one Inventory failure through six stages, from the original native
trace to a prompt regression that CI rejects. The [talk plan](talk-plan.md)
gives the timing and the [cue sheet](demo-script.md) gives the screen order.
Attendees can [follow the public case](attendee-guide.md).

## Case and package boundaries

The trace is the evidence for the original execution. S1 turns that trace into
a fixed AgentCore dataset scenario: first an editable draft, then a published
version after the prose response and typed expected recommendation are saved.
The published version is the input downloaded by the Codespace. Both reviewed
fields are evaluator context; they are not added to the agent prompt.

S2 first checks the exact structured recommendation, then scores the original
report with `Builtin.Correctness`. S3 runs the current native denial case with
its same-incident evidence bridge. S4 and S5 add that case to the four retained
reviewed cases, five cases total, against the exact package proposed for
release. Keep these identities
distinct:

- original trace and its report;
- published dataset case and version;
- fresh S3/S4 execution and trace;
- CI execution and exact Runtime ZIP; and
- a later live alarm/run, if one is shown.

The agent proposes one action; it does not call the controller. The approved
denial action is **Restore inventory access** by selecting the healthy
role-backed version at the current memory. Capacity evidence may instead
support **Increase reserved concurrency**. The offline synthetic example keeps
versions 74 and 75 and remains an independent local check.

## Checkpoints

| State | Audience sequence | Meaning |
| --- | --- | --- |
| S0 - Native trace | Show the denied read, configuration, source results, and original memory recommendation. | Evidence of one actual agent execution; no score yet. |
| S1 - Dataset case | Add the trace to a fixed dataset, edit the prose response and typed recommendation in the scenario draft, save it, and create the published version. | The published version freezes the reviewed input. |
| S2 - Original score | Download `examples[0]` from the full dataset ID, show the exact structured recommendation check, and score the original report. | Show the returned `Builtin.Correctness` label, value, and explanation; compare the formal action with the expected response. No agent rerun. |
| S3 - Development repair | Edit only the recommendation rule and run a fresh candidate. | Development feedback against the same case/evidence. |
| S4 - Native Strands experiment | Run the repaired candidate with the current native case/evidence bridge alongside the four retained reviewed cases. | Five development cases; not qualification or publication. |
| S5 - Release gate | Push one commit containing the prompt edit and private suite-pointer update; run CI against the exact ZIP. | Presenter preparation has already appended the current case to the four-case roster; CI downloads/verifies all five, checks source/bundle identity, and required failures reject. |

The [native case bridge](../scripts/native_case_bridge.py) makes the normal
transfer explicit; use the [build command](adapt-evaluations.md#bridge-the-live-case-into-s3-s4).
The downloaded native case and `original-trace.json` join the originating
RunTable row and S3 captures, then become the frozen case, captured bundle, and
S4 suite. S3/S4 use the same incident's normal task projection and bounded
evidence; the bridge does not create a new trace or treat native
expected-response prose as the review record.

## Evidence rules

Identify each result by the case and candidate that produced it.

- A saved trace is evidence of that execution, not proof that a later edit ran.
- A dataset draft is editable; only a created version is a frozen download.
- S2 scores the saved original session once. S3 and S4 run fresh candidates.
- S3 uses the current native case and captured evidence; S4 adds that case to
  the four retained reviewed cases. Their new traces are not the original
  trace.
- S5 evaluates the exact package being proposed, not a development trace from
  another candidate.
- A later live row is evidence of a later alarm/run and must not be presented as
  the CI qualification row.
- Missing, pending, incomplete, or recorded evidence keeps its status.

For the detailed application invariants, see [demo scenarios](demo-scenarios.md).
For scoring and publication, see [evaluations](evaluations.md) and
[deployment](deployment.md).
