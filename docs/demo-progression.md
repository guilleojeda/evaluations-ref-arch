# Demo progression

Follow one Inventory failure through six stages, from the original native
trace to a prompt regression that CI rejects. The [talk plan](talk-plan.md)
gives the timing and the [cue sheet](demo-script.md) gives the screen order.
Attendees can [follow the public case](attendee-guide.md).

## Current audience progression

The normal post-calibration route is one native Strands IDE loop, one
pre-qualified live endpoint, and one required fast gate. Start from clean S5
and copy the prepared `before/faulty-prompt.py` reference into the active
`S5/agent/prompt.py`. Show the
audience case input, expected output, fixed captured tools, and evaluator; run
the original prompt to FAIL, say the required boundary sentence, edit the
active rule to:

```text
When Inventory reads are still denied, recommend restoring access. Identify the healthy version at the same memory from the configuration evidence. If access has already recovered, recommend no change.
```

Run the same command for a fresh recommendation. Use the identical repaired
prompt for one new denial and show that hosted behavior only. Register the
original scored case and matching case/bundle hashes once, restore
the original prompt, run local FAIL, say “assume I'm a careless dev and I
didn't run my tests locally before merging my changes”, and push. The
`audience-case-gate` fast check runs in parallel with ordinary checks; failure
or incomplete status blocks/skips downstream `evaluate-agent` qualification
and publication. Reach slides 35/36 before the actual red/no-publication or
pending callback, then 37. The S3/S4 rows below are fallback/preparation only.

## Case and package boundaries

The trace is the evidence for the original execution. S1 turns that trace into
a fixed AgentCore dataset scenario: first an editable draft, then a published
version after the prose response and typed expected recommendation are saved.
The published version is the input downloaded by the Codespace. Both reviewed
fields are evaluator context; they are not added to the agent prompt.

S2 first checks the exact structured recommendation, then scores the original
report with `Builtin.Correctness`. The current route then runs one native
Strands case on fixed input/tools and uses the identical repaired prompt on one
new denial as behavior evidence only. It registers the original scored case
and matching case/bundle hashes once before the ordinary push. The historical
S3/S4/S5 workflow adds a case to retained reviewed cases and can be used for
independent preparation; keep these identities
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
| IDE repair | Convert the audience case to native Strands, run the original prompt to FAIL, edit the exact rule, and run the same command. | Fresh session/recommendation on fixed input and captured tools. |
| Live repaired endpoint | Use the identical repaired prompt for one new denial and show the recommendation. | Real event/run, not a prepared result or CI input. |
| Fast release gate | Register the original scored case and matching case/bundle hashes, restore the original prompt, show local FAIL, say the careless-dev line, and push. | `audience-case-gate` failure/incomplete blocks/skips `evaluate-agent` and publication. |

The [native case bridge](../scripts/native_case_bridge.py) makes the prepared
transfer explicit; use the [build command](adapt-evaluations.md#bridge-the-live-case-into-s3s4)
only for the historical S3/S4 fallback.
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
- S3 uses the current native case and captured evidence; the historical S4
  fallback adds that case to the four retained reviewed cases. Their new traces
  are not the original trace.
- S5 evaluates the exact package being proposed, not a development trace from
  another candidate.
- A later live row is evidence of a later alarm/run and must not be presented as
  the CI qualification row.
- Missing, pending, incomplete, or recorded evidence keeps its status.

For the detailed application invariants, see [demo scenarios](demo-scenarios.md).
For scoring and publication, see [evaluations](evaluations.md) and
[deployment](deployment.md).
