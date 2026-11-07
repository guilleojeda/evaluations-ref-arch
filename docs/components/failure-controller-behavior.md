# Failure controller specification

The deployed [controller](failure-controller.md) supports checkout readiness, normal traffic, Stop, and inspection or discard of interrupted work. This specification also describes the remaining incident and remedy contracts. It uses the [application API](application.md) and [scenario contracts](../demo-scenarios.md).

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
| Restore inventory access | Detach the named Inventory deny policy with ownership and version checks, then read back the attachment state |
| Recover application | Stop producers, restore expected caps/policy, baseline memory and alias versions, settle work, and verify fresh business behavior without deleting data |
| Reset demo | Perform recovery and the quiescent data reset, invalidating old productVersion payloads and recording the next verified baseline |
| Observe and inspect | Show action progress, separate catalog/checkout demand and outcomes, actual alarms, matching agent runs, and source-timestamped evidence |
| Reconnect and reconcile | Reattach after browser navigation; reconcile AWS state and pending work after backend restart before explicit continuation |

The presenter independently chooses each action and its parameters. The agent remains read-only and may suggest an available remedy, no remediation, or another response. No agent report is automatically executed, no agent credentials authorize a controller action, and no evaluation gate is introduced here. Do not add code publication, arbitrary AWS operations, automatic remediation, or manual live-agent invocation.

## Baseline and state ownership

Setup records the target account/region/resources, trusted successful deployment generation and artifact identity, healthy numeric live-alias versions and their memory sizes, normal traffic settings, positive inventory baseline cap, checkout capacity, the Inventory deny policy's expected detached state and default version, and the absence of an Inventory table resource policy. The inventory cap must serve normal demand; overload activation changes demand, not this cap. Checkout capacity must be adequate for the selected workload. Function-cap increases require a positive current cap. Values are selected and verified during implementation, not fixed by an illustrative rate/cap example.

Capture missing resource policies or concurrency settings explicitly. Absence is not a zero concurrency cap. Keep the original expected baseline distinct from current settings and the presenter's remediation targets; an increase during an incident does not overwrite the baseline used by Recover.

Bind the baseline to the deployment generation and artifact identity known to be successfully deployed when its expected settings and application checks were verified. Recover and any Reset step that restores baseline aliases/settings must confirm that this same generation is still selected. A later or unknown generation makes the old baseline stale; never restore it over that deployment. After a successful deployment, an explicit Reset may instead reconcile against the new generation's trusted expected settings; it does not require restoring a stale baseline first. A failed or partial deployment blocks mutations that could apply an old baseline until actual deployed state is reconciled. Reconciliation preserves business data, request budgets, unsettled outcomes, and private journal history; it does not bless active fault settings as a new baseline. Establish a new baseline only from known expected settings for a successfully deployed generation and after required actual checks pass, not by sampling current configuration blindly. Coordinate deployment changes with controller work. The exact generation protocol and durable representation remain open.

### Deployment and baseline adoption

Schedule independent releases outside demo operation. Stop traffic and let accepted requests settle before deployment. After an app update, check its successful source revision and expected settings through the app stack outputs. A stale, partial, or unknown deployment blocks new traffic. Preserve the run, business data, unresolved outcomes and remaining budgets through a release. The deployment workflow sends no business traffic.

