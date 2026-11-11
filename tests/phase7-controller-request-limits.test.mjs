import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  appFetch, appRevision, awsEnvironment, fixture, getAction, getState, httpEvent, put, releaseHeld, reset, root, row,
  startAwsServer, submit,
} from './support/phase3-inventory-controller-harness.mjs';

function zeroLegacyBudgets() {
  row('STATE').data.budgets = {
    checkout: { generatorRemaining: 0, verificationRemaining: 0 },
    catalog: { remaining: 0 },
    orderStatus: { remaining: 0 },
  };
}

function requestDelta(startIndex) {
  return fixture.appRequests.slice(startIndex);
}

function checkoutPosts(requests) {
  return requests.filter(({ method, path }) => method === 'POST' && path === '/api/checkout');
}

async function runAction(api, worker, kind, extra = {}) {
  const id = await submit(api, kind, extra);
  await worker.handler({ actionId: id });
  return { id, action: await getAction(api, id), state: await getState(api) };
}

async function assertReadiness({ api, worker }) {
  const beforeRequest = fixture.appRequests.length;
  const beforeStock = fixture.appStock;
  const beforeReceipts = (await getState(api)).receipts.length;
  const { id, action, state } = await runAction(api, worker, 'readiness', { confirmQuiet: true });

  assert.equal(action.status, 'completed', action.error);
  assert.equal(checkoutPosts(requestDelta(beforeRequest)).length, 1,
    'readiness makes one real quantity-one checkout through the app API');
  assert.ok(action.requests.some(({ kind, outcome, completedAt, checkout }) =>
    kind === 'checkout' && outcome === 'success' && completedAt && checkout?.quantity === 1),
  'the persisted request records its actual successful checkout outcome');
  assert.ok(state.baseline?.deploymentIdentity?.stackId,
    'public readiness binds the baseline to the successful deployed stack identity');
  assert.equal(state.baseline.appRevision, appRevision);
  assert.equal(state.receipts.length, beforeReceipts + 1);
  assert.equal(state.latestStock, beforeStock - 1);
  assert.equal(fixture.appStock, beforeStock - 1);
  return { id, action, state };
}

function seedOldAllowanceOnlyRecover() {
  const now = Date.now();
  const id = randomUUID();
  const error = 'Recover restored configuration, but fresh business verification was incomplete because the checkout allowance was exhausted.';
  put({ pk: `ACTION#${id}`, revision: 1, data: {
    id,
    kind: 'recover',
    command: { kind: 'recover', confirmQuiet: true },
    status: 'incomplete',
    createdAt: new Date(now - 120_000).toISOString(),
    updatedAt: new Date(now - 60_000).toISOString(),
    claimBy: now - 90_000,
    deadlineAt: now - 60_000,
    discardAfter: now - 1,
    requests: [],
    configurationOutcome: 'applied',
    recoveryProgress: 'verification_incomplete',
    error,
  } });
  row('STATE').data.configurationActionId = id;
  return { id, error };
}

function seedUnknownCheckout(checkoutId, { committed = false } = {}) {
  const payload = { checkoutId, sku: 'demo-widget', quantity: 1, productVersion: 'fixture-product-v1' };
  row('STATE').data.unresolved.push({ ...payload, startedAt: new Date().toISOString(), status: 'unknown' });
  if (committed) {
    fixture.appOrders.set(checkoutId, {
      checkoutId,
      sku: payload.sku,
      quantity: payload.quantity,
      unitPriceCents: 1299,
      totalPriceCents: 1299,
      currency: 'USD',
      createdAt: new Date().toISOString(),
      status: 'placed',
    });
    fixture.appStock -= 1;
  }
  return payload;
}

