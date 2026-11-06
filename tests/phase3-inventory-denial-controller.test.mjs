import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const account = '027224425948';
const region = 'us-east-1';
const appRevision = '7dca23a7ec0f2d9870c5e25285e3c0e200bc1ff2';
const newerRevision = '8e5a48bc0edcd7a65b9cc857ea2d17d4f5da2a90';
const table = 'IncidentTriageDemoInventory';
const tableArn = `arn:aws:dynamodb:${region}:${account}:table/${table}`;
const inventoryRoleArn = `arn:aws:iam::${account}:role/IncidentTriageDemoAppInventoryRole`;
const checkoutRoleArn = `arn:aws:iam::${account}:role/IncidentTriageDemoAppCheckoutRole`;
const appApi = 'https://fixtureapi.execute-api.us-east-1.amazonaws.com';
const operatorBearer = 'fixture-operator';
const appBearer = 'fixture-app';
const runTable = 'ControllerRunFixture';
const evidenceBucket = 'incident-triage-demo-evidence-027224425948-us-east-1';
const evidencePrefix = 'configuration/';

const records = new Map();
const fixture = {
  appRequests: [],
  invocations: [],
  mutations: [],
  policyReads: [],
  policyPuts: [],
  policyDeletes: [],
  checkpointObjects: [],
  alarmReads: [],
  unhandled: [],
  revision: appRevision,
  policy: undefined,
  policyRevision: undefined,
  putMode: 'apply',
  deleteMode: 'apply',
  checkpointMode: 'store',
  aliasVersion: { Checkout: '2', Inventory: '2' },
  appMode: 'denied',
  heldRequests: new Set(),
};

function row(pk) {
  return records.get(pk);
}

function put(value) {
  records.set(value.pk, value);
}

