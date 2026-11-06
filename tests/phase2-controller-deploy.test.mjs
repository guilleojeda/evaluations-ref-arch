import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('../scripts/check-controller-change-set.mjs', import.meta.url));
const stackName = 'IncidentTriageDemoController';
const target = 'arn:aws:cloudformation:us-east-1:027224425948';

function runTableChange(action, replacement) {
  return { Type: 'Resource', ResourceChange: {
    Action: action, LogicalResourceId: 'RunTable', ResourceType: 'AWS::DynamoDB::Table',
    ...(replacement === undefined ? {} : { Replacement: replacement }),
  } };
}

function check(change, overrides = {}) {
  const result = spawnSync(process.execPath, [guard], {
    input: JSON.stringify({
      ChangeSetId: `${target}:changeSet/phase2-example/22222222-2222-4222-8222-222222222222`,
      StackId: `${target}:stack/${stackName}/11111111-1111-4111-8111-111111111111`,
      StackName: stackName, Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE',
      Changes: [change], ...overrides,
    }),
    encoding: 'utf8', timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND/, 'the controller change-set guard must be implemented');
  assert.notEqual(result.status, null, 'the controller change-set guard must complete');
  return result.status;
}

test('controller release permits initial creation and retains the current run on update', () => {
  assert.equal(check(runTableChange('Add')), 0);
  assert.equal(check(runTableChange('Modify', 'False')), 0);
  for (const change of [
    runTableChange('Remove'), runTableChange('Modify', 'True'),
    runTableChange('Modify', 'Conditional'), runTableChange('Modify'),
  ]) assert.notEqual(check(change), 0);
});

test('controller release rejects an unavailable, incomplete, or different-stack change set', () => {
  const change = runTableChange('Modify', 'False');
  for (const overrides of [
    { ExecutionStatus: 'OBSOLETE' }, { NextToken: 'unread-page' },
    { StackName: 'IncidentTriageDemoApp' },
    { StackId: `${target}:stack/IncidentTriageDemoApp/11111111-1111-4111-8111-111111111111` },
  ]) assert.notEqual(check(change, overrides), 0);
});
