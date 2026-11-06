import {
  DynamoDBClient,
  GetItemCommand,
  TransactWriteItemsCommand,
  type GetItemCommandOutput,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";

import {
  INVENTORY_CALLER_DEADLINE_MS,
  ORDER_STATUS_READ_DEADLINE_MS,
  ORDER_WRITE_DEADLINE_MS,
  ORDER_WRITE_RESERVE_MS,
  ORDER_RESOLUTION_RETRY_DELAY_MS,
  type ApiEvent,
  type ApiResponse,
  type CheckoutInput,
  type LambdaContext,
  type Order,
  type Product,
  authenticate,
  canonicalRequestHash,
  env,
  emitMetric,
  errorResponse,
  logRequest,
  orderFromItem,
  orderHash,
  orderIdFor,
  orderToItem,
  parseBody,
  requestIdFor,
  response,
  routeOf,
  sanitizeError,
  stringAttribute,
  numberAttribute,
  validateCheckoutInput,
  isUuid,
} from "./runtime.js";

const dynamo = new DynamoDBClient({ maxAttempts: 1 });
const lambda = new LambdaClient({ maxAttempts: 1 });
const EMPTY_CONTEXT: LambdaContext = {};

interface InventoryPayload {
  readonly product?: unknown;
  readonly products?: unknown;
  readonly invocationId?: unknown;
  readonly errorType?: unknown;
}

interface InventoryCallSuccess {
  readonly kind: "success";
  readonly payload: InventoryPayload;
  readonly executedVersion?: string;
  readonly invocationId?: string;
  readonly durationMs: number;
}

interface InventoryCallFailure {
  readonly kind: "error" | "timeout";
  readonly error?: unknown;
  readonly errorName: string;
  readonly reason: "configuration" | "function_error" | "invalid_payload" | "deadline" | "transport_error" | "inventory_access_denied";
  readonly executedVersion?: string;
  readonly durationMs: number;
}

type InventoryCall = InventoryCallSuccess | InventoryCallFailure;
type ObserveInventory = (call: InventoryCall) => void;

interface SavedOrder {
  readonly item: Record<string, AttributeValue>;
  readonly order: Order;
}

function tableNames(): { orders: string; inventory: string } | undefined {
  const orders = env("ORDERS_TABLE_NAME");
  const inventory = env("INVENTORY_TABLE_NAME");
  return orders && inventory ? { orders, inventory } : undefined;
}

function inventoryFunctionName(): string | undefined {
  const configured = env("INVENTORY_FUNCTION_NAME");
  return configured?.endsWith(":live") ? configured : undefined;
}

function parseInventoryPayload(value: Uint8Array | string | undefined): InventoryPayload | undefined {
  if (value === undefined) return undefined;
  try {
    const raw = typeof value === "string" ? value : Buffer.from(value).toString("utf8");
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as InventoryPayload
      : undefined;
  } catch {
    return undefined;
  }
}

function isExecutedInventoryAccessDenied(result: {
  readonly FunctionError?: string;
  readonly ExecutedVersion?: string;
  readonly Payload?: Uint8Array | string;
}): boolean {
  if (!result.FunctionError || typeof result.ExecutedVersion !== "string" || result.ExecutedVersion.length === 0) return false;
  return parseInventoryPayload(result.Payload)?.errorType === "InventoryReadAccessDenied";
}

async function sendDynamo<T>(
  operation: (abortSignal: AbortSignal) => Promise<T>,
  deadlineMs: number,
): Promise<T> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), deadlineMs);
  try {
    return await operation(abort.signal);
  } finally {
    clearTimeout(timeout);
  }
}

function payloadProduct(value: unknown): Product | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const unitPriceCents = item.unitPriceCents;
  const availableQuantity = item.availableQuantity;
  if (typeof item.sku !== "string" || typeof item.name !== "string" || typeof item.currency !== "string" ||
      typeof item.productVersion !== "string" || typeof unitPriceCents !== "number" ||
      typeof availableQuantity !== "number" || !Number.isSafeInteger(unitPriceCents) ||
      !Number.isSafeInteger(availableQuantity) || unitPriceCents < 0 || availableQuantity < 0) {
    return undefined;
  }
  return {
    sku: item.sku,
    name: item.name,
    unitPriceCents,
    currency: item.currency,
    availableQuantity,
    productVersion: item.productVersion,
  };
}

function inventoryProduct(payload: InventoryPayload): Product | null | "invalid" {
  if (payload.product === null) return null;
  return payloadProduct(payload.product) ?? "invalid";
}

