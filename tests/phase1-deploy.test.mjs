import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('../scripts/check-app-change-set.mjs', import.meta.url));
const appStack = 'arn:aws:cloudformation:us-east-1:027224425948:stack/IncidentTriageDemoApp/11111111-1111-4111-8111-111111111111';

function change(logicalId, action, replacement, type = 'AWS::DynamoDB::Table') {
  return { Type: 'Resource', ResourceChange: {
    Action: action, LogicalResourceId: logicalId, ResourceType: type,
    ...(replacement === undefined ? {} : { Replacement: replacement }),
  } };
}

function check(changes, overrides = {}) {
  const result = spawnSync(process.execPath, [guard], {
    input: JSON.stringify({
      ChangeSetId: 'arn:aws:cloudformation:us-east-1:027224425948:changeSet/phase1-example/22222222-2222-4222-8222-222222222222',
      StackId: appStack, StackName: 'IncidentTriageDemoApp',
      Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Changes: changes,
      ...overrides,
    }),
    encoding: 'utf8', timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND/, 'the app change-set guard must be implemented');
  assert.notEqual(result.status, null, 'the app change-set guard must complete');
  return result.status;
}

test('app change-set guard accepts first creation and changes that retain the tables', () => {
  assert.equal(check([change('Inventory', 'Add'), change('Orders', 'Add')]), 0);
  assert.equal(check([
    change('Orders', 'Modify', 'False'),
    change('Site', 'Modify', 'True', 'AWS::CloudFront::Distribution'),
  ]), 0);
});

test('app change-set guard refuses table removal or possible replacement', () => {
  for (const rejected of [
    change('Orders', 'Remove'),
    change('Inventory', 'Modify', 'True'),
    change('Orders', 'Modify', 'Conditional'),
    change('Inventory', 'Modify'),
    change('Orders', 'Dynamic'),
  ]) assert.notEqual(check([rejected]), 0, JSON.stringify(rejected));
});

test('app change-set guard refuses incomplete, unavailable or wrong-stack results', () => {
  const changes = [change('Orders', 'Modify', 'False')];
  for (const result of [
    { NextToken: 'more-changes' },
    { Changes: undefined },
    { Status: 'CREATE_IN_PROGRESS' },
    { ExecutionStatus: 'OBSOLETE' },
    { StackName: 'IncidentTriageDemoController' },
  ]) assert.notEqual(check(changes, result), 0, JSON.stringify(result));
});
