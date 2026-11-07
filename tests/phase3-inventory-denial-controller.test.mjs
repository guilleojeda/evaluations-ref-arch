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
const inventoryRoleName = 'IncidentTriageDemoAppInventoryRole';
const policyName = 'IncidentTriageDemoInventoryReadDeny';
const policyArn = `arn:aws:iam::${account}:policy/${policyName}`;
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
  dynamoPolicyReads: [],
  iamReads: [],
  iamAttaches: [],
  iamDetaches: [],
  checkpointObjects: [],
  alarmReads: [],
  unhandled: [],
  revision: appRevision,
  iamAttached: false,
  iamPolicyDocument: undefined,
  iamDefaultVersionId: 'v1',
  iamVersionDocuments: new Map(),
  attachMode: 'apply',
  detachMode: 'apply',
  beforeDetach: undefined,
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

function iamPolicyDocument() {
  return {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Deny', Action: 'dynamodb:GetItem', Resource: tableArn }],
  };
}

function reset({ baselineRevision = appRevision, revision = appRevision, attached = false,
  versionId = 'v1', versionDocuments } = {}) {
  records.clear();
  fixture.appRequests.length = 0;
  fixture.invocations.length = 0;
  fixture.mutations.length = 0;
  fixture.dynamoPolicyReads.length = 0;
  fixture.iamReads.length = 0;
  fixture.iamAttaches.length = 0;
  fixture.iamDetaches.length = 0;
  fixture.checkpointObjects.length = 0;
  fixture.alarmReads.length = 0;
  fixture.unhandled.length = 0;
  fixture.revision = revision;
  fixture.iamAttached = attached;
  fixture.iamPolicyDocument = iamPolicyDocument();
  fixture.iamDefaultVersionId = versionId;
  fixture.iamVersionDocuments = versionDocuments ?? new Map([[versionId, fixture.iamPolicyDocument]]);
  fixture.attachMode = 'apply';
  fixture.detachMode = 'apply';
  fixture.checkpointMode = 'store';
  fixture.appMode = 'denied';
  fixture.beforeDetach = undefined;
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
  const action = typeof body.Action === 'string' ? body.Action : '';
  const target = request.headers['x-amz-target'] ?? (action ? `CloudFormation_${action}` : '');
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
  if (target.endsWith('GetResourcePolicy')) {
    fixture.dynamoPolicyReads.push(body.ResourceArn);
    if (body.ResourceArn !== tableArn) throw new Error(`unexpected policy read target ${body.ResourceArn}`);
    return { __error: 'PolicyNotFoundException' };
  }
  if (action === 'ListAttachedRolePolicies') {
    assert.equal(body.RoleName, inventoryRoleName, 'IAM reads must target the Inventory execution role');
    fixture.iamReads.push({ action, ...body });
    const attached = fixture.iamAttached
      ? `<member><PolicyName>${policyName}</PolicyName><PolicyArn>${policyArn}</PolicyArn></member>` : '';
    return { __xml: `<ListAttachedRolePoliciesResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><ListAttachedRolePoliciesResult><AttachedPolicies>${attached}</AttachedPolicies><IsTruncated>false</IsTruncated></ListAttachedRolePoliciesResult></ListAttachedRolePoliciesResponse>` };
  }
  if (action === 'GetPolicy') {
    assert.equal(body.PolicyArn, policyArn, 'IAM policy reads must target the pre-created denial policy');
    fixture.iamReads.push({ action, ...body });
    return { __xml: `<GetPolicyResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><GetPolicyResult><Policy><PolicyName>${policyName}</PolicyName><PolicyArn>${policyArn}</PolicyArn><DefaultVersionId>${fixture.iamDefaultVersionId}</DefaultVersionId><AttachmentCount>${fixture.iamAttached ? 1 : 0}</AttachmentCount></Policy></GetPolicyResult></GetPolicyResponse>` };
  }
  if (action === 'GetPolicyVersion') {
    assert.equal(body.PolicyArn, policyArn, 'IAM policy-version reads must target the pre-created denial policy');
    fixture.iamReads.push({ action, ...body });
    const document = fixture.iamVersionDocuments.get(body.VersionId);
    if (!document) return { __error: 'NoSuchEntity', __errorProtocol: 'iam' };
    return { __xml: `<GetPolicyVersionResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><GetPolicyVersionResult><PolicyVersion><Document>${encodeURIComponent(JSON.stringify(document))}</Document><VersionId>${body.VersionId}</VersionId><IsDefaultVersion>${body.VersionId === fixture.iamDefaultVersionId}</IsDefaultVersion></PolicyVersion></GetPolicyVersionResult></GetPolicyVersionResponse>` };
  }
  if (action === 'AttachRolePolicy') {
    assert.equal(body.RoleName, inventoryRoleName, 'attach must target only the Inventory execution role');
    assert.equal(body.PolicyArn, policyArn, 'attach must target only the pre-created denial policy');
    fixture.iamAttaches.push({ ...body });
    fixture.mutations.push(`AttachRolePolicy ${body.RoleName} ${body.PolicyArn}`);
    if (fixture.attachMode === 'conflict') return { __error: 'EntityAlreadyExists', __errorProtocol: 'iam' };
    fixture.iamAttached = true;
    if (fixture.attachMode === 'lost-ack') return { __error: 'ServiceFailure', __errorProtocol: 'iam' };
    return { __xml: '<AttachRolePolicyResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"></AttachRolePolicyResponse>' };
  }
  if (action === 'DetachRolePolicy') {
    assert.equal(body.RoleName, inventoryRoleName, 'detach must target only the Inventory execution role');
    assert.equal(body.PolicyArn, policyArn, 'detach must target only the pre-created denial policy');
    fixture.iamDetaches.push({ ...body });
    fixture.mutations.push(`DetachRolePolicy ${body.RoleName} ${body.PolicyArn}`);
    if (typeof fixture.beforeDetach === 'function') fixture.beforeDetach(body);
    if (fixture.detachMode === 'conflict') return { __error: 'NoSuchEntity', __errorProtocol: 'iam' };
    fixture.iamAttached = false;
    if (fixture.detachMode === 'lost-ack') return { __error: 'ServiceFailure', __errorProtocol: 'iam' };
    return { __xml: '<DetachRolePolicyResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"></DetachRolePolicyResponse>' };
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
  if (/PutItem|UpdateItem|DeleteItem|PutFunctionConcurrency|DeleteFunctionConcurrency|UpdateAlias|UpdateFunctionConfiguration|UpdateFunctionCode|PublishVersion|AddPermission|RemovePermission|PutObject|DeleteObject/i.test(operation) ||
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
        if (result.__errorProtocol === 'iam') {
          response.writeHead(400, { 'content-type': 'text/xml' });
          response.end(`<ErrorResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><Error><Type>Sender</Type><Code>${result.__error}</Code><Message>${result.__error}</Message></Error><RequestId>fixture-iam-error</RequestId></ErrorResponse>`);
        } else {
          response.writeHead(400, { 'content-type': 'application/x-amz-json-1.0', 'x-amzn-errortype': result.__error });
          response.end(JSON.stringify({ __type: `com.amazonaws.dynamodbv20120810#${result.__error}`, message: result.__error,
            ...(result.__error === 'TransactionCanceledException'
              ? { CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] } : {}) }));
        }
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

async function assertActivationRejected({ api, worker, baselineRevision, revision = appRevision, expectedError }) {
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

function denialDocument() {
  return iamPolicyDocument();
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

async function activateAndConfirm({ api, worker, attachMode = 'apply', appMode = 'denied' }) {
  reset();
  fixture.attachMode = attachMode;
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

  await t.test('a pre-existing exact attachment fails closed before mutation or app traffic', async () => {
    reset({ attached: true });
    const id = await submit(api, 'activate_inventory_denial');
    await worker.handler({ actionId: id });
    const action = await getAction(api, id);
    assert.equal(action.status, 'failed');
    assert.match(action.error ?? '', /attached|policy|drift|baseline/i);
    assert.equal(fixture.iamAttaches.length, 0, 'an existing attachment must not be reattached');
    assert.equal(fixture.iamAttached, true);
    assert.equal(fixture.appRequests.length, 0, 'an existing attachment must not send an app probe');
    assert.ok(fixture.dynamoPolicyReads.length > 0, 'readiness must retain the Dynamo absence read');
    assert.ok(fixture.dynamoPolicyReads.every((resourceArn) => resourceArn === tableArn),
      'Dynamo absence reads must target only the Inventory table');
    assert.ok(fixture.iamReads.every(({ RoleName, PolicyArn }) =>
      (!RoleName || RoleName === inventoryRoleName) && (!PolicyArn || PolicyArn === policyArn)));
    assert.deepEqual(fixture.mutations, []);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('activation uses one exact IAM attachment and confirms the owned policy', async () => {
    const { id, action } = await activateAndConfirm({ api, worker });
    assert.equal(action.status, 'completed');
    assert.equal(fixture.iamAttaches.length, 1);
    assert.equal(fixture.iamAttaches[0].RoleName, inventoryRoleName);
    assert.equal(fixture.iamAttaches[0].PolicyArn, policyArn);
    assert.equal(fixture.iamAttached, true);
    assert.deepEqual(fixture.iamPolicyDocument, denialDocument(id));
    assert.ok(fixture.iamReads.some(({ action: readAction }) => readAction === 'ListAttachedRolePolicies'));
    assert.ok(fixture.iamReads.some(({ action: readAction }) => readAction === 'GetPolicy'));
    assert.ok(fixture.iamReads.some(({ action: readAction }) => readAction === 'GetPolicyVersion'));
    assert.ok(fixture.dynamoPolicyReads.length > 0);
    assert.ok(fixture.dynamoPolicyReads.every((resourceArn) => resourceArn === tableArn));
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('a lost AttachRolePolicy acknowledgement reconciles without resending', async () => {
    const { id, action, state } = await activateAndConfirm({ api, worker, attachMode: 'lost-ack' });
    assert.equal(action.status, 'completed');
    assert.equal(fixture.iamAttaches.length, 1, 'lost acknowledgement must not resend AttachRolePolicy');
    assert.equal(fixture.iamAttached, true, 'readback must reconcile the attachment');
    assert.deepEqual(fixture.iamPolicyDocument, denialDocument(id), 'readback must reconcile the action-owned document');
    assert.equal(state.incident?.kind, 'inventory_access_denied');
    assert.equal(state.incident?.activationActionId, id);
    assert.equal(state.incident?.policy?.state, 'present');
    assert.equal(state.incident?.policy?.policyArn, policyArn);
    assert.equal(state.incident?.policy?.policyName, policyName);
    assert.equal(state.incident?.policy?.roleArn, inventoryRoleArn);
    assert.equal(state.incident?.policy?.defaultVersionId, 'v1');
    assert.equal(state.incident?.policy?.documentMatches, true);
    assert.equal(state.incident?.policyBefore?.state, 'absent');
    assert.equal(state.incident?.checkpoint?.status, 'stored');
    assert.equal(state.incident?.checkpoint?.inventoryPolicyAtCapture?.policyArn, policyArn);
    assert.equal(state.incident?.checkpoint?.inventoryPolicyAtCapture?.roleArn, inventoryRoleArn);
    assert.equal(state.incident?.checkpoint?.inventoryPolicyAtCapture?.defaultVersionId, 'v1');
    assert.equal(state.incident?.checkpoint?.inventoryPolicyAtCapture?.documentMatches, true);
    assert.equal(state.incident?.checkpoint?.tablePolicyBefore?.state, 'absent');
    assert.equal(fixture.checkpointObjects.length, 1, 'successful reconciliation must retain a checkpoint');
    assert.ok(fixture.checkpointObjects[0].key.startsWith(evidencePrefix));
    assert.ok(fixture.appRequests.some(({ path }) => path === '/api/products'));
    assert.ok(fixture.appRequests.some(({ path, method }) => path === '/api/checkout' && method === 'POST'));
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('a default-policy-version drift blocks detach and preserves the attachment', async () => {
    const activation = await activateAndConfirm({ api, worker });
    const beforeRestoreRequests = fixture.appRequests.length;
    fixture.iamDefaultVersionId = 'v2';
    fixture.iamVersionDocuments.set('v2', denialDocument());
    const restoreId = await submit(api, 'restore_inventory_access');
    await withPolicyPropagationElapsed(() => worker.handler({ actionId: restoreId }));
    const restore = await getAction(api, restoreId);
    assert.notEqual(restore.status, 'completed');
    assert.match(restore.error ?? '', /version|policy|drift|changed/i);
    assert.equal(fixture.iamDetaches.length, 0, 'version drift must be detected before DetachRolePolicy');
    assert.equal(fixture.iamAttached, true, 'version drift must preserve the managed-policy attachment');
    assert.equal(fixture.iamDefaultVersionId, 'v2');
    assert.equal(activation.state.incident?.policy?.defaultVersionId, 'v1');
    assert.equal(activation.state.incident?.policy?.documentMatches, true);
    assert.equal(fixture.appRequests.length, beforeRestoreRequests, 'restore must not send app probes');
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('an already-detached owned policy is a no-op with no app traffic', async () => {
    await activateAndConfirm({ api, worker });
    fixture.iamAttached = false;
    const beforeRequests = fixture.appRequests.length;
    const restoreId = await submit(api, 'restore_inventory_access');
    await withPolicyPropagationElapsed(() => worker.handler({ actionId: restoreId }));
    const restore = await getAction(api, restoreId);
    assert.equal(restore.status, 'completed');
    assert.equal(fixture.iamDetaches.length, 0, 'absence must not issue a duplicate DetachRolePolicy');
    assert.equal(fixture.iamAttached, false);
    assert.equal(fixture.appRequests.length, beforeRequests, 'no-op restore must not send app probes');
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
    assert.equal(fixture.iamDetaches.length, 0, 'ordinary restore must not detach without its checkpoint');
    assert.equal(fixture.iamAttached, true, 'the known denial must remain active after ordinary restore is blocked');
    assert.equal(fixture.appRequests.length, beforeRequests, 'restore must not send an app request');
    const blockedState = await getState(api);
    assert.match(blockedState.incident?.checkpoint?.status ?? '', /unavailable|incomplete/);

    fixture.checkpointMode = 'fail';
    const protectiveId = await submit(api, 'restore_inventory_access', { restoreWithoutEvidence: true });
    await withPolicyPropagationElapsed(() => worker.handler({ actionId: protectiveId }));
    const protective = await getAction(api, protectiveId);
    assert.equal(protective.status, 'completed');
    assert.equal(fixture.iamDetaches.length, 1);
    assert.equal(fixture.iamDetaches[0].RoleName, inventoryRoleName);
    assert.equal(fixture.iamDetaches[0].PolicyArn, policyArn);
    assert.equal(fixture.iamAttached, false, 'protective restore must remove only the recorded attachment');
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
    const catalogs = action.requests.filter(({ kind }) => kind === 'catalog');
    assert.equal(catalogs.length, 6);
    assert.ok(Date.parse(catalogs.at(-1).startedAt) - Date.parse(catalogs[0].startedAt) >= 22_000,
      'the six probes must span the available propagation window');
    assert.equal(state.incident?.activationActionId, id, 'the owned intent must remain visible for reconciliation');
    assert.deepEqual(fixture.iamPolicyDocument, denialDocument(id), 'the managed policy document must remain unchanged after an unconfirmed probe');
    assert.equal(fixture.iamAttached, true, 'the owned attachment must remain active after an unconfirmed probe');
    assert.deepEqual(fixture.unhandled, []);
  });
});
