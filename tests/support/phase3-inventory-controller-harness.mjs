import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const account = '027224425948';
export const region = 'us-east-1';
export const appRevision = '7dca23a7ec0f2d9870c5e25285e3c0e200bc1ff2';
export const newerRevision = '8e5a48bc0edcd7a65b9cc857ea2d17d4f5da2a90';
export const table = 'IncidentTriageDemoInventory';
export const tableArn = `arn:aws:dynamodb:${region}:${account}:table/${table}`;
export const inventoryRoleArn = `arn:aws:iam::${account}:role/IncidentTriageDemoAppInventoryRole`;
export const inventoryRoleName = 'IncidentTriageDemoAppInventoryRole';
export const deniedRoleArn = `arn:aws:iam::${account}:role/IncidentTriageDemoAppInventoryDeniedRole`;
export const deniedRoleName = 'IncidentTriageDemoAppInventoryDeniedRole';
export const policyName = 'IncidentTriageDemoInventoryReadDeny';
export const policyArn = `arn:aws:iam::${account}:policy/${policyName}`;
export const checkoutRoleArn = `arn:aws:iam::${account}:role/IncidentTriageDemoAppCheckoutRole`;
export const appApi = 'https://fixtureapi.execute-api.us-east-1.amazonaws.com';
export const operatorBearer = 'fixture-operator';
export const appBearer = 'fixture-app';
export const runTable = 'ControllerRunFixture';
export const ordersTable = 'IncidentTriageDemoOrders';
export const evidenceBucket = 'incident-triage-demo-evidence-027224425948-us-east-1';
export const evidencePrefix = 'configuration/';
export const manifestBucket = 'cdk-evaltalk-assets-027224425948-us-east-1';
export const manifestKey = `releases/app/${appRevision}/inventory-variants.json`;
export function currentManifestKey() {
  return `releases/app/${fixture.revision}/inventory-variants.json`;
}
export const healthyVersion = '2';
export const deniedVersion = '3';

export const records = new Map();
export const fixture = {
  appRequests: [],
  businessRequests: [],
  businessMutations: [],
  businessOperationCounts: new Map(),
  businessFailure: undefined,
  beforeBusinessRequest: undefined,
  afterBusinessRequest: undefined,
  failResetCompletion: false,
  ordersScanPageSize: 1000,
  ordersScanPages: 0,
  invocations: [],
  mutations: [],
  dynamoPolicyReads: [],
  iamReads: [],
  manifestReads: [],
  aliasReads: [],
  aliasUpdates: [],
  aliasUpdateAttempts: [],
  checkpointObjects: [],
  afterCheckpoint: undefined,
  trace: [],
  configurationReads: [],
  concurrencyReads: [],
  concurrencyAttempts: [],
  concurrencyWrites: [],
  concurrencyMode: 'apply',
  alarmReads: [],
  unhandled: [],
  revision: appRevision,
  stackStatus: 'UPDATE_COMPLETE',
  stackId: '11111111-1111-4111-8111-111111111111',
  stackCreatedAt: '2026-11-05T00:00:00.000Z',
  stackLastUpdatedAt: '2026-11-05T00:00:00.000Z',
  credentialGeneration: 'fixture-generation',
  baselineMemoryMb: 256,
  inventoryExpectedVersion: healthyVersion,
  inventoryExpectedConcurrency: 'unreserved',
  checkoutExpectedConcurrency: 'unreserved',
  healthyRoleAttached: false,
  deniedRoleAttached: true,
  iamPolicyDocument: undefined,
  iamDefaultVersionId: 'v1',
  iamVersionDocuments: new Map(),
  manifestCodeSha256: 'fixture-code',
  extraVariants: [],
  versionOverrides: {},
  inventoryConcurrency: undefined,
  checkoutConcurrency: undefined,
  aliasMode: 'apply',
  beforeAliasUpdate: undefined,
  aliasUpdateEntered: false,
  checkpointMode: 'store',
  aliasVersion: { Checkout: healthyVersion, Inventory: healthyVersion },
  aliasRevision: 'alias-revision-1',
  manifestMode: 'valid',
  deniedConfigMode: 'valid',
  weightedAlias: false,
  appMode: 'denied',
  appStock: 99,
  appProductVersion: 'fixture-product-v1',
  appOrders: new Map(),
  appOrderIds: new Map(),
  heldRequests: new Set(),
};

export function row(pk) {
  return records.get(pk);
}

export function omitOriginalBaseline() {
  const state = row('STATE');
  if (state?.data) delete state.data.originalBaseline;
}

export function put(value) {
  records.set(value.pk, value);
}

export function iamPolicyDocument() {
  return {
    Version: '2012-10-17',
    Statement: [{ Sid: 'DenyInventoryGetItem', Effect: 'Deny', Action: 'dynamodb:GetItem', Resource: tableArn }],
  };
}

export function variantsManifest() {
  if (fixture.manifestMode === 'malformed') return { schemaVersion: 1, variants: [] };
  return {
    schemaVersion: 1,
    sourceRevision: fixture.manifestMode === 'stale' ? newerRevision : fixture.revision,
    functionName: 'IncidentTriageDemoInventory',
    aliasName: 'live',
    baselineMemoryMb: 256,
    codeSha256: fixture.manifestCodeSha256,
    variants: [
      { memoryMb: 256, access: 'healthy', version: healthyVersion, roleArn: inventoryRoleArn },
      { memoryMb: 256, access: 'denied', version: deniedVersion, roleArn: deniedRoleArn },
      ...fixture.extraVariants,
    ],
  };
}

