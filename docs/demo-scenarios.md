# Demonstration scenario contracts

**Status:** Phase 9 provides the Inventory-only capacity shortcut and its baseline/readiness/recovery behavior. The calibrated capacity surge and matched before/after workload demonstration remain Phase 10 work. Do not treat a cap change or readback as evidence that a surge was served. The selected incidents are **inventory-capacity-overload** and **inventory-access-denied**; both use unchanged healthy application code. The application-regression and fixed-delay fixtures are no longer selected controller incidents. **recovered-stale-alarm** remains an observation condition reached through recovery, not another fault.

The [application](components/application.md) owns API/business semantics; the [controller specification](components/failure-controller-behavior.md) owns actions, traffic, and records. The [operations agent](components/operations-agent.md) investigates and recommends; [evaluations](evaluations.md) assess its behavior.

## Common contract

Setup records the trusted deployment generation and artifact identities, healthy numeric checkout/inventory live-alias versions and memory allocations, the allowlisted denied Inventory version and its static execution role, Inventory's release-owned reserved-concurrency baseline of **16**, Checkout's unreserved setting, the exact Inventory Deny policy/default document and access state, plus the absence of an Inventory table resource policy, target resources, and the normal catalog/business baseline. The healthy and denied baseline-memory Inventory variants share checked code and non-role settings; only the execution role differs. A baseline belongs to that deployment generation; it cannot restore old settings over a later or uncertain deployment. The [deployment contract](deployment.md) and [controller specification](components/failure-controller-behavior.md) own reconciliation and safe baseline adoption. The capacity shortcut changes Inventory only; its initial target is 32 and it accepts integer values from 16 through 64. Checkout has no capacity shortcut and remains unreserved.

The presenter controls incident activation, targeted fixes, traffic, recovery, and reset separately. The agent recommends one of **Increase reserved concurrency**, **Increase memory**, **Restore inventory access**, or **Other**, with an explanation and the action's target/value where applicable. A report that proposes increasing Checkout concurrency is an incorrect candidate output; there is no Checkout capacity control for the presenter to execute. Other includes a justified no-change response or insufficient evidence. The agent does not call the controller or supply its authority. Shortcuts are usable independently of an agent report or evaluation result.

**Targeted fixes only change the selected configuration and report the action result.** They do not start/stop traffic, submit verification requests, or decide whether the incident is resolved. The presenter can apply a fix and then explicitly repeat the workload to show what happens. Ordinary independent dashboard observations remain available throughout.

Use normal authenticated catalog and checkout requests. The normal traffic action lasts 15 seconds, with separate 1 Hz catalog and quantity-one checkout ticks, at most one catalog request and two checkout requests in flight; skipped ticks do not queue or catch up. Each logical checkout uses a fresh UUID with immutable sku, quantity, and captured productVersion. A retry retains its identity/input and is recorded as another actual attempt. There are no cumulative controller-wide checkout, catalog, or status-read quotas or separate generator, verification, or manual pools. Each action instead has its own applicable duration, maximum attempts, pacing, in-flight limit, timeout, and deadline; repeated phases are separate bounded actions. Record actual counts, outcomes, receipts, stock effects, and unresolved identities.

Record actual submissions, completions, skipped pacing ticks, in-flight requests, and phase windows. A configured rate is not proof of delivered demand. Do not queue a backlog, send catch-up bursts, silently extend a finite batch, or count catalog responses as orders.

Stop prevents new submissions; it does not cancel accepted AWS changes or submitted requests. Settle and reconcile uncertain checkouts before destructive reset. A single missing-order read does not rule out a later commit. Browser closure leaves bounded accepted backend work running; backend restart requires reconciliation and explicit continuation.

Retain four evidence layers:

1. **Actions:** private intent and expected baseline, actual target/value or alias/version/role/policy state and default document, acknowledgements/readbacks, and traffic phase parameters.
2. **Effects:** measured demand, HTTP outcomes, correlated caller/child errors, actual execution versions where code executed, confirmed receipts, and settled stock/order changes.
3. **Monitoring:** actual alarm ARN, originating ALARM-transition timestamp, current state/reason, separate update/read times, and observation freshness. Retain the originating identity after OK and use actual durable run records to discover investigations missed by polling.
4. **Agent:** genuine alarm-event identity, matching run/trace/status, and result. An alarm or dashboard poll does not establish an invocation.

