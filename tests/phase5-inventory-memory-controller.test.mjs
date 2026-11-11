import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { currentConfigurationObservation, currentInventoryDisplay } from '../controller/src/inventory-display.mjs';
import {
  appApi, appRevision, appFetch, awsEnvironment, call, deniedRoleArn, deniedRoleName, fixture, getAction, getState,
  healthyVersion, deniedVersion, httpEvent, reset, root, startAwsServer, submit,
  activateAndConfirm, inventoryRoleArn, omitOriginalBaseline,
} from './support/phase3-inventory-controller-harness.mjs';

const higherHealthy = { memoryMb: 512, access: 'healthy', version: '4', roleArn: inventoryRoleArn };
const higherDenied = { memoryMb: 512, access: 'denied', version: '5', roleArn: deniedRoleArn };

function addHigherMemoryVariants() {
  fixture.extraVariants = [structuredClone(higherHealthy), structuredClone(higherDenied)];
}

function commandBody(memoryMb = 512) {
  return { kind: 'increase_memory', function: 'inventory', memoryMb };
}

async function submitMemory(api, memoryMb = 512, id = randomUUID()) {
  const accepted = await call(api, 'PUT', `/api/actions/${id}`, commandBody(memoryMb), 202);
  assert.equal(accepted.action?.id, id);
  assert.deepEqual(accepted.action?.command, commandBody(memoryMb));
  return id;
}

async function runMemory(api, worker, memoryMb = 512) {
  const id = await submitMemory(api, memoryMb);
  await worker.handler({ actionId: id });
  return { id, action: await getAction(api, id) };
}

function checkpointBody(checkpoint) {
  return typeof checkpoint.body === 'string' ? JSON.parse(checkpoint.body) : checkpoint.body;
}

function latestConfiguration(version) {
  return [...fixture.configurationReads].reverse().find((read) => read.name === 'Inventory' && read.version === version);
}

function assertCheckpointBeforeAlias(version, previousVersion, previousMemory, previousRole) {
  const captureIndex = fixture.trace.findLastIndex((entry) => entry.type === 'checkpoint-stored');
  const updateIndex = fixture.trace.findLastIndex((entry) => entry.type === 'alias-update' && entry.version === version);
  assert.ok(captureIndex >= 0, 'the previous configuration must be stored before changing the alias');
  assert.ok(updateIndex > captureIndex, 'the checkpoint write must finish before UpdateAlias');
  const capture = checkpointBody(fixture.checkpointObjects.at(-1));
  assert.equal(capture.settings?.inventory?.version, previousVersion);
  assert.equal(capture.settings?.inventory?.memory, previousMemory);
  assert.equal(capture.settings?.inventory?.role, previousRole);
  assert.equal(capture.settings?.inventory?.codeSha256, fixture.manifestCodeSha256);
}

function assertNoMemorySideEffects({ appRequests, invocations, aliasUpdates, checkpoints }) {
  assert.equal(fixture.appRequests.length, appRequests, 'memory selection must not probe the app or start traffic');
  assert.equal(fixture.invocations.length, invocations, 'the command must not start duplicate worker or agent actions');
  assert.equal(fixture.aliasUpdates.length, aliasUpdates, 'the selected target must not cause extra alias updates');
  assert.equal(fixture.checkpointObjects.length, checkpoints, 'no-op or rejected selection must not create a checkpoint');
  assert.deepEqual(fixture.unhandled, [], 'memory selection must not call an agent or an unconfigured service');
}

