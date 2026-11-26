# Evaluation approach

Checkout can still be broken when an agent gets the diagnosis right. Given the evidence available at the time, did the agent recommend a change that could fix the problem?

## Worked case: Inventory access denied

Inventory tried to read its DynamoDB table, and the policy on its active execution role denied `GetItem`. The agent found the denial in the logs. It recommended **Increase memory**. A larger Lambda still has the same permissions, so the case requires **Restore inventory access** to the healthy version at the current memory. The captured alias, role, policy and change history identify which version that is.

| Part of the evaluation | What it sees or decides |
| --- | --- |
| Agent | Receives the alarm, cutoff time and allowed sources. It can query captured logs, metrics, configuration and change history. The expected remedy stays with the evaluator. |
| Code checks | Grade the report and tool trace against the reviewed case. For the faulty report, `target` passes because the agent picked Inventory. `action` and `target_value` fail because extra memory cannot restore the denied read. |
| AgentCore judge | Reads the investigation and reviewed references. It gives one advisory verdict with a reason about the diagnosis and the evidence cited for it. |
| Release gate | A required failure rejects the ZIP. Missing required evidence blocks publication. If the checks pass and advisory scoring completes, a reviewer compares the reports with their sources before approving that ZIP. |

On stage, the audience sees the faulty agent's trace (S0), reviews the case (S1), scores the saved run (S2), edits the prompt (S3), and tries the change across cases in Strands (S4). In S5, CI evaluates the ZIP the participant has proposed for release. [Stage guide](components/operations-agent.md#software-stages) and [demo sequence](demo-progression.md)

## Public and prepared routes

To try the checker on a laptop, start with the saved synthetic case. The public example needs no AWS credentials. You can then run the same case with Strands or replace the saved report with your own agent’s output. [Attendee guide](attendee-guide.md) and [adaptation walkthrough](adapt-evaluations.md)

For a performance, use the private cases, scoped AWS profile and reviewer-approved evaluator. The Codespace exports each investigation's traces to CloudWatch so AgentCore can score the session. See [talk preparation](preparation.md) for the inputs and [deployment](deployment.md) for the package and approval steps.

### Active model target

The prepared `talk/v5` workflow uses the US Opus 5.5 inference profile in
`us-east-1` for the agent and semantic judge. The current single-mode evaluator
returns one advisory categorical `semantic_quality` verdict and reason. Its
rubric requires both diagnosis support and accurate source and coverage claims
across the report. The explanation should identify the decisive evidence or
the precise gap. Recommendation action, target and value are checked
separately. Evaluator-only reference inputs carry the reviewed criteria and may
include a compact source view copied from returned results. They do not carry
the admissible recommendation list.

### Maintainer details

The US inference profile ID is `us.anthropic.claude-opus-5-5`. The calibrated
evaluator is `IncidentTriageSemanticSingle_584b1b2b228fbf141f-MqPN3HHgez` with
configuration digest
`584b1b2b228fbf141f50eb780df5d51c75b56b0ed720fe7717d247527069b5c1`. Its judge
configuration sets `maxTokens` to 2000 and omits `temperature`. Prepared S2-S5
inputs select the exact evaluator descriptor. Older results retain their own
model, rubric and findings in the [historical evaluation record](evaluation-history.md).

## Evaluation inputs and expectations

Use actual executions of synthetic application incidents. The failure
controller records what it activated and verifies observed failure and recovery.
The operations agent sees ordinary logs, metrics and change history. It does
not see the controller's scenario label or expected diagnosis.

Each reviewed case needs an affected service, originating event and alert time,
symptoms, incident window, an explicit effective investigation reference time,
an evidence reference, provenance, acceptable behavior and unacceptable
behavior. A correct response need not match one sentence or one tool order.

The prepared cases cover traffic-driven Inventory capacity overload, an IAM
Deny on the Inventory execution role and recovery followed by a stale alert.
The recovered case is a temporal condition, not a third injected fault.

For overload, check actual Lambda `Throttles`, function-cap configuration and
invocation evidence. Distinguish concurrent execution exhaustion from the
synchronous Invoke request-rate limit when the evidence supports that
distinction. Rejected invocations do not execute the function or count as its
`Invocations` or `Errors`.

For access denial, check the failed read and the ordinary alias, version, role
and policy evidence. The accepted recommendation selects the healthy
role-backed version at the current memory. Add a case only for a distinct
behavior. Case count alone does not establish coverage.

A failed run can provide evidence for a new case, but its response is not the
definition of success. Review the expected behavior before freezing the case.

## Captured evidence for regressions

Local and CI regressions use versioned, queryable captures for logs, metrics,
sanitized configuration and bounded change history. A capture supports the
case's effective investigation reference time. Keep source observation time,
capture or acquisition time and case reference time distinct. Derive as-of
configuration only from observations or history that supports it. A recovered
case uses a later reference time and post-recovery observations.

