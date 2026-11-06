import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import type { AttributeValue } from "@aws-sdk/client-dynamodb";

export interface ApiEvent {
  readonly version?: string;
  readonly routeKey?: string;
  readonly rawPath?: string;
  readonly rawQueryString?: string;
  readonly headers?: Record<string, string | undefined>;
  readonly requestContext?: {
    readonly requestId?: string;
    readonly http?: { readonly method?: string; readonly path?: string };
  };
  readonly pathParameters?: Record<string, string | undefined>;
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
  readonly [key: string]: unknown;
}

export interface LambdaContext {
  readonly awsRequestId?: string;
  readonly functionVersion?: string;
  readonly invokedFunctionArn?: string;
  readonly getRemainingTimeInMillis?: () => number;
}

export interface ApiResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly isBase64Encoded?: false;
}

export interface Product {
  readonly sku: string;
  readonly name: string;
  readonly unitPriceCents: number;
  readonly currency: string;
  readonly availableQuantity: number;
  readonly productVersion: string;
}

export interface Order {
  readonly checkoutId: string;
  readonly sku: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly totalPriceCents: number;
  readonly currency: string;
  readonly createdAt: string;
  readonly status: "placed";
}

export interface CheckoutInput {
  readonly checkoutId: string;
  readonly sku: string;
  readonly quantity: number;
  readonly productVersion: string;
}

export const PRINCIPAL_ID = "demo-presenter";
export const INVENTORY_CALLER_DEADLINE_MS = 1_500;
export const ORDER_WRITE_DEADLINE_MS = 2_500;
export const ORDER_STATUS_READ_DEADLINE_MS = 1_000;
export const ORDER_RESOLUTION_RETRY_DELAY_MS = 25;
export const ORDER_RESPONSE_RESERVE_MS = 500;
export const ORDER_WRITE_RESERVE_MS = ORDER_WRITE_DEADLINE_MS +
  (2 * ORDER_STATUS_READ_DEADLINE_MS) + ORDER_RESOLUTION_RETRY_DELAY_MS + ORDER_RESPONSE_RESERVE_MS;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

export function env(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function requestIdFor(event: ApiEvent): string {
  const requestId = event.requestContext?.requestId;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : randomUUID();
}

export function response(statusCode: number, value: unknown): ApiResponse {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: JSON.stringify(value),
    isBase64Encoded: false,
  };
}

export function errorResponse(
  statusCode: number,
  code: string,
  message: string,
  requestId: string,
  checkoutId?: string,
): ApiResponse {
  return response(statusCode, {
    code,
    message,
    requestId,
    ...(checkoutId === undefined ? {} : { checkoutId }),
  });
}

export function header(event: ApiEvent, name: string): string | undefined {
  const headers = event.headers ?? {};
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

export type AuthenticationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly response: ApiResponse };

export function authenticate(event: ApiEvent, requestId: string): AuthenticationResult {
  const configured = env("PRESENTER_CREDENTIAL_DIGEST")?.toLowerCase();
  if (!configured || !/^[0-9a-f]{64}$/.test(configured)) {
    return {
      ok: false,
      response: errorResponse(500, "AUTH_CONFIGURATION_ERROR", "Authentication is not configured", requestId),
    };
  }

  const authorization = header(event, "authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/);
  if (!match) {
    return {
      ok: false,
      response: errorResponse(401, "UNAUTHORIZED", "A valid presenter credential is required", requestId),
    };
  }

  const expected = Buffer.from(configured, "hex");
  const actual = createHash("sha256").update(match[1], "utf8").digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return {
      ok: false,
      response: errorResponse(401, "UNAUTHORIZED", "A valid presenter credential is required", requestId),
    };
  }
  return { ok: true };
}

export function routeOf(event: ApiEvent): { method: string; path: string } {
  const method = String(event.requestContext?.http?.method ?? event.routeKey?.split(" ")[0] ?? "").toUpperCase();
  const path = String(event.rawPath ?? event.requestContext?.http?.path ?? "").split("?", 1)[0];
  return { method, path };
}

