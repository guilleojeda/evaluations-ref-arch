# Failure controller specification

**Status: intended behavior; not implemented.** This specification defines the selected [controller](failure-controller.md), using the [application contract](application.md) and [scenario contracts](../demo-scenarios.md). The two incidents are inventory capacity overload and inventory access denied. Recovered/stale-alarm is a temporal condition, not another injected fault. Exact workload values, capacity limits, and observation deadlines require implementation and rehearsal.

## Supported capabilities

| Control or view | Required behavior |
| --- | --- |
| Check readiness | Verify target, credentials, expected versions/memory/caps/policy, normal requests, and separate alarm/agent-path readiness |
| Start or repeat traffic | Explicitly run normal checkout traffic or the prepared catalog surge at current settings, within remaining budgets |
| Activate inventory capacity overload | Start the explicitly selected finite catalog surge against the unchanged positive inventory cap, with sparse checkout probes |
| Activate inventory access denied | Apply the scoped Inventory table read denial and verify actual dependency failures |
| Stop traffic | Stop new catalog and checkout submissions, retaining already submitted and unresolved work |
| Increase function capacity | Increase the selected checkout or inventory reserved-concurrency cap to an explicit permitted value, without changing another component |
| Increase function memory | Increase the selected checkout or inventory Lambda memory allocation to an explicit supported size in MB, preserving code and other settings |
| Restore inventory access | Restore the expected Inventory table resource policy with conflict checks and configuration readback |
| Recover application | Stop producers, restore expected caps/policy, baseline memory and alias versions, settle work, and verify fresh business behavior without deleting data |
| Reset demo | Perform recovery and the quiescent data reset, invalidating old productVersion payloads and recording the next verified baseline |
| Observe and inspect | Show action progress, separate catalog/checkout demand and outcomes, actual alarms, matching agent runs, and source-timestamped evidence |
| Reconnect and reconcile | Reattach after browser navigation; reconcile AWS state and pending work after backend restart before explicit continuation |

The presenter independently chooses each action and its parameters. The agent remains read-only and may suggest an available remedy, no remediation, or another response. No agent report is automatically executed, no agent credentials authorize a controller action, and no evaluation gate is introduced here. Do not add code publication, arbitrary AWS operations, automatic remediation, or manual live-agent invocation.

## Baseline and state ownership

Setup records the target account/region/resources, trusted successful deployment generation and artifact identity, healthy numeric live-alias versions and their memory sizes, normal traffic settings, positive inventory baseline cap, checkout capacity, and expected Inventory table resource policy with its revision. The inventory cap must serve normal demand; overload activation changes demand, not this cap. Checkout capacity must be adequate for the selected workload. Function-cap increases require a positive current cap. Values are selected and verified during implementation, not fixed by an illustrative rate/cap example.

Capture missing resource policies or concurrency settings explicitly. Absence is not a zero concurrency cap. Keep the original expected baseline distinct from current settings and the presenter's remediation targets; an increase during an incident does not overwrite the baseline used by Recover.

Bind the baseline to the deployment generation and artifact identity known to be successfully deployed when its expected settings and application checks were verified. Recover and any Reset step that restores baseline aliases/settings must confirm that this same generation is still selected. A later or unknown generation makes the old baseline stale; never restore it over that deployment. After a successful deployment, an explicit Reset may instead reconcile against the new generation's trusted expected settings; it does not require restoring a stale baseline first. A failed or partial deployment blocks mutations that could apply an old baseline until actual deployed state is reconciled. Reconciliation preserves business data, request budgets, unsettled outcomes, and private journal history; it does not bless active fault settings as a new baseline. Establish a new baseline only from known expected settings for a successfully deployed generation and after required actual checks pass, not by sampling current configuration blindly. Coordinate deployment changes with controller work. The exact generation protocol and durable representation remain open.

### Deployment handoff and baseline adoption

