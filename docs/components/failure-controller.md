# Failure Controller

The failure controller is a local presenter web application that generates bounded traffic, causes two selected operational incidents, and shows their real effects. It provides separate shortcuts for the presenter to apply a proposed remedy, recover the application, and reset business data. The presenter controls each transition.

This component is designed, not implemented. The [controller specification](failure-controller-behavior.md) owns action behavior, traffic bounds, observations, private records, and interruptions. The [scenario contracts](../demo-scenarios.md) own inventory capacity overload, denied inventory access, and the recovered/stale-alarm condition. The [demo script](../demo-script.md) places these controls in the talk. The [agent design](operations-agent.md) defines the alarm-to-Runtime path and durable run/report records; exact integration schemas remain to be implemented.

## Selected incidents and fixes

Both incidents start from healthy application code and do not require a faulty checkout release or a delayed inventory release.

| Incident | How the controller causes it | Configuration control |
| --- | --- | --- |
| Inventory capacity overload | Start a finite surge of ordinary authenticated catalog reads against a positive inventory Lambda concurrency limit that supports baseline demand. Include sparse checkout probes. Activation increases demand without changing code or lowering the limit. | Increase inventory reserved concurrency. |
| Inventory access denied | Apply a narrowly scoped Inventory table resource-policy denial of the inventory role's required read operation, keeping its original role permission intact. | Restore the expected Inventory table policy. |

## Configuration actions

The controller supports increasing reserved concurrency, increasing Lambda memory, and restoring the Inventory table access policy. For a function action, the operator selects checkout or inventory and an explicit supported target value. These capabilities are available independently of incident selection or an agent report.

**Increase Lambda memory** raises the selected function's memory allocation to the requested supported size in MB. It preserves application code and all other settings, records the previous and resulting memory/version state, and reads back the configuration of the version invoked through the live alias. Recover and Reset restore the captured baseline memory and version state. The [specification](failure-controller-behavior.md#increase-function-memory) defines the action contract and published-version constraint.

The agent investigates ordinary logs, metrics, and relevant configuration evidence and merely recommends an action, another response, or no remediation. It has no mutation tools or controller authority. The presenter independently selects a shortcut and its target/value. Controller actions do not depend on parsing or executing an agent report, and an action can be used without an agent run.

A shortcut changes only its selected setting and reports applied, no change, failed, or unknown from configuration acknowledgement/readback. It does not start or stop traffic, submit application probes, or judge incident resolution. It must not silently call Recover, fix another component, or substitute the controller's known cause for the presenter's choice. Application outcomes remain separate observations.

## Presenter experience

Establish credentials and the target, then check readiness. Start normal traffic, activate one incident, inspect its effects and the agent's investigation, and choose a remedy when ready. After the fix, explicitly generate or repeat traffic to observe its effect. Use Recover to return to the demonstration baseline; use Reset when a new business-data baseline is needed.

For overload, the presenter can stop the surge, apply a fix, then repeat the same workload at the current capacity setting to show whether it now succeeds. Repeating the workload does not restore the original cap or require another failure. Compare actual demand and outcomes across those separate phases; a quiet application after Stop traffic does not show that peak demand can be served. Additional batches use the remaining read budget and never extend automatically. For denied access, repeat ordinary requests after the policy fix without reapplying the denial. None of this traffic belongs to the fix action itself.

Keep controls and observations visible together. Activation confirmed and incident observed are separate states. Stopping traffic, applying one remedy, recovering configuration, and resetting data are separate intentions. Stop prevents new generated requests; it does not cancel submitted work.

### Observation views

Keep the accepted overview of checkout outcomes, latency, actual CloudWatch alarm state, and agent activity beside the action summary. Add the catalog-load observations needed to understand capacity incidents without replacing checkout outcomes with read counts.

