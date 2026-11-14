# Demo cue sheet

The complete talk is 60 minutes, including presentation, live operation, code edits, questions, and buffer. S0–S5 remain internal capability checkpoints rather than the public section order.

The [slides plan](slides-plan.md) records slide numbers, content, purposes, and transitions between slides and actual screens. This cue sheet owns presenter prompts and operating steps.

## Before the room opens

- [ ] Confirm the correct AWS target and presenter controller access.
- [ ] Verify that the controller's original Inventory cap is the current release baseline, 16, and that its current cap is separately recorded; first/new-generation adoption starts at 16. Checkout stays unreserved. Also verify healthy aliases, baseline memory/version, expected healthy role-backed Inventory access state, and no unresolved checkouts.
- [ ] Record the real business-data baseline after a fresh verification checkout, including its stock effect.
- [ ] Observe the real alarm in **OK** with its alarm-to-agent path ready for a new incident.
- [ ] Select S0 and the intentionally faulty candidate; verify no evaluation case, evaluator, score, or gate is active.
- [ ] Open the application view, controller dashboard, live agent report view, editor, evaluation results, and AgentCore Observability for later trace inspection.
- [ ] Prepare actual saved runs and results for delays. Add a capacity case only after its profile has been calibrated for the target environment and the measured comparison has been rehearsed; label saved runs **recorded** and retain their event/run identity.

## Working run of show

| Minutes | Section | Stage | Activity | Expected wait |
| --- | --- | --- | --- | --- |
| 0–5 | Does the recommendation actually fix the problem? | S0 | Introduction to evaluations |  |
| 5–11 |  | S0 | Example and agent failure | Alarm and agent report: ~2–3 min; configuration change: ~1 min; telemetry ingestion: 2–5 min |
| 11–15 |  | S0 | Code walkthrough and audience question | Application recovery: ~1–2 min |
| 15–18 | What did the agent actually do? | S0 | Inspect AgentCore Observability; optional audience choice of first view |  |
| 18–23 | From failure to test case | S0 -> S1 -> S2 | Construct one case with audience input, load the prepared dataset, and start baseline evaluation | Baseline evaluation: ~5 min |
| 23–28 |  | S2 | Audience judging exercise; explain judge model selection, calibration, holdouts, and repeated runs |  |
| 28–30 |  | S2 | Inspect baseline evaluation failures |  |
| 30–31 |  | S2 -> S3 | Change the prompt and run the changed agent | Execution and evaluation, including telemetry: ~8 min |
| 31–36 | The developer experience of evals | S3 -> S4 | Show the Strands in-code experiment workflow |  |
| 36–39 |  | S4 | Present prepared measurements, evaluation costs, and limitations |  |
| 39–40 |  | S4 | Compare candidate results and push the repair | Deployment: ~4 min |
| 40–44 |  | S4 -> S5 | Add the experiment to CI and explain cost per run |  |
| 44–48 |  | S5 | Repeat the incident with the deployed agent | Alarm and agent report: ~2–3 min; corrective action: ~1 min |
| 48–54 |  | S5 | Audience participant types the prepared prompt regression; show CI rejection | CI evaluation: ~5 min |
| 54–55 | Closing | S5 | Deliver the approved closing |  |
| 55–60 |  | S5 | Questions and buffer |  |

Waits are provisional operation durations and can extend beyond the block that starts them. The changed-agent estimate includes telemetry. AWS documents the [2–5-minute telemetry ingestion wait](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/ondemand-evaluations-prereqs.html); the other durations need measurement.

The approved closing is:

> “Your agent is non-deterministic, but you can still test whether its behavior is acceptable. First define what good looks like. Then check whether your evaluations recognize it. Finally, use them to improve the agent and stop regressions before they ship.
> Evaluations passing doesn’t mean the agent can never fail. But at least your release decision now has evidence behind it.
> Without that evidence, you’re hoping nothing goes wrong. Hope is not a strategy. Do evals.”

## Presenter cues

### Does the recommendation actually fix the problem?

#### Opening question and evaluation introduction

On the title slide, ask aloud: “How would you know if your latest prompt change made your agent unsafe to ship?” Use the brief status-report example on slides 02–03 to define evaluation and show how different wording can preserve the same requirement. Finish the introduction in the opening five minutes. Use slide 04 to introduce the application, agent, and operator, then show slide 05 immediately before switching to the live demonstration.

#### Opening live incident