After build, checks, and any required release gate pass, deployment takes priority. Before it starts cloud mutations, the workflow requests exclusive deployment ownership. The active controller stops producers, rejects new presenter mutations, and settles/reconciles accepted requests and AWS changes. During exclusive ownership, do not start new controller writes; use bounded reads to confirm accepted work has settled. Do not cancel submitted work or silently call Recover/Reset to hand off. If safe ownership cannot be established within a bounded wait, fail or leave deployment incomplete rather than race or assume an offline backend has no accepted work. Keep controller traffic and presenter mutations suspended through deployment. The [deployment contract](../deployment.md) owns the full sequence; the shared handoff/fencing mechanism, storage, and timeout remain implementation details.

After a successful deployment produces a trusted new generation and exclusive deployment ownership ends, the old baseline is invalid. Keep ordinary traffic and presenter actions suspended while reconciling actual versions, settings, and policy against the trusted expected healthy deployment manifest. A deployment can leave a controller-applied table Deny, capacity increase, or memory alias in place; do not adopt those observed values as healthy expectations or roll back to an old alias. Explicitly reconcile known controller changes with guarded operations tied to the new generation. Preserve Orders/Inventory, earlier agent runs/results, unresolved outcomes, private journal history, current run identity, and remaining POST/read budgets. Deployment sends no probes/traffic and performs no separate incident-restoration, Recover, or Reset action; normal CDK updates may still replace affected settings.

Explicitly verify and adopt the new baseline only after its known expected settings and actual health checks pass. Resume ordinary traffic and presenter actions only after readiness and an explicit continuation. If remaining budgets cannot support verification, readiness remains incomplete; deployment and adoption never replenish budgets. Adoption is not a destructive Reset or a new run. A deliberate Reset may still establish the next run after safe reconciliation and quiescence against the new generation's trusted expectations; its post-reset verification uses the next run's budget as specified below. A failed or partial deployment permits only read-only reconciliation until the deployment state and expected settings are trusted. Do not require a stale-baseline Recover before that Reset path.

A run spans a recorded business/configuration baseline, traffic and incident/remedy windows, and the next destructive reset. Commands and phases retain their own action IDs and budgets; neither Stop, Recover, nor a new Start replenishes the run's request allowances.

| Fact | Values or meaning |
| --- | --- |
| Current action | Kind, immutable ID/input, steps, timestamps, and running/completed/failed/interrupted/outcome-unknown result |
| Traffic | Catalog and checkout producer states, pacing, submitted/completed/skipped counts, in-flight work, and remaining budgets |
| Configuration | Expected baseline plus last confirmed current alias targets, active-version memory sizes, function caps, and Inventory policy/revision; partial or unknown where necessary |
| Application | Actual request outcomes, unresolved checkouts, incident or remedy effect, and observation windows |
| Monitoring and agent | Actual alarm state/freshness and matching event/run/status/result; previous runs remain identifiable |
| Reset | Not in progress, incomplete with its last recorded step, or verified next baseline |

The local backend owns accepted work. Browser refresh or closure leaves finite accepted work running within its original bounds while the backend remains active. Tabs share that owner. Acquire a local process lock per target; two backend processes operating the same target are unsupported.

Serialize readiness, incident activation, targeted remediation, Recover, and Reset. Traffic may continue during activation or a targeted remedy, but fixes neither start nor stop producers and do not require active traffic. Recover and Reset stop producers before restoration and verification. Block new traffic during readiness, recovery/reset, incomplete reset, or unresolved startup/deployment reconciliation. While deployment owns the environment, reject controller mutations and new traffic; allow bounded reads only to settle already accepted work. After ownership returns, allow explicit generation-safe reconciliation/readiness work while ordinary presenter actions remain suspended. Observation reads remain independent. Reject conflicting commands without queuing a later side effect.

Stop remains available for active producers. It stops new submissions, not an accepted AWS change, action-owned probe, or submitted request. Each command has a browser-generated action ID: repeated same ID/input returns the recorded action; different input with that ID is rejected. Persist acceptance before acknowledgement and resolve lost responses by reading that action. This deduplicates controller commands; it does not guarantee exactly-once AWS effects.

## Action contracts

Every action exposes its real steps, elapsed time, and evidence. Use bounded reads and action deadlines, ending with incomplete/unknown when necessary. Do not invent percentages or hide pending propagation. A targeted fix ends with its configuration result: applied, no change, failed, or unknown. It submits no business probes and makes no resolution judgment. Request outcomes and any observed resolution belong to separate traffic/observation steps; polling remains independent.

