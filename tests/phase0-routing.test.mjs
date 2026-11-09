import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const selector = fileURLToPath(new URL('../scripts/affected-stacks.mjs', import.meta.url));

test('the CI selector identifies component, shared, and documentation changes across revisions', (t) => {
  assert.ok(existsSync(selector), 'scripts/affected-stacks.mjs is missing');
  const repository = mkdtempSync(join(tmpdir(), 'demo-ci-routing-'));
  t.after(() => rmSync(repository, { recursive: true, force: true }));

  const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  git('init', '--quiet');

  function commit(path) {
    const destination = join(repository, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, `${path}\n`);
    git('add', path);
    git('-c', 'user.name=CI fixture', '-c', 'user.email=ci@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--no-verify', '-m', path);
    return git('rev-parse', 'HEAD');
  }

  function affected(base, candidate) {
    const output = execFileSync(process.execPath, [selector, base, candidate], {
      cwd: repository,
      encoding: 'utf8',
    });
    return JSON.parse(output).sort();
  }

  const baseline = commit('README.md');
  const docs = commit('docs/example.md');
  const componentDocs = commit('agent/README.md');
  const app = commit('app/web/café.tsx');
  const controller = commit('controller/api/example.ts');
  const agent = commit('agent/example.py');
  const agentStack = commit('infrastructure/agent/example.ts');
  const shared = commit('package-lock.json');
  const agentRelease = commit('scripts/finalize-agent.py');
  const appRelease = commit('scripts/deploy-app.sh');
  const controllerRelease = commit('scripts/deploy-controller.sh');

  assert.deepEqual(affected(baseline, docs), []);
  assert.deepEqual(affected(docs, componentDocs), []);
  assert.deepEqual(affected(componentDocs, app), ['app']);
  assert.deepEqual(affected(app, controller), ['controller']);
  assert.deepEqual(affected(controller, agent), ['agent']);
  assert.deepEqual(affected(agent, agentStack), ['agent']);
  assert.deepEqual(affected(agentStack, shared), ['agent', 'app', 'controller']);
  assert.deepEqual(affected(shared, agentRelease), ['agent']);
  assert.deepEqual(affected(agentRelease, appRelease), ['app']);
  assert.deepEqual(affected(appRelease, controllerRelease), ['controller']);
  assert.deepEqual(affected(baseline, controller), ['app', 'controller'],
    'an earlier relevant change remains visible when comparing with the last successful revision');
});