test('the current Inventory view uses a fresher readiness observation without erasing incident history', () => {
  const incident = {
    active: 'healthy',
    alias: { functionName: 'IncidentTriageDemoInventory', aliasName: 'live',
      aliasArn: 'inventory-live', functionVersion: '4', revisionId: 'alias-2', routingWeighted: false,
      observedAt: '2026-11-11T10:00:00.000Z' },
    target: { memoryMb: 512, access: 'denied', version: '5', roleArn: deniedRoleArn },
  };
  const baselineAlias = { functionName: 'IncidentTriageDemoInventory', aliasName: 'live',
    aliasArn: 'inventory-live', functionVersion: healthyVersion, revisionId: 'alias-3', routingWeighted: false,
    observedAt: '2026-11-11T10:05:00.000Z' };
  const baselineInventory = { version: healthyVersion, aliasArn: 'inventory-live', memory: 256, timeout: 6,
    cap: 'unreserved', codeSha256: 'fixture-code', role: inventoryRoleArn, aliasRevision: 'alias-3',
    access: 'healthy', sourceRevision: appRevision, observedAt: '2026-11-11T10:04:00.000Z' };

  const current = currentInventoryDisplay({ baselineAlias, baselineInventory, aliasIncident: incident });
  assert.equal(current.baselineSupersedesIncident, true);
  assert.equal(current.currentAlias?.functionVersion, healthyVersion);
  assert.equal(current.currentVariant?.memoryMb, 256);
  assert.equal(current.access, 'healthy');
  assert.equal(incident.alias.functionVersion, '4', 'the earlier incident observation remains intact');

  const olderBaseline = currentInventoryDisplay({
    baselineAlias: { ...baselineAlias, observedAt: '2026-11-11T09:00:00.000Z' },
    baselineInventory: { ...baselineInventory, observedAt: '2026-11-11T08:59:00.000Z', version: '4', memory: 512 },
    aliasIncident: incident,
  });
  assert.equal(olderBaseline.currentAlias?.functionVersion, '4');
  assert.equal(olderBaseline.currentVariant?.memoryMb, 512);
});

test('the configuration panel follows the latest alias operation while retaining activation history', () => {
  const activation = { id: 'activation', kind: 'activate_inventory_denial', createdAt: '2026-11-11T10:00:00.000Z' };
  const memory = { id: 'memory', kind: 'increase_memory', createdAt: '2026-11-11T10:01:00.000Z' };
  const restore = { id: 'restore', kind: 'restore_inventory_access', createdAt: '2026-11-11T10:02:00.000Z' };
  assert.equal(currentConfigurationObservation(activation, memory), memory);
  assert.equal(currentConfigurationObservation(activation, restore), restore);
  assert.equal(currentConfigurationObservation(activation, undefined), activation);
  assert.equal(currentConfigurationObservation(activation,
    { ...memory, createdAt: '2026-11-11T09:59:00.000Z' }), activation);
});

