import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, afterEach, before, test } from "node:test";

const ROOT = resolve(join(fileURLToPath(new URL(".", import.meta.url)), ".."));
const ARTIFACT = join(ROOT, ".artifacts", "app", "backend", "index.mjs");
const PASSWORD = "phase1-presenter-secret";
const SKU = "phase1-sku";
const VERSION = "phase1-version-1";
const ORDERS = "phase1-orders";
const INVENTORY = "phase1-inventory";
const INVENTORY_FUNCTION = "Phase1Inventory:live";
const REGION = "us-east-1";
const product = Object.freeze({
  sku: SKU, name: "Phase 1 Widget", unitPriceCents: 1299,
  currency: "USD", availableQuantity: 17, productVersion: VERSION,
});

const envNames = [
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE",
  "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_LAMBDA",
  "AWS_ENDPOINT_URL_DYNAMODB", "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS", "AWS_EC2_METADATA_DISABLED",
  "PRESENTER_CREDENTIAL_DIGEST", "PRESENTER_CREDENTIAL_GENERATION", "ORDERS_TABLE_NAME",
  "INVENTORY_TABLE_NAME", "INVENTORY_FUNCTION_NAME", "PRODUCT_SKU",
];
const savedEnv = new Map(envNames.map((name) => [name, process.env[name]]));

function configureEnv(endpoint) {
  Object.assign(process.env, {
    AWS_ACCESS_KEY_ID: "phase1-test-access-key",
    AWS_SECRET_ACCESS_KEY: "phase1-test-secret-key",
    AWS_REGION: REGION,
    AWS_DEFAULT_REGION: REGION,
    AWS_ENDPOINT_URL: endpoint,
    AWS_ENDPOINT_URL_LAMBDA: endpoint,
    AWS_ENDPOINT_URL_DYNAMODB: endpoint,
    AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "false",
    AWS_EC2_METADATA_DISABLED: "true",
    PRESENTER_CREDENTIAL_DIGEST: createHash("sha256").update(PASSWORD).digest("hex"),
    PRESENTER_CREDENTIAL_GENERATION: "phase1-fixture",
    ORDERS_TABLE_NAME: ORDERS,
    INVENTORY_TABLE_NAME: INVENTORY,
    INVENTORY_FUNCTION_NAME: INVENTORY_FUNCTION,
    PRODUCT_SKU: SKU,
  });
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_PROFILE;
}