### Check readiness

Require no competing action or active producer and presenter confirmation that unrelated browser checkouts are stopped. Inspect the selected account, region, resource identifiers, healthy aliases and their memory sizes, actual function caps, expected table policy, private setup record, and AWS permissions. Do not silently repair mismatches.

Verify an authenticated catalog read and a fresh quantity-one checkout, its saved receipt, and its stock decrement after outcomes settle. Retain that real order in the baseline and count its POST attempt. Capture sku/productVersion for later probes; the two incidents may prevent catalog refresh.

Report application readiness separately from fresh alarm-path readiness. A fresh alarm-driven demonstration requires the selected alarm observed OK with actions and integration configured. ALARM, INSUFFICIENT_DATA, missing configuration, unknown integration, and stale/unavailable reads are not ready. Readiness is not proof of event delivery; observe the actual run later.

### Traffic profiles and budgets

All traffic uses the normal protected API. Keep catalog load and checkout traffic separate in records and displays.

- Normal checkout traffic provisionally starts at one POST/second with at most two outstanding generator POSTs; these existing starting settings remain subject to rehearsal. Use quantity one and a fresh UUID/immutable payload per logical checkout.
- The overload profile adds paced GET /api/products traffic and sparse checkout probes. It declares a finite duration, maximum catalog attempts, maximum in-flight reads, timeouts, and the shared run's remaining catalog allowance before it starts. Exact settings remain unselected.
- Catalog reads use the uncached normal API path and must actually invoke inventory. Measure actual send/completion rates, in-flight counts, skips, and request outcomes. A pacing setting is not proof of delivered demand.
- A full concurrency slot skips that tick; do not accumulate a client queue, catch-up burst, or automatic extension. Explicit additional phases use the remaining run budget and retain their own observation windows.

Keep at most **60 checkout POST attempts per run**, including readiness, probes, retries, remedies, recovery, and reset verification where applicable. Initially reserve 10 for action/verification needs and permit at most 50 generator attempts; do not spend reserved capacity on catalog load or silently replenish POSTs. A post-reset verification belongs to the next run. Give catalog traffic its own finite aggregate allowance; incidental status/telemetry reads have separate finite bounds.

Capture checkout identity/input before sending. A timeout, lost response, or outcome-unknown response is unresolved, not proof of no order. Do not retry every failure. Reconcile with bounded status reads; a single 404 does not rule out a later commit. Any resubmission retains the same identity/input and consumes another POST attempt.

Stop disables both producers immediately, then shows draining until submitted work settles. Preserve unresolved identities and block destructive reset. It does not restore capacity/access or delete orders. Repeated Start/Activate commands cannot reset budgets or automatically renew an expired surge.

### Activate inventory capacity overload

Initially start from the verified healthy configuration and recorded ordinary-demand baseline. Only one incident is selected at a time; recover before switching incidents. Require an explicit bounded surge profile, adequate upstream/account capacity, remaining budgets, and a known positive inventory cap. After a targeted fix, the presenter may explicitly repeat this workload at the current cap without Recover or reapplying the baseline limit.

Record the actual current caps/aliases and start the selected catalog producer. Do not change code, restore or lower the inventory cap, set it to zero, add an artificial sleep, or silently change API/database limits. Existing sparse checkout traffic may continue within its bounds. Give each explicitly repeated workload phase its own evidence window; repeated command IDs still deduplicate. A repeat after the appropriate fix is expected to serve the workload without reproducing the failure.

Verify increased actual demand and inventory invocation rejections using checkout caller errors and inventory Throttles. Distinguish native concurrent-execution exhaustion from synchronous invocation-rate throttling using available error reasons; do not claim all execution slots were busy without evidence. Throttled invocations may have no child execution log and do not increment Invocations or Errors. Check for competing Gateway rejection, checkout throttling, client queueing, or database failures before attributing the incident.

The result may be “surge started; incident effect unverified.” An expired producer does not mean capacity is fixed. Its request evidence can still produce a later real alarm/run, but no traffic is extended to force delivery.

### Activate inventory access denied

