# Evaluation approach

The evaluations assess the operations agent's handling of incidents. They do not score application health. An agent can correctly diagnose an application outage and pass; it can mishandle a healthy or recovered application and fail.

The Python evaluation workflow connects known incident cases, repeated development tests, evaluations of observed agent traces, and a release policy. The [agent component](components/operations-agent.md#software-stages) defines software capabilities and known behavior at S0–S4; [Demo progression](demo-progression.md) places those stages in the talk. S0 is instrumented but has no evaluation cases, evaluators, scores, or gate. Schema validation, access limits, and tracing are runtime capabilities available from the start.

## Evaluation inputs and expectations

Use actual executions of synthetic application incidents. The failure controller records what it activated and verifies the observed failure and recovery. The operations agent sees ordinary logs, metrics, and change history, not the controller's scenario label or expected diagnosis.

Each reviewed case needs enough information to repeat and judge the task: an affected service, originating event and alert time, symptoms, relevant incident window, an explicit effective investigation reference time, evidence reference, provenance, expected acceptable behavior, and the behavior that would be unacceptable. A correct response need not match one exact sentence or one tool sequence.

The initial cases cover traffic-driven inventory capacity overload under an unchanged healthy function, an Inventory table resource-policy Deny that blocks the inventory role's read, and recovery followed by a stale alert. The recovered/stale-alert case is a temporal condition, not a third injected fault. For overload, judge whether the agent uses actual Lambda `Throttles`, function-cap configuration, and invocation evidence to identify whether the observed limit was concurrent execution or synchronous Invoke request rate; rejected invocations do not execute the function or count as its `Invocations` or `Errors`. For access denial, judge whether the agent grounds its diagnosis in the failed read and ordinary table-policy change history. Add cases only when they exercise a distinct relevant behavior; case count alone does not establish representativeness.

Turning a failed run into a case requires reviewing the expected answer and behavior. The failed run's observed response is evidence of what happened, not the definition of success. Dataset extraction can use a future observability interface without changing this review obligation.

## Captured evidence for regressions

Local and CI regression executions use versioned, queryable captures for all four agent tools: logs, metrics, sanitized configuration, and bounded change history. Captures support the case's explicit effective investigation reference time. Keep source observation time, capture time, and that case time distinct; derive as-of configuration only from captured observations or history that supports it. A recovered case uses an explicit later reference time with source observations from after recovery.

Retain the raw source evidence from S0, including configuration before recovery changes it; review and case creation begin at S1. The original trace alone records only the original queries and may not support a different valid investigation. Review the captured coverage against the case's expectations. If the capture cannot support those expectations, the case/evaluation is incomplete; do not fill the gap with live state or score an unsupported expected answer as an agent defect.

The regression tools query only their referenced captures. They do not fall back to current AWS state or include evidence from after the case reference time. Logs and metrics preserve the candidate's requested windows; configuration reflects values at the reference time; bounded history includes only changes effective by then. Relative query windows, freshness, and current-state assessment use the case reference time, with real execution timestamps recorded separately. Partial results and unavailable coverage stay visible in the tool output. Each candidate chooses its own queries, windows, and order. Do not replay a saved tool-call sequence, inject scenario labels or expected answers, or replace candidate outputs. A fixed captured trace can be judged again, but that is not execution of a changed candidate.

Every regression execution has its own identity, separate from the originating live alarm's deduplication identity. Retain the original alarm and case provenance alongside the regression identity so repeated candidates do not appear as new live events or overwrite a live run. The capture file/schema and provider implementation remain open; this contract adds no service or platform requirement.

## Recommendation correctness

The report selects exactly one of **Increase reserved concurrency**, **Increase memory**, **Restore inventory access**, or **Other**. The two function actions identify checkout or inventory and an explicit supported target higher than the observed setting, in concurrency units or MB respectively. Restore inventory access identifies the Inventory table and expected-policy restoration. Other explains the alternative, no-change conclusion, or missing evidence; it is not an executable arbitrary command. See the [agent recommendation contract](components/operations-agent.md) for the complete output behavior.

| Reviewed evidence | Expected recommendation | Incorrect behavior |
| --- | --- | --- |
| Inventory throttles under the selected comparable surge | Increase reserved concurrency on inventory to a supported higher limit justified for that workload | Wrong component, irrelevant policy change, or unsupported claim that another resource change fixes the observed limit |
| Inventory read denied by the selected table-policy change | Restore inventory access | Increase memory or concurrency while leaving the denial intact |
| Fresh requests support recovery within the investigated scope | Other, with a reason for leaving configuration unchanged | Another configuration change based only on historical failure or an old alarm |
| Evidence is insufficient to support a specific action | Other, with the uncertainty and useful next investigation | An invented cause, target, or certainty |

Case expectations may accept more than one justified numeric target within the reviewed bounds; they must not enforce one arbitrary sentence, tool sequence, or exact value. If the agent cannot establish a supported target, it should explain that limitation through Other. Insufficient evidence is not an escape from a case that supplies adequate evidence the agent failed to collect.

The selected initial defect is an inventory memory recommendation for the access-denied case. Keep the same defective candidate through S1–S3: S1 establishes the expected policy restoration without scoring, S2 introduces a deterministic action/target check, and S3 judges diagnosis, evidence support, and the recommendation's reasoning. At S4, execute the pending candidate source/artifact in the local Python Strands path before deployment, using the same agent construction, prompt, tools, report behavior, captured providers, and policy as local and CI regressions. Rerun both incident cases and relevant controls. Bind the result to the evaluated source and agent artifact, prompt, dependency, case, evidence, evaluator, and model versions, then deploy the candidate covered by that result. A trace from the previously deployed candidate cannot replace pending-candidate execution. Retain the old candidate to show that the completed suite still rejects it. An evaluation result identifies a problem; it does not change the agent's behavior.

A correct diagnosis with the wrong action fails recommendation correctness. A lucky correct action with an unsupported diagnosis still needs a grounding finding. These results should remain separately inspectable rather than disappear into one average score.

The controller can successfully apply a larger active-version memory allocation while the table Deny continues to reject requests. That observed consequence supports review of the case. Routine regression scoring can inspect the report and trace against reviewed expectations; it does not require executing a configuration change on every run. An action acknowledgement is never a correctness label or proof of recovery.

## Checks and judgments

| Concern | Useful assessment | Important limit |
| --- | --- | --- |
| Incident scope | Code checks on affected service and relevant query windows | Historical evidence may also be useful; do not reject all historical queries |
| Evidence collection | Trace checks for the observations needed by that case | Allow equivalent valid investigations rather than one mandatory tool order |
| Diagnosis | Judge the claim against collected evidence and reviewed expectations | Plausible wording and temporal correlation do not prove the cause |
| Missing or failed evidence | Check that the response reports the limitation and avoids invented certainty | A tool failure is not proof that the application is healthy |
| Recommendation | Check the selected action, resource, target/value, supporting evidence, and reviewed acceptable outcomes | An available action can be wrong for this incident; a valid enum or successful AWS change does not prove correctness |
| Operator boundary | Check that the report proposes rather than claims to execute a change | The agent's read-only permissions enforce its authority; an evaluator does not grant or enforce runtime permissions |
| Recovered incident | Assess whether the agent distinguishes prior symptoms from current state | A stale alert should not automatically cause a new remediation |

Use model judges for semantic questions with a specific rubric, supplied evidence, and an explanation of the result. Use code for facts and boundaries that can be checked directly. Human review defines expectations, examines disagreements, and handles decisions the available evidence cannot support.

The agent investigates read-only and proposes a response. It may assess current state from timestamped application evidence; it cannot certify recovery from a configuration acknowledgement or claim to have applied the remedy. The presenter independently chooses whether to use a controller shortcut and then separately generates requests to observe its effect. Evaluations assess the investigation and recommendation. Application recovery is established through application evidence, not an agent score.

## Strands and AgentCore roles

Strands Evals provides evaluation in code: cases, tasks, experiments, output and trajectory scoring, custom evaluators, reports, and repeated runs suitable for local development and CI. AgentCore Evaluations provides managed scoring of instrumented agent traces, including on-demand and continuous evaluation of deployed behavior. [Strands quickstart](https://strandsagents.com/docs/user-guide/evals-sdk/quickstart/), [Strands and AgentCore guidance](https://strandsagents.com/docs/user-guide/evals-sdk/how-to/agentcore_evaluation_dashboard/)

Both support code checks and model judges. AgentCore custom code evaluators execute through Lambda; Strands also provides model-based evaluators. Their role in this example follows the execution workflow, not a division by evaluator type. [AgentCore custom evaluators](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/create-evaluator.html)

Use Strands to execute reviewed regression cases around pending candidate changes, with the captured providers described above. Use AgentCore to evaluate actual instrumented traces from deployed investigations. AgentCore trace scoring may remain in CI where useful, but a trace from the deployed old candidate cannot stand in for the required local Python Strands execution of the pending source/artifact. The placement of semantic evaluators remains open within the constraint that the complete S4 policy result is available before deployment; do not require a second environment or run every evaluator twice.

For this example, Strands answers whether a candidate still handles the reviewed incidents correctly before release. AgentCore helps inspect the quality of actual alarm-triggered investigations and discover failures worth reviewing as future regression cases. Both contribute to the same feedback cycle; neither removes the need for reviewed expectations or an explicit agent repair.

Do not implement two copies of every check just to demonstrate both products. A Strands evaluator object, dataset, or report is not automatically an AgentCore evaluator or result. Instrumenting the same agent can support both workflows, and Strands can publish SDK results to a CloudWatch dashboard, but dashboard visibility is distinct from the AgentCore service performing the evaluation.

The useful feedback sequence is:

1. Capture an actual investigation and assess its behavior through AgentCore.
2. Review a quality problem and define acceptable behavior.
3. Turn it into a Strands regression case.
4. Compare faulty and corrected candidates.
5. Feed the selected evaluation evidence into the release policy.

## Offline cases and observed traffic

Controlled cases have known, reviewed causes. They can test diagnosis correctness against that knowledge. Deployed traffic usually does not have a supplied correct answer. Its evaluators can assess evidence support and other observable behavior, but those results alone do not establish the true incident cause.

AgentCore custom evaluators that reference ground-truth placeholders cannot be used in online evaluation configurations. Use the appropriate on-demand or dataset path for such checks. If continuous evaluation is selected, its criteria must be available from the observed trace. [AgentCore ground-truth restrictions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/create-evaluator.html)

## Release decisions

The repository's policy interprets evaluation results; the presence of a score does not automatically authorize shipping. Keep per-case findings and reasons visible. Preserve each evaluator's score meaning rather than assuming different products use interchangeable scales.

| Outcome | Intended meaning |
| --- | --- |
| Pass | The candidate satisfies the defined release criteria for the selected cases and scope |
| Warn | A finding needs review or is acceptable only under the defined lower-risk policy |
| Fail | A required behavior or hard boundary is violated |
| Incomplete evaluation | Required results are missing, pending, invalid, or failed to execute; the run cannot be claimed as passing |

A known incorrect recommendation for either demonstrated incident must fail its required correctness check; do not downgrade the initial memory recommendation to a warning because the action executed or the answer sounded convincing. An operator-boundary violation must not be averaged away by high answer-quality scores. A diagnosis with insufficient evidence can require review when uncertainty is appropriate to the case. Exact numerical thresholds, which warnings permit release, and the complete required case set must be established from the selected risks and reviewed examples before implementation. They are not universal defaults.

The local gate command and CI workflow must use the same policy and captured evidence contract. Keep evaluation execution failures distinguishable from agent-quality failures, and block an automatic pass when required evidence is incomplete.

[GitHub Actions](deployment.md) deploys development changes automatically from S0. At S4, the pending candidate must complete the captured-evidence Strands execution and pass this policy before deployment in that same workflow. Ordinary build/code checks in the earlier stages are separate from agent evaluations.

## Measurements

The accepted proposal promises reproducible measurements of judge agreement, run-to-run stability, false passes, false failures, cost, and latency. Collect these before putting numerical conclusions in the deck.

| Measurement | Evidence to retain |
| --- | --- |
| Judge agreement | Independent human assessments under the same rubric, judge results, and reviewed disagreements |
| Run-to-run stability | Repeated results for a fixed case set and explicit candidate, evaluator, and model settings |
| False passes and false failures | Independently reviewed acceptable/unacceptable examples and the resulting decisions |
| Cost | Recorded model usage and applicable service charges or a clearly stated pricing estimate, separated by agent and evaluator work |
| Latency | Timed agent execution and evaluation, with telemetry ingestion or other waits identified separately |

Record case and candidate versions, evaluator criteria/settings, model IDs, run settings, and enough source references to reproduce the reported result. Separate variability in fresh agent executions from variability when judging the same captured trace. These answer different questions.

Do not report invented measurements, universal cutoffs, or production failure rates inferred from a small demo sample. Explain sample size, the tested cases, and remaining uncertainty. The talk should include checks that catch defects and at least one concrete limitation or missed defect.

## Open decisions

The [scenario contracts](demo-scenarios.md) define the two incident families and the recovered/stale-alert condition. The initial access-denied/memory defect and the corrected recommendations are selected. Exact live-event/run wire formats and discovery indexes, concrete capture contents and their file/schema/provider, the implementation of that defect and its repair, additional useful candidate variants, semantic evaluator placement within the predeployment constraint, judge rubrics/models, numerical release thresholds, and measurement repetitions remain open. The [demo script](demo-script.md) records how these cases enter the S0–S4 teaching sequence.
