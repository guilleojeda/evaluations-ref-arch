import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const account = '027224425948';
export const region = 'us-east-1';
export const runtimeId = 'IncidentTriageDemoAgent-7VWTOWDIs4';
export const runtimeArn = `arn:aws:bedrock-agentcore:${region}:${account}:runtime/${runtimeId}`;
export const alarmArn = `arn:aws:cloudwatch:${region}:${account}:alarm:IncidentTriageDemoAppStage5xx`;
export const adapterArn = `arn:aws:lambda:${region}:${account}:function:IncidentTriageDemoAlarmAdapter`;
export const selectorAdapterCodeSha256 = 'b'.repeat(64);
export const controllerTable = 'IncidentTriageDemoControllerRunFixture';
export const selectionKey = 'AGENT_SELECTION';
export const operatorBearer = 'phase21-controller-fixture-operator';
export const appRevision = '5a8a44da4b4d28add6125eeb14f4a7474e263e83';

const faultyArtifact = 'e5ac2ee20d8f3947eb95ceb74094e882a3d8a4a010f2a8e7bf96700dd5906b33';
const repairedArtifact = '1f8e45fedee78cc9cc60c8b777c2b3ef51eee53ac00909a3bbf499c78de28cf7';
const faultyEndpoint = `${runtimeArn}/runtime-endpoint/faulty`;
export const repairedEndpoint = `${runtimeArn}/runtime-endpoint/repaired`;

const faultyEnvironment = {
  AGENT_ACCOUNT_ID: account,
  AGENT_ALARM_ARN: alarmArn,
  AGENT_APP_HTTP_API_ID: '404scbghri',
  AGENT_ARTIFACT_SHA256: faultyArtifact,
  AGENT_CANDIDATE_ID: 'faulty',
  AGENT_ENDPOINT_NAME: 'faulty',
  AGENT_MODEL_ID: 'us.anthropic.claude-sonnet-4-6',
  AGENT_REGION: region,
  AGENT_RUN_TABLE: 'IncidentTriageDemoAgentRun',
  AGENT_SOURCE_BUCKET: `incident-triage-demo-evidence-${account}-${region}`,
  AGENT_SOURCE_PREFIX: 'agent-source/',
  AGENT_SOURCE_REVISION: 'bd6f77df97933e3e675ee9c2a699db16e29ea1b6',
};

const repairedEnvironment = {
  ...faultyEnvironment,
  AGENT_ARTIFACT_SHA256: repairedArtifact,
  AGENT_CANDIDATE_ID: 'repaired',
  AGENT_ENDPOINT_NAME: 'repaired',
  AGENT_SOURCE_REVISION: '62236d0e8731242d5a6468cf931f003a323b5349',
};

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function configFor(candidate) {
  const repaired = candidate === 'repaired';
  const artifact = repaired ? repairedArtifact : faultyArtifact;
  const environmentVariables = structuredClone(repaired ? repairedEnvironment : faultyEnvironment);
  const bucket = 'cdk-evaltalk-assets-027224425948-us-east-1';
  const prefix = repaired ? `agent-qualified/${artifact}.zip` : `agent-reference/${artifact}.zip`;
  const versionId = repaired ? 'jSNSUJ_qWCBaBQdiQ3nlS7DgSvYbmwNl' : 'cfbeR.PYCX2qc8g9xWBJUzqWmTBXCyaw';
  return {
    agentRuntimeArn: runtimeArn,
    agentRuntimeArtifact: {
      codeConfiguration: {
        code: { s3: { bucket, prefix, versionId } },
        entryPoint: ['opentelemetry-instrument', 'main.py'],
        runtime: 'PYTHON_3_13',
      },
    },
    environmentVariables,
    lifecycleConfiguration: { idleRuntimeSessionTimeout: 300, maxLifetime: 600 },
    metadataConfiguration: { requireMMDSV2: true },
    networkConfiguration: { networkMode: 'PUBLIC' },
    protocolConfiguration: { serverProtocol: 'HTTP' },
    roleArn: `arn:aws:iam::${account}:role/IncidentTriageDemoAgentRuntimeRole`,
  };
}

function stagedConfigFor(candidate) {
  const config = configFor(candidate);
  if (candidate === 'repaired') {
    config.agentRuntimeArtifact.codeConfiguration.code.s3 = {
      bucket: `incident-triage-demo-evidence-${account}-${region}`,
      prefix: `agent-evaluation/phase20/${repairedArtifact}/runtime.zip`,
    };
  }
  return config;
}