Start with healthy versions, adequate capacity for the selected normal traffic, and the expected table policy. Keep the overload producer stopped. Record the prior policy and revision and apply only the prepared denial of the inventory role's required read operation on the selected Inventory table. Preserve the role's existing Allow and access for checkout/controller or other principals; no general IAM policy editor is exposed.

Use DynamoDB policy revision checks, including the no-policy condition when appropriate. Stop on unexpected policy drift instead of overwriting unrelated changes. Policy application and readback are eventually consistent, and subsequent updates are blocked for 15 seconds; use bounded observation and respect that interval. API acknowledgement is not activation proof. See [PutResourcePolicy](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_PutResourcePolicy.html) and [policy constraints](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/rbac-considerations.html).

Verify an actual denied inventory read, with its correlated error/operation and execution version, and a dependency-failure response through the normal API. Checkout returns 502 before its transaction for confirmed lookup failures. Separate overlapping successes or unrelated uncertain outcomes. Probe with bounded catalog reads before consuming a fresh checkout POST if needed.

Neither incident activation nor its probes invoke the agent. A repeated command ID does not create another action. An explicit new workload phase records its own observations without promising a new incident, alarm transition, or agent run.

### Increase function capacity

The presenter selects checkout or inventory and an explicit bounded target reserved-concurrency value. Read the selected current cap and verify target/account headroom. Require an existing positive cap and a strictly larger permitted target; setting a cap on an uncapped function is not presented as an increase. An already-active target is a no-change result, not an executed increase.

Record before/target values and apply only the selected function setting. Read it back and retain the acknowledgement and actual observation. The single local owner prevents competing controller actions, but the capacity API does not provide the alias/policy revision guard; unexpected changes or ambiguous results require reconciliation rather than an exactly-once claim.

Do not change another function, memory allocation, table policy, code, or traffic profile. Apply the operator's selected target without substituting another action.

End the action after the configuration result/readback. Do not submit probes, start/stop a producer, compare workload outcomes, or decide whether the incident persists. The presenter may separately repeat traffic and inspect its outcome.

### Increase function memory

The operator selects checkout or inventory and an explicit supported target memory size in MB. Resolve the selected live alias and read the memory size of the version it invokes. Require a target greater than the current allocation and within the supported operating range. An already-active target returns no change; an unsupported value is rejected before mutation.

Apply the requested memory increase to the selected function's invoked configuration while preserving its application artifact and all non-memory settings, including authentication, dependency targets, timeouts, concurrency, and access policies. Record the prior and resulting memory sizes, code identity, numeric version, and alias target/revision where applicable. Do not modify the other function.

Published Lambda versions have immutable memory settings. The action must activate a compatible version with the requested allocation through the selected live alias; updating only an uninvoked latest configuration does not complete the action. Read back that alias and the resolved version's memory size before reporting applied. Version preparation and activation mechanics remain an implementation detail; they do not authorize an application-code change. See [Lambda published versions](https://docs.aws.amazon.com/lambda/latest/dg/configuration-versions.html).

Use the existing action serialization, deduplication, conflict handling, and bounded configuration reads. Retain partial or unknown state for reconciliation if configuration/alias changes cannot be confirmed. The action ends at its configuration result and does not start or stop traffic, submit application probes, or evaluate application behavior.

### Restore inventory access

The presenter selects restoration of the expected Inventory table policy. Record current/expected state and use the applicable revision condition to restore the captured policy or its captured absence. Remove only the scenario's access change; unexpected external edits are conflicts requiring inspection. Do not add broad grants, change execution roles, move aliases, alter capacity, or silently stop traffic.

Respect policy update/propagation constraints and report the configuration result/readback. Policy readback can precede effective access restoration. Do not issue inventory reads or checkout probes as part of this action, and do not classify the incident as resolved or persistent. The presenter separately generates requests or runs readiness to observe the effect.

### Observe after a targeted remedy

This is a presenter workflow, not a verification step inside a fix action. A scoped remedy leaves unrelated settings and traffic unchanged. The presenter can stop the workload, apply the fix, and explicitly repeat the same profile at the current configuration. Starting the workload does not undo the fix. For overload, compare actual offered demand and outcomes across the recorded phases. For denied access, repeat ordinary requests without reapplying the Deny. Preserve policy/metric lag, partial evidence, and any period without traffic as separate observations.

