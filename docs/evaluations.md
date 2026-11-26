# Evaluation approach

The evaluations assess the operations agent's handling of incidents. They do not score application health. An agent can correctly diagnose an application outage and pass; it can mishandle a healthy or recovered application and fail.

## Public and prepared routes

The public route is the saved synthetic case and local report checker. Use the
[attendee guide](attendee-guide.md) to follow the talk, or [adapt the
evaluation](adapt-evaluations.md) to run the native Strands workflow with your
own agent. These paths do not require the talk AWS account, presenter
credentials, private evidence, or a live model call unless the walkthrough
explicitly adds one.

The prepared AWS route is the presenter workflow. It uses private case and
evaluator inputs, a named short-lived profile, outside-Runtime telemetry, and
protected publication checks. Use [talk preparation](preparation.md) for the
prepared inputs and [deployment design](deployment.md) for the package and
approval path. Public examples and prepared AWS assets are separate inputs;
one cannot stand in for the other.

### Active model target

In `talk/v5`, the agent and semantic judge use the US Opus 5.5 inference profile, `us.anthropic.claude-opus-5-5`, from `us-east-1`. The calibrated evaluator is `IncidentTriageSemanticSingle_584b1b2b228fbf141f-MqPN3HHgez`, configuration digest `584b1b2b228fbf141f50eb780df5d51c75b56b0ed720fe7717d247527069b5c1`. Its judge configuration sets `maxTokens` to 2000 and omits `temperature`. It returns one advisory `semantic_quality` verdict and reason covering diagnosis support and grounding. Code checks the recommended action, target and arguments.

The metric rubric distinguishes the start of a measurement bucket, the source observation time, and the time the observation became available. A citation uses the source observation time. The prepared S2-S5 inputs select the exact evaluator descriptor. Older records identify the evaluator that produced them, including the original Opus and Sonnet scores and the historical rubric with separate `diagnosis_support` and `evidence_grounding` findings.

On the saved overload report, the revised native judge rejected both bucket-start citations. It accepted a calibration copy with only those two fields corrected. A separate constructed pair confirmed that it accepts a point’s observation time and rejects its availability time when those clocks differ. All nine earlier regression reports received their expected verdicts. In one older S4 report, the judge caught the unsupported coverage claim but accepted an ongoing assessment that relied on the same claim. The categorical verdict and its explanation still warrant separate review.

The repaired candidate ran once on the original November 18 overload case. It cited `20:12:15.471Z` for maximum concurrency 16 and throttle sum 112, described the `20:10Z` measurement bucket, and recommended a trial increase from 16 to 32. The revised judge accepted the saved run and all eight required checks passed. Promoting a Runtime ZIP uses the full release gate described below.