export function parseBody(event: ApiEvent): unknown {
  if (event.body === undefined || event.body === null) return undefined;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  if (raw.length === 0) return undefined;
  return JSON.parse(raw);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function validateCheckoutInput(value: unknown): CheckoutInput | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "checkoutId,productVersion,quantity,sku") return undefined;
  const { checkoutId, productVersion, quantity, sku } = value;
  if (!isUuid(checkoutId) || typeof sku !== "string" || sku.length < 1 || sku.length > 128) return undefined;
  if (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 5) return undefined;
  if (typeof productVersion !== "string" || productVersion.length < 1 || productVersion.length > 256) return undefined;
  return { checkoutId, sku, quantity, productVersion };
}

export function canonicalRequestHash(input: CheckoutInput): string {
  return createHash("sha256")
    .update(JSON.stringify({ sku: input.sku, quantity: input.quantity, productVersion: input.productVersion }))
    .digest("hex");
}

export function orderIdFor(checkoutId: string): string {
  return `${PRINCIPAL_ID}#${checkoutId.toLowerCase()}`;
}

export function stringAttribute(value: unknown): AttributeValue {
  return { S: String(value) };
}

export function numberAttribute(value: number): AttributeValue {
  return { N: String(value) };
}

export function attributeString(item: Record<string, AttributeValue> | undefined, key: string): string | undefined {
  const value = item?.[key];
  return value && "S" in value ? value.S : undefined;
}

export function attributeNumber(item: Record<string, AttributeValue> | undefined, key: string): number | undefined {
  const value = item?.[key];
  if (!value || !("N" in value) || value.N === undefined) return undefined;
  const number = Number(value.N);
  return Number.isFinite(number) ? number : undefined;
}

export function productFromItem(item: Record<string, AttributeValue> | undefined): Product | undefined {
  const sku = attributeString(item, "sku");
  const name = attributeString(item, "name");
  const currency = attributeString(item, "currency");
  const productVersion = attributeString(item, "productVersion");
  const unitPriceCents = attributeNumber(item, "unitPriceCents");
  const availableQuantity = attributeNumber(item, "availableQuantity");
  if (!sku || !name || !currency || !productVersion || unitPriceCents === undefined || availableQuantity === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(unitPriceCents) || unitPriceCents < 0 ||
      !Number.isSafeInteger(availableQuantity) || availableQuantity < 0) return undefined;
  return { sku, name, unitPriceCents, currency, availableQuantity, productVersion };
}

export function orderFromItem(item: Record<string, AttributeValue> | undefined): Order | undefined {
  const checkoutId = attributeString(item, "checkoutId");
  const sku = attributeString(item, "sku");
  const currency = attributeString(item, "currency");
  const createdAt = attributeString(item, "createdAt");
  const quantity = attributeNumber(item, "quantity");
  const unitPriceCents = attributeNumber(item, "unitPriceCents");
  const totalPriceCents = attributeNumber(item, "totalPriceCents");
  const status = attributeString(item, "status");
  if (!checkoutId || !sku || !currency || !createdAt || quantity === undefined || unitPriceCents === undefined ||
      totalPriceCents === undefined || status !== "placed") return undefined;
  if (!Number.isSafeInteger(quantity) || quantity < 1 || !Number.isSafeInteger(unitPriceCents) || unitPriceCents < 0 ||
      !Number.isSafeInteger(totalPriceCents) || totalPriceCents < 0) return undefined;
  return { checkoutId, sku, quantity, unitPriceCents, totalPriceCents, currency, createdAt, status: "placed" };
}