export function reset({ baselineRevision = appRevision, revision = appRevision, healthyAttached = false,
  deniedAttached = true, versionId = 'v1', versionDocuments, aliasVersion = healthyVersion,
  aliasRevision = 'alias-revision-1' } = {}) {
  records.clear();
  fixture.appRequests.length = 0;
  fixture.businessRequests.length = 0;
  fixture.businessMutations.length = 0;
  fixture.businessOperationCounts.clear();
  fixture.businessFailure = undefined;
  fixture.beforeBusinessRequest = undefined;
  fixture.afterBusinessRequest = undefined;
  fixture.failResetCompletion = false;
  fixture.ordersScanPageSize = 1000;
  fixture.ordersScanPages = 0;
  fixture.invocations.length = 0;
  fixture.mutations.length = 0;
  fixture.dynamoPolicyReads.length = 0;
  fixture.iamReads.length = 0;
  fixture.manifestReads.length = 0;
  fixture.aliasReads.length = 0;
  fixture.aliasUpdates.length = 0;
  fixture.aliasUpdateAttempts.length = 0;
  fixture.checkpointObjects.length = 0;
  fixture.afterCheckpoint = undefined;
  fixture.trace.length = 0;
  fixture.configurationReads.length = 0;
  fixture.concurrencyReads.length = 0;
  fixture.concurrencyAttempts.length = 0;
  fixture.concurrencyWrites.length = 0;
  fixture.concurrencyMode = 'apply';
  fixture.alarmReads.length = 0;
  fixture.unhandled.length = 0;
  fixture.revision = revision;
  fixture.stackStatus = 'UPDATE_COMPLETE';
  fixture.stackId = '11111111-1111-4111-8111-111111111111';
  fixture.stackCreatedAt = '2026-11-05T00:00:00.000Z';
  fixture.stackLastUpdatedAt = '2026-11-05T00:00:00.000Z';
  fixture.credentialGeneration = 'fixture-generation';
  fixture.baselineMemoryMb = 256;
  fixture.inventoryExpectedVersion = healthyVersion;
  fixture.inventoryExpectedConcurrency = 'unreserved';
  fixture.checkoutExpectedConcurrency = 'unreserved';
  fixture.healthyRoleAttached = healthyAttached;
  fixture.deniedRoleAttached = deniedAttached;
  fixture.iamPolicyDocument = iamPolicyDocument();
  fixture.iamDefaultVersionId = versionId;
  fixture.iamVersionDocuments = versionDocuments ?? new Map([[versionId, fixture.iamPolicyDocument]]);
  fixture.manifestCodeSha256 = 'fixture-code';
  fixture.extraVariants = [];
  fixture.versionOverrides = {};
  fixture.inventoryConcurrency = undefined;
  fixture.checkoutConcurrency = undefined;
  fixture.manifestMode = 'valid';
  fixture.deniedConfigMode = 'valid';
  fixture.weightedAlias = false;
  fixture.aliasMode = 'apply';
  fixture.beforeAliasUpdate = undefined;
  fixture.aliasUpdateEntered = false;
  fixture.checkpointMode = 'store';
  fixture.appMode = 'denied';
  fixture.appStock = 99;
  fixture.appProductVersion = 'fixture-product-v1';
  fixture.appOrders = new Map();
  fixture.appOrderIds = new Map();
  fixture.aliasVersion = { Checkout: healthyVersion, Inventory: aliasVersion };
  fixture.aliasRevision = aliasRevision;
  fixture.heldRequests.clear();
  fixture.heldReleaseMode = undefined;
  put({ pk: 'STATE', revision: 1, data: {
    baseline: {
      appRevision: baselineRevision,
      checkoutId: 'verified-baseline-order',
      sku: 'demo-widget',
      productVersion: 'fixture-product-v1',
      stockBefore: 100,
      stockAfter: 99,
      verifiedAt: new Date().toISOString(),
      receipt: { checkoutId: 'verified-baseline-order', sku: 'demo-widget', quantity: 1,
        unitPriceCents: 1299, totalPriceCents: 1299, currency: 'USD',
        createdAt: new Date().toISOString(), status: 'placed' },
      settings: {
        account, region, api: appApi, credentialGeneration: 'fixture-generation',
        inventoryPolicy: 'absent', inventoryTableArn: tableArn, inventoryRoleArn,
        inventoryPolicyName: policyName, inventoryPolicyArn: policyArn,
        inventoryPolicyDefaultVersionId: 'v1', inventoryPolicyDocument: iamPolicyDocument(),
        inventoryAccessPolicy: {
          state: 'absent', policyArn, policyName, roleArn: inventoryRoleArn,
          defaultVersionId: 'v1', documentMatches: true, observedAt: new Date().toISOString(),
        },
        inventoryDeniedRoleArn: deniedRoleArn,
        inventoryDeniedAccessPolicy: {
          state: 'present', policyArn, policyName, roleArn: deniedRoleArn,
          defaultVersionId: 'v1', documentMatches: true, observedAt: new Date().toISOString(),
        },
        inventoryVariantsManifest: {
          schemaVersion: 1, sourceRevision: appRevision, functionName: 'IncidentTriageDemoInventory', aliasName: 'live',
          baselineMemoryMb: 256, codeSha256: 'fixture-code',
          variants: [
            { memoryMb: 256, access: 'healthy', version: healthyVersion, roleArn: inventoryRoleArn },
            { memoryMb: 256, access: 'denied', version: deniedVersion, roleArn: deniedRoleArn },
          ],
        },
        checkout: { version: '2', aliasArn: `arn:aws:lambda:${region}:${account}:function:IncidentTriageDemoCheckout:live`,
          memory: 256, timeout: 12, cap: 'unreserved', codeSha256: 'fixture-code', role: checkoutRoleArn },
        inventory: { version: healthyVersion, aliasArn: `arn:aws:lambda:${region}:${account}:function:IncidentTriageDemoInventory:live`,
          memory: 256, timeout: 6, cap: 'unreserved', codeSha256: 'fixture-code', role: inventoryRoleArn },
      },
    },
    budgets: {
      checkout: { generatorRemaining: 50, verificationRemaining: 5 },
      catalog: { remaining: 120 },
      orderStatus: { remaining: 60 },
    },
    receipts: [],
    unresolved: [],
  } });
  const run = row('STATE');
  if (run?.data.baseline) run.data.originalBaseline = structuredClone(run.data.baseline);
}

