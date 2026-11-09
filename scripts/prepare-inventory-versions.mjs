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

function stableConfiguration(configuration) {
  const result = {};
  for (const key of CONFIGURATION_FIELDS) if (key in (configuration ?? {})) result[key] = configuration[key];
  return result;
}

function roleIndependentConfiguration(configuration) {
  const result = stableConfiguration(configuration);
  delete result.Role;
  return result;
}

function assertReleaseConfiguration(configuration, config, label, codeSha256) {
  if (!configuration || configuration.CodeSha256 !== codeSha256) fail(`${label} code hash does not match the release`);
  if (configuration.MemorySize !== config.baselineMemoryMb) fail(`${label} memory is not the baseline ${config.baselineMemoryMb} MB`);
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

function assertKnownManifest(manifest, config) {
  if (manifest?.schemaVersion !== 1
      || manifest.sourceRevision !== config.sourceRevision
      || manifest.functionName !== config.functionName
      || manifest.aliasName !== config.aliasName
      || manifest.baselineMemoryMb !== config.baselineMemoryMb
      || typeof manifest.codeSha256 !== 'string'
      || !Array.isArray(manifest.variants)
      || manifest.variants.length !== 2) {
    fail('existing manifest has the wrong schema or release identity');
  }
  const byAccess = Object.fromEntries(manifest.variants.map((variant) => [variant.access, variant]));
  if (!numericVersion(byAccess.healthy?.version) || !numericVersion(byAccess.denied?.version)
      || byAccess.healthy.version !== config.healthyVersion
      || byAccess.healthy.roleArn !== config.healthyRoleArn
      || byAccess.denied.roleArn !== config.deniedRoleArn
      || byAccess.healthy.memoryMb !== config.baselineMemoryMb
      || byAccess.denied.memoryMb !== config.baselineMemoryMb) {
    fail('existing manifest has the wrong prepared pair');
  }
  return { manifest, byAccess };
}

async function exactVersion(aws, config, versions, roleArn, codeSha256) {
  const candidates = [];
  for (const version of versions) {
    const number = version.Version;
    if (!numericVersion(number) || number === config.healthyVersion) continue;
    const qualified = await aws.getFunctionConfiguration({ functionName: config.functionName, qualifier: number });
    if (!qualified || qualified.Role !== roleArn) continue;
    try {
      assertReleaseConfiguration(qualified, config, `version ${number}`, codeSha256);
    } catch {
      continue;
    }
    candidates.push({ number, configuration: qualified });
  }
  if (candidates.length > 1) fail('more than one exact denied version matches the release');
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

async function restoreLatest(aws, config) {
  let latest = await aws.getFunctionConfiguration({ functionName: config.functionName });
  if (latest.LastUpdateStatus === 'InProgress') {
    await waitForReady(aws, config, { allowFailed: true });
    latest = await aws.getFunctionConfiguration({ functionName: config.functionName });
  }
  if (latest.Role === config.healthyRoleArn) return latest;
  if (latest.Role !== config.deniedRoleArn) fail(`refusing to restore unexpected staged role ${latest.Role}`);
  const restored = await aws.updateFunctionConfiguration({
    functionName: config.functionName,
    roleArn: config.healthyRoleArn,
    revisionId: latest.RevisionId,
  });
  await waitForReady(aws, config, { allowFailed: true });
  const readback = await aws.getFunctionConfiguration({ functionName: config.functionName });
  if (readback.Role !== config.healthyRoleArn) fail(`$LATEST restore did not return to ${config.healthyRoleArn}`);
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

export async function restoreRecognizedInventoryStaging({ config, aws }) {
  if (!config || !aws) fail('requires config and an AWS adapter');
  if (!/^[0-9a-f]{40}$/.test(config.sourceRevision)) fail('source revision must be a 40-character commit SHA');
  if (config.functionName !== 'IncidentTriageDemoInventory') fail('only the named Inventory function is supported');
  if (!numericVersion(config.healthyVersion)) fail('healthy version must be numeric');
  const alias = await aws.getAlias({ functionName: config.functionName, aliasName: config.aliasName ?? 'live' });
  assertNoRouting(alias, { ...config, aliasName: config.aliasName ?? 'live' });
  let latest = await aws.getFunctionConfiguration({ functionName: config.functionName });
  if (latest.LastUpdateStatus === 'InProgress') {
    await waitForReady(aws, config, { allowFailed: true });
    latest = await aws.getFunctionConfiguration({ functionName: config.functionName });
  }
  const healthy = await aws.getFunctionConfiguration({ functionName: config.functionName, qualifier: config.healthyVersion });
  const codeSha256 = healthy?.CodeSha256;
  if (!codeSha256) fail(`healthy version ${config.healthyVersion} does not expose a code hash`);
  assertReleaseConfiguration(healthy, config, `healthy version ${config.healthyVersion}`, codeSha256);
  if (healthy.Role !== config.healthyRoleArn) fail('healthy qualified version has the wrong role');
  assertReleaseConfiguration(latest, config, '$LATEST', codeSha256);
  if (canonical(roleIndependentConfiguration(latest)) !== canonical(roleIndependentConfiguration(healthy))) {
    fail('$LATEST has configuration drift beyond the recognized execution role');
  }
  if (latest.Role === config.healthyRoleArn) return { restored: false, latest };
  if (latest.Role !== config.deniedRoleArn) fail(`refusing unexpected staged role ${latest.Role}`);
  const restored = await restoreLatest(aws, config);
  const readback = await aws.getFunctionConfiguration({ functionName: config.functionName });
  if (readback.Role !== config.healthyRoleArn) fail('$LATEST staging recovery did not restore the healthy role');
  if (canonical(roleIndependentConfiguration(readback)) !== canonical(roleIndependentConfiguration(healthy))) {
    fail('$LATEST staging recovery changed non-role configuration');
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
  const existingObject = await aws.headObject({ bucket: config.manifestBucket, key: config.manifestKey });
  let existingManifest;
  if (existingObject) existingManifest = assertKnownManifest(JSON.parse(existingObject.body), config);

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
  assertReleaseConfiguration(healthy, config, `healthy version ${config.healthyVersion}`, codeSha256);
  if (healthy.Role !== config.healthyRoleArn) fail('healthy qualified version has the wrong role');
  assertReleaseConfiguration(latest, config, '$LATEST', codeSha256);
  if (canonical(roleIndependentConfiguration(latest)) !== canonical(roleIndependentConfiguration(healthy))) {
    fail('$LATEST has configuration drift beyond the recognized execution role');
  }
  if (latest.LastUpdateStatus === 'Failed' && latest.Role === config.deniedRoleArn) {
    await restoreLatest(aws, config);
    fail(`recognized staged role has a failed Lambda update: ${latest.LastUpdateStatusReason ?? 'unknown reason'}`);
  }

  let deniedVersion = existingManifest?.byAccess.denied.version;
  let deniedConfiguration;
  if (deniedVersion) {
    deniedConfiguration = await aws.getFunctionConfiguration({ functionName: config.functionName, qualifier: deniedVersion });
    assertReleaseConfiguration(deniedConfiguration, config, `denied version ${deniedVersion}`, codeSha256);
    if (deniedConfiguration.Role !== config.deniedRoleArn) fail('manifest denied version has the wrong role');
  } else {
    const versions = await aws.listVersions({ functionName: config.functionName });
    const existingDenied = await exactVersion(aws, config, versions, config.deniedRoleArn, codeSha256);
    if (existingDenied) {
      deniedVersion = existingDenied.number;
      deniedConfiguration = existingDenied.configuration;
    }
  }

  let restored = latest;
  if (!deniedVersion) {
    if (latest.Role !== config.healthyRoleArn && latest.Role !== config.deniedRoleArn) fail(`refusing unexpected $LATEST role drift ${latest.Role}`);
    let stagedRevision = latest.RevisionId;
    let publicationError;
    try {
      if (latest.Role === config.healthyRoleArn) {
        const staged = await aws.updateFunctionConfiguration({ functionName: config.functionName, roleArn: config.deniedRoleArn, revisionId: latest.RevisionId });
        await waitForReady(aws, config);
        const stagedReadback = await aws.getFunctionConfiguration({ functionName: config.functionName });
        assertReleaseConfiguration(stagedReadback, config, 'staged $LATEST', codeSha256);
        if (stagedReadback.Role !== config.deniedRoleArn) fail('role-only staging did not set the denied role');
        stagedRevision = stagedReadback.RevisionId ?? staged?.RevisionId;
      } else {
        const stagedReadback = await aws.getFunctionConfiguration({ functionName: config.functionName });
        assertReleaseConfiguration(stagedReadback, config, 'recognized staged $LATEST', codeSha256);
        stagedRevision = stagedReadback.RevisionId ?? stagedRevision;
      }
      try {
        const publication = await aws.publishVersion({ functionName: config.functionName, codeSha256, revisionId: stagedRevision, description: config.sourceRevision });
        deniedVersion = publication?.Version;
      } catch (error) {
        publicationError = error;
      }
      if (!numericVersion(deniedVersion)) {
        const reconciled = await exactVersion(aws, config, await aws.listVersions({ functionName: config.functionName }), config.deniedRoleArn, codeSha256);
        if (!reconciled) throw publicationError ?? new Error('publication did not return a version and no exact matching version exists');
        deniedVersion = reconciled.number;
        deniedConfiguration = reconciled.configuration;
      }
      deniedConfiguration ??= await aws.getFunctionConfiguration({ functionName: config.functionName, qualifier: deniedVersion });
      assertReleaseConfiguration(deniedConfiguration, config, `denied version ${deniedVersion}`, codeSha256);
      if (deniedConfiguration.Role !== config.deniedRoleArn) fail('published denied version has the wrong role');
    } finally {
      restored = await restoreLatest(aws, config);
    }
    if (publicationError && !numericVersion(deniedVersion)) throw publicationError;
  }

  if (latest.Role === config.deniedRoleArn && deniedVersion) restored = await restoreLatest(aws, config);

  const finalLatest = await aws.getFunctionConfiguration({ functionName: config.functionName });
  if (finalLatest.Role !== config.healthyRoleArn) fail('$LATEST was not restored to the healthy role');
  if (canonical(roleIndependentConfiguration(finalLatest)) !== canonical(roleIndependentConfiguration(latest))) fail('$LATEST restoration changed non-role configuration');
  const finalHealthy = await aws.getFunctionConfiguration({ functionName: config.functionName, qualifier: config.healthyVersion });
  const finalDenied = deniedConfiguration ?? await aws.getFunctionConfiguration({ functionName: config.functionName, qualifier: deniedVersion });
  assertReleaseConfiguration(finalHealthy, config, `healthy version ${config.healthyVersion}`, codeSha256);
  assertReleaseConfiguration(finalDenied, config, `denied version ${deniedVersion}`, codeSha256);
  if (finalHealthy.Role !== config.healthyRoleArn || finalDenied.Role !== config.deniedRoleArn) fail('prepared roles do not match the static pair');
  if (canonical(roleIndependentConfiguration(finalHealthy)) !== canonical(roleIndependentConfiguration(finalDenied))) fail('prepared pair differs beyond the execution role');
  await validatePolicyState(aws, config);

  const manifest = {
    schemaVersion: 1,
    sourceRevision: config.sourceRevision,
    functionName: config.functionName,
    aliasName: config.aliasName,
    baselineMemoryMb: config.baselineMemoryMb,
    codeSha256,
    variants: [
      { memoryMb: config.baselineMemoryMb, access: 'healthy', version: config.healthyVersion, roleArn: config.healthyRoleArn },
      { memoryMb: config.baselineMemoryMb, access: 'denied', version: deniedVersion, roleArn: config.deniedRoleArn },
    ],
  };
  const manifestBody = `${JSON.stringify(manifest, null, 2)}\n`;
  if (existingManifest && canonical(existingManifest.manifest) !== canonical(manifest)) fail('existing manifest identity differs from the verified pair');
  await publishManifest(aws, config, manifestBody);
  return { manifest, manifestBody, manifestBucket: config.manifestBucket, manifestKey: config.manifestKey, healthyVersion: config.healthyVersion, deniedVersion, restored };
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
    updateFunctionConfiguration: ({ functionName, roleArn, revisionId }) => cliJson(['lambda', 'update-function-configuration', '--function-name', functionName, '--role', roleArn, '--revision-id', revisionId]),
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = argumentMap(process.argv.slice(2));
  const restoreOnly = args['restore-staging-only'] === 'true';
  const required = ['function-name', 'source-revision', 'healthy-version', 'healthy-role-arn', 'denied-role-arn', 'inventory-table-arn'];
  if (!restoreOnly) required.push('manifest-bucket', 'manifest-key');
  for (const key of required) if (!args[key]) fail(`missing --${key}`);
  const deniedRoleName = args['denied-role-arn'].split('/').at(-1);
  const healthyRoleName = args['healthy-role-arn'].split('/').at(-1);
  const config = {
    sourceRevision: args['source-revision'],
    functionName: args['function-name'],
    aliasName: args['alias-name'] ?? 'live',
    baselineMemoryMb: Number(args['baseline-memory'] ?? '256'),
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
}
