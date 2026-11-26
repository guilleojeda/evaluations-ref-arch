# Demonstration scenario contracts

The selected incidents are **inventory-access-denied** and **inventory-capacity-overload**. Both use unchanged healthy application code. **recovered-stale-alarm** is a time and evidence condition reached through recovery, not a third injected fault. The [attendee guide](attendee-guide.md) gives the public denial-to-CI story; this document keeps the scenario invariants.

The [application](components/application.md) owns API and business semantics. The [controller specification](components/failure-controller-behavior.md) owns actions, traffic, and records. The [operations agent](components/operations-agent.md) investigates and recommends. [Evaluations](evaluations.md) assess the candidate against reviewed expectations.

## Common contract

Record the trusted deployment generation and artifact identity, healthy and denied Inventory versions, memory allocations, aliases, execution roles, exact policy state, Inventory's release-owned reserved-concurrency baseline of **16**, Checkout's unreserved setting, and the normal catalog and business baseline. The healthy and denied baseline-memory variants share checked code and non-role settings; only the execution role differs. A baseline belongs to its deployment generation and must not restore old settings over a newer or uncertain deployment.

The presenter controls activation, targeted fixes, traffic, recovery, and reset separately. The agent proposes exactly one of **Increase reserved concurrency**, **Increase memory**, **Restore inventory access**, or **Other** with a reason. The agent cannot call the controller. A targeted configuration action changes and reads back only the selected setting; it does not send application traffic or establish recovery.

Normal traffic is bounded and separately recorded. Checkout inputs use fresh immutable IDs, SKU, quantity, and product version. Stop prevents new submissions but does not cancel accepted work. Settle and reconcile uncertain checkouts before Reset. Never queue catch-up work or count catalog responses as orders.

The current `inventory_surge` profile requests 30 catalog reads every 1,000 ms for 15 seconds, at most 450 attempts and 30 in flight, with a bounded launch allowance and request timeout. It also reserves sparse quantity-one checkout probes. These are requested bounds, not delivered-demand guarantees. Use a new action ID for each phase and the same saved profile for both capacity episodes. Compare actual starts, skips, cohorts, arrivals, outcomes, native metric windows, and business effects. Empty or incomplete metric series remain unknown.

Retain four evidence layers:

1. **Actions:** requested and actual configuration, alias/version/role/policy state, acknowledgements, and traffic parameters.
2. **Effects:** actual demand, HTTP results, caller and child errors, executed versions, receipts, and settled stock/order effects.
3. **Monitoring:** alarm ARN, originating ALARM transition, current state and reason, read times, and freshness.
4. **Agent:** genuine alarm identity, matching run and trace, status, report, and result.

An alarm or dashboard poll does not establish an invocation. A saved trace is evidence of that execution, not evidence that a later candidate ran.

Both incidents use the native stage-level HTTP API 5xx alarm: Sum >= 1 over 60 seconds, 1 of 1, missing data notBreaching. It includes catalog failures and is not checkout-only. The two causes produce dependency-failure 502 responses when the Inventory lookup fails before a transaction. Keep ambiguous writes and unrelated timeouts separate.

Agent evidence may include ordinary current caps, alias/version metadata, role and relevant policy, management history, logs, and metrics. Private scenario labels, controller intent, expected answers, credentials, and raw authentication configuration are not agent inputs. Local and CI regressions use one coherent captured view for all four tools at the case reference time, with no live fallback.

## Agent expectations

| Evidence-supported condition | Correct recommendation | Unacceptable response |
| --- | --- | --- |
| Inventory capacity is throttling the comparable workload | Increase reserved concurrency on Inventory to a supported higher limit | Choose an unsupported target, change an unrelated setting, or claim memory fixes throttling without evidence |
| Inventory reads are blocked by the scoped IAM Deny on the denied version | Restore inventory access by selecting the healthy role-backed version at the current memory | Increase memory or concurrency while leaving the denied version active |
| Current requests support recovery in the investigated scope | Other, with the scope of the no-change conclusion | Apply a remedy only because an old alarm remains ALARM |
| Evidence cannot establish a supported action | Other, with the uncertainty and next useful investigation | Invent a cause, target, or recovery claim |

The known faulty behavior is **Increase memory on Inventory for inventory-access-denied**. The corrected behavior must handle both mechanisms. A deterministic action check can reject a wrong recommendation even when its prose diagnosis sounds plausible.

## inventory-capacity-overload

### Cause and baseline

