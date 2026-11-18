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
function runGuard(changes, overrides = {}, template = checkedTemplate, flags = []) {
  const directory = mkdtempSync(join(tmpdir(), 'phase4-agent-guard-'));
  try {
    const path = join(directory, 'checked-template.json');
    writeFileSync(path, JSON.stringify(template));
    return spawnSync(process.execPath, [guard, ...flags, path], { encoding: 'utf8', input: JSON.stringify({ ...description, Changes: changes, ...overrides }) });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
function check(action, replacement, overrides = {}, resourceOverrides = {}, template = checkedTemplate) {
  return runGuard([{ Type: 'Resource', ResourceChange: { Action: action, LogicalResourceId: 'RunTable', ResourceType: 'AWS::DynamoDB::Table', ...(replacement === undefined ? {} : { Replacement: replacement }), ...resourceOverrides } }], overrides, template);
}
test('agent release accepts retained run data and rejects removal, uncertain replacement and incomplete inspection', () => {
  assert.equal(check('Add').status, 0);
  assert.equal(check('Modify', 'False').status, 0);
  for (const result of [check('Remove'), check('Modify', 'True'), check('Modify', 'Conditional'), check('Modify'), check('Modify', 'False', { NextToken: 'next' }), check('Modify', 'False', { ExecutionStatus: 'OBSOLETE' }), check('Modify', 'False', { StackName: 'IncidentTriageDemoApp' })]) {
    assert.equal(result.status, 1, result.stdout + result.stderr);
  }
});

test('existing infrastructure-only reconciliation protects the published Runtime while allowing adapter changes', () => {
  const adapter = {
    Type: 'Resource',
    ResourceChange: {
      Action: 'Modify', LogicalResourceId: 'AlarmAdapter94C8F489',
      ResourceType: 'AWS::Lambda::Function', Replacement: 'False',
    },
  };
  const runtime = {
    Type: 'Resource',
    ResourceChange: {
      Action: 'Modify', LogicalResourceId: 'Runtime',
      ResourceType: 'AWS::BedrockAgentCore::Runtime', Replacement: 'False',
    },
  };
  assert.equal(runGuard([adapter], {}, checkedTemplate, ['--infrastructure-only']).status, 0);
  const rejected = runGuard([runtime], {}, checkedTemplate, ['--infrastructure-only']);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /must not modify the publisher-owned Runtime/);
  assert.equal(runGuard([runtime]).status, 0,
    'the general guard remains compatible with the explicit fresh bootstrap path');
});

test('normal AWS change-set property resolution removes only the dynamic Permission false positive', () => {
  const adapter = {
    Type: 'Resource',
    ResourceChange: {
      Action: 'Modify', LogicalResourceId: 'AlarmAdapter94C8F489',
      ResourceType: 'AWS::Lambda::Function', Replacement: 'False',
      Details: [{ Target: { Attribute: 'Properties', Name: 'Environment', RequiresRecreation: 'Never' }, Evaluation: 'Dynamic', ChangeSource: 'DirectModification' }],
    },
  };
  const dynamicPermission = {
    Type: 'Resource',
    ResourceChange: {
      Action: 'Modify', LogicalResourceId: 'NativeAlarmPermission',
      ResourceType: 'AWS::Lambda::Permission', Replacement: 'Conditional',
      Details: [{ Target: { Attribute: 'Properties', Name: 'FunctionName', RequiresRecreation: 'Always' }, Evaluation: 'Dynamic', ChangeSource: 'ResourceAttribute', CausingEntity: 'AlarmAdapter94C8F489.Arn' }],
    },
  };
  const normalDetail = runGuard([adapter, dynamicPermission]);
  assert.equal(normalDetail.status, 1, normalDetail.stdout + normalDetail.stderr);
  const resolvedDetail = runGuard([adapter]);
  assert.equal(resolvedDetail.status, 0, resolvedDetail.stdout + resolvedDetail.stderr);
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
  const block = workflow.match(/      - name: Select changed components[\s\S]*?\n        run: \|\n([\s\S]*?)(?=^      - name:)/m)[1]
    .replace(/^ {10}/gm, '');
  const directory = mkdtempSync(join(tmpdir(), 'phase4-manual-route-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cases = [
    { component: 'app' },
    { component: 'controller' },
    { component: 'agent' },
    { component: 'app', from: 'initial', to: 'next-generation' },
    { component: 'invalid', reject: true },
    { component: 'controller', from: 'initial', to: 'next-generation', reject: true },
    { component: 'app', to: 'next-generation', reject: true },
    { component: 'app', from: 'initial', to: 'initial', reject: true },
    { component: 'app', from: 'initial', to: 'invalid generation', reject: true },
  ];
  const script = block
    .replaceAll('${{ github.event_name }}', 'workflow_dispatch')
    .replaceAll('${{ github.ref }}', 'refs/heads/demo-deploy')
    .replaceAll('${{ github.sha }}', 'a'.repeat(40));
  for (const [index, { component, from = '', to = '', reject = false }] of cases.entries()) {
    const output = join(directory, String(index));
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
      env: { ...process.env, GITHUB_OUTPUT: output, DISPATCH_COMPONENT: component,
        DISPATCH_ROTATION_FROM: from, DISPATCH_ROTATION_TO: to },
      encoding: 'utf8',
    });
    assert.equal(result.status, reject ? 1 : 0, result.stderr);
    if (!reject) {
      const lines = readFileSync(output, 'utf8').trim().split('\n');
      const values = Object.fromEntries(lines.map((line) => {
        const split = line.indexOf('=');
        return [line.slice(0, split), line.slice(split + 1)];
      }));
      const expected = {
        components: `["${component}"]`,
        operation: 'normal',
        reference_setup: 'false',
      };
      if (from) {
        expected.rotation_from_generation = from;
        expected.rotation_to_generation = to;
      }
      for (const [key, value] of Object.entries(expected)) assert.equal(values[key], value, key);
      // New routing outputs are asserted by meaning without making this
      // legacy dispatch contract depend on their ordering or exact line set.
      if (component === 'agent') {
        assert.equal(values.deploy_components, '[]');
        assert.equal(values.check_components, '[]');
        assert.equal(values.agent_components, '["agent"]');
        assert.equal(values.qualification_required, 'true');
        assert.equal(values.reconcile_after_gate, 'true');
      } else {
        assert.equal(values.deploy_components, `["${component}"]`);
        assert.equal(values.check_components, `["${component}"]`);
        assert.equal(values.agent_components, '[]');
        assert.equal(values.qualification_required, 'false');
        assert.equal(values.reconcile_after_gate, 'false');
      }
      assert.equal(values.agent_infrastructure_only, 'false');
    }
  }
});
