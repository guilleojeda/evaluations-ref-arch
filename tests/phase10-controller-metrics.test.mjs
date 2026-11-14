import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import {
  appFetch, awsEnvironment, call, fixture, getAction, getState, httpEvent,
  put, reset, resetProducerRunObservations, root, row, startAwsServer, submit,
} from './support/phase3-inventory-controller-harness.mjs';

function setInventoryCap(cap) {
  fixture.inventoryExpectedConcurrency = cap;
  fixture.inventoryConcurrency = cap;
}

async function createContext(t) {
  const server = await startAwsServer();
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
  });
  awsEnvironment(server.address().port);
  globalThis.fetch = appFetch;
  const backendPath = pathToFileURL(resolve(root, '.artifacts/controller/backend/index.mjs')).href;
  const workerPath = pathToFileURL(resolve(root, '.artifacts/controller/backend/worker.mjs')).href;
  const suffix = `phase10-metrics=${Date.now()}-${randomUUID()}`;
  const api = await import(`${backendPath}?${suffix}`);
  const worker = await import(`${workerPath}?${suffix}`);
  return { api, worker };
}

async function prepareReady(context) {
  reset();
  setInventoryCap(16);
  fixture.appMode = 'selected-variant';
  const readinessId = await submit(context.api, 'readiness', { confirmQuiet: true });
  await context.worker.handler({ actionId: readinessId });
  const action = await getAction(context.api, readinessId);
  assert.equal(action.status, 'completed', action.error);
  resetProducerRunObservations();
  return { readinessId, action, state: await getState(context.api) };
}

