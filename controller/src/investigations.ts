import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type {
  InvestigationCitation,
  InvestigationFailure,
  InvestigationRecommendation,
  InvestigationReport,
  InvestigationResponse,
  InvestigationRun,
  InvestigationStatus,
  JsonValue,
} from "./types.js";

const dynamo = new DynamoDBClient({ maxAttempts: 1 });
const recentLimit = 20;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/;
const projectionNames = {
  "#alarmArn": "alarmArn",
  "#transitionAt": "transitionAt",
  "#runId": "runId",
  "#runtimeSessionId": "runtimeSessionId",
  "#candidateId": "candidateId",
  "#sourceRevision": "sourceRevision",
  "#artifactSha256": "artifactSha256",
  "#promptSha256": "promptSha256",
  "#modelId": "modelId",
  "#runtimeArn": "runtimeArn",
  "#runtimeVersion": "runtimeVersion",
  "#endpointName": "endpointName",
  "#status": "status",
  "#startedAt": "startedAt",
  "#deadlineAt": "deadlineAt",
  "#finishedAt": "finishedAt",
  "#report": "report",
  "#reportSchemaVersion": "reportSchemaVersion",
  "#failure": "failure",
  "#traceRef": "traceRef",
  "#captureRef": "captureRef",
};
const projection = Object.keys(projectionNames).join(", ");

export class InvestigationQueryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "InvestigationQueryError";
  }
}

export class InvestigationReadError extends Error {
  constructor(message = "Durable investigation records could not be observed") {
    super(message);
    this.name = "InvestigationReadError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, name: string, maxLength = 2048): string {
  const field = value[name];
  if (typeof field !== "string" || !field.trim() || field.length > maxLength) {
    throw new InvestigationReadError("An investigation record is missing required provenance.");
  }
  return field;
}

function optionalString(value: Record<string, unknown>, name: string, maxLength = 2048): string | undefined {
  const field = value[name];
  if (field === undefined || field === null) return undefined;
  if (typeof field !== "string" || field.length > maxLength) {
    throw new InvestigationReadError("An investigation record contains invalid optional provenance.");
  }
  return field;
}

function timestamp(value: string): string {
  if (!timestampPattern.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new InvestigationReadError("An investigation record contains an invalid timestamp.");
  }
  return value;
}

function normalizeTransitionAt(value: string): string | undefined {
  if (value.length > 64 || !timestampPattern.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function allowedAlarms(): string[] {
  const raw = process.env.CONTROLLER_AGENT_ALARM_ARNS;
  if (!raw) throw new InvestigationReadError("Investigation discovery is not configured.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvestigationReadError("Investigation discovery is not configured.");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 ||
      parsed.some((arn) => typeof arn !== "string" || !/^arn:[^:]+:cloudwatch:[a-z0-9-]+:\d{12}:alarm:.{1,240}$/.test(arn))) {
    throw new InvestigationReadError("Investigation discovery is not configured.");
  }
  return [...new Set(parsed)];
}

function tableName(): string {
  const table = process.env.CONTROLLER_AGENT_RUN_TABLE?.trim();
  if (!table || table.length > 255 || !/^[A-Za-z0-9_.-]+$/.test(table)) {
    throw new InvestigationReadError("Investigation discovery is not configured.");
  }
  return table;
}

function jsonValue(value: unknown, depth = 0): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (depth >= 3) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, 32).flatMap((item) => {
      const safe = jsonValue(item, depth + 1);
      return safe === undefined ? [] : [safe];
    });
  }
  if (isRecord(value)) {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value).slice(0, 32)) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) continue;
      const safe = jsonValue(item, depth + 1);
      if (safe !== undefined) result[key] = safe;
    }
    return result;
  }
  return undefined;
}

function reference(value: unknown, kind: "trace" | "capture"): Record<string, JsonValue> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new InvestigationReadError("An investigation record contains an invalid evidence reference.");
  const keys = kind === "trace"
    ? ["traceId", "traceArn", "region", "logGroup", "logGroupName", "logStream", "logStreamName", "runtimeArn", "runtimeSessionId", "sessionId", "runId", "candidateId", "sourceRevision", "artifactSha256", "modelId", "endpointName", "runtimeVersion", "spanId", "recordedAt", "observedAt"]
    : ["bucket", "prefix", "key", "manifestKey", "baselineKey", "queryResultsKey", "schemaVersion", "runId", "alarmArn", "transitionAt", "versionId", "etag", "sourceCount", "coveredFrom", "coveredThrough", "configurationObservedAt", "capturedAt", "observedAt", "completeness", "sources", "gaps", "coverage"];
  const result: Record<string, JsonValue> = {};
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) continue;
    const safe = jsonValue(value[key]);
    if (safe !== undefined) result[key] = safe;
  }
  return result;
}

