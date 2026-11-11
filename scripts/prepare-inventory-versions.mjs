#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFile = promisify(execFileCallback);
const ACCOUNT = process.env.AWS_ACCOUNT_ID ?? '027224425948';
const REGION = process.env.AWS_REGION ?? 'us-east-1';
const DEFAULT_POLICY_ARN = `arn:aws:iam::${ACCOUNT}:policy/IncidentTriageDemoInventoryReadDeny`;
const CONFIGURATION_FIELDS = ['Runtime', 'Role', 'Handler', 'CodeSha256', 'Timeout', 'MemorySize', 'Environment', 'Architectures', 'EphemeralStorage', 'LoggingConfig', 'TracingConfig', 'VpcConfig', 'Layers', 'DeadLetterConfig', 'FileSystemConfigs', 'KMSKeyArn', 'PackageType', 'SnapStart'];

function fail(message) {
  throw new Error(`Inventory version preparation: ${message}`);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function numericVersion(value) {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
}

function supportedMemorySizes(config) {
  const values = config.supportedMemoryMb ?? [config.baselineMemoryMb];
  if (!Array.isArray(values) || values.length === 0) fail('supported memory sizes must be a non-empty list');
  if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) fail('supported memory sizes must be positive integers');
  if (new Set(values).size !== values.length) fail('supported memory sizes must not contain duplicates');
  if (!values.includes(config.baselineMemoryMb)) fail('supported memory sizes must include the baseline memory');
  return [...values].sort((left, right) => left - right);
}

function variantKey(memoryMb, access) {
  return `${memoryMb}:${access}`;
}

function variantsFor(supportedMemoryMb, config) {
  return supportedMemoryMb.flatMap((memoryMb) => [
    { memoryMb, access: 'healthy', roleArn: config.healthyRoleArn },
    { memoryMb, access: 'denied', roleArn: config.deniedRoleArn },
  ]);
}

function stableConfiguration(configuration) {
  const result = {};
  for (const key of CONFIGURATION_FIELDS) if (key in (configuration ?? {})) result[key] = configuration[key];
  return result;
}

function variantIndependentConfiguration(configuration) {
  const result = stableConfiguration(configuration);
  delete result.Role;
  delete result.MemorySize;
  return result;
}

function assertReleaseConfiguration(configuration, config, label, codeSha256, memoryMb = config.baselineMemoryMb) {
  if (!configuration || configuration.CodeSha256 !== codeSha256) fail(`${label} code hash does not match the release`);
  if (configuration.MemorySize !== memoryMb) fail(`${label} memory is not the expected ${memoryMb} MB`);
  const environment = configuration?.Environment ?? {};
  if (environment.Error) fail(`${label} environment decrypt failed (${environment.Error.ErrorCode ?? 'unknown'})`);
  const variables = environment.Variables ?? {};
  if (variables.SOURCE_REVISION !== config.sourceRevision) fail(`${label} SOURCE_REVISION does not match ${config.sourceRevision}`);
  if (variables.APP_ENVIRONMENT !== 'demo') fail(`${label} APP_ENVIRONMENT is not demo`);
  if (variables.INVENTORY_TABLE_NAME !== config.inventoryTableArn) fail(`${label} Inventory table does not match the release`);
  if (variables.PRODUCT_SKU !== 'demo-widget') fail(`${label} product SKU does not match the release`);
}

function assertNoRouting(alias, config) {
  if (!alias || alias.Name !== config.aliasName) fail(`missing ${config.aliasName} Inventory alias`);
  if (alias.FunctionVersion !== config.healthyVersion) fail(`live alias is ${alias.FunctionVersion}, expected healthy ${config.healthyVersion}`);
  if (Object.keys(alias.RoutingConfig?.AdditionalVersionWeights ?? {}).length > 0) fail('live alias has weighted targets');
}