function restoreEnv() {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

class AwsFixture {
  constructor() {
    this.calls = [];
    this.mode = { inventory: "lookup", transaction: "success" };
    this.orderItems = [];
    this.sockets = new Set();
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        this.protocolError ??= error;
        if (!response.destroyed && !response.writableEnded) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ message: error.message }));
        }
      });
    });
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
  }

  async listen() {
    await new Promise((resolvePromise, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = this.server.address();
    assert.ok(address && typeof address === "object");
    return `http://127.0.0.1:${address.port}`;
  }

  async close() {
    for (const socket of this.sockets) socket.destroy();
    await new Promise((resolvePromise) => this.server.close(resolvePromise));
  }

  reset({ inventory = "lookup", transaction = "success" } = {}) {
    this.calls = [];
    this.mode = { inventory, transaction };
    this.orderItems = [];
  }

  callsFor(service, operation) {
    return this.calls.filter((call) => call.service === service && call.operation === operation);
  }

  async handle(request, response) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks);
    const body = rawBody.length ? JSON.parse(rawBody.toString()) : {};
    const target = String(request.headers["x-amz-target"] ?? "");
    if (target.endsWith("DynamoDB_20120810.GetItem")) return this.getItem(body, response);
    if (target.endsWith("DynamoDB_20120810.TransactWriteItems")) return this.transaction(body, response);
    if (request.url?.includes("/2015-03-31/functions/")) return this.invoke(request, body, response);
    throw new Error(`Unexpected AWS fixture request: ${target || request.url}`);
  }

  getItem(body, response) {
    this.calls.push({ service: "dynamodb", operation: "GetItem", body });
    assert.equal(body.TableName, ORDERS);
    assert.equal(body.ConsistentRead, true, "order reads must be strong");
    const orderId = body.Key?.orderId?.S;
    assert.ok(orderId, "read must use the Orders key");
    const item = this.orderItems.find((candidate) => candidate.orderId?.S === orderId);
    this.json(response, item ? { Item: item } : {});
  }

  transaction(body, response) {
    this.calls.push({ service: "dynamodb", operation: "TransactWriteItems", body });
    assert.equal(body.TransactItems?.length, 2);
    const put = body.TransactItems.find((entry) => entry.Put)?.Put;
    assert.ok(put, "transaction must contain an order Put");
    assert.equal(put.TableName, ORDERS);
    assert.equal(body.TransactItems.find((entry) => entry.Update)?.Update.TableName, INVENTORY);
    if (this.mode.transaction === "ack-timeout-commit") this.orderItems.push(put.Item);
    if (this.mode.transaction.startsWith("ack-timeout-")) return this.destroyAfterReceiving(response);
    this.json(response, {});
  }

  async invoke(request, body, response) {
    const url = new URL(request.url, "http://fixture");
    const match = url.pathname.match(/\/functions\/([^/]+)\/invocations$/);
    assert.ok(match, "Invoke must use the Lambda invocation protocol");
    const functionName = decodeURIComponent(match[1]);
    assert.equal(functionName.split(":")[0], INVENTORY_FUNCTION.split(":")[0]);
    assert.ok(functionName.endsWith(":live") || url.searchParams.get("Qualifier") === "live", "Invoke must select live");
    this.calls.push({ service: "lambda", operation: "Invoke", functionName, body });
    if (this.mode.inventory === "timeout") {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_800));
      if (!response.destroyed && !response.writableEnded) response.destroy();
      return;
    }
    if (this.mode.inventory === "function-error") return this.payload(response, JSON.stringify({ errorMessage: "simulated failure" }), { "x-amz-function-error": "Unhandled" });
    if (this.mode.inventory === "invalid-payload") return this.payload(response, JSON.stringify({ products: [] }));
    const list = this.mode.inventory === "list" || body.action === "list" || body.operation === "list";
    this.payload(response, JSON.stringify(list ? { products: [product] } : { product }));
  }

  destroyAfterReceiving(response) {
    setTimeout(() => {
      if (!response.destroyed && !response.writableEnded) response.destroy();
    }, 5);
  }

  payload(response, value, headers = {}) {
    const bytes = Buffer.from(value);
    response.writeHead(200, { "content-type": "application/json", "content-length": bytes.length, ...headers });
    response.end(bytes);
  }

  json(response, value) {
    const bytes = Buffer.from(JSON.stringify(value));
    response.writeHead(200, { "content-type": "application/x-amz-json-1.0", "content-length": bytes.length });
    response.end(bytes);
  }
}

function apiEvent(method, path, requestId, { body, authorization = `Bearer ${PASSWORD}`, noAuth = false } = {}) {
  const headers = { "content-type": "application/json" };
  if (!noAuth) headers.authorization = authorization;
  const orderPath = path.startsWith("/api/orders/");
  return {
    version: "2.0", routeKey: `${method} ${orderPath ? "/api/orders/{checkoutId}" : path}`,
    rawPath: path, rawQueryString: "", headers,
    requestContext: { requestId, http: { method, path } },
    pathParameters: orderPath ? { checkoutId: path.split("/").at(-1) } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body), isBase64Encoded: false,
  };
}

function checkout(checkoutId, requestId, quantity = 1, extra = {}) {
  return apiEvent("POST", "/api/checkout", requestId, {
    body: { checkoutId, sku: SKU, quantity, productVersion: VERSION, ...extra },
  });
}

function bodyOf(response) {
  assert.equal(typeof response?.body, "string");
  return JSON.parse(response.body);
}

async function captureEmf(run) {
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    await run();
  } finally {
    process.stdout.write = originalWrite;
  }
  return writes
    .flatMap((chunk) => chunk.split("\n"))
    .filter(Boolean)
    .flatMap((chunk) => {
      try {
        const value = JSON.parse(chunk);
        return value?._aws ? [value] : [];
      } catch {
        return [];
      }
    });
}

function errorOf(response, statusCode, requestId, checkoutId) {
  assert.equal(response.statusCode, statusCode);
  const body = bodyOf(response);
  assert.equal(typeof body.code, "string");
  assert.ok(body.code);
  assert.equal(typeof body.message, "string");
  assert.equal(body.requestId, requestId);
  if (checkoutId !== undefined) assert.equal(body.checkoutId, checkoutId);
  return body;
}

