import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/i;
const VERSION = /^[1-9]\d*$/;
const ACCOUNT = '027224425948';
const INVENTORY_ALIAS = `arn:aws:lambda:us-east-1:${ACCOUNT}:function:IncidentTriageDemoInventory:live`;
const INVENTORY_FUNCTION = 'IncidentTriageDemoInventory';
const HEALTHY_ROLE = `arn:aws:iam::${ACCOUNT}:role/IncidentTriageDemoAppInventoryRole`;
const DENIED_ROLE = `arn:aws:iam::${ACCOUNT}:role/IncidentTriageDemoAppInventoryDeniedRole`;
const INVENTORY_TABLE = `arn:aws:dynamodb:us-east-1:${ACCOUNT}:table/IncidentTriageDemoInventory`;

function origin(name) {
  let url;
  try {
    url = new URL(process.env[name]);
  } catch {
    assert.fail(`${name} must be an explicit HTTPS origin`);
  }
  assert.equal(url.protocol, 'https:', `${name} must use HTTPS`);
  assert.match(url.hostname, /^[a-z0-9]+\.execute-api\.us-east-1\.amazonaws\.com$/,
    `${name} must be the checked AWS HTTP API origin`);
  assert.ok(!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
    `${name} must contain only the HTTPS origin`);
  return url.origin;
}

function actionId(name) {
  const value = process.env[name];
  assert.match(value ?? '', UUID, `${name} must be the browser-accepted action UUID`);
  return value;
}

function budgets(state) {
  const result = {
    generator: state.budgets?.checkout?.generatorRemaining,
    verification: state.budgets?.checkout?.verificationRemaining,
    catalog: state.budgets?.catalog?.remaining,
    orderStatus: state.budgets?.orderStatus?.remaining,
  };
  for (const [name, maximum] of Object.entries({ generator: 50, verification: 5, catalog: 120, orderStatus: 60 })) {
    assert.ok(Number.isSafeInteger(result[name]) && result[name] >= 0 && result[name] <= maximum,
      `invalid remaining ${name} allowance`);
  }
  return result;
}

function completedAction(action, id, kind) {
  assert.equal(action?.id, id);
  assert.equal(action?.kind, kind);
  assert.equal(action?.status, 'completed', `${kind} action must be settled successfully`);
  return action;
}

function requestId(record, label) {
  assert.equal(typeof record?.requestId, 'string', `${label} must retain its app request ID`);
  assert.ok(record.requestId.length > 0 && record.requestId.length <= 120, `${label} request ID must be bounded`);
  return record.requestId;
}

function checkoutAttempt(action, label) {
  const matches = action.requests.filter(({ kind }) => kind === 'checkout');
  assert.equal(matches.length, 1, `${label} must contain exactly one checkout request`);
  return matches[0];
}

function assertOrder(order, checkoutId, sku, quantity = 1) {
  assert.equal(order?.checkoutId, checkoutId);
  assert.equal(order?.sku, sku);
  assert.equal(order?.quantity, quantity);
  assert.equal(order?.status, 'placed');
}

function manifestVariant(manifest, access, label) {
  assert.equal(manifest?.schemaVersion, 1, `${label} must use the prepared Inventory manifest schema`);
  assert.match(manifest?.sourceRevision ?? '', SHA, `${label} source revision must be present`);
  assert.equal(manifest?.functionName, INVENTORY_FUNCTION);
  assert.equal(manifest?.aliasName, 'live');
  assert.ok(Number.isSafeInteger(manifest?.baselineMemoryMb), `${label} must expose baseline memory`);
  assert.equal(typeof manifest?.codeSha256, 'string', `${label} must expose the qualified code hash`);
  assert.ok(Array.isArray(manifest?.variants) && manifest.variants.length === 2,
    `${label} must expose exactly the Phase 3 healthy and denied variants`);
  const matches = manifest.variants.filter((variant) => variant?.access === access);
  assert.equal(matches.length, 1, `${label} must contain exactly one ${access} variant`);
  const variant = matches[0];
  assert.match(String(variant.version ?? ''), VERSION, `${label} ${access} variant must use a numeric version`);
  assert.equal(variant.memoryMb, manifest.baselineMemoryMb, `${label} ${access} variant memory mismatch`);
  assert.equal(variant.roleArn, access === 'healthy' ? HEALTHY_ROLE : DENIED_ROLE,
    `${label} ${access} variant role mismatch`);
  return variant;
}

