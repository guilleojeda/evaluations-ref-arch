# Demo cue sheet

The complete talk is 60 minutes, including presentation, live operation, code edits, questions, and buffer. S0–S5 remain internal capability checkpoints rather than the public section order.

## Before the room opens

- [ ] Confirm the correct AWS target and presenter controller access.
- [ ] Verify that the controller baseline matches the current trusted deployment generation, healthy aliases, baseline memory/version and capacity settings, expected Inventory table policy, and no unresolved checkouts.
- [ ] Record the real business-data baseline after a fresh verification checkout, including its stock effect.
- [ ] Observe the real alarm in **OK** with its alarm-to-agent path ready for a new incident.
- [ ] Select S0 and the intentionally faulty candidate; verify no evaluation case, evaluator, score, or gate is active.
- [ ] Open the application view, controller dashboard, live agent report view, editor, evaluation results, and AgentCore Observability for later trace inspection.
- [ ] Prepare actual saved runs and results for delays or the capacity case. Label each **recorded** and retain its event/run identity.

## Working run of show

| Minutes | Section | Stage | Activity | Expected wait |
| --- | --- | --- | --- | --- |
| 0–5 | Does the recommendation actually fix the problem? | S0 | Introduction to evaluations |  |
| 5–11 |  | S0 | Example and agent failure | Alarm and agent report: ~2–3 min; configuration change: ~1 min; telemetry ingestion: 2–5 min |
| 11–15 |  | S0 | Code walkthrough and audience question | Application recovery: ~1–2 min |
| 15–18 | What did the agent actually do? | S0 | Inspect the execution in AgentCore Observability |  |
| 18–23 | From failure to test case | S0 -> S1 -> S2 | Construct one case, load the prepared dataset, and start baseline evaluation | Baseline evaluation: ~5 min |
| 23–28 |  | S2 | Explain judge model selection, calibration, holdouts, and repeated runs |  |
| 28–30 |  | S2 | Inspect baseline evaluation failures |  |
| 30–31 |  | S2 -> S3 | Change the prompt and run the changed agent | Execution and evaluation, including telemetry: ~8 min |
| 31–36 | The developer experience of evals | S3 -> S4 | Show the Strands in-code experiment workflow |  |
| 36–39 |  | S4 | Present prepared measurements, evaluation costs, and limitations |  |
| 39–40 |  | S4 | Compare candidate results and push the repair | Deployment: ~4 min |
| 40–44 |  | S4 -> S5 | Add the experiment to CI and explain cost per run |  |
| 44–48 |  | S5 | Repeat the incident with the deployed agent | Alarm and agent report: ~2–3 min; corrective action: ~1 min |
| 48–54 |  | S5 | Introduce the prepared prompt regression and show CI rejection | CI evaluation: ~5 min |
| 54–55 | Closing | S5 | Deliver the approved closing |  |
| 55–60 |  | S5 | Questions and buffer |  |

Waits are provisional operation durations and can extend beyond the block that starts them. The changed-agent estimate includes telemetry. AWS documents the [2–5-minute telemetry ingestion wait](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/ondemand-evaluations-prereqs.html); the other durations need measurement.

The approved closing is:

> “Your agent is non-deterministic, but you can still test whether its behavior is acceptable. First define what good looks like. Then check whether your evaluations recognize it. Finally, use them to improve the agent and stop regressions before they ship.
> Evaluations passing doesn’t mean the agent can never fail. But at least your release decision now has evidence behind it.
> Without that evidence, you’re hoping nothing goes wrong. Hope is not a strategy. Do evals.”

## Presenter cues

### Does the recommendation actually fix the problem?

#### Opening live incident

1. Verify the healthy starting state, expected Inventory table policy, and real alarm **OK**. Start the bounded ordinary catalog workload and, if useful, sparse fresh checkout probes within the controller's recorded budgets.
2. Activate the **inventory-access-denied** scenario. The narrow policy Deny causes the Inventory read to fail while application code and aliases remain healthy.
3. Observe the actual alarm and open only the live agent report whose event identity matches it. Show the controller observations and report output first. The agent investigates through read-only tools, choosing its own relevant queries, time windows, and query order; do not inspect its trace or tool execution yet. It receives no preassembled incident packet or hidden scenario label.
4. Show the initial candidate's exactly one proposed action: **Increase memory — INVENTORY — larger MB**. Explain that an agent proposal does not authorize or execute the change.
5. Independently apply that selected controller action. Show the configuration readback and the invoked-version memory allocation change, with application code and other settings preserved. The action does not generate requests or determine whether the incident is resolved.
6. Separately start or continue ordinary traffic after the action. Show the access-denied failure persists because the table-policy Deny remains. Keep this request evidence distinct from the memory action's configuration result.
7. Preserve the bounded, sanitized source capture needed to investigate the incident before restoring settings; this is data capture, with case review and verdicts reserved for later stages. Do not delay this source configuration capture until after **Recover**.
8. After the opening request observation, stop producers and settle outstanding work, then request **Recover**. Verify recovery and observe the alarm returning to **OK** before the second live incident. **Recover** restores the current deployment generation's baseline memory/version, capacity, policy, and healthy aliases, retains business data, and ends the live fault. It is distinct from destructive **Reset**; if a full reset is needed, use the scenario contract's new `productVersion` and order/stock reset semantics.

