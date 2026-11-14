import {
  CloudWatchClient,
  GetMetricDataCommand,
  type MetricDataQuery,
  type MetricDataResult,
} from "@aws-sdk/client-cloudwatch";
import type { Action } from "./types.js";

export type TrafficMetricResource = "Inventory" | "Checkout" | "Gateway" | "Account";
export type TrafficMetricNamespace = "AWS/Lambda" | "AWS/ApiGateway";
export type TrafficMetricStatistic = "Sum" | "Maximum";
export type TrafficMetricsStatus = "available" | "pending" | "partial";
export type TrafficMetricStatusCode =
  | "Complete"
  | "PartialData"
  | "InternalError"
  | "Forbidden"
  | "Missing"
  | "Unknown";

export interface TrafficMetric {
  resource: TrafficMetricResource;
  name: string;
  namespace: TrafficMetricNamespace;
  dimensions: Record<string, string>;
  statistic: TrafficMetricStatistic;
  periodSeconds: 60;
  timestamps: string[];
  values: number[];
  statusCode: TrafficMetricStatusCode;
}

export interface TrafficMetricsResponse {
  actionId: string;
  observedAt: string;
  window: { start: string; end: string } | null;
  periodSeconds: 60;
  status: TrafficMetricsStatus;
  metrics: TrafficMetric[];
}

export class MetricsReadError extends Error {
  readonly code = "METRICS_UNAVAILABLE";

  constructor(message = "Native traffic metrics are temporarily unavailable") {
    super(message);
    this.name = "MetricsReadError";
  }
}

const cloudWatch = new CloudWatchClient({ maxAttempts: 1 });
const periodSeconds = 60 as const;
const minuteMs = periodSeconds * 1_000;
const maximumWindowMs = 180_000;
const metricDeadline = () => ({ abortSignal: AbortSignal.timeout(2_000) });

interface MetricDescriptor {
  id: string;
  resource: TrafficMetricResource;
  name: string;
  namespace: TrafficMetricNamespace;
  dimensions: Record<string, string>;
  statistic: TrafficMetricStatistic;
}

interface QueryDescriptor extends MetricDescriptor {
  query: MetricDataQuery;
}

function descriptors(apiId: string): MetricDescriptor[] {
  const result: MetricDescriptor[] = [];
  for (const [resource, functionName] of [
    ["Inventory", "IncidentTriageDemoInventory"],
    ["Checkout", "IncidentTriageDemoCheckout"],
  ] as const) {
    for (const name of ["Invocations", "Errors", "Throttles", "ConcurrentExecutions"] as const) {
      const statistic: TrafficMetricStatistic = name === "ConcurrentExecutions" ? "Maximum" : "Sum";
      result.push({
        id: `${resource.toLowerCase()}_${name.toLowerCase()}`,
        resource,
        name,
        namespace: "AWS/Lambda",
        dimensions: { FunctionName: functionName },
        statistic,
      });
    }
  }
  for (const name of ["Count", "4xx", "5xx"] as const) {
    result.push({
      id: `gateway_${name.toLowerCase()}`,
      resource: "Gateway",
      name,
      namespace: "AWS/ApiGateway",
      dimensions: { ApiId: apiId, Stage: "$default" },
      statistic: "Sum",
    });
  }
  result.push({
    id: "account_concurrent_executions",
    resource: "Account",
    name: "ConcurrentExecutions",
    namespace: "AWS/Lambda",
    dimensions: {},
    statistic: "Maximum",
  });
  return result;
}

function queryFor(descriptor: MetricDescriptor): QueryDescriptor {
  const dimensions = Object.entries(descriptor.dimensions).map(([Name, Value]) => ({ Name, Value }));
  return {
    ...descriptor,
    query: {
      Id: descriptor.id,
      MetricStat: {
        Metric: {
          Namespace: descriptor.namespace,
          MetricName: descriptor.name,
          Dimensions: dimensions,
        },
        Period: periodSeconds,
        Stat: descriptor.statistic,
      },
      ReturnData: true,
    },
  };
}

function timestampMillis(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function savedTimestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const millis = timestampMillis(value);
  if (millis === undefined) throw new MetricsReadError();
  return millis;
}

function asIso(millis: number): string {
  return new Date(millis).toISOString();
}

interface DerivedWindow {
  startMillis: number;
  endMillis: number;
}