async function waitFor(description, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function assertTrafficRequestHistory(action) {
  assert.equal(action.status, 'completed', action.error);
  for (const profile of ['catalog', 'checkout']) {
    const requests = action.requests.filter(({ kind }) => kind === profile);
    const progress = action.traffic[profile];
    assert.ok(progress.submitted > 0, `the ${profile} profile sends traffic in its own action`);
    assert.equal(progress.submitted, requests.length);
    assert.equal(progress.completed, requests.length);
    assert.equal(progress.inFlight, 0);
    assert.ok(progress.submitted <= 15, `the ${profile} producer stays within its finite action profile`);
    assert.equal(progress.submitted + progress.skipped, 15,
      `the completed ${profile} profile accounts for each of its finite ticks`);
    assert.ok(requests.every(({ completedAt, outcome }) => completedAt && outcome),
      `the ${profile} request history retains each observed outcome`);
  }
}

test('controller request quotas are not cumulative run gates', { timeout: 180_000 }, async (t) => {
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
  const api = await import(`${backendPath}?phase7-request-limits=${Date.now()}`);
  const worker = await import(`${workerPath}?phase7-request-limits=${Date.now()}`);

  await t.test('legacy zero allowances allow readiness and Recover while preserving observed orders', async () => {
    reset();
    zeroLegacyBudgets();
    const legacyBudgets = structuredClone(row('STATE').data.budgets);
    fixture.appMode = 'selected-variant';
    const readiness = await assertReadiness({ api, worker });
    assert.deepEqual(row('STATE').data.budgets, legacyBudgets,
      'readiness preserves inert legacy fields without charging or replenishing them');
    const readyReceiptId = readiness.state.baseline.checkoutId;
    const stockBeforeRecover = fixture.appStock;
    const receiptsBeforeRecover = (await getState(api)).receipts.length;
    const requestStart = fixture.appRequests.length;

    const recovery = await runAction(api, worker, 'recover', { confirmQuiet: true });
    assert.equal(recovery.action.status, 'completed', recovery.action.error);
    assert.equal(recovery.action.configurationOutcome, 'no_change');
    assert.deepEqual(row('STATE').data.budgets, legacyBudgets,
      'Recover preserves the original exhausted legacy fields unchanged');
    assert.equal(checkoutPosts(requestDelta(requestStart)).length, 1,
      'Recover makes one fresh checkout instead of treating old allowance values as a send gate');
    assert.ok(recovery.action.requests.some(({ kind, outcome, completedAt, checkout }) =>
      kind === 'checkout' && outcome === 'success' && completedAt && checkout?.quantity === 1),
    'Recover retains the fresh verification request and outcome');
    assert.equal(recovery.state.receipts.length, receiptsBeforeRecover + 1);
    assert.ok(recovery.state.receipts.some(({ checkoutId }) => checkoutId === readyReceiptId),
      'Recover retains the readiness receipt from the earlier action');
    assert.ok(recovery.state.receipts.some(({ checkoutId }) => checkoutId === recovery.action.baseline?.checkoutId),
      'Recover persists its new verification receipt');
    assert.equal(recovery.state.latestStock, stockBeforeRecover - 1);
    assert.equal(fixture.appStock, stockBeforeRecover - 1);
    assert.equal((await getAction(api, readiness.id)).status, 'completed',
      'the earlier public action remains inspectable after recovery');

    const requestsAfterRecovery = fixture.appRequests.length;
    const duplicate = await api.handler(httpEvent('PUT', `/api/actions/${recovery.id}`, {
      kind: 'recover', confirmQuiet: true,
    }));
    assert.equal(duplicate.statusCode, 200);
    await worker.handler({ actionId: recovery.id });
    assert.equal(fixture.appRequests.length, requestsAfterRecovery,
      'replaying the same completed Recover command adds no app request');
    assert.equal(fixture.appStock, stockBeforeRecover - 1,
      'replaying the command does not decrement stock again');
  });

  await t.test('a persisted state without allowance fields loads and completes readiness', async () => {
    reset();
    delete row('STATE').data.budgets;
    fixture.appMode = 'selected-variant';

    const loaded = await getState(api);
    assert.equal(loaded.baseline?.appRevision, appRevision,
      'the public state endpoint still returns the saved run when old allowance fields are absent');
    const readiness = await assertReadiness({ api, worker });
    assert.equal(readiness.action.status, 'completed', readiness.action.error);
    assert.ok(readiness.state.baseline?.deploymentIdentity?.stackId);
    assert.equal(Object.hasOwn(row('STATE').data, 'budgets'), false,
      'readiness does not recreate cumulative allowance fields');
    const priorReceiptId = readiness.state.baseline.checkoutId;
    const beforeRecoverStock = fixture.appStock;
    const beforeRecoverReceipts = readiness.state.receipts.length;
    const requestStart = fixture.appRequests.length;
    const recovery = await runAction(api, worker, 'recover', { confirmQuiet: true });
    assert.equal(recovery.action.status, 'completed', recovery.action.error);
    assert.equal(checkoutPosts(requestDelta(requestStart)).length, 1,
      'Recover completes fresh verification when old allowance fields are absent');
    assert.equal(Object.hasOwn(row('STATE').data, 'budgets'), false,
      'Recover does not recreate cumulative allowance fields');
    assert.equal(recovery.state.receipts.length, beforeRecoverReceipts + 1);
    assert.ok(recovery.state.receipts.some(({ checkoutId }) => checkoutId === priorReceiptId));
    assert.equal(recovery.state.latestStock, beforeRecoverStock - 1);
    assert.equal(fixture.appStock, beforeRecoverStock - 1);
  });

  await t.test('zero-allowance runs can activate denial, restore access, and verify recovery without a transfer', async () => {
    reset();
    zeroLegacyBudgets();
    fixture.appMode = 'selected-variant';
    const readiness = await assertReadiness({ api, worker });
    const stockBeforeIncident = fixture.appStock;
    const receiptsBeforeIncident = (await getState(api)).receipts.length;
    const activationRequestStart = fixture.appRequests.length;

    const activation = await runAction(api, worker, 'activate_inventory_denial');
    assert.equal(activation.action.status, 'completed', activation.action.error);
    assert.equal(activation.action.configurationOutcome, 'applied');
    assert.ok(activation.action.requests.some(({ kind, dependencyReason }) =>
      kind === 'catalog' && dependencyReason === 'inventory_access_denied'),
    'activation uses actual denial evidence through the app API');
    assert.ok(activation.action.requests.some(({ kind, dependencyReason, outcome }) =>
      kind === 'checkout' && dependencyReason === 'inventory_access_denied' && outcome !== 'success'),
    'the denial checkout is recorded as a failed business request without a receipt');
    assert.equal(checkoutPosts(requestDelta(activationRequestStart)).length, 1);
    assert.equal(fixture.appStock, stockBeforeIncident,
      'denied activation creates no order and does not decrement stock');
    assert.equal(activation.state.receipts.length, receiptsBeforeIncident);

    const requestsBeforeRestore = fixture.appRequests.length;
    const restore = await runAction(api, worker, 'restore_inventory_access');
    assert.equal(restore.action.status, 'completed', restore.action.error);
    assert.equal(restore.action.configurationOutcome, 'applied');
    assert.equal(fixture.appRequests.length, requestsBeforeRestore,
      'access restoration changes configuration without an implicit business probe');

    const requestsBeforeRecover = fixture.appRequests.length;
    const recovery = await runAction(api, worker, 'recover', { confirmQuiet: true });
    assert.equal(recovery.action.status, 'completed', recovery.action.error);
    assert.equal(checkoutPosts(requestDelta(requestsBeforeRecover)).length, 1,
      'fresh recovery proof succeeds while the legacy remaining allowances are zero');
    assert.equal(fixture.appStock, stockBeforeIncident - 1);
    assert.equal(recovery.state.receipts.length, receiptsBeforeIncident + 1);
    assert.ok(recovery.state.receipts.some(({ checkoutId }) => checkoutId === readiness.state.baseline.checkoutId));
    assert.ok(await getAction(api, activation.id));
    assert.ok(await getAction(api, restore.id));
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('Recover reconciles each saved unknown checkout once before its fresh verification', async () => {
    reset();
    zeroLegacyBudgets();
    fixture.appMode = 'selected-variant';
    await assertReadiness({ api, worker });
    const prior = [
      seedUnknownCheckout(randomUUID(), { committed: true }),
      seedUnknownCheckout(randomUUID(), { committed: true }),
    ];
    const stockBeforeRecover = fixture.appStock;
    const requestStart = fixture.appRequests.length;

    const recovery = await runAction(api, worker, 'recover', { confirmQuiet: true });
    assert.equal(recovery.action.status, 'completed', recovery.action.error);
    const delta = requestDelta(requestStart);
    for (const checkout of prior) {
      assert.equal(delta.filter(({ method, path }) => method === 'GET' && path === `/api/orders/${checkout.checkoutId}`).length, 1,
        'Recover reads each saved checkout identity once');
      assert.equal(checkoutPosts(delta).filter(({ body }) => body?.checkoutId === checkout.checkoutId).length, 0,
        'Recover reconciles the prior identity without resubmitting its POST');
      assert.ok(recovery.state.receipts.some(({ checkoutId }) => checkoutId === checkout.checkoutId),
        'a committed order discovered by status remains in cumulative receipt history');
    }
    const freshCheckout = recovery.action.requests.find(({ kind, checkout }) => kind === 'checkout' && checkout);
    assert.ok(freshCheckout?.checkout, 'Recover records its distinct fresh verification checkout');
    assert.notEqual(freshCheckout.checkout.checkoutId, prior[0].checkoutId);
    assert.notEqual(freshCheckout.checkout.checkoutId, prior[1].checkoutId);
    assert.equal(checkoutPosts(delta).filter(({ body }) => body?.checkoutId === freshCheckout.checkout.checkoutId).length, 1);
    assert.equal(recovery.state.unresolved.length, 0);
    assert.equal(fixture.appStock, stockBeforeRecover - 1,
      'status reconciliation adds no stock changes; only the fresh verification order decrements stock');
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('an unresolved first status read keeps later identities and fresh verification untouched', async () => {
    reset();
    zeroLegacyBudgets();
    fixture.appMode = 'selected-variant';
    await assertReadiness({ api, worker });
    const activation = await runAction(api, worker, 'activate_inventory_denial');
    assert.equal(activation.action.status, 'completed', activation.action.error);
    const first = seedUnknownCheckout(randomUUID());
    const later = seedUnknownCheckout(randomUUID(), { committed: true });
    const requestStart = fixture.appRequests.length;
    const stockBeforeRecover = fixture.appStock;

    const recovery = await runAction(api, worker, 'recover', { confirmQuiet: true });
    assert.ok(['failed', 'incomplete'].includes(recovery.action.status));
    assert.equal(recovery.action.configurationOutcome, 'applied',
      'configuration restoration remains independently recorded');
    const delta = requestDelta(requestStart);
    assert.equal(delta.filter(({ method, path }) => method === 'GET' && path === `/api/orders/${first.checkoutId}`).length, 1,
      'Recover attempts the first unresolved identity once');
    assert.equal(delta.filter(({ method, path }) => method === 'GET' && path === `/api/orders/${later.checkoutId}`).length, 0,
      'an unknown first result stops before later status reads');
    assert.equal(checkoutPosts(delta).length, 0,
      'Recover does not start fresh verification while a previous checkout remains unknown');
    assert.deepEqual(recovery.state.unresolved.map(({ checkoutId }) => checkoutId), [first.checkoutId, later.checkoutId]);
    assert.equal(fixture.appStock, stockBeforeRecover,
      'the blocked fresh verification sends no checkout and changes no stock');
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('Recover stops reconciliation at its request deadline without sending later checks or a fresh POST', async () => {
    reset();
    fixture.appMode = 'selected-variant';
    await assertReadiness({ api, worker });
    const prior = [
      seedUnknownCheckout(randomUUID(), { committed: true }),
      seedUnknownCheckout(randomUUID(), { committed: true }),
    ];
    const requestStart = fixture.appRequests.length;
    const stockBefore = fixture.appStock;
    const clock = Date.now;
    globalThis.fetch = async (url, init) => {
      const response = await appFetch(url, init);
      if (new URL(url).pathname === `/api/orders/${prior[0].checkoutId}`) {
        // The first status completed, but less than one request timeout remains.
        Date.now = () => clock() + 70_000;
      }
      return response;
    };
    let recovery;
    try {
      recovery = await runAction(api, worker, 'recover', { confirmQuiet: true });
    } finally {
      Date.now = clock;
      globalThis.fetch = appFetch;
    }
    assert.equal(recovery.action.status, 'incomplete');
    assert.equal(recovery.action.configurationOutcome, 'no_change');
    assert.deepEqual(requestDelta(requestStart).map(({ method, path }) => ({ method, path })), [
      { method: 'GET', path: `/api/orders/${prior[0].checkoutId}` },
    ], 'deadline admission prevents the second status check and every fresh verification request');
    assert.ok(recovery.state.receipts.some(({ checkoutId }) => checkoutId === prior[0].checkoutId));
    assert.deepEqual(recovery.state.unresolved.map(({ checkoutId }) => checkoutId), [prior[1].checkoutId]);
    assert.equal(fixture.appStock, stockBefore);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('an old allowance-only incomplete Recover remains inspectable and can be discarded before a new Recover', async () => {
    reset();
    zeroLegacyBudgets();
    fixture.appMode = 'selected-variant';
    const readiness = await assertReadiness({ api, worker });
    const priorReceiptId = readiness.state.baseline.checkoutId;
    const old = seedOldAllowanceOnlyRecover();

    const observedOld = await getAction(api, old.id);
    assert.equal(observedOld.status, 'incomplete');
    assert.equal(observedOld.error, old.error,
      'the prior allowance-based result remains historical and visible');
    const discardId = await submit(api, 'discard', { targetActionId: old.id });
    assert.equal((await getAction(api, discardId)).status, 'completed');
    assert.equal((await getAction(api, old.id)).status, 'discarded');
    assert.equal((await getAction(api, old.id)).error, old.error,
      'discard keeps the saved failure detail instead of rewriting history');

    const beforeStock = fixture.appStock;
    const beforeReceipts = (await getState(api)).receipts.length;
    const requestStart = fixture.appRequests.length;
    const next = await runAction(api, worker, 'recover', { confirmQuiet: true });
    assert.equal(next.action.status, 'completed', next.action.error);
    assert.equal(checkoutPosts(requestDelta(requestStart)).length, 1);
    assert.equal(fixture.appStock, beforeStock - 1);
    assert.equal(next.state.receipts.length, beforeReceipts + 1);
    assert.ok(next.state.receipts.some(({ checkoutId }) => checkoutId === priorReceiptId),
      'the new action proceeds without resetting the saved readiness order');
    assert.equal((await getAction(api, old.id)).error, old.error);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('zero-allowance Stop drains held traffic and duplicate commands add no sends', async () => {
    reset();
    zeroLegacyBudgets();
    fixture.appMode = 'selected-variant';
    await assertReadiness({ api, worker });
    fixture.appMode = 'hold';
    fixture.heldReleaseMode = 'selected-variant';
    const requestsBeforeTraffic = fixture.appRequests.length;
    const trafficId = await submit(api, 'traffic');
    const trafficRun = worker.handler({ actionId: trafficId });
    let stopId;
    try {
      await waitFor('both normal traffic profiles to occupy their in-flight slots', async () => {
        const action = await getAction(api, trafficId);
        return action.traffic.catalog.inFlight === 1 && action.traffic.checkout.inFlight === 2;
      });
      const beforeDuplicateStart = fixture.appRequests.length;
      const invocationCount = fixture.invocations.length;
      const duplicateStart = await api.handler(httpEvent('PUT', `/api/actions/${trafficId}`, { kind: 'traffic' }));
      assert.equal(duplicateStart.statusCode, 200);
      await worker.handler({ actionId: trafficId });
      assert.equal(fixture.appRequests.length, beforeDuplicateStart);
      assert.equal(fixture.invocations.length, invocationCount);

      stopId = await submit(api, 'stop', { targetActionId: trafficId });
      const draining = await getAction(api, trafficId);
      assert.equal(draining.status, 'draining');
      assert.equal(draining.stopRequested, true);
      const requestsAtStop = fixture.appRequests.length;

      const duplicateStop = await api.handler(httpEvent('PUT', `/api/actions/${stopId}`, {
        kind: 'stop', targetActionId: trafficId,
      }));
      assert.equal(duplicateStop.statusCode, 200);
      await worker.handler({ actionId: stopId });
      assert.equal(fixture.appRequests.length, requestsAtStop,
        'duplicate Stop delivery creates no additional application request');
      assert.ok(requestsAtStop > requestsBeforeTraffic,
        'the Stop request drains work that had already been accepted');
    } finally {
      releaseHeld();
      await trafficRun;
    }

    const stopped = await getAction(api, trafficId);
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.traffic.catalog.inFlight, 0);
    assert.equal(stopped.traffic.checkout.inFlight, 0);
    assert.equal(stopped.traffic.catalog.completed, stopped.traffic.catalog.submitted);
    assert.equal(stopped.traffic.checkout.completed, stopped.traffic.checkout.submitted);
    assert.equal(fixture.appRequests.length - requestsBeforeTraffic, stopped.requests.length,
      'all app sends are represented by durable traffic request history');
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('normal traffic completes as separate finite actions and a duplicate command sends nothing', { timeout: 90_000 }, async () => {
    reset();
    zeroLegacyBudgets();
    fixture.appMode = 'selected-variant';
    await assertReadiness({ api, worker });

    async function runTraffic() {
      const requestStart = fixture.appRequests.length;
      const id = await submit(api, 'traffic');
      await worker.handler({ actionId: id });
      const action = await getAction(api, id);
      assertTrafficRequestHistory(action);
      const actualDelta = requestDelta(requestStart);
      assert.equal(actualDelta.filter(({ method, path }) => method === 'GET' && path === '/api/products').length,
        action.traffic.catalog.submitted);
      assert.equal(checkoutPosts(actualDelta).length, action.traffic.checkout.submitted);
      return { id, action };
    }

    const first = await runTraffic();
    const afterFirst = fixture.appRequests.length;
    const invocationCount = fixture.invocations.length;
    const duplicate = await api.handler(httpEvent('PUT', `/api/actions/${first.id}`, { kind: 'traffic' }));
    assert.equal(duplicate.statusCode, 200);
    await worker.handler({ actionId: first.id });
    assert.equal(fixture.appRequests.length, afterFirst,
      'duplicate Start delivery does not add traffic after the first action completed');
    assert.equal(fixture.invocations.length, invocationCount,
      'the duplicate command does not dispatch another worker');

    const second = await runTraffic();
    assert.notEqual(second.id, first.id);
    assert.ok(second.action.traffic.catalog.submitted > 0 && second.action.traffic.checkout.submitted > 0,
      'a later traffic action has its own submissions after the earlier action completed');
    assert.deepEqual(fixture.unhandled, []);
  });
});