function inventoryProducts(payload: InventoryPayload): Product[] | "invalid" {
  if (!Array.isArray(payload.products)) return "invalid";
  const products = payload.products.map(payloadProduct);
  return products.every((product): product is Product => product !== undefined) ? products : "invalid";
}

async function invokeInventory(
  requestId: string,
  input: { readonly operation: "lookup" | "list"; readonly sku?: string },
  context: LambdaContext,
): Promise<InventoryCall> {
  const functionName = inventoryFunctionName();
  const started = Date.now();
  if (!functionName) {
    return { kind: "error", error: new Error("Inventory function is not configured"), errorName: "ConfigurationError", reason: "configuration", durationMs: 0 };
  }
  const remaining = context.getRemainingTimeInMillis?.() ?? Number.POSITIVE_INFINITY;
  if (remaining <= INVENTORY_CALLER_DEADLINE_MS + 500) {
    return { kind: "timeout", errorName: "DeadlineExceeded", reason: "deadline", durationMs: Date.now() - started };
  }
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), INVENTORY_CALLER_DEADLINE_MS);
  const payload = {
    action: input.operation,
    operation: input.operation,
    ...(input.sku === undefined ? {} : { sku: input.sku }),
    requestId,
  };
  try {
    const result = await lambda.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify(payload)),
    }), { abortSignal: abort.signal });
    const durationMs = Date.now() - started;
    if (result.FunctionError) {
      if (isExecutedInventoryAccessDenied(result)) {
        return {
          kind: "error",
          errorName: "InventoryReadAccessDenied",
          reason: "inventory_access_denied",
          executedVersion: result.ExecutedVersion,
          durationMs,
        };
      }
      return {
        kind: "error",
        errorName: "FunctionError",
        reason: "function_error",
        executedVersion: result.ExecutedVersion,
        durationMs,
      };
    }
    const parsed = parseInventoryPayload(result.Payload);
    if (!parsed) return { kind: "error", errorName: "InvalidPayload", reason: "invalid_payload", durationMs };
    return {
      kind: "success",
      payload: parsed,
      executedVersion: result.ExecutedVersion,
      invocationId: typeof parsed.invocationId === "string" ? parsed.invocationId : result.$metadata.requestId,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - started;
    const name = sanitizeError(error).name;
    if (abort.signal.aborted || name === "AbortError") {
      return { kind: "timeout", errorName: "AbortError", reason: "deadline", durationMs };
    }
    return { kind: "error", error, errorName: name, reason: "transport_error", durationMs };
  } finally {
    clearTimeout(timeout);
  }
}

async function readOrder(tableName: string, orderId: string): Promise<SavedOrder | undefined> {
  const result = await sendDynamo(
    (abortSignal): Promise<GetItemCommandOutput> => dynamo.send(new GetItemCommand({
      TableName: tableName,
      Key: { orderId: stringAttribute(orderId) },
      ConsistentRead: true,
    }), { abortSignal }),
    ORDER_STATUS_READ_DEADLINE_MS,
  );
  if (!result.Item) return undefined;
  const order = orderFromItem(result.Item);
  if (!order) throw new Error("Saved order has an invalid shape");
  return { item: result.Item, order };
}

function checkoutError(
  statusCode: number,
  code: string,
  message: string,
  requestId: string,
  input: Pick<CheckoutInput, "checkoutId">,
  dependencyReason?: string,
): ApiResponse {
  return errorResponse(statusCode, code, message, requestId, input.checkoutId, dependencyReason);
}

function inventoryDependencyReason(call: InventoryCallFailure): string | undefined {
  return call.reason === "inventory_access_denied" ? "inventory_access_denied" : undefined;
}

function matchingSavedOrder(
  saved: SavedOrder | undefined,
  hash: string,
  requestId: string,
  input: CheckoutInput,
): ApiResponse | undefined {
  if (!saved) return undefined;
  if (orderHash(saved.item) !== hash) {
    return checkoutError(409, "CHECKOUT_ID_CONFLICT", "This checkout ID was already used for different input", requestId, input);
  }
  return response(200, { requestId, order: saved.order });
}

