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

The application story also includes inventory capacity overload under a positive reserved-concurrency cap. The correct proposal for that reviewed case is an increased Inventory reserved-concurrency cap. At S4, show this recommendation with evidence from an actual run; if the incident was not run live, label its matching saved run as recorded. A recovered incident with an old alert supplies a temporal control case, not another injected fault. The [scenario contracts](demo-scenarios.md) define incident behavior, and the [demo cue sheet](demo-script.md) holds the presenter sequence.

The agent chooses relevant read-only queries, windows, and query order from available evidence; it is not given a preassembled packet. It proposes exactly one action from the approved menu: increase reserved concurrency on CHECKOUT or INVENTORY to a higher cap, increase memory on CHECKOUT or INVENTORY to a larger MB allocation, restore the expected Inventory table policy, or select Other with a reason, including no change or unknown. The presenter makes any controller action independently. Neither the proposal nor its configuration readback proves an application effect, and the controller action does not generate traffic.

## Code transformation

S0 is one alarm-triggered investigation and report, with no chat loop, evaluation case, evaluator, score, or release gate. S1 reviews expectations but produces no verdict. S2 adds deterministic checks for behavior and action/target validity. In the opening example, INVENTORY is the correct target but Increase memory is the wrong action; separate wrong-target proposals fail target checks, and numeric checks accept any justified value within reviewed bounds. S3 adds semantic judgment about diagnosis and grounding and demonstrates a genuine AgentCore evaluation of the deployed trace. S4 explicitly repairs the candidate and compares both versions against identical reviewed cases before showing the release decision. The original candidate stays runnable and continues to fail the access-denied case.

The transformation primarily adds evaluation capability around the agent. Code excerpts use Python for the agent and evaluation workflow, and TypeScript for the application and presenter controller. Their component behavior is specified in the [agent](components/operations-agent.md), [application](components/application.md), and [controller](components/failure-controller.md) documents; this talk plan describes the story and screen sequence.

Strands represents the in-code experiment workflow; AgentCore demonstrates evaluation of a deployed agent trace. Local/CI regressions execute the identified candidates against versioned, queryable captures for all four investigation tools at an explicit case reference time. This preserves independent investigation after the live application has recovered. Rejudging a saved trace remains distinct from executing a changed candidate. At S4, the pre-deployment gate binds its result to the pending source and agent artifact identity. Evaluator placement remains open within that constraint, and the talk should not duplicate every evaluation in both systems. The [evaluation approach](evaluations.md) describes the roles.

The detailed S0–S4 outcomes are in [Demo progression](demo-progression.md). The visible transition is: wrong executable remedy, reviewed expectation, deterministic failure, semantic explanation, explicit candidate repair, and two evidence-backed correct proposals.

## Run of show

The full hour includes presentation, incident operation, code edits, evaluation results, transitions, questions, and buffer. This working schedule totals 60 minutes and reserves up to 12 minutes for the initial S0 incident and its independent memory-action and traffic observations. Rehearsal may shift the allocations; if time tightens, use prepared results for the capacity case without dropping any S0–S4 outcome.

| Minutes | Activity | What the audience learns |
| --- | --- | --- |
| 0–5 | Introduce the incident, agent report, and shipping decision | Why a plausible report needs evidence |
| 5–17 | S0: real access-denied alarm/run, wrong memory action, separate traffic result | A setting change can complete while the application failure persists |
| 17–23 | S1: review the captured run and define expectations | A case is reviewed before it is scored |
| 23–32 | S2: add and run deterministic action/target checks | A concrete mismatch can be detected and explained |
| 32–42 | S3: add semantic judgment and show AgentCore trace evaluation | A groundedness question needs evidence and a clear rubric |
| 42–49 | S4: repair explicitly; compare the same cases and release result | Evaluation can distinguish faulty and repaired candidates |
| 49–52 | Show prepared measurements, limitations, and one missed defect | Evidence supports a bounded claim, not universal safety |
| 52–60 | Questions and recovery buffer | Leave room for discussion and a safe close |

## Slide storyboard

Use the AWS-supplied template and roughly 10–12 core slides, plus backup material. Slides explain the incident, decisions, and results; the editor, controller, application, and evaluation views carry the live sequence.