| View | Purpose | Evidence boundary |
| --- | --- | --- |
| Target and action status | Identify the application, selected action, progress, and configuration change | A requested condition or API acknowledgement is not proof of its effect |
| Catalog load | Show configured pacing, actual submissions/completions, skipped submissions, in-flight reads, and remaining budget | Controller traffic only; configured rate is not measured demand |
| Checkout activity | Show actual outcomes, latency, and unresolved logical checkouts | Distinguish generator requests and action probes; retain available request IDs |
| Orders and inventory | Show confirmed orders and stock observations | Deduplicate receipts; stale or denied stock reads are not zero stock |
| Application evidence | Show dependency invocation errors, inventory throttles, current limits, and relevant policy/change evidence | Label source, scope/window, and freshness; missing child logs do not establish health |
| CloudWatch alarms | Show actual state, reason, and update/read times | Missing configuration and stale/failed reads are distinct from OK |
| Run timeline | Connect intent, configuration changes, measured demand, effects, alarms, and agent events | Preserve source times and observation times |

The [application alarm](application.md#application-alarm) remains native stage-level HTTP API 5xx: Sum >=1 over 60 seconds, 1-of-1, missing data notBreaching. Both selected incidents can produce dependency-failure 502 responses, including on catalog reads. The alarm identifies a symptom, not its cause. An idle OK state does not prove health; an old ALARM does not disprove fresh recovery. Do not manufacture transitions or promise fixed detection/clearing times.

Use ordinary React components and independent observation reads. Each view identifies source, time window, last observation, loading, and error state. No dashboard plugin system is needed. The checkout page retains its browser-only history; controller catalog and checkout traffic must be labelled separately.

### Presentation layout

Keep one dashboard route with a compact Actions menu, large status text, and persistent action progress. Preserve the accepted wrapping layout and support substantial browser zoom. Put detailed configuration, records, and older timeline entries below the essential overview. Do not shrink text or introduce horizontal scrolling to fit primary controls.

The Actions menu offers readiness, normal traffic, incident activation, Stop traffic, increase function capacity, increase function memory, restore inventory access, Recover, and Reset. Choosing an action keeps the overview visible, shows progress, and disables conflicting mutations. Stop remains available when a producer is active. Reset explains its destructive data effect inline.

The [interactive design preview](../design/controller-dashboard-preview.html) uses illustrative data and predates these incident and remediation controls. It is a layout reference, not an implemented or current menu specification. Its earlier layout checks at 1280px, 1024px, 800x450, 640x360, and 320px do not verify the new controls or actual projector readability. Retain the 960x540, 800x450, and 640x360 effective-viewport stress cases and narrow reflow to 320px when implementing the updated view.

### Refresh and alarm-triggered investigation

Initially refresh observations every five seconds, with the intended five-to-ten-second cadence configurable. Preserve prior values and their freshness on read failure; prevent overlapping reads for the same source. Refresh does not mutate application state or move focus.

Show separate timestamps for the alarm transition, observed agent run, and result. Match durable runs by selected alarm ARN and originating ALARM transition identity, retaining that identity after the current alarm returns to OK. An ALARM state, dashboard poll, incident activation, or remediation action does not itself prove or start an agent invocation. A prior run stays labelled as prior.

Run display distinguishes waiting, alarm active with no matching run, investigating, complete, failed, and unavailable. Regression/replay workflows remain separately identified; the dashboard provides no manual agent trigger as a substitute for the live alarm path.

### Local hosting

Host the React presenter interface with a local TypeScript backend. The backend binds to loopback, accepts intended same-origin controls, uses the operator's AWS profile, and holds the privately supplied application credential in process memory. Browser JavaScript receives no AWS credentials. The application credential grants business API access, not configuration or reset authority.

The backend owns accepted finite work across browser disconnects. AWS connectivity and established credentials remain necessary. Backend restart requires reconciliation before an explicit presenter continuation.

Automatic deployment takes priority after its build/check/gate succeeds. Before deployment changes AWS, the controller stops producers, rejects new presenter mutations, and settles/reconciles accepted work; it does not cancel requests or run Recover/Reset as a handoff. The controller remains suspended through deployment. A successful new generation invalidates the old baseline, so actual settings must be reconciled against the new generation's trusted expectations and explicitly verified before normal actions resume. The [deployment contract](../deployment.md) defines handoff, failure, and post-deployment reconciliation; exact fencing/storage mechanics remain open.

## Responsibilities and record

| Action | Controller responsibility | Evidence to retain |
| --- | --- | --- |
| Establish baseline | Bind known expected healthy versions and settings to a trusted successful deployment generation; exercise normal reads and a checkout | Target, generation/artifact identity, actual settings/revisions, successful requests, and the post-checkout stock/order baseline |
| Cause capacity overload | Apply the selected finite demand profile without changing its positive inventory cap | Intended profile, actual demand, invocation errors/throttles, and affected request windows |
| Deny inventory access | Apply only the selected role/read-operation denial on the Inventory table | Prior policy, requested change, actual revision/readback, and observed denied reads |
| Apply a configuration action | Increase the selected function's reserved concurrency or memory, or restore the expected Inventory table policy, without generating traffic | Operator choice, before/after values and version/alias state where applicable, and configuration result/readback |
| Repeat traffic and observe | Explicitly run another bounded workload at the current configuration | Actual demand, phase windows, and request outcomes, separate from the preceding action result |
| Recover application | Stop traffic, confirm the baseline generation is still current, restore expected policies/caps and baseline memory/alias versions, settle work, then verify fresh behavior | Confirmed restoration and fresh evidence, retaining prior effects and results |
| Reset demo | Reconcile against trusted expected settings for the current successful generation, settle work, reset Orders/Inventory under a new productVersion, then verify the next baseline | Reset progress and the actual baseline including the verification order |

Use the private append-only local journal defined in the [specification](failure-controller-behavior.md#backend-boundary-and-private-records). Capture absence of a policy or concurrency setting as absence, not zero. Policy restoration uses expected settings and current revision checks; unexpected external edits are conflicts, not permission to overwrite unrelated access. Recover is limited to a still-current baseline. After deployment, use guarded changes tied to the new trusted generation; Reset does not require restoring a stale baseline and may establish the next run only after safe reconciliation and quiescence. Preserve request budgets, unresolved outcomes, and agent/run history across deployment.

Private scenario labels, expected answers, controller baseline mappings, and intended causes are evaluator context, not agent inputs. Ordinary observed limits, policy statements, execution versions, errors, and management history may be agent evidence. Exclude credentials, authentication configuration, and raw SDK/configuration dumps.

The [application design](application.md) owns API/business semantics, authentication, checkout identities, and productVersion. Traffic uses that normal authenticated API. There is no bypass endpoint, automatic remedy, or generic AWS command executor.

## Verification and limits

For each incident, distinguish baseline readiness, action acceptance, configuration or traffic confirmation, observed request effects, alarm state, and an actual matching agent run. Missing evidence stays incomplete.

Overload verification distinguishes inventory throttling from Gateway rejection, checkout throttling, client queueing, and database contention. Lambda concurrency and synchronous request-rate limits are related but different; use the observed reason rather than asserting that execution slots were all busy. Policy changes require actual denied/successful read evidence after propagation.

A single successful quiet checkout cannot certify overload resolution. First verify service at comparable demand; after stopping producers and settling work, verify precise order/stock effects. Full Recover deliberately returns the original low-demand configuration, including the original capacity limits; it is separate from proving that an increased limit handled the surge.

Reset preserves operational history, invalidates old productVersion payloads, and requires cleared browser attempts and settled checkout outcomes. The next baseline includes the verification order and stock decrement. An unresolved outcome or interrupted reset prevents claiming completion.

The selected scope is these two operational incidents, their presenter-operated fixes, and recovered/stale-alert interpretation. Data corruption, general chaos tooling, and new infrastructure are not additional requirements. Exact traffic/cap values and propagation deadlines remain implementation/rehearsal settings; no controller or AWS behavior has been implemented or measured here.