Replay queries only the referenced capture. It does not fall back to live AWS
state or include evidence after the case reference time. Tool responses keep
eligible row timestamps, requested windows, coverage gaps and partial results
visible. Logs and metrics preserve the candidate's requested windows.
Configuration reflects the reference time. Bounded history includes only
changes effective by that time. Relative windows and freshness use the case
reference time. Real execution timestamps are recorded separately.

Each candidate chooses its own queries, windows and order. Do not replay a
saved tool-call sequence, inject a scenario label or expected answer, or
replace candidate output. A saved trace can be judged again, but that does not
execute a changed candidate.

Give each regression run its own ID and retain the originating alarm and case IDs alongside it. That way two candidates can investigate the same incident without overwriting the live record. If the capture format or replay implementation changes, review and record its new digest before comparing prompts.

S4 and S5 record the replay implementation digest in the tooling manifest.
Prompt-only comparisons require matching replay tooling. An older report stays
available under the tooling identity that produced it.

## S1: Author, validate, freeze, and hand off

Start with the [verified portable assets](preparation.md#run-a-stage-from-its-prepared-workspace).
Follow the [S1 commands](../agent/README.md#review-and-freeze-a-case-s1) to
copy the audience draft into a private workspace, edit the expected remedy and
run `validate`, `freeze` and `candidate-input` offline. Direct prepared entry
uses the matching case and evidence bundle.

Validation checks provenance, cutoff availability and required coverage.
Freezing binds the reviewed case to exact evidence bytes. The candidate gets
the public task projection and reads the captured evidence through read-only
tools. Expected remedies and review notes remain evaluator-only.

## Recommendation correctness

The report selects exactly one of **Increase reserved concurrency**,
**Increase memory**, **Restore inventory access** or **Other**. The first two
actions identify `checkout` or `inventory` and a supported higher target in
executions or MB. Restore access identifies the denied Inventory read, the
observed alias, version, role and policy evidence, and the exact healthy
role-backed version at the current memory with unit `version`. Other explains
an alternative, a no-change conclusion or missing evidence. It is not an
arbitrary executable command.

| Reviewed evidence | Expected recommendation | Incorrect behavior |
| --- | --- | --- |
| Inventory throttles under a selected comparable surge | Increase reserved concurrency for `inventory` to a supported higher limit justified by observed demand | Wrong component, unrelated policy change or unsupported claim about the observed limit |
| Inventory read denied by the scoped IAM policy on the denied version's role | Restore inventory access to the healthy role-backed version at current memory | Increase memory or concurrency while leaving the denied version active |
| Fresh requests support recovery in the investigated scope | Other, with a reason for leaving configuration unchanged | A new configuration change based only on an old alarm |
| Evidence cannot support a specific action | Other, with the uncertainty and next useful investigation | Invented cause, target or certainty |

Case expectations may allow more than one justified numeric target within
reviewed bounds. They must not enforce one sentence, tool order or arbitrary
value. If the agent cannot establish a supported target, it should explain
that limitation through Other. Insufficient evidence is not an escape when the
case supplied evidence the agent failed to collect.

A correct diagnosis with the wrong action fails recommendation correctness. A
lucky correct action with an unsupported diagnosis fails the current combined
`semantic_quality` verdict. A controller acknowledgement is not a correctness
label or proof of recovery. The controller can select a larger qualified
version while the denied version's policy still rejects the read.

## Checks and judgments

The deterministic checker exposes eight findings:
`report_structure`, `assessment`, `action`, `target`, `target_value`,
`source_scope`, `as_of_time` and `operator_boundary`.

### Evidence times and cutoffs

A CloudWatch point in the `20:10Z` bucket was observed at `20:12:15.471Z`. The report can name the bucket to explain the aggregation. Its citation field, `evidence[].observedAt`, needs `20:12:15.471Z`. A third timestamp says when the observation became available to the agent.

Those times answer different questions. A citation after the case cutoff fails the code check. A bucket start might fall **before** the cutoff and still be the wrong citation. To judge that claim, compare the citation with the observation returned by the tool. An empty or partial result also limits what the agent can say about the requested window.

Use the [offline checker](../agent/README.md#check-an-investigation-deterministically)
with a frozen case and matching source bundle. A recorded archive verifies the
case, bundle, run, alarm transition, trace, session and report identities. A
standalone report can check report fields and citation times, but its execution
and operator findings remain incomplete.

Use model judges for semantic questions with a specific rubric, supplied
evidence and an explanation. Use code for facts and boundaries that can be
checked directly. Human review defines expectations, examines disagreements and
handles decisions the evidence cannot support.

The agent investigates read-only and proposes a response. It may assess state
from timestamped evidence. It cannot certify recovery from an action
acknowledgement or claim to have applied a remedy. The presenter can choose a
controller shortcut and then separately generate requests to observe its
effect. Evaluations assess investigation and recommendation. Application
recovery requires application evidence, not an agent score.

## Strands and AgentCore roles

Strands Evals provides cases, tasks, experiments, evaluators, reports and
comparisons for local development and CI. AgentCore Evaluations scores
instrumented traces through on-demand or continuous workflows. See the
[Strands quickstart](https://strandsagents.com/docs/user-guide/evals-sdk/quickstart/)
and [Strands and AgentCore guidance](https://strandsagents.com/docs/user-guide/evals-sdk/how-to/agentcore_evaluation_dashboard/).

Both products support code checks and model judges. AgentCore custom code
evaluators run through Lambda. Strands also provides model evaluators. Their
roles follow the execution workflow, not a rule that every check must be
implemented twice. See [AgentCore custom evaluators](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/create-evaluator.html).

In this project, Strands runs the agent against each reviewed case and collects the evaluator rows. The deterministic evaluator runs the code checks. The semantic evaluator passes that case's CloudWatch session and reviewed references to AgentCore and returns the service's verdict and reason. Both use the same candidate execution.

S2 and S3 can score one saved session directly with AgentCore. S4 and S5 call it through the Strands evaluator. That lets the IDE and CI use the same check implementations. The agent uses the same constructor for live and captured investigations. Only its evidence provider changes.

For a Codespace run, set up the trace export and access to the matching CloudWatch session before calling the evaluator. AWS documents the [outside-Runtime observability setup](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-configure.html#observability-configure-3p) and [on-demand evaluation prerequisites](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/ondemand-evaluations-prereqs.html). To adapt the evaluator, see [passing ground-truth references](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/ground-truth-evaluations.html) and [running code-based checks in Lambda](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-based-evaluators.html).

## S2: Run and score the captured baseline

Use the [captured-run commands](../agent/README.md#run-and-score-the-captured-baseline-s2).
`evaluate_case.py show` opens a saved run offline. `evaluate_case.py score`
scores its matching CloudWatch session with the reviewed evaluator. A new
input requires a matching execution. `evaluate_case.py run` creates a fresh
captured execution for a frozen case and source bundle.

Scoring waits for matching telemetry and saves each explicit scoring attempt.
If spans are still arriving, score the same run again later. `show` reopens
saved reports and scores without credentials. Keep case, bundle, run and judge
attempts in private evidence storage.

## S3: Fresh candidate before deployment

The S3 runner snapshots the editable candidate, source, lockfile, frozen case
and captured bundle before importing the candidate. The prepared repair changes
only the prompt. Each invocation gets a fresh execution, session and trace
identity. The serving prompt remains inside the selected immutable Runtime ZIP.
Editing the development prompt does not change a serving endpoint.

Follow the [S3 runbook](../agent/README.md#run-score-and-compare-the-repaired-candidate-s3).
Use `talk_stage.py setup` and `run` to start from the prepared workspace. Then use `evaluate_case.py run`, `score` and `compare`. The edited agent chooses its own queries. Compare it with the S2 baseline when the case, cutoff, model, runtime and tooling sources, evaluator and scoring source match. Each execution has its own scoring attempt. Verify that the selected attempt belongs to that execution. Missing spans, a score from a different session, or changed case inputs leave the comparison incomplete.

`show` and `compare` read the saved records offline. To evaluate a changed prompt, run it and score its own session.

## S4: Native Strands development experiment

Run the [native experiment](../agent/README.md#run-the-native-strands-development-experiment-s4)
from a prepared workspace. The Strands task for each case runs the candidate on its captured evidence. The
experiment calls `Experiment.run_evaluations` with two custom evaluators. Cases run sequentially. The deterministic and
advisory calls for a completed case may overlap.

Direct S4 entry does not require an S3 run. An optional `--source-run` selects
an authenticated immutable S3 source exactly, including an accepted active
execution. It does not repair or substitute the candidate. A focused `--case`
run is a development subset.

The native report has one `(case, evaluator)` row for each selected case and
evaluator. Each case has one deterministic row with the eight named findings
and one advisory row with the pinned Opus 5.5 categorical verdict, reason,
status, scoring attempt and full run, session and trace references. The native
numeric field is `0.0` with `numericPlaceholder: true`. It is not a quality
score and does not affect policy.

Before the first case, the experiment snapshots the selected cases and bundles,
candidate, tooling and dependency inputs, and evaluator descriptor. Later edits
cannot change an accepted run. Repeating the same selection creates new
experiment and execution identities.

A known deterministic failure yields `reject` immediately. Missing, invalid or
error execution or scoring yields `incomplete`. All deterministic findings
passing with a complete advisory pass or fail yields `review_required`.
These are S4 development outcomes. They do not qualify or publish a Runtime
ZIP. `show` reopens a saved report without credentials or side effects.
`compare` joins exact identities, keeps available rows visible and does not
emit a release decision.

S5 runs the same experiment and policy against the exact Linux ARM64 Runtime
ZIP. Required results must be complete, package identities must match and the
protected GitHub environment must contain source-backed human approval before
publication.

## Offline cases and observed traffic

Controlled cases have reviewed causes. They can test diagnosis against that
knowledge. Deployed traffic usually has no supplied correct answer. Its
evaluators can assess evidence support and observable behavior, but those
results alone do not establish the true incident cause.

AgentCore custom evaluators that reference ground-truth placeholders cannot be
used in online evaluation configurations. Use the appropriate on-demand or
dataset path. For continuous evaluation, criteria must be available from the
observed trace. See [AgentCore ground-truth restrictions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/create-evaluator.html).

## Release decisions

CI runs the Strands experiment against the proposed Linux ARM64 Runtime ZIP. It takes the case list and Opus evaluator from the reviewed input archive, then checks that the results cover those cases and belong to that package.

| Evidence for the pending package | Release decision |
| --- | --- |
| A known required deterministic failure | Reject automatically, even if another result is pending. Preserve the failing report and unfinished results. |
| Missing, errored or mismatched required evidence | Incomplete. Identify the unavailable case, execution or scoring result. |
| All required checks pass and advisory evidence is complete | Await source-backed human review. A complete advisory disagreement remains visible. |
| The presenter rejects, or approval belongs to different evidence | Publication is blocked. |
| The presenter approves the exact package, reports, traces and sources in the protected GitHub environment | The publisher may pin those bytes to the named repaired endpoint and verify its live version. |

Reviewers can open the reports, tool evidence, judge reasons and findings in the private review packet. Approval belongs to the specified prompt, ZIP, cases, evaluator, policy and reports. If any of those change, review the new packet.

See [running and reviewing the release](deployment.md#review-a-repaired-agent-release).

## Measurements

Use reviewed measurements of judge agreement, run-to-run stability, false
passes, false failures and latency before putting numerical conclusions in the
deck.

| Measurement | Evidence to retain |
| --- | --- |
| Judge agreement | Independent human assessments under the same rubric, judge results and reviewed disagreements |
| Run-to-run stability | Repeated results for a fixed case set and explicit candidate, evaluator and model settings |
| False passes and false failures | Independently reviewed acceptable and unacceptable examples with resulting decisions |
| Latency | Timed agent execution and evaluation, with telemetry ingestion and other waits identified separately |

Record case and candidate versions, evaluator criteria and settings, model IDs,
run settings and enough source references to reproduce the result.

## Calibration, holdouts, and repeated runs

An agent rerun repeats the investigation and can show variation in its report
or tool use. Rejudging a saved trace keeps the agent execution fixed and can
show variation in the judge. Neither substitutes for the other.

Calibration asks whether the judge recognizes acceptable behavior. Review
acceptable and unacceptable reports against the same evidence and rubric. Get
human decisions and compare both verdicts and explanations. Review
disagreements to decide whether the judge is wrong, the rubric is unclear or
the expectation needs correction.

Holdouts answer a different question. A judge holdout contains human-reviewed
examples not used to tune the rubric or settings. An agent holdout contains
cases not used to repair the prompt. Keep related captures and near-duplicate
reports together when separating sets. A new trace of the same case does not
establish a new incident family.

The access-denied case shown on stage informed the prompt repair, so it is a
regression case. If a held-back example changes the prompt or rubric, move it
to development and reserve a fresh example for the next independent check.
Interpret results using that run's case roster, model, rubric and repetition
count. A judge repeat on a saved trace measures scoring variation for that
trace.

Cost and latency belong in Q&A. When discussing a measured run, identify the
case count, model, region, elapsed time and services included in a cost figure.
See the [presenter appendix](slides-plan.md#appendix-guidance).

## Choosing a judge model

Select the judge independently from the agent, within the options supported by
the evaluation product and evaluator. Compare models using the same evidence,
rubric and human-reviewed examples. Inspect false passes, false failures,
explanations and latency. Model size or identity with the agent model does not
establish judge quality.

The configuration options differ. [AgentCore built-in evaluators](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/built-in-evaluators-overview.html)
use fixed prompts and models. [Custom LLM evaluators](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/create-evaluator.html)
allow supported model and settings choices. [Strands model evaluators](https://strandsagents.com/docs/user-guide/evals-sdk/evaluators/output_evaluator/)
accept a model override.

The current prepared workflow uses the calibrated single-mode Opus judge above.
Validate it on a separate judge holdout. Keep model and version, rubric and
settings fixed when comparing agent candidates. Changing the judge changes the
measurement. Recheck calibration and establish a comparable baseline before
interpreting score differences as agent improvement.
