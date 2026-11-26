# Demo progression

Follow one Inventory failure through six stages, from the agent’s first investigation to a prompt regression that CI rejects. The [talk plan](talk-plan.md) gives the timing and the [cue sheet](demo-script.md) gives the commands. Attendees can [follow the same case in the public repo](attendee-guide.md).

The v5 experiment uses one calibrated Opus 5.5 judge in AgentCore. Its verdict helps the developer review the report. Before a ZIP goes live, CI checks the recommended action and a person reviews the reports and traces for that ZIP.

## Candidate and package boundaries

Start with the faulty agent. In S3, edit its prompt. In S4, test that edit. For the repaired live incident, switch to the package that passed the release gate before the talk. The participant’s S5 push proposes another version. If CI rejects it, the repaired endpoint keeps serving the approved package.

The agent recommends one action. The presenter decides whether to apply it. The report can name either function, but the controller’s memory and capacity shortcuts target Inventory. The report accepts these recommendations.

- Increase reserved concurrency for INVENTORY or CHECKOUT, with a higher cap.
- Increase memory for INVENTORY or CHECKOUT, with a larger allocation.
- Restore inventory access by selecting the healthy role-backed Inventory version at the current memory.
- Other, with a reason for no change or insufficient evidence.

After a change, show the setting, then make a request or repeat the workload to find out whether the service recovered.

## Checkpoints

| State | Audience sequence | Meaning |
| --- | --- | --- |
| S0 - Instrumented agent | Run the genuine alarm-driven access-denied investigation with the faulty candidate. It recommends **Increase memory - INVENTORY - 512 MB**. Apply that recommendation, then use one fresh checkout from the already-open signed-in storefront. | The memory change is real, but the denied role and exact-table Deny remain. The checkout returns the denied failure with no order or stock write. Ask the diagnostic question, start Recover privately, and go directly to the matched original trace. Keep the constructor view in backup material only. |
| S1 - Reviewed case | Use the captured source at its investigation reference time. Ask what an acceptable recommendation should do, normalize the answer to **Restore inventory access**, and open the prepared reviewed case. | Review expectations before scoring. S1 has no verdict. |
| S2 - Evaluated faulty candidate | Keep the same faulty candidate and score its saved session once. Introduce two checks, ask once **"Do the logs support the diagnosis?"**, then show the matching actual action and one current calibrated semantic verdict. Show one clock-calibration pair and move on. | The deterministic action and value fail. Keep the target and other required findings as separate facts. Treat the semantic result as advisory. Do not rerun the agent. |
| S3 - Short development repair | Edit only the recommendation rule in the prepared development workspace. Run a fresh candidate against the same case and judge, then compare it with the retained faulty baseline. | Change only the prompt. Keep the case, evidence boundary, tools, permissions, model target, and judge fixed. |
| S4 - Developer experiment | Start the normal Strands experiment as soon as the authenticated S3 source is ready, aiming for 30:00. If that source is unavailable, use the independent prepared S4 checkpoint and label it prepared. Hand the participant the S5 terminal immediately. Show the denial row before the throttling row around 36:00-37:00, using a matching recorded pair by 37:00 if needed. | Use S4 for repeatable development feedback. Do not use it to qualify the prepared serving package. |
| S5 - Release gate | Have the participant edit only the prompt, predict the result, and push the regression to `demo-deploy` by 35:00 while S4 continues. Show status at 35:05. At 50:00 use the private presenter kit to run `python3 gate_packet.py --callback` and inspect the result. The [attendee guide](attendee-guide.md#the-rejected-push) shows the same rejection in public CI. Keep the prepared exact package serving until the gate completes. | Deterministic failures reject automatically. Otherwise human semantic review decides. A rejected candidate leaves the qualified repaired package in place. |

## Evidence rules

Identify each result by the case and candidate that produced it.

- A saved trace is evidence of that execution, not proof that a later edit ran.
- S2 scores the saved faulty session once. S3 and S4 run fresh development candidates.
- S3 and S4 use the same reviewed case and current calibrated judge for advisory feedback.
- The S5 gate evaluates the exact package being proposed, not a trace from another candidate.
- The live repaired incident is a separate new alarm, run, action, and request outcome.
- The capacity scenario requires actual demand, native metrics, caller evidence, and business outcomes at both caps. A cap readback or quiet request is not proof of surge recovery.
- Missing, pending, incomplete, or recorded evidence keeps its status. It is never silently promoted to success.

For the incident evidence, see [demo scenarios](demo-scenarios.md). For scoring and publication, see the [evaluation guide](evaluations.md), [operations agent](components/operations-agent.md), and [deployment](deployment.md). Use [preparation](preparation.md) and [cleanup](cleanup.md) between performances.