export function stackXml() {
  const supportedMemory = [...new Set([256, ...fixture.extraVariants.map(({ memoryMb }) => memoryMb)])]
    .sort((a, b) => a - b).join(',');
  const outputs = [
    ['SourceRevision', fixture.revision], ['ApiUrl', appApi], ['ProductSku', 'demo-widget'],
    ['CheckoutFunctionName', 'IncidentTriageDemoCheckout'], ['InventoryFunctionName', 'IncidentTriageDemoInventory'],
    ['OrdersTableName', 'IncidentTriageDemoOrders'], ['InventoryTableName', table], ['InventoryRoleArn', inventoryRoleArn], ['PresenterCredentialGeneration', fixture.credentialGeneration],
    ['InventoryDeniedRoleArn', deniedRoleArn],
    ['InventoryVariantsManifestBucket', manifestBucket], ['InventoryVariantsManifestKey', currentManifestKey()],
    ['CheckoutLiveVersion', healthyVersion], ['InventoryLiveVersion', fixture.inventoryExpectedVersion],
    ['CheckoutLiveAliasArn', `arn:aws:lambda:${region}:${account}:function:IncidentTriageDemoCheckout:live`],
    ['InventoryLiveAliasArn', `arn:aws:lambda:${region}:${account}:function:IncidentTriageDemoInventory:live`],
    ['CheckoutMemorySize', '256'], ['InventoryMemorySize', String(fixture.baselineMemoryMb)], ['InventorySupportedMemoryMb', supportedMemory],
    ['CheckoutTimeoutSeconds', '12'], ['InventoryTimeoutSeconds', '6'],
    ['CheckoutReservedConcurrency', String(fixture.checkoutExpectedConcurrency)], ['InventoryReservedConcurrency', String(fixture.inventoryExpectedConcurrency)],
    ['InventoryResourcePolicy', 'absent'],
  ].map(([key, value]) => `<member><OutputKey>${key}</OutputKey><OutputValue>${value}</OutputValue></member>`).join('');
  return `<DescribeStacksResponse xmlns="http://cloudformation.amazonaws.com/doc/2010-09-09/"><DescribeStacksResult><Stacks><member><StackId>arn:aws:cloudformation:${region}:${account}:stack/IncidentTriageDemoApp/${fixture.stackId}</StackId><StackName>IncidentTriageDemoApp</StackName><StackStatus>${fixture.stackStatus}</StackStatus><CreationTime>${fixture.stackCreatedAt}</CreationTime><LastUpdatedTime>${fixture.stackLastUpdatedAt}</LastUpdatedTime><Outputs>${outputs}</Outputs></member></Stacks></DescribeStacksResult></DescribeStacksResponse>`;
}

function namedFunctionFromConcurrencyPath(url) {
  const path = new URL(url, 'http://fixture').pathname;
  const functionName = decodeURIComponent(path.split('/').filter(Boolean).at(-2) ?? '');
  assert.ok(['IncidentTriageDemoInventory', 'IncidentTriageDemoCheckout'].includes(functionName),
    `concurrency operations must target a named demo function, got ${functionName}`);
  return functionName;
}

export function resourcesXml() {
  return '<ListStackResourcesResponse xmlns="http://cloudformation.amazonaws.com/doc/2010-05-15/"><ListStackResourcesResult><StackResourceSummaries><member><LogicalResourceId>HttpApi</LogicalResourceId><PhysicalResourceId>fixtureapi</PhysicalResourceId><ResourceType>AWS::ApiGatewayV2::Api</ResourceType><ResourceStatus>CREATE_COMPLETE</ResourceStatus></member></StackResourceSummaries></ListStackResourcesResult></ListStackResourcesResponse>';
}

export async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if ((request.headers['content-type'] ?? '').includes('form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  try {
    return JSON.parse(raw);
  } catch {
    return Buffer.from(raw, 'utf8');
  }
}

function noteBusinessRequest(operation, body) {
  const count = (fixture.businessOperationCounts.get(operation) ?? 0) + 1;
  fixture.businessOperationCounts.set(operation, count);
  const entry = { operation, count, tableName: body.TableName, body: structuredClone(body) };
  fixture.businessRequests.push(entry);
  return entry;
}

function businessFailure(operation, count) {
  const failure = fixture.businessFailure;
  if (!failure || failure.operation !== operation || failure.occurrence !== count) return undefined;
  fixture.businessFailure = undefined;
  return failure.errorCode ?? 'AccessDeniedException';
}

async function afterBusinessRequest(call, outcome) {
  if (typeof fixture.afterBusinessRequest === 'function') {
    await fixture.afterBusinessRequest({ ...call, outcome });
  }
}

async function beforeBusinessRequest(call) {
  if (typeof fixture.beforeBusinessRequest === 'function') {
    await fixture.beforeBusinessRequest(call);
  }
}

