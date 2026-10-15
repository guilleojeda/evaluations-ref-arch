# Demonstration scenario contracts

**Status: intended behavior; not implemented.** The selected incidents are **inventory-capacity-overload** and **inventory-access-denied**. Both use unchanged healthy application code. The application-regression and fixed-delay fixtures are no longer the selected controller incidents. **recovered-stale-alarm** remains an observation condition reached through recovery, not another fault.

The [application](components/application.md) owns API/business semantics; the [controller specification](components/failure-controller-behavior.md) owns actions, traffic, and records. The [operations agent](components/operations-agent.md) investigates and recommends; [evaluations](evaluations.md) assess its behavior.

## Common contract

Setup records the trusted deployment generation and artifact identities, healthy numeric checkout/inventory live-alias versions and memory allocations, expected function caps, the expected Inventory table policy/revision or its absence, target resources, and the normal catalog/business baseline. A baseline belongs to that deployment generation; it cannot restore old settings over a later or uncertain deployment. The [deployment contract](deployment.md) and [controller specification](components/failure-controller-behavior.md) own reconciliation and safe baseline adoption. Inventory's positive cap supports ordinary demand. A positive checkout cap with adequate headroom allows a real wrong-component increase to be demonstrated. Exact caps and workload bounds remain unselected.

The presenter controls incident activation, targeted fixes, traffic, recovery, and reset separately. The agent recommends one of **Increase reserved concurrency**, **Increase memory**, **Restore inventory access**, or **Other**, with an explanation and the action's target/value where applicable. Other includes a justified no-change response or insufficient evidence. It does not call the controller or supply its authority. Shortcuts are usable independently of an agent report or evaluation result.

**Targeted fixes only change the selected configuration and report the action result.** They do not start/stop traffic, submit verification requests, or decide whether the incident is resolved. The presenter can apply a fix and then explicitly repeat the workload to show what happens. Ordinary independent dashboard observations remain available throughout.

Use normal authenticated catalog and checkout requests. Catalog load has explicit finite duration, maximum attempts, pacing, in-flight bound, and a run-level read allowance; it is separate from the **60 checkout POST attempts per run**, including retries and action/baseline probes. Each checkout uses a fresh UUID with immutable sku, quantity, and captured productVersion. A retry retains its identity/input and consumes another POST attempt. Start, Stop, activation, and a targeted fix do not replenish budgets; explicit repeated phases use remaining allowances.

Record actual submissions, completions, skipped pacing ticks, in-flight requests, and phase windows. A configured rate is not proof of delivered demand. Do not queue a backlog, send catch-up bursts, silently extend a finite batch, or count catalog responses as orders.

Stop prevents new submissions; it does not cancel accepted AWS changes or submitted requests. Settle and reconcile uncertain checkouts before destructive reset. A single missing-order read does not rule out a later commit. Browser closure leaves bounded accepted backend work running; backend restart requires reconciliation and explicit continuation.

Retain four evidence layers:

1. **Actions:** private intent and expected baseline, actual target/value or policy revisions, acknowledgements/readbacks, and traffic phase parameters.
2. **Effects:** measured demand, HTTP outcomes, correlated caller/child errors, actual execution versions where code executed, confirmed receipts, and settled stock/order changes.
3. **Monitoring:** actual alarm ARN, originating ALARM-transition timestamp, current state/reason, separate update/read times, and observation freshness. Retain the originating identity after OK and use actual durable run records to discover investigations missed by polling.
4. **Agent:** genuine alarm-event identity, matching run/trace/status, and result. An alarm or dashboard poll does not establish an invocation.

Both incidents use the selected native stage-level HTTP API **5xx** alarm: Sum >=1 over 60 seconds, 1-of-1, missing data notBreaching. It includes catalog failures and is not checkout/controller-only. The two causes produce dependency-failure 502 responses where the inventory lookup is confirmed to have failed before a transaction. Unrelated timeouts or ambiguous write acknowledgements retain their own API meanings.

Agent evidence may include ordinary current caps, relevant table policy, management change history, logs, metrics, and version metadata. Private scenario labels, intended causes, controller baseline mappings, expected answers, credentials, and raw authentication configuration are not agent inputs. Do not infer a failed child's executed version from an alias when no child invocation occurred.

For repeatable local/CI regressions, retain versioned, queryable captures of those ordinary sources at an explicit investigation reference time. All four tools use the same captured view, including supported as-of configuration and bounded change history; no query falls back to the recovered live application. Candidates choose their own queries, with missing coverage visible. Each new regression execution has its own identity and retains the original event/case provenance. The [evaluation contract](evaluations.md) owns capture, time, and candidate-comparison semantics; recorded-trace judging remains distinct from executing a candidate.

## Agent candidates and scenario expectations

