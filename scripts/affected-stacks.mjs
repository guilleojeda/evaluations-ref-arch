#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const [base, candidate] = process.argv.slice(2);

if (!base || !candidate || process.argv.length !== 4) {
  console.error('Usage: node scripts/affected-stacks.mjs <base> <candidate>');
  process.exit(2);
}

let changed;
try {
  changed = execFileSync(
    'git',
    ['diff', '--name-only', '--no-renames', '-z', base, candidate],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
} catch (error) {
  const detail = error?.stderr?.toString().trim();
  console.error(`Could not compare ${base} with ${candidate}${detail ? `: ${detail}` : '.'}`);
  process.exit(1);
}

const components = new Set();

function addAll() {
  components.add('app');
  components.add('controller');
  components.add('agent');
}

function componentPath(path, component) {
  return path === component || path.startsWith(`${component}/`)
    || path === `infrastructure/${component}`
    || path.startsWith(`infrastructure/${component}/`);
}

function documentationPath(path) {
  return /(?:^|\/)(?:README(?:\.[^/]*)?|[^/]+\.(?:md|mdx|rst|txt))$/i.test(path);
}

const componentScripts = new Map([
  ['scripts/deploy-app.sh', 'app'],
  ['scripts/check-app-change-set.mjs', 'app'],
  ['scripts/prepare-inventory-versions.mjs', 'app'],
  ['scripts/deploy-controller.sh', 'controller'],
  ['scripts/check-controller-change-set.mjs', 'controller'],
  ['scripts/deploy-agent.sh', 'agent'],
  ['scripts/check-agent-change-set.mjs', 'agent'],
  ['scripts/finalize-agent.py', 'agent'],
  ['scripts/phase0-agent-asset.mjs', 'agent'],
]);

for (const path of changed) {
  if (componentScripts.has(path)) {
    components.add(componentScripts.get(path));
    continue;
  }
  // Component sources and their stack definitions are independently releasable.
  if (!documentationPath(path)) {
    if (componentPath(path, 'app')) components.add('app');
    if (componentPath(path, 'controller')) components.add('controller');
    if (componentPath(path, 'agent')) components.add('agent');
  }

  // These inputs are consumed by every component check or deployment job.
  if (!documentationPath(path) && (
    path === '.nvmrc'
    || path === '.npmrc'
    || path === 'package.json'
    || path === 'package-lock.json'
    || path === 'npm-shrinkwrap.json'
    || path === 'uv.lock'
    || path === 'cdk.json'
    || path === 'tsconfig.json'
    || path === 'tsconfig.base.json'
    || /^\.(?:eslint|prettier)(?:\.[^/]+)?$/.test(path)
    || /^(?:esbuild|vite)\.config\.[^/]+$/.test(path)
    || path === '.github/workflows/deploy.yml'
    || path.startsWith('scripts/')
    || path.startsWith('tests/')
    || (path.startsWith('infrastructure/')
      && !/^infrastructure\/(?:app|controller|agent)(?:\/|$)/.test(path))
  )) {
    addAll();
  }
}

console.log(JSON.stringify(['app', 'controller', 'agent'].filter((component) => components.has(component))));
