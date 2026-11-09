# Failure Controller

The failure controller is a cloud-hosted presenter dashboard. It verifies the checkout baseline, runs bounded traffic, and lets the presenter observe or stop the same run from another browser. It selects and restores the prepared Inventory access-state versions through the single-target `live` alias, records request evidence, and displays the actual app alarm separately. Phase 4 adds durable read-only investigation discovery, source-cited reports, actual trace references, and independent agent endpoint/alarm-binding readiness observations.

The [controller specification](failure-controller-behavior.md) owns action behavior, traffic bounds, observations, private records, and interruptions. The [scenario contracts](../demo-scenarios.md) own inventory capacity overload, denied inventory access, and the recovered/stale-alarm condition. The [demo script](../demo-script.md) places these controls in the talk. The [agent design](operations-agent.md) defines the alarm-to-Runtime path and durable run/report records.

## Selected incidents and fixes

Both incidents start from healthy application code and do not require a faulty checkout release or a delayed inventory release.

| Incident | How the controller causes it | Configuration control |
| --- | --- | --- |
| Inventory capacity overload | Start a finite surge of ordinary authenticated catalog reads against a positive inventory Lambda concurrency limit that supports baseline demand. Include sparse checkout probes. Activation increases demand without changing code or lowering the limit. | Increase inventory reserved concurrency. |
| Inventory access denied | Select the prepared denied Inventory version through the single-target `live` alias. Its static execution role has logging/read access plus a permanent `dynamodb:GetItem` Deny on the exact Inventory table. | Select the healthy role-backed Inventory version at the current memory. |

## Configuration actions

The controller supports increasing reserved concurrency, increasing Lambda memory, and restoring Inventory access by selecting an allowlisted `live` alias target. For capacity, the operator selects a function and permitted cap. For memory, it shows only variants prepared for the current app release; the demo needs baseline and higher Inventory sizes. These capabilities are available independently of incident selection or an agent report.