function inventoryVersionCondition(body) {
  if (body.ConditionExpression === undefined) return { present: false, supported: true, matches: true };
  if (typeof body.ConditionExpression !== 'string') return { present: true, supported: false, matches: false };
  const match = /^\s*(#[A-Za-z0-9_]+|[A-Za-z][A-Za-z0-9_]*)\s*=\s*(:[A-Za-z0-9_]+)\s*$/.exec(body.ConditionExpression);
  if (!match) return { present: true, supported: false, matches: false };
  const attribute = body.ExpressionAttributeNames?.[match[1]] ?? match[1];
  const expectedVersion = body.ExpressionAttributeValues?.[match[2]]?.S;
  if (attribute !== 'productVersion' || typeof expectedVersion !== 'string') {
    return { present: true, supported: false, matches: false };
  }
  return { present: true, supported: true, matches: expectedVersion === fixture.appProductVersion };
}

function inventoryItem() {
  return marshall({
    sku: 'demo-widget',
    name: 'Demo Widget',
    unitPriceCents: 1299,
    currency: 'USD',
    availableQuantity: fixture.appStock,
    productVersion: fixture.appProductVersion,
    updatedAt: new Date().toISOString(),
  }, { removeUndefinedValues: true });
}

function orderRows() {
  return [...fixture.appOrders.entries()].map(([checkoutId, order]) => {
    let orderId = fixture.appOrderIds.get(checkoutId);
    if (!orderId) {
      orderId = `fixture-order-${checkoutId}`;
      fixture.appOrderIds.set(checkoutId, orderId);
    }
    return { checkoutId, orderId, order };
  }).sort((left, right) => left.orderId.localeCompare(right.orderId));
}

async function businessScan(body) {
  if (body.TableName !== ordersTable) {
    fixture.unhandled.push(`DynamoDB.Scan ${body.TableName}`);
    throw new Error(`Unexpected business Scan table ${body.TableName}`);
  }
  const call = noteBusinessRequest('Scan', body);
  await beforeBusinessRequest(call);
  fixture.ordersScanPages++;
  const failure = businessFailure('Scan', call.count);
  if (failure) {
    await afterBusinessRequest(call, 'failed');
    return { __error: failure };
  }

  const exclusive = body.ExclusiveStartKey?.orderId?.S;
  const remaining = orderRows().filter(({ orderId }) => !exclusive || orderId > exclusive);
  const requestedLimit = Number.isSafeInteger(body.Limit) && body.Limit > 0 ? body.Limit : Number.POSITIVE_INFINITY;
  const pageSize = Math.max(1, Math.min(requestedLimit, fixture.ordersScanPageSize));
  const page = remaining.slice(0, pageSize);
  const last = page.at(-1);
  const result = {
    Items: page.map(({ orderId, order }) => marshall({ orderId, ...order }, { removeUndefinedValues: true })),
    ...(remaining.length > page.length && last ? { LastEvaluatedKey: { orderId: { S: last.orderId } } } : {}),
  };
  await afterBusinessRequest(call, 'completed');
  return result;
}

export async function awsProtocol(request, body) {
  const action = typeof body.Action === 'string' ? body.Action : '';
  const target = request.headers['x-amz-target'] ?? (action ? `CloudFormation_${action}` : '');
  if (target.endsWith('GetItem')) {
    if (body.TableName === runTable) {
      const item = row(body.Key?.pk?.S);
      return item ? { Item: marshall(item, { removeUndefinedValues: true }) } : {};
    }
    if (body.TableName === table) {
      const call = noteBusinessRequest('GetItem', body);
      await beforeBusinessRequest(call);
      if (body.ConsistentRead !== true || body.Key?.sku?.S !== 'demo-widget') {
        fixture.unhandled.push(`DynamoDB.GetItem ${body.TableName}`);
        throw new Error('Inventory reset reads must be strong and use the seeded SKU');
      }
      const failure = businessFailure('GetItem', call.count);
      if (failure) {
        await afterBusinessRequest(call, 'failed');
        return { __error: failure };
      }
      const result = { Item: inventoryItem() };
      await afterBusinessRequest(call, 'completed');
      return result;
    }
    fixture.unhandled.push(`DynamoDB.GetItem ${body.TableName}`);
    throw new Error(`Unexpected GetItem table ${body.TableName}`);
  }
  if (target.endsWith('TransactWriteItems')) {
    const writes = body.TransactItems?.map(({ Put }) => Put).filter(Boolean) ?? [];
    assert.ok(writes.length > 0, 'controller journal transaction must include puts');
    assert.ok(writes.every((write) => write.TableName === runTable), 'controller journal writes must stay in the fixture table');
    for (const write of writes) {
      const item = unmarshall(write.Item);
      const existing = row(item.pk);
      if (write.ConditionExpression === 'attribute_not_exists(pk)' && existing) {
        return { __error: 'TransactionCanceledException' };
      }
      if (write.ConditionExpression?.includes('#revision = :previous') &&
          (!existing || String(existing.revision) !== String(write.ExpressionAttributeValues?.[':previous']?.N))) {
        return { __error: 'TransactionCanceledException' };
      }
    }
    if (fixture.failResetCompletion) {
      const stateWrite = writes.map((write) => unmarshall(write.Item)).find(({ pk }) => pk === 'STATE');
      const currentState = row('STATE')?.data;
      if (currentState?.resetRequired === true && stateWrite?.data?.resetRequired !== true &&
          stateWrite?.data?.baseline !== null && stateWrite?.data?.baseline !== undefined) {
        return { __error: 'AccessDeniedException' };
      }
    }
    for (const write of writes) put(unmarshall(write.Item));
    return {};
  }
  if (target.endsWith('PutItem')) {
    if (body.TableName !== table) {
      fixture.businessMutations.push({ operation: 'PutItem', tableName: body.TableName, body: structuredClone(body), outcome: 'rejected' });
      fixture.unhandled.push(`DynamoDB.PutItem ${body.TableName}`);
      throw new Error('Reset may only seed the selected Inventory row; Orders PutItem is not allowed');
    }
    const call = noteBusinessRequest('PutItem', body);
    const mutation = { operation: 'PutItem', tableName: body.TableName, body: structuredClone(body), outcome: 'attempted' };
    fixture.businessMutations.push(mutation);
    await beforeBusinessRequest(call);
    const item = unmarshall(body.Item ?? {});
    if (item.sku !== 'demo-widget' || typeof item.productVersion !== 'string' ||
        !Number.isSafeInteger(item.availableQuantity) || item.availableQuantity !== 1000) {
      mutation.outcome = 'rejected';
      fixture.unhandled.push(`DynamoDB.PutItem ${body.TableName}`);
      throw new Error('Reset must seed only the demo SKU with the approved stock value and a product version');
    }
    const condition = inventoryVersionCondition(body);
    if (!condition.supported) {
      mutation.outcome = 'rejected';
      fixture.unhandled.push(`DynamoDB.PutItem condition ${body.ConditionExpression}`);
      throw new Error('Fixture supports only a simple Inventory productVersion equality condition');
    }
    if (!condition.matches) {
      mutation.outcome = 'conditional_failed';
      await afterBusinessRequest(call, 'conditional_failed');
      return { __error: 'ConditionalCheckFailedException' };
    }
    const failure = businessFailure('PutItem', call.count);
    if (failure) {
      mutation.outcome = 'failed';
      await afterBusinessRequest(call, 'failed');
      return { __error: failure };
    }
    fixture.appStock = item.availableQuantity;
    fixture.appProductVersion = item.productVersion;
    mutation.outcome = 'applied';
    await afterBusinessRequest(call, 'applied');
    return {};
  }
  if (target.endsWith('Scan')) return businessScan(body);
  if (target.endsWith('DeleteItem')) {
    if (body.TableName !== ordersTable) {
      fixture.businessMutations.push({ operation: 'DeleteItem', tableName: body.TableName, body: structuredClone(body), outcome: 'rejected' });
      fixture.unhandled.push(`DynamoDB.DeleteItem ${body.TableName}`);
      throw new Error(`Reset may only delete prior Orders rows, not ${body.TableName}`);
    }
    const call = noteBusinessRequest('DeleteItem', body);
    const orderId = body.Key?.orderId?.S;
    const knownOrder = orderRows().find(({ orderId: known }) => known === orderId);
    const mutation = { operation: 'DeleteItem', tableName: body.TableName, orderId,
      checkoutId: knownOrder?.checkoutId ?? orderId?.replace(/^fixture-order-/, ''),
      body: structuredClone(body), outcome: 'attempted' };
    fixture.businessMutations.push(mutation);
    await beforeBusinessRequest(call);
    if (typeof orderId !== 'string' || !/^fixture-order-[A-Za-z0-9_-]+$/.test(orderId)) {
      mutation.outcome = 'rejected';
      fixture.unhandled.push(`DynamoDB.DeleteItem ${body.TableName}`);
      throw new Error('Reset DeleteItem must target a valid Orders key');
    }
    const failure = businessFailure('DeleteItem', call.count);
    if (failure) {
      mutation.outcome = 'failed';
      await afterBusinessRequest(call, 'failed');
      return { __error: failure };
    }
    if (knownOrder) {
      fixture.appOrders.delete(knownOrder.checkoutId);
      fixture.appOrderIds.delete(knownOrder.checkoutId);
    }
    mutation.outcome = 'applied';
    await afterBusinessRequest(call, 'applied');
    return {};
  }
  if (target.endsWith('GetResourcePolicy')) {
    fixture.dynamoPolicyReads.push(body.ResourceArn);
    if (body.ResourceArn !== tableArn) throw new Error(`unexpected policy read target ${body.ResourceArn}`);
    return { __error: 'PolicyNotFoundException' };
  }
  if (action === 'ListAttachedRolePolicies') {
    assert.ok([inventoryRoleName, deniedRoleName].includes(body.RoleName), 'IAM reads must target a named Inventory role');
    fixture.iamReads.push({ action, ...body });
    const attached = (body.RoleName === inventoryRoleName ? fixture.healthyRoleAttached : fixture.deniedRoleAttached)
      ? `<member><PolicyName>${policyName}</PolicyName><PolicyArn>${policyArn}</PolicyArn></member>` : '';
    return { __xml: `<ListAttachedRolePoliciesResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><ListAttachedRolePoliciesResult><AttachedPolicies>${attached}</AttachedPolicies><IsTruncated>false</IsTruncated></ListAttachedRolePoliciesResult></ListAttachedRolePoliciesResponse>` };
  }
  if (action === 'GetPolicy') {
    assert.equal(body.PolicyArn, policyArn, 'IAM policy reads must target the pre-created denial policy');
    fixture.iamReads.push({ action, ...body });
    return { __xml: `<GetPolicyResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><GetPolicyResult><Policy><PolicyName>${policyName}</PolicyName><Arn>${policyArn}</Arn><DefaultVersionId>${fixture.iamDefaultVersionId}</DefaultVersionId><AttachmentCount>${fixture.deniedRoleAttached ? 1 : 0}</AttachmentCount></Policy></GetPolicyResult></GetPolicyResponse>` };
  }
  if (action === 'GetPolicyVersion') {
    assert.equal(body.PolicyArn, policyArn, 'IAM policy-version reads must target the pre-created denial policy');
    fixture.iamReads.push({ action, ...body });
    const document = fixture.iamVersionDocuments.get(body.VersionId);
    if (!document) return { __error: 'NoSuchEntity', __errorProtocol: 'iam' };
    return { __xml: `<GetPolicyVersionResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><GetPolicyVersionResult><PolicyVersion><Document>${encodeURIComponent(JSON.stringify(document))}</Document><VersionId>${body.VersionId}</VersionId><IsDefaultVersion>${body.VersionId === fixture.iamDefaultVersionId}</IsDefaultVersion></PolicyVersion></GetPolicyVersionResult></GetPolicyVersionResponse>` };
  }
  if (!target && request.method === 'GET' && request.url.startsWith(`/${manifestBucket}/`)) {
    const key = decodeURIComponent(request.url.slice(`/${manifestBucket}/`.length)).split('?')[0];
    fixture.manifestReads.push({ bucket: manifestBucket, key });
    if (key !== currentManifestKey()) throw new Error(`unexpected manifest key ${key}`);
    if (fixture.manifestMode === 'missing') return { __error: 'NoSuchKey', __errorProtocol: 's3' };
    return { __s3Body: JSON.stringify(variantsManifest()) };
  }
  if (target.endsWith('DescribeAlarms')) {
    fixture.alarmReads.push('DescribeAlarms');
    return { __xml: `<DescribeAlarmsResponse xmlns="http://monitoring.amazonaws.com/doc/2010-08-01/"><DescribeAlarmsResult><MetricAlarms><member><AlarmName>IncidentTriageDemoAppStage5xx</AlarmName><AlarmArn>arn:aws:cloudwatch:${region}:${account}:alarm:IncidentTriageDemoAppStage5xx</AlarmArn><StateValue>OK</StateValue><StateReason>fixture healthy</StateReason><StateUpdatedTimestamp>2026-11-06T00:00:00.000Z</StateUpdatedTimestamp><StateTransitionedTimestamp>2026-11-06T00:00:00.000Z</StateTransitionedTimestamp><ActionsEnabled>true</ActionsEnabled></member></MetricAlarms></DescribeAlarmsResult></DescribeAlarmsResponse>` };
  }
  if (target.endsWith('DescribeAlarmHistory')) {
    fixture.alarmReads.push('DescribeAlarmHistory');
    return { __xml: '<DescribeAlarmHistoryResponse xmlns="http://monitoring.amazonaws.com/doc/2010-08-01/"><DescribeAlarmHistoryResult><AlarmHistoryItems/></DescribeAlarmHistoryResult></DescribeAlarmHistoryResponse>' };
  }
  if (target.endsWith('DescribeStacks')) return { __xml: stackXml() };
  if (target.endsWith('ListStackResources')) return { __xml: resourcesXml() };
  if (!target && request.method === 'GET' && request.url.includes('/aliases/live')) {
    const name = request.url.includes('Checkout') ? 'Checkout' : 'Inventory';
    fixture.aliasReads.push({ name, version: fixture.aliasVersion[name], revisionId: fixture.aliasRevision });
    return { FunctionVersion: fixture.aliasVersion[name], RevisionId: fixture.aliasRevision,
      FunctionArn: `arn:aws:lambda:${region}:${account}:function:IncidentTriageDemo${name}:live`,
      RoutingConfig: name === 'Inventory' && fixture.weightedAlias ? { AdditionalVersionWeights: { '4': 0.1 } } : {} };
  }
  if (!target && ['POST', 'PUT'].includes(request.method) && request.url.includes('/aliases/live')) {
    assert.match(body.RevisionId, /^alias-revision-[1-9]\d*$/, 'alias update must use the observed revision');
    const version = body.FunctionVersion;
    const allowedVersions = variantsManifest().variants.map(({ version: allowed }) => allowed);
    assert.ok(allowedVersions.includes(version), 'alias update must target an allowlisted version');
    fixture.trace.push({ type: 'alias-update-attempt', version, revisionId: body.RevisionId });
    fixture.aliasUpdateAttempts.push({ version, revisionId: body.RevisionId });
    if (body.RevisionId !== fixture.aliasRevision) return { __error: 'PreconditionFailedException', __errorProtocol: 'lambda' };
    fixture.aliasUpdateEntered = true;
    if (typeof fixture.beforeAliasUpdate === 'function') await fixture.beforeAliasUpdate(body);
    if (fixture.aliasMode === 'conflict') return { __error: 'PreconditionFailedException', __errorProtocol: 'lambda' };
    if (fixture.aliasMode === 'lost-no-observation') return { __error: 'ServiceFailure', __errorProtocol: 'lambda' };
    fixture.aliasUpdates.push({ version, revisionId: body.RevisionId });
    fixture.trace.push({ type: 'alias-update', version });
    fixture.mutations.push(`UpdateAlias live ${version}`);
    fixture.aliasVersion.Inventory = version;
    fixture.aliasRevision = `alias-revision-${Number(fixture.aliasRevision.slice('alias-revision-'.length)) + 1}`;
    if (fixture.aliasMode === 'lost-ack') return { __error: 'ServiceFailure', __errorProtocol: 'lambda' };
    return { FunctionVersion: version, RevisionId: fixture.aliasRevision, RoutingConfig: {} };
  }
  if (!target && request.url.includes('/configuration?')) {
    const name = request.url.includes('Checkout') ? 'Checkout' : 'Inventory';
    const version = new URL(request.url, 'http://fixture').searchParams.get('Qualifier') ?? healthyVersion;
    const deniedConfig = name === 'Inventory' && version === deniedVersion;
    const variant = name === 'Inventory'
      ? variantsManifest().variants.find((candidate) => candidate.version === version) : undefined;
    const override = fixture.versionOverrides[`${name}:${version}`] ?? fixture.versionOverrides[version] ?? {};
    const config = {
      State: 'Active',
      Version: override.version ?? version,
      MemorySize: override.memoryMb ?? (deniedConfig && fixture.deniedConfigMode === 'memory' ? 512 : variant?.memoryMb ?? 256),
      Timeout: override.timeout ?? (name === 'Checkout' ? 12 : 6),
      CodeSha256: override.codeSha256 ?? (deniedConfig && fixture.deniedConfigMode === 'code' ? 'wrong-code' : fixture.manifestCodeSha256),
      Role: name === 'Checkout' ? checkoutRoleArn : override.roleArn ?? variant?.roleArn ?? inventoryRoleArn,
      Environment: { Variables: name === 'Checkout'
        ? { APP_ENVIRONMENT: 'demo', SOURCE_REVISION: fixture.revision,
          PRESENTER_CREDENTIAL_DIGEST: createHash('sha256').update(appBearer).digest('hex'),
          PRESENTER_CREDENTIAL_GENERATION: fixture.credentialGeneration, ORDERS_TABLE_NAME: 'IncidentTriageDemoOrders',
          INVENTORY_TABLE_NAME: table, INVENTORY_FUNCTION_NAME: `arn:aws:lambda:${region}:${account}:function:IncidentTriageDemoInventory:live`,
          PRODUCT_SKU: 'demo-widget' }
        : { APP_ENVIRONMENT: 'demo', SOURCE_REVISION: override.sourceRevision ?? (deniedConfig && fixture.deniedConfigMode === 'env' ? newerRevision : fixture.revision), INVENTORY_TABLE_NAME: override.inventoryTableArn ?? tableArn, PRODUCT_SKU: 'demo-widget' } },
      Architectures: override.architectures ?? ['x86_64'],
    };
    fixture.configurationReads.push({ name, version, ...config });
    return config;
  }
  if (!target && request.url.includes('/concurrency') && request.method === 'GET') {
    const functionName = namedFunctionFromConcurrencyPath(request.url);
    const name = functionName === 'IncidentTriageDemoInventory' ? 'Inventory' : 'Checkout';
    const cap = name === 'Inventory' ? fixture.inventoryConcurrency : fixture.checkoutConcurrency;
    fixture.concurrencyReads.push({ name, cap: cap ?? 'unreserved' });
    return cap === undefined ? {} : { ReservedConcurrentExecutions: cap };
  }
  if (!target && request.url.includes('/concurrency') && ['PUT', 'DELETE'].includes(request.method)) {
    const functionName = namedFunctionFromConcurrencyPath(request.url);
    const name = functionName === 'IncidentTriageDemoInventory' ? 'Inventory' : 'Checkout';
    const previous = name === 'Inventory' ? fixture.inventoryConcurrency : fixture.checkoutConcurrency;
    const next = request.method === 'DELETE' ? undefined : Number(body.ReservedConcurrentExecutions);
    if (request.method === 'PUT') assert.ok(Number.isSafeInteger(next) && next > 0, 'reserved concurrency writes must use a positive integer');
    fixture.concurrencyAttempts.push({ name, previous: previous ?? 'unreserved', next: next ?? 'unreserved', method: request.method });
    fixture.trace.push({ type: 'concurrency-attempt', name, previous: previous ?? 'unreserved', next: next ?? 'unreserved', method: request.method });
    const mode = fixture.concurrencyMode;
    fixture.concurrencyMode = 'apply';
    if (mode === 'fail' || mode === 'lost-no-observation') {
      return { __error: mode === 'fail' ? 'AccessDeniedException' : 'ServiceFailure', __errorProtocol: 'lambda' };
    }
    fixture.mutations.push(`${request.method === 'DELETE' ? 'Delete' : 'Put'}FunctionConcurrency ${name} ${next ?? 'unreserved'}`);
    if (name === 'Inventory') fixture.inventoryConcurrency = next;
    else fixture.checkoutConcurrency = next;
    fixture.concurrencyWrites.push({ name, previous: previous ?? 'unreserved', next: next ?? 'unreserved', method: request.method });
    fixture.trace.push({ type: 'concurrency-update', name, previous: previous ?? 'unreserved', next: next ?? 'unreserved', method: request.method });
    if (mode === 'lost-ack') return { __error: 'ServiceFailure', __errorProtocol: 'lambda' };
    return request.method === 'DELETE' ? { __noContent: true } : { ReservedConcurrentExecutions: next };
  }
  if (target.endsWith('GetSecretValue')) {
    return { SecretString: body.SecretId.endsWith(':operator')
      ? createHash('sha256').update(operatorBearer).digest('hex') : appBearer };
  }
  if (!target && request.method === 'PUT' && !request.url.includes('/invocations')) {
    const path = request.url.startsWith('/') ? request.url.slice(1) : request.url;
    const slash = path.indexOf('/');
    const bucket = slash < 0 ? path : path.slice(0, slash);
    const key = slash < 0 ? '' : decodeURIComponent(path.slice(slash + 1));
    if (bucket === evidenceBucket && key.startsWith(evidencePrefix)) {
      fixture.trace.push({ type: 'checkpoint-attempt', key });
      fixture.mutations.push(`PutObject ${bucket}/${key}`);
      if (fixture.checkpointMode === 'fail') return { __error: 'AccessDenied' };
      fixture.checkpointObjects.push({ bucket, key, body });
      fixture.trace.push({ type: 'checkpoint-stored', key, body });
      if (typeof fixture.afterCheckpoint === 'function') await fixture.afterCheckpoint({ bucket, key, body });
      return {};
    }
  }
  if (request.url.includes('/invocations')) {
    assert.equal(request.headers['x-amz-invocation-type'], 'Event');
    fixture.invocations.push(body.actionId);
    return { __accepted: true };
  }

  const operation = `${target} ${request.method} ${request.url}`;
  if (/PutItem|UpdateItem|DeleteItem|PutFunctionConcurrency|DeleteFunctionConcurrency|UpdateAlias|UpdateFunctionConfiguration|UpdateFunctionCode|PublishVersion|AddPermission|RemovePermission|PutObject|DeleteObject/i.test(operation) ||
      (request.method === 'PUT' && /s3\./i.test(request.headers.host ?? ''))) {
    fixture.mutations.push(operation);
  }
  fixture.unhandled.push(operation);
  throw new Error(`Unhandled fixture operation ${operation}`);
}

export async function startAwsServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const result = await awsProtocol(request, await requestBody(request));
      if (result.__error) {
        if (result.__errorProtocol === 'iam') {
          response.writeHead(400, { 'content-type': 'text/xml' });
          response.end(`<ErrorResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><Error><Type>Sender</Type><Code>${result.__error}</Code><Message>${result.__error}</Message></Error><RequestId>fixture-iam-error</RequestId></ErrorResponse>`);
        } else if (result.__errorProtocol === 'lambda') {
          response.writeHead(412, { 'content-type': 'application/json', 'x-amzn-errortype': result.__error });
          response.end(JSON.stringify({ __type: `com.amazonaws.lambda#${result.__error}`, message: result.__error }));
        } else if (result.__errorProtocol === 's3') {
          response.writeHead(404, { 'content-type': 'application/xml', 'x-amz-request-id': 'fixture-s3-error' });
          response.end(`<Error><Code>${result.__error}</Code><Message>${result.__error}</Message></Error>`);
        } else {
          response.writeHead(400, { 'content-type': 'application/x-amz-json-1.0', 'x-amzn-errortype': result.__error });
          response.end(JSON.stringify({ __type: `com.amazonaws.dynamodbv20120810#${result.__error}`, message: result.__error,
            ...(result.__error === 'TransactionCanceledException'
              ? { CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] } : {}) }));
        }
      } else if (result.__accepted) {
        response.writeHead(202);
        response.end();
      } else if (result.__noContent) {
        response.writeHead(204);
        response.end();
      } else if (result.__xml) {
        response.writeHead(200, { 'content-type': 'text/xml' });
        response.end(result.__xml);
      } else if (result.__s3Body !== undefined) {
        response.writeHead(200, { 'content-type': 'application/json', etag: 'fixture-etag' });
        response.end(result.__s3Body);
      } else {
        response.writeHead(200, { 'content-type': 'application/x-amz-json-1.0' });
        response.end(JSON.stringify(result));
      }
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: error instanceof Error ? error.message : 'fixture failure' }));
    }
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return server;
}