function publication(candidate) {
  const repaired = candidate === 'repaired';
  const artifactSha256 = repaired ? repairedArtifact : faultyArtifact;
  const endpointName = repaired ? 'repaired' : 'faulty';
  const endpointArn = repaired ? repairedEndpoint : faultyEndpoint;
  const runtimeVersion = repaired ? '20' : '19';
  const sourceRevision = repaired ? repairedEnvironment.AGENT_SOURCE_REVISION : faultyEnvironment.AGENT_SOURCE_REVISION;
  return {
    pk: `AGENT_PUBLICATION#${candidate}`,
    candidateId: candidate,
    status: repaired ? 'published' : 'reference',
    endpointName,
    endpointArn,
    runtimeArn,
    runtimeVersion,
    artifactSha256,
    artifactVersionId: repaired ? 'jSNSUJ_qWCBaBQdiQ3nlS7DgSvYbmwNl' : 'cfbeR.PYCX2qc8g9xWBJUzqWmTBXCyaw',
    ...(!repaired ? { configurationVersionId: 'BbCtgPF2Do16.BJ0oetJvN09pSFvW6fI' } : {}),
    // The private Phase 20 configuration bytes are not shipped in this
    // checkout. Keep the row's shape and staged/serving digest formula while
    // deriving a self-contained fixture digest from the exact bytes below.
    configurationSha256: digest(`${JSON.stringify(stagedConfigFor(candidate))}\n`),
    sourceRevision,
    ...(!repaired ? { sourceManifestSha256: '2b1eccde2e92799fd24d21572576680a856c7aba9f0b3495831f2f76a34e0bab' } : {}),
    sourceSha256: repaired
      ? '88b8b94f2da13263407aadc1301bc5b4c2345fcec3ac2bd148fead9835807bdd'
      : '3d21155b9f9465a0ac11eb9fcaf761bfd19549cf6454ae3ac20c20044d57a9eb',
    promptSha256: repaired
      ? '0f8d10ce6f46302a00dbe60cb29ebfeb4212627000c78b3529e6e0c7696ff425'
      : '161aa4357b908cffe9691349d01da284411cd5d4689235717525d79e1073fffc',
    modelId: 'us.anthropic.claude-sonnet-4-6',
    alarmArn,
    adapterArn,
    adapterCodeSha256: 'a88f40a6d780c0342f5aea5ad7e5eac3f7f270c28ed209c51543c1801a66da56',
    ...(repaired ? {
      caseSetSha256: '64e81d8ac825154dd49ee36ca750aca81bb4a07ab1612d1d00e6c28dba0a7bfe',
      reportIdentitiesSha256: '6ad649f0da85194e6b8c9f3675fd24f3a15d275d206a92a63ece7a49d394f5ca',
      experimentId: 'facc9c90-882c-4e53-aa04-bceae858fdd9',
      reviewEnvironment: 'repaired-publication',
      reviewRunId: '44265837592',
      reviewManifestSha256: '29669b1dc3faa8a9bf7693aa5650937cd330741ebd02a1bc9ac80c549b06ec1b',
      reviewer: 'guilleojeda',
    } : {}),
  };
}

function endpoint(candidate, overrides = {}) {
  const repaired = candidate === 'repaired';
  const version = repaired ? '20' : '19';
  const name = repaired ? 'repaired' : 'faulty';
  return {
    status: 'READY',
    liveVersion: version,
    name,
    agentRuntimeArn: runtimeArn,
    agentRuntimeEndpointArn: repaired ? repairedEndpoint : faultyEndpoint,
    ...overrides,
  };
}

function stackResponse() {
  return {
    Stacks: [{
      StackName: 'IncidentTriageDemoApp',
      StackId: `arn:aws:cloudformation:${region}:${account}:stack/IncidentTriageDemoApp/fixture`,
      StackStatus: 'UPDATE_COMPLETE',
      LastUpdatedTime: new Date('2026-11-18T12:00:00.000Z'),
      Outputs: [
        { OutputKey: 'CheckoutHttpApiId', OutputValue: '404scbghri' },
        { OutputKey: 'InventoryRoleArn', OutputValue: `arn:aws:iam::${account}:role/IncidentTriageDemoAppInventoryRole` },
        { OutputKey: 'InventoryTableArn', OutputValue: `arn:aws:dynamodb:${region}:${account}:table/IncidentTriageDemoInventory` },
        { OutputKey: 'PresenterCredentialGeneration', OutputValue: 'fixture-generation' },
      ],
    }],
  };
}

