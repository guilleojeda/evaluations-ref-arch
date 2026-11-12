import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  appApi, appBearer, appFetch, appRevision, awsEnvironment, call, deniedVersion, fixture, getAction, getState,
  httpEvent, newerRevision, ordersTable, releaseHeld, reset, root, row, startAwsServer, submit, table, withElapsed,
} from './support/phase3-inventory-controller-harness.mjs';

const RESET_CONFIRMATION = Object.freeze({
  confirmQuiet: true,
  confirmReset: true,
  confirmCheckoutClosed: true,
});

function resetBody(overrides = {}) {
  return { kind: 'reset', ...RESET_CONFIRMATION, ...overrides };
}

async function runAction(api, worker, kind, extra = {}) {
  const id = await submit(api, kind, extra);
  await worker.handler({ actionId: id });
  return { id, action: await getAction(api, id), state: await getState(api) };
}

async function acceptReset(api, id = randomUUID()) {
  const response = await call(api, 'PUT', `/api/actions/${id}`, resetBody(), 202);
  assert.equal(response.action?.id, id);
  assert.equal(response.action?.kind, 'reset');
  return id;
}

async function runReset({ api, worker, id = randomUUID() }) {
  await acceptReset(api, id);
  await worker.handler({ actionId: id });
  return { id, action: await getAction(api, id), state: await getState(api) };
}