function transactionCancellationKind(
  error: unknown,
  requestedVersion: string,
  requestedQuantity: number,
): "duplicate" | "stale" | "stock" | "unknown" {
  const candidate = error as { readonly CancellationReasons?: Array<{ readonly Code?: string }> };
  const reasons = candidate.CancellationReasons ?? [];
  if (reasons.some((reason) => reason.Code === "IdempotentParameterMismatch")) return "duplicate";
  if (reasons.some((reason) => reason.Code === "TransactionConflict")) return "unknown";
  const updateReason = reasons[1] as { readonly Code?: string; readonly Item?: Record<string, AttributeValue> } | undefined;
  if (updateReason?.Code !== "ConditionalCheckFailed" || !updateReason.Item) return "unknown";
  const version = updateReason.Item.productVersion?.S;
  const quantity = Number(updateReason.Item.availableQuantity?.N);
  if (version !== requestedVersion) return "stale";
  if (Number.isSafeInteger(quantity) && quantity >= 0 && quantity < requestedQuantity) return "stock";
  return "unknown";
}

function isTransactionCancellation(error: unknown): boolean {
  const name = sanitizeError(error).name;
  return name === "TransactionCanceledException" || name === "TransactionConflictException" || name === "ConditionalCheckFailedException";
}

async function resolveAmbiguousOrder(
  tableName: string,
  input: CheckoutInput,
): Promise<SavedOrder | undefined> {
  const orderId = orderIdFor(input.checkoutId);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const saved = await readOrder(tableName, orderId);
      if (saved) return saved;
    } catch {
      // A failed status read cannot settle the write; preserve the unknown outcome.
    }
    if (attempt === 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, ORDER_RESOLUTION_RETRY_DELAY_MS));
  }
  return undefined;
}

async function resolvedOrderResponse(
  tableName: string,
  input: CheckoutInput,
  hash: string,
  requestId: string,
): Promise<ApiResponse | undefined> {
  const saved = await resolveAmbiguousOrder(tableName, input);
  return saved ? matchingSavedOrder(saved, hash, requestId, input) : undefined;
}

async function transactOrder(
  names: { orders: string; inventory: string },
  input: CheckoutInput,
  product: Product,
  requestHash: string,
  context: LambdaContext,
): Promise<Order> {
  const now = new Date().toISOString();
  const order: Order = {
    checkoutId: input.checkoutId,
    sku: product.sku,
    quantity: input.quantity,
    unitPriceCents: product.unitPriceCents,
    totalPriceCents: product.unitPriceCents * input.quantity,
    currency: product.currency,
    createdAt: now,
    status: "placed",
  };
  const remaining = context.getRemainingTimeInMillis?.() ?? Number.POSITIVE_INFINITY;
  if (remaining <= ORDER_WRITE_RESERVE_MS) {
    throw Object.assign(new Error("Insufficient time for the order transaction"), { name: "CheckoutDeadlineExceeded" });
  }
  await sendDynamo((abortSignal) => dynamo.send(new TransactWriteItemsCommand({
    ReturnConsumedCapacity: "NONE",
    TransactItems: [
      {
        Put: {
          TableName: names.orders,
          Item: orderToItem(input, product, requestHash, now),
          ConditionExpression: "attribute_not_exists(orderId)",
        },
      },
      {
        Update: {
          TableName: names.inventory,
          Key: { sku: stringAttribute(product.sku) },
          UpdateExpression: "SET availableQuantity = availableQuantity - :quantity, updatedAt = :updatedAt",
          ConditionExpression: "attribute_exists(sku) AND productVersion = :productVersion AND availableQuantity >= :quantity",
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          ExpressionAttributeValues: {
            ":quantity": numberAttribute(input.quantity),
            ":productVersion": stringAttribute(input.productVersion),
            ":updatedAt": stringAttribute(now),
          },
        },
      },
    ],
  }), { abortSignal }), ORDER_WRITE_DEADLINE_MS);
  return order;
}

