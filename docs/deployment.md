# Deployment

The checkout app, failure controller, and operations agent have separate AWS CDK stacks in one development account. The repository workflow checks each component and verifies its AWS deployment access. Product releases use the corresponding stack job.

## Local development

From the repository root, select Node.js with `nvm use` or install the version in [`.nvmrc`](../.nvmrc). Use Python 3.13 and the uv version in [`agent/pyproject.toml`](../agent/pyproject.toml). Install dependencies from the locks.

```sh
npm ci
uv sync --project agent --locked
```

Run `APP_API_URL=https://<api-id>.execute-api.us-east-1.amazonaws.com npm run dev --workspace app` with the direct API origin from the app stack outputs. Open the local URL Vite prints and enter the presenter credential on the page. Vite proxies the relative business routes to the deployed API. Start the controller separately with `npm run dev --workspace controller`. Start the credential-free AgentCore entry with `uv run --project agent --locked python agent/main.py`. Its health endpoint is `http://127.0.0.1:8080/ping`. See the [agent runtime commands](../agent/README.md) for a sample invocation and the native ARM64 package check.

Build and synthesize the component you are changing.

```sh
npm run check -- app
npm run check -- controller
npm run check -- agent
```

The checks write browser builds and CDK assemblies under `.artifacts/<component>/`. The agent assembly publishes `.artifacts/agent/runtime.zip` as a CDK file asset. It packages the locked dependencies for ARM64 Linux. Check the three assemblies, deployment routing, and local checkout cases with `node --test tests/phase0*.mjs tests/phase1-*.test.mjs tests/phase2-controller-*.test.mjs tests/phase3-inventory-denial-*.test.mjs` after building. The deployed API suite is opt-in and consumes stock from an explicitly prepared verification fixture.

## GitHub Actions

Use [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) for pull requests and changes to `main`. Pull requests run the affected checks without AWS credentials. Changes in shared build or infrastructure inputs select all affected stacks. Documentation-only changes skip AWS jobs.

| Component | AWS stack |
| --- | --- |
| App | `IncidentTriageDemoApp` |
| Failure controller | `IncidentTriageDemoController` |
| Agent | `IncidentTriageDemoAgent` |

Deploy jobs serialize within each stack. The app job compares the candidate with the successful app stack revision, skips superseded or irrelevant candidates, and uses the checked CDK assembly. It inspects the prepared CloudFormation change set for table removal or possible replacement before executing that exact change set. It publishes immutable hashed assets before the revalidatable HTML. The controller job serves the checked web build in the HTTP Lambda artifact and deploys the separate worker. It inspects the change set for removal or possible replacement of the controller run table. The agent job verifies its groundwork path and publishes and checks the ZIP asset.

When a release depends on changes in another stack, merge and verify the dependency first. Record the checked assembly's source revision and deployed artifact or version identity with each release. Finish deployments before a demo run. If a deployment overlaps a run, abandon that run and verify the current release and settings before starting another.

## AWS access and initial setup

Use AWS CLI v2 with the `reinvent-2026-talk` profile, account `027224425948`, and Region `us-east-1`. For an IAM Identity Center profile, renew an expired session with `aws sso login --profile reinvent-2026-talk`. Check the caller before setup.

```sh
aws sts get-caller-identity --profile reinvent-2026-talk --region us-east-1
```

GitHub receives short-lived credentials through OIDC. The deployment role trusts the STS audience and the immutable identity of `guilleojeda/evaluations-ref-arch`, and pins the caller to `.github/workflows/deploy.yml` on `main`. It assumes the CDK deployment and file-publishing roles. Bootstrap administration, CloudFormation execution, and component runtime permissions use separate roles. [GitHub OIDC for AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws) · [CDK bootstrapping](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-env.html)

Follow the [AWS bootstrap commands](../infrastructure/bootstrap/README.md) to provision the scoped execution policy, dedicated `evaltalk` toolkit, and GitHub IAM stack in that order. The dedicated deploy role can prepare and execute change sets for the named app and controller stacks. CloudFormation uses separate scoped execution policies for their resources. Use the verified administrator for updates to the bootstrap IAM stacks. Keep the deploy guard and CloudFormation execution grants scoped to reviewed feature resources.

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

The seed inserts the demo SKU with 1,000 units only when it is absent. Reruns report the existing version and quantity. Open the CloudFront site URL from the outputs, enter the bearer, and verify one normal order and its stock decrement. The direct API origin is available for the local Vite proxy. The outputs also identify the source revision, tables, function and alias targets, and logs used to check the release. Inventory release preparation publishes the healthy and denied baseline variants from the checked artifact, restores and verifies the original unpublished `$LATEST` settings, then conditionally writes the immutable version manifest with explicit AES256 server-side encryption to the existing private CDK asset bucket under `releases/app/<SourceRevision>/inventory-variants.json`; no new service or bucket is introduced. The outputs identify that manifest location and the denied execution role; the controller uses them for allowlist validation and alias-only changes.

Reloading the page requires the bearer again. If an order response is lost, use the saved attempt to check status or retry the original submission. A missing status may precede a commit. Check that the page shows a confirmed receipt before placing another order.

## First controller release and operator access