export function awsEnvironment(port) {
  const endpoint = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    AWS_ENDPOINT_URL: endpoint,
    AWS_ENDPOINT_URL_CLOUDFORMATION: endpoint,
    AWS_ENDPOINT_URL_DYNAMODB: endpoint,
    AWS_ENDPOINT_URL_LAMBDA: endpoint,
    AWS_ENDPOINT_URL_SECRETS_MANAGER: endpoint,
    AWS_ENDPOINT_URL_CLOUDWATCH: endpoint,
    AWS_ENDPOINT_URL_S3: endpoint,
    AWS_ENDPOINT_URL_IAM: endpoint,
    AWS_REGION: region,
    AWS_ACCESS_KEY_ID: 'fixture',
    AWS_SECRET_ACCESS_KEY: 'fixture-only',
    AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'false',
    AWS_EC2_METADATA_DISABLED: 'true',
    CONTROLLER_RUN_TABLE: runTable,
    CONTROLLER_OPERATOR_SECRET_ARN: `arn:aws:secretsmanager:${region}:${account}:secret:fixture:operator`,
    CONTROLLER_APP_SECRET_ARN: `arn:aws:secretsmanager:${region}:${account}:secret:fixture:app`,
    CONTROLLER_WORKER_NAME: 'ControllerWorkerFixture',
    CONTROLLER_EVIDENCE_BUCKET: evidenceBucket,
    CONTROLLER_EVIDENCE_PREFIX: evidencePrefix,
  });
  delete process.env.AWS_PROFILE;
  delete process.env.AWS_SESSION_TOKEN;
}

