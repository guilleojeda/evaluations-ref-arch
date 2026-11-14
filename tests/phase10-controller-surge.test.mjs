import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  appFetch, appRevision, awsEnvironment, call, fixture, getAction, getState, healthyVersion, httpEvent, newerRevision,
  records, releaseHeldCatalog, reset, resetProducerRunObservations, root, row, startAwsServer, submit, withElapsed,
} from './support/phase3-inventory-controller-harness.mjs';

const surgeCommand = { kind: 'traffic', profile: 'inventory_surge' };
const surgeProfile = {
  name: 'inventory_surge',
  version: 1,
  durationMs: 15_000,
  catalog: { ratePerSecond: 240, maxAttempts: 3_600, maxInFlight: 128, requestTimeoutMs: 7_000 },
  checkout: { intervalMs: 1_000, maxAttempts: 15, maxInFlight: 2, requestTimeoutMs: 7_000 },
};
const outcomeNames = ['success', 'http4xx', 'http5xx', 'invalidResponse', 'noResponse'];
const skipNames = ['late', 'full', 'checkpoint'];

function setInventoryCap(cap) {
  fixture.inventoryExpectedConcurrency = cap;
  fixture.inventoryConcurrency = cap;
}

async function createContext(t, suffix) {
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
  const importSuffix = `${suffix}=${Date.now()}-${randomUUID()}`;
  const api = await import(`${backendPath}?${importSuffix}`);
  const worker = await import(`${workerPath}?${importSuffix}`);
  return { api, worker };
}

async function prepareReady(context, cap = 16) {
  reset();
  setInventoryCap(cap);
  fixture.appMode = 'selected-variant';
  const readinessId = await submit(context.api, 'readiness', { confirmQuiet: true });
  await context.worker.handler({ actionId: readinessId });
  const action = await getAction(context.api, readinessId);
  assert.equal(action.status, 'completed', action.error);
  const state = await getState(context.api);
  assert.equal(state.baseline?.settings?.inventory?.cap, cap);
  resetProducerRunObservations();
  return { readinessId, action, state };
}