function policyStatements(policy) {
  return Array.isArray(policy?.Statement) ? policy.Statement : policy?.Statement ? [policy.Statement] : [];
}

function assertDenyPolicy(policy, config) {
  const statements = policyStatements(policy);
  const match = statements.find((statement) => statement.Effect === 'Deny'
    && canonical([statement.Action].flat()) === canonical(['dynamodb:GetItem'])
    && canonical([statement.Resource].flat()) === canonical([config.inventoryTableArn]));
  if (!match || statements.length !== 1) fail('denial policy is not the exact single GetItem Deny on the Inventory table');
}

function assertKnownManifest(manifest, config, supportedMemoryMb) {
  const expected = variantsFor(supportedMemoryMb, config);
  if (manifest?.schemaVersion !== 1
      || manifest.sourceRevision !== config.sourceRevision
      || manifest.functionName !== config.functionName
      || manifest.aliasName !== config.aliasName
      || manifest.baselineMemoryMb !== config.baselineMemoryMb
      || typeof manifest.codeSha256 !== 'string'
      || !Array.isArray(manifest.variants)
      || manifest.variants.length !== expected.length) {
    fail('existing manifest has the wrong schema or release identity');
  }
  const byVariant = new Map();
  const versions = new Set();
  for (const variant of manifest.variants) {
    if (!variant || typeof variant !== 'object' || Array.isArray(variant)) fail('existing manifest contains an invalid variant entry');
    const expectedVariant = expected.find(({ memoryMb, access }) => variantKey(memoryMb, access) === variantKey(variant.memoryMb, variant.access));
    if (!expectedVariant || variant.roleArn !== expectedVariant.roleArn || !numericVersion(variant.version) || versions.has(variant.version)) {
      fail('existing manifest has an invalid or duplicate prepared variant');
    }
    versions.add(variant.version);
    byVariant.set(variantKey(variant.memoryMb, variant.access), variant);
  }
  if (byVariant.size !== expected.length) fail('existing manifest is missing a supported memory/access variant');
  if (byVariant.get(variantKey(config.baselineMemoryMb, 'healthy'))?.version !== config.healthyVersion) {
    fail('existing manifest does not retain the deployed healthy baseline version');
  }
  return { manifest, byVariant };
}

async function exactVersion(aws, config, versions, variant, codeSha256, healthyConfiguration) {
  const candidates = [];
  for (const version of versions) {
    const number = version.Version;
    if (!numericVersion(number) || number === config.healthyVersion) continue;
    if (version.CodeSha256 && version.CodeSha256 !== codeSha256) continue;
    if (version.Description && version.Description !== config.sourceRevision) continue;
    if (version.Role && version.Role !== variant.roleArn) continue;
    if (version.MemorySize !== undefined && version.MemorySize !== variant.memoryMb) continue;
    const qualified = await aws.getFunctionConfiguration({ functionName: config.functionName, qualifier: number });
    if (!qualified || qualified.Role !== variant.roleArn) continue;
    if (qualified.Version !== undefined && String(qualified.Version) !== number) continue;
    try {
      assertReleaseConfiguration(qualified, config, `version ${number}`, codeSha256, variant.memoryMb);
    } catch {
      continue;
    }
    if (canonical(variantIndependentConfiguration(qualified)) !== canonical(variantIndependentConfiguration(healthyConfiguration))) continue;
    candidates.push({ number, configuration: qualified });
    if (candidates.length > 1) fail(`more than one exact ${variant.memoryMb} MB ${variant.access} version matches the release`);
  }
  return candidates[0] ?? null;
}

