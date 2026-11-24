import { useCallback, useEffect, useRef, useState } from "react";
import type { Action, TrafficContext, TrafficProfileSnapshot } from "./types";
import type { TrafficMetricsResponse } from "./metrics";
import "./surge.css";
import { uiText } from "./ui-text";

interface TrafficSurgePanelProps {
  bearer: string;
  currentAction?: Action;
  latestSurgeActionId?: string;
  disabled: boolean;
  disabledReason?: string;
  onStart: () => void;
  onRepeat: () => void;
}

interface Observation<T> {
  value?: T;
  loading: boolean;
  failedAt?: string;
  error?: string;
}

type ObservationMap<T> = Record<string, Observation<T>>;

const ACTIVE_ACTIONS = new Set(["queued", "running", "draining"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAction(value: unknown): value is Action {
  return isRecord(value) && typeof value.id === "string" && typeof value.kind === "string" &&
    typeof value.status === "string" && isRecord(value.command) && Array.isArray(value.requests);
}

function isTrafficMetricsResponse(value: unknown): value is TrafficMetricsResponse {
  return isRecord(value) && typeof value.actionId === "string" && typeof value.observedAt === "string" &&
    (value.status === "available" || value.status === "pending" || value.status === "partial") &&
    (value.window === null || (isRecord(value.window) && typeof value.window.start === "string" && typeof value.window.end === "string")) &&
    value.periodSeconds === 60 && Array.isArray(value.metrics) && value.metrics.every((metric) => isRecord(metric) &&
      typeof metric.resource === "string" && typeof metric.name === "string" && typeof metric.namespace === "string" &&
      isRecord(metric.dimensions) && typeof metric.statistic === "string" && metric.periodSeconds === 60 &&
      Array.isArray(metric.timestamps) && metric.timestamps.every((timestamp) => typeof timestamp === "string") &&
      Array.isArray(metric.values) && metric.values.every((sample) => typeof sample === "number" && Number.isFinite(sample)) &&
      typeof metric.statusCode === "string");
}

function timeLabel(value: string | undefined): string {
  if (!value) return "Not observed";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}

function countLabel(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "Not observed";
}

function durationLabel(milliseconds: number | undefined): string {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return "Not observed";
  return `${(milliseconds / 1_000).toFixed(1)} s`;
}

function statusLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " ");
}

function requestOutcomeLabel(value: string | undefined): string {
  if (value === "not_sent") return "Not sent: admission closed";
  return value ? statusLabel(value) : "Outcome pending";
}

function catalogProfileLabel(profile: TrafficProfileSnapshot): string {
  if (profile.version === 1) return `Catalog ${profile.catalog.ratePerSecond}/s, max ${profile.catalog.maxAttempts.toLocaleString()}`;
  return `${profile.catalog.batchSize} catalog GETs every ${profile.catalog.batchIntervalMs} ms, ${profile.catalog.ratePerSecond}/s average, max ${profile.catalog.maxAttempts.toLocaleString()}`;
}

function admissionLatenessLabel(profile: TrafficProfileSnapshot): string {
  if (profile.version === 3) return "150 ms late admission allowance";
  if (profile.version === 4) return `${profile.admissionLatenessMs} ms late admission allowance`;
  return "";
}

function profileLabel(profile: TrafficProfileSnapshot | undefined): string {
  if (!profile) return "Profile not recorded";
  const admission = admissionLatenessLabel(profile);
  return [
    `${profile.durationMs / 1_000} second run`,
    catalogProfileLabel(profile),
    admission,
    `checkout every ${profile.checkout.intervalMs / 1_000} s, max ${profile.checkout.maxAttempts}`,
  ].filter(Boolean).join(" | ");
}

function isCurrentInventorySurgeProfile(profile: TrafficProfileSnapshot | undefined): boolean {
  return profile?.version === 4 && profile.name === "inventory_surge" && profile.durationMs === 15_000 && profile.admissionLatenessMs === 300 &&
    profile.catalog.ratePerSecond === 30 && profile.catalog.batchSize === 30 && profile.catalog.batchIntervalMs === 1_000 &&
    profile.catalog.maxAttempts === 450 && profile.catalog.maxInFlight === 30 && profile.catalog.requestTimeoutMs === 7_000 &&
    profile.checkout.intervalMs === 1_000 && profile.checkout.maxAttempts === 15 && profile.checkout.maxInFlight === 1 &&
    profile.checkout.requestTimeoutMs === 7_000;
}

