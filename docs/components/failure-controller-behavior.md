# Failure controller specification

The deployed [controller](failure-controller.md) supports checkout readiness, normal traffic, Stop, inspection or discard of interrupted work, and read-only discovery of durable agent runs. This specification also describes the remaining incident and remedy contracts. It uses the [application API](application.md), [agent contract](operations-agent.md), and [scenario contracts](../demo-scenarios.md).

## Supported capabilities

| Control or view | Required behavior |
| --- | --- |
| Check readiness | Verify target, credentials, expected qualified versions/memory/caps/access state, normal requests, and separate alarm/agent-path readiness |
| Start or repeat traffic | Explicitly run normal checkout traffic or the prepared catalog surge at current settings, within remaining budgets |
| Activate inventory capacity overload | Start the explicitly selected finite catalog surge against the unchanged positive inventory cap, with sparse checkout probes |
| Activate inventory access denied | Select the prepared denied Inventory version through the single-target `live` alias and verify actual dependency failures |
| Stop traffic | Stop new catalog and checkout submissions, retaining already submitted and unresolved work |
| Increase function capacity | Increase the selected checkout or inventory reserved-concurrency cap to an explicit permitted value, without changing another component |
| Increase function memory | Show only memory variants prepared for the current app release; the demo provides baseline and higher Inventory sizes, preserving code and other settings |
| Restore inventory access | Select the healthy Inventory version at the current memory with release/role/policy and alias revision checks, then read back the alias and qualified configuration |
| Recover application | Stop producers, restore expected caps and healthy role-backed alias versions at baseline memory, settle work, and verify fresh business behavior without deleting data |
| Reset demo | Perform recovery and the quiescent data reset, invalidating old productVersion payloads and recording the next verified baseline |
| Observe and inspect | Show action progress, separate catalog/checkout demand and outcomes, actual alarms, matching agent runs, and source-timestamped evidence |
| Reconnect and reconcile | Reattach after browser navigation; reconcile AWS state and pending work after backend restart before explicit continuation |

The presenter independently chooses each action and its parameters. The agent remains read-only and may suggest an available remedy, no remediation, or another response. No agent report is automatically executed, no agent credentials authorize a controller action, and no evaluation gate is introduced here. Do not add code publication, arbitrary AWS operations, automatic remediation, or manual live-agent invocation.

## Baseline and state ownership

Setup records the target account/region/resources, trusted successful deployment generation and artifact identity, the allowlisted healthy and denied numeric Inventory versions and their memory sizes, their static execution roles and exact policy/default-document state, the healthy baseline alias target, normal traffic settings, positive inventory baseline cap, checkout capacity, and the absence of an Inventory table resource policy. The baseline pair has identical checked code, memory and non-role settings; only the execution role differs. The denied role retains logging/read access and carries the permanent exact-table `dynamodb:GetItem` Deny. The inventory cap must serve normal demand; overload activation changes demand, not this cap. Checkout capacity must be adequate for the selected workload. Function-cap increases require a positive current cap. Values are selected and verified during implementation, not fixed by an illustrative rate/cap example.

Capture missing resource policies or concurrency settings explicitly. Absence is not a zero concurrency cap. Keep the original expected baseline distinct from current settings and the presenter's remediation targets; an increase during an incident does not overwrite the baseline used by Recover.

Bind the baseline to the deployment generation and artifact identity known to be successfully deployed when its expected settings and application checks were verified. Recover and any Reset step that restores baseline aliases/settings must confirm that this same generation is still selected. A later or unknown generation makes the old baseline stale; never restore it over that deployment. After a successful deployment, an explicit Reset may instead reconcile against the new generation's trusted expected settings; it does not require restoring a stale baseline first. A failed or partial deployment blocks mutations that could apply an old baseline until actual deployed state is reconciled. Reconciliation preserves business data, request budgets, unsettled outcomes, and private journal history; it does not bless active fault settings as a new baseline. Establish a new baseline only from known expected settings for a successfully deployed generation and after required actual checks pass, not by sampling current configuration blindly. The app, agent, and controller are independent cloud stacks; the presenter sequences dependent releases outside a live run. Follow the [release procedure](../deployment.md#deployment-and-controller-baseline) and reconcile affected baselines and endpoints after each release.

### Deployment and baseline adoption

