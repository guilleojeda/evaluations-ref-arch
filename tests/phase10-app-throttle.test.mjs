import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, afterEach, before, test } from "node:test";
import { ThrottleReason } from "@aws-sdk/client-lambda";

const ROOT = resolve(join(fileURLToPath(new URL(".", import.meta.url)), ".."));
const ARTIFACT = join(ROOT, ".artifacts", "app", "backend", "index.mjs");
const PASSWORD = "phase10-presenter-secret";
const SKU = "phase10-sku";
const VERSION = "phase10-version-1";
const ORDERS = "phase10-orders";
const INVENTORY = "phase10-inventory";
const INVENTORY_FUNCTION = "IncidentTriageDemoInventory:live";
const GATEWAY_REQUEST_ID = "phase10-api-gateway-request";
const LAMBDA_REQUEST_ID = "phase10-checkout-lambda-request";
const LAMBDA_INVOKE_REQUEST_ID = "phase10-lambda-api-request";
const THROTTLE_REASON_RATE_LIMIT = ThrottleReason.ReservedFunctionInvocationRateLimitExceeded;
const THROTTLE_REASON_CONCURRENCY = ThrottleReason.ReservedFunctionConcurrentInvocationLimitExceeded;
const AWS_EXCEPTION_TYPE = "User";
const REGION = "us-east-1";
const product = Object.freeze({
  sku: SKU, name: "Phase 10 Widget", unitPriceCents: 1299,
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
    AWS_ACCESS_KEY_ID: "phase10-test-access-key",
    AWS_SECRET_ACCESS_KEY: "phase10-test-secret-key",
    AWS_REGION: REGION,
    AWS_DEFAULT_REGION: REGION,
    AWS_ENDPOINT_URL: endpoint,
    AWS_ENDPOINT_URL_LAMBDA: endpoint,
    AWS_ENDPOINT_URL_DYNAMODB: endpoint,
    AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "false",
    AWS_EC2_METADATA_DISABLED: "true",
    PRESENTER_CREDENTIAL_DIGEST: createHash("sha256").update(PASSWORD).digest("hex"),
    PRESENTER_CREDENTIAL_GENERATION: "phase10-fixture",
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

async function captureLogs(run) {
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values) => logs.push(values.map(String).join(" "));
  console.error = (...values) => logs.push(values.map(String).join(" "));
  try {
    return { value: await run(), logs };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function structuredLogs(logs) {
  return logs.flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return typeof value === "object" && value !== null ? [value] : [];
    } catch {
      return [];
    }
  });
}

function inventoryItem() {
  return {
    sku: { S: SKU },
    name: { S: product.name },
    unitPriceCents: { N: String(product.unitPriceCents) },
    currency: { S: product.currency },
    availableQuantity: { N: String(product.availableQuantity) },
    productVersion: { S: VERSION },
    updatedAt: { S: "2026-01-01T00:00:00.000Z" },
  };
}