async function checkout(
  names: { orders: string; inventory: string },
  input: CheckoutInput,
  requestId: string,
  context: LambdaContext,
  observeInventory: ObserveInventory,
): Promise<ApiResponse> {
  const hash = canonicalRequestHash(input);
  const orderId = orderIdFor(input.checkoutId);
  let saved: SavedOrder | undefined;
  try {
    saved = await readOrder(names.orders, orderId);
  } catch {
    return checkoutError(500, "ORDER_READ_FAILED", "The order could not be read", requestId, input);
  }
  const existing = matchingSavedOrder(saved, hash, requestId, input);
  if (existing) return existing;

  const inventory = await invokeInventory(requestId, { operation: "lookup", sku: input.sku }, context);
  observeInventory(inventory);
  if (inventory.kind === "timeout") {
    return checkoutError(504, "INVENTORY_DEADLINE_EXCEEDED", "Inventory did not respond before the dependency deadline", requestId, input);
  }
  if (inventory.kind === "error") {
    return checkoutError(502, "INVENTORY_LOOKUP_FAILED", "Inventory could not be read", requestId, input,
      inventoryDependencyReason(inventory));
  }
  if (inventory.kind !== "success") {
    return checkoutError(502, "INVENTORY_LOOKUP_FAILED", "Inventory could not be read", requestId, input);
  }
  const productResult = inventoryProduct(inventory.payload);
  if (productResult === "invalid") {
    return checkoutError(502, "INVENTORY_INVALID_PAYLOAD", "Inventory returned an invalid product", requestId, input);
  }
  if (productResult === null || productResult.sku !== input.sku) {
    return checkoutError(404, "PRODUCT_NOT_FOUND", "The requested product was not found", requestId, input);
  }
  if (productResult.productVersion !== input.productVersion) {
    return checkoutError(409, "STALE_PRODUCT_VERSION", "The product snapshot is no longer current", requestId, input);
  }

  try {
    const createdOrder = await transactOrder(names, input, productResult, hash, context);
    return response(201, { requestId, order: createdOrder });
  } catch (error) {
    if (sanitizeError(error).name === "CheckoutDeadlineExceeded") {
      return checkoutError(504, "CHECKOUT_DEADLINE_EXCEEDED", "There was not enough time to start the order transaction", requestId, input);
    }
    const resolved = await resolvedOrderResponse(names.orders, input, hash, requestId);
    if (resolved) return resolved;
    if (isTransactionCancellation(error)) {
      const kind = transactionCancellationKind(error, input.productVersion, input.quantity);
      if (kind === "stale") return checkoutError(409, "STALE_PRODUCT_VERSION", "The product snapshot is no longer current", requestId, input);
      if (kind === "stock") return checkoutError(409, "INSUFFICIENT_STOCK", "There is not enough stock for this quantity", requestId, input);
      return checkoutError(503, "OUTCOME_UNKNOWN", "The order outcome could not be confirmed; check status before retrying", requestId, input);
    }
    return checkoutError(503, "OUTCOME_UNKNOWN", "The order outcome could not be confirmed; check status before retrying", requestId, input);
  }
}

async function products(requestId: string, context: LambdaContext, observeInventory: ObserveInventory): Promise<ApiResponse> {
  const inventory = await invokeInventory(requestId, { operation: "list" }, context);
  observeInventory(inventory);
  if (inventory.kind === "timeout") return errorResponse(504, "INVENTORY_DEADLINE_EXCEEDED", "Inventory did not respond before the dependency deadline", requestId);
  if (inventory.kind === "error") {
    return errorResponse(502, "INVENTORY_LOOKUP_FAILED", "Inventory could not be read", requestId, undefined,
      inventoryDependencyReason(inventory));
  }
  if (inventory.kind !== "success") return errorResponse(502, "INVENTORY_LOOKUP_FAILED", "Inventory could not be read", requestId);
  const values = inventoryProducts(inventory.payload);
  if (values === "invalid") return errorResponse(502, "INVENTORY_INVALID_PAYLOAD", "Inventory returned an invalid product list", requestId);
  return response(200, { requestId, observedAt: new Date().toISOString(), products: values });
}

async function orderStatus(tableName: string, checkoutId: string, requestId: string): Promise<ApiResponse> {
  try {
    const saved = await readOrder(tableName, orderIdFor(checkoutId));
    if (!saved) return checkoutError(404, "ORDER_NOT_FOUND", "The order was not found", requestId, { checkoutId });
    return response(200, { requestId, order: saved.order });
  } catch {
    return checkoutError(500, "ORDER_READ_FAILED", "The order could not be read", requestId, { checkoutId });
  }
}

function pathCheckoutId(event: ApiEvent, path: string): string | undefined {
  const fromParameters = event.pathParameters?.checkoutId;
  if (typeof fromParameters === "string" && fromParameters.length > 0) return fromParameters;
  const prefix = "/api/orders/";
  return path.startsWith(prefix) ? decodeURIComponent(path.slice(prefix.length)) : undefined;
}

function classifyOutcome(statusCode: number): string {
  if (statusCode >= 500) return statusCode === 504 ? "timeout" : "server_error";
  if (statusCode >= 400) return "rejected";
  return "success";
}

