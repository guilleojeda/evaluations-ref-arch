import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
const supportedMemoryMb = [256, 512];

const latestBase = {
  FunctionArn: `arn:aws:lambda:us-east-1:027224425948:function:${functionName}`,
  CodeSha256: codeSha256,
  Description: sourceRevision,
  Handler: 'inventory.handler',
  MemorySize: 256,
  Runtime: 'nodejs24.x',
  Timeout: 6,
  Architectures: ['arm64'],
  EphemeralStorage: { Size: 512 },
  LoggingConfig: { LogFormat: 'JSON', ApplicationLogLevel: 'INFO', SystemLogLevel: 'WARN' },
  TracingConfig: { Mode: 'Active' },
  Layers: ['arn:aws:lambda:us-east-1:027224425948:layer:InventoryCommon:4'],
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
    supportedMemoryMb,
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

function copy(value) {
  return structuredClone(value);
}

function qualified(version, roleArn, memoryMb, overrides = {}) {
  return {
    ...copy(latestBase),
    FunctionArn: `${latestBase.FunctionArn}:${version}`,
    Version: String(version),
    Role: roleArn,
    MemorySize: memoryMb,
    ...overrides,
  };
}

function expectedVariants() {
  return supportedMemoryMb.flatMap((memoryMb) => [
    { memoryMb, access: 'healthy', roleArn: healthyRoleArn },
    { memoryMb, access: 'denied', roleArn: deniedRoleArn },
  ]);
}

function preparedManifest(variants = expectedVariants().map((variant, index) => ({
  ...variant,
  version: String(index + 10),
}))) {
  return {
    schemaVersion: 1,
    sourceRevision,
    functionName,
    aliasName,
    baselineMemoryMb: 256,
    codeSha256,
    variants,
  };
}

function objectFor(manifest) {
  return { body: `${JSON.stringify(manifest, null, 2)}\n`, serverSideEncryption: 'AES256' };
}

function createAws({
  existingManifest,
  preexistingVariants = [],
  failureBefore,
  lostResponseAfterPublish,
  qualifiedOverrides = {},
} = {}) {
  const calls = [];
  const alias = {
    Name: aliasName,
    FunctionVersion: '10',
    RevisionId: 'alias-revision',
    RoutingConfig: {},
  };
  const state = {
    latest: { ...copy(latestBase), Role: healthyRoleArn, RevisionId: 'latest-revision' },
    alias: copy(alias),
    object: existingManifest ? copy(existingManifest) : null,
    qualified: new Map([['10', qualified('10', healthyRoleArn, 256)]]),
    nextVersion: 11,
  };
  for (const [index, variant] of expectedVariants().entries()) {
    if (variant.memoryMb === 256 && variant.access === 'healthy') continue;
    if (existingManifest || preexistingVariants.some((candidate) => pairKey(candidate) === pairKey(variant))) {
      const version = String(index + 10);
      state.qualified.set(version, qualified(version, variant.roleArn, variant.memoryMb));
    }
  }
  state.nextVersion = Math.max(...[...state.qualified.keys()].map(Number)) + 1;
  for (const [version, override] of Object.entries(qualifiedOverrides)) {
    const current = state.qualified.get(String(version));
    state.qualified.set(String(version), { ...current, ...copy(override) });
  }
  const initialLatest = copy(state.latest);
  const initialAlias = copy(state.alias);

  const aws = {
    calls,
    state,
    initialLatest,
    initialAlias,
    async getFunctionConfiguration({ qualifier } = {}) {
      calls.push(['getFunctionConfiguration', qualifier ?? '$LATEST']);
      const result = qualifier ? state.qualified.get(String(qualifier)) : state.latest;
      return result ? copy(result) : undefined;
    },
    async getAlias() {
      calls.push(['getAlias', aliasName]);
      return copy(state.alias);
    },
    async updateAlias({ functionVersion }) {
      calls.push(['updateAlias', functionVersion]);
      state.alias = { ...state.alias, FunctionVersion: String(functionVersion) };
      return copy(state.alias);
    },
    async updateFunctionConfiguration({ roleArn, memorySize, revisionId }) {
      calls.push(['updateFunctionConfiguration', roleArn, memorySize, revisionId]);
      assert.equal(revisionId, state.latest.RevisionId, 'configuration updates must use the current revision');
      state.latest = {
        ...state.latest,
        Role: roleArn ?? state.latest.Role,
        MemorySize: memorySize ?? state.latest.MemorySize,
        RevisionId: `latest-revision-${calls.filter(([name]) => name === 'updateFunctionConfiguration').length}`,
      };
      return copy(state.latest);
    },
    async waitForFunctionReady() {
      calls.push(['waitForFunctionReady']);
    },
    async publishVersion({ codeSha256: requestedHash, revisionId, description }) {
      const roleArn = state.latest.Role;
      const memoryMb = state.latest.MemorySize;
      const access = roleArn === healthyRoleArn ? 'healthy' : roleArn === deniedRoleArn ? 'denied' : 'unknown';
      const variant = { memoryMb, access };
      calls.push(['publishVersion', requestedHash, revisionId, description, variant]);
      assert.equal(requestedHash, codeSha256, 'publication must pin the checked release code');
      assert.equal(revisionId, state.latest.RevisionId, 'publication must use the current configuration revision');
      assert.equal(description, sourceRevision, 'publication must identify the source release');
      if (failureBefore && failureBefore.memoryMb === memoryMb && failureBefore.access === access) {
        throw new Error(`publication failed for ${memoryMb} MB ${access} variant`);
      }

      const version = String(state.nextVersion++);
      state.qualified.set(version, qualified(version, roleArn, memoryMb));
      calls.push(['publishedVersion', version, variant]);
      if (lostResponseAfterPublish && lostResponseAfterPublish.memoryMb === memoryMb && lostResponseAfterPublish.access === access) {
        throw Object.assign(new Error('publication response lost'), { unknown: true });
      }
      return { Version: version };
    },
    async listVersions() {
      calls.push(['listVersions']);
      return [...state.qualified.entries()].map(([Version, value]) => ({ Version, CodeSha256: value.CodeSha256 }));
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
    async headObject({ bucket, key }) {
      calls.push(['headObject', bucket, key]);
      assert.equal(bucket, manifestBucket);
      assert.equal(key, manifestKey);
      return state.object ? copy(state.object) : null;
    },
    async putObject({ bucket, key, body, serverSideEncryption, ifNoneMatch }) {
      calls.push(['putObject', bucket, key, body, serverSideEncryption, ifNoneMatch]);
      assert.equal(bucket, manifestBucket);
      assert.equal(key, manifestKey);
      assert.equal(serverSideEncryption, 'AES256');
      assert.equal(ifNoneMatch, '*', 'manifest publication must be conditional');
      state.object = { body, serverSideEncryption };
    },
  };
  return aws;
}

function configurationWithoutPublicationMetadata(configuration) {
  const result = copy(configuration);
  delete result.RevisionId;
  delete result.LastModified;
  delete result.FunctionArn;
  delete result.Version;
  return result;
}

function pairKey({ memoryMb, access }) {
  return `${memoryMb}:${access}`;
}

function assertManifestVariants(manifest, aws) {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.sourceRevision, sourceRevision);
  assert.equal(manifest.functionName, functionName);
  assert.equal(manifest.aliasName, aliasName);
  assert.equal(manifest.baselineMemoryMb, 256);
  assert.equal(manifest.codeSha256, codeSha256);
  assert.deepEqual(
    manifest.variants.map(({ memoryMb, access }) => pairKey({ memoryMb, access })).sort(),
    expectedVariants().map(pairKey).sort(),
    'manifest must include each supported memory/access combination exactly once',
  );
  assert.equal(
    manifest.variants.find(({ memoryMb, access }) => memoryMb === 256 && access === 'healthy')?.version,
    '10',
    'the existing healthy baseline version must be reused',
  );

  const seenVersions = new Set();
  for (const variant of manifest.variants) {
    const expectedRole = variant.access === 'healthy' ? healthyRoleArn : deniedRoleArn;
    assert.equal(variant.roleArn, expectedRole, `${pairKey(variant)} must use its fixed role`);
    assert.match(variant.version, /^[1-9][0-9]*$/);
    assert.equal(seenVersions.has(variant.version), false, 'each manifest entry must identify a distinct qualified version');
    seenVersions.add(variant.version);

    const version = aws.state.qualified.get(variant.version);
    assert.ok(version, `${pairKey(variant)} version must be published and readable`);
    assert.equal(version.Version, variant.version);
    assert.equal(version.Role, expectedRole);
    assert.equal(version.MemorySize, variant.memoryMb);
    assert.equal(version.CodeSha256, codeSha256);
    assert.equal(version.Description, sourceRevision);
    assert.deepEqual(
      configurationWithoutPublicationMetadata(version),
      configurationWithoutPublicationMetadata({
        ...copy(latestBase),
        Role: expectedRole,
        MemorySize: variant.memoryMb,
      }),
      `${pairKey(variant)} must preserve release and every non-memory configuration field`,
    );
  }
}

function assertLatestAndAliasRestored(aws) {
  assert.deepEqual(
    configurationWithoutPublicationMetadata(aws.state.latest),
    configurationWithoutPublicationMetadata(aws.initialLatest),
    '$LATEST role, memory, code, and non-memory configuration must match its original state',
  );
  assert.deepEqual(aws.state.alias, aws.initialAlias, 'preparation must leave the live alias unchanged');
  assert.equal(aws.calls.some(([name]) => name === 'updateAlias'), false, 'preparation must not select a live alias target');
}

function assertNoPublicationOrMutation(aws) {
  assert.equal(aws.calls.some(([name]) => name === 'updateFunctionConfiguration'), false, 'invalid prepared state must not stage $LATEST');
  assert.equal(aws.calls.some(([name]) => name === 'publishVersion'), false, 'invalid prepared state must not publish versions');
  assert.equal(aws.calls.some(([name]) => name === 'putObject'), false, 'invalid prepared state must not publish a manifest');
  assertLatestAndAliasRestored(aws);
}

test('prepares every healthy/denied memory variant, restores the full original $LATEST, and preserves the live alias', async () => {
  const aws = createAws();
  const firstResult = await prepareInventoryVersions({ config: config(), aws });

  assertLatestAndAliasRestored(aws);
  const publishCount = aws.calls.filter(([name]) => name === 'publishVersion').length;
  const putCount = aws.calls.filter(([name]) => name === 'putObject').length;
  const headCount = aws.calls.filter(([name]) => name === 'headObject').length;

  const rerun = await prepareInventoryVersions({ config: config(), aws });

  assertLatestAndAliasRestored(aws);
  assertManifestVariants(firstResult.manifest, aws);
  assertManifestVariants(rerun.manifest, aws);
  assert.equal(firstResult.manifestBody, `${JSON.stringify(firstResult.manifest, null, 2)}\n`);
  assert.equal(rerun.manifestBody, firstResult.manifestBody);
  assert.equal(aws.state.object.body, firstResult.manifestBody, 'the immutable manifest must be read back byte-for-byte');
  assert.equal(aws.calls.filter(([name]) => name === 'publishVersion').length, publishCount, 'rerunning must not publish extra versions');
  assert.equal(aws.calls.filter(([name]) => name === 'putObject').length, putCount, 'rerunning must not rewrite the immutable manifest');
  assert.ok(aws.calls.filter(([name]) => name === 'headObject').length > headCount, 'rerunning must read the existing manifest');

  const published = aws.calls.filter(([name]) => name === 'publishVersion').map(([, , , , variant]) => pairKey(variant));
  assert.deepEqual(published.sort(), ['256:denied', '512:denied', '512:healthy'].sort());
  assert.equal(aws.calls.filter(([name]) => name === 'putObject').length, 1);
});

test('restores the complete original $LATEST after a failed higher-memory publication', async () => {
  const aws = createAws({ failureBefore: { memoryMb: 512, access: 'denied' } });

  const outcome = await prepareInventoryVersions({ config: config(), aws }).then(
    () => null,
    (error) => error,
  );
  assertLatestAndAliasRestored(aws);
  assert.ok(outcome instanceof Error, 'preparation must reject the failed higher-memory publication');
  assert.match(outcome?.message ?? '', /publication failed for 512 MB denied variant/);
  assert.equal(aws.state.object, null, 'a partial preparation must not publish an incomplete manifest');
  assert.ok(aws.calls.some(([name, , , , variant]) => name === 'publishVersion' && pairKey(variant) === '512:denied'));
});

test('reconciles a lost higher-memory publication response and restores the complete original $LATEST', async () => {
  const aws = createAws({ lostResponseAfterPublish: { memoryMb: 512, access: 'denied' } });

  const result = await prepareInventoryVersions({ config: config(), aws });

  assertLatestAndAliasRestored(aws);
  const lostPublication = aws.calls.findIndex(([name, , , , variant]) => name === 'publishVersion' && pairKey(variant) === '512:denied');
  assert.notEqual(lostPublication, -1, 'the ambiguous higher-memory publication must be attempted');
  assert.ok(aws.calls.slice(lostPublication + 1).some(([name]) => name === 'listVersions'), 'the lost response must be reconciled by reading versions');
  assert.equal(
    aws.calls.filter(([name, , , , variant]) => name === 'publishVersion' && pairKey(variant) === '512:denied').length,
    1,
    'reconciling the lost response must not republish the same variant',
  );
  assertManifestVariants(result.manifest, aws);
  assert.equal(
    aws.calls.filter(([name, , , , variant]) => name === 'publishVersion' && pairKey(variant) === '512:denied').length,
    1,
  );
});

test('reuses checked versions from an interrupted matrix before publishing only the missing variant', async () => {
  const aws = createAws({
    preexistingVariants: [
      { memoryMb: 256, access: 'denied' },
      { memoryMb: 512, access: 'healthy' },
    ],
  });

  const result = await prepareInventoryVersions({ config: config(), aws });

  assertManifestVariants(result.manifest, aws);
  assert.deepEqual(
    aws.calls.filter(([name]) => name === 'publishVersion').map(([, , , , variant]) => pairKey(variant)),
    ['512:denied'],
  );
  assertLatestAndAliasRestored(aws);
});

test('rejects a missing, invalid-role, or configuration-mismatched prepared variant before mutation', async (t) => {
  const good = preparedManifest();
  const cases = [
    {
      name: 'missing supported combination',
      manifest: preparedManifest(good.variants.filter(({ memoryMb, access }) => !(memoryMb === 512 && access === 'denied'))),
      qualifiedOverrides: {},
    },
    {
      name: 'wrong fixed role',
      manifest: preparedManifest(good.variants.map((variant) => variant.memoryMb === 512 && variant.access === 'denied'
        ? { ...variant, roleArn: healthyRoleArn }
        : variant)),
      qualifiedOverrides: {},
    },
    {
      name: 'qualified memory does not match manifest',
      manifest: good,
      qualifiedOverrides: { 13: { MemorySize: 256 } },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const aws = createAws({
        existingManifest: objectFor(scenario.manifest),
        qualifiedOverrides: scenario.qualifiedOverrides,
      });
      await assert.rejects(() => prepareInventoryVersions({ config: config(), aws }), /manifest|variant|version|role|memory/i);
      assertNoPublicationOrMutation(aws);
    });
  }
});

