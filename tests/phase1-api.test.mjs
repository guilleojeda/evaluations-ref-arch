import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

const FIXTURE_STOCK = 11;
const MAX_POSTS = 21;
const TRANSIENT = new Set([500, 502, 503, 504]);

function origin(name, pattern) {
  const value = process.env[name]?.trim();
  assert.ok(value && pattern.test(value), `${name} must be the expected HTTPS origin without credentials or a path`);
  return new URL(value).origin;
}

function error(result, expectedStatus, checkoutId) {
  const { status, body, label } = result;
  assert.equal(status, expectedStatus, label);
  assert.ok(typeof body?.code === 'string' && body.code.length > 0, `${label} must include an error code`);
  assert.ok(typeof body.message === 'string' && body.message.length > 0, `${label} must include a message`);
  if (checkoutId) assert.equal(body.checkoutId, checkoutId, label);
  return body.code;
}

function receipt(result, input, product) {
  const { order } = result.body;
  assert.ok(order, `${result.label} must include the saved order`);
  assert.equal(order.checkoutId, input.checkoutId, result.label);
  assert.equal(order.sku, input.sku, result.label);
  assert.equal(order.quantity, input.quantity, result.label);
  assert.equal(order.unitPriceCents, product.unitPriceCents, result.label);
  assert.equal(order.totalPriceCents, product.unitPriceCents * input.quantity, result.label);
  assert.equal(order.currency, product.currency, result.label);
  assert.equal(order.status, 'placed', result.label);
  assert.ok(Number.isFinite(Date.parse(order.createdAt)), `${result.label} must include the creation time`);
  return order;
}

