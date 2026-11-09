import assert from 'node:assert/strict';
import { test } from 'node:test';

import { prepareInventoryVersions } from '../scripts/prepare-inventory-versions.mjs';

const sourceRevision = '0123456789abcdef0123456789abcdef01234567';
const functionName = 'IncidentTriageDemoInventory';
const aliasName = 'live';
const healthyRoleArn = 'arn:aws:iam::027224425948:role/IncidentTriageDemoAppInventoryRole';
const deniedRoleArn = 'arn:aws:iam::027224425948:role/IncidentTriageDemoAppInventoryDeniedRole';
const healthyRoleName = 'IncidentTriageDemoAppInventoryRole';
const deniedRoleName = 'IncidentTriageDemoAppInventoryDeniedRole';
const policyArn = 'arn:aws:iam::027224425948:policy/IncidentTriageDemoInventoryReadDeny';
const tableArn = 'arn:aws:dynamodb:us-east-1:027224425948:table/IncidentTriageDemoInventory';
const manifestBucket = 'cdk-evaltalk-assets-027224425948-us-east-1';
const manifestKey = `releases/app/${sourceRevision}/inventory-variants.json`;
const codeSha256 = '1dX6yZZAb7TaBN3yVt++SsJwB4U7bT58nJQYfhKle18=';

const latestBase = {
  CodeSha256: codeSha256,
  Description: sourceRevision,
  Handler: 'inventory.handler',
  MemorySize: 256,
  Runtime: 'nodejs24.x',
  Timeout: 6,
  Architectures: ['x86_64'],
  Environment: {
    Variables: {
      APP_ENVIRONMENT: 'demo',
      SOURCE_REVISION: sourceRevision,
      INVENTORY_TABLE_NAME: tableArn,
      PRODUCT_SKU: 'demo-widget',
    },
  },
};

function config(overrides = {}) {
  return {
    sourceRevision,
    functionName,
    aliasName,
    baselineMemoryMb: 256,
    healthyVersion: '10',
    healthyRoleArn,
    deniedRoleArn,
    healthyRoleName,
    deniedRoleName,
    deniedPolicyArn: policyArn,
    inventoryTableArn: tableArn,
    manifestBucket,
    manifestKey,
    ...overrides,
  };
}

function qualified(roleArn, overrides = {}) {
  return { ...latestBase, Role: roleArn, ...overrides };
}

function fakeAws({
  latestRole = healthyRoleArn,
  existingManifest = null,
  publishMode = 'success',
  stagingRevision = 'staged-revision',
  listVersions = ['10'],
  latestOverrides = {},
} = {}) {
  const calls = [];
  const state = {
    latest: { ...latestBase, Role: latestRole, RevisionId: latestRole === deniedRoleArn ? stagingRevision : 'latest-revision', ...latestOverrides },
    versions: new Set(listVersions),
    qualified: new Map([['10', qualified(healthyRoleArn)]]),
    object: existingManifest,
  };
  const aws = {
    calls,
    state,
    async getFunctionConfiguration({ qualifier } = {}) {
      calls.push(['getFunctionConfiguration', qualifier ?? '$LATEST']);
      if (qualifier) return state.qualified.get(String(qualifier));
      return { ...state.latest };
    },
    async getAlias() {
      calls.push(['getAlias', aliasName]);
      return { Name: aliasName, FunctionVersion: '10', RevisionId: 'alias-revision', RoutingConfig: {} };
    },
    async updateFunctionConfiguration({ roleArn, revisionId }) {
      calls.push(['updateFunctionConfiguration', roleArn, revisionId]);
      assert.equal(revisionId, state.latest.RevisionId);
      state.latest = { ...state.latest, Role: roleArn, RevisionId: roleArn === deniedRoleArn ? stagingRevision : 'restored-revision' };
      return { ...state.latest };
    },
    async waitForFunctionReady() {
      calls.push(['waitForFunctionReady']);
    },
    async publishVersion({ codeSha256: requestedHash, revisionId }) {
      calls.push(['publishVersion', requestedHash, revisionId]);
      assert.equal(requestedHash, codeSha256);
      assert.equal(revisionId, stagingRevision);
      if (publishMode === 'definite-failure') throw new Error('publish failed');
      state.versions.add('11');
      state.qualified.set('11', qualified(deniedRoleArn));
      if (publishMode === 'lost-response') throw Object.assign(new Error('publication response lost'), { unknown: true });
      return { Version: '11' };
    },
    async listVersions() {
      calls.push(['listVersions']);
      return [...state.versions].map((Version) => ({ Version, CodeSha256: codeSha256 }));
    },
    async getRolePolicyAttachments({ roleName }) {
      calls.push(['getRolePolicyAttachments', roleName]);
      return roleName === deniedRoleName ? [{ PolicyArn: policyArn }] : [];
    },
    async getPolicyDocument({ policyArn: requestedArn }) {
      calls.push(['getPolicyDocument', requestedArn]);
      assert.equal(requestedArn, policyArn);
      return { Version: '2012-10-17', Statement: [{ Effect: 'Deny', Action: 'dynamodb:GetItem', Resource: tableArn }] };
    },
    async headObject() {
      calls.push(['headObject']);
      return state.object;
    },
    async putObject({ body, serverSideEncryption, ifNoneMatch }) {
      assert.equal(ifNoneMatch, '*', 'manifest publication must be conditional');
      calls.push(['putObject', body, serverSideEncryption]);
      state.object = { body, serverSideEncryption };
    },
  };
  return aws;
}

