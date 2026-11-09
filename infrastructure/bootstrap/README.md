# Incident Triage Demo bootstrap handoff

These templates set up the deployment path for account
`027224425948` in `us-east-1` and create the pre-provisioned Inventory access
Deny. They do not deploy the application, controller, or AgentCore product
resources; those remain independent product stacks released through GitHub
Actions.

The setup has three deliberately separate layers:

1. `phase0-cfn-execution-policy.yaml` creates the managed policies
   `IncidentTriageDemoBootstrapCfnExecution`,
   `IncidentTriageDemoControllerCfnExecution`,
   `IncidentTriageDemoPhase3CfnExecution`, and
   `IncidentTriageDemoAgentCfnExecution` in stack
   `IncidentTriageDemoBootstrapPolicy`. The policies separate bootstrap and
   app grants, controller grants, Phase 3 alarm/evidence grants, and scoped
   AgentCore Runtime, run-table, alarm-adapter, and runtime-identity grants.
   It also creates the
   `IncidentTriageDemoInventoryReadDeny` managed policy. That policy has one
   explicit `dynamodb:GetItem` Deny on the Inventory table; the app stack
   permanently attaches it to the named denied Inventory role. The controller
   worker reads both static role states and never attaches or detaches policies.
   The Phase 3 policy gives the app CloudFormation execution path only the
   scoped denied-role creation, attachment and PassRole grants. It is not
   attached to any runtime role. The same stack owns the four
   app/controller runtime permissions boundaries and separate runtime and
   alarm-adapter boundaries. The product-stack CloudFormation execution roles
   cannot edit those boundaries.
   Creation-time tagging requires the project/component tags and target Region;
   workload identity tags cover the `IncidentTriageDemoAgent-*` prefix and its
   exact default-directory parent required by creation authorization.
2. The standard CDK v2 bootstrap command creates stack
   `IncidentTriageDemoBootstrap` with qualifier `evaltalk`. Its CloudFormation
   execution role receives all four policies through
   `--cloudformation-execution-policies`.
3. `github-iam.yaml` creates stack `IncidentTriageDemoGitHub`, the GitHub OIDC
   provider when one is absent, and role `IncidentTriageDemoGitHubDeploy`.
   The role trust accepts only the immutable main workflow subject. Its
   identity policy contains only `sts:AssumeRole` for the standard CDK deploy
   and file-publishing roles. The same stack attaches the deploy guard to
   the existing `cdk-evaltalk-deploy-role-*`. It limits the standard role to
   bootstrap inspection and the actions needed to release the named app,
   controller, and agent stacks, prepare the two baseline Inventory versions,
   publish their immutable JSON manifest into the existing CDK asset bucket,
   and finalize the checked AgentCore version and adapter attestation. Keep the
   setup order below.

## Before any mutation

Use the verified administrative identity and confirm the target first:

```sh
export AWS_PROFILE=reinvent-2026-talk
export AWS_REGION=us-east-1
export TARGET_ACCOUNT=027224425948

aws sts get-caller-identity --profile "$AWS_PROFILE" --region "$AWS_REGION"
```

The returned account must be `027224425948`. Do not continue if the named
profile is missing or the caller is different.

## One-time AgentCore Runtime Identity account prerequisite

Before the first agent release, use the verified administrator to check for
the AWS-managed Runtime Identity service-linked role:

```sh
aws iam get-role \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --role-name AWSServiceRoleForBedrockAgentCoreRuntimeIdentity \
  --query 'Role.Arn' --output text
```

The expected ARN is
`arn:aws:iam::027224425948:role/aws-service-role/runtime-identity.bedrock-agentcore.amazonaws.com/AWSServiceRoleForBedrockAgentCoreRuntimeIdentity`.
If it is present, preserve it and continue. Only if the check returns
`NoSuchEntity`, create this exact service-linked role as the administrator,
then repeat the check and confirm the ARN:

```sh
aws iam create-service-linked-role \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --aws-service-name runtime-identity.bedrock-agentcore.amazonaws.com
```

For any other error, resolve the administrative access or account check before
continuing. This one-time account setup creates only the Runtime Identity
service-linked role, without provisioning other roles or AgentCore network or
instances resources. AWS can create this role during Runtime creation or
update, but the scoped CI policies do not grant service-linked-role creation.
The role is managed by AWS; it does not add authority to the agent execution
role. See [AgentCore service-linked roles](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/service-linked-roles.html).

## Before the first live Anthropic Runtime rehearsal

The initial Runtime profile is `us.anthropic.claude-sonnet-4-6`; its underlying
model ID is `anthropic.claude-sonnet-4-6` in `us-east-1`. Before live rehearsal,
the verified account administrator completes Anthropic's first-time-use form
using accurate company/developer identity and industry information supplied
and approved by the user. Do not store the form answers or personal details in
this repository. This is account setup; do not grant form-submission or
Marketplace permissions to the Runtime, alarm adapter, or GitHub Actions roles.