test('deployed checkout protects both origins and preserves orders and stock', {
  skip: process.env.PHASE1_LIVE !== '1' && 'Requires the deployed Phase 1 app and the disposable stock fixture',
  timeout: 125_000,
}, async (t) => {
  const site = origin('PHASE1_SITE_URL', /^https:\/\/[a-z0-9-]+\.cloudfront\.net\/?$/i);
  const api = origin('PHASE1_API_URL', /^https:\/\/[a-z0-9-]+\.execute-api\.us-east-1\.amazonaws\.com\/?$/i);
  const bearer = process.env.PHASE1_PRESENTER_BEARER;
  assert.ok(bearer && !/\s/.test(bearer), 'Provide PHASE1_PRESENTER_BEARER privately');
  assert.equal(process.env.PHASE1_EXPECTED_STOCK, String(FIXTURE_STOCK), 'Prepare the disposable stock fixture first');

  const deadline = Date.now() + 120_000;
  let posts = 0;

  async function request(base, path, label, { credential = bearer, input } = {}) {
    const headers = { accept: 'application/json' };
    if (credential) headers.authorization = `Bearer ${credential}`;
    if (input) {
      assert.ok(++posts <= MAX_POSTS, 'Phase 1 checkout POST budget exceeded');
      t.diagnostic(`${label}: checkoutId=${input.checkoutId}, POST ${posts}`);
      headers['content-type'] = 'application/json';
    }
    const remaining = deadline - Date.now();
    assert.ok(remaining > 0, 'Phase 1 acceptance run deadline reached');
    let response;
    let raw;
    try {
      response = await fetch(new URL(path, base), {
        headers,
        method: input ? 'POST' : 'GET',
        body: input ? JSON.stringify(input) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(Math.min(15_000, remaining)),
      });
      raw = await response.text();
    } catch (cause) {
      const reason = ['AbortError', 'TimeoutError'].includes(cause?.name) ? 'timed out' : 'failed';
      assert.fail(`${label}: request ${reason}`);
    }
    assert.ok(!raw.includes(bearer), `${label}: a response exposed the presenter credential`);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      assert.fail(`${label}: expected a JSON application response`);
    }
    assert.ok(typeof body?.requestId === 'string' && body.requestId.length > 0, `${label}: missing request ID`);
    return { status: response.status, body, label };
  }

  const products = (base, label, options) => request(base, '/api/products', label, options);
  const buy = (base, input, label, options) => request(base, '/api/checkout', label, { ...options, input });
  const status = (base, input, label, options) =>
    request(base, `/api/orders/${input.checkoutId}`, label, options);

  async function catalog(base) {
    const result = await products(base, 'authorized catalog');
    assert.equal(result.status, 200, result.label);
    const { products: items, observedAt } = result.body;
    assert.ok(Array.isArray(items) && items.length === 1, 'catalog must expose the one seeded SKU');
    assert.ok(Number.isFinite(Date.parse(observedAt)), 'catalog must include observation time');
    const product = items[0];
    for (const field of ['sku', 'name', 'currency', 'productVersion']) {
      assert.ok(typeof product[field] === 'string' && product[field].length > 0, `catalog must include ${field}`);
    }
    for (const field of ['availableQuantity', 'unitPriceCents']) {
      assert.ok(Number.isSafeInteger(product[field]) && product[field] >= 0, `catalog must include a valid ${field}`);
    }
    return product;
  }

  async function confirm(base, input, expected) {
    const saved = await status(base, input, 'saved order status');
    assert.equal(saved.status, 200, saved.label);
    assert.deepEqual(receipt(saved, input, product), expected, 'status must return the same durable receipt');
  }

  async function settle(result, base, input) {
    if (!TRANSIENT.has(result.status)) return result;
    const retry = await buy(base, input, `same-ID settlement after ${result.label}`);
    return TRANSIENT.has(retry.status) ? status(base, input, 'status after same-ID settlement') : retry;
  }

  async function absent(input) {
    error(await status(api, input, 'status for a rejected checkout'), 404, input.checkoutId);
  }

  const product = await catalog(site);
  assert.deepEqual(await catalog(api), product, 'CloudFront and direct Gateway must expose the same seed');
  assert.equal(product.availableQuantity, FIXTURE_STOCK, 'catalog must show the intended isolated test stock');
  const input = (quantity) => ({
    checkoutId: randomUUID(),
    sku: product.sku,
    quantity,
    productVersion: product.productVersion,
  });

  const unauthorized = input(1);
  for (const base of [site, api]) {
    for (const credential of [null, 'phase1-invalid-credential']) {
      const options = { credential };
      error(await products(base, 'unauthorized catalog', options), 401);
      error(await buy(base, unauthorized, 'unauthorized checkout', options), 401);
      error(await status(base, unauthorized, 'unauthorized order status', options), 401);
    }
  }
  await absent(unauthorized);

  const first = input(5);
  error(await status(site, first, 'CloudFront status before creation'), 404, first.checkoutId);
  const created = await buy(site, first, 'first purchase');
  assert.equal(created.status, 201, created.label);
  const firstOrder = receipt(created, first, product);
  await confirm(site, first, firstOrder);
  await confirm(api, first, firstOrder);
  error(await status(site, first, 'unauthorized warmed order status', { credential: null }), 401);
  assert.equal((await catalog(api)).availableQuantity, 6, 'a five-unit order must decrement stock once');

  const duplicate = input(1);
  const matching = await Promise.all([
    buy(site, duplicate, 'matching order through CloudFront'),
    buy(api, duplicate, 'matching order through Gateway'),
  ]);
  const one = await settle(matching[0], site, duplicate);
  const two = await settle(matching[1], api, duplicate);
  assert.ok([200, 201].includes(one.status) && [200, 201].includes(two.status), 'both matching attempts must resolve');
  assert.ok(one.status !== 201 || two.status !== 201, 'at most one matching attempt can create an order');
  assert.notEqual(one.body.requestId, two.body.requestId, 'distinct requests must have distinct request IDs');
  const duplicateOrder = receipt(one, duplicate, product);
  assert.deepEqual(receipt(two, duplicate, product), duplicateOrder);
  assert.equal((await catalog(site)).availableQuantity, 5, 'matching attempts must decrement stock once');

  const conflictCode = error(
    await buy(api, { ...duplicate, quantity: 2 }, 'reuse of checkout ID with different input'),
    409,
    duplicate.checkoutId,
  );
  await confirm(api, duplicate, duplicateOrder);

  for (const [label, invalid, canReadStatus] of [
    ['zero quantity', input(0), true],
    ['quantity above five', input(6), true],
    ['fractional quantity', input(1.5), true],
    ['invalid UUID', { ...input(1), checkoutId: 'not-a-uuid' }, false],
    ['client-supplied price', { ...input(1), unitPriceCents: 1 }, true],
  ]) {
    error(await buy(site, invalid, label), 400, canReadStatus ? invalid.checkoutId : undefined);
    if (canReadStatus) await absent(invalid);
  }
  const stale = { ...input(1), productVersion: randomUUID() };
  const staleCode = error(await buy(api, stale, 'stale product version'), 409, stale.checkoutId);
  assert.notEqual(staleCode, conflictCode, 'classify stale inventory separately from a reused checkout ID');
  await absent(stale);
  const missing = { ...input(1), sku: `${product.sku}-missing` };
  error(await buy(api, missing, 'unknown SKU'), 404, missing.checkoutId);
  await absent(missing);
  assert.equal((await catalog(api)).availableQuantity, 5, 'rejected inputs must leave five units for the race');

  const a = input(5);
  const b = input(5);
  const race = await Promise.all([buy(site, a, 'last-stock contender A'), buy(api, b, 'last-stock contender B')]);
  const left = await settle(race[0], site, a);
  const right = await settle(race[1], api, b);
  const outcomes = [[left, a], [right, b]];
  const winners = outcomes.filter(([result]) => result.status === 200 || result.status === 201);
  assert.equal(winners.length, 1, 'only one contender can consume the last five units');
  const [[won, winner]] = winners;
  const [lost, loser] = outcomes.find(([, candidate]) => candidate !== winner);
  const stockCode = error(lost, 409, loser.checkoutId);
  assert.ok(stockCode !== conflictCode && stockCode !== staleCode, 'classify insufficient stock separately');
  await confirm(api, winner, receipt(won, winner, product));
  await absent(loser);
  const remaining = (await catalog(site)).availableQuantity;
  assert.equal(remaining, 0, 'the race must consume exactly the available stock');
  t.diagnostic(`Fixture settled: ${posts} checkout POSTs, final stock ${remaining}`);
});