Schedule independent app, agent, and controller stack releases outside demo operation. Stop traffic and let accepted requests settle before deployment. For the initial alarm path, deploy and finalize the checked agent stack against current app outputs, bind the app alarm to the adapter only after final endpoint readback, then deploy the controller with the agent table and endpoint identifiers. After each update, check its successful source revision and expected settings through stack outputs. A stale, partial, or unknown release blocks new traffic or a readiness claim that depends on it. Preserve the run, business data, unresolved outcomes and remaining budgets through a release. The deployment workflow sends no business traffic or test alarm.

Adopt a fresh baseline only after matching the trusted expected settings and verifying a new order and its stock decrement. If there is too little remaining verification allowance, show readiness as incomplete. Adoption leaves the current run allowance intact. [Release operation](../deployment.md#deployment-and-controller-baseline)

A run spans a recorded business/configuration baseline, traffic and incident/remedy windows, and the next destructive reset. Commands and phases retain their own action IDs and budgets; neither Stop, Recover, nor a new Start replenishes the run's request allowances.

| Fact | Values or meaning |
| --- | --- |
| Current action | Kind, immutable ID/input, steps, timestamps, and running/completed/failed/interrupted/outcome-unknown result |
| Traffic | Catalog and checkout producer states, pacing, submitted/completed/skipped counts, in-flight work, and remaining budgets |
| Configuration | Expected baseline plus last confirmed current alias targets/revisions, qualified version and role/policy identities, active-version memory sizes, and function caps; partial or unknown where necessary |
| Application | Actual request outcomes, unresolved checkouts, incident or remedy effect, and observation windows |
| Monitoring and agent | Actual alarm state/freshness and matching event/run/status/result; previous runs remain identifiable |
| Reset | Not in progress, incomplete with its last recorded step, or verified next baseline |

The background Lambda owns accepted actions. Browser closure leaves the worker running within its original bounds. Authenticated tabs share the durable run. The worker can claim only the current, unexpired action. A repeated or late invocation cannot restart it after a claim or discard.

Readiness and normal traffic are mutually exclusive. Reject a conflicting command without queuing a later side effect. In the incident flows, targeted remedies can operate alongside traffic, while Recover and Reset require stopped producers and settled work. Observation reads remain independent.

Stop remains available for active producers. It stops new submissions, not an accepted AWS change, action-owned probe, or submitted request. Each command has a browser-generated action ID: repeated same ID/input returns the recorded action; different input with that ID is rejected. Persist acceptance before acknowledgement and resolve lost responses by reading that action. This deduplicates controller commands; it does not guarantee exactly-once AWS effects.

## Action contracts

Every action exposes its real steps, elapsed time, and evidence. Use bounded reads and action deadlines, ending with incomplete/unknown when necessary. Do not invent percentages or hide pending propagation. A scoped remediation shortcut—capacity, memory, or Restore inventory access—ends with its configuration result: applied, no change, failed, or unknown. It sends no business probes and makes no resolution judgment. Incident activation is separate: it retains its bounded catalog probes and, for access denial, one fresh verification checkout after a typed denied read. Record those request outcomes separately from the activation's configuration/readback result; polling remains independent.

### Check readiness

Require no competing action or active producer and presenter confirmation that unrelated browser checkouts are stopped. Inspect the selected account, Region, resource identifiers, the current `live` alias and revision, allowlisted healthy/denied versions and their memory sizes, actual function caps, expected role/policy state and absence of an Inventory table resource policy, private setup record, and AWS permissions. For Phase 4, separately read back the configured AgentCore endpoint and verify the actual alarm binding; neither readiness observation invokes the agent or establishes that inference occurred. Do not silently repair mismatches.

Verify an authenticated catalog read and a fresh quantity-one checkout, its saved receipt, and its stock decrement after outcomes settle. Retain that real order in the baseline and count its POST attempt. Capture sku/productVersion for later probes; the two incidents may prevent catalog refresh.

Report application readiness separately from fresh alarm-path readiness. A fresh alarm-driven demonstration requires the selected alarm observed OK, `ActionsEnabled`, the exact expected adapter binding, and a ready pinned AgentCore endpoint. ALARM, INSUFFICIENT_DATA, disabled actions, missing or unexpected configuration, endpoint mismatch/unavailability, and stale reads are not ready. Readiness is not proof of event delivery; observe the actual run later.

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

Start with the healthy version at the approved baseline memory, adequate capacity, and the overload producer stopped. Verify the current `live` alias is unweighted and points to the healthy qualified version. Verify the denied version's static execution role, its logging/read Allow and permanent policy that denies only `dynamodb:GetItem` on the exact Inventory table, and the absence of a table resource policy.

The controller serializes its configuration actions and records intent before making one compare-and-swap alias update. It checks the observed alias revision, requested release/version, qualified configuration, role and policy state, and stops on unexpected drift. An uncertain alias response stays unknown until reconciled through alias readback; existing invocations may overlap the switch.

Activation requires a verified current release, settled controller traffic, and paused unrelated writers. The worker captures the active alias/version/role/policy configuration before the switch, then sends up to six paced catalog probes through the denied version. A typed catalog denial permits one verification checkout. A specific denied-read response and a fresh checkout 502 establish the incident. Keep actual successes and unresolved checkout identities in the run if the request evidence differs.

Neither incident activation nor its probes invoke the agent. A repeated command ID does not create another action. An explicit new workload phase records its own observations without promising a new incident, alarm transition, or agent run.

### Increase function capacity

The presenter selects checkout or inventory and an explicit bounded target reserved-concurrency value. Read the selected current cap and verify target/account headroom. Require an existing positive cap and a strictly larger permitted target; setting a cap on an uncapped function is not presented as an increase. An already-active target is a no-change result, not an executed increase.

Record before/target values and apply only the selected function setting. Read it back and retain the acknowledgement and actual observation. Controller action serialization prevents competing controller changes. The capacity API lacks the alias revision guard, so unexpected changes or ambiguous results require reconciliation rather than an exactly-once claim.

Do not change another function, memory allocation, Inventory access state, code, alias target, or traffic profile. Apply the operator's selected target without substituting another action.

End the action after the configuration result/readback. Do not submit probes, start/stop a producer, compare workload outcomes, or decide whether the incident persists. The presenter may separately repeat traffic and inspect its outcome.

### Increase function memory

Show a memory dropdown only for variants prepared for the current app release. The demo needs two Inventory sizes, baseline and higher. Resolve the selected live alias and the memory size of its active version. Require a prepared target greater than the current allocation. An already-active target returns no change; a stale release or unlisted value is rejected before mutation.

Apply the requested memory increase by selecting the prepared qualified version through the selected function's `live` alias while preserving its application artifact and all non-memory settings, including authentication, dependency targets, timeouts, concurrency, and access state. For Inventory, preserve whether the current variant is healthy or denied. Record the prior and resulting memory sizes, code identity, numeric version, role, and alias target/revision. Do not modify the other function.

Published Lambda versions have immutable memory settings. Deployment publishes the allowlisted qualified variants and verifies the original unpublished `$LATEST` configuration is restored. The demo's Inventory release matrix contains healthy and denied variants at each supported memory size. The action must activate a compatible allowlisted release/version through the selected `live` alias; updating `$LATEST` or publishing from the controller does not complete the action. Read back that alias, revision, qualified configuration, and resolved version's memory before reporting applied. The controller has no role-passing, `$LATEST` staging, version-publication, or other version-preparation authority. See [Lambda published versions](https://docs.aws.amazon.com/lambda/latest/dg/configuration-versions.html).

Use the existing action serialization, deduplication, conflict handling, and bounded configuration reads. Retain partial or unknown state for reconciliation if configuration/alias changes cannot be confirmed. The action ends at its configuration result and does not start or stop traffic, submit application probes, or evaluate application behavior.

### Restore inventory access

The presenter chooses **Restore inventory access**. The worker checks the current app source revision and the active alias/version/role/policy recorded by activation. It captures that configuration before the change, then selects only the allowlisted healthy version at the current memory with a compare-and-swap alias update and reads back the alias, revision, qualified configuration, role and policy state. Unexpected changes require inspection.

Capture the live incident configuration in the private evidence bucket before switching away from the denied version. If required capture fails, the presenter can explicitly confirm restoration without the configuration checkpoint. Record the evidence gap. Both paths use the current app source revision and exact qualified manifest entries. Retain alias/version/role/policy identity across interruption for reconciliation. Report configuration readback independently of request health, then let the presenter run separate traffic or readiness to observe the effect.

### Observe after a targeted remedy

This is a presenter workflow, not a verification step inside a fix action. A scoped remedy leaves unrelated settings and traffic unchanged. The presenter can stop the workload, apply the fix, and explicitly repeat the same profile at the current configuration. Starting the workload does not undo the fix. For overload, compare actual offered demand and outcomes across the recorded phases. For denied access, repeat ordinary requests through the healthy version without selecting the denied version again. Preserve alias-readback, metric lag, partial evidence, and any period without traffic as separate observations.

A confirmed checkout receipt can be observed under catalog load. For precise order/stock verification, stop checkout producers and unrelated browser writes, settle submitted work, then compare the actual stock/order effects. Do not require a precise stock delta while other writers remain active. Distinguish pre-change/overlapping requests from fresh post-confirmation requests.

Observed improvement does not prove the agent's reasoning was sound; evaluation of the recommendation remains separate.

### Recover application

Stop catalog and checkout producers. Confirm the trusted deployment generation and app source revision still match the baseline, then restore/read back the original expected function caps and healthy role-backed Inventory version at baseline memory through the healthy `live` alias. Apply the alias compare-and-swap guard and inspect conflicting external changes. Restore the baseline, not whichever increased limit or memory allocation was most recently used. If deployment identity is newer or unknown, or a deployment is failed/partial, keep Recover blocked pending deployment reconciliation; never silently restore old aliases/settings over it. Reconcile the new generation against its trusted manifest explicitly before adopting a new baseline or resuming presenter actions.

Settle submitted work, including ambiguous checkout outcomes, then verify a fresh catalog read, quantity-one checkout, receipt, and stock decrement while other writers are stopped. Configuration restoration may complete while effect verification is incomplete. Exhausted POST budget permits configuration restoration but not an unsupported recovery-success claim.

Recover preserves orders, logs, incident/remedy records, alarm state, and previous agent results. Traffic stays stopped until explicitly restarted. Restoring the original small inventory cap verifies low-demand readiness; it does not demonstrate that peak demand is now served. Preserve the earlier comparable-load remedy result separately.

### Reset demo

Show inline confirmation naming the target and explaining order deletion, stock reseeding, stopped traffic, and clearing browser attempts. Perform generation-safe configuration reconciliation using the trusted expected settings for the current successful deployment, then settle and reconcile submitted work before destructive data changes. Do not require stale-baseline Recover first; a stale/unknown generation or failed/partial deployment blocks reset until reconciliation succeeds. If this reset is the chosen next-run boundary, its post-reset verification uses that next run's budget; the deployment and pre-reset reconciliation do not renew the current run's allowances.

Reset Orders/Inventory under a new productVersion, clear/refresh other-origin checkout-page attempts with presenter acknowledgement, and verify the next actual baseline. Record each step before mutation. The next baseline includes the verification order and stock decrement, not empty Orders or pristine seed stock. Preserve logs, alarm history, and earlier evidence.

An incomplete reset blocks ordinary traffic. After reconciliation, explicit continuation uses its recorded target productVersion and checkout identity; do not blindly increment the version, reseed after writes resume, or delete a verification order. Stop if the journal cannot establish a safe continuation.

## Observation contracts

Poll alarm and investigation observations independently every five seconds without overlapping reads for the same source. On a read failure, retain the last good value and its observation time; mark investigation data stale after two intervals. Each observation identifies source, target, scope/window, read time, and source event/update time. Use monotonic time for request durations and UTC for correlation; avoid precise ordering claims across machines from tiny timestamp differences.

| Data | Source and meaning |
| --- | --- |
| Catalog load | Controller request records: configured pacing, actual attempts/completions/skips, in-flight counts, outcomes, and budget; never folded into checkout/order counts |
| Checkout outcomes | Controller POST records only, separating HTTP result from confirmed/unknown business outcome and labelling probes |
| Latency | Completed controller POSTs begun within a rolling 60-second window: median and sample count; client timeouts separate. Catalog latency and CloudWatch metrics are separate series |
| Orders/stock | Deduplicated confirmed receipts/status reads for known IDs and last authenticated stock/productVersion observation; no all-orders source implied |
| Function configuration/access | Selected current function caps, active-version memory sizes and alias targets/revisions, Inventory version/role/policy state and ordinary management history, actual caller error reasons, and native inventory Throttles with scope/freshness |
| Alarm | DescribeAlarms: actual stage 5xx state, reason, transition/update/read times, and enabled action state; separately report whether the exact configured adapter is bound. Missing, disabled, unexpected, stale, or failed is not ready; read time is freshness only |
| Agent | Selected alarm ARN plus normalized originating ALARM transition, matching durable run/session/candidate identity, Runtime version and release provenance, status/deadline, report citations and uncertainty, trace and source-capture references; unavailable and no matching run are distinct |
| Timeline | Recorded intent, traffic phases, confirmed settings, request effects, alarm transitions, agent events, and recovery/reset; no invented missed transitions |

The live alarm identity is the selected alarm ARN paired with the UTC-normalized originating ALARM state-transition timestamp from the actual adapter-delivered `alarmData.state.timestamp`. The [agent design](operations-agent.md) owns producing and persisting that identity. The authenticated `/api/investigations` route reads durable run records from the agent's separate DynamoDB table using scoped strong base-table reads; an optional `alarmArn` must be allowlisted, and an exact `transitionAt` query returns only that event's row or no row. Without an exact transition it returns up to 20 recent records for the selected alarm. If observation polling missed the transition or the backend restarted, the controller rediscovers actual records rather than reconstructing an event from alarm state. Keep runs for distinct transitions separate, and retain the originating identity after `DescribeAlarms` reports OK.

`DescribeAlarms.StateTransitionedTimestamp` may corroborate an identity only when it represents that same ALARM transition. `StateUpdatedTimestamp` and controller poll/read timestamps describe display state and freshness; they are never substitutes for the originating transition identity. Polling never invokes the agent or manufactures a missed event. `/api/investigations` polls independently of `/api/alarm`, retains the last good value on error, and marks the result stale after two five-second intervals. The alarm read separately reports whether the configured endpoint is ready and the adapter is bound to the selected alarm; these are control-plane observations, not inference evidence. An older result stays labelled as history when a newer transition has no matching run; absence of a discovered run is distinct from an unavailable read. For a fresh live cycle, observe the selected alarm OK before activating; persistent ALARM does not promise another invocation. Do not use `SetAlarmState` or a direct invocation as hidden proof. See [CloudWatch alarm behavior](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Alarms.html).

## Backend boundary and private records

Expose defined authenticated commands and observation reads. The controller table records accepted actions and immutable checkout inputs before external submission. The worker charges a request against its allowance before sending it. A failed durable write blocks the send.

Record target/run/action identities, expected baseline including its deployment generation/artifact identity, current/target settings and revisions, traffic profiles/budgets and actual request records, command results, request/effect windows, alarm/event/run references, unresolved outcomes, and reset progress. Memory and access actions retain before/after allocation, version/code/alias identity, role and policy state. Capture the active alias/version/role/policy before recovery. Scope permissions to the named functions' approved capacity APIs and allowlisted alias/version operations, selected aliases, manifest reads, and existing data-reset operations; no IAM attach/detach, role-passing, `$LATEST` staging, version-publication, or general code/configuration editor is exposed.

Private intended causes, scenario IDs, prepared baseline mappings, and expected answers are scorer context. Ordinary current settings and management history may be agent evidence. Never store credentials, authentication configuration, or raw SDK dumps. Do not require an agent recommendation/run ID to operate a shortcut; an optional reference merely records what the presenter was reviewing.

An expired action appears incomplete. Discard it only after its execution and drain window has elapsed. Keep any charged attempts and unresolved checkout identities. A single missing order response leaves that checkout unresolved. The worker never automatically replays expired or previously claimed actions.

## Implementation verification

Implementation must exercise each selected incident, each supported configuration action, recovery, and reset. Verify that a memory increase changes the allocation used by the live alias while preserving the application artifact and other settings, and that an Inventory memory switch preserves the current healthy/denied access state. Verify that access restoration switches from the denied version to the healthy version at the same memory and that Recover/Reset restore their baseline. Scoped remediation shortcuts finish without generating traffic or judging incident resolution; incident activation retains its bounded catalog probes and fresh denied verification checkout, with configuration/readback and request outcomes kept separate. For overload, prove comparable actual demand and correct bottleneck attribution; for denied access, prove failed and restored reads after alias readback. Observe real alarm delivery/run identity independently. No exact cap, load rate, or memory target is yet a verified setting.

Retain duplicate/lost command responses, browser refresh, backend restart during a mutation, partial configuration restoration, ambiguous checkout outcomes, failed/stale reads, old alarms/results, exhausted POST/read budgets, and interrupted reset as existing behavior checks. Verify that private truth and credentials do not enter agent evidence. For the genuine alarm path, verify duplicate delivery creates no second investigation, an interrupted post-claim run remains incomplete, and the report and trace stay discoverable after OK or browser reconnect.
