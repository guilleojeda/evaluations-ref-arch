# Deployment

The checkout app, failure controller, and operations agent have separate AWS CDK stacks in one development account. Pull requests and `main` run credential-free checks. The long-lived `demo-deploy` branch is the only branch that can publish checked component releases to AWS through the corresponding stack job.

## Local development

Use the Node.js version in [`.nvmrc`](../.nvmrc) and the Python and uv versions in [`agent/pyproject.toml`](../agent/pyproject.toml). From the repository root, install the locked dependencies and build either web interface without AWS credentials.

```sh
npm ci
uv sync --project agent --locked
npm run build --workspace app
npm run build --workspace controller
```

The two builds write static assets under `.artifacts/app/web/` and `.artifacts/controller/web/`.

- **Storefront.** For a working local checkout, set `APP_API_URL` to the direct API origin from the deployed app stack, then run `npm run dev --workspace app`. Vite proxies the business routes to that origin. Enter the presenter credential in the local storefront.
- **Controller.** Run `npm run dev --workspace controller` to preview the sign-in page. Its Vite server serves frontend files only. Sign-in, state, and commands require the hosted controller, where the page and its authenticated `/api/*` routes share the same origin.
- **Agent.** Run `uv run --project agent --locked python agent/main.py` for the local Runtime entry point. Its `/ping` route supports a health check. Follow the [agent instructions](../agent/README.md#local-health-and-invalid-event-smoke) for the invalid-event and package checks.

For a deployment outside the talk account, start with the [own-account adaptation checklist](../infrastructure/bootstrap/README.md#own-account-adaptation-checklist).

Build and synthesize the component you are changing.

```sh
npm run check -- app
npm run check -- controller
npm run check -- agent
```

The checks write browser builds and CDK assemblies under `.artifacts/<component>/`. The agent assembly publishes `.artifacts/agent/runtime.zip` and `.artifacts/agent/alarm-adapter.zip` as CDK file assets. Both packages use locked ARM64 Linux dependencies. Check the three assemblies, deployment routing, and local checkout cases with `node --test tests/phase0*.mjs tests/phase1-*.test.mjs tests/phase2-controller-*.test.mjs tests/phase3-inventory-denial-*.test.mjs` after building. The deployed API suite is opt-in and consumes stock from an explicitly prepared verification fixture.

## GitHub Actions

Use [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) for pull requests, `main`, and `demo-deploy`. Pull requests and `main` run affected checks without AWS credentials. `demo-deploy` runs those checks and can publish the affected stacks. Changes in shared build or infrastructure inputs select all three stacks. Documentation-only changes skip AWS jobs.

| Component | AWS stack |
| --- | --- |
| App | `IncidentTriageDemoApp` |
| Failure controller | `IncidentTriageDemoController` |
| Agent | `IncidentTriageDemoAgent` |

Deploy jobs serialize within each stack. Every job uses the checked CDK assembly and inspects its prepared CloudFormation change set for table removal or possible replacement before executing that exact change set.

- **App.** The job compares the candidate with the successful app stack revision, skips superseded or irrelevant candidates, and publishes immutable hashed assets before the revalidatable HTML.
- **Controller.** The job serves the checked web build in the HTTP Lambda artifact, deploys the separate worker, and checks the controller run table for removal or possible replacement.
- **Agent.** The job publishes and checks the Runtime and adapter ZIPs, inspects the agent-stack change set, and deploys its independent Runtime and retained run table. The ordinary release checks Runtime configuration and adapter readback without invoking the agent or sending application traffic.

After the one-time ownership transfer, the named `faulty` endpoint and its published tuple are maintained only by the fixed reference operation. Ordinary agent releases carry that tuple forward and cannot create, repin, or delete the endpoint.

Relevant pushes to `demo-deploy` deploy affected stacks automatically. Pushes to `main` remain check-only. The app, controller, and agent stacks remain independent. The presenter sequences dependent releases outside a live run. For an operator retry or a binding-only update at the same source revision, `workflow_dispatch` requires one component selection and deploys only that stack from `demo-deploy`. Run separate dispatches in dependency order:

```sh
gh workflow run deploy.yml --repo guilleojeda/evaluations-ref-arch --ref demo-deploy -f component=agent
gh workflow run deploy.yml --repo guilleojeda/evaluations-ref-arch --ref demo-deploy -f component=app
gh workflow run deploy.yml --repo guilleojeda/evaluations-ref-arch --ref demo-deploy -f component=controller
```

For the first alarm-path release, leave the app alarm adapter and controller agent variables empty while the checked reference setup verifies the endpoint and the agent stack outputs.

Then set `APP_ALARM_ADAPTER_ARN` to the stack's `AlarmAdapterArn` and dispatch `app`. Only after that succeeds, set `CONTROLLER_AGENT_RUNTIME_ARN`, `CONTROLLER_AGENT_ENDPOINT_ARN`, and `CONTROLLER_AGENT_ALARM_ADAPTER_ARN` to the verified agent outputs and dispatch `controller`. Empty or unset variables preserve an existing binding on updates. Fresh stacks start unconfigured.

Verify each run and its stack outputs before dispatching the dependent component. Record the checked source revision and final Runtime version/artifact identity with each release. Finish deployments before a demo run. If a deployment overlaps a run, abandon that run and verify the current release and settings before starting another.

### Restore the reviewed faulty reference

Use the **reference-setup** operation on `demo-deploy` to restore or verify the opening agent. Its only publication target is the named `faulty` endpoint. The [fixed descriptor](../scripts/faulty-reference.json) identifies the reviewed source, prompt, model, configuration and versioned S3 ZIP that passed the native ARM64 smoke test.

Before first use, stop controller traffic, confirm no active action or investigation, and verify the checkout alarm is OK. Inspect the legacy binding, rollback ZIP and native change set for the one-time CloudFormation ownership transfer. The change set must preserve the Runtime and target the recorded physical endpoint. Once the workflow observes the old endpoint's removal, it restores from the archive.

```sh
gh workflow run deploy.yml --repo guilleojeda/evaluations-ref-arch \
  --ref demo-deploy -f component=reference-setup
gh run list --repo guilleojeda/evaluations-ref-arch --workflow deploy.yml \
  --branch demo-deploy --event workflow_dispatch --limit 1 \
  --json databaseId,headSha,status,conclusion
gh run watch <run-id> --repo guilleojeda/evaluations-ref-arch --exit-status
```

The workflow checks the archive bytes and full configuration, reuses a matching numbered Runtime version or creates one, then checks the endpoint's live version, the alarm adapter's binding and the strongly read `AGENT_PUBLICATION#faulty` record. A healthy repeat reports the same tuple. Ordinary agent deployments preserve the binding. Restoration records a reference identity and requires no model invocation.

If a dispatch stops partway, inspect its log, the native endpoint, adapter and publication record. Repeat the fixed dispatch to reconcile an incomplete reference. Use the stack's `RuntimeId` to inspect `GetAgentRuntimeEndpoint` for `faulty`. Compare its numbered version with `AGENT_RUNTIME_VERSION` on `IncidentTriageDemoAlarmAdapter` and the controller record:

```sh
aws dynamodb get-item --table-name IncidentTriageDemoControllerRun \
  --key '{"pk":{"S":"AGENT_PUBLICATION#faulty"}}' --consistent-read \
  --profile reinvent-2026-talk --region us-east-1
```

To verify the complete alarm path, run Readiness in the hosted controller, induce Inventory denial, and open the investigation for the new 5xx alarm transition. Capture its report, trace and source evidence before Recover. Confirm the restored healthy Inventory version, 256 MB, reserved concurrency 16, a fresh successful checkout and native alarm OK.

## AWS access and initial setup

The values in this runbook describe the author's talk environment. They are not portable defaults. Before using the deployment path in another account or repository, complete the [own-account adaptation checklist](../infrastructure/bootstrap/README.md#own-account-adaptation-checklist) and stop if any item is still a talk-specific value.

Use AWS CLI v2 with the `reinvent-2026-talk` profile, account `027224425948`, and Region `us-east-1`. For an IAM Identity Center profile, renew an expired session with `aws sso login --profile reinvent-2026-talk`. Check the caller before setup. Each capacity action checks fresh regional `GetAccountSettings` data and available unreserved headroom. A quota value alone does not establish available headroom.

```sh
aws sts get-caller-identity --profile reinvent-2026-talk --region us-east-1
```

GitHub receives short-lived credentials through OIDC. The deployment role trusts the STS audience and immutable identity of `guilleojeda/evaluations-ref-arch`, and pins the caller to `.github/workflows/deploy.yml` on `refs/heads/demo-deploy`. Pull requests, `main`, tags, and other branches cannot assume that publishing role. It assumes the CDK deployment and file-publishing roles. Bootstrap administration, CloudFormation execution, and component runtime permissions use separate roles. [GitHub OIDC for AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws) - [CDK bootstrapping](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-env.html)

Follow the [AWS bootstrap commands](../infrastructure/bootstrap/README.md) to provision the scoped execution policy, dedicated `evaltalk` toolkit, and GitHub IAM stack in that order. Before the first agent release, an administrator must also [check or create the exact Runtime Identity service-linked role](../infrastructure/bootstrap/README.md#one-time-agentcore-runtime-identity-account-prerequisite). Preserve it if it already exists. This is one-time account setup, separate from CI and agent execution authority. The dedicated deploy role can prepare and execute change sets for the named app, controller, and agent stacks. CloudFormation uses separate scoped execution policies for their resources. Use the verified administrator for updates to the bootstrap IAM stacks. Keep the deploy guard and CloudFormation execution grants scoped to reviewed feature resources.

Before setting the GitHub subject template, inspect existing Actions runs and OIDC consumers for the repository. Preserve immutable identity. A repository admin can set the template with GitHub CLI.

```sh
gh api --method PUT repos/guilleojeda/evaluations-ref-arch/actions/oidc/customization/sub \
  -H 'X-GitHub-Api-Version: 2026-03-10' --input - <<'JSON'
{"use_default":false,"include_claim_keys":["repo","workflow_ref"],"use_immutable_subject":true}
JSON
gh api repos/guilleojeda/evaluations-ref-arch/actions/oidc/customization/sub
```

## Talk hostnames

Use `https://store.riv2026.guilleojeda.com` for checkout and `https://controller.riv2026.guilleojeda.com` for the operator dashboard and agent reports. The parent DNS account delegates `riv2026.guilleojeda.com` to a public Route 53 zone in the talk account. Keep that zone and its parent NS record across app releases. Each component stack owns its certificate, its DNS records, and the binding to its serving endpoint.

Both stacks expose `FriendlySiteUrl` for the presenter and `SiteUrl` for the original AWS address. The controller maps the root of its hostname to its HTTP API. The storefront continues to send `/api/*` through CloudFront. Internal traffic and API attribution use the app’s existing `ApiUrl`. If switching storefront addresses during a demo, reconcile any pending checkout on the original address first. Browsers keep the saved checkout attempt per origin.

## First app release and presenter access

Before the first app release, generate a high-entropy presenter bearer in private storage. Supply only its SHA-256 digest to the repository's `APP_PRESENTER_DIGEST` Actions secret. The app stack stores the digest as a required CloudFormation `NoEcho` parameter. Later releases use the stored value. Remove the repository secret after verifying the first successful release and sign-in with `gh secret delete APP_PRESENTER_DIGEST --repo guilleojeda/evaluations-ref-arch`.

For example, the following creates a private temporary file for the bearer. Keep the bearer in a secure location available to the presenter before deleting that file.

```sh
umask 077
presenter_file=$(mktemp)
openssl rand -hex 32 > "$presenter_file"
tr -d '\n' < "$presenter_file" | openssl dgst -sha256 -r | cut -d ' ' -f 1 \
  | gh secret set APP_PRESENTER_DIGEST --repo guilleojeda/evaluations-ref-arch
```

After the deployment job succeeds, read the app stack outputs and seed the table with the verified AWS CLI v2 profile.

```sh
aws cloudformation describe-stacks --stack-name IncidentTriageDemoApp \
  --profile reinvent-2026-talk --region us-east-1 --query 'Stacks[0].Outputs'
node scripts/seed-app-inventory.mjs
```

The seed inserts the demo SKU with 1,000 units only when it is absent. Reruns report the existing version and quantity. Open `FriendlySiteUrl` from the app outputs, enter the bearer, and verify one normal order and its stock decrement. The direct API origin is available for the local Vite proxy. The outputs also identify the source revision, tables, function and alias targets, and logs used to check the release. Inventory release preparation publishes healthy and denied variants at each configured supported memory from the checked artifact, restores and verifies the original unpublished `$LATEST` settings, then conditionally writes the immutable version manifest with explicit AES256 server-side encryption to the existing private CDK asset bucket under `releases/app/<SourceRevision>/inventory-variants.json`. No new service or bucket is introduced. The outputs identify that manifest location and the denied execution role. The controller uses them for allowlist validation and alias-only changes.

Reloading the page requires the bearer again. If an order response is lost, use the saved attempt to check status or retry the original submission. A missing status may precede a commit. Check that the page shows a confirmed receipt before placing another order.

## Inventory memory variants

The app release prepares healthy and denied Inventory variants at 256 and 512 MB. The schema-1 manifest maps each `(memoryMb, access)` pair to its numeric version and fixed role, with the checked code digest and source revision. Preparation leaves `live` at the healthy baseline and verifies the original unpublished role/memory/configuration is restored. The immutable revision-scoped object is published only after the complete set validates. A mismatched existing object is rejected. The checked deployment script supplies the supported values to the preparer CLI, including its recognized-staging cleanup path. Adding a size requires a checked release/configuration update.

Use the controller's Inventory memory action for an increase or equal-size no-op. It only switches the allowed alias target and preserves access state, code and other settings. To prove denial persists, send a separate fresh request after higher-memory readback. Restore access chooses healthy at that same memory. A separate bounded readiness action proves business recovery. Do not apply `$LATEST` changes or publish versions from the controller.

## First controller release and operator access

Use the administrator to provision the existing app bearer and the SHA-256 hex digest of a separate high-entropy operator bearer in the two named Secrets Manager secrets. Use the names `incident-triage-demo/controller/app-bearer` and `incident-triage-demo/controller/operator-digest`. Store each as a single text value. Supply their exact ARNs as the `CONTROLLER_APP_SECRET_ARN` and `CONTROLLER_OPERATOR_SECRET_ARN` repository variables for the first release. The controller stack retains these inputs on updates. Only the worker reads the app bearer, and only the HTTP Lambda reads the operator digest. Keep the raw operator bearer in the established presenter-only SSM SecureString recovery copy `/incident-triage-demo/presenter/controller-operator-bearer`, reachable from a replacement device. Do not create another vault or change the app/controller ARN boundaries.

After deployment, open `FriendlySiteUrl` from the `IncidentTriageDemoController` stack outputs and sign in with the operator bearer. Pause other app checkout writers, then check readiness. A successful readiness action verifies its bounded request sequence and stock decrement. The dashboard displays the baseline and actual request counts and outcomes. Each action has its own finite bounds. Start normal traffic explicitly and use Stop to close submissions and drain work. A second browser can sign in to the same session/run. Inspect and discard an expired action only after it is shown as incomplete. Its recorded attempts and unresolved checkout IDs remain available.

The controller has no cumulative checkout, catalog, or status-read quotas and no separate generator, verification, or manual pools. Each individual traffic or verification action remains bounded by its configured duration, attempt count, pacing, in-flight limit, timeout, and deadline. Normal traffic uses the 15-second profile with 1 Hz catalog and checkout ticks, one catalog request and two checkout requests in flight, and no catch-up on skipped ticks. The access-denied activation uses up to six paced catalog probes and at most one verification checkout after a typed denial. Readiness uses its own bounded request sequence. Record actual requests and outcomes. Deduplicate repeated command IDs and drain accepted work on Stop.

## Release and bind the initial agent path

The first agent release uses the currently deployed app API ID as an input to the agent stack. The app alarm remains unbound while the agent stack is released, and the controller remains unconfigured for agent readiness. Use the stack outputs and checked GitHub assembly. Do not invoke the Runtime as a smoke test. In the current layout, this ordinary release creates or updates the Runtime and adapter but does not own the publisher-owned `faulty` or `repaired` endpoint or publish a candidate.

After the `IncidentTriageDemoAgent` release succeeds, verify its `SourceRevision`, `RuntimeArn`, `FaultyEndpointArn`, `AlarmAdapterArn`, and `RuntimeArtifactSha256` outputs against the checked release. The `CloudFormationRuntimeVersion` output is the initial CloudFormation Runtime version. The publisher-owned `faulty` version is read back separately by the fixed reference operation. The ordinary release checks native `requireMMDSV2`, Runtime configuration and adapter code/readback. It must carry a publisher-owned endpoint tuple forward rather than selecting `DEFAULT` or a latest version. This is release evidence only. No alarm or investigation is generated. To establish or recover the `faulty` reference, use the fixed [reference maintenance operation](#restore-the-reviewed-faulty-reference), not this ordinary route.

Read the finalized agent stack outputs into local shell variables, then bind the app alarm by setting the repository variable and deploying the app component:

```sh
export AGENT_ALARM_ADAPTER_ARN="$(aws cloudformation describe-stacks --stack-name IncidentTriageDemoAgent --profile reinvent-2026-talk --region us-east-1 --query "Stacks[0].Outputs[?OutputKey=='AlarmAdapterArn'].OutputValue | [0]" --output text)"
gh variable set APP_ALARM_ADAPTER_ARN --repo guilleojeda/evaluations-ref-arch --body "$AGENT_ALARM_ADAPTER_ARN"
gh workflow run deploy.yml --repo guilleojeda/evaluations-ref-arch --ref demo-deploy -f component=app
```

Set `AGENT_ALARM_ADAPTER_ARN` to the exact `AlarmAdapterArn` output from the finalized agent stack. After the app release succeeds, read back the alarm's single `AlarmActions` target and confirm it equals that ARN.

Configure controller readiness and investigation discovery from the same finalized agent outputs, then deploy only the controller component:

```sh
export AGENT_RUNTIME_ARN="$(aws cloudformation describe-stacks --stack-name IncidentTriageDemoAgent --profile reinvent-2026-talk --region us-east-1 --query "Stacks[0].Outputs[?OutputKey=='RuntimeArn'].OutputValue | [0]" --output text)"
export AGENT_FAULTY_ENDPOINT_ARN="$(aws cloudformation describe-stacks --stack-name IncidentTriageDemoAgent --profile reinvent-2026-talk --region us-east-1 --query "Stacks[0].Outputs[?OutputKey=='FaultyEndpointArn'].OutputValue | [0]" --output text)"
export AGENT_ALARM_ADAPTER_ARN="$(aws cloudformation describe-stacks --stack-name IncidentTriageDemoAgent --profile reinvent-2026-talk --region us-east-1 --query "Stacks[0].Outputs[?OutputKey=='AlarmAdapterArn'].OutputValue | [0]" --output text)"
gh variable set CONTROLLER_AGENT_RUNTIME_ARN --repo guilleojeda/evaluations-ref-arch --body "$AGENT_RUNTIME_ARN"
gh variable set CONTROLLER_AGENT_ENDPOINT_ARN --repo guilleojeda/evaluations-ref-arch --body "$AGENT_FAULTY_ENDPOINT_ARN"
gh variable set CONTROLLER_AGENT_ALARM_ADAPTER_ARN --repo guilleojeda/evaluations-ref-arch --body "$AGENT_ALARM_ADAPTER_ARN"
gh workflow run deploy.yml --repo guilleojeda/evaluations-ref-arch --ref demo-deploy -f component=controller
```

The values are `RuntimeArn`, `FaultyEndpointArn`, and `AlarmAdapterArn` from the agent stack outputs. When the controller release completes, open the dashboard and verify the endpoint is ready and the alarm binding is bound. These checks are read-only control-plane observations. They do not prove an inference occurred. Complete the actual alarm-triggered journey through the controller after readiness.

### Select the next alarm candidate

After Readiness has established a healthy current application generation, stop traffic, settle actions, clear unresolved checkout attempts, and observe the native alarm in `OK`. In the controller's **Next alarm** panel, choose exactly one publisher-owned label, `faulty` or `repaired`, and submit the selection. The browser sends a fresh action UUID and only this command body:

```json
{"kind":"select_agent","candidateId":"repaired"}
```

The controller verifies the selected publication, named endpoint, `READY` state, numbered Runtime version, versioned code/configuration bytes, source/package/model identity, and the applicable reference or qualification identity before writing `AGENT_SELECTION`. It displays that complete tuple and its observation time after strong readback. A repeated tuple is a no-op. A stale, changed, missing, or unavailable tuple fails closed and leaves the prior selection unchanged. Selection sends no application traffic, does not invoke or repin AgentCore, and never falls back to `DEFAULT` or an old environment route. Refresh or a replacement authenticated browser reads the same durable selection. If a refresh fails, the dashboard labels the last successful tuple stale/unavailable and preserves its earlier observation time. It does not reselect automatically. Select the intended candidate again only after the readiness read has recovered.

The controller's HTTP and worker roles retain read-only access to the fixed faulty reference object and to repaired staged configuration objects under the evidence bucket's `agent-evaluation/phase20/` prefix. The repaired path is constrained to a 64-character package-digest directory with IAM `?` wildcards and the exact `runtime-configuration.json` suffix. IAM `?` matches one arbitrary character. It does not validate hexadecimal characters or exclude `/`. The application authenticates the publisher, key, digest, and numbered Runtime. These grants do not add S3 listing/writing or AgentCore invocation/endpoint-repin permissions.

## Captured evidence and Inventory version reads

The Runtime's `lambda:ListVersionsByFunction` grant covers the exact Inventory function. It complements the existing qualified configuration and role reads. Apply the checked [administrator bootstrap policy](../infrastructure/bootstrap/README.md#1-provision-the-scoped-execution-policy) before publishing an agent that uses this grant. Verify the effective Runtime role and its permissions boundary.

Use the [agent capture commands](../agent/README.md#export-and-query-captured-evidence) to save ordinary evidence while the relevant configuration is still observable. Store exports with the demo's private evidence. Query a saved bundle locally with its explicit reference time.

## Capacity surge and native metric reader

Use the `demo-deploy` release workflow for the capacity surge. Configure the existing finite worker Lambda at **1,024 MB**, a 90-second timeout, and zero asynchronous retries to give catalog production room during calibration. This is a controller-side producer setting only. Inventory and Checkout memory, aliases, access, and app code stay fixed across the capacity comparison. Higher producer memory does not prove the requested fetch rate was achieved.

New `inventory_surge` actions use version 4 with these requested bounds:

- 30 catalog GETs every 1,000 ms for 15 seconds, or 30 starts/second on average
- at most 450 attempts and 30 in flight
- a 300 ms bounded launch allowance and a 7-second request timeout
- at most 15 quantity-one checkout probes on one-second ticks, with one in flight and a 7-second timeout

Achieved demand is always measured. Historical v1 requested a smooth 240 catalog starts/second with at most 3,600 attempts and 128 in flight. v2 requested 30 reads every 500 ms, or 60 starts/second on average, with at most 900 attempts and 30 in flight. v3 used the v4 catalog and checkout bounds with a 150 ms launch allowance. Versions 1-3 remain readable in prior action history and are not current same-profile repeats.

Reusing an action UUID with the same input returns the recorded action/result without sending traffic. Conflicting input is rejected. A new action UUID starts a new workload using v4. Checkout inputs are durably recorded before producers co-launch. Missed, full-slot, and checkpoint-overlapping catalog waves are skipped without queueing or catch-up.

Treat v4 as a pressure and latency hypothesis until actual starts, wave cadence, skips, request-arrival timing, and upstream headroom are verified. Use the same exact v4 paired workload for both cap episodes, recheck headroom before each pair, and compare actual delivered demand. Do not raise or lower demand between the 16 and 32 cap episodes to make a result appear comparable. Follow the [controller surge procedure](components/failure-controller.md#presenter-experience) for the operator sequence and comparison evidence.

The authenticated controller HTTP Lambda performs one fixed `GetMetricData` read for Inventory/Checkout Lambda Invocations, Errors, Throttles and ConcurrentExecutions, Gateway Count/4xx/5xx, and account ConcurrentExecutions. Add only region-scoped `cloudwatch:GetMetricData` to its role and administrator-owned boundary. The HTTP handler fixes resources, dimensions, statistics, period and derived action window. It rejects caller query/resource/window overrides and is not a metric proxy. The worker does not need this grant. The route uses one call with a two-second SDK deadline and no pagination or waiting. Sparse empty series remain empty and provider-partial results stay partial.

## Operate the Inventory access incident

1. Stop existing traffic and pause other checkout writers. Use **Check readiness** on the current release. Keep readiness, activation, and post-restore verification as separate actions with their own bounds.
2. Choose **Activate Inventory denial**. Inspect the active alias/version, execution role, exact policy/default document, and checkpoint alongside the catalog and checkout evidence. The alarm card reads CloudWatch independently. Wait for an observed ALARM when collecting a complete incident.
3. Choose **Restore Inventory access**. If the controller cannot save the required configuration and you need to restore service, use the explicit protective confirmation. It still requires the recorded app source revision, alias/version/role/policy state, and current release. The evidence gap remains visible.
4. Once the alias reads as the healthy version at the current memory, wait for an actual fresh catalog success and run **Check readiness**. Confirm the successful order and stock change separately from the alarm. Allow for native metric evaluation delay before observing OK.

Keep the evidence bucket private. Inspect or export the referenced configuration objects using authorized AWS access before teardown. Run planned releases after the healthy alias is restored and traffic has settled.

## Deployment and controller baseline

The presenter schedules releases outside active demo sessions and manually sequences dependent app, agent, and controller changes. Routine releases preserve business data and investigation history.

**Release identity.** The current app release owns Inventory's reserved-concurrency baseline of **16**. Checkout remains unreserved. Keep the app's expected versions, memory, cap, and Inventory role/policy/access-state manifest tied to the release. Treat the app credential generation as part of that release identity. A same-source rotation still requires fresh Readiness before controller traffic resumes.

**Same-generation capacity.** A confirmed Inventory capacity increase updates only the controller's same-generation current-cap observation. It does not change the original cap or release identity. Readiness on that generation accepts the confirmed current cap and performs its normal business verification. First readiness and new-generation adoption require the release cap of 16. They never carry a previous generation's raised cap forward. See the [controller baseline and recovery rules](components/failure-controller.md#recover-the-current-release).

**Recover and Reset.** Recover compares its saved original baseline with the successful stack identity/update time, deployed source revision, immutable versions, manifest and affected live settings before restoring Inventory to 16. Reset follows a separate path. It may reconcile to the trusted expected settings for the current successful app release, including Inventory 16 and unreserved Checkout, even when the old baseline is stale or missing. It preserves archived cap observations as recorded and gives the new run baseline 16 only after verification.

**Drift and provenance.** A failed or partial release, or an unknown current target or configuration, blocks destructive work until reconciled. Agent provenance separately identifies the checked Runtime artifact and final pinned version. Unexpected drift or a newer release requires fresh readiness for actions that depend on the saved baseline.

The deployment workflow leaves incident activation, probes, Recover, and Reset to the presenter. Applying an expected setting through CDK does not establish fresh business behavior. Use the [controller run procedure](components/failure-controller.md#presenter-experience) to verify a new baseline and the [application contract](components/application.md#deployment-development-and-reset) for disposable data setup and reset.

## Rotate presenter credentials

This is a scheduled, app-only release on the trusted `demo-deploy` ref. It rotates two independent presenter credentials while keeping the same secret ARNs, app tables, and controller run. Use the exact ARNs already configured in `CONTROLLER_APP_SECRET_ARN` and `CONTROLLER_OPERATOR_SECRET_ARN`. Their stable names are `incident-triage-demo/controller/app-bearer` and `incident-triage-demo/controller/operator-digest`. Update the existing presenter-only SSM SecureString `/incident-triage-demo/presenter/controller-operator-bearer` with the raw operator bearer before activating its new digest. Handle both raw values only through the private presenter channel.

### Stage and publish

1. Stop and drain traffic, pause other writers, and reconcile any unresolved checkout outcome. Read the account, Region, healthy aliases, Checkout's unreserved setting, Inventory's cap of 16, the app stack's current `PresenterCredentialGeneration`, the current app and operator secret `VersionId`s, the current run/productVersion, and the order, controller-action, agent-run, and source-object identities. If either secret already has an unexpected `AWSPENDING` version, reconcile it before generating another pair. Keep only the nonsecret IDs and verdicts in the evidence record.
2. Generate two independent high-entropy values in private presenter storage: one app bearer and one operator bearer. Write the app value to the existing app-bearer ARN as a new `AWSPENDING` version. Hash the separate operator bearer and write only that digest to the existing operator-digest ARN's `AWSPENDING` version. The operator secret never stores the raw operator bearer. Derive the app digest from the app bearer for the temporary Actions secret in the next step. Record the two pending `VersionId`s and the saved current `VersionId`s by reading the secret labels back. The app pending `VersionId` is the new opaque Checkout credential generation. Enter values through the administrator's private input channel or a mode-600 temporary file that is removed immediately. Never put a bearer, digest, or secret string in a command line, shell history, browser storage, repository, log, screenshot, or evidence object.
3. Set the masked `APP_PRESENTER_DIGEST` Actions secret to the digest derived from the staged app bearer only for this dispatch. From `demo-deploy`, run the checked app workflow with the paired, independent rotation inputs and no controller or agent input:

   ```sh
   gh workflow run deploy.yml --repo guilleojeda/evaluations-ref-arch --ref demo-deploy \
     -f component=app \
     -f rotation_from_generation='<current-PresenterCredentialGeneration>' \
     -f rotation_to_generation='<staged-app-VersionId>'
   ```

   The generation inputs are nonsecret identifiers. Use `initial` for the predecessor if the app stack still reports that generation. Wait for the checked app release to finish before moving either `AWSCURRENT` label. Verify the new numeric Checkout version, one-target `live` alias, exact new generation/digest binding, unchanged business tables, and successful functional checks with the staged app bearer. Keep the worker idle during this interval.

### Promote and recover from interruption

After the app publication succeeds, promote the staged app secret first, then the staged operator digest. Each move must name both the saved current and intended pending version. The administrator's operation is equivalent to `UpdateSecretVersionStage` with `VersionStage=AWSCURRENT`, `MoveToVersionId=<pending>`, and `RemoveFromVersionId=<saved-current>`:

```sh
aws secretsmanager update-secret-version-stage \
  --secret-id "$APP_SECRET_ARN" --version-stage AWSCURRENT \
  --move-to-version-id "$APP_PENDING_VERSION_ID" \
  --remove-from-version-id "$APP_CURRENT_VERSION_ID"
# After updating the private SSM recovery copy and reading its parameter version:
aws secretsmanager update-secret-version-stage \
  --secret-id "$OPERATOR_SECRET_ARN" --version-stage AWSCURRENT \
  --move-to-version-id "$OPERATOR_PENDING_VERSION_ID" \
  --remove-from-version-id "$OPERATOR_CURRENT_VERSION_ID"
```

Run the two commands separately in that order and read the labels back after each move. Never substitute an unverified value for any ID. Before moving the operator digest's label, update the existing SSM SecureString recovery copy at `/incident-triage-demo/presenter/controller-operator-bearer` with the new raw operator bearer through the established administrator path and retain only its parameter version/status in evidence. Never move a label by "whatever is current", delete the old version, or roll the app alias back to an older credential version.

If the app release fails or rolls back before its new alias is active, leave both current labels unchanged and report that terminal outcome before staging again. If the app alias has switched but a label move or browser check is interrupted, keep maintenance paused. Read the actual stack/template, alias target, generation, and both secret label sets first. Continue forward only from the confirmed saved/pending IDs and the observed release outcome. Do not infer success from a lost acknowledgement, retry an unknown label move, or roll a label back. An unexpected generation, version, alias, or digest requires diagnosis before another mutation. Once both intended `AWSCURRENT` labels and the app binding are confirmed, remove the temporary `AWSPENDING` labels and the temporary `APP_PRESENTER_DIGEST` Actions secret.

### Reconnect and adopt the same run

Use a clean replacement browser context. Retrieve the new operator bearer only from the established SSM SecureString recovery copy through the private presenter channel, and retrieve the new app bearer only from the existing app-bearer secret's confirmed `AWSCURRENT` version through the same private channel. At the CloudFront and direct Gateway origins, verify the new app bearer can read the catalog and an existing order status. With an invalid checkout body, verify the old app bearer receives `401 UNAUTHORIZED` on all three routes at both origins. This probe cannot place an order if a guard regresses. Verify the old operator bearer receives `401` on protected controller reads and command entry points. The new controller sign-in must show the same run, prior action/incident history, and enabled controls. Do not capture credentials, authorization headers, digests, or sensitive screenshots. Retain request IDs, statuses, no-store behavior, and the absence of credentials from browser application storage.

Before ordinary traffic, run the controller's new-generation Readiness with writers paused. It must validate the qualified Checkout generation, worker bearer/digest match, healthy aliases and settings, Inventory cap 16, and the bounded catalog/quantity-one checkout/status sequence. A stale pre-rotation baseline must block ordinary traffic without business sends. Readiness adopts the new generation explicitly and does not Reset or create a new run. Verify the new receipt and one-unit stock decrease, unchanged `productVersion` and run ID, and preservation of earlier orders, controller actions, agent runs, and source identities. Leave the app and controller healthy, traffic stopped, alarm OK, and no pending or unresolved work. See the [application access contract](components/application.md#frontend-hosting-and-access) and [controller reconnect contract](components/failure-controller-behavior.md#reconnect-after-credential-rotation).

## Recover and Reset permissions and operation

Reapply the checked administrator bootstrap policy through [bootstrap step 1](../infrastructure/bootstrap/README.md#1-provision-the-scoped-execution-policy) before deploying a controller that changes Inventory capacity or resets data. Preserve the existing app API/distribution/OAC parameters.

**Worker capacity permissions.** The worker policy and its administrator-owned runtime boundary permit `PutFunctionConcurrency` and `DeleteFunctionConcurrency` only for the two named app functions as needed for Recover/Reset. It also adds region-scoped `lambda:GetAccountSettings` on `*` for the Inventory capacity headroom check. The shortcut accepts Inventory only. Checkout remains unreserved. The worker does not call Service Quotas.

**Reset permissions.** Reset additionally grants the worker `GetItem`/`PutItem` only on the exact Inventory table with a leading-key condition for the canonical demo SKU, and `Scan`/`DeleteItem` only on the exact Orders table. It grants no Orders `PutItem`/`UpdateItem`. The HTTP and agent roles have no business-table access.

**Alias and metrics permissions.** Inventory alias writes remain scoped to the existing supported function. No version-publication permission is added. The HTTP role separately receives only region-scoped `cloudwatch:GetMetricData` for its fixed, code-selected metrics. It cannot publish metrics or select arbitrary resources.

After the normal release succeeds, use fresh readiness, then the hosted **Recover** action with other writers paused. It stops/drains traffic, restores Inventory to 16 and Checkout to unreserved, returns Inventory to its original healthy variant and memory, and verifies a new one-unit order without resetting data or request history. A legacy/stale generation needs explicit readiness reconciliation. Restored configuration with incomplete bounded verification remains an incomplete business result. Consult the separate configuration and request evidence. See the [Recover command and evidence contract](components/failure-controller.md#recover-the-current-release).

For **Reset**:

- **Before reset.** Close old checkout pages and confirm quiet traffic, destructive order deletion/stock reseeding, and the closed-page condition in the controller. Reset stops the producers and waits for accepted work and the execution/drain window before changing data.
- **Reconcile and archive.** Reconcile against the current successful app release's trusted expected settings, including Inventory 16 and unreserved Checkout. Do not run Recover first just to establish a stale or missing old baseline. Reset archives the prior run and its receipts, outcomes, unresolved identities, cap observations, captures, and agent results, then starts a new run linked to it.
- **Replace and verify.** Reset replaces the canonical SKU with stock 1,000 and a fresh UUID `productVersion`, deletes prior Orders, and verifies one new quantity-one order with its saved receipt and stock decrement to 999. Only after verification does the new baseline record Inventory at 16. Traffic remains stopped afterward.
- **If interrupted.** Leave the run unusable. After its old execution/drain window has ended, an explicit new Reset with a new action UUID/productVersion may proceed. Do not continue or replay the old reset action. Retain any archived unknown checkout outcome as unknown.

See the [controller Reset safeguards](components/failure-controller.md#responsibilities-and-record).

## Evaluation stages

S1 freezes reviewed cases. S2 scores a captured faulty investigation. S3 evaluates the IDE prompt edit, and S4 runs the native Strands experiment over the selected suite. At S5, CI runs the experiment on the exact candidate ZIP before protected publication. The [active model and judge configuration](evaluations.md#active-model-target) identifies the evaluator for these runs. Each historical score retains the evaluator that produced it.

## Review a repaired agent release

1. Submit the candidate on `demo-deploy`. The agent check builds and smoke-tests the ZIP on Linux ARM64. The cloud evaluation job downloads that ZIP, runs the required cases and stores the source-backed results in private S3. A pull request or push to `main` runs offline checks.
2. Open the candidate’s GitHub Actions summary. Confirm the source SHA and ZIP digest. For a pending review, sign in to the demo AWS account and open the private evidence location in the summary. Read each report alongside its queried observations and their times, the deterministic findings, and the selected advisory judge verdict and reason. Pay particular attention to claims about cause, recovery and capacity headroom.
3. Open **Review deployments** for that run and select **repaired-publication**. If the evidence supports release, enter `approve <manifest-sha256>` with the full digest from the summary and approve. Otherwise reject. Keep evidence and private reports out of the public comment. A rerun that produces new evidence needs a new matching review.
4. Inspect the publisher’s readback of the new numbered Runtime version, the READY named `repaired` endpoint, its serving ZIP and its prepared publication record. The alarm adapter and the named `faulty` reference retain their bindings.

A prompt-only regression on `demo-deploy` uses the same gate. Review the failed case against the submitted SHA, then compare the named endpoint and prepared record to the last qualified release. The branch now contains the failed experiment while the endpoint continues serving the qualified bytes. Before another full rehearsal, revert that specific commit on `demo-deploy` and inspect the newly built package through the same workflow. Source-code checkout and endpoint publication have separate identities.