After Recover, do not query the recovered application as though the old incident were still active. Later regression executions use the reviewed case's versioned, queryable captured evidence for all four tools at its explicit investigation reference time, with no live fallback. Keep each execution's identity distinct from the original alarm identity. The recovered/stale-alert condition remains a useful temporal control case: it may be represented by a qualifying later investigation or by offline regression over captured reference-time evidence. When it is replayed offline after recovery, the old-alert concern requires a separately identified later reference time and captured post-recovery evidence because an earlier report did not know the future. It is not a third live incident. Keep the originating ALARM identity selected when the current alarm returns to OK; discover the actual matching durable run after missed polls or restart. A fresh corrected live run requires a newly observed alarm **OK**, the same failure induced anew, and its own new alarm/event/run. The memory action and Recover do not trigger an agent run.

#### Initial code walkthrough

Walk through the initial agent, application, and controller code. Ask what should be code-checked and what needs a judge. Keep this walkthrough within the ten-minute opening example-and-code block.

### What did the agent actually do?

#### AgentCore Observability

Open AgentCore Observability and inspect the matched execution, read-only tools, selected windows, query order, and evidence that led to the report. Keep the execution identity tied to the original alarm/run. This is the first trace inspection; the opening report and controller views intentionally came first.

### From failure to test case

#### Case construction

Construct exactly one reviewed case completely from the preserved source capture: case identity and reference time, expected diagnosis, required evidence, expected action, and target. Then open the separately prepared dataset. Do not imply a fixed dataset size; any illustrative “50” is not a required case count. Show deterministic code checks for the action and target separately from judge assessment of evidence and diagnosis. Start the baseline AgentCore evaluation over already captured actual executions.

#### Judge model selection

During the existing calibration explanation, briefly describe choosing the judge separately from the agent where configuration is supported: AgentCore built-in judges have fixed models, while custom judges and Strands model evaluators offer choices. Test supported candidates against human-reviewed examples, then weigh false passes, false failures, cost, and latency. A larger model is a candidate to measure, not an automatic quality guarantee. Keep the judge and rubric fixed for the agent comparison; changing either requires checking calibration again.

### The developer experience of evals

#### Prompt change and experiment workflow

Keep the prompt repair and the development experiment visibly separate. The prompt edit is the candidate change. The Strands workflow then runs the cases, task, evaluator, and experiment, and CI automates that workflow. The fresh candidate has its own execution and result identity. An old trace cannot establish that the changed candidate was executed.

#### Evaluation cost in development and CI

In the 36–39 measurements block, show one measured complete experiment's cost, split between agent executions, scoring, and applicable service overhead, alongside its feedback time. State the case count, repetitions, judge configuration, pricing date, and what is included. Explain that repeated local experiments add cost; scoring a saved trace does not rerun the agent or test a changed candidate.

