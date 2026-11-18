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
const releaseRef = 'refs/heads/demo-deploy';
const mainRef = 'refs/heads/main';
const probeTagRef = 'refs/tags/phase12-oidc-proof';
const deployWorkflow = '.github/workflows/deploy.yml';
const negativeWorkflow = '.github/workflows/oidc-negative.yml';
const deployRoleArn = `arn:aws:iam::${targetAccount}:role/IncidentTriageDemoGitHubDeploy`;
const evaluationRoleArn = `arn:aws:iam::${targetAccount}:role/IncidentTriageDemoGitHubEvaluation`;
const immutableRepository = `repo:guilleojeda@18320860/evaluations-ref-arch@${targetRepositoryId}:workflow_ref:`;
const expectedSubject = `${immutableRepository}${targetRepository}/${deployWorkflow}@${releaseRef}`;
const negativeRefs = { 'wrong-branch': mainRef, 'wrong-tag': probeTagRef };
const probe = process.env.PHASE0_OIDC_CASE;

function expectedRoleForEnvironment(environment) {
  if (environment === 'demo-evaluation') return evaluationRoleArn;
  return deployRoleArn;
}

function input(name) {
  const value = process.env[name];
  assert.ok(value, `Missing ${name}`);
  return value;
}

function validateRunnerIdentity(context, env) {
  const { probe, repository, repositoryId, account, region, roleArn, environment, ref, workflowRef, subject } = context;
  assert.equal(repository, targetRepository, `OIDC probe must target ${targetRepository}`);
  assert.equal(repositoryId, targetRepositoryId, `OIDC probe must target repository ID ${targetRepositoryId}`);
  assert.equal(account, targetAccount, `OIDC probe must target AWS account ${targetAccount}`);
  assert.equal(region, targetRegion, `OIDC probe must target ${targetRegion}`);
  assert.equal(roleArn, expectedRoleForEnvironment(environment),
    'OIDC proof must target the role trusted by this fixed GitHub environment');
  assert.ok(['demo-infrastructure', 'demo-evaluation'].includes(environment),
    'OIDC proof must target a fixed workflow environment');
  assert.equal(subject, expectedSubject, 'Expected subject must refer to the exact publishing workflow');
  assert.equal(ref, negativeRefs[probe] ?? releaseRef);
  assert.equal(workflowRef, `${repository}/${probe === 'wrong-workflow' ? negativeWorkflow : deployWorkflow}@${ref}`);
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.equal(env.GITHUB_REF, ref);
  assert.equal(env.GITHUB_WORKFLOW_REF, workflowRef);
  assert.equal(env.PHASE0_OIDC_ENVIRONMENT, environment);
  const eventName = env.GITHUB_EVENT_NAME;
  assert.ok(['push', 'workflow_dispatch'].includes(eventName), 'OIDC deployment probe requires push or workflow_dispatch');
  return eventName;
}

function validateTokenIdentity(context, claims) {
  const { probe, repository, repositoryId, subject, environment, ref, workflowRef, eventName } = context;
  assert.equal(claims.iss, 'https://token.actions.githubusercontent.com');
  assert.equal(claims.aud, audience);
  assert.equal(claims.repository, repository);
  assert.equal(String(claims.repository_id), repositoryId);
  assert.equal(claims.environment, environment, 'OIDC token must carry the role-bound GitHub environment');
  assert.equal(claims.ref, ref);
  assert.equal(claims.workflow_ref, workflowRef);
  assert.equal(claims.event_name, eventName, 'Token event_name must match the verified runner event');
  assert.equal(claims.sub, `${immutableRepository}${workflowRef}`,
    'GitHub subject must match the immutable repository and exact workflow file and ref');
  if (probe === 'allowed') assert.equal(claims.sub, subject);
  else {
    assert.notEqual(claims.sub, subject, 'A wrong ref or workflow must change the immutable subject');
    if (Object.hasOwn(negativeRefs, probe)) {
      assert.notEqual(claims.ref, releaseRef, 'Wrong-ref proof requires a different ref claim');
      assert.equal(claims.workflow_ref, `${repository}/${deployWorkflow}@${ref}`);
    } else {
      assert.equal(claims.ref, releaseRef);
      assert.notEqual(claims.workflow_ref, `${repository}/${deployWorkflow}@${releaseRef}`, 'Wrong-workflow probe must issue a different workflow_ref claim');
    }
  }
}

