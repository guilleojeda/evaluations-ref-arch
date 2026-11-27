# Operations agent

A CloudWatch alarm starts one read-only investigation. The agent queries logs, metrics and configuration, then writes a report that the presenter can inspect alongside the original trace. The same agent can investigate a saved incident from the IDE. The [application](application.md) produces the telemetry, and the [failure controller](failure-controller.md) applies the presenter’s choice of remedy. [Reference overview](../../README.md) and [talk plan](../talk-plan.md)

## Public and prepared access

To try the report checks and Strands experiment without AWS credentials, use the [attendee guide](../attendee-guide.md) and [adaptation walkthrough](../adapt-evaluations.md). The hosted investigation and cloud evaluations need scoped AWS access and reviewed evaluator inputs. Private locators and credentials stay outside the checkout. See [preparation](../preparation.md) and [deployment](../deployment.md).

## Purpose and boundaries

The operations agent performs one bounded investigation for one genuine application alarm event and returns one report. It does not conduct a follow-up chat. A dashboard poll, an already-active alarm, incident activation, a configuration action, or recovery does not invoke it. Each run retains the originating alarm identity so its trace and report can be matched to that event. The overload case uses throttle evidence within the same model, report contract, evidence tools, and investigation limits.

The live agent uses the US Opus 5.5 inference profile, `us.anthropic.claude-opus-5-5`, from `us-east-1`. The semantic judge gives one advisory verdict on diagnosis and grounding. Code checks the recommendation. For results produced by earlier judges, see the [evaluation history](../evaluation-history.md).

A replay gets its own execution ID and retains the original alarm and case IDs. This lets the developer run several candidates on one incident without creating new live alarms. The controller has no manual agent trigger.

The run input identifies the affected service and scope, the originating alarm/event and its time, the reported symptoms, and when investigation began. Regression input also supplies the case's effective investigation reference time. Trusted deployment configuration identifies the permitted evidence sources. A CloudWatch alarm invokes a small Lambda adapter directly on a transition to ALARM ([CloudWatch alarm actions](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/alarms-and-actions-Lambda.html)).

The canonical live event identity is the alarm ARN plus the UTC-normalized ALARM state-transition timestamp from the delivered `alarmData.state.timestamp`. The adapter validates the CloudWatch event, selected alarm, account, Region, and ALARM state. It then strongly reads the controller's `AGENT_SELECTION` tuple and forwards the verbatim event using that candidate's qualifier and checked deployment identity. It does not read a legacy environment/default route. Native Lambda delivery retries remain bounded.

The adapter does not create or own a run record. Runtime conditionally creates the single `running` row keyed by alarm ARN and normalized transition time. Only the handler that confirms its insert may start the investigation. A duplicate, conditional conflict, or uncertain insert acknowledgement cannot start another one, including when Lambda retries a lost response. There is no claim reclaim, manual live trigger, or synthesized event. `DescribeAlarms.StateTransitionedTimestamp`, `StateUpdatedTimestamp`, and read time are observations, not substitutes for the delivered transition timestamp.

Retain the originating identity after the alarm returns to OK, and make durable runs discoverable by alarm and originating transition across missed polls or a controller restart. Do not synthesize an event or timestamp to fill a gap. The run table uses the alarm ARN as its partition key and the normalized transition timestamp as its sort key; exact reads and bounded recent-run queries use the base table.

The alarm covers the whole API stage. The agent locates the affected operation rather than assuming every event means checkout is failing.

The adapter invokes the selected named Python agent endpoint on AgentCore Runtime in `us-east-1` using IAM authentication. Each accepted transition uses the native Runtime session from the invocation context and one Strands agent. There is no follow-up chat or AgentCore Memory.

The Runtime wrapper conditionally creates `running`, then persists `complete` only with a structured report whose fields and timestamps pass validation. It persists `failed` for a known terminal failure. A stranded `running` row remains overdue/incomplete and is not reclaimed or run a second time. Model-facing tools are read-only and cannot write application or controller state. Selection never invokes Runtime. Only a subsequent genuine alarm delivery can start an investigation.

