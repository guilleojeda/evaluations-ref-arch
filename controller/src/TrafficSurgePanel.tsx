import { useCallback, useEffect, useRef, useState } from "react";
import type { Action, TrafficContext, TrafficProfileSnapshot } from "./types";
import type { TrafficMetricsResponse } from "./metrics";

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
  return typeof value === "number" && Number.isSafeInteger(value) ? value.toLocaleString() : "Not observed";
}

function requestOutcomeLabel(value: string | undefined): string {
  if (value === "not_sent") return "Not sent · admission closed";
  return value ? value.replaceAll("_", " ") : "Outcome pending";
}

function durationLabel(milliseconds: number | undefined): string {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return "Not observed";
  return `${(milliseconds / 1_000).toFixed(1)} s`;
}

function profileLabel(profile: TrafficProfileSnapshot | undefined): string {
  if (!profile) return "Profile not recorded";
  return `${profile.durationMs / 1_000} s · catalog ${profile.catalog.ratePerSecond}/s, max ${profile.catalog.maxAttempts.toLocaleString()} · checkout every ${profile.checkout.intervalMs / 1_000} s, max ${profile.checkout.maxAttempts}`;
}

function actionProductionDuration(action: Action | undefined): number | undefined {
  const window = action?.trafficWindow;
  if (!window) return undefined;
  const started = Date.parse(window.startedAt);
  const recordedEnd = window.producerStoppedAt ?? window.settledAt ?? action?.finishedAt;
  const ended = recordedEnd ? Date.parse(recordedEnd)
    : action && (action.status === "queued" || action.status === "running" || action.status === "draining") ? Date.now()
      : Date.parse(window.scheduledEndAt);
  return Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? ended - started : undefined;
}

function catalogStartsLabel(action: Action): string {
  const observation = action.catalogObservation;
  if (!observation) return "Unknown · no saved catalog snapshot";
  const starts = countLabel(action.traffic?.catalog?.submitted);
  if (observation.status === "complete") return `${starts} final observed starts`;
  const terminal = ["completed", "incomplete", "failed", "stopped", "discarded"].includes(action.status);
  return `${starts} starts through ${timeLabel(observation.observedThrough)}${terminal ? " · final totals unknown" : " · checkpoint only"}`;
}

function catalogTotalsLabel(action: Action): string {
  const observation = action.catalogObservation;
  if (!observation) return "Unknown · no saved catalog snapshot";
  const counters = action.traffic?.catalog;
  const totals = `${countLabel(counters?.submitted)} started · ${countLabel(counters?.completed)} settled · ${countLabel(counters?.succeeded)} succeeded · ${countLabel(counters?.skipped)} skipped`;
  if (observation.status === "complete") return `${totals} · final snapshot through ${timeLabel(observation.observedThrough)}`;
  const terminal = ["completed", "incomplete", "failed", "stopped", "discarded"].includes(action.status);
  return `${totals} · counts through ${timeLabel(observation.observedThrough)}${terminal ? " · final totals unknown after interruption" : " · current totals may have advanced"}`;
}

function catalogInFlightLabel(action: Action): string {
  const observation = action.catalogObservation;
  if (!observation) return "Unknown · no saved catalog snapshot";
  const inFlight = countLabel(action.traffic?.catalog?.inFlight);
  return observation.status === "complete" ? `${inFlight} at final drain` : `${inFlight} at snapshot ${timeLabel(observation.observedThrough)} · current in-flight count unknown`;
}

function catalogOutcomeTotalLabel(action: Action): string {
  const observation = action.catalogObservation;
  if (!observation) return "Unknown · no saved catalog snapshot";
  const successes = countLabel(observation.outcomes.success);
  return observation.status === "complete" ? `${successes} final successful responses` : `${successes} successful responses through ${timeLabel(observation.observedThrough)}`;
}