function identityFixture(eventName = 'push', probe = 'allowed', roleArn = deployRoleArn, environment = 'demo-infrastructure') {
  const ref = negativeRefs[probe] ?? releaseRef;
  const workflow = probe === 'wrong-workflow' ? negativeWorkflow : deployWorkflow;
  const workflowRef = `${targetRepository}/${workflow}@${ref}`;
  return {
    context: {
      probe, repository: targetRepository, repositoryId: targetRepositoryId,
      account: targetAccount, region: targetRegion,
      roleArn, environment,
      subject: expectedSubject,
      ref, workflowRef, eventName,
    },
    env: {
      GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: targetRepository,
      GITHUB_REF: ref, GITHUB_WORKFLOW_REF: workflowRef, GITHUB_EVENT_NAME: eventName,
      PHASE0_OIDC_ENVIRONMENT: environment,
    },
    claims: {
      iss: 'https://token.actions.githubusercontent.com', aud: audience,
      repository: targetRepository, repository_id: targetRepositoryId,
      environment, ref, workflow_ref: workflowRef, event_name: eventName,
      sub: `${immutableRepository}${workflowRef}`,
    },
  };
}

for (const eventName of ['push', 'workflow_dispatch']) {
  test(`offline OIDC validation accepts ${eventName} from the exact demo-deploy workflow`, () => {
    const { context, env, claims } = identityFixture(eventName);
    assert.equal(validateRunnerIdentity(context, env), eventName);
    validateTokenIdentity(context, claims);
  });
}

test('offline OIDC validation accepts the isolated evaluation environment role', () => {
  const { context, env, claims } = identityFixture(
    'workflow_dispatch', 'allowed', evaluationRoleArn, 'demo-evaluation',
  );
  assert.equal(validateRunnerIdentity(context, env), 'workflow_dispatch');
  validateTokenIdentity(context, claims);
  assert.equal(context.roleArn, evaluationRoleArn);
  assert.equal(context.environment, 'demo-evaluation');
});

test('offline OIDC validation rejects other runner events and mismatched token events', () => {
  const { context, env, claims } = identityFixture('workflow_dispatch');
  for (const eventName of ['pull_request', 'pull_request_target', 'workflow_call', 'repository_dispatch', 'schedule', undefined]) {
    assert.throws(() => validateRunnerIdentity(context, { ...env, GITHUB_EVENT_NAME: eventName }), /requires push or workflow_dispatch/);
    assert.throws(() => validateTokenIdentity(context, { ...claims, event_name: eventName }), /Token event_name must match/);
  }
  for (const eventName of ['push', 'workflow_dispatch']) {
    const fixture = identityFixture(eventName);
    const otherEvent = eventName === 'push' ? 'workflow_dispatch' : 'push';
    assert.throws(() => validateTokenIdentity(fixture.context, { ...fixture.claims, event_name: otherEvent }), /Token event_name must match/);
  }
});

test('offline manual OIDC validation preserves repository, workflow, release ref, audience and immutable subject checks', () => {
  const { context, env, claims } = identityFixture('workflow_dispatch');
  for (const [key, value] of [
    ['GITHUB_ACTIONS', 'false'], ['GITHUB_REPOSITORY', 'other/repository'],
    ['GITHUB_REF', 'refs/heads/feature'], ['GITHUB_WORKFLOW_REF', `${targetRepository}/${negativeWorkflow}@${mainRef}`],
  ]) {
    assert.throws(() => validateRunnerIdentity(context, { ...env, [key]: value }), assert.AssertionError, key);
  }
  for (const [key, value] of [
    ['iss', 'https://other.example'], ['aud', 'other-audience'],
    ['repository', 'other/repository'], ['repository_id', '123'],
    ['ref', 'refs/heads/feature'], ['workflow_ref', `${targetRepository}/${negativeWorkflow}@${mainRef}`],
    ['sub', claims.sub.replace('guilleojeda@18320860', 'guilleojeda')],
    ['sub', claims.sub.replace(targetRepositoryId, '123')],
    ['sub', claims.sub.replace(deployWorkflow, negativeWorkflow)],
    ['sub', claims.sub.replace(releaseRef, mainRef)],
  ]) {
    assert.throws(() => validateTokenIdentity(context, { ...claims, [key]: value }), assert.AssertionError, key);
  }
});