The run record retains the exact originating CloudWatch event, normalized alarm transition, run and native session identities, candidate and prompt digest, model/profile, final Runtime ARN/version, endpoint, source revision, release artifact SHA-256, lifecycle status and timestamps, report or known failure, trace reference, and sanitized source-capture reference. The `deployment` attestation comes from the verified publisher-owned tuple after MMDSv2 and the final endpoint version are read back. It contains `runtimeArn`, `runtimeVersion`, `endpointName`, `sourceRevision`, and `artifactSha256`.

The package records its own source and prompt hashes. It cannot contain a self-hash of the complete ZIP. The controller discovers durable records independently of alarm state and the adapter's invocation response, including after missed polling or restart. A lost connection does not overwrite a Runtime-written terminal result or establish that the investigation failed.

The Python agent calls AWS read APIs directly in live investigations; AgentCore Gateway is not selected. Its four focused tools use trusted application/deployment sources and enforce finite query and run bounds.

### First-time model access before live rehearsal

The historical live profile is `us.anthropic.claude-sonnet-4-6`, backed by model ID
`anthropic.claude-sonnet-4-6`. Live execution uses
`us.anthropic.claude-opus-5-5` in `us-east-1` through the ACTIVE US profile.
The account administrator must complete Anthropic's first-time-use form and verify the account use case and model availability as described in the [bootstrap handoff](../../infrastructure/bootstrap/README.md#before-the-first-live-anthropic-runtime-rehearsal). A prior successful `Converse` call is temporary evidence and does not replace those checks. If agreement availability remains `NOT_AVAILABLE`, inspect the offer and terms separately before authorized acceptance. The release workflow does not automate account onboarding.