export async function handler(event: ApiEvent = {}, context: LambdaContext = EMPTY_CONTEXT): Promise<ApiResponse> {
  const requestId = requestIdFor(event);
  const started = Date.now();
  const route = routeOf(event);
  const operation = route.path === "/api/products"
    ? "products"
    : route.path === "/api/checkout"
      ? "checkout"
      : route.path.startsWith("/api/orders/")
        ? "order_status"
        : "unknown";
  let result: ApiResponse;
  let errorCode: string | undefined;
  let checkoutId: string | undefined;
  let sku: string | undefined = route.path === "/api/products" ? env("PRODUCT_SKU") : undefined;
  let inventoryExecutedVersion: string | undefined;
  let inventoryInvocationId: string | undefined;
  let dependencyDurationMs: number | undefined;
  let dependencyErrorName: string | undefined;
  let dependencyFailureReason: string | undefined;
  let requestErrorName: string | undefined;
  const observeInventory: ObserveInventory = (call) => {
    dependencyDurationMs = call.durationMs;
    inventoryExecutedVersion = call.executedVersion;
    if (call.kind === "success") {
      inventoryInvocationId = call.invocationId;
    } else {
      dependencyErrorName = call.errorName;
      dependencyFailureReason = call.reason;
    }
  };
  try {
    const auth = authenticate(event, requestId);
    if (!auth.ok) {
      result = auth.response;
    } else {
      const names = tableNames();
      if (!names || !inventoryFunctionName()) {
        result = errorResponse(500, "APPLICATION_CONFIGURATION_ERROR", "The application is not configured", requestId);
      } else if (route.method === "GET" && route.path === "/api/products") {
        result = await products(requestId, context, observeInventory);
      } else if (route.method === "POST" && route.path === "/api/checkout") {
        let parsed: unknown;
        let malformedJson = false;
        try {
          parsed = parseBody(event);
        } catch {
          malformedJson = true;
        }
        const input = malformedJson ? undefined : validateCheckoutInput(parsed);
        const candidateCheckoutId = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>).checkoutId
          : undefined;
        checkoutId = isUuid(candidateCheckoutId) ? candidateCheckoutId : undefined;
        sku = input?.sku;
        if (malformedJson) {
          result = errorResponse(400, "INVALID_JSON", "The request body must be valid JSON", requestId);
        } else if (!input) {
          result = errorResponse(400, "INVALID_CHECKOUT", "The checkout request is invalid", requestId, checkoutId);
        } else {
          result = await checkout(names, input, requestId, context, observeInventory);
        }
      } else if (route.method === "GET" && route.path.startsWith("/api/orders/")) {
        checkoutId = pathCheckoutId(event, route.path);
        if (!isUuid(checkoutId)) {
          result = errorResponse(400, "INVALID_CHECKOUT_ID", "The checkout ID is invalid", requestId);
        } else {
          result = await orderStatus(names.orders, checkoutId, requestId);
        }
      } else {
        result = errorResponse(404, "ROUTE_NOT_FOUND", "The requested route was not found", requestId);
      }
    }
  } catch (error) {
    const safe = sanitizeError(error);
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      environment: env("APP_ENVIRONMENT") ?? "development",
      service: "checkout",
      operation,
      requestId,
      lambdaRequestId: context.awsRequestId,
      error: safe.name,
    }));
    requestErrorName = safe.name;
    result = errorResponse(500, "INTERNAL_ERROR", "The request could not be completed", requestId, checkoutId);
  }

  try {
    const body = JSON.parse(result.body) as { readonly code?: string };
    errorCode = body.code;
  } catch {
    // The handler always creates JSON bodies; leave logging defensive in case that changes.
  }
  const durationMs = Date.now() - started;
  const outcome = classifyOutcome(result.statusCode);
  logRequest({
    timestamp: new Date().toISOString(),
    environment: env("APP_ENVIRONMENT") ?? "development",
    service: "checkout",
    operation,
    requestId,
    lambdaRequestId: context.awsRequestId,
    functionVersion: context.functionVersion,
    sourceRevision: env("SOURCE_REVISION"),
    credentialGeneration: env("PRESENTER_CREDENTIAL_GENERATION"),
    outcome,
    durationMs,
    statusCode: result.statusCode,
    errorCode,
    errorName: requestErrorName ?? dependencyErrorName,
    checkoutId,
    sku,
    inventoryFunction: inventoryFunctionName(),
    inventoryExecutedVersion,
    inventoryInvocationId,
    dependencyErrorName,
    dependencyFailureReason,
    dependencyDurationMs,
  });
  emitMetric("checkout", operation, durationMs, outcome, {
    inventoryLookupDurationMs: dependencyDurationMs,
    inventoryLookupTimeout: dependencyFailureReason === "deadline" ? 1 : 0,
  });
  return result;
}
