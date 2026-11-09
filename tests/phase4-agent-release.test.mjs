import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const guard = fileURLToPath(new URL('../scripts/check-agent-change-set.mjs', import.meta.url));
const description = {
  ChangeSetId: 'arn:aws:cloudformation:us-east-1:027224425948:changeSet/agent/22222222-2222-4222-8222-222222222222',
  StackId: 'arn:aws:cloudformation:us-east-1:027224425948:stack/IncidentTriageDemoAgent/11111111-1111-4111-8111-111111111111',
  StackName: 'IncidentTriageDemoAgent', Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE',
};
function check(action, replacement, overrides = {}) {
  return spawnSync(process.execPath, [guard], { encoding: 'utf8', input: JSON.stringify({ ...description, Changes: [{ Type: 'Resource', ResourceChange: { Action: action, LogicalResourceId: 'RunTable', ResourceType: 'AWS::DynamoDB::Table', ...(replacement === undefined ? {} : { Replacement: replacement }) } }], ...overrides }) });
}
test('agent release accepts retained run data and rejects removal, uncertain replacement and incomplete inspection', () => {
  assert.equal(check('Add').status, 0);
  assert.equal(check('Modify', 'False').status, 0);
  for (const result of [check('Remove'), check('Modify', 'True'), check('Modify', 'Conditional'), check('Modify'), check('Modify', 'False', { NextToken: 'next' }), check('Modify', 'False', { ExecutionStatus: 'OBSOLETE' }), check('Modify', 'False', { StackName: 'IncidentTriageDemoApp' })]) {
    assert.equal(result.status, 1, result.stdout + result.stderr);
  }
});

test('manual deployment routing selects exactly the requested independent component', (t) => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const block = workflow.match(/          if \[\[ "\$\{\{ github.event_name \}\}" == "workflow_dispatch" \]\]; then[\s\S]*?          fi/)[0];
  const directory = mkdtempSync(join(tmpdir(), 'phase4-manual-route-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const component of ['app', 'controller', 'agent', 'invalid']) {
    const output = join(directory, component);
    const script = block.replaceAll('${{ github.event_name }}', 'workflow_dispatch').replaceAll('${{ inputs.component }}', component);
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script], { env: { ...process.env, GITHUB_OUTPUT: output }, encoding: 'utf8' });
    assert.equal(result.status, component === 'invalid' ? 1 : 0, result.stderr);
    if (component !== 'invalid') assert.equal(readFileSync(output, 'utf8').trim(), `components=["${component}"]`);
  }
});
