# Failure Controller

Use the hosted controller to start an Inventory incident, watch the requests and the agent's investigation, and try a remedy. The controller can switch Inventory versions to deny or restore access, generate a surge of catalog reads, raise the capacity limit, or restore the release settings. You can reopen the dashboard in another browser to see the same run or stop its traffic.

To preview the sign-in screen locally, start Vite. To use the controls, open the hosted `FriendlySiteUrl` and sign in with the operator credential. That hostname serves both the dashboard and its `/api/*` routes. The local Vite server has no API proxy.

For command inputs, request limits and interruption handling, see [controller behavior](failure-controller-behavior.md). The [incident scenarios](../demo-scenarios.md) describe the denial, overload and recovered-alarm cases. Use the [demo cue sheet](../demo-script.md) to run them on stage and the [operations agent guide](operations-agent.md) to follow an alarm into the investigation.

## Selected incidents and fixes

Start both incidents on a healthy release. The presenter introduces the failure by changing the Inventory alias or by sending traffic.

| Incident | How the controller causes it | Configuration control |
| --- | --- | --- |
| Inventory capacity overload | Start a finite surge of ordinary authenticated catalog reads against a positive Inventory cap that supports baseline demand. Include sparse checkout probes. Activation increases demand without changing code or lowering the limit. | Increase Inventory reserved concurrency. |
| Inventory access denied | Select the prepared denied Inventory version through the single-target `live` alias. Its static execution role has logging/read access plus a permanent `dynamodb:GetItem` Deny on the exact Inventory table. | Select the healthy role-backed Inventory version at the current memory. |

## Configuration actions

Inventory starts with 16 reserved concurrent executions. Checkout is unreserved. In **Increase Inventory capacity**, the initial target is 32 and the allowed range is 16 through 64. A value equal to the current cap returns `no_change`. A lower value is rejected.

The worker checks available account capacity and reads the new setting back after applying the increase. To see whether it helped checkout, repeat the traffic separately. The controller never requests a quota increase.

The presenter chooses which setting to change, even when the agent has supplied a recommendation. The controller can run these commands without an agent report.