function receiptOf(response, statusCode, requestId, input) {
  assert.equal(response.statusCode, statusCode);
  const body = bodyOf(response);
  assert.equal(body.requestId, requestId);
  assert.equal(body.order.checkoutId, input.checkoutId);
  assert.equal(body.order.sku, input.sku);
  assert.equal(body.order.quantity, input.quantity);
  assert.equal(body.order.totalPriceCents, body.order.unitPriceCents * input.quantity);
  assert.equal(body.order.status, "placed");
  return body;
}

const fixture = new AwsFixture();
let handler;

before(async () => {
  assert.ok(existsSync(ARTIFACT), `missing ${ARTIFACT}; run npm run check -- app first`);
  configureEnv(await fixture.listen());
  const runtime = await import(pathToFileURL(ARTIFACT).href);
  assert.equal(typeof runtime.handler, "function");
  handler = (event) => runtime.handler(event, {
    awsRequestId: `lambda-${event.requestContext.requestId}`,
    functionVersion: "1",
    invokedFunctionArn: "arn:aws:lambda:us-east-1:027224425948:function:Phase1Checkout:live",
    getRemainingTimeInMillis: () => 12_000,
  });
});

afterEach(() => {
  const error = fixture.protocolError;
  fixture.protocolError = undefined;
  assert.ifError(error);
});

after(async () => {
  await fixture.close();
  restoreEnv();
});

test("healthy catalog and checkout return documented envelopes", async () => {
  fixture.reset({ inventory: "list" });
  const catalogId = "phase1-catalog";
  let catalog;
  const catalogMetrics = await captureEmf(async () => {
    catalog = await handler(apiEvent("GET", "/api/products", catalogId));
  });
  assert.equal(catalog.statusCode, 200);
  assert.equal(catalogMetrics.length, 1);
  assert.ok(Number.isFinite(catalogMetrics[0].InventoryLookupDurationMs));
  assert.equal(catalogMetrics[0].InventoryLookupTimeout, 0);
  const catalogBody = bodyOf(catalog);
  assert.deepEqual(catalogBody.products, [product]);
  assert.equal(catalogBody.requestId, catalogId);
  assert.equal(typeof catalogBody.observedAt, "string");

  fixture.reset();
  const input = { checkoutId: "11111111-1111-4111-8111-111111111111", sku: SKU, quantity: 2 };
  const response = await handler(checkout(input.checkoutId, "phase1-checkout", input.quantity));
  receiptOf(response, 201, "phase1-checkout", input);
  assert.equal(fixture.callsFor("lambda", "Invoke").length, 1);
  assert.equal(fixture.callsFor("dynamodb", "TransactWriteItems").length, 1);
});

test("auth and validation reject before any provider call", async () => {
  for (const [index, authorization] of [undefined, "Basic phase1-presenter-secret", "Bearer wrong-secret"].entries()) {
    fixture.reset();
    const options = authorization === undefined ? { noAuth: true } : { authorization };
    const metrics = await captureEmf(async () => {
      errorOf(await handler(apiEvent("GET", "/api/products", `phase1-auth-${index}`, options)), 401, `phase1-auth-${index}`);
    });
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].InventoryLookupDurationMs, undefined, "auth rejection must not publish an inventory duration sample");
    assert.equal(metrics[0].InventoryLookupTimeout, undefined, "auth rejection must not publish an inventory timeout sample");
    assert.equal(fixture.calls.length, 0);
  }
  fixture.reset();
  const statusMetrics = await captureEmf(async () => {
    errorOf(await handler(apiEvent("GET", "/api/orders/66666666-6666-4666-8666-666666666666", "phase1-status-metric")), 404, "phase1-status-metric", "66666666-6666-4666-8666-666666666666");
  });
  assert.equal(statusMetrics[0].InventoryLookupDurationMs, undefined, "status reads must not publish an inventory duration sample");
  assert.equal(statusMetrics[0].InventoryLookupTimeout, undefined, "status reads must not publish an inventory timeout sample");
  const otherMetrics = await captureEmf(async () => {
    errorOf(await handler(apiEvent("GET", "/api/other", "phase1-other-metric")), 404, "phase1-other-metric");
  });
  assert.equal(otherMetrics[0].InventoryLookupDurationMs, undefined, "other routes must not publish an inventory duration sample");
  assert.equal(otherMetrics[0].InventoryLookupTimeout, undefined, "other routes must not publish an inventory timeout sample");
  fixture.reset();
  const unauthenticated = apiEvent("POST", "/api/checkout", "phase1-auth-before-parsing", { noAuth: true });
  unauthenticated.body = "{";
  errorOf(await handler(unauthenticated), 401, "phase1-auth-before-parsing");
  const invalidId = "phase1-invalid-request";
  errorOf(await handler(apiEvent("POST", "/api/checkout", invalidId, {
    body: { checkoutId: "not-a-uuid", sku: SKU, quantity: 0, productVersion: VERSION, unexpected: true },
  })), 400, invalidId);
  assert.equal(fixture.calls.length, 0);
});

