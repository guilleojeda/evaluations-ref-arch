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
export const evidenceBucket = 'incident-triage-demo-evidence-027224425948-us-east-1';
export const evidencePrefix = 'configuration/';
export const manifestBucket = 'cdk-evaltalk-assets-027224425948-us-east-1';
export const manifestKey = `releases/app/${appRevision}/inventory-variants.json`;
export const healthyVersion = '2';
export const deniedVersion = '3';

export const records = new Map();
export const fixture = {
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
  trace: [],
  configurationReads: [],
  concurrencyReads: [],
  alarmReads: [],
  unhandled: [],
  revision: appRevision,
  healthyRoleAttached: false,
  deniedRoleAttached: true,
  iamPolicyDocument: undefined,
  iamDefaultVersionId: 'v1',
  iamVersionDocuments: new Map(),
  manifestCodeSha256: 'fixture-code',
  extraVariants: [],
  versionOverrides: {},
  inventoryConcurrency: undefined,
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
  appOrders: new Map(),
  heldRequests: new Set(),
};

export function row(pk) {
  return records.get(pk);
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
  fixture.invocations.length = 0;
  fixture.mutations.length = 0;
  fixture.dynamoPolicyReads.length = 0;
  fixture.iamReads.length = 0;
  fixture.manifestReads.length = 0;
  fixture.aliasReads.length = 0;
  fixture.aliasUpdates.length = 0;
  fixture.aliasUpdateAttempts.length = 0;
  fixture.checkpointObjects.length = 0;
  fixture.trace.length = 0;
  fixture.configurationReads.length = 0;
  fixture.concurrencyReads.length = 0;
  fixture.alarmReads.length = 0;
  fixture.unhandled.length = 0;
  fixture.revision = revision;
  fixture.healthyRoleAttached = healthyAttached;
  fixture.deniedRoleAttached = deniedAttached;
  fixture.iamPolicyDocument = iamPolicyDocument();
  fixture.iamDefaultVersionId = versionId;
  fixture.iamVersionDocuments = versionDocuments ?? new Map([[versionId, fixture.iamPolicyDocument]]);
  fixture.manifestCodeSha256 = 'fixture-code';
  fixture.extraVariants = [];
  fixture.versionOverrides = {};
  fixture.inventoryConcurrency = undefined;
  fixture.manifestMode = 'valid';
  fixture.deniedConfigMode = 'valid';
  fixture.weightedAlias = false;
  fixture.aliasMode = 'apply';
  fixture.beforeAliasUpdate = undefined;
  fixture.aliasUpdateEntered = false;
  fixture.checkpointMode = 'store';
  fixture.appMode = 'denied';
  fixture.appStock = 99;
  fixture.appOrders = new Map();
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

export function stackXml() {
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

export async function awsProtocol(request, body) {
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
    fixture.aliasRevision = fixture.aliasRevision === 'alias-revision-1' ? 'alias-revision-2' : 'alias-revision-3';
    if (fixture.aliasMode === 'lost-ack') return { __error: 'ServiceFailure', __errorProtocol: 'lambda' };
    return { FunctionVersion: version, RevisionId: fixture.aliasRevision, RoutingConfig: {} };
  }
  if (!target && request.url.includes('/configuration?')) {
    const name = request.url.includes('Checkout') ? 'Checkout' : 'Inventory';
    const version = new URL(request.url, 'http://fixture').searchParams.get('Qualifier') ?? healthyVersion;
    const deniedConfig = name === 'Inventory' && version === deniedVersion;
    const variant = name === 'Inventory'
      ? variantsManifest().variants.find((candidate) => candidate.version === version) : undefined;
    const override = fixture.versionOverrides[version] ?? {};
    const config = {
      State: 'Active',
      Version: override.version ?? version,
      MemorySize: override.memoryMb ?? (deniedConfig && fixture.deniedConfigMode === 'memory' ? 512 : variant?.memoryMb ?? 256),
      Timeout: override.timeout ?? (name === 'Checkout' ? 12 : 6),
      CodeSha256: override.codeSha256 ?? (deniedConfig && fixture.deniedConfigMode === 'code' ? 'wrong-code' : fixture.manifestCodeSha256),
      Role: name === 'Checkout' ? checkoutRoleArn : override.roleArn ?? variant?.roleArn ?? inventoryRoleArn,
      Environment: { Variables: name === 'Checkout'
        ? { APP_ENVIRONMENT: 'demo', SOURCE_REVISION: fixture.revision, ORDERS_TABLE_NAME: 'IncidentTriageDemoOrders', INVENTORY_TABLE_NAME: table, PRODUCT_SKU: 'demo-widget' }
        : { APP_ENVIRONMENT: 'demo', SOURCE_REVISION: override.sourceRevision ?? (deniedConfig && fixture.deniedConfigMode === 'env' ? newerRevision : fixture.revision), INVENTORY_TABLE_NAME: override.inventoryTableArn ?? tableArn, PRODUCT_SKU: 'demo-widget' } },
      Architectures: override.architectures ?? ['x86_64'],
    };
    fixture.configurationReads.push({ name, version, ...config });
    return config;
  }
  if (!target && request.url.includes('/concurrency')) {
    const name = request.url.includes('IncidentTriageDemoInventory') ? 'Inventory' : 'Checkout';
    const cap = name === 'Inventory' ? fixture.inventoryConcurrency : undefined;
    fixture.concurrencyReads.push({ name, cap: cap ?? 'unreserved' });
    return cap === undefined ? {} : { ReservedConcurrentExecutions: cap };
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
      products: [{ sku: 'demo-widget', productVersion: 'fixture-product-v1',
        availableQuantity: fixture.appMode === 'selected-variant' ? fixture.appStock : 99 }],
    });
  }
  if (method === 'POST' && path === '/api/checkout') {
    if (fixture.appMode === 'generic-502' || selectedUnknown) return appResponse(502, { code: 'INVENTORY_LOOKUP_FAILED' });
    if (fixture.appMode === 'denied' || selectedDenied) return appResponse(502, {
      code: 'INVENTORY_LOOKUP_FAILED', dependencyReason: 'inventory_access_denied', checkoutId: body.checkoutId,
    });
    if (fixture.appMode === 'selected-variant') {
      fixture.appStock -= 1;
      const order = { checkoutId: body.checkoutId, sku: 'demo-widget', quantity: 1, unitPriceCents: 1299,
        totalPriceCents: 1299, currency: 'USD', createdAt: new Date().toISOString(), status: 'placed' };
      fixture.appOrders.set(body.checkoutId, order);
      return appResponse(201, { requestId: `fixture-${randomUUID()}`, order });
    }
    return appResponse(201, {
      requestId: `fixture-${randomUUID()}`,
      order: { checkoutId: body.checkoutId, sku: 'demo-widget', quantity: 1, unitPriceCents: 1299,
        totalPriceCents: 1299, currency: 'USD', createdAt: new Date().toISOString(), status: 'placed' },
    });
  }
  if (method === 'GET' && path.startsWith('/api/orders/')) {
    if (fixture.appMode !== 'selected-variant' || selectedDenied || selectedUnknown) return appResponse(404, { code: 'ORDER_NOT_FOUND' });
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
  fixture.appMode = 'healthy';
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