function metricsSummary(response: TrafficMetricsResponse | undefined): string {
  if (!response) return "No native metric response";
  if (response.status === "pending") return "Pending · no settled metric window";
  return `${response.status === "partial" ? "Partial" : "Available"} · ${response.metrics.length} series · ${response.window ? `${timeLabel(response.window.start)}–${timeLabel(response.window.end)}` : "window unavailable"}`;
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
  return left.name === right.name && left.version === right.version && left.durationMs === right.durationMs &&
    left.catalog.ratePerSecond === right.catalog.ratePerSecond && left.catalog.maxAttempts === right.catalog.maxAttempts &&
    left.catalog.maxInFlight === right.catalog.maxInFlight && left.catalog.requestTimeoutMs === right.catalog.requestTimeoutMs &&
    left.checkout.intervalMs === right.checkout.intervalMs && left.checkout.maxAttempts === right.checkout.maxAttempts &&
    left.checkout.maxInFlight === right.checkout.maxInFlight && left.checkout.requestTimeoutMs === right.checkout.requestTimeoutMs;
}

function contextMatchesExceptInventoryCap(previous: TrafficContext | undefined, current: TrafficContext | undefined): boolean | undefined {
  if (!previous || !current) return undefined;
  return previous.inventory.cap === 16 && current.inventory.cap === 32 &&
    previous.appRevision === current.appRevision && previous.productVersion === current.productVersion &&
    previous.inventory.aliasVersion === current.inventory.aliasVersion && previous.inventory.access === current.inventory.access &&
    previous.inventory.memoryMb === current.inventory.memoryMb &&
    previous.checkout.cap === current.checkout.cap && previous.checkout.aliasVersion === current.checkout.aliasVersion &&
    previous.checkout.memoryMb === current.checkout.memoryMb;
}

function NativeMetrics({ action, observation, onRefresh }: { action: Action; observation?: Observation<TrafficMetricsResponse>; onRefresh: () => void }) {
  const response = observation?.value;
  const byResource = ["Inventory", "Checkout", "Gateway", "Account"] as const;
  return <section className="surge-metrics" aria-label={`Native metrics for surge ${action.id}`}>
    <div className="surge-section-heading">
      <h5>Native CloudWatch observations</h5>
      <span className="surge-metric-status" role="status">
        {observation?.error && response ? "Refresh failed · showing last good observation" :
          observation?.error ? "Unavailable" : observation?.loading && !response ? "Loading" : response ? metricsSummary(response) :
            !action.trafficWindow?.startedAt && ["queued", "running", "draining"].includes(action.status) ? "Pending · waiting for producer start" : "No observation yet"}
      </span>
    </div>
    <button className="surge-refresh-button" type="button" onClick={onRefresh} disabled={observation?.loading}>
      {observation?.loading ? "Refreshing native metrics…" : "Refresh native metrics"}
    </button>
    {observation?.error && !response && <p className="surge-muted" role="status">{observation.error}</p>}
    {observation?.error && response && <p className="surge-muted" role="status">The last good observation is retained from {timeLabel(response.observedAt)}. Refresh failed: {observation.error}</p>}
    {!response && !observation?.error && !action.trafficWindow?.startedAt && ["queued", "running", "draining"].includes(action.status) &&
      <p className="surge-muted">Native queries remain pending until the worker records an actual producer start.</p>}
    {response?.window && <p className="surge-muted">Fixed 60-second native periods · window {timeLabel(response.window.start)}–{timeLabel(response.window.end)} · observed {timeLabel(response.observedAt)}. These are operational signals, not health certification.</p>}
    {response?.status === "pending" && <p className="surge-muted">The action has not produced a settled metric window. Pending remains unavailable, not zero.</p>}
    {response && response.status !== "pending" && <div className="native-metric-grid">
      {byResource.map((resource) => {
        const metrics = response.metrics.filter((metric) => metric.resource === resource);
        return <article className="native-metric-card" key={resource}>
          <h6>{resource}</h6>
          {metrics.length ? <ul>{metrics.map((metric, index) => {
            const points = metric.values.map((sample, pointIndex) => `${timeLabel(metric.timestamps[pointIndex])}: ${sample}`).join(" · ");
            const dimensionSummary = Object.entries(metric.dimensions).map(([name, value]) => `${name}=${value}`).join(", ");
            return <li key={`${metric.name}-${index}`}>
              <strong>{metric.name} · {metric.statistic}</strong>
              <span>{points || "No datapoints observed"}</span>
              <small>{metric.statusCode} · {metric.namespace}{dimensionSummary ? ` · ${dimensionSummary}` : " · account scope"}</small>
            </li>;
          })}</ul> : <p className="surge-muted">No series returned for this resource.</p>}
        </article>;
      })}
    </div>}
    {observation?.failedAt && <p className="surge-muted">Last failed refresh {timeLabel(observation.failedAt)}.</p>}
  </section>;
}

