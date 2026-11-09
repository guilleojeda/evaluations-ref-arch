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
const deniedRoleArn = `arn:aws:iam::${account}:role/IncidentTriageDemoAppInventoryDeniedRole`;
const deniedRoleName = 'IncidentTriageDemoAppInventoryDeniedRole';
const policyName = 'IncidentTriageDemoInventoryReadDeny';
const policyArn = `arn:aws:iam::${account}:policy/${policyName}`;
const checkoutRoleArn = `arn:aws:iam::${account}:role/IncidentTriageDemoAppCheckoutRole`;
const appApi = 'https://fixtureapi.execute-api.us-east-1.amazonaws.com';
const operatorBearer = 'fixture-operator';
const appBearer = 'fixture-app';
const runTable = 'ControllerRunFixture';
const evidenceBucket = 'incident-triage-demo-evidence-027224425948-us-east-1';
const evidencePrefix = 'configuration/';
const manifestBucket = 'cdk-evaltalk-assets-027224425948-us-east-1';
const manifestKey = `releases/app/${appRevision}/inventory-variants.json`;
const healthyVersion = '2';
const deniedVersion = '3';

const records = new Map();
const fixture = {
  appRequests: [],
  invocations: [],
  mutations: [],
  dynamoPolicyReads: [],
  iamReads: [],
  manifestReads: [],
  aliasReads: [],
  aliasUpdates: [],
  aliasUpdateAttempts: [],
  checkpointObjects: [],
  alarmReads: [],
  unhandled: [],
  revision: appRevision,
  healthyRoleAttached: false,
  deniedRoleAttached: true,
  iamPolicyDocument: undefined,
  iamDefaultVersionId: 'v1',
  iamVersionDocuments: new Map(),
  manifestCodeSha256: 'fixture-code',
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
    Statement: [{ Sid: 'DenyInventoryGetItem', Effect: 'Deny', Action: 'dynamodb:GetItem', Resource: tableArn }],
  };
}

function variantsManifest() {
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
    ],
  };
}

function reset({ baselineRevision = appRevision, revision = appRevision, healthyAttached = false,
  deniedAttached = true, versionId = 'v1', versionDocuments, aliasVersion = healthyVersion,
  aliasRevision = 'alias-revision-1' } = {}) {
  records.clear();
  fixture.appRequests.length = 0;
  fixture.invocations.length = 0;
  fixture.mutations.length = 0;
  fixture.dynamoPolicyReads.length = 0;
  fixture.iamReads.length = 0;
  fixture.manifestReads.length = 0;
  fixture.aliasReads.length = 0;
  fixture.aliasUpdates.length = 0;
  fixture.aliasUpdateAttempts.length = 0;
  fixture.checkpointObjects.length = 0;
  fixture.alarmReads.length = 0;
  fixture.unhandled.length = 0;
  fixture.revision = revision;
  fixture.healthyRoleAttached = healthyAttached;
  fixture.deniedRoleAttached = deniedAttached;
  fixture.iamPolicyDocument = iamPolicyDocument();
  fixture.iamDefaultVersionId = versionId;
  fixture.iamVersionDocuments = versionDocuments ?? new Map([[versionId, fixture.iamPolicyDocument]]);
  fixture.manifestCodeSha256 = 'fixture-code';
  fixture.manifestMode = 'valid';
  fixture.deniedConfigMode = 'valid';
  fixture.weightedAlias = false;
  fixture.aliasMode = 'apply';
  fixture.beforeAliasUpdate = undefined;
  fixture.aliasUpdateEntered = false;
  fixture.checkpointMode = 'store';
  fixture.appMode = 'denied';
  fixture.aliasVersion = { Checkout: healthyVersion, Inventory: aliasVersion };
  fixture.aliasRevision = aliasRevision;
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
}