function strings(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== "string" || item.length > 2048)) {
    throw new InvestigationReadError("An investigation report contains invalid evidence notes.");
  }
  return value.map((item) => item as string);
}

function citation(value: unknown): InvestigationCitation {
  if (!isRecord(value)) throw new InvestigationReadError("An investigation report contains invalid source evidence.");
  return {
    source: stringField(value, "source", 160),
    resource: stringField(value, "resource", 512),
    windowStart: timestamp(stringField(value, "windowStart", 64)),
    windowEnd: timestamp(stringField(value, "windowEnd", 64)),
    observedAt: timestamp(stringField(value, "observedAt", 64)),
    finding: stringField(value, "finding", 4096),
  };
}

function canonicalRecommendation(value: Record<string, unknown>): InvestigationRecommendation {
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "action,target,unit,value") {
    throw new InvestigationReadError("A schema 2 investigation recommendation has an invalid shape.");
  }
  const action = value.action;
  if (action !== "Increase reserved concurrency" && action !== "Increase memory" &&
      action !== "Restore inventory access" && action !== "Other") {
    throw new InvestigationReadError("A schema 2 investigation recommendation has an invalid action.");
  }
  const target = value.target;
  const recommendedValue = value.value;
  const unit = value.unit;
  if (action === "Increase memory") {
    if ((target !== "checkout" && target !== "inventory") || typeof recommendedValue !== "number" ||
        !Number.isSafeInteger(recommendedValue) || recommendedValue < 128 || recommendedValue > 10_240 || unit !== "MB") {
      throw new InvestigationReadError("A schema 2 memory recommendation has invalid target, value, or unit.");
    }
  } else if (action === "Increase reserved concurrency") {
    if ((target !== "checkout" && target !== "inventory") || typeof recommendedValue !== "number" ||
        !Number.isSafeInteger(recommendedValue) || recommendedValue <= 0 || unit !== "executions") {
      throw new InvestigationReadError("A schema 2 concurrency recommendation has invalid target, value, or unit.");
    }
  } else if (action === "Restore inventory access") {
    if (target !== "inventory" || typeof recommendedValue !== "string" || !/^[1-9][0-9]*$/.test(recommendedValue) || unit !== "version") {
      throw new InvestigationReadError("A schema 2 restoration recommendation has invalid target, value, or unit.");
    }
  } else if (target !== null || typeof recommendedValue !== "string" || !recommendedValue.trim() || unit !== null) {
    throw new InvestigationReadError("A schema 2 Other recommendation has invalid target, value, or unit.");
  }
  return { action, target, value: recommendedValue, unit };
}

function legacyRecommendation(value: Record<string, unknown>): InvestigationRecommendation {
  const recommendation: InvestigationRecommendation = {
    action: stringField(value, "action", 160),
  };
  const target = value.target;
  if (target === null || typeof target === "string") recommendation.target = target;
  else if (target !== undefined) throw new InvestigationReadError("An investigation report has an invalid target.");
  const recommendedValue = value.value;
  if (recommendedValue === null || typeof recommendedValue === "string" || typeof recommendedValue === "number") {
    recommendation.value = recommendedValue;
  } else if (recommendedValue !== undefined) throw new InvestigationReadError("An investigation report has an invalid recommendation value.");
  const unit = value.unit;
  if (unit === null || typeof unit === "string") recommendation.unit = unit;
  else if (unit !== undefined) throw new InvestigationReadError("An investigation report has an invalid recommendation unit.");
  if (typeof value.explanation === "string") recommendation.explanation = value.explanation;
  if (typeof value.policy === "string") recommendation.policy = value.policy;
  if (typeof value.policyDetail === "string") recommendation.policyDetail = value.policyDetail;
  return recommendation;
}