function decodeValue(value) {
  if (!value || typeof value !== 'object') return value;
  if (Object.hasOwn(value, 'S')) return value.S;
  if (Object.hasOwn(value, 'N')) return Number(value.N);
  if (Object.hasOwn(value, 'BOOL')) return value.BOOL;
  return unmarshall({ value }).value;
}

function keyOf(body) {
  const key = body.Key ?? {};
  const raw = key.pk ?? key.PK ?? key.key;
  return decodeValue(raw);
}

function rowFor(fixture, key) {
  return fixture.rows.get(key);
}

function project(row, body) {
  if (!body.ProjectionExpression && !body.AttributesToGet) return row;
  const aliases = body.ExpressionAttributeNames ?? {};
  const fields = (body.ProjectionExpression?.split(',') ?? body.AttributesToGet ?? [])
    .map((field) => aliases[field.trim()] ?? field.trim())
    .map((field) => field.split('.')[0]);
  return Object.fromEntries([...new Set(fields)].filter((field) => Object.hasOwn(row, field))
    .map((field) => [field, row[field]]));
}

function putRow(fixture, item) {
  const row = unmarshall(item, { wrapNumbers: false });
  const key = row.pk ?? row.PK;
  assert.equal(typeof key, 'string', 'controller writes must have a string pk');
  if (key.startsWith('AGENT_PUBLICATION#')) {
    fixture.rows.set(key, row);
  } else {
    fixture.rows.set(key, row);
  }
  if (key === selectionKey) fixture.selected = row;
}

function transaction(fixture, body) {
  const pending = [];
  for (const operation of body.TransactItems ?? []) {
    if (operation.Put?.Item) {
      const row = unmarshall(operation.Put.Item);
      const key = row.pk ?? row.PK;
      const existing = rowFor(fixture, key);
      const condition = operation.Put.ConditionExpression ?? '';
      if (condition.includes('attribute_not_exists') && existing) return false;
      if (condition.includes('#revision = :previous')) {
        const expected = Number(operation.Put.ExpressionAttributeValues?.[':previous']?.N);
        if (!existing || Number(existing.revision) !== expected) return false;
      }
      pending.push(row);
    }
  }
  for (const row of pending) putRow(fixture, marshall(row, { removeUndefinedValues: true }));
  return true;
}

function dynamoError(message = 'conditional write failed') {
  return { __type: 'com.amazonaws.dynamodb.v20120810#TransactionCanceledException', message };
}

function runtimeFor(fixture, candidate, overrides = {}) {
  const config = configFor(candidate);
  const version = candidate === 'repaired' ? '20' : '19';
  return {
    ...config,
    agentRuntimeId: runtimeId,
    agentRuntimeName: 'IncidentTriageDemoAgent',
    agentRuntimeVersion: version,
    platformVersion: 'V1',
    status: 'READY',
    ...overrides,
  };
}