test("confirmed inventory failures return 502 before transaction", async () => {
  for (const [index, inventory] of ["function-error", "invalid-payload"].entries()) {
    fixture.reset({ inventory });
    const id = `22222222-2222-4222-8222-22222222222${index}`;
    const requestId = `phase1-inventory-${index}`;
    errorOf(await handler(checkout(id, requestId)), 502, requestId, id);
    assert.equal(fixture.callsFor("lambda", "Invoke").length, 1);
    assert.equal(fixture.callsFor("dynamodb", "TransactWriteItems").length, 0);
  }
});

test("inventory deadline returns 504 before transaction", { timeout: 5_000 }, async () => {
  fixture.reset({ inventory: "timeout" });
  const id = "33333333-3333-4333-8333-333333333333";
  const requestId = "phase1-inventory-timeout";
  errorOf(await handler(checkout(id, requestId)), 504, requestId, id);
  assert.equal(fixture.callsFor("dynamodb", "TransactWriteItems").length, 0);
});

test("saved uncertain order is returned by status and same-ID retry without new providers", async () => {
  fixture.reset({ transaction: "ack-timeout-commit" });
  const id = "aaaaaaaa-4444-4444-8444-444444444444";
  const input = { checkoutId: id, sku: SKU, quantity: 3 };
  const first = await handler(checkout(id, "phase1-ack-commit", input.quantity));
  assert.ok([200, 201].includes(first.statusCode), "a confirmed receipt must settle the POST");
  const receipt = receiptOf(first, first.statusCode, "phase1-ack-commit", input);
  const invokes = fixture.callsFor("lambda", "Invoke").length;
  const writes = fixture.callsFor("dynamodb", "TransactWriteItems").length;
  assert.equal(invokes, 1);
  assert.equal(writes, 1);
  assert.ok(fixture.callsFor("dynamodb", "GetItem").length >= 2);
  const status = await handler(apiEvent("GET", `/api/orders/${id}`, "phase1-ack-status"));
  const statusReceipt = receiptOf(status, 200, "phase1-ack-status", input);
  fixture.mode.inventory = "function-error";
  const retry = await handler(checkout(id, "phase1-ack-retry", input.quantity));
  const retryReceipt = receiptOf(retry, 200, "phase1-ack-retry", input);
  assert.deepEqual(statusReceipt.order, receipt.order);
  assert.deepEqual(retryReceipt.order, receipt.order);
  const equivalentId = await handler(checkout(id.toUpperCase(), "phase1-ack-equivalent-id", input.quantity));
  assert.deepEqual(receiptOf(equivalentId, 200, "phase1-ack-equivalent-id", input).order, receipt.order);
  assert.equal(fixture.callsFor("lambda", "Invoke").length, invokes, "saved retry must not invoke Inventory");
  assert.equal(fixture.callsFor("dynamodb", "TransactWriteItems").length, writes, "saved retry must not write again");
  assert.ok(fixture.callsFor("dynamodb", "GetItem").every((call) => call.body.ConsistentRead === true));
});

test("unconfirmed acknowledgement is OUTCOME_UNKNOWN even when later status is 404", async () => {
  fixture.reset({ transaction: "ack-timeout-unknown" });
  const id = "55555555-5555-4555-8555-555555555555";
  const requestId = "phase1-ack-unknown";
  const unknown = errorOf(await handler(checkout(id, requestId)), 503, requestId, id);
  assert.equal(unknown.code, "OUTCOME_UNKNOWN");
  const statusId = "phase1-status-after-unknown";
  const notFound = errorOf(await handler(apiEvent("GET", `/api/orders/${id}`, statusId)), 404, statusId, id);
  assert.notEqual(notFound.code, "OUTCOME_UNKNOWN");
  assert.ok(fixture.callsFor("dynamodb", "GetItem").length >= 3);
  assert.ok(fixture.callsFor("dynamodb", "GetItem").every((call) => call.body.ConsistentRead === true));
});
