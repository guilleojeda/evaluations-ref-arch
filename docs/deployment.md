# Deployment

The checkout app, failure controller, and operations agent have separate AWS CDK stacks in one development account. The repository workflow checks each component and verifies its AWS deployment access. Product releases use the corresponding stack job.

## Local development

From the repository root, select Node.js with `nvm use` or install the version in [`.nvmrc`](../.nvmrc). Use Python 3.13 and the uv version in [`agent/pyproject.toml`](../agent/pyproject.toml). Install dependencies from the locks.

```sh
npm ci
uv sync --project agent --locked
```

Run `npm run dev --workspace app` or `npm run dev --workspace controller` and open the local URL Vite prints. Start the credential-free AgentCore entry with `uv run --project agent --locked python agent/main.py`. Its health endpoint is `http://127.0.0.1:8080/ping`. See the [agent runtime commands](../agent/README.md) for a sample invocation and the native ARM64 package check.

Build and synthesize the component you are changing.

```sh
npm run check -- app
npm run check -- controller
npm run check -- agent
```

The checks write browser builds and CDK assemblies under `.artifacts/<component>/`. The agent assembly publishes `.artifacts/agent/runtime.zip` as a CDK file asset. It packages the locked dependencies for ARM64 Linux. Check the three assemblies and deployment routing with `node --test tests/phase0*.mjs`.

## GitHub Actions

Use [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) for pull requests and changes to `main`. Pull requests run the affected checks without AWS credentials. Changes in shared build or infrastructure inputs select all affected stacks. Documentation-only changes skip AWS jobs.

| Component | AWS stack |
| --- | --- |
| App | `IncidentTriageDemoApp` |
| Failure controller | `IncidentTriageDemoController` |
| Agent | `IncidentTriageDemoAgent` |

Deploy jobs serialize within each stack. During groundwork they assume the deployment role and verify the bootstrap path. The agent job also publishes and checks the ZIP asset. The component stacks first change when their first features are delivered. Once a stack has a successful release, compare candidates with its deployed revision inside the serialized job and skip a superseded candidate.

When a release depends on changes in another stack, merge and verify the dependency first. Record the checked assembly's source revision and deployed artifact or version identity with each release. Finish deployments before a demo run. If a deployment overlaps a run, abandon that run and verify the current release and settings before starting another.

## AWS access and initial setup

Use AWS CLI v2 with the `reinvent-2026-talk` profile, account `027224425948`, and Region `us-east-1`. For an IAM Identity Center profile, renew an expired session with `aws sso login --profile reinvent-2026-talk`. Check the caller before setup.

```sh
aws sts get-caller-identity --profile reinvent-2026-talk --region us-east-1
```

GitHub receives short-lived credentials through OIDC. The deployment role trusts the STS audience and the immutable identity of `guilleojeda/evaluations-ref-arch`, and pins the caller to `.github/workflows/deploy.yml` on `main`. It assumes the CDK deployment and file-publishing roles. Bootstrap administration, CloudFormation execution, and component runtime permissions use separate roles. [GitHub OIDC for AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws) · [CDK bootstrapping](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-env.html)

Follow the [AWS bootstrap commands](../infrastructure/bootstrap/README.md) to provision the scoped execution policy, dedicated `evaltalk` toolkit, and GitHub IAM stack in that order. The groundwork role can verify the toolkit but cannot create CloudFormation change sets. Scope the deployment guard and CloudFormation execution grants to the feature resources when adding the first product change set.

Before setting the GitHub subject template, inspect existing Actions runs and OIDC consumers for the repository. Preserve immutable identity. A repository admin can set the template with GitHub CLI.

```sh
gh api --method PUT repos/guilleojeda/evaluations-ref-arch/actions/oidc/customization/sub \
  -H 'X-GitHub-Api-Version: 2026-03-10' --input - <<'JSON'
{"use_default":false,"include_claim_keys":["repo","workflow_ref"],"use_immutable_subject":true}
JSON
gh api repos/guilleojeda/evaluations-ref-arch/actions/oidc/customization/sub
```

## Deployment and controller baseline

The presenter schedules deployments outside active demo runs. Routine releases preserve business data and investigation history. Keep the app's expected versions, memory, cap, and Inventory policy tied to the current release. The controller compares its recorded baseline with the deployed release and the affected live settings before restoring them. Unexpected drift or a newer release requires fresh readiness checks.

The deployment workflow leaves incident activation, probes, Recover, and Reset to the presenter. Applying an expected setting through CDK does not establish fresh business behavior. Use the [controller run procedure](components/failure-controller-behavior.md) to verify a new baseline and the [application contract](components/application.md#deployment-development-and-reset) for disposable data setup and reset.

## Evaluation stages

S0 has automatic deployment and ordinary software checks, with no agent evaluation suite or evaluation release gate. S1 introduces reviewed cases. S2 introduces deterministic action/target checks, semantic diagnosis/grounding criteria, judge configuration, and AgentCore evaluation results. S3 changes only the prompt and compares a fresh candidate with the original on the same cases and criteria. S4 connects the local Strands experiment and evaluates the existing reviewed local release policy before the first deployment. S5 runs that same experiment and policy in CI before deployment; failed or incomplete required evaluation evidence cannot pass. Deployment is the resulting action, not another stage. See [evaluation approach](evaluations.md#release-decisions).

The S4 workflow executes the repaired candidate through the local Python/Strands experiment against versioned captured evidence before the first deployment. It uses one agent construction with the candidate prompt, tool contracts, permissions, and report behavior, with captured evidence providers in place of live AWS reads. At S5, CI runs the same experiment and policy before deployment. Retain the evaluated source commit, agent artifact/prompt/dependency identity, case/evidence versions, evaluator/model settings, and policy result. Deploy only the candidate covered by the result; a substituted candidate or relevant artifact change requires new evaluation. An old deployed-agent trace cannot substitute for execution of the pending candidate. Genuine AgentCore trace evaluations retain their own provenance and selected role. This does not require a second environment, automatic evaluator-format interchange, or running every evaluator twice.

At S3, the prepared [local runner](evaluations.md#s3-fresh-candidate-before-deployment) executes candidates and submits their fresh traces to AgentCore on-demand evaluation. S4 reuses the execution function in the Strands experiment; S5 invokes that experiment from CI. Prepare local telemetry export, session correlation, collection, and evaluation permissions. The semantic backend for the S4/S5 experiment remains open; its selected path determines the corresponding CI permissions and waits. Neither candidate evaluation nor the experiment requires deploying the repaired source first.

The [agent component](components/operations-agent.md) owns runtime behavior; the [talk documents](demo-progression.md) own how the stages are presented. One shared development environment and one automatic deployment workflow are the baseline.