async function waitForReady(aws, config, { allowFailed = false } = {}) {
  if (typeof aws.waitForFunctionReady === 'function') {
    await aws.waitForFunctionReady({ functionName: config.functionName });
    return;
  }
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const latest = await aws.getFunctionConfiguration({ functionName: config.functionName });
    if (latest.LastUpdateStatus === 'Successful' || latest.LastUpdateStatus === undefined) return;
    if (latest.LastUpdateStatus === 'Failed') {
      if (allowFailed) return latest;
      fail(`Lambda configuration update failed: ${latest.LastUpdateStatusReason ?? 'unknown reason'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  fail('Lambda configuration update did not settle');
}

async function restoreLatest(aws, config, supportedMemoryMb, healthyConfiguration, codeSha256) {
  let latest = await aws.getFunctionConfiguration({ functionName: config.functionName });
  if (latest.LastUpdateStatus === 'InProgress') {
    await waitForReady(aws, config, { allowFailed: true });
    latest = await aws.getFunctionConfiguration({ functionName: config.functionName });
  }
  if (![config.healthyRoleArn, config.deniedRoleArn].includes(latest.Role)) fail(`refusing to restore unexpected staged role ${latest.Role}`);
  if (!supportedMemoryMb.includes(latest.MemorySize)) fail(`refusing to restore unexpected staged memory ${latest.MemorySize}`);
  assertReleaseConfiguration(latest, config, 'staged $LATEST', codeSha256, latest.MemorySize);
  if (canonical(variantIndependentConfiguration(latest)) !== canonical(variantIndependentConfiguration(healthyConfiguration))) {
    fail('$LATEST staging recovery found non-memory configuration drift');
  }
  if (latest.Role === config.healthyRoleArn && latest.MemorySize === config.baselineMemoryMb) return latest;
  const restored = await aws.updateFunctionConfiguration({
    functionName: config.functionName,
    roleArn: config.healthyRoleArn,
    memorySize: config.baselineMemoryMb,
    revisionId: latest.RevisionId,
  });
  await waitForReady(aws, config, { allowFailed: true });
  const readback = await aws.getFunctionConfiguration({ functionName: config.functionName });
  assertReleaseConfiguration(readback, config, 'restored $LATEST', codeSha256, config.baselineMemoryMb);
  if (readback.Role !== config.healthyRoleArn || readback.MemorySize !== config.baselineMemoryMb) {
    fail(`$LATEST restore did not return to the ${config.baselineMemoryMb} MB healthy configuration`);
  }
  if (canonical(variantIndependentConfiguration(readback)) !== canonical(variantIndependentConfiguration(healthyConfiguration))) {
    fail('$LATEST restore changed non-memory configuration');
  }
  return restored ?? readback;
}

async function validatePolicyState(aws, config) {
  const [healthyPolicies, deniedPolicies] = await Promise.all([
    aws.getRolePolicyAttachments({ roleName: config.healthyRoleName }),
    aws.getRolePolicyAttachments({ roleName: config.deniedRoleName }),
  ]);
  if ((healthyPolicies ?? []).some(({ PolicyArn }) => PolicyArn === config.deniedPolicyArn)) {
    fail('healthy Inventory role has the denial policy attached');
  }
  if (!(deniedPolicies ?? []).some(({ PolicyArn }) => PolicyArn === config.deniedPolicyArn)) {
    fail('denied Inventory role is missing the denial policy');
  }
  const policy = await aws.getPolicyDocument({ policyArn: config.deniedPolicyArn });
  assertDenyPolicy(policy, config);
}

function assertVariantConfiguration(configuration, config, variant, codeSha256, healthyConfiguration, label, expectedVersion) {
  assertReleaseConfiguration(configuration, config, label, codeSha256, variant.memoryMb);
  if (expectedVersion && String(configuration.Version) !== expectedVersion) fail(`${label} readback returned a different qualified version`);
  if (configuration.Role !== variant.roleArn) fail(`${label} has the wrong ${variant.access} execution role`);
  if (canonical(variantIndependentConfiguration(configuration)) !== canonical(variantIndependentConfiguration(healthyConfiguration))) {
    fail(`${label} differs from the release beyond its role and memory`);
  }
}

async function publishVariant(aws, config, variant, supportedMemoryMb, healthyConfiguration, codeSha256) {
  let publishedVersion;
  let publishedConfiguration;
  try {
    let latest = await aws.getFunctionConfiguration({ functionName: config.functionName });
    if (latest.LastUpdateStatus === 'InProgress') {
      await waitForReady(aws, config, { allowFailed: true });
      latest = await aws.getFunctionConfiguration({ functionName: config.functionName });
    }
    if (![config.healthyRoleArn, config.deniedRoleArn].includes(latest.Role)) fail(`refusing unexpected staged role ${latest.Role}`);
    if (!supportedMemoryMb.includes(latest.MemorySize)) fail(`refusing unexpected staged memory ${latest.MemorySize}`);
    assertReleaseConfiguration(latest, config, '$LATEST before staging', codeSha256, latest.MemorySize);
    if (canonical(variantIndependentConfiguration(latest)) !== canonical(variantIndependentConfiguration(healthyConfiguration))) {
      fail('$LATEST has configuration drift before variant publication');
    }
    if (latest.LastUpdateStatus === 'Failed') {
      fail(`recognized staged $LATEST has a failed Lambda update: ${latest.LastUpdateStatusReason ?? 'unknown reason'}`);
    }

    if (latest.Role !== variant.roleArn || latest.MemorySize !== variant.memoryMb) {
      await aws.updateFunctionConfiguration({
        functionName: config.functionName,
        roleArn: variant.roleArn,
        memorySize: variant.memoryMb,
        revisionId: latest.RevisionId,
      });
      await waitForReady(aws, config);
      latest = await aws.getFunctionConfiguration({ functionName: config.functionName });
    }
    assertVariantConfiguration(latest, config, variant, codeSha256, healthyConfiguration, 'staged $LATEST');

    let publicationError;
    try {
      const publication = await aws.publishVersion({
        functionName: config.functionName,
        codeSha256,
        revisionId: latest.RevisionId,
        description: config.sourceRevision,
      });
      publishedVersion = publication?.Version;
    } catch (error) {
      publicationError = error;
    }

    if (!numericVersion(publishedVersion)) {
      const reconciled = await exactVersion(
        aws,
        config,
        await aws.listVersions({ functionName: config.functionName }),
        variant,
        codeSha256,
        healthyConfiguration,
      );
      if (!reconciled) throw publicationError ?? new Error('publication did not return a version and no exact matching version exists');
      publishedVersion = reconciled.number;
      publishedConfiguration = reconciled.configuration;
    }
    publishedConfiguration ??= await aws.getFunctionConfiguration({ functionName: config.functionName, qualifier: publishedVersion });
    assertVariantConfiguration(publishedConfiguration, config, variant, codeSha256, healthyConfiguration, `version ${publishedVersion}`, publishedVersion);
  } finally {
    await restoreLatest(aws, config, supportedMemoryMb, healthyConfiguration, codeSha256);
  }
  return { version: publishedVersion, configuration: publishedConfiguration };
}

export async function restoreRecognizedInventoryStaging({ config, aws }) {
  if (!config || !aws) fail('requires config and an AWS adapter');
  if (!/^[0-9a-f]{40}$/.test(config.sourceRevision)) fail('source revision must be a 40-character commit SHA');
  if (config.functionName !== 'IncidentTriageDemoInventory') fail('only the named Inventory function is supported');
  if (!numericVersion(config.healthyVersion)) fail('healthy version must be numeric');
  const supported = supportedMemorySizes(config);
  const normalizedConfig = { ...config, aliasName: config.aliasName ?? 'live' };
  const alias = await aws.getAlias({ functionName: config.functionName, aliasName: normalizedConfig.aliasName });
  assertNoRouting(alias, normalizedConfig);
  let latest = await aws.getFunctionConfiguration({ functionName: config.functionName });
  if (latest.LastUpdateStatus === 'InProgress') {
    await waitForReady(aws, config, { allowFailed: true });
    latest = await aws.getFunctionConfiguration({ functionName: config.functionName });
  }
  const healthy = await aws.getFunctionConfiguration({ functionName: config.functionName, qualifier: config.healthyVersion });
  const codeSha256 = healthy?.CodeSha256;
  if (!codeSha256) fail(`healthy version ${config.healthyVersion} does not expose a code hash`);
  assertReleaseConfiguration(healthy, normalizedConfig, `healthy version ${config.healthyVersion}`, codeSha256, config.baselineMemoryMb);
  if (healthy.Role !== config.healthyRoleArn) fail('healthy qualified version has the wrong role');
  if (![config.healthyRoleArn, config.deniedRoleArn].includes(latest.Role)) fail(`refusing unexpected staged role ${latest.Role}`);
  if (!supported.includes(latest.MemorySize)) fail(`refusing unexpected staged memory ${latest.MemorySize}`);
  assertReleaseConfiguration(latest, normalizedConfig, '$LATEST', codeSha256, latest.MemorySize);
  if (canonical(variantIndependentConfiguration(latest)) !== canonical(variantIndependentConfiguration(healthy))) {
    fail('$LATEST has configuration drift beyond the recognized role and memory settings');
  }
  if (latest.Role === config.healthyRoleArn && latest.MemorySize === config.baselineMemoryMb) return { restored: false, latest };
  const restored = await restoreLatest(aws, normalizedConfig, supported, healthy, codeSha256);
  const readback = await aws.getFunctionConfiguration({ functionName: config.functionName });
  assertReleaseConfiguration(readback, normalizedConfig, 'restored $LATEST', codeSha256, config.baselineMemoryMb);
  if (readback.Role !== config.healthyRoleArn || readback.MemorySize !== config.baselineMemoryMb) {
    fail('$LATEST staging recovery did not restore the healthy baseline');
  }
  if (canonical(variantIndependentConfiguration(readback)) !== canonical(variantIndependentConfiguration(healthy))) {
    fail('$LATEST staging recovery changed non-memory configuration');
  }
  return { restored: true, latest: readback, restoredFrom: latest, update: restored };
}

async function publishManifest(aws, config, manifestBody) {
  const existing = await aws.headObject({ bucket: config.manifestBucket, key: config.manifestKey });
  if (existing) {
    if (existing.body !== manifestBody) fail('immutable manifest already exists with different bytes');
    return;
  }
  try {
    await aws.putObject({
      bucket: config.manifestBucket,
      key: config.manifestKey,
      body: manifestBody,
      contentType: 'application/json',
      serverSideEncryption: 'AES256',
      ifNoneMatch: '*',
    });
  } catch (error) {
    const afterRace = await aws.headObject({ bucket: config.manifestBucket, key: config.manifestKey });
    if (!afterRace || afterRace.body !== manifestBody) throw error;
  }
  const readback = await aws.headObject({ bucket: config.manifestBucket, key: config.manifestKey });
  if (!readback || readback.body !== manifestBody) fail('manifest publication readback does not match the prepared bytes');
}

export async function prepareInventoryVersions({ config, aws }) {
  if (!config || !aws) fail('requires config and an AWS adapter');
  if (!/^[0-9a-f]{40}$/.test(config.sourceRevision)) fail('source revision must be a 40-character commit SHA');
  if (config.functionName !== 'IncidentTriageDemoInventory') fail('only the named Inventory function is supported');
  if (!numericVersion(config.healthyVersion)) fail('healthy version must be numeric');
  if (config.aliasName !== 'live') fail('only the live alias is supported');
  if (config.manifestKey !== `releases/app/${config.sourceRevision}/inventory-variants.json`) fail('manifest key is not revision scoped');
  const supported = supportedMemorySizes(config);
  const expectedVariants = variantsFor(supported, config);
  const existingObject = await aws.headObject({ bucket: config.manifestBucket, key: config.manifestKey });
  let existingManifest;
  if (existingObject) {
    let parsedManifest;
    try {
      parsedManifest = JSON.parse(existingObject.body);
    } catch {
      fail('existing manifest is not valid JSON');
    }
    existingManifest = assertKnownManifest(parsedManifest, config, supported);
  }

  const alias = await aws.getAlias({ functionName: config.functionName, aliasName: config.aliasName });
  assertNoRouting(alias, config);
  let latest = await aws.getFunctionConfiguration({ functionName: config.functionName });
  if (latest.LastUpdateStatus === 'InProgress') {
    await waitForReady(aws, config, { allowFailed: true });
    latest = await aws.getFunctionConfiguration({ functionName: config.functionName });
  }
  const healthy = await aws.getFunctionConfiguration({ functionName: config.functionName, qualifier: config.healthyVersion });
  const codeSha256 = healthy?.CodeSha256;
  if (!codeSha256) fail(`healthy version ${config.healthyVersion} does not expose a code hash`);
  const baselineHealthy = { memoryMb: config.baselineMemoryMb, access: 'healthy', roleArn: config.healthyRoleArn };
  assertVariantConfiguration(healthy, config, baselineHealthy, codeSha256, healthy, `healthy version ${config.healthyVersion}`, config.healthyVersion);
  if (healthy.Role !== config.healthyRoleArn) fail('healthy qualified version has the wrong role');
  if (![config.healthyRoleArn, config.deniedRoleArn].includes(latest.Role)) fail(`refusing unexpected $LATEST role ${latest.Role}`);
  if (!supported.includes(latest.MemorySize)) fail(`refusing unexpected $LATEST memory ${latest.MemorySize}`);
  assertReleaseConfiguration(latest, config, '$LATEST', codeSha256, latest.MemorySize);
  if (canonical(variantIndependentConfiguration(latest)) !== canonical(variantIndependentConfiguration(healthy))) {
    fail('$LATEST has configuration drift beyond the recognized role and memory settings');
  }
  if (latest.LastUpdateStatus === 'Failed') {
    if (latest.Role !== config.healthyRoleArn || latest.MemorySize !== config.baselineMemoryMb) {
      await restoreLatest(aws, config, supported, healthy, codeSha256);
    }
    fail(`recognized staged $LATEST has a failed Lambda update: ${latest.LastUpdateStatusReason ?? 'unknown reason'}`);
  }

  if (existingManifest && existingManifest.manifest.codeSha256 !== codeSha256) {
    fail('existing manifest code hash does not match the healthy release');
  }
  await validatePolicyState(aws, config);

  const prepared = new Map();
  if (existingManifest) {
    for (const variant of expectedVariants) {
      const manifestVariant = existingManifest.byVariant.get(variantKey(variant.memoryMb, variant.access));
      const configuration = await aws.getFunctionConfiguration({ functionName: config.functionName, qualifier: manifestVariant.version });
      assertVariantConfiguration(configuration, config, variant, codeSha256, healthy, `manifest version ${manifestVariant.version}`, manifestVariant.version);
      prepared.set(variantKey(variant.memoryMb, variant.access), { ...variant, version: manifestVariant.version });
    }
  } else {
    const versions = await aws.listVersions({ functionName: config.functionName });
    for (const variant of expectedVariants) {
      const key = variantKey(variant.memoryMb, variant.access);
      if (key === variantKey(config.baselineMemoryMb, 'healthy')) {
        prepared.set(key, { ...variant, version: config.healthyVersion });
        continue;
      }
      const existing = await exactVersion(aws, config, versions, variant, codeSha256, healthy);
      const result = existing ?? await publishVariant(aws, config, variant, supported, healthy, codeSha256);
      prepared.set(key, { ...variant, version: result.number ?? result.version });
    }
  }

  const restored = await restoreLatest(aws, config, supported, healthy, codeSha256);
  const finalLatest = await aws.getFunctionConfiguration({ functionName: config.functionName });
  assertVariantConfiguration(finalLatest, config, baselineHealthy, codeSha256, healthy, 'restored $LATEST');
  if (canonical(stableConfiguration(finalLatest)) !== canonical(stableConfiguration(healthy))) {
    fail('$LATEST restoration changed the original baseline configuration');
  }

  for (const variant of expectedVariants) {
    const preparedVariant = prepared.get(variantKey(variant.memoryMb, variant.access));
    const configuration = await aws.getFunctionConfiguration({ functionName: config.functionName, qualifier: preparedVariant.version });
    assertVariantConfiguration(configuration, config, variant, codeSha256, healthy, `prepared version ${preparedVariant.version}`, preparedVariant.version);
  }
  await validatePolicyState(aws, config);

  const manifest = {
    schemaVersion: 1,
    sourceRevision: config.sourceRevision,
    functionName: config.functionName,
    aliasName: config.aliasName,
    baselineMemoryMb: config.baselineMemoryMb,
    codeSha256,
    variants: expectedVariants.map((variant) => ({
      ...variant,
      version: prepared.get(variantKey(variant.memoryMb, variant.access)).version,
    })),
  };
  if (existingManifest && canonical(existingManifest.manifest) !== canonical(manifest)) fail('existing manifest identity differs from the verified matrix');
  const manifestBody = existingObject ? existingObject.body : `${JSON.stringify(manifest, null, 2)}\n`;
  await publishManifest(aws, config, manifestBody);
  return {
    manifest,
    manifestBody,
    manifestBucket: config.manifestBucket,
    manifestKey: config.manifestKey,
    healthyVersion: config.healthyVersion,
    deniedVersion: prepared.get(variantKey(config.baselineMemoryMb, 'denied')).version,
    restored,
  };
}

async function cliJson(args) {
  try {
    const { stdout } = await execFile('aws', [...args, '--region', REGION, '--output', 'json'], { maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    error.command = `aws ${args.join(' ')}`;
    throw error;
  }
}

function cliAws() {
  let s3Client;
  return {
    getFunctionConfiguration: ({ functionName, qualifier }) => cliJson(['lambda', 'get-function-configuration', '--function-name', functionName, ...(qualifier ? ['--qualifier', String(qualifier)] : [])]),
    getAlias: ({ functionName, aliasName }) => cliJson(['lambda', 'get-alias', '--function-name', functionName, '--name', aliasName]),
    updateFunctionConfiguration: ({ functionName, roleArn, memorySize, revisionId }) => cliJson(['lambda', 'update-function-configuration', '--function-name', functionName, '--role', roleArn, '--memory-size', String(memorySize), '--revision-id', revisionId]),
    publishVersion: ({ functionName, codeSha256, revisionId, description }) => cliJson(['lambda', 'publish-version', '--function-name', functionName, '--code-sha256', codeSha256, '--revision-id', revisionId, '--description', description]),
    listVersions: async ({ functionName }) => (await cliJson(['lambda', 'list-versions-by-function', '--function-name', functionName])).Versions ?? [],
    getRolePolicyAttachments: async ({ roleName }) => (await cliJson(['iam', 'list-attached-role-policies', '--role-name', roleName])).AttachedPolicies ?? [],
    getPolicyDocument: async ({ policyArn }) => {
      const policy = await cliJson(['iam', 'get-policy', '--policy-arn', policyArn]);
      const version = await cliJson(['iam', 'get-policy-version', '--policy-arn', policyArn, '--version-id', policy.Policy.DefaultVersionId]);
      const encoded = version.PolicyVersion.Document;
      return typeof encoded === 'string' ? JSON.parse(decodeURIComponent(encoded)) : encoded;
    },
    headObject: async ({ bucket, key }) => {
      let metadata;
      try {
        metadata = await cliJson(['s3api', 'head-object', '--bucket', bucket, '--key', key, '--expected-bucket-owner', ACCOUNT]);
      } catch (error) {
        if (/404|NotFound|NoSuchKey|Not Found/i.test(error.stderr ?? error.message ?? '')) return null;
        throw error;
      }
      const directory = await mkdtemp(join(tmpdir(), 'incident-triage-manifest-'));
      const bodyPath = join(directory, 'manifest.json');
      try {
        await execFile('aws', ['s3api', 'get-object', '--bucket', bucket, '--key', key, '--expected-bucket-owner', ACCOUNT, bodyPath, '--region', REGION], { maxBuffer: 1_024 * 1_024 });
        return { ...metadata, body: await readFile(bodyPath, 'utf8') };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    putObject: async ({ bucket, key, body, contentType, serverSideEncryption, ifNoneMatch }) => {
      const { PutObjectCommand, S3Client } = await import('@aws-sdk/client-s3');
      s3Client ??= new S3Client({ region: REGION });
      return s3Client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: Buffer.from(body, 'utf8'),
        ContentType: contentType,
        ServerSideEncryption: serverSideEncryption,
        IfNoneMatch: ifNoneMatch,
        ExpectedBucketOwner: ACCOUNT,
      }));
    },
  };
}

function argumentMap(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    result[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

function parseSupportedMemoryMb(value) {
  if (typeof value !== 'string' || !value) fail('missing --supported-memory-mb');
  const entries = value.split(',');
  if (entries.some((entry) => !/^[1-9][0-9]*$/.test(entry))) fail('--supported-memory-mb must be a comma-separated list of positive integers');
  const values = entries.map(Number);
  if (values.some((entry) => !Number.isSafeInteger(entry))) fail('--supported-memory-mb contains an out-of-range value');
  if (new Set(values).size !== values.length) fail('--supported-memory-mb must not contain duplicates');
  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = argumentMap(process.argv.slice(2));
    const restoreOnly = args['restore-staging-only'] === 'true';
    const required = ['function-name', 'source-revision', 'healthy-version', 'healthy-role-arn', 'denied-role-arn', 'inventory-table-arn', 'supported-memory-mb'];
    if (!restoreOnly) required.push('manifest-bucket', 'manifest-key');
    for (const key of required) if (!args[key]) fail(`missing --${key}`);
    const deniedRoleName = args['denied-role-arn'].split('/').at(-1);
    const healthyRoleName = args['healthy-role-arn'].split('/').at(-1);
    const config = {
      sourceRevision: args['source-revision'],
      functionName: args['function-name'],
      aliasName: args['alias-name'] ?? 'live',
      baselineMemoryMb: Number(args['baseline-memory'] ?? '256'),
      supportedMemoryMb: parseSupportedMemoryMb(args['supported-memory-mb']),
      healthyVersion: args['healthy-version'],
      healthyRoleArn: args['healthy-role-arn'],
      deniedRoleArn: args['denied-role-arn'],
      healthyRoleName,
      deniedRoleName,
      deniedPolicyArn: args['denied-policy-arn'] ?? DEFAULT_POLICY_ARN,
      inventoryTableArn: args['inventory-table-arn'],
      manifestBucket: args['manifest-bucket'],
      manifestKey: args['manifest-key'],
    };
    const operation = restoreOnly
      ? restoreRecognizedInventoryStaging({ config, aws: cliAws() })
      : prepareInventoryVersions({ config, aws: cliAws() });
    operation
      .then((result) => {
        console.log(JSON.stringify({ manifestBucket: result.manifestBucket, manifestKey: result.manifestKey, healthyVersion: result.healthyVersion, deniedVersion: result.deniedVersion }));
      })
      .catch((error) => {
        console.error(error.stack ?? error.message ?? error);
        process.exitCode = 1;
      });
  } catch (error) {
    console.error(error.message ?? error);
    process.exitCode = 1;
  }
}
