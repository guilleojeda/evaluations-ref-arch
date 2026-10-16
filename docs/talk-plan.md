# Talk plan

**Ship Reliable AI Agents with Strands Evaluation and AgentCore Evaluations** is a 300-level, 60-minute re:Invent Code Talk. The sessions are on December 1 and December 3, 2026; slides are due November 6, 2026. The talk uses a fresh deck and code, with the earlier foundational talk providing conceptual context.

## Audience and intended outcome

The audience is engineers and architects building AI agents on AWS. They already understand prompts, model invocation, and tool use. They need a repeatable way to assess whether changes to an agent are safe to release.

Attendees should leave able to turn observed failures into reviewed cases, assess both answers and the behavior behind them, and connect those results to a release decision. They should understand that variable model output can be evaluated, while recognizing the limits of their cases and evaluators.

The three key lessons are:

1. Turn observed failures into representative, reviewed test cases.
2. Evaluate the evidence and actions behind an answer alongside the answer itself.
3. Make release decisions according to the risk of the findings rather than one generic score.

## Incident story

The opening question is: **Our operations agent gives convincing answers. Can we tell whether a change made it unsafe to ship?**

Open on the Inventory access-denied incident. The S0 candidate investigates a genuine alarm read-only, then recommends increasing memory on INVENTORY. The presenter independently applies that configuration change and separately sends ordinary traffic; the denied read still fails because memory does not remove the Inventory table-policy Deny. Show the configuration readback and later request result as separate evidence. This is an application incident exposing an agent defect, not an agent-controlled remediation.

The application story also includes inventory capacity overload under a positive reserved-concurrency cap. The correct proposal for that reviewed case is an increased Inventory reserved-concurrency cap. After the prompt repair, show this recommendation with evidence from an actual run; if the incident was not run live, label its matching saved run as recorded. The live sequence has two valid incidents: the opening access-denied incident and, after repair and deployment, a newly induced access-denied incident with a new alarm and run. A recovered/stale-alert condition remains a useful temporal control case: it may be represented by a qualifying later investigation or by offline regression over captured reference-time evidence. An old-alert replay concern is not a third live incident. The [scenario contracts](demo-scenarios.md) define incident behavior, and the [demo cue sheet](demo-script.md) holds the presenter sequence.

The agent chooses relevant read-only queries, windows, and query order from available evidence; it is not given a preassembled packet. It proposes exactly one action from the approved menu: increase reserved concurrency on CHECKOUT or INVENTORY to a higher cap, increase memory on CHECKOUT or INVENTORY to a larger MB allocation, restore the expected Inventory table policy, or select Other with a reason, including no change or unknown. The presenter makes any controller action independently. Neither the proposal nor its configuration readback proves an application effect, and the controller action does not generate traffic.

## Code transformation

The project progresses through six capability stages, S0–S5. The core agent stays mostly stable while reviewed cases, evaluations, a developer experiment workflow, and a release gate are added around it. The agent's behavioral versions are **faulty → repaired → regressed**. The deliberate behavior changes are the prompt repair and the friend's later prompt regression.

| Stage | Agent behavior | Difference introduced |
| --- | --- | --- |
| **S0 — Instrumented agent** | Investigates incidents and produces the faulty recommendation. | Starting point: the prompt, four read-only tools, structured report, tracing, and source capture already work. There are no evaluation cases, scores, or release gate. |
| **S1 — Agent with reviewed cases** | Same faulty agent. | Add investigation inputs, captured evidence references and reference times, reviewed acceptable outcomes, and unacceptable behavior. Fully construct one case, then load the separately prepared dataset. |
| **S2 — Evaluated agent** | Same faulty agent; evaluation exposes its defects. | Add deterministic recommendation checks, semantic diagnosis/grounding criteria, judge configuration, and AgentCore evaluation results. The memory action fails for the denied-read case even though INVENTORY is the correct target. Judge findings assess whether the diagnosis and recommendation follow from the available evidence. |
| **S3 — Repaired candidate** | Uses the revised prompt, whose effectiveness must be established by fresh evaluation. | Change the prompt while keeping the model, tools, permissions, and report schema fixed. Execute the changed candidate and compare it with the original against the same reviewed cases and criteria. Retain the faulty candidate so the same checks can still reject it. |
| **S4 — Agent with a developer experiment workflow** | Same repaired candidate. | Add the Strands in-code experiment entry point: load cases, execute the agent, evaluate results, inspect individual failures, and compare candidates locally. Apply the reviewed local release policy before the first repaired deployment. |
| **S5 — Agent with a release gate** | Same repaired candidate remains deployed unless a replacement passes. | Run the same experiment and release policy in CI before deployment. Failed or incomplete required evaluations prevent release. |