Use the administrator to provision the existing app bearer and the SHA-256 hex digest of a separate high-entropy operator bearer in the two named Secrets Manager secrets. Use the names `incident-triage-demo/controller/app-bearer` and `incident-triage-demo/controller/operator-digest`. Store each as a single text value. Supply their exact ARNs as the `CONTROLLER_APP_SECRET_ARN` and `CONTROLLER_OPERATOR_SECRET_ARN` repository variables for the first release. The controller stack retains these inputs on updates. Only the worker reads the app bearer, and only the HTTP Lambda reads the operator digest. Keep the raw operator bearer in presenter-only storage that can be reached from a replacement device.

After deployment, open `SiteUrl` from the `IncidentTriageDemoController` stack outputs and sign in with the operator bearer. Pause other app checkout writers, then check readiness. A successful readiness action saves a one-unit order and verifies its stock decrement. The dashboard displays that baseline, request progress, and the remaining allowances. Start normal traffic explicitly and use Stop to close submissions and drain work. A second browser can sign in to the same run. Inspect and discard an expired action only after it is shown as incomplete. Its recorded attempts and unresolved checkout IDs remain available.

The run allows 50 generator POSTs, 5 controller verification POSTs, and 5 manual POSTs. Track every manual attempt separately, including retries. Catalog traffic and order-status reads have separate limits. Stop, repeated Start, discard, and routine releases preserve the current allowance.

## Operate the Inventory access incident

1. Stop existing traffic and pause other checkout writers. Use **Check readiness** on the current release. Keep verification checkout allowance for activation and a separate post-restore readiness check.
2. Choose **Activate Inventory denial**. Inspect the active alias/version, execution role, exact policy/default document, and checkpoint alongside the catalog and checkout evidence. The alarm card reads CloudWatch independently. Wait for an observed ALARM when collecting a complete incident.
3. Choose **Restore Inventory access**. If the controller cannot save the required configuration and you need to restore service, use the explicit protective confirmation. It still requires the recorded app source revision, alias/version/role/policy state, and current release. The evidence gap remains visible.
4. Once the alias reads as the healthy version at the current memory, wait for an actual fresh catalog success and run **Check readiness**. Confirm the successful order and stock change separately from the alarm. Allow for native metric evaluation delay before observing OK.

Keep the evidence bucket private. Inspect or export the referenced configuration objects using authorized AWS access before teardown. Run planned releases after the healthy alias is restored and traffic has settled.

## Deployment and controller baseline

The presenter schedules deployments outside active demo runs. Routine releases preserve business data and investigation history. Keep the app's expected versions, memory, cap, and Inventory role/policy/access-state manifest tied to the current release. The controller compares its recorded baseline with the deployed source revision, manifest, and affected live settings before restoring them. Unexpected drift or a newer release requires fresh readiness checks.

The deployment workflow leaves incident activation, probes, Recover, and Reset to the presenter. Applying an expected setting through CDK does not establish fresh business behavior. Use the [controller run procedure](components/failure-controller-behavior.md) to verify a new baseline and the [application contract](components/application.md#deployment-development-and-reset) for disposable data setup and reset.

## Evaluation stages

S0 has automatic deployment and ordinary software checks, with no agent evaluation suite or evaluation release gate. S1 introduces reviewed cases. S2 introduces deterministic action/target checks, semantic diagnosis/grounding criteria, judge configuration, and AgentCore evaluation results. S3 changes only the prompt and compares a fresh candidate with the original on the same cases and criteria. S4 connects the local Strands experiment and evaluates the existing reviewed local release policy before the first deployment. S5 runs that same experiment and policy in CI before deployment; failed or incomplete required evaluation evidence cannot pass. Deployment is the resulting action, not another stage. See [evaluation approach](evaluations.md#release-decisions).

The S4 workflow executes the repaired candidate through the local Python/Strands experiment against versioned captured evidence before the first deployment. It uses one agent construction with the candidate prompt, tool contracts, permissions, and report behavior, with captured evidence providers in place of live AWS reads. At S5, CI runs the same experiment and policy before deployment. Retain the evaluated source commit, agent artifact/prompt/dependency identity, case/evidence versions, evaluator/model settings, and policy result. Deploy only the candidate covered by the result; a substituted candidate or relevant artifact change requires new evaluation. An old deployed-agent trace cannot substitute for execution of the pending candidate. Genuine AgentCore trace evaluations retain their own provenance and selected role. This does not require a second environment, automatic evaluator-format interchange, or running every evaluator twice.

At S3, the prepared [local runner](evaluations.md#s3-fresh-candidate-before-deployment) executes candidates and submits their fresh traces to AgentCore on-demand evaluation. S4 reuses the execution function in the Strands experiment; S5 invokes that experiment from CI. Prepare local telemetry export, session correlation, collection, and evaluation permissions. The semantic backend for the S4/S5 experiment remains open; its selected path determines the corresponding CI permissions and waits. Neither candidate evaluation nor the experiment requires deploying the repaired source first.

The [agent component](components/operations-agent.md) owns runtime behavior; the [talk documents](demo-progression.md) own how the stages are presented. One shared development environment and one automatic deployment workflow are the baseline.
