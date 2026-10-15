# Demo cue sheet

The complete talk is 60 minutes, including the slides, explanations, live operation and edits, results, transitions, questions, and buffer. The schedule below is a working allocation to rehearse; it totals 60 minutes and gives the opening S0 incident up to 12 minutes for the separate memory-action and traffic observations.

## Before the room opens

- [ ] Confirm the correct AWS target and presenter controller access.
- [ ] Verify that the controller baseline matches the current trusted deployment generation, healthy aliases, baseline memory/version and capacity settings, expected Inventory table policy, and no unresolved checkouts.
- [ ] Record the real business-data baseline after a fresh verification checkout, including its stock effect.
- [ ] Observe the real alarm in **OK** with its alarm-to-agent path ready for a new incident.
- [ ] Select S0 and the intentionally faulty candidate; verify no evaluation case, evaluator, score, or gate is active.
- [ ] Open the application view, controller dashboard, matching agent trace/report, editor, and evaluation results.
- [ ] Prepare actual saved runs and results for delays or the capacity case. Label each **recorded** and retain its event/run identity.

## Working run of show

| Minutes | Stage | Presenter cue | Lesson |
| --- | --- | --- | --- |
| 0–5 | Introduction | Introduce the app, controller, and agent; ask, “Would you ship this agent?” | A plausible report needs evidence. |
| 5–17 | S0 — One investigation | Open the Inventory access-denied incident, inspect the real alarm-triggered run, apply the candidate's memory recommendation independently, and make a separate ordinary traffic observation. | Configuration readback does not establish application effect; access-denied errors persist. |
| 17–23 | S1 — Reviewed expectations | Review the captured run and add the case expectations for diagnosis, evidence, action, and target. | Review defines success; this stage has no verdict. |
| 23–32 | S2 — Deterministic checks | Add and run the exact action/target check against the same case and faulty candidate. | The unsupported memory action fails for a concrete reason. |
| 32–42 | S3 — Semantic judgment | Add the evidence/diagnosis criterion and show a genuine AgentCore evaluation of the captured trace alongside the Strands workflow. | The proposal is unsupported because memory cannot remove the policy Deny. Evaluation does not repair the agent. |
| 42–49 | S4 — Repair and decision | Explicitly repair the candidate. Compare faulty and repaired versions on the same reviewed cases; show both correct recommendations, their separately observed remedy outcomes, and the release result. | The faulty version remains runnable; an evaluation result alone does not establish application recovery. |
| 49–52 | Measurements and limits | Present prepared measurements and one known limitation or missed defect. Use recorded results and actual labels. | State only what the evidence supports; do not invent live latency or evaluation results. |
| 52–60 | Questions and buffer | Take questions and recover the demo state if needed. | Leave room for discussion and safe closeout. |

## S0 live incident — Inventory access denied

1. Verify the healthy starting state, expected Inventory table policy, and real alarm **OK**. Start the bounded ordinary catalog workload and, if useful, sparse fresh checkout probes within the controller's recorded budgets.
2. Activate the **inventory-access-denied** scenario. The narrow policy Deny causes the Inventory read to fail while application code and aliases remain healthy.
3. Observe the actual alarm and open only the agent run whose event identity matches it. The agent investigates through read-only tools, choosing its own relevant queries, time windows, and query order. It receives no preassembled incident packet or hidden scenario label.
4. Show the initial candidate's exactly one proposed action: **Increase memory — INVENTORY — larger MB**. Explain that an agent proposal does not authorize or execute the change.
5. Independently apply that selected controller action. Show the configuration readback and the invoked-version memory allocation change, with application code and other settings preserved. The action does not generate requests or determine whether the incident is resolved.
6. Separately start or continue ordinary traffic after the action. Show the access-denied failure persists because the table-policy Deny remains. Keep this request evidence distinct from the memory action's configuration result.
7. Preserve the bounded, sanitized source capture needed to investigate the incident before restoring settings; this is data capture, with case review and verdicts reserved for later stages. Stop producers, settle outstanding work, and use **Recover** to restore the current deployment generation's baseline memory/version, capacity, policy, and healthy aliases. Recovery retains business data and ends the live fault. If a full reset is needed, use the scenario contract's new productVersion and order/stock reset semantics.

After Recover, do not query the recovered application as though the old incident were still active. Later regression executions use the reviewed case's versioned, queryable captured evidence for all four tools at its explicit investigation reference time, with no live fallback. Keep each execution's identity distinct from the original alarm identity. The recovered/stale-alert case needs a separately identified later reference time and captured post-recovery evidence; an earlier report did not know the future. Keep the originating ALARM identity selected when the current alarm returns to OK; discover the actual matching durable run after missed polls or restart. A fresh corrected live run requires a newly observed alarm **OK**, a new incident, and its own matching event/run. The memory action and Recover do not trigger an agent run.

## S1–S4 editing and result cues

