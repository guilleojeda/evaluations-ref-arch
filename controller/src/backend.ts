import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { AlarmReadError, readAlarm } from "./alarm.js";
import {
  InvestigationQueryError,
  InvestigationReadError,
  parseInvestigationQuery,
  readInvestigations,
} from "./investigations.js";
import { applyCommand, getAction, getDashboard, CommandError } from "./store.js";
import type { Action, Command } from "./types.js";

export interface BackendEvent {
  readonly rawPath?: string;
  readonly rawQueryString?: string;
  readonly queryStringParameters?: Record<string, string | undefined>;
  readonly requestContext?: { readonly http?: { readonly method?: string } };
  readonly headers?: Record<string, string | undefined>;
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
}

export interface BackendResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

const secrets = new SecretsManagerClient({ maxAttempts: 1 });
const lambda = new LambdaClient({ maxAttempts: 1 });
const webRoot = new URL("./web/", import.meta.url);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store, max-age=0",
};

function json(statusCode: number, value: unknown): BackendResponse {
  return { statusCode, headers: jsonHeaders, body: JSON.stringify(value) };
}

function header(event: BackendEvent, name: string): string | undefined {
  const match = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match?.[1];
}

function bearer(event: BackendEvent): string | undefined {
  const value = header(event, "authorization");
  return value?.match(/^Bearer ([^\s]+)$/)?.[1];
}

async function configuredOperatorDigest(): Promise<string | undefined> {
  const secretId = process.env.CONTROLLER_OPERATOR_SECRET_ARN;
  if (!secretId) return undefined;
  try {
    const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }), {
      abortSignal: AbortSignal.timeout(3_000),
    });
    const value = response.SecretString?.trim();
    if (!value || !/^[0-9a-f]{64}$/i.test(value)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function matchesDigest(value: string, expected: string): boolean {
  const actual = createHash("sha256").update(value).digest();
  const wanted = Buffer.from(expected, "hex");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

async function authorized(event: BackendEvent): Promise<boolean> {
  const actual = bearer(event);
  if (!actual) return false;
  const expected = await configuredOperatorDigest();
  return Boolean(expected && matchesDigest(actual, expected));
}

function parsedBody(event: BackendEvent): unknown {
  if (!event.body) return undefined;
  try {
    const source = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    return JSON.parse(source);
  } catch {
    return undefined;
  }
}

function command(value: unknown): Command | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (input.kind === "readiness" && input.confirmQuiet === true && keys.every((key) => ["kind", "confirmQuiet"].includes(key))) {
    return { kind: "readiness", confirmQuiet: true };
  }
  if (input.kind === "traffic" && keys.length === 1) return { kind: "traffic" };
  if (input.kind === "increase_memory" && keys.length === 3 && input.function === "inventory" &&
      typeof input.memoryMb === "number" && Number.isSafeInteger(input.memoryMb) && input.memoryMb >= 128 && input.memoryMb <= 10_240) {
    return { kind: "increase_memory", function: "inventory", memoryMb: input.memoryMb };
  }
  if (input.kind === "activate_inventory_denial" && keys.length === 1) return { kind: "activate_inventory_denial" };
  if (input.kind === "restore_inventory_access" && (keys.length === 1 || (keys.length === 2 && input.restoreWithoutEvidence === true))) {
    return input.restoreWithoutEvidence === true ? { kind: "restore_inventory_access", restoreWithoutEvidence: true } : { kind: "restore_inventory_access" };
  }
  if (input.kind === "recover" && input.confirmQuiet === true &&
      (keys.length === 2 || (keys.length === 3 && input.recoverWithoutEvidence === true)) &&
      keys.every((key) => ["kind", "confirmQuiet", "recoverWithoutEvidence"].includes(key))) {
    return input.recoverWithoutEvidence === true
      ? { kind: "recover", confirmQuiet: true, recoverWithoutEvidence: true }
      : { kind: "recover", confirmQuiet: true };
  }
  if ((input.kind === "stop" || input.kind === "discard") && keys.every((key) => ["kind", "targetActionId"].includes(key))
      && typeof input.targetActionId === "string" && UUID.test(input.targetActionId)) {
    return { kind: input.kind, targetActionId: input.targetActionId };
  }
  return undefined;
}

function staticAsset(path: string): URL | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  if (decoded === "/" || decoded === "/index.html") return new URL("index.html", webRoot);
  if (!/^\/assets\/[A-Za-z0-9._-]+\.(?:js|mjs|css)$/.test(decoded)) return undefined;
  const name = basename(decoded);
  return name === decoded.slice("/assets/".length) ? new URL(`assets/${name}`, webRoot) : undefined;
}