function actionProductionDuration(action: Action | undefined): number | undefined {
  const window = action?.trafficWindow;
  if (!window) return undefined;
  const started = Date.parse(window.startedAt);
  const recordedEnd = window.producerStoppedAt ?? window.settledAt ?? action?.finishedAt;
  const ended = recordedEnd ? Date.parse(recordedEnd)
    : action && ACTIVE_ACTIONS.has(action.status) ? Date.now()
      : Date.parse(window.scheduledEndAt);
  return Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? ended - started : undefined;
}

function catalogStartsLabel(action: Action): string {
  const observation = action.catalogObservation;
  if (!observation) return "Not observed";
  const starts = countLabel(action.traffic?.catalog?.submitted);
  if (observation.status === "complete") return `${starts} final starts`;
  return `${starts} starts through ${timeLabel(observation.observedThrough)}`;
}

function catalogOutcomeTotalLabel(action: Action): string {
  const observation = action.catalogObservation;
  if (!observation) return "Not observed";
  const successes = countLabel(observation.outcomes.success);
  return observation.status === "complete" ? `${successes} final successes` : `${successes} successes through ${timeLabel(observation.observedThrough)}`;
}

function catalogSnapshotLabel(action: Action): string {
  const observation = action.catalogObservation;
  if (!observation) return "No snapshot";
  return observation.status === "complete" ? "Final snapshot" : "Partial snapshot";
}

function catalogInFlightLabel(action: Action): string {
  const observation = action.catalogObservation;
  if (!observation) return "Not observed";
  const inFlight = countLabel(action.traffic?.catalog?.inFlight);
  return observation.status === "complete" ? `${inFlight} at drain` : `${inFlight} at snapshot`;
}

function metricsSummary(response: TrafficMetricsResponse | undefined): string {
  if (!response) return "Not loaded";
  if (response.status === "pending") return "Pending";
  return response.status === "partial" ? "Partial data" : "Available";
}

function readAction(value: unknown): Action {
  if (!isRecord(value) || !isAction(value.action)) throw new Error("The controller returned an invalid action record");
  return value.action;
}

function readMetrics(value: unknown, expectedId: string): TrafficMetricsResponse {
  if (!isTrafficMetricsResponse(value) || value.actionId !== expectedId) {
    throw new Error("The controller returned an invalid native metric observation");
  }
  return value;
}