function report(value: unknown, schemaVersion?: number): InvestigationReport | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || typeof value.assessment !== "string" ||
      !["ongoing", "recovered", "unknown"].includes(value.assessment)) {
    throw new InvestigationReadError("An investigation record contains an invalid report.");
  }
  const rawRecommendation = value.recommendation;
  if (!isRecord(rawRecommendation)) throw new InvestigationReadError("An investigation report has no recommendation.");
  const recommendation = schemaVersion === 2
    ? canonicalRecommendation(rawRecommendation)
    : legacyRecommendation(rawRecommendation);
  if (!Array.isArray(value.evidence) || value.evidence.length === 0 || value.evidence.length > 64) {
    throw new InvestigationReadError("An investigation report has no bounded source citations.");
  }
  return {
    assessment: value.assessment as InvestigationReport["assessment"],
    summary: stringField(value, "summary", 4096),
    recommendation,
    evidence: value.evidence.map(citation),
    uncertainties: strings(value.uncertainties, 64),
    alternatives: strings(value.alternatives, 64),
  };
}

function failure(value: unknown): InvestigationFailure | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new InvestigationReadError("An investigation record contains an invalid failure.");
  const code = optionalString(value, "code") ?? optionalString(value, "type");
  if (!code) throw new InvestigationReadError("An investigation record contains an invalid failure.");
  return { code, message: stringField(value, "message", 2048) };
}

function run(value: unknown, alarmArn: string, transitionAt?: string): InvestigationRun {
  if (!isRecord(value)) throw new InvestigationReadError("An investigation record has an invalid shape.");
  const itemAlarmArn = stringField(value, "alarmArn", 512);
  const itemTransitionAt = timestamp(stringField(value, "transitionAt", 64));
  const normalized = normalizeTransitionAt(itemTransitionAt);
  if (itemAlarmArn !== alarmArn || !normalized || (transitionAt && normalized !== transitionAt)) {
    throw new InvestigationReadError("The investigation store returned a record outside the requested alarm event.");
  }
  let status = stringField(value, "status", 32) as InvestigationStatus;
  if (!["running", "complete", "failed"].includes(status)) throw new InvestigationReadError("An investigation record has an invalid status.");
  const startedAt = timestamp(stringField(value, "startedAt", 64));
  const deadlineAt = timestamp(stringField(value, "deadlineAt", 64));
  const finishedAtValue = optionalString(value, "finishedAt", 64);
  const artifactSha256 = optionalString(value, "artifactSha256", 64);
  if (artifactSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(artifactSha256)) {
    throw new InvestigationReadError("An investigation record contains an invalid artifact digest.");
  }
  const reportSchemaVersion = value.reportSchemaVersion;
  if (reportSchemaVersion !== undefined &&
      (typeof reportSchemaVersion !== "number" || !Number.isSafeInteger(reportSchemaVersion) || reportSchemaVersion !== 2)) {
    throw new InvestigationReadError("An investigation record contains an invalid report schema version.");
  }
  const failureValue = failure(value.failure);
  let reportValue: InvestigationReport | undefined;
  let reportRejected = false;
  if (status === "complete" && value.report !== undefined && value.report !== null && !failureValue) {
    try {
      reportValue = report(value.report, reportSchemaVersion);
    } catch (error) {
      if (!(error instanceof InvestigationReadError)) throw error;
      status = "failed";
      reportRejected = true;
    }
  } else {
    reportValue = report(value.report, reportSchemaVersion);
  }
  const traceRef = reference(value.traceRef, "trace");
  const captureRef = reference(value.captureRef, "capture");
  if (status === "complete" && (!reportValue || failureValue)) throw new InvestigationReadError("A completed investigation has an invalid terminal result.");
  if (status === "failed" && !failureValue && !reportRejected) throw new InvestigationReadError("A failed investigation has no failure result.");
  if (status === "running" && (reportValue || failureValue)) throw new InvestigationReadError("A running investigation has an unexpected terminal result.");
  const reportedFailure = failureValue ?? (reportRejected ? {
    code: "INVALID_REPORT",
    message: "The Runtime completed, but the saved investigation report failed validation.",
  } : undefined);
  return {
    alarmArn: itemAlarmArn,
    transitionAt: normalized,
    runId: stringField(value, "runId", 256),
    runtimeSessionId: stringField(value, "runtimeSessionId", 256),
    candidateId: stringField(value, "candidateId", 256),
    sourceRevision: stringField(value, "sourceRevision", 256),
    ...(artifactSha256 !== undefined ? { artifactSha256 } : {}),
    promptSha256: stringField(value, "promptSha256", 128),
    modelId: stringField(value, "modelId", 256),
    runtimeArn: stringField(value, "runtimeArn", 1024),
    runtimeVersion: stringField(value, "runtimeVersion", 8),
    endpointName: stringField(value, "endpointName", 128),
    status,
    startedAt,
    deadlineAt,
    ...(finishedAtValue ? { finishedAt: timestamp(finishedAtValue) } : {}),
    ...(reportSchemaVersion !== undefined ? { reportSchemaVersion: reportSchemaVersion as 2 } : {}),
    ...(reportValue ? { report: reportValue } : {}),
    ...(reportedFailure ? { failure: reportedFailure } : {}),
    ...(traceRef ? { traceRef } : {}),
    ...(captureRef ? { captureRef } : {}),
  };
}