async function startSurge(api) {
  const id = randomUUID();
  const accepted = await call(api, 'PUT', `/api/actions/${id}`, surgeCommand, 202);
  assert.equal(accepted.action?.id, id);
  assert.deepEqual(accepted.action?.command, surgeCommand);
  return { id, accepted: accepted.action };
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

function blockEventLoop(milliseconds) {
  const until = performance.now() + milliseconds;
  while (performance.now() < until) { /* emulate a brief scheduler stall */ }
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function assertFixedCounters(value, names, label) {
  assert.deepEqual(Object.keys(value).sort(), [...names].sort(), `${label} keeps the fixed counter set`);
  for (const [name, count] of Object.entries(value)) {
    assert.ok(Number.isSafeInteger(count) && count >= 0, `${label}.${name} is a nonnegative integer`);
  }
}

test('Phase 10 surge commands use bounded, durable observations and preserve controller traffic behavior', { timeout: 180_000 }, async (t) => {
  const context = await createContext(t, 'phase10-surge');

  await t.test('strict profile, authentication, ordinary traffic compatibility, deduplication, and expired delivery', async () => {
    await prepareReady(context);
    const requestsBefore = fixture.appRequests.length;
    const invocationCount = fixture.invocations.length;
    const invalidCommands = [
      { kind: 'traffic', profile: 'unknown' },
      { kind: 'traffic', profile: null },
      { kind: 'traffic', profile: 'inventory_surge', unexpected: true },
      { kind: 'traffic', profile: 'inventory_surge', durationMs: 1 },
      { kind: 'traffic', unexpected: true },
    ];
    for (const command of invalidCommands) {
      const response = await context.api.handler(httpEvent('PUT', `/api/actions/${randomUUID()}`, command));
      assert.equal(response.statusCode, 400, response.body);
    }
    const unauthorized = httpEvent('PUT', `/api/actions/${randomUUID()}`, surgeCommand);
    unauthorized.headers.authorization = 'Bearer wrong-operator';
    assert.equal((await context.api.handler(unauthorized)).statusCode, 401);
    assert.equal(fixture.invocations.length, invocationCount);
    assert.equal(fixture.appRequests.length, requestsBefore);

    const ordinaryId = randomUUID();
    const ordinary = await call(context.api, 'PUT', `/api/actions/${ordinaryId}`, { kind: 'traffic' }, 202);
    assert.equal(ordinary.action?.trafficProfile, undefined, 'ordinary traffic retains its existing profile-free command');
    const ordinaryReplay = await call(context.api, 'PUT', `/api/actions/${ordinaryId}`, { kind: 'traffic' }, 200);
    assert.equal(ordinaryReplay.action?.id, ordinaryId);
    assert.equal(fixture.invocations.length, invocationCount + 1);
    await withElapsed(31_000, () => context.worker.handler({ actionId: ordinaryId }));
    assert.equal(fixture.appRequests.length, requestsBefore, 'an expired queued delivery cannot start ordinary traffic');

    const conflict = await context.api.handler(httpEvent('PUT', `/api/actions/${ordinaryId}`, surgeCommand));
    assert.equal(conflict.statusCode, 409, 'an ID accepted for ordinary traffic cannot be reused for surge');

    await prepareReady(context);
    const id = randomUUID();
    const accepted = await call(context.api, 'PUT', `/api/actions/${id}`, surgeCommand, 202);
    assert.deepEqual(accepted.action?.trafficProfile, surgeProfile,
      'the complete server-owned profile is persisted in the first acknowledgement');
    assert.equal(accepted.action?.trafficContext, undefined,
      'the HTTP acknowledgement does not claim worker-side settings that have not been freshly observed');
    assert.equal(accepted.action?.trafficWindow, undefined, 'the producer window starts only when the worker starts production');
    assert.equal((await getState(context.api)).lastSurgeActionId, id);
    const dispatches = fixture.invocations.length;
    const replay = await call(context.api, 'PUT', `/api/actions/${id}`, surgeCommand, 200);
    assert.deepEqual(replay.action, accepted.action, 'same ID and command return the exact saved acceptance');
    const conflicting = await context.api.handler(httpEvent('PUT', `/api/actions/${id}`, { kind: 'traffic' }));
    assert.equal(conflicting.statusCode, 409);
    assert.equal(fixture.invocations.length, dispatches, 'replay and conflicting reuse do not dispatch a second producer');
    const requestsAtExpiry = fixture.appRequests.length;
    await withElapsed(31_000, async () => {
      await context.worker.handler({ actionId: id });
      await context.worker.handler({ actionId: id });
    });
    assert.equal(fixture.appRequests.length, requestsAtExpiry, 'expired duplicate delivery cannot replay an accepted action');
  });

  await t.test('surge fails closed on stale release, denied Inventory, cap drift, or unresolved checkout', async () => {
    const cases = [
      ['stale app release', () => {
        fixture.revision = newerRevision;
        fixture.stackId = '22222222-2222-4222-8222-222222222222';
        fixture.stackLastUpdatedAt = '2026-11-13T00:00:00.000Z';
      }],
      ['denied Inventory alias', () => {
        fixture.aliasVersion.Inventory = '3';
      }],
      ['unexplained Inventory cap drift', () => {
        fixture.inventoryConcurrency = 48;
      }],
      ['changed current productVersion', () => {
        fixture.appProductVersion = 'fixture-product-v2';
      }],
      ['unresolved checkout', () => {
        row('STATE').data.unresolved.push({
          checkoutId: 'phase10-unknown-checkout', sku: 'demo-widget', quantity: 1,
          productVersion: row('STATE').data.baseline.productVersion,
          startedAt: new Date().toISOString(), status: 'unknown',
        });
      }],
    ];
    for (const [label, configure] of cases) {
      await prepareReady(context);
      configure();
      const appRequestCount = fixture.appRequests.length;
      const mutationCount = fixture.mutations.length;
      const aliasUpdates = fixture.aliasUpdates.length;
      const capacityWrites = fixture.concurrencyWrites.length;
      const id = randomUUID();
      const response = await context.api.handler(httpEvent('PUT', `/api/actions/${id}`, surgeCommand));
      assert.ok([202, 409].includes(response.statusCode), `${label}: ${response.statusCode} ${response.body}`);
      if (response.statusCode === 202) {
        await context.worker.handler({ actionId: id });
        const action = await getAction(context.api, id);
        assert.ok(['failed', 'incomplete'].includes(action.status), `${label}: unsafe surge was ${action.status}`);
      } else {
        assert.equal(row(`ACTION#${id}`), undefined, `${label}: API rejection did not persist an action`);
      }
      assert.equal(fixture.appRequests.length, appRequestCount, `${label}: no business fetch was sent`);
      assert.equal(fixture.mutations.length, mutationCount, `${label}: no AWS configuration mutation was attempted`);
      assert.equal(fixture.aliasUpdates.length, aliasUpdates, `${label}: no alias was changed`);
      assert.equal(fixture.concurrencyWrites.length, capacityWrites, `${label}: no concurrency setting was changed`);
      assert.deepEqual(fixture.unhandled, [], `${label}: the fixture accounted for all AWS operations`);
    }
  });

  await t.test('surge rejects a deadline that cannot cover the full window and bounded drain', async () => {
    await prepareReady(context);
    const { id } = await startSurge(context.api);
    row(`ACTION#${id}`).data.deadlineAt = Date.now() + 20_000;
    const appRequestCount = fixture.appRequests.length;
    await context.worker.handler({ actionId: id });
    const action = await getAction(context.api, id);
    assert.equal(action.status, 'failed', action.error);
    assert.ok(action.trafficContext, 'the worker may save its preflight context before rejecting the shortened deadline');
    assert.equal(action.trafficWindow, undefined, 'no production window starts without the full 15s plus drain budget');
    assert.equal(fixture.appRequests.length, appRequestCount, 'the rejected deadline sends no app traffic');
    assert.equal(fixture.catalogFetches.length, 0);
    assert.equal(fixture.checkoutFetches.length, 0);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('ordinary traffic keeps its existing producer window and saves worker-observed attribution', { timeout: 45_000 }, async () => {
    const ready = await prepareReady(context);
    const requestStart = fixture.appRequests.length;
    const id = randomUUID();
    await call(context.api, 'PUT', `/api/actions/${id}`, { kind: 'traffic' }, 202);
    await context.worker.handler({ actionId: id });
    const action = await getAction(context.api, id);
    assert.equal(action.status, 'completed', action.error);
    assert.equal(action.trafficProfile, undefined, 'ordinary traffic does not acquire a surge profile');
    assert.equal(action.trafficWindow, undefined, 'ordinary traffic retains its existing 15-second action shape');
    assert.equal(action.trafficApiId, 'fixtureapi');
    assert.deepEqual(action.trafficContext, {
      appRevision,
      productVersion: ready.state.baseline.productVersion,
      inventory: { cap: 16, aliasVersion: healthyVersion, access: 'healthy', memoryMb: 256 },
      checkout: { cap: 'unreserved', aliasVersion: healthyVersion, memoryMb: 256 },
    });
    const requests = fixture.appRequests.slice(requestStart);
    assert.equal(requests.filter(({ method, path }) => method === 'GET' && path === '/api/products').length, 15);
    assert.equal(requests.filter(({ method, path }) => method === 'POST' && path === '/api/checkout').length, 15);
    assert.equal(action.requests.length, 30, 'ordinary traffic keeps its durable per-request history');
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('one finite surge records actual fetches, cohort outcomes, a bounded sample, and durable checkouts', { timeout: 75_000 }, async () => {
    const ready = await prepareReady(context);
    fixture.catalogResponseDelayMs = 100;
    fixture.checkoutResponseDelayMs = 1_200;
    fixture.catalogResponseStatuses.set(1, 503);
    fixture.catalogResponseStatuses.set(2, 404);
    const rowsBefore = new Set(records.keys());
    const appRequestStart = fixture.appRequests.length;
    const { id, accepted } = await startSurge(context.api);
    assert.deepEqual(accepted.trafficProfile, surgeProfile);
    const execution = context.worker.handler({ actionId: id });
    try {
      await waitFor('initial production fetches', () => fixture.catalogFetches.length >= 20);
      blockEventLoop(150);
      const resumedAt = performance.now();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      const resumedStarts = fixture.catalogFetches.filter(({ startedAtMs }) =>
        startedAtMs >= resumedAt && startedAtMs <= resumedAt + 100).length;
      assert.ok(resumedStarts <= 40, `late catalog ticks are skipped without a catch-up burst (${resumedStarts} starts in 100 ms)`);
      await execution;

      const action = await getAction(context.api, id);
      const state = await getState(context.api);
      const observation = action.catalogObservation;
      const catalog = action.traffic.catalog;
      assert.deepEqual(action.trafficContext, {
        appRevision,
        productVersion: ready.state.baseline.productVersion,
        inventory: { cap: 16, aliasVersion: healthyVersion, access: 'healthy', memoryMb: 256 },
        checkout: { cap: 'unreserved', aliasVersion: healthyVersion, memoryMb: 256 },
      }, 'the worker records freshly observed release and current settings before production');
      assert.equal(action.trafficApiId, 'fixtureapi', 'the worker derives and saves the trusted API ID before surge sends');
      assert.equal(action.status, 'completed', action.error);
      assert.equal(action.trafficWindow.stopReason, 'duration');
      assert.ok(Date.parse(action.trafficWindow.producerStoppedAt) >= Date.parse(action.trafficWindow.scheduledEndAt));
      assert.ok(Date.parse(action.trafficWindow.settledAt) >= Date.parse(action.trafficWindow.producerStoppedAt));
      assert.equal(Date.parse(action.trafficWindow.scheduledEndAt) - Date.parse(action.trafficWindow.startedAt), surgeProfile.durationMs);
      const firstCatalogFetch = fixture.catalogFetches[0];
      const windowStartMono = Date.parse(action.trafficWindow.startedAt) - performance.timeOrigin;
      assert.ok(firstCatalogFetch.startedAtMs >= windowStartMono - 2,
        'the recorded producer window does not start after the first catalog dispatch');
      assert.ok(firstCatalogFetch.startedAtMs - windowStartMono < 100,
        'the window start is aligned with the first source dispatch after worker preflight');
      assert.equal(observation.status, 'complete');
      assert.equal(fixture.catalogFetches.length, catalog.submitted, 'submitted counts actual GET starts, not intended ticks');
      assert.equal(fixture.catalogFetches.length, catalog.completed, 'a completed action drains every actual GET');
      assert.ok(catalog.submitted <= surgeProfile.catalog.maxAttempts, 'the finite surge respects its 3,600-attempt cap');
      assert.equal(catalog.submitted + catalog.skipped, surgeProfile.catalog.maxAttempts,
        'a completed profile accounts for every scheduled catalog ordinal as a fetch or explicit skip');
      assert.ok(fixture.appRequests.slice(appRequestStart).filter(({ method, path }) => method === 'GET' && path === '/api/products')
        .every(({ surgeContextBeforeFetch }) => surgeContextBeforeFetch === true),
      'fresh release/cap/alias/access observations are saved before each surge fetch');
      assert.equal(catalog.inFlight, 0);
      assert.ok(fixture.peakCatalogInFlight > 1, 'timed catalog responses create observable concurrent fetches');
      assert.ok(observation.peakInFlight <= surgeProfile.catalog.maxInFlight);
      assert.equal(observation.peakInFlight, fixture.peakCatalogInFlight);
      assertFixedCounters(observation.outcomes, outcomeNames, 'catalog outcomes');
      assertFixedCounters(observation.skips, skipNames, 'catalog skip reasons');
      assert.equal(observation.outcomes.http5xx, 1);
      assert.equal(observation.outcomes.http4xx, 1);
      assert.equal(observation.outcomes.success, catalog.succeeded);
      assert.equal(sum(Object.values(observation.outcomes)), catalog.completed);
      assert.equal(sum(Object.values(observation.skips)), catalog.skipped);
      assert.ok(observation.skips.late > 0, 'the scheduler stall is visible as a late skip');
      assert.equal(observation.bins.length, 15);
      assert.deepEqual(observation.bins.map(({ offsetMs }) => offsetMs), Array.from({ length: 15 }, (_, index) => index * 1_000));
      for (const bin of observation.bins) {
        assert.equal(bin.durationMs, 1_000);
        assert.ok(Number.isSafeInteger(bin.observedDurationMs) && bin.observedDurationMs >= 0 && bin.observedDurationMs <= 1_000);
        assertFixedCounters(bin.outcomes, outcomeNames, `bin ${bin.offsetMs} outcomes`);
        assert.equal(sum(Object.values(bin.outcomes)), bin.completed);
        assert.equal(bin.outcomes.success, bin.succeeded);
      }
      assert.equal(sum(observation.bins.map(({ submitted }) => submitted)), catalog.submitted);
      assert.equal(sum(observation.bins.map(({ completed }) => completed)), catalog.completed);
      assert.equal(sum(observation.bins.map(({ skipped }) => skipped)), catalog.skipped);
      assert.ok(observation.samples.length <= 24);
      assert.equal(observation.sampleRule, 'first8_last8_first8_failed');
      assert.equal(typeof observation.samplesTruncated, 'boolean');
      assert.equal(new Set(observation.samples.map(({ id }) => id)).size, observation.samples.length,
        'overlapping first, last, and failure sample sets are deduplicated');
      assert.ok(observation.samples.some(({ statusCode }) => statusCode === 503));
      assert.ok(observation.samples.every((sample) => sample.id.length <= 36 &&
        Object.values(sample).every((value) => typeof value !== 'string' || value.length <= 256)),
      'retained sample strings stay within explicit small bounds');
      assert.ok(action.requests.every(({ kind }) => kind !== 'catalog'), 'surge GETs live only in the bounded sample, not durable request history');
      const appRequests = fixture.appRequests.slice(appRequestStart);
      const checkoutFetches = appRequests.filter(({ method, path }) => method === 'POST' && path === '/api/checkout');
      assert.ok(checkoutFetches.length > 0 && checkoutFetches.length <= surgeProfile.checkout.maxAttempts);
      assert.equal(checkoutFetches.length, action.traffic.checkout.submitted);
      assert.ok(action.traffic.checkout.submitted <= 15);
      assert.ok(fixture.peakCheckoutInFlight <= surgeProfile.checkout.maxInFlight);
      assert.ok(fixture.peakCheckoutInFlight > 1, 'the delayed profile checkouts exercise the two-slot bound');
      for (let index = 1; index < fixture.checkoutFetches.length; index++) {
        assert.ok(fixture.checkoutFetches[index].startedAtMs - fixture.checkoutFetches[index - 1].startedAtMs >= 850,
          'quantity-one checkouts use paced one-second ticks without catch-up');
      }
      assert.ok(checkoutFetches.every(({ durableCheckoutBeforeFetch }) => durableCheckoutBeforeFetch),
        'each immutable quantity-one checkout is durably recorded before its fetch');
      assert.ok(action.requests.filter(({ kind }) => kind === 'checkout').every(({ checkout, completedAt }) =>
        checkout?.quantity === 1 && checkout?.productVersion === ready.state.baseline.productVersion && completedAt));
      assert.deepEqual(state.unresolved, []);
      assert.equal(state.lastSurgeActionId, id);
      assert.ok(Buffer.byteLength(JSON.stringify(action)) < 64 * 1024,
        'maximum-profile action remains below the 64 KiB public JSON budget');
      const newRows = [...records.keys()].filter((key) => !rowsBefore.has(key));
      assert.deepEqual(newRows, [`ACTION#${id}`], 'catalog GETs create no per-request rows or catalog-driven run rows');
      assert.ok(fixture.catalogObservationWrites.length > 0);
      assert.ok(fixture.catalogObservationWrites.length < fixture.catalogFetches.length,
        'catalog observations are periodic rather than one durable write per GET');
      assert.deepEqual(fixture.unhandled, []);
    } finally {
      await execution;
    }
  });

  await t.test('Stop closes surge admission before drain and preserves an unknown checkout without replay', async () => {
    await prepareReady(context);
    fixture.catalogResponseMode = 'hold';
    fixture.checkoutResponseDelayMs = 2_000;
    fixture.checkoutNoResponseCount = 1;
    const stockBeforeSurge = fixture.appStock;
    const ordersBeforeSurge = new Set(fixture.appOrders.keys());
    const { id } = await startSurge(context.api);
    const execution = context.worker.handler({ actionId: id });
    try {
      await waitFor('the held surge to fill its real catalog slots', () => fixture.catalogFetches.length >= surgeProfile.catalog.maxInFlight, 25_000);
      const full = await waitFor('the first periodic snapshot of held catalog slots', async () => {
        const action = await getAction(context.api, id);
        return action.traffic.catalog.inFlight === surgeProfile.catalog.maxInFlight ? action : undefined;
      });
      assert.equal(full.traffic.catalog.inFlight, surgeProfile.catalog.maxInFlight);
      assert.equal(fixture.peakCatalogInFlight, surgeProfile.catalog.maxInFlight);
      await waitFor('full-slot skips to be recorded', async () => (await getAction(context.api, id)).traffic.catalog.skipped > 0);
      await waitFor('both paced checkout slots to be occupied', () => fixture.peakCheckoutInFlight === 2, 5_000);
      assert.equal(fixture.checkoutInFlight, 2);
      assert.equal((await getAction(context.api, id)).traffic.checkout.inFlight, 2);
      assert.ok(fixture.checkoutFetches.every(({ durableBeforeFetch }) => durableBeforeFetch),
        'all in-flight checkout payloads were persisted before their fetches');
      for (let index = 1; index < fixture.checkoutFetches.length; index++) {
        assert.ok(fixture.checkoutFetches[index].startedAtMs - fixture.checkoutFetches[index - 1].startedAtMs >= 850,
          'surge checkouts remain paced at one-second intervals');
      }
      await waitFor('the dropped Checkout response to be durably marked unknown', async () =>
        (await getAction(context.api, id)).requests.some(({ kind, outcome }) => kind === 'checkout' && outcome === 'unknown'));

      const stopId = randomUUID();
      const stop = await call(context.api, 'PUT', `/api/actions/${stopId}`, { kind: 'stop', targetActionId: id }, 202);
      assert.equal(stop.action?.kind, 'stop');
      const requested = await getAction(context.api, id);
      assert.equal(requested.status, 'draining');
      assert.equal(requested.stopRequested, true);
      const producerStopped = await waitFor('the worker acknowledgement that admissions are closed', async () => {
        const action = await getAction(context.api, id);
        return action.trafficWindow?.producerStoppedAt ? action : undefined;
      });
      assert.ok(producerStopped.trafficWindow.stopObservedAt);
      const afterProducerAcknowledgement = fixture.catalogFetches.length;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      assert.equal(fixture.catalogFetches.length, afterProducerAcknowledgement,
        'the closed producer stays closed while previously accepted requests remain held');
      const catalogAtAck = fixture.catalogFetches.length;
      const checkoutAtAck = fixture.checkoutFetches.length;
      releaseHeldCatalog();
      await execution;

      const stopped = await getAction(context.api, id);
      assert.equal(stopped.status, 'stopped');
      assert.equal(stopped.trafficWindow.stopReason, 'requested');
      assert.ok(Date.parse(stopped.trafficWindow.stopObservedAt) <= Date.parse(stopped.trafficWindow.producerStoppedAt));
      assert.ok(Date.parse(stopped.trafficWindow.producerStoppedAt) <= Date.parse(stopped.trafficWindow.settledAt));
      assert.equal(stopped.traffic.catalog.inFlight, 0);
      assert.equal(stopped.traffic.catalog.completed, stopped.traffic.catalog.submitted);
      assert.equal(stopped.catalogObservation.status, 'complete', 'a requested Stop with successful drain records exact final totals');
      assert.ok(stopped.catalogObservation.skips.full > 0);
      assert.equal(fixture.catalogFetches.length, catalogAtAck, 'drain does not reopen catalog admissions');
      assert.equal(fixture.checkoutFetches.length, checkoutAtAck, 'drain does not reopen checkout admissions');
      assert.equal(stopped.traffic.checkout.inFlight, 0);
      assert.equal(stopped.traffic.checkout.completed, stopped.traffic.checkout.submitted);
      const unknownCheckout = stopped.requests.find(({ kind, outcome }) => kind === 'checkout' && outcome === 'unknown');
      assert.ok(unknownCheckout?.checkout?.checkoutId);
      assert.equal(fixture.appOrders.has(unknownCheckout.checkout.checkoutId), false,
        'the unknown checkout was not fabricated as a completed Order');
      assert.ok((await getState(context.api)).unresolved.some(({ checkoutId }) => checkoutId === unknownCheckout.checkout.checkoutId),
        'a 404 status read keeps the unknown checkout ID in the run for later reconciliation');
      const newOrders = [...fixture.appOrders.keys()].filter((checkoutId) => !ordersBeforeSurge.has(checkoutId));
      assert.equal(stockBeforeSurge - fixture.appStock, newOrders.length,
        'only successful fresh checkouts changed stock');
      const requestsAtDrain = fixture.appRequests.length;
      await context.worker.handler({ actionId: id });
      const replay = await call(context.api, 'PUT', `/api/actions/${stopId}`, { kind: 'stop', targetActionId: id }, 200);
      assert.equal(replay.action?.id, stopId);
      assert.equal(fixture.appRequests.length, requestsAtDrain, 'duplicate delivery and Stop replay add no business sends');
      assert.equal(fixture.catalogInFlight, 0);
      assert.deepEqual(fixture.unhandled, []);
    } finally {
      fixture.catalogResponseMode = 'immediate';
      releaseHeldCatalog();
      await execution;
    }
  });

  await t.test('slow periodic persistence exposes checkpoint skips and a failed later observation remains incomplete', async () => {
    await prepareReady(context);
    fixture.catalogResponseDelayMs = 80;
    fixture.catalogObservationWriteDelayMs = 300;
    fixture.beforeCatalogObservationWrite = async () => {
      if (fixture.catalogObservationWrites.filter(({ committed }) => committed).length >= 2) {
        fixture.catalogObservationWriteFailure = true;
      }
    };
    fixture.checkoutNoResponseCount = 1;
    const { id } = await startSurge(context.api);
    const execution = context.worker.handler({ actionId: id });
    await execution;
    const persistedWrites = fixture.catalogObservationWrites.filter(({ committed }) => committed);
    const failedWrites = fixture.catalogObservationWrites.filter(({ outcome }) => outcome === 'write_failed');

    const saved = await getAction(context.api, id);
    assert.equal(saved.status, 'incomplete', saved.error);
    assert.equal(saved.trafficWindow.stopReason, 'observation_failure');
    assert.equal(saved.catalogObservation.status, 'partial');
    assert.ok(persistedWrites.length >= 2, 'two periodic observations committed before the selected failure');
    assert.ok(failedWrites.length >= 1, 'a later catalog observation was rejected by the fixture');
    const lastSuccessful = persistedWrites.at(-1);
    assert.equal(saved.catalogObservation.observedThrough, lastSuccessful.observedThrough,
      'the public snapshot remains at the last successful checkpoint');
    assert.ok(saved.catalogObservation.skips.checkpoint > 0,
      `elapsed ordinals during slow persistence are counted as checkpoint skips: ${JSON.stringify({
        skips: saved.catalogObservation.skips,
        writes: fixture.catalogObservationWrites.map(({ observedThrough, startedAt, completedAtMs, startedAtMs, skips, catalogCounters }) =>
          ({ observedThrough, startedAt, durationMs: completedAtMs === undefined ? undefined : completedAtMs - startedAtMs, skips, catalogCounters })),
      })}`);
    assert.ok(lastSuccessful.completedAtMs - lastSuccessful.startedAtMs >= 250,
      'the fixture delayed the real observation transaction rather than changing the producer clock');
    const unknown = saved.requests.find(({ kind, outcome }) => kind === 'checkout' && outcome === 'unknown');
    assert.ok(unknown?.checkout?.checkoutId);
    assert.ok((await getState(context.api)).unresolved.some(({ checkoutId }) => checkoutId === unknown.checkout.checkoutId),
      'observation failure preserves an unresolved checkout ID');
    for (const write of persistedWrites.slice(0, 2)) {
      const sumBins = (field) => write.bins.reduce((total, bin) => total + bin[field], 0);
      assert.equal(write.catalogCounters.submitted, sumBins('submitted'),
        'the action counters and cohort snapshot share one submission boundary');
      assert.equal(write.catalogCounters.completed, sumBins('completed'),
        'the action counters and cohort snapshot share one completion boundary');
      assert.equal(write.catalogCounters.succeeded, sumBins('succeeded'));
      assert.equal(write.catalogCounters.skipped, sumBins('skipped'));
      assert.equal(sum(Object.values(write.skips)), write.catalogCounters.skipped);
      for (const name of outcomeNames) {
        assert.equal(write.outcomes[name], write.bins.reduce((total, bin) => total + bin.outcomes[name], 0),
          `the ${name} aggregate and start cohorts come from the same checkpoint`);
      }
    }
    const fetchCount = fixture.catalogFetches.length;
    await context.worker.handler({ actionId: id });
    assert.equal(fixture.catalogFetches.length, fetchCount, 'incomplete action redelivery does not replay the producer');
    assert.ok(fixture.catalogFetches.every(({ completedAt }) => completedAt), 'all requests accepted before failure were drained');
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('Stop during Checkout admission cancels the durable reservation without a fetch or unresolved ID', async () => {
    await prepareReady(context);
    fixture.catalogResponseMode = 'hold';
    const { id } = await startSurge(context.api);
    fixture.admissionReadDelayActionId = id;
    fixture.admissionReadDelayRemaining = 1;
    fixture.admissionReadDelayMs = 300;
    const execution = context.worker.handler({ actionId: id });
    try {
      await waitFor('the post-reservation admission read', () => fixture.admissionReadDelayStarted, 5_000);
      assert.equal(fixture.checkoutFetches.length, 0, 'the reservation is durable before the fetch admission check');
      const stopId = randomUUID();
      await call(context.api, 'PUT', `/api/actions/${stopId}`, { kind: 'stop', targetActionId: id }, 202);
      await waitFor('producer closure after the concurrent Stop', async () =>
        (await getAction(context.api, id)).trafficWindow?.producerStoppedAt);
      releaseHeldCatalog();
      await execution;
      const action = await getAction(context.api, id);
      const cancelled = action.requests.find(({ kind, outcome }) => kind === 'checkout' && outcome === 'not_sent');
      assert.ok(cancelled?.checkout?.checkoutId, 'the immutable reserved payload remains auditable');
      assert.equal(cancelled.completedAt !== undefined, true);
      assert.equal(cancelled.statusCode, undefined, 'known-not-sent does not invent an HTTP response');
      assert.equal(action.traffic.checkout.submitted, fixture.checkoutFetches.length,
        'submitted counts only actual fetches');
      assert.equal(action.traffic.checkout.completed, fixture.checkoutFetches.length,
        'completed counts only actual fetch responses');
      assert.equal(action.traffic.checkout.skipped, 1, 'the canceled scheduled tick is reported as skipped');
      assert.equal(action.traffic.checkout.inFlight, 0);
      assert.equal((await getState(context.api)).unresolved.some(({ checkoutId }) => checkoutId === cancelled.checkout.checkoutId), false,
        'a known-unsent checkout is not left unresolved');
      assert.deepEqual(fixture.unhandled, []);
    } finally {
      fixture.catalogResponseMode = 'immediate';
      releaseHeldCatalog();
      await execution;
    }
  });

  await t.test('a Stop observed after the scheduled end does not move the producer closure time', { timeout: 35_000 }, async () => {
    await prepareReady(context);
    const { id } = await startSurge(context.api);
    fixture.checkoutReservationDelayActionId = id;
    fixture.checkoutReservationDelayCount = surgeProfile.checkout.maxAttempts;
    fixture.checkoutReservationDelayMs = 2_500;
    const execution = context.worker.handler({ actionId: id });
    try {
      await waitFor('the final durable checkout reservation to pause before admission', () =>
        fixture.checkoutReservationDelayStarted, 20_000);
      const running = await getAction(context.api, id);
      assert.ok(running.trafficWindow?.scheduledEndAt, 'the actual producer window is already persisted');
      const scheduledEnd = Date.parse(running.trafficWindow.scheduledEndAt);
      await waitFor('the scheduled production end to pass', () => Date.now() >= scheduledEnd + 150, 3_000);
      const stopId = randomUUID();
      await call(context.api, 'PUT', `/api/actions/${stopId}`, { kind: 'stop', targetActionId: id }, 202);
      await waitFor('the worker to observe the late Stop', async () =>
        (await getAction(context.api, id)).trafficWindow?.stopObservedAt, 3_000);
      await execution;

      const stopped = await getAction(context.api, id);
      assert.equal(stopped.status, 'stopped', stopped.error);
      assert.equal(stopped.trafficWindow.stopReason, 'duration', 'a Stop after the duration does not replace the scheduled close reason');
      assert.equal(stopped.trafficWindow.producerStoppedAt, stopped.trafficWindow.scheduledEndAt,
        'producerStoppedAt reports the actual scheduled admission boundary, not late bookkeeping');
      assert.ok(Date.parse(stopped.trafficWindow.stopObservedAt) > scheduledEnd,
        'the separately recorded Stop observation remains truthful when it arrives after production ended');
      assert.equal(fixture.checkoutFetches.length, stopped.traffic.checkout.submitted,
        'the delayed reservation is not counted as a submitted fetch');
      const notSent = stopped.requests.find(({ kind, outcome }) => kind === 'checkout' && outcome === 'not_sent');
      assert.ok(notSent?.checkout?.checkoutId, 'the immutable final checkout remains recorded');
      assert.equal(notSent.statusCode, undefined, 'the worker does not invent an HTTP response for a blocked fetch');
      assert.equal(stopped.traffic.checkout.inFlight, 0);
      assert.equal(stopped.traffic.checkout.skipped, 1);
      assert.equal((await getState(context.api)).unresolved.some(({ checkoutId }) => checkoutId === notSent.checkout.checkoutId), false);
      assert.deepEqual(fixture.unhandled, []);
    } finally {
      await execution;
    }
  });

  await t.test('a failed Stop read closes admissions and leaves a partial action', async () => {
    await prepareReady(context);
    fixture.catalogResponseMode = 'hold';
    const { id } = await startSurge(context.api);
    const execution = context.worker.handler({ actionId: id });
    try {
      await waitFor('an actual held catalog fetch', () => fixture.catalogFetches.length > 0);
      fixture.stopReadFailureActionId = id;
      fixture.stopReadFailureRemaining = 1;
      const stopId = randomUUID();
      await call(context.api, 'PUT', `/api/actions/${stopId}`, { kind: 'stop', targetActionId: id }, 202);
      await waitFor('the targeted Stop read failure', () => fixture.stopReadFailureRemaining === 0);
      const closedAt = fixture.catalogFetches.length;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      assert.equal(fixture.catalogFetches.length, closedAt, 'a Stop read failure cannot reopen catalog admissions');
      releaseHeldCatalog();
      await execution;
      const incomplete = await getAction(context.api, id);
      assert.equal(incomplete.status, 'incomplete');
      assert.equal(incomplete.trafficWindow.stopReason, 'observation_failure');
      assert.notEqual(incomplete.catalogObservation.status, 'complete');
      assert.equal(fixture.catalogFetches.length, closedAt);
      assert.equal(fixture.stopReadFailures.length, 1);
      const readsAtEnd = fixture.catalogFetches.length;
      await context.worker.handler({ actionId: id });
      assert.equal(fixture.catalogFetches.length, readsAtEnd, 'the incomplete Stop-read action cannot be redelivered into new sends');
      assert.deepEqual(fixture.unhandled, []);
    } finally {
      fixture.catalogResponseMode = 'immediate';
      releaseHeldCatalog();
      await execution;
    }
  });

  await t.test('a setting-only increase is followed by an explicit same-profile repeat at 32 and Recover to 16', { timeout: 75_000 }, async () => {
    const initial = await prepareReady(context);
    fixture.catalogResponseMode = 'hold';
    const first = await startSurge(context.api);
    const firstExecution = context.worker.handler({ actionId: first.id });
    let repeatExecution;
    try {
      await waitFor('the first at-cap-16 surge fetch', () => fixture.catalogFetches.length > 0);
      const firstStopId = randomUUID();
      await call(context.api, 'PUT', `/api/actions/${firstStopId}`, { kind: 'stop', targetActionId: first.id }, 202);
      await waitFor('first surge producer stop acknowledgement', async () =>
        (await getAction(context.api, first.id)).trafficWindow?.producerStoppedAt);
      releaseHeldCatalog();
      await firstExecution;
      const firstFinished = await getAction(context.api, first.id);
      assert.equal(firstFinished.trafficContext.inventory.cap, 16);
      assert.equal(firstFinished.trafficContext.appRevision, appRevision);
      assert.equal(firstFinished.trafficContext.productVersion, initial.state.baseline.productVersion);

      const appRequestsBeforeCapacity = fixture.appRequests.length;
      const ordersBeforeCapacity = structuredClone([...fixture.appOrders.entries()]);
      const inventoryCapacityId = await submit(context.api, 'increase_capacity', { function: 'inventory', reservedConcurrency: 32 });
      await context.worker.handler({ actionId: inventoryCapacityId });
      const capacity = await getAction(context.api, inventoryCapacityId);
      assert.equal(capacity.status, 'completed', capacity.error);
      assert.equal(capacity.capacityChange?.before, 16);
      assert.equal(capacity.capacityChange?.readback, 32);
      assert.equal(fixture.appRequests.length, appRequestsBeforeCapacity, 'the setting-only action sends no business traffic');
      assert.deepEqual([...fixture.appOrders.entries()], ordersBeforeCapacity, 'the setting-only action preserves every existing Order');
      assert.equal(fixture.aliasVersion.Inventory, healthyVersion);
      assert.equal(fixture.aliasVersion.Checkout, healthyVersion);
      assert.equal(fixture.baselineMemoryMb, 256);

      fixture.catalogResponseMode = 'hold';
      const repeat = await startSurge(context.api);
      assert.deepEqual(repeat.accepted.trafficProfile, first.accepted.trafficProfile,
        'the repeat uses the exact profile that ran at 16');
      assert.equal(repeat.accepted.previousSurgeActionId, first.id);
      repeatExecution = context.worker.handler({ actionId: repeat.id });
      const catalogFetchesBeforeRepeat = fixture.catalogFetches.length;
      await waitFor('the at-cap-32 repeat fetch', () => fixture.catalogFetches.length > catalogFetchesBeforeRepeat);
      const runningRepeat = await getAction(context.api, repeat.id);
      assert.deepEqual(runningRepeat.trafficContext, {
        appRevision,
        productVersion: initial.state.baseline.productVersion,
        inventory: { cap: 32, aliasVersion: healthyVersion, access: 'healthy', memoryMb: 256 },
        checkout: { cap: 'unreserved', aliasVersion: healthyVersion, memoryMb: 256 },
      }, 'the context is freshly read after the setting-only increase and before the repeat sends traffic');
      const repeatStopId = randomUUID();
      await call(context.api, 'PUT', `/api/actions/${repeatStopId}`, { kind: 'stop', targetActionId: repeat.id }, 202);
      await waitFor('repeat producer stop acknowledgement', async () =>
        (await getAction(context.api, repeat.id)).trafficWindow?.producerStoppedAt);
      releaseHeldCatalog();
      await repeatExecution;
      const repeatFinished = await getAction(context.api, repeat.id);
      assert.equal(repeatFinished.status, 'stopped');
      assert.equal((await getState(context.api)).lastSurgeActionId, repeat.id);
      assert.equal((await getAction(context.api, first.id)).id, first.id, 'the earlier baseline action remains readable');

      fixture.catalogResponseMode = 'immediate';
      const ordersBeforeRecover = structuredClone([...fixture.appOrders.entries()]);
      const receiptsBeforeRecover = structuredClone((await getState(context.api)).receipts);
      const recoverId = await submit(context.api, 'recover', { confirmQuiet: true });
      await context.worker.handler({ actionId: recoverId });
      const recovered = await getAction(context.api, recoverId);
      const finalState = await getState(context.api);
      assert.equal(recovered.status, 'completed', recovered.error);
      assert.equal(recovered.capRestoration?.inventory?.target, 16);
      assert.equal(recovered.capRestoration?.inventory?.readback, 16);
      assert.equal(finalState.baseline?.settings?.inventory?.cap, 16);
      assert.equal(finalState.originalBaseline?.settings?.inventory?.cap, 16);
      for (const [checkoutId, order] of ordersBeforeRecover) assert.deepEqual(fixture.appOrders.get(checkoutId), order);
      assert.equal(fixture.appOrders.size, ordersBeforeRecover.length + 1, 'Recover adds its verification Order without deleting prior Orders');
      for (const receipt of receiptsBeforeRecover) assert.ok(finalState.receipts.some(({ checkoutId }) => checkoutId === receipt.checkoutId));
      assert.equal(finalState.unresolved.length, 0);
      assert.deepEqual(fixture.unhandled, []);
      assert.ok(initial.state.baseline.productVersion);
    } finally {
      fixture.catalogResponseMode = 'immediate';
      releaseHeldCatalog();
      await firstExecution;
      if (repeatExecution) await repeatExecution;
    }
  });

});
