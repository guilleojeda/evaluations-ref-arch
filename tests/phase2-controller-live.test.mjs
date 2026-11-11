import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const slots = { catalog: 1, checkout: 2 };
const terminal = ['completed', 'stopped', 'failed', 'expired', 'incomplete', 'discarded'];

function origin(name) {
  let url;
  try {
    url = new URL(process.env[name]);
  } catch {
    assert.fail(`${name} must be an explicit HTTPS origin`);
  }
  assert.equal(url.protocol, 'https:', `${name} must use HTTPS`);
  assert.ok(!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
    `${name} must contain only the HTTPS origin`);
  return url.origin;
}

function counts(action) {
  const result = {};
  for (const [profile, limit] of Object.entries(slots)) {
    const progress = action.traffic?.[profile];
    assert.ok(progress, `missing ${profile} progress`);
    const { submitted, skipped, completed, succeeded, inFlight } = progress;
    for (const n of [submitted, skipped, completed, succeeded, inFlight]) {
      assert.ok(Number.isSafeInteger(n) && n >= 0, `invalid ${profile} count`);
    }
    assert.ok(submitted + skipped <= 15, `too many ${profile} ticks`);
    assert.ok(inFlight <= limit, `too many in-flight ${profile} requests`);
    assert.ok(succeeded <= completed && completed + inFlight <= submitted, `inconsistent ${profile} counts`);
    result[profile] = { submitted, skipped, completed, succeeded, inFlight };
  }
  return result;
}

function assertDrain(progress) {
  for (const [profile, count] of Object.entries(progress)) {
    assert.ok(count.submitted > 0, `${profile} must send traffic`);
    assert.equal(count.inFlight, 0, `${profile} must drain`);
    assert.equal(count.completed, count.submitted, `${profile} requests must settle`);
  }
}

