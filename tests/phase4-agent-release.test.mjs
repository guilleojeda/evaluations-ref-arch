import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const guard = fileURLToPath(new URL('../scripts/check-agent-change-set.mjs', import.meta.url));
const description = {
  ChangeSetId: 'arn:aws:cloudformation:us-east-1:027224425948:changeSet/agent/22222222-2222-4222-8222-222222222222',
  StackId: 'arn:aws:cloudformation:us-east-1:027224425948:stack/IncidentTriageDemoAgent/11111111-1111-4111-8111-111111111111',
  StackName: 'IncidentTriageDemoAgent', Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE',
};
const checkedTemplate = { Resources: {
  RunTable: { Type: 'AWS::DynamoDB::Table', Properties: { TableName: 'IncidentTriageDemoAgentRun' }, DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' },
  AdapterLogGroupABC: { Type: 'AWS::Logs::LogGroup', Properties: { LogGroupName: '/aws/lambda/IncidentTriageDemoAlarmAdapter' }, DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' },
} };
function check(action, replacement, overrides = {}, resourceOverrides = {}, template = checkedTemplate) {
  const directory = mkdtempSync(join(tmpdir(), 'phase4-agent-guard-'));
  try {
    const path = join(directory, 'checked-template.json');
    writeFileSync(path, JSON.stringify(template));
    return spawnSync(process.execPath, [guard, path], { encoding: 'utf8', input: JSON.stringify({ ...description, Changes: [{ Type: 'Resource', ResourceChange: { Action: action, LogicalResourceId: 'RunTable', ResourceType: 'AWS::DynamoDB::Table', ...(replacement === undefined ? {} : { Replacement: replacement }), ...resourceOverrides } }], ...overrides }) });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
test('agent release accepts retained run data and rejects removal, uncertain replacement and incomplete inspection', () => {
  assert.equal(check('Add').status, 0);
  assert.equal(check('Modify', 'False').status, 0);
  for (const result of [check('Remove'), check('Modify', 'True'), check('Modify', 'Conditional'), check('Modify'), check('Modify', 'False', { NextToken: 'next' }), check('Modify', 'False', { ExecutionStatus: 'OBSOLETE' }), check('Modify', 'False', { StackName: 'IncidentTriageDemoApp' })]) {
    assert.equal(result.status, 1, result.stdout + result.stderr);
  }
});

test('agent release imports only the exact checked retained table and adapter logs', () => {
  assert.equal(check('Import', undefined, {}, { PhysicalResourceId: 'IncidentTriageDemoAgentRun' }).status, 0);
  assert.equal(check('Import', 'False', {}, { LogicalResourceId: 'AdapterLogGroupABC', ResourceType: 'AWS::Logs::LogGroup', PhysicalResourceId: '/aws/lambda/IncidentTriageDemoAlarmAdapter' }).status, 0);
  for (const resource of [
    {},
    { PhysicalResourceId: 'IncidentTriageDemoControllerRun' },
    { LogicalResourceId: 'OtherTable', PhysicalResourceId: 'IncidentTriageDemoAgentRun' },
    { ResourceType: 'AWS::Logs::LogGroup', PhysicalResourceId: 'IncidentTriageDemoAgentRun' },
    { LogicalResourceId: 'AdapterLogGroupABC', ResourceType: 'AWS::Logs::LogGroup', PhysicalResourceId: '/aws/lambda/OtherFunction' },
    { LogicalResourceId: 'OtherLambda', ResourceType: 'AWS::Lambda::Function', PhysicalResourceId: 'IncidentTriageDemoAlarmAdapter' },
  ]) {
    const result = check('Import', undefined, {}, resource);
    assert.equal(result.status, 1, result.stdout + result.stderr);
  }
  assert.equal(check('Import', 'True', {}, { PhysicalResourceId: 'IncidentTriageDemoAgentRun' }).status, 1);
});

test('agent import approval requires exact retained resources in the checked template', () => {
  for (const change of [
    (template) => { template.Resources.RunTable.DeletionPolicy = 'Delete'; },
    (template) => { template.Resources.RunTable.UpdateReplacePolicy = 'Delete'; },
    (template) => { template.Resources.RunTable.Properties.TableName = 'OtherTable'; },
    (template) => { template.Resources.AdapterLogGroupABC.Properties.LogGroupName = '/aws/lambda/OtherFunction'; },
    (template) => { delete template.Resources.AdapterLogGroupABC; },
  ]) {
    const template = structuredClone(checkedTemplate);
    change(template);
    const result = check('Import', undefined, {}, { PhysicalResourceId: 'IncidentTriageDemoAgentRun' }, template);
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