function assertAliasObservation(alias, label, expectedVersion) {
  assert.ok(alias && typeof alias === 'object', `${label} must be present`);
  assert.equal(alias.functionName, INVENTORY_FUNCTION, `${label} function mismatch`);
  assert.equal(alias.aliasName, 'live', `${label} alias name mismatch`);
  if (expectedVersion === undefined) assert.match(alias.functionVersion ?? '', VERSION, `${label} must expose a numeric version`);
  else assert.equal(alias.functionVersion, expectedVersion, `${label} version mismatch`);
  assert.equal(alias.routingWeighted, false, `${label} must be an unweighted single-target alias`);
  assert.equal(alias.aliasArn, INVENTORY_ALIAS, `${label} must identify the Inventory live alias`);
  assert.equal(typeof alias.revisionId, 'string', `${label} must retain the alias revision`);
  assert.ok(alias.revisionId.length > 0 && alias.revisionId.length <= 256, `${label} alias revision must be bounded`);
  assert.ok(Number.isFinite(Date.parse(alias.observedAt)), `${label} must retain its observation time`);
  return alias;
}

function assertQualifiedCheckpoint(checkpoint, label, variant, manifest) {
  assert.equal(checkpoint?.status, 'stored', `${label} must be stored`);
  assert.equal(checkpoint.inventoryTableArn, INVENTORY_TABLE, `${label} table mismatch`);
  assert.equal(checkpoint.inventoryVersion, variant.version, `${label} version mismatch`);
  assert.equal(checkpoint.inventoryRoleArn, variant.roleArn, `${label} role mismatch`);
  assert.equal(checkpoint.inventoryMemory, variant.memoryMb, `${label} memory mismatch`);
  assert.equal(checkpoint.inventoryCodeSha256, manifest.codeSha256, `${label} code hash mismatch`);
  const aliasAtCapture = assertAliasObservation(checkpoint.inventoryAliasAtCapture, `${label} aliasAtCapture`, variant.version);
  assert.equal(checkpoint.inventoryAliasBefore.routingWeighted, false, `${label} aliasBefore must be unweighted`);
  return aliasAtCapture;
}