test('deployed controller verifies the app and owns finite traffic through Stop and repeat', {
  skip: process.env.PHASE2_LIVE !== '1' && 'Requires explicit deployed origins and credentials',
  timeout: 240_000,
}, async (t) => {
  const controller = origin('PHASE2_CONTROLLER_URL');
  const app = origin('PHASE2_APP_URL');
  const appRevision = process.env.PHASE2_EXPECTED_APP_SHA;
  const operatorBearer = process.env.PHASE2_CONTROLLER_BEARER;
  const appBearer = process.env.PHASE2_APP_BEARER;
  assert.notEqual(controller, app, 'the controller and app must use separate origins');
  assert.match(appRevision ?? '', /^[0-9a-f]{40}$/i, 'supply the deployed app SHA');
  assert.ok(operatorBearer && appBearer && operatorBearer !== appBearer &&
    !/\s/.test(operatorBearer) && !/\s/.test(appBearer), 'supply two distinct bearers privately');
  const privateValues = [operatorBearer, appBearer].flatMap((value) =>
    [value, createHash('sha256').update(value).digest('hex')]);

  async function request(path, expected, { base = controller, token = operatorBearer, command } = {}) {
    const headers = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (command) headers['content-type'] = 'application/json';
    const label = `${command ? 'PUT' : 'GET'} ${path}`;
    let response, raw;
    try {
      response = await fetch(new URL(path, base), {
        method: command ? 'PUT' : 'GET', headers,
        body: command && JSON.stringify(command),
        redirect: 'error', signal: AbortSignal.timeout(8_000),
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
    try {
      return JSON.parse(raw);
    } catch {
      assert.fail(`${label} must return JSON`);
    }
  }

  const actionPath = (id) => `/api/actions/${id}`;
  const state = () => request('/api/state', 200);
  async function command(id, body, expected = 202) {
    const { action } = await request(actionPath(id), expected, { command: body });
    assert.equal(action?.id, id);
    assert.equal(action.kind, body.kind);
  }

  async function readAction(id) {
    const { action } = await request(actionPath(id), 200);
    assert.equal(action?.id, id);
    return action;
  }

  async function waitFor(id, description, matches, timeout = 60_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const action = await readAction(id);
      if (matches(action)) return action;
      assert.ok(!terminal.includes(action.status), `${description}: action ended as ${action.status}`);
      await delay(400);
    }
    assert.fail(`${description}: action did not settle within its deadline`);
  }

  const trafficIds = [];
  t.after(async () => {
    for (const id of trafficIds) {
      try {
        const { action } = await request(actionPath(id), [200, 404]);
        if (action?.kind === 'traffic' && !terminal.includes(action.status)) {
          await command(randomUUID(), { kind: 'stop', targetActionId: id });
          await waitFor(id, 'cleanup Stop', (current) => terminal.includes(current.status), 20_000);
        }
      } catch {
        t.diagnostic(`Could not confirm cleanup of traffic action ${id}`);
      }
    }
  });

  const readinessId = randomUUID();
  const readiness = { kind: 'readiness', confirmQuiet: true };
  for (const token of [null, appBearer]) {
    await request('/api/state', 401, { token });
    await request(actionPath(readinessId), 401, { token });
    await request(actionPath(readinessId), 401, { token, command: readiness });
  }

  await command(readinessId, readiness);
  await waitFor(readinessId, 'readiness', ({ status }) => status === 'completed');
  await command(readinessId, readiness, [200, 202]);
  assert.equal((await readAction(readinessId)).status, 'completed');

  const verified = await state();
  const baseline = verified.baseline;
  assert.equal(baseline?.appRevision, appRevision);
  assert.match(baseline.checkoutId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.ok(baseline.sku && baseline.productVersion);
  assert.ok(Number.isSafeInteger(baseline.stockBefore) && Number.isSafeInteger(baseline.stockAfter) && baseline.stockAfter >= 0);
  assert.equal(baseline.stockBefore - baseline.stockAfter, 1);
  const appAccess = { base: app, token: appBearer };
  const { order } = await request(`/api/orders/${baseline.checkoutId}`, 200, appAccess);
  assert.equal(order?.checkoutId, baseline.checkoutId);
  assert.equal(order.sku, baseline.sku);
  assert.equal(order.quantity, 1);
  assert.equal(order.status, 'placed');
  const readProduct = async () => {
    const { products } = await request('/api/products', 200, appAccess);
    const product = products?.find(({ sku }) => sku === baseline.sku);
    assert.equal(product?.productVersion, baseline.productVersion);
    return product;
  };
  assert.equal((await readProduct()).availableQuantity, baseline.stockAfter);

  const trafficId = randomUUID();
  const traffic = { kind: 'traffic' };
  trafficIds.push(trafficId);
  await command(trafficId, traffic);
  await command(trafficId, traffic, [200, 202]);
  await waitFor(trafficId, 'initial traffic on both profiles', (action) => {
    if (action.status === 'queued') return false;
    const progress = counts(action);
    return action.status === 'running' && progress.catalog.submitted > 0 && progress.checkout.submitted > 0;
  });
  await command(randomUUID(), { kind: 'stop', targetActionId: trafficId });
  const stopped = counts(await waitFor(trafficId, 'Stop drain', ({ status }) => status === 'stopped'));
  assertDrain(stopped);
  await command(trafficId, traffic, [200, 202]);
  await request(actionPath(trafficId), 409, { command: readiness });
  await delay(1_250);
  const stillStopped = await readAction(trafficId);
  assert.equal(stillStopped.status, 'stopped');
  assert.deepEqual(counts(stillStopped), stopped);
  const repeatId = randomUUID();
  trafficIds.push(repeatId);
  await command(repeatId, traffic);
  const completed = counts(await waitFor(repeatId, 'finite repeat', ({ status }) => status === 'completed'));
  assertDrain(completed);
  assert.ok(completed.catalog.succeeded > 0 && completed.checkout.succeeded > 0, 'healthy repeat must serve both profiles');
  assert.equal((await readProduct()).availableQuantity,
    baseline.stockAfter - stopped.checkout.succeeded - completed.checkout.succeeded,
    'stock must reflect the real successful generator checkouts');
});