function runTableKey(alarmArn: string, transitionAt: string): Record<string, AttributeValue> {
  return { pk: { S: alarmArn }, sk: { S: transitionAt } };
}

export function parseInvestigationQuery(rawQueryString = "", queryStringParameters?: Record<string, string | undefined>): { alarmArn?: string; transitionAt?: string } {
  let alarmValues: string[] = [];
  let transitionValues: string[] = [];
  if (rawQueryString) {
    const query = new URLSearchParams(rawQueryString);
    for (const key of query.keys()) {
      if (key !== "alarmArn" && key !== "transitionAt") throw new InvestigationQueryError("INVALID_QUERY", "Only alarmArn and transitionAt are supported.");
    }
    alarmValues = query.getAll("alarmArn");
    transitionValues = query.getAll("transitionAt");
  } else if (queryStringParameters) {
    for (const key of Object.keys(queryStringParameters)) {
      if (key !== "alarmArn" && key !== "transitionAt") throw new InvestigationQueryError("INVALID_QUERY", "Only alarmArn and transitionAt are supported.");
    }
    if (queryStringParameters.alarmArn !== undefined) alarmValues = [queryStringParameters.alarmArn];
    if (queryStringParameters.transitionAt !== undefined) transitionValues = [queryStringParameters.transitionAt];
  }
  if (alarmValues.length > 1 || transitionValues.length > 1) {
    throw new InvestigationQueryError("INVALID_QUERY", "Specify each investigation selector at most once.");
  }
  return {
    ...(alarmValues.length ? { alarmArn: alarmValues[0] } : {}),
    ...(transitionValues.length ? { transitionAt: transitionValues[0] } : {}),
  };
}

/** Read one allowlisted alarm partition using a strong exact read or newest-first bounded query. */
export async function readInvestigations(query: { alarmArn?: string; transitionAt?: string } = {}): Promise<InvestigationResponse> {
  const configuredAlarms = allowedAlarms();
  const alarmArn = query.alarmArn ?? configuredAlarms[0];
  if (!configuredAlarms.includes(alarmArn)) {
    throw new InvestigationQueryError("ALARM_NOT_ALLOWED", "The requested alarm is not configured for this controller.");
  }
  const transitionAt = query.transitionAt === undefined ? undefined : normalizeTransitionAt(query.transitionAt);
  if (query.transitionAt !== undefined && !transitionAt) {
    throw new InvestigationQueryError("INVALID_TRANSITION", "transitionAt must be an ISO-8601 timestamp.");
  }
  const table = tableName();
  const common = {
    TableName: table,
    ProjectionExpression: projection,
    ExpressionAttributeNames: projectionNames,
    ConsistentRead: true,
  };
  try {
    let items: Record<string, AttributeValue>[];
    if (transitionAt) {
      const response = await dynamo.send(new GetItemCommand({
        ...common,
        Key: runTableKey(alarmArn, transitionAt),
      }), { abortSignal: AbortSignal.timeout(3_000) });
      items = response.Item ? [response.Item] : [];
    } else {
      const response = await dynamo.send(new QueryCommand({
        ...common,
        KeyConditionExpression: "#pk = :alarmArn",
        ExpressionAttributeNames: { ...projectionNames, "#pk": "pk" },
        ExpressionAttributeValues: { ":alarmArn": { S: alarmArn } },
        Limit: recentLimit,
        ScanIndexForward: false,
      }), { abortSignal: AbortSignal.timeout(3_000) });
      items = response.Items ?? [];
    }
    const runs = items.slice(0, recentLimit).map((item) => run(unmarshall(item), alarmArn, transitionAt));
    runs.sort((left, right) => right.transitionAt.localeCompare(left.transitionAt));
    return { observedAt: new Date().toISOString(), runs };
  } catch (error) {
    if (error instanceof InvestigationReadError) throw error;
    throw new InvestigationReadError();
  }
}