test('prepares the healthy and denied baseline pair, restores $LATEST, then publishes the exact manifest', async () => {
  const aws = fakeAws();
  const result = await prepareInventoryVersions({ config: config(), aws });
  const manifest = JSON.parse(result.manifestBody);
  assert.deepEqual(manifest, {
    schemaVersion: 1,
    sourceRevision,
    functionName,
    aliasName,
    baselineMemoryMb: 256,
    codeSha256,
    variants: [
      { memoryMb: 256, access: 'healthy', version: '10', roleArn: healthyRoleArn },
      { memoryMb: 256, access: 'denied', version: '11', roleArn: deniedRoleArn },
    ],
  });
  assert.equal(aws.state.latest.Role, healthyRoleArn);
  assert.deepEqual(aws.calls.filter(([name]) => name === 'updateFunctionConfiguration').map(([, role]) => role), [deniedRoleArn, healthyRoleArn]);
  const uploaded = aws.calls.findIndex(([name]) => name === 'putObject');
  const restored = aws.calls.findIndex(([name, role]) => name === 'updateFunctionConfiguration' && role === healthyRoleArn);
  assert.ok(restored >= 0 && restored < uploaded, 'restore must precede manifest publication');
  assert.deepEqual(aws.calls[uploaded], ['putObject', result.manifestBody, 'AES256']);
  assert.ok(aws.calls.slice(uploaded + 1).some(([name]) => name === 'headObject'), 'published manifest must be read back');
});

test('resumes recognized denied-role staging without staging it a second time', async () => {
  const aws = fakeAws({ latestRole: deniedRoleArn, listVersions: ['10'] });
  await prepareInventoryVersions({ config: config(), aws });
  assert.deepEqual(aws.calls.filter(([name]) => name === 'updateFunctionConfiguration').map(([, role]) => role), [healthyRoleArn]);
});

test('reconciles a lost publication response only through one exact matching version', async () => {
  const aws = fakeAws({ publishMode: 'lost-response' });
  const result = await prepareInventoryVersions({ config: config(), aws });
  assert.equal(JSON.parse(result.manifestBody).variants[1].version, '11');
  assert.equal(aws.calls.filter(([name]) => name === 'publishVersion').length, 1);
  assert.equal(aws.state.latest.Role, healthyRoleArn);
});

test('restores $LATEST after a failed publication and does not publish a manifest', async () => {
  const aws = fakeAws({ publishMode: 'definite-failure' });
  await assert.rejects(() => prepareInventoryVersions({ config: config(), aws }), /publish failed|matching version/i);
  assert.equal(aws.state.latest.Role, healthyRoleArn);
  assert.equal(aws.calls.some(([name]) => name === 'putObject'), false);
});

test('rejects configuration drift before mutation and rejects a conflicting immutable manifest', async () => {
  const drifted = fakeAws({ latestOverrides: { MemorySize: 512 } });
  await assert.rejects(() => prepareInventoryVersions({ config: config(), aws: drifted }), /drift|memory/i);
  assert.equal(drifted.calls.some(([name]) => name === 'updateFunctionConfiguration'), false);

  const conflicting = fakeAws({ existingManifest: { body: '{"schemaVersion":999}', serverSideEncryption: 'AES256' } });
  await assert.rejects(() => prepareInventoryVersions({ config: config(), aws: conflicting }), /manifest|immutable|different/i);
  assert.equal(conflicting.calls.some(([name]) => name === 'updateFunctionConfiguration'), false);
});