Check the native `GetUseCaseForModelAccess` result and call
`GetFoundationModelAvailability` for the underlying model ID. Require the use
case to be on file and availability statuses `AUTHORIZED`, `AVAILABLE`,
`AVAILABLE`, and `AVAILABLE` for authorization, entitlement, Region, and
agreement. A prior successful `Converse` call is not proof that the form and
agreement checks are complete; AWS documents that initial access can be
temporarily available. If `agreementAvailability` remains `NOT_AVAILABLE` after
the form is submitted, inspect the applicable offer and terms separately
before authorized acceptance. The current release workflow does not automate
first-use onboarding; no paid inference probe is needed for these control-plane
checks. See
[Model access](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html),
[`GetUseCaseForModelAccess`](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_GetUseCaseForModelAccess.html), and
[`GetFoundationModelAvailability`](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_GetFoundationModelAvailability.html).

## 1. Provision the scoped execution policy

Run this as the verified administrator. The explicit stack name and named IAM
capability are intentional:

```sh
aws cloudformation deploy \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --stack-name IncidentTriageDemoBootstrapPolicy \
  --template-file infrastructure/bootstrap/phase0-cfn-execution-policy.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset
```

The CloudFormation execution policy ARNs for the target account are:

```text
arn:aws:iam::027224425948:policy/IncidentTriageDemoBootstrapCfnExecution
arn:aws:iam::027224425948:policy/IncidentTriageDemoControllerCfnExecution
arn:aws:iam::027224425948:policy/IncidentTriageDemoPhase3CfnExecution
arn:aws:iam::027224425948:policy/IncidentTriageDemoAgentCfnExecution
```

The administrator-managed Deny policy ARN is separate and is not passed to
CDK bootstrap or attached to a runtime role:

```text
arn:aws:iam::027224425948:policy/IncidentTriageDemoInventoryReadDeny
```

## 2. Bootstrap CDK with the standard template

From the repository root, after `npm ci`, use the repository-pinned CDK v2 CLI.
The standard template is intentionally
generated by that pinned CLI rather than copied into this directory. Passing
all four execution policy ARNs is required: the standard template otherwise has an
`AdministratorAccess` fallback when no execution policies are supplied.

```sh
npm exec -- cdk bootstrap aws://027224425948/us-east-1 \
  --profile "$AWS_PROFILE" \
  --qualifier evaltalk \
  --toolkit-stack-name IncidentTriageDemoBootstrap \
  --cloudformation-execution-policies \
    "arn:aws:iam::027224425948:policy/IncidentTriageDemoBootstrapCfnExecution,arn:aws:iam::027224425948:policy/IncidentTriageDemoControllerCfnExecution,arn:aws:iam::027224425948:policy/IncidentTriageDemoPhase3CfnExecution,arn:aws:iam::027224425948:policy/IncidentTriageDemoAgentCfnExecution"
```

Keep the three existing app resource ID parameters when updating the policy stack. Set `ControllerHttpApiId` to the controller's `ApiId` output as soon as the first controller release succeeds. The `*` setting is for first creation, while CloudFormation is assigning the ID. Keep all four policy ARNs attached to the exact `cdk-evaltalk-cfn-exec-role-027224425948-us-east-1` role; do not replace them with a broad policy or unpinned role.

The app, controller, and agent releases share the CloudFormation execution role, but each product stack has its own scoped execution policy and its runtime components assume separate named roles with separate boundaries. The agent runtime can invoke only the selected model, read allowlisted app observations, write its own run records, save sanitized source evidence under the agent-source prefix, and emit traces. The adapter can invoke only the named AgentCore Runtime endpoint. The deploy role can finalize the checked Runtime endpoint and attest its final version in the adapter after native readback; it cannot run an investigation or send application traffic. Verify the runtime boundaries and bootstrap policy attachment before the first rehearsal. [CDK bootstrap policy inputs](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-env.html)

Use this single-account setup without `--trust` or `--trust-for-lookup`.
The resulting standard role names are:

```text
cdk-evaltalk-deploy-role-027224425948-us-east-1
cdk-evaltalk-file-publishing-role-027224425948-us-east-1
cdk-evaltalk-cfn-exec-role-027224425948-us-east-1
```

The application CDK assemblies must use qualifier `evaltalk` so their
synthesizers reference these roles and the `cdk-evaltalk-assets-027224425948-
us-east-1` staging bucket.

## 3. Create or reuse the GitHub OIDC provider and role

The issuer and audience are fixed:

```text
https://token.actions.githubusercontent.com
sts.amazonaws.com
```