function CatalogCohorts({ action }: { action: Action }) {
  const observation = action.catalogObservation;
  if (!observation) return <p className="surge-muted">No catalog cohort observation is recorded yet.</p>;
  return <details className="surge-details">
    <summary>Catalog outcomes and 15 one-second start cohorts</summary>
    <p className="surge-muted">Cohorts group requests by start time. A cohort's completions belong to requests started in that second; unobserved future time is not measured zero.</p>
    <dl className="surge-outcome-grid">
      {(["success", "http4xx", "http5xx", "invalidResponse", "noResponse"] as const).map((name) => <div key={name}><dt>{name}</dt><dd>{countLabel(observation.outcomes[name])}</dd></div>)}
      {(["late", "full", "checkpoint"] as const).map((name) => <div key={name}><dt>Skipped · {name}</dt><dd>{countLabel(observation.skips[name])}</dd></div>)}
    </dl>
    <div className="surge-table-scroll" role="region" aria-label="Catalog start cohorts" tabIndex={0}>
      <table className="surge-cohort-table"><thead><tr><th>Offset</th><th>Observed</th><th>Started</th><th>Settled</th><th>Success</th><th>Skipped</th><th>Unsuccessful</th></tr></thead>
        <tbody>{observation.bins.map((bin) => { const measured = bin.observedDurationMs > 0; return <tr key={bin.offsetMs}>
          <th scope="row">{(bin.offsetMs / 1_000).toFixed(0)} s</th>
          <td>{(bin.observedDurationMs / 1_000).toFixed(1)} s</td><td>{measured ? countLabel(bin.submitted) : "—"}</td><td>{measured ? countLabel(bin.completed) : "—"}</td>
          <td>{measured ? countLabel(bin.succeeded) : "—"}</td><td>{measured ? countLabel(bin.skipped) : "—"}</td>
          <td>{measured ? countLabel(bin.outcomes.http4xx + bin.outcomes.http5xx + bin.outcomes.invalidResponse + bin.outcomes.noResponse) : "—"}</td>
        </tr>; })}</tbody>
      </table>
    </div>
    <p className="surge-muted">Samples: {observation.samples.length} of at most 24 · {observation.sampleRule.replaceAll("_", " ")} · {observation.samplesTruncated ? "sample set truncated" : "sample set retained"} · observed through {timeLabel(observation.observedThrough)}.</p>
    {observation.samples.length > 0 && <ul className="surge-sample-list">{observation.samples.map((sample, index) => <li key={`${sample.id}-${index}`}>
      <span>{requestOutcomeLabel(sample.outcome)} · {sample.statusCode === undefined ? "no HTTP status" : `HTTP ${sample.statusCode}`}</span>
      <strong>{sample.durationMs === undefined ? "No duration" : `${sample.durationMs} ms`}</strong>
      <small>{sample.requestId ?? sample.id}{sample.errorCode ? ` · ${sample.errorCode}` : ""}</small>
    </li>)}</ul>}
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
    : requested ? "Awaiting admission closure" : window ? "Open" : "No producer window recorded";
  const drainState = settled ? `Settled at ${timeLabel(window?.settledAt)}`
    : action.status === "incomplete" || action.status === "failed" ? `Incomplete · catalog final counts unknown${action.catalogObservation ? `; last snapshot ${timeLabel(action.catalogObservation.observedThrough)}` : "; no catalog snapshot saved"} · checkout ${countLabel(checkout?.inFlight)} in flight`
      : action.status === "draining" || requested ? `Draining · catalog ${catalogInFlightLabel(action)} · checkout ${countLabel(checkout?.inFlight)} in flight`
        : `Catalog ${catalogInFlightLabel(action)} · checkout ${countLabel(checkout?.inFlight)} in flight`;
  const checkoutRequests = action.requests.filter((request) => request.kind === "checkout");
  return <article className="surge-action-record">
    <div className="surge-action-heading">
      <div><p className="eyebrow">{label}</p><h4>{action.status}</h4></div>
      <span className={`incident-badge ${action.status === "failed" || action.status === "incomplete" || action.status === "stopped" ? "badge-warning" : "badge-neutral"}`}>{action.catalogObservation?.status ?? "No catalog snapshot"}</span>
    </div>
    <dl className="surge-facts">
      <div><dt>Action ID</dt><dd className="mono">{action.id}</dd></div>
      <div><dt>Requested profile</dt><dd>{profileLabel(profile)}{profile ? ` · v${profile.version} · max ${profile.catalog.maxInFlight} catalog / ${profile.checkout.maxInFlight} checkout in flight · ${profile.catalog.requestTimeoutMs / 1_000} s request timeouts` : ""}</dd></div>
      <div><dt>Profile requested vs observed</dt><dd>{profile ? `catalog ${profile.catalog.ratePerSecond.toLocaleString()}/s requested · ${catalogStartsLabel(action)}` : "No profile snapshot"}</dd></div>
      <div><dt>Production duration</dt><dd>{window ? `${durationLabel(productionDuration)} · scheduled ${timeLabel(window.startedAt)}–${timeLabel(window.scheduledEndAt)}` : ["queued", "running", "draining"].includes(action.status) ? "Preparing · producer window not yet recorded" : "No producer window recorded"}</dd></div>
      <div><dt>Catalog totals</dt><dd>{action.catalogObservation ? `${catalogTotalsLabel(action)} · ${catalogInFlightLabel(action)}` : "No saved catalog snapshot; catalog start, outcome, and in-flight counts are unknown"}</dd></div>
      <div><dt>Checkout totals</dt><dd>{countLabel(checkout?.submitted)} sent · {countLabel(checkout?.completed)} settled · {countLabel(checkout?.succeeded)} succeeded · {countLabel(checkout?.skipped)} skipped · {countLabel(checkout?.inFlight)} in flight</dd></div>
      <div><dt>Catalog sample fidelity</dt><dd>{action.catalogObservation ? `${action.catalogObservation.status} · ${action.catalogObservation.samples.length} bounded samples · ${action.catalogObservation.samplesTruncated ? "truncated" : "not truncated"}` : "No catalog observation yet"}</dd></div>
      <div><dt>Stop request receipt</dt><dd>{requested ? "Recorded" : window?.stopReason === "duration" ? "Not requested · planned duration ended" : "No Stop request observed"}</dd><small>{window?.stopObservedAt ? `Worker observed Stop at ${timeLabel(window.stopObservedAt)}` : requested ? "Awaiting worker observation" : ""}</small></div>
      <div><dt>Producer admissions</dt><dd>{admissionState}</dd></div>
      <div><dt>Accepted work drain</dt><dd>{drainState}</dd></div>
      <div><dt>Stop reason</dt><dd>{window?.stopReason ?? "Not recorded"}</dd></div>
      <div><dt>App generation / product</dt><dd>{action.trafficContext ? `${action.trafficContext.appRevision} · ${action.trafficContext.productVersion}` : "Awaiting worker preflight"}</dd></div>
      <div><dt>Resolved Inventory</dt><dd>{action.trafficContext ? `cap ${action.trafficContext.inventory.cap} · alias v${action.trafficContext.inventory.aliasVersion} · ${action.trafficContext.inventory.access} · ${action.trafficContext.inventory.memoryMb} MB` : "Awaiting worker preflight"}</dd></div>
      <div><dt>Resolved Checkout</dt><dd>{action.trafficContext ? `cap ${action.trafficContext.checkout.cap} · alias v${action.trafficContext.checkout.aliasVersion} · ${action.trafficContext.checkout.memoryMb} MB` : "Awaiting worker preflight"}</dd></div>
    </dl>
    <details className="surge-details">
      <summary>Durable checkout request outcomes and durations ({checkoutRequests.length})</summary>
      {checkoutRequests.length ? <ul className="surge-sample-list">{checkoutRequests.map((request, index) => <li key={`${request.id}-${index}`}>
        <span>{requestOutcomeLabel(request.outcome)} · {request.statusCode === undefined ? "no HTTP status" : `HTTP ${request.statusCode}`}</span>
        <strong>{request.durationMs === undefined ? "No duration" : `${request.durationMs} ms`}</strong>
        <small>{request.requestId ?? request.checkoutId ?? request.id}{request.dependencyReason ? ` · ${request.dependencyReason}` : request.errorCode ? ` · ${request.errorCode}` : ""}</small>
      </li>)}</ul> : <p className="surge-muted">No checkout request records are available yet.</p>}
    </details>
    <CatalogCohorts action={action} />
    <NativeMetrics action={action} observation={observation} onRefresh={onMetricsRefresh} />
  </article>;
}