export function httpEvent(method, path, body) {
  return { rawPath: path, requestContext: { http: { method } },
    headers: { authorization: `Bearer ${operatorBearer}` }, body: body && JSON.stringify(body) };
}

export function appResponse(status, body) {
  return {
    status,
    headers: new Headers({ 'content-type': 'application/json', 'x-amzn-requestid': 'fixture-request' }),
    json: async () => body,
  };
}

export function appReply(path, method, body) {
  const currentVariant = variantsManifest().variants.find(({ version }) => version === fixture.aliasVersion.Inventory);
  const selectedDenied = fixture.appMode === 'selected-variant' && currentVariant?.access === 'denied';
  const selectedUnknown = fixture.appMode === 'selected-variant' && !currentVariant;
  if (method === 'GET' && path === '/api/products') {
    if (fixture.appMode === 'generic-502' || selectedUnknown) return appResponse(502, { code: 'INVENTORY_LOOKUP_FAILED' });
    if (fixture.appMode === 'denied' || selectedDenied) return appResponse(502, {
      code: 'INVENTORY_LOOKUP_FAILED', dependencyReason: 'inventory_access_denied',
    });
    return appResponse(200, {
      observedAt: new Date().toISOString(),
      products: [{ sku: 'demo-widget', productVersion: fixture.appProductVersion,
        availableQuantity: fixture.appStock }],
    });
  }
  if (method === 'POST' && path === '/api/checkout') {
    if (fixture.appMode === 'generic-502' || selectedUnknown) return appResponse(502, { code: 'INVENTORY_LOOKUP_FAILED' });
    if (fixture.appMode === 'denied' || selectedDenied) return appResponse(502, {
      code: 'INVENTORY_LOOKUP_FAILED', dependencyReason: 'inventory_access_denied', checkoutId: body.checkoutId,
    });
    if (fixture.appMode === 'selected-variant') {
      if (body.productVersion !== fixture.appProductVersion) {
        return appResponse(409, { code: 'STALE_PRODUCT_VERSION', checkoutId: body.checkoutId });
      }
      fixture.appStock -= 1;
      const order = { checkoutId: body.checkoutId, sku: 'demo-widget', quantity: 1, unitPriceCents: 1299,
        totalPriceCents: 1299, currency: 'USD', createdAt: new Date().toISOString(), status: 'placed' };
      fixture.appOrders.set(body.checkoutId, order);
      fixture.appOrderIds.set(body.checkoutId, `fixture-order-${body.checkoutId}`);
      return appResponse(201, { requestId: `fixture-${randomUUID()}`, order });
    }
    return appResponse(201, {
      requestId: `fixture-${randomUUID()}`,
      order: { checkoutId: body.checkoutId, sku: 'demo-widget', quantity: 1, unitPriceCents: 1299,
        totalPriceCents: 1299, currency: 'USD', createdAt: new Date().toISOString(), status: 'placed' },
    });
  }
  if (method === 'GET' && path.startsWith('/api/orders/')) {
    const checkoutId = path.slice('/api/orders/'.length);
    const order = fixture.appOrders.get(checkoutId);
    return order ? appResponse(200, { order }) : appResponse(404, { code: 'ORDER_NOT_FOUND' });
  }
  return appResponse(404, { code: 'NOT_FOUND' });
}