async function responseJson(response: Response): Promise<unknown> {
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new Error("The controller returned an unreadable response"); }
  if (!response.ok) {
    const message = isRecord(body) && typeof body.message === "string" ? body.message : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

function sameProfile(left: TrafficProfileSnapshot | undefined, right: TrafficProfileSnapshot | undefined): boolean | undefined {
  if (!left || !right) return undefined;
  const sharedFieldsMatch = left.name === right.name && left.version === right.version && left.durationMs === right.durationMs &&
    left.catalog.ratePerSecond === right.catalog.ratePerSecond && left.catalog.maxAttempts === right.catalog.maxAttempts &&
    left.catalog.maxInFlight === right.catalog.maxInFlight && left.catalog.requestTimeoutMs === right.catalog.requestTimeoutMs &&
    left.checkout.intervalMs === right.checkout.intervalMs && left.checkout.maxAttempts === right.checkout.maxAttempts &&
    left.checkout.maxInFlight === right.checkout.maxInFlight && left.checkout.requestTimeoutMs === right.checkout.requestTimeoutMs;
  if (!sharedFieldsMatch) return false;
  if (left.version === 1 || right.version === 1) return left.version === 1 && right.version === 1;
  if (left.version !== right.version || left.catalog.batchSize !== right.catalog.batchSize ||
      left.catalog.batchIntervalMs !== right.catalog.batchIntervalMs) return false;
  if (left.version === 4 && right.version === 4) return left.admissionLatenessMs === 300 && right.admissionLatenessMs === 300;
  return true;
}

function contextMatchesExceptInventoryCap(previous: TrafficContext | undefined, current: TrafficContext | undefined): boolean | undefined {
  if (!previous || !current) return undefined;
  return previous.inventory.cap === 16 && current.inventory.cap === 32 &&
    previous.appRevision === current.appRevision && previous.productVersion === current.productVersion &&
    previous.inventory.aliasVersion === current.inventory.aliasVersion && previous.inventory.access === current.inventory.access &&
    previous.inventory.memoryMb === current.inventory.memoryMb && previous.checkout.cap === current.checkout.cap &&
    previous.checkout.aliasVersion === current.checkout.aliasVersion && previous.checkout.memoryMb === current.checkout.memoryMb;
}

interface ComparisonCheck {
  headline: string;
  checks: string[];
  ready: boolean;
}

function comparisonCheck(previous: Action | undefined, current: Action | undefined): ComparisonCheck {
  if (!previous || !current) return { headline: "Waiting for both saved runs", checks: [], ready: false };
  const profile = sameProfile(previous.trafficProfile, current.trafficProfile);
  const context = contextMatchesExceptInventoryCap(previous.trafficContext, current.trafficContext);
  const previousDuration = actionProductionDuration(previous);
  const currentDuration = actionProductionDuration(current);
  const previousStarts = previous.catalogObservation ? previous.traffic?.catalog?.submitted : undefined;
  const currentStarts = current.catalogObservation ? current.traffic?.catalog?.submitted : undefined;
  const actualDemand = previousStarts === undefined || currentStarts === undefined ? undefined : currentStarts >= previousStarts;
  const completeCatalogPair = previous.catalogObservation?.status === "complete" && current.catalogObservation?.status === "complete";
  const sameDuration = previousDuration !== undefined && currentDuration !== undefined && previousDuration === currentDuration;
  const hasSettledDrain = (action: Action) => (action.status === "completed" || action.status === "stopped") &&
    action.catalogObservation?.status === "complete" && Boolean(action.trafficWindow?.producerStoppedAt && action.trafficWindow.settledAt);
  const settledPair = hasSettledDrain(previous) && hasSettledDrain(current);
  const previousBins = previous.catalogObservation?.bins;
  const currentBins = current.catalogObservation?.bins;
  const cohortComparison = previousBins?.length === 15 && currentBins?.length === 15
    ? `${currentBins.filter((bin, index) => bin.submitted >= previousBins[index].submitted).length} of 15 one second cohorts meet or exceed prior starts`
    : "One second cohort comparison unavailable";
  const startsComparison = actualDemand === undefined ? "Catalog start totals unavailable"
    : !completeCatalogPair ? `Checkpoint starts ${actualDemand ? "meet or exceed" : "are below"} prior starts. Final demand is unknown`
      : actualDemand ? "Final catalog starts meet or exceed prior starts" : "Final catalog starts are below prior starts";
  const checks = [
    profile === undefined ? "Profile identity unavailable" : profile ? "Profile matches" : "Profile differs",
    context === undefined ? "Resolved context unavailable" : context ? "Only Inventory capacity changed from 16 to 32" : "Resolved context differs from the 16 to 32 pair",
    sameDuration ? `Production duration matches at ${durationLabel(currentDuration)}` : "Production duration differs or is unavailable",
    startsComparison,
    cohortComparison,
    settledPair ? "Both runs have complete snapshots and settled drains" : "Complete snapshots and settled drains are not confirmed for both runs",
  ];
  const ready = profile === true && context === true && sameDuration && actualDemand === true && completeCatalogPair && settledPair;
  return {
    headline: ready ? "Same profile pair is ready to compare" : profile === true && context === true ? "Pair recorded with evidence still pending" : "Comparison needs review",
    checks,
    ready,
  };
}

function metricSeries(response: TrafficMetricsResponse | undefined, resource: string, name: string) {
  return response?.metrics.find((metric) => metric.resource === resource && metric.name === name);
}

function nativeMetricValue(observation: Observation<TrafficMetricsResponse> | undefined, resource: string, name: string): string {
  const response = observation?.value;
  if (!response) return observation?.loading ? "Loading" : "Not available";
  if (response.status === "pending") return "Pending";
  const metric = metricSeries(response, resource, name);
  if (!metric || metric.values.length === 0) return "No data";
  const value = metric.statistic === "Maximum" ? Math.max(...metric.values) : metric.values.reduce((total, sample) => total + sample, 0);
  return `${countLabel(value)}${metric.statusCode === "Complete" ? "" : " (partial)"}`;
}

function NativeMetrics({ action, observation, onRefresh }: { action: Action; observation?: Observation<TrafficMetricsResponse>; onRefresh: () => void }) {
  const response = observation?.value;
  const resources = ["Inventory", "Checkout", "Gateway", "Account"] as const;
  return <details className="surge-disclosure surge-native-metrics">
    <summary>
      <span>Native CloudWatch metrics</span>
      <span className="surge-summary-status" role="status">{observation?.error && response ? "Last good data" : observation?.error ? "Unavailable" : metricsSummary(response)}</span>
    </summary>
    <div className="surge-disclosure-body">
      <div className="surge-inline-controls">
        <span className="surge-muted">Fixed 60 second periods</span>
        <button className="surge-refresh-button" type="button" onClick={onRefresh} disabled={observation?.loading}>
          {observation?.loading ? "Refreshing" : "Refresh metrics"}
        </button>
      </div>
      {observation?.error && !response && <p className="surge-state surge-state-error" role="status">{observation.error}</p>}
      {observation?.error && response && <p className="surge-state surge-state-warning" role="status">Last good snapshot from {timeLabel(response.observedAt)}. Refresh failed: {observation.error}</p>}
      {!response && !observation?.error && ACTIVE_ACTIONS.has(action.status) && <p className="surge-muted">Metrics wait for an actual producer start.</p>}
      {response?.window && <p className="surge-muted">Window {timeLabel(response.window.start)} to {timeLabel(response.window.end)}. Observed {timeLabel(response.observedAt)}.</p>}
      {response?.status === "pending" && <p className="surge-muted">No settled metric window yet. Pending is not zero.</p>}
      {response && response.status !== "pending" && <div className="native-metric-grid">
        {resources.map((resource) => {
          const metrics = response.metrics.filter((metric) => metric.resource === resource);
          return <article className="native-metric-card" key={resource}>
            <h6>{resource}</h6>
            {metrics.length ? <ul>{metrics.map((metric, index) => {
              const points = metric.values.map((sample, pointIndex) => `${timeLabel(metric.timestamps[pointIndex])}: ${sample}`).join(", ");
              const dimensions = Object.entries(metric.dimensions).map(([name, value]) => `${name}=${value}`).join(", ");
              return <li key={`${metric.name}-${index}`}>
                <strong>{metric.name} | {metric.statistic}</strong>
                <span>{points || "No datapoints observed"}</span>
                <small>{metric.statusCode} | {metric.namespace}{dimensions ? ` | ${dimensions}` : " | account scope"}</small>
              </li>;
            })}</ul> : <p className="surge-muted">No series returned.</p>}
          </article>;
        })}
      </div>}
      {observation?.failedAt && <p className="surge-muted">Last failed refresh {timeLabel(observation.failedAt)}.</p>}
    </div>
  </details>;
}

function CatalogCohorts({ action }: { action: Action }) {
  const observation = action.catalogObservation;
  return <details className="surge-disclosure">
    <summary>
      <span>Catalog snapshot</span>
      <span className="surge-summary-status">{catalogSnapshotLabel(action)}</span>
    </summary>
    <div className="surge-disclosure-body">
      {!observation ? <p className="surge-muted">No catalog snapshot is recorded.</p> : <>
        <p className="surge-muted">Observed through {timeLabel(observation.observedThrough)}. Future intervals are not measured as zero.</p>
        <dl className="surge-outcome-grid">
          {(["success", "http4xx", "http5xx", "invalidResponse", "noResponse"] as const).map((name) => <div key={name}><dt>{name}</dt><dd>{countLabel(observation.outcomes[name])}</dd></div>)}
          {(["late", "full", "checkpoint"] as const).map((name) => <div key={name}><dt>Skipped {name}</dt><dd>{countLabel(observation.skips[name])}</dd></div>)}
        </dl>
        <div className="surge-table-scroll" role="region" aria-label="Catalog start cohorts" tabIndex={0}>
          <table className="surge-cohort-table"><thead><tr><th>Offset</th><th>Observed</th><th>Started</th><th>Settled</th><th>Success</th><th>Skipped</th><th>Unsuccessful</th></tr></thead>
            <tbody>{observation.bins.map((bin) => {
              const measured = bin.observedDurationMs > 0;
              return <tr key={bin.offsetMs}>
                <th scope="row">{(bin.offsetMs / 1_000).toFixed(0)} s</th>
                <td>{(bin.observedDurationMs / 1_000).toFixed(1)} s</td>
                <td>{measured ? countLabel(bin.submitted) : "Not measured"}</td>
                <td>{measured ? countLabel(bin.completed) : "Not measured"}</td>
                <td>{measured ? countLabel(bin.succeeded) : "Not measured"}</td>
                <td>{measured ? countLabel(bin.skipped) : "Not measured"}</td>
                <td>{measured ? countLabel(bin.outcomes.http4xx + bin.outcomes.http5xx + bin.outcomes.invalidResponse + bin.outcomes.noResponse) : "Not measured"}</td>
              </tr>;
            })}</tbody>
          </table>
        </div>
        <p className="surge-muted">Samples {observation.samples.length} of 24. {observation.samplesTruncated ? "Sample set truncated." : "Sample set retained."}</p>
        {observation.samples.length > 0 && <ul className="surge-sample-list">{observation.samples.map((sample, index) => <li key={`${sample.id}-${index}`}>
          <span>{requestOutcomeLabel(sample.outcome)} | {sample.statusCode === undefined ? "No HTTP status" : `HTTP ${sample.statusCode}`}</span>
          <strong>{sample.durationMs === undefined ? "No duration" : `${sample.durationMs} ms`}</strong>
          <small>{sample.requestId ?? sample.id}{sample.errorCode ? ` | ${sample.errorCode}` : ""}</small>
        </li>)}</ul>}
      </>}
    </div>
  </details>;
}

function TrafficActionObservation({ action, observation, label, onMetricsRefresh }: { action: Action; observation?: Observation<TrafficMetricsResponse>; label: string; onMetricsRefresh: () => void }) {
  const catalog = action.traffic?.catalog;
  const checkout = action.traffic?.checkout;
  const profile = action.trafficProfile;
  const window = action.trafficWindow;
  const productionDuration = actionProductionDuration(action);
  const requested = action.stopRequested === true;
  const closed = Boolean(window?.producerStoppedAt);
  const settled = Boolean(window?.settledAt) && action.status !== "draining" && action.catalogObservation?.status === "complete";
  const admissionState = closed ? `Closed at ${timeLabel(window?.producerStoppedAt)}`
    : requested ? "Awaiting admission closure" : window ? "Open" : "No producer window";
  const drainState = settled ? `Settled at ${timeLabel(window?.settledAt)}`
    : action.status === "incomplete" || action.status === "failed" ? "Incomplete. Final catalog counts are unknown."
      : action.status === "draining" || requested ? `Draining. Catalog ${catalogInFlightLabel(action)}. Checkout ${countLabel(checkout?.inFlight)} in flight.`
        : `Catalog ${catalogInFlightLabel(action)}. Checkout ${countLabel(checkout?.inFlight)} in flight.`;
  const checkoutRequests = action.requests.filter((request) => request.kind === "checkout");
  const warning = ["failed", "incomplete", "stopped", "discarded"].includes(action.status);
  return <article className="surge-action-record">
    <div className="surge-run-heading">
      <div>
        <p className="eyebrow">{label}</p>
        <h4>{statusLabel(action.status)}</h4>
      </div>
      <span className={`incident-badge ${warning ? "badge-warning" : "badge-neutral"}`}>{catalogSnapshotLabel(action)}</span>
    </div>
    <dl className="surge-key-metrics" aria-label={`${label} key metrics`}>
      <div><dt>Catalog started</dt><dd>{countLabel(catalog?.submitted)}</dd></div>
      <div><dt>Catalog succeeded</dt><dd>{countLabel(catalog?.succeeded)}</dd></div>
      <div><dt>Checkout sent</dt><dd>{countLabel(checkout?.submitted)}</dd></div>
      <div><dt>Checkout succeeded</dt><dd>{countLabel(checkout?.succeeded)}</dd></div>
    </dl>
    <div className="surge-run-status-grid">
      <div><span>Admissions</span><strong>{admissionState}</strong></div>
      <div><span>Drain</span><strong>{drainState}</strong></div>
    </div>
    <details className="surge-disclosure">
      <summary>Run details</summary>
      <div className="surge-disclosure-body">
        <dl className="surge-detail-grid">
          <div><dt>Action ID</dt><dd className="mono">{action.id}</dd></div>
          <div><dt>Requested profile</dt><dd>{profileLabel(profile)}</dd></div>
          <div><dt>Profile requested and observed</dt><dd>{profile ? `${catalogProfileLabel(profile)} requested. ${catalogStartsLabel(action)}. In flight ${profile.catalog.maxInFlight} catalog and ${profile.checkout.maxInFlight} checkout. Timeout ${profile.catalog.requestTimeoutMs / 1_000} s.` : "No profile snapshot."}</dd></div>
          <div><dt>Production duration</dt><dd>{window ? `${durationLabel(productionDuration)}. Scheduled ${timeLabel(window.startedAt)} to ${timeLabel(window.scheduledEndAt)}.` : ACTIVE_ACTIONS.has(action.status) ? "Preparing. Producer window not recorded." : "No producer window recorded."}</dd></div>
          <div><dt>Catalog totals</dt><dd>{catalog ? `${catalogStartsLabel(action)}. ${countLabel(catalog.completed)} settled. ${countLabel(catalog.succeeded)} succeeded. ${countLabel(catalog.skipped)} skipped.` : "No saved catalog counters."}</dd></div>
          <div><dt>Checkout totals</dt><dd>{countLabel(checkout?.submitted)} sent. {countLabel(checkout?.completed)} settled. {countLabel(checkout?.succeeded)} succeeded. {countLabel(checkout?.skipped)} skipped. {countLabel(checkout?.inFlight)} in flight.</dd></div>
          <div><dt>Snapshot fidelity</dt><dd>{action.catalogObservation ? `${statusLabel(action.catalogObservation.status)}. ${action.catalogObservation.samples.length} bounded samples. ${action.catalogObservation.samplesTruncated ? "Truncated." : "Retained."}` : "No catalog snapshot."}</dd></div>
          <div><dt>Stop request</dt><dd>{requested ? "Recorded" : window?.stopReason === "duration" ? "Not requested. Planned duration ended." : "Not observed"}{window?.stopObservedAt ? ` at ${timeLabel(window.stopObservedAt)}` : ""}</dd></div>
          <div><dt>Stop reason</dt><dd>{window?.stopReason ?? "Not recorded"}</dd></div>
          <div><dt>Application</dt><dd>{action.trafficContext ? `${action.trafficContext.appRevision} | ${action.trafficContext.productVersion}` : "Awaiting worker preflight"}</dd></div>
          <div><dt>Inventory</dt><dd>{action.trafficContext ? `Capacity ${action.trafficContext.inventory.cap} | alias ${action.trafficContext.inventory.aliasVersion} | ${action.trafficContext.inventory.access} | ${action.trafficContext.inventory.memoryMb} MB` : "Awaiting worker preflight"}</dd></div>
          <div><dt>Checkout</dt><dd>{action.trafficContext ? `Capacity ${action.trafficContext.checkout.cap} | alias ${action.trafficContext.checkout.aliasVersion} | ${action.trafficContext.checkout.memoryMb} MB` : "Awaiting worker preflight"}</dd></div>
        </dl>
      </div>
    </details>
    <details className="surge-disclosure">
      <summary><span>Checkout outcomes</span><span className="surge-summary-status">{checkoutRequests.length} records</span></summary>
      <div className="surge-disclosure-body">
        {checkoutRequests.length ? <ul className="surge-sample-list">{checkoutRequests.map((request, index) => <li key={`${request.id}-${index}`}>
          <span>{requestOutcomeLabel(request.outcome)} | {request.statusCode === undefined ? "No HTTP status" : `HTTP ${request.statusCode}`}</span>
          <strong>{request.durationMs === undefined ? "No duration" : `${request.durationMs} ms`}</strong>
          <small>{request.requestId ?? request.checkoutId ?? request.id}{request.dependencyReason ? ` | ${request.dependencyReason}` : request.errorCode ? ` | ${request.errorCode}` : ""}</small>
        </li>)}</ul> : <p className="surge-muted">No checkout request records are available.</p>}
      </div>
    </details>
    <CatalogCohorts action={action} />
    <NativeMetrics action={action} observation={observation} onRefresh={onMetricsRefresh} />
  </article>;
}

function ThrottlingComparison({ previous, current }: { previous?: Observation<TrafficMetricsResponse>; current?: Observation<TrafficMetricsResponse> }) {
  const rows = ["Inventory", "Checkout"] as const;
  const hasSeries = rows.some((resource) => metricSeries(previous?.value, resource, "Throttles") || metricSeries(current?.value, resource, "Throttles"));
  return <section className="surge-throttle-comparison" aria-label="Observed throttles comparison">
    <div className="surge-subheading">
      <h4>Observed throttles</h4>
    </div>
    {hasSeries ? <div className="surge-table-scroll">
      <table className="surge-cohort-table"><thead><tr><th>Resource</th><th>Prior run</th><th>Latest run</th></tr></thead>
        <tbody>{rows.map((resource) => <tr key={resource}><th scope="row">{resource}</th><td>{nativeMetricValue(previous, resource, "Throttles")}</td><td>{nativeMetricValue(current, resource, "Throttles")}</td></tr>)}</tbody>
      </table>
    </div> : <p className="surge-muted">No native throttle series is available for either run.</p>}
  </section>;
}

export function TrafficSurgePanel({ bearer, currentAction, latestSurgeActionId, disabled, disabledReason, onStart, onRepeat }: TrafficSurgePanelProps) {
  const latestId = currentAction?.trafficProfile ? currentAction.id : latestSurgeActionId;
  const latestLiveAction = latestId && currentAction?.id === latestId ? currentAction : undefined;
  const [loadedActions, setLoadedActions] = useState<ObservationMap<Action>>({});
  const [metricObservations, setMetricObservations] = useState<ObservationMap<TrafficMetricsResponse>>({});
  const inFlightActions = useRef(new Set<string>());
  const inFlightMetrics = useRef(new Set<string>());
  const queuedMetricReads = useRef(new Set<string>());
  const automaticMetricReads = useRef(new Set<string>());
  const latestAction = latestLiveAction ?? (latestId ? loadedActions[latestId]?.value : undefined);
  const previousId = latestAction?.previousSurgeActionId;
  const previousLiveAction = previousId && currentAction?.id === previousId ? currentAction : undefined;
  const previousAction = previousLiveAction ?? (previousId ? loadedActions[previousId]?.value : undefined);
  const comparison = comparisonCheck(previousAction, latestAction);
  const showRepeat = isCurrentInventorySurgeProfile(latestAction?.trafficProfile);
  const repeatUnavailableReason = latestAction?.trafficProfile?.version === 1
    ? "Latest run used historical profile v1, not the current v4 workload."
    : latestAction?.trafficProfile?.version === 2
      ? "Latest run used historical profile v2 at 60/s, not the current v4 profile at 30/s."
      : latestAction?.trafficProfile?.version === 3
        ? "Latest run used historical profile v3 with a 150 ms allowance, not the current v4 profile at 300 ms."
        : latestId && latestAction && !latestAction.trafficProfile
          ? "Latest run has no saved profile. Same profile cannot be confirmed."
          : latestId && latestAction && latestAction.trafficProfile && !showRepeat
            ? "Latest v4 parameters differ from the current v4 profile. Same profile is unavailable."
            : undefined;

  const loadAction = useCallback(async (id: string) => {
    if (!bearer || inFlightActions.current.has(id)) return;
    inFlightActions.current.add(id);
    setLoadedActions((previous) => ({ ...previous, [id]: { ...previous[id], loading: true } }));
    try {
      const response = await fetch(`/api/actions/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      });
      const action = readAction(await responseJson(response));
      if (action.id !== id) throw new Error("The controller returned a different action record");
      setLoadedActions((previous) => ({ ...previous, [id]: { value: action, loading: false } }));
    } catch (error) {
      setLoadedActions((previous) => ({ ...previous, [id]: { ...previous[id], loading: false, failedAt: new Date().toISOString(), error: error instanceof Error ? uiText(error.message) : "The surge action could not be read" } }));
    } finally {
      inFlightActions.current.delete(id);
    }
  }, [bearer]);

  const loadMetrics = useCallback(async (id: string) => {
    if (!bearer) return;
    if (inFlightMetrics.current.has(id)) {
      queuedMetricReads.current.add(id);
      return;
    }
    inFlightMetrics.current.add(id);
    setMetricObservations((previous) => ({ ...previous, [id]: { ...previous[id], loading: true } }));
    try {
      const response = await fetch(`/api/actions/${encodeURIComponent(id)}/metrics`, {
        headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      });
      const metrics = readMetrics(await responseJson(response), id);
      setMetricObservations((previous) => ({ ...previous, [id]: { value: metrics, loading: false } }));
    } catch (error) {
      setMetricObservations((previous) => ({ ...previous, [id]: { ...previous[id], loading: false, failedAt: new Date().toISOString(), error: error instanceof Error ? uiText(error.message) : "Native metrics could not be read" } }));
    } finally {
      inFlightMetrics.current.delete(id);
      if (queuedMetricReads.current.delete(id)) window.setTimeout(() => { void loadMetrics(id); }, 0);
    }
  }, [bearer]);

  useEffect(() => {
    if (!latestId) return;
    if (latestId !== currentAction?.id) void loadAction(latestId);
    const knownPreviousId = latestLiveAction?.previousSurgeActionId ?? loadedActions[latestId]?.value?.previousSurgeActionId;
    if (knownPreviousId && knownPreviousId !== currentAction?.id) void loadAction(knownPreviousId);
  }, [currentAction?.id, latestId, latestLiveAction?.previousSurgeActionId, loadedActions[latestId ?? ""]?.value?.previousSurgeActionId, loadAction]);

  useEffect(() => {
    const actions = [[latestId, latestAction], [previousId, previousAction]] as const;
    for (const [id, action] of actions) {
      if (!id || !action?.trafficWindow?.startedAt) continue;
      const settled = Boolean(action.trafficWindow.settledAt);
      const key = `${id}:${settled ? "settled" : "started"}`;
      if (automaticMetricReads.current.has(key)) continue;
      automaticMetricReads.current.add(key);
      if (settled) automaticMetricReads.current.add(`${id}:started`);
      void loadMetrics(id);
    }
  }, [latestId, latestAction?.trafficWindow?.startedAt, latestAction?.trafficWindow?.settledAt,
    previousId, previousAction?.trafficWindow?.startedAt, previousAction?.trafficWindow?.settledAt, loadMetrics]);

  useEffect(() => {
    const keep = new Set([latestId, previousId].filter((id): id is string => Boolean(id)));
    setMetricObservations((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => keep.has(id))));
    setLoadedActions((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => keep.has(id))));
    for (const key of automaticMetricReads.current) {
      if (!keep.has(key.slice(0, key.lastIndexOf(":")))) automaticMetricReads.current.delete(key);
    }
  }, [latestId, previousId]);

  return <section className="card surge-panel" aria-label="Inventory surge and comparison">
    <div className="card-heading">
      <h2>Inventory surge</h2>
      <span className="surge-summary-status">15 seconds</span>
    </div>
    <div className="surge-action-bar">
      <button className="button button-secondary" type="button" onClick={onStart} disabled={disabled}>Start surge</button>
      {showRepeat && <button className="button button-primary" type="button" onClick={onRepeat} disabled={disabled}>Repeat same profile</button>}
    </div>
    {disabledReason && <p className="surge-guardrail surge-guardrail-blocked" role="status">{uiText(disabledReason)}</p>}
    <details className="surge-disclosure surge-workload-details">
      <summary><span>Workload details</span><span className="surge-summary-status">v4</span></summary>
      <div className="surge-disclosure-body">
        <dl className="surge-outcome-grid surge-workload-grid">
          <div><dt>Duration</dt><dd>15 s</dd></div>
          <div><dt>Catalog</dt><dd>30 GETs every 1,000 ms</dd></div>
          <div><dt>Catalog cap</dt><dd>450 attempts, 30 in flight</dd></div>
          <div><dt>Late admission</dt><dd>300 ms</dd></div>
          <div><dt>Checkout</dt><dd>Every 1 s, max 15</dd></div>
          <div><dt>Side effects</dt><dd>No capacity or release change</dd></div>
        </dl>
      </div>
    </details>
    {repeatUnavailableReason && <p className="surge-muted surge-guardrail-note" role="status">{repeatUnavailableReason}</p>}
    {latestId ? <>
      {latestAction ? <TrafficActionObservation action={latestAction} observation={metricObservations[latestId]} label="Latest run" onMetricsRefresh={() => void loadMetrics(latestId)} /> :
        <div className="surge-state-message" role="status">
          <span>{loadedActions[latestId]?.error ? `Could not read latest saved run: ${loadedActions[latestId]?.error}` : "Loading latest saved run"}</span>
          {loadedActions[latestId]?.error && <button className="surge-refresh-button" type="button" onClick={() => void loadAction(latestId)} disabled={loadedActions[latestId]?.loading}>Retry run read</button>}
        </div>}
      {previousId && latestAction && <section className="surge-comparison" aria-label="Previous surge comparison">
        <div className="surge-subheading">
          <h4>Capacity comparison</h4>
        </div>
        {!previousAction ? <div className="surge-state-message" role="status">
          <span>{loadedActions[previousId]?.error ? `Could not read prior saved run: ${loadedActions[previousId]?.error}` : "Loading prior saved run"}</span>
          {loadedActions[previousId]?.error && <button className="surge-refresh-button" type="button" onClick={() => void loadAction(previousId)} disabled={loadedActions[previousId]?.loading}>Retry prior run read</button>}
        </div> : <>
          <p className="surge-comparison-result" role="status">{comparison.headline}</p>
          <div className="surge-comparison-grid">
            <div><strong>Prior run</strong><span>{catalogStartsLabel(previousAction)} | {catalogOutcomeTotalLabel(previousAction)} | duration {durationLabel(actionProductionDuration(previousAction))}</span></div>
            <div><strong>Latest run</strong><span>{catalogStartsLabel(latestAction)} | {catalogOutcomeTotalLabel(latestAction)} | duration {durationLabel(actionProductionDuration(latestAction))}</span></div>
          </div>
          <details className="surge-disclosure">
            <summary><span>Comparison checks</span><span className="surge-summary-status">{comparison.checks.length} checks</span></summary>
            <div className="surge-disclosure-body"><ul className="surge-check-list">{comparison.checks.map((check) => <li key={check}>{check}</li>)}</ul></div>
          </details>
          <ThrottlingComparison previous={metricObservations[previousId]} current={metricObservations[latestId]} />
          <details className="surge-disclosure"><summary>Previous surge details</summary>
            <TrafficActionObservation action={previousAction} observation={metricObservations[previousId]} label="Prior run" onMetricsRefresh={() => void loadMetrics(previousId)} />
          </details>
        </>}
      </section>}
    </> : <p className="surge-empty" role="status">No previous surge.</p>}
  </section>;
}
