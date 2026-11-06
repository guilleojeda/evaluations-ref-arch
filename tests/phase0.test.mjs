import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { before, describe, test } from "node:test";

const REGION = "us-east-1";
const TARGET_ACCOUNT = "027224425948";
const TARGET_PROFILE = "reinvent-2026-talk";
const TARGET_REPOSITORY = "guilleojeda/evaluations-ref-arch";
const TARGET_REPOSITORY_ID = "1411023195";
const TARGET_OWNER_ID = "18320860";
const WORKFLOW = ".github/workflows/deploy.yml";
const REF = "refs/heads/main";
const ISSUER = "token.actions.githubusercontent.com";
const AUDIENCE = "sts.amazonaws.com";
const ENV_NAMES = [
  "PHASE0_GITHUB_REPOSITORY",
  "PHASE0_GITHUB_REPOSITORY_ID",
  "PHASE0_AWS_ACCOUNT_ID",
  "PHASE0_AWS_REGION",
  "PHASE0_EXPECTED_AWS_CALLER_ARN",
  "PHASE0_DEPLOY_ROLE_ARN",
  "PHASE0_EXPECTED_OIDC_SUBJECT",
  "PHASE0_CDK_QUALIFIER",
  "PHASE0_CDK_BOOTSTRAP_STACK",
  "PHASE0_AWS_PROFILE",
];

const SAMPLE_ENV = {
  PHASE0_GITHUB_REPOSITORY: TARGET_REPOSITORY,
  PHASE0_GITHUB_REPOSITORY_ID: TARGET_REPOSITORY_ID,
  PHASE0_AWS_ACCOUNT_ID: TARGET_ACCOUNT,
  PHASE0_AWS_REGION: REGION,
  PHASE0_EXPECTED_AWS_CALLER_ARN: `arn:aws:sts::${TARGET_ACCOUNT}:assumed-role/phase0-checker/session`,
  PHASE0_DEPLOY_ROLE_ARN: `arn:aws:iam::${TARGET_ACCOUNT}:role/github-deploy`,
  PHASE0_EXPECTED_OIDC_SUBJECT: `repo:guilleojeda@${TARGET_OWNER_ID}/evaluations-ref-arch@${TARGET_REPOSITORY_ID}:workflow_ref:${TARGET_REPOSITORY}/${WORKFLOW}@${REF}`,
  PHASE0_CDK_QUALIFIER: "hnb659fds",
  PHASE0_CDK_BOOTSTRAP_STACK: "CDKToolkit",
  PHASE0_AWS_PROFILE: TARGET_PROFILE,
};

function getInputs(env) {
  const values = Object.fromEntries(ENV_NAMES.map((name) => {
    const value = env[name]?.trim();
    assert.ok(value, `${name} must be set when PHASE0_LIVE=1`);
    return [name, value];
  }));
  const [owner, name, ...extra] = values.PHASE0_GITHUB_REPOSITORY.split("/");
  assert.ok(owner && name && extra.length === 0, "PHASE0_GITHUB_REPOSITORY must be owner/name");
  assert.equal(values.PHASE0_GITHUB_REPOSITORY, TARGET_REPOSITORY, `Phase 0 repository must be ${TARGET_REPOSITORY}`);
  assert.equal(values.PHASE0_GITHUB_REPOSITORY_ID, TARGET_REPOSITORY_ID, `Phase 0 repository ID must be ${TARGET_REPOSITORY_ID}`);
  assert.equal(values.PHASE0_AWS_ACCOUNT_ID, TARGET_ACCOUNT, `Phase 0 account must be ${TARGET_ACCOUNT}`);
  assert.equal(values.PHASE0_AWS_REGION, REGION, `Phase 0 region must be ${REGION}`);
  assert.equal(values.PHASE0_AWS_PROFILE, TARGET_PROFILE, `Phase 0 AWS profile must be ${TARGET_PROFILE}`);
  assert.ok(
    values.PHASE0_EXPECTED_AWS_CALLER_ARN.startsWith(`arn:aws:`) && values.PHASE0_EXPECTED_AWS_CALLER_ARN.includes(`::${values.PHASE0_AWS_ACCOUNT_ID}:`),
    "PHASE0_EXPECTED_AWS_CALLER_ARN must belong to PHASE0_AWS_ACCOUNT_ID",
  );
  assert.match(
    values.PHASE0_DEPLOY_ROLE_ARN,
    new RegExp(`^arn:aws:iam::${values.PHASE0_AWS_ACCOUNT_ID}:role/.+$`),
    "PHASE0_DEPLOY_ROLE_ARN must be an IAM role in PHASE0_AWS_ACCOUNT_ID",
  );
  assert.match(values.PHASE0_CDK_QUALIFIER, /^[A-Za-z0-9]{1,10}$/, "PHASE0_CDK_QUALIFIER must be 1–10 alphanumeric characters");
  assert.match(values.PHASE0_CDK_BOOTSTRAP_STACK, /^[A-Za-z][A-Za-z0-9-]{0,127}$/, "PHASE0_CDK_BOOTSTRAP_STACK must be a valid stack name");

  return {
    ...values,
    repository: values.PHASE0_GITHUB_REPOSITORY,
    owner,
    name,
    repositoryId: values.PHASE0_GITHUB_REPOSITORY_ID,
    accountId: values.PHASE0_AWS_ACCOUNT_ID,
    region: values.PHASE0_AWS_REGION,
    callerArn: values.PHASE0_EXPECTED_AWS_CALLER_ARN,
    deployRoleArn: values.PHASE0_DEPLOY_ROLE_ARN,
    expectedSubject: values.PHASE0_EXPECTED_OIDC_SUBJECT,
    qualifier: values.PHASE0_CDK_QUALIFIER,
    bootstrapStack: values.PHASE0_CDK_BOOTSTRAP_STACK,
    profile: values.PHASE0_AWS_PROFILE,
  };
}

