# Failure Controller

The failure controller is a cloud-hosted presenter dashboard. It verifies the checkout baseline, runs bounded normal traffic and a finite Inventory catalog surge, selects prepared Inventory memory/access versions, changes Inventory's reserved-concurrency cap, and recovers the current release without deleting orders. Another authenticated browser can observe or stop the same run. Native alarm state, durable agent investigations, source-cited reports, trace references, fixed native metric reads, and endpoint readiness remain independent observations. The capacity comparison is meaningful only when actual demand and native-metric, caller, and business evidence are measured across both episodes.

The [controller specification](failure-controller-behavior.md) owns action behavior, traffic bounds, observations, private records, and interruptions. The [scenario contracts](../demo-scenarios.md) own inventory capacity overload, denied inventory access, and the recovered/stale-alarm condition. The [demo script](../demo-script.md) places these controls in the talk. The [agent design](operations-agent.md) defines the alarm-to-Runtime path and durable run/report records.

## Selected incidents and fixes

Both incidents start from healthy application code and do not require a faulty checkout release or a delayed inventory release.

| Incident | How the controller causes it | Configuration control |
| --- | --- | --- |
| Inventory capacity overload (Phase 10) | Start a finite surge of ordinary authenticated catalog reads against a positive Inventory cap that supports baseline demand. Include sparse checkout probes. Activation increases demand without changing code or lowering the limit. | Increase Inventory reserved concurrency. |
| Inventory access denied | Select the prepared denied Inventory version through the single-target `live` alias. Its static execution role has logging/read access plus a permanent `dynamodb:GetItem` Deny on the exact Inventory table. | Select the healthy role-backed Inventory version at the current memory. |

## Configuration actions

The release-owned Inventory cap is 16. The original release baseline stays 16 even after the controller confirms a higher current cap. The capacity shortcut changes Inventory only; Checkout has no capacity shortcut and remains unreserved. The first higher target is 32, and the input accepts integer values from 16 through 64. Equality with the current cap is `no_change`; lower values are rejected. These are control defaults, not measured surge requirements or guaranteed regional headroom.

The capacity action checks fresh account capacity, records the requested before/target values, changes only Inventory's reserved concurrency, then reads the setting back. It does not call Service Quotas, send business requests, control traffic, or establish recovery. A capacity readback proves configuration only. The surge is a separate explicit action, and the repeat after the change is another new action; neither is started automatically by the capacity control.

The other controls select prepared Inventory memory variants, restore Inventory access, Recover the current release, and Reset business data into a new verified run. Readiness, normal traffic, Stop and inspection remain available. Memory choices come from the current release manifest and are independent of an agent report.