async function waitFor(description, predicate, timeoutMs = 20_000) {
  const deadline = performance.now() + timeoutMs;
  let lastValue;
  while (performance.now() < deadline) {
    lastValue = await predicate();
    if (lastValue) return lastValue;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  assert.fail(`Timed out waiting for ${description}; last observed value: ${String(lastValue)}`);
}

function metricsEvent(id, rawQueryString) {
  const event = httpEvent('GET', `/api/actions/${id}/metrics`);
  if (rawQueryString !== undefined) event.rawQueryString = rawQueryString;
  return event;
}

async function metricsResponse(api, id, rawQueryString) {
  const response = await api.handler(metricsEvent(id, rawQueryString));
  let body;
  try { body = JSON.parse(response.body); } catch { body = undefined; }
  return { statusCode: response.statusCode, body };
}

function dimensionsMap(dimensions) {
  if (Array.isArray(dimensions)) {
    return Object.fromEntries(dimensions.map((dimension) => [dimension.name ?? dimension.Name, dimension.value ?? dimension.Value]));
  }
  return dimensions ?? {};
}

function queryResource(query) {
  const dims = Object.fromEntries(query.dimensions.map(({ name, value }) => [name, value]));
  if (query.namespace === 'AWS/Lambda') {
    if (!dims.FunctionName) return 'Account';
    return dims.FunctionName === 'IncidentTriageDemoInventory' ? 'Inventory' : 'Checkout';
  }
  return query.namespace === 'AWS/ApiGateway' ? 'Gateway' : 'Account';
}

function metricKey(resource, name) {
  return `${resource}:${name}`;
}

function providerInstantMillis(value) {
  return typeof value === 'number' ? Math.round(value * 1_000) : Date.parse(value);
}

function roundedMinute(value, roundUp = false) {
  const milliseconds = Date.parse(value);
  const minute = 60_000;
  return new Date(roundUp ? Math.ceil(milliseconds / minute) * minute : Math.floor(milliseconds / minute) * minute).toISOString();
}

test('Phase 10 native metric observations use fixed authenticated CloudWatch queries and honest sparse results', { timeout: 90_000 }, async (t) => {
  const context = await createContext(t);

  await t.test('the CloudWatch loopback fixture returns the installed SDK JSON response shape', async () => {
    reset();
    const client = new CloudWatchClient({
      region: 'us-east-1',
      endpoint: process.env.AWS_ENDPOINT_URL_CLOUDWATCH,
      credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture-only' },
      maxAttempts: 1,
    });
    try {
      const startTime = new Date(Date.now() - 120_000);
      const endTime = new Date();
      const result = await client.send(new GetMetricDataCommand({
        StartTime: startTime,
        EndTime: endTime,
        MetricDataQueries: [{
          Id: 'inventory_throttles',
          MetricStat: {
            Metric: { Namespace: 'AWS/Lambda', MetricName: 'Throttles',
              Dimensions: [{ Name: 'FunctionName', Value: 'IncidentTriageDemoInventory' }] },
            Period: 60,
            Stat: 'Sum',
          },
          ReturnData: true,
        }],
      }));
      assert.equal(fixture.cloudWatchRequests.length, 1);
      assert.equal(fixture.cloudWatchRequests[0]?.protocol, 'json');
      assert.equal(providerInstantMillis(fixture.cloudWatchRequests[0].startTime), startTime.getTime());
      assert.equal(providerInstantMillis(fixture.cloudWatchRequests[0].endTime), endTime.getTime());
      assert.deepEqual(fixture.cloudWatchRequests[0].queries, [{
        id: 'inventory_throttles', namespace: 'AWS/Lambda', metricName: 'Throttles',
        dimensions: [{ name: 'FunctionName', value: 'IncidentTriageDemoInventory' }],
        periodSeconds: 60, statistic: 'Sum',
      }]);
      assert.equal(result.MetricDataResults?.[0]?.Id, 'inventory_throttles');
      assert.equal(result.MetricDataResults?.[0]?.StatusCode, 'Complete');
      assert.deepEqual(result.MetricDataResults?.[0]?.Values, [1]);
      assert.equal(result.MetricDataResults?.[0]?.Timestamps?.length, 1);
      assert.equal(result.MetricDataResults[0].Timestamps[0].getTime(), startTime.getTime());
      assert.deepEqual(fixture.unhandled, []);
    } finally {
      client.destroy();
    }
  });

  await t.test('authentication, action lookup, query overrides, and a queued action do not read CloudWatch', async () => {
    await prepareReady(context);
    const unknownId = randomUUID();
    const unauthorized = metricsEvent(unknownId);
    unauthorized.headers.authorization = 'Bearer wrong-operator';
    assert.equal((await context.api.handler(unauthorized)).statusCode, 401);
    const unknown = await metricsResponse(context.api, unknownId);
    assert.equal(unknown.statusCode, 404);
    assert.equal(fixture.cloudWatchRequests.length, 0);

    const queuedId = await submit(context.api, 'traffic');
    const pending = await metricsResponse(context.api, queuedId);
    assert.equal(pending.statusCode, 200);
    assert.equal(pending.body?.actionId, queuedId);
    assert.equal(pending.body?.status, 'pending');
    assert.equal(pending.body?.window, null, 'queued actions have no invented producer window');
    assert.equal(pending.body?.periodSeconds, 60);
    assert.deepEqual(pending.body?.metrics, []);
    assert.ok(Number.isFinite(Date.parse(pending.body?.observedAt)));
    assert.equal(fixture.cloudWatchRequests.length, 0, 'the pending route makes no provider call');

    const override = await metricsResponse(context.api, queuedId,
      'start=2026-01-01T00%3A00%3A00.000Z&end=2026-01-01T01%3A00%3A00.000Z&resource=arn%3Aaws%3Alambda%3Aus-east-1%3A123456789012%3Afunction%3Aother');
    assert.equal(override.statusCode, 400, 'caller-selected resource and time-window inputs are rejected');
    assert.equal(fixture.cloudWatchRequests.length, 0, 'rejected query overrides do not reach CloudWatch');
    assert.equal((await getAction(context.api, queuedId)).status, 'queued');
  });

  await t.test('a stopped finite producer yields one fixed query set, the saved bounded window, and sparse series', async () => {
    const ready = await prepareReady(context);
    fixture.catalogResponseMode = 'hold';
    const surgeId = randomUUID();
    await call(context.api, 'PUT', `/api/actions/${surgeId}`, { kind: 'traffic', profile: 'inventory_surge' }, 202);
    const execution = context.worker.handler({ actionId: surgeId });
    try {
      await waitFor('surge worker start and first actual catalog request', async () => {
        const action = await getAction(context.api, surgeId);
        return action.trafficWindow?.startedAt && fixture.catalogFetches.length > 0;
      });
      const stopId = randomUUID();
      await call(context.api, 'PUT', `/api/actions/${stopId}`, { kind: 'stop', targetActionId: surgeId }, 202);
      await waitFor('the producer-stopped observation', async () =>
        (await getAction(context.api, surgeId)).trafficWindow?.producerStoppedAt);
      fixture.cloudWatchMode = 'sparse';
      fixture.cloudWatchNextToken = undefined;
      fixture.cloudWatchResultOrder = 'reverse';
      for (const release of fixture.heldCatalogRequests) release();
      fixture.heldCatalogRequests.clear();
      await execution;

      const stored = row(`ACTION#${surgeId}`);
      const actionData = structuredClone(stored.data);
      let minuteBase = Math.floor(Date.now() / 60_000) * 60_000 - 60_000;
      if (minuteBase + 60_100 > Date.now() - 1_000) minuteBase -= 60_000;
      const startedAt = new Date(minuteBase + 44_000).toISOString();
      const producerStoppedAt = new Date(minuteBase + 59_500).toISOString();
      const settledAt = new Date(minuteBase + 60_100).toISOString();
      actionData.trafficWindow = {
        startedAt,
        scheduledEndAt: new Date(minuteBase + 59_000).toISOString(),
        stopObservedAt: new Date(minuteBase + 59_400).toISOString(),
        producerStoppedAt,
        settledAt,
        stopReason: 'requested',
      };
      actionData.finishedAt = settledAt;
      put({ ...stored, data: actionData });

      const action = await getAction(context.api, surgeId);
      const response = await metricsResponse(context.api, surgeId);
      assert.equal(response.statusCode, 200, response.body?.message);
      assert.equal(response.body?.actionId, surgeId);
      assert.equal(response.body?.status, 'available', 'useful native samples stay available when some series are empty');
      assert.ok(Number.isFinite(Date.parse(response.body?.observedAt)));
      assert.equal(response.body?.periodSeconds, 60);
      assert.deepEqual(response.body?.window, {
        start: roundedMinute(action.trafficWindow.startedAt),
        end: roundedMinute(action.trafficWindow.settledAt, true),
      }, 'the query covers the producer through late completion and rounds the saved settlement to UTC minutes');
      assert.ok(Date.parse(response.body.window.end) > Date.parse(response.body.window.start));
      assert.ok(Date.parse(response.body.window.end) - Date.parse(response.body.window.start) <= 180_000,
        'minute rounding remains bounded to the action and drain window');
      assert.equal(fixture.cloudWatchRequests.length, 1, 'one request returns the fixed twelve-query observation');
      const request = fixture.cloudWatchRequests[0];
      assert.equal(request.queries.length, 12);
      assert.equal(providerInstantMillis(request.startTime), Date.parse(response.body.window.start));
      assert.equal(providerInstantMillis(request.endTime), Date.parse(response.body.window.end));

      const expectedQueries = [
        ...['IncidentTriageDemoInventory', 'IncidentTriageDemoCheckout'].flatMap((functionName) =>
          ['Invocations', 'Errors', 'Throttles', 'ConcurrentExecutions'].map((metricName) => ({
            resource: functionName.endsWith('Inventory') ? 'Inventory' : 'Checkout',
            metricName,
            namespace: 'AWS/Lambda',
            dimensions: { FunctionName: functionName },
            statistic: metricName === 'ConcurrentExecutions' ? 'Maximum' : 'Sum',
          }))),
        ...['Count', '4xx', '5xx'].map((metricName) => ({
          resource: 'Gateway', metricName, namespace: 'AWS/ApiGateway',
          dimensions: { ApiId: 'fixtureapi', Stage: '$default' }, statistic: 'Sum',
        })),
        { resource: 'Account', metricName: 'ConcurrentExecutions', namespace: 'AWS/Lambda', dimensions: {}, statistic: 'Maximum' },
      ];
      assert.deepEqual(request.queries.map((query) => ({
        resource: queryResource(query), metricName: query.metricName, namespace: query.namespace,
        dimensions: Object.fromEntries(query.dimensions.map(({ name, value }) => [name, value])),
        statistic: query.statistic,
      })).sort((left, right) => metricKey(left.resource, left.metricName).localeCompare(metricKey(right.resource, right.metricName))),
      expectedQueries.map(({ resource, metricName, namespace, dimensions, statistic }) => ({ resource, metricName, namespace, dimensions, statistic }))
        .sort((left, right) => metricKey(left.resource, left.metricName).localeCompare(metricKey(right.resource, right.metricName))),
      'the controller selects only fixed app resources, dimensions, statistics, and metrics');
      assert.ok(request.queries.every(({ periodSeconds }) => periodSeconds === 60));

      const byMetric = new Map(response.body.metrics.map((metric) => [metricKey(metric.resource, metric.name), metric]));
      assert.equal(byMetric.size, 12);
      for (const expected of expectedQueries) {
        const metric = byMetric.get(metricKey(expected.resource, expected.metricName));
        assert.ok(metric, `response includes ${expected.resource} ${expected.metricName}`);
        assert.equal(metric.namespace, expected.namespace);
        assert.deepEqual(dimensionsMap(metric.dimensions), expected.dimensions);
        assert.equal(metric.statistic, expected.statistic);
        assert.equal(metric.periodSeconds, 60);
        assert.equal(metric.statusCode, 'Complete');
        const queryIndex = request.queries.findIndex((query) =>
          queryResource(query) === expected.resource && query.metricName === expected.metricName);
        const empty = /^(Errors|Throttles|4xx|5xx)$/.test(expected.metricName);
        assert.deepEqual(metric.values, empty ? [] : [queryIndex + 1],
          'CloudWatch results remain associated with their requested resource and metric');
        assert.equal(metric.timestamps.length, empty ? 0 : 1);
      }
      assert.deepEqual(byMetric.get('Inventory:Throttles').values, [], 'an empty throttle series is never converted to zero');
      assert.deepEqual(fixture.unhandled, []);
      assert.ok(ready.state.baseline.productVersion);

      fixture.cloudWatchMode = 'empty';
      const empty = await metricsResponse(context.api, surgeId);
      assert.equal(empty.statusCode, 200);
      assert.equal(empty.body?.status, 'pending', 'no metric data at all is pending rather than zero');
      assert.equal(empty.body?.metrics.length, 12);
      assert.ok(empty.body.metrics.every(({ values, timestamps }) => values.length === 0 && timestamps.length === 0));
      assert.equal(fixture.cloudWatchRequests.length, 2);

      fixture.cloudWatchMode = 'partial';
      fixture.cloudWatchNextToken = 'fixture-next-page';
      const partial = await metricsResponse(context.api, surgeId);
      assert.equal(partial.statusCode, 200);
      assert.equal(partial.body?.status, 'partial', 'PartialData and a next token are disclosed as partial');
      assert.equal(fixture.cloudWatchRequests.length, 3,
        'each fixed provider read is bounded to one GetMetricData call and does not paginate');
      assert.ok(partial.body.metrics.some(({ statusCode }) => statusCode === 'PartialData'));

      fixture.cloudWatchMode = 'fail';
      fixture.cloudWatchNextToken = undefined;
      const failed = await metricsResponse(context.api, surgeId);
      assert.equal(failed.statusCode, 503);
      assert.equal(failed.body?.code, 'METRICS_UNAVAILABLE');
      assert.ok(typeof failed.body?.message === 'string' && failed.body.message.length > 0 && failed.body.message.length <= 200);
      assert.doesNotMatch(failed.body.message, /InternalServiceError|fixture-cloudwatch-error|stack|\.ts|Error:/i,
        'provider details and stack traces are not returned to callers');
      assert.equal(fixture.cloudWatchRequests.length, 4, 'provider failure is not retried');
      assert.deepEqual(fixture.unhandled, []);
    } finally {
      fixture.catalogResponseMode = 'immediate';
      for (const release of fixture.heldCatalogRequests) release();
      fixture.heldCatalogRequests.clear();
      await execution;
    }
  });

});