export async function createPhase21Context(t) {
  const fixture = {
    rows: new Map(),
    publications: { faulty: publication('faulty'), repaired: publication('repaired') },
    endpoints: { faulty: endpoint('faulty'), repaired: endpoint('repaired') },
    runtimes: { faulty: runtimeFor(null, 'faulty'), repaired: runtimeFor(null, 'repaired') },
    selected: undefined,
    calls: [],
    writes: [],
    endpointReads: [],
    runtimeReads: [],
    s3Reads: [],
    s3Objects: new Map(),
    strongReads: 0,
    invocations: [],
    alarmState: 'OK',
    alarmActionsEnabled: true,
    alarmActions: [adapterArn],
    cloudWatchMode: 'ok',
    endpointMode: 'ok',
    runtimeMode: 'ok',
    loseSelectionResponse: false,
    selectionReadMode: 'ok',
    selectionReadbackOverride: undefined,
    selectionCommitted: false,
  };
  fixture.runtimes.faulty = runtimeFor(fixture, 'faulty');
  fixture.runtimes.repaired = runtimeFor(fixture, 'repaired');

  function reset({ selectedCandidate = 'faulty' } = {}) {
    fixture.rows.clear();
    fixture.calls.length = 0;
    fixture.writes.length = 0;
    fixture.endpointReads.length = 0;
    fixture.runtimeReads.length = 0;
    fixture.s3Reads.length = 0;
    fixture.strongReads = 0;
    fixture.invocations.length = 0;
    fixture.alarmState = 'OK';
    fixture.alarmActionsEnabled = true;
    fixture.alarmActions = [adapterArn];
    fixture.cloudWatchMode = 'ok';
    fixture.endpointMode = 'ok';
    fixture.runtimeMode = 'ok';
    fixture.loseSelectionResponse = false;
    fixture.selectionReadMode = 'ok';
    fixture.selectionReadbackOverride = undefined;
    fixture.selectionCommitted = false;
    fixture.publications = { faulty: publication('faulty'), repaired: publication('repaired') };
    fixture.endpoints = { faulty: endpoint('faulty'), repaired: endpoint('repaired') };
    fixture.runtimes = { faulty: runtimeFor(fixture, 'faulty'), repaired: runtimeFor(fixture, 'repaired') };
    fixture.s3Objects = new Map([
      [`cdk-evaltalk-assets-${account}-${region}/agent-reference/${fixture.publications.faulty.configurationSha256}.json`, {
        body: JSON.stringify(stagedConfigFor('faulty')) + '\n', versionId: 'BbCtgPF2Do16.BJ0oetJvN09pSFvW6fI',
      }],
      [`incident-triage-demo-evidence-${account}-${region}/agent-evaluation/phase20/${repairedArtifact}/runtime-configuration.json`, {
        body: JSON.stringify(stagedConfigFor('repaired')) + '\n',
      }],
    ]);
    const baseline = {
      appRevision,
      sku: 'demo-widget',
      productVersion: 'fixture-product-v1',
      deploymentIdentity: {
        stackId: 'arn:aws:cloudformation:us-east-1:027224425948:stack/IncidentTriageDemoApp/fixture',
        successfulAt: '2026-11-18T12:00:00.000Z',
        sourceRevision: appRevision,
        api: '404scbghri',
        sku: 'demo-widget',
        credentialGeneration: 'fixture-generation',
        checkoutVersion: '31',
        checkoutCodeSha256: 'c'.repeat(64),
        checkoutMemoryMb: 256,
        inventoryVersion: '75',
        inventoryCodeSha256: 'd'.repeat(64),
        inventoryMemoryMb: 256,
        inventoryCap: 16,
      },
      settings: {
        credentialGeneration: 'fixture-generation',
        inventoryRoleArn: `arn:aws:iam::${account}:role/IncidentTriageDemoAppInventoryRole`,
      },
    };
    fixture.rows.set('STATE', {
      pk: 'STATE', revision: 1, data: {
        runId: 'fixture-run', resetRequired: false, baseline, originalBaseline: structuredClone(baseline),
        receipts: [], unresolved: [], inventoryAliasUnknown: false,
        ...(selectedCandidate ? { selectedAgent: selectionRecord(selectedCandidate) } : {}),
      },
    });
    if (selectedCandidate) {
      fixture.rows.set(selectionKey, { pk: selectionKey, revision: 1, ...selectionRecord(selectedCandidate) });
      fixture.selected = fixture.rows.get(selectionKey);
    } else fixture.selected = undefined;
    fixture.rows.set('AGENT_PUBLICATION#faulty', structuredClone(fixture.publications.faulty));
    fixture.rows.set('AGENT_PUBLICATION#repaired', structuredClone(fixture.publications.repaired));
  }

  function selectionRecord(candidate) {
    const row = fixture.publications[candidate];
    const tupleFields = [
      'candidateId', 'endpointName', 'endpointArn', 'runtimeArn', 'runtimeVersion',
      'artifactSha256', 'artifactVersionId', 'configurationSha256', 'sourceRevision', 'sourceSha256',
      'promptSha256', 'modelId', 'alarmArn', 'adapterArn', 'adapterCodeSha256',
      'sourceManifestSha256', 'caseSetSha256', 'reportIdentitiesSha256', 'experimentId',
      'reviewEnvironment', 'reviewRunId', 'reviewManifestSha256', 'reviewer',
    ];
    return {
      ...Object.fromEntries(tupleFields.filter((field) => Object.hasOwn(row, field)).map((field) => [field, row[field]])),
      selectedAt: '2026-11-18T12:00:00.000Z',
    };
  }

  reset();

  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    const target = request.headers['x-amz-target'] ?? '';
    fixture.calls.push({ method: request.method, url: request.url, target, body });

    const send = (status, value, contentType = 'application/x-amz-json-1.1') => {
      response.writeHead(status, { 'content-type': contentType });
      response.end(typeof value === 'string' ? value : JSON.stringify(value));
    };
    if (target.endsWith('GetSecretValue')) {
      send(200, { SecretString: digest(operatorBearer) });
      return;
    }
    if (target.endsWith('DescribeAlarms')) {
      if (fixture.cloudWatchMode !== 'ok') {
        send(503, { __type: 'ServiceUnavailableException', message: 'fixture alarm read failed' });
        return;
      }
      send(200, { MetricAlarms: [{
        AlarmName: 'IncidentTriageDemoAppStage5xx', AlarmArn: alarmArn, StateValue: fixture.alarmState,
        StateReason: `fixture alarm is ${fixture.alarmState}`, ActionsEnabled: fixture.alarmActionsEnabled,
        AlarmActions: fixture.alarmActions, StateUpdatedTimestamp: 1_763_460_000,
        StateTransitionedTimestamp: 1_763_460_000,
      }] });
      return;
    }
    if (target.endsWith('DescribeStacks')) { send(200, stackResponse()); return; }
    if (target.endsWith('GetItem')) {
      const key = keyOf(body);
      if (key === selectionKey && (fixture.selectionReadMode === 'unavailable' ||
          (fixture.selectionReadMode === 'unavailable-after-write' && fixture.selectionCommitted))) {
        send(503, { __type: 'ServiceUnavailableException', message: 'fixture selected-record read failed' });
        return;
      }
      if (key === selectionKey || String(key).startsWith('AGENT_PUBLICATION#')) {
        assert.equal(body.ConsistentRead, true, 'selected/publication records require strong DynamoDB readback');
        fixture.strongReads += 1;
      }
      const row = key === selectionKey && fixture.selectionCommitted && fixture.selectionReadbackOverride
        ? fixture.selectionReadbackOverride : rowFor(fixture, key);
      send(200, row ? { Item: marshall(project(row, body), { removeUndefinedValues: true }) } : {});
      return;
    }
    if (target.endsWith('TransactWriteItems')) {
      const accepted = transaction(fixture, body);
      fixture.writes.push({ type: 'transaction', accepted, body });
      const hasSelection = (body.TransactItems ?? []).some((item) => item.Put?.Item?.pk?.S === selectionKey);
      if (accepted && hasSelection) fixture.selectionCommitted = true;
      if (accepted && hasSelection && fixture.loseSelectionResponse) {
        fixture.loseSelectionResponse = false;
        send(503, { __type: 'ServiceUnavailableException', message: 'lost selection save response' });
        return;
      }
      send(accepted ? 200 : 400, accepted ? {} : dynamoError());
      return;
    }
    if (target.endsWith('PutItem')) {
      const row = unmarshall(body.Item ?? {});
      putRow(fixture, body.Item);
      fixture.writes.push({ type: 'put', row, rawItem: body.Item });
      send(200, {});
      return;
    }
    if (target.endsWith('Invoke')) {
      fixture.invocations.push({ target, body });
      send(202, {});
      return;
    }
    if (target.endsWith('GetFunctionConfiguration')) {
      send(200, {
        FunctionArn: adapterArn, FunctionName: 'IncidentTriageDemoAlarmAdapter', RevisionId: 'adapter-revision-faulty',
        // Phase 21's shared selector adapter is a different release from the
        // historical publisher adapter hash carried in both Phase 20 rows.
        CodeSha256: Buffer.from(selectorAdapterCodeSha256, 'hex').toString('base64'),
        LastUpdateStatus: 'Successful',
        Environment: { Variables: { AGENT_ALARM_ARN: alarmArn, AGENT_RUNTIME_ARN: runtimeArn, AGENT_SELECTION_TABLE: controllerTable } },
        TracingConfig: { Mode: 'Active' },
      });
      return;
    }
    if ((request.method === 'GET' || request.method === 'HEAD') && request.url?.startsWith('/')) {
      const path = decodeURIComponent(request.url.split('?')[0].replace(/^\//, ''));
      const [bucket, ...keyParts] = path.split('/');
      const key = `${bucket}/${keyParts.join('/')}`;
      const object = fixture.s3Objects.get(key);
      if (object) {
        fixture.s3Reads.push(key);
        response.writeHead(200, { 'content-type': 'application/json', ...(object.versionId ? { 'x-amz-version-id': object.versionId } : {}) });
        response.end(request.method === 'HEAD' ? undefined : object.body);
        return;
      }
    }
    if (request.method === 'GET' && request.url?.includes('/runtime-endpoints/')) {
      const match = request.url.match(/runtime-endpoints\/([^/?]+)/);
      const candidate = match?.[1] === 'repaired' ? 'repaired' : 'faulty';
      fixture.endpointReads.push(candidate);
      if (fixture.endpointMode === 'unavailable') { send(503, { message: 'fixture endpoint read failed' }, 'application/json'); return; }
      send(200, fixture.endpoints[candidate]);
      return;
    }
    if (request.method === 'GET' && request.url?.includes('/runtimes/')) {
      const version = request.url.match(/versions\/([^/?]+)/)?.[1];
      const candidate = version === '20' ? 'repaired' : 'faulty';
      fixture.runtimeReads.push(candidate);
      if (fixture.runtimeMode === 'unavailable') { send(503, { message: 'fixture Runtime read failed' }, 'application/json'); return; }
      send(200, fixture.runtimes[candidate]);
      return;
    }
    send(400, { __type: 'UnknownOperationException', message: `unexpected fixture operation ${target} ${request.method} ${request.url}` });
  });

  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = server.address().port;
  const endpointUrl = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    AWS_ENDPOINT_URL: endpointUrl,
    AWS_ENDPOINT_URL_DYNAMODB: endpointUrl,
    AWS_ENDPOINT_URL_SECRETS_MANAGER: endpointUrl,
    AWS_ENDPOINT_URL_CLOUDWATCH: endpointUrl,
    AWS_ENDPOINT_URL_CLOUDFORMATION: endpointUrl,
    AWS_ENDPOINT_URL_LAMBDA: endpointUrl,
    AWS_ENDPOINT_URL_BEDROCK_AGENTCORE_CONTROL: endpointUrl,
    AWS_REGION: region,
    AWS_ACCESS_KEY_ID: 'fixture', AWS_SECRET_ACCESS_KEY: 'fixture-only',
    AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'false', AWS_EC2_METADATA_DISABLED: 'true',
    CONTROLLER_RUN_TABLE: controllerTable,
    CONTROLLER_OPERATOR_SECRET_ARN: `arn:aws:secretsmanager:${region}:${account}:secret:fixture:operator`,
    CONTROLLER_WORKER_NAME: 'IncidentTriageDemoControllerWorkerFixture',
    CONTROLLER_AGENT_RUNTIME_ARN: runtimeArn,
    CONTROLLER_AGENT_ENDPOINT_NAME: 'faulty',
    CONTROLLER_AGENT_ENDPOINT_ARN: faultyEndpoint,
    CONTROLLER_AGENT_ALARM_ADAPTER_ARN: adapterArn,
    CONTROLLER_AGENT_ALARM_ARNS: JSON.stringify([alarmArn]),
    CONTROLLER_ALARM_NAME: 'IncidentTriageDemoAppStage5xx',
  });
  delete process.env.AWS_PROFILE;
  delete process.env.AWS_SESSION_TOKEN;

  const root = resolve(new URL('../..', import.meta.url).pathname);
  const backendPath = pathToFileURL(resolve(root, '.artifacts/controller/backend/index.mjs')).href;
  const workerPath = pathToFileURL(resolve(root, '.artifacts/controller/backend/worker.mjs')).href;
  const suffix = `phase21=${Date.now()}-${randomUUID()}`;
  const api = await import(`${backendPath}?${suffix}`);
  const worker = await import(`${workerPath}?${suffix}`);
  t.after(async () => {
    server.closeAllConnections();
    server.closeIdleConnections();
    await Promise.race([
      new Promise((resolveClose) => server.close(resolveClose)),
      new Promise((resolveClose) => setTimeout(resolveClose, 250)),
    ]);
  });
  return { api, worker, fixture, reset, selectionRecord };
}
