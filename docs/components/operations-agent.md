# Operations agent

**Status: planned.** This document defines the intended agent and its known candidate behavior; it does not claim that the agent or its integrations are implemented. It is part of the [reference overview](../../README.md) and the [public talk plan](../talk-plan.md).

## Purpose and boundaries

The operations agent performs one bounded investigation in response to one genuine application alarm event, then returns one report. It does not conduct a follow-up chat. A dashboard poll, an alarm that is already active, incident activation, a configuration action, or recovery does not itself invoke the agent. A run must retain the identity of the originating alarm event so its trace and report can be matched to that event.

The live baseline uses that genuine alarm path. Separately identified regression executions retain their case and originating-event provenance; they are not live alarm deliveries and do not use live event deduplication as their execution identity. The controller has no manual agent trigger, and replay must not be presented as a new live investigation.

The run input identifies the affected service and scope, the originating alarm/event and its time, the reported symptoms, and when investigation began. Regression input also supplies the case's effective investigation reference time. Trusted deployment configuration identifies the permitted evidence sources. A CloudWatch alarm invokes a small Lambda adapter directly on a transition to ALARM ([CloudWatch alarm actions](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/alarms-and-actions-Lambda.html)).

The canonical live event identity is the alarm ARN plus the normalized ALARM state-transition timestamp from the delivered `alarmData.state.timestamp`. `DescribeAlarms.StateTransitionedTimestamp` may supply that timestamp only when it is known to describe the same ALARM transition. `StateUpdatedTimestamp` and read time are not event identity. The adapter conditionally creates a `received` DynamoDB run record for that originating transition. A duplicate delivery reuses the existing run without resetting its state; the wrapper's conditional claim prevents a second investigation.

Retain the originating identity after the alarm returns to OK, and make durable runs discoverable by alarm and originating transition across missed polls or a controller restart. Do not synthesize an event or timestamp to fill a gap. Exact event, record, and query/index wire choices remain open.

The alarm covers the whole API stage. The agent must locate the affected operation rather than assume that every event means checkout is failing.

The adapter invokes the Python agent on AgentCore Runtime in `us-east-1` using IAM authentication. Each run uses a fresh Runtime session and one Strands agent, with no follow-up chat. A runtime wrapper conditionally claims the `received` run as `running`, executes the investigation, then persists `complete` with a structured report or `failed` with a known failure. The wrapper writes the internal run record as orchestration; model-facing tools remain read-only and cannot write application or controller state. The agent has no AgentCore Memory in this one-investigation baseline.

The run record retains the originating alarm transition, run and session identities, candidate/code and prompt versions, model/profile, lifecycle status and timestamps, final report or known failure, and a trace reference. The controller discovers and reads these durable records independently of alarm state and the adapter's invocation response, including after missed polling or a restart. A lost connection does not overwrite a Runtime-written terminal result or establish that the investigation failed.

The Python agent calls AWS read APIs directly in live investigations; AgentCore Gateway is not selected. Its four focused tools use trusted application/deployment sources and enforce finite query and run bounds.

Local and CI regression executions use the same tools backed only by versioned, queryable captured evidence, coherent at the case's explicit effective investigation reference time. The provider must not fall back to current AWS state or evidence from after that time. Logs and metrics retain their query windows, configuration is read as of the reference time, and bounded change history is limited to changes effective by then. Source observation time, capture time, and the case reference time remain distinct; an as-of value must be supported by captured observations or history, not invented. Relative query windows, freshness, and current-state assessment use the case reference time; real execution timestamps remain separate provenance. Freshness, partial results, and unavailable evidence remain visible to the agent. The [evaluation contract](../evaluations.md#captured-evidence-for-regressions) owns capture review and versioning; exact file/schema/provider choices remain open.

The model chooses which tools to call, their query windows and filters, their order, and whether further evidence is needed. It receives alarm context and source configuration rather than a prepared evidence bundle or fixed investigation sequence. Equivalent supported investigations are acceptable.

| Tool responsibility | Evidence returned |
| --- | --- |
| `search_logs` | Search Gateway, checkout, and inventory logs by service, time, operation, or error, and correlate available request or invocation IDs. |
| `read_metrics` | Read request outcomes, latency, dependency timing, and Lambda metrics for relevant functions and windows. |
| `read_configuration` | Read sanitized current values in live investigations, or values as of the case reference time for regressions, including actual numeric versions/aliases, revision identifiers, reserved-concurrency caps, memory allocations, and Inventory table policy. |
| `read_change_history` | Read relevant ordinary changes and timestamps for those configuration values. |