test('deployed Inventory denial and restoration checkpoints are visible through public APIs', {
  skip: process.env.PHASE3_LIVE !== '1' && 'Requires explicit deployed origins, action IDs, and credentials',
  timeout: 60_000,
}, async (t) => {
  const step = process.env.PHASE3_LIVE_STEP;
  assert.ok(step === 'denied' || step === 'restored', 'PHASE3_LIVE_STEP must be denied or restored');

  const controller = origin('PHASE3_CONTROLLER_URL');
  const app = origin('PHASE3_APP_URL');
  assert.notEqual(controller, app, 'the controller and app must use separate origins');

  const appRevision = process.env.PHASE3_EXPECTED_APP_SHA;
  assert.match(appRevision ?? '', SHA, 'supply the deployed app SHA');
  const operatorBearer = process.env.PHASE3_CONTROLLER_BEARER;
  const appBearer = process.env.PHASE3_APP_BEARER;
  assert.ok(operatorBearer && appBearer && operatorBearer !== appBearer &&
    !/\s/.test(operatorBearer) && !/\s/.test(appBearer), 'supply two distinct bearers privately');
  const privateValues = [operatorBearer, appBearer].flatMap((value) =>
    [value, createHash('sha256').update(value).digest('hex')]);

  async function request(path, expected, { base = controller, token = operatorBearer, method = 'GET', body } = {}) {
    const headers = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const label = `${method} ${path}`;
    let response, raw;
    try {
      response = await fetch(new URL(path, base), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(8_000),
      });
      raw = await response.text();
    } catch {
      assert.fail(`${label} could not complete`);
    }
    assert.ok(privateValues.every((value) => !raw.includes(value)), `${label} exposed a credential`);
    assert.ok([expected].flat().includes(response.status), `${label} returned HTTP ${response.status}`);
    if (base === controller) {
      assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/i, `${label} must not be cached`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      assert.fail(`${label} must return JSON`);
    }
    return { status: response.status, body: parsed };
  }

  const state = async () => (await request('/api/state', 200)).body;
  const actionPath = (id) => `/api/actions/${id}`;
  const readAction = async (id) => {
    const { action } = (await request(actionPath(id), 200)).body;
    assert.equal(action?.id, id);
    return action;
  };
  const appGet = async (path, expected) => (await request(path, expected, { base: app, token: appBearer })).body;
  const appPost = async (path, body, expected) => (await request(path, expected, {
    base: app, token: appBearer, method: 'POST', body,
  })).body;

  if (step === 'denied') {
    const activationId = actionId('PHASE3_ACTIVATION_ID');
    const activationKind = 'activate_inventory_denial';
    const activationCommand = { kind: activationKind };
    const activation = completedAction(await readAction(activationId), activationId, activationKind);
    const snapshot = await state();
    const baseline = snapshot.baseline;
    assert.equal(baseline?.appRevision, appRevision);
    assert.match(baseline?.checkoutId ?? '', UUID, 'a verified baseline order is required');
    assert.ok(typeof baseline.sku === 'string' && baseline.sku.length > 0);
    assert.ok(typeof baseline.productVersion === 'string' && baseline.productVersion.length > 0);
    assert.ok(Number.isFinite(Date.parse(baseline.verifiedAt)), 'baseline verification time must be recorded');
    assert.ok(Date.parse(baseline.verifiedAt) <= Date.parse(activation.startedAt ?? activation.createdAt),
      'readiness must precede the denial action');
    assert.equal(snapshot.currentAction?.id, activationId, 'the denied checkpoint must still be current');
    assert.equal(snapshot.currentAction?.status, 'completed');
    const manifest = baseline.settings?.inventoryVariantsManifest;
    assert.equal(manifest?.sourceRevision, appRevision, 'prepared Inventory manifest must match the readiness release');
    const healthyVariant = manifestVariant(manifest, 'healthy', 'baseline');
    const deniedVariant = manifestVariant(manifest, 'denied', 'baseline');
    assert.notEqual(healthyVariant.version, deniedVariant.version, 'prepared variants must use distinct versions');
    assert.equal(healthyVariant.roleArn, HEALTHY_ROLE);
    assert.equal(deniedVariant.roleArn, DENIED_ROLE);
    const baselineInventory = baseline.settings?.inventory;
    assert.equal(baselineInventory?.version, healthyVariant.version, 'readiness must start on the prepared healthy version');
    assert.equal(baselineInventory?.role, HEALTHY_ROLE, 'readiness must record the healthy Inventory role');
    assert.equal(baselineInventory?.memory, manifest.baselineMemoryMb, 'readiness must record baseline Inventory memory');
    assert.equal(baselineInventory?.codeSha256, manifest.codeSha256, 'readiness must record the prepared code hash');
    assert.equal(baselineInventory?.aliasArn, INVENTORY_ALIAS, 'readiness must record the Inventory live alias');

    const incident = snapshot.incident;
    assert.equal(incident?.kind, 'inventory_access_denied');
    assert.equal(incident?.mechanism, 'lambda-alias');
    assert.equal(incident?.activationActionId, activationId);
    assert.equal(incident?.active, 'denied');
    assert.deepEqual(incident?.target, deniedVariant, 'activation must retain the selected denied manifest variant');
    const aliasBefore = assertAliasObservation(incident?.aliasBefore, 'activation aliasBefore', healthyVariant.version);
    const deniedAlias = assertAliasObservation(incident?.alias, 'activation alias', deniedVariant.version);
    assert.notEqual(deniedAlias.revisionId, aliasBefore.revisionId, 'activation must read back a changed alias revision');
    const actionAliasBefore = assertAliasObservation(activation.inventorySwitch?.before, 'activation action aliasBefore', healthyVariant.version);
    assert.equal(actionAliasBefore.revisionId, aliasBefore.revisionId,
      'activation action and incident must retain the same alias before observation');
    assert.deepEqual(activation.inventorySwitch?.target, deniedVariant, 'activation action must retain the selected denied manifest variant');
    const actionDeniedAlias = assertAliasObservation(activation.inventorySwitch?.after, 'activation action aliasAfter', deniedVariant.version);
    assert.notEqual(actionDeniedAlias.revisionId, actionAliasBefore.revisionId,
      'activation action must read back a changed alias revision');
    assert.equal(activation.inventorySwitch.after.revisionId, deniedAlias.revisionId,
      'activation action must retain the actual denied alias readback');
    const checkpoint = incident?.checkpoint;
    const capturedAlias = assertQualifiedCheckpoint(checkpoint, 'denied configuration checkpoint', deniedVariant, manifest);
    assertAliasObservation(checkpoint.inventoryAliasBefore, 'checkpoint aliasBefore', healthyVariant.version);
    assert.equal(capturedAlias.revisionId, deniedAlias.revisionId, 'checkpoint must retain the actual denied alias revision');

    const catalogs = activation.requests.filter(({ kind }) => kind === 'catalog');
    assert.ok(catalogs.length >= 1 && catalogs.length <= 6, 'catalog probes must stay within the activation allowance');
    const deniedCatalog = catalogs.at(-1);
    assert.equal(deniedCatalog.statusCode, 502);
    assert.equal(deniedCatalog.errorCode, 'INVENTORY_LOOKUP_FAILED');
    assert.equal(deniedCatalog.dependencyReason, 'inventory_access_denied');
    assert.equal(deniedCatalog.outcome, 'failed');

    const failedCheckout = checkoutAttempt(activation, 'activation');
    assert.equal(failedCheckout.statusCode, 502);
    assert.equal(failedCheckout.errorCode, 'INVENTORY_LOOKUP_FAILED');
    assert.equal(failedCheckout.dependencyReason, 'inventory_access_denied');
    assert.equal(failedCheckout.outcome, 'failed');
    assert.equal(failedCheckout.checkout?.sku, baseline.sku);
    assert.equal(failedCheckout.checkout?.quantity, 1);
    assert.equal(failedCheckout.checkout?.productVersion, baseline.productVersion);
    assert.match(failedCheckout.checkout?.checkoutId ?? '', UUID);
    assert.notEqual(failedCheckout.checkout.checkoutId, baseline.checkoutId,
      'the denied checkout must use a fresh identity');
    const deniedIds = [requestId(deniedCatalog, 'denied catalog'), requestId(failedCheckout, 'denied checkout')];
    assert.notEqual(deniedIds[0], deniedIds[1], 'distinct app requests must retain distinct request IDs');

    const beforeReplayBudgets = budgets(snapshot);
    const beforeReplayRequestIds = activation.requests.map(({ id, requestId: appRequestId }) => ({ id, requestId: appRequestId }));
    const replay = await request(actionPath(activationId), 200, { method: 'PUT', body: activationCommand });
    assert.equal(replay.body.action?.id, activationId);
    assert.equal(replay.body.action?.kind, activationKind);
    assert.equal(replay.body.action?.status, 'completed');
    const afterReplay = await state();
    assert.deepEqual(budgets(afterReplay), beforeReplayBudgets, 'duplicate activation must spend no additional app budget');
    const replayedAction = await readAction(activationId);
    assert.deepEqual(replayedAction.requests.map(({ id, requestId: appRequestId }) => ({ id, requestId: appRequestId })),
      beforeReplayRequestIds, 'duplicate activation must not add app requests');

    const savedPath = `/api/orders/${encodeURIComponent(baseline.checkoutId)}`;
    const savedBefore = await appGet(savedPath, 200);
    assertOrder(savedBefore.order, baseline.checkoutId, baseline.sku);
    assert.equal(typeof savedBefore.requestId, 'string');

    const duplicate = await appPost('/api/checkout', {
      checkoutId: baseline.checkoutId,
      sku: baseline.sku,
      quantity: 1,
      productVersion: baseline.productVersion,
    }, 200);
    assertOrder(duplicate.order, baseline.checkoutId, baseline.sku);
    assert.equal(typeof duplicate.requestId, 'string', 'matching saved-order replay must retain its request ID');
    assert.equal(typeof duplicate.order.createdAt, 'string');

    const savedAfter = await appGet(savedPath, 200);
    assertOrder(savedAfter.order, baseline.checkoutId, baseline.sku);
    assert.deepEqual(savedAfter.order, savedBefore.order, 'the existing receipt must remain unchanged while access is denied');
    const missing = await appGet(`/api/orders/${encodeURIComponent(failedCheckout.checkout.checkoutId)}`, 404);
    assert.equal(missing.code, 'ORDER_NOT_FOUND');

    t.diagnostic(`denied catalog requestId=${deniedIds[0]}`);
    t.diagnostic(`denied checkout requestId=${deniedIds[1]}`);
    t.diagnostic(`denied Inventory version=${deniedVariant.version} memory=${deniedVariant.memoryMb}`);
    t.diagnostic(`matching saved-order replay requestId=${duplicate.requestId}`);
    t.diagnostic(`denied checkout status requestId=${missing.requestId ?? 'not returned'}`);
    return;
  }

  const restoreId = actionId('PHASE3_RESTORE_ID');
  const recoveryId = actionId('PHASE3_RECOVERY_ID');
  const restore = completedAction(await readAction(restoreId), restoreId, 'restore_inventory_access');
  assert.deepEqual(restore.requests, [], 'restoration must change configuration only and send no app requests');
  const restoreSwitch = restore.inventorySwitch;
  const restoreBefore = assertAliasObservation(restoreSwitch?.before, 'restore action aliasBefore', undefined);
  const restoreTarget = restoreSwitch?.target;
  assert.equal(restoreTarget?.access, 'healthy', 'restore must target the healthy prepared variant');
  assert.equal(restoreTarget?.roleArn, HEALTHY_ROLE, 'restore must target the healthy Inventory role');
  assert.match(restoreTarget?.version ?? '', VERSION, 'restore must target a numeric prepared version');
  const restoreAfter = assertAliasObservation(restoreSwitch?.after, 'restore action aliasAfter', restoreTarget.version);
  assert.notEqual(restoreAfter.revisionId, restoreBefore.revisionId, 'restore must read back a changed alias revision');

  const recovery = completedAction(await readAction(recoveryId), recoveryId, 'readiness');
  assert.ok(Date.parse(restore.finishedAt) <= Date.parse(recovery.startedAt ?? recovery.createdAt),
    'fresh readiness must follow completed Inventory alias restoration');
  const snapshot = await state();
  assert.equal(snapshot.currentAction?.id, recoveryId, 'the recovery readiness action must be current');
  assert.equal(snapshot.currentAction?.status, 'completed');
  const baseline = snapshot.baseline;
  assert.equal(baseline?.appRevision, appRevision);
  assert.match(baseline?.checkoutId ?? '', UUID);
  assert.ok(baseline.sku && baseline.productVersion);
  assert.ok(Number.isSafeInteger(baseline.stockBefore) && Number.isSafeInteger(baseline.stockAfter));
  assert.equal(baseline.stockBefore - baseline.stockAfter, 1, 'fresh readiness must confirm its one-unit order');
  assert.ok(Date.parse(baseline.verifiedAt) >= Date.parse(restore.finishedAt),
    'recovery readiness must establish a post-restoration baseline');
  const recoveredHealthy = baseline.settings?.inventory;
  assert.equal(recoveredHealthy?.role, HEALTHY_ROLE, 'recovery readiness must use the healthy Inventory role');
  assert.match(recoveredHealthy?.version ?? '', VERSION, 'recovery readiness must retain a numeric Inventory version');
  assert.equal(recoveredHealthy?.version, restoreTarget.version,
    'recovery readiness must use the healthy prepared version selected by restoration');
  assert.equal(recoveredHealthy?.memory, restoreTarget.memoryMb,
    'restoration must preserve the current Inventory memory');
  const recoveredManifest = baseline.settings?.inventoryVariantsManifest;
  const recoveredHealthyVariant = manifestVariant(recoveredManifest, 'healthy', 'recovery');
  assert.equal(recoveredHealthyVariant.version, restoreTarget.version);
  assert.deepEqual(restoreTarget, recoveredHealthyVariant, 'restore must target the manifest healthy variant for the current release');
  assert.equal(recoveredHealthy?.codeSha256, recoveredManifest.codeSha256);
  const retainedIncident = snapshot.incident;
  assert.equal(retainedIncident?.restoreActionId, restoreId, 'restored incident must retain the restore action identity');
  assert.equal(retainedIncident?.active, 'healthy', 'restored incident must report healthy active access');
  const restoredAlias = assertAliasObservation(retainedIncident?.alias, 'restored incident alias', restoreTarget.version);
  assert.equal(restoredAlias.revisionId, restoreAfter.revisionId, 'incident must retain the restore alias readback');
  const retainedCheckpoint = retainedIncident?.checkpoint;
  const deniedVariant = manifestVariant(recoveredManifest, 'denied', 'retained checkpoint');
  const capturedDeniedAlias = assertQualifiedCheckpoint(retainedCheckpoint, 'retained denied checkpoint', deniedVariant, recoveredManifest);
  assert.equal(restoreBefore.functionVersion, capturedDeniedAlias.functionVersion,
    'restore must read the denied alias target before switching');
  assert.equal(restoreBefore.revisionId, capturedDeniedAlias.revisionId,
    'restore must retain the denied alias revision it guarded');
  assertAliasObservation(retainedCheckpoint.inventoryAliasBefore, 'retained checkpoint aliasBefore', deniedVariant.version);
  assert.equal(retainedCheckpoint.inventoryRoleArn, DENIED_ROLE, 'retained checkpoint must preserve the denied role');
  assert.equal(retainedCheckpoint.inventoryAliasAtCapture.functionVersion, deniedVariant.version,
    'retained checkpoint must preserve the denied alias target at capture');
  assert.equal(capturedDeniedAlias.functionVersion, deniedVariant.version);

  const checkout = checkoutAttempt(recovery, 'recovery readiness');
  assert.ok([200, 201].includes(checkout.statusCode));
  assert.equal(checkout.outcome, 'success');
  assert.equal(checkout.checkout?.checkoutId, baseline.checkoutId);
  assert.equal(checkout.checkout?.sku, baseline.sku);
  assert.equal(checkout.checkout?.quantity, 1);
  assert.equal(checkout.checkout?.productVersion, baseline.productVersion);
  const catalogRequests = recovery.requests.filter(({ kind }) => kind === 'catalog');
  assert.equal(catalogRequests.length, 2, 'readiness must bracket its order with catalog reads');
  for (const [index, item] of catalogRequests.entries()) {
    assert.equal(item.statusCode, 200, `recovery catalog read ${index + 1} must succeed`);
    assert.equal(item.outcome, 'success');
    requestId(item, `recovery catalog read ${index + 1}`);
  }
  const statusRequests = recovery.requests.filter(({ kind }) => kind === 'order_status');
  assert.equal(statusRequests.length, 1, 'readiness must confirm the saved order through status');
  assert.equal(statusRequests[0].checkoutId, baseline.checkoutId);
  assert.equal(statusRequests[0].statusCode, 200);
  assert.equal(statusRequests[0].outcome, 'success');
  requestId(checkout, 'recovery checkout');
  requestId(statusRequests[0], 'recovery order status');

  const existing = await appGet(`/api/orders/${encodeURIComponent(baseline.checkoutId)}`, 200);
  assertOrder(existing.order, baseline.checkoutId, baseline.sku);
  assert.deepEqual(existing.order, baseline.receipt);
  assert.ok(snapshot.receipts?.some(({ checkoutId }) => checkoutId === baseline.checkoutId),
    'the fresh recovery receipt must remain visible in controller state');

  t.diagnostic(`restoration action=${restoreId} completed without app requests`);
  t.diagnostic(`restored Inventory version=${restoreTarget.version} memory=${restoreTarget.memoryMb}`);
  t.diagnostic(`recovery checkout requestId=${checkout.requestId}`);
  t.diagnostic(`recovery order-status requestId=${statusRequests[0].requestId}`);
  t.diagnostic(`recovery app order status requestId=${existing.requestId ?? 'not returned'}`);
});
