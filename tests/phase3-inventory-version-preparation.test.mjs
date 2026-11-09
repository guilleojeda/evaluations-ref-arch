import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { prepareInventoryVersions, restoreRecognizedInventoryStaging } from '../scripts/prepare-inventory-versions.mjs';

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
  FunctionArn: `arn:aws:lambda:us-east-1:027224425948:function:${functionName}`,
  CodeSha256: codeSha256,
  Description: sourceRevision,
  Handler: 'inventory.handler',
  MemorySize: 256,
  Runtime: 'nodejs24.x',
  Timeout: 6,
  Architectures: ['x86_64'],
  LastModified: '2026-11-09T12:00:00.000+0000',
  LastUpdateStatus: 'Successful',
  State: 'Active',
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
  return { ...latestBase, FunctionArn: `${latestBase.FunctionArn}:10`, Version: '10', Role: roleArn, ...overrides };
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
      state.qualified.set('11', { ...state.latest, FunctionArn: `${latestBase.FunctionArn}:11`, Version: '11', Role: deniedRoleArn });
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

test('resumes after publication completed but restoration was interrupted', async () => {
  const aws = fakeAws({ latestRole: deniedRoleArn, listVersions: ['10', '11'] });
  aws.state.qualified.set('11', { ...latestBase, FunctionArn: `${latestBase.FunctionArn}:11`, Version: '11', Role: deniedRoleArn });
  const result = await prepareInventoryVersions({ config: config(), aws });
  assert.equal(JSON.parse(result.manifestBody).variants[1].version, '11');
  assert.deepEqual(aws.calls.filter(([name]) => name === 'updateFunctionConfiguration').map(([, role]) => role), [healthyRoleArn]);
});

test('restores prior-release staging before the next release with the fresh current revision', async () => {
  const aws = fakeAws({ latestRole: deniedRoleArn });
  aws.state.latest.RevisionId = 'fresh-current-revision';
  const result = await restoreRecognizedInventoryStaging({ config: config(), aws });
  assert.equal(result.restored, true);
  assert.deepEqual(aws.calls.filter(([name]) => name === 'updateFunctionConfiguration'), [
    ['updateFunctionConfiguration', healthyRoleArn, 'fresh-current-revision'],
  ]);
});

test('restores $LATEST after a failed publication and does not publish a manifest', async () => {
  const aws = fakeAws({ publishMode: 'definite-failure' });
  await assert.rejects(() => prepareInventoryVersions({ config: config(), aws }), /publish failed|matching version/i);
  assert.equal(aws.state.latest.Role, healthyRoleArn);
  assert.equal(aws.calls.some(([name]) => name === 'putObject'), false);
});

test('restores a recognized denied role even when the prior Lambda update is already failed', async () => {
  const aws = fakeAws({ latestRole: deniedRoleArn, latestOverrides: { LastUpdateStatus: 'Failed', LastUpdateStatusReason: 'simulated stage failure' } });
  await assert.rejects(() => prepareInventoryVersions({ config: config(), aws }), /failed Lambda update/i);
  assert.equal(aws.state.latest.Role, healthyRoleArn);
  assert.deepEqual(aws.calls.filter(([name]) => name === 'updateFunctionConfiguration').map(([, role]) => role), [healthyRoleArn]);
});

test('rejects configuration drift before mutation and rejects a conflicting immutable manifest', async () => {
  const drifted = fakeAws({ latestOverrides: { MemorySize: 512 } });
  await assert.rejects(() => prepareInventoryVersions({ config: config(), aws: drifted }), /drift|memory/i);
  assert.equal(drifted.calls.some(([name]) => name === 'updateFunctionConfiguration'), false);

  const conflicting = fakeAws({ existingManifest: { body: '{"schemaVersion":999}', serverSideEncryption: 'AES256' } });
  await assert.rejects(() => prepareInventoryVersions({ config: config(), aws: conflicting }), /manifest|immutable|different/i);
  assert.equal(conflicting.calls.some(([name]) => name === 'updateFunctionConfiguration'), false);
});

test('reports Lambda environment decryption errors by code without exposing the provider message', async () => {
  const aws = fakeAws();
  const original = aws.getFunctionConfiguration.bind(aws);
  aws.getFunctionConfiguration = async (request = {}) => {
    const result = await original(request);
    if (request.qualifier === '10') {
      return { ...result, Environment: { Error: { ErrorCode: 'AccessDeniedException', Message: 'sensitive provider detail' } } };
    }
    return result;
  };
  await assert.rejects(
    () => prepareInventoryVersions({ config: config(), aws }),
    (error) => {
      assert.match(error.message, /environment decrypt failed \(AccessDeniedException\)/);
      assert.doesNotMatch(error.message, /sensitive provider detail/);
      return true;
    },
  );
});

test('deploy script restores recognized staging before any new CloudFormation change set and skips old stacks safely', () => {
  const deploy = readFileSync(new URL('../scripts/deploy-app.sh', import.meta.url), 'utf8');
  const recovery = deploy.indexOf('restore_previous_inventory_staging');
  const deployedRevision = deploy.indexOf('deployed_revision=');
  const cdk = deploy.indexOf('cdk deploy');
  assert.ok(recovery >= 0 && recovery < deployedRevision && recovery < cdk);
  assert.match(deploy, /\[\[ -n "\$denied_role" \]\] \|\| return 0/);
  assert.match(deploy, /--restore-staging-only true/);
});

test('deploy guard permits only the exact Inventory and alarm-adapter Lambda environment decrypt contexts', () => {
  const template = readFileSync(new URL('../infrastructure/bootstrap/github-iam.yaml', import.meta.url), 'utf8');
  assert.match(template, /- kms:Decrypt\s+- kms:DescribeKey\s+- s3:GetBucketLocation/);
  assert.match(template, /Sid: DenyBootstrapKeyOutsideBootstrapTemplates[\s\S]*?Resource: arn:aws:kms:us-east-1:027224425948:key\/b292b95c-709f-42c6-aa42-b934ba2c6f07[\s\S]*?kms:EncryptionContext:aws:s3:arn:/);
  assert.match(template, /Sid: DenyLambdaKeyOutsideApprovedEnvironments[\s\S]*?Resource: arn:aws:kms:us-east-1:027224425948:key\/9d894f12-dc33-4332-bb3e-df489928914b[\s\S]*?kms:EncryptionContext:aws:lambda:FunctionArn:\s+- arn:aws:lambda:us-east-1:027224425948:function:IncidentTriageDemoInventory\s+- arn:aws:lambda:us-east-1:027224425948:function:IncidentTriageDemoAlarmAdapter/);
  assert.match(template, /Sid: DenyDescribeKeyOutsideInventoryEnvironmentKey[\s\S]*?Action: kms:DescribeKey[\s\S]*?NotResource: arn:aws:kms:us-east-1:027224425948:key\/9d894f12-dc33-4332-bb3e-df489928914b/);
  assert.match(template, /Sid: DenyDescribeInventoryKeyOutsideLambdaService[\s\S]*?Action: kms:DescribeKey[\s\S]*?Resource: arn:aws:kms:us-east-1:027224425948:key\/9d894f12-dc33-4332-bb3e-df489928914b[\s\S]*?kms:ViaService:\s+lambda.us-east-1.amazonaws.com/);
  assert.doesNotMatch(template, /kms:EncryptionContext:aws:lambda:FunctionArn:\s+(?:-\s*)?arn:aws:lambda:us-east-1:027224425948:function:\*/);
});
