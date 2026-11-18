import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');

test('both selector promotions use the ordinary push routes and a mixed prompt change still requires qualification', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'agent-selection-promotions-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const outputDir = mkdtempSync(join(tmpdir(), 'selector-route-output-'));
  t.after(() => rmSync(outputDir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Release fixture');
  git('config', 'user.email', 'release@example.invalid');
  mkdirSync(join(repo, 'scripts'));
  copyFileSync(new URL('../scripts/affected-stacks.mjs', import.meta.url), join(repo, 'scripts/affected-stacks.mjs'));

  function commit(files) {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), content);
    }
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'promotion fixture');
    return git('rev-parse', 'HEAD');
  }

  function pushRoute(base, head) {
    const shell = workflow.match(/      - name: Select changed components[\s\S]*?\n        run: \|\n((?:          [^\n]*\n|\n)+)/)[1]
      .replace(/^ {10}/gm, '')
      .replaceAll('${{ github.event_name }}', 'push')
      .replaceAll('${{ github.event.before }}', base)
      .replaceAll('${{ github.ref }}', 'refs/heads/demo-deploy')
      .replaceAll('${{ github.sha }}', head);
    const outputFile = join(outputDir, head);
    execFileSync('bash', ['-euo', 'pipefail', '-c', shell], {
      cwd: repo, env: { ...process.env, GITHUB_OUTPUT: outputFile, GITHUB_SHA: head },
    });
    return Object.fromEntries(readFileSync(outputFile, 'utf8').trim().split('\n').map((line) => {
      const split = line.indexOf('=');
      return [line.slice(0, split), line.slice(split + 1)];
    }));
  }

  const initial = commit({ 'agent/prompt.py': 'faulty source' });
  const feature = commit({
    'agent/alarm_adapter.py': 'route from selection',
    'infrastructure/agent/stack.ts': 'selector settings and legacy env',
    'controller/src/backend.ts': 'authenticated selection',
    'tests/phase21-agent-selection.test.mjs': 'selector tests',
  });
  const mixed = pushRoute(initial, feature);
  assert.ok(JSON.parse(mixed.deploy_components).includes('controller'));
  assert.ok(!JSON.parse(mixed.deploy_components).includes('agent'));
  assert.equal(mixed.qualification_required, 'true');
  assert.equal(mixed.reference_setup, 'false');

  const cleanup = commit({ 'infrastructure/agent/stack.ts': 'selector settings only' });
  const infra = pushRoute(feature, cleanup);
  assert.deepEqual(JSON.parse(infra.deploy_components), ['agent']);
  assert.equal(infra.agent_infrastructure_only, 'true');
  assert.equal(infra.qualification_required, 'false');
  assert.equal(infra.reconcile_after_gate, 'false');
  assert.equal(infra.reference_setup, 'false');

  const newPrompt = commit({ 'agent/prompt.py': 'changed candidate' });
  const withPrompt = pushRoute(feature, newPrompt);
  assert.equal(withPrompt.agent_infrastructure_only, 'false');
  assert.equal(withPrompt.qualification_required, 'true');
  assert.ok(!JSON.parse(withPrompt.deploy_components).includes('agent'));
});