1. Verify the healthy starting state, expected healthy role-backed Inventory version, and real alarm **OK**. Start the bounded ordinary traffic profile and, if useful, sparse fresh checkout probes as separate bounded actions.
2. Activate the **inventory-access-denied** scenario. Selecting the prepared denied version causes the Inventory read to fail while checked application code, release, memory and capacity remain unchanged.
3. Observe the actual alarm and open only the live agent report whose event identity matches it. Show the controller observations and report output first. The agent investigates through read-only tools, choosing its own relevant queries, time windows, and query order; do not inspect its trace or tool execution yet. It receives no preassembled incident packet or hidden scenario label.
4. Show the initial candidate's exactly one proposed action: **Increase memory — INVENTORY — larger MB**. Explain that an agent proposal does not authorize or execute the change.
5. Independently apply that selected controller action. Show the configuration readback and the invoked-version memory allocation change, with application code and other settings preserved. The action does not generate requests or determine whether the incident is resolved.
6. Separately start or continue ordinary traffic after the action. Show the access-denied failure persists because the selected version still uses the denied execution role and permanent exact-table Deny. Keep this request evidence distinct from the memory action's configuration result.
7. Preserve the bounded, sanitized source capture needed to investigate the incident before restoring settings; this is data capture, with case review and verdicts reserved for later stages. Do not delay this source configuration capture until after **Recover**.
8. After the opening request observation, stop producers and settle outstanding work, then request **Recover**. Verify recovery and observe the alarm returning to **OK** before the second live incident. **Recover** restores the saved baseline only while its deployment generation is still current, retains business data, and ends the live fault. A whole-demo restart uses confirmed **Reset**: close old checkout pages, stop/drain work, reconcile to the current successful release, preserve the prior run, replace the canonical SKU at stock 1,000 under a new UUID `productVersion`, delete old Orders, then verify one new order and stock 999. Reset creates the new run/session and leaves traffic stopped. If Reset is interrupted, keep the run unusable and use a new confirmed action with a fresh ID/version after the old execution/drain window ends; never continue or reuse the old reset action. Retain archived unknown outcomes as unknown. See the [Reset contract](components/failure-controller-behavior.md#reset-demo).

After Recover, do not query the recovered application as though the old incident were still active. Later regression executions use the reviewed case's versioned, queryable captured evidence for all four tools at its explicit investigation reference time, with no live fallback. Keep each execution's identity distinct from the original alarm identity. The recovered/stale-alert condition remains a useful temporal control case: it may be represented by a qualifying later investigation or by offline regression over captured reference-time evidence. When it is replayed offline after recovery, the old-alert concern requires a separately identified later reference time and captured post-recovery evidence because an earlier report did not know the future. It is not a third live incident. Keep the originating ALARM identity selected when the current alarm returns to OK; discover the actual matching durable run after missed polls or restart. A fresh corrected live run requires a newly observed alarm **OK**, the same failure induced anew, and its own new alarm/event/run. The memory action and Recover do not trigger an agent run.

#### Initial code walkthrough

Walk through the initial agent, application, and controller code. Ask what should be code-checked and what needs a judge. Keep this walkthrough within the ten-minute opening example-and-code block.

### What did the agent actually do?

#### AgentCore Observability

Open AgentCore Observability and inspect the matched execution, read-only tools, selected windows, query order, and evidence that led to the report. Keep the execution identity tied to the original alarm/run. This is the first trace inspection; the opening report and controller views intentionally came first.

Optionally ask “Logs or configuration—which would you inspect first?” Open the selected view first, then cover the other relevant evidence and finish the same explanation. Prepare both short routes through the matched execution; this choice changes the order of inspection, not the agent's recorded investigation. With no clear response, use the rehearsed order. Skip the choice when time is tight.

### From failure to test case

#### Case construction

Construct exactly one complete reviewed case from the preserved source capture. Show its identity, alarm context, incident window and investigation reference time, versioned evidence references, expected diagnosis, action and target, and unacceptable behavior. At the expectation field, ask “What should an acceptable recommendation do here?” Take one short action/target or one-sentence expectation. Check it against the evidence, restate the accepted meaning, and enter it into the prepared case structure. The denied-read case requires restoring Inventory access by selecting the healthy role-backed version at the current memory; if an answer is unsupported, explain briefly and use that reviewed expectation. If nobody responds, supply it yourself.

Keep the accepted expectation visible for the later CI callback. Review and normalize audience wording into case data; do not insert it as executable code, an agent instruction, or a new judge rubric. Finish review before baseline evaluation and keep the case and criteria fixed through the candidate comparisons. Then open the separately prepared dataset. Do not imply a fixed dataset size; any illustrative “50” is not a required case count. Show deterministic code checks for the action and target separately from judge assessment of evidence and diagnosis. Start the baseline AgentCore evaluation over already captured actual executions.

#### Audience judgment and calibration

On slide 16, show one actual prepared report alongside the relevant evidence. Choose a report that proposes the correct Inventory access restoration and healthy-version target but gives a plausible diagnosis the evidence does not support. Keep the criteria from the worked case visible. Ask “Would you accept this recommendation? Why?” Take a show of hands and one explanation, then reveal the reviewed verdict and actual model-judge finding. Show the action check passing and use the diagnosis to explain grounding and any agreement or disagreement under the existing rubric. If nobody responds, walk through the reviewed reasoning yourself. Keep the report and findings pending until prepared.

Treat the response as discussion, not measured judge agreement, a new calibration label, holdout evidence, or permission to release. Keep the evaluator and rubric fixed; no live calibration is performed.

#### Judge model selection

During calibration, use one sentence for model selection: “AgentCore built-in judges have fixed models, and where you can choose a judge model separately from your agent, use the least expensive supported model that meets your quality requirements on human-reviewed examples.” Keep model comparisons and configuration details for appendix slide 37. Keep the judge and rubric fixed for the agent comparison.

### The developer experience of evals

#### Prompt change and experiment workflow

Keep the prompt repair and the development experiment visibly separate. After launching the changed candidate, ask “How do we run these same checks after the next edit?” Show the actual local Strands command, then open one failed case and its evidence in the matching report. Connect that result to the case loader, execution task, evaluators, and comparison. The fresh candidate has its own execution and result identity. An old trace cannot establish that the changed candidate was executed. CI later runs the same experiment and policy.

Use the rehearsed repair at 30–31. Keep this one-minute block focused on the edit and launch so the next operation starts on time.

#### Evaluation cost in development and CI

While the candidate comparison is pending, use the 36–39 measurements block to show one measured complete experiment's cost, split between agent executions, scoring, and applicable service overhead, alongside its feedback time. State the case count, repetitions, judge configuration, pricing date, and what is included. Explain that repeated local experiments add cost; scoring a saved trace does not rerun the agent or test a changed candidate. As soon as the comparison is ready, switch to it before continuing cost. Leave remaining detail for the CI block or questions.

#### Candidate comparison and release decision

Show the matched faulty and repaired candidate results under the same reviewed cases and criteria. Pair the two actual repaired findings: denied reads plus the observed alias/version/role/policy support selecting the healthy Inventory version at the current memory, and throttling under a reserved-concurrency cap supports raising the Inventory cap. Show the evidence behind each action and label any saved run recorded. Keep the recommendation findings separate from application remedy outcomes. Before pushing, verify and show the passing S4 local Strands experiment and reviewed policy result for the exact candidate. If the comparison is ready while the S4 result is pending, show the findings and leave the release decision pending.

#### CI and recurring cost

During the 40–44 CI block, point out that this cost recurs each time the required workflow runs, with CI runner time and telemetry waits also affecting feedback. Focused local runs can shorten iteration, while the release gate retains its required suite. Use the [cost and judge-selection notes](evaluations.md#evaluation-cost-and-judge-model-selection) for questions; do not give an unmeasured dollar estimate.

#### Repaired live incident

After the deployment handoff, use the controller to reconcile and verify the new generation's healthy baseline before starting another incident. Observe the real alarm **OK**, induce the same Inventory access failure anew, and observe the new alarm and its matching new agent run/report. Show the report and controller observations first. The repaired candidate recommends **Restore inventory access**; the presenter applies that action independently, reads back the alias/version/role/policy state, and sends fresh Inventory requests through the healthy version at the current memory. Show those requests succeeding. This is the second valid live incident, with its own alarm/event/run identity. The matching report and fresh request evidence establish this demonstration step without waiting for another trace-ingestion cycle.

If rehearsal shows that waiting for the live incident would crowd out the regression, switch to the actual matching recorded incident at the rehearsed cue. Show its alarm/run identity, independent alias/version/role/policy readback, and fresh request evidence. Keep the recorded status visible and any unfinished live result pending.

#### Prepared audience prompt regression

At 48–54, have the friend in the audience propose and type the rehearsed memory-first regression from the [instruction versions](components/operations-agent.md#instruction-versions). After the edit, ask the room “What happens if I push?” Take a quick prediction, then push the candidate through the existing CI gate. Show its fresh execution, the denied-read action check failing, and the release being blocked while the repaired version stays deployed. Cases, evaluators, and policy remain unchanged.

Point back to the expectation written with audience input: “This is the behavior you said we should require.” The participant and edit are prepared; the evaluation and CI result must come from the actual candidate. If the friend is unavailable, type the same change yourself. If waiting for the live CI result would crowd out the rejection callback and closing, switch at the rehearsed cue to an actual matching recorded result. Show its candidate identity, failing case, blocked deployment, and deployed repaired candidate, with recorded status visible. Leave the unfinished live run pending.

### Closing

Use the approved closing above verbatim, then leave the final block for questions and operational buffer.

## Backup capability checkpoints

### S1–S5 editing and result cues

- **S1:** Review the captured trace and queryable source evidence, identify the case version and reference time, and review expectations before evaluation. For access denied, the reviewed case expects the denied-read diagnosis grounded in the relevant evidence and **Restore inventory access** by selecting the healthy role-backed Inventory version at the current memory. Show the provenance and expectations; do not show a pass/fail verdict yet.
- **S2:** Add deterministic assertions for the action and target, semantic diagnosis and grounding criteria, judge configuration, and AgentCore evaluation results. For the opening example, INVENTORY is the correct target but **Increase memory** is the wrong action; show that failure reason. A separate wrong-target proposal must fail its target check, while multiple justified numeric targets within the reviewed bounds are accepted. Both evaluator types are introduced here; the candidate remains faulty through S2.
- **S3:** Make and identify the prompt-only candidate repair. Keep the model, tools, permissions, and report behavior fixed. Execute the fresh candidate against the same reviewed cases and criteria, compare it with the original, and leave pending results visibly pending; introducing S3 does not imply a pass.
- **S4:** Keep the repaired candidate and connect the local Strands experiment entrypoint across the case, task, evaluator, report, and comparison. Evaluate the existing reviewed local release policy before the first deployment; deployment is an action, not another stage.
- **S5:** Keep the repaired candidate and run the same experiment and release policy in CI before deployment. Failed or incomplete required results block deployment. The prepared friend's prompt regression is another candidate evaluated at S5; there is no S6.
- Show the actual remedy outcomes separately from evaluation: after increasing the inventory concurrency cap, repeat the same bounded workload and compare actual delivered demand and outcomes at the current raised cap; the presenter separately applies **Restore inventory access**, then selects the healthy role-backed Inventory version at the current memory and runs ordinary reads. If success is not observed, report the effect as incomplete instead of inferring health. Do not infer application health from the proposal or configuration readback.
- If either outcome cannot be demonstrated live, use a clearly labeled actual saved execution with its matching event/run and action/request evidence. For capacity, show that the repeated bounded workload used comparable delivered demand and the raised cap remained active; the repeat does not automatically reactivate the fault or restore the cap. A repeat may not create a new alarm or agent run. A fresh alarm-driven corrected run requires an observed **OK**, a new incident, and a matching event/run.
- Show the release policy result and its reasons, including any incomplete evaluation, and the pending source/agent artifact identity it evaluated before deployment. Evaluations assess the proposal and investigation; they do not apply controller actions or claim that the application recovered.

### Phase 10 capacity overload and separate remedy observation

Run this complete sequence only after the profile is frozen and the hosted path is rehearsed. Start with healthy ordinary traffic at the release baseline: Inventory cap 16, healthy access/alias and unchanged app code; Checkout stays unreserved. Version 1 requests 15 seconds, 240 catalog starts/second, at most 3,600 attempts and 128 in flight with a 7-second timeout, plus up to 15 one-unit checkout probes on one-second ticks/two slots. These are request bounds, not achieved-rate guarantees. Calibrate and freeze the profile for the target environment from measured starts, skips, arrival timing, and upstream headroom before comparing episodes. Keep Inventory and Checkout memory, code, aliases, access and productVersion unchanged during this comparison.

Click **Start Inventory surge · 15 s**. Show **Catalog totals**, **Checkout totals**, **Production duration**, and **Catalog sample fidelity**; expand **Catalog outcomes and 15 one-second start cohorts**. The saved observation reports actual fetch starts/skips, outcomes, in-flight peak and a bounded sample separately from durable checkout attempts. Read the fixed metric series under **Native CloudWatch observations** for the action's saved start-to-settlement window. At 16, the incident is demonstrated only with actual Inventory caller rejection, positive native Inventory Throttles, a fresh checkout dependency failure without an Order/stock write, and the real ALARM plus its matching investigation. Show the current candidate's actual recommendation exactly as recorded, whether correct or incorrect; the presenter independently chooses the supported capacity action from the evidence.

Select **Stop traffic** and wait for **Stop request receipt**, **Producer admissions** closed, and **Accepted work drain** complete before changing the cap. Apply the Inventory-only capacity action to 32; verify its readback and show that the action sends no requests or changes code, memory, aliases or access. Then click **Repeat same Inventory surge profile** to start a new bounded action. Review the **Same-profile comparison** preconditions, but treat them as a check summary rather than a success verdict. A same-profile label does not prove equal actual demand: compare starts over the same production duration, cohort rates, skips, burst/queue evidence, caller outcomes, native windows and upstream headroom. At 32, require valid results for every observed catalog read and settled successful fresh checkout probes with matching orders/decrements; empty sparse metric series remain unknown, not measured zero. Do not claim the higher cap served the baseline demand when actual starts fell or producer/upstream evidence is missing.

After the comparison, use **Recover** to restore Inventory 16 and the healthy current-generation settings. Preserve the existing productVersion, prior Orders, actions, observations and agent history; verify a fresh quantity-one order/decrement and native OK, then leave traffic stopped. Do not reset data between the two load episodes or force a memory failure on the overload path. If a required live signal is absent, state that the pair is unverified and use only an actual saved run with matching event/action/request identities, clearly labelled **recorded**. A capacity recommendation, setting readback, ordinary successful request or evaluation score alone does not prove surge recovery.

### Recovered/stale alert cue

Use a genuine originating event, retained incident evidence, and timestamped post-recovery requests. Assess only an actual investigation that queried the post-recovery evidence. If the saved S0 report predates recovery, do not score it as if it knew that later state. Use a reviewed replay with its original event and explicit reference time when there is no qualifying live run. When evidence supports no action, **Other** with a reason is acceptable; when it does not support a conclusion, **Other** should explain the uncertainty. Do not fabricate an alert or manually invoke the agent to create this case.

### Fresh runs, saved evidence, and recovery

- Before each new alarm-driven incident, observe the actual alarm **OK** and confirm the event-to-agent path is ready. Match a genuine event to its run ID. Dashboard polling does not invoke the agent; do not manually invoke it as a substitute.
- A saved trace is evidence of that recorded execution. Label it as recorded; do not present rejudging it as a fresh execution of the repaired candidate. A new candidate execution against captured evidence is a labeled regression run with its own identity.
- A targeted action changes and reads back the chosen configuration only. It does not create traffic. A later independent request or workload is required to observe application behavior.
- Stop traffic and settle accepted work before recovery or Reset. Recover strictly restores Inventory's original cap of 16, Checkout's unreserved setting, and the current generation's healthy versions/memory while preserving business data. Reset uses trusted expected settings for the current successful release even if the old baseline is stale or missing; it restores Inventory to 16, preserves the old run's cap observations, creates a new run/version, and does not restart traffic automatically. An interrupted Reset is replaced by a new explicit Reset after its old execution/drain window, never resumed with the same ID.
- If automatic deployment intervenes, pause the presentation's controller operations through the deployment handoff. Reconcile and verify the new generation's baseline before resuming; do not use the old baseline or alter session/run history merely because code changed. The [deployment contract](deployment.md#deployment-and-controller-baseline) owns the sequence.
- If the alarm, agent, or evaluator is slow, show an actual saved run/result while leaving its recorded status visible. Never fake an alarm or silently substitute a manual invocation.

Detailed action, workload, and recovery behavior belongs to the [controller specification](components/failure-controller-behavior.md) and [scenario contracts](demo-scenarios.md). This cue sheet supplies the presentation order, not a second component contract.

## Remaining rehearsal preparation

- [ ] Settle how S0–S5 checkpoints and candidate versions are selected and packaged.
- [ ] Write the actual live edits and commands after implementation; do not use placeholder or invented commands on screen.
- [ ] Make the initial Inventory memory defect reproduce reliably and prepare the explicit agent repair.
- [ ] Use Inventory capacity target 32 and bounded integer input 16–64; verify fresh account headroom and the 100-unit unreserved floor. Checkout has no capacity shortcut. Phase 10 must calibrate bounded surge settings and comparable delivered demand before any load-remedy claim. Memory choices come from the deployed Inventory manifest.
- [ ] Time alarm, agent, telemetry, and evaluation waits; record replay locations and event/run identities.
- [ ] Rehearse the repaired incident and CI rejection fallbacks using matching recorded evidence. Choose the switch cues after measuring the live path and leave time for the result, callback, and approved closing.
- [ ] Select the judge rubric/model, evaluator paths, and release-gate criteria before rehearsal results are presented.
- [ ] Rehearse the three audience interactions with the prepared case fields, one correct-action report with an unsupported diagnosis and its reviewed/model judgments, and the friend's exact prompt edit. Prepare both view orders only if using the optional Observability choice.
