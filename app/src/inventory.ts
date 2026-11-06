import {
  DynamoDBClient,
  GetItemCommand,
} from "@aws-sdk/client-dynamodb";

import {
  type LambdaContext,
  type Product,
  env,
  emitMetric,
  logRequest,
  productFromItem,
  requestIdFor,
  sanitizeError,
} from "./runtime.js";

interface InventoryEvent {
  readonly action?: unknown;
  readonly operation?: unknown;
  readonly sku?: unknown;
  readonly requestId?: unknown;
}

export interface InventoryResult {
  readonly product?: Product | null;
  readonly products?: Product[];
  readonly requestId: string;
  readonly observedAt: string;
  readonly executedVersion?: string;
  readonly invocationId?: string;
}

const dynamo = new DynamoDBClient({ maxAttempts: 1 });
const INVENTORY_DYNAMO_DEADLINE_MS = 4_500;

function tableName(): string | undefined {
  return env("INVENTORY_TABLE_NAME");
}

function configuredSku(): string | undefined {
  return env("PRODUCT_SKU");
}

function eventRequestId(event: InventoryEvent): string {
  return typeof event.requestId === "string" && event.requestId.length > 0 ? event.requestId : requestIdFor({});
}

async function readProduct(sku: string): Promise<Product | null> {
  const table = tableName();
  if (!table) throw new Error("Inventory table is not configured");
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), INVENTORY_DYNAMO_DEADLINE_MS);
  let result;
  try {
    result = await dynamo.send(new GetItemCommand({
      TableName: table,
      Key: { sku: { S: sku } },
      ConsistentRead: true,
    }), { abortSignal: abort.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!result.Item) return null;
  return productFromItem(result.Item) ?? (() => { throw new Error("Inventory item has an invalid shape"); })();
}

export async function handler(event: InventoryEvent = {}, context: LambdaContext = {}): Promise<InventoryResult> {
  const started = Date.now();
  const requestId = eventRequestId(event);
  const operation = event.action === "list" || event.operation === "list" ? "list" : "lookup";
  let outcome = "success";
  let statusCode = 200;
  let sku: string | undefined;
  let failureReason: string | undefined;
  let failureErrorName: string | undefined;
  try {
    const requestedSku = typeof event.sku === "string" && event.sku.length > 0 ? event.sku : configuredSku();
    sku = requestedSku;
    if (!requestedSku) {
      outcome = "server_error";
      statusCode = 500;
      throw new Error("Inventory product is not configured");
    }
    const product = await readProduct(requestedSku);
    const observedAt = new Date().toISOString();
    if (operation === "list") {
      return {
        products: product ? [product] : [],
        requestId,
        observedAt,
        executedVersion: context.functionVersion,
        invocationId: context.awsRequestId,
      };
    }
    return { product, requestId, observedAt, executedVersion: context.functionVersion, invocationId: context.awsRequestId };
  } catch (error) {
    const safe = sanitizeError(error);
    failureErrorName = safe.name;
    const timedOut = safe.name === "AbortError";
    outcome = timedOut ? "timeout" : "server_error";
    statusCode = timedOut ? 504 : 500;
    failureReason = timedOut ? "deadline" : "dependency_error";
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      environment: env("APP_ENVIRONMENT") ?? "development",
      service: "inventory",
      operation,
      requestId,
      lambdaRequestId: context.awsRequestId,
      functionVersion: context.functionVersion,
      sku,
      outcome,
      durationMs: Date.now() - started,
      statusCode,
      error: safe.name,
      failureReason,
    }));
    throw error;
  } finally {
    const durationMs = Date.now() - started;
    logRequest({
      timestamp: new Date().toISOString(),
      environment: env("APP_ENVIRONMENT") ?? "development",
      service: "inventory",
      operation,
      requestId,
      lambdaRequestId: context.awsRequestId,
      functionVersion: context.functionVersion,
      sourceRevision: env("SOURCE_REVISION"),
      outcome,
      durationMs,
      statusCode,
      sku,
      dependencyErrorName: failureErrorName,
      dependencyFailureReason: failureReason,
    });
    emitMetric("inventory", operation, durationMs, outcome);
  }
}