During the 40–44 CI block, point out that this cost recurs each time the required workflow runs, with CI runner time and telemetry waits also affecting feedback. Focused local runs can shorten iteration, while the release gate retains its required suite. Use the [cost and judge-selection notes](evaluations.md#evaluation-cost-and-judge-model-selection) for questions; do not give an unmeasured dollar estimate.

#### Repaired live incident

After the deployment handoff, use the controller to reconcile and verify the new generation's healthy baseline before starting another incident. Observe the real alarm **OK**, induce the same Inventory access failure anew, and observe the new alarm and its matching new agent run/report. Show the report and controller observations first. The repaired candidate recommends **Restore inventory access**; the presenter applies that action independently, reads back the policy state, and sends fresh Inventory requests after propagation. Show those requests succeeding. This is the second valid live incident, with its own alarm/event/run identity. The matching report and fresh request evidence establish this demonstration step without waiting for another trace-ingestion cycle.

### Closing

Use the approved closing above verbatim, then leave the final block for questions and operational buffer.

## Backup capability checkpoints

### S1–S5 editing and result cues

- **S1:** Review the captured trace and queryable source evidence, identify the case version and reference time, and review expectations before evaluation. For access denied, the reviewed case expects the denied-read diagnosis grounded in the relevant evidence and **Restore inventory access** for the expected Inventory table policy. Show the provenance and expectations; do not show a pass/fail verdict yet.
- **S2:** Add deterministic assertions for the action and target, semantic diagnosis and grounding criteria, judge configuration, and AgentCore evaluation results. For the opening example, INVENTORY is the correct target but **Increase memory** is the wrong action; show that failure reason. A separate wrong-target proposal must fail its target check, while multiple justified numeric targets within the reviewed bounds are accepted. Both evaluator types are introduced here; the candidate remains faulty through S2.
- **S3:** Make and identify the prompt-only candidate repair. Keep the model, tools, permissions, and report behavior fixed. Execute the fresh candidate against the same reviewed cases and criteria, compare it with the original, and leave pending results visibly pending; introducing S3 does not imply a pass.
- **S4:** Keep the repaired candidate and connect the local Strands experiment entrypoint across the case, task, evaluator, report, and comparison. Evaluate the existing reviewed local release policy before the first deployment; deployment is an action, not another stage.
- **S5:** Keep the repaired candidate and run the same experiment and release policy in CI before deployment. Failed or incomplete required results block deployment. The prepared friend's prompt regression is another candidate evaluated at S5; there is no S6.
- Show the actual remedy outcomes separately from evaluation: after increasing the inventory concurrency cap, repeat the same bounded workload and compare actual delivered demand and outcomes at the current raised cap; the presenter separately applies **Restore inventory access**, then runs ordinary reads and shows successful access after policy propagation. If success is not observed, report the effect as incomplete instead of inferring health. Do not infer application health from the proposal or configuration readback.
- If either outcome cannot be demonstrated live, use a clearly labeled actual saved execution with its matching event/run and action/request evidence. For capacity, show that the repeated bounded workload used comparable delivered demand and the raised cap remained active; the repeat does not automatically reactivate the fault or restore the cap. A repeat may not create a new alarm or agent run. A fresh alarm-driven corrected run requires an observed **OK**, a new incident, and a matching event/run.
- Show the release policy result and its reasons, including any incomplete evaluation, and the pending source/agent artifact identity it evaluated before deployment. Evaluations assess the proposal and investigation; they do not apply controller actions or claim that the application recovered.

### Capacity overload and separate remedy observation

If time and rehearsal allow a live capacity case, verify a healthy baseline and observe the actual alarm **OK** first. Start the bounded catalog surge, inspect the actual alarm and matching agent run, and show the corrected candidate recommending increased reserved concurrency for INVENTORY. The presenter applies that cap increase independently; its readback is only configuration evidence. Stop or pause the first workload phase as needed, then explicitly repeat the same bounded workload at the current raised cap. Compare actual delivered demand, request outcomes, and throttling evidence across the phases. Do not reset the raised cap or reapply the incident between the action and comparison; the repeated workload does not promise a new alarm or agent run. Recover only after the remedy observation is complete.

If the live sequence does not fit, show an actual saved capacity run with the matching event/run, action readback, and separate post-action traffic observations. Label it recorded. Do not claim a capacity remedy from the corrected recommendation or an evaluation score alone.

### Recovered/stale alert cue

Use a genuine originating event, retained incident evidence, and timestamped post-recovery requests. Assess only an actual investigation that queried the post-recovery evidence. If the saved S0 report predates recovery, do not score it as if it knew that later state. Use a reviewed replay with its original event and explicit reference time when there is no qualifying live run. When evidence supports no action, **Other** with a reason is acceptable; when it does not support a conclusion, **Other** should explain the uncertainty. Do not fabricate an alert or manually invoke the agent to create this case.

### Fresh runs, saved evidence, and recovery

- Before each new alarm-driven incident, observe the actual alarm **OK** and confirm the event-to-agent path is ready. Match a genuine event to its run ID. Dashboard polling does not invoke the agent; do not manually invoke it as a substitute.
- A saved trace is evidence of that recorded execution. Label it as recorded; do not present rejudging it as a fresh execution of the repaired candidate. A new candidate execution against captured evidence is a labeled regression run with its own identity.
- A targeted action changes and reads back the chosen configuration only. It does not create traffic. A later independent request or workload is required to observe application behavior.
- Stop traffic and settle uncertain requests before recovery or reset. Restore baseline memory/version, caps, policy, and aliases. Recovery preserves business data; a full reset follows the defined Orders/Inventory and productVersion semantics.
- If automatic deployment intervenes, pause the presentation's controller operations through the deployment handoff. Reconcile and verify the new generation's baseline before resuming; do not use the old baseline or reset budgets merely because code changed. The [deployment contract](deployment.md#deployment-and-controller-baseline) owns the sequence.
- If the alarm, agent, or evaluator is slow, show an actual saved run/result while leaving its recorded status visible. Never fake an alarm or silently substitute a manual invocation.

Detailed action, workload, and recovery behavior belongs to the [controller specification](components/failure-controller-behavior.md) and [scenario contracts](demo-scenarios.md). This cue sheet supplies the presentation order, not a second component contract.

## Remaining rehearsal preparation

- [ ] Settle how S0–S5 checkpoints and candidate versions are selected and packaged.
- [ ] Write the actual live edits and commands after implementation; do not use placeholder or invented commands on screen.
- [ ] Make the initial Inventory memory defect reproduce reliably and prepare the explicit agent repair.
- [ ] Calibrate supported numeric capacity and memory targets, bounded load settings, and comparable delivered demand. Exact values remain unselected until measured.
- [ ] Time alarm, agent, telemetry, and evaluation waits; record replay locations and event/run identities.
- [ ] Select the judge rubric/model, evaluator paths, and release-gate criteria before rehearsal results are presented.