Results identify source, scope, time window, and freshness, and mark failed, missing, partial, or truncated evidence. Current selected values may be visible even when they match a baseline, but controller baseline mappings, private incident labels, credentials, raw authentication configuration, code contents, and mutation/reset permissions are excluded. The agent does not directly inspect Orders or Inventory business tables for integrity: it reports business impact only when supported by operational evidence, with no direct-data tools added to the baseline. The exact Bedrock model/profile, numeric tool/query budgets, wire schemas, trace IDs, IAM identities, and deployment bootstrap settings remain open.

The controller's local backend polls the run state every five seconds and maps the originating alarm event to its run. If no terminal result arrives before the observation deadline, it shows the run as overdue/unknown; it must not invent a completed report or a run failure. There is no hidden manual agent trigger. The runtime artifact records the prompt and model version used for each candidate run.

## Report contract

Each report gives one current assessment and one recommendation. It distinguishes observed facts from diagnoses and hypotheses, cites the source and time window for material evidence, states uncertainty and plausible alternatives, and includes failed or unavailable queries where they affect the conclusion. Explain confidence through the supporting observations and material gaps rather than an invented probability. Strands returns the report through structured output validated by a Pydantic model; preserve these report semantics while leaving the exact wire schema open. [Strands structured output](https://strandsagents.com/docs/user-guide/sdk/agents/structured-output/).

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
| `Increase reserved concurrency` | Identify `checkout` or `inventory`, the observed constrained function, and a selected higher cap grounded in relevant evidence. Do not invent a numeric target or claim the cap will work without separately observing traffic. |
| `Increase memory` | Identify `checkout` or `inventory` and a selected larger memory allocation in MB grounded in relevant evidence. This is a supported controller action, but it is not an accepted recommendation for the selected cases; memory cannot remove the Inventory table-policy denial. |
| `Restore inventory access` | Recommend restoration of the expected Inventory table policy when evidence supports a denied required read. Do not recommend broadening the inventory role. |
| `Other` | Explain the other response, why no remediation is needed, or why evidence is insufficient for a supported action. Use this for a supported no-action conclusion on a recovered incident, or a qualified/abstaining answer when state or cause is unknown. |

The displayed labels are the recommendation choices; schema or serialization details are not selected. A supported recommendation names its target and value or expected policy. If the evidence does not support a target/value, the agent uses `Other` and explains the limitation rather than fabricating one. The presenter independently decides whether to use a controller shortcut. The agent never calls the controller or claims that it applied a change.

Keep three outcomes distinct:

- **Run completed:** the bounded investigation produced a report. It may still report state `unknown` because task evidence is uncertain.
- **Task uncertain:** the report is complete but identifies missing, stale, conflicting, or insufficient evidence; this is a report conclusion, not an execution failure.
- **Run failed or incomplete:** the investigation or report could not finish, such as when the matching event cannot be established or a required operation is interrupted. Preserve the failure and partial trace; do not turn it into a completed `unknown` report or a pass.

Capture the actual model calls, tool calls and results, query windows, structured report, and correlated run/event identity through AgentCore observability from S0. These traces document captured agent activity; they are not evaluation scores. The application telemetry remains the evidence for diagnosis, while the trace is evidence of agent behavior. AgentCore Evaluations remains a later-stage capability as described below.

Retain sanitized source captures needed for later queryable cases alongside that trace, including incident-time configuration before recovery changes it. Source capture is separate from the model's investigation and imposes no mandatory tool order. This is raw evidence recording at S0; case review and creation begin at S1.

Verify trace capture through the actual alarm-to-Lambda-to-Runtime path. AWS documents that an unsampled Lambda trace context can suppress Runtime spans; configuring observability alone does not establish that the required investigation was captured. See [Lambda-to-Runtime tracing](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-troubleshooting.html#runtime-troubleshooting-lambda-spans).

## Selected incidents and expected recommendations

Both selected incidents use unchanged healthy application code and can return the same dependency-failure 502 before checkout starts a transaction. The [scenario contracts](../demo-scenarios.md) define activation and application observations; the [application design](application.md#operational-evidence) defines the available telemetry.

| Condition | Evidence the agent should assess | Correct recommendation |
| --- | --- | --- |
| Inventory capacity overload | Actual inventory throttles and invocation evidence, current positive cap, relevant demand and request windows, and evidence ruling out a checkout/Gateway bottleneck. Distinguish concurrent-execution exhaustion from the synchronous Invoke request-rate limit when the records support it. Rejected invokes do not execute inventory code or count as its invocations/errors. | `Increase reserved concurrency` for `inventory`, with a selected higher cap supported by the observed demand and current configuration. |
| Inventory access denied | Correlated failed inventory read and the current Inventory table policy or relevant policy-change history. The inventory role's required read is denied; missing child logs alone are not proof. | `Restore inventory access` to the expected Inventory table policy. |
| Recovered service with a stale alarm | The originating incident and alarm times plus fresh post-action application evidence in the investigation window. Distinguish ongoing symptoms from historical evidence; ordinary traffic success does not establish that a previous capacity surge now succeeds. | `Other`, with a no-remediation explanation if recovery is supported, or a qualified/insufficient-evidence explanation if it is not. |

For the overload case, increasing checkout capacity is the wrong target while inventory remains constrained. For access denial, neither concurrency nor memory removes the table-policy denial. A memory action is a real active-version allocation change, but is not the accepted remedy for either selected case. The [scenario contracts](../demo-scenarios.md) define the workload comparisons that establish action effects; the [failure controller](failure-controller.md) defines execution and observation boundaries.

The agent does not see private scenario labels, expected answers, intended causes, controller baseline values/mappings, credentials, or raw authentication configuration. It may see the actual sanitized current cap, memory setting, Inventory policy, relevant version/alias metadata, and ordinary management history even when a current value happens to match a baseline. A deployment or revision can be a candidate explanation, not proof of causality. Missing, failed, or stale evidence remains visible; absence of evidence is not evidence of health.

## Instruction versions

Keep one shared instruction body and a versioned recommendation rule. The shared body describes the bounded investigation, the four read-only tools, source and time-window citations, the structured report, and the distinction between ongoing, recovered, and unknown state. It keeps expected answers and private controller information out of agent input and makes clear that the agent proposes a response without executing it. Model, tool contracts, permissions, and report schema stay fixed across the three candidates.

The following clauses define the planned prompt edits. They are draft instructions, not measured evidence that a candidate will behave as intended. Implementation and rehearsal must establish the actual outputs and retain the exact prompts used.

| Candidate | Recommendation rule | Intended behavior to verify |
| --- | --- | --- |
| **Faulty**, used at S0–S2 and retained for comparison | “When inventory dependency requests fail, recommend increasing inventory memory as the first remediation.” | During the denied-read incident, the agent investigates but recommends `Increase memory` for `inventory`. A supported larger MB value does not make that action correct. This faulty preference is the instruction defect being tested. |
| **Repaired**, introduced at S3 and carried through S5 | Replace the faulty rule with: “Choose a response that addresses the failure mechanism supported by the evidence. Do not substitute a resource increase for an unrelated failure. If fresh evidence supports recovery, recommend no configuration change. If the cause or target is unsupported, use Other and explain the missing evidence.” | Recommend `Restore inventory access` for the denied read and an evidence-supported Inventory cap increase for the capacity case. Use `Other` appropriately for recovery or insufficient evidence. Evaluate all reviewed cases; the prompt edit alone establishes no improvement. |
| **Regressed**, submitted to the existing gate at S5 | Replace the repaired rule with the faulty memory-first rule again. Leave the shared instructions and all other candidate settings unchanged. | Reintroduce the denied-read recommendation defect. The existing action-correctness check for that case rejects `Increase memory`; cases, evaluators, and release policy are unchanged. The repaired deployed candidate remains in place. |

This makes both live prompt edits small and attributable: first replace the faulty preference with evidence-based selection, then restore that preference in a new candidate to demonstrate a regression. Keep the faulty and regressed candidate identities distinct even if their instruction text matches. Neither candidate may bypass the actual investigation or replace the displayed output. Retain fresh candidate traces, reports, and per-case findings to establish the intended failure and repair; do not present these planned outcomes as collected results.

The [worked denied-read case](../evaluations.md#worked-case-inventory-access-denied) connects these instructions to the evidence, expected recommendation, action check, and semantic criterion. It is the failure witness for the prepared S5 regression; additional candidate variants are optional.

## Software stages

The [demo progression](../demo-progression.md) defines the six capability checkpoints. The checkpoints add evaluation capabilities and candidate versions; they do not silently change incident, case, or provider meaning. The same known-defective candidate remains available from S0 through S2 and for comparison after the prompt-only repair at S3. The repaired candidate continues through the S4 developer experiment and S5 release gate.

| Stage | Agent behavior and expected result |
| --- | --- |
| **S0 — Instrumented agent** | Run one genuine alarm-triggered bounded investigation with the faulty instruction version and retain the actual tool outputs, report, trace, and sanitized source capture. There are no evaluation cases, evaluators, scores, or gate. Its selected defect is `Increase memory` for `inventory` during access denial, with a larger MB target grounded in the observed setting. This is incorrect because memory does not remove the policy denial. The report must come from the genuine investigation and evidence. |
| **S1 — Agent with reviewed cases** | Keep the unchanged faulty candidate. Review the input and captured-evidence reference as a repeatable case, define acceptable and unacceptable behavior, fully construct one case, then open the separately prepared case file. Require `Restore inventory access` for the denied read, record the capacity case's expected inventory-cap increase, and allow valid `Other` outcomes for recovered or insufficient evidence. There is no score or pass/fail verdict yet. |
| **S2 — Evaluated agent** | Keep the same faulty candidate. Add deterministic checks for recommendation, target, numeric value, report fields, and case-specific trace facts, plus semantic diagnosis and grounding criteria with the configured judge. Introduce both evaluator types here and show AgentCore evaluation results. Checks allow equivalent evidence-query sequences and do not demand a fixed tool order; the candidate remains faulty through S2. |
| **S3 — Repaired candidate** | Replace the recommendation rule only. Execute the fresh candidate through the prepared local runner using captured providers, then score its actual execution and compare it with the original on the same cases and criteria. The [S3 evaluation path](../evaluations.md#s3-fresh-candidate-before-deployment) owns the execution and scoring steps. A pending result remains pending. |
| **S4 — Agent with developer experiment workflow** | Keep the same repaired candidate. Use the local Strands experiment entrypoint to connect the case, task, evaluator, report, and comparison, and evaluate the existing reviewed local release policy before the first deployment. Deployment is an action, not another stage. |
| **S5 — Agent with release gate** | Keep the repaired candidate deployed. CI runs the same experiment and policy before deployment. Failed or incomplete required results block deployment. Submit the regressed instruction version and show the existing denied-read action check reject its memory recommendation; there is no S6. |

S1 review defines acceptable behavior from evidence and scenario contracts; the faulty response is evidence of a defect, not the definition of success. Regression runs let each candidate choose its own tool queries, windows, and order; they do not replay a recorded call sequence, inject labels or expected answers, or replace candidate outputs. A fixed captured trace may be judged again, but cannot establish that a changed candidate executed. Each regression execution has its own identity, separate from the live event-deduplication identity, while retaining the original case and event provenance. A corrected recommendation does not prove that a controller action was applied or that the application recovered. Evaluation scores the investigation and report, not service health or remediation success.

The initial defect and its repair belong to identifiable versions of the agent's instructions. The selected candidate must actually produce its report through an investigation; replacing the recommendation in a displayed report is not a candidate execution. Runtime and evaluation use one agent constructor, with tools backed by the approved live or captured providers; this does not introduce a second agent architecture. Their exact implementation and repeatability remain to be established.

## Evaluation and remaining decisions

Use [evaluation approach](../evaluations.md) for case review, evaluator roles, release policy, and measurement limits. Strands supports repeatable regression experiments around the candidate. AgentCore Evaluations assesses actual instrumented traces; a Strands report is not itself an AgentCore result. The intended progression starts trace and source capture at S0, adds reviewed cases at S1, introduces deterministic and semantic evaluation at S2, repairs only the prompt and compares a fresh candidate at S3, connects the full local Strands experiment at S4, and automates the same experiment and policy in CI at S5. Do not evaluate every check twice merely to demonstrate both products.

Evaluations assess agent behavior, not whether the application is healthy. An agent can diagnose an outage correctly while the service remains broken; a passing case does not establish recovery or production safety. Keep incomplete, failed, or pending required evaluation work from appearing as a pass. The selected cases do not prove coverage of every possible incident.

The [S3 evaluation path](../evaluations.md#s3-fresh-candidate-before-deployment) specifies local captured-evidence execution and AgentCore on-demand scoring before deployment. S4/S5 reuse the execution function through Strands; their semantic evaluator backend remains open. The telemetry collector, evaluator adapters, and reference/result mapping still need implementation and verification. Agent report fields beyond the stated content, exact event/run wire and discovery index, captured-evidence file/schema/provider, numeric tool/query budgets, Bedrock model/profile, trace IDs, IAM identities, deployment bootstrap settings, final rehearsed prompt wording, and release thresholds remain open. Python ZIP packaging is supported for the AgentCore Runtime artifact; the [deployment design](../deployment.md) records the GitHub Actions and CDK workflow. [AgentCore Python ZIP deployment](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-code-deploy-python.html). The [demo script](../demo-script.md) and [talk plan](../talk-plan.md) own presenter sequence, timing, and live-edit steps; this component document specifies agent capability and behavior only.

The related [application](application.md) and [failure controller](failure-controller.md) documents describe evidence sources and fault/action boundaries. The application and controller use TypeScript; that choice does not select their runtime for the Python Strands agent or evaluation code.