The transitions introduce the following changes:

- **S0 -> S1:** Define acceptable behavior.
- **S1 -> S2:** Make that behavior measurable.
- **S2 -> S3:** Change the agent and test the repair.
- **S3 -> S4:** Make evaluation a repeatable developer workflow.
- **S4 -> S5:** Make the release policy automatic.

A transition marks a capability being introduced; it does not imply that an asynchronous evaluation has already completed or passed. Keep pending, failed, and incomplete results visible as such.

**Deployment is an action within the progression.** Deploy the candidate that passed the local release policy at S4, then induce the same failure anew and observe a new alarm, investigation, recommendation, presenter action, and fresh request outcome. The schedule introduces the automated CI gate during deployment, so that second live incident is shown at S5. Deployment itself creates no additional stage.

**The friend's prompt change creates another candidate at S5.** Cases, evaluators, and the release policy stay fixed while the existing gate rejects the prepared regression. There is no S6: the repaired deployed version remains in place.

### Code and data changes shown in the talk

Show the initial agent constructor, prompt, tools, and structured report. Add one complete reviewed case, one recommendation check, and one semantic judge criterion before running the baseline evaluation. The prompt repair is a focused change to the agent's decision rule: select a recommendation that addresses the failure mechanism supported by evidence, and explain uncertainty or recovery when a configuration change is unwarranted. It must be tested across the reviewed cases rather than treated as an established fix merely because the prompt changed.

The Strands segment connects the shared agent constructor, case loader, evaluation task, evaluators, result reporting, and candidate comparison. Runtime and evaluation executions use the same agent construction and tool contracts; live investigations read AWS, while regressions use the approved captured evidence providers. Each candidate chooses its own queries and their order. The CI edit invokes that experiment and applies the same release policy before deployment.