async function waitFor(description, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

async function addPriorOrder(checkoutId = randomUUID(), productVersion = fixture.appProductVersion) {
  const input = { checkoutId, sku: 'demo-widget', quantity: 1, productVersion };
  const response = await appFetch(`${appApi}/api/checkout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${appBearer}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.order?.checkoutId, checkoutId);
  return input;
}

async function appStatus(checkoutId) {
  return appFetch(`${appApi}/api/orders/${checkoutId}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${appBearer}` },
  });
}

async function appProduct() {
  const response = await appFetch(`${appApi}/api/products`, {
    method: 'GET',
    headers: { authorization: `Bearer ${appBearer}` },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.products?.length, 1);
  return body.products[0];
}

async function readyCurrentRelease(api, worker) {
  fixture.appMode = 'selected-variant';
  const readiness = await runAction(api, worker, 'readiness', { confirmQuiet: true });
  assert.equal(readiness.action.status, 'completed', readiness.action.error);
  assert.ok(readiness.state.baseline?.deploymentIdentity?.stackId);
  return readiness;
}

function unresolvedAttempt(checkoutId, productVersion) {
  return { checkoutId, sku: 'demo-widget', quantity: 1, productVersion,
    startedAt: new Date().toISOString(), status: 'unknown' };
}

async function getRun(api, runId) {
  return (await call(api, 'GET', `/api/runs/${encodeURIComponent(runId)}`, undefined, 200)).run;
}

function requestCount(requests, method, path) {
  return requests.filter((request) => request.method === method && request.path === path).length;
}

test('Reset creates a verified new session while preserving old operational history', { timeout: 240_000 }, async (t) => {
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
  const api = await import(`${backendPath}?phase8-reset=${Date.now()}`);
  const worker = await import(`${workerPath}?phase8-reset=${Date.now()}`);

  await t.test('authentication and explicit confirmation reject before any business access', async () => {
    reset();
    fixture.appMode = 'selected-variant';
    const invalid = [
      { kind: 'reset' },
      { kind: 'reset', confirmQuiet: true, confirmReset: true },
      resetBody({ confirmQuiet: false }),
      resetBody({ confirmReset: false }),
      resetBody({ confirmCheckoutClosed: false }),
      resetBody({ ordersTableName: ordersTable }),
      resetBody({ seedQuantity: 1000 }),
      resetBody({ sku: 'demo-widget' }),
    ];
    for (const body of invalid) {
      const response = await api.handler(httpEvent('PUT', `/api/actions/${randomUUID()}`, body));
      assert.equal(response.statusCode, 400, response.body);
    }
    const unauthorized = httpEvent('PUT', `/api/actions/${randomUUID()}`, resetBody());
    unauthorized.headers.authorization = 'Bearer wrong-operator';
    assert.equal((await api.handler(unauthorized)).statusCode, 401);
    const unauthorizedRun = httpEvent('GET', '/api/runs/legacy');
    unauthorizedRun.headers.authorization = 'Bearer wrong-operator';
    assert.equal((await api.handler(unauthorizedRun)).statusCode, 401,
      'archived run reads require the operator credential');
    assert.deepEqual(fixture.businessRequests, [], 'unconfirmed or unauthorized Reset does not read business data');
    assert.deepEqual(fixture.businessMutations, [], 'unconfirmed or unauthorized Reset changes no business data');
    assert.deepEqual(fixture.appRequests, [], 'unconfirmed or unauthorized Reset sends no app request');
    assert.deepEqual(fixture.invocations, [], 'invalid input never dispatches the worker');
  });

  await t.test('legacy run reads have a stable identity without rewriting stored history', async () => {
    reset();
    const storedBeforeRead = structuredClone(row('STATE'));
    const legacy = await getRun(api, 'legacy');
    const current = await getState(api);
    assert.equal(legacy.runId, 'legacy');
    assert.equal(current.runId, 'legacy');
    assert.equal(current.resetRequired, false);
    assert.deepEqual(legacy.baseline, current.baseline);
    assert.deepEqual(row('STATE'), storedBeforeRead, 'reading old state does not migrate or rewrite it');
    await call(api, 'GET', `/api/runs/${randomUUID()}`, undefined, 404);
    assert.deepEqual(fixture.invocations, []);
    assert.deepEqual(fixture.businessRequests, []);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('a completed Reset reseeds, deletes prior orders, rejects old payloads, and keeps the old run readable', async () => {
    reset();
    fixture.appMode = 'selected-variant';
    const readiness = await readyCurrentRelease(api, worker);
    const oldVersion = readiness.state.baseline.productVersion;
    const oldRunId = readiness.state.runId ?? 'legacy';
    const oldReceiptId = readiness.state.baseline.checkoutId;
    const additionalOrders = [await addPriorOrder(), await addPriorOrder()];
    const priorOrderIds = [oldReceiptId, ...additionalOrders.map(({ checkoutId }) => checkoutId)];
    const oldPayload = { checkoutId: oldReceiptId, sku: 'demo-widget', quantity: 1, productVersion: oldVersion };
    const originalBaseline = structuredClone(row('STATE').data.originalBaseline);
    assert.ok(originalBaseline, 'a successful readiness action saves its original baseline');
    const legacyExtra = { retainedByReset: true, source: 'phase8-acceptance' };
    row('STATE').data.legacyExtra = structuredClone(legacyExtra);
    const priorRun = await getState(api);
    const requestsBeforeReset = fixture.appRequests.length;
    const mutationsBeforeReset = fixture.businessMutations.length;
    const businessReadsBeforeReset = fixture.businessRequests.length;
    fixture.ordersScanPageSize = 1;
    fixture.businessOperationCounts.clear();
    const resetId = randomUUID();
    let beforeFirstMutation;
    fixture.beforeBusinessRequest = ({ operation }) => {
      if (!beforeFirstMutation && (operation === 'PutItem' || operation === 'DeleteItem')) {
        beforeFirstMutation = {
          current: structuredClone(row('STATE')?.data),
          archived: structuredClone(row(`RUN#${oldRunId}`)?.data),
        };
      }
    };

    const result = await runReset({ api, worker, id: resetId });
    fixture.beforeBusinessRequest = undefined;
    assert.equal(result.action.status, 'completed', result.action.error);
    assert.equal(result.action.reset?.runId, result.id);
    assert.equal(result.action.reset?.previousRunId, oldRunId);
    assert.equal(result.action.reset?.seedQuantity, 1000);
    assert.match(result.action.reset?.productVersion ?? '', /^[0-9a-f-]{36}$/i);
    assert.notEqual(result.action.reset.productVersion, oldVersion);
    assert.equal(result.state.runId, result.id);
    assert.equal(result.state.previousRunId, oldRunId);
    assert.equal(result.state.resetRequired, false);
    assert.equal(Object.hasOwn(result.state, 'budgets'), false,
      'new run state does not require or expose legacy request budgets');
    assert.equal(Object.hasOwn(row('STATE').data, 'budgets'), false,
      'the persisted new run does not create a request budget pool');
    assert.equal(result.state.baseline.productVersion, result.action.reset.productVersion);
    assert.equal(result.state.baseline.stockBefore, 1000);
    assert.equal(result.state.baseline.stockAfter, 999);
    const currentRunRead = await getRun(api, result.id);
    assert.equal(currentRunRead.runId, result.id);
    assert.deepEqual(currentRunRead.baseline, result.state.baseline);
    assert.equal(result.state.baseline.receipt.checkoutId, result.state.baseline.checkoutId);
    assert.deepEqual(result.state.unresolved, []);
    assert.equal(result.state.receipts.length, 1, 'the new run records its fresh verification order');
    assert.equal(beforeFirstMutation.current.runId, resetId);
    assert.equal(beforeFirstMutation.current.resetRequired, true,
      'the durable reset marker is active before the first business mutation');
    assert.equal(beforeFirstMutation.current.baseline, null);
    assert.equal(beforeFirstMutation.archived.runId, oldRunId);
    assert.deepEqual(beforeFirstMutation.archived.originalBaseline, originalBaseline);
    assert.deepEqual(beforeFirstMutation.archived.legacyExtra, legacyExtra);

    const verificationRequests = fixture.appRequests.slice(requestsBeforeReset);
    assert.equal(requestCount(verificationRequests, 'GET', '/api/products'), 2);
    assert.equal(requestCount(verificationRequests, 'POST', '/api/checkout'), 1);
    assert.equal(requestCount(verificationRequests, 'GET', `/api/orders/${result.state.baseline.checkoutId}`), 1);
    assert.deepEqual(result.action.requests.map(({ kind }) => kind).sort(),
      ['catalog', 'catalog', 'checkout', 'order_status'].sort());
    assert.ok(result.action.requests.every(({ completedAt, outcome }) => completedAt && outcome));

    const resetMutations = fixture.businessMutations.slice(mutationsBeforeReset);
    const inventorySeed = resetMutations.findIndex(({ operation, tableName }) => operation === 'PutItem' && tableName === table);
    const firstOrderDelete = resetMutations.findIndex(({ operation, tableName }) => operation === 'DeleteItem' && tableName === ordersTable);
    assert.ok(inventorySeed >= 0 && firstOrderDelete > inventorySeed,
      'Reset seeds the new inventory epoch before deleting prior Orders');
    assert.ok(fixture.businessRequests.slice(businessReadsBeforeReset).filter(({ operation }) => operation === 'Scan').length > 1,
      'the one-row fixture page size requires Reset to follow every Orders page');
    const seedRequest = fixture.businessRequests.slice(businessReadsBeforeReset)
      .find(({ operation, tableName }) => operation === 'PutItem' && tableName === table);
    assert.ok(seedRequest?.body.ConditionExpression,
      'the Inventory seed uses a conditional write');
    assert.deepEqual({
      sku: seedRequest.body.Item?.sku?.S,
      name: seedRequest.body.Item?.name?.S,
      unitPriceCents: seedRequest.body.Item?.unitPriceCents?.N,
      currency: seedRequest.body.Item?.currency?.S,
      availableQuantity: seedRequest.body.Item?.availableQuantity?.N,
    }, { sku: 'demo-widget', name: 'Demo Widget', unitPriceCents: '1299', currency: 'USD', availableQuantity: '1000' },
    'the actual seed request restores every established business value');
    const versionCondition = /^\s*(#[A-Za-z0-9_]+|[A-Za-z][A-Za-z0-9_]*)\s*=\s*(:[A-Za-z0-9_]+)\s*$/.exec(seedRequest.body.ConditionExpression);
    assert.ok(versionCondition, 'the seed condition is a simple productVersion equality');
    assert.equal(seedRequest.body.ExpressionAttributeNames?.[versionCondition[1]] ?? versionCondition[1], 'productVersion');
    assert.equal(seedRequest.body.ExpressionAttributeValues?.[versionCondition[2]]?.S, oldVersion,
      'the seed condition is bound to the previously read productVersion');
    const scanRequests = fixture.businessRequests.slice(businessReadsBeforeReset)
      .filter(({ operation }) => operation === 'Scan');
    assert.ok(scanRequests.length > 1 && scanRequests.every(({ body }) => body.ConsistentRead === true),
      'Reset scans Orders consistently while old writers are stopped');
    assert.ok(resetMutations.every(({ operation, tableName }) =>
      (operation === 'PutItem' && tableName === table) || (operation === 'DeleteItem' && tableName === ordersTable)),
    'Reset seeds only the selected Inventory row and deletes Orders without batch or order writes');
    assert.equal(fixture.appOrders.size, 1, 'only the fresh verification order remains');
    assert.equal(fixture.appStock, 999);
    assert.equal(fixture.appProductVersion, result.action.reset.productVersion);

    for (const checkoutId of priorOrderIds) {
      assert.equal((await appStatus(checkoutId)).status, 404, `prior order ${checkoutId} was deleted`);
    }
    const productAfterReset = await appProduct();
    assert.equal(productAfterReset.productVersion, result.action.reset.productVersion);
    assert.equal(productAfterReset.availableQuantity, 999);

    const stockBeforeStale = fixture.appStock;
    const ordersBeforeStale = fixture.appOrders.size;
    const stale = await appFetch(`${appApi}/api/checkout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${appBearer}`, 'content-type': 'application/json' },
      body: JSON.stringify(oldPayload),
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, 'STALE_PRODUCT_VERSION');
    assert.equal(fixture.appStock, stockBeforeStale);
    assert.equal(fixture.appOrders.size, ordersBeforeStale);
    assert.equal((await appStatus(oldPayload.checkoutId)).status, 404);

    const archived = await getRun(api, oldRunId);
    assert.equal(archived.runId, oldRunId);
    assert.equal(archived.baseline.checkoutId, oldReceiptId);
    assert.deepEqual(archived.originalBaseline, originalBaseline);
    assert.deepEqual(archived.legacyExtra, legacyExtra);
    const currentRun = await getRun(api, result.id);
    assert.equal(currentRun.runId, result.state.runId);
    assert.equal(currentRun.baseline.productVersion, result.state.baseline.productVersion);
    assert.ok(archived.receipts.some(({ checkoutId }) => checkoutId === oldReceiptId));
    assert.equal((await getAction(api, readiness.id)).status, 'completed');

    const callsAfterSuccess = fixture.businessMutations.length;
    const appRequestsAfterSuccess = fixture.appRequests.length;
    const invocationsAfterSuccess = fixture.invocations.length;
    const duplicate = await api.handler(httpEvent('PUT', `/api/actions/${result.id}`, resetBody()));
    assert.equal(duplicate.statusCode, 200);
    assert.equal(JSON.parse(duplicate.body).action?.reset?.productVersion, result.action.reset.productVersion);
    const conflicting = await api.handler(httpEvent('PUT', `/api/actions/${result.id}`, { kind: 'traffic' }));
    assert.equal(conflicting.statusCode, 409);
    await worker.handler({ actionId: result.id });
    assert.equal(fixture.businessMutations.length, callsAfterSuccess);
    assert.equal(fixture.appRequests.length, appRequestsAfterSuccess);
    assert.equal(fixture.invocations.length, invocationsAfterSuccess);
    assert.equal(fixture.appStock, 999);
    assert.deepEqual(fixture.unhandled, []);
    assert.equal(priorRun.runId ?? 'legacy', oldRunId);
  });

  await t.test('Reset uses current deployed settings when the prior baseline is missing or stale', async (t) => {
    await t.test('missing legacy baseline adopts the healthy current generation', async () => {
      reset({ revision: appRevision, baselineRevision: appRevision });
      fixture.appMode = 'selected-variant';
      row('STATE').data.baseline = null;
      delete row('STATE').data.originalBaseline;
      const oldRunId = (await getState(api)).runId ?? 'legacy';
      const oldOrder = await addPriorOrder();
      const result = await runReset({ api, worker });
      assert.equal(result.action.status, 'completed', result.action.error);
      assert.equal(result.state.runId, result.id);
      assert.equal(result.state.previousRunId, oldRunId);
      assert.equal(result.state.baseline.appRevision, appRevision);
      assert.ok(result.state.baseline.deploymentIdentity?.stackId);
      assert.equal(result.state.baseline.stockBefore, 1000);
      assert.equal(result.action.reset.productVersion, result.state.baseline.productVersion);
      assert.equal((await appStatus(oldOrder.checkoutId)).status, 404);
      assert.deepEqual(fixture.unhandled, []);
    });

    await t.test('stale memory and cap settings are replaced by the newer generation settings', async () => {
      reset({ revision: newerRevision, baselineRevision: appRevision });
      fixture.stackId = '22222222-2222-4222-8222-222222222222';
      fixture.stackLastUpdatedAt = '2026-11-12T00:00:00.000Z';
      fixture.extraVariants = [
        { memoryMb: 512, access: 'healthy', version: '4', roleArn: 'arn:aws:iam::027224425948:role/IncidentTriageDemoAppInventoryRole' },
        { memoryMb: 512, access: 'denied', version: '5', roleArn: 'arn:aws:iam::027224425948:role/IncidentTriageDemoAppInventoryDeniedRole' },
      ];
      fixture.aliasVersion.Inventory = '4';
      fixture.aliasRevision = 'alias-revision-2';
      fixture.inventoryConcurrency = 75;
      fixture.checkoutConcurrency = 40;
      fixture.appMode = 'selected-variant';
      const priorBaseline = row('STATE').data.baseline;
      priorBaseline.settings.inventory.version = '4';
      priorBaseline.settings.inventory.memory = 512;
      priorBaseline.settings.inventory.cap = 75;
      priorBaseline.settings.checkout.cap = 40;
      priorBaseline.appRevision = appRevision;
      row('STATE').data.originalBaseline = structuredClone(priorBaseline);
      const oldOrder = await addPriorOrder();

      const result = await runReset({ api, worker });
      assert.equal(result.action.status, 'completed', result.action.error);
      assert.equal(result.state.baseline.appRevision, newerRevision);
      assert.equal(result.state.baseline.deploymentIdentity?.stackId,
        `arn:aws:cloudformation:us-east-1:027224425948:stack/IncidentTriageDemoApp/${fixture.stackId}`);
      assert.equal(fixture.aliasVersion.Inventory, '2', 'Reset uses the current release healthy variant, not stale v4');
      assert.equal(fixture.inventoryConcurrency, undefined);
      assert.equal(fixture.checkoutConcurrency, undefined);
      assert.ok(fixture.concurrencyWrites.every(({ next }) => next === 'unreserved'));
      assert.equal((await appStatus(oldOrder.checkoutId)).status, 404);
      assert.deepEqual(fixture.unhandled, []);
    });
  });

  await t.test('Reset rejects failed deployments and unavailable required capture before data mutation', async (t) => {
    for (const scenario of [
      {
        name: 'failed deployment',
        configure: () => { fixture.stackStatus = 'UPDATE_ROLLBACK_COMPLETE'; },
      },
      {
        name: 'unavailable capture',
        configure: () => { fixture.checkpointMode = 'fail'; fixture.aliasVersion.Inventory = deniedVersion; },
      },
    ]) {
      await t.test(scenario.name, async () => {
        reset();
        fixture.appMode = 'selected-variant';
        const oldOrder = await addPriorOrder();
        scenario.configure();
        const ordersBefore = fixture.appOrders.size;
        const stockBefore = fixture.appStock;
        const result = await runReset({ api, worker });
        assert.ok(['failed', 'incomplete'].includes(result.action.status), result.action.error);
        assert.equal(fixture.businessMutations.length, 0,
          'the unsafe Reset does not seed Inventory or delete prior Orders');
        assert.equal(fixture.appOrders.size, ordersBefore);
        assert.equal(fixture.appStock, stockBefore);
        assert.equal((await appStatus(oldOrder.checkoutId)).status, 200);
        assert.deepEqual(fixture.unhandled, []);
      });
    }
  });

  await t.test('Reset waits for held traffic to drain before changing business data', async () => {
    reset();
    fixture.appMode = 'selected-variant';
    await readyCurrentRelease(api, worker);
    fixture.appMode = 'hold';
    fixture.heldReleaseMode = 'selected-variant';
    const requestsBeforeTraffic = fixture.appRequests.length;
    const trafficId = await submit(api, 'traffic');
    const trafficRun = worker.handler({ actionId: trafficId });
    let resetWorker;
    let resetId;
    try {
      await waitFor('normal traffic to occupy catalog and checkout slots', async () => {
        const action = await getAction(api, trafficId);
        return action.traffic.catalog.inFlight === 1 && action.traffic.checkout.inFlight === 2;
      });
      assert.equal(fixture.appOrders.size > 0, true);
      const businessWritesBeforeReset = fixture.businessMutations.length;
      resetId = await acceptReset(api);
      resetWorker = worker.handler({ actionId: resetId });
      await waitFor('Reset to stop and drain the traffic action', async () =>
        (await getAction(api, trafficId)).status === 'draining');
      assert.equal((await getAction(api, trafficId)).stopRequested, true);
      assert.equal(fixture.businessMutations.length, businessWritesBeforeReset,
        'Reset performs no seed/delete writes while accepted requests are held');
      const acceptedRequestsAtDrain = fixture.appRequests.length;
      const resetAction = await getAction(api, resetId);
      assert.equal(resetAction.status, 'running');

      releaseHeld();
      await Promise.all([trafficRun, resetWorker]);
      resetWorker = undefined;
      const stopped = await getAction(api, trafficId);
      assert.equal(stopped.status, 'stopped');
      assert.equal(stopped.traffic.catalog.inFlight, 0);
      assert.equal(stopped.traffic.checkout.inFlight, 0);
      assert.ok(fixture.appRequests.length >= acceptedRequestsAtDrain);
      const completedReset = await getAction(api, resetId);
      assert.equal(completedReset.status, 'completed', completedReset.error);
      assert.ok(fixture.businessMutations.length > businessWritesBeforeReset);
      assert.ok(fixture.businessMutations.findIndex(({ operation }) => operation === 'PutItem') <
        fixture.businessMutations.findIndex(({ operation }) => operation === 'DeleteItem'));
      assert.deepEqual(fixture.unhandled, []);
    } finally {
      releaseHeld();
      await Promise.all([trafficRun, resetWorker].filter(Boolean));
    }
  });

  await t.test('seed failures stay incomplete, applied lost acknowledgements use readback, and failed completion cannot certify health', async (t) => {
    await t.test('a rejected Inventory seed leaves the new run blocked without deleting orders', async () => {
      reset();
      fixture.appMode = 'selected-variant';
      const readiness = await readyCurrentRelease(api, worker);
      const oldOrder = await addPriorOrder();
      const stockBefore = fixture.appStock;
      const appRequestsBefore = fixture.appRequests.length;
      fixture.businessOperationCounts.clear();
      fixture.businessFailure = { operation: 'PutItem', occurrence: 1, errorCode: 'AccessDeniedException' };

      const result = await runReset({ api, worker });
      assert.equal(result.action.status, 'incomplete', result.action.error);
      assert.equal(result.state.resetRequired, true);
      assert.equal(result.state.baseline, null);
      assert.equal(fixture.appStock, stockBefore);
      assert.equal(fixture.businessMutations.filter(({ operation }) => operation === 'DeleteItem').length, 0);
      assert.equal(fixture.appRequests.length, appRequestsBefore,
        'a failed seed does not start app verification');
      assert.equal((await appStatus(oldOrder.checkoutId)).status, 200);
      assert.ok(await getRun(api, readiness.state.runId ?? 'legacy'));
      assert.deepEqual(fixture.unhandled, []);
    });

    await t.test('a seed that commits before its response is lost is resolved by strong readback', async () => {
      reset();
      fixture.appMode = 'selected-variant';
      await readyCurrentRelease(api, worker);
      fixture.businessOperationCounts.clear();
      let lost = false;
      fixture.afterBusinessRequest = ({ operation, outcome }) => {
        if (!lost && operation === 'PutItem' && outcome === 'applied') {
          lost = true;
          throw new Error('fixture lost the seed acknowledgement after commit');
        }
      };

      const result = await runReset({ api, worker });
      fixture.afterBusinessRequest = undefined;
      assert.equal(lost, true);
      assert.equal(result.action.status, 'completed', result.action.error);
      assert.equal(result.state.resetRequired, false);
      assert.equal(fixture.businessMutations.filter(({ operation }) => operation === 'PutItem').length, 1,
        'the ambiguous seed is not retried');
      assert.ok(fixture.businessRequests.filter(({ operation }) => operation === 'GetItem').length >= 2,
        'a strong Inventory read resolves the lost seed acknowledgement');
      assert.equal(fixture.appProductVersion, result.action.reset.productVersion);
      assert.deepEqual(fixture.unhandled, []);
    });

    await t.test('a final current-state write failure leaves resetRequired set', async () => {
      reset();
      fixture.appMode = 'selected-variant';
      await readyCurrentRelease(api, worker);
      fixture.failResetCompletion = true;

      const result = await runReset({ api, worker });
      assert.notEqual(result.action.status, 'completed', result.action.error);
      assert.equal(result.state.resetRequired, true,
        'verified business calls cannot clear the durable marker when completion persistence fails');
      assert.equal(result.state.baseline, null);
      assert.equal(fixture.appStock, 999);
      assert.ok(fixture.appRequests.some(({ method, path }) => method === 'POST' && path === '/api/checkout'));
      assert.deepEqual(fixture.unhandled, []);
    });
  });

  await t.test('partial Orders deletion leaves Reset required; discard plus a new Reset starts a fresh epoch', async () => {
    reset();
    fixture.appMode = 'selected-variant';
    const readiness = await readyCurrentRelease(api, worker);
    const oldRunId = readiness.state.runId ?? 'legacy';
    const priorIds = [readiness.state.baseline.checkoutId,
      (await addPriorOrder()).checkoutId, (await addPriorOrder()).checkoutId];
    fixture.ordersScanPageSize = 1;
    fixture.businessOperationCounts.clear();
    fixture.businessFailure = { operation: 'DeleteItem', occurrence: 2, errorCode: 'AccessDeniedException' };
    const resetOneId = randomUUID();
    const resetOne = await runReset({ api, worker, id: resetOneId });
    assert.equal(resetOne.action.status, 'incomplete', resetOne.action.error);
    assert.equal(resetOne.state.resetRequired, true);
    assert.ok(resetOne.action.reset?.productVersion);
    const firstVersion = resetOne.action.reset.productVersion;
    assert.equal(fixture.appStock, 1000, 'the first attempt seeded the new stock before partial deletion');
    assert.notEqual(fixture.appProductVersion, readiness.state.baseline.productVersion);
    assert.ok(fixture.appOrders.size > 0 && fixture.appOrders.size < priorIds.length,
      'the injected failure leaves only part of the prior Orders set');
    assert.ok(fixture.businessMutations.some(({ operation, outcome }) => operation === 'DeleteItem' && outcome === 'failed'));

    const appRequestsAtFailure = fixture.appRequests.length;
    const businessWritesAtFailure = fixture.businessMutations.length;
    for (const [kind, extra] of [
      ['readiness', { confirmQuiet: true }],
      ['recover', { confirmQuiet: true }],
      ['traffic', {}],
      ['activate_inventory_denial', {}],
      ['increase_memory', { function: 'inventory', memoryMb: 512 }],
    ]) {
      const blocked = await api.handler(httpEvent('PUT', `/api/actions/${randomUUID()}`, { kind, ...extra }));
      assert.equal(blocked.statusCode, 409, blocked.body);
    }
    assert.equal(fixture.appRequests.length, appRequestsAtFailure);
    assert.equal(fixture.businessMutations.length, businessWritesAtFailure,
      'Readiness and Recover cannot bypass a pending destructive Reset');

    const discardId = randomUUID();
    const discardOffset = resetOne.action.discardAfter - Date.now() + 1;
    await withElapsed(discardOffset, async () => {
      await call(api, 'PUT', `/api/actions/${discardId}`, { kind: 'discard', targetActionId: resetOneId }, 202);
    });
    assert.equal((await getAction(api, discardId)).status, 'completed');
    assert.equal((await getAction(api, resetOneId)).status, 'discarded');
    assert.equal((await getState(api)).resetRequired, true,
      'discarding the incomplete attempt does not certify or clear the destructive reset');

    const writesBeforeReplay = fixture.businessMutations.length;
    const replay = await api.handler(httpEvent('PUT', `/api/actions/${resetOneId}`, resetBody()));
    assert.equal(replay.statusCode, 200);
    assert.equal(JSON.parse(replay.body).action?.reset?.productVersion, firstVersion);
    await worker.handler({ actionId: resetOneId });
    assert.equal(fixture.businessMutations.length, writesBeforeReplay,
      'replaying the old incomplete action does not continue or repeat its reset steps');

    fixture.ordersScanPageSize = 1;
    const requestsBeforeSecond = fixture.appRequests.length;
    const resetTwo = await runReset({ api, worker });
    assert.notEqual(resetTwo.id, resetOneId);
    assert.equal(resetTwo.action.status, 'completed', resetTwo.action.error);
    assert.notEqual(resetTwo.action.reset.productVersion, firstVersion,
      'an explicit new Reset action receives another fresh productVersion');
    assert.equal(resetTwo.state.resetRequired, false);
    assert.equal(resetTwo.state.runId, resetTwo.id);
    assert.equal(resetTwo.state.previousRunId, resetOneId);
    assert.equal(resetTwo.state.baseline.stockBefore, 1000);
    assert.equal(resetTwo.state.baseline.stockAfter, 999);
    for (const checkoutId of priorIds) assert.equal((await appStatus(checkoutId)).status, 404);
    const firstAttemptRun = await getRun(api, resetOneId);
    assert.equal(firstAttemptRun.resetRequired, true);
    const originalRun = await getRun(api, oldRunId);
    assert.ok(originalRun.receipts.some(({ checkoutId }) => checkoutId === priorIds[0]));
    assert.ok(fixture.appRequests.length > requestsBeforeSecond);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('verification interruption archives unresolved history and a new Reset can establish a fresh epoch', async () => {
    reset();
    fixture.appMode = 'selected-variant';
    const readiness = await readyCurrentRelease(api, worker);
    const previousRunId = readiness.state.runId ?? 'legacy';
    const oldVersion = readiness.state.baseline.productVersion;
    const oldUnknownId = randomUUID();
    row('STATE').data.unresolved.push(unresolvedAttempt(oldUnknownId, oldVersion));
    const oldOrder = await addPriorOrder();

    fixture.appMode = 'generic-502';
    const failedReset = await runReset({ api, worker });
    assert.equal(failedReset.action.status, 'incomplete', failedReset.action.error);
    assert.equal(failedReset.state.resetRequired, true);
    const firstResetVersion = failedReset.action.reset.productVersion;
    assert.notEqual(firstResetVersion, oldVersion);
    assert.equal(fixture.appProductVersion, firstResetVersion,
      'inventory reseeding happened before the verification interruption');
    assert.equal(fixture.appStock, 1000, 'verification failure sends no fresh checkout');
    assert.ok(fixture.businessMutations.some(({ operation }) => operation === 'PutItem'));
    assert.ok(fixture.businessMutations.some(({ operation }) => operation === 'DeleteItem'));
    assert.equal((await appStatus(oldOrder.checkoutId)).status, 404);

    const archived = await getRun(api, previousRunId);
    assert.ok(archived.unresolved.some(({ checkoutId, productVersion }) =>
      checkoutId === oldUnknownId && productVersion === oldVersion),
    'the prior unknown checkout remains historical after its order table was cleared');
    assert.equal((await appStatus(oldUnknownId)).status, 404,
      'the old unknown identity no longer blocks Reset after its prior work has stopped');
    const writesBeforeGates = fixture.businessMutations.length;
    const requestsBeforeGates = fixture.appRequests.length;
    for (const [kind, extra] of [['readiness', { confirmQuiet: true }], ['recover', { confirmQuiet: true }]]) {
      const blocked = await api.handler(httpEvent('PUT', `/api/actions/${randomUUID()}`, { kind, ...extra }));
      assert.equal(blocked.statusCode, 409);
    }
    const discardId = randomUUID();
    await withElapsed(failedReset.action.discardAfter - Date.now() + 1, async () => {
      await call(api, 'PUT', `/api/actions/${discardId}`, { kind: 'discard', targetActionId: failedReset.id }, 202);
    });
    assert.equal((await getState(api)).resetRequired, true,
      'discarding the incomplete verification action does not clear resetRequired');
    assert.equal(fixture.businessMutations.length, writesBeforeGates);
    assert.equal(fixture.appRequests.length, requestsBeforeGates);

    fixture.appMode = 'selected-variant';
    const next = await runReset({ api, worker });
    assert.notEqual(next.action.reset.productVersion, firstResetVersion);
    assert.equal(next.action.status, 'completed', next.action.error);
    assert.equal(next.state.resetRequired, false);
    assert.equal(next.state.previousRunId, failedReset.id);
    assert.equal(next.state.baseline.stockBefore, 1000);
    assert.equal(next.state.baseline.stockAfter, 999);
    assert.equal((await appStatus(oldUnknownId)).status, 404);
    const originalRun = await getRun(api, previousRunId);
    assert.ok(originalRun.unresolved.some(({ checkoutId }) => checkoutId === oldUnknownId));
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('Reset stops paginated deletion when the action deadline is reached', async () => {
    reset();
    fixture.appMode = 'selected-variant';
    const readiness = await readyCurrentRelease(api, worker);
    await addPriorOrder();
    await addPriorOrder();
    fixture.ordersScanPageSize = 1;
    const appRequestsBeforeReset = fixture.appRequests.length;
    const resetId = randomUUID();
    const accepted = await call(api, 'PUT', `/api/actions/${resetId}`, resetBody(), 202);
    const originalNow = Date.now;
    fixture.afterBusinessRequest = ({ operation, count }) => {
      if (operation === 'Scan' && count === 1) Date.now = () => accepted.action.deadlineAt;
    };
    try {
      await worker.handler({ actionId: resetId });
    } finally {
      Date.now = originalNow;
      fixture.afterBusinessRequest = undefined;
    }
    const action = await getAction(api, resetId);
    const state = await getState(api);
    assert.equal(action.status, 'incomplete');
    assert.equal(state.resetRequired, true);
    assert.equal(fixture.ordersScanPages, 1,
      'the action deadline prevents an additional Orders page request');
    assert.equal(fixture.businessMutations.filter(({ operation }) => operation === 'DeleteItem').length, 0,
      'no deletion is submitted after the first page exhausts the action window');
    assert.equal(fixture.appRequests.length, appRequestsBeforeReset,
      'Reset does not begin fresh business verification after its action deadline');
    assert.ok(action.reset?.productVersion);
    assert.equal(fixture.appProductVersion, action.reset.productVersion,
      'the seed already committed before the bounded scan stopped');
    assert.ok(readiness.state.baseline.productVersion !== action.reset.productVersion);
    assert.deepEqual(fixture.unhandled, []);
  });
});