export function appFetch(url, init = {}) {
  const target = new URL(url);
  assert.equal(target.origin, appApi, 'worker app requests must stay on the controlled fixture origin');
  const method = init.method ?? 'GET';
  const body = init.body ? JSON.parse(init.body) : undefined;
  const request = { url: String(url), method, path: target.pathname, body };
  fixture.appRequests.push(request);
  if (fixture.appMode === 'hold') {
    return new Promise((resolveResponse) => fixture.heldRequests.add(() => resolveResponse(appReply(target.pathname, method, body))));
  }
  return Promise.resolve(appReply(target.pathname, method, body));
}

export function releaseHeld() {
  fixture.appMode = fixture.heldReleaseMode ?? 'healthy';
  fixture.heldReleaseMode = undefined;
  for (const release of fixture.heldRequests) release();
  fixture.heldRequests.clear();
}

export async function call(api, method, path, body, expected) {
  const response = await api.handler(httpEvent(method, path, body));
  assert.equal(response.statusCode, expected, `${method} ${path}: ${response.body}`);
  return JSON.parse(response.body);
}

export async function assertActivationRejected({ api, worker, baselineRevision, revision = appRevision, expectedError }) {
  reset({ baselineRevision, revision });
  const id = randomUUID();
  const accepted = await call(api, 'PUT', `/api/actions/${id}`, { kind: 'activate_inventory_denial' }, 202);
  assert.equal(accepted.action?.id, id);
  assert.equal(accepted.action?.kind, 'activate_inventory_denial');
  assert.deepEqual(fixture.invocations, [id], 'accepted activation must dispatch its one durable action');

  await worker.handler({ actionId: id });
  const result = await call(api, 'GET', `/api/actions/${id}`, undefined, 200);
  assert.equal(result.action?.status, 'failed');
  assert.match(result.action?.error ?? '', expectedError);
  assert.equal(fixture.appRequests.length, 0, 'a rejected activation must send no app requests');
  assert.deepEqual(fixture.mutations, [], 'a rejected activation must not mutate AWS configuration or checkpoint objects');
  assert.deepEqual(fixture.unhandled, [], 'the controlled fixture must account for every AWS request');
  return result.action;
}