export function orderToItem(
  input: CheckoutInput,
  product: Product,
  requestHash: string,
  createdAt: string,
): Record<string, AttributeValue> {
  return {
    orderId: stringAttribute(orderIdFor(input.checkoutId)),
    ownerId: stringAttribute(PRINCIPAL_ID),
    checkoutId: stringAttribute(input.checkoutId),
    requestHash: stringAttribute(requestHash),
    sku: stringAttribute(product.sku),
    productVersion: stringAttribute(product.productVersion),
    quantity: numberAttribute(input.quantity),
    unitPriceCents: numberAttribute(product.unitPriceCents),
    totalPriceCents: numberAttribute(product.unitPriceCents * input.quantity),
    currency: stringAttribute(product.currency),
    createdAt: stringAttribute(createdAt),
    status: stringAttribute("placed"),
  };
}

export function orderHash(item: Record<string, AttributeValue> | undefined): string | undefined {
  const value = item?.requestHash;
  return value && "S" in value ? value.S : undefined;
}

export function sanitizeError(error: unknown): { name: string; message: string } {
  const name = error instanceof Error && error.name ? error.name : "Error";
  const rawMessage = error instanceof Error ? error.message : String(error);
  return { name: name.slice(0, 120), message: rawMessage.slice(0, 500) };
}

export interface RequestLog {
  readonly timestamp: string;
  readonly environment: string;
  readonly service: "checkout" | "inventory";
  readonly operation: string;
  readonly requestId: string;
  readonly lambdaRequestId?: string;
  readonly functionVersion?: string;
  readonly sourceRevision?: string;
  readonly credentialGeneration?: string;
  readonly outcome: string;
  readonly durationMs: number;
  readonly statusCode?: number;
  readonly errorCode?: string;
  readonly errorName?: string;
  readonly sku?: string;
  readonly checkoutId?: string;
  readonly inventoryFunction?: string;
  readonly inventoryExecutedVersion?: string;
  readonly inventoryInvocationId?: string;
  readonly dependencyErrorName?: string;
  readonly dependencyFailureReason?: string;
  readonly dependencyDurationMs?: number;
}

export function logRequest(log: RequestLog): void {
  // IDs are useful in application logs for joins, but never appear in metric dimensions.
  console.log(JSON.stringify(log));
}

export function emitMetric(
  service: "checkout" | "inventory",
  operation: string,
  durationMs: number,
  outcome: string,
  details: {
    readonly inventoryLookupDurationMs?: number;
    readonly inventoryLookupTimeout?: number;
  } = {},
): void {
  const serverError = outcome === "server_error" || outcome === "dependency_error" || outcome === "timeout";
  const dimensions = ["Environment", "Service"];
  const metricName = service === "inventory" ? "InventoryRequests" : "CheckoutRequests";
  const inventoryLookupDurationMs = details.inventoryLookupDurationMs ?? (service === "inventory" ? durationMs : 0);
  const inventoryLookupTimeout = details.inventoryLookupTimeout ?? (service === "inventory" && outcome === "timeout" ? 1 : 0);
  const checkoutSuccess = service === "checkout" && operation === "checkout" && outcome === "success" ? 1 : 0;
  const checkoutServerError = service === "checkout" && operation === "checkout" && serverError ? 1 : 0;
  process.stdout.write(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: "IncidentTriage/Application",
        Dimensions: [dimensions],
        Metrics: [
          { Name: metricName, Unit: "Count" },
          { Name: "DurationMs", Unit: "Milliseconds" },
          { Name: "ServerErrors", Unit: "Count" },
          { Name: "CheckoutSuccess", Unit: "Count" },
          { Name: "CheckoutServerError", Unit: "Count" },
          { Name: "InventoryLookupDurationMs", Unit: "Milliseconds" },
          { Name: "InventoryLookupTimeout", Unit: "Count" },
        ],
      }],
    },
    Environment: env("APP_ENVIRONMENT") ?? "development",
    Service: service,
    Operation: operation,
    [metricName]: 1,
    DurationMs: durationMs,
    ServerErrors: serverError ? 1 : 0,
    CheckoutSuccess: checkoutSuccess,
    CheckoutServerError: checkoutServerError,
    InventoryLookupDurationMs: inventoryLookupDurationMs,
    InventoryLookupTimeout: inventoryLookupTimeout,
  }) + "\n");
}