function comparisonCheck(previous: Action | undefined, current: Action | undefined): string {
  if (!previous || !current) return "Waiting for both saved surge action records.";
  const profile = sameProfile(previous.trafficProfile, current.trafficProfile);
  const context = contextMatchesExceptInventoryCap(previous.trafficContext, current.trafficContext);
  const previousDuration = actionProductionDuration(previous);
  const currentDuration = actionProductionDuration(current);
  const previousStarts = previous.catalogObservation ? previous.traffic?.catalog?.submitted : undefined;
  const currentStarts = current.catalogObservation ? current.traffic?.catalog?.submitted : undefined;
  const actualDemand = previousStarts === undefined || currentStarts === undefined ? undefined : currentStarts >= previousStarts;
  const completeCatalogPair = previous.catalogObservation?.status === "complete" && current.catalogObservation?.status === "complete";
  const settledPair = previous.status === "completed" && current.status === "completed" &&
    previous.catalogObservation?.status === "complete" && current.catalogObservation?.status === "complete";
  const sameDuration = previousDuration !== undefined && currentDuration !== undefined && previousDuration === currentDuration;
  const previousBins = previous.catalogObservation?.bins;
  const currentBins = current.catalogObservation?.bins;
  const cohortComparison = previousBins?.length === 15 && currentBins?.length === 15
    ? `${completeCatalogPair ? "Final" : "Checkpointed"} cohorts: ${currentBins.filter((bin, index) => bin.submitted >= previousBins[index].submitted).length}/15 one-second periods have at least as many starts`
    : "one-second cohort comparison unavailable";
  const profileText = profile === undefined ? "profile identity unavailable" : profile ? "requested profile matches" : "requested profile differs";
  const contextText = context === undefined ? "resolved context unavailable" : context ? "only Inventory cap changed from 16 to 32" : "resolved app/Inventory/Checkout context does not match the required 16→32 pair";
  const demandText = actualDemand === undefined ? "catalog start totals unavailable without both saved snapshots"
    : !completeCatalogPair ? `checkpointed start totals ${actualDemand ? "are at least as high" : "are lower"} at the recorded observation times; final demand is unknown`
      : actualDemand ? "repeat recorded at least as many final catalog starts" : "repeat recorded fewer final catalog starts";
  const durationText = sameDuration ? `production durations match (${durationLabel(currentDuration)})` : "production durations differ or are unavailable";
  const settleText = settledPair ? "both catalog snapshots are complete and actions completed" : "one or both actions are incomplete or partial";
  return `${profileText}; ${contextText}; ${durationText}; ${demandText}; ${cohortComparison}; ${settleText}.`;
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
  const showRepeat = Boolean(latestId);

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
      setLoadedActions((previous) => ({ ...previous, [id]: { ...previous[id], loading: false, failedAt: new Date().toISOString(), error: error instanceof Error ? error.message : "The surge action could not be read" } }));
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
      setMetricObservations((previous) => ({ ...previous, [id]: { ...previous[id], loading: false, failedAt: new Date().toISOString(), error: error instanceof Error ? error.message : "Native metrics could not be read" } }));
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
      <div><p className="eyebrow">Finite capacity scenario</p><h3>Inventory surge</h3></div>
      <span className="incident-badge badge-neutral">Read only comparison</span>
    </div>
    <p className="surge-intro">Start the fixed 15-second Inventory workload. Stop closes new admissions and drains accepted requests. Set Inventory capacity to 32 in the capacity control, then explicitly repeat the same profile. Recover restores the original release capacity.</p>
    <div className="surge-start-row">
      <button className="button button-secondary" type="button" onClick={onStart} disabled={disabled}>Start Inventory surge · 15 s</button>
      {showRepeat && <button className="button button-primary" type="button" onClick={onRepeat} disabled={disabled}>Repeat same Inventory surge profile</button>}
    </div>
    <p className="surge-muted" role="status">{disabledReason ?? "Profile: catalog 240 requests/s for 15 seconds (maximum 3,600), up to 128 in flight; checkout every 1 second, maximum 15, up to 2 in flight. Starting or repeating sends no capacity, code, memory, access, alias, or Checkout setting change."}</p>
    {latestId ? <>
      {latestAction ? <TrafficActionObservation action={latestAction} observation={metricObservations[latestId]} label="Latest surge" onMetricsRefresh={() => void loadMetrics(latestId)} /> :
        <div className="surge-read-error" role="status">
          <span>{loadedActions[latestId]?.error ? `Could not read the latest saved surge: ${loadedActions[latestId]?.error}` : "Loading the latest saved surge action…"}</span>
          {loadedActions[latestId]?.error && <button type="button" onClick={() => void loadAction(latestId)} disabled={loadedActions[latestId]?.loading}>Retry latest action read</button>}
        </div>}
      {previousId && previousAction && latestAction && <section className="surge-comparison" aria-label="Previous surge comparison">
        <div className="surge-section-heading"><div><p className="eyebrow">Prior action · {previousAction.id}</p><h4>Same-profile comparison</h4></div></div>
        <p className="surge-comparison-result" role="status">{comparison}</p>
        <p className="surge-muted">A matching profile does not prove equivalent delivered demand or a capacity effect; compare actual counts, one-second starts, pacing/skips, metric periods, fresh checkout effects, source-arrival evidence, and the independent alarm/report.</p>
        <div className="surge-comparison-grid">
          <div><strong>Prior catalog starts</strong><span>{catalogStartsLabel(previousAction)} · duration {durationLabel(actionProductionDuration(previousAction))}</span></div>
          <div><strong>Current catalog starts</strong><span>{catalogStartsLabel(latestAction)} · duration {durationLabel(actionProductionDuration(latestAction))}</span></div>
          <div><strong>Prior catalog successes</strong><span>{catalogOutcomeTotalLabel(previousAction)}</span></div>
          <div><strong>Current catalog successes</strong><span>{catalogOutcomeTotalLabel(latestAction)}</span></div>
        </div>
        <TrafficActionObservation action={previousAction} observation={metricObservations[previousId]} label="Previous surge" onMetricsRefresh={() => void loadMetrics(previousId)} />
      </section>}
      {previousId && latestAction && !previousAction && <div className="surge-read-error" role="status">
        <span>{loadedActions[previousId]?.error ? `Could not read the previous surge ${previousId}: ${loadedActions[previousId]?.error}` : "Loading the previous surge action for comparison…"}</span>
        {loadedActions[previousId]?.error && <button type="button" onClick={() => void loadAction(previousId)} disabled={loadedActions[previousId]?.loading}>Retry previous action read</button>}
      </div>}
    </> : <p className="surge-muted" role="status">No Inventory surge action has been recorded in this run.</p>}
  </section>;
}