test('Inventory memory selection preserves access and release state', { timeout: 90_000 }, async (t) => {
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
  const api = await import(`${backendPath}?phase5-memory=${Date.now()}`);
  const worker = await import(`${workerPath}?phase5-memory=${Date.now()}`);

  await t.test('healthy selection checkpoints, switches only memory, and keeps the same artifact', async () => {
    reset();
    addHigherMemoryVariants();
    fixture.appMode = 'selected-variant';
    const before = await getState(api);
    const beforeAppRequests = fixture.appRequests.length;
    const beforeWorkerInvocations = fixture.invocations.length;
    const beforeAliasUpdates = fixture.aliasUpdates.length;
    const beforeCheckpoints = fixture.checkpointObjects.length;

    const { id, action } = await runMemory(api, worker);
    assert.equal(action.status, 'completed');
    assert.equal(action.configurationOutcome, 'applied');
    assert.deepEqual(action.inventorySwitch?.target, higherHealthy);
    assert.equal(action.inventorySwitch?.before?.functionVersion, healthyVersion);
    assert.equal(action.inventorySwitch?.after?.functionVersion, higherHealthy.version);
    assert.equal(fixture.aliasVersion.Inventory, higherHealthy.version);
    assert.deepEqual(fixture.aliasUpdates.slice(beforeAliasUpdates).map(({ version }) => version), [higherHealthy.version]);
    assertCheckpointBeforeAlias(higherHealthy.version, healthyVersion, 256, inventoryRoleArn);

    const readback = latestConfiguration(higherHealthy.version);
    assert.ok(readback, 'the selected immutable version must be read back');
    assert.equal(readback.MemorySize, 512);
    assert.equal(readback.Timeout, 6);
    assert.equal(readback.Role, inventoryRoleArn);
    assert.equal(readback.CodeSha256, fixture.manifestCodeSha256);
    assert.equal(readback.Environment.Variables.SOURCE_REVISION, appRevision);
    assert.equal(readback.Environment.Variables.INVENTORY_TABLE_NAME, 'arn:aws:dynamodb:us-east-1:027224425948:table/IncidentTriageDemoInventory');
    assert.deepEqual(readback.Architectures, ['x86_64']);
    assert.equal(fixture.concurrencyReads.findLast(({ name }) => name === 'Inventory')?.cap, 'unreserved');

    const after = await getState(api);
    assert.deepEqual(after.baseline.settings.checkout, before.baseline.settings.checkout);
    assert.equal(after.baseline.settings.credentialGeneration, before.baseline.settings.credentialGeneration);
    assert.equal(after.baseline.settings.inventoryPolicy, before.baseline.settings.inventoryPolicy);
    assert.equal(after.baseline.settings.inventory.memory, 512);
    assert.equal(after.originalBaseline?.settings?.inventory?.memory, 256,
      'the original recovery settings remain available after changing the active baseline');
    assertNoMemorySideEffects({ appRequests: beforeAppRequests, invocations: beforeWorkerInvocations + 1,
      aliasUpdates: beforeAliasUpdates + 1, checkpoints: beforeCheckpoints + 1 });
    assert.equal(fixture.invocations.at(-1), id);
    assert.deepEqual(fixture.mutations.slice(-2).map((item) => item.startsWith('PutObject') ? 'checkpoint' : item),
      ['checkpoint', `UpdateAlias live ${higherHealthy.version}`]);

    const activationId = await submit(api, 'activate_inventory_denial');
    await worker.handler({ actionId: activationId });
    const activation = await getAction(api, activationId);
    assert.equal(activation.status, 'completed');
    assert.equal(activation.inventorySwitch?.target?.version, higherDenied.version,
      'denial activation selects the denied version at the current higher memory');
    assert.equal(activation.inventorySwitch?.target?.memoryMb, 512);
    assert.equal(fixture.aliasVersion.Inventory, higherDenied.version);
    assert.equal((await getState(api)).incident?.active, 'denied');
  });

  await t.test('denial remains active at higher memory and Restore access keeps that memory', async () => {
    reset();
    addHigherMemoryVariants();
    fixture.appMode = 'selected-variant';
    const initialReadinessId = await submit(api, 'readiness', { confirmQuiet: true });
    await worker.handler({ actionId: initialReadinessId });
    assert.equal((await getAction(api, initialReadinessId)).status, 'completed');
    const id = await submit(api, 'activate_inventory_denial');
    await worker.handler({ actionId: id });
    const activation = { id, action: await getAction(api, id), state: await getState(api) };
    assert.equal(activation.state.incident?.active, 'denied');
    const requestsBeforeSelection = fixture.appRequests.length;
    const { action: increase } = await runMemory(api, worker);
    assert.equal(increase.status, 'completed');
    assert.deepEqual(increase.inventorySwitch?.target, higherDenied);
    assert.equal(fixture.aliasVersion.Inventory, higherDenied.version);
    assert.equal(latestConfiguration(higherDenied.version)?.MemorySize, 512);
    assert.equal(latestConfiguration(higherDenied.version)?.Role, deniedRoleArn);
    assert.equal(fixture.deniedRoleAttached, true);
    assert.ok(fixture.iamReads.some(({ action: readAction, RoleName }) =>
      readAction === 'ListAttachedRolePolicies' && RoleName === deniedRoleName),
    'the denied role remains the verified role for the higher-memory denied version');
    assert.deepEqual(fixture.iamPolicyDocument.Statement, [{
      Sid: 'DenyInventoryGetItem', Effect: 'Deny', Action: 'dynamodb:GetItem',
      Resource: 'arn:aws:dynamodb:us-east-1:027224425948:table/IncidentTriageDemoInventory',
    }]);
    assert.equal(fixture.appRequests.length, requestsBeforeSelection, 'the memory action must not send an implicit request');
    assertCheckpointBeforeAlias(higherDenied.version, deniedVersion, 256, deniedRoleArn);

    const deniedCatalog = await appFetch(`${appApi}/api/products`);
    assert.equal(deniedCatalog.status, 502);
    assert.equal((await deniedCatalog.json()).dependencyReason, 'inventory_access_denied',
      'a fresh catalog read still fails after only increasing memory');

    const requestsBeforeRestore = fixture.appRequests.length;
    const restoreId = await submit(api, 'restore_inventory_access');
    await worker.handler({ actionId: restoreId });
    const restore = await getAction(api, restoreId);
    assert.equal(restore.status, 'completed', restore.error);
    assert.equal(restore.configurationOutcome, 'applied');
    assert.deepEqual(restore.inventorySwitch?.target, higherHealthy,
      'access restoration must choose the healthy version at the alias current memory');
    assert.equal(restore.inventorySwitch?.before?.functionVersion, higherDenied.version);
    assert.equal(restore.inventorySwitch?.after?.functionVersion, higherHealthy.version);
    assert.equal(fixture.aliasVersion.Inventory, higherHealthy.version);
    assert.equal(latestConfiguration(higherHealthy.version)?.MemorySize, 512);
    assert.equal(latestConfiguration(higherHealthy.version)?.Role, inventoryRoleArn);
    assertCheckpointBeforeAlias(higherHealthy.version, higherDenied.version, 512, deniedRoleArn);
    assert.equal(fixture.appRequests.length, requestsBeforeRestore, 'Restore access does not probe or start traffic');
    const restoredState = await getState(api);
    assert.equal(restoredState.incident?.active, 'healthy');
    assert.equal(restoredState.incident?.alias?.functionVersion, higherHealthy.version);
    assert.equal(fixture.aliasUpdates.at(-1)?.version, higherHealthy.version);

    const healthyCatalog = await appFetch(`${appApi}/api/products`);
    assert.equal(healthyCatalog.status, 200, 'fresh catalog reads work after access restoration');

    const readinessId = await submit(api, 'readiness', { confirmQuiet: true });
    await worker.handler({ actionId: readinessId });
    const readiness = await getAction(api, readinessId);
    assert.equal(readiness.status, 'completed');
    assert.equal(readiness.baseline?.settings?.inventory?.version, higherHealthy.version);
    assert.equal(readiness.baseline?.settings?.inventory?.memory, 512);
    assert.equal(readiness.baseline?.settings?.inventory?.role, inventoryRoleArn);
    assert.equal(readiness.baseline?.settings?.inventory?.codeSha256, fixture.manifestCodeSha256);
    assert.equal(readiness.baseline?.settings?.inventory?.cap, 'unreserved');
    assert.equal(readiness.baseline?.settings?.credentialGeneration, 'fixture-generation');
    const recoveredRun = await getState(api);
    assert.equal(recoveredRun.baseline?.settings?.inventory?.memory, 512);
    assert.equal(recoveredRun.originalBaseline?.settings?.inventory?.memory, 256,
      'higher-memory readiness does not replace the separately retained original baseline');
  });

  await t.test('duplicate IDs are idempotent and selecting the active size is a no-op', async () => {
    reset();
    addHigherMemoryVariants();
    fixture.appMode = 'selected-variant';
    const id = await submitMemory(api, 512);
    await worker.handler({ actionId: id });
    assert.equal((await getAction(api, id)).status, 'completed');
    const counts = { appRequests: fixture.appRequests.length, invocations: fixture.invocations.length,
      aliasUpdates: fixture.aliasUpdates.length, checkpoints: fixture.checkpointObjects.length };

    const duplicate = await call(api, 'PUT', `/api/actions/${id}`, commandBody(512), 200);
    assert.equal(duplicate.action?.id, id);
    assert.equal(duplicate.action?.status, 'completed');
    assertNoMemorySideEffects(counts);

    const conflicting = await call(api, 'PUT', `/api/actions/${id}`, commandBody(256), 409);
    assert.equal(conflicting.code, 'ACTION_ID_CONFLICT');
    assertNoMemorySideEffects(counts);

    const noOpId = await submitMemory(api, 512);
    await worker.handler({ actionId: noOpId });
    const noOp = await getAction(api, noOpId);
    assert.equal(noOp.status, 'completed');
    assert.equal(noOp.configurationOutcome, 'no_change');
    assert.equal(noOp.inventorySwitch?.before?.functionVersion, higherHealthy.version);
    assert.equal(fixture.aliasVersion.Inventory, higherHealthy.version);
    assert.equal(fixture.aliasUpdates.length, counts.aliasUpdates);
    assert.equal(fixture.checkpointObjects.length, counts.checkpoints,
      'an already active variant does not need a mutation checkpoint');
    assert.equal(fixture.appRequests.length, counts.appRequests);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('first memory change retains a legacy verified baseline as the original baseline', async () => {
    reset();
    omitOriginalBaseline();
    addHigherMemoryVariants();
    fixture.appMode = 'selected-variant';
    assert.equal((await getState(api)).originalBaseline, undefined);
    const { action } = await runMemory(api, worker);
    assert.equal(action.status, 'completed', action.error);
    const state = await getState(api);
    assert.equal(state.baseline?.settings?.inventory?.memory, 512);
    assert.equal(state.originalBaseline?.settings?.inventory?.memory, 256,
      'the current verified baseline must be retained before the memory change replaces it');
  });

  await t.test('stale, unlisted and drifted variants fail before checkpoint or alias mutation', async () => {
    async function rejectedMemory({ prepare = true, configure = () => {}, expectedError = /variant|manifest|release|version|configuration|memory|role|code|environment|stale|drift/i } = {}) {
      reset();
      if (prepare) addHigherMemoryVariants();
      configure();
      const { id, action } = await runMemory(api, worker);
      assert.ok(['failed', 'incomplete'].includes(action.status));
      assert.match(action.error ?? '', expectedError);
      assert.equal(fixture.aliasUpdates.length, 0);
      assert.equal(fixture.checkpointObjects.length, 0, 'an invalid request must fail before a checkpoint or mutation');
      assert.equal(fixture.appRequests.length, 0);
      assert.deepEqual(fixture.unhandled, []);
      return id;
    }

    await rejectedMemory({ configure: () => { fixture.manifestMode = 'stale'; }, expectedError: /stale|release|revision|manifest/i });
    await rejectedMemory({ configure: () => { fixture.weightedAlias = true; }, expectedError: /weighted|alias|version/i });
    await rejectedMemory({ configure: () => { fixture.aliasVersion.Inventory = '99'; }, expectedError: /alias|version|variant|baseline/i });
    await rejectedMemory({ configure: () => {
      fixture.versionOverrides[`Inventory:${healthyVersion}`] = { version: '99' };
    }, expectedError: /version|configuration|alias|variant/i });
    await rejectedMemory({ configure: () => {
      fixture.versionOverrides[`Inventory:${healthyVersion}`] = { codeSha256: 'current-code-drift' };
    }, expectedError: /code|configuration|variant|manifest/i });
    await rejectedMemory({ configure: () => {
      fixture.versionOverrides[`Inventory:${healthyVersion}`] = { sourceRevision: '8e5a48bc0edcd7a65b9cc857ea2d17d4f5da2a90' };
    }, expectedError: /environment|release|revision|configuration/i });
    await rejectedMemory({ prepare: false, expectedError: /variant|memory|manifest|prepared|allow/i });
    await rejectedMemory({ configure: () => { fixture.versionOverrides[`Inventory:${higherHealthy.version}`] = { memoryMb: 256 }; }, expectedError: /memory|configuration|variant|manifest/i });
    await rejectedMemory({ configure: () => {
      fixture.versionOverrides[`Inventory:${higherHealthy.version}`] = { codeSha256: 'higher-code-drift' };
    }, expectedError: /code|configuration|variant|manifest/i });
    await rejectedMemory({ configure: () => {
      fixture.versionOverrides[`Inventory:${higherHealthy.version}`] = { inventoryTableArn: 'arn:aws:dynamodb:us-east-1:027224425948:table/WrongInventory' };
    }, expectedError: /environment|table|configuration|variant|manifest/i });

    reset();
    addHigherMemoryVariants();
    const activation = await activateAndConfirm({ api, worker });
    assert.equal(activation.action.status, 'completed');
    addHigherMemoryVariants();
    fixture.versionOverrides[`Inventory:${higherDenied.version}`] = { roleArn: inventoryRoleArn };
    const requestsBefore = fixture.appRequests.length;
    const rejected = await runMemory(api, worker);
    assert.ok(['failed', 'incomplete'].includes(rejected.action.status));
    assert.match(rejected.action.error ?? '', /role|configuration|variant|manifest/i);
    assert.equal(fixture.aliasVersion.Inventory, deniedVersion);
    assert.equal(fixture.aliasUpdates.length, 1, 'the only alias update is the earlier denial activation');
    assert.equal(fixture.checkpointObjects.length, 1, 'invalid target configuration must fail before another checkpoint');
    assert.equal(fixture.appRequests.length, requestsBefore);

    fixture.versionOverrides = {};
    const raised = await runMemory(api, worker);
    assert.equal(raised.action.status, 'completed');
    assert.equal(fixture.aliasVersion.Inventory, higherDenied.version);
    const updatesBeforeDownsize = fixture.aliasUpdates.length;
    const checkpointsBeforeDownsize = fixture.checkpointObjects.length;
    const downsizeId = await submitMemory(api, 256);
    await worker.handler({ actionId: downsizeId });
    const downsize = await getAction(api, downsizeId);
    assert.ok(['failed', 'incomplete'].includes(downsize.status), 'arbitrary memory reduction is not this command');
    assert.match(downsize.error ?? '', /increase|larger|memory|variant|prepared/i);
    assert.equal(fixture.aliasVersion.Inventory, higherDenied.version);
    assert.equal(fixture.aliasUpdates.length, updatesBeforeDownsize);
    assert.equal(fixture.checkpointObjects.length, checkpointsBeforeDownsize);
    assert.equal(fixture.appRequests.length, requestsBefore);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('a lost UpdateAlias acknowledgement reconciles by readback without retry', async () => {
    reset();
    addHigherMemoryVariants();
    fixture.aliasMode = 'lost-ack';
    fixture.appMode = 'selected-variant';
    const { action } = await runMemory(api, worker);
    assert.equal(action.status, 'completed');
    assert.equal(action.configurationOutcome, 'applied');
    assert.equal(action.inventorySwitch?.after?.functionVersion, higherHealthy.version);
    assert.equal(fixture.aliasVersion.Inventory, higherHealthy.version);
    assert.equal(fixture.aliasUpdates.length, 1);
    assert.equal(fixture.aliasUpdateAttempts.length, 1, 'readback reconciles the applied write without resending');
    assert.deepEqual(fixture.aliasReads.filter(({ name }) => name === 'Inventory').at(-1)?.version,
      higherHealthy.version);
    assert.equal(fixture.appRequests.length, 0);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('checkpoint storage failure prevents UpdateAlias', async () => {
    reset();
    addHigherMemoryVariants();
    fixture.checkpointMode = 'fail';
    fixture.appMode = 'selected-variant';
    const { action } = await runMemory(api, worker);
    assert.ok(['failed', 'incomplete'].includes(action.status));
    assert.match(action.error ?? '', /checkpoint|evidence|capture|storage/i);
    assert.equal(fixture.aliasVersion.Inventory, healthyVersion);
    assert.equal(fixture.aliasUpdateAttempts.length, 0, 'the alias call must not be attempted without a stored checkpoint');
    assert.equal(fixture.aliasUpdates.length, 0);
    assert.equal(fixture.checkpointObjects.length, 0);
    assert.ok(fixture.trace.some(({ type }) => type === 'checkpoint-attempt'));
    assert.equal(fixture.appRequests.length, 0);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('revision conflict and an unobserved alias write stay unresolved without retry', async () => {
    reset();
    addHigherMemoryVariants();
    fixture.aliasMode = 'conflict';
    fixture.appMode = 'selected-variant';
    const conflict = await runMemory(api, worker);
    assert.ok(['failed', 'incomplete'].includes(conflict.action.status));
    assert.match(conflict.action.error ?? '', /revision|conflict|changed|precondition|alias/i);
    assert.equal(fixture.aliasVersion.Inventory, healthyVersion);
    assert.equal(fixture.aliasUpdateAttempts.length, 1);
    assert.equal(fixture.aliasUpdateAttempts[0].revisionId, 'alias-revision-1');
    assert.equal(fixture.aliasUpdates.length, 0, 'a rejected revision must not change the alias');
    assert.equal(fixture.checkpointObjects.length, 1, 'the pre-change checkpoint remains available after a conflict');
    assert.equal(fixture.appRequests.length, 0);

    reset();
    addHigherMemoryVariants();
    fixture.aliasMode = 'lost-no-observation';
    fixture.appMode = 'selected-variant';
    const unknown = await runMemory(api, worker);
    assert.equal(unknown.action.status, 'incomplete');
    assert.equal(unknown.action.configurationOutcome, 'unknown');
    assert.match(unknown.action.error ?? '', /unknown|observ|reconcil|alias/i);
    assert.equal(fixture.aliasVersion.Inventory, healthyVersion);
    assert.equal(fixture.aliasUpdateAttempts.length, 1, 'an unobserved write must not be resent');
    assert.equal(fixture.aliasUpdates.length, 0);
    assert.equal(fixture.checkpointObjects.length, 1);
    assert.equal(fixture.appRequests.length, 0);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('unsupported function and noninteger memory are rejected before dispatch; authentication still guards the API', async () => {
    reset();
    const unsupportedFunctionId = randomUUID();
    const unsupportedFunction = await api.handler(httpEvent('PUT', `/api/actions/${unsupportedFunctionId}`,
      { ...commandBody(), function: 'checkout' }));
    assert.equal(unsupportedFunction.statusCode, 400);
    assert.equal(JSON.parse(unsupportedFunction.body).code, 'INVALID_COMMAND');

    const nonintegerId = randomUUID();
    const noninteger = await api.handler(httpEvent('PUT', `/api/actions/${nonintegerId}`,
      commandBody(512.5)));
    assert.equal(noninteger.statusCode, 400);
    assert.equal(JSON.parse(noninteger.body).code, 'INVALID_COMMAND');

    const unauthorizedId = randomUUID();
    const unauthorizedEvent = httpEvent('PUT', `/api/actions/${unauthorizedId}`, commandBody());
    unauthorizedEvent.headers.authorization = 'Bearer invalid-operator';
    const unauthorized = await api.handler(unauthorizedEvent);
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(JSON.parse(unauthorized.body).code, 'UNAUTHORIZED');
    assert.deepEqual(fixture.invocations, []);
    assert.equal(fixture.aliasUpdateAttempts.length, 0);
    assert.equal(fixture.aliasUpdates.length, 0);
    assert.equal(fixture.checkpointObjects.length, 0);
    assert.equal(fixture.appRequests.length, 0);
    assert.deepEqual(fixture.unhandled, []);
  });
});