function reset({ baselineRevision = appRevision, revision = appRevision, policy, policyRevision } = {}) {
  records.clear();
  fixture.appRequests.length = 0;
  fixture.invocations.length = 0;
  fixture.mutations.length = 0;
  fixture.policyReads.length = 0;
  fixture.policyPuts.length = 0;
  fixture.policyDeletes.length = 0;
  fixture.checkpointObjects.length = 0;
  fixture.alarmReads.length = 0;
  fixture.unhandled.length = 0;
  fixture.revision = revision;
  fixture.policy = policy;
  fixture.policyRevision = policy ? (policyRevision ?? 'revision-owned') : undefined;
  fixture.putMode = 'apply';
  fixture.deleteMode = 'apply';
  fixture.checkpointMode = 'store';
  fixture.appMode = 'denied';
  fixture.beforeDelete = undefined;
  fixture.heldRequests.clear();
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
        checkout: { version: '2', aliasArn: `arn:aws:lambda:${region}:${account}:function:IncidentTriageDemoCheckout:live`,
          memory: 256, timeout: 12, cap: 'unreserved', codeSha256: 'fixture-code', role: checkoutRoleArn },
        inventory: { version: '2', aliasArn: `arn:aws:lambda:${region}:${account}:function:IncidentTriageDemoInventory:live`,
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
}

function stackXml() {
  const outputs = [
    ['SourceRevision', fixture.revision], ['ApiUrl', appApi], ['ProductSku', 'demo-widget'],
    ['CheckoutFunctionName', 'IncidentTriageDemoCheckout'], ['InventoryFunctionName', 'IncidentTriageDemoInventory'],
    ['InventoryTableName', table], ['InventoryRoleArn', inventoryRoleArn], ['PresenterCredentialGeneration', 'fixture-generation'],
    ['CheckoutLiveVersion', '2'], ['InventoryLiveVersion', '2'],
    ['CheckoutLiveAliasArn', `arn:aws:lambda:${region}:${account}:function:IncidentTriageDemoCheckout:live`],
    ['InventoryLiveAliasArn', `arn:aws:lambda:${region}:${account}:function:IncidentTriageDemoInventory:live`],
    ['CheckoutMemorySize', '256'], ['InventoryMemorySize', '256'],
    ['CheckoutTimeoutSeconds', '12'], ['InventoryTimeoutSeconds', '6'],
    ['CheckoutReservedConcurrency', 'unreserved'], ['InventoryReservedConcurrency', 'unreserved'],
    ['InventoryResourcePolicy', 'absent'],
  ].map(([key, value]) => `<member><OutputKey>${key}</OutputKey><OutputValue>${value}</OutputValue></member>`).join('');
  return `<DescribeStacksResponse xmlns="http://cloudformation.amazonaws.com/doc/2010-09-09/"><DescribeStacksResult><Stacks><member><StackId>arn:aws:cloudformation:${region}:${account}:stack/IncidentTriageDemoApp/11111111-1111-4111-8111-111111111111</StackId><StackName>IncidentTriageDemoApp</StackName><StackStatus>UPDATE_COMPLETE</StackStatus><Outputs>${outputs}</Outputs></member></Stacks></DescribeStacksResult></DescribeStacksResponse>`;
}

function resourcesXml() {
  return '<ListStackResourcesResponse xmlns="http://cloudformation.amazonaws.com/doc/2010-05-15/"><ListStackResourcesResult><StackResourceSummaries><member><LogicalResourceId>HttpApi</LogicalResourceId><PhysicalResourceId>fixtureapi</PhysicalResourceId><ResourceType>AWS::ApiGatewayV2::Api</ResourceType><ResourceStatus>CREATE_COMPLETE</ResourceStatus></member></StackResourceSummaries></ListStackResourcesResult></ListStackResourcesResponse>';
}

async function requestBody(request) {
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

async function awsProtocol(request, body) {
  const target = request.headers['x-amz-target'] ?? (body.Action ? `CloudFormation_${body.Action}` : '');
  if (target.endsWith('GetItem')) {
    const item = row(body.Key?.pk?.S);
    return item ? { Item: marshall(item, { removeUndefinedValues: true }) } : {};
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
    for (const write of writes) put(unmarshall(write.Item));
    return {};
  }
  if (target.endsWith('PutResourcePolicy')) {
    assert.equal(body.ResourceArn, tableArn, 'denial must target only the named Inventory table');
    assert.equal(body.ExpectedRevisionId, 'NO_POLICY', 'activation must use the no-policy revision guard');
    fixture.policyPuts.push({ ...body });
    fixture.mutations.push(`PutResourcePolicy ${body.ResourceArn}`);
    if (fixture.putMode === 'conflict') return { __error: 'ResourceInUseException' };
    fixture.policy = JSON.parse(body.Policy);
    fixture.policyRevision = `revision-${fixture.policyPuts.length}`;
    if (fixture.putMode === 'lost-ack') return { __error: 'InternalServerError' };
    return { RevisionId: fixture.policyRevision };
  }
  if (target.endsWith('DeleteResourcePolicy')) {
    assert.equal(body.ResourceArn, tableArn, 'restore must target only the named Inventory table');
    fixture.policyDeletes.push({ ...body });
    fixture.mutations.push(`DeleteResourcePolicy ${body.ResourceArn}`);
    if (typeof fixture.beforeDelete === 'function') fixture.beforeDelete(body);
    if (fixture.deleteMode === 'conflict' || body.ExpectedRevisionId !== fixture.policyRevision) {
      return { __error: 'ConditionalCheckFailedException' };
    }
    fixture.policy = undefined;
    fixture.policyRevision = undefined;
    return {};
  }
  if (target.endsWith('GetResourcePolicy')) {
    fixture.policyReads.push(body.ResourceArn);
    if (body.ResourceArn !== tableArn) throw new Error(`unexpected policy read target ${body.ResourceArn}`);
    return fixture.policy ? { Policy: JSON.stringify(fixture.policy), RevisionId: fixture.policyRevision }
      : { __error: 'PolicyNotFoundException' };
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
  if (!target && request.url.includes('/aliases/live')) {
    const name = request.url.includes('Checkout') ? 'Checkout' : 'Inventory';
    return { FunctionVersion: fixture.aliasVersion[name], FunctionArn: `arn:aws:lambda:${region}:${account}:function:IncidentTriageDemo${name}:live`, RoutingConfig: {} };
  }
  if (!target && request.url.includes('/configuration?')) {
    const name = request.url.includes('Checkout') ? 'Checkout' : 'Inventory';
    return { State: 'Active', Version: new URL(request.url, 'http://fixture').searchParams.get('Qualifier') ?? '2',
      MemorySize: 256, Timeout: name === 'Checkout' ? 12 : 6, CodeSha256: 'fixture-code',
      Role: name === 'Checkout' ? checkoutRoleArn : inventoryRoleArn };
  }
  if (!target && request.url.includes('/concurrency')) return {};
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
      fixture.mutations.push(`PutObject ${bucket}/${key}`);
      if (fixture.checkpointMode === 'fail') return { __error: 'AccessDenied' };
      fixture.checkpointObjects.push({ bucket, key, body });
      return {};
    }
  }
  if (request.url.includes('/invocations')) {
    assert.equal(request.headers['x-amz-invocation-type'], 'Event');
    fixture.invocations.push(body.actionId);
    return { __accepted: true };
  }

  const operation = `${target} ${request.method} ${request.url}`;
  if (/PutResourcePolicy|DeleteResourcePolicy|PutItem|UpdateItem|DeleteItem|PutFunctionConcurrency|DeleteFunctionConcurrency|UpdateAlias|UpdateFunctionConfiguration|UpdateFunctionCode|PublishVersion|AddPermission|RemovePermission|PutObject|DeleteObject/i.test(operation) ||
      (request.method === 'PUT' && /s3\./i.test(request.headers.host ?? ''))) {
    fixture.mutations.push(operation);
  }
  fixture.unhandled.push(operation);
  throw new Error(`Unhandled fixture operation ${operation}`);
}

async function startAwsServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const result = await awsProtocol(request, await requestBody(request));
      if (result.__error) {
        response.writeHead(400, { 'content-type': 'application/x-amz-json-1.0', 'x-amzn-errortype': result.__error });
        response.end(JSON.stringify({ __type: `com.amazonaws.dynamodbv20120810#${result.__error}`, message: result.__error,
          ...(result.__error === 'TransactionCanceledException'
            ? { CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] } : {}) }));
      } else if (result.__accepted) {
        response.writeHead(202);
        response.end();
      } else if (result.__xml) {
        response.writeHead(200, { 'content-type': 'text/xml' });
        response.end(result.__xml);
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

function awsEnvironment(port) {
  const endpoint = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    AWS_ENDPOINT_URL: endpoint,
    AWS_ENDPOINT_URL_CLOUDFORMATION: endpoint,
    AWS_ENDPOINT_URL_DYNAMODB: endpoint,
    AWS_ENDPOINT_URL_LAMBDA: endpoint,
    AWS_ENDPOINT_URL_SECRETS_MANAGER: endpoint,
    AWS_ENDPOINT_URL_CLOUDWATCH: endpoint,
    AWS_ENDPOINT_URL_S3: endpoint,
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

function httpEvent(method, path, body) {
  return { rawPath: path, requestContext: { http: { method } },
    headers: { authorization: `Bearer ${operatorBearer}` }, body: body && JSON.stringify(body) };
}

function appResponse(status, body) {
  return {
    status,
    headers: new Headers({ 'content-type': 'application/json', 'x-amzn-requestid': 'fixture-request' }),
    json: async () => body,
  };
}

function appReply(path, method, body) {
  if (method === 'GET' && path === '/api/products') {
    if (fixture.appMode === 'generic-502') return appResponse(502, { code: 'INVENTORY_LOOKUP_FAILED' });
    if (fixture.appMode === 'denied') return appResponse(502, {
      code: 'INVENTORY_LOOKUP_FAILED', dependencyReason: 'inventory_access_denied',
      inventoryVersion: fixture.aliasVersion.Inventory, inventoryTableArn: tableArn, inventoryOperation: 'dynamodb:GetItem',
    });
    return appResponse(200, {
      observedAt: new Date().toISOString(),
      products: [{ sku: 'demo-widget', productVersion: 'fixture-product-v1', availableQuantity: 99 }],
    });
  }
  if (method === 'POST' && path === '/api/checkout') {
    if (fixture.appMode === 'generic-502') return appResponse(502, { code: 'INVENTORY_LOOKUP_FAILED' });
    if (fixture.appMode === 'denied') return appResponse(502, {
      code: 'INVENTORY_LOOKUP_FAILED', dependencyReason: 'inventory_access_denied', checkoutId: body.checkoutId,
      inventoryVersion: fixture.aliasVersion.Inventory, inventoryTableArn: tableArn, inventoryOperation: 'dynamodb:GetItem',
    });
    return appResponse(201, {
      requestId: `fixture-${randomUUID()}`,
      order: { checkoutId: body.checkoutId, sku: 'demo-widget', quantity: 1, unitPriceCents: 1299,
        totalPriceCents: 1299, currency: 'USD', createdAt: new Date().toISOString(), status: 'placed' },
    });
  }
  if (method === 'GET' && path.startsWith('/api/orders/')) return appResponse(404, { code: 'ORDER_NOT_FOUND' });
  return appResponse(404, { code: 'NOT_FOUND' });
}

function appFetch(url, init = {}) {
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

function releaseHeld() {
  fixture.appMode = 'healthy';
  for (const release of fixture.heldRequests) release();
  fixture.heldRequests.clear();
}

async function call(api, method, path, body, expected) {
  const response = await api.handler(httpEvent(method, path, body));
  assert.equal(response.statusCode, expected, `${method} ${path}: ${response.body}`);
  return JSON.parse(response.body);
}

async function assertActivationRejected({ api, worker, baselineRevision, revision = appRevision, policy, expectedError }) {
  reset({ baselineRevision, revision, policy });
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

function denialDocument(actionId) {
  return {
    Version: '2012-10-17',
    Statement: [{
      Sid: `InventoryAccessDenied${actionId.replace(/-/g, '')}`,
      Effect: 'Deny',
      Principal: { AWS: inventoryRoleArn },
      Action: 'dynamodb:GetItem',
      Resource: tableArn,
    }],
  };
}

async function getAction(api, id) {
  return (await call(api, 'GET', `/api/actions/${id}`, undefined, 200)).action;
}

async function getState(api) {
  return call(api, 'GET', '/api/state', undefined, 200);
}

async function submit(api, kind, extra = {}) {
  const id = randomUUID();
  const accepted = await call(api, 'PUT', `/api/actions/${id}`, { kind, ...extra }, 202);
  assert.equal(accepted.action?.id, id);
  assert.equal(accepted.action?.kind, kind);
  return id;
}

async function withPolicyPropagationElapsed(callback) {
  const now = Date.now;
  Date.now = () => now() + 16_000;
  try {
    return await callback();
  } finally {
    Date.now = now;
  }
}

async function activateAndConfirm({ api, worker, putMode = 'apply', appMode = 'denied' }) {
  reset();
  fixture.putMode = putMode;
  fixture.appMode = appMode;
  const id = await submit(api, 'activate_inventory_denial');
  await worker.handler({ actionId: id });
  const action = await getAction(api, id);
  const state = await getState(api);
  return { id, action, state };
}

test('Inventory denial activation fails closed before mutation or app traffic', { timeout: 90_000 }, async (t) => {
  const server = await startAwsServer();
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
  });
  awsEnvironment(server.address().port);
  globalThis.fetch = appFetch;

  const backendPath = pathToFileURL(resolve(root, '.artifacts/controller/backend/index.mjs')).href;
  const workerPath = pathToFileURL(resolve(root, '.artifacts/controller/backend/worker.mjs')).href;
  const api = await import(`${backendPath}?phase3=${Date.now()}`);
  const worker = await import(`${workerPath}?phase3=${Date.now()}`);

  await t.test('a newer deployed app revision makes the ready baseline stale', async () => {
    fixture.revision = newerRevision;
    const action = await assertActivationRejected({
      api, worker, baselineRevision: appRevision, revision: newerRevision,
      expectedError: /baseline|release|revision|changed/i,
    });
    assert.ok(action.finishedAt, 'the stale-baseline rejection must be durably settled');
  });

  await t.test('an unexpected table policy conflicts with the recorded no-policy checkpoint', async () => {
    const policy = {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Deny', Principal: { AWS: inventoryRoleArn }, Action: 'dynamodb:GetItem', Resource: tableArn }],
    };
    const action = await assertActivationRejected({
      api, worker, baselineRevision: appRevision, policy,
      expectedError: /policy|conflict|drift|checkpoint/i,
    });
    assert.ok(action.finishedAt, 'the policy-conflict rejection must be durably settled');
    assert.ok(fixture.policyReads.length > 0, 'the conflict check must read the recorded policy target');
    assert.ok(fixture.policyReads.every((resourceArn) => resourceArn === tableArn),
      'the conflict check must read only the named Inventory table policy');
  });

  await t.test('a revision conflict sends one conditional Put and no app request', async () => {
    reset();
    fixture.putMode = 'conflict';
    const id = await submit(api, 'activate_inventory_denial');
    await worker.handler({ actionId: id });
    const action = await getAction(api, id);
    assert.equal(action.status, 'failed');
    assert.match(action.error ?? '', /revision|policy|conflict/i);
    assert.equal(fixture.policyPuts.length, 1, 'revision conflict must attempt exactly one Put');
    assert.equal(fixture.policyPuts[0].ExpectedRevisionId, 'NO_POLICY');
    assert.equal(fixture.policy, undefined, 'a rejected Put must not leave a denial behind');
    assert.equal(fixture.appRequests.length, 0, 'revision conflict must not send an app probe');
    assert.equal(fixture.checkpointObjects.length, 0, 'revision conflict must not write a checkpoint');
    assert.deepEqual(fixture.mutations, [`PutResourcePolicy ${tableArn}`]);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('a lost Put acknowledgement reconciles the exact denial without resending', async () => {
    const { id, action, state } = await activateAndConfirm({ api, worker, putMode: 'lost-ack' });
    assert.equal(action.status, 'completed');
    assert.equal(fixture.policyPuts.length, 1, 'lost acknowledgement must not resend Put');
    assert.deepEqual(fixture.policy, denialDocument(id), 'readback must reconcile the action-owned document');
    assert.equal(fixture.policyRevision, 'revision-1');
    assert.equal(state.incident?.kind, 'inventory_access_denied');
    assert.equal(state.incident?.activationActionId, id);
    assert.equal(state.incident?.policy?.state, 'present');
    assert.equal(state.incident?.policy?.revision, 'revision-1');
    assert.equal(state.incident?.policy?.statementId, denialDocument(id).Statement[0].Sid);
    assert.equal(state.incident?.checkpoint?.status, 'stored');
    assert.equal(fixture.checkpointObjects.length, 1, 'successful reconciliation must retain a checkpoint');
    assert.ok(fixture.checkpointObjects[0].key.startsWith(evidencePrefix));
    assert.ok(fixture.appRequests.some(({ path }) => path === '/api/products'));
    assert.ok(fixture.appRequests.some(({ path, method }) => path === '/api/checkout' && method === 'POST'));
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('a foreign policy revision survives conditional restore', async () => {
    const activation = await activateAndConfirm({ api, worker });
    const beforeRestoreRequests = fixture.appRequests.length;
    const foreign = {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Deny', Principal: { AWS: 'arn:aws:iam::027224425948:role/ForeignRole' },
        Action: 'dynamodb:GetItem', Resource: tableArn }],
    };
    fixture.beforeDelete = () => {
      fixture.policy = foreign;
      fixture.policyRevision = 'revision-foreign';
    };
    const restoreId = await submit(api, 'restore_inventory_access');
    await withPolicyPropagationElapsed(() => worker.handler({ actionId: restoreId }));
    const restore = await getAction(api, restoreId);
    assert.notEqual(restore.status, 'completed');
    assert.match(restore.error ?? '', /revision|policy|conflict|changed/i);
    assert.equal(fixture.policyDeletes.length, 1, 'restore must use one conditional Delete');
    assert.equal(fixture.policyDeletes[0].ExpectedRevisionId, activation.state.incident?.policy?.revision);
    assert.deepEqual(fixture.policy, foreign, 'a foreign revision must not be deleted');
    assert.equal(fixture.appRequests.length, beforeRestoreRequests, 'restore must not send app probes');
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('ordinary restore stops on unavailable checkpoint, protective restore preserves the gap', async () => {
    await activateAndConfirm({ api, worker });
    const beforeRequests = fixture.appRequests.length;
    fixture.checkpointMode = 'fail';
    const ordinaryId = await submit(api, 'restore_inventory_access');
    await worker.handler({ actionId: ordinaryId });
    const ordinary = await getAction(api, ordinaryId);
    assert.notEqual(ordinary.status, 'completed');
    assert.match(ordinary.error ?? '', /checkpoint|evidence|capture|unavailable/i);
    assert.equal(fixture.policyDeletes.length, 0, 'ordinary restore must not delete without its checkpoint');
    assert.ok(fixture.policy, 'the known denial must remain active after ordinary restore is blocked');
    assert.equal(fixture.appRequests.length, beforeRequests, 'restore must not send an app request');
    const blockedState = await getState(api);
    assert.match(blockedState.incident?.checkpoint?.status ?? '', /unavailable|incomplete/);

    fixture.checkpointMode = 'fail';
    const expectedDeleteRevision = fixture.policyRevision;
    const protectiveId = await submit(api, 'restore_inventory_access', { restoreWithoutEvidence: true });
    await withPolicyPropagationElapsed(() => worker.handler({ actionId: protectiveId }));
    const protective = await getAction(api, protectiveId);
    assert.equal(protective.status, 'completed');
    assert.equal(fixture.policyDeletes.length, 1);
    assert.equal(fixture.policyDeletes[0].ExpectedRevisionId, expectedDeleteRevision);
    assert.equal(fixture.policy, undefined, 'protective restore must remove only the recorded denial');
    assert.equal(fixture.appRequests.length, beforeRequests, 'protective restore must not send an app request');
    const restoredState = await getState(api);
    assert.equal(restoredState.incident?.checkpoint?.status, 'incomplete');
    assert.match(restoredState.incident?.checkpoint?.error ?? '', /evidence|capture|checkpoint/i);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('restore runs independently while held traffic drains through Stop', async () => {
    const activation = await activateAndConfirm({ api, worker });
    const activationRequestCount = fixture.appRequests.length;
    fixture.appMode = 'hold';
    const trafficId = await submit(api, 'traffic');
    const trafficRun = worker.handler({ actionId: trafficId });
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && fixture.appRequests.length < activationRequestCount + 3) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      assert.equal(fixture.appRequests.length, activationRequestCount + 3, 'traffic must hold one catalog and two checkout requests');
      const held = await getAction(api, trafficId);
      assert.equal(held.traffic.catalog.inFlight, 1);
      assert.equal(held.traffic.checkout.inFlight, 2);

      const beforeRestoreRequests = fixture.appRequests.length;
      const restoreId = await submit(api, 'restore_inventory_access');
      await withPolicyPropagationElapsed(() => worker.handler({ actionId: restoreId }));
      const restore = await getAction(api, restoreId);
      assert.equal(restore.status, 'completed');
      assert.equal(fixture.appRequests.length, beforeRestoreRequests, 'restore must not submit probes');
      const stopId = await submit(api, 'stop', { targetActionId: trafficId });
      const stop = await getAction(api, stopId);
      assert.equal(stop.status, 'completed');
      const draining = await getAction(api, trafficId);
      assert.equal(draining.status, 'draining');
      assert.equal(draining.stopRequested, true);
    } finally {
      releaseHeld();
      await trafficRun;
    }
    const stopped = await getAction(api, trafficId);
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.traffic.catalog.inFlight, 0);
    assert.equal(stopped.traffic.checkout.inFlight, 0);
    assert.equal(fixture.appRequests.length, activationRequestCount + 3, 'Stop must drain held requests without new producers');
    assert.equal((await getState(api)).incident?.activationActionId, activation.id);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('a generic 502 cannot confirm access denial', async () => {
    const { id, action, state } = await activateAndConfirm({ api, worker, appMode: 'generic-502' });
    assert.ok(['failed', 'incomplete'].includes(action.status), 'a generic 502 must not complete activation');
    assert.match(action.error ?? '', /denial|specific|dependency|confirmed|evidence|effect/i);
    const request = action.requests.find(({ kind }) => kind === 'catalog' || kind === 'checkout');
    assert.ok(request, 'the activation must retain the attempted probe');
    assert.notEqual(request.dependencyReason, 'inventory_access_denied');
    assert.equal(state.incident?.activationActionId, id, 'the owned intent must remain visible for reconciliation');
    assert.deepEqual(fixture.policy, denialDocument(id), 'the owned policy must remain active after an unconfirmed probe');
    assert.equal(fixture.policyDeletes.length, 0);
    assert.deepEqual(fixture.unhandled, []);
  });
});
