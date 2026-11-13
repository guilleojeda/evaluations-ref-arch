import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  appFetch, appRevision, awsEnvironment, call, deniedRoleArn, deniedVersion, fixture, getAction, getState, healthyVersion, httpEvent,
  inventoryRoleArn, newerRevision, reset, root, row, startAwsServer, submit,
} from './support/phase3-inventory-controller-harness.mjs';

const inventoryReleaseCap = 16;
const higherInventoryCap = 32;
const maximumInventoryCap = 64;
const unrecordedInventoryCap = 48;
const capacityCommand = (reservedConcurrency = higherInventoryCap) => ({
  kind: 'increase_capacity', function: 'inventory', reservedConcurrency,
});
const higherHealthy = { memoryMb: 512, access: 'healthy', version: '4', roleArn: inventoryRoleArn };
const higherDenied = { memoryMb: 512, access: 'denied', version: '5', roleArn: deniedRoleArn };

function setInventoryCap(cap, releaseCap = cap) {
  fixture.inventoryExpectedConcurrency = releaseCap;
  fixture.inventoryConcurrency = cap === 'unreserved' ? undefined : cap;
}

async function prepareReady({ inventoryCap = inventoryReleaseCap, releaseCap = inventoryCap, memoryVariants = false } = {}, { api, worker }) {
  reset();
  setInventoryCap(inventoryCap, releaseCap);
  fixture.appMode = 'selected-variant';
  if (memoryVariants) fixture.extraVariants = [structuredClone(higherHealthy), structuredClone(higherDenied)];

  const readinessId = await submit(api, 'readiness', { confirmQuiet: true });
  await worker.handler({ actionId: readinessId });
  const readiness = await getAction(api, readinessId);
  assert.equal(readiness.status, 'completed', readiness.error);
  const state = await getState(api);
  assert.equal(state.baseline?.settings?.inventory?.cap, inventoryCap);
  assert.equal(state.originalBaseline?.settings?.inventory?.cap, inventoryCap);
  return { readinessId, readiness, state };
}

async function prepareCurrentReleaseOverStaleUnreservedBaseline(context) {
  const previous = await prepareReady({ inventoryCap: 'unreserved', releaseCap: 'unreserved' }, context);
  fixture.revision = newerRevision;
  fixture.stackId = '22222222-2222-4222-8222-222222222222';
  fixture.stackLastUpdatedAt = '2026-11-13T00:00:00.000Z';
  fixture.inventoryExpectedConcurrency = inventoryReleaseCap;
  fixture.inventoryConcurrency = higherInventoryCap;
  fixture.appMode = 'selected-variant';
  return previous.state;
}

async function runCapacity({ api, worker }, reservedConcurrency = higherInventoryCap, id = randomUUID()) {
  const command = capacityCommand(reservedConcurrency);
  const accepted = await call(api, 'PUT', `/api/actions/${id}`, command, 202);
  assert.equal(accepted.action?.id, id);
  assert.deepEqual(accepted.action?.command, command);
  await worker.handler({ actionId: id });
  return { id, action: await getAction(api, id), state: await getState(api) };
}

async function runAction({ api, worker }, kind, extra = {}) {
  const id = await submit(api, kind, extra);
  await worker.handler({ actionId: id });
  return { id, action: await getAction(api, id), state: await getState(api) };
}

function checkpointBody(checkpoint) {
  if (typeof checkpoint.body === 'string') return JSON.parse(checkpoint.body);
  if (Buffer.isBuffer(checkpoint.body)) return JSON.parse(checkpoint.body.toString('utf8'));
  return checkpoint.body;
}

function assertCapacityChange(action, expected) {
  assert.equal(action.capacityChange?.function, 'inventory');
  for (const [key, value] of Object.entries(expected)) assert.equal(action.capacityChange?.[key], value, key);
}