The [instruction versions](components/operations-agent.md#instruction-versions) define the draft faulty, repaired, and regressed prompt edits. The [worked case](evaluations.md#worked-case-inventory-access-denied) connects the denied-read evidence to its checks and semantic criterion, while the [S3 execution path](evaluations.md#s3-fresh-candidate-before-deployment) explains how to score the changed candidate before deployment. Use the [calibration and holdout guidance](evaluations.md#calibration-holdouts-and-repeated-runs) for the five-minute explanation; final prompt wording and actual example results still require implementation and rehearsal.

Prepare alarm delivery, Runtime deployment, tracing, source capture, captured evidence providers, permissions, controller/recovery behavior, and SDK integration before the session. Show the meaningful case, check, rubric, prompt, experiment, and CI changes without building that plumbing live. Calibration and holdouts are explained using prepared examples and reviewed results; they do not introduce another agent stage.

Preserve the same reviewed case meaning and criteria across AgentCore and Strands. Show any required loading or mapping explicitly; automatic interchange between their artifacts is not established. Compare candidates within the same evaluation setup. Publishing Strands scores to a dashboard is distinct from the AgentCore service performing an evaluation, and the talk does not need every check implemented twice.

Code excerpts use Python for the agent and evaluation workflow and TypeScript for the application and controller. The [agent](components/operations-agent.md), [application](components/application.md), and [controller](components/failure-controller.md) documents own component behavior. The [demo progression](demo-progression.md) describes the capability stages, and the [evaluation approach](evaluations.md) owns captured evidence, evaluators, and release-policy details.

### Brief cost and judge-model discussion

During the judges/calibration block, explain that the judge model is a separate choice from the agent model where the evaluator supports configuration. AgentCore built-in judges have fixed models; custom judges and Strands model evaluators provide model choices. Compare supported choices against human-reviewed examples for agreement, false passes, false failures, cost, and latency. Prefer the least expensive model that meets the reviewed quality requirements; size or price alone does not establish that it is a trustworthy judge. Keep its model and rubric fixed when comparing agent candidates, and recheck calibration when either changes.

Use the prepared measurements block to show the cost of one complete experiment, separating fresh agent executions from scoring and applicable service costs. Then explain the development and CI effect: more local experiments and more gated CI runs increase spending, while evaluation and telemetry waits also increase feedback time. Rejudging an existing trace avoids a fresh agent execution but cannot test a changed prompt. Use measured usage and dated pricing, with the case count, repetitions, and evaluator configuration visible; no dollar figure is selected yet.

When adding CI, briefly distinguish focused development runs from the required release suite. Developers can run relevant cases while iterating; the release gate still runs the required checks. Show the cost per required CI run and how often that workflow runs. The [cost and judge-selection notes](evaluations.md#evaluation-cost-and-judge-model-selection) support these points and anticipated questions.

## Run of show

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

## Slide storyboard

Use the AWS-supplied template. The five section titles can become divider slides. Individual presentation blocks can use slides, code, the controller, or evaluation views; they do not each need a section divider.

| Section | Supporting material |
| --- | --- |
| Does the recommendation actually fix the problem? | Evaluation introduction, application and agent overview, output-only failure demonstration, and agent code walkthrough. |
| What did the agent actually do? | AgentCore Observability execution, tool calls, returned evidence, and time windows. |
| From failure to test case | One complete reviewed case, the separately prepared dataset, code checks and judge criteria, judge model selection, calibration and holdouts, baseline failures, and the prompt repair. |
| The developer experience of evals | Strands experiment code, prepared measurements including evaluation and development costs, limitations, candidate comparison, CI integration and cost per run, deployment, corrected live incident, and rejected prompt regression. |
| Closing | Approved closing and resources, followed by questions. |

Speaker notes should identify screen changes, code edits, background operations and expected wait durations, audience questions, and recovery cues. Use actual recorded evidence when needed and keep its provenance visible. Numerical claims in the talk must come from collected measurements.

## Demonstration reliability

Measure the live path before assigning its time budget. Evaluation workflows that collect CloudWatch telemetry can introduce ingestion waits. Prepare actual saved traces and results for delays; use a direct path over captured spans only if rehearsal confirms it. The schedule's non-telemetry numbers are provisional rehearsal estimates, not measurements. Do not claim a latency or service-level duration until it has been measured.

Preprovision the selected environment and prepare saved traces and results from actual executions. Before each alarm-driven incident, observe the real alarm OK and confirm the integration is ready. Match the actual event to the corresponding agent run by alarm ARN and originating ALARM-transition timestamp; retain that identity through OK and discover actual recorded runs after missed polls. Dashboard polling does not invoke the agent, and a manual invocation is not evidence of alarm delivery. Preserve the incident source capture before recovery; review it into a case at S1. Recovery restores the current deployment generation's baseline memory/version, caps, policy, and healthy aliases; a full reset follows the scenario contract's business-data semantics. Both sessions start from a verified baseline.

Automatic deployment takes priority over controller work. If it intervenes, follow the [deployment handoff](deployment.md#deployment-and-controller-baseline), then reconcile and verify the new generation's baseline before resuming. Code deployment preserves business data, prior results, and consumed controller budgets; it does not automatically recover/reset the demonstration or run application probes.

## Source material and open choices

- [Accepted proposal and preparation document](https://docs.google.com/document/d/1k6ed2Q8f0pv7lhDI2_2ypxPAgrxsdnG3SLxNhQNZVWQ/edit)
- [Earlier foundational talk preparation](https://docs.google.com/document/d/1KZf_LgzQtfXIiv_959uFFa0m9Mtt4yAKNV7Ya_WMJ8A/edit)
- [Earlier slides for conceptual context](https://docs.google.com/presentation/d/1W5qtNF6cDbgg_M5gjDrroHUloKVNg-Vk/edit)

The selected incidents, five-section talk, six capability stages, opening faulty recommendation, action menu, and language roles are settled for this plan. The direct CloudWatch alarm-to-Lambda-to-AgentCore Runtime path, durable run records and discovery, canonical originating transition identity, captured queryable regression evidence, and pending-candidate pre-deployment gate are also selected. Implementation details still to complete include event/record wire schemas and lookup mechanics, capture/provider format and coverage, exact case records and rubrics, evaluation settings and release thresholds, and checkpoint packaging. Exact workload and configuration values are owned by the scenario/controller implementation. Start dataset preparation from captured actual runs and reviewed expectations; slot the planned AgentCore observability experience into extraction when its capabilities are clear while retaining the evidence/time contract. The talk does not depend on CloudWatch Omni.
