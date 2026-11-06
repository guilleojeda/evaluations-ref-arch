import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const audience = 'sts.amazonaws.com';
const targetAccount = '027224425948';
const targetRepository = 'guilleojeda/evaluations-ref-arch';
const targetRepositoryId = '1411023195';
const targetRegion = 'us-east-1';
const mainRef = 'refs/heads/main';
const deployWorkflow = '.github/workflows/deploy.yml';
const negativeWorkflow = '.github/workflows/oidc-negative.yml';
const probe = process.env.PHASE0_OIDC_CASE;

function input(name) {
  const value = process.env[name];
  assert.ok(value, `Missing ${name}`);
  return value;
}

test('GitHub issues the expected identity and STS enforces the deployment boundary', {
  skip: probe ? false : 'Run from a Phase 0 GitHub Actions push probe with PHASE0_OIDC_CASE set',
  timeout: 45_000,
}, async () => {
  assert.ok(['allowed', 'wrong-branch', 'wrong-workflow'].includes(probe), 'Invalid Phase 0 probe');
  const repository = input('PHASE0_GITHUB_REPOSITORY');
  const repositoryId = input('PHASE0_GITHUB_REPOSITORY_ID');
  const account = input('PHASE0_AWS_ACCOUNT_ID');
  const region = input('PHASE0_AWS_REGION');
  const roleArn = input('PHASE0_DEPLOY_ROLE_ARN');
  const subject = input('PHASE0_EXPECTED_OIDC_SUBJECT');
  const ref = probe === 'wrong-branch' ? input('PHASE0_OIDC_PROBE_REF') : mainRef;
  const workflow = probe === 'wrong-workflow' ? negativeWorkflow : deployWorkflow;
  const workflowRef = `${repository}/${workflow}@${ref}`;

  assert.equal(repository, targetRepository, `OIDC probe must target ${targetRepository}`);
  assert.equal(repositoryId, targetRepositoryId, `OIDC probe must target repository ID ${targetRepositoryId}`);
  assert.equal(account, targetAccount, `OIDC probe must target AWS account ${targetAccount}`);
  assert.equal(region, targetRegion, `OIDC probe must target ${targetRegion}`);
  assert.ok(roleArn.startsWith(`arn:aws:iam::${account}:role/`), 'Deploy role must belong to the confirmed account');
  assert.match(ref, /^refs\/heads\/.+$/);
  if (probe === 'wrong-branch') assert.notEqual(ref, mainRef);
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  assert.equal(process.env.GITHUB_REF, ref);
  assert.equal(process.env.GITHUB_WORKFLOW_REF, workflowRef);
  assert.equal(process.env.GITHUB_EVENT_NAME, 'push');

  const issuerRequest = new URL(input('ACTIONS_ID_TOKEN_REQUEST_URL'));
  assert.equal(issuerRequest.protocol, 'https:');
  assert.ok(issuerRequest.hostname.endsWith('.actions.githubusercontent.com'), 'Unexpected GitHub token endpoint');
  issuerRequest.searchParams.set('audience', audience);
  const issued = await fetch(issuerRequest, {
    headers: { Authorization: `Bearer ${input('ACTIONS_ID_TOKEN_REQUEST_TOKEN')}` },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  assert.ok(issued.ok, `GitHub token request returned ${issued.status}`);
  const { value: token } = await issued.json();
  assert.ok(typeof token === 'string' && token.split('.').length === 3, 'Expected a GitHub JWT');
  let claims;
  try {
    claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    assert.fail('GitHub JWT payload could not be decoded');
  }
  assert.equal(claims.iss, 'https://token.actions.githubusercontent.com');
  assert.equal(claims.aud, audience);
  assert.equal(claims.repository, repository);
  assert.equal(String(claims.repository_id), repositoryId);
  assert.equal(claims.ref, ref);
  assert.equal(claims.workflow_ref, workflowRef);
  assert.equal(claims.event_name, 'push');
  assert.ok(claims.sub?.startsWith(`repo:guilleojeda@18320860/evaluations-ref-arch@${targetRepositoryId}:workflow_ref:`), 'GitHub subject is missing the immutable repository identity');
  assert.ok(claims.sub?.includes(`workflow_ref:${workflowRef}`), 'GitHub subject is missing the exact workflow file and ref');
  if (probe === 'allowed') assert.equal(claims.sub, subject);
  else {
    assert.notEqual(claims.sub, subject, 'A wrong branch or workflow must change the immutable subject');
    if (probe === 'wrong-branch') {
      assert.notEqual(claims.ref, mainRef, 'Wrong-branch probe must issue a different ref claim');
      assert.equal(claims.workflow_ref, `${repository}/${deployWorkflow}@${ref}`);
    } else {
      assert.equal(claims.ref, mainRef);
      assert.notEqual(claims.workflow_ref, `${repository}/${deployWorkflow}@${mainRef}`, 'Wrong-workflow probe must issue a different workflow_ref claim');
    }
  }

  const directory = mkdtempSync(join(tmpdir(), 'phase0-oidc-'));
  const sessionName = `phase0-${probe}-${input('GITHUB_RUN_ID')}`;
  try {
    const tokenFile = join(directory, 'identity');
    writeFileSync(tokenFile, token, { mode: 0o600, flag: 'wx' });
    const result = spawnSync('aws', [
      'sts', 'assume-role-with-web-identity', '--no-sign-request',
      '--region', targetRegion, '--endpoint-url', `https://sts.${targetRegion}.amazonaws.com`,
      '--role-arn', roleArn, '--role-session-name', sessionName,
      '--web-identity-token', `file://${tokenFile}`,
      '--query', 'AssumedRoleUser.Arn', '--output', 'text',
    ], {
      encoding: 'utf8',
      env: { ...process.env, AWS_PAGER: '', AWS_MAX_ATTEMPTS: '1' },
      timeout: 20_000,
    });
    assert.ok(!result.error && result.status !== null, 'AWS CLI did not return an STS result');
    if (probe === 'allowed') {
      assert.equal(result.status, 0, 'The designated workflow must be able to assume the deployment role');
      const roleName = roleArn.split('/').at(-1);
      assert.ok(result.stdout.trim() === `arn:aws:sts::${account}:assumed-role/${roleName}/${sessionName}`,
        'STS did not return the expected deployment role session');
    } else {
      assert.ok(result.status > 0, 'This identity must not be able to assume the deployment role');
      assert.ok(/\(AccessDenied\).*AssumeRoleWithWebIdentity/.test(result.stderr),
        'Expected STS AccessDenied for AssumeRoleWithWebIdentity, rather than a token, CLI, or network error');
    }
    console.log(`Verified ${probe} STS outcome for ${workflowRef} in run ${process.env.GITHUB_RUN_ID}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
