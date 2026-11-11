# Deployment

The checkout app, failure controller, and operations agent have separate AWS CDK stacks in one development account. The repository workflow checks each component and verifies its AWS deployment access. Product releases use the corresponding stack job.

## Local development

From the repository root, select Node.js with `nvm use` or install the version in [`.nvmrc`](../.nvmrc). Use Python 3.13 and the uv version in [`agent/pyproject.toml`](../agent/pyproject.toml). Install dependencies from the locks.

```sh
npm ci
uv sync --project agent --locked
```

Run `APP_API_URL=https://<api-id>.execute-api.us-east-1.amazonaws.com npm run dev --workspace app` with the direct API origin from the app stack outputs. Open the local URL Vite prints and enter the presenter credential on the page. Vite proxies the relative business routes to the deployed API. Start the controller separately with `npm run dev --workspace controller`. Start the local AgentCore entry with `uv run --project agent --locked python agent/main.py`; its `/ping` route checks health, while its invalid-event smoke is rejected before claim or inference. See the [agent runtime commands](../agent/README.md) for the smoke commands and native ARM64 package check.

Build and synthesize the component you are changing.

```sh
npm run check -- app
npm run check -- controller
npm run check -- agent
```

The checks write browser builds and CDK assemblies under `.artifacts/<component>/`. The agent assembly publishes `.artifacts/agent/runtime.zip` and `.artifacts/agent/alarm-adapter.zip` as CDK file assets. Both packages use locked ARM64 Linux dependencies. Check the three assemblies, deployment routing, and local checkout cases with `node --test tests/phase0*.mjs tests/phase1-*.test.mjs tests/phase2-controller-*.test.mjs tests/phase3-inventory-denial-*.test.mjs` after building. The deployed API suite is opt-in and consumes stock from an explicitly prepared verification fixture.

## GitHub Actions

Use [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) for pull requests and changes to `main`. Pull requests run the affected checks without AWS credentials. Changes in shared build or infrastructure inputs select all affected stacks. Documentation-only changes skip AWS jobs.

| Component | AWS stack |
| --- | --- |
| App | `IncidentTriageDemoApp` |
| Failure controller | `IncidentTriageDemoController` |
| Agent | `IncidentTriageDemoAgent` |

Deploy jobs serialize within each stack. The app job compares the candidate with the successful app stack revision, skips superseded or irrelevant candidates, and uses the checked CDK assembly. It inspects the prepared CloudFormation change set for table removal or possible replacement before executing that exact change set. It publishes immutable hashed assets before the revalidatable HTML. The controller job serves the checked web build in the HTTP Lambda artifact and deploys the separate worker. It inspects the change set for removal or possible replacement of the controller run table. The agent job publishes and checks the runtime and adapter ZIPs, inspects the agent-stack change set, and deploys its independent Runtime, endpoint, adapter, and retained run table. Its finalization step verifies the checked Runtime configuration, applies MMDSv2 while preserving the remaining configuration when needed, uses the returned Runtime version, pins and reads back the `faulty` endpoint, checks the trace destination, and writes the verified runtime version into the adapter configuration with a revision guard. It does not invoke the agent or send application traffic.

Relevant pushes to `main` deploy affected stacks automatically. The app, controller, and agent stacks remain independent; the presenter sequences dependent releases outside a live run. For an operator retry or a binding-only update at the same source revision, `workflow_dispatch` requires one component selection and deploys only that stack. Run separate dispatches in dependency order:

```sh
gh workflow run deploy.yml --repo guilleojeda/evaluations-ref-arch --ref main -f component=agent
gh workflow run deploy.yml --repo guilleojeda/evaluations-ref-arch --ref main -f component=app
gh workflow run deploy.yml --repo guilleojeda/evaluations-ref-arch --ref main -f component=controller
```

For the first alarm-path release, keep the app alarm adapter and controller agent variables empty until the checked agent stack has finalized and its outputs have been read back. Then set `APP_ALARM_ADAPTER_ARN` to the agent stack's `AlarmAdapterArn` and dispatch `app`; only after that succeeds set `CONTROLLER_AGENT_RUNTIME_ARN`, `CONTROLLER_AGENT_ENDPOINT_ARN`, and `CONTROLLER_AGENT_ALARM_ADAPTER_ARN` to the verified agent outputs and dispatch `controller`. Empty or unset variables preserve an existing binding on updates; fresh stacks start unconfigured. Verify each run and its stack outputs before dispatching the dependent component. Record the checked source revision and final Runtime version/artifact identity with each release. Finish deployments before a demo run. If a deployment overlaps a run, abandon that run and verify the current release and settings before starting another.

