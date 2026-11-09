import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { marshall } from '@aws-sdk/util-dynamodb';
import { after, test } from 'node:test';
import { handler } from '../.artifacts/controller/backend/index.mjs';

const account = '027224425948';
const region = 'us-east-1';
const alarmArn = `arn:aws:cloudwatch:${region}:${account}:alarm:IncidentTriageDemoAppStage5xx`;
const retainedAlarmArn = `arn:aws:cloudwatch:${region}:${account}:alarm:IncidentTriageDemoAppStage5xx-previous`;
const allowedAlarmArns = [alarmArn, retainedAlarmArn];
const tableName = 'IncidentTriageDemoAgentRunFixture';
const operatorBearer = 'phase4-controller-fixture-operator';
const fixture = {
  rows: [],
  calls: [],
  invocations: [],
  unexpected: [],
  queryMode: 'ok',
  cloudWatchMode: 'ok',
};

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if ((request.headers['content-type'] ?? '').includes('application/x-amz-json')) {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function stringValues(value) {
  if (!value || typeof value !== 'object') return [];
  if (typeof value.S === 'string') return [value.S];
  return Object.values(value).flatMap(stringValues);
}

function keyValue(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return value.S ?? value.N;
  return undefined;
}

function rowForExact(body) {
  const key = body.Key ?? {};
  const partition = keyValue(key.pk ?? key.alarmArn);
  const transitionAt = keyValue(key.sk ?? key.transitionAt);
  if (!allowedAlarmArns.includes(partition)) return undefined;
  if (!transitionAt) return undefined;
  return fixture.rows.find((row) => row.alarmArn === partition && row.transitionAt === transitionAt);
}

function project(row, body) {
  const projection = body.ProjectionExpression ?? body.AttributesToGet?.join(',');
  if (!projection) return row;
  const names = body.ExpressionAttributeNames ?? {};
  const fields = projection.split(',').map((name) => name.trim()).filter(Boolean)
    .map((name) => names[name] ?? name).map((name) => name.split('.')[0]);
  return Object.fromEntries([...new Set(fields)].filter((name) => Object.hasOwn(row, name))
    .map((name) => [name, row[name]]));
}

function queryRows(body) {
  const values = stringValues(body.ExpressionAttributeValues);
  const partition = values.find((value) => allowedAlarmArns.includes(value));
  assert.ok(partition, 'the public route must query only a configured current or retained alarm partition');
  assert.equal(body.ConsistentRead, true, 'base-table investigation discovery must use a strong read');
  const transitionAt = values.find((value) => value !== partition && Number.isFinite(Date.parse(value)));
  const candidates = fixture.rows.filter((row) => row.alarmArn === partition &&
    (!transitionAt || row.transitionAt === transitionAt));
  candidates.sort((left, right) => left.transitionAt.localeCompare(right.transitionAt));
  if (body.ScanIndexForward === false) candidates.reverse();
  return candidates.slice(0, body.Limit ?? candidates.length).map((row) => project(row, body));
}

function cloudWatchResponse(action) {
  if (action === 'DescribeAlarms') {
    return { MetricAlarms: [{ AlarmName: 'IncidentTriageDemoAppStage5xx', AlarmArn: alarmArn,
      StateValue: 'OK', StateReason: 'fixture state is currently healthy',
      StateUpdatedTimestamp: Date.parse('2026-11-09T12:00:00.000Z') / 1000,
      StateTransitionedTimestamp: Date.parse('2026-11-09T12:00:00.000Z') / 1000,
      ActionsEnabled: true }] };
  }
  return { AlarmHistoryItems: [] };
}

const server = http.createServer(async (request, response) => {
  try {
    const body = await requestBody(request);
    const target = request.headers['x-amz-target'] ?? '';
    const action = body.Action ?? '';
    fixture.calls.push({ target, action, body, method: request.method, url: request.url });

    if (target.endsWith('GetSecretValue')) {
      response.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' });
      response.end(JSON.stringify({ SecretString: createHash('sha256').update(operatorBearer).digest('hex') }));
      return;
    }
    if (target.endsWith('DescribeAlarms') || action === 'DescribeAlarms') {
      if (fixture.cloudWatchMode === 'unavailable') {
        response.writeHead(500, { 'content-type': 'application/x-amz-json-1.1', 'x-amzn-errortype': 'ServiceUnavailableException' });
        response.end(JSON.stringify({ __type: 'ServiceUnavailableException', message: 'fixture read failure' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' });
      response.end(JSON.stringify(cloudWatchResponse('DescribeAlarms')));
      return;
    }
    if (target.endsWith('Query') || target.endsWith('GetItem')) {
      assert.equal(body.TableName, tableName, 'discovery must read the separate AgentCore run table');
      if (fixture.queryMode === 'unavailable') {
        response.writeHead(500, { 'content-type': 'application/x-amz-json-1.0', 'x-amzn-errortype': 'InternalServerErrorException' });
        response.end(JSON.stringify({ __type: 'com.amazonaws.dynamodbv20120810#InternalServerErrorException', message: 'fixture read failure' }));
        return;
      }
      if (target.endsWith('GetItem')) {
        const row = rowForExact(body);
        response.writeHead(200, { 'content-type': 'application/x-amz-json-1.0' });
      response.end(JSON.stringify(row ? { Item: marshall(project(row, body), { removeUndefinedValues: true }) } : {}));
        return;
      }
      const rows = queryRows(body);
      response.writeHead(200, { 'content-type': 'application/x-amz-json-1.0' });
      response.end(JSON.stringify({ Items: rows.map((row) => marshall(row, { removeUndefinedValues: true })) }));
      return;
    }
    if (/Invoke|PutItem|UpdateItem|DeleteItem|TransactWriteItems|Scan/.test(target)) {
      fixture.invocations.push({ target, body });
    }
    fixture.unexpected.push(`${target} ${request.method} ${request.url}`);
    response.writeHead(400, { 'content-type': 'application/x-amz-json-1.0', 'x-amzn-errortype': 'UnknownOperationException' });
    response.end(JSON.stringify({ __type: 'UnknownOperationException', message: 'unexpected fixture operation' }));
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: error instanceof Error ? error.message : 'fixture failure' }));
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const endpoint = `http://127.0.0.1:${server.address().port}`;
Object.assign(process.env, {
  AWS_ENDPOINT_URL: endpoint,
  AWS_ENDPOINT_URL_DYNAMODB: endpoint,
  AWS_ENDPOINT_URL_SECRETS_MANAGER: endpoint,
  AWS_ENDPOINT_URL_CLOUDWATCH: endpoint,
  AWS_REGION: region,
  AWS_ACCESS_KEY_ID: 'fixture',
  AWS_SECRET_ACCESS_KEY: 'fixture-only',
  AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'false',
  AWS_EC2_METADATA_DISABLED: 'true',
  CONTROLLER_RUN_TABLE: 'ControllerRunFixture',
  CONTROLLER_AGENT_RUN_TABLE: tableName,
  CONTROLLER_AGENT_ALARM_ARNS: JSON.stringify(allowedAlarmArns),
  CONTROLLER_OPERATOR_SECRET_ARN: `arn:aws:secretsmanager:${region}:${account}:secret:fixture:operator`,
  CONTROLLER_ALARM_NAME: 'IncidentTriageDemoAppStage5xx',
});
delete process.env.AWS_PROFILE;
delete process.env.AWS_SESSION_TOKEN;

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function run({ alarmArn: sourceAlarmArn = alarmArn, transitionAt, status = 'complete', assessment = 'unknown', ...overrides } = {}) {
  const value = {
    pk: sourceAlarmArn,
    sk: transitionAt,
    alarmArn: sourceAlarmArn,
    transitionAt,
    runId: randomUUID(),
    runtimeSessionId: `session-${randomUUID()}`,
    candidateId: 'faulty-v1',
    sourceRevision: 'a'.repeat(40),
    promptSha256: 'b'.repeat(64),
    modelId: 'us.anthropic.claude-sonnet-4-6',
    runtimeArn: `arn:aws:bedrock-agentcore:${region}:${account}:runtime/IncidentTriageAgent-1234567890`,
    runtimeVersion: '1',
    endpointName: 'faulty',
    status,
    startedAt: transitionAt,
    deadlineAt: new Date(Date.parse(transitionAt) + 240_000).toISOString(),
    finishedAt: new Date(Date.parse(transitionAt) + 90_000).toISOString(),
    traceRef: { region, logGroup: '/aws/bedrock-agentcore/runtimes/fixture', traceId: 'trace-123' },
    captureRef: { bucket: 'incident-triage-demo-evidence-027224425948-us-east-1',
      key: 'agent-source/run-123/manifest.json', manifestKey: 'agent-source/run-123/manifest.json',
      sourceCount: 4, coveredFrom: transitionAt, coveredThrough: transitionAt },
    report: {
      assessment,
      summary: 'The evidence is insufficient to establish whether the inventory failure has recovered.',
      recommendation: { action: 'Other', explanation: 'The available observation is incomplete.' },
      evidence: [{ source: 'CloudWatch Logs', resource: '/aws/lambda/IncidentTriageDemoInventory',
        windowStart: transitionAt, windowEnd: transitionAt, observedAt: transitionAt, finding: 'AccessDeniedException observed.' }],
      uncertainties: ['Fresh post-recovery request evidence is unavailable.'],
      alternatives: [],
    },
    ...overrides,
  };
  return value;
}

function reset({ rows = [], queryMode = 'ok', cloudWatchMode = 'ok' } = {}) {
  fixture.rows = rows;
  fixture.calls.length = 0;
  fixture.invocations.length = 0;
  fixture.unexpected.length = 0;
  fixture.queryMode = queryMode;
  fixture.cloudWatchMode = cloudWatchMode;
}

function event(method, path, authenticated = true) {
  return {
    rawPath: path.split('?')[0],
    rawQueryString: path.includes('?') ? path.slice(path.indexOf('?') + 1) : '',
    requestContext: { http: { method, path: path.split('?')[0] } },
    headers: authenticated ? { authorization: `Bearer ${operatorBearer}` } : {},
  };
}

async function call(method, path, authenticated = true) {
  return handler(event(method, path, authenticated));
}

function responseBody(response) {
  return JSON.parse(response.body);
}

function allStringValues(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(allStringValues);
}

function assertNoInvocationOrWrites() {
  assert.deepEqual(fixture.invocations, [], 'public discovery must never invoke the agent or write run state');
  assert.deepEqual(fixture.unexpected, [], 'the route must use only its expected read APIs');
  assert.ok(!fixture.calls.some(({ target }) => /(?:PutItem|UpdateItem|DeleteItem|TransactWriteItems|InvokeAgentRuntime|Lambda_2015-03-31.Invoke)/.test(target)),
    'the discovery boundary is read-only and has no agent trigger');
}

test('investigation discovery is authenticated before any AWS read', async () => {
  reset({ rows: [run({ transitionAt: '2026-11-09T12:00:00.000Z' })] });
  const response = await call('GET', '/api/investigations', false);
  assert.equal(response.statusCode, 401);
  assert.equal(fixture.calls.length, 0, 'invalid credentials must be rejected before Secrets Manager or run-table reads');
  assertNoInvocationOrWrites();
});

test('exact and recent discovery retain the originating ALARM report after the native alarm returns to OK', async (t) => {
  const oldest = run({ transitionAt: '2026-11-09T11:40:00.000Z', assessment: 'recovered' });
  const latest = run({ transitionAt: '2026-11-09T12:05:00.000Z', assessment: 'unknown' });
  reset({ rows: [oldest, latest] });

  await t.test('the current native alarm can be OK while exact ALARM-run discovery returns the retained report', async () => {
    const alarm = await call('GET', '/api/alarm');
    assert.equal(alarm.statusCode, 200, `${alarm.body} · fixture calls ${JSON.stringify(fixture.calls)}`);
    assert.equal(responseBody(alarm).alarm?.state, 'OK');

    fixture.calls.length = 0;
    fixture.cloudWatchMode = 'unavailable';
    const result = await call('GET', `/api/investigations?transitionAt=${encodeURIComponent(latest.transitionAt)}`);
    assert.equal(result.statusCode, 200, result.body);
    const body = responseBody(result);
    assert.ok(Date.now() - Date.parse(body.observedAt) < 10_000, 'the API must timestamp its fresh table observation');
    assert.equal(body.runs?.length, 1, 'exact discovery returns only the originating transition');
    const [found] = body.runs;
    assert.equal(found.alarmArn, alarmArn);
    assert.equal(found.transitionAt, latest.transitionAt);
    assert.equal(found.runId, latest.runId);
    assert.equal(found.runtimeSessionId, latest.runtimeSessionId);
    assert.equal(found.candidateId, latest.candidateId);
    assert.equal(found.sourceRevision, latest.sourceRevision);
    assert.equal(found.promptSha256, latest.promptSha256);
    assert.equal(found.modelId, latest.modelId);
    assert.deepEqual(found.report, latest.report);
    assert.deepEqual(found.traceRef, latest.traceRef);
    assert.deepEqual(found.captureRef, latest.captureRef);
    assert.ok(!fixture.calls.some(({ target, action }) => target.endsWith('DescribeAlarms') || action === 'DescribeAlarms'),
      'run discovery must not depend on the current CloudWatch alarm read');
    const exactRead = fixture.calls.find(({ target }) => target.endsWith('GetItem') || target.endsWith('Query'));
    assert.ok(exactRead, 'the public exact route must read the durable run table');
    assert.equal(exactRead.body.TableName, tableName);
    if (exactRead.target.endsWith('GetItem')) {
      const keyValues = allStringValues(exactRead.body.Key);
      assert.ok(keyValues.includes(alarmArn) && keyValues.includes(latest.transitionAt),
        'exact lookup key must contain both configured alarm ARN and originating transition time');
      assert.equal(exactRead.body.ConsistentRead, true);
    } else {
      const values = allStringValues(exactRead.body.ExpressionAttributeValues);
      assert.ok(values.includes(alarmArn) && values.includes(latest.transitionAt),
        'exact query must key on both configured alarm ARN and originating transition time');
      assert.equal(exactRead.body.ConsistentRead, true);
    }
  });

  await t.test('recent discovery orders distinct ALARM transitions newest first', async () => {
    reset({ rows: [latest, oldest] });
    const response = await call('GET', '/api/investigations');
    assert.equal(response.statusCode, 200, response.body);
    const body = responseBody(response);
    assert.deepEqual(body.runs?.map(({ transitionAt }) => transitionAt), [latest.transitionAt, oldest.transitionAt]);
    const query = fixture.calls.find(({ target }) => target.endsWith('Query'));
    assert.ok(query, 'recent discovery must query the base run table');
    assert.equal(query.body.TableName, tableName);
    assert.equal(query.body.ConsistentRead, true);
    assert.ok(allStringValues(query.body.ExpressionAttributeValues).some((value) => allowedAlarmArns.includes(value)),
      'recent discovery must stay within configured alarm ARN partitions');
    assertNoInvocationOrWrites();
  });

  await t.test('an explicitly configured retained alarm ARN can be queried after the current release changes', async () => {
    const retained = run({ alarmArn: retainedAlarmArn, transitionAt: '2026-11-08T16:00:00.000Z' });
    reset({ rows: [retained], cloudWatchMode: 'unavailable' });
    const response = await call('GET', `/api/investigations?alarmArn=${encodeURIComponent(retainedAlarmArn)}&transitionAt=${encodeURIComponent(retained.transitionAt)}`);
    assert.equal(response.statusCode, 200, response.body);
    const [found] = responseBody(response).runs;
    assert.equal(found.alarmArn, retainedAlarmArn);
    assert.equal(found.transitionAt, retained.transitionAt);
    assert.ok(!fixture.calls.some(({ target, action }) => target.endsWith('DescribeAlarms') || action === 'DescribeAlarms'));
    assertNoInvocationOrWrites();
  });

  await t.test('an unconfigured alarm ARN is rejected before the run table is queried', async () => {
    reset({ rows: [latest] });
    const valid = await call('GET', '/api/investigations');
    assert.equal(valid.statusCode, 200, valid.body);
    fixture.calls.length = 0;
    const other = `arn:aws:cloudwatch:${region}:${account}:alarm:UnconfiguredAlarm`;
    const response = await call('GET', `/api/investigations?alarmArn=${encodeURIComponent(other)}&transitionAt=${encodeURIComponent(latest.transitionAt)}`);
    assert.ok([400, 403, 404].includes(response.statusCode), response.body);
    assert.ok(!fixture.calls.some(({ target }) => target.endsWith('Query') || target.endsWith('GetItem')),
      'untrusted alarm identities must be rejected before querying durable runs');
    assertNoInvocationOrWrites();
  });
});

test('a newer ALARM never inherits an older report; no row and unavailable reads stay distinct', async (t) => {
  const previous = run({ transitionAt: '2026-11-09T12:00:00.000Z' });
  const nextTransition = '2026-11-09T12:05:00.000Z';

  await t.test('exact lookup does not attach an older run to the newer event', async () => {
    reset({ rows: [previous] });
    const response = await call('GET', `/api/investigations?transitionAt=${encodeURIComponent(nextTransition)}`);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(responseBody(response).runs, [], 'the new event has no matching run; its predecessor remains separate');
    assertNoInvocationOrWrites();
  });

  await t.test('a genuinely empty recent history is a successful empty result', async () => {
    reset();
    const response = await call('GET', '/api/investigations');
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(responseBody(response).runs, []);
    assertNoInvocationOrWrites();
  });

  await t.test('a failed run-table read is unavailable, not an empty result', async () => {
    reset({ queryMode: 'unavailable' });
    const response = await call('GET', '/api/investigations');
    assert.ok(response.statusCode >= 500, response.body);
    assert.notEqual(response.statusCode, 200, 'an unavailable source cannot be represented as no matching run');
    assert.equal(responseBody(response).runs, undefined, 'an unavailable read must not be returned as a successful empty history');
    assertNoInvocationOrWrites();
  });
});

test('running, overdue, failed, and completed-unknown records keep separate meanings', async (t) => {
  const now = Date.now();
  const running = run({ transitionAt: new Date(now - 10_000).toISOString(), status: 'running',
    deadlineAt: new Date(now + 60_000).toISOString(), finishedAt: undefined, report: undefined, assessment: undefined });
  const overdue = run({ transitionAt: new Date(now - 300_000).toISOString(), status: 'running',
    deadlineAt: new Date(now - 60_000).toISOString(), finishedAt: undefined, report: undefined, assessment: undefined });
  const failed = run({ transitionAt: new Date(now - 400_000).toISOString(), status: 'failed',
    finishedAt: new Date(now - 350_000).toISOString(), report: undefined, assessment: undefined,
    failure: { code: 'INVESTIGATION_INTERRUPTED', message: 'The Runtime ended before a terminal report was stored.' } });
  const completeUnknown = run({ transitionAt: new Date(now - 500_000).toISOString(), status: 'complete', assessment: 'unknown' });

  await t.test('a live claim remains running without an invented report', async () => {
    reset({ rows: [running] });
    const response = await call('GET', `/api/investigations?transitionAt=${encodeURIComponent(running.transitionAt)}`);
    assert.equal(response.statusCode, 200, response.body);
    const [found] = responseBody(response).runs;
    assert.equal(found.status, 'running');
    assert.ok(Date.parse(found.deadlineAt) > Date.now());
    assert.equal(found.report, undefined);
    assert.equal(found.failure, undefined);
  });

  await t.test('a claim past its deadline is still incomplete and is not changed to failed', async () => {
    reset({ rows: [overdue] });
    const response = await call('GET', `/api/investigations?transitionAt=${encodeURIComponent(overdue.transitionAt)}`);
    assert.equal(response.statusCode, 200, response.body);
    const [found] = responseBody(response).runs;
    assert.equal(found.status, 'running', 'overdue is a presentation of an expired claim, not a fabricated terminal status');
    assert.ok(Date.parse(found.deadlineAt) < Date.now());
    assert.equal(found.report, undefined);
    assert.equal(found.failure, undefined);
  });

  await t.test('known execution failure stays failed and carries its failure record', async () => {
    reset({ rows: [failed] });
    const response = await call('GET', `/api/investigations?transitionAt=${encodeURIComponent(failed.transitionAt)}`);
    assert.equal(response.statusCode, 200, response.body);
    const [found] = responseBody(response).runs;
    assert.equal(found.status, 'failed');
    assert.equal(found.failure?.code, failed.failure.code);
  });

  await t.test('completed unknown assessment retains its report and is not an execution failure', async () => {
    reset({ rows: [completeUnknown] });
    const response = await call('GET', `/api/investigations?transitionAt=${encodeURIComponent(completeUnknown.transitionAt)}`);
    assert.equal(response.statusCode, 200, response.body);
    const [found] = responseBody(response).runs;
    assert.equal(found.status, 'complete');
    assert.equal(found.report?.assessment, 'unknown');
    assert.equal(found.failure, undefined);
    assert.deepEqual(found.traceRef, completeUnknown.traceRef);
  });

  assertNoInvocationOrWrites();
});

test('the discovery route has no manual trigger or action-execution method', async () => {
  reset();
  const discovery = await call('GET', '/api/investigations');
  assert.equal(discovery.statusCode, 200, discovery.body);
  fixture.calls.length = 0;
  const response = await call('POST', '/api/investigations');
  assert.ok([404, 405].includes(response.statusCode), response.body);
  assertNoInvocationOrWrites();
});