| Slide role | Content and transition |
| --- | --- |
| Title and outcome | State the title and what attendees will be able to implement |
| Incident and shipping question | Show the denied Inventory read and ask whether the agent is safe to ship |
| Application, controller, and agent | Show the system at a glance and keep incident, action, and investigation distinct |
| S0 report and proposal | Put the access-denied evidence beside the wrong Inventory memory recommendation |
| Independent action result | Show configuration readback, then separate ordinary traffic with the Deny still present |
| S1 reviewed case | Show provenance and expected diagnosis, evidence, action, and target; no verdict yet |
| S2 deterministic result | Show the wrong memory action failing and its reason; show that a separate wrong target fails target validation |
| S3 evidence judgment | Show the rubric, evidence supplied, actual judgment, and a limitation |
| Evaluation workflows | Explain the in-code Strands workflow and genuine AgentCore deployed-trace evaluation |
| S4 repair and comparison | Show the explicit repair, the still-failing original, both evidence-backed correct proposals, and separate observed remedy outcomes |
| Measurements, limits, and takeaways | Present actual prepared evidence, a missed defect, and resources |

Speaker notes should specify screen transitions, code edits, expected observations, audience questions, and recovery cues. Use actual saved runs for slow calls, but label their original event and run identity. Do not fill slides with unmeasured latency claims or results from an execution that did not happen.

## Preparation targets

Only the event dates and slide deadline are externally fixed. These intermediate dates are working targets to organize preparation.

| Dates in 2026 | Target |
| --- | --- |
| October 8–12 | Settle the incident story, selected application incidents, checkpoint outcomes, and storyboard |
| October 13–18 | Prove one case through the selected evaluation paths and build the complete minimum demo |
| October 19–25 | Finish scoped cases and evaluators, collect supported measurements, and time a full rehearsal |
| October 26–November 1 | Complete the deck and demo script; rehearse with someone unfamiliar with the code |
| November 2–5 | Repair confusing or slow sections and check deck/demo consistency |
| November 6 | Submit slides |
| November 7–20 | Rehearse and verify reliability, repository setup, recovery, and resets |
| November 21–30 | Freeze the sequence, verify the event environment, and practice resets |
| December 1 and 3 | Deliver the rehearsed sequence |

The preparation outputs are the talk blueprint, runnable public reference, demo script, actual measured evidence, fresh deck, and rehearsal/reset procedure. Include only measurements that have been collected and whose method and scope can be explained.

## Demonstration reliability

Measure the live path before assigning its time budget. Evaluation workflows that collect CloudWatch telemetry can introduce ingestion waits. Prepare actual saved traces and results for delays; use a direct path over captured spans only if rehearsal confirms it. Do not claim a latency until it has been measured.

Preprovision the selected environment and prepare saved traces and results from actual executions. Before each alarm-driven incident, observe the real alarm OK and confirm the integration is ready. Match the actual event to the corresponding agent run by alarm ARN and originating ALARM-transition timestamp; retain that identity through OK and discover actual recorded runs after missed polls. Dashboard polling does not invoke the agent, and a manual invocation is not evidence of alarm delivery. Preserve the incident source capture before recovery; review it into a case at S1. Recovery restores the current deployment generation's baseline memory/version, caps, policy, and healthy aliases; a full reset follows the scenario contract's business-data semantics. Both sessions start from a verified baseline.

Automatic deployment takes priority over controller work. If it intervenes, follow the [deployment handoff](deployment.md#deployment-and-controller-baseline), then reconcile and verify the new generation's baseline before resuming. Code deployment preserves business data, prior results, and consumed controller budgets; it does not automatically recover/reset the demonstration or run application probes.

## Source material and open choices

- [Accepted proposal and preparation document](https://docs.google.com/document/d/1k6ed2Q8f0pv7lhDI2_2ypxPAgrxsdnG3SLxNhQNZVWQ/edit)
- [Earlier foundational talk preparation](https://docs.google.com/document/d/1KZf_LgzQtfXIiv_959uFFa0m9Mtt4yAKNV7Ya_WMJ8A/edit)
- [Earlier slides for conceptual context](https://docs.google.com/presentation/d/1W5qtNF6cDbgg_M5gjDrroHUloKVNg-Vk/edit)

The selected incidents, five-stage story, opening faulty recommendation, action menu, and language roles are settled for this plan. The direct CloudWatch alarm-to-Lambda-to-AgentCore Runtime path, durable run records and discovery, canonical originating transition identity, captured queryable regression evidence, and pending-candidate pre-deployment gate are also selected. Implementation details still to complete include event/record wire schemas and lookup mechanics, capture/provider format and coverage, exact case records and rubrics, evaluation settings and release thresholds, and checkpoint packaging. Exact workload and configuration values are owned by the scenario/controller implementation. Start dataset preparation from captured actual runs and reviewed expectations; slot the planned AgentCore observability experience into extraction when its capabilities are clear while retaining the evidence/time contract. The talk does not depend on CloudWatch Omni.
