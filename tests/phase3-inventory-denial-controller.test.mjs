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

const records = new Map();
const fixture = {
  appRequests: [],
  invocations: [],
  mutations: [],
  policyReads: [],
  unhandled: [],
  revision: appRevision,
  policy: undefined,
  aliasVersion: { Checkout: '2', Inventory: '2' },
};

function row(pk) {
  return records.get(pk);
}

function put(value) {
  records.set(value.pk, value);
}

function reset({ baselineRevision = appRevision, revision = appRevision, policy } = {}) {
  records.clear();
  fixture.appRequests.length = 0;
  fixture.invocations.length = 0;
  fixture.mutations.length = 0;
  fixture.policyReads.length = 0;
  fixture.unhandled.length = 0;
  fixture.revision = revision;
  fixture.policy = policy;
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
  return (request.headers['content-type'] ?? '').includes('form-urlencoded')
    ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw);
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
  if (target.endsWith('GetResourcePolicy')) {
    fixture.policyReads.push(body.ResourceArn);
    if (body.ResourceArn !== tableArn) throw new Error(`unexpected policy read target ${body.ResourceArn}`);
    return fixture.policy ? { Policy: JSON.stringify(fixture.policy), RevisionId: 'revision-unexpected' }
      : { __error: 'PolicyNotFoundException' };
  }
  if (target.endsWith('DescribeStacks')) return { __xml: stackXml() };
  if (target.endsWith('ListStackResources')) return { __xml: resourcesXml() };
  if (!target && request.url.includes('/aliases/live')) {
    const name = request.url.includes('Checkout') ? 'Checkout' : 'Inventory';
    return { FunctionVersion: fixture.aliasVersion[name], FunctionArn: `arn:aws:lambda:${region}:${account}:function:IncidentTriageDemo${name}:live`, RoutingConfig: {} };
  }
  if (!target && request.url.includes('/config')) {
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
    AWS_REGION: region,
    AWS_ACCESS_KEY_ID: 'fixture',
    AWS_SECRET_ACCESS_KEY: 'fixture-only',
    AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'false',
    AWS_EC2_METADATA_DISABLED: 'true',
    CONTROLLER_RUN_TABLE: runTable,
    CONTROLLER_OPERATOR_SECRET_ARN: `arn:aws:secretsmanager:${region}:${account}:secret:fixture:operator`,
    CONTROLLER_APP_SECRET_ARN: `arn:aws:secretsmanager:${region}:${account}:secret:fixture:app`,
    CONTROLLER_WORKER_NAME: 'ControllerWorkerFixture',
  });
  delete process.env.AWS_PROFILE;
  delete process.env.AWS_SESSION_TOKEN;
}

function httpEvent(method, path, body) {
  return { rawPath: path, requestContext: { http: { method } },
    headers: { authorization: `Bearer ${operatorBearer}` }, body: body && JSON.stringify(body) };
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

test('Inventory denial activation fails closed before mutation or app traffic', { timeout: 20_000 }, async (t) => {
  const server = await startAwsServer();
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
  });
  awsEnvironment(server.address().port);
  globalThis.fetch = async (url, init = {}) => {
    fixture.appRequests.push({ url: String(url), method: init.method ?? 'GET' });
    const target = new URL(url);
    assert.equal(target.origin, appApi, 'worker app requests must stay on the controlled fixture origin');
    const status = target.pathname === '/api/products' ? 200 : 502;
    const body = target.pathname === '/api/products'
      ? { observedAt: new Date().toISOString(), products: [{ sku: 'demo-widget', productVersion: 'fixture-product-v1', availableQuantity: 99 }] }
      : { code: 'INVENTORY_LOOKUP_FAILED' };
    return { status, headers: new Headers({ 'content-type': 'application/json', 'x-amzn-requestid': 'fixture-request' }),
      json: async () => body };
  };

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
});