A confirmed checkout receipt can be observed under catalog load. For precise order/stock verification, stop checkout producers and unrelated browser writes, settle submitted work, then compare the actual stock/order effects. Do not require a precise stock delta while other writers remain active. Distinguish pre-change/overlapping requests from fresh post-confirmation requests.

Observed improvement does not prove the agent's reasoning was sound; evaluation of the recommendation remains separate.

### Recover application

Stop catalog and checkout producers. Confirm the trusted deployment generation still matches the baseline, then restore/read back the original expected function caps, Inventory table policy, and baseline memory/version state through the healthy live aliases. Apply policy/alias revision guards where supported and inspect conflicting external changes. Restore the baseline, not whichever increased limit or memory allocation was most recently used. If deployment identity is newer or unknown, or a deployment is failed/partial, keep Recover blocked pending deployment reconciliation; never silently restore old aliases/settings over it. Reconcile the new generation against its trusted manifest explicitly before adopting a new baseline or resuming presenter actions.

Settle submitted work, including ambiguous checkout outcomes, then verify a fresh catalog read, quantity-one checkout, receipt, and stock decrement while other writers are stopped. Configuration restoration may complete while effect verification is incomplete. Exhausted POST budget permits configuration restoration but not an unsupported recovery-success claim.

Recover preserves orders, logs, incident/remedy records, alarm state, and previous agent results. Traffic stays stopped until explicitly restarted. Restoring the original small inventory cap verifies low-demand readiness; it does not demonstrate that peak demand is now served. Preserve the earlier comparable-load remedy result separately.

### Reset demo

Show inline confirmation naming the target and explaining order deletion, stock reseeding, stopped traffic, and clearing browser attempts. Perform generation-safe configuration reconciliation using the trusted expected settings for the current successful deployment, then settle and reconcile submitted work before destructive data changes. Do not require stale-baseline Recover first; a stale/unknown generation or failed/partial deployment blocks reset until reconciliation succeeds. If this reset is the chosen next-run boundary, its post-reset verification uses that next run's budget; the deployment and pre-reset reconciliation do not renew the current run's allowances.

Reset Orders/Inventory under a new productVersion, clear/refresh other-origin checkout-page attempts with presenter acknowledgement, and verify the next actual baseline. Record each step before mutation. The next baseline includes the verification order and stock decrement, not empty Orders or pristine seed stock. Preserve logs, alarm history, and earlier evidence.

An incomplete reset blocks ordinary traffic. After reconciliation, explicit continuation uses its recorded target productVersion and checkout identity; do not blindly increment the version, reseed after writes resume, or delete a verification order. Stop if the journal cannot establish a safe continuation.

## Observation contracts

Initially poll every five seconds without overlapping reads for a source. A timeout retains its last value/time plus an error. Mark a read stale after two intended poll intervals. Each observation identifies source, target, scope/window, read time, and source event/update time. Use monotonic time for request durations and UTC for correlation; avoid precise ordering claims across machines from tiny timestamp differences.

| Data | Source and meaning |
| --- | --- |
| Catalog load | Controller request records: configured pacing, actual attempts/completions/skips, in-flight counts, outcomes, and budget; never folded into checkout/order counts |
| Checkout outcomes | Controller POST records only, separating HTTP result from confirmed/unknown business outcome and labelling probes |
| Latency | Completed controller POSTs begun within a rolling 60-second window: median and sample count; client timeouts separate. Catalog latency and CloudWatch metrics are separate series |
| Orders/stock | Deduplicated confirmed receipts/status reads for known IDs and last authenticated stock/productVersion observation; no all-orders source implied |
| Function configuration/access | Selected current function caps, active-version memory sizes and alias targets, Inventory policy/revision, ordinary management history, actual caller error reasons, and native inventory Throttles with scope/freshness |
| Alarm | DescribeAlarms: actual stage 5xx alarm state, reason, transition/update/read times, and actions-enabled status. Missing/stale/failed is not OK; read time is freshness only |
| Agent | Selected alarm ARN plus normalized originating ALARM transition timestamp, matching durable run identity, status, start/end times, and result reference; unavailable and no observed run are distinct |
| Timeline | Recorded intent, traffic phases, confirmed settings, request effects, alarm transitions, agent events, and recovery/reset; no invented missed transitions |

