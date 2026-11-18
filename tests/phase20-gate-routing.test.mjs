import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
const selector = new URL('../scripts/affected-stacks.mjs', import.meta.url).pathname;
const githubIam = readFileSync(new URL('../infrastructure/bootstrap/github-iam.yaml', import.meta.url), 'utf8');
const demoRef = 'refs/heads/demo-deploy';

function jobs() {
  const lines = workflow.split('\n');
  const starts = lines.flatMap((line, index) => {
    const match = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    return match ? [{ name: match[1], index }] : [];
  });
  return Object.fromEntries(starts.map(({ name, index }, offset) => [
    name,
    lines.slice(index, starts[offset + 1]?.index ?? lines.length).join('\n'),
  ]));
}

function requireMatch(value, pattern, message) {
  assert.match(value, pattern, message);
}

function requireAbsent(value, pattern, message) {
  assert.doesNotMatch(value, pattern, message);
}

function routeScript() {
  const match = workflow.match(/      - name: Select changed components\n[\s\S]*?\n        run: \|\n([\s\S]*?)(?=^      - name:)/m);
  assert.ok(match, 'workflow must expose its route shell');
  return match[1].replace(/^ {10}/gm, '');
}

function runAgentDispatch() {
  const directory = mkdtempSync(join(tmpdir(), 'phase20-route-'));
  const output = join(directory, 'route-output');
  const rendered = routeScript()
    .replaceAll('${{ github.event_name }}', 'workflow_dispatch')
    .replaceAll('${{ github.ref }}', demoRef)
    .replaceAll('${{ github.sha }}', 'a'.repeat(40));
  const result = spawnSync('bash', ['-euo', 'pipefail', '-c', rendered], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: output, DISPATCH_COMPONENT: 'agent' },
  });
  const outputText = existsSync(output) ? readFileSync(output, 'utf8') : '';
  rmSync(directory, { recursive: true, force: true });
  return { result, outputText };
}

function makeRepository() {
  const directory = mkdtempSync(join(tmpdir(), 'phase20-affected-'));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Phase 20 fixture');
  git('config', 'user.email', 'phase20@example.invalid');
  const commit = (path) => {
    const destination = join(directory, path);
    execFileSync('mkdir', ['-p', destination.slice(0, destination.lastIndexOf('/'))]);
    writeFileSync(destination, `${path}\n`);
    git('add', path);
    git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '--no-verify', '-m', path);
    return git('rev-parse', 'HEAD');
  };
  const affected = (base, candidate) => JSON.parse(execFileSync(process.execPath, [selector, base, candidate], {
    cwd: directory,
    encoding: 'utf8',
  }));
  return { directory, commit, affected };
}

function needs(jobBody) {
  const line = jobBody.match(/^    needs:\s*(.*)$/m)?.[1]?.trim() ?? '';
  const inline = line.match(/[A-Za-z0-9_-]+/g) ?? [];
  const block = jobBody.match(/^    needs:\s*\n((?:      -\s*[A-Za-z0-9_-]+\s*\n)+)/m)?.[1] ?? '';
  return [...new Set([...inline, ...[...block.matchAll(/-\s*([A-Za-z0-9_-]+)/g)].map((match) => match[1])])];
}