The [agent software stages](components/operations-agent.md#software-stages) define the initially defective and corrected candidates. The [demo progression](demo-progression.md) defines how they are presented.

| Condition supported by the evidence | Corrected candidate recommendation | Unacceptable response |
| --- | --- | --- |
| Inventory capacity is throttling the comparable workload | Increase reserved concurrency on inventory to an explicit supported higher limit | Increase the unconstrained checkout function, restore an unrelated policy, or assert that a memory increase addresses the observed limit without supporting evidence |
| Inventory reads are blocked by the scoped table-policy denial | Restore inventory access on the Inventory table | Increase memory or reserved concurrency while leaving the denial in place |
| Current requests support recovery within the investigated scope | Other, explaining that no configuration change is needed and the scope of that conclusion | Apply a remedy solely because the old alarm remains ALARM |
| The available evidence cannot establish a supported action | Other, explaining the uncertainty and useful next investigation | Invent a cause, target, or recovery claim |

The initial candidate's selected known defect is **Increase memory on inventory for inventory-access-denied**. S0 shows that behavior without an evaluation verdict; S1 reviews its expected alternative; S2–S3 expose the defect with evaluations; S4 explicitly repairs the agent. A code check can reject the wrong recommendation even if its prose diagnosis sounds correct. The corrected candidate must handle both incidents; the initial candidate need not recommend memory for both.

The memory action must change the allocation of the version actually invoked through inventory's live alias, preserving the code and non-memory settings. The denial remains active, so separate fresh requests still fail. This establishes an ineffective recommendation through an actual execution rather than a simulated action. Exact memory targets remain rehearsal settings. Increasing memory can affect performance in other workloads; the selected denial case makes this demonstration independent of that effect.

## inventory-capacity-overload

### Cause and baseline

The application works at ordinary demand. Inventory has a small positive reserved-concurrency cap; checkout, Gateway, and database capacity are adequate for the selected workload. Healthy versions and access policy remain unchanged. Record successful baseline catalog and checkout behavior before starting the surge.

### Activation

Start the selected finite surge through authenticated GET /api/products, with sparse checkout probes within the POST budget. These normal reads invoke inventory without creating orders or causing hot-stock write contention. Increase demand without changing the inventory cap, deploying code, introducing a sleep, or setting concurrency to zero.

Observe actual inventory invocation rejections, checkout caller error reasons, and native inventory Throttles in the traffic window. Both concurrent-execution exhaustion and the related synchronous request-rate quota are possible; identify the observed constraint or qualify the diagnosis as capacity throttling. Throttled requests do not execute inventory code and do not increment its Invocations or Errors. Missing child logs alone are not a diagnosis.

Check that Gateway throttling, checkout limits, client queueing, or other failures are not the actual bottleneck. Mark the incident unverified if its expected effect was not observed.

### Fixes and separate demonstration

**Appropriate recommendation:** Increase reserved concurrency on inventory to an explicit permitted higher limit.

**Example ineffective action:** increase checkout reserved concurrency while inventory remains the constrained dependency. This must be a real increase from a positive checkout cap; an already-active target is a no-change result.

Each action changes only the named cap and reads back the result. It neither generates traffic nor checks application outcomes. Do not switch another setting or call Recover on the presenter's behalf.

The presenter may stop the surge, apply the action, and then explicitly repeat the same workload profile at the current limits. Repetition does not restore the original inventory cap, lower demand, or imply that a new fault or alarm must occur. A successful replay of the surge after the inventory increase is the desired result.

Assess that separately observed result against actual offered rates, workload mix, request outcomes, and throttling windows. A quiet successful request or a batch ending cannot establish that peak demand is now served. A further phase must fit the remaining run budgets. Label reduced-load stabilization separately from serving the original surge.

### Agent and operational close

The agent should identify the constrained component using ordinary evidence, separate request-rate from concurrency claims, and justify a remedy or uncertainty. Equivalent supported investigations are valid. It must not receive the controller's intended cause, invent a deployment regression, or claim to have changed capacity.

Observe the real alarm and matching agent run independently. If finite traffic ends without proving delivery, retain the application evidence and report live delivery incomplete rather than extending traffic or manually invoking the agent.

After the presenter has observed the remedy result, stop producers and settle work for exact order/stock verification. Full Recover returns the expected low-demand caps/policy and healthy aliases and verifies fresh baseline business behavior. Restoring the original cap is not the overload fix; its original surge limitation remains part of that baseline.

## inventory-access-denied

### Cause and baseline

Normal traffic works with healthy versions, sufficient capacity, and the expected Inventory table policy. Keep the overload producer stopped. The inventory execution role already has the required read Allow.

### Activation

Apply a prepared Inventory table resource-policy Deny scoped to the inventory role and its actual required read operation. Preserve other principals and operations, including controller recovery and checkout writes. Record the prior policy or its absence and the applicable revision. Stop on unexpected external drift rather than overwriting unrelated access.

Policy application/readback are eventually consistent, and subsequent policy updates are blocked for 15 seconds. Actual request observations establish the effect; configuration acknowledgement alone does not. See [PutResourcePolicy](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_PutResourcePolicy.html) and [policy constraints](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/rbac-considerations.html).

Bounded catalog reads can establish a correlated denied DynamoDB operation in inventory logs. A fresh checkout lookup fails with 502 before its transaction; confirm no writes for those known pre-write failures after settling, while keeping overlapping successes and unrelated unknown outcomes separate.

### Fixes and separate demonstration

**Appropriate recommendation:** Restore inventory access, restoring the expected Inventory table resource policy and removing the scoped denial.

**Initial candidate's ineffective recommendation:** Increase memory on inventory. The presenter selects a supported larger size in MB. Confirm the live alias's effective memory/version change, then separately repeat ordinary requests while the denial remains active. Those requests should still show the denied read and 502 responses. Do not silently restore the table policy or execute Recover as part of the memory action. A configuration failure or no-change result does not demonstrate a successfully executed ineffective remedy.

An increase to either function's reserved concurrency also leaves this denial in place; it is another incorrect recommendation for the reviewed case, not an additional required live demonstration.

The access shortcut applies only the expected policy restoration, with revision/conflict checks and configuration readback. It does not broaden the execution role, change aliases/caps, issue application probes, or decide whether reads work.

After policy restoration, the presenter explicitly repeats ordinary catalog/checkout traffic and observes whether the previously denied operation succeeds. Do not reapply the Deny to test the fix; that would cause another incident. Propagation can leave transient failures after a successful policy action, so preserve their timestamps rather than equating action completion with immediate request success. A changed memory version may remain active during this observation; full Recover restores its captured baseline afterward.

### Agent and operational close

The corrected agent should use the denied operation/resource, current policy or relevant history, and request correlation to support an access diagnosis and Restore inventory access. It must not infer a capacity problem merely from a dependency error or recommend unnecessarily broad grants. Missing policy evidence may require a qualified diagnosis or Other. The initial memory recommendation is a known agent defect, not acceptable handling of this evidence.

Observe the genuine alarm/run separately. After request success is observed, stop other writers, settle outcomes, and verify fresh business effects. Recover restores the expected policy, original caps, and healthy aliases while preserving data and operational history; alias movement alone cannot repair the policy.

## recovered-stale-alarm

This is a recovery/time interpretation condition, not a third injected fault. Use a genuine originating incident/event, retained historical evidence, and timestamped fresh healthy requests after policy/configuration recovery or a separately demonstrated fix.

An alarm may remain ALARM while requests succeed. For an overload incident, distinguish successful ordinary traffic from a demonstrated successful surge: the former alone cannot establish peak-load recovery. Keep incident, action, request, alarm, and investigation times distinct.

Do not fabricate an alert, manipulate alarm state, reapply a fault, or directly invoke the agent to make this condition appear live. Recovery does not promise another alarm transition or agent invocation. A qualifying actual investigation must have seen the relevant post-action evidence; an earlier report cannot be scored as if it knew the future.

If no qualifying live run exists, preserve a reviewed regression/replay case with its original event, evidence windows, and an explicit later investigation reference time supported by captured post-recovery evidence. Execute the candidate against that coherent captured view and label it as replay. Do not add future recovery evidence to the earlier ongoing-incident case or rejudge its earlier report as though it had seen recovery. The agent selects Other and explains that no remediation is needed when evidence at the case reference time supports that scope, or that it cannot select a remedy when the evidence is insufficient. Do not assert service health from idle OK or absent data.

## Recovery, reset, and acceptance

A targeted fix completes at its configuration result; traffic and observed application effects are separate presenter steps. Missing post-fix traffic means effect unobserved, not failed or proven remediation. Completed AWS work may coexist with persistent request failures.

Recover stops all producers, restores expected function caps/table policy and baseline memory/version state through healthy aliases, settles submitted work, and verifies fresh catalog/checkout/order/stock behavior without deleting data. Reset additionally reseeds under a new productVersion, deletes prior Orders once quiescent, clears browser attempts, and records the next baseline including its verification order/decrement. Both retain logs, alarms, and previous agent results.

Automatic deployment takes priority if it overlaps this workflow: stop new controller work and settle accepted work before deployment mutates the target. Afterward, reconcile using the new trusted deployment generation before verification or reset; never restore old aliases/settings from the superseded baseline. Baseline adoption preserves the current run and consumed budgets. Only a separately requested, safely reconciled destructive Reset establishes the next run. The [deployment handoff](deployment.md#deployment-and-controller-baseline) owns this sequence.

Keep configured activation, observed incident, action applied, separately observed remedy outcome, alarm delivery, and agent evaluation as separate facts. Contradictory business effects fail application verification; missing evidence, unsettled outcomes, or interrupted reset remain incomplete.

For a fresh alarm-driven incident, first observe the actual alarm OK with its integration ready. A repeated surge after a successful capacity fix may correctly produce no new alarm. The direct alarm-to-Lambda-to-Runtime path, canonical transition identity, durable run discovery, and captured regression evidence approach are selected. Exact load/cap values, propagation deadlines, event/record wire schemas, and lookup/capture implementations remain implementation choices; this contract records no executed tests or measured AWS results.