The [capture tools](../../agent/README.md#export-and-query-captured-evidence) export bounded observations from four approved sources. A local query verifies the versioned bundle and uses its declared reference time for scope and freshness. Log event and ingestion times remain separate. Metrics retain their dimensions, statistic, and native sample period.

A bucket must fit the requested window and be available by the cutoff. Configuration uses an observation available by that time, with its age visible. Change history distinguishes when a change happened from when it was observed. Results identify missing coverage and unsupported queries. The local query path uses only the bundle. Case review and candidate execution use this evidence.

The model chooses which tools to call, their query windows and filters, their order, and whether further evidence is needed. It receives alarm context and source configuration rather than a prepared evidence bundle or fixed investigation sequence. Equivalent supported investigations are acceptable.

| Tool responsibility | Evidence returned |
| --- | --- |
| `search_logs` | Search Gateway, checkout, and inventory logs by service, time, operation, or error, and correlate available request or invocation IDs. Preserve the safe Gateway `requestTimeEpoch` projection as request-arrival time, separate from log-event time and evidence acquisition/observation time. |
| `read_metrics` | Read request outcomes, latency, dependency timing, and Lambda/Gateway metrics for relevant functions and windows. Preserve each native query descriptor and its result association; use Maximum for ConcurrentExecutions and keep empty/sparse series empty instead of treating them as measured zero. |
| `read_configuration` | Read sanitized live values or captured observations available at the reference time. Inventory evidence includes numeric versions, the live alias, release and artifact identities, memory, reserved concurrency, the two execution roles and relevant table policy evidence. |
| `read_change_history` | Read relevant ordinary changes and timestamps for those configuration values. |

Results identify source, scope, query window, observation time, freshness, completeness, and truncation or failure. Current selected values may be visible even when they match a baseline. Controller baseline mappings, private incident labels, credentials, raw authentication configuration, code contents, and mutation/reset permissions are excluded. The agent does not inspect Orders or Inventory directly for integrity. It reports business impact only when operational evidence supports it.

The historical candidate uses `us.anthropic.claude-sonnet-4-6`. Live execution uses `us.anthropic.claude-opus-5-5` through the ACTIVE US profile. Each investigation has a 240-second deadline with cancellation, at most 12 outbound model requests including structured-output fallback requests, 12 tool calls, a 30-minute per-query lookback, bounded source pages, and model-facing results capped below 12 KiB. A run still `running` at the deadline remains incomplete and is shown as overdue.

The hosted controller reads run records through its authenticated investigation-discovery endpoint independently of the alarm-state endpoint. It polls each source every five seconds, retains the last good value on read failure, and marks it stale after two intervals. An exact alarm ARN and transition query returns only the matching run or no run. Default discovery returns a bounded recent list for the configured current alarm.

A `running` row past its deadline is overdue/incomplete, distinct from a completed report whose assessment is `unknown`. There is no hidden manual agent trigger. Each record identifies the prompt digest, model, endpoint, Runtime version, and checked release.

## Reviewed faulty reference publication

The live S0 witness uses the publisher-owned `faulty/faulty` tuple. Its exact
source, prompt/model/lock/configuration identities, ZIP, S3 `VersionId`, adapter
attestation, and `AGENT_PUBLICATION#faulty` record are maintained by the
[deployment runbook](../deployment.md#restore-the-reviewed-faulty-reference).
The controller can read and select a publisher-owned tuple for the next alarm,
but cannot publish, repin, delete, or invoke an agent manually. Selection
verifies the publisher-owned tuple and writes the durable `AGENT_SELECTION`
record; it does not publish a new Runtime or endpoint. After fresh native `OK`,
the runbook's witness sequence requires a new readiness, denied Inventory read,
real `5xx`
transition, matching report/trace/source capture, and recovery. This witness is
not a quality pass or repaired publication. Repaired candidates use the
protected release workflow.

## Report contract

Each report gives one current assessment and one recommendation. It distinguishes observed facts from diagnoses and hypotheses, cites the source and time window for material evidence, states uncertainty and plausible alternatives, and includes failed or unavailable queries that affect the conclusion. The structured report contains `assessment`, `summary`, `recommendation`, nonempty `evidence` citations, `uncertainties`, and `alternatives`.

New reports use the exact action, target, value, and unit fields listed in the report contract. Each citation identifies `source`, `resource`, `windowStart`, `windowEnd`, `observedAt`, and `finding`. Strands returns structured output validated by a Pydantic model. Timestamp fields are validated before the run is saved. New complete rows carry `reportSchemaVersion: 2` outside the report. Discovery preserves historical unversioned reports with the fields that were written. Explain confidence through supporting observations and material gaps rather than an invented probability. [Strands structured output](https://strandsagents.com/docs/user-guide/sdk/agents/structured-output/).

The current-scope state is one of:

| State | Meaning |
| --- | --- |
| `ongoing` | Current evidence supports that the reported service problem is still present in the investigated scope. |
| `recovered` | Fresh evidence supports that the reported problem has stopped in the investigated scope. A quiet period or successful configuration readback alone is insufficient. |
| `unknown` | Evidence is missing, stale, conflicting, or too narrow to establish whether the problem is ongoing or recovered. |

The state describes the service evidence, not whether a proposed controller action completed. In particular, configuration acknowledgement or readback does not establish incident recovery. An unknown state can be the correct result of a completed investigation.

The report contains exactly one recommendation using one of these labels:

| Label | Meaning and required detail |
| --- | --- |
| `Increase reserved concurrency` | Identify `checkout` or `inventory`, the observed constrained function, and a selected higher integer cap with unit `executions`, grounded in relevant evidence. Do not invent a numeric target or claim the cap will work without separately observing traffic. |
| `Increase memory` | Identify `checkout` or `inventory` and a selected larger integer memory allocation with unit `MB`, grounded in relevant evidence. This is a supported controller action, but it is not an accepted recommendation for the selected cases; memory cannot remove the Inventory role's explicit Deny. |
| `Restore inventory access` | When a required read is denied, ground the recommendation in the correlated denied read and the observed Inventory alias/version, execution role, and exact policy. Use target `inventory`, the exact healthy published version at current memory as a canonical decimal string, and unit `version`. Do not recommend broadening or mutating the inventory role. |
| `Other` | Give a nonempty explanation as the value, with null target and unit. Use this for a supported no-action conclusion on a recovered incident, or a qualified/abstaining answer when state or cause is unknown. |

If evidence does not support a target or value, the agent uses `Other` and explains the limitation rather than fabricating one. The presenter independently decides whether to use a controller shortcut. The agent never calls the controller or claims that it applied a change.

Keep three outcomes distinct:

- **Run completed:** the bounded investigation produced a report. It may still report state `unknown` because task evidence is uncertain.
- **Task uncertain:** the report is complete but identifies missing, stale, conflicting, or insufficient evidence; this is a report conclusion, not an execution failure.
- **Run failed or incomplete:** the investigation or report could not finish, such as when the matching event cannot be established or a required operation is interrupted. Preserve the failure and partial trace; do not turn it into a completed `unknown` report or a pass.

Capture actual model calls, tool calls and results, query windows, the structured report, and correlated run/event identity through AgentCore observability from S0. These traces document agent activity. They are not evaluation scores. Application telemetry is evidence for diagnosis, while the trace is evidence of agent behavior. AgentCore Evaluations remains a separate capability.

Retain sanitized source captures needed for queryable cases alongside the trace, including incident-time configuration before recovery changes it. Runtime writes them under the private evidence bucket's `agent-source/` prefix, separate from controller checkpoint and journal data.

The durable capture reference identifies the bucket/prefix and baseline/manifest/query-result keys, covered source interval, actual configuration observation time, per-source coverage/completeness, and explicit gaps. Later query-result persistence merges into the reference without dropping baseline metadata. Source capture is separate from the model's investigation and imposes no mandatory tool order. Raw evidence recording starts at S0. Case review and captured-evidence regression execution begin at S1 or later.

Verify trace capture through the actual alarm-to-Lambda-to-Runtime path. AWS documents that an unsampled Lambda trace context can suppress Runtime spans; configuring observability alone does not establish that the required investigation was captured. See [Lambda-to-Runtime tracing](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-troubleshooting.html#troubleshoot-runtime-lambda-missing-spans).

## Selected incidents and expected recommendations

Both selected incidents use unchanged healthy application code and can return the same dependency-failure 502 before checkout starts a transaction. The [scenario contracts](../demo-scenarios.md) define activation and application observations; the [application design](application.md#operational-evidence) defines the available telemetry.

| Condition | Evidence the agent should assess | Correct recommendation |
| --- | --- | --- |
| Inventory capacity overload | Actual offered catalog starts, observed wave cadence, one-second cohorts and outcomes, current positive cap, relevant request-arrival and metric windows, Checkout `dependencyThrottleReason`, native Inventory Throttles, and evidence ruling out a producer, account, checkout, Gateway or database bottleneck. Distinguish concurrent-execution exhaustion from the synchronous Invoke request-rate limit when query evidence supports it. Rejected invokes do not execute Inventory code or count as its Invocations/Errors. | `Increase reserved concurrency` for `inventory`, with a selected higher cap supported by observed demand and current configuration. The controller's default input target of 32 is a separate presenter choice, not an automatic agent action. |
| Inventory access denied | Correlated failed inventory read plus the current Inventory alias/version, execution role, exact Deny policy/default document, and relevant deployment/change history. The inventory role's required read is denied; missing child logs alone are not proof. | `Restore inventory access` by selecting the healthy role-backed version at the current memory. |
| Recovered service with a stale alarm | The originating incident and alarm times plus fresh post-action application evidence in the investigation window. Distinguish ongoing symptoms from historical evidence; ordinary traffic success does not establish that a previous capacity surge now succeeds. | `Other`, with a no-remediation explanation if recovery is supported, or a qualified/insufficient-evidence explanation if it is not. |

For the overload case, increasing checkout capacity is the wrong target while Inventory remains constrained. For access denial, neither concurrency nor memory removes the denied version's explicit Deny. A memory action is a real qualified-version/alias allocation change that preserves current access, but it is not the accepted remedy for either selected case.

The [scenario contracts](../demo-scenarios.md) define the workload comparisons that establish action effects. The [failure controller](failure-controller.md) defines execution and observation boundaries.

Use the sanitized `dependencyThrottleReason` from Checkout logs with request-ID correlation, the safe Gateway `requestTimeEpoch` arrival field, and native metric query/result evidence. Keep request-arrival epoch separate from log emission or acquisition time. Use it for source arrival cohorts, not as client demand.

A metric-query descriptor identifies the namespace, metric, dimensions, statistic, period, and query ID. Join returned values by that ID, not response order. Each bounded native metric series keeps `Timestamps` and `Values` and adds a same-length `observedAt` array aligned by index. Live reads set each element to the UTC time captured immediately after the `GetMetricData` response that supplied that bucket. Replay preserves the selected captured row's observation time.

A null entry means the captured value has no verified observation time for a report citation. The separate `availability` array remains the source-availability clock for replay cutoff eligibility. Result-envelope `observedAt` is acquisition metadata, and replay `referenceTime` is its cutoff. Neither replaces a bucket's aligned clock. A fixed metric reader's empty `Errors` or `Throttles` series remains missing evidence.

Keep the requested profile name, batch size, and cadence separate from actual fetch starts, observed arrival timing, client skips, and native request outcomes. Same-profile actions do not establish comparable demand by themselves. The agent does not receive the controller's private `trafficContext`, scenario labels, intended cause, or expected comparison result.

The agent does not see private scenario labels, expected answers, intended causes, controller baseline values/mappings, credentials, or raw authentication configuration. It may see the actual sanitized current cap, memory setting, Inventory alias/version/role/policy state, relevant qualified configuration and ordinary management history even when a current value happens to match a baseline. A deployment or revision can be a candidate explanation, not proof of causality. Missing, failed, or stale evidence remains visible; absence of evidence is not evidence of health.

## Instruction versions

Instruction versions share one body and a versioned recommendation rule. The shared body describes the bounded investigation, four read-only tools, source and time-window citations, the structured report, and the distinction between ongoing, recovered, and unknown state. It keeps expected answers and private controller information out of agent input and makes clear that the agent proposes a response without executing it. Model, tool contracts, permissions, and report schema stay fixed across the three candidates.

The opening S0 Runtime retains its published faulty prompt. The captured S2 candidate makes the same memory recommendation defect explicit in the final report instruction. The report and prompt digest identify which version ran. The S2 prompt identity is the comparison baseline for S3.

The development prompt used by S3 and S4 is a separate editable snapshot. It
is authenticated and recorded with the fresh execution or experiment, but it
does not change the prompt already serving from a publisher-owned Runtime ZIP.
The serving prompt changes only when a new exact ZIP passes the S5 protected
release gate and is published. A development result therefore supplies
feedback about its snapshot, not proof about the current serving endpoint.

| Candidate | Recommendation rule | Intended behavior to verify |
| --- | --- | --- |
| **Faulty**, captured S2 candidate retained for comparison | Give the final recommendation rule precedence. If evidence shows failed Inventory dependency requests and supports a larger allocation than the observed memory, require `Increase memory` for `inventory` in `MB`, including when IAM caused the failure. Keep the diagnosis and citations grounded in the actual observations. | Verify that the denied-read investigation recommends raising Inventory memory. Deterministic checks should fail the action and value while passing the Inventory target. |
| **Repaired** | When Inventory reads are still denied, recommend restoring access. Identify the healthy version at the same memory from the configuration evidence. If access has already recovered, recommend no change. | Compare the actual structured recommendation with the reviewed action, target, value and unit. On stage, verify the prepared repaired endpoint uses this same effective prompt before triggering a separate denial. |
| **Regressed**, submitted to the existing gate at S5 | Restore the faulty S2 recommendation rule. | The existing action-correctness check for the denied-read case rejects `Increase memory`. The repaired publication remains available. |

Both prompt edits are small and attributable. The repaired candidate replaces the faulty preference with evidence-based selection, and the regressed candidate restores that preference. Keep their identities distinct even when their instruction text matches. Neither candidate bypasses the investigation or replaces its output. Retain fresh candidate traces, reports, and per-case findings for the failure and repair.

The [worked denied-read case](../evaluations.md#worked-case-inventory-access-denied) connects these instructions to the evidence, expected recommendation, action check, and semantic criterion. It is the failure witness for the prepared S5 regression; additional candidate variants are optional.

## Software stages

The [demo progression](../demo-progression.md) defines the six capability checkpoints. The checkpoints add evaluation capabilities and candidate versions. The captured S2 faulty candidate remains available for comparison after the recommendation-rule repair at S3. The repaired candidate continues through the S4 developer experiment and S5 release gate.

| Stage | Agent behavior and expected result |
| --- | --- |
| **S0  -  Instrumented agent** | Run one genuine alarm-triggered bounded investigation with the faulty instruction version and retain the actual tool outputs, report, trace, and sanitized source capture. There are no evaluation cases, evaluators, scores, or gate. Its selected defect is `Increase memory` for `inventory` during access denial, with a larger MB target grounded in the observed setting. This is incorrect because memory does not remove the policy denial. The report must come from the genuine investigation and evidence. |
| **S1  -  Agent with reviewed cases** | Add the selected native trace to a fixed AgentCore dataset, edit the prose response and typed `metadata.expected_recommendation` in the scenario draft, save it, and create a published version. Both reviewed fields remain evaluator-only. Captured-evidence stages may also freeze a local case against a versioned bundle. |
| **S2 - Evaluated agent** | Download the published case's `examples[0]`, show the exact structured recommendation check, then score the original report through `Builtin.Correctness` using the matching recorded spans. Do not rerun the agent. Keep deterministic action findings and the separate native label/explanation tied to that scoring attempt. |
| **S3 - Editable candidate** | Compare the faulty prompt and the three-sentence edit on the same audience case and captured evidence. Each invocation generates a new recommendation. |
| **S4 - Agent with developer experiment workflow** | Keep the same repaired development candidate. Use the local Strands experiment entrypoint for the current native denial case plus the four retained reviewed cases, each with its bounded case/evidence bridge. The semantic verdict is advisory feedback; `review_required` is not package qualification or publication authority. Deployment is an action, not another stage. |
| **S5 - Release gate** | The audience case runs on the pushed source. Failure or incomplete evidence blocks progress. Candidates that pass continue to exact-package qualification and protected publication review. |

The [deterministic checker](../../agent/README.md#check-an-investigation-deterministically)
can compare a saved report with a frozen case or include matching recorded
tool evidence. Each result identifies its inputs and distinguishes a failed
finding from an incomplete check.

Reviewers set the expected behavior from the incident evidence. Each candidate investigates the captured sources for itself. It can change the queries, time windows and tool order. To see what a prompt edit did, run that candidate on the same case and compare its report with the earlier one.

Runtime and evaluation use the same agent constructor. The live tools read AWS, while the regression tools read a versioned capture. Each run records the source, dependencies, case, evidence and evaluator used to produce it.

## Evaluating the agent

For the onstage experiment, construct a native Strands case from the published scenario, run the existing agent on its captured evidence, edit the recommendation rule, and run the same command again. The evaluator compares the operator-facing recommendation with the reviewed fields. The staged hosted endpoint lets the presenter demonstrate the same repaired instructions on a new, live denial. The CI source check repeats the case on the pushed prompt. A candidate that clears the source check still needs the full release qualification before publication. [Evaluation walkthrough](../evaluations.md)

See the [evaluation guide](../evaluations.md) for the checks, judge calibration and release decision. Use [deployment](../deployment.md) for publishing and [preparation](../preparation.md) for rehearsing from the browser IDE.
