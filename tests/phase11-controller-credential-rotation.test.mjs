import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  appApi, appBearer, appFetch, appRevision, awsEnvironment, call, fixture,
  getAction, getState, httpEvent, releaseHeld, reset, root, row, startAwsServer, submit,
} from './support/phase3-inventory-controller-harness.mjs';

const oldOperator = 'fixture-operator';
const nextOperator = 'fixture-operator-v2';
const nextAppBearer = 'fixture-app-v2';
const nextGeneration = 'fixture-generation-v2';
const nextCheckoutVersion = '27';

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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

async function runAction(api, worker, kind, extra = {}) {
  const id = await submit(api, kind, extra);
  await worker.handler({ actionId: id });
  return { id, action: await getAction(api, id), state: await getState(api) };
}

async function waitFor(description, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function applyRotation({ revision = appRevision } = {}) {
  fixture.operatorBearer = nextOperator;
  fixture.operatorSecretBearer = nextOperator;
  fixture.workerAppBearer = nextAppBearer;
  fixture.checkoutServingCredentialDigest = digest(nextAppBearer);
  fixture.checkoutServingCredentialGeneration = nextGeneration;
  fixture.credentialGeneration = nextGeneration;
  fixture.checkoutQualifiedVersion = nextCheckoutVersion;
  fixture.checkoutAliasVersion = nextCheckoutVersion;
  fixture.checkoutServingVersion = nextCheckoutVersion;
  fixture.aliasVersion.Checkout = nextCheckoutVersion;
  fixture.revision = revision;
  fixture.stackLastUpdatedAt = '2026-11-14T00:00:00.000Z';
}

function assertNoRuntimeEffects({ action, label }) {
  assert.equal(action.status, 'failed', `${label}: ${action.error}`);
  assert.equal(fixture.appRequests.length, 0, `${label}: no business request was sent`);
  assert.equal(fixture.concurrencyWrites.length, 0, `${label}: no concurrency setting was written`);
  assert.equal(fixture.aliasUpdates.length, 0, `${label}: no Lambda alias was changed`);
  assert.deepEqual(fixture.unhandled, [], `${label}: the fixture accounted for every provider request`);
}

test('Phase 11 rotates presenter access without replacing the run or bypassing readiness', { timeout: 180_000 }, async (t) => {
  const context = await createContext(t, 'phase11-credential-rotation');

  await t.test('a warm HTTP handler rereads the operator digest and keeps old history read-only', async () => {
    reset();
    const before = structuredClone(row('STATE').data);
    const initial = await call(context.api, 'GET', '/api/state', undefined, 200);
    assert.equal(initial.runId, 'legacy');
    assert.equal(fixture.secretReads.filter(({ kind }) => kind === 'operator').length, 1);

    fixture.operatorSecretBearer = nextOperator;
    const oldActionId = randomUUID();
    const oldAttempt = await context.api.handler(httpEvent(
      'PUT', `/api/actions/${oldActionId}`, { kind: 'readiness', confirmQuiet: true }, oldOperator,
    ));
    assert.equal(oldAttempt.statusCode, 401, 'the old operator bearer is rejected after rotation');
    assert.equal(fixture.invocations.length, 0, 'old operator access cannot dispatch work');
    assert.deepEqual(row('STATE').data, before, 'old operator access does not change run history');
    assert.equal(fixture.secretReads.filter(({ kind }) => kind === 'operator').length, 2,
      'the warm HTTP module performs a fresh operator-secret read');

    const replacement = await context.api.handler(httpEvent('GET', '/api/state', undefined, nextOperator));
    assert.equal(replacement.statusCode, 200, 'the replacement browser bearer is accepted');
    const replacementState = JSON.parse(replacement.body);
    assert.equal(replacementState.runId, initial.runId, 'replacement access sees the same run');
    assert.deepEqual(replacementState.baseline, initial.baseline, 'replacement access sees the same baseline');
    assert.equal(fixture.secretReads.filter(({ kind }) => kind === 'operator').length, 3,
      'each warm request rereads the current operator digest');
  });

  await t.test('worker and qualified Checkout mismatches fail before business sends or settings writes', async () => {
    const cases = [
      ['worker AWSCURRENT secret differs from the qualified digest', () => {
        reset();
        fixture.appMode = 'selected-variant';
        fixture.workerAppBearer = nextAppBearer;
        fixture.checkoutServingCredentialDigest = digest(appBearer);
      }],
      ['qualified Checkout version is stale behind the expected live version', () => {
        reset();
        fixture.appMode = 'selected-variant';
        fixture.checkoutQualifiedVersion = nextCheckoutVersion;
        fixture.checkoutAliasVersion = '2';
        fixture.checkoutServingVersion = '2';
      }],
      ['readiness generation is newer than the qualified Checkout environment', () => {
        reset();
        fixture.appMode = 'selected-variant';
        fixture.credentialGeneration = nextGeneration;
        fixture.checkoutServingCredentialGeneration = 'fixture-generation';
      }],
    ];
    for (const [label, configure] of cases) {
      configure();
      const result = await runAction(context.api, context.worker, 'readiness', { confirmQuiet: true });
      assertNoRuntimeEffects({ action: result.action, label });
      assert.equal(fixture.appAuthentication.length, 0, `${label}: app authentication was never reached`);
    }
  });

  await t.test('matched rotation adopts a new baseline quietly and preserves the same run and receipts', async () => {
    reset();
    fixture.appMode = 'selected-variant';
    const prior = await runAction(context.api, context.worker, 'readiness', { confirmQuiet: true });
    assert.equal(prior.action.status, 'completed', prior.action.error);
    const priorRunId = prior.state.runId;
    const priorReceiptId = prior.state.baseline.checkoutId;
    const priorActionId = prior.id;
    const priorReceiptCount = prior.state.receipts.length;
    const stockBeforeRotation = fixture.appStock;

    applyRotation();
    const oldApp = await appFetch(`${appApi}/api/products`, {
      headers: { authorization: `Bearer ${appBearer}` },
    });
    assert.equal(oldApp.status, 401, 'the old app bearer is rejected by the serving Checkout digest');
    assert.equal(fixture.appStock, stockBeforeRotation, 'old app authentication has no business effect');
    const newApp = await appFetch(`${appApi}/api/products`, {
      headers: { authorization: `Bearer ${nextAppBearer}` },
    });
    assert.equal(newApp.status, 200, 'the replacement app bearer reaches the serving Checkout version');

    const rotated = await runAction(context.api, context.worker, 'readiness', { confirmQuiet: true });
    assert.equal(rotated.action.status, 'completed', rotated.action.error);
    assert.equal(rotated.state.runId, priorRunId, 'Readiness does not Reset or replace the controller run');
    assert.equal(rotated.state.baseline.settings.credentialGeneration, nextGeneration);
    assert.equal(rotated.state.baseline.settings.checkout.version, nextCheckoutVersion);
    assert.notEqual(rotated.state.baseline.checkoutId, priorReceiptId, 'Readiness verifies a fresh checkout');
    assert.equal(rotated.state.receipts.length, priorReceiptCount + 1, 'the old receipt remains in the run');
    assert.ok(rotated.state.receipts.some(({ checkoutId }) => checkoutId === priorReceiptId));
    assert.ok(rotated.state.receipts.some(({ checkoutId }) => checkoutId === rotated.state.baseline.checkoutId));
    assert.equal(fixture.appStock, stockBeforeRotation - 1, 'the fresh readiness checkout decrements stock once');
    assert.equal((await getAction(context.api, priorActionId)).status, 'completed',
      'the prior readiness action remains inspectable after rotation');
    assert.ok(fixture.appAuthentication.slice(-4).every(({ authenticated }) => authenticated),
      'all worker requests after matching rotation authenticate with the new serving digest');
    assert.deepEqual(fixture.unhandled, []);
  });

  await t.test('same-SHA legacy baselines without deployment identity still require readiness before ordinary traffic', async () => {
    reset();
    fixture.appMode = 'selected-variant';
    delete row('STATE').data.baseline.deploymentIdentity;
    delete row('STATE').data.originalBaseline.deploymentIdentity;
    applyRotation({ revision: appRevision });

    const id = await submit(context.api, 'traffic');
    const execution = context.worker.handler({ actionId: id });
    let observedBusinessRequest = false;
    try {
      await waitFor('legacy traffic action to reject or send its first request', async () => {
        const action = await getAction(context.api, id);
        observedBusinessRequest = fixture.appRequests.length > 0;
        return observedBusinessRequest || ['failed', 'incomplete', 'completed', 'stopped'].includes(action.status);
      });
      if (observedBusinessRequest) {
        const stopId = randomUUID();
        await call(context.api, 'PUT', `/api/actions/${stopId}`, { kind: 'stop', targetActionId: id }, 202);
        fixture.heldReleaseMode = 'healthy';
        releaseHeld();
      }
      await execution;
    } finally {
      fixture.heldReleaseMode = 'healthy';
      releaseHeld();
      await execution;
    }
    const action = await getAction(context.api, id);
    assert.equal(observedBusinessRequest, false, `legacy traffic must be blocked: ${action?.error ?? 'request sent'}`);
    assert.equal(action.status, 'failed');
    assert.match(action.error ?? '', /readiness|release/i);
    assert.equal(fixture.appRequests.length, 0);
    assert.equal(fixture.concurrencyWrites.length, 0);
    assert.equal(fixture.aliasUpdates.length, 0);
  });
});