function stackXml() {
  const outputs = [
    ['SourceRevision', fixture.revision], ['ApiUrl', appApi], ['ProductSku', 'demo-widget'],
    ['CheckoutFunctionName', 'IncidentTriageDemoCheckout'], ['InventoryFunctionName', 'IncidentTriageDemoInventory'],
    ['InventoryTableName', table], ['InventoryRoleArn', inventoryRoleArn], ['PresenterCredentialGeneration', 'fixture-generation'],
    ['InventoryDeniedRoleArn', deniedRoleArn],
    ['InventoryVariantsManifestBucket', manifestBucket], ['InventoryVariantsManifestKey', manifestKey],
    ['CheckoutLiveVersion', healthyVersion], ['InventoryLiveVersion', healthyVersion],
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
    if (key !== manifestKey) throw new Error(`unexpected manifest key ${key}`);
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
    assert.ok(['alias-revision-1', 'alias-revision-2'].includes(body.RevisionId), 'alias update must use the observed revision');
    const version = body.FunctionVersion;
    assert.ok([healthyVersion, deniedVersion].includes(version), 'alias update must target an allowlisted version');
    fixture.aliasUpdateAttempts.push({ version, revisionId: body.RevisionId });
    if (body.RevisionId !== fixture.aliasRevision) return { __error: 'PreconditionFailedException', __errorProtocol: 'lambda' };
    fixture.aliasUpdateEntered = true;
    if (typeof fixture.beforeAliasUpdate === 'function') await fixture.beforeAliasUpdate(body);
    if (fixture.aliasMode === 'conflict') return { __error: 'PreconditionFailedException', __errorProtocol: 'lambda' };
    if (fixture.aliasMode === 'lost-no-observation') return { __error: 'ServiceFailure', __errorProtocol: 'lambda' };
    fixture.aliasUpdates.push({ version, revisionId: body.RevisionId });
    fixture.mutations.push(`UpdateAlias live ${version}`);
    fixture.aliasVersion.Inventory = version;
    fixture.aliasRevision = fixture.aliasRevision === 'alias-revision-1' ? 'alias-revision-2' : 'alias-revision-3';
    if (fixture.aliasMode === 'lost-ack') return { __error: 'ServiceFailure', __errorProtocol: 'lambda' };
    return { FunctionVersion: version, RevisionId: fixture.aliasRevision, RoutingConfig: {} };
  }
  if (!target && request.url.includes('/configuration?')) {
    const name = request.url.includes('Checkout') ? 'Checkout' : 'Inventory';
    const version = new URL(request.url, 'http://fixture').searchParams.get('Qualifier') ?? healthyVersion;
    const deniedConfig = name === 'Inventory' && version === deniedVersion;
    return { State: 'Active', Version: new URL(request.url, 'http://fixture').searchParams.get('Qualifier') ?? '2',
      MemorySize: deniedConfig && fixture.deniedConfigMode === 'memory' ? 512 : 256,
      Timeout: name === 'Checkout' ? 12 : 6,
      CodeSha256: deniedConfig && fixture.deniedConfigMode === 'code' ? 'wrong-code' : 'fixture-code',
      Role: name === 'Checkout' ? checkoutRoleArn : version === deniedVersion ? deniedRoleArn : inventoryRoleArn,
      Environment: { Variables: name === 'Checkout'
        ? { APP_ENVIRONMENT: 'demo', SOURCE_REVISION: fixture.revision, ORDERS_TABLE_NAME: 'IncidentTriageDemoOrders', INVENTORY_TABLE_NAME: table, PRODUCT_SKU: 'demo-widget' }
        : { APP_ENVIRONMENT: 'demo', SOURCE_REVISION: deniedConfig && fixture.deniedConfigMode === 'env' ? newerRevision : fixture.revision, INVENTORY_TABLE_NAME: tableArn, PRODUCT_SKU: 'demo-widget' } },
      Architectures: ['x86_64'] };
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

async function withElapsed(milliseconds, callback) {
  const now = Date.now;
  Date.now = () => now() + milliseconds;
  try {
    return await callback();
  } finally {
    Date.now = now;
  }
}

async function activateAndConfirm({ api, worker, aliasMode = 'apply', appMode = 'denied' }) {
  reset();
  fixture.aliasMode = aliasMode;
  fixture.appMode = appMode;
  const id = await submit(api, 'activate_inventory_denial');
  await worker.handler({ actionId: id });
  const action = await getAction(api, id);
  const state = await getState(api);
  return { id, action, state };
}

async function assertActivationFailsBeforeAlias({ api, worker, configure, expectedError }) {
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

test('Inventory denial alias activation and restoration fail closed', { timeout: 90_000 }, async (t) => {
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

  await t.test('a changed denied-role attachment fails closed before alias mutation', async () => {
    reset({ deniedAttached: false });
    const id = await submit(api, 'activate_inventory_denial');
    await worker.handler({ actionId: id });
    const action = await getAction(api, id);
    assert.equal(action.status, 'failed');
    assert.match(action.error ?? '', /attach|policy|drift|baseline/i);
    assert.equal(fixture.aliasUpdates.length, 0, 'attachment drift must not update the alias');
    assert.equal(fixture.deniedRoleAttached, false);
    assert.equal(fixture.appRequests.length, 0, 'an existing attachment must not send an app probe');
    assert.ok(fixture.dynamoPolicyReads.length > 0, 'readiness must retain the Dynamo absence read');
    assert.ok(fixture.dynamoPolicyReads.every((resourceArn) => resourceArn === tableArn),
      'Dynamo absence reads must target only the Inventory table');
    assert.ok(fixture.iamReads.every(({ RoleName, PolicyArn }) =>
      (!RoleName || [inventoryRoleName, deniedRoleName].includes(RoleName)) && (!PolicyArn || PolicyArn === policyArn)));
    assert.deepEqual(fixture.mutations, []);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('missing, stale or malformed manifests fail before alias mutation', async () => {
    for (const [mode, expectedError] of [['missing', /manifest|unavailable|NoSuchKey|provider/i], ['stale', /stale|release|revision/i], ['malformed', /manifest|schema|invalid/i]]) {
      await assertActivationFailsBeforeAlias({ api, worker, configure: () => { fixture.manifestMode = mode; }, expectedError });
    }
  });

  await t.test('weighted aliases and denied configuration drift fail before alias mutation', async () => {
    await assertActivationFailsBeforeAlias({ api, worker, configure: () => { fixture.weightedAlias = true; }, expectedError: /weighted|alias|version/i });
    reset({ aliasVersion: '99' });
    const unlistedId = await submit(api, 'activate_inventory_denial');
    await worker.handler({ actionId: unlistedId });
    const unlisted = await getAction(api, unlistedId);
    assert.match(unlisted.error ?? '', /alias|version|baseline/i);
    assert.equal(fixture.aliasUpdates.length, 0);
    assert.equal(fixture.appRequests.length, 0);
    for (const mode of ['memory', 'code', 'env']) {
      await assertActivationFailsBeforeAlias({ api, worker, configure: () => { fixture.deniedConfigMode = mode; }, expectedError: /variant|configuration|environment|manifest|code|memory/i });
    }
  });

  await t.test('activation checkpoints and updates the single live alias to the denied variant', async () => {
    const { id, action, state } = await activateAndConfirm({ api, worker });
    assert.equal(action.status, 'completed');
    assert.equal(fixture.aliasUpdates.length, 1);
    assert.equal(fixture.aliasUpdates[0].version, deniedVersion);
    assert.equal(fixture.aliasUpdateAttempts[0].revisionId, 'alias-revision-1', 'UpdateAlias must carry the observed alias revision in its JSON body');
    assert.equal(fixture.aliasVersion.Inventory, deniedVersion);
    assert.equal(state.incident?.mechanism, 'lambda-alias');
    assert.equal(state.incident?.active, 'denied');
    assert.equal(state.incident?.target?.version, deniedVersion);
    assert.equal(state.incident?.target?.roleArn, deniedRoleArn);
    assert.equal(state.incident?.alias?.functionVersion, deniedVersion);
    assert.equal(state.incident?.alias?.routingWeighted, false);
    assert.equal(state.incident?.aliasBefore?.functionVersion, healthyVersion);
    assert.equal(state.incident?.policyBefore?.state, 'present');
    assert.equal(state.incident?.policyBefore?.roleArn, deniedRoleArn);
    assert.equal(state.incident?.checkpoint?.status, 'stored');
    assert.equal(state.incident?.checkpoint?.inventoryAliasBefore?.functionVersion, healthyVersion);
    assert.equal(state.incident?.checkpoint?.inventoryAliasAtCapture?.functionVersion, deniedVersion);
    assert.equal(state.incident?.checkpoint?.inventoryVersion, deniedVersion);
    assert.equal(state.incident?.checkpoint?.inventoryRoleArn, deniedRoleArn);
    assert.equal(fixture.checkpointObjects.length, 1, 'activation must retain one pre-switch checkpoint');
    const checkpointBody = typeof fixture.checkpointObjects[0].body === 'string'
      ? JSON.parse(fixture.checkpointObjects[0].body) : fixture.checkpointObjects[0].body;
    assert.equal(checkpointBody.inventoryAliasBefore?.functionVersion, healthyVersion, 'durable capture must retain the healthy alias before switching');
    assert.equal(checkpointBody.inventoryAliasAtCapture?.functionVersion, deniedVersion, 'durable capture must retain the denied alias at capture');
    assert.equal(checkpointBody.target?.inventoryRoleArn, deniedRoleArn);
    assert.equal(checkpointBody.settings?.inventory?.version, deniedVersion);
    assert.ok(fixture.appRequests.some(({ path }) => path === '/api/products'), 'activation must retain a catalog denial probe');
    assert.ok(fixture.appRequests.some(({ path, method }) => path === '/api/checkout' && method === 'POST'), 'activation must retain a fresh denial checkout');
    assert.deepEqual(fixture.iamPolicyDocument, denialDocument(id));
    assert.ok(fixture.iamReads.some(({ action: readAction }) => readAction === 'ListAttachedRolePolicies'));
    assert.ok(fixture.iamReads.some(({ action: readAction }) => readAction === 'GetPolicy'));
    assert.ok(fixture.iamReads.some(({ action: readAction }) => readAction === 'GetPolicyVersion'));
    assert.ok(fixture.dynamoPolicyReads.length > 0);
    assert.ok(fixture.dynamoPolicyReads.every((resourceArn) => resourceArn === tableArn));
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('a live default policy version drift from baseline v1 to v2 blocks activation before mutation', async () => {
    const document = denialDocument();
    reset({ versionId: 'v2', versionDocuments: new Map([['v1', document], ['v2', document]]) });
    const id = await submit(api, 'activate_inventory_denial');
    await worker.handler({ actionId: id });
    const action = await getAction(api, id);
    assert.equal(action.status, 'failed');
    assert.match(action.error ?? '', /version|policy|drift|changed/i);
    assert.equal(fixture.iamDefaultVersionId, 'v2');
    assert.equal(fixture.aliasUpdates.length, 0, 'policy drift must be rejected before UpdateAlias');
    assert.equal(fixture.appRequests.length, 0, 'version drift must not send app probes');
    assert.equal(fixture.checkpointObjects.length, 0, 'version drift must not capture a checkpoint');
    assert.ok(fixture.iamReads.some(({ action: readAction, VersionId }) =>
      readAction === 'GetPolicyVersion' && VersionId === 'v2'));
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('a lost UpdateAlias acknowledgement reconciles without resending', async () => {
    const { id, action, state } = await activateAndConfirm({ api, worker, aliasMode: 'lost-ack' });
    assert.equal(action.status, 'completed');
    assert.equal(fixture.aliasUpdates.length, 1, 'lost acknowledgement must not resend UpdateAlias');
    assert.equal(fixture.aliasVersion.Inventory, deniedVersion, 'readback must reconcile the alias target');
    assert.equal(state.incident?.kind, 'inventory_access_denied');
    assert.equal(state.incident?.activationActionId, id);
    assert.equal(state.incident?.active, 'denied');
    assert.equal(state.incident?.policy?.policyArn, policyArn);
    assert.equal(state.incident?.policy?.policyName, policyName);
    assert.equal(state.incident?.policy?.roleArn, deniedRoleArn);
    assert.equal(state.incident?.policy?.defaultVersionId, 'v1');
    assert.equal(state.incident?.policy?.documentMatches, true);
    assert.equal(state.incident?.policyBefore?.state, 'present');
    assert.equal(state.incident?.checkpoint?.status, 'stored');
    assert.equal(state.incident?.checkpoint?.inventoryPolicyAtCapture?.policyArn, policyArn);
    assert.equal(state.incident?.checkpoint?.inventoryPolicyAtCapture?.roleArn, deniedRoleArn);
    assert.equal(state.incident?.checkpoint?.inventoryPolicyAtCapture?.defaultVersionId, 'v1');
    assert.equal(state.incident?.checkpoint?.inventoryPolicyAtCapture?.documentMatches, true);
    assert.equal(state.incident?.checkpoint?.tablePolicyBefore?.state, 'absent');
    assert.equal(fixture.checkpointObjects.length, 1, 'successful reconciliation must retain a checkpoint');
    assert.ok(fixture.checkpointObjects[0].key.startsWith(evidencePrefix));
    const checkpointBody = typeof fixture.checkpointObjects[0].body === 'string'
      ? JSON.parse(fixture.checkpointObjects[0].body) : fixture.checkpointObjects[0].body;
    assert.deepEqual(checkpointBody.policyDocument, denialDocument(), 'checkpoint must retain the exact provisioned IAM policy document');
    assert.ok(fixture.appRequests.some(({ path }) => path === '/api/products'));
    assert.ok(fixture.appRequests.some(({ path, method }) => path === '/api/checkout' && method === 'POST'));
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('a lost alias acknowledgement with no observed target stays unknown and blocks reuse', async () => {
    reset();
    fixture.aliasMode = 'lost-no-observation';
    const id = await submit(api, 'activate_inventory_denial');
    await worker.handler({ actionId: id });
    const action = await getAction(api, id);
    const state = await getState(api);
    assert.equal(action.status, 'incomplete');
    assert.equal(action.configurationOutcome, 'unknown');
    assert.equal(state.incident?.activationActionId, id);
    assert.equal(state.incident?.active, 'unknown', 'an uncertain alias update is not proof of a safe healthy target');
    assert.equal(fixture.aliasUpdates.length, 0, 'an unobserved alias update must not be repeated');
    assert.equal(fixture.aliasVersion.Inventory, healthyVersion);
    assert.equal(fixture.appRequests.length, 0, 'unknown attachment must not send app probes');
    assert.equal(fixture.checkpointObjects.length, 0, 'unknown attachment must not capture incident evidence');

    const readinessId = randomUUID();
    const readiness = await call(api, 'PUT', `/api/actions/${readinessId}`,
      { kind: 'readiness', confirmQuiet: true }, 409);
    assert.match(readiness.code ?? '', /incident|unknown|incomplete/i);
    const retryId = randomUUID();
    const retry = await call(api, 'PUT', `/api/actions/${retryId}`,
      { kind: 'activate_inventory_denial' }, 409);
    assert.match(retry.code ?? '', /incident|unknown|incomplete/i);
    assert.deepEqual(fixture.invocations, [id], 'blocked readiness/reactivation must not dispatch workers');

    const discardId = randomUUID();
    const discardedCommand = await withElapsed(120_000, () => call(api, 'PUT', `/api/actions/${discardId}`,
      { kind: 'discard', targetActionId: id }, 202));
    assert.equal(discardedCommand.action?.status, 'completed');
    assert.equal((await getAction(api, id)).status, 'discarded');
    const trafficId = randomUUID();
    const traffic = await call(api, 'PUT', `/api/actions/${trafficId}`, { kind: 'traffic' }, 409);
    assert.equal(traffic.code, 'INVENTORY_DENIAL_UNRESOLVED');
    assert.deepEqual(fixture.invocations, [id], 'discard and blocked traffic must not dispatch workers');
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('an alias revision drift blocks restore and preserves the denied target', async () => {
    const activation = await activateAndConfirm({ api, worker });
    const beforeRestoreRequests = fixture.appRequests.length;
    const beforeUpdates = fixture.aliasUpdates.length;
    fixture.aliasMode = 'conflict';
    const restoreId = await submit(api, 'restore_inventory_access');
    await worker.handler({ actionId: restoreId });
    const restore = await getAction(api, restoreId);
    assert.notEqual(restore.status, 'completed');
    assert.match(restore.error ?? '', /version|policy|drift|changed/i);
    assert.equal(fixture.aliasUpdates.length, beforeUpdates, 'revision drift must not record an applied UpdateAlias');
    assert.equal(fixture.aliasUpdateAttempts.at(-1)?.revisionId, 'alias-revision-2', 'restore must carry the current observed alias revision in the body');
    assert.equal(fixture.aliasVersion.Inventory, deniedVersion, 'revision drift must preserve the denied target');
    assert.equal(activation.state.incident?.active, 'denied');
    assert.equal(fixture.appRequests.length, beforeRestoreRequests, 'restore must not send app probes');
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('an already-healthy alias is a no-op with no app traffic', async () => {
    await activateAndConfirm({ api, worker });
    fixture.aliasVersion.Inventory = healthyVersion;
    const beforeUpdates = fixture.aliasUpdates.length;
    const beforeRequests = fixture.appRequests.length;
    const restoreId = await submit(api, 'restore_inventory_access');
    await worker.handler({ actionId: restoreId });
    const restore = await getAction(api, restoreId);
    assert.equal(restore.status, 'completed');
    assert.equal(fixture.aliasUpdates.length, beforeUpdates, 'healthy alias must not issue a duplicate UpdateAlias');
    assert.equal(fixture.aliasVersion.Inventory, healthyVersion);
    assert.equal(fixture.appRequests.length, beforeRequests, 'no-op restore must not send app probes');
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('a lost restore UpdateAlias acknowledgement reconciles the healthy target without reissue', async () => {
    await activateAndConfirm({ api, worker });
    const beforeRequests = fixture.appRequests.length;
    fixture.aliasMode = 'lost-ack';
    const restoreId = await submit(api, 'restore_inventory_access');
    await worker.handler({ actionId: restoreId });
    const restore = await getAction(api, restoreId);
    const state = await getState(api);
    assert.equal(restore.status, 'completed');
    assert.equal(restore.configurationOutcome, 'applied');
    assert.equal(fixture.aliasUpdates.length, 2, 'observed restore must not be retried');
    assert.equal(fixture.aliasVersion.Inventory, healthyVersion);
    assert.equal(state.incident?.active, 'healthy');
    assert.equal(fixture.appRequests.length, beforeRequests, 'restore must not send app probes');
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('ordinary restore stops on unavailable checkpoint, protective restore preserves the gap', async () => {
    await activateAndConfirm({ api, worker });
    const beforeUpdates = fixture.aliasUpdates.length;
    const beforeRequests = fixture.appRequests.length;
    fixture.checkpointMode = 'fail';
    const ordinaryId = await submit(api, 'restore_inventory_access');
    await worker.handler({ actionId: ordinaryId });
    const ordinary = await getAction(api, ordinaryId);
    assert.notEqual(ordinary.status, 'completed');
    assert.match(ordinary.error ?? '', /checkpoint|evidence|capture|unavailable/i);
    assert.equal(fixture.aliasUpdates.length, beforeUpdates, 'ordinary restore must not update without its checkpoint');
    assert.equal(fixture.aliasVersion.Inventory, deniedVersion, 'the known denial must remain active after ordinary restore is blocked');
    assert.equal(fixture.appRequests.length, beforeRequests, 'restore must not send an app request');
    const blockedState = await getState(api);
    assert.match(blockedState.incident?.checkpoint?.status ?? '', /unavailable|incomplete/);

    fixture.checkpointMode = 'fail';
    const protectiveId = await submit(api, 'restore_inventory_access', { restoreWithoutEvidence: true });
    await worker.handler({ actionId: protectiveId });
    const protective = await getAction(api, protectiveId);
    assert.equal(protective.status, 'completed');
    assert.equal(fixture.aliasUpdates.length, beforeUpdates + 1);
    assert.equal(fixture.aliasUpdates.at(-1).version, healthyVersion);
    assert.equal(fixture.aliasVersion.Inventory, healthyVersion, 'protective restore must select the healthy version');
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
    let releaseAliasUpdate;
    let restoreRun;
    let restoreId;
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
      const aliasGate = new Promise((resolveAlias) => { releaseAliasUpdate = resolveAlias; });
      fixture.beforeAliasUpdate = async () => {
        fixture.aliasUpdateEntered = true;
        await aliasGate;
      };
      restoreId = await submit(api, 'restore_inventory_access');
      restoreRun = worker.handler({ actionId: restoreId });
      const aliasDeadline = Date.now() + 10_000;
      while (Date.now() < aliasDeadline && !fixture.aliasUpdateEntered) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      assert.equal(fixture.aliasUpdateEntered, true, 'restore must reach the exact UpdateAlias call');
      assert.equal(fixture.appRequests.length, beforeRestoreRequests, 'restore must not submit probes');
      const stopId = await submit(api, 'stop', { targetActionId: trafficId });
      const stop = await getAction(api, stopId);
      assert.equal(stop.status, 'completed');
      const draining = await getAction(api, trafficId);
      assert.equal(draining.status, 'draining');
      assert.equal(draining.stopRequested, true);
      const restoreWhileHeld = await getAction(api, restoreId);
      assert.equal(restoreWhileHeld.status, 'running', 'Stop must not cancel or replace the in-flight restore');
    } finally {
      releaseAliasUpdate?.();
      releaseHeld();
      await Promise.all([trafficRun, restoreRun].filter(Boolean));
    }
    const restore = await getAction(api, restoreId);
    assert.equal(restore.status, 'completed');
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
    assert.equal(fixture.aliasVersion.Inventory, deniedVersion, 'unconfirmed effect leaves the selected denied alias active');
    assert.equal(state.incident?.activationActionId, id, 'the owned intent must remain visible for reconciliation');
    assert.deepEqual(fixture.iamPolicyDocument, denialDocument(id), 'the managed policy document must remain unchanged after an unconfirmed probe');
    assert.equal(fixture.deniedRoleAttached, true, 'the permanent denied-role policy remains attached');
    assert.deepEqual(fixture.unhandled, []);
  });
});