function runJson(command, args, label, { profile, region } = {}) {
  const cliArgs = [];
  if (profile) cliArgs.push("--profile", profile);
  cliArgs.push(...args);
  if (region) cliArgs.push("--region", region);
  if (command === "aws") cliArgs.push("--output", "json");
  const result = spawnSync(command, cliArgs, {
    encoding: "utf8",
    env: { ...process.env, AWS_PAGER: "", GH_HOST: "github.com" },
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const details = String(result.stderr ?? "").trim()
      .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted AWS access key]")
      .replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/g, "[redacted GitHub token]")
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .slice(0, 600);
    assert.fail(`${label} failed${result.status === null ? "" : ` (exit ${result.status})`}${details ? `: ${details}` : "."}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    assert.fail(`${label} returned invalid JSON`);
  }
}

function aws(inputs, service, operation, args = []) {
  return runJson("aws", [service, operation, ...args], `aws ${service} ${operation}`, {
    profile: inputs.profile,
    region: inputs.region,
  });
}

function gh(endpoint) {
  return runJson("gh", ["api", "--hostname", "github.com", endpoint], `gh api github.com ${endpoint}`);
}

function expectedProvider(inputs) {
  return `arn:aws:iam::${inputs.accountId}:oidc-provider/${ISSUER}`;
}

function validateSubjectCustomization(customization, repo, inputs) {
  assert.equal(customization.use_default, false, "GitHub must use the customized OIDC subject template");
  assert.deepEqual(customization.include_claim_keys, ["repo", "workflow_ref"], "GitHub subject customization must include only repo and workflow_ref");
  if (typeof customization.use_immutable_subject === "boolean") {
    assert.equal(customization.use_immutable_subject, true, "GitHub immutable subject format must remain enabled");
  }

  const ownerId = String(repo.owner?.id ?? "");
  assert.match(ownerId, /^\d+$/, "GitHub repository metadata must include the immutable owner ID");
  const immutableRepoPart = `repo:${inputs.owner}@${ownerId}/${inputs.name}@${inputs.repositoryId}`;
  assert.equal(ownerId, TARGET_OWNER_ID, `GitHub repository owner ID must be ${TARGET_OWNER_ID}`);
  const expected = `${immutableRepoPart}:workflow_ref:${inputs.repository}/${WORKFLOW}@${REF}`;
  assert.equal(inputs.expectedSubject, expected, "PHASE0_EXPECTED_OIDC_SUBJECT must match the immutable repository and exact workflow ref");
  return expected;
}

function validateRoleTrust(policy, inputs, providerArn) {
  const statements = Array.isArray(policy?.Statement) ? policy.Statement : [policy?.Statement];
  const allows = statements.filter((statement) => statement?.Effect === "Allow");
  assert.ok(allows.length > 0, "deployment role must allow the GitHub OIDC workflow");
  for (const statement of allows) {
    assert.deepEqual(Object.keys(statement.Principal ?? {}), ["Federated"], "every role trust grant must use only a federated principal");
    assert.deepEqual([statement.Principal.Federated].flat(), [providerArn], "every role trust grant must use only the configured GitHub provider");
    assert.deepEqual([statement.Action].flat(), ["sts:AssumeRoleWithWebIdentity"], "role trust grant must only allow web identity assumption");
    const conditions = statement.Condition?.StringEquals ?? {};
    assert.equal(conditions[`${ISSUER}:aud`], AUDIENCE, "role trust must require the STS audience");
    // GitHub puts the caller's workflow path in sub. STS also maps the repository ID and ref.
    assert.equal(conditions[`${ISSUER}:sub`], inputs.expectedSubject, "role trust must require the exact immutable workflow subject");
    assert.equal(conditions[`${ISSUER}:repository_id`], inputs.repositoryId, "role trust must require the immutable repository ID");
    assert.equal(conditions[`${ISSUER}:ref`], REF, "role trust must require refs/heads/main");
  }
}

function stackResources(inputs, stackName) {
  return aws(inputs, "cloudformation", "list-stack-resources", ["--stack-name", stackName])
    .StackResourceSummaries ?? [];
}

function active(resource) {
  return !String(resource.ResourceStatus ?? "").startsWith("DELETE_");
}

function requireCompleteStack(stack, name, label) {
  assert.ok(stack, `${label} stack ${name} was not found`);
  assert.equal(stack.StackName, name);
  assert.match(stack.StackStatus, /^(CREATE_COMPLETE|UPDATE_COMPLETE|IMPORT_COMPLETE)$/);
}

test("local checks reject misdirected targets and broadened OIDC trust", () => {
  assert.equal(getInputs(SAMPLE_ENV).expectedSubject, SAMPLE_ENV.PHASE0_EXPECTED_OIDC_SUBJECT);
  assert.throws(() => getInputs({ ...SAMPLE_ENV, PHASE0_AWS_REGION: "us-west-2" }), /region must be us-east-1/);
  assert.throws(() => getInputs({ ...SAMPLE_ENV, PHASE0_AWS_ACCOUNT_ID: "123456789012" }), /account must be 027224425948/);
  assert.throws(() => getInputs({ ...SAMPLE_ENV, PHASE0_GITHUB_REPOSITORY: "other/example" }), /repository must be guilleojeda\/evaluations-ref-arch/);
  assert.throws(() => getInputs({ ...SAMPLE_ENV, PHASE0_AWS_PROFILE: "default" }), /profile must be reinvent-2026-talk/);

  const inputs = getInputs(SAMPLE_ENV);
  const providerArn = expectedProvider(inputs);
  const policy = { Statement: [{
    Effect: "Allow",
    Principal: { Federated: providerArn },
    Action: "sts:AssumeRoleWithWebIdentity",
    Condition: { StringEquals: {
      [`${ISSUER}:aud`]: AUDIENCE,
      [`${ISSUER}:sub`]: inputs.expectedSubject,
      [`${ISSUER}:repository_id`]: inputs.repositoryId,
      [`${ISSUER}:ref`]: REF,
    } },
  }] };
  const repo = { owner: { id: TARGET_OWNER_ID } };
  assert.equal(validateSubjectCustomization({ use_default: false, use_immutable_subject: true, include_claim_keys: ["repo", "workflow_ref"] }, repo, inputs), inputs.expectedSubject);
  validateRoleTrust(policy, inputs, providerArn);
  assert.throws(() => validateRoleTrust({ Statement: [...policy.Statement, { Effect: "Allow", Principal: { AWS: "*" }, Action: "sts:AssumeRole" }] }, inputs, providerArn), /every role trust grant/);
  assert.throws(() => validateRoleTrust({ Statement: [{ ...policy.Statement[0], Condition: { StringEquals: { ...policy.Statement[0].Condition.StringEquals, [`${ISSUER}:aud`]: "wrong-audience" } } }] }, inputs, providerArn), /STS audience/);
  assert.throws(() => validateRoleTrust({ Statement: [{ ...policy.Statement[0], Condition: { StringEquals: { ...policy.Statement[0].Condition.StringEquals, [`${ISSUER}:sub`]: "repo:wrong" } } }] }, inputs, providerArn), /exact immutable workflow subject/);
  assert.throws(() => validateRoleTrust({ Statement: [{ ...policy.Statement[0], Condition: { StringEquals: { ...policy.Statement[0].Condition.StringEquals, [`${ISSUER}:sub`]: inputs.expectedSubject.replace(REF, "refs/heads/feature") } } }] }, inputs, providerArn), /exact immutable workflow subject/);
  assert.throws(() => validateRoleTrust({ Statement: [{ ...policy.Statement[0], Condition: { StringEquals: { ...policy.Statement[0].Condition.StringEquals, [`${ISSUER}:ref`]: "refs/heads/feature" } } }] }, inputs, providerArn), /refs\/heads\/main/);
  assert.throws(() => validateSubjectCustomization({ use_default: false, use_immutable_subject: true, include_claim_keys: ["repo"] }, repo, inputs), /subject customization/);
});

const liveEnabled = process.env.PHASE0_LIVE === "1";
let inputs;
let repo;
let providerArn;

describe("Phase 0 read-only AWS and GitHub acceptance", {
  skip: liveEnabled ? false : "Set PHASE0_LIVE=1 and the PHASE0_* target inputs to enable live reads.",
}, () => {
  before(() => {
    inputs = getInputs(process.env);

    // Verify the selected account/caller and immutable repository ID before reading target resources.
    const caller = aws(inputs, "sts", "get-caller-identity");
    assert.equal(caller.Account, inputs.accountId, "AWS caller account did not match PHASE0_AWS_ACCOUNT_ID");
    assert.equal(caller.Arn, inputs.callerArn, "AWS caller did not match PHASE0_EXPECTED_AWS_CALLER_ARN");

    repo = gh(`repos/${encodeURIComponent(inputs.owner)}/${encodeURIComponent(inputs.name)}`);
    assert.equal(String(repo.id), inputs.repositoryId, "GitHub repository ID did not match PHASE0_GITHUB_REPOSITORY_ID");
    assert.equal(repo.full_name, inputs.repository, "GitHub repository name did not match PHASE0_GITHUB_REPOSITORY");
    assert.equal(repo.default_branch, "main", "main must be the repository's default branch");
    providerArn = expectedProvider(inputs);
  });

  test("GitHub main has the permanent workflow and exact customized immutable subject", () => {
    const base = `repos/${encodeURIComponent(inputs.owner)}/${encodeURIComponent(inputs.name)}`;
    const files = gh(`${base}/contents/.github/workflows?ref=main`);
    assert.ok(files.some(({ type, path }) => type === "file" && path === WORKFLOW), `GitHub main must contain ${WORKFLOW}`);
    validateSubjectCustomization(gh(`${base}/actions/oidc/customization/sub`), repo, inputs);
  });

  test("GitHub OIDC provider and deploy role are scoped to this immutable workflow and branch", () => {
    const provider = aws(inputs, "iam", "get-open-id-connect-provider", ["--open-id-connect-provider-arn", providerArn]);
    assert.equal(String(provider.Url).replace(/^https:\/\//, "").replace(/\/$/, ""), ISSUER);
    assert.ok(provider.ClientIDList?.includes(AUDIENCE), "GitHub OIDC provider must register the STS audience");

    const roleName = inputs.deployRoleArn.split("/").at(-1);
    const role = aws(inputs, "iam", "get-role", ["--role-name", roleName]).Role;
    assert.equal(role?.Arn, inputs.deployRoleArn);
    validateRoleTrust(role?.AssumeRolePolicyDocument, inputs, providerArn);
  });

  test("CDK bootstrap owns the standard deployment and publishing role identities", () => {
    const stack = aws(inputs, "cloudformation", "describe-stacks", ["--stack-name", inputs.bootstrapStack]).Stacks?.[0];
    requireCompleteStack(stack, inputs.bootstrapStack, "CDK bootstrap");
    const resources = stackResources(inputs, inputs.bootstrapStack).filter(active);
    const roleNames = [
      `cdk-${inputs.qualifier}-deploy-role-${inputs.accountId}-${REGION}`,
      `cdk-${inputs.qualifier}-file-publishing-role-${inputs.accountId}-${REGION}`,
      `cdk-${inputs.qualifier}-cfn-exec-role-${inputs.accountId}-${REGION}`,
    ];
    for (const roleName of roleNames) {
      assert.ok(resources.some((resource) => resource.ResourceType === "AWS::IAM::Role" && resource.PhysicalResourceId === roleName), `CDK bootstrap must own ${roleName}`);
      const role = aws(inputs, "iam", "get-role", ["--role-name", roleName]).Role;
      assert.equal(role?.Arn, `arn:aws:iam::${inputs.accountId}:role/${roleName}`);
    }
    const versionName = `/cdk-bootstrap/${inputs.qualifier}/version`;
    const marker = aws(inputs, "ssm", "get-parameter", ["--name", versionName]).Parameter;
    assert.equal(marker?.Name, versionName);
    assert.match(marker?.Value ?? "", /^\d+$/);
    assert.ok(Number(marker.Value) > 0);
  });

});