The Python evaluation workflow connects known incident cases, repeated development tests, evaluations of observed agent traces, and a release policy. The [agent component](components/operations-agent.md#software-stages) defines software capabilities and known behavior at S0-S5; [Demo progression](demo-progression.md) places those stages in the talk. S0 is instrumented but has no evaluation cases, evaluators, scores, or gate. S2 introduces deterministic checks, semantic diagnosis/grounding criteria, judge configuration, and AgentCore evaluation results. S4 connects the full local Strands experiment; S5 automates that same experiment and policy in CI. Schema validation, access limits, and tracing are runtime capabilities available from the start.

## Evaluation inputs and expectations

Use actual executions of synthetic application incidents. The failure controller records what it activated and verifies the observed failure and recovery. The operations agent sees ordinary logs, metrics, and change history, not the controller's scenario label or expected diagnosis.

Each reviewed case needs enough information to repeat and judge the task: an affected service, originating event and alert time, symptoms, relevant incident window, an explicit effective investigation reference time, evidence reference, provenance, expected acceptable behavior, and the behavior that would be unacceptable. A correct response need not match one exact sentence or one tool sequence.

The initial cases cover traffic-driven inventory capacity overload under an unchanged healthy function, an IAM Deny carried by the denied Inventory execution role that blocks its read of the Inventory table, and recovery followed by a stale alert. The recovered/stale-alert case is a temporal condition, not a third injected fault. For overload, judge whether the agent uses actual Lambda `Throttles`, function-cap configuration, and invocation evidence to identify whether the observed limit was concurrent execution or synchronous Invoke request rate; rejected invocations do not execute the function or count as its `Invocations` or `Errors`. For access denial, judge whether the agent grounds its diagnosis in the failed read and ordinary alias/version/role/policy evidence and recommends the healthy role-backed version at the current memory. Add cases only when they exercise a distinct relevant behavior; case count alone does not establish representativeness.

Turning a failed run into a case requires reviewing the expected answer and behavior. The failed run's observed response is evidence of what happened, not the definition of success. Dataset extraction can use a future observability interface without changing this review obligation.

## Worked case: Inventory access denied

This table describes the evidence needed to demonstrate a memory recommendation on a reviewed access-denied case. The recorded S2 evidence is summarized below.

| Part of the example | What it must establish |
| --- | --- |
| Case and agent input | The reviewed case retains the actual originating event and alert time, symptoms, incident window, effective investigation reference time, evidence reference, and provenance. The agent receives ordinary alarm context, permitted source scope, and the effective time; it must locate the affected operation. The private scenario cause and expected action stay outside its input. |
| Tool evidence | The actual captured, read-only evidence must support an inventory-role read being denied by the permanent exact-table `GetItem` policy on the denied role, plus the active alias/version/role/policy state and relevant deployment/change history. Prepare captured sources for all four tools; the candidate chooses its own queries, so this does not require calling every tool. |
| Faulty baseline report | The selected defect recommends **Increase memory** for `inventory`, with a larger supported MB value and source references. The report separately assesses current state from the investigated evidence. These are planned report semantics, not a quotation or a claim about an executed run. |
| Reviewed expectation | The evaluator-only expectation is that the denied read is explained through the relevant alias/version/role/policy evidence and the report recommends **Restore inventory access** with the healthy role-backed version at the current memory as the concrete target. Increasing memory or concurrency leaves the denial unresolved. |
| Deterministic check | Require **Restore inventory access**, the Inventory target, and the healthy role-backed version at the current memory. **Increase memory** fails the action check even when `inventory` is the correct target. The correct action label passes only that part of the check; the resource and restoration target still need validation. |
| Semantic judgment | Assess whether the diagnosis connects the failed read and relevant IAM policy evidence to the access problem, and whether the recommendation follows from that evidence. A report may correctly identify the denial and still propose an unsupported memory increase; keep those findings separate. |

To substantiate this example, retain the raw trace and source observations at S0, finish and review this one case at S1 before loading the separately prepared regression dataset, then evaluate the known faulty baseline against the fixed case at S2. The actual case, captured evidence, candidate trace and report, deterministic result, and semantic result must support what the talk says; do not fill in missing facts with illustrative IDs, timestamps, values, or evidence text.

## Captured evidence for regressions

Local and CI regression executions use versioned, queryable captures for all four agent tools: logs, metrics, sanitized configuration, and bounded change history. Captures support the case's explicit effective investigation reference time. Keep source observation time, capture time, and that case time distinct; derive as-of configuration only from captured observations or history that supports it. A recovered case uses an explicit later reference time with source observations from after recovery.

The frozen bundle retains the original observation and acquisition timestamps.
Replay uses them to determine which rows were available at the case reference
time. Tool responses omit archive metadata dated after that cutoff. The model
still sees each eligible row’s timestamps, the requested window and coverage gaps.

Retain the raw source evidence from S0, including configuration before recovery changes it; review and case creation begin at S1. The original trace alone records only the original queries and may not support a different valid investigation. Review the captured coverage against the case's expectations. If the capture cannot support those expectations, the case/evaluation is incomplete; do not fill the gap with live state or score an unsupported expected answer as an agent defect.

The regression tools query only their referenced captures. They do not fall back to current AWS state or include evidence from after the case reference time. Logs and metrics preserve the candidate's requested windows; configuration reflects values at the reference time; bounded history includes only changes effective by then. Relative query windows, freshness, and current-state assessment use the case reference time, with real execution timestamps recorded separately. Partial results and unavailable coverage stay visible in the tool output. Each candidate chooses its own queries, windows, and order. Do not replay a saved tool-call sequence, inject scenario labels or expected answers, or replace candidate outputs. A fixed captured trace can be judged again, but that is not execution of a changed candidate.

Every regression execution has its own identity, separate from the originating live alarm's deduplication identity. Retain the original alarm and case provenance alongside the regression identity so repeated candidates do not appear as new live events or overwrite a live run. The delivered Phase 13 capture schema and provider are the S1 input boundary; any later capture/provider change is a new identified input that requires its own digest and review. Preserve the same case meaning and criteria across evaluation paths without claiming an automatic format interchange.

S4 and S5 record the digest of the replay implementation in the run’s tooling
manifest. A prompt-only comparison requires matching replay tooling. An earlier
S2 or S4 report remains available under the tooling identity that produced it.

## S1: Author, validate, freeze, and hand off

Start with the [verified portable assets](preparation.md#run-a-stage-from-its-prepared-workspace). Follow the [S1 commands](../agent/README.md#review-and-freeze-a-case-s1) to copy the audience draft into a private working directory, edit the expected remedy in the IDE, and run `validate`, `freeze`, and `candidate-input` offline. For direct entry with a prepared case, use its matching case and evidence bundle.

Validation checks provenance, evidence availability at the cutoff, and coverage of the required observations. Freezing binds the reviewed case to those exact evidence bytes. The candidate receives the task and queries the captured evidence through its read-only tools. The expected remedy and review notes stay with the evaluator.

## Recommendation correctness

The report selects exactly one of **Increase reserved concurrency**, **Increase memory**, **Restore inventory access**, or **Other**. The two function actions identify checkout or inventory and an explicit supported target higher than the observed setting, in concurrency units or MB respectively. Restore inventory access identifies the denied Inventory read, the observed alias/version/role/policy evidence, and the healthy role-backed version at the current memory. Other explains the alternative, no-change conclusion, or missing evidence; it is not an executable arbitrary command. See the [agent recommendation contract](components/operations-agent.md) for the complete output behavior.

| Reviewed evidence | Expected recommendation | Incorrect behavior |
| --- | --- | --- |
| Inventory throttles under the selected comparable surge | Increase reserved concurrency on inventory to a supported higher limit justified for that workload | Wrong component, irrelevant policy change, or unsupported claim that another resource change fixes the observed limit |
| Inventory read denied by the scoped IAM policy on the denied version's role | Restore inventory access, targeting the healthy role-backed version at the current memory | Increase memory or concurrency while leaving the denied version active |
| Fresh requests support recovery within the investigated scope | Other, with a reason for leaving configuration unchanged | Another configuration change based only on historical failure or an old alarm |
| Evidence is insufficient to support a specific action | Other, with the uncertainty and useful next investigation | An invented cause, target, or certainty |

Case expectations may accept more than one justified numeric target within the reviewed bounds; they must not enforce one arbitrary sentence, tool sequence, or exact value. If the agent cannot establish a supported target, it should explain that limitation through Other. Insufficient evidence is not an escape from a case that supplies adequate evidence the agent failed to collect.

The selected initial defect is an inventory memory recommendation for the access-denied case. S1 reviews acceptable and unacceptable behavior using evidence from the opening incident. S2 evaluates the captured faulty candidate with explicit final recommendation precedence. At S3, edit the prompt only and compare its fresh execution with the identified S2 baseline on the same cases and criteria. Pending results remain pending. At S4, execute the repaired candidate through the local Python Strands entrypoint that connects case, task, evaluator, report, and comparison. S4 is development feedback only: it does not publish or authorize deployment. Bind the result to the evaluated source and agent artifact, prompt, dependency, case, evidence, evaluator, and model versions. At S5, CI runs the same experiment and policy before deployment; failed or incomplete required results block it, and the exact pending Runtime ZIP remains subject to the later human-approved gate. Use one agent constructor with the same approved live or captured providers across runtime and evaluation. A trace from the previously deployed candidate cannot replace pending-candidate execution. Retain the captured faulty candidate to show that the selected required cases still reject it. An evaluation result identifies a problem; it does not change the agent's behavior.

A correct diagnosis with the wrong action fails recommendation correctness. A
lucky correct action with an unsupported diagnosis fails the current combined
`semantic_quality` verdict; its explanation should identify the diagnosis or
source-grounding defect. Historical multi-mode records keep their separate
findings, but neither contract should disappear into one unlabelled average.

The controller can successfully select a larger qualified version while the denied version's table Deny continues to reject requests. That observed consequence supports review of the case. Routine regression scoring can inspect the report and trace against reviewed expectations; it does not require executing a configuration change on every run. An action acknowledgement is never a correctness label or proof of recovery.

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

Run the [offline checker](../agent/README.md#check-an-investigation-deterministically)
with a frozen case and its source bundle. Use the verified native archive for
recorded execution checks. A standalone report supports checks of its structured
fields and citation times, with execution findings marked incomplete.

Use model judges for semantic questions with a specific rubric, supplied evidence, and an explanation of the result. Use code for facts and boundaries that can be checked directly. Human review defines expectations, examines disagreements, and handles decisions the available evidence cannot support.

The agent investigates read-only and proposes a response. It may assess current state from timestamped application evidence; it cannot certify recovery from a configuration acknowledgement or claim to have applied the remedy. The presenter independently chooses whether to use a controller shortcut and then separately generates requests to observe its effect. Evaluations assess the investigation and recommendation. Application recovery is established through application evidence, not an agent score.

## Strands and AgentCore roles

Strands Evals provides evaluation in code: cases, tasks, experiments, output and trajectory scoring, custom evaluators, reports, and repeated runs suitable for local development and CI. AgentCore Evaluations provides managed scoring of instrumented agent traces, including on-demand and continuous evaluation of deployed behavior. [Strands quickstart](https://strandsagents.com/docs/user-guide/evals-sdk/quickstart/), [Strands and AgentCore guidance](https://strandsagents.com/docs/user-guide/evals-sdk/how-to/agentcore_evaluation_dashboard/)

Both support code checks and model judges. AgentCore custom code evaluators execute through Lambda; Strands also provides model-based evaluators. Their role in this example follows the execution workflow, not a division by evaluator type. [AgentCore custom evaluators](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/create-evaluator.html)

Use AgentCore to evaluate actual instrumented traces from both deployed investigations and the prepared local candidate runner. The runner executes the same Strands agent constructor with captured providers before deployment. S3 uses AgentCore on-demand scoring for the current single semantic criterion, with deterministic recommendation checks kept separately inspectable. S4 connects the execution task, evaluators, reports, and comparisons in the full Strands experiment; S5 runs that same experiment and reviewed policy in CI. An old deployed-agent trace cannot substitute for execution of the pending source/artifact. Deterministic checks and the current advisory evaluator are introduced at S2; their integration does not require a second deployment environment or two implementations of every check.

For this example, Strands answers whether a candidate still handles the reviewed incidents correctly before release. AgentCore helps inspect the quality of actual alarm-triggered investigations and discover failures worth reviewing as future regression cases. Both contribute to the same feedback cycle; neither removes the need for reviewed expectations or an explicit agent repair.

Do not implement two copies of every check just to demonstrate both products. A Strands evaluator object, dataset, or report is not automatically an AgentCore evaluator or result. Instrumenting the same agent can support both workflows, and Strands can publish SDK results to a CloudWatch dashboard, but dashboard visibility is distinct from the AgentCore service performing the evaluation.

The useful feedback sequence is:

1. Capture an actual investigation and assess its behavior through AgentCore.
2. Review a quality problem and define acceptable behavior.
3. Turn it into a Strands regression case.
4. Compare faulty and corrected candidates.
5. Feed the selected evaluation evidence into the release policy.

## S2: Run and score the captured baseline

The [captured-run commands](../agent/README.md#run-and-score-the-captured-baseline-s2)
open the identified saved execution and score its verified CloudWatch session.
The baseline uses the prepared denial case, its exact evidence cutoff, and the
faulty candidate's saved source and settings. A new input requires its own
matching execution. The historical live denial report remains a separate
incident artifact.

The current custom AgentCore SESSION evaluator returns one categorical
`semantic_quality` finding in one call. Its rubric requires both diagnosis
support and accurate source and coverage claims, and its explanation should
identify the decisive evidence or gap. The deterministic recommendation checks
still evaluate the action, target, and value independently. The saved result
keeps the combined verdict and reason.

Older retained scores may contain the separate `diagnosis_support` and
`evidence_grounding` findings from the historical multi-mode rubric. They are
useful calibration or regression evidence only when their original evaluator
identity is shown; they are not additional findings from the current
single-mode evaluator.

The first frozen-case run recommended restoring Inventory access. Its
deterministic cutoff check failed on a citation beyond the reviewed time.
An earlier Haiku 4.5 run passed both historical semantic findings in two
provisional scoring attempts. Both explanations treated an empty, clipped tool
response as evidence through the full requested window. That run supplies a
timing counterexample for judge calibration. The saved S2 execution on the same
frozen case diagnosed the access denial and recommended increasing Inventory
memory from 256 MB to
512 MB. Its action, value, and cutoff checks failed. Its Inventory target
check passed. The grounding rubric checks claims about source observations
and query coverage. Diagnosis support grades the causal explanation and
incident assessment. The evaluator receives a compact view of verified log
records with separate event, ingestion, and availability times alongside the
native session. The pinned historical Sonnet 4.6 single-verdict score can be
shown with its reason after the evaluator descriptor and session identity are
verified. It does not qualify a release by itself or establish behavior for the
active US Opus 5.5 target. The deterministic
action, target, value and cutoff checks, together with identity-bound human
review of the exact report, trace and pending artifact, control publication.

Judge calibration uses labeled, constructed controls grounded in retained
evidence. Development and holdout controls come from separate incidents. The
reference contrast changes a reviewed assertion while keeping the session
fixed. This small sample covers the reviewed examples
and their counterexamples. Record the evaluated configurations, disagreements,
and explicit repeat alongside the baseline evidence.

## S3: Fresh candidate before deployment

The S3 runner accepts an explicitly selected editable candidate and snapshots
its prompt, source, lockfile, frozen case and captured bundle before importing
the candidate. The prepared `agent/prompts/s3-repair.patch` changes only the
prompt. The default `faulty` path keeps the checked-in manifest validation used
by S2. The explicit `repaired` path records the actual saved prompt digest and
candidate label while preserving the same model, report schema, four captured
read-only tools, permissions and request bounds. A later editor save cannot
change an in-flight run. Each invocation gets a fresh execution, session and
trace identity, including repeated runs with identical inputs. The run emits a
durable directory as soon as its running record is ready, so a second IDE
terminal can inspect progress with `show`; process loss remains interrupted and
never relaunches work. The editable S3/S4 prompt is development input only. The
serving prompt is the authenticated prompt inside the selected Runtime ZIP;
editing the development file does not change the serving endpoint.

The intended execution and scoring path is:

1. Execute the changed candidate with a new regression/session identity, retaining its prompt, source, model, case, and evidence versions. The candidate chooses its own queries against the captured sources. For the denial case, the repaired guidance chooses the healthy role-backed Inventory version at the current memory when the captured IAM evidence supports that action, and keeps the recommendation bounded to the source rows, coverage and effective reference time.
2. Export that execution's actual model/tool/report telemetry to CloudWatch through the prepared outside-Runtime observability configuration, with session correlation. Wait for ingestion, then collect the matching complete session spans and conversation content. The case reference time governs evidence access; telemetry timestamps describe the new execution.
3. Submit those spans to AgentCore on-demand `Evaluate`, using the same versioned semantic evaluators and reviewed reference expectations as the baseline. Supply expectations as evaluator reference inputs, outside the agent's prompt and tool evidence. Verify that reference-dependent criteria actually consumed the supplied fields.
4. Run the deterministic action/target checks against the new report and keep their findings separate from the semantic judgments. Reuse the check logic when exposing a check through an AgentCore Lambda evaluator rather than writing a second copy.
5. Compare the captured S2 faulty candidate and the repaired candidate on the same cases, captured evidence, criteria, scoring setup, and replay tooling. Use the identified S2 baseline only when its captured-evidence and trusted-tooling identities match the new execution. The offline comparison verifies common runtime/tool source hashes, case and evidence identities, evaluator and scoring source pins, the selected score attempt, and the native session/trace binding. For an alternate input with no matching baseline, execute the captured S2 prompt with the current identified tooling and retain the observed result; do not manufacture a fresh S2 result from an older record. Missing spans, ignored required references, foreign results, or failed required scoring leave the evaluation incomplete while preserving available reports and deterministic findings.

AWS supports on-demand evaluation of supported-framework agents outside AgentCore Runtime. Its [on-demand prerequisites](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/ondemand-evaluations-prereqs.html) and [outside-Runtime observability setup](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-configure.html#observability-configure-3p) establish this route. Prepare telemetry export, session propagation, source collection, and evaluation permissions before the session. Ground-truth reference inputs are described in [ground-truth evaluation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/ground-truth-evaluations.html); shared code checks can use the [Lambda evaluator contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-based-evaluators.html).

At S4, the Strands experiment reuses the candidate execution function as its native task and calls the SDK's `Experiment.run_evaluations`, rather than implementing a separate case loop. It creates native `Case` objects and two custom `Evaluator` objects: one projects the eight named deterministic findings, and one uses the verified single-mode Opus AgentCore scoring operation above for one combined `semantic_quality` advisory verdict and reason. The returned native report has one `(case, evaluator)` row for each selected case/evaluator pair - one deterministic row and one advisory row per case. The semantic row carries a native numeric `0.0` only as `numericPlaceholder: true`; policy reads the actual categorical result and canonical status instead. Cases execute sequentially, and the two evaluator calls for a completed case may overlap. The AgentCore verdict and reason are advisory feedback. Preserve case meaning, supply the right reference inputs, and compare candidates within the selected scoring setup rather than treating scores from different evaluators as interchangeable. The direct prepared S4 entry has no S3-run prerequisite; an optional `--source-run` selects an authenticated immutable S3 source exactly, including an accepted active execution. A focused `--case` selection is a development subset. Native experiment snapshots freeze the selected cases and bundles, candidate/tooling/dependency inputs, and evaluator before the first case; later edits cannot change the run, and `show`/`compare` are read-only. A known deterministic failure rejects immediately, missing or error results are incomplete, and all deterministic checks passing with a complete advisory pass or fail yields `review_required`. These are S4 feedback outcomes, not publication authority. S5 runs the same experiment and policy against the exact Linux ARM64 Runtime ZIP and requires complete required results, matching package identities, and source-backed approval in the protected GitHub environment before publication. S3 remains a direct IDE runner and does not deploy the repaired candidate or invoke the live alarm adapter.

## S4: Native Strands development experiment

Run the native experiment from a prepared browser-IDE workspace using the
commands in the [agent README](../agent/README.md#run-the-native-strands-development-experiment-s4).
Direct S4 starts from the selected prepared suite, candidate, evaluator descriptor, and
reviewed case/bundle assets; it does not require a prior S3 run. An optional
`--source-run` selects the authenticated immutable candidate source from an
accepted S3 execution, including an active execution, and rejects missing,
altered, or incompatible sources before inference. `--case CASE_ID` narrows a
development run without changing the selected reviewed suite used later.

The task passes only the public candidate input to the existing captured
runner. Reviewed expectations stay in evaluator-only metadata. The experiment
freezes the selected candidate sources, dependency lock, native experiment and
evaluator code, selected suite, case/bundle bytes, and evaluator descriptor before its
first case. Repeating the same selection creates a new experiment and new
execution/session/trace identities; a later prompt, case, tooling, or lock edit
cannot alter an accepted run. SDK retries cannot launch a second investigation
or judge call after a typed task/evaluator failure, and later selected cases may
continue after an incomplete case. `show` reopens the native report without
credentials or side effects. `compare` joins exact case, tooling - including the
captured-evidence projection - runtime, input, evaluator, scorer, report, and
selected-attempt identities and retains available rows when another pair is
unavailable or mismatched. A result using an earlier replay projection remains
historical and cannot be promoted to a current comparison baseline.

Each native report contains one row per `(case, evaluator)`. The selected suite
determines the case count; each deterministic row exposes the eight named
findings, while each advisory row retains the actual pinned
AgentCore Opus 5.5 categorical verdict, reason, status, scoring attempt, and
full run/session/trace references. The SDK's required numeric field is `0.0`
with `numericPlaceholder: true`; this placeholder is not a quality score and
does not affect policy. A known required deterministic failure yields
`reject` immediately, even if advisory scoring is pending. Missing, invalid,
or error execution/scoring yields `incomplete`. All required deterministic
findings passing plus a complete advisory result - whether pass or fail - yields
`review_required`. These are S4 development outcomes, not publication
authority; exact Runtime ZIP qualification and human approval belong to the
later S5 gate.

The historical browser IDE workflow was verified with an Opus audience-case comparison and native four-case S4 runs. The repaired denial rows passed the access action and semantic grounding; overload and recovery retained separate semantic failures. A separate historical four-case serving comparison ran Sonnet and Opus on the same reviewed cases: each completed all 32/32 required deterministic checks and chose the same action on every case. This is limited to those cases, serving inputs, evaluator configuration, and package identity; it is not an overall accuracy or model-superiority claim. In that historical comparison, the original judge accepted an overload report with a citation error: two metric citations put the 20:10 bucket start in `observedAt` although the source rows were observed at `20:12:15.471Z`; the matched Sonnet report used the source observation time and was correct. These are advisory results, not current release qualification. The archived Sonnet workflow and cutoff report remain historical and separate. Original-production holdout recovery is complete at 2/2 correct-recipe responses, with two incompatible-recipe attempts incomplete and excluded. Rehearsal preparation checks session correlation, complete telemetry, reference mapping and exact result identities.

## Offline cases and observed traffic

Controlled cases have known, reviewed causes. They can test diagnosis correctness against that knowledge. Deployed traffic usually does not have a supplied correct answer. Its evaluators can assess evidence support and other observable behavior, but those results alone do not establish the true incident cause.

AgentCore custom evaluators that reference ground-truth placeholders cannot be used in online evaluation configurations. Use the appropriate on-demand or dataset path for such checks. If continuous evaluation is selected, its criteria must be available from the observed trace. [AgentCore ground-truth restrictions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/create-evaluator.html)

## Release decisions

An S4 experiment produces feedback for a saved development prompt edit in the IDE. The development prompt is distinct from the prompt in any serving ZIP. S5 runs the same Strands experiment and captured providers against the checked Linux ARM64 Runtime ZIP. The checked package uses the current single-mode Opus evaluator identified by its reviewed input archive for its one advisory verdict and reason. Archived model comparisons, original-judge calls, and earlier multi-finding scores remain historical and retain their original labels. A serving comparison is limited to its reviewed cases, inputs, evaluator configuration, and exact package identity; it is not an overall accuracy or model-superiority claim. CI verifies the expected case and evidence identities independently of the rows the experiment returned.

| Evidence for the pending package | Release decision |
| --- | --- |
| A known required deterministic failure | Reject automatically, even if another result is still pending. Preserve the failing report and any unfinished results. |
| Missing, errored or mismatched required evidence | Incomplete. Identify the unavailable case, execution or scoring result. |
| All required checks pass and advisory evidence is complete | Await source-backed human review. A complete advisory disagreement remains visible for that decision. |
| The presenter rejects, or approval belongs to different evidence | Publication is blocked. |
| The presenter approves the exact package, reports, traces and sources in the protected GitHub environment | The publisher may pin those bytes to the named repaired endpoint and verify its live version. |

The prepared cases cover access denial, throttling, and recovery with a stale
alert. The selected suite's input manifest binds the exact frozen roster, which
may differ between prepared runs. An explicit reviewed input carries its own
frozen identity into CI. A different case, prompt, ZIP, policy, evaluator or
newly evaluated report needs matching review. The report, its actual tool
evidence, the single judge reason and all per-case findings remain available
privately. The numeric field used by the native Strands report has no release
authority.

The signed-in presenter reviews the private evidence and enters the manifest digest on the pending GitHub run. See [running and reviewing the release](deployment.md#review-a-repaired-agent-release).

## Measurements

Use reviewed measurements of judge agreement, run-to-run stability, false passes,
false failures, and latency before putting numerical conclusions in the deck.

| Measurement | Evidence to retain |
| --- | --- |
| Judge agreement | Independent human assessments under the same rubric, judge results, and reviewed disagreements |
| Run-to-run stability | Repeated results for a fixed case set and explicit candidate, evaluator, and model settings |
| False passes and false failures | Independently reviewed acceptable/unacceptable examples and the resulting decisions |
| Latency | Timed agent execution and evaluation, with telemetry ingestion or other waits identified separately |

Record case and candidate versions, evaluator criteria/settings, model IDs, run settings, and enough source references to reproduce the reported result.

## Calibration, holdouts, and repeated runs

An agent rerun repeats the investigation and can reveal run-to-run variation in its report or tool use. Rejudging a saved trace keeps that agent execution fixed and can reveal variation in the judge. Neither result substitutes for the other.

**Calibration checks whether the judge recognizes acceptable behavior.** Review acceptable and unacceptable example reports against the same evidence and rubric, obtain human decisions, and compare the judge's decisions and explanations with them. Review disagreements to determine whether the judge is wrong, the rubric is unclear, or the human expectation needs correction. For the worked case, distinguish a supported policy-restoration recommendation, an unsupported memory recommendation, and a correct action backed by an unsupported diagnosis. The historical original Opus rubric has 7/7 agreement on seven exposed controls and 2/2 on two holdout reports; the three prespecified S4 calls are repeats of one saved defect report. These are retained-report calibration results, not fresh agent executions or a general accuracy estimate. Collect actual examples before claiming agreement or error rates.

**Holdouts check performance on examples that did not guide the changes.** A judge holdout contains human-reviewed examples not used to tune the rubric or judge settings. An agent holdout contains cases not used to repair the agent's prompt. These answer different questions. Keep related captures, near-duplicate reports, and variants of the same incident together when separating development and final checking, so the separation supports the claim being made. A new trace of the same known case does not establish coverage of a new incident family.

The access-denied case shown on stage is a regression case because it informed the prompt repair. If a held-back example changes the prompt or rubric, move it into the development set and reserve a fresh example for the next independent check. Interpret each result using that run's case roster, model, rubric, and repetition count. A judge repeat on a saved trace measures scoring variation for that trace.

Cost and latency belong in Q&A. When discussing a measured run, identify the case count, model, region, elapsed time, and the services included in any cost figure. [Presenter appendix](slides-plan.md#appendix-guidance)

## Choosing a judge model

Select the judge independently from the agent, within the options supported by the chosen evaluation product and evaluator. Compare models using the same evidence, rubric, and human-reviewed examples, inspecting false passes, false failures, explanations, and latency. Model size or identity with the agent model does not establish judge quality.

The configuration options differ: [AgentCore built-in evaluators](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/built-in-evaluators-overview.html) have fixed prompts and models. Its [custom LLM evaluators](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/create-evaluator.html) allow supported model/settings choices, and [Strands model evaluators](https://strandsagents.com/docs/user-guide/evals-sdk/evaluators/output_evaluator/) accept a model override. Explain that distinction when discussing judge selection; the talk does not promise that a built-in judge's model can be replaced.

The current prepared workflow selects the calibrated single-mode Opus judge
described above. Check that the judge can handle the supplied evidence and
context, then validate it on the separate judge holdout. Keep model/version,
rubric, and settings fixed when comparing agent candidates. Changing the judge
is a change to the measurement: recheck calibration and establish a comparable
baseline before interpreting score differences as an agent improvement.