First perform a read-only check for an existing provider. If it exists, verify
that its URL is `token.actions.githubusercontent.com` and its client ID list
contains `sts.amazonaws.com` (other audiences may belong to other consumers)
before passing its ARN to the stack. Preserve that provider's existing owner
and pass its ARN on every rerun. If it does not exist, omit
`GitHubOidcProviderArn` and the stack creates it.

Create/reuse the role stack with the hard-coded approved immutable repository
and workflow inputs:

```sh
# Existing provider path: set this only after the read-only provider check.
export GITHUB_OIDC_PROVIDER_ARN='arn:aws:iam::027224425948:oidc-provider/token.actions.githubusercontent.com'

aws cloudformation deploy \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --stack-name IncidentTriageDemoGitHub \
  --template-file infrastructure/bootstrap/github-iam.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    GitHubOidcProviderArn="$GITHUB_OIDC_PROVIDER_ARN" \
  --no-fail-on-empty-changeset
```

For the absent-provider path, use the same command and omit
`GitHubOidcProviderArn` so the stack creates and owns the provider. On updates,
keep the same provider ownership by reusing the previous parameter value.
The provider resource is retained if this stack is later deleted.

The role trust's exact subject is:

```text
repo:guilleojeda@18320860/evaluations-ref-arch@1411023195:workflow_ref:guilleojeda/evaluations-ref-arch/.github/workflows/deploy.yml@refs/heads/main
```

It also requires the separate `repository_id=1411023195`,
`ref=refs/heads/main`, and `aud=sts.amazonaws.com` conditions. The GitHub role
only assumes the standard CDK roles. The deploy role's scoped guard permits
the release helpers' Lambda role-only stage/publish/restore operations, exact
role and policy reads, conditional manifest publication, and the agent's
checked Runtime finalization. It cannot publish outside the revision-scoped
manifest prefix or pass an unrelated role. The administrator attaches policies
and bootstraps the account; subsequent product releases and finalization run
through the scoped GitHub workflow.
The deploy role's existing Lambda-key decryption exception covers only the
exact Inventory and alarm-adapter environment contexts.
Adapter attestation also permits `kms:Encrypt` only through Lambda on that
same key and the exact alarm-adapter environment context. It does not permit
Inventory encryption or grant/key creation. See [Lambda environment encryption](https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars-encryption.html)
and the [KMS Encrypt permission](https://docs.aws.amazon.com/kms/latest/APIReference/API_Encrypt.html).

The app release script runs `scripts/prepare-inventory-versions.mjs` after the
app stack is healthy. It verifies the healthy `live` alias, stages only the
denied role with the observed `$LATEST` revision, publishes with the observed
code hash and revision, immediately restores `$LATEST` to the healthy role,
checks both static policy states, and then writes
`releases/app/<SourceRevision>/inventory-variants.json` with explicit
`AES256` server-side encryption. A matching existing object is reused only
when its bytes are identical; a conflicting object fails the release.

## Pin the first app release's resource IDs

The first app stack create uses the defaults for `AppHttpApiId`, `AppDistributionId`, and `AppOriginAccessControlId`. AWS assigns those IDs during creation. Once the app stack succeeds, retrieve them from its owned resources.

```sh
aws cloudformation list-stack-resources --stack-name IncidentTriageDemoApp \
  --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  --query "StackResourceSummaries[?ResourceType=='AWS::ApiGatewayV2::Api' || ResourceType=='AWS::CloudFront::Distribution' || ResourceType=='AWS::CloudFront::OriginAccessControl'].[ResourceType,PhysicalResourceId]"
```

Reapply step 1 with `--parameter-overrides AppHttpApiId="$api_id" AppDistributionId="$distribution_id" AppOriginAccessControlId="$origin_access_control_id"`, using the three reported IDs. The named execution role then has resource-level access to the app's generated resources. Keep these values for routine releases. A reviewed replacement of one of those resources needs a corresponding bootstrap update.

## Recover a failed initial agent creation

After a failed first agent create reaches `ROLLBACK_COMPLETE`, an administrator removes only that failed stack shell. Preserve `IncidentTriageDemoAgentRun` and `/aws/lambda/IncidentTriageDemoAlarmAdapter`; the next normal checked agent deployment uses CDK auto-import, and its guard permits only those exact retained resources from the checked template. Never delete table rows or log history to make deployment succeed.

## Offline checks

Run these checks from the repository root before handoff:

```sh
cfn-lint infrastructure/bootstrap/github-iam.yaml \
  infrastructure/bootstrap/phase0-cfn-execution-policy.yaml
```

The templates are intentionally independent of CDK application code and AWS
credentials. Run the live account, provider, bootstrap, and STS checks with
the verified administrative and GitHub identities before enabling deployment.
