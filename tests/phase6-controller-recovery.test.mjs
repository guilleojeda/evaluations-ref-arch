import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  appFetch, awsEnvironment, deniedRoleArn, fixture, getAction, getState,
  httpEvent, inventoryRoleArn, newerRevision, releaseHeld, reset, root, row, startAwsServer, submit,
} from './support/phase3-inventory-controller-harness.mjs';

const higherHealthy = { memoryMb: 512, access: 'healthy', version: '4', roleArn: inventoryRoleArn };
const higherDenied = { memoryMb: 512, access: 'denied', version: '5', roleArn: deniedRoleArn };
const healthyVersion = '2';
const deniedVersion = '3';

function addHigherMemoryVariants() {
  fixture.extraVariants = [structuredClone(higherHealthy), structuredClone(higherDenied)];
}

function currentCap(value) {
  return value === 'unreserved' ? undefined : value;
}

function setBaselineCaps({ inventory = 'unreserved', checkout = 'unreserved' } = {}) {
  fixture.inventoryExpectedConcurrency = inventory;
  fixture.checkoutExpectedConcurrency = checkout;
  fixture.inventoryConcurrency = currentCap(inventory);
  fixture.checkoutConcurrency = currentCap(checkout);
  const run = row('STATE').data;
  run.baseline.settings.inventory.cap = inventory;
  run.baseline.settings.checkout.cap = checkout;
  run.originalBaseline = structuredClone(run.baseline);
}

function seedBaselineOrder() {
  const run = row('STATE').data;
  const order = structuredClone(run.baseline.receipt);
  if (!run.receipts.some(({ checkoutId }) => checkoutId === order.checkoutId)) run.receipts.push(order);
  fixture.appOrders.set(order.checkoutId, order);
  return order;
}

function seedCommittedUnknownCheckout(checkoutId = randomUUID()) {
  const run = row('STATE').data;
  const payload = { checkoutId, sku: 'demo-widget', quantity: 1, productVersion: 'fixture-product-v1' };
  const order = { checkoutId: payload.checkoutId, sku: payload.sku, quantity: payload.quantity,
    unitPriceCents: 1299, totalPriceCents: 1299, currency: 'USD',
    createdAt: new Date().toISOString(), status: 'placed' };
  run.unresolved.push({ ...payload, startedAt: new Date().toISOString(), status: 'unknown' });
  fixture.appOrders.set(checkoutId, order);
  fixture.appStock -= 1;
  return order;
}

function seedMissingUnknownCheckout(checkoutId = randomUUID()) {
  const run = row('STATE').data;
  const payload = { checkoutId, sku: 'demo-widget', quantity: 1, productVersion: 'fixture-product-v1' };
  run.unresolved.push({ ...payload, startedAt: new Date().toISOString(), status: 'unknown' });
  return payload;
}

async function prepareDeniedAt512({ api, worker, baselineInventoryCap = 'unreserved', baselineCheckoutCap = 'unreserved',
  currentInventoryCap, currentCheckoutCap } = {}) {
  reset();
  addHigherMemoryVariants();
  setBaselineCaps({ inventory: baselineInventoryCap, checkout: baselineCheckoutCap });
  fixture.appMode = 'selected-variant';

  const readinessId = await submit(api, 'readiness', { confirmQuiet: true });
  await worker.handler({ actionId: readinessId });
  const readiness = await getAction(api, readinessId);
  assert.equal(readiness.status, 'completed', readiness.error);
  const readyState = await getState(api);
  assert.equal(readyState.originalBaseline?.settings?.inventory?.memory, 256,
    'public readiness records the trusted deployment baseline before incident changes');

  const activationId = await submit(api, 'activate_inventory_denial');
  await worker.handler({ actionId: activationId });
  const activation = await getAction(api, activationId);
  assert.equal(activation.status, 'completed', activation.error);
  assert.equal(fixture.aliasVersion.Inventory, deniedVersion);

  const memoryId = await submit(api, 'increase_memory', { function: 'inventory', memoryMb: 512 });
  await worker.handler({ actionId: memoryId });
  const memory = await getAction(api, memoryId);
  assert.equal(memory.status, 'completed', memory.error);
  assert.equal(fixture.aliasVersion.Inventory, higherDenied.version);

  if (currentInventoryCap !== undefined) fixture.inventoryConcurrency = currentCap(currentInventoryCap);
  if (currentCheckoutCap !== undefined) fixture.checkoutConcurrency = currentCap(currentCheckoutCap);
  return { readinessId, activationId, memoryId, activation, memory };
}

async function acceptRecover(api, id = randomUUID(), extra = {}) {
  const command = { kind: 'recover', confirmQuiet: true, ...extra };
  const response = await api.handler(httpEvent('PUT', `/api/actions/${id}`, command));
  assert.equal(response.statusCode, 202, `PUT /api/actions/${id}: ${response.body}`);
  const body = JSON.parse(response.body);
  assert.equal(body.action?.id, id);
  assert.equal(body.action?.kind, 'recover');
  assert.deepEqual(body.action?.command, command);
  return id;
}

async function runRecover({ api, worker, id = randomUUID(), extra = {} }) {
  const actionId = await acceptRecover(api, id, extra);
  await worker.handler({ actionId });
  return { id: actionId, action: await getAction(api, actionId), state: await getState(api) };
}