test('offline negative OIDC probes require distinct main, tag or alternate-workflow identities before native STS denial', () => {
  const allowed = identityFixture();
  for (const [probe, eventName] of [['wrong-branch', 'workflow_dispatch'], ['wrong-tag', 'workflow_dispatch'], ['wrong-workflow', 'push']]) {
    const { context, env, claims } = identityFixture(eventName, probe);
    assert.equal(validateRunnerIdentity(context, env), eventName);
    validateTokenIdentity(context, claims);
    assert.notEqual(claims.sub, allowed.claims.sub);
    assert.throws(() => validateTokenIdentity(context, allowed.claims), assert.AssertionError);
    assert.throws(() => validateTokenIdentity(allowed.context, claims), assert.AssertionError);
  }
});

test('GitHub issues the expected identity and STS enforces the deployment boundary', {
  skip: probe ? false : 'Run in GitHub Actions with PHASE0_OIDC_CASE and the required OIDC context set',
  timeout: 45_000,
}, async () => {
  assert.ok(['allowed', ...Object.keys(negativeRefs), 'wrong-workflow'].includes(probe), 'Invalid OIDC probe');
  const repository = input('PHASE0_GITHUB_REPOSITORY');
  const repositoryId = input('PHASE0_GITHUB_REPOSITORY_ID');
  const account = input('PHASE0_AWS_ACCOUNT_ID');
  const region = input('PHASE0_AWS_REGION');
  const roleArn = input('PHASE0_OIDC_ROLE_ARN');
  const environment = input('PHASE0_OIDC_ENVIRONMENT');
  const subject = input('PHASE0_EXPECTED_OIDC_SUBJECT');
  const ref = negativeRefs[probe] ?? releaseRef;
  const workflow = probe === 'wrong-workflow' ? negativeWorkflow : deployWorkflow;
  const workflowRef = `${repository}/${workflow}@${ref}`;

  const context = { probe, repository, repositoryId, account, region, roleArn, environment, subject, ref, workflowRef };
  const eventName = validateRunnerIdentity(context, process.env);

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
  validateTokenIdentity({ ...context, eventName }, claims);

  const directory = mkdtempSync(join(tmpdir(), 'phase0-oidc-'));
  const sessionName = `phase0-${probe}-${input('GITHUB_RUN_ID')}`;
  try {
    const tokenFile = join(directory, 'identity');
    writeFileSync(tokenFile, token, { mode: 0o600, flag: 'wx' });
    const stsArguments = (targetRoleArn, targetSessionName) => [
      'sts', 'assume-role-with-web-identity', '--no-sign-request',
      '--region', targetRegion, '--endpoint-url', `https://sts.${targetRegion}.amazonaws.com`,
      '--role-arn', targetRoleArn, '--role-session-name', targetSessionName,
      '--web-identity-token', `file://${tokenFile}`,
      // The verification session has no permissions even if a denial check unexpectedly succeeds.
      '--duration-seconds', '900',
      '--policy', '{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":"*","Resource":"*"}]}',
      '--query', 'AssumedRoleUser.Arn', '--output', 'text',
    ];
    const runSts = (targetRoleArn, targetSessionName) => spawnSync('aws', stsArguments(targetRoleArn, targetSessionName), {
      encoding: 'utf8',
      env: { ...process.env, AWS_PAGER: '', AWS_MAX_ATTEMPTS: '1' },
      timeout: 20_000,
    });
    const result = runSts(roleArn, sessionName);
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
    if (probe === 'allowed' && environment === 'demo-evaluation') {
      const deniedRoleArns = input('PHASE0_DENIED_OIDC_ROLE_ARNS').split(',').filter(Boolean);
      const repairedPublisherRoleArn = `arn:aws:iam::${targetAccount}:role/IncidentTriageDemoGitHubRepairedPublisher`;
      assert.deepEqual(deniedRoleArns.sort(), [deployRoleArn, repairedPublisherRoleArn].sort(),
        'Evaluation OIDC denial probes must target only the legacy and repaired publisher roles');
      for (const deniedRoleArn of deniedRoleArns) {
        const denied = runSts(deniedRoleArn, `${sessionName}-denied`);
        assert.ok(denied.status > 0, `Evaluation WebIdentity must not assume ${deniedRoleArn}`);
        assert.ok(/\(AccessDenied\).*AssumeRoleWithWebIdentity/.test(denied.stderr),
          'Expected AccessDenied for the evaluation WebIdentity denial probe');
      }
    }
    console.log(`Verified ${probe} STS outcome for ${workflowRef} in run ${process.env.GITHUB_RUN_ID}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