function assertNoTrafficOrAliasChanges(snapshot) {
  assert.equal(fixture.appRequests.length, snapshot.appRequests, 'capacity actions do not probe business routes');
  assert.equal(fixture.appStock, snapshot.stock, 'capacity actions do not change stock');
  const orders = [...fixture.appOrders.entries()].map(([id, order]) => [id, structuredClone(order)])
    .sort(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(orders, snapshot.orders, 'capacity actions preserve complete order records');
  assert.deepEqual(fixture.aliasVersion, snapshot.aliasVersion, 'capacity actions do not move aliases');
  assert.equal(fixture.aliasRevision, snapshot.aliasRevision, 'capacity actions do not revise aliases');
  assert.equal(fixture.checkoutConcurrency, snapshot.checkoutConcurrency, 'Inventory capacity actions leave Checkout unchanged');
  assert.deepEqual(fixture.versionOverrides, snapshot.versionOverrides, 'capacity actions do not alter version memory or code configuration');
  assert.equal(fixture.baselineMemoryMb, snapshot.baselineMemoryMb);
  assert.equal(fixture.inventoryExpectedVersion, snapshot.inventoryExpectedVersion);
  assert.equal(fixture.inventoryExpectedConcurrency, snapshot.inventoryExpectedConcurrency,
    'capacity actions do not change the published release expectation');
  assert.equal(fixture.healthyRoleAttached, snapshot.healthyRoleAttached, 'capacity actions preserve Inventory role state');
  assert.equal(fixture.deniedRoleAttached, snapshot.deniedRoleAttached, 'capacity actions preserve denied-role state');
  assert.deepEqual(fixture.iamPolicyDocument, snapshot.iamPolicyDocument, 'capacity actions preserve the Inventory access policy');
}

function sideEffectSnapshot() {
  return {
    appRequests: fixture.appRequests.length,
    stock: fixture.appStock,
    orders: [...fixture.appOrders.entries()].map(([id, order]) => [id, structuredClone(order)])
      .sort(([left], [right]) => left.localeCompare(right)),
    aliasVersion: structuredClone(fixture.aliasVersion),
    aliasRevision: fixture.aliasRevision,
    checkoutConcurrency: fixture.checkoutConcurrency,
    versionOverrides: structuredClone(fixture.versionOverrides),
    baselineMemoryMb: fixture.baselineMemoryMb,
    inventoryExpectedVersion: fixture.inventoryExpectedVersion,
    inventoryExpectedConcurrency: fixture.inventoryExpectedConcurrency,
    healthyRoleAttached: fixture.healthyRoleAttached,
    deniedRoleAttached: fixture.deniedRoleAttached,
    iamPolicyDocument: structuredClone(fixture.iamPolicyDocument),
  };
}

test('Inventory capacity controls are bounded, captured, reconciled, and recoverable', { timeout: 180_000 }, async (t) => {
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
  const importSuffix = `phase9-capacity=${Date.now()}`;
  const api = await import(`${backendPath}?${importSuffix}`);
  const worker = await import(`${workerPath}?${importSuffix}`);
  const context = { api, worker };

  await t.test('public Readiness at release cap 16 establishes the original baseline at 16', async () => {
    const ready = await prepareReady({}, context);
    assert.equal(ready.readiness.status, 'completed', ready.readiness.error);
    assert.equal(ready.state.baseline.settings.inventory.cap, inventoryReleaseCap);
    assert.equal(ready.state.originalBaseline.settings.inventory.cap, inventoryReleaseCap);
    assert.equal(ready.state.originalBaseline.deploymentIdentity.inventoryCap, inventoryReleaseCap);
    assert.equal(fixture.inventoryConcurrency, inventoryReleaseCap);
    assert.equal(fixture.inventoryExpectedConcurrency, inventoryReleaseCap);
    assert.equal(ready.state.baseline.stockBefore - ready.state.baseline.stockAfter, 1,
      'the normal readiness checkout remains part of the release baseline');
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('authentication, strict inputs, UUID conflicts, and replay keep one durable command', async () => {
    await prepareReady({}, context);
    const beforeAppRequests = fixture.appRequests.length;
    const beforeWrites = fixture.concurrencyAttempts.length;
    const beforeCheckpoints = fixture.checkpointObjects.length;
    const invalid = [
      { kind: 'increase_capacity', function: 'inventory' },
      { ...capacityCommand(), function: 'unknown' },
      { ...capacityCommand(), function: 'checkout' },
      { ...capacityCommand(), reservedConcurrency: 0 },
      { ...capacityCommand(), reservedConcurrency: 4.5 },
      { ...capacityCommand(), reservedConcurrency: inventoryReleaseCap - 1 },
      { ...capacityCommand(), reservedConcurrency: maximumInventoryCap + 1 },
      { ...capacityCommand(), reservedConcurrency: '4' },
      { ...capacityCommand(), unexpected: true },
    ];
    for (const body of invalid) {
      const response = await api.handler(httpEvent('PUT', `/api/actions/${randomUUID()}`, body));
      assert.equal(response.statusCode, 400, response.body);
    }
    assert.equal((await api.handler(httpEvent('PUT', '/api/actions/not-a-uuid', capacityCommand()))).statusCode, 404);
    const unauthorized = httpEvent('PUT', `/api/actions/${randomUUID()}`, capacityCommand());
    unauthorized.headers.authorization = 'Bearer wrong-operator';
    assert.equal((await api.handler(unauthorized)).statusCode, 401);
    assert.equal(fixture.appRequests.length, beforeAppRequests);
    assert.equal(fixture.concurrencyAttempts.length, beforeWrites);
    assert.equal(fixture.checkpointObjects.length, beforeCheckpoints);

    const beforeDispatches = fixture.invocations.length;
    const id = randomUUID();
    const accepted = await call(api, 'PUT', `/api/actions/${id}`, capacityCommand(), 202);
    assert.equal(accepted.action?.id, id);
    assert.deepEqual(accepted.action?.command, capacityCommand());
    const queuedReplay = await api.handler(httpEvent('PUT', `/api/actions/${id}`, capacityCommand()));
    assert.equal(queuedReplay.statusCode, 200);
    assert.equal(JSON.parse(queuedReplay.body).action?.id, id);
    const conflicting = await api.handler(httpEvent('PUT', `/api/actions/${id}`, capacityCommand(higherInventoryCap + 1)));
    assert.equal(conflicting.statusCode, 409, 'reusing an accepted ID with different capacity input is rejected');
    assert.deepEqual(fixture.invocations.slice(beforeDispatches), [id], 'one accepted ID dispatches only one worker action');

    await worker.handler({ actionId: id });
    const completed = await getAction(api, id);
    assert.equal(completed.status, 'completed', completed.error);
    const attempts = fixture.concurrencyAttempts.length;
    const writes = fixture.concurrencyWrites.length;
    const checkpoints = fixture.checkpointObjects.length;
    const requests = fixture.appRequests.length;
    const replay = await api.handler(httpEvent('PUT', `/api/actions/${id}`, capacityCommand()));
    assert.equal(replay.statusCode, 200);
    await worker.handler({ actionId: id });
    assert.equal(fixture.concurrencyAttempts.length, attempts);
    assert.equal(fixture.concurrencyWrites.length, writes);
    assert.equal(fixture.checkpointObjects.length, checkpoints);
    assert.equal(fixture.appRequests.length, requests);
    assert.equal(fixture.inventoryConcurrency, higherInventoryCap);
  });

  await t.test('missing readiness, Reset-required state, and queued traffic block capacity without side effects', async () => {
    await prepareReady({}, context);
    const missingBaselineId = randomUUID();
    const baselineRequests = fixture.appRequests.length;
    const baselineDispatches = fixture.invocations.length;
    row('STATE').data.baseline = null;
    const missingBaseline = await api.handler(httpEvent('PUT', `/api/actions/${missingBaselineId}`, capacityCommand()));
    assert.equal(missingBaseline.statusCode, 409);
    assert.equal(JSON.parse(missingBaseline.body).code, 'READINESS_REQUIRED');
    assert.equal(row(`ACTION#${missingBaselineId}`), undefined);
    assert.equal(fixture.invocations.length, baselineDispatches);
    assert.equal(fixture.appRequests.length, baselineRequests);
    assert.equal(fixture.concurrencyAttempts.length, 0);

    await prepareReady({}, context);
    const resetBlockedId = randomUUID();
    const requestsBeforeResetGuard = fixture.appRequests.length;
    const dispatchesBeforeResetGuard = fixture.invocations.length;
    row('STATE').data.resetRequired = true;
    const resetBlocked = await api.handler(httpEvent('PUT', `/api/actions/${resetBlockedId}`, capacityCommand()));
    assert.equal(resetBlocked.statusCode, 409);
    assert.equal(JSON.parse(resetBlocked.body).code, 'RESET_REQUIRED');
    assert.equal(row(`ACTION#${resetBlockedId}`), undefined, 'Reset-required state does not accept a capacity action');
    assert.equal((await getState(api)).resetRequired, true);
    assert.equal(fixture.appRequests.length, requestsBeforeResetGuard);
    assert.equal(fixture.invocations.length, dispatchesBeforeResetGuard);
    assert.equal(fixture.concurrencyAttempts.length, 0);
    assert.equal(fixture.checkpointObjects.length, 0);

    await prepareReady({}, context);
    const requestsBeforeTraffic = fixture.appRequests.length;
    const trafficId = await submit(api, 'traffic');
    const queuedTraffic = await getAction(api, trafficId);
    assert.equal(queuedTraffic.status, 'queued');
    const capacityId = randomUUID();
    const dispatchesBeforeBlockedCapacity = fixture.invocations.length;
    const blockedCapacity = await api.handler(httpEvent('PUT', `/api/actions/${capacityId}`, capacityCommand()));
    assert.equal(blockedCapacity.statusCode, 409, 'queued ordinary traffic prevents a concurrent capacity change');
    assert.equal(row(`ACTION#${capacityId}`), undefined);
    assert.equal(fixture.invocations.length, dispatchesBeforeBlockedCapacity,
      'a rejected capacity request is not dispatched');
    const stillQueued = await getAction(api, trafficId);
    assert.equal(stillQueued.status, 'queued', 'capacity admission does not implicitly stop the producer');
    assert.equal(stillQueued.stopRequested, undefined);
    const state = await getState(api);
    assert.equal(state.currentActionId, trafficId);
    assert.equal(state.configurationActionId, undefined);
    assert.equal(fixture.appRequests.length, requestsBeforeTraffic,
      'the queued producer is not run as part of the capacity guard');
    assert.equal(fixture.inventoryConcurrency, inventoryReleaseCap);
    assert.equal(fixture.concurrencyAttempts.length, 0);
    assert.equal(fixture.checkpointObjects.length, 0);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('public Recover restores the positive release cap 16 from a saved current cap 32 and preserves orders', async () => {
    const ready = await prepareReady({}, context);
    const originalBaseline = structuredClone(ready.state.originalBaseline);
    const priorOrders = [...fixture.appOrders.keys()].sort();
    const stockBefore = fixture.appStock;

    // Seed the persisted current setting as if the capacity action had already confirmed 32.
    // The public Recover action below remains the behavior under test.
    fixture.inventoryConcurrency = higherInventoryCap;
    row('STATE').data.baseline.settings.inventory.cap = higherInventoryCap;
    const requestsBeforeRecover = fixture.appRequests.length;
    const recovery = await runAction(context, 'recover', { confirmQuiet: true });
    assert.equal(recovery.action.status, 'completed', recovery.action.error);
    assert.equal(recovery.action.capRestoration?.inventory?.before, higherInventoryCap);
    assert.equal(recovery.action.capRestoration?.inventory?.target, inventoryReleaseCap);
    assert.equal(recovery.action.capRestoration?.inventory?.readback, inventoryReleaseCap);
    assert.equal(recovery.action.capRestoration?.inventory?.outcome, 'applied');
    assert.deepEqual(fixture.concurrencyWrites, [{
      name: 'Inventory', previous: higherInventoryCap, next: inventoryReleaseCap, method: 'PUT',
    }]);
    assert.equal(fixture.inventoryConcurrency, inventoryReleaseCap);
    assert.deepEqual(recovery.state.originalBaseline, originalBaseline,
      'Recover keeps the readiness-time release baseline as the recovery target');
    assert.equal(recovery.state.baseline.settings.inventory.cap, inventoryReleaseCap);
    assert.equal(fixture.appRequests.length - requestsBeforeRecover, 4,
      'Recover restores the cap and verifies a fresh catalog, checkout, status, and catalog');
    const freshCheckout = recovery.action.requests.find(({ kind, outcome }) => kind === 'checkout' && outcome === 'success');
    assert.equal(freshCheckout?.checkout?.quantity, 1);
    for (const checkoutId of priorOrders) {
      assert.ok(fixture.appOrders.has(checkoutId), `Recover preserves prior order ${checkoutId}`);
    }
    assert.ok(fixture.appOrders.has(freshCheckout.checkout.checkoutId));
    assert.equal(fixture.appStock, stockBefore - 1);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('a positive Inventory cap increases only that function after durable capture and headroom check', async () => {
    const { state: ready } = await prepareReady({}, context);
    const before = sideEffectSnapshot();
    const deploymentIdentity = structuredClone(ready.baseline.deploymentIdentity);
    const originalBaseline = structuredClone(ready.originalBaseline);
    const traceStart = fixture.trace.length;
    const accountReadsStart = fixture.accountSettingsReads.length;
    const id = randomUUID();
    let stateAtPut;
    fixture.beforeConcurrencyAttempt = async ({ name, previous, next, method }) => {
      assert.deepEqual({ name, previous, next, method },
        { name: 'Inventory', previous: inventoryReleaseCap, next: higherInventoryCap, method: 'PUT' });
      stateAtPut = await getAction(api, id);
    };

    const { action, state } = await runCapacity(context, higherInventoryCap, id);
    assertCapacityChange(stateAtPut, { before: inventoryReleaseCap, target: higherInventoryCap });
    assert.equal(stateAtPut.status, 'running', 'before/target are durable before the function write is sent');
    assert.equal(action.status, 'completed', action.error);
    assert.equal(action.configurationOutcome, 'applied');
    assertCapacityChange(action, {
      before: inventoryReleaseCap, target: higherInventoryCap,
      acknowledgement: 'acknowledged', readback: higherInventoryCap,
    });
    assert.equal(state.configurationActionId, id, 'capacity uses the configuration-action lane');
    assert.equal(state.currentActionId, ready.readinessId, 'capacity leaves the prior readiness action in the primary lane');
    assert.equal(fixture.inventoryConcurrency, higherInventoryCap);
    assert.deepEqual(fixture.concurrencyAttempts.slice(-1), [
      { name: 'Inventory', previous: inventoryReleaseCap, next: higherInventoryCap, method: 'PUT' },
    ]);
    assert.deepEqual(fixture.concurrencyWrites.slice(-1), [
      { name: 'Inventory', previous: inventoryReleaseCap, next: higherInventoryCap, method: 'PUT' },
    ]);
    assert.ok(fixture.concurrencyReads.slice(-1).some(({ name, cap }) => name === 'Inventory' && cap === higherInventoryCap),
      'the selected function cap is confirmed by GetFunctionConcurrency');
    assert.ok(fixture.accountSettingsReads.slice(accountReadsStart).some(({ concurrentExecutions, unreservedConcurrentExecutions }) =>
      concurrentExecutions === 1000 && unreservedConcurrentExecutions === 1000 - inventoryReleaseCap),
    'GetAccountSettings reports the 1,000 execution quota and fresh headroom after the release-owned 16-unit cap');

    const captureAt = fixture.trace.findIndex((entry, index) => index >= traceStart && entry.type === 'checkpoint-stored');
    const settingsReadAt = fixture.trace.findIndex((entry, index) => index >= traceStart && entry.type === 'account-settings-read');
    const putAt = fixture.trace.findIndex((entry, index) => index >= traceStart && entry.type === 'concurrency-attempt');
    assert.ok(captureAt >= 0 && putAt > captureAt, 'the durable configuration capture completes before PutFunctionConcurrency');
    assert.ok(settingsReadAt >= 0 && putAt > settingsReadAt, 'the account headroom observation precedes the selected write');
    assert.equal(action.configurationCheckpoint?.status, 'stored');
    assert.equal(action.configurationCheckpoint?.inventoryCap, inventoryReleaseCap);
    const saved = checkpointBody(fixture.checkpointObjects.at(-1));
    assert.equal(saved.settings?.inventory?.cap, inventoryReleaseCap);
    assert.equal(saved.settings?.inventory?.memory, 256);
    assert.equal(saved.settings?.inventory?.version, healthyVersion);

    assertNoTrafficOrAliasChanges(before);
    assert.equal(fixture.appRequests.length, before.appRequests, 'the shortcut sends no application probes');
    assert.deepEqual(fixture.concurrencyAttempts.map(({ name }) => name), ['Inventory']);
    assert.deepEqual(state.originalBaseline, originalBaseline);
    assert.deepEqual(state.baseline.deploymentIdentity, deploymentIdentity,
      'capacity remediation does not change the published-release identity');
    assert.equal(state.originalBaseline.settings.inventory.cap, inventoryReleaseCap);
    const selectedConfiguration = fixture.configurationReads.findLast(({ name, version }) =>
      name === 'Inventory' && version === healthyVersion);
    assert.equal(selectedConfiguration?.MemorySize, 256);
    assert.equal(selectedConfiguration?.Role, inventoryRoleArn);
    assert.equal(selectedConfiguration?.CodeSha256, fixture.manifestCodeSha256);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('bounded integer targets include a non-default value and the upper boundary', async () => {
    for (const target of [24, maximumInventoryCap]) {
      await prepareReady({}, context);
      const before = sideEffectSnapshot();
      const { action, state } = await runCapacity(context, target);
      assert.equal(action.status, 'completed', action.error);
      assert.equal(action.configurationOutcome, 'applied');
      assertCapacityChange(action, { before: inventoryReleaseCap, target, readback: target });
      assert.equal(fixture.inventoryConcurrency, target, 'the requested value is applied without substituting the default');
      assert.equal(state.originalBaseline.settings.inventory.cap, inventoryReleaseCap);
      assertNoTrafficOrAliasChanges(before);
    }
  });

  await t.test('already-active and lower targets do not write capacity or capture another checkpoint', async () => {
    await prepareReady({}, context);
    const initiallyActive = await runCapacity(context, inventoryReleaseCap);
    assert.equal(initiallyActive.action.status, 'completed', initiallyActive.action.error);
    assert.equal(initiallyActive.action.configurationOutcome, 'no_change');
    assertCapacityChange(initiallyActive.action, {
      before: inventoryReleaseCap, target: inventoryReleaseCap,
    });
    assert.equal(fixture.concurrencyAttempts.length, 0, 'the original release cap is already active');
    assert.equal(fixture.checkpointObjects.length, 0, 'an equal target does not need a mutation checkpoint');

    const first = await runCapacity(context, higherInventoryCap);
    assert.equal(first.action.status, 'completed', first.action.error);
    const writesBefore = fixture.concurrencyAttempts.length;
    const capturesBefore = fixture.checkpointObjects.length;
    const appRequestsBefore = fixture.appRequests.length;

    const noChange = await runCapacity(context, higherInventoryCap);
    assert.equal(noChange.action.status, 'completed', noChange.action.error);
    assert.equal(noChange.action.configurationOutcome, 'no_change');
    assertCapacityChange(noChange.action, { before: higherInventoryCap, target: higherInventoryCap });
    assert.equal(fixture.concurrencyAttempts.length, writesBefore, 'an already-active target is an observation, not another Put');
    assert.equal(fixture.checkpointObjects.length, capturesBefore, 'a no-change result needs no mutation checkpoint');

    const lower = await runCapacity(context, inventoryReleaseCap);
    assert.ok(['failed', 'incomplete'].includes(lower.action.status));
    assert.match(lower.action.error ?? '', /increase|larger|target|cap|concurr/i);
    assert.equal(fixture.inventoryConcurrency, higherInventoryCap);
    assert.equal(fixture.concurrencyAttempts.length, writesBefore, 'a lower target is rejected without PutFunctionConcurrency');
    assert.equal(fixture.checkpointObjects.length, capturesBefore);
    assert.equal(fixture.appRequests.length, appRequestsBefore);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('increase requires a positive current cap and enough measured account headroom', async () => {
    await prepareReady({}, context);
    fixture.inventoryConcurrency = undefined;
    const noPositive = await runCapacity(context);
    assert.ok(['failed', 'incomplete'].includes(noPositive.action.status));
    assert.match(noPositive.action.error ?? '', /positive|unreserved|cap|increase/i);
    assert.equal(fixture.concurrencyAttempts.length, 0, 'an unreserved function is not raised by this command');
    assert.equal(fixture.checkpointObjects.length, 0);

    await prepareReady({}, context);
    fixture.accountOtherReservedConcurrency = 880;
    const appRequestsBefore = fixture.appRequests.length;
    const insufficient = await runCapacity(context);
    assert.ok(['failed', 'incomplete'].includes(insufficient.action.status));
    assert.match(insufficient.action.error ?? '', /headroom|account|quota|unreserved|concurr/i);
    assert.equal(fixture.accountSettingsReads.at(-1)?.concurrentExecutions, 1000);
    assert.equal(fixture.accountSettingsReads.at(-1)?.unreservedConcurrentExecutions, 104);
    assert.equal(fixture.concurrencyAttempts.length, 0, 'the selected target would leave fewer than 100 account executions unreserved');
    assert.equal(fixture.checkpointObjects.length, 0);
    assert.equal(fixture.appRequests.length, appRequestsBefore);

    await prepareReady({}, context);
    fixture.accountSettingsMode = 'fail';
    const requestsBeforeAccountFailure = fixture.appRequests.length;
    const failedAccountRead = await runCapacity(context);
    assert.ok(['failed', 'incomplete'].includes(failedAccountRead.action.status));
    assert.equal(fixture.concurrencyAttempts.length, 0, 'unknown account capacity blocks the write');
    assert.equal(fixture.appRequests.length, requestsBeforeAccountFailure,
      'no business request is introduced by the capacity shortcut');
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('unrecorded cap drift from a trusted positive baseline blocks readiness or capacity mutation', async () => {
    const { state: ready } = await prepareReady({}, context);
    const originalBaseline = structuredClone(ready.originalBaseline);
    const currentBaseline = structuredClone(ready.baseline);
    const appRequestsBeforeReadiness = fixture.appRequests.length;
    fixture.inventoryConcurrency = 2;
    const driftedReadiness = await runAction(context, 'readiness', { confirmQuiet: true });
    assert.ok(['failed', 'incomplete'].includes(driftedReadiness.action.status));
    assert.match(driftedReadiness.action.error ?? '', /concurr|cap|release|baseline|setting/i);
    assert.equal(fixture.appRequests.length, appRequestsBeforeReadiness,
      'readiness refuses unrecorded positive cap drift before business verification');
    assert.deepEqual(driftedReadiness.state.originalBaseline, originalBaseline);
    assert.deepEqual(driftedReadiness.state.baseline, currentBaseline,
      'failed readiness does not adopt external capacity as the current or recovery baseline');

    const { state: zeroReady } = await prepareReady({}, context);
    const trustedZeroBaseline = structuredClone(zeroReady.originalBaseline);
    fixture.inventoryConcurrency = 0;
    const appRequestsBeforeCapacity = fixture.appRequests.length;
    const zeroDrift = await runCapacity(context);
    assert.ok(['failed', 'incomplete'].includes(zeroDrift.action.status));
    assert.equal(fixture.inventoryConcurrency, 0, 'the externally selected zero cap is left for reconciliation');
    assert.equal(fixture.concurrencyAttempts.length, 0, 'capacity does not overwrite an unrecorded zero cap');
    assert.equal(fixture.appRequests.length, appRequestsBeforeCapacity);
    assert.deepEqual(zeroDrift.state.originalBaseline, trustedZeroBaseline);

    const { state: positiveReady } = await prepareReady({}, context);
    const trustedPositiveBaseline = structuredClone(positiveReady.originalBaseline);
    const trustedPositiveCurrent = structuredClone(positiveReady.baseline);
    fixture.inventoryConcurrency = unrecordedInventoryCap;
    const appRequestsBeforeRaisedDrift = fixture.appRequests.length;
    const raisedDrift = await runAction(context, 'readiness', { confirmQuiet: true });
    assert.ok(['failed', 'incomplete'].includes(raisedDrift.action.status));
    assert.match(raisedDrift.action.error ?? '', /concurr|cap|release|baseline|setting/i);
    assert.equal(fixture.appRequests.length, appRequestsBeforeRaisedDrift,
      `readiness rejects unrecorded cap ${unrecordedInventoryCap} before business verification`);
    assert.deepEqual(raisedDrift.state.originalBaseline, trustedPositiveBaseline);
    assert.deepEqual(raisedDrift.state.baseline, trustedPositiveCurrent,
      'readiness does not adopt external cap 48 over the release target 16');
    assert.equal(fixture.inventoryConcurrency, unrecordedInventoryCap, 'the external cap is left untouched for reconciliation');
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('a first readiness on a new release cannot adopt a raised cap from a stale unreserved baseline', async () => {
    const oldState = await prepareCurrentReleaseOverStaleUnreservedBaseline(context);
    assert.equal(oldState.originalBaseline.settings.inventory.cap, 'unreserved');
    assert.equal(fixture.inventoryExpectedConcurrency, inventoryReleaseCap,
      'the new release itself owns the positive 16-unit baseline');
    const appRequestsBefore = fixture.appRequests.length;

    const readiness = await runAction(context, 'readiness', { confirmQuiet: true });
    assert.ok(['failed', 'incomplete'].includes(readiness.action.status));
    assert.match(readiness.action.error ?? '', /concurr|cap|release|baseline|setting|generation/i);
    assert.equal(fixture.appRequests.length, appRequestsBefore,
      'a new generation at cap 32 is rejected before any readiness business request');
    assert.equal(readiness.state.baseline.appRevision, appRevision);
    assert.equal(readiness.state.originalBaseline.settings.inventory.cap, 'unreserved',
      'the old generation remains historical and cannot become the new 16-unit recovery target');
    assert.equal(readiness.state.baseline.deploymentIdentity?.sourceRevision, appRevision,
      'the stored baseline keeps its old release identity when new-generation readiness fails');
    assert.equal(readiness.state.baseline.deploymentIdentity?.inventoryCap, 'unreserved',
      'the old unreserved identity is preserved without being adopted as the new release baseline');
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('stale release, failed capture, and post-capture cap drift block the write', async () => {
    await prepareReady({}, context);
    fixture.revision = newerRevision;
    const stale = await runCapacity(context);
    assert.ok(['failed', 'incomplete'].includes(stale.action.status));
    assert.match(stale.action.error ?? '', /release|revision|baseline|deployment/i);
    assert.equal(fixture.concurrencyAttempts.length, 0);
    assert.equal(fixture.checkpointObjects.length, 0);

    await prepareReady({}, context);
    fixture.checkpointMode = 'fail';
    const beforeRequests = fixture.appRequests.length;
    const captureFailure = await runCapacity(context);
    assert.ok(['failed', 'incomplete'].includes(captureFailure.action.status));
    assert.match(captureFailure.action.error ?? '', /checkpoint|capture|evidence|storage/i);
    assert.equal(fixture.concurrencyAttempts.length, 0, 'a failed durable capture blocks the cap write');
    assert.equal(fixture.concurrencyWrites.length, 0);
    assert.equal(fixture.appRequests.length, beforeRequests);

    await prepareReady({}, context);
    fixture.afterCheckpoint = async () => { fixture.inventoryConcurrency = 2; };
    const capDrift = await runCapacity(context);
    assert.ok(['failed', 'incomplete'].includes(capDrift.action.status));
    assert.match(capDrift.action.error ?? '', /changed|drift|capture|checkpoint|concurr/i);
    assert.equal(fixture.inventoryConcurrency, 2, 'the external change is preserved for reconciliation');
    assert.equal(fixture.concurrencyAttempts.length, 0, 'the controller does not overwrite cap drift after capture');
    assert.ok(fixture.checkpointObjects.length > 0, 'the recorded checkpoint remains available after drift is found');
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('write failures and lost acknowledgements retain their actual outcome without retry', async () => {
    await prepareReady({}, context);
    fixture.concurrencyMode = 'fail';
    const failed = await runCapacity(context);
    assert.ok(['failed', 'incomplete'].includes(failed.action.status));
    assert.equal(failed.action.configurationOutcome, 'failed');
    assertCapacityChange(failed.action, {
      before: inventoryReleaseCap, target: higherInventoryCap,
      acknowledgement: 'rejected', readback: inventoryReleaseCap,
    });
    assert.equal(fixture.concurrencyAttempts.length, 1);
    assert.equal(fixture.concurrencyWrites.length, 0);
    assert.equal(fixture.inventoryConcurrency, inventoryReleaseCap);

    await prepareReady({}, context);
    fixture.concurrencyMode = 'lost-ack';
    const lostAck = await runCapacity(context);
    assert.equal(lostAck.action.status, 'completed', lostAck.action.error);
    assert.equal(lostAck.action.configurationOutcome, 'applied');
    assertCapacityChange(lostAck.action, {
      before: inventoryReleaseCap, target: higherInventoryCap,
      acknowledgement: 'ambiguous', readback: higherInventoryCap,
    });
    assert.equal(fixture.concurrencyAttempts.length, 1, 'readback reconciles a lost acknowledgement without a second Put');
    assert.equal(fixture.concurrencyWrites.length, 1);
    assert.ok(fixture.concurrencyReads.some(({ name, cap }) => name === 'Inventory' && cap === higherInventoryCap));

    await prepareReady({}, context);
    fixture.concurrencyMode = 'lost-no-observation';
    fixture.concurrencyReadMode = 'fail-after-attempt';
    const unknown = await runCapacity(context);
    assert.equal(unknown.action.status, 'incomplete');
    assert.equal(unknown.action.configurationOutcome, 'unknown');
    assertCapacityChange(unknown.action, {
      before: inventoryReleaseCap, target: higherInventoryCap,
      acknowledgement: 'ambiguous', readback: 'unknown',
    });
    assert.equal(fixture.concurrencyAttempts.length, 1, 'an unobserved Put is not blindly retried');
    assert.equal(fixture.concurrencyWrites.length, 0);
    assert.ok(fixture.concurrencyReadFailures.length > 0, 'the fixture withheld every post-write cap observation');
    assert.equal(fixture.inventoryConcurrency, inventoryReleaseCap);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('denial and access restoration preserve the confirmed raised cap through alias readback', async () => {
    await prepareReady({}, context);
    const increased = await runCapacity(context);
    assert.equal(increased.action.status, 'completed', increased.action.error);
    const stockBefore = fixture.appStock;
    const ordersBefore = structuredClone([...fixture.appOrders.entries()]);

    const denied = await runAction(context, 'activate_inventory_denial');
    assert.equal(denied.action.status, 'completed', denied.action.error);
    assert.equal(fixture.aliasVersion.Inventory, deniedVersion);
    assert.equal(fixture.inventoryConcurrency, higherInventoryCap);
    assert.equal(denied.state.baseline.settings.inventory.cap, higherInventoryCap);
    assert.equal(denied.state.originalBaseline.settings.inventory.cap, inventoryReleaseCap);
    assert.ok(denied.action.requests.some(({ kind, statusCode, dependencyReason }) =>
      kind === 'checkout' && statusCode === 502 && dependencyReason === 'inventory_access_denied'));
    assert.equal(fixture.appStock, stockBefore);
    assert.deepEqual([...fixture.appOrders.entries()], ordersBefore);

    const requestsBeforeRestore = fixture.appRequests.length;
    const restored = await runAction(context, 'restore_inventory_access');
    assert.equal(restored.action.status, 'completed', restored.action.error);
    assert.equal(fixture.aliasVersion.Inventory, healthyVersion);
    assert.equal(fixture.inventoryConcurrency, higherInventoryCap, 'access restoration does not reset capacity');
    assert.equal(restored.state.baseline.settings.inventory.cap, higherInventoryCap);
    assert.equal(restored.state.originalBaseline.settings.inventory.cap, inventoryReleaseCap);
    assert.equal(fixture.appRequests.length, requestsBeforeRestore, 'the access shortcut remains configuration-only');
    assert.deepEqual([...fixture.appOrders.entries()], ordersBefore);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('changed cap, refreshed readiness, memory selection, and Recover retain the original positive target', async () => {
    const firstReadiness = await prepareReady({ memoryVariants: true }, context);
    const originalBaseline = structuredClone(firstReadiness.state.originalBaseline);
    const publishedIdentity = structuredClone(firstReadiness.state.originalBaseline.deploymentIdentity);
    assert.equal(publishedIdentity.inventoryCap, inventoryReleaseCap);
    const originalOrders = [...fixture.appOrders.keys()];

    const increased = await runCapacity(context, higherInventoryCap);
    assert.equal(increased.action.status, 'completed', increased.action.error);
    assert.equal(fixture.inventoryConcurrency, higherInventoryCap);
    assert.deepEqual((await getState(api)).originalBaseline, originalBaseline);

    const refreshed = await runAction(context, 'readiness', { confirmQuiet: true });
    assert.equal(refreshed.action.status, 'completed', refreshed.action.error);
    assert.equal(refreshed.state.baseline.settings.inventory.cap, higherInventoryCap,
      'fresh readiness records the live capacity as current settings');
    assert.equal(refreshed.state.originalBaseline.settings.inventory.cap, inventoryReleaseCap,
      'readiness keeps the original positive capacity as the recovery target');
    assert.deepEqual(refreshed.state.baseline.deploymentIdentity, publishedIdentity,
      'a runtime cap change does not rewrite the immutable published-release identity');
    assert.deepEqual(refreshed.state.originalBaseline.deploymentIdentity, publishedIdentity);
    assert.equal(fixture.inventoryExpectedConcurrency, inventoryReleaseCap, 'the release output remains the published cap');
    assert.equal(refreshed.state.baseline.deploymentIdentity.inventoryCap, inventoryReleaseCap,
      'current readiness keeps the release identity cap at 16 while recording confirmed current cap 32');

    const confirmedRaisedBaseline = structuredClone(refreshed.state.baseline);
    fixture.inventoryConcurrency = unrecordedInventoryCap;
    const requestsBeforeUnrecordedCap = fixture.appRequests.length;
    const unrecordedCap = await runAction(context, 'readiness', { confirmQuiet: true });
    assert.ok(['failed', 'incomplete'].includes(unrecordedCap.action.status));
    assert.match(unrecordedCap.action.error ?? '', /concurr|cap|release|baseline|setting/i);
    assert.equal(fixture.appRequests.length, requestsBeforeUnrecordedCap,
      `the current release rejects cap ${unrecordedInventoryCap} before business verification`);
    assert.deepEqual(unrecordedCap.state.baseline, confirmedRaisedBaseline,
      'the observed cap 48 cannot replace the confirmed cap 32');
    assert.deepEqual(unrecordedCap.state.originalBaseline, originalBaseline,
      'the unrecorded cap cannot change the original recovery target');
    fixture.inventoryConcurrency = higherInventoryCap;

    const memory = await runAction(context, 'increase_memory', { function: 'inventory', memoryMb: 512 });
    assert.equal(memory.action.status, 'completed', memory.action.error);
    assert.equal(fixture.aliasVersion.Inventory, higherHealthy.version);
    assert.equal(fixture.inventoryConcurrency, higherInventoryCap, 'memory selection preserves the raised current cap');
    assert.equal(memory.action.configurationCheckpoint?.inventoryCap, higherInventoryCap);
    assert.equal(memory.state.baseline.settings.inventory.cap, higherInventoryCap);
    assert.equal(memory.state.originalBaseline.settings.inventory.cap, inventoryReleaseCap);

    const ordersBeforeRecover = [...fixture.appOrders.keys()].sort();
    const stockBeforeRecover = fixture.appStock;
    const requestsBeforeRecover = fixture.appRequests.length;
    const recover = await runAction(context, 'recover', { confirmQuiet: true });
    assert.equal(recover.action.status, 'completed', recover.action.error);
    assert.equal(recover.action.configurationOutcome, 'applied');
    assert.equal(recover.action.capRestoration?.inventory?.before, higherInventoryCap);
    assert.equal(recover.action.capRestoration?.inventory?.target, inventoryReleaseCap);
    assert.equal(recover.action.capRestoration?.inventory?.readback, inventoryReleaseCap);
    assert.equal(recover.action.capRestoration?.inventory?.outcome, 'applied');
    assert.equal(fixture.inventoryConcurrency, inventoryReleaseCap);
    assert.equal(fixture.aliasVersion.Inventory, healthyVersion);
    assert.equal(fixture.appRequests.length - requestsBeforeRecover, 4,
      'Recover restores the original positive cap and performs its fresh two-catalog, checkout, and status verification');
    assert.ok(recover.action.requests.some(({ kind, outcome, completedAt, checkout }) =>
      kind === 'checkout' && outcome === 'success' && completedAt && checkout?.quantity === 1));
    for (const checkoutId of [...originalOrders, ...ordersBeforeRecover]) {
      assert.ok(fixture.appOrders.has(checkoutId), `Recover preserves the earlier order ${checkoutId}`);
    }
    assert.equal(fixture.appStock, stockBeforeRecover - 1);
    assert.equal(recover.state.originalBaseline.settings.inventory.cap, inventoryReleaseCap);
    assert.deepEqual(recover.state.originalBaseline.deploymentIdentity, publishedIdentity);
    assert.equal(recover.state.latestStock, fixture.appStock);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('Reset adopts the current release cap 16 from cap 32 and preserves the archived unreserved run', async () => {
    const previous = await prepareCurrentReleaseOverStaleUnreservedBaseline(context);
    const previousRunId = previous.runId ?? 'legacy';
    const oldProductVersion = previous.baseline.productVersion;
    const oldOriginalBaseline = structuredClone(previous.originalBaseline);
    assert.equal(oldOriginalBaseline.settings.inventory.cap, 'unreserved');
    const appRequestsBeforeReset = fixture.appRequests.length;

    const resetResult = await runAction(context, 'reset', {
      confirmQuiet: true, confirmReset: true, confirmCheckoutClosed: true,
    });
    assert.equal(resetResult.action.status, 'completed', resetResult.action.error);
    assert.equal(resetResult.action.capRestoration?.inventory?.before, higherInventoryCap);
    assert.equal(resetResult.action.capRestoration?.inventory?.target, inventoryReleaseCap);
    assert.equal(resetResult.action.capRestoration?.inventory?.readback, inventoryReleaseCap);
    assert.equal(resetResult.action.capRestoration?.inventory?.outcome, 'applied');
    assert.deepEqual(fixture.concurrencyAttempts, [{
      name: 'Inventory', previous: higherInventoryCap, next: inventoryReleaseCap, method: 'PUT',
    }], 'Reset restores the release-owned cap instead of the older unreserved value');
    assert.equal(fixture.inventoryConcurrency, inventoryReleaseCap);
    assert.equal(fixture.inventoryExpectedConcurrency, inventoryReleaseCap);
    assert.equal(resetResult.state.runId, resetResult.id);
    assert.equal(resetResult.state.previousRunId, previousRunId);
    assert.equal(resetResult.state.baseline.settings.inventory.cap, inventoryReleaseCap);
    assert.equal(resetResult.state.originalBaseline.settings.inventory.cap, inventoryReleaseCap);
    assert.equal(resetResult.state.baseline.deploymentIdentity.inventoryCap, inventoryReleaseCap);
    assert.equal(resetResult.state.originalBaseline.deploymentIdentity.inventoryCap, inventoryReleaseCap);
    assert.notEqual(resetResult.action.reset.productVersion, oldProductVersion,
      'the new Reset session is bound to a fresh productVersion');
    assert.equal(resetResult.state.baseline.productVersion, resetResult.action.reset.productVersion);
    assert.equal(resetResult.state.baseline.stockBefore, 1000);
    assert.equal(resetResult.state.baseline.stockAfter, 999);
    assert.equal(fixture.appStock, 999, 'Reset verifies the seeded 1,000-to-999 stock decrement');
    assert.equal(fixture.appRequests.length - appRequestsBeforeReset, 4,
      'Reset sends only its two catalogs, fresh checkout, and order-status verification');
    const resetCheckout = resetResult.action.requests.find(({ kind }) => kind === 'checkout');
    assert.equal(resetCheckout?.checkout?.productVersion, resetResult.action.reset.productVersion);
    assert.equal(resetCheckout?.checkout?.quantity, 1);
    assert.equal(resetCheckout?.outcome, 'success');
    assert.deepEqual([...fixture.appOrders.keys()], [resetCheckout.checkout.checkoutId],
      'Reset removes prior business orders while retaining the new verification order');

    const archived = await call(api, 'GET', `/api/runs/${previousRunId}`, undefined, 200);
    assert.deepEqual(archived.run.originalBaseline, oldOriginalBaseline,
      'the old session retains its original unreserved baseline as history');
    assert.equal(archived.run.baseline.settings.inventory.cap, 'unreserved');
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('the public capacity command followed by Reset restores 16 in a fresh session', async () => {
    const ready = await prepareReady({}, context);
    const previousRunId = ready.state.runId ?? 'legacy';
    const previousProductVersion = ready.state.baseline.productVersion;
    const raised = await runCapacity(context, higherInventoryCap);
    assert.equal(raised.action.status, 'completed', raised.action.error);
    assert.equal(raised.action.capacityChange?.before, inventoryReleaseCap);
    assert.equal(raised.action.capacityChange?.target, higherInventoryCap);
    assert.equal(raised.action.capacityChange?.readback, higherInventoryCap);
    assert.equal(raised.state.originalBaseline.settings.inventory.cap, inventoryReleaseCap);

    const appRequestsBeforeReset = fixture.appRequests.length;
    const resetResult = await runAction(context, 'reset', {
      confirmQuiet: true, confirmReset: true, confirmCheckoutClosed: true,
    });
    assert.equal(resetResult.action.status, 'completed', resetResult.action.error);
    assert.equal(resetResult.action.capRestoration?.inventory?.before, higherInventoryCap);
    assert.equal(resetResult.action.capRestoration?.inventory?.target, inventoryReleaseCap);
    assert.equal(resetResult.action.capRestoration?.inventory?.readback, inventoryReleaseCap);
    assert.equal(fixture.inventoryConcurrency, inventoryReleaseCap);
    assert.equal(resetResult.state.runId, resetResult.id);
    assert.equal(resetResult.state.previousRunId, previousRunId);
    assert.equal(resetResult.state.baseline.settings.inventory.cap, inventoryReleaseCap);
    assert.equal(resetResult.state.originalBaseline.settings.inventory.cap, inventoryReleaseCap);
    assert.equal(resetResult.state.baseline.deploymentIdentity.inventoryCap, inventoryReleaseCap);
    assert.notEqual(resetResult.action.reset.productVersion, previousProductVersion);
    assert.equal(resetResult.state.baseline.productVersion, resetResult.action.reset.productVersion);
    assert.equal(resetResult.state.baseline.stockBefore, 1000);
    assert.equal(resetResult.state.baseline.stockAfter, 999);
    assert.equal(fixture.appStock, 999);
    assert.equal(fixture.appRequests.length - appRequestsBeforeReset, 4);
    assert.deepEqual(fixture.unhandled, []);
  });
});