Both incidents use the selected native stage-level HTTP API **5xx** alarm: Sum >=1 over 60 seconds, 1-of-1, missing data notBreaching. It includes catalog failures and is not checkout/controller-only. The two causes produce dependency-failure 502 responses where the inventory lookup is confirmed to have failed before a transaction. Unrelated timeouts or ambiguous write acknowledgements retain their own API meanings.

Agent evidence may include ordinary current caps, alias/version metadata, the Inventory execution role and relevant IAM policy/default document, management change history, logs, and metrics. Private scenario labels, intended causes, controller baseline mappings, expected answers, credentials, and raw authentication configuration are not agent inputs. Do not infer a failed child's executed version from an alias when no child invocation occurred.

For repeatable local/CI regressions, retain versioned, queryable captures of those ordinary sources at an explicit investigation reference time. All four tools use the same captured view, including supported as-of configuration and bounded change history; no query falls back to the recovered live application. Candidates choose their own queries, with missing coverage visible. Each new regression execution has its own identity and retains the original event/case provenance. The [evaluation contract](evaluations.md) owns capture, time, and candidate-comparison semantics; recorded-trace judging remains distinct from executing a candidate.

## Agent candidates and scenario expectations

The [agent software stages](components/operations-agent.md#software-stages) define the initially defective and corrected candidates. The [demo progression](demo-progression.md) defines how they are presented.

| Condition supported by the evidence | Corrected candidate recommendation | Unacceptable response |
| --- | --- | --- |
| Inventory capacity is throttling the comparable workload | Increase reserved concurrency on Inventory to an explicit supported higher limit | Choose an unsupported target, change an unrelated setting, or assert that memory addresses the observed limit without supporting evidence |
| Inventory reads are blocked by the scoped IAM Deny on the denied version's role | Select the healthy role-backed Inventory version at the current memory | Increase memory or reserved concurrency while leaving the denied version active |
| Current requests support recovery within the investigated scope | Other, explaining that no configuration change is needed and the scope of that conclusion | Apply a remedy solely because the old alarm remains ALARM |
| The available evidence cannot establish a supported action | Other, explaining the uncertainty and useful next investigation | Invent a cause, target, or recovery claim |

The initial candidate's selected known defect is **Increase memory on inventory for inventory-access-denied**. S0 shows that behavior without an evaluation verdict; S1 reviews its expected alternative; S2–S3 expose the defect with evaluations; S4 explicitly repairs the agent. A code check can reject the wrong recommendation even if its prose diagnosis sounds correct. The corrected candidate must handle both incidents; the initial candidate need not recommend memory for both.

The memory action must select a prepared qualified version through inventory's live alias, preserving the code, non-memory settings, and current access state. When the denied variant is active, the permanent exact-table Deny remains active, so separate fresh requests still fail. This establishes an ineffective recommendation through an actual execution rather than a simulated action. Exact memory targets remain rehearsal settings. Increasing memory can affect performance in other workloads; the selected denial case makes this demonstration independent of that effect.

## inventory-capacity-overload

### Cause and baseline

The application works at ordinary demand. Inventory starts at its release-owned reserved-concurrency cap of **16**; Checkout is unreserved, and Gateway and database capacity are adequate for the selected workload. Healthy versions and access policy remain unchanged. Record successful baseline catalog and checkout behavior before the Phase 10 surge. A controller-confirmed higher current Inventory cap is distinct from the original release baseline and is not carried to a new deployment generation.

### Activation

Start the selected finite surge through authenticated GET /api/products, with sparse bounded checkout probes. These normal reads invoke inventory without creating orders or causing hot-stock write contention. Increase demand without changing the inventory cap, deploying code, introducing a sleep, or setting concurrency to zero.

Observe actual inventory invocation rejections, checkout caller error reasons, and native inventory Throttles in the traffic window. Both concurrent-execution exhaustion and the related synchronous request-rate quota are possible; identify the observed constraint or qualify the diagnosis as capacity throttling. Throttled requests do not execute inventory code and do not increment its Invocations or Errors. Missing child logs alone are not a diagnosis.

Check that Gateway throttling, checkout limits, client queueing, or other failures are not the actual bottleneck. Mark the incident unverified if its expected effect was not observed.

### Fixes and separate demonstration

**Appropriate recommendation:** Increase reserved concurrency on Inventory to a permitted higher limit. The controller input starts at **32** and accepts integer targets from **16–64**. Equality with the current cap is `no_change`; lower values are rejected. Fresh account settings determine available headroom, and the action preserves AWS's 100-unit unreserved floor. The worker uses `GetAccountSettings`; it does not call Service Quotas or wait on quota changes.

The capacity shortcut changes only Inventory's cap and reads back the result. It neither generates traffic nor checks application outcomes, and a readback makes no recovery claim. The calibrated workload and post-change comparison remain Phase 10 work; do not interpret this shortcut as that demonstration.

Once the Phase 10 surge is implemented, the presenter may stop it, apply the action, and then explicitly repeat the same workload profile at the current limits. Repetition does not restore the original Inventory cap, lower demand, or imply that a new fault or alarm must occur. A successful replay at the raised cap is the desired Phase 10 result.

Assess that separately observed result against actual offered rates, workload mix, request outcomes, and throttling windows. A quiet successful request or a batch ending cannot establish that peak demand is now served. Any further phase is a separate bounded action; label reduced-load stabilization separately from serving the original surge.

### Agent and operational close

The agent should identify the constrained component using ordinary evidence, separate request-rate from concurrency claims, and justify a remedy or uncertainty. Equivalent supported investigations are valid. It must not receive the controller's intended cause, invent a deployment regression, or claim to have changed capacity.

Observe the real alarm and matching agent run independently. If finite traffic ends without proving delivery, retain the application evidence and report live delivery incomplete rather than extending traffic or manually invoking the agent.

After the presenter has observed the Phase 10 remedy result, stop producers and settle work for exact order/stock verification. Full Recover returns Inventory to its release cap of **16**, restores Checkout's unreserved setting and healthy aliases, and verifies fresh baseline business behavior. Reset also restores Inventory to 16 and starts a fresh verified business run. Preserve the original and controller-confirmed current caps separately; Reset archives the prior settings rather than rewriting them.

## inventory-access-denied

### Cause and baseline

Normal traffic works with the healthy version at baseline memory, sufficient capacity, and the named denied variant not selected. Keep the overload producer stopped. The healthy Inventory execution role grants the required read; the separate denied role retains logging/read access plus the permanent exact-table Deny.

### Activation

Select the prepared denied baseline-memory Inventory version through the single-target `live` alias. Record the prior alias target/revision, selected version, execution role, policy ARN/default document and access state. Stop on unexpected alias, qualified configuration, role or policy drift.

Alias readback and qualified configuration are separate from request evidence. Record the alias revision and separately observe actual request failures through the denied version within the bounded probe window; existing invocations may overlap an alias switch.

Bounded catalog reads can establish a correlated denied DynamoDB operation in inventory logs. A fresh checkout lookup fails with 502 before its transaction; confirm no writes for those known pre-write failures after settling, while keeping overlapping successes and unrelated unknown outcomes separate.

### Fixes and separate demonstration

**Appropriate recommendation:** Restore inventory access by selecting the healthy role-backed Inventory version at the current memory. Ground the recommendation in the denied read and actual alias/version/role/policy evidence.

**Initial candidate's ineffective recommendation:** Increase memory on inventory. The presenter selects a supported larger size in MB. Confirm the live alias's effective memory/version change, then separately repeat ordinary requests while the denied access state remains active. Those requests should still show the denied read and 502 responses. The memory switch preserves the denied role/policy during the demonstration. A configuration failure or no-change result does not demonstrate a successfully executed ineffective remedy.

Increasing Inventory's reserved concurrency while its denied version remains active also leaves this denial in place; it is an incorrect recommendation for the reviewed case, not an additional required live demonstration.

The access shortcut captures the active alias/version/role/policy before recovery, then selects only the allowlisted healthy version at the current memory with a compare-and-swap alias update. It reads back the alias, qualified configuration, role and policy state after verifying the current app source revision. It does not broaden or mutate the execution role, stage `$LATEST`, publish versions, issue application probes, or decide whether reads work.

After the alias restoration, the presenter explicitly repeats ordinary catalog/checkout traffic and observes whether the previously denied operation succeeds through the healthy version. Do not select the denied version again to test the fix; that would cause another incident. Preserve alias-readback and request timestamps rather than equating action completion with immediate request success. A changed memory version may remain active during this observation; full Recover restores its captured baseline afterward.

### Agent and operational close

The corrected agent should use the denied operation/resource, current alias/version/role/policy or relevant history, and request correlation to support an access diagnosis and Restore inventory access, with the healthy role-backed version as the concrete target. It must not infer a capacity problem merely from a dependency error or recommend unnecessarily broad grants. Missing policy evidence may require a qualified diagnosis or Other. The initial memory recommendation is a known agent defect, not acceptable handling of this evidence.

Observe the genuine alarm/run separately. After request success is observed, stop other writers, settle outcomes, and verify fresh business effects. Recover restores Inventory's original cap of 16, Checkout's unreserved setting, and the healthy role-backed alias at baseline memory while preserving data and operational history.

## recovered-stale-alarm

This is a recovery/time interpretation condition, not a third injected fault. Use a genuine originating incident/event, retained historical evidence, and timestamped fresh healthy requests after policy/configuration recovery or a separately demonstrated fix.

An alarm may remain ALARM while requests succeed. For an overload incident, distinguish successful ordinary traffic from a demonstrated successful surge: the former alone cannot establish peak-load recovery. Keep incident, action, request, alarm, and investigation times distinct.

Do not fabricate an alert, manipulate alarm state, reapply a fault, or directly invoke the agent to make this condition appear live. Recovery does not promise another alarm transition or agent invocation. A qualifying actual investigation must have seen the relevant post-action evidence; an earlier report cannot be scored as if it knew the future.

If no qualifying live run exists, preserve a reviewed regression/replay case with its original event, evidence windows, and an explicit later investigation reference time supported by captured post-recovery evidence. Execute the candidate against that coherent captured view and label it as replay. Do not add future recovery evidence to the earlier ongoing-incident case or rejudge its earlier report as though it had seen recovery. The agent selects Other and explains that no remediation is needed when evidence at the case reference time supports that scope, or that it cannot select a remedy when the evidence is insufficient. Do not assert service health from idle OK or absent data.

## Recovery, reset, and acceptance

A targeted fix completes at its configuration result; traffic and observed application effects are separate presenter steps. Missing post-fix traffic means effect unobserved, not failed or proven remediation. Completed AWS work may coexist with persistent request failures.

Recover stops all producers, restores expected function caps and the healthy role-backed Inventory alias at baseline memory, settles submitted work, and verifies fresh catalog/checkout/order/stock behavior without deleting data. Reset additionally reseeds under a new productVersion, deletes prior Orders once quiescent, clears browser attempts, and records the next baseline including its verification order/decrement. Both retain logs, alarms, and previous agent results.

Automatic deployment takes priority if it overlaps this workflow: stop new controller work and settle accepted work before deployment mutates the target. Afterward, reconcile using the new trusted deployment generation before verification or reset; never restore old aliases/settings from the superseded baseline. Baseline adoption preserves the current session/run history and unresolved request outcomes. A separately requested, safely reconciled destructive Reset establishes the next business baseline in a distinct controller session/run for history isolation. The [deployment handoff](deployment.md#deployment-and-controller-baseline) owns this sequence.

Keep configured activation, observed incident, action applied, separately observed remedy outcome, alarm delivery, and agent evaluation as separate facts. Contradictory business effects fail application verification; missing evidence, unsettled outcomes, or interrupted reset remain incomplete.

For a fresh alarm-driven incident, first observe the actual alarm OK with its integration ready. A repeated surge after a successful capacity fix may correctly produce no new alarm. The direct alarm-to-Lambda-to-Runtime path, canonical transition identity, durable run discovery, and captured regression evidence approach are selected. Exact load/cap values, propagation deadlines, event/record wire schemas, and lookup/capture implementations remain implementation choices; this contract records no executed tests or measured AWS results.