function deriveWindow(action: Action, now: number): DerivedWindow | undefined {
  const isSurge = (action.command.kind === "traffic" && action.command.profile === "inventory_surge") ||
    action.trafficProfile?.name === "inventory_surge" || action.trafficWindow !== undefined;

  // The action's worker claim time is not the surge's actual producer start.
  const rawStart = isSurge
    ? savedTimestamp(action.trafficWindow?.startedAt)
    : savedTimestamp(action.startedAt);
  if (rawStart === undefined) return undefined;

  const rawEnd = isSurge
    ? savedTimestamp(action.trafficWindow?.settledAt)
    : savedTimestamp(action.finishedAt);
  let observedEnd = rawEnd;
  if (observedEnd === undefined) {
    if (action.status !== "running" && action.status !== "draining") {
      throw new MetricsReadError();
    }
    const roundedStart = Math.floor(rawStart / minuteMs) * minuteMs;
    // Keep an in-flight observation inside the finite producer/drain allowance.
    observedEnd = Math.min(now, rawStart + maximumWindowMs, roundedStart + maximumWindowMs);
  }
  if (observedEnd < rawStart) throw new MetricsReadError();

  const startMillis = Math.floor(rawStart / minuteMs) * minuteMs;
  let endMillis = Math.ceil(observedEnd / minuteMs) * minuteMs;
  if (endMillis <= startMillis) endMillis = startMillis + minuteMs;
  if (observedEnd - rawStart > maximumWindowMs || endMillis - startMillis > maximumWindowMs) {
    throw new MetricsReadError();
  }
  return { startMillis, endMillis };
}

function validApiId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9]{10}$/.test(value);
}

function statusCode(value: MetricDataResult["StatusCode"] | undefined): TrafficMetricStatusCode {
  if (value === "Complete" || value === "PartialData" || value === "InternalError" || value === "Forbidden") {
    return value;
  }
  return "Unknown";
}

function projectPoints(result: MetricDataResult | undefined): {
  timestamps: string[];
  values: number[];
} {
  if (!result) return { timestamps: [], values: [] };
  const timestamps = result.Timestamps ?? [];
  const values = result.Values ?? [];
  if (timestamps.length !== values.length) throw new MetricsReadError();

  const points = timestamps.map((timestamp, index) => {
    const millis = timestamp instanceof Date ? timestamp.getTime() : timestampMillis(timestamp);
    const value = values[index];
    if (!Number.isFinite(millis) || typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new MetricsReadError();
    }
    return { millis: millis as number, value };
  }).sort((left, right) => left.millis - right.millis);

  return {
    timestamps: points.map((point) => asIso(point.millis)),
    values: points.map((point) => point.value),
  };
}

function toMetric(descriptor: QueryDescriptor, result: MetricDataResult | undefined): TrafficMetric {
  const points = projectPoints(result);
  return {
    resource: descriptor.resource,
    name: descriptor.name,
    namespace: descriptor.namespace,
    dimensions: { ...descriptor.dimensions },
    statistic: descriptor.statistic,
    periodSeconds,
    ...points,
    statusCode: result ? statusCode(result.StatusCode) : "Missing",
  };
}

/** Read only the fixed native traffic metrics for one persisted controller traffic action. */
export async function readTrafficMetrics(action: Action): Promise<TrafficMetricsResponse> {
  const observedAtMillis = Date.now();
  const observedAt = asIso(observedAtMillis);
  if (action.kind !== "traffic") throw new MetricsReadError("Traffic metrics are unavailable for this action");
  if (action.status === "queued") {
    return {
      actionId: action.id,
      observedAt,
      window: null,
      periodSeconds,
      status: "pending",
      metrics: [],
    };
  }

  const window = deriveWindow(action, observedAtMillis);
  if (!window) {
    return {
      actionId: action.id,
      observedAt,
      window: null,
      periodSeconds,
      status: "pending",
      metrics: [],
    };
  }

  if (!validApiId(action.trafficApiId)) throw new MetricsReadError();

  const queryDescriptors = descriptors(action.trafficApiId).map(queryFor);
  let response;
  try {
    response = await cloudWatch.send(new GetMetricDataCommand({
      StartTime: new Date(window.startMillis),
      EndTime: new Date(window.endMillis),
      MetricDataQueries: queryDescriptors.map(({ query }) => query),
    }), metricDeadline());
  } catch {
    throw new MetricsReadError();
  }

  const expectedIds = new Set(queryDescriptors.map(({ id }) => id));
  const byId = new Map<string, MetricDataResult>();
  for (const result of response.MetricDataResults ?? []) {
    if (!result.Id || !expectedIds.has(result.Id)) continue;
    if (byId.has(result.Id)) throw new MetricsReadError();
    // Do not present a failed provider series alongside usable values as if the set were complete.
    if (result.StatusCode === "InternalError" || result.StatusCode === "Forbidden") {
      throw new MetricsReadError();
    }
    byId.set(result.Id, result);
  }

  const metrics = queryDescriptors.map((descriptor) => toMetric(descriptor, byId.get(descriptor.id)));
  const hasSamples = metrics.some((metric) => metric.values.length > 0);
  const isPartial = Boolean(response.NextToken) || metrics.some((metric) => metric.statusCode !== "Complete");
  const status: TrafficMetricsStatus = isPartial ? "partial" : hasSamples ? "available" : "pending";

  return {
    actionId: action.id,
    observedAt,
    window: { start: asIso(window.startMillis), end: asIso(window.endMillis) },
    periodSeconds,
    status,
    metrics,
  };
}