async function staticResponse(path: string): Promise<BackendResponse> {
  const asset = staticAsset(path);
  if (!asset) return json(404, { code: "NOT_FOUND", message: "Controller route not found" });
  try {
    const body = await readFile(asset);
    const suffix = extname(asset.pathname);
    const type = suffix === ".css" ? "text/css; charset=utf-8"
      : suffix === ".js" || suffix === ".mjs" ? "application/javascript; charset=utf-8"
        : "text/html; charset=utf-8";
    const cache = asset.pathname.endsWith("index.html") ? "no-cache, max-age=0, must-revalidate" : "public, max-age=31536000, immutable";
    return { statusCode: 200, headers: { "content-type": type, "cache-control": cache }, body: body.toString("utf8") };
  } catch {
    return json(404, { code: "NOT_FOUND", message: "Controller asset not found" });
  }
}

async function dispatch(action: Action): Promise<void> {
  const functionName = process.env.CONTROLLER_WORKER_NAME;
  if (!functionName) throw new Error("worker unavailable");
  await lambda.send(new InvokeCommand({
    FunctionName: functionName,
    InvocationType: "Event",
    Payload: Buffer.from(JSON.stringify({ actionId: action.id })),
  }), { abortSignal: AbortSignal.timeout(2_000) });
}

function commandError(error: unknown): BackendResponse {
  if (error instanceof CommandError) return json(error.statusCode, { code: error.code, message: error.message });
  if (error instanceof AlarmReadError) return json(503, { code: "ALARM_UNAVAILABLE", message: error.message });
  if (error instanceof InvestigationQueryError) return json(400, { code: error.code, message: error.message });
  if (error instanceof InvestigationReadError) return json(503, { code: "INVESTIGATIONS_UNAVAILABLE", message: error.message });
  return json(500, { code: "CONTROLLER_ERROR", message: "The controller could not complete the request" });
}

export async function handler(event: BackendEvent = {}): Promise<BackendResponse> {
  const path = event.rawPath ?? "/";
  const method = event.requestContext?.http?.method ?? "GET";
  if (!path.startsWith("/api/")) return method === "GET" ? staticResponse(path) : json(405, { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" });
  if (!(await authorized(event))) return json(401, { code: "UNAUTHORIZED", message: "Controller authentication required" });

  try {
    if (method === "GET" && path === "/api/state") return json(200, await getDashboard());
    if (method === "GET" && path === "/api/alarm") return json(200, await readAlarm());
    if (method === "GET" && path === "/api/investigations") {
      return json(200, await readInvestigations(parseInvestigationQuery(event.rawQueryString, event.queryStringParameters)));
    }
    const match = path.match(/^\/api\/actions\/([^/]+)$/);
    if (!match || !UUID.test(match[1])) return json(404, { code: "NOT_FOUND", message: "Controller route not found" });
    const id = match[1];
    if (method === "GET") {
      const action = await getAction(id);
      return action ? json(200, { action }) : json(404, { code: "ACTION_NOT_FOUND", message: "Action not found" });
    }
    if (method !== "PUT") return json(405, { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" });
    const input = command(parsedBody(event));
    if (!input) return json(400, { code: "INVALID_COMMAND", message: "The action command is invalid" });
    const result = await applyCommand(id, input);
    if (result.created && input.kind !== "stop" && input.kind !== "discard") {
      try {
        await dispatch(result.action);
      } catch {
        // Keep the queued action durable. A later expiry is visible to the presenter and is not replayed here.
      }
    }
    return json(result.created ? 202 : 200, { action: result.action });
  } catch (error) {
    return commandError(error);
  }
}