## AWS access and initial setup

Use AWS CLI v2 with the `reinvent-2026-talk` profile, account `027224425948`, and Region `us-east-1`. For an IAM Identity Center profile, renew an expired session with `aws sso login --profile reinvent-2026-talk`. Check the caller before setup.

```sh
aws sts get-caller-identity --profile reinvent-2026-talk --region us-east-1
```

GitHub receives short-lived credentials through OIDC. The deployment role trusts the STS audience and the immutable identity of `guilleojeda/evaluations-ref-arch`, and pins the caller to `.github/workflows/deploy.yml` on `main`. It assumes the CDK deployment and file-publishing roles. Bootstrap administration, CloudFormation execution, and component runtime permissions use separate roles. [GitHub OIDC for AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws) · [CDK bootstrapping](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-env.html)

Follow the [AWS bootstrap commands](../infrastructure/bootstrap/README.md) to provision the scoped execution policy, dedicated `evaltalk` toolkit, and GitHub IAM stack in that order. Before the first agent release, an administrator must also [check or create the exact Runtime Identity service-linked role](../infrastructure/bootstrap/README.md#one-time-agentcore-runtime-identity-account-prerequisite); preserve it if it already exists. This is one-time account setup, separate from CI and agent execution authority. The dedicated deploy role can prepare and execute change sets for the named app, controller, and agent stacks. CloudFormation uses separate scoped execution policies for their resources. Use the verified administrator for updates to the bootstrap IAM stacks. Keep the deploy guard and CloudFormation execution grants scoped to reviewed feature resources.

Before setting the GitHub subject template, inspect existing Actions runs and OIDC consumers for the repository. Preserve immutable identity. A repository admin can set the template with GitHub CLI.

```sh
gh api --method PUT repos/guilleojeda/evaluations-ref-arch/actions/oidc/customization/sub \
  -H 'X-GitHub-Api-Version: 2026-03-10' --input - <<'JSON'
{"use_default":false,"include_claim_keys":["repo","workflow_ref"],"use_immutable_subject":true}
JSON
gh api repos/guilleojeda/evaluations-ref-arch/actions/oidc/customization/sub
```

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

The seed inserts the demo SKU with 1,000 units only when it is absent. Reruns report the existing version and quantity. Open the CloudFront site URL from the outputs, enter the bearer, and verify one normal order and its stock decrement. The direct API origin is available for the local Vite proxy. The outputs also identify the source revision, tables, function and alias targets, and logs used to check the release. Inventory release preparation publishes healthy and denied variants at each configured supported memory from the checked artifact, restores and verifies the original unpublished `$LATEST` settings, then conditionally writes the immutable version manifest with explicit AES256 server-side encryption to the existing private CDK asset bucket under `releases/app/<SourceRevision>/inventory-variants.json`; no new service or bucket is introduced. The outputs identify that manifest location and the denied execution role; the controller uses them for allowlist validation and alias-only changes.

Reloading the page requires the bearer again. If an order response is lost, use the saved attempt to check status or retry the original submission. A missing status may precede a commit. Check that the page shows a confirmed receipt before placing another order.

## Inventory memory variants

The app release prepares healthy and denied Inventory variants at 256 and 512 MB. The schema-1 manifest maps each `(memoryMb, access)` pair to its numeric version and fixed role, with the checked code digest and source revision. Preparation leaves `live` at the healthy baseline and verifies the original unpublished role/memory/configuration is restored. The immutable revision-scoped object is published only after the complete set validates; a mismatched existing object is rejected. The checked deployment script supplies the supported values to the preparer CLI, including its recognized-staging cleanup path. Adding a size requires a reviewed release/configuration update.

Use the controller's Inventory memory action for an increase or equal-size no-op. It only switches the allowed alias target and preserves access state, code and other settings. To prove denial persists, send a separate fresh request after higher-memory readback. Restore access chooses healthy at that same memory; a separate bounded readiness action proves business recovery. Do not apply `$LATEST` changes or publish versions from the controller.

## First controller release and operator access

Use the administrator to provision the existing app bearer and the SHA-256 hex digest of a separate high-entropy operator bearer in the two named Secrets Manager secrets. Use the names `incident-triage-demo/controller/app-bearer` and `incident-triage-demo/controller/operator-digest`. Store each as a single text value. Supply their exact ARNs as the `CONTROLLER_APP_SECRET_ARN` and `CONTROLLER_OPERATOR_SECRET_ARN` repository variables for the first release. The controller stack retains these inputs on updates. Only the worker reads the app bearer, and only the HTTP Lambda reads the operator digest. Keep the raw operator bearer in presenter-only storage that can be reached from a replacement device.

After deployment, open `SiteUrl` from the `IncidentTriageDemoController` stack outputs and sign in with the operator bearer. Pause other app checkout writers, then check readiness. A successful readiness action verifies its bounded request sequence and stock decrement. The dashboard displays the baseline and actual request counts and outcomes. Each action has its own finite bounds. Start normal traffic explicitly and use Stop to close submissions and drain work. A second browser can sign in to the same session/run. Inspect and discard an expired action only after it is shown as incomplete. Its recorded attempts and unresolved checkout IDs remain available.

The controller has no cumulative checkout, catalog, or status-read quotas and no separate generator, verification, or manual pools. Each individual traffic or verification action remains bounded by its configured duration, attempt count, pacing, in-flight limit, timeout, and deadline. Normal traffic uses the 15-second profile with 1 Hz catalog and checkout ticks, one catalog request and two checkout requests in flight, and no catch-up on skipped ticks. The access-denied activation uses up to six paced catalog probes and at most one verification checkout after a typed denial. Readiness uses its own bounded request sequence. Record actual requests and outcomes; deduplicate repeated command IDs and drain accepted work on Stop.

## Release and bind the initial agent path

The first Phase 4 release uses the currently deployed app API ID as an input to the agent stack. The app alarm remains unbound while the agent is finalized, and the controller remains unconfigured for agent readiness. Use the stack outputs and checked GitHub assembly; do not invoke the Runtime as a smoke test.

After the `IncidentTriageDemoAgent` release succeeds, verify its `SourceRevision`, `RuntimeArn`, `FaultyEndpointArn`, `AlarmAdapterArn`, and `RuntimeArtifactSha256` outputs against the checked release. The `CloudFormationRuntimeVersion` output is the initial CloudFormation version; use the finalizer's `agent-final-release.json` log record for the accepted `runtimeVersion`. The finalization step checks native `requireMMDSV2`, reads back the endpoint's live and target version, verifies CloudWatch Transaction Search is enabled, then sets the adapter's runtime version using its current `RevisionId`. A final adapter readback checks the version, checked adapter ZIP, tracing mode, and release identity. This is release evidence only; no alarm or investigation is generated.

Read the finalized agent stack outputs into local shell variables, then bind the app alarm by setting the repository variable and deploying the app component:

```sh
export AGENT_ALARM_ADAPTER_ARN="$(aws cloudformation describe-stacks --stack-name IncidentTriageDemoAgent --profile reinvent-2026-talk --region us-east-1 --query "Stacks[0].Outputs[?OutputKey=='AlarmAdapterArn'].OutputValue | [0]" --output text)"
gh variable set APP_ALARM_ADAPTER_ARN --repo guilleojeda/evaluations-ref-arch --body "$AGENT_ALARM_ADAPTER_ARN"
gh workflow run deploy.yml --repo guilleojeda/evaluations-ref-arch --ref main -f component=app
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
gh workflow run deploy.yml --repo guilleojeda/evaluations-ref-arch --ref main -f component=controller
```

The values are `RuntimeArn`, `FaultyEndpointArn`, and `AlarmAdapterArn` from the agent stack outputs. When the controller release completes, open the dashboard and verify the endpoint is ready and the alarm binding is bound. These checks are read-only control-plane observations; they do not prove an inference occurred. Complete the actual alarm-triggered journey through the controller after readiness.

## Operate the Inventory access incident

1. Stop existing traffic and pause other checkout writers. Use **Check readiness** on the current release. Keep readiness, activation, and post-restore verification as separate actions with their own bounds.
2. Choose **Activate Inventory denial**. Inspect the active alias/version, execution role, exact policy/default document, and checkpoint alongside the catalog and checkout evidence. The alarm card reads CloudWatch independently. Wait for an observed ALARM when collecting a complete incident.
3. Choose **Restore Inventory access**. If the controller cannot save the required configuration and you need to restore service, use the explicit protective confirmation. It still requires the recorded app source revision, alias/version/role/policy state, and current release. The evidence gap remains visible.
4. Once the alias reads as the healthy version at the current memory, wait for an actual fresh catalog success and run **Check readiness**. Confirm the successful order and stock change separately from the alarm. Allow for native metric evaluation delay before observing OK.

Keep the evidence bucket private. Inspect or export the referenced configuration objects using authorized AWS access before teardown. Run planned releases after the healthy alias is restored and traffic has settled.

## Deployment and controller baseline

The presenter schedules releases outside active demo sessions and manually sequences dependent app, agent, and controller changes. Routine releases preserve business data and investigation history. Keep the app's expected versions, memory, cap, and Inventory role/policy/access-state manifest tied to the current release. The controller compares its recorded original baseline with the successful stack identity/update time, deployed source revision, immutable versions, manifest and affected live settings before restoring them. A first or legacy baseline requires readiness at the original healthy settings; later supported higher-memory readiness does not change that restore target. Explicit new-generation readiness preserves prior incident history and identifies the new baseline. Agent provenance separately identifies the checked Runtime artifact and final pinned version. Unexpected drift or a newer release requires fresh readiness checks.

The deployment workflow leaves incident activation, probes, Recover, and Reset to the presenter. Applying an expected setting through CDK does not establish fresh business behavior. Use the [controller run procedure](components/failure-controller-behavior.md) to verify a new baseline and the [application contract](components/application.md#deployment-development-and-reset) for disposable data setup and reset.

## Recover permissions and operation

Reapply the checked administrator bootstrap policy through [bootstrap step 1](../infrastructure/bootstrap/README.md#1-provision-the-scoped-execution-policy) before deploying a controller that restores caps. Preserve the existing app API/distribution/OAC parameters. The worker policy and its administrator-owned runtime boundary both permit `PutFunctionConcurrency` and `DeleteFunctionConcurrency` only for the two named app functions. The HTTP role has no configuration mutation authority. Inventory alias writes remain scoped to the existing supported function; no business-table write or version-publication permission is added.

After the normal release succeeds, use fresh readiness, then the hosted **Recover** action with other writers paused. It stops/drains traffic, restores current-release original settings and verifies a new one-unit order without resetting data or request history. A legacy/stale generation needs explicit readiness reconciliation. Restored configuration with incomplete bounded verification remains an incomplete business result; consult the separate configuration and request evidence. See the [Recover command and evidence contract](components/failure-controller.md#recover-the-current-release).

## Evaluation stages

S0 has automatic deployment and ordinary software checks, with no agent evaluation suite or evaluation release gate. S1 introduces reviewed cases. S2 introduces deterministic action/target checks, semantic diagnosis/grounding criteria, judge configuration, and AgentCore evaluation results. S3 changes only the prompt and compares a fresh candidate with the original on the same cases and criteria. S4 connects the local Strands experiment and evaluates the existing reviewed local release policy before the first deployment. S5 runs that same experiment and policy in CI before deployment; failed or incomplete required evaluation evidence cannot pass. Deployment is the resulting action, not another stage. See [evaluation approach](evaluations.md#release-decisions).

The S4 workflow executes the repaired candidate through the local Python/Strands experiment against versioned captured evidence before the first deployment. It uses one agent construction with the candidate prompt, tool contracts, permissions, and report behavior, with captured evidence providers in place of live AWS reads. At S5, CI runs the same experiment and policy before deployment. Retain the evaluated source commit, agent artifact/prompt/dependency identity, case/evidence versions, evaluator/model settings, and policy result. Deploy only the candidate covered by the result; a substituted candidate or relevant artifact change requires new evaluation. An old deployed-agent trace cannot substitute for execution of the pending candidate. Genuine AgentCore trace evaluations retain their own provenance and selected role. This does not require a second environment, automatic evaluator-format interchange, or running every evaluator twice.

At S3, the prepared [local runner](evaluations.md#s3-fresh-candidate-before-deployment) executes candidates and submits their fresh traces to AgentCore on-demand evaluation. S4 reuses the execution function in the Strands experiment; S5 invokes that experiment from CI. Prepare local telemetry export, session correlation, collection, and evaluation permissions. The semantic backend for the S4/S5 experiment remains open; its selected path determines the corresponding CI permissions and waits. Neither candidate evaluation nor the experiment requires deploying the repaired source first.

The [agent component](components/operations-agent.md) owns runtime behavior; the [talk documents](demo-progression.md) own how the stages are presented. The development target has three independent stacks and one GitHub Actions workflow with separate checks/deployments; the presenter sequences dependent releases.