test('rejects invalid supported-memory sets before reading or mutating AWS state', async (t) => {
  for (const [name, supported] of [
    ['duplicate sizes', [256, 256]],
    ['omitted baseline', [512]],
    ['non-integer size', [256, 512.5]],
  ]) {
    await t.test(name, async () => {
      const aws = createAws();
      await assert.rejects(
        () => prepareInventoryVersions({ config: config({ supportedMemoryMb: supported }), aws }),
        /supported memory/i,
      );
      assert.deepEqual(aws.calls, [], 'invalid memory configuration must fail before AWS reads');
    });
  }
});

test('recovers only recognized current-release role/memory staging to the healthy baseline', async () => {
  const aws = createAws();
  aws.state.latest = { ...aws.state.latest, Role: deniedRoleArn, MemorySize: 512, RevisionId: 'interrupted-high-memory-stage' };

  const recovered = await restoreRecognizedInventoryStaging({ config: config(), aws });

  assert.equal(recovered.restored, true);
  assert.equal(aws.state.latest.Role, healthyRoleArn);
  assert.equal(aws.state.latest.MemorySize, 256);
  assert.equal(aws.calls.filter(([name]) => name === 'updateFunctionConfiguration').length, 1);
  assert.deepEqual(aws.calls.find(([name]) => name === 'updateFunctionConfiguration'), [
    'updateFunctionConfiguration', healthyRoleArn, 256, 'interrupted-high-memory-stage',
  ]);
  assert.deepEqual(aws.state.alias, aws.initialAlias, 'staging recovery must not move the live alias');

  const unsupported = createAws();
  unsupported.state.latest = { ...unsupported.state.latest, MemorySize: 768 };
  await assert.rejects(() => restoreRecognizedInventoryStaging({ config: config(), aws: unsupported }), /staged memory/i);
  assert.equal(unsupported.calls.some(([name]) => name === 'updateFunctionConfiguration'), false);
});