Adopt a fresh baseline only after matching the trusted expected settings and verifying a new order and its stock decrement. If there is too little remaining verification allowance, show readiness as incomplete. Adoption leaves the current run allowance intact. [Release operation](../deployment.md#deployment-and-controller-baseline)

A run spans a recorded business/configuration baseline, traffic and incident/remedy windows, and the next destructive reset. Commands and phases retain their own action IDs and budgets; neither Stop, Recover, nor a new Start replenishes the run's request allowances.

| Fact | Values or meaning |
| --- | --- |
| Current action | Kind, immutable ID/input, steps, timestamps, and running/completed/failed/interrupted/outcome-unknown result |
| Traffic | Catalog and checkout producer states, pacing, submitted/completed/skipped counts, in-flight work, and remaining budgets |
| Configuration | Expected baseline plus last confirmed current alias targets, active-version memory sizes, function caps, and Inventory deny-policy attachment and default version; partial or unknown where necessary |
| Application | Actual request outcomes, unresolved checkouts, incident or remedy effect, and observation windows |
| Monitoring and agent | Actual alarm state/freshness and matching event/run/status/result; previous runs remain identifiable |
| Reset | Not in progress, incomplete with its last recorded step, or verified next baseline |

The background Lambda owns accepted actions. Browser closure leaves the worker running within its original bounds. Authenticated tabs share the durable run. The worker can claim only the current, unexpired action. A repeated or late invocation cannot restart it after a claim or discard.

Readiness and normal traffic are mutually exclusive. Reject a conflicting command without queuing a later side effect. In the incident flows, targeted remedies can operate alongside traffic, while Recover and Reset require stopped producers and settled work. Observation reads remain independent.

Stop remains available for active producers. It stops new submissions, not an accepted AWS change, action-owned probe, or submitted request. Each command has a browser-generated action ID: repeated same ID/input returns the recorded action; different input with that ID is rejected. Persist acceptance before acknowledgement and resolve lost responses by reading that action. This deduplicates controller commands; it does not guarantee exactly-once AWS effects.

## Action contracts

Every action exposes its real steps, elapsed time, and evidence. Use bounded reads and action deadlines, ending with incomplete/unknown when necessary. Do not invent percentages or hide pending propagation. A targeted fix ends with its configuration result: applied, no change, failed, or unknown. It submits no business probes and makes no resolution judgment. Request outcomes and any observed resolution belong to separate traffic/observation steps; polling remains independent.

### Check readiness

Require no competing action or active producer and presenter confirmation that unrelated browser checkouts are stopped. Inspect the selected account, region, resource identifiers, healthy aliases and their memory sizes, actual function caps, expected deny-policy attachment and table-policy absence, private setup record, and AWS permissions. Do not silently repair mismatches.

Verify an authenticated catalog read and a fresh quantity-one checkout, its saved receipt, and its stock decrement after outcomes settle. Retain that real order in the baseline and count its POST attempt. Capture sku/productVersion for later probes; the two incidents may prevent catalog refresh.

Report application readiness separately from fresh alarm-path readiness. A fresh alarm-driven demonstration requires the selected alarm observed OK with actions and integration configured. ALARM, INSUFFICIENT_DATA, missing configuration, unknown integration, and stale/unavailable reads are not ready. Readiness is not proof of event delivery; observe the actual run later.

### Traffic profiles and budgets

All traffic uses the normal protected API. Keep catalog load and checkout traffic separate in records and displays.

- The normal profile lasts 15 seconds and gives catalog reads and quantity-one checkouts separate one-second ticks. It allows one catalog request and two checkout requests in flight. Each logical checkout gets a fresh UUID and immutable input.
- The overload profile adds paced GET /api/products traffic and sparse checkout probes. It declares a finite duration, maximum catalog attempts, maximum in-flight reads, timeouts, and the shared run's remaining catalog allowance before it starts. Exact settings remain unselected.
- Catalog reads use the uncached normal API path and must actually invoke inventory. Measure actual send/completion rates, in-flight counts, skips, and request outcomes. A pacing setting is not proof of delivered demand.
- A full concurrency slot skips that tick; do not accumulate a client queue, catch-up burst, or automatic extension. Explicit additional phases use the remaining run budget and retain their own observation windows.

Keep at most **60 checkout POST attempts per run**, including readiness, probes, retries, remedies, recovery, and reset verification where applicable. The controller permits 50 generator attempts and 5 verification attempts. Track the 5 manual attempts in the presenter runbook. The controller separately bounds catalog attempts at 120 per run, including readiness, and order status reads at 60. A post-reset verification belongs to the next run. Give catalog traffic its own finite aggregate allowance; incidental status/telemetry reads have separate finite bounds.

Capture checkout identity/input before sending. A timeout, lost response, or outcome-unknown response is unresolved, not proof of no order. Do not retry every failure. Reconcile with bounded status reads; a single 404 does not rule out a later commit. Any resubmission retains the same identity/input and consumes another POST attempt.

Stop disables both producers immediately, then shows draining until submitted work settles. Preserve unresolved identities and block destructive reset. It does not restore capacity/access or delete orders. Repeated Start/Activate commands cannot reset budgets or automatically renew an expired surge.

### Activate inventory capacity overload

Initially start from the verified healthy configuration and recorded ordinary-demand baseline. Only one incident is selected at a time; recover before switching incidents. Require an explicit bounded surge profile, adequate upstream/account capacity, remaining budgets, and a known positive inventory cap. After a targeted fix, the presenter may explicitly repeat this workload at the current cap without Recover or reapplying the baseline limit.

Record the actual current caps/aliases and start the selected catalog producer. Do not change code, restore or lower the inventory cap, set it to zero, add an artificial sleep, or silently change API/database limits. Existing sparse checkout traffic may continue within its bounds. Give each explicitly repeated workload phase its own evidence window; repeated command IDs still deduplicate. A repeat after the appropriate fix is expected to serve the workload without reproducing the failure.

Verify increased actual demand and inventory invocation rejections using checkout caller errors and inventory Throttles. Distinguish native concurrent-execution exhaustion from synchronous invocation-rate throttling using available error reasons; do not claim all execution slots were busy without evidence. Throttled invocations may have no child execution log and do not increment Invocations or Errors. Check for competing Gateway rejection, checkout throttling, client queueing, or database failures before attributing the incident.

The result may be “surge started; incident effect unverified.” An expired producer does not mean capacity is fixed. Its request evidence can still produce a later real alarm/run, but no traffic is extended to force delivery.

### Activate inventory access denied

Start with healthy versions, adequate capacity, and the named deny policy detached. Keep the overload producer stopped. Verify the default document and attach the prepared policy that denies only `dynamodb:GetItem` on the Inventory table to the Inventory Lambda execution role. The role retains its existing Allow and the table resource policy stays absent.

The controller serializes its configuration actions and records intent before making one attachment change. It checks the observed attachment and default policy version and stops on unexpected drift. IAM changes are eventually consistent. An unresolved attachment with an absent readback stays unknown until reconciled. [IAM propagation](https://docs.aws.amazon.com/IAM/latest/UserGuide/troubleshoot.html#troubleshoot_general_eventual-consistency)

Activation requires a verified current release, settled controller traffic, and paused unrelated writers. The worker checks that the table resource policy is absent and captures the exact IAM policy and attachment before sending up to six paced catalog probes. A typed catalog denial permits one verification checkout. A specific denied-read response and a fresh checkout 502 establish the incident. Keep actual successes and unresolved checkout identities in the run if the request evidence differs.

Neither incident activation nor its probes invoke the agent. A repeated command ID does not create another action. An explicit new workload phase records its own observations without promising a new incident, alarm transition, or agent run.

### Increase function capacity

The presenter selects checkout or inventory and an explicit bounded target reserved-concurrency value. Read the selected current cap and verify target/account headroom. Require an existing positive cap and a strictly larger permitted target; setting a cap on an uncapped function is not presented as an increase. An already-active target is a no-change result, not an executed increase.

Record before/target values and apply only the selected function setting. Read it back and retain the acknowledgement and actual observation. Controller action serialization prevents competing controller changes. The capacity API lacks the alias revision guard, so unexpected changes or ambiguous results require reconciliation rather than an exactly-once claim.

Do not change another function, memory allocation, deny-policy attachment, code, or traffic profile. Apply the operator's selected target without substituting another action.

End the action after the configuration result/readback. Do not submit probes, start/stop a producer, compare workload outcomes, or decide whether the incident persists. The presenter may separately repeat traffic and inspect its outcome.

### Increase function memory

The operator selects checkout or inventory and an explicit supported target memory size in MB. Resolve the selected live alias and read the memory size of the version it invokes. Require a target greater than the current allocation and within the supported operating range. An already-active target returns no change; an unsupported value is rejected before mutation.

Apply the requested memory increase to the selected function's invoked configuration while preserving its application artifact and all non-memory settings, including authentication, dependency targets, timeouts, concurrency, and access policies. Record the prior and resulting memory sizes, code identity, numeric version, and alias target/revision where applicable. Do not modify the other function.

Published Lambda versions have immutable memory settings. The action must activate a compatible version with the requested allocation through the selected live alias; updating only an uninvoked latest configuration does not complete the action. Read back that alias and the resolved version's memory size before reporting applied. Version preparation and activation mechanics remain an implementation detail; they do not authorize an application-code change. See [Lambda published versions](https://docs.aws.amazon.com/lambda/latest/dg/configuration-versions.html).

Use the existing action serialization, deduplication, conflict handling, and bounded configuration reads. Retain partial or unknown state for reconciliation if configuration/alias changes cannot be confirmed. The action ends at its configuration result and does not start or stop traffic, submit application probes, or evaluate application behavior.

### Restore inventory access

The presenter chooses **Restore inventory access**. The worker checks the current app release and the attachment and default version recorded by activation. It detaches only that named policy from the named role and reads back the state. Unexpected changes require inspection.

Capture the live incident configuration in the private evidence bucket before removing the recorded denial. If required capture fails, the presenter can explicitly confirm restoration without evidence for the same owned policy. Record the evidence gap. Both paths use the current app release and exact IAM policy default version. Retain owned policy identity across interruption for reconciliation. Report policy readback independently of request health, then let the presenter run separate traffic or readiness to observe the effect.

### Observe after a targeted remedy

This is a presenter workflow, not a verification step inside a fix action. A scoped remedy leaves unrelated settings and traffic unchanged. The presenter can stop the workload, apply the fix, and explicitly repeat the same profile at the current configuration. Starting the workload does not undo the fix. For overload, compare actual offered demand and outcomes across the recorded phases. For denied access, repeat ordinary requests without reapplying the Deny. Preserve policy/metric lag, partial evidence, and any period without traffic as separate observations.

A confirmed checkout receipt can be observed under catalog load. For precise order/stock verification, stop checkout producers and unrelated browser writes, settle submitted work, then compare the actual stock/order effects. Do not require a precise stock delta while other writers remain active. Distinguish pre-change/overlapping requests from fresh post-confirmation requests.

Observed improvement does not prove the agent's reasoning was sound; evaluation of the recommendation remains separate.

### Recover application

Stop catalog and checkout producers. Confirm the trusted deployment generation still matches the baseline, then restore/read back the original expected function caps, Inventory deny-policy attachment, and baseline memory/version state through the healthy live aliases. Apply alias revision guards where supported and inspect conflicting external changes. Restore the baseline, not whichever increased limit or memory allocation was most recently used. If deployment identity is newer or unknown, or a deployment is failed/partial, keep Recover blocked pending deployment reconciliation; never silently restore old aliases/settings over it. Reconcile the new generation against its trusted manifest explicitly before adopting a new baseline or resuming presenter actions.

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
| Function configuration/access | Selected current function caps, active-version memory sizes and alias targets, Inventory deny-policy attachment and default version, ordinary management history, actual caller error reasons, and native inventory Throttles with scope/freshness |
| Alarm | DescribeAlarms: actual stage 5xx alarm state, reason, transition/update/read times, and actions-enabled status. Missing/stale/failed is not OK; read time is freshness only |
| Agent | Selected alarm ARN plus normalized originating ALARM transition timestamp, matching durable run identity, status, start/end times, and result reference; unavailable and no observed run are distinct |
| Timeline | Recorded intent, traffic phases, confirmed settings, request effects, alarm transitions, agent events, and recovery/reset; no invented missed transitions |

The live alarm identity is the selected alarm ARN paired with the normalized originating ALARM state-transition timestamp from the actual adapter-delivered `alarmData.state.timestamp`. The [agent design](operations-agent.md) owns producing and persisting that identity. The controller reads durable run records from the agent's separate DynamoDB run/report table using scoped AWS permissions and matches them by alarm and originating transition. If observation polling missed the transition or the backend restarted, it must rediscover actual durable run records for the selected alarm and reconcile their originating transitions; a current alarm snapshot alone cannot reconstruct a missed event. Keep runs for distinct transitions separate, and retain the originating identity after DescribeAlarms reports OK.

DescribeAlarms `StateTransitionedTimestamp` may corroborate an identity only when it represents that same ALARM transition. `StateUpdatedTimestamp` and controller poll/read timestamps describe display state and freshness; they are never substitutes for the originating transition identity. Exact lookup schemas and indexes remain implementation details. Polling never invokes the agent or manufactures a missed event. An older result stays labelled as older when a newer transition has no matching run; absence of a discovered run is distinct from an unavailable read. For a fresh live cycle, observe the selected alarm OK before activating; persistent ALARM does not promise another invocation. Do not use SetAlarmState or a direct invocation as hidden proof. See [CloudWatch alarm behavior](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Alarms.html).

## Backend boundary and private records

Expose defined authenticated commands and observation reads. The controller table records accepted actions and immutable checkout inputs before external submission. The worker charges a request against its allowance before sending it. A failed durable write blocks the send.

Record target/run/action identities, expected baseline including its deployment generation/artifact identity, current/target settings and revisions, traffic profiles/budgets and actual request records, command results, request/effect windows, alarm/event/run references, unresolved outcomes, and reset progress. Memory actions retain before/after allocation and active-version/code/alias identity. Keep the expected detached state, the observed attachment, and the later restoration as separate records. Scope permissions to the named functions' concurrency and memory/version operations, the named Inventory role and deny-policy ARN, selected aliases, and existing data-reset operations; no general code/configuration editor is exposed.

Private intended causes, scenario IDs, prepared baseline mappings, and expected answers are scorer context. Ordinary current settings and management history may be agent evidence. Never store credentials, authentication configuration, or raw SDK dumps. Do not require an agent recommendation/run ID to operate a shortcut; an optional reference merely records what the presenter was reviewing.

An expired action appears incomplete. Discard it only after its execution and drain window has elapsed. Keep any charged attempts and unresolved checkout identities. A single missing order response leaves that checkout unresolved. The worker never automatically replays expired or previously claimed actions.

## Implementation verification

Implementation must exercise each selected incident, each supported configuration action, recovery, and reset. Verify that a memory increase changes the allocation used by the live alias while preserving the application artifact and other settings, and that Recover/Reset restore its baseline. Configuration actions finish without generating traffic or judging incident resolution. For overload, prove comparable actual demand and correct bottleneck attribution; for denied access, prove failed and restored reads after propagation. Observe real alarm delivery/run identity independently. No exact cap, load rate, memory target, or propagation duration is yet a verified setting.

Retain duplicate/lost command responses, browser refresh, backend restart during a mutation, partial configuration restoration, ambiguous checkout outcomes, failed/stale reads, old alarms/results, exhausted POST/read budgets, and interrupted reset as existing behavior checks. Verify that private truth/credentials do not enter agent evidence. This documentation update does not implement or execute those checks.