function roleTargets(jobBody) {
  return [...jobBody.matchAll(/role-to-assume:\s*([^\n]+)|--role-arn\s+([^\s]+)/gi)]
    .map((match) => (match[1] ?? match[2]).replace(/["'`,)]/g, '').trim())
    .filter(Boolean);
}

function steps(jobBody) {
  return jobBody.split(/(?=^      - name:)/m).filter((block) => /^      - name:/m.test(block));
}

function stepIndex(jobBody, pattern) {
  return steps(jobBody).findIndex((block) => pattern.test(block));
}

function runStepIndex(jobBody, pattern) {
  return stepIndex(jobBody, new RegExp(`^\\s+run:[\\s\\S]*${pattern.source}`, pattern.flags.includes('i') ? 'im' : 'm'));
}

function buildJob() {
  const matches = Object.entries(jobs()).filter(([, body]) =>
    /ubuntu-24\.04-arm/.test(body) && /actions\/upload-artifact/.test(body));
  assert.equal(matches.length, 1, `expected one ARM64 artifact build, found ${matches.map(([name]) => name).join(', ')}`);
  return matches[0];
}

function gateJob(buildName) {
  const matches = Object.entries(jobs()).filter(([name, body]) =>
    name !== buildName
    && !/environment:\s*repaired-publication/.test(body)
    && !/matrix\.component/.test(body)
    && /actions\/download-artifact/.test(body)
    && /id-token:\s*write/.test(body)
    && needs(body).includes(buildName));
  assert.equal(matches.length, 1, `expected one non-publishing quality gate, found ${matches.map(([name]) => name).join(', ')}`);
  return matches[0];
}

function publicationJob(gateName) {
  const matches = Object.entries(jobs()).filter(([name, body]) =>
    /environment:\s*repaired-publication/.test(body) && needs(body).includes(gateName));
  assert.equal(matches.length, 1, `expected one protected publish job, found ${matches.map(([name]) => name).join(', ')}`);
  return matches[0];
}

test('normal agent dispatch and changed-file routing remain observable', () => {
  const dispatch = runAgentDispatch();
  assert.equal(dispatch.result.status, 0, dispatch.result.stderr);
  requireMatch(dispatch.outputText, /components=\["agent"\]/, 'agent dispatch must select only the agent component');
  requireMatch(dispatch.outputText, /operation=normal/, 'agent dispatch must select the normal operation');
  requireMatch(dispatch.outputText, /reference_setup=false/, 'agent dispatch must not select maintenance');
  requireMatch(routeScript(), /affected-stacks\.mjs/, 'pushes must use the changed-file selector');
});

test('documentation-only changes stay outside consumed runtime and evaluation inputs', () => {
  const repository = makeRepository();
  try {
    let previous = repository.commit('README.md');
    for (const [path, expected, message] of [
      ['docs/deployment.md', [], 'operator documentation is not a component input'],
      ['docs/evaluations.md', [], 'evaluation prose is not itself a model input'],
      ['agent/prompt.py', ['agent'], 'the packaged prompt is consumed at runtime'],
      ['agent/agent-manifest.json', ['agent'], 'the packaged identity manifest is consumed at runtime'],
      ['agent/reviewed_cases.py', ['agent'], 'reviewed cases are consumed by evaluation'],
      ['agent/deterministic_checks.py', ['agent'], 'the deterministic policy is consumed by evaluation'],
      ['tests/phase18_strands_experiment_test.py', ['app', 'controller', 'agent'], 'tests remain offline component-build inputs'],
    ]) {
      const candidate = repository.commit(path);
      assert.deepEqual(repository.affected(previous, candidate).sort(), expected.sort(), message);
      previous = candidate;
    }
  } finally {
    rmSync(repository.directory, { recursive: true, force: true });
  }
});

test('quality gate and protected publication use isolated roles, dependencies, and the pending artifact', () => {
  const [buildName, build] = buildJob();
  const [gateName, gate] = gateJob(buildName);
  const [publicationName, publication] = publicationJob(gateName);

  requireMatch(build, /runtime\.zip/, 'the ARM64 build must produce the Runtime ZIP');
  requireMatch(build, /actions\/upload-artifact/, 'the build must retain its checked artifact');
  requireAbsent(build, /id-token:\s*write|configure-aws-credentials|aws sts assume-role/i,
    'the ARM64 build must remain credential-free');

  requireMatch(gate, /actions\/download-artifact/, 'the gate must consume the checked artifact');
  requireMatch(gate, /(?:configure-aws-credentials|sts assume-role)/,
    'the gate must acquire an evaluation session');
  assert.ok(runStepIndex(gate, /(?:sha256sum|sha256|artifactSha256)/i) >= 0,
    'the gate must record package identity in an executed check');
  requireAbsent(gate, /continue-on-error:\s*true/i, 'machine rejection/incompleteness must fail the gate');
  const gateRoles = roleTargets(gate);
  const publicationRoles = roleTargets(publication);
  assert.ok(gateRoles.length > 0, 'the gate must identify its AWS role');
  assert.ok(publicationRoles.length > 0, 'the publisher must identify its AWS role');
  assert.ok(gateRoles.every((target) => !publicationRoles.includes(target)),
    'the evaluation session must not reuse the publishing role');
  requireAbsent(gate, /PHASE0_DEPLOY_ROLE_ARN|CDK_DEPLOY_ROLE_ARN|CDK_FILE_PUBLISHING_ROLE_ARN/,
    'the evaluation session must not assume the existing broad deployment roles');

  requireMatch(publication, /^    environment:\s*repaired-publication\s*$/m,
    'publication must use the native protected environment');
  requireMatch(publication, /actions\/download-artifact/, 'publication must consume the same-run artifact');
  requireAbsent(publication, /actions\/upload-artifact/, 'publication must not produce a replacement artifact');
  const downloadPosition = stepIndex(publication, /actions\/download-artifact/);
  const digestPosition = runStepIndex(publication, /(?:sha256sum|sha256|artifactSha256)/i);
  const credentialPosition = stepIndex(publication, /(?:configure-aws-credentials|sts assume-role)/);
  assert.ok(downloadPosition >= 0 && downloadPosition < digestPosition && digestPosition < credentialPosition,
    'publication must download and verify the pending artifact before publishing credentials');
  if (/always\(\)/.test(publication)) {
    requireMatch(publication, new RegExp(`needs\\.${gateName}\\.result\\s*==\\s*['"]success['"]`),
      'an always-running publisher must still require the gate result');
  }
  assert.notEqual(publicationName, gateName, 'protected publication must be a separate job');

  requireMatch(workflow, /PHASE0_EXPECTED_OIDC_SUBJECT:[^\n]*refs\/heads\/demo-deploy/,
    'the authoritative workflow identity must remain pinned to demo-deploy');
  requireMatch(githubIam, /token\.actions\.githubusercontent\.com:aud:\s*sts\.amazonaws\.com/,
    'OIDC trust must require the GitHub audience');
  requireMatch(githubIam, /token\.actions\.githubusercontent\.com:sub:[^\n]*refs\/heads\/demo-deploy/,
    'OIDC trust must require the trusted demo-deploy workflow subject');
  requireAbsent(githubIam, /workflow_ref:[^\n]*refs\/heads\/(?:main|master)/,
    'OIDC trust must not accept main or another branch');
});
