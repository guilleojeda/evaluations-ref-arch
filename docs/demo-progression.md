# Demo progression

The talk uses six capability checkpoints, S0 through S5. They explain how a real incident becomes a reviewed case, how a candidate is tested, and how a release is protected. The public story and exact handoffs are in the [talk plan](talk-plan.md) and [demo cue sheet](demo-script.md). The [attendee guide](attendee-guide.md) is the canonical denial-to-CI account.

The current rehearsal is the v5 flow. It uses one calibrated native AgentCore semantic judge with US Opus 5.5 for advisory feedback. S5 does not publish from that advisory label: its decision binds deterministic requirements and human semantic review to the exact prepared package, reviewed cases, and evaluated reports and traces. Older model results are historical and stay labeled as such.

## Candidate and package boundaries

The opening candidate is intentionally faulty. The short prompt repair edited in S3 and exercised in S4 is a development candidate. It gets a fresh run and advisory feedback; it is not the serving release. Before the talk, a different exact v5 serving package is qualified against the reviewed suite and serves the repaired live incident. S5 starts from that qualified serving source, keeps it serving while the participant pushes a regression, and leaves it in place if the gate rejects the new candidate.

The candidate proposes exactly one action and never changes the application. The presenter independently applies supported actions. The approved menu is:

- Increase reserved concurrency for INVENTORY or CHECKOUT, with a higher cap.
- Increase memory for INVENTORY or CHECKOUT, with a larger allocation.
- Restore inventory access by selecting the healthy role-backed Inventory version at the current memory.
- Other, with a reason for no change or insufficient evidence.

A configuration readback is not an application result. A later request or bounded workload supplies that evidence.

## Checkpoints

| State | Audience sequence | Meaning |
| --- | --- | --- |
| S0 - Instrumented agent | Run the genuine alarm-driven access-denied investigation with the faulty candidate. It recommends **Increase memory - INVENTORY - 512 MB**. The presenter applies that recommendation, then uses one fresh checkout from the already-open signed-in storefront. | The memory change is real, but the denied role and exact-table Deny remain. The checkout returns the denied failure with no order or stock write. Ask the diagnostic question, start Recover privately, and go directly to the matched original trace. The constructor view is backup only. |
| S1 - Reviewed case | Use the captured source at its investigation reference time. Ask what an acceptable recommendation should do, normalize the answer to **Restore inventory access**, and open the prepared reviewed case. | Expectations are reviewed before scoring. S1 has no verdict. |
| S2 - Evaluated faulty candidate | Keep the same faulty candidate and score its saved session once. Introduce two checks, ask once **"Do the logs support the diagnosis?"**, then show the matching actual action and one current calibrated semantic verdict. Show one clock-calibration pair and move on. | The deterministic action and value fail; the target and other required findings are separate facts. The semantic result is advisory and does not qualify a release. Do not rerun the agent. |
| S3 - Short development repair | Edit only the recommendation rule in the prepared development workspace. Run a fresh candidate against the same case and judge, then compare it with the retained faulty baseline. | The prompt changed, while case, evidence boundary, tools, permissions, model target, and judge stayed fixed. A pending or failed result remains pending or failed. |
| S4 - Developer experiment | Start the normal Strands experiment as soon as the authenticated S3 source is ready, aiming for 30:00. If that source is unavailable, use the independent prepared S4 checkpoint and label it prepared. Hand the participant the S5 terminal immediately. Show the denial row before the throttling row around 36:00-37:00, using a matching recorded pair by 37:00 if needed. | S4 provides repeatable development feedback. It does not qualify the prepared serving package. |
| S5 - Release gate | The participant edits only the prompt, predicts the result, and pushes the regression to `demo-deploy` by 35:00 while S4 continues. Show status at 35:05. At 50:00 use the private presenter kit to run `python3 gate_packet.py --callback` and inspect the result. The [attendee guide](attendee-guide.md#the-rejected-push) shows the same rejection in public CI. Keep the prepared exact package serving until the gate completes. | Deterministic failures reject automatically; otherwise human semantic review decides. A rejected candidate leaves the qualified repaired package in place. There is no S6. |

## Evidence rules

Keep these distinctions visible throughout the talk:

- A saved trace is evidence of that execution, not proof that a later edit ran.
- S2 scores the saved faulty session once. S3 and S4 run fresh development candidates.
- S3 and S4 use the same reviewed case and current calibrated judge for advisory feedback.
- The S5 gate evaluates the exact package being proposed, not a trace from another candidate.
- The live repaired incident is a separate new alarm, run, action, and request outcome.
- The capacity scenario requires actual demand, native metrics, caller evidence, and business outcomes at both caps. A cap readback or quiet request is not proof of surge recovery.
- Missing, pending, incomplete, or recorded evidence keeps its status. It is never silently promoted to success.

For the scenario invariants, see [demo scenarios](demo-scenarios.md). For the implementation and release boundary, see [evaluations](evaluations.md), [the operations agent](components/operations-agent.md), and [deployment](deployment.md). Preparation and cleanup belong in [preparation](preparation.md) and [cleanup](cleanup.md); maintainer and reference-run material is linked from the [attendee guide](attendee-guide.md).