**Increase Lambda memory** selects a prepared qualified version at the requested supported size in MB through a revision-guarded `live` alias update. It preserves application code and all other settings, records the previous and resulting memory/version state, and reads back the configuration of the version invoked through the alias. Recover restores the saved baseline memory/version; Reset reconciles to the trusted expected settings for the current successful release. The [specification](failure-controller-behavior.md#increase-function-memory) defines the action contract and published-version constraint.

The memory command targets Inventory. Use the supported-memory dropdown or the authenticated `PUT /api/actions/<action UUID>` interface:

```json
{"kind":"increase_memory","function":"inventory","memoryMb":512}
```

Choices come from the current release manifest. An equal active size completes as no change; a lower size, unsupported function/value, stale release or incompatible version is rejected. Reusing the same UUID/input returns its recorded outcome. Before a change, the worker saves configuration and guards the alias switch with its observed revision. Lost acknowledgement is reconciled by readback; an unconfirmed result remains unknown. The action sends no app requests and establishes no recovery. Higher memory preserves denial; **Restore Inventory access** selects the matching healthy version at that memory. After the original baseline for the successful deployment is established, readiness accepts a supported higher healthy variant and separately verifies an order/decrement. First adoption requires the release's original healthy baseline settings.

Use the authenticated `PUT /api/actions/<action UUID>` interface for the capacity shortcut:

```json
{"kind":"increase_capacity","function":"inventory","reservedConcurrency":32}
```

The Inventory function must already have a positive cap. The worker requires the selected value to be at least the confirmed current cap, and checks that the requested increase fits the fresh unreserved account capacity while preserving AWS's 100-unit unreserved floor. It rejects stale generation state, unexplained cap drift, unsettled work, or insufficient headroom before changing configuration. A confirmed result updates the controller's current-cap observation; it does not change the original baseline of 16 or the release identity. A lost acknowledgement with matching readback is recorded as applied with the ambiguity retained. No matching or unavailable readback remains failed or incomplete/unknown; the worker does not retry the Put automatically.

The agent investigates ordinary logs, metrics, and relevant configuration evidence and merely recommends an action, another response, or no remediation. It has no mutation tools or controller authority. The presenter independently selects a shortcut and its target/value. Controller actions do not depend on parsing or executing an agent report, and an action can be used without an agent run.

A shortcut changes only its selected setting and reports `applied`, `no_change`, `failed`, or `unknown` from configuration acknowledgement/readback. It does not start or stop traffic, submit application probes, or judge incident resolution. It must not silently call Recover, fix another component, or substitute the controller's known cause for the presenter's choice. Application outcomes remain separate observations.

## Recover the current release

Pause other browser/manual checkout writers, select the existing quiet-writers confirmation, then choose **Recover**. Recover stops both producers itself and drains submitted work. It restores the original healthy Inventory version and memory for the same successful app deployment, Inventory's release baseline cap of 16, and Checkout's unchanged unreserved setting. A confirmed higher Inventory cap does not replace the restore target. Orders, productVersion, actual request history, incident/source history and agent results are preserved; traffic remains stopped.

The authenticated command uses a new action UUID:

```json
{"kind":"recover","confirmQuiet":true}
```

Configuration restoration and business verification have separate results. A complete recovery verifies two fresh catalog reads, a quantity-one checkout, its saved receipt through status, and its same-productVersion stock decrement. Each verification action has its own request bounds and deadline. Existing ambiguous attempts are checked through bounded status reads without resubmitting them; an absent order does not settle an uncertain write. If the bounded verification action cannot complete, verification remains incomplete even when settings are restored. Inspect the recorded configuration result and last independently verified health instead of interpreting a configuration acknowledgement or alarm OK as fresh business proof.

Fresh readiness binds the original baseline to the successful stack generation, immutable versions and artifact/settings identities. First adoption and new-generation adoption require Inventory at 16. Within the same generation, readiness may use a controller-confirmed higher current Inventory cap while retaining the original cap of 16 and the same release identity. It never adopts an unexplained observed increase or carries a prior generation's confirmed raised cap into a new generation. Missing legacy facts, another deployment, unexpected code/role/policy drift or an unknown alias blocks Recover until reconciled. After a successful new deployment, explicit readiness can preserve prior incident history and establish the new original baseline within the current session/run.

Recover stores ordinary configuration evidence before changing settings. If that capture is unavailable, the UI can request separate confirmation to proceed protectively using `recoverWithoutEvidence:true`. This retains the evidence gap and still requires all target checks and fresh business proof. Reusing an action UUID returns its recorded input/result; changed confirmation is conflicting reuse, and a failed/unknown AWS acknowledgement is reconciled by readback without blind retries.

## Presenter experience

Establish credentials and the target, then check readiness. Start normal traffic, activate one incident, inspect its effects and the agent's investigation, and choose a remedy when ready. After the fix, explicitly generate or repeat traffic to observe its effect. Use Recover to return to the demonstration baseline; use Reset when a new business-data baseline is needed.

For the Phase 10 overload scenario, the presenter starts from healthy ordinary demand at Inventory 16, runs the finite catalog surge, stops and drains it, increases Inventory to 32, then explicitly repeats the same saved profile before Recover restores 16. New actions use `inventory_surge` version 2: 30 catalog reads every 500 ms for 15 seconds (60 starts/second average), at most 900 attempts and 30 in flight, plus at most 15 quantity-one checkouts on one-second ticks/one slot; all requests have a 7-second timeout. The UI identifies this as “30 catalog GETs every 500 ms (60/s average), maximum 900 attempts, up to 30 in flight.” These are requested bounds, not achieved-rate claims. Version 1 remains readable in prior history; replaying an existing action UUID retains its saved profile version. Calibrate and remeasure producer and upstream headroom for the target environment before comparing episodes; measure actual starts, wave cadence, skips, cohorts, outcomes, and request arrivals. The **Repeat same Inventory surge profile** control is available only after the latest action uses version 2. A repeat uses the same saved profile with a new action ID and keeps the controller-confirmed current cap; it does not restore the original cap, lower the load, or require another failure. Compare actual starts, per-second cohorts, skips, outcomes, native metrics, and fresh business effects across separately recorded windows. A matching profile name alone does not prove matching delivered demand. A quiet application after Stop traffic does not show that peak demand can be served. Each phase is a separate bounded action and never extends automatically. For denied access, repeat ordinary requests after the alias fix without selecting the denied version again. None of this traffic belongs to the fix action itself.

The dashboard labels the surge controls **Start Inventory surge · 15 s** and **Repeat same Inventory surge profile**. Its cards identify **Catalog totals**, **Checkout totals**, **Production duration**, and **Catalog sample fidelity**; an expandable view is **Catalog outcomes and 15 one-second start cohorts**. Stop progress separates **Stop request receipt**, **Producer admissions**, and **Accepted work drain**. The native metric panel is headed **Native CloudWatch observations**. The **Same-profile comparison** reports the requested profile, resolved context (including cap 16→32), production duration, actual starts, and whether both snapshots are complete. It reports comparison preconditions and does not declare that the capacity remedy succeeded.

Keep controls and observations visible together. Activation confirmed and incident observed are separate states. Stopping traffic, applying one remedy, recovering configuration, and resetting data are separate intentions. Stop prevents new generated requests; it does not cancel submitted work.

### Observation views

Keep the accepted overview of checkout outcomes, latency, actual CloudWatch alarm state, and agent activity beside the action summary. Add the catalog-load observations needed to understand capacity incidents without replacing checkout outcomes with read counts.

| View | Purpose | Evidence boundary |
| --- | --- | --- |
| Target and action status | Identify the application, selected action, progress, and configuration change | A requested condition or API acknowledgement is not proof of its effect |
| Catalog load | **Catalog totals**, **Checkout totals**, **Production duration**, **Catalog sample fidelity**, and expandable **Catalog outcomes and 15 one-second start cohorts** show the saved profile, actual fetch starts/completions, skipped starts, peak/in-flight reads, fixed outcomes, and bounded completed-record sample | Controller traffic only; requested rate is not measured demand. Cohort completions belong to the starts in that cohort. Samples do not determine totals. |
| Checkout activity | Show actual outcomes, latency, and unresolved logical checkouts | Distinguish generator requests and action probes; retain available request IDs. A durably reserved checkout closed before fetch is **Not sent · admission closed**, with no fabricated HTTP status or duration. |
| Orders and inventory | Show confirmed orders and stock observations | Deduplicate receipts; stale or denied stock reads are not zero stock |
| Application evidence | **Native CloudWatch observations** show fixed native Lambda/API Gateway metric series, dependency invocation errors, Inventory throttles, current limits, and relevant policy/change evidence | Fixed 60-second periods/window; label source, scope/window, and freshness. Keep empty or partial series unknown, and missing child logs do not establish health |
| CloudWatch alarms | Show actual state, reason, update/read times, and whether the exact adapter action is configured and enabled | Missing, disabled, unexpected, and stale/failed reads are distinct from OK |
| Agent investigations | Show the matching durable run, report, cited sources, uncertainty, release provenance, trace, and capture reference | Run discovery is separate from the current alarm read; a complete `unknown` assessment is not an overdue run |
| Run timeline | Connect intent, configuration changes, measured demand, effects, alarms, and agent events | Preserve source times and observation times |

The [application alarm](application.md#application-alarm) remains native stage-level HTTP API 5xx: Sum >=1 over 60 seconds, 1-of-1, missing data notBreaching. Both selected incidents can produce dependency-failure 502 responses, including on catalog reads. The alarm identifies a symptom, not its cause. An idle OK state does not prove health; an old ALARM does not disprove fresh recovery. Do not manufacture transitions or promise fixed detection/clearing times.

For each traffic action, the authenticated `GET /api/actions/{UUID}/metrics` route reads only the fixed application metrics: Inventory and Checkout Lambda Invocations/Errors/Throttles (Sum), ConcurrentExecutions (Maximum), Gateway Count/4xx/5xx (Sum), and account ConcurrentExecutions (Maximum) for upstream context. It derives a UTC minute-rounded window from actual producer start through settlement, uses one bounded query call, and rejects caller-supplied resources/windows/queries. Queued actions return pending without a CloudWatch call. Empty sparse series stay empty, and partial provider coverage remains partial. A query is evidence for context, not a certification of demand or recovery.

Use ordinary React components and independent observation reads. Each view identifies source, time window, last observation, loading, and error state. No dashboard plugin system is needed. The checkout page retains its browser-only history; controller catalog and checkout traffic must be labelled separately.

### Presentation layout

Keep one dashboard route with a compact Actions menu, large status text, and persistent action progress. Preserve the accepted wrapping layout and support substantial browser zoom. Put detailed configuration, records, and older timeline entries below the essential overview. Do not shrink text or introduce horizontal scrolling to fit primary controls.

The Actions menu offers readiness, normal traffic, incident activation, Stop traffic, increase Inventory capacity, increase Inventory memory, restore inventory access, and Recover. The capacity input starts at 32 and accepts bounded integer values from 16 through 64. Reset is presented in a separate card with its destructive effect and required confirmations. Choosing a menu action keeps the overview visible, shows progress, and disables conflicting mutations. Stop remains available when a producer is active.

The [interactive design preview](../design/controller-dashboard-preview.html) uses illustrative data and predates these incident and remediation controls. It is a layout reference, not an implemented or current menu specification. Its earlier layout checks at 1280px, 1024px, 800x450, 640x360, and 320px do not verify the new controls or actual projector readability. Retain the 960x540, 800x450, and 640x360 effective-viewport stress cases and narrow reflow to 320px when implementing the updated view.

### Refresh and alarm-triggered investigation

Refresh alarm and investigation observations independently every five seconds. Preserve the last good value and its observation time on read failure, and mark investigation data stale after two intervals. Prevent overlapping reads for the same source. Refresh does not mutate application state or move focus.

Show separate timestamps for the alarm transition, observed agent run, and result. Match durable runs by selected alarm ARN and originating ALARM transition identity, retaining that identity after the current alarm returns to OK. An ALARM state, dashboard poll, incident activation, or remediation action does not itself prove or start an agent invocation. A prior run stays labelled as prior. Show its run/session and candidate provenance, report evidence and uncertainty, sanitized source-capture reference, and actual trace reference separately from the alarm snapshot.

The authenticated `/api/investigations` read queries the durable agent table directly. It accepts an optional configured `alarmArn` and `transitionAt`; without an alarm selector it uses the current configured alarm, and an exact event query returns that row or no row. Recent results are bounded to 20. The route does not call CloudWatch or invoke the agent. Poll it independently from `/api/alarm`, retain its last good value on error, and mark it stale after two five-second intervals. Run display distinguishes no matching run, running, overdue/incomplete, complete (including assessment `unknown`), failed, unavailable, and stale data. Regression/replay workflows remain separately identified; the dashboard provides no manual agent trigger as a substitute for the live alarm path.

### Cloud hosting

A controller-owned HTTP API and Lambda serve the React dashboard and authenticated controls from the same HTTPS origin. The operator signs in with a separate bearer held in page memory. The background worker uses the checkout credential from AWS Secrets Manager to make normal app requests. The dashboard reads durable agent runs from the agent stack's table and reports endpoint and alarm-binding readiness without invoking the agent. It works from a clean browser with the operator credential.

The worker owns accepted finite work. Browser refresh or closure leaves it running within its original bounds. The controller stores the session/run and action records in DynamoDB. Check readiness before starting normal traffic. Use Stop to close new submissions and watch accepted requests drain. When an action outlives its deadline, the dashboard shows it as incomplete. Explicit discard retains actual attempt/outcome records and unresolved orders.

Schedule deployments outside demo runs and wait for each dependent app, agent, and controller release to settle before checking readiness again. A new app release makes an old baseline stale. Preserve orders, session/run history, actual request outcomes, and observation history across deployments. [Deployment and operator access](../deployment.md#first-controller-release-and-operator-access)

## Responsibilities and record

| Action | Controller responsibility | Evidence to retain |
| --- | --- | --- |
| Establish baseline | Bind known expected healthy versions and settings, including Inventory cap 16 and unreserved Checkout, to a trusted successful deployment generation; exercise normal reads and a checkout | Target, generation/artifact identity, original/current cap observations, actual settings/revisions, successful requests, and the post-checkout stock/order baseline |
| Cause capacity overload (Phase 10) | Apply the selected finite demand profile without changing the Inventory cap | Intended profile, actual demand, invocation errors/throttles, and affected request windows |
| Deny inventory access | Select only the prepared denied role-backed Inventory version through the `live` alias | Prior alias/version/role/policy state, requested target, actual revision/readback, and independently observed denied reads |
| Apply a configuration action | Increase Inventory's reserved concurrency, increase Inventory memory, or switch the Inventory `live` alias to the healthy version, without generating traffic | Operator choice, before/after values and version/alias/role/policy state where applicable, and configuration result/readback |
| Repeat traffic and observe | Explicitly run another bounded workload at the current configuration | Actual demand, phase windows, and request outcomes, separate from the preceding action result |
| Recover application | Stop traffic, confirm the baseline generation is still current, restore expected caps and healthy role-backed alias versions at baseline memory, settle work, then verify fresh behavior | Confirmed restoration and fresh evidence, retaining prior effects and results |
| Reset demo | Require quiet, destructive, and checkout-closed confirmations; stop/drain work, reconcile the current trusted release, archive the old run, replace business data under a fresh productVersion, and verify a new run | Previous-run link and preserved history; reset progress and the new baseline including the verification order |

The authenticated `PUT /api/actions/{UUID}` Reset input requires all three confirmations and accepts no caller-selected table, SKU, seed, or product version:

```json
{"kind":"reset","confirmQuiet":true,"confirmReset":true,"confirmCheckoutClosed":true}
```

The [private run and action records](failure-controller-behavior.md#backend-boundary-and-private-records) retain accepted inputs and observed results. Capture absence of a policy or concurrency setting as absence, not zero. Alias restoration uses the allowlisted release/version, expected role and policy state, and current alias revision; unexpected external edits are conflicts, not permission to overwrite unrelated access. Recover is limited to a still-current saved baseline. Before recovery, capture the active alias/version/role/policy configuration. After deployment, use guarded changes tied to the new trusted generation; Reset instead reconciles against the trusted expected settings of the current successful release, even when the old baseline is stale or missing. A failed/partial deployment or unknown current configuration still blocks it. Preserve actual request records, unresolved outcomes, and agent/run history across deployment.

Before changing business data, the controller archives the prior run and makes the Reset action UUID the current run ID, linked to the previous run. The new run remains unusable until Reset verification completes. The authenticated `GET /api/runs/{id}` read returns the current or archived run; the previous-run link is sufficient to inspect history, and archived runs stay read-only. An incomplete Reset leaves the current run unusable. After its worker and drain window have ended, a new confirmed Reset starts with a new action UUID and productVersion; the old action is never resumed. An older unresolved checkout remains unknown in its archived run and does not alone block that new destructive Reset.

Private scenario labels, expected answers, controller baseline mappings, and intended causes are evaluator context, not agent inputs. Ordinary observed limits, policy statements, execution versions, errors, and management history may be agent evidence. Exclude credentials, authentication configuration, and raw SDK/configuration dumps.

The [application design](application.md) owns API/business semantics, authentication, checkout identities, and productVersion. Traffic uses that normal authenticated API. There is no bypass endpoint, automatic remedy, or generic AWS command executor.

## Verification and limits

For each incident, distinguish baseline readiness, action acceptance, configuration or traffic confirmation, observed request effects, alarm state, and an actual matching agent run. Missing evidence stays incomplete.

Overload verification distinguishes inventory throttling from Gateway rejection, checkout throttling, client queueing, and database contention. Lambda concurrency and synchronous request-rate limits are related but different; use the observed reason rather than asserting that execution slots were all busy. Access-version switches require actual denied/successful read evidence from fresh requests after alias readback.

For the Phase 10 overload scenario, a successful quiet checkout cannot certify capacity recovery. Compare service at the original surge demand before and after the Inventory cap increase; after stopping producers and settling work, verify precise order/stock effects. Full Recover deliberately returns Inventory to 16 and Checkout to unreserved; it is separate from proving that an increased limit handled the surge.

Reset preserves operational history, invalidates old productVersion payloads, and requires old work to stop and drain plus checkout pages to be closed. The new baseline includes the single verification order and stock decrement. An incomplete Reset remains unusable; do not resume it or claim success. Once its execution/drain window has ended and it has been explicitly discarded if needed, a new confirmed Reset may proceed with a fresh action UUID/version while retaining any old unknown checkout outcome as unknown.

The selected scope is these two operational incidents, their presenter-operated fixes, and recovered/stale-alert interpretation. Data corruption, general chaos tooling, and new infrastructure are not additional requirements. Set rehearsal waits using observed request, policy and alarm timing.
