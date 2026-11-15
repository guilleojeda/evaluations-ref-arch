import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
const githubIam = readFileSync(new URL('../infrastructure/bootstrap/github-iam.yaml', import.meta.url), 'utf8');
const bootstrapReadme = readFileSync(new URL('../infrastructure/bootstrap/README.md', import.meta.url), 'utf8');

const trigger = workflow.match(/^on:\n([\s\S]*?)\n^env:/m)?.[1] ?? '';

function job(name) {
  const match = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+: *$|(?![\\s\\S]))`, 'm'));
  assert.ok(match, `workflow is missing the ${name} job`);
  return match[1];
}

const route = job('route');
const check = job('check');
const deploy = job('deploy');
const releaseRefEquality = /github\.ref\s*==\s*['"]refs\/heads\/demo-deploy['"]/;

const requireMatch = (value, pattern, message) => {
  if (!pattern.test(value)) assert.fail(message);
};

const requireAbsent = (value, pattern, message) => {
  if (pattern.test(value)) assert.fail(message);
};

test('cloud workflow publishes from demo-deploy while main remains a checked offline branch', () => {
  const pushIndex = trigger.indexOf('  push:\n');
  assert.notEqual(pushIndex, -1, 'workflow must define a push trigger');
  const pushTrigger = trigger.slice(pushIndex);
  const pushBranches = [...pushTrigger.matchAll(/^\s+- (main|demo-deploy)\s*$/gm)].map((match) => match[1]);
  assert.deepEqual(new Set(pushBranches), new Set(['main', 'demo-deploy']),
    'push checks must still run on main and must also run on demo-deploy');
  requireMatch(check, /refs\/heads\/main/,
    'main needs its credential-free component checks');
  requireMatch(check, /refs\/heads\/demo-deploy/,
    'demo-deploy needs its component checks before publishing');
  requireAbsent(deploy, /refs\/heads\/main/,
    'main must not publish cloud stacks');
  requireMatch(deploy, releaseRefEquality,
    'only demo-deploy may publish cloud stacks');
  const uploadCondition = check.match(/^        if: (.+)\n        uses: actions\/upload-artifact@/m)?.[1] ?? '';
  requireMatch(uploadCondition, releaseRefEquality, 'checked release artifacts must only be uploaded on demo-deploy');
  requireAbsent(uploadCondition, /refs\/heads\/main|pull_request/, 'offline events must not upload release artifacts');
});

test('the deployment role trust is pinned to the demo-deploy workflow ref', () => {
  const subject = 'repo:guilleojeda@18320860/evaluations-ref-arch@1411023195:workflow_ref:guilleojeda/evaluations-ref-arch/.github/workflows/deploy.yml@refs/heads/demo-deploy';
  assert.ok(workflow.includes(`PHASE0_EXPECTED_OIDC_SUBJECT: ${subject}`),
    'workflow expected OIDC subject must pin the exact immutable repo, workflow and ref');
  requireAbsent(workflow, /PHASE0_EXPECTED_OIDC_SUBJECT:\s*.*refs\/heads\/main/,
    'workflow must not pin the old main release ref');
  requireMatch(githubIam, /token\.actions\.githubusercontent\.com:aud:\s*sts\.amazonaws\.com/,
    'role trust must require the GitHub Actions audience');
  requireMatch(githubIam, /token\.actions\.githubusercontent\.com:repository_id:\s*\n?\s*['"]?1411023195/,
    'role trust must require the immutable repository ID');
  assert.ok(githubIam.includes(`token.actions.githubusercontent.com:sub: ${subject}`),
    'the role trust must require the exact immutable repo, workflow and ref');
  requireMatch(githubIam, /token\.actions\.githubusercontent\.com:ref:\s*refs\/heads\/demo-deploy/,
    'the role trust must require the full release branch ref');
  requireAbsent(githubIam, /workflow_ref:[^\n]*refs\/heads\/main/,
    'the deployment role must not keep the old main workflow-ref trust');
  assert.ok(bootstrapReadme.includes(subject),
    'bootstrap instructions must match the applied trust contract');
  requireAbsent(bootstrapReadme, /workflow_ref:[^\n]*refs\/heads\/main/,
    'bootstrap instructions must not preserve the old release branch');
});

test('pull requests and main do not acquire cloud deployment credentials', () => {
  requireMatch(check, /permissions:\n\s+contents: read/, 'checks must have read-only repository permissions');
  requireMatch(check, /github\.event_name\s*==\s*['"]pull_request['"]/, 'PRs must retain credential-free checks');
  requireAbsent(check, /id-token:\s*write/, 'checks must not request cloud identity tokens');
  requireMatch(deploy, /permissions:\n\s+contents: read\n\s+id-token: write/, 'publish jobs must request OIDC only in the deploy job');
  requireMatch(deploy, /github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'/,
    'publish jobs must be limited to push or explicit dispatch');
  requireMatch(deploy, releaseRefEquality,
    'publish jobs must be limited to demo-deploy');
});

test('manual component dispatch stays independent and preserves rotation inputs', () => {
  for (const component of ['app', 'controller', 'agent']) {
    requireMatch(trigger, new RegExp(`- ${component}`), `${component} must remain dispatchable independently`);
  }
  requireMatch(trigger, /rotation_from_generation:/, 'Phase 11 app rotation input must remain available');
  requireMatch(trigger, /rotation_to_generation:/, 'Phase 11 app rotation input must remain available');
  requireMatch(route, /DISPATCH_ROTATION_FROM/, 'route must receive the rotation predecessor input');
  requireMatch(route, /DISPATCH_ROTATION_TO/, 'route must receive the rotation target input');
  requireMatch(deploy, /APP_ROTATION_FROM_GENERATION: \$\{\{ needs\.route\.outputs\.rotation_from_generation \}\}/,
    'app deploy must receive the rotation predecessor output');
  requireMatch(deploy, /APP_ROTATION_TO_GENERATION: \$\{\{ needs\.route\.outputs\.rotation_to_generation \}\}/,
    'app deploy must receive the rotation target output');
  requireAbsent(deploy, /CONTROLLER_ROTATION_(FROM|TO)_GENERATION/,
    'controller deploy must not receive app-only rotation inputs');
  requireAbsent(deploy, /AGENT_ROTATION_(FROM|TO)_GENERATION/,
    'agent deploy must not receive app-only rotation inputs');
});

test('the workflow has no tag-triggered or arbitrary-branch cloud path', () => {
  requireAbsent(trigger, /^    tags:/m, 'tag pushes must not trigger a cloud release');
  requireMatch(deploy, releaseRefEquality,
    'cloud publishing must require demo-deploy');
  requireAbsent(deploy, /refs\/heads\/main/,
    'cloud publishing must reject main');
  requireMatch(workflow, /permissions:\n\s+contents: read/,
    'workflow must keep repository read permission as its default');
});