**Increase Lambda memory** selects a prepared qualified version at the requested supported size in MB through a revision-guarded `live` alias update. It preserves application code and all other settings, records the previous and resulting memory/version state, and reads back the configuration of the version invoked through the alias. Recover and Reset restore the captured baseline memory and version state. The [specification](failure-controller-behavior.md#increase-function-memory) defines the action contract and published-version constraint.

The agent investigates ordinary logs, metrics, and relevant configuration evidence and merely recommends an action, another response, or no remediation. It has no mutation tools or controller authority. The presenter independently selects a shortcut and its target/value. Controller actions do not depend on parsing or executing an agent report, and an action can be used without an agent run.

A shortcut changes only its selected setting and reports applied, no change, failed, or unknown from configuration acknowledgement/readback. It does not start or stop traffic, submit application probes, or judge incident resolution. It must not silently call Recover, fix another component, or substitute the controller's known cause for the presenter's choice. Application outcomes remain separate observations.

## Presenter experience

Establish credentials and the target, then check readiness. Start normal traffic, activate one incident, inspect its effects and the agent's investigation, and choose a remedy when ready. After the fix, explicitly generate or repeat traffic to observe its effect. Use Recover to return to the demonstration baseline; use Reset when a new business-data baseline is needed.

For overload, the presenter can stop the surge, apply a fix, then repeat the same workload at the current capacity setting to show whether it now succeeds. Repeating the workload does not restore the original cap or require another failure. Compare actual demand and outcomes across those separate phases; a quiet application after Stop traffic does not show that peak demand can be served. Additional batches use the remaining read budget and never extend automatically. For denied access, repeat ordinary requests after the alias fix without selecting the denied version again. None of this traffic belongs to the fix action itself.

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
| CloudWatch alarms | Show actual state, reason, update/read times, and whether the exact adapter action is configured and enabled | Missing, disabled, unexpected, and stale/failed reads are distinct from OK |
| Agent investigations | Show the matching durable run, report, cited sources, uncertainty, release provenance, trace, and capture reference | Run discovery is separate from the current alarm read; a complete `unknown` assessment is not an overdue run |
| Run timeline | Connect intent, configuration changes, measured demand, effects, alarms, and agent events | Preserve source times and observation times |

The [application alarm](application.md#application-alarm) remains native stage-level HTTP API 5xx: Sum >=1 over 60 seconds, 1-of-1, missing data notBreaching. Both selected incidents can produce dependency-failure 502 responses, including on catalog reads. The alarm identifies a symptom, not its cause. An idle OK state does not prove health; an old ALARM does not disprove fresh recovery. Do not manufacture transitions or promise fixed detection/clearing times.

Use ordinary React components and independent observation reads. Each view identifies source, time window, last observation, loading, and error state. No dashboard plugin system is needed. The checkout page retains its browser-only history; controller catalog and checkout traffic must be labelled separately.

### Presentation layout

Keep one dashboard route with a compact Actions menu, large status text, and persistent action progress. Preserve the accepted wrapping layout and support substantial browser zoom. Put detailed configuration, records, and older timeline entries below the essential overview. Do not shrink text or introduce horizontal scrolling to fit primary controls.

The Actions menu offers readiness, normal traffic, incident activation, Stop traffic, increase function capacity, increase function memory, restore inventory access, Recover, and Reset. Choosing an action keeps the overview visible, shows progress, and disables conflicting mutations. Stop remains available when a producer is active. Reset explains its destructive data effect inline.

The [interactive design preview](../design/controller-dashboard-preview.html) uses illustrative data and predates these incident and remediation controls. It is a layout reference, not an implemented or current menu specification. Its earlier layout checks at 1280px, 1024px, 800x450, 640x360, and 320px do not verify the new controls or actual projector readability. Retain the 960x540, 800x450, and 640x360 effective-viewport stress cases and narrow reflow to 320px when implementing the updated view.

### Refresh and alarm-triggered investigation

Refresh alarm and investigation observations independently every five seconds. Preserve the last good value and its observation time on read failure, and mark investigation data stale after two intervals. Prevent overlapping reads for the same source. Refresh does not mutate application state or move focus.

Show separate timestamps for the alarm transition, observed agent run, and result. Match durable runs by selected alarm ARN and originating ALARM transition identity, retaining that identity after the current alarm returns to OK. An ALARM state, dashboard poll, incident activation, or remediation action does not itself prove or start an agent invocation. A prior run stays labelled as prior. Show its run/session and candidate provenance, report evidence and uncertainty, sanitized source-capture reference, and actual trace reference separately from the alarm snapshot.

The authenticated `/api/investigations` read queries the durable agent table directly. It accepts an optional configured `alarmArn` and `transitionAt`; without an alarm selector it uses the current configured alarm, and an exact event query returns that row or no row. Recent results are bounded to 20. The route does not call CloudWatch or invoke the agent. Poll it independently from `/api/alarm`, retain its last good value on error, and mark it stale after two five-second intervals. Run display distinguishes no matching run, running, overdue/incomplete, complete (including assessment `unknown`), failed, unavailable, and stale data. Regression/replay workflows remain separately identified; the dashboard provides no manual agent trigger as a substitute for the live alarm path.

### Cloud hosting

A controller-owned HTTP API and Lambda serve the React dashboard and authenticated controls from the same HTTPS origin. The operator signs in with a separate bearer held in page memory. The background worker uses the checkout credential from AWS Secrets Manager to make normal app requests. The dashboard reads durable agent runs from the agent stack's table and reports endpoint and alarm-binding readiness without invoking the agent. It works from a clean browser with the operator credential.

The worker owns accepted finite work. Browser refresh or closure leaves it running within its original bounds. The controller stores the run and action records in DynamoDB. Check readiness before starting normal traffic. Use Stop to close new submissions and watch accepted requests drain. When an action outlives its deadline, the dashboard shows it as incomplete. Explicit discard retains its charged attempts and unresolved orders.

Schedule deployments outside demo runs and wait for each dependent app, agent, and controller release to settle before checking readiness again. A new app release makes an old baseline stale. Preserve orders, remaining allowances and observation history across deployments. [Deployment and operator access](../deployment.md#first-controller-release-and-operator-access)

## Responsibilities and record

| Action | Controller responsibility | Evidence to retain |
| --- | --- | --- |
| Establish baseline | Bind known expected healthy versions and settings to a trusted successful deployment generation; exercise normal reads and a checkout | Target, generation/artifact identity, actual settings/revisions, successful requests, and the post-checkout stock/order baseline |
| Cause capacity overload | Apply the selected finite demand profile without changing its positive inventory cap | Intended profile, actual demand, invocation errors/throttles, and affected request windows |
| Deny inventory access | Select only the prepared denied role-backed Inventory version through the `live` alias | Prior alias/version/role/policy state, requested target, actual revision/readback, and independently observed denied reads |
| Apply a configuration action | Increase the selected function's reserved concurrency or memory, or switch the Inventory `live` alias to the healthy version, without generating traffic | Operator choice, before/after values and version/alias/role/policy state where applicable, and configuration result/readback |
| Repeat traffic and observe | Explicitly run another bounded workload at the current configuration | Actual demand, phase windows, and request outcomes, separate from the preceding action result |
| Recover application | Stop traffic, confirm the baseline generation is still current, restore expected caps and healthy role-backed alias versions at baseline memory, settle work, then verify fresh behavior | Confirmed restoration and fresh evidence, retaining prior effects and results |
| Reset demo | Reconcile against trusted expected settings for the current successful generation, settle work, reset Orders/Inventory under a new productVersion, then verify the next baseline | Reset progress and the actual baseline including the verification order |

The [private run and action records](failure-controller-behavior.md#backend-boundary-and-private-records) retain accepted inputs and observed results. Capture absence of a policy or concurrency setting as absence, not zero. Alias restoration uses the allowlisted release/version, expected role and policy state, and current alias revision; unexpected external edits are conflicts, not permission to overwrite unrelated access. Recover is limited to a still-current baseline. Before recovery, capture the active alias/version/role/policy configuration. After deployment, use guarded changes tied to the new trusted generation; Reset does not require restoring a stale baseline and may establish the next run only after safe reconciliation and quiescence. Preserve request budgets, unresolved outcomes, and agent/run history across deployment.

Private scenario labels, expected answers, controller baseline mappings, and intended causes are evaluator context, not agent inputs. Ordinary observed limits, policy statements, execution versions, errors, and management history may be agent evidence. Exclude credentials, authentication configuration, and raw SDK/configuration dumps.

The [application design](application.md) owns API/business semantics, authentication, checkout identities, and productVersion. Traffic uses that normal authenticated API. There is no bypass endpoint, automatic remedy, or generic AWS command executor.

## Verification and limits

For each incident, distinguish baseline readiness, action acceptance, configuration or traffic confirmation, observed request effects, alarm state, and an actual matching agent run. Missing evidence stays incomplete.

Overload verification distinguishes inventory throttling from Gateway rejection, checkout throttling, client queueing, and database contention. Lambda concurrency and synchronous request-rate limits are related but different; use the observed reason rather than asserting that execution slots were all busy. Access-version switches require actual denied/successful read evidence from fresh requests after alias readback.

A single successful quiet checkout cannot certify overload resolution. First verify service at comparable demand; after stopping producers and settling work, verify precise order/stock effects. Full Recover deliberately returns the original low-demand configuration, including the original capacity limits; it is separate from proving that an increased limit handled the surge.

Reset preserves operational history, invalidates old productVersion payloads, and requires cleared browser attempts and settled checkout outcomes. The next baseline includes the verification order and stock decrement. An unresolved outcome or interrupted reset prevents claiming completion.

The selected scope is these two operational incidents, their presenter-operated fixes, and recovered/stale-alert interpretation. Data corruption, general chaos tooling, and new infrastructure are not additional requirements. Set rehearsal waits using observed request, policy and alarm timing.
