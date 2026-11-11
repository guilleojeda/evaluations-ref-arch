import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import * as harness from './support/phase3-inventory-controller-harness.mjs';

const { root, account, region, appRevision, newerRevision, table, tableArn, inventoryRoleArn,
  inventoryRoleName, deniedRoleArn, deniedRoleName, policyName, policyArn, checkoutRoleArn, appApi,
  operatorBearer, appBearer, runTable, evidenceBucket, evidencePrefix, manifestBucket, manifestKey,
  healthyVersion, deniedVersion, records, fixture, row, put, iamPolicyDocument, variantsManifest, reset,
  stackXml, resourcesXml, requestBody, awsProtocol, startAwsServer, awsEnvironment, httpEvent,
  appResponse, appReply, appFetch, releaseHeld, call, assertActivationRejected, denialDocument,
  getAction, getState, submit, withElapsed, activateAndConfirm, assertActivationFailsBeforeAlias } = harness;

test('Inventory denial alias activation and restoration fail closed', { timeout: 90_000 }, async (t) => {
  const server = await startAwsServer();
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
  });
  awsEnvironment(server.address().port);
  globalThis.fetch = appFetch;

  const backendPath = pathToFileURL(resolve(root, '.artifacts/controller/backend/index.mjs')).href;
  const workerPath = pathToFileURL(resolve(root, '.artifacts/controller/backend/worker.mjs')).href;
  const api = await import(`${backendPath}?phase3=${Date.now()}`);
  const worker = await import(`${workerPath}?phase3=${Date.now()}`);

  await t.test('a newer deployed app revision makes the ready baseline stale', async () => {
    fixture.revision = newerRevision;
    const action = await assertActivationRejected({
      api, worker, baselineRevision: appRevision, revision: newerRevision,
      expectedError: /baseline|release|revision|changed/i,
    });
    assert.ok(action.finishedAt, 'the stale-baseline rejection must be durably settled');
  });

  await t.test('a changed denied-role attachment fails closed before alias mutation', async () => {
    reset({ deniedAttached: false });
    const id = await submit(api, 'activate_inventory_denial');
    await worker.handler({ actionId: id });
    const action = await getAction(api, id);
    assert.equal(action.status, 'failed');
    assert.match(action.error ?? '', /attach|policy|drift|baseline/i);
    assert.equal(fixture.aliasUpdates.length, 0, 'attachment drift must not update the alias');
    assert.equal(fixture.deniedRoleAttached, false);
    assert.equal(fixture.appRequests.length, 0, 'an existing attachment must not send an app probe');
    assert.ok(fixture.dynamoPolicyReads.length > 0, 'readiness must retain the Dynamo absence read');
    assert.ok(fixture.dynamoPolicyReads.every((resourceArn) => resourceArn === tableArn),
      'Dynamo absence reads must target only the Inventory table');
    assert.ok(fixture.iamReads.every(({ RoleName, PolicyArn }) =>
      (!RoleName || [inventoryRoleName, deniedRoleName].includes(RoleName)) && (!PolicyArn || PolicyArn === policyArn)));
    assert.deepEqual(fixture.mutations, []);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('missing, stale or malformed manifests fail before alias mutation', async () => {
    for (const [mode, expectedError] of [['missing', /manifest|unavailable|NoSuchKey|provider/i], ['stale', /stale|release|revision/i], ['malformed', /manifest|schema|invalid/i]]) {
      await assertActivationFailsBeforeAlias({ api, worker, configure: () => { fixture.manifestMode = mode; }, expectedError });
    }
  });

  await t.test('weighted aliases and denied configuration drift fail before alias mutation', async () => {
    await assertActivationFailsBeforeAlias({ api, worker, configure: () => { fixture.weightedAlias = true; }, expectedError: /weighted|alias|version/i });
    reset({ aliasVersion: '99' });
    const unlistedId = await submit(api, 'activate_inventory_denial');
    await worker.handler({ actionId: unlistedId });
    const unlisted = await getAction(api, unlistedId);
    assert.match(unlisted.error ?? '', /alias|version|baseline/i);
    assert.equal(fixture.aliasUpdates.length, 0);
    assert.equal(fixture.appRequests.length, 0);
    for (const mode of ['memory', 'code', 'env']) {
      await assertActivationFailsBeforeAlias({ api, worker, configure: () => { fixture.deniedConfigMode = mode; }, expectedError: /variant|configuration|environment|manifest|code|memory/i });
    }
  });

  await t.test('activation checkpoints and updates the single live alias to the denied variant', async () => {
    const { id, action, state } = await activateAndConfirm({ api, worker });
    assert.equal(action.status, 'completed');
    assert.equal(fixture.aliasUpdates.length, 1);
    assert.equal(fixture.aliasUpdates[0].version, deniedVersion);
    assert.equal(fixture.aliasUpdateAttempts[0].revisionId, 'alias-revision-1', 'UpdateAlias must carry the observed alias revision in its JSON body');
    assert.equal(fixture.aliasVersion.Inventory, deniedVersion);
    assert.equal(state.incident?.mechanism, 'lambda-alias');
    assert.equal(state.incident?.active, 'denied');
    assert.equal(state.incident?.target?.version, deniedVersion);
    assert.equal(state.incident?.target?.roleArn, deniedRoleArn);
    assert.equal(state.incident?.alias?.functionVersion, deniedVersion);
    assert.equal(state.incident?.alias?.routingWeighted, false);
    assert.equal(state.incident?.aliasBefore?.functionVersion, healthyVersion);
    assert.equal(state.incident?.policyBefore?.state, 'present');
    assert.equal(state.incident?.policyBefore?.roleArn, deniedRoleArn);
    assert.equal(state.incident?.checkpoint?.status, 'stored');
    assert.equal(state.incident?.checkpoint?.inventoryAliasBefore?.functionVersion, healthyVersion);
    assert.equal(state.incident?.checkpoint?.inventoryAliasAtCapture?.functionVersion, deniedVersion);
    assert.equal(state.incident?.checkpoint?.inventoryVersion, deniedVersion);
    assert.equal(state.incident?.checkpoint?.inventoryRoleArn, deniedRoleArn);
    assert.equal(fixture.checkpointObjects.length, 1, 'activation must retain one pre-switch checkpoint');
    const checkpointBody = typeof fixture.checkpointObjects[0].body === 'string'
      ? JSON.parse(fixture.checkpointObjects[0].body) : fixture.checkpointObjects[0].body;
    assert.equal(checkpointBody.inventoryAliasBefore?.functionVersion, healthyVersion, 'durable capture must retain the healthy alias before switching');
    assert.equal(checkpointBody.inventoryAliasAtCapture?.functionVersion, deniedVersion, 'durable capture must retain the denied alias at capture');
    assert.equal(checkpointBody.target?.inventoryRoleArn, deniedRoleArn);
    assert.equal(checkpointBody.settings?.inventory?.version, deniedVersion);
    assert.ok(fixture.appRequests.some(({ path }) => path === '/api/products'), 'activation must retain a catalog denial probe');
    assert.ok(fixture.appRequests.some(({ path, method }) => path === '/api/checkout' && method === 'POST'), 'activation must retain a fresh denial checkout');
    assert.deepEqual(fixture.iamPolicyDocument, denialDocument(id));
    assert.ok(fixture.iamReads.some(({ action: readAction }) => readAction === 'ListAttachedRolePolicies'));
    assert.ok(fixture.iamReads.some(({ action: readAction }) => readAction === 'GetPolicy'));
    assert.ok(fixture.iamReads.some(({ action: readAction }) => readAction === 'GetPolicyVersion'));
    assert.ok(fixture.dynamoPolicyReads.length > 0);
    assert.ok(fixture.dynamoPolicyReads.every((resourceArn) => resourceArn === tableArn));
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('a live default policy version drift from baseline v1 to v2 blocks activation before mutation', async () => {
    const document = denialDocument();
    reset({ versionId: 'v2', versionDocuments: new Map([['v1', document], ['v2', document]]) });
    const id = await submit(api, 'activate_inventory_denial');
    await worker.handler({ actionId: id });
    const action = await getAction(api, id);
    assert.equal(action.status, 'failed');
    assert.match(action.error ?? '', /version|policy|drift|changed/i);
    assert.equal(fixture.iamDefaultVersionId, 'v2');
    assert.equal(fixture.aliasUpdates.length, 0, 'policy drift must be rejected before UpdateAlias');
    assert.equal(fixture.appRequests.length, 0, 'version drift must not send app probes');
    assert.equal(fixture.checkpointObjects.length, 0, 'version drift must not capture a checkpoint');
    assert.ok(fixture.iamReads.some(({ action: readAction, VersionId }) =>
      readAction === 'GetPolicyVersion' && VersionId === 'v2'));
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('a lost UpdateAlias acknowledgement reconciles without resending', async () => {
    const { id, action, state } = await activateAndConfirm({ api, worker, aliasMode: 'lost-ack' });
    assert.equal(action.status, 'completed');
    assert.equal(fixture.aliasUpdates.length, 1, 'lost acknowledgement must not resend UpdateAlias');
    assert.equal(fixture.aliasVersion.Inventory, deniedVersion, 'readback must reconcile the alias target');
    assert.equal(state.incident?.kind, 'inventory_access_denied');
    assert.equal(state.incident?.activationActionId, id);
    assert.equal(state.incident?.active, 'denied');
    assert.equal(state.incident?.policy?.policyArn, policyArn);
    assert.equal(state.incident?.policy?.policyName, policyName);
    assert.equal(state.incident?.policy?.roleArn, deniedRoleArn);
    assert.equal(state.incident?.policy?.defaultVersionId, 'v1');
    assert.equal(state.incident?.policy?.documentMatches, true);
    assert.equal(state.incident?.policyBefore?.state, 'present');
    assert.equal(state.incident?.checkpoint?.status, 'stored');
    assert.equal(state.incident?.checkpoint?.inventoryPolicyAtCapture?.policyArn, policyArn);
    assert.equal(state.incident?.checkpoint?.inventoryPolicyAtCapture?.roleArn, deniedRoleArn);
    assert.equal(state.incident?.checkpoint?.inventoryPolicyAtCapture?.defaultVersionId, 'v1');
    assert.equal(state.incident?.checkpoint?.inventoryPolicyAtCapture?.documentMatches, true);
    assert.equal(state.incident?.checkpoint?.tablePolicyBefore?.state, 'absent');
    assert.equal(fixture.checkpointObjects.length, 1, 'successful reconciliation must retain a checkpoint');
    assert.ok(fixture.checkpointObjects[0].key.startsWith(evidencePrefix));
    const checkpointBody = typeof fixture.checkpointObjects[0].body === 'string'
      ? JSON.parse(fixture.checkpointObjects[0].body) : fixture.checkpointObjects[0].body;
    assert.deepEqual(checkpointBody.policyDocument, denialDocument(), 'checkpoint must retain the exact provisioned IAM policy document');
    assert.ok(fixture.appRequests.some(({ path }) => path === '/api/products'));
    assert.ok(fixture.appRequests.some(({ path, method }) => path === '/api/checkout' && method === 'POST'));
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('a lost alias acknowledgement with no observed target stays unknown and blocks reuse', async () => {
    reset();
    fixture.aliasMode = 'lost-no-observation';
    const id = await submit(api, 'activate_inventory_denial');
    await worker.handler({ actionId: id });
    const action = await getAction(api, id);
    const state = await getState(api);
    assert.equal(action.status, 'incomplete');
    assert.equal(action.configurationOutcome, 'unknown');
    assert.equal(state.incident?.activationActionId, id);
    assert.equal(state.incident?.active, 'unknown', 'an uncertain alias update is not proof of a safe healthy target');
    assert.equal(fixture.aliasUpdates.length, 0, 'an unobserved alias update must not be repeated');
    assert.equal(fixture.aliasVersion.Inventory, healthyVersion);
    assert.equal(fixture.appRequests.length, 0, 'unknown attachment must not send app probes');
    assert.equal(fixture.checkpointObjects.length, 0, 'unknown attachment must not capture incident evidence');

    const readinessId = randomUUID();
    const readiness = await call(api, 'PUT', `/api/actions/${readinessId}`,
      { kind: 'readiness', confirmQuiet: true }, 409);
    assert.match(readiness.code ?? '', /incident|unknown|incomplete/i);
    const retryId = randomUUID();
    const retry = await call(api, 'PUT', `/api/actions/${retryId}`,
      { kind: 'activate_inventory_denial' }, 409);
    assert.match(retry.code ?? '', /incident|unknown|incomplete/i);
    assert.deepEqual(fixture.invocations, [id], 'blocked readiness/reactivation must not dispatch workers');

    const discardId = randomUUID();
    const discardedCommand = await withElapsed(120_000, () => call(api, 'PUT', `/api/actions/${discardId}`,
      { kind: 'discard', targetActionId: id }, 202));
    assert.equal(discardedCommand.action?.status, 'completed');
    assert.equal((await getAction(api, id)).status, 'discarded');
    const trafficId = randomUUID();
    const traffic = await call(api, 'PUT', `/api/actions/${trafficId}`, { kind: 'traffic' }, 409);
    assert.equal(traffic.code, 'INVENTORY_DENIAL_UNRESOLVED');
    assert.deepEqual(fixture.invocations, [id], 'discard and blocked traffic must not dispatch workers');
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('an alias revision drift blocks restore and preserves the denied target', async () => {
    const activation = await activateAndConfirm({ api, worker });
    const beforeRestoreRequests = fixture.appRequests.length;
    const beforeUpdates = fixture.aliasUpdates.length;
    fixture.aliasMode = 'conflict';
    const restoreId = await submit(api, 'restore_inventory_access');
    await worker.handler({ actionId: restoreId });
    const restore = await getAction(api, restoreId);
    assert.notEqual(restore.status, 'completed');
    assert.match(restore.error ?? '', /version|policy|drift|changed/i);
    assert.equal(fixture.aliasUpdates.length, beforeUpdates, 'revision drift must not record an applied UpdateAlias');
    assert.equal(fixture.aliasUpdateAttempts.at(-1)?.revisionId, 'alias-revision-2', 'restore must carry the current observed alias revision in the body');
    assert.equal(fixture.aliasVersion.Inventory, deniedVersion, 'revision drift must preserve the denied target');
    assert.equal(activation.state.incident?.active, 'denied');
    assert.equal(fixture.appRequests.length, beforeRestoreRequests, 'restore must not send app probes');
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('an already-healthy alias is a no-op with no app traffic', async () => {
    await activateAndConfirm({ api, worker });
    fixture.aliasVersion.Inventory = healthyVersion;
    const beforeUpdates = fixture.aliasUpdates.length;
    const beforeRequests = fixture.appRequests.length;
    const restoreId = await submit(api, 'restore_inventory_access');
    await worker.handler({ actionId: restoreId });
    const restore = await getAction(api, restoreId);
    assert.equal(restore.status, 'completed');
    assert.equal(fixture.aliasUpdates.length, beforeUpdates, 'healthy alias must not issue a duplicate UpdateAlias');
    assert.equal(fixture.aliasVersion.Inventory, healthyVersion);
    assert.equal(fixture.appRequests.length, beforeRequests, 'no-op restore must not send app probes');
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('a lost restore UpdateAlias acknowledgement reconciles the healthy target without reissue', async () => {
    await activateAndConfirm({ api, worker });
    const beforeRequests = fixture.appRequests.length;
    fixture.aliasMode = 'lost-ack';
    const restoreId = await submit(api, 'restore_inventory_access');
    await worker.handler({ actionId: restoreId });
    const restore = await getAction(api, restoreId);
    const state = await getState(api);
    assert.equal(restore.status, 'completed');
    assert.equal(restore.configurationOutcome, 'applied');
    assert.equal(fixture.aliasUpdates.length, 2, 'observed restore must not be retried');
    assert.equal(fixture.aliasVersion.Inventory, healthyVersion);
    assert.equal(state.incident?.active, 'healthy');
    assert.equal(fixture.appRequests.length, beforeRequests, 'restore must not send app probes');
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('ordinary restore stops on unavailable checkpoint, protective restore preserves the gap', async () => {
    await activateAndConfirm({ api, worker });
    const beforeUpdates = fixture.aliasUpdates.length;
    const beforeRequests = fixture.appRequests.length;
    fixture.checkpointMode = 'fail';
    const ordinaryId = await submit(api, 'restore_inventory_access');
    await worker.handler({ actionId: ordinaryId });
    const ordinary = await getAction(api, ordinaryId);
    assert.notEqual(ordinary.status, 'completed');
    assert.match(ordinary.error ?? '', /checkpoint|evidence|capture|unavailable/i);
    assert.equal(fixture.aliasUpdates.length, beforeUpdates, 'ordinary restore must not update without its checkpoint');
    assert.equal(fixture.aliasVersion.Inventory, deniedVersion, 'the known denial must remain active after ordinary restore is blocked');
    assert.equal(fixture.appRequests.length, beforeRequests, 'restore must not send an app request');
    const blockedState = await getState(api);
    assert.match(blockedState.incident?.checkpoint?.status ?? '', /unavailable|incomplete/);

    fixture.checkpointMode = 'fail';
    const protectiveId = await submit(api, 'restore_inventory_access', { restoreWithoutEvidence: true });
    await worker.handler({ actionId: protectiveId });
    const protective = await getAction(api, protectiveId);
    assert.equal(protective.status, 'completed');
    assert.equal(fixture.aliasUpdates.length, beforeUpdates + 1);
    assert.equal(fixture.aliasUpdates.at(-1).version, healthyVersion);
    assert.equal(fixture.aliasVersion.Inventory, healthyVersion, 'protective restore must select the healthy version');
    assert.equal(fixture.appRequests.length, beforeRequests, 'protective restore must not send an app request');
    const restoredState = await getState(api);
    assert.equal(restoredState.incident?.checkpoint?.status, 'incomplete');
    assert.match(restoredState.incident?.checkpoint?.error ?? '', /evidence|capture|checkpoint/i);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('restore runs independently while held traffic drains through Stop', async () => {
    const activation = await activateAndConfirm({ api, worker });
    const activationRequestCount = fixture.appRequests.length;
    fixture.appMode = 'hold';
    const trafficId = await submit(api, 'traffic');
    const trafficRun = worker.handler({ actionId: trafficId });
    let releaseAliasUpdate;
    let restoreRun;
    let restoreId;
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && fixture.appRequests.length < activationRequestCount + 3) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      assert.equal(fixture.appRequests.length, activationRequestCount + 3, 'traffic must hold one catalog and two checkout requests');
      const held = await getAction(api, trafficId);
      assert.equal(held.traffic.catalog.inFlight, 1);
      assert.equal(held.traffic.checkout.inFlight, 2);

      const beforeRestoreRequests = fixture.appRequests.length;
      const aliasGate = new Promise((resolveAlias) => { releaseAliasUpdate = resolveAlias; });
      fixture.beforeAliasUpdate = async () => {
        fixture.aliasUpdateEntered = true;
        await aliasGate;
      };
      restoreId = await submit(api, 'restore_inventory_access');
      restoreRun = worker.handler({ actionId: restoreId });
      const aliasDeadline = Date.now() + 10_000;
      while (Date.now() < aliasDeadline && !fixture.aliasUpdateEntered) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      assert.equal(fixture.aliasUpdateEntered, true, 'restore must reach the exact UpdateAlias call');
      assert.equal(fixture.appRequests.length, beforeRestoreRequests, 'restore must not submit probes');
      const stopId = await submit(api, 'stop', { targetActionId: trafficId });
      const stop = await getAction(api, stopId);
      assert.equal(stop.status, 'completed');
      const draining = await getAction(api, trafficId);
      assert.equal(draining.status, 'draining');
      assert.equal(draining.stopRequested, true);
      const restoreWhileHeld = await getAction(api, restoreId);
      assert.equal(restoreWhileHeld.status, 'running', 'Stop must not cancel or replace the in-flight restore');
    } finally {
      releaseAliasUpdate?.();
      releaseHeld();
      await Promise.all([trafficRun, restoreRun].filter(Boolean));
    }
    const restore = await getAction(api, restoreId);
    assert.equal(restore.status, 'completed');
    const stopped = await getAction(api, trafficId);
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.traffic.catalog.inFlight, 0);
    assert.equal(stopped.traffic.checkout.inFlight, 0);
    assert.equal(fixture.appRequests.length, activationRequestCount + 3, 'Stop must drain held requests without new producers');
    assert.equal((await getState(api)).incident?.activationActionId, activation.id);
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('a generic 502 cannot confirm access denial', async () => {
    const { id, action, state } = await activateAndConfirm({ api, worker, appMode: 'generic-502' });
    assert.ok(['failed', 'incomplete'].includes(action.status), 'a generic 502 must not complete activation');
    assert.match(action.error ?? '', /denial|specific|dependency|confirmed|evidence|effect/i);
    const request = action.requests.find(({ kind }) => kind === 'catalog' || kind === 'checkout');
    assert.ok(request, 'the activation must retain the attempted probe');
    assert.notEqual(request.dependencyReason, 'inventory_access_denied');
    const catalogs = action.requests.filter(({ kind }) => kind === 'catalog');
    assert.equal(catalogs.length, 6);
    assert.equal(fixture.aliasVersion.Inventory, deniedVersion, 'unconfirmed effect leaves the selected denied alias active');
    assert.equal(state.incident?.activationActionId, id, 'the owned intent must remain visible for reconciliation');
    assert.deepEqual(fixture.iamPolicyDocument, denialDocument(id), 'the managed policy document must remain unchanged after an unconfirmed probe');
    assert.equal(fixture.deniedRoleAttached, true, 'the permanent denied-role policy remains attached');
    assert.deepEqual(fixture.unhandled, []);
  });
});