export function denialDocument() {
  return iamPolicyDocument();
}

export async function getAction(api, id) {
  return (await call(api, 'GET', `/api/actions/${id}`, undefined, 200)).action;
}

export async function getState(api) {
  return call(api, 'GET', '/api/state', undefined, 200);
}

export async function submit(api, kind, extra = {}) {
  const id = randomUUID();
  const accepted = await call(api, 'PUT', `/api/actions/${id}`, { kind, ...extra }, 202);
  assert.equal(accepted.action?.id, id);
  assert.equal(accepted.action?.kind, kind);
  return id;
}

export async function withElapsed(milliseconds, callback) {
  const now = Date.now;
  Date.now = () => now() + milliseconds;
  try {
    return await callback();
  } finally {
    Date.now = now;
  }
}

export async function activateAndConfirm({ api, worker, aliasMode = 'apply', appMode = 'denied' }) {
  reset();
  fixture.aliasMode = aliasMode;
  fixture.appMode = appMode;
  const id = await submit(api, 'activate_inventory_denial');
  await worker.handler({ actionId: id });
  const action = await getAction(api, id);
  const state = await getState(api);
  return { id, action, state };
}

export async function assertActivationFailsBeforeAlias({ api, worker, configure, expectedError }) {
  reset();
  configure();
  const id = await submit(api, 'activate_inventory_denial');
  await worker.handler({ actionId: id });
  const action = await getAction(api, id);
  assert.ok(['failed', 'incomplete'].includes(action.status));
  assert.match(action.error ?? '', expectedError);
  assert.equal(fixture.aliasUpdates.length, 0, 'invalid release state must not update the alias');
  assert.equal(fixture.appRequests.length, 0, 'invalid release state must not submit activation probes');
  assert.deepEqual(fixture.unhandled, []);
}