**Select memory** switches the Inventory `live` alias to a qualified version with the requested memory. Both versions run the same code with the same access permissions. The worker records the original alias revision, guards the update against concurrent changes, then reads back the version and memory. See [how Inventory versions are selected](failure-controller-behavior.md#increase-function-memory).

The memory command targets Inventory. Use the supported-memory dropdown or the authenticated `PUT /api/actions/<action UUID>` interface:

```json
{"kind":"increase_memory","function":"inventory","memoryMb":512}
```

Choose a size from the current release manifest. Selecting the active size makes no change. The controller rejects a lower size, an unsupported function or value, a stale release, or an incompatible version. Reusing the same UUID and input returns the original result. If acknowledgement is lost, the worker reads the alias again. A change it cannot confirm stays unknown.

Increasing memory leaves a denied version denied. **Restore Inventory access** selects the healthy version at that same memory. The first readiness check for a release requires its original healthy configuration. Later checks accept a supported higher-memory healthy version and verify checkout with a new order and stock read.

Use the authenticated `PUT /api/actions/<action UUID>` interface for the capacity shortcut:

```json
{"kind":"increase_capacity","function":"inventory","reservedConcurrency":32}
```

The capacity command requires a positive Inventory reservation. Before increasing it, the worker verifies the release, current cap and available unreserved capacity. It preserves AWS's 100-unit unreserved floor and rejects a drifted cap, an old release or unsettled work. A confirmed increase updates the current cap in the dashboard. The release baseline for **Recover** stays at 16.

If AWS loses the acknowledgement but the readback matches, the action records that AWS applied the change and notes the missing acknowledgement. A mismatch fails verification. If the readback itself is unavailable, the outcome stays unknown. The worker does not retry the capacity write automatically.

The agent can read logs, metrics and configuration and recommend a change. Only the presenter can apply it through the controller.

Each shortcut reports `applied`, `no_change`, `failed`, or `unknown` for the selected setting. Generate a fresh request to see its effect on checkout. For a full return to baseline, use **Recover**.

### Select the prepared agent publication

In **Incident**, choose `faulty` or `repaired` under **Next alarm**. Before applying the selection, check that the app baseline is healthy, controller work has settled, all checkout attempts are resolved, and the latest alarm read shows `OK`. Submit a new action UUID with the candidate label.

```json
{"kind":"select_agent","candidateId":"repaired"}
```

The worker makes a strongly consistent read of the candidate's `AGENT_PUBLICATION#faulty` or `AGENT_PUBLICATION#repaired` row. It checks that the named endpoint is `READY` on the publisher's numbered Runtime version and verifies its code and configuration. It then writes `AGENT_SELECTION`. The dashboard shows the candidate, endpoint, Runtime version, source commit, package digest, and the record of reference setup or repaired qualification. Selecting the identical publication again makes no change. A newer publication under the same label must pass the checks again.

The two controller roles and their permissions boundaries allow reads of the faulty reference configuration and repaired candidate configurations. For repaired packages, the grant is limited to `runtime-configuration.json` below `agent-evaluation/phase20/` in the evidence bucket. The package directory matches 64 IAM `?` wildcards. Each matches one character, which can include a slash or a non-hex character. The controller therefore checks the full key, digest, publisher row and numbered Runtime before using the object. The roles cannot list or write these objects, invoke the agent, or repin an endpoint through this grant.

The selection takes effect on the next genuine alarm. Choosing it does not invoke the Runtime, change an endpoint, or generate app traffic. On a failed refresh, the dashboard shows the last verified selection and its timestamp as stale or unavailable. It never silently routes to a default endpoint. Another signed-in browser reads the same selection and investigation records.

## Recover the current release

Pause any other browser or manual checkout, confirm that the writers are quiet, then choose **Recover**. The controller stops both traffic producers and lets in-flight requests settle. It restores the original healthy Inventory version, memory and cap of 16 for the current app release. Checkout stays unreserved and traffic stays stopped. Orders, stock version, request history and investigations survive recovery.

The authenticated command uses a new action UUID:

```json
{"kind":"recover","confirmQuiet":true}
```

After restoring configuration, Recover reads the catalog twice, places a quantity-one order, looks up its receipt and checks that stock fell by one for the same `productVersion`. Each verification action has a request limit and deadline. If verification runs out of time, the dashboard can show “configuration restored” with business verification still incomplete.

For an ambiguous checkout, the controller reads order status a bounded number of times without resubmitting it. An absent order alone cannot rule out a write that is still settling.

Readiness records the release, package and settings it verified. A new release starts with Inventory at 16. On the same release, Readiness can accept a higher cap set and confirmed by the controller. Recover still restores 16. An unexplained increase, unknown alias, changed code, role or policy, or missing baseline blocks recovery. After a successful deployment, run Readiness to establish the new baseline in the current session and keep the earlier incident history.

Recover saves the observed configuration before changing it. If that read fails, the dashboard can ask for separate confirmation to continue (`recoverWithoutEvidence:true`). The record shows the missing evidence. All target checks and checkout verification still apply. Reusing the same UUID returns the recorded result, while changing its confirmation conflicts with the original input. After an uncertain AWS acknowledgement the controller checks the setting before taking further action.

## Presenter experience

Sign in and open **Incident**. Check readiness and confirm which publication under **Next alarm** will receive the alarm. Start one incident, inspect the failures and investigation, then try a remedy. After the change, generate or repeat traffic to observe its effect. **Recover** returns the release to baseline. **Reset demo**, under **History**, starts a new session and replaces the business data.

To compare capacity, start with healthy ordinary traffic and Inventory at 16. Run **Start surge**, stop and drain the workload, raise Inventory to 32, then choose **Repeat same profile**. After the comparison, Recover returns the cap to 16.

| Version 4 surge setting | Requested load |
| --- | --- |
| Catalog reads | One wave of 30 GETs every 1,000 ms for 15 seconds, up to 450 attempts and 30 in flight |
| Launch allowance | 300 ms per wave |
| Checkout probes | At most 15 quantity-one checkouts, on one-second ticks with one slot |
| Request timeout | 7 seconds |

A fresh action UUID starts a new workload. Reusing the same UUID and input returns the saved result. Reusing it with different input is rejected. Runs using versions 1-3 are still readable. Version 3 allowed 150 ms per wave. Only a version 4 action can be repeated with **Repeat same profile**. Repeating keeps the confirmed cap, uses a new UUID and sends the same saved workload once.

Compare the actual starts, wave timing, skipped requests, per-second groups, arrivals, request outcomes and native metrics in the two measured windows. Check upstream capacity and inspect order and stock effects. A quiet minute after **Stop traffic** tells you little about how the service handles peak demand. For the denial case, make fresh ordinary requests after restoring the alias. Leave the healthy version selected.

Open **Workload details** for the requested profile. For measured results, open **Run details**, **Checkout outcomes**, **Catalog snapshot**, and **Native CloudWatch metrics**. **Capacity comparison** shows the two caps, production durations, actual starts and whether both snapshots are complete. Use **Comparison checks** before drawing a conclusion about the increased cap.

**Stop traffic** prevents new submissions. Watch already submitted requests until they settle.

### Observation views

The action strip stays visible across tabs. Open a panel's evidence to see the source, observation time, query window and any read error.

| View | Purpose | Evidence boundary |
| --- | --- | --- |
| **Incident** - **Inventory** | Access state, **Activate Inventory denial**, **Restore Inventory access**, **Select memory**, **Check readiness**, **Recover**, and expandable **Inventory evidence** | Configuration readback is not proof of business recovery; fresh requests remain separate |
| **Incident** - **Store API alarm** | Actual alarm state, **Current investigation** or **Last investigation**, and expandable **Alarm evidence** | Alarm state and endpoint readiness do not prove that an investigation ran; a complete `unknown` assessment is not an overdue run |
| **Incident** - **Next alarm** | The **Agent** dropdown, **Apply agent**, and expandable **Publication identity** for the selected tuple | Selection verifies and stores routing metadata; it does not publish, repin, invoke, or qualify an agent |
| **Traffic** - **Inventory surge** | **Workload details**, latest and prior run records, **Catalog snapshot**, **Checkout outcomes**, and **Capacity comparison** with **Comparison checks** | Requested rate is not measured demand. Cohort completions belong to starts in that cohort, and samples do not determine totals |
| **Traffic** - **Inventory capacity** | Current cap, target input, **Increase Inventory capacity**, and **Capacity evidence** | The shortcut changes configuration only; it does not send requests or establish recovery |
| **Traffic** - **Native CloudWatch metrics** | Fixed native Lambda/API Gateway and account-concurrency series, with refresh/freshness state | Fixed 60-second periods/window. Empty or partial series remain unknown, and missing child logs do not establish health |
| **History** - **Reset business data** | **Reset demo**, destructive confirmations, current/previous or archived run links, receipts, and unresolved attempts | Reset is destructive and separate from Recover; archived runs are read-only and unresolved writes remain unknown |
| **History** - **Investigations** | Durable runs, reports, source citations, uncertainty, release provenance, trace, and capture reference | Run discovery is separate from the current alarm read; unavailable and no matching run are distinct |

The [Store API alarm](application.md#application-alarm) watches the stage-level HTTP API 5xx sum. One error in one 60-second period can trigger it. Missing data is treated as `notBreaching`. Either incident can cause a 502, including on a catalog read. A quiet service can return to OK while still broken, and an old error can keep the alarm active after a successful checkout.

For a traffic action, `GET /api/actions/{UUID}/metrics` makes one bounded CloudWatch query over the UTC minute-rounded window from producer start to settlement. It reads these series:

| Resource | Statistic |
| --- | --- |
| Inventory and Checkout Lambda | Sum of Invocations, Errors and Throttles. Maximum ConcurrentExecutions. |
| HTTP API Gateway | Sum of Count, 4xx and 5xx. |
| AWS account | Maximum ConcurrentExecutions. |

A queued action returns pending before calling CloudWatch. The API rejects caller-supplied resources, windows and queries. Empty series stay empty, and partial coverage is labeled. Use the catalog and checkout records to establish actual demand and outcomes.

### Presentation layout

The dashboard keeps action progress and **Stop traffic** in view across all three tabs. **Incident** groups the readiness check and incident controls. **Traffic** groups **Start healthy traffic**, **Start surge**, **Repeat same profile**, and **Increase Inventory capacity**. **History** contains **Reset demo** and earlier investigations and runs. Configuration and individual receipts expand below the main controls so the primary actions stay readable without horizontal scrolling.

### Refresh and alarm-triggered investigation

The dashboard polls `/api/alarm` and `/api/investigations` independently every five seconds without overlapping reads or moving keyboard focus. If a read fails, it keeps the last good observation and its timestamp. After two intervals it marks the investigation data stale.

The authenticated investigations route reads the agent's DynamoDB table. It defaults to the configured alarm and returns up to 20 recent results. Specify the configured `alarmArn` and the originating ALARM `transitionAt` to look up one event. The same key finds the run after the alarm returns to OK. A poll neither invokes the agent nor queries CloudWatch on this route.

The view shows the alarm transition time, run time and result time. A matched run can be running, overdue/incomplete, complete or failed. A complete report can have an `unknown` assessment. A missing match, a stale read and an unavailable read each have their own display. Open the run for its session, candidate, evidence, uncertainty, source capture and trace. Earlier runs and replays keep their own labels.

If a stored complete run contains an invalid report, the UI shows **Report rejected**. It preserves the raw report, event and run IDs, trace and capture. Other investigation history stays available. Only a genuine alarm transition triggers the live agent.

### Cloud hosting

A controller-owned HTTP API and Lambda serve the React dashboard and authenticated controls from the same HTTPS origin. The operator signs in with a separate bearer held in page memory. The background worker uses the checkout credential from AWS Secrets Manager to make normal app requests. The dashboard reads durable agent runs from the agent stack's table and reports endpoint and alarm-binding readiness without invoking the agent. It works from a clean browser with the operator credential.

The worker owns accepted finite work. Browser refresh or closure leaves it running within its original bounds. The controller stores the session/run and action records in DynamoDB. Check readiness before starting normal traffic. Use Stop to close new submissions and watch accepted requests drain. When an action outlives its deadline, the dashboard shows it as incomplete. Explicit discard retains actual attempt/outcome records and unresolved orders.

Schedule deployments outside demo runs and wait for each dependent app, agent, and controller release to settle before checking readiness again. A new app release makes an old baseline stale. Preserve orders, session/run history, actual request outcomes, and observation history across deployments. [Deployment and operator access](../deployment.md#first-controller-release-and-operator-access)

## Responsibilities and record

| Action | Controller responsibility | Evidence to retain |
| --- | --- | --- |
| Establish baseline | Bind known expected healthy versions and settings, including Inventory cap 16 and unreserved Checkout, to a trusted successful deployment generation; exercise normal reads and a checkout | Target, generation/artifact identity, original/current cap observations, actual settings/revisions, successful requests, and the post-checkout stock/order baseline |
| Cause capacity overload | Apply the selected finite demand profile without changing the Inventory cap | Intended profile, actual demand, invocation errors/throttles, and affected request windows |
| Deny inventory access | Select only the prepared denied role-backed Inventory version through the `live` alias | Prior alias/version/role/policy state, requested target, actual revision/readback, and independently observed denied reads |
| Apply a configuration action | Increase Inventory's reserved concurrency, increase Inventory memory, or switch the Inventory `live` alias to the healthy version, without generating traffic | Operator choice, before/after values and version/alias/role/policy state where applicable, and configuration result/readback |
| Repeat traffic and observe | Explicitly run another bounded workload at the current configuration | Actual demand, phase windows, and request outcomes, separate from the preceding action result |
| Recover application | Stop traffic, confirm the baseline generation is still current, restore expected caps and healthy role-backed alias versions at baseline memory, settle work, then verify fresh behavior | Confirmed restoration and fresh evidence, retaining prior effects and results |
| Reset demo | Require quiet, destructive, and checkout-closed confirmations; stop/drain work, reconcile the current trusted release, archive the old run, replace business data under a fresh productVersion, and verify a new run | Previous-run link and preserved history; reset progress and the new baseline including the verification order |

The authenticated `PUT /api/actions/{UUID}` Reset input requires all three confirmations and accepts no caller-selected table, SKU, seed, or product version:

```json
{"kind":"reset","confirmQuiet":true,"confirmReset":true,"confirmCheckoutClosed":true}
```

The [private run and action records](failure-controller-behavior.md#backend-boundary-and-private-records) keep accepted inputs and observed results. Record an absent policy or concurrency setting as absent. A zero value means something different. Before restoring an alias, check its current revision, the allowlisted version and its role and policy. An unexpected external change is a conflict.

**Recover** restores the baseline saved for the same successful release. **Reset demo** can replace a stale or missing baseline with the settings from the current successful release. A failed or partial deployment, or an unknown current configuration, blocks Reset. Keep earlier request outcomes and agent history through deployments.

Before replacing business data, Reset archives the old run and makes the action UUID the new run ID. It links to the previous run. `GET /api/runs/{id}` can open either the current run or a read-only archive. The new run becomes usable only after verification.

If Reset stops partway through, let the worker finish and wait for the drain window to end. Discard the incomplete action if necessary. Start a newly confirmed Reset with a new UUID and `productVersion`. The archived run keeps any unresolved checkout marked unknown. That historical checkout alone does not block the new Reset.

The agent can inspect observed limits, policy statements, version numbers, errors and management history. Keep scenario labels, expected answers, controller baseline mappings, credentials, authentication configuration and raw SDK dumps out of its inputs. Traffic uses the [normal authenticated application API](application.md).

## Verification and limits

For denial, read back the alias switch, then check whether a fresh Inventory read failed or succeeded. Match the alarm and agent run to that transition. A configuration change alone cannot tell you whether customers can place orders.

For overload, check the Lambda throttle reason before attributing it to busy execution slots. Use Gateway, Checkout and client-side evidence to rule out upstream rejection, queueing or database contention. Compare service at the original and increased caps under the same delivered demand. After traffic drains, reconcile order and stock changes. Full Recover then returns Inventory to 16 and leaves Checkout unreserved.

After Reset, the new baseline includes its verification order and the matching stock decrement. Old checkout payloads carry the wrong `productVersion`. When rehearsing, time actual requests and alarm transitions to decide when to switch to a recorded result.