async function waitFor(description, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function configurationMutations() {
  return fixture.mutations.filter((entry) => /^(Put|Delete)FunctionConcurrency|^UpdateAlias/.test(entry));
}

function checkpointValue(item) {
  return typeof item.body === 'string' ? JSON.parse(item.body) : item.body;
}

function assertCheckpointPrecedesAllSettingsWrites(startIndex = 0) {
  const checkpointIndex = fixture.trace.findLastIndex((entry, index) => index >= startIndex && entry.type === 'checkpoint-stored');
  const settingWriteIndexes = fixture.trace.flatMap((entry, index) =>
    index >= startIndex && ['alias-update-attempt', 'alias-update', 'concurrency-attempt', 'concurrency-update'].includes(entry.type)
      ? [index] : []);
  assert.ok(checkpointIndex >= 0, 'Recover must durably capture current configuration before mutation');
  assert.ok(settingWriteIndexes.length > 0, 'the changed configuration must be restored');
  assert.ok(settingWriteIndexes.every((index) => index > checkpointIndex),
    'the stored active-state checkpoint must precede every alias or cap change');
}

test('authenticated Recover restores the trusted baseline and verifies a fresh order', { timeout: 120_000 }, async (t) => {
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
  const api = await import(`${backendPath}?phase6-recover=${Date.now()}`);
  const worker = await import(`${workerPath}?phase6-recover=${Date.now()}`);

  await t.test('restores baseline memory and positive caps, reconciles an ambiguous order by status, then verifies one new order', async () => {
    const { readinessId, activationId, memoryId } = await prepareDeniedAt512({ api, worker,
      baselineInventoryCap: 40, baselineCheckoutCap: 30,
      currentInventoryCap: 80, currentCheckoutCap: 90 });
    const preservedReceipt = seedBaselineOrder();
    const ambiguous = seedCommittedUnknownCheckout();
    const before = await getState(api);
    const stockBeforeRecover = fixture.appStock;
    const beforeActionCount = fixture.invocations.length;
    const beforeRequestCount = fixture.appRequests.length;
    const beforeTraceCount = fixture.trace.length;
    const beforeMutations = configurationMutations().length;
    const originalBaseline = structuredClone(before.originalBaseline);
    const existingActions = [readinessId, activationId, memoryId];

    const { id, action, state } = await runRecover({ api, worker });
    assert.equal(action.status, 'completed', action.error);
    assert.equal(action.configurationOutcome, 'applied');
    assert.equal(fixture.aliasVersion.Inventory, healthyVersion,
      'Recover returns to the original healthy 256 MB version, not the previously active 512 MB setting');
    assert.deepEqual(action.inventorySwitch?.target, { memoryMb: 256, access: 'healthy', version: healthyVersion,
      roleArn: inventoryRoleArn });
    assert.deepEqual(fixture.concurrencyWrites.map(({ name, previous, next, method }) => ({ name, previous, next, method }))
      .sort((left, right) => left.name.localeCompare(right.name)), [
      { name: 'Checkout', previous: 90, next: 30, method: 'PUT' },
      { name: 'Inventory', previous: 80, next: 40, method: 'PUT' },
    ].sort((left, right) => left.name.localeCompare(right.name)));
    assertCheckpointPrecedesAllSettingsWrites(beforeTraceCount);
    const capture = checkpointValue(fixture.checkpointObjects.at(-1));
    assert.equal(capture.settings?.inventory?.version, higherDenied.version);
    assert.equal(capture.settings?.inventory?.memory, 512);
    assert.equal(capture.settings?.inventory?.role, deniedRoleArn);
    assert.equal(capture.settings?.inventory?.cap, 80);
    assert.equal(capture.settings?.checkout?.cap, 90);

    const recoveryRequests = fixture.appRequests.slice(beforeRequestCount);
    assert.equal(recoveryRequests.filter(({ method, path }) => method === 'POST' && path === '/api/checkout').length, 1,
      'Recover sends one new verification checkout and never retries the earlier ambiguous checkout');
    assert.ok(recoveryRequests.some(({ method, path }) => method === 'GET' && path === `/api/orders/${ambiguous.checkoutId}`),
      'Recover reconciles the submitted checkout through the order-status endpoint');
    const newCheckout = action.requests.find(({ kind }) => kind === 'checkout');
    assert.ok(newCheckout, 'the fresh verification checkout is durably recorded');
    assert.equal(newCheckout.checkout?.quantity, 1);
    assert.equal(newCheckout.checkout?.productVersion, before.baseline.productVersion);
    assert.notEqual(newCheckout.checkout?.checkoutId, ambiguous.checkoutId);
    assert.ok(action.requests.some(({ kind, checkoutId }) => kind === 'order_status' && checkoutId === ambiguous.checkoutId));
    assert.ok(action.requests.some(({ kind, checkoutId }) => kind === 'order_status' && checkoutId === newCheckout.checkout?.checkoutId),
      'the fresh receipt is confirmed through status reconciliation');

    assert.equal(state.unresolved.length, 0);
    assert.deepEqual(state.originalBaseline, originalBaseline, 'Recover does not replace its trusted target with current incident settings');
    assert.equal(state.latestStock, fixture.appStock);
    assert.equal(state.latestStock, stockBeforeRecover - 1,
      'the fresh quantity-one order changes stock once after the earlier committed order was reconciled');
    assert.ok(state.receipts.some((receipt) => receipt.checkoutId === preservedReceipt.checkoutId),
      'the prior baseline order is preserved');
    assert.ok(state.receipts.some((receipt) => receipt.checkoutId === ambiguous.checkoutId),
      'status reconciliation retains the earlier committed order');
    assert.ok(state.incident?.activationActionId === activationId ||
      state.incidentHistory?.some(({ activationActionId: priorId }) => priorId === activationId),
    'the earlier denial record remains inspectable after recovery');
    const freshReceipt = state.receipts.find((receipt) => receipt.checkoutId === newCheckout.checkout?.checkoutId);
    assert.equal(freshReceipt?.quantity, 1);
    assert.equal(state.receipts.length, before.receipts.length + 2);
    assert.equal(state.budgets.checkout.generatorRemaining, before.budgets.checkout.generatorRemaining,
      'Recover uses its verification allowance, not the generator allowance');
    assert.equal(state.budgets.checkout.verificationRemaining, before.budgets.checkout.verificationRemaining - 1);
    assert.equal(state.budgets.catalog.remaining, before.budgets.catalog.remaining - 2);
    assert.equal(state.budgets.orderStatus.remaining, before.budgets.orderStatus.remaining - 2);
    assert.equal(fixture.invocations.length, beforeActionCount + 1, 'one accepted Recover action is dispatched');
    for (const priorActionId of existingActions) assert.ok(await getAction(api, priorActionId), 'prior action history remains readable');
    assert.equal(configurationMutations().length, beforeMutations + 3);
    assert.deepEqual(fixture.unhandled, []);

    const requestCountAfterRecovery = fixture.appRequests.length;
    const duplicate = await api.handler(httpEvent('PUT', `/api/actions/${id}`, { kind: 'recover', confirmQuiet: true }));
    assert.equal(duplicate.statusCode, 200);
    assert.equal(JSON.parse(duplicate.body).action?.id, id);
    assert.equal(fixture.appRequests.length, requestCountAfterRecovery,
      'repeating the same action ID does not repeat probes or verification');
    assert.equal(fixture.invocations.length, beforeActionCount + 1);
    assert.equal(configurationMutations().length, beforeMutations + 3);
    const conflicting = await api.handler(httpEvent('PUT', `/api/actions/${id}`, { kind: 'traffic' }));
    assert.equal(conflicting.statusCode, 409, 'reusing the Recover ID for another command is rejected');
  });

  await t.test('restores an explicit unreserved cap with DeleteFunctionConcurrency', async () => {
    await prepareDeniedAt512({ api, worker, baselineInventoryCap: 'unreserved', baselineCheckoutCap: 'unreserved',
      currentInventoryCap: 70 });
    fixture.appMode = 'selected-variant';
    const { action, state } = await runRecover({ api, worker });
    assert.equal(action.status, 'completed', action.error);
    assert.equal(action.configurationOutcome, 'applied');
    assert.deepEqual(fixture.concurrencyWrites, [
      { name: 'Inventory', previous: 70, next: 'unreserved', method: 'DELETE' },
    ], 'unreserved is restored by deleting the cap; zero is not used as a substitute');
    assert.equal(state.originalBaseline.settings.inventory.cap, 'unreserved');
    assert.equal(fixture.inventoryConcurrency, undefined);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('a 404 does not settle an unknown checkout or trigger a POST retry', async () => {
    await prepareDeniedAt512({ api, worker });
    const ambiguous = seedMissingUnknownCheckout();
    const beforeRequests = fixture.appRequests.length;
    const { action, state } = await runRecover({ api, worker });
    assert.ok(['failed', 'incomplete'].includes(action.status));
    assert.notEqual(action.status, 'completed', 'a single 404 cannot prove that the earlier transaction did not commit');
    assert.equal(action.configurationOutcome, 'applied', 'safe configuration restoration remains distinct from business verification');
    assert.match(action.error ?? '', /unresolved|unknown|settle|verification|checkout/i);
    assert.equal(fixture.aliasVersion.Inventory, healthyVersion);
    assert.ok(state.unresolved.some(({ checkoutId }) => checkoutId === ambiguous.checkoutId));
    const recoveryRequests = fixture.appRequests.slice(beforeRequests);
    assert.ok(recoveryRequests.some(({ method, path }) => method === 'GET' && path === `/api/orders/${ambiguous.checkoutId}`));
    assert.equal(recoveryRequests.filter(({ method, path, body }) => method === 'POST' && path === '/api/checkout' &&
      body?.checkoutId === ambiguous.checkoutId).length, 0, 'Recover never resubmits the ambiguous identity');
    assert.equal(recoveryRequests.filter(({ method, path }) => method === 'POST' && path === '/api/checkout').length, 0,
      'fresh verification waits until the earlier checkout is settled');
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('Recover stops active producers, drains submitted work, then changes configuration', async () => {
    await prepareDeniedAt512({ api, worker });
    const restoreId = await submit(api, 'restore_inventory_access');
    await worker.handler({ actionId: restoreId });
    assert.equal((await getAction(api, restoreId)).status, 'completed');
    assert.equal(fixture.aliasVersion.Inventory, higherHealthy.version,
      'traffic is held at healthy 512 MB so its already submitted checkout can commit');
    fixture.appMode = 'hold';
    fixture.heldReleaseMode = 'selected-variant';
    const stockBeforeTraffic = fixture.appStock;
    const beforeTrafficRequestCount = fixture.appRequests.length;
    const trafficId = await submit(api, 'traffic');
    const trafficRun = worker.handler({ actionId: trafficId });
    let recoverRun;
    try {
      await waitFor('held catalog and checkout requests', () =>
        fixture.heldRequests.size === 2 && fixture.appRequests.length >= beforeTrafficRequestCount + 2);
      const beforeAliasUpdates = fixture.aliasUpdates.length;
      const beforeCapWrites = fixture.concurrencyWrites.length;
      const id = await acceptRecover(api);
      const stateAfterAccept = await getState(api);
      assert.equal(stateAfterAccept.currentActionId, trafficId);
      assert.equal(stateAfterAccept.configurationActionId, id,
        'Recover uses the configuration action lane while the primary traffic action retains its pointer');
      const draining = await getAction(api, trafficId);
      assert.equal(draining.status, 'draining');
      assert.equal(draining.stopRequested, true, 'acceptance immediately stops new producer submissions');
      assert.ok(draining.traffic.catalog.inFlight > 0 && draining.traffic.checkout.inFlight > 0,
        'the already submitted catalog and checkout work remains visible while draining');
      const acceptedTrafficRequests = fixture.appRequests.length;

      let trafficStatusAtAliasUpdate;
      fixture.beforeAliasUpdate = async () => {
        trafficStatusAtAliasUpdate = (await getAction(api, trafficId)).status;
      };
      recoverRun = worker.handler({ actionId: id });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      assert.equal(fixture.aliasUpdates.length, beforeAliasUpdates, 'no alias change starts before accepted requests settle');
      assert.equal(fixture.concurrencyWrites.length, beforeCapWrites, 'no cap change starts before accepted requests settle');
      assert.equal(fixture.appRequests.length, acceptedTrafficRequests,
        'the stop request prevents any additional producer submissions during drain');

      releaseHeld();
      await Promise.all([trafficRun, recoverRun]);
      recoverRun = undefined;
      const traffic = await getAction(api, trafficId);
      assert.equal(traffic.status, 'stopped');
      assert.equal(traffic.traffic.catalog.inFlight, 0);
      assert.equal(traffic.traffic.checkout.inFlight, 0);
      assert.equal(trafficStatusAtAliasUpdate, 'stopped', 'the worker waits for drain completion before alias mutation');
      const recovery = await getAction(api, id);
      assert.equal(recovery.status, 'completed', recovery.error);
      assert.equal(recovery.requests.filter(({ kind }) => kind === 'catalog').length, 2);
      assert.equal(recovery.requests.filter(({ kind }) => kind === 'checkout').length, 1);
      assert.equal(recovery.requests.filter(({ kind }) => kind === 'order_status').length, 1);
      const trafficCheckout = traffic.requests.find(({ kind }) => kind === 'checkout');
      assert.equal(trafficCheckout?.outcome, 'success', 'the accepted held checkout settles successfully before restoration');
      assert.ok((await getState(api)).receipts.some(({ checkoutId }) => checkoutId === trafficCheckout?.checkout?.checkoutId),
        'Recover retains the order receipt produced by traffic that it drained');
      assert.equal(fixture.appStock, stockBeforeTraffic - 2,
        'one drained traffic order and one fresh verification order each decrement stock once');
      assert.deepEqual(fixture.unhandled, []);
    } finally {
      if (trafficRun) {
        try {
          const currentTraffic = await getAction(api, trafficId);
          if (['queued', 'running', 'draining'].includes(currentTraffic.status)) {
            await submit(api, 'stop', { targetActionId: trafficId });
          }
        } catch {
          // Release held fixture responses below even when an expected-red request failed.
        }
      }
      releaseHeld();
      await Promise.all([trafficRun, recoverRun].filter(Boolean));
    }
  });

  await t.test('exhausted verification allowance does not block configuration restoration or claim recovery', async () => {
    await prepareDeniedAt512({ api, worker, baselineInventoryCap: 45, currentInventoryCap: 75 });
    const run = row('STATE').data;
    run.budgets.checkout.verificationRemaining = 0;
    const budgetsBefore = structuredClone(run.budgets);
    const beforeRequests = fixture.appRequests.length;
    const { action, state } = await runRecover({ api, worker });
    assert.ok(['failed', 'incomplete'].includes(action.status), 'configuration can restore while business verification remains incomplete');
    assert.equal(action.configurationOutcome, 'applied');
    assert.match(action.error ?? '', /allowance|budget|verification|checkout/i);
    assert.equal(fixture.aliasVersion.Inventory, healthyVersion);
    assert.deepEqual(fixture.concurrencyWrites.map(({ name, next }) => ({ name, next })), [{ name: 'Inventory', next: 45 }]);
    assert.equal(fixture.appRequests.length, beforeRequests,
      'Recover does not begin an unfinishable app-verification sequence after its POST allowance is exhausted');
    assert.notEqual(action.status, 'completed', 'restored settings alone are not successful business recovery');
    assert.deepEqual(state.budgets, budgetsBefore);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('catalog or order-status exhaustion prevents an unfinishable verification sequence', async () => {
    for (const [budget, remaining] of [['catalog', 1], ['orderStatus', 0]]) {
      await prepareDeniedAt512({ api, worker });
      const run = row('STATE').data;
      if (budget === 'catalog') run.budgets.catalog.remaining = remaining;
      else run.budgets.orderStatus.remaining = remaining;
      const before = await getState(api);
      const beforeRequests = fixture.appRequests.length;
      const { action, state } = await runRecover({ api, worker });
      assert.ok(['failed', 'incomplete'].includes(action.status), `${budget} exhaustion leaves effect verification incomplete`);
      assert.equal(action.configurationOutcome, 'applied');
      assert.match(action.error ?? '', /allowance|budget|catalog|status|verification/i);
      assert.equal(fixture.aliasVersion.Inventory, healthyVersion, 'safe settings restoration still finishes');
      assert.equal(fixture.appRequests.length, beforeRequests,
        `Recover checks all needed ${budget} allowances before starting a partial business-verification sequence`);
      assert.equal(state.budgets[budget === 'catalog' ? 'catalog' : 'orderStatus'].remaining, remaining);
      assert.deepEqual(state.budgets, before.budgets, 'a skipped verification sequence does not charge any partial allowance');
      assert.notEqual(action.status, 'completed');
      assert.deepEqual(fixture.unhandled, []);
      assert.ok(before.originalBaseline.settings.inventory.memory === 256);
    }
  });

  await t.test('a new-generation 512 MB readiness cannot establish the original baseline; later higher readiness preserves 256 MB', async () => {
    reset({ revision: newerRevision, baselineRevision: newerRevision });
    addHigherMemoryVariants();
    fixture.stackId = '22222222-2222-4222-8222-222222222222';
    fixture.stackLastUpdatedAt = '2026-11-10T00:00:00.000Z';
    fixture.aliasVersion.Inventory = higherHealthy.version;
    fixture.aliasRevision = 'alias-revision-2';
    fixture.appMode = 'selected-variant';
    const firstRun = row('STATE').data;
    firstRun.baseline = null;
    delete firstRun.originalBaseline;
    const requestsBefore = fixture.appRequests.length;
    const budgetsBefore = structuredClone((await getState(api)).budgets);

    const prematureId = await submit(api, 'readiness', { confirmQuiet: true });
    await worker.handler({ actionId: prematureId });
    const premature = await getAction(api, prematureId);
    assert.ok(['failed', 'incomplete'].includes(premature.status),
      'a new generation cannot use a healthy 512 MB alias to invent its original 256 MB readiness record');
    assert.match(premature.error ?? '', /baseline|memory|256|original|generation/i);
    assert.equal(fixture.appRequests.length, requestsBefore, 'no business probe is sent before the trusted baseline configuration is selected');
    const unadopted = await getState(api);
    assert.equal(unadopted.baseline, null);
    assert.equal(unadopted.originalBaseline, undefined);
    assert.deepEqual(unadopted.budgets, budgetsBefore, 'failed baseline adoption does not consume or renew run allowances');

    reset({ revision: newerRevision, baselineRevision: newerRevision });
    addHigherMemoryVariants();
    fixture.stackId = '22222222-2222-4222-8222-222222222222';
    fixture.stackLastUpdatedAt = '2026-11-10T00:00:00.000Z';
    fixture.appMode = 'selected-variant';
    const run = row('STATE').data;
    run.baseline = null;
    delete run.originalBaseline;

    const baselineId = await submit(api, 'readiness', { confirmQuiet: true });
    await worker.handler({ actionId: baselineId });
    assert.equal((await getAction(api, baselineId)).status, 'completed');
    let state = await getState(api);
    assert.equal(state.baseline.settings.inventory.memory, 256);
    assert.equal(state.originalBaseline.settings.inventory.memory, 256);

    const memoryId = await submit(api, 'increase_memory', { function: 'inventory', memoryMb: 512 });
    await worker.handler({ actionId: memoryId });
    assert.equal((await getAction(api, memoryId)).status, 'completed');
    assert.equal(fixture.aliasVersion.Inventory, higherHealthy.version);
    const higherReadinessId = await submit(api, 'readiness', { confirmQuiet: true });
    await worker.handler({ actionId: higherReadinessId });
    const higherReadiness = await getAction(api, higherReadinessId);
    assert.equal(higherReadiness.status, 'completed', higherReadiness.error);
    state = await getState(api);
    assert.equal(state.baseline.settings.inventory.memory, 512);
    assert.equal(state.originalBaseline.settings.inventory.memory, 256,
      'readiness at a supported higher size does not replace the established recovery target');
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('stale, unknown, failed stack, code drift and credential-generation drift block before mutation', async () => {
    const rejected = async (configure, expectedError) => {
      await prepareDeniedAt512({ api, worker, currentInventoryCap: 80 });
      configure();
      const beforeRequests = fixture.appRequests.length;
      const beforeAliasUpdates = fixture.aliasUpdates.length;
      const beforeCheckpoints = fixture.checkpointObjects.length;
      const { action } = await runRecover({ api, worker });
      assert.ok(['failed', 'incomplete'].includes(action.status));
      assert.match(action.error ?? '', expectedError);
      assert.equal(fixture.aliasUpdates.length, beforeAliasUpdates,
        'a stale recovery target does not update the alias');
      assert.equal(fixture.concurrencyWrites.length, 0);
      assert.equal(fixture.checkpointObjects.length, beforeCheckpoints,
        'the failed Recover does not create a misleading pre-mutation checkpoint');
      assert.equal(fixture.appRequests.length, beforeRequests, 'a rejected stale target sends no application requests');
      assert.deepEqual(fixture.unhandled, []);
    };

    await rejected(() => { fixture.stackStatus = 'UPDATE_IN_PROGRESS'; }, /stack|release|successful|deployment/i);
    await rejected(() => { fixture.stackId = '33333333-3333-4333-8333-333333333333'; },
      /generation|stack|release|baseline|deployment/i);
    await rejected(() => { fixture.stackLastUpdatedAt = '2026-11-11T00:00:00.000Z'; },
      /generation|stack|release|baseline|deployment/i);
    await rejected(() => { fixture.revision = newerRevision; }, /release|revision|baseline|deployment/i);
    await rejected(() => {
      fixture.versionOverrides[`Inventory:${higherDenied.version}`] = { codeSha256: 'wrong-code' };
    }, /code|configuration|manifest|release/i);
    await rejected(() => { fixture.credentialGeneration = 'rotated-generation'; }, /credential|generation|release|baseline/i);
  });

  await t.test('checkpoint failure, alias conflict, and unobserved alias acknowledgement cannot claim recovery', async () => {
    await prepareDeniedAt512({ api, worker, currentInventoryCap: 80 });
    fixture.checkpointMode = 'fail';
    const beforeCaptureRequests = fixture.appRequests.length;
    const beforeCaptureAliasUpdates = fixture.aliasUpdates.length;
    const failedCapture = await runRecover({ api, worker });
    assert.ok(['failed', 'incomplete'].includes(failedCapture.action.status));
    assert.match(failedCapture.action.error ?? '', /checkpoint|capture|evidence|storage/i);
    assert.equal(fixture.aliasUpdates.length, beforeCaptureAliasUpdates, 'a missing capture blocks the baseline alias update');
    assert.equal(fixture.concurrencyWrites.length, 0, 'a missing capture blocks cap changes');
    assert.equal(fixture.appRequests.length, beforeCaptureRequests, 'a missing capture sends no recovery probes');
    const changedConsent = await api.handler(httpEvent('PUT', `/api/actions/${failedCapture.id}`,
      { kind: 'recover', confirmQuiet: true, recoverWithoutEvidence: true }));
    assert.equal(changedConsent.statusCode, 409, 'evidence-loss confirmation is part of the immutable action input');

    await prepareDeniedAt512({ api, worker, currentInventoryCap: 80 });
    fixture.checkpointMode = 'fail';
    const protectiveTraceStart = fixture.trace.length;
    const protective = await runRecover({ api, worker, extra: { recoverWithoutEvidence: true } });
    assert.equal(protective.action.status, 'completed', protective.action.error);
    assert.equal(protective.action.configurationOutcome, 'applied');
    assert.equal(fixture.aliasVersion.Inventory, healthyVersion);
    assert.equal(fixture.checkpointObjects.length, 2, 'no unavailable capture is falsely recorded as stored');
    assert.match(protective.action.configurationCheckpoint?.status ?? '', /unavailable|incomplete/);
    const checkpointAttempt = fixture.trace.findIndex((entry, index) => index >= protectiveTraceStart && entry.type === 'checkpoint-attempt');
    const firstSettingWrite = fixture.trace.findIndex((entry, index) => index >= protectiveTraceStart &&
      ['alias-update-attempt', 'alias-update', 'concurrency-attempt', 'concurrency-update'].includes(entry.type));
    assert.ok(checkpointAttempt >= 0 && firstSettingWrite > checkpointAttempt,
      'explicit protective consent is recorded before the mutation that proceeds without stored evidence');
    assert.equal(protective.action.requests.filter(({ kind }) => kind === 'checkout').length, 1,
      'explicit capture consent does not skip business verification');

    await prepareDeniedAt512({ api, worker, currentInventoryCap: 80 });
    fixture.aliasMode = 'conflict';
    const before = fixture.appRequests.length;
    const beforeTrace = fixture.trace.length;
    const beforeAliasAttempts = fixture.aliasUpdateAttempts.length;
    const beforeAliasUpdates = fixture.aliasUpdates.length;
    const conflict = await runRecover({ api, worker });
    assert.ok(['failed', 'incomplete'].includes(conflict.action.status));
    assert.match(conflict.action.error ?? '', /revision|conflict|precondition|alias|unknown/i);
    assert.equal(fixture.aliasVersion.Inventory, higherDenied.version);
    assert.equal(fixture.aliasUpdateAttempts.length, beforeAliasAttempts + 1, 'the failed CAS is not retried');
    assert.equal(fixture.aliasUpdates.length, beforeAliasUpdates);
    assert.equal(fixture.appRequests.length, before, 'an unconfirmed target is not probed as healthy');
    assertCheckpointPrecedesAllSettingsWrites(beforeTrace);

    await prepareDeniedAt512({ api, worker, currentInventoryCap: 80 });
    fixture.aliasMode = 'lost-no-observation';
    const beforeUnknownRequests = fixture.appRequests.length;
    const beforeUnknownAliasAttempts = fixture.aliasUpdateAttempts.length;
    const beforeUnknownAliasUpdates = fixture.aliasUpdates.length;
    const unknown = await runRecover({ api, worker });
    assert.equal(unknown.action.status, 'incomplete');
    assert.equal(unknown.action.configurationOutcome, 'unknown');
    assert.equal(fixture.aliasVersion.Inventory, higherDenied.version);
    assert.equal(fixture.aliasUpdateAttempts.length, beforeUnknownAliasAttempts + 1, 'one uncertain Recover alias write is not resent');
    assert.equal(fixture.aliasUpdates.length, beforeUnknownAliasUpdates);
    assert.equal(fixture.appRequests.length, beforeUnknownRequests, 'the unknown alias is not used for business verification');
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('a lost alias acknowledgement is reconciled by readback without a second update', async () => {
    await prepareDeniedAt512({ api, worker, currentInventoryCap: 80 });
    fixture.aliasMode = 'lost-ack';
    const beforeRequests = fixture.appRequests.length;
    const beforeBudgets = await getState(api);
    const beforeAliasAttempts = fixture.aliasUpdateAttempts.length;
    const beforeAliasUpdates = fixture.aliasUpdates.length;
    const { action, state } = await runRecover({ api, worker });
    assert.equal(action.status, 'completed', action.error);
    assert.equal(action.configurationOutcome, 'applied');
    assert.equal(action.inventorySwitch?.after?.functionVersion, healthyVersion);
    assert.equal(fixture.aliasVersion.Inventory, healthyVersion);
    assert.equal(fixture.aliasUpdateAttempts.length, beforeAliasAttempts + 1, 'the uncertain Recover is sent once');
    assert.equal(fixture.aliasUpdates.length, beforeAliasUpdates + 1, 'readback confirms Recover applied despite the lost response');
    assert.ok(fixture.aliasReads.filter(({ name }) => name === 'Inventory').some(({ version }) => version === healthyVersion));
    const recoveryRequests = fixture.appRequests.slice(beforeRequests);
    assert.equal(recoveryRequests.filter(({ method, path }) => method === 'GET' && path === '/api/products').length, 2);
    assert.equal(recoveryRequests.filter(({ method, path }) => method === 'POST' && path === '/api/checkout').length, 1);
    assert.equal(recoveryRequests.filter(({ method, path }) => method === 'GET' && path.startsWith('/api/orders/')).length, 1,
      'verification occurs only after readback confirms the healthy alias');
    assert.equal(state.budgets.checkout.verificationRemaining, beforeBudgets.budgets.checkout.verificationRemaining - 1);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('a cap write lost acknowledgement reconciles by readback without retry', async () => {
    await prepareDeniedAt512({ api, worker, baselineInventoryCap: 45, currentInventoryCap: 75 });
    fixture.concurrencyMode = 'lost-ack';
    const beforeRequests = fixture.appRequests.length;
    const beforeState = await getState(api);
    const beforeAttempts = fixture.concurrencyAttempts.length;
    const beforeWrites = fixture.concurrencyWrites.length;
    const beforeReads = fixture.concurrencyReads.length;
    const { action, state } = await runRecover({ api, worker });
    assert.equal(action.status, 'completed', action.error);
    assert.equal(action.configurationOutcome, 'applied');
    assert.equal(fixture.inventoryConcurrency, 45);
    assert.equal(fixture.concurrencyAttempts.length, beforeAttempts + 1);
    assert.equal(fixture.concurrencyWrites.length, beforeWrites + 1,
      'the cap changed once even though its response was lost');
    assert.ok(fixture.concurrencyReads.slice(beforeReads).some(({ name, cap }) => name === 'Inventory' && cap === 45),
      'a readback confirms the selected cap');
    assert.equal(fixture.appRequests.slice(beforeRequests).filter(({ method, path }) => method === 'POST' && path === '/api/checkout').length, 1);
    assert.equal(state.budgets.checkout.verificationRemaining, beforeState.budgets.checkout.verificationRemaining - 1,
      'the verification request is charged once after settings are reconciled');
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('failed or unobserved cap changes do not retry or claim recovery', async () => {
    for (const mode of ['fail', 'lost-no-observation']) {
      await prepareDeniedAt512({ api, worker, baselineInventoryCap: 45, currentInventoryCap: 75 });
      fixture.concurrencyMode = mode;
      const beforeRequests = fixture.appRequests.length;
      const beforeAttempts = fixture.concurrencyAttempts.length;
      const beforeWrites = fixture.concurrencyWrites.length;
      const { action } = await runRecover({ api, worker });
      assert.ok(['failed', 'incomplete'].includes(action.status), `${mode} cannot complete recovery`);
      assert.notEqual(action.status, 'completed');
      assert.match(action.error ?? '', /concurr|cap|unknown|observ|reconcil|permission/i);
      assert.equal(fixture.concurrencyAttempts.length, beforeAttempts + 1, 'a failed or ambiguous cap write is not blindly retried');
      assert.equal(fixture.concurrencyWrites.length, beforeWrites, 'the configured failure modes do not apply the target cap');
      assert.equal(fixture.inventoryConcurrency, 75);
      assert.equal(fixture.appRequests.length, beforeRequests, 'business verification waits until configuration is confirmed');
      if (mode === 'lost-no-observation') assert.equal(action.configurationOutcome, 'unknown');
      assert.deepEqual(fixture.unhandled, []);
    }
  });

  await t.test('healthy no-op Recover still verifies once and ignores same-ID or late worker replay', async () => {
    reset();
    fixture.appMode = 'selected-variant';
    const readinessId = await submit(api, 'readiness', { confirmQuiet: true });
    await worker.handler({ actionId: readinessId });
    assert.equal((await getAction(api, readinessId)).status, 'completed');
    const before = await getState(api);
    const beforeRequests = fixture.appRequests.length;
    const beforeInvocations = fixture.invocations.length;
    const beforeAliasUpdates = fixture.aliasUpdates.length;
    const beforeCapAttempts = fixture.concurrencyAttempts.length;

    const { id, action, state } = await runRecover({ api, worker });
    assert.equal(action.status, 'completed', action.error);
    assert.equal(action.configurationOutcome, 'no_change');
    assert.equal(fixture.aliasUpdates.length, beforeAliasUpdates);
    assert.equal(fixture.concurrencyAttempts.length, beforeCapAttempts);
    assert.equal(state.budgets.checkout.verificationRemaining, before.budgets.checkout.verificationRemaining - 1);
    assert.equal(state.budgets.catalog.remaining, before.budgets.catalog.remaining - 2);
    assert.equal(state.budgets.orderStatus.remaining, before.budgets.orderStatus.remaining - 1);
    assert.equal(fixture.appRequests.slice(beforeRequests).filter(({ method, path }) => method === 'POST' && path === '/api/checkout').length, 1);

    const duplicate = await api.handler(httpEvent('PUT', `/api/actions/${id}`, { kind: 'recover', confirmQuiet: true }));
    assert.equal(duplicate.statusCode, 200);
    await worker.handler({ actionId: id });
    const replayRequests = fixture.appRequests.slice(beforeRequests);
    assert.equal(replayRequests.filter(({ method, path }) => method === 'GET' && path === '/api/products').length, 2);
    assert.equal(replayRequests.filter(({ method, path }) => method === 'POST' && path === '/api/checkout').length, 1);
    assert.equal(replayRequests.filter(({ method, path }) => method === 'GET' && path.startsWith('/api/orders/')).length, 1);
    assert.equal(fixture.invocations.length, beforeInvocations + 1);
    assert.equal(fixture.aliasUpdates.length, beforeAliasUpdates);
    assert.equal(fixture.concurrencyAttempts.length, beforeCapAttempts);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('missing or false quiet confirmation rejects before dispatch', async () => {
    reset();
    for (const command of [{ kind: 'recover' }, { kind: 'recover', confirmQuiet: false }]) {
      const id = randomUUID();
      const response = await api.handler(httpEvent('PUT', `/api/actions/${id}`, command));
      assert.equal(response.statusCode, 400);
    }
    assert.deepEqual(fixture.invocations, []);
    assert.deepEqual(fixture.mutations, []);
    assert.deepEqual(fixture.appRequests, []);
  });

  await t.test('Recover requires fresh readiness when legacy records lack deployment-generation facts', async () => {
    reset();
    fixture.appMode = 'selected-variant';
    const before = await getState(api);
    const { action, state } = await runRecover({ api, worker });
    assert.ok(['failed', 'incomplete'].includes(action.status),
      'matching source revision alone cannot attest a legacy baseline to the current successful deployment');
    assert.match(action.error ?? '', /generation|baseline|readiness|release|reconcil/i);
    assert.deepEqual(configurationMutations(), [], 'unverified generation facts cannot authorize configuration restoration');
    assert.deepEqual(fixture.appRequests, [], 'fresh readiness is required before Recover can claim business verification');
    assert.deepEqual(state.budgets, before.budgets);
    assert.deepEqual(state.originalBaseline, before.originalBaseline);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('readiness cannot adopt a new release while a checkout remains unknown without an incident', async () => {
    reset({ baselineRevision: newerRevision, revision: newerRevision });
    fixture.stackId = '55555555-5555-4555-8555-555555555555';
    fixture.stackLastUpdatedAt = '2026-11-11T02:00:00.000Z';
    const unresolved = seedMissingUnknownCheckout();
    const before = await getState(api);
    const readinessId = await submit(api, 'readiness', { confirmQuiet: true });
    await worker.handler({ actionId: readinessId });
    const readiness = await getAction(api, readinessId);
    assert.ok(['failed', 'incomplete'].includes(readiness.status));
    assert.match(readiness.error ?? '', /settle|unknown|checkout/i);
    assert.deepEqual(fixture.appRequests, [], 'readiness sends no new business request while an earlier checkout is unresolved');
    const after = await getState(api);
    assert.equal(after.unresolved.length, 1);
    assert.deepEqual({ checkoutId: after.unresolved[0].checkoutId, sku: after.unresolved[0].sku,
      quantity: after.unresolved[0].quantity, productVersion: after.unresolved[0].productVersion }, unresolved,
    'the original checkout identity and immutable input remain unresolved');
    assert.deepEqual(after.budgets, before.budgets, 'blocked readiness does not consume or replenish any allowance');
    assert.deepEqual(after.baseline, before.baseline);
    assert.deepEqual(after.originalBaseline, before.originalBaseline);
    assert.equal(after.incident, undefined, 'this case has no incident to trigger the settlement guard');
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('explicit readiness can adopt a healthy new release after a stale incident without resetting budgets', async () => {
    const { activationId } = await prepareDeniedAt512({ api, worker });
    const oldIncidentId = (await getState(api)).incident.activationActionId;
    assert.equal(oldIncidentId, activationId);

    fixture.revision = newerRevision;
    fixture.stackId = '44444444-4444-4444-8444-444444444444';
    fixture.stackLastUpdatedAt = '2026-11-11T01:00:00.000Z';
    fixture.credentialGeneration = 'fixture-generation-next';
    fixture.manifestCodeSha256 = 'fixture-code-next';
    fixture.aliasVersion.Inventory = healthyVersion;
    fixture.aliasRevision = 'alias-revision-4';
    fixture.inventoryConcurrency = currentCap(fixture.inventoryExpectedConcurrency);
    fixture.checkoutConcurrency = currentCap(fixture.checkoutExpectedConcurrency);
    fixture.appMode = 'selected-variant';
    const before = await getState(api);
    const priorReceiptIds = before.receipts.map(({ checkoutId }) => checkoutId);
    const beforeBudget = structuredClone(before.budgets);

    const readinessId = await submit(api, 'readiness', { confirmQuiet: true });
    await worker.handler({ actionId: readinessId });
    const readiness = await getAction(api, readinessId);
    assert.equal(readiness.status, 'completed', readiness.error);
    const after = await getState(api);
    assert.equal(after.baseline.appRevision, newerRevision);
    assert.equal(after.baseline.settings.inventory.memory, 256);
    assert.equal(fixture.manifestReads.at(-1)?.key, `releases/app/${newerRevision}/inventory-variants.json`);
    const newCheckoutConfiguration = fixture.configurationReads.filter(({ name }) => name === 'Checkout').at(-1);
    assert.equal(newCheckoutConfiguration?.CodeSha256, 'fixture-code-next');
    assert.equal(newCheckoutConfiguration?.Environment?.Variables?.SOURCE_REVISION, newerRevision);
    const newInventoryConfiguration = fixture.configurationReads.findLast(({ name, version }) =>
      name === 'Inventory' && version === healthyVersion);
    assert.equal(newInventoryConfiguration?.CodeSha256, 'fixture-code-next');
    assert.equal(newInventoryConfiguration?.Environment?.Variables?.SOURCE_REVISION, newerRevision);
    assert.equal(after.budgets.checkout.generatorRemaining, beforeBudget.checkout.generatorRemaining);
    assert.equal(after.budgets.checkout.verificationRemaining, beforeBudget.checkout.verificationRemaining - 1);
    assert.equal(after.budgets.catalog.remaining, beforeBudget.catalog.remaining - 2);
    assert.equal(after.budgets.orderStatus.remaining, beforeBudget.orderStatus.remaining - 1);
    for (const receiptId of priorReceiptIds) assert.ok(after.receipts.some(({ checkoutId }) => checkoutId === receiptId));
    assert.ok(after.incident?.activationActionId === oldIncidentId ||
      after.incidentHistory?.some(({ activationActionId }) => activationActionId === oldIncidentId),
    'the old incident remains inspectable after current-release readiness adoption');
    assert.ok(await getAction(api, activationId), 'the old incident action remains inspectable');
    assert.ok(after.originalBaseline?.settings?.inventory?.memory === 256,
      'explicit readiness adopts the new trusted generation at its 256 MB baseline');
    assert.deepEqual(fixture.unhandled, []);
  });
});
