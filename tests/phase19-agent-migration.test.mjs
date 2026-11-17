import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const guard = fileURLToPath(new URL('../scripts/check-agent-change-set.mjs', import.meta.url));
const stackName = 'IncidentTriageDemoAgent';
const accountRegion = 'arn:aws:cloudformation:us-east-1:027224425948';
// Captured from the read-only Phase 19 stack-resource receipt. Keep the
// physical ID as data from CloudFormation rather than deriving it from the
// desired template: a physical ID is not generally required to be an ARN.
const legacyEndpoint = {
  LogicalResourceId: 'FaultyEndpoint',
  PhysicalResourceId:
    'arn:aws:bedrock-agentcore:us-east-1:027224425948:runtime/IncidentTriageDemoAgent-7VWTOWDIs4/runtime-endpoint/faulty',
  ResourceType: 'AWS::BedrockAgentCore::RuntimeEndpoint',
};

// This is the checked post-cutover shape: the endpoint is deliberately absent
// from the desired template. The table and adapter log group remain the two
// retained resources that ordinary agent releases may import.
const checkedTemplate = { Resources: {
  RunTable: {
    Type: 'AWS::DynamoDB::Table',
    Properties: { TableName: 'IncidentTriageDemoAgentRun' },
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
  },
  AdapterLogGroupABC: {
    Type: 'AWS::Logs::LogGroup',
    Properties: { LogGroupName: '/aws/lambda/IncidentTriageDemoAlarmAdapter' },
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
  },
  Runtime: {
    Type: 'AWS::BedrockAgentCore::Runtime',
    Properties: { AgentRuntimeName: 'IncidentTriageDemoAgent' },
  },
  OtherResource: {
    Type: 'AWS::S3::Bucket',
    Properties: { BucketName: 'unrelated-fixture-resource' },
  },
} };

const description = {
  ChangeSetId: `${accountRegion}:changeSet/agent-migration/22222222-2222-4222-8222-222222222222`,
  StackId: `${accountRegion}:stack/${stackName}/11111111-1111-4111-8111-111111111111`,
  StackName: stackName,
  Status: 'CREATE_COMPLETE',
  ExecutionStatus: 'AVAILABLE',
};

function change(logicalId, action, resourceType, replacement, extra = {}) {
  return {
    Type: 'Resource',
    ResourceChange: {
      Action: action,
      LogicalResourceId: logicalId,
      ResourceType: resourceType,
      ...(replacement === undefined ? {} : { Replacement: replacement }),
      ...extra,
    },
  };
}

function tableChange(action = 'Modify', replacement = 'False') {
  return change('RunTable', action, 'AWS::DynamoDB::Table', replacement);
}

function runtimeChange(action = 'Modify', replacement = 'False') {
  return change('Runtime', action, 'AWS::BedrockAgentCore::Runtime', replacement);
}

function legacyEndpointRemoval(overrides = {}) {
  return change(legacyEndpoint.LogicalResourceId, 'Remove', legacyEndpoint.ResourceType, undefined, {
    PhysicalResourceId: legacyEndpoint.PhysicalResourceId,
    ...overrides,
  });
}

function run(changes, { referenceCutover = false, template = checkedTemplate, overrides = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'phase19-agent-guard-'));
  try {
    const templatePath = join(directory, 'checked-template.json');
    writeFileSync(templatePath, JSON.stringify(template));
    const args = [guard, ...(referenceCutover ? ['--reference-cutover'] : []), templatePath];
    const result = spawnSync(process.execPath, args, {
      input: JSON.stringify({ ...description, Changes: changes, ...overrides }),
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.notEqual(result.status, null, 'the agent change-set guard must complete');
    assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND/, 'the agent change-set guard must be implemented');
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('ordinary agent releases retain the existing safety contract and cannot detach or repin', () => {
  const sameRevision = { Parameters: [{ ParameterKey: 'SourceRevision', ParameterValue: 'a'.repeat(40) }] };
  assert.equal(run([tableChange(), runtimeChange()], { overrides: sameRevision }).status, 0);

  for (const changes of [
    [legacyEndpointRemoval()],
    [change('FaultyEndpoint', 'Modify', 'AWS::BedrockAgentCore::RuntimeEndpoint', 'False', {
      Details: [{ Target: { Name: 'Properties.AgentRuntimeVersion' } }],
    })],
    [runtimeChange('Modify', 'True')],
    [runtimeChange('Remove')],
  ]) {
    const result = run(changes, { overrides: sameRevision });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
  }
});

test('reference cutover permits one exact legacy endpoint removal, while fresh or already-detached updates need none', () => {
  const ordinary = [tableChange(), runtimeChange()];
  assert.equal(run([...ordinary, legacyEndpointRemoval()], { referenceCutover: true }).status, 0);
  assert.equal(run(ordinary, { referenceCutover: true }).status, 0);
  assert.equal(run([runtimeChange()], { referenceCutover: true }).status, 0);
  assert.notEqual(
    run([legacyEndpointRemoval(), legacyEndpointRemoval()], { referenceCutover: true }).status,
    0,
    'cutover must inspect at most one legacy endpoint removal',
  );
});

test('reference cutover rejects other endpoint changes and every unrelated removal or replacement', () => {
  const rejected = [
    legacyEndpointRemoval({ PhysicalResourceId: legacyEndpoint.PhysicalResourceId.replace('/faulty', '/repaired') }),
    legacyEndpointRemoval({ PhysicalResourceId: legacyEndpoint.PhysicalResourceId.replace('IncidentTriageDemoAgent-7VWTOWDIs4', 'IncidentTriageDemoAgent-Other123') }),
    legacyEndpointRemoval({ PhysicalResourceId: 'not-a-runtime-endpoint' }),
    legacyEndpointRemoval({ LogicalResourceId: 'OtherEndpoint' }),
    legacyEndpointRemoval({ ResourceType: 'AWS::Lambda::Function' }),
    change('FaultyEndpoint', 'Add', 'AWS::BedrockAgentCore::RuntimeEndpoint', 'False'),
    change('FaultyEndpoint', 'Modify', 'AWS::BedrockAgentCore::RuntimeEndpoint', 'False'),
    change('FaultyEndpoint', 'Modify', 'AWS::BedrockAgentCore::RuntimeEndpoint', 'True'),
    change('Runtime', 'Modify', 'AWS::BedrockAgentCore::Runtime', 'True'),
    change('Runtime', 'Modify', 'AWS::BedrockAgentCore::Runtime', 'Conditional'),
    change('RunTable', 'Modify', 'AWS::DynamoDB::Table', 'True'),
    change('RunTable', 'Remove', 'AWS::DynamoDB::Table'),
    change('AdapterLogGroupABC', 'Remove', 'AWS::Logs::LogGroup'),
    change('OtherResource', 'Remove', 'AWS::S3::Bucket'),
    change('OtherResource', 'Modify', 'AWS::S3::Bucket', 'True'),
  ];
  for (const rejectedChange of rejected) {
    const result = run([rejectedChange], { referenceCutover: true });
    assert.notEqual(result.status, 0, JSON.stringify(rejectedChange));
  }
});