The live alarm identity is the selected alarm ARN paired with the normalized originating ALARM state-transition timestamp from the actual adapter-delivered `alarmData.state.timestamp`. The [agent design](operations-agent.md) owns producing and persisting that identity. The local backend reads durable run records from the agent's separate DynamoDB run/report table using its AWS profile and matches them by alarm and originating transition. If observation polling missed the transition or the backend restarted, it must rediscover actual durable run records for the selected alarm and reconcile their originating transitions; a current alarm snapshot alone cannot reconstruct a missed event. Keep runs for distinct transitions separate, and retain the originating identity after DescribeAlarms reports OK.

DescribeAlarms `StateTransitionedTimestamp` may corroborate an identity only when it represents that same ALARM transition. `StateUpdatedTimestamp` and controller poll/read timestamps describe display state and freshness; they are never substitutes for the originating transition identity. Exact lookup schemas and indexes remain implementation details. Polling never invokes the agent or manufactures a missed event. An older result stays labelled as older when a newer transition has no matching run; absence of a discovered run is distinct from an unavailable read. For a fresh live cycle, observe the selected alarm OK before activating; persistent ALARM does not promise another invocation. Do not use SetAlarmState or a direct invocation as hidden proof. See [CloudWatch alarm behavior](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Alarms.html).

## Backend boundary and private records

Expose defined local commands and observation reads, not arbitrary AWS calls. The private local JSON Lines journal has one writer that durably records accepted action intent and immutable checkout input before external submission. A write failure stops new mutations/traffic. Detect partial trailing records rather than treating an unreadable journal as a clean run.

Record target/run/action identities, expected baseline including its deployment generation/artifact identity, current/target settings and revisions, traffic profiles/budgets and actual request records, command results, request/effect windows, alarm/event/run references, unresolved outcomes, and reset progress. Memory actions retain before/after allocation and active-version/code/alias identity. Retain original expected policy/absence separately from the temporary denial and later restoration. Scope permissions to the named functions' concurrency and memory/version operations, Inventory table policy, selected aliases, and existing data-reset operations; no general code/configuration editor is exposed.

Private intended causes, scenario IDs, prepared baseline mappings, and expected answers are scorer context. Ordinary current settings and management history may be agent evidence. Never store credentials, authentication configuration, or raw SDK dumps. Do not require an agent recommendation/run ID to operate a shortcut; an optional reference merely records what the presenter was reviewing.

On backend restart, reload the journal, mark unfinished work interrupted/uncertain, reacquire the application credential, and inspect actual deployment generation/artifact identity, caps, policy, aliases, active-version memory sizes, and known checkout outcomes. Also rediscover durable agent run records for the selected alarm and their originating transitions, including transitions missed by the prior poller. New local traffic has stopped, but submitted AWS work and access changes remain possible; a stopped surge does not certify recovery. Never automatically replay mutations, traffic, or reset. The presenter explicitly selects continuation or recovery after reconciliation. Local storage is not a disk-loss guarantee.

## Implementation verification

Implementation must exercise each selected incident, each supported configuration action, recovery, and reset. Verify that a memory increase changes the allocation used by the live alias while preserving the application artifact and other settings, and that Recover/Reset restore its baseline. Configuration actions finish without generating traffic or judging incident resolution. For overload, prove comparable actual demand and correct bottleneck attribution; for denied access, prove failed and restored reads after propagation. Observe real alarm delivery/run identity independently. No exact cap, load rate, memory target, or propagation duration is yet a verified setting.

Retain duplicate/lost command responses, browser refresh, backend restart during a mutation, partial configuration restoration, ambiguous checkout outcomes, failed/stale reads, old alarms/results, exhausted POST/read budgets, and interrupted reset as existing behavior checks. Verify that private truth/credentials do not enter agent evidence. This documentation update does not implement or execute those checks.