class AwsFixture {
  constructor() {
    this.calls = [];
    this.invokeReplies = [];
    this.orderItems = [];
    this.inventoryItem = inventoryItem();
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

  reset({ throttleReason }) {
    this.calls = [];
    this.invokeReplies = [];
    this.orderItems = [];
    this.inventoryItem = inventoryItem();
    this.throttleReason = throttleReason ?? THROTTLE_REASON_RATE_LIMIT;
  }

  inventoryState() {
    return {
      productVersion: this.inventoryItem.productVersion.S,
      availableQuantity: Number(this.inventoryItem.availableQuantity.N),
    };
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
    const put = body.TransactItems?.find((entry) => entry.Put)?.Put;
    const update = body.TransactItems?.find((entry) => entry.Update)?.Update;
    assert.ok(put && update, "a checkout transaction must include its order and stock writes");
    assert.equal(put.TableName, ORDERS);
    assert.equal(update.TableName, INVENTORY);
    this.orderItems.push(put.Item);
    const quantity = Number(update.ExpressionAttributeValues?.[":quantity"]?.N);
    this.inventoryItem = {
      ...this.inventoryItem,
      availableQuantity: { N: String(Number(this.inventoryItem.availableQuantity.N) - quantity) },
    };
    this.json(response, {});
  }

  invoke(request, body, response) {
    const url = new URL(request.url, "http://fixture");
    const match = url.pathname.match(/\/functions\/([^/]+)\/invocations$/);
    assert.ok(match, "Invoke must use the Lambda invocation protocol");
    const functionName = decodeURIComponent(match[1]);
    this.calls.push({ service: "lambda", operation: "Invoke", functionName, body });

    // The Lambda API exception uses Type="User" and a bounded Reason subtype.
    // This is an Invoke API rejection, so there is no child FunctionError or version.
    const error = {
      Type: AWS_EXCEPTION_TYPE,
      Reason: this.throttleReason,
      Message: "Invocation request rate exceeded",
    };
    this.invokeReplies.push({ statusCode: 429, requestId: LAMBDA_INVOKE_REQUEST_ID, error });
    this.json(response, error, 429, {
      "x-amzn-errortype": "TooManyRequestsException",
      "x-amzn-requestid": LAMBDA_INVOKE_REQUEST_ID,
    });
  }

  json(response, value, statusCode = 200, headers = {}) {
    const bytes = Buffer.from(JSON.stringify(value));
    response.writeHead(statusCode, {
      "content-type": "application/x-amz-json-1.0",
      "content-length": bytes.length,
      ...headers,
    });
    response.end(bytes);
  }
}

function apiEvent(method, path, requestId, { body, authorization = `Bearer ${PASSWORD}` } = {}) {
  const isOrderStatus = path.startsWith("/api/orders/");
  return {
    version: "2.0",
    routeKey: `${method} ${isOrderStatus ? "/api/orders/{checkoutId}" : path}`,
    rawPath: path,
    rawQueryString: "",
    headers: { "content-type": "application/json", authorization },
    requestContext: { requestId, http: { method, path } },
    pathParameters: isOrderStatus ? { checkoutId: path.split("/").at(-1) } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

function checkout(checkoutId, requestId) {
  return apiEvent("POST", "/api/checkout", requestId, {
    body: { checkoutId, sku: SKU, quantity: 2, productVersion: VERSION },
  });
}

function bodyOf(response) {
  assert.equal(typeof response?.body, "string");
  return JSON.parse(response.body);
}

function assertThrottleContract(run, requestId, checkoutId) {
  assert.equal(run.statusCode, 502);
  const body = bodyOf(run);
  assert.equal(body.code, "INVENTORY_LOOKUP_FAILED");
  assert.equal(body.message, "Inventory could not be read");
  assert.equal(body.requestId, requestId);
  if (checkoutId === undefined) assert.equal(body.checkoutId, undefined);
  else assert.equal(body.checkoutId, checkoutId);
  assert.equal(body.dependencyReason, undefined, "transport throttling keeps the established generic public contract");
  assert.equal(body.inventoryInvocationId, undefined);
  assert.equal(body.executedVersion, undefined);
}

const fixture = new AwsFixture();
let handler;

before(async () => {
  assert.ok(existsSync(ARTIFACT), `missing ${ARTIFACT}; reuse the established app build output`);
  configureEnv(await fixture.listen());
  const runtime = await import(pathToFileURL(ARTIFACT).href);
  assert.equal(typeof runtime.handler, "function");
  handler = (event) => runtime.handler(event, {
    awsRequestId: LAMBDA_REQUEST_ID,
    functionVersion: "1",
    invokedFunctionArn: `arn:aws:lambda:${REGION}:027224425948:function:Phase10Checkout:live`,
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

test("Lambda Invoke throttling is a correlated 502 for catalog and checkout without writes", async (t) => {
  const scenarios = [
    {
      operation: "products",
      event: apiEvent("GET", "/api/products", GATEWAY_REQUEST_ID),
      invokeOperation: "list",
      throttleReason: THROTTLE_REASON_RATE_LIMIT,
    },
    {
      operation: "checkout",
      event: checkout("10101010-1010-4010-8010-101010101010", GATEWAY_REQUEST_ID),
      checkoutId: "10101010-1010-4010-8010-101010101010",
      invokeOperation: "lookup",
      throttleReason: THROTTLE_REASON_CONCURRENCY,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.operation, async () => {
      fixture.reset({ throttleReason: scenario.throttleReason });
      const initialInventory = fixture.inventoryState();
      const run = await captureLogs(() => handler(scenario.event));
      assertThrottleContract(run.value, GATEWAY_REQUEST_ID, scenario.checkoutId);

      const invokes = fixture.callsFor("lambda", "Invoke");
      assert.equal(invokes.length, 1, "the SDK must not retry this rejected Invoke");
      assert.equal(invokes[0].functionName, INVENTORY_FUNCTION, "Invoke must request the configured live alias");
      assert.equal(invokes[0].body.operation, scenario.invokeOperation);
      assert.equal(invokes[0].body.requestId, GATEWAY_REQUEST_ID, "the app Gateway request ID must correlate across Invoke");
      assert.equal(fixture.invokeReplies.length, 1);
      assert.equal(fixture.invokeReplies[0].statusCode, 429, "the rejection must cross the SDK transport boundary as HTTP 429");
      assert.equal(fixture.invokeReplies[0].requestId, LAMBDA_INVOKE_REQUEST_ID);
      assert.equal(fixture.invokeReplies[0].error.Type, AWS_EXCEPTION_TYPE);
      assert.equal(fixture.invokeReplies[0].error.Reason, scenario.throttleReason);
      assert.equal(fixture.invokeReplies[0].FunctionError, undefined);
      assert.equal(fixture.invokeReplies[0].ExecutedVersion, undefined);

      assert.equal(fixture.callsFor("dynamodb", "TransactWriteItems").length, 0,
        "a throttled lookup must not submit an order or stock transaction");
      assert.equal(fixture.orderItems.length, 0, "a rejected checkout must not persist an order");
      assert.deepEqual(fixture.inventoryState(), initialInventory, "a rejected checkout must preserve stock");

      const log = structuredLogs(run.logs).find((entry) =>
        entry.service === "checkout" && entry.requestId === GATEWAY_REQUEST_ID && entry.operation === scenario.operation);
      assert.ok(log, "the public request must produce its structured checkout log");
      assert.equal(log.requestId, GATEWAY_REQUEST_ID, "the exact Gateway request ID must be logged");
      assert.equal(log.lambdaRequestId, LAMBDA_REQUEST_ID);
      assert.equal(log.inventoryFunction, INVENTORY_FUNCTION, "the requested Inventory alias must be logged");
      assert.equal(log.dependencyErrorName, "TooManyRequestsException", "retain the modeled SDK exception name");
      assert.equal(log.dependencyFailureReason, "transport_error", "keep the existing generic failure projection");
      assert.equal(log.inventoryExecutedVersion, undefined, "a rejected Invoke did not execute an Inventory child");
      assert.equal(log.inventoryInvocationId, undefined, "a rejected Invoke did not return a child invocation ID");
      assert.equal(run.logs.join("\n").includes("Invocation request rate exceeded"), false,
        "do not log the raw SDK error message");
      assert.equal(log.dependencyThrottleReason, scenario.throttleReason,
        "retain the modeled, bounded Lambda throttle Reason subtype");
    });
  }
});