At ordinary demand, the application is healthy. Inventory starts at release cap **16**, Checkout is unreserved, and healthy aliases, access, code, memory, and product version remain unchanged. Record ordinary baseline behavior before the finite surge.

### Activation

Run the saved finite surge with sparse checkout probes. Increase demand without changing the cap, code, memory, aliases, access, or product version. Stop and drain before changing the cap. Require evidence of Inventory caller rejection, positive native Inventory throttles, the corresponding checkout dependency failure before transaction writes, and the matching alarm and agent run. Rule out Gateway, producer, checkout, queueing, and upstream bottlenecks. If the effect is not observed, mark the incident unverified.

### Fix and comparison

The appropriate recommendation is to increase Inventory reserved concurrency to a permitted higher limit. The controller's first higher target is **32** and its supported input range is 16 through 64. The capacity action reads back configuration only.

After the cap-16 episode settles, apply the Inventory-only 16 to 32 action and explicitly repeat the same saved surge profile. Compare actual demand over the same production duration, request arrivals, skips, native windows, caller outcomes, and upstream headroom. At 32, every observed catalog read must succeed and every submitted checkout probe must settle with its matching order and stock decrement. A profile label or quiet request is not proof of serving the original demand.

### Close

Recover returns Inventory to 16, restores healthy current-generation settings, preserves the product version, orders, and history, verifies a fresh order and stock decrement, observes alarm OK, and leaves traffic stopped. It does not reset business data.

## inventory-access-denied

### Cause and baseline

Normal traffic works through the healthy Inventory version at baseline memory and sufficient capacity. The denied version has the same checked code and non-role settings but a role with a permanent exact-table `dynamodb:GetItem` Deny. Keep the overload producer stopped.

### Activation

Select the prepared denied version through the single-target live alias. Record the prior alias target, selected version, execution role, policy and access state. Stop on unexpected drift. Observe the failed Inventory read and matching 502 within the bounded probe window. The activation may use bounded probes to trigger the real alarm.

### Ineffective and appropriate actions

The faulty candidate recommends **Increase memory on Inventory**. Select a supported larger memory version that preserves the denied role and policy, read back the alias and memory, then submit exactly one fresh checkout from the existing signed-in storefront. It must retain the denied read and 502 and create no order or stock decrement. Do not retry it or start healthy traffic. A failed or no-op configuration action is not an executed ineffective remedy.

The appropriate recommendation is **Restore inventory access** by selecting the allowlisted healthy role-backed version at the current memory. The access action uses a compare-and-swap alias update, reads back the alias, version, role and policy, and does not broaden permissions, publish `$LATEST`, or issue application probes. Repeat ordinary catalog and checkout requests only after the healthy version is selected. Do not select the denied version again.

### Close

Observe the genuine new request outcome separately from the alias readback. Recover restores the current-generation healthy alias and baseline memory while preserving business data and operational history.

## recovered-stale-alarm

This condition uses a genuine originating event, retained incident evidence, and timestamped post-recovery requests. An alarm may remain ALARM while requests succeed. Ordinary success does not prove that a prior capacity surge was served.

Do not fabricate an alert, manipulate alarm state, reapply a fault, or invoke the agent manually. A qualifying investigation must have seen the post-recovery evidence. If no qualifying live run exists, use a reviewed replay with the original event and an explicit later reference time supported by captured post-recovery evidence. Label it replay. Do not add future evidence to the earlier report or rejudge it as if it knew the future. Use **Other** when the later evidence supports no change or when it cannot support a conclusion.

## Recovery, reset, and acceptance

Keep activation, observed incident, action result, separate remedy outcome, alarm delivery, and agent evaluation as separate facts. Missing post-fix traffic means effect unobserved, not failed or proven. Contradictory business effects fail application verification. Missing evidence, unsettled work, or an interrupted Reset remains incomplete.

Recover stops producers, settles accepted work, restores current-generation caps and healthy aliases at baseline memory, verifies catalog, checkout, order and stock behavior, and preserves data. Reset is the separate destructive whole-session operation: reconcile the current successful release, create a new product version, replace stock at 1,000, delete old Orders after quiescence, verify one baseline order and stock 999, and leave traffic stopped. Replace an interrupted Reset with a new confirmed action after its execution and drain window; never resume or reuse it.

If deployment overlaps a run, stop new controller work, settle accepted work, reconcile the new trusted generation, and verify readiness before resuming. Never restore a superseded baseline over a newer release. See [deployment](deployment.md#deployment-and-controller-baseline), [preparation](preparation.md), and [cleanup](cleanup.md).