test('CLI and deployment pass the selected memory list instead of inventing it in the preparer', () => {
  const deploy = readFileSync(new URL('../scripts/deploy-app.sh', import.meta.url), 'utf8');
  const stack = readFileSync(new URL('../infrastructure/app/stack.ts', import.meta.url), 'utf8');
  assert.match(stack, /SUPPORTED_INVENTORY_MEMORY_MB = \[BASELINE_MEMORY_MB, 512\]/);
  assert.match(stack, /InventorySupportedMemoryMb[\s\S]*SUPPORTED_INVENTORY_MEMORY_MB\.join\(","\)/);
  assert.match(deploy, /stack_output InventorySupportedMemoryMb/);
  assert.equal((deploy.match(/--supported-memory-mb "\$supported_memory_mb"/g) ?? []).length, 2);

  assert.throws(
    () => execFileSync(process.execPath, [
      new URL('../scripts/prepare-inventory-versions.mjs', import.meta.url).pathname,
      '--function-name', functionName,
      '--source-revision', sourceRevision,
      '--healthy-version', '10',
      '--healthy-role-arn', healthyRoleArn,
      '--denied-role-arn', deniedRoleArn,
      '--inventory-table-arn', tableArn,
      '--manifest-bucket', manifestBucket,
      '--manifest-key', manifestKey,
      '--baseline-memory', '256',
      '--supported-memory-mb', '256,256',
    ], { encoding: 'utf8' }),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(error.stderr, /supported-memory-mb must not contain duplicates/);
      return true;
    },
  );
});