- **S1:** Review the captured trace and queryable source evidence, identify the case version and reference time, and review expectations before evaluation. For access denied, the reviewed case expects the denied-read diagnosis grounded in the relevant evidence and **Restore inventory access** for the expected Inventory table policy. Show the provenance and expectations; do not show a pass/fail verdict yet.
- **S2:** Add deterministic assertions for the action and target. For the opening example, INVENTORY is the correct target but **Increase memory** is the wrong action; show that failure reason. A separate wrong-target proposal must fail its target check, while multiple justified numeric targets within the reviewed bounds are accepted.
- **S3:** Add semantic assessment of whether the diagnosis and proposed action follow from the evidence. Show the genuine AgentCore trace evaluation and its supplied evidence/result. Keep this distinct from the in-code Strands workflow; do not imply either system is limited to one evaluator type or run every check twice.
- **S4:** Make and identify an explicit candidate repair. Execute both candidate versions against the same reviewed cases and captured evidence views, allowing each to choose its own queries. The repaired candidate recommends **Increase reserved concurrency — INVENTORY — higher cap** for capacity overload and **Restore inventory access** for the access-denied case. Keep the original faulty candidate available so it still fails the access-denied case.
- Show the actual remedy outcomes separately from evaluation: after increasing the inventory concurrency cap, repeat the same bounded workload and compare actual delivered demand and outcomes at the current raised cap; the presenter separately applies **Restore inventory access**, then runs ordinary reads and shows successful access after policy propagation. If success is not observed, report the effect as incomplete instead of inferring health. Do not infer application health from the proposal or configuration readback.
- If either outcome cannot be demonstrated live, use a clearly labeled actual saved execution with its matching event/run and action/request evidence. For capacity, show that the repeated bounded workload used comparable delivered demand and the raised cap remained active; the repeat does not automatically reactivate the fault or restore the cap. A repeat may not create a new alarm or agent run. A fresh alarm-driven corrected run requires an observed **OK**, a new incident, and a matching event/run.
- Show the release policy result and its reasons, including any incomplete evaluation, and the pending source/agent artifact identity it evaluated before deployment. Evaluations assess the proposal and investigation; they do not apply controller actions or claim that the application recovered.

## Capacity overload and separate remedy observation

If time and rehearsal allow a live capacity case, verify a healthy baseline and observe the actual alarm **OK** first. Start the bounded catalog surge, inspect the actual alarm and matching agent run, and show the corrected candidate recommending increased reserved concurrency for INVENTORY. The presenter applies that cap increase independently; its readback is only configuration evidence. Stop or pause the first workload phase as needed, then explicitly repeat the same bounded workload at the current raised cap. Compare actual delivered demand, request outcomes, and throttling evidence across the phases. Do not reset the raised cap or reapply the incident between the action and comparison; the repeated workload does not promise a new alarm or agent run. Recover only after the remedy observation is complete.

If the live sequence does not fit, show an actual saved capacity run with the matching event/run, action readback, and separate post-action traffic observations. Label it recorded. Do not claim a capacity remedy from the corrected recommendation or an evaluation score alone.

## Recovered/stale alert cue

Use a genuine originating event, retained incident evidence, and timestamped post-recovery requests. Assess only an actual investigation that queried the post-recovery evidence. If the saved S0 report predates recovery, do not score it as if it knew that later state. Use a reviewed replay with its original event and explicit reference time when there is no qualifying live run. When evidence supports no action, **Other** with a reason is acceptable; when it does not support a conclusion, **Other** should explain the uncertainty. Do not fabricate an alert or manually invoke the agent to create this case.

## Fresh runs, saved evidence, and recovery

- Before each new alarm-driven incident, observe the actual alarm **OK** and confirm the event-to-agent path is ready. Match a genuine event to its run ID. Dashboard polling does not invoke the agent; do not manually invoke it as a substitute.
- A saved trace is evidence of that recorded execution. Label it as recorded; do not present rejudging it as a fresh execution of the repaired candidate. A new candidate execution against captured evidence is a labeled regression run with its own identity.
- A targeted action changes and reads back the chosen configuration only. It does not create traffic. A later independent request or workload is required to observe application behavior.
- Stop traffic and settle uncertain requests before recovery or reset. Restore baseline memory/version, caps, policy, and aliases. Recovery preserves business data; a full reset follows the defined Orders/Inventory and productVersion semantics.
- If automatic deployment intervenes, pause the presentation's controller operations through the deployment handoff. Reconcile and verify the new generation's baseline before resuming; do not use the old baseline or reset budgets merely because code changed. The [deployment contract](deployment.md#deployment-and-controller-baseline) owns the sequence.
- If the alarm, agent, or evaluator is slow, show an actual saved run/result while leaving its recorded status visible. Never fake an alarm or silently substitute a manual invocation.

Detailed action, workload, and recovery behavior belongs to the [controller specification](components/failure-controller-behavior.md) and [scenario contracts](demo-scenarios.md). This cue sheet supplies the presentation order, not a second component contract.

## Remaining rehearsal preparation

- [ ] Settle how S0–S4 checkpoints and candidate versions are selected and packaged.
- [ ] Write the actual live edits and commands after implementation; do not use placeholder or invented commands on screen.
- [ ] Make the initial Inventory memory defect reproduce reliably and prepare the explicit agent repair.
- [ ] Calibrate supported numeric capacity and memory targets, bounded load settings, and comparable delivered demand. Exact values remain unselected until measured.
- [ ] Time alarm, agent, telemetry, and evaluation waits; record replay locations and event/run identities.
- [ ] Select the judge rubric/model, evaluator paths, and release-gate criteria before rehearsal results are presented.
