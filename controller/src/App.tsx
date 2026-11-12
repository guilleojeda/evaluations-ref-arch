import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Action,
  AlarmResponse,
  AlarmState,
  Command,
  DashboardState,
  InvestigationResponse,
  InvestigationRun,
  InventoryAliasObservation,
  InventoryVariant,
  InventoryVersionObservation,
  RunState,
} from "./types";
import {
  capOutcomeLabel,
  capValueLabel,
  currentConfigurationObservation,
  currentInventoryDisplay,
  recoveryProgressLabel,
  recoveryVerificationLabel,
} from "./inventory-display.mjs";

type Notice = { kind: "error" | "success"; message: string } | undefined;
type PendingCommand = { id: string; command: Command };
const activeStatuses = new Set(["queued", "running", "draining"]);

function formatTime(value: unknown): string {
  if (typeof value !== "string") return "No observation yet";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleTimeString() : value;
}
function display(value: unknown, fallback = "—"): string { return value === undefined || value === null || value === "" ? fallback : String(value); }
function normalizedTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function runStatusLabel(run: InvestigationRun): string {
  if (run.status === "running") {
    return Date.parse(run.deadlineAt) <= Date.now() ? "Overdue · still running" : "Running";
  }
  if (run.status === "failed") return "Failed";
  return run.report?.assessment === "unknown" ? "Complete · assessment unknown"
    : run.report?.assessment ? `Complete · ${run.report.assessment}` : "Complete";
}

function traceUrl(run: InvestigationRun): string | undefined {
  const storedTraceId = run.traceRef?.traceId;
  const region = run.traceRef?.region;
  if (typeof storedTraceId !== "string" || typeof region !== "string" || !/^[a-z0-9-]{3,32}$/.test(region)) return undefined;
  const traceId = /^[a-f0-9]{32}$/i.test(storedTraceId)
    ? `1-${storedTraceId.slice(0, 8)}-${storedTraceId.slice(8)}`
    : /^1-[a-f0-9]{8}-[a-f0-9]{24}$/i.test(storedTraceId) ? storedTraceId : undefined;
  if (!traceId) return undefined;
  return `https://console.aws.amazon.com/xray/home?region=${encodeURIComponent(region)}#/traces/${encodeURIComponent(traceId)}`;
}

function InvestigationRecord({ run }: { run: InvestigationRun }) {
  const trace = traceUrl(run);
  const recommendation = run.report?.recommendation;
  const capture = run.captureRef;
  return <article className="investigation-record">
    <div className="record-heading">
      <div><p className="eyebrow">ALARM transition · {formatTime(run.transitionAt)}</p><h4>{runStatusLabel(run)}</h4></div>
      <span className={`alarm-state ${run.status === "failed" ? "alarm-danger" : run.status === "complete" ? "alarm-ok" : "alarm-unknown"}`}>{run.status}</span>
    </div>
    <dl className="investigation-facts">
      <div><dt>Run / session</dt><dd className="mono">{run.runId} / {run.runtimeSessionId}</dd></div>
      <div><dt>Candidate / source</dt><dd className="mono">{run.candidateId} / {run.sourceRevision}</dd></div>
      {run.artifactSha256 && <div><dt>Runtime artifact SHA-256</dt><dd className="mono">{run.artifactSha256}</dd></div>}
      <div><dt>Prompt SHA-256</dt><dd className="mono">{run.promptSha256}</dd></div>
      <div><dt>Model / Runtime</dt><dd className="mono">{run.modelId} · v{run.runtimeVersion} · {run.endpointName}</dd></div>
      <div><dt>Started / deadline</dt><dd>{formatTime(run.startedAt)} · {formatTime(run.deadlineAt)}</dd></div>
      {run.finishedAt && <div><dt>Finished</dt><dd>{formatTime(run.finishedAt)}</dd></div>}
    </dl>
    {run.failure && <p className="investigation-failure"><strong>{run.failure.code}</strong> · {run.failure.message}</p>}
    {run.report && <section className="investigation-report" aria-label="Investigation report">
      <p className="report-summary">{run.report.summary}</p>
      {recommendation && <div className="report-recommendation"><strong>{recommendation.action}</strong>
        {(recommendation.target !== undefined || recommendation.value !== undefined || recommendation.unit !== undefined) && <span>{[recommendation.target, recommendation.value, recommendation.unit].filter((value) => value !== undefined && value !== null && value !== "").map(String).join(" · ")}</span>}
        {recommendation.explanation && <p>{recommendation.explanation}</p>}
        {recommendation.policy && <p>{recommendation.policy}</p>}
        {recommendation.policyDetail && <p>{recommendation.policyDetail}</p>}
      </div>}
      <div><h5>Source evidence</h5>
        <ul className="citation-list">{run.report.evidence.map((citation, index) => <li key={`${citation.source}-${citation.resource}-${index}`}>
          <strong>{citation.source}</strong> · <span className="mono">{citation.resource}</span>
          <small>{formatTime(citation.windowStart)} to {formatTime(citation.windowEnd)} · observed {formatTime(citation.observedAt)}</small>
          <span>{citation.finding}</span>
        </li>)}</ul>
      </div>
      <div className="report-notes"><div><h5>Uncertainties</h5>{run.report.uncertainties.length ? <ul>{run.report.uncertainties.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>None recorded</p>}</div>
        <div><h5>Alternatives</h5>{run.report.alternatives.length ? <ul>{run.report.alternatives.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>None recorded</p>}</div>
      </div>
    </section>}
    <div className="investigation-links">
      {trace && <a href={trace} target="_blank" rel="noreferrer">Open native CloudWatch trace</a>}
      {run.traceRef && <span className="mono">Trace {display(run.traceRef.traceId, "not recorded")} · {display(run.traceRef.region, "region unknown")}</span>}
    </div>
    {capture && <details className="capture-details"><summary>Source capture and coverage</summary>
      <dl className="investigation-facts">
        <div><dt>Private source location</dt><dd className="mono">{display(capture.bucket)} / {display(capture.prefix)}</dd></div>
        <div><dt>Baseline / manifest</dt><dd className="mono">{display(capture.manifestKey ?? capture.baselineKey ?? capture.key)}</dd></div>
        <div><dt>Query results</dt><dd className="mono">{display(capture.queryResultsKey)}</dd></div>
        <div><dt>Capture completeness</dt><dd>{display(capture.completeness)} · observed {formatTime(capture.capturedAt ?? capture.observedAt)}</dd></div>
        <div><dt>Coverage</dt><dd>{display(capture.coveredFrom, "start not recorded")} to {display(capture.coveredThrough, "end not recorded")}</dd></div>
      </dl>
      {Array.isArray(capture.gaps) && capture.gaps.length > 0 && <ul className="capture-gaps">{capture.gaps.map((gap, index) => <li key={index}>{String(gap)}</li>)}</ul>}
    </details>}
  </article>;
}

function recoveryValidationLabel(action: Action): string {
  if (action.recoveryProgress === "validating") {
    if (action.status === "failed") return "Failed";
    if (action.status === "incomplete") return "Incomplete";
    return "In progress";
  }
  if (["capturing", "restoring", "verifying", "verified", "verification_incomplete", "verification_unknown"].includes(action.recoveryProgress ?? "")) {
    return "Passed";
  }
  return action.status === "failed" ? "Failed or not reached" : "Not recorded";
}

function RecoveryPanel({
  action,
  state,
  trafficAction,
  currentAlias,
  currentMemoryMb,
  currentAccess,
}: {
  action: Action;
  state: DashboardState;
  trafficAction?: Action;
  currentAlias?: InventoryAliasObservation;
  currentMemoryMb?: number;
  currentAccess: unknown;
}) {
  const original = inventoryVersionObservation(state.originalBaseline?.settings?.inventory);
  const target = action.inventorySwitch?.target;
  const aliasBefore = action.inventorySwitch?.before;
  const aliasAfter = action.inventorySwitch?.after;
  const baselineInventory = inventoryVersionObservation(state.baseline?.settings?.inventory);
  const manifest = state.baseline?.settings?.inventoryVariantsManifest ?? state.originalBaseline?.settings?.inventoryVariantsManifest;
  const checkpointRevision = action.configurationCheckpoint?.appRevision;
  const trustedManifest = isRecord(manifest) && manifest.sourceRevision === checkpointRevision ? manifest : undefined;
  const beforeVariant = inventoryVariantForVersion(trustedManifest, aliasBefore?.functionVersion);
  const beforeMatchesCurrent = aliasBefore?.functionVersion === currentAlias?.functionVersion;
  const beforeMemory = beforeVariant?.memoryMb ?? (beforeMatchesCurrent ? currentMemoryMb : undefined);
  const beforeAccess = beforeVariant?.access ?? (beforeMatchesCurrent ? currentAccess : undefined);
  const beforeRole = beforeVariant?.roleArn ?? (beforeMatchesCurrent ? baselineInventory?.role : undefined);
  const checkpoint = action.configurationCheckpoint;
  const verificationRequest = [...action.requests].reverse().find(({ kind }) => kind === "checkout");
  const verificationId = action.baseline?.checkoutId ?? verificationRequest?.checkout?.checkoutId ?? verificationRequest?.checkoutId;
  const receipt = verificationId ? state.receipts.find(({ checkoutId }) => checkoutId === verificationId) : undefined;
  const verifiedBaseline = action.baseline?.checkoutId === verificationId ? action.baseline
    : state.baseline?.checkoutId === verificationId ? state.baseline : undefined;
  const trafficLabel = !trafficAction ? "No active traffic action"
    : trafficAction.status === "draining" ? "Draining accepted requests"
      : trafficAction.status === "stopped" ? "Stopped"
        : trafficAction.status === "completed" ? "Completed"
          : trafficAction.status === "running" && trafficAction.stopRequested ? "Stop requested"
            : trafficAction.status;
  const capRows = [
    ["Checkout", action.capRestoration?.checkout],
    ["Inventory", action.capRestoration?.inventory],
  ] as const;

  return <section className="card recovery-panel" aria-label="Recovery progress">
    <div className="card-heading">
      <div><p className="eyebrow">Recover current release</p><h3 aria-live="polite">{recoveryProgressLabel(action.recoveryProgress)}</h3></div>
      <span className={`incident-badge ${["failed", "incomplete", "discarded"].includes(action.status) ? "badge-warning" : "badge-neutral"}`}>Action {action.status}</span>
    </div>
    <p className="muted recovery-meta">Action {action.id} · started {formatTime(action.startedAt)}{action.finishedAt ? ` · ended ${formatTime(action.finishedAt)}` : ""}</p>
    {action.error && <p className="action-error" role="alert">{action.error}</p>}
    <div className="recovery-status-grid">
      <div><span className="fact-label">Traffic</span><strong>{trafficLabel}</strong><small>{trafficAction ? `${display(trafficAction.traffic?.catalog?.inFlight, "0")} catalog · ${display(trafficAction.traffic?.checkout?.inFlight, "0")} checkout requests in flight` : "No producer needs draining"}</small></div>
      <div><span className="fact-label">Release validation</span><strong>{recoveryValidationLabel(action)}</strong><small>Current deployed release and prepared settings</small></div>
      <div><span className="fact-label">Settings capture</span><strong>{checkpoint?.status ?? (action.recoveryProgress === "capturing" ? "In progress" : "Not recorded")}</strong><small>{checkpoint?.createdAt ? `Observed ${formatTime(checkpoint.createdAt)}` : checkpoint?.error ?? ""}</small></div>
      <div><span className="fact-label">Settings result</span><strong>{resultLabel(action.configurationOutcome)}</strong><small>Recorded independently from business verification</small></div>
    </div>
    {checkpoint?.error && <p className="muted recovery-gap" role="status">Capture detail: {checkpoint.error}</p>}

    <h4 className="recovery-subheading">Inventory version and memory</h4>
    <dl className="recovery-facts">
      <div><dt>Original healthy target</dt><dd>{original ? `v${original.version} · ${original.memory} MB · ${accessLabel(original.access)} · ${roleLabel(original.role)}` : "Not established"}</dd></div>
      <div><dt>Before recovery</dt><dd>{aliasBefore ? `v${aliasBefore.functionVersion}` : display(currentAlias?.functionVersion, "Unknown")} · {beforeMemory === undefined ? "memory unknown" : `${beforeMemory} MB`} · {accessLabel(beforeAccess)} · {roleLabel(beforeRole)}</dd></div>
      <div><dt>Recovery target</dt><dd>{target ? `v${target.version} · ${target.memoryMb} MB · ${accessLabel(target.access)} · ${roleLabel(target.roleArn)}` : "Not recorded"}</dd></div>
      <div><dt>Alias readback</dt><dd>{aliasAfter ? `v${aliasAfter.functionVersion}${target?.version === aliasAfter.functionVersion ? ` · target ${target.memoryMb} MB ${accessLabel(target.access)} · ${roleLabel(target.roleArn)}` : ""} · ${formatTime(aliasAfter.observedAt)}` : action.recoveryProgress === "restoring" ? "Awaiting readback" : "Not observed"}</dd></div>
    </dl>

    <h4 className="recovery-subheading">Function concurrency</h4>
    <div className="recovery-cap-grid">
      {capRows.map(([name, value]) => <article className="recovery-cap" key={name}>
        <strong>{name}</strong>
        {value ? <>
          <span>Before {capValueLabel(value.before)} · target {capValueLabel(value.target)}</span>
          <span>Readback {value.readback === undefined ? (value.outcome === "pending" ? "Awaiting readback" : "Not observed") : capValueLabel(value.readback)}</span>
          <small>{capOutcomeLabel(value.outcome)}{value.observedAt ? ` · ${formatTime(value.observedAt)}` : ""}</small>
        </> : <span>Not observed</span>}
      </article>)}
    </div>

    <h4 className="recovery-subheading">Fresh business verification</h4>
    <p className="recovery-verification" role="status">{recoveryVerificationLabel(action)}</p>
    <dl className="recovery-facts">
      <div><dt>Verification order</dt><dd className="mono">{display(verificationId, "Not sent")}</dd></div>
      <div><dt>Saved receipt</dt><dd>{display(verifiedBaseline?.receipt?.status ?? receipt?.status, verificationRequest?.outcome === "success" ? "Request succeeded; receipt readback pending" : "Not observed")}</dd></div>
      <div><dt>Stock check</dt><dd>{verifiedBaseline ? `${verifiedBaseline.stockBefore} → ${verifiedBaseline.stockAfter} units` : "Not verified"}</dd></div>
      <div><dt>Product version</dt><dd className="mono">{display(verifiedBaseline?.productVersion, "Not verified")}</dd></div>
    </dl>

    <h4 className="recovery-subheading">Last verified health</h4>
    {state.baseline
      ? <p className="recovery-last-health"><span className="mono">{state.baseline.checkoutId}</span> · {state.baseline.stockBefore} → {state.baseline.stockAfter} units · product {state.baseline.productVersion} · verified {formatTime(state.baseline.verifiedAt)}</p>
      : <p className="recovery-last-health">No successful business verification is recorded.</p>}
  </section>;
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDashboard(value: Record<string, unknown>): value is Record<string, unknown> & DashboardState {
  return typeof value.observedAt === "string" && typeof value.runId === "string" && typeof value.resetRequired === "boolean" &&
    (value.baseline === null || isRecord(value.baseline)) &&
    (value.currentAction === undefined || isRecord(value.currentAction)) &&
    (value.currentConfigurationAction === undefined || isRecord(value.currentConfigurationAction)) &&
    Array.isArray(value.receipts) && value.receipts.every(isRecord) &&
    Array.isArray(value.unresolved) && value.unresolved.every(isRecord);
}

function isRunState(value: unknown): value is RunState {
  return isRecord(value) && typeof value.runId === "string" && typeof value.resetRequired === "boolean" &&
    (value.baseline === null || isRecord(value.baseline)) && Array.isArray(value.receipts) && value.receipts.every(isRecord) &&
    Array.isArray(value.unresolved) && value.unresolved.every(isRecord);
}

function isAlarmResponse(value: Record<string, unknown>): value is Record<string, unknown> & AlarmResponse {
  return typeof value.observedAt === "string" && (value.alarm === null || isRecord(value.alarm));
}

function alarmTone(state: AlarmState | undefined): string {
  return state === "ALARM" ? "alarm-danger" : state === "OK" ? "alarm-ok" : "alarm-unknown";
}
function accessLabel(access: unknown): string {
  return access === "healthy" ? "Healthy" : access === "denied" ? "Denied" : "Unknown";
}
function resultLabel(result: Action["configurationOutcome"] | undefined): string {
  return result === "applied" ? "Success" : result === "no_change" ? "No-op" : result === "unknown" ? "Unknown" : result === "failed" ? "Failed" : "Not attempted";
}
function inventoryVersionObservation(value: unknown): InventoryVersionObservation | undefined {
  if (!isRecord(value) || typeof value.version !== "string" || typeof value.aliasArn !== "string" ||
      typeof value.memory !== "number" || typeof value.timeout !== "number" ||
      (typeof value.cap !== "number" && value.cap !== "unreserved") || typeof value.codeSha256 !== "string" ||
      typeof value.role !== "string") return undefined;
  return value as unknown as InventoryVersionObservation;
}
function inventoryVariantForVersion(value: unknown, version: string | undefined): InventoryVariant | undefined {
  if (!version || !isRecord(value) || !Array.isArray(value.variants)) return undefined;
  const variant = value.variants.find((candidate) => isRecord(candidate) && candidate.version === version);
  if (!isRecord(variant) || typeof variant.memoryMb !== "number" || !Number.isSafeInteger(variant.memoryMb) ||
      variant.memoryMb < 128 || variant.memoryMb > 10_240 ||
      (variant.access !== "healthy" && variant.access !== "denied") || typeof variant.roleArn !== "string") return undefined;
  return { version, memoryMb: variant.memoryMb, access: variant.access, roleArn: variant.roleArn };
}
function roleLabel(value: unknown): string {
  if (typeof value !== "string" || !value) return "Role not recorded";
  return value.split("/").at(-1) ?? value;
}
function inventoryMemoryOptions(value: unknown, releaseRevision: string | undefined,
  healthyRoleArn: unknown, deniedRoleArn: unknown): number[] {
  if (!releaseRevision || !isRecord(value) || value.schemaVersion !== 1 || value.sourceRevision !== releaseRevision ||
      value.functionName !== "IncidentTriageDemoInventory" || value.aliasName !== "live" ||
      typeof value.codeSha256 !== "string" || !value.codeSha256 || !Array.isArray(value.variants) ||
      value.variants.length < 2 || value.variants.length > 32) return [];
  const pairs = new Set<string>();
  const memories = new Set<number>();
  const versions = new Set<string>();
  for (const entry of value.variants) {
    if (!isRecord(entry) || typeof entry.memoryMb !== "number" || !Number.isSafeInteger(entry.memoryMb) ||
        entry.memoryMb < 128 || entry.memoryMb > 10_240 ||
        (entry.access !== "healthy" && entry.access !== "denied") || typeof entry.version !== "string" ||
        !/^[1-9]\d*$/.test(entry.version) || typeof entry.roleArn !== "string" ||
        entry.roleArn !== (entry.access === "healthy" ? healthyRoleArn : deniedRoleArn) || versions.has(entry.version)) return [];
    const key = `${entry.memoryMb}:${entry.access}`;
    if (pairs.has(key)) return [];
    pairs.add(key);
    memories.add(entry.memoryMb);
    versions.add(entry.version);
  }
  const choices = [...memories].filter((memoryMb) => pairs.has(`${memoryMb}:healthy`) && pairs.has(`${memoryMb}:denied`)).sort((a, b) => a - b);
  return choices.length * 2 === value.variants.length ? choices : [];
}
function aliasStatus(
  alias: InventoryAliasObservation | undefined,
  variant: InventoryVariant | undefined,
  baselineReady: boolean,
  access?: unknown,
): string {
  if (!baselineReady) return "Unready";
  if (!alias) return "Unknown";
  if (access === "unknown") return "Unknown";
  if (alias.routingWeighted || !variant || variant.version !== alias.functionVersion) return "Foreign";
  if (freshness(alias.observedAt) === "Stale") return "Stale";
  return "Observed";
}
function freshness(value: string | undefined): string {
  if (!value) return "Unknown freshness";
  const elapsed = Date.now() - Date.parse(value);
  return Number.isFinite(elapsed) && elapsed < 10_000 ? "Fresh" : "Stale";
}

async function readDashboard(response: Response): Promise<DashboardState> {
  const data = await readJson(response);
  if (!isDashboard(data)) throw new Error("The controller returned an invalid dashboard");
  return data;
}

async function readAlarm(response: Response): Promise<AlarmResponse> {
  const data = await readJson(response);
  if (!isAlarmResponse(data)) throw new Error("The controller returned an invalid alarm observation");
  return data;
}

async function readInvestigations(response: Response): Promise<InvestigationResponse> {
  const data = await readJson(response);
  if (typeof data.observedAt !== "string" || !Array.isArray(data.runs) || !data.runs.every(isRecord)) {
    throw new Error("The controller returned an invalid investigation history");
  }
  return data as unknown as InvestigationResponse;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "message" in body ? String((body as { message?: unknown }).message) : `Request failed with HTTP ${response.status}`;
    throw new RequestError(response.status, message);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("The controller returned an invalid response");
  return body as Record<string, unknown>;
}

type HistoricalActionReference = { id: string; label: string };

function historicalActionReferences(run: RunState): HistoricalActionReference[] {
  const references: HistoricalActionReference[] = [];
  const add = (id: unknown, label: string) => {
    if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return;
    if (references.some((reference) => reference.id === id)) return;
    references.push({ id, label });
  };
  add(run.currentActionId, "Run action");
  add(run.configurationActionId, "Configuration action");
  const addIncident = (value: unknown, label: string) => {
    if (!isRecord(value)) return;
    add(value.activationActionId, `${label} activation`);
    add(value.restoreActionId, `${label} restore`);
  };
  addIncident(run.incident, "Incident");
  if (Array.isArray(run.incidentHistory)) run.incidentHistory.forEach((incident, index) => addIncident(incident, `Incident ${index + 1}`));
  return references;
}

type ArchivedIncidentRecord = { summary: string; sourceReference?: string };

function archivedIncidentRecords(run: RunState): ArchivedIncidentRecord[] {
  const values = [...(Array.isArray(run.incidentHistory) ? run.incidentHistory : []), ...(run.incident ? [run.incident] : [])];
  return values.flatMap((value) => {
    if (!isRecord(value)) return [];
    const mechanism = value.mechanism === "lambda-alias" ? "Inventory access incident" : "Retained legacy incident";
    const state = value.active === "denied" ? "denial recorded" : value.active === "healthy" ? "access restored" : value.active === "unknown" ? "outcome unknown" : "record retained";
    const updatedAt = typeof value.updatedAt === "string" ? ` · updated ${formatTime(value.updatedAt)}` : "";
    const checkpoint = isRecord(value.checkpoint) ? value.checkpoint : undefined;
    return [{ summary: `${mechanism} · ${state}${updatedAt}`, sourceReference: typeof checkpoint?.key === "string" ? checkpoint.key : undefined }];
  });
}

function RunHistoryPanel({ currentRunId, previousRunId, currentResetRequired, bearer }: { currentRunId: string; previousRunId?: string; currentResetRequired: boolean; bearer: string }) {
  const [archiveId, setArchiveId] = useState<string>();
  const [archive, setArchive] = useState<{ run: RunState; loadedAt: string }>();
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveError, setArchiveError] = useState<string>();
  const [historyNow, setHistoryNow] = useState(Date.now());
  const [selectedActionId, setSelectedActionId] = useState<string>();
  const [selectedAction, setSelectedAction] = useState<Action>();
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const archiveRequest = useRef(0);
  const actionRequest = useRef(0);
  const selectedArchive = archiveId !== undefined && archive?.run.runId === archiveId ? archive : undefined;
  const archiveMatchesSelection = selectedArchive !== undefined;
  const archiveAgeMs = selectedArchive ? historyNow - Date.parse(selectedArchive.loadedAt) : Number.POSITIVE_INFINITY;
  const archiveFreshness = archiveLoading ? selectedArchive ? "Refreshing archived snapshot" : "Loading archived run"
    : archiveError ? selectedArchive ? "Refresh failed · last snapshot shown" : "Unavailable"
      : !selectedArchive ? "Not loaded"
        : !Number.isFinite(archiveAgeMs) || archiveAgeMs >= 60_000 ? "Stale · refresh available" : "Loaded";

  useEffect(() => {
    const timer = window.setInterval(() => setHistoryNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const loadRun = useCallback(async (id: string) => {
    const request = archiveRequest.current + 1;
    archiveRequest.current = request;
    if (id !== archiveId) {
      actionRequest.current += 1;
      setSelectedActionId(undefined);
      setSelectedAction(undefined);
      setActionLoading(false);
      setActionError(undefined);
    }
    setArchiveId(id);
    setArchiveLoading(true);
    setArchiveError(undefined);
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      });
      const body = await readJson(response);
      if (!isRunState(body.run) || body.run.runId !== id) throw new Error("The controller returned an invalid archived run");
      if (archiveRequest.current === request) {
        setArchive({ run: body.run, loadedAt: new Date().toISOString() });
        setHistoryNow(Date.now());
      }
    } catch (error) {
      if (archiveRequest.current === request) setArchiveError(error instanceof Error ? error.message : "The archived run could not be read");
    } finally {
      if (archiveRequest.current === request) setArchiveLoading(false);
    }
  }, [archiveId, bearer]);

  const loadAction = useCallback(async (id: string) => {
    const request = actionRequest.current + 1;
    actionRequest.current = request;
    setSelectedActionId(id);
    setSelectedAction(undefined);
    setActionLoading(true);
    setActionError(undefined);
    try {
      const response = await fetch(`/api/actions/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      });
      const body = await readJson(response);
      if (!isRecord(body.action) || body.action.id !== id || typeof body.action.kind !== "string" ||
          typeof body.action.status !== "string" || !Array.isArray(body.action.requests)) {
        throw new Error("The controller returned an invalid action record");
      }
      if (actionRequest.current === request) setSelectedAction(body.action as unknown as Action);
    } catch (error) {
      if (actionRequest.current === request) setActionError(error instanceof Error ? error.message : "The action record could not be read");
    } finally {
      if (actionRequest.current === request) setActionLoading(false);
    }
  }, [bearer]);

  const closeArchive = () => {
    archiveRequest.current += 1;
    actionRequest.current += 1;
    setArchiveId(undefined);
    setArchiveLoading(false);
    setArchiveError(undefined);
    setSelectedActionId(undefined);
    setSelectedAction(undefined);
    setActionLoading(false);
    setActionError(undefined);
  };
  const run = selectedArchive?.run;
  const actionReferences = run ? historicalActionReferences(run) : [];
  const incidents = run ? archivedIncidentRecords(run) : [];

  return <>
    <section className="card session-card" aria-label="Current demo run">
      <div className="card-heading">
        <div><p className="eyebrow">Current session</p><h3>Run {currentRunId}</h3></div>
        <span className={`incident-badge ${currentResetRequired ? "badge-warning" : "badge-neutral"}`}>{currentResetRequired ? "Reset required" : "Current"}</span>
      </div>
      <p className="muted">Traffic belongs to the current session. Alarm and investigation history retain their own timestamps and identities.</p>
      {previousRunId
        ? <button className="button button-secondary history-link" type="button" onClick={() => void loadRun(previousRunId)}>View previous run · {previousRunId}</button>
        : <p className="muted empty-state">No previous run is recorded.</p>}
    </section>
    {archiveId && <section className="card archived-run" aria-label={`Archived run ${archiveId}`}>
      <div className="card-heading">
        <div><p className="eyebrow">Archived session · read only</p><h3>Run {archiveId}</h3></div>
        <div className="archived-heading-actions"><span className="incident-badge badge-neutral">History</span><button className="button button-secondary" type="button" onClick={closeArchive}>Return to current run</button></div>
      </div>
      <p className="source-time" role="status">{archiveFreshness}{selectedArchive ? ` · loaded ${formatTime(selectedArchive.loadedAt)}` : ""}</p>
      {archiveError && <p className="notice notice-error" role="alert">{archiveMatchesSelection ? "Refresh failed; showing the last loaded snapshot. " : "Run history is unavailable. "}{archiveError}</p>}
      {archiveLoading && !archiveMatchesSelection && <p className="muted" role="status">Loading archived run…</p>}
      {!archiveLoading && !archiveMatchesSelection && !archiveError && <p className="muted empty-state">No archived run is loaded.</p>}
      {run && <>
        <div className="archived-run-actions">
          <button className="button button-secondary" type="button" onClick={() => void loadRun(run.runId)} disabled={archiveLoading}>Refresh archived snapshot</button>
          {run.previousRunId && <button className="button button-secondary" type="button" onClick={() => void loadRun(run.previousRunId!)} disabled={archiveLoading}>View earlier run · {run.previousRunId}</button>}
        </div>
        <dl className="archived-facts">
          <div><dt>Run identity</dt><dd className="mono">{run.runId}{run.previousRunId ? ` · previous ${run.previousRunId}` : ""}</dd></div>
          <div><dt>Reset state when archived</dt><dd>{run.resetRequired ? "Reset was still required" : "Run was usable"}</dd></div>
          <div><dt>Last verified baseline</dt><dd>{run.baseline ? `${run.baseline.stockBefore} → ${run.baseline.stockAfter} units · product ${run.baseline.productVersion} · verified ${formatTime(run.baseline.verifiedAt)}` : "No verified baseline in this run"}</dd></div>
          {run.originalBaseline && <div><dt>Original healthy baseline</dt><dd>{`${run.originalBaseline.stockBefore} → ${run.originalBaseline.stockAfter} units · product ${run.originalBaseline.productVersion} · verified ${formatTime(run.originalBaseline.verifiedAt)}`}</dd></div>}
          <div><dt>Retained records</dt><dd>{run.receipts.length} receipts · {run.unresolved.length} unresolved attempts · {actionReferences.length} action references</dd></div>
        </dl>

        <div className="archive-content-grid">
          <section aria-label="Archived receipts">
            <h4 className="recovery-subheading">Retained receipts</h4>
            {run.receipts.length ? <ul className="record-list">{run.receipts.map((receipt, index) => <li key={`${receipt.checkoutId}-${index}`}><span className="mono">{display(receipt.checkoutId)}</span><strong>{display(receipt.quantity, "?")} units</strong><small>{formatTime(receipt.createdAt)} · {display(receipt.status, "unknown")}</small></li>)}</ul> : <p className="muted empty-state">No receipts were recorded in this run.</p>}
          </section>
          <section aria-label="Archived unresolved attempts">
            <h4 className="recovery-subheading">Unresolved attempts</h4>
            {run.unresolved.length ? <ul className="record-list">{run.unresolved.map((attempt) => <li key={attempt.checkoutId}><span className="mono">{attempt.checkoutId}</span><strong>Outcome unknown</strong><small>Started {formatTime(attempt.startedAt)} · retained, not resolved by Reset</small></li>)}</ul> : <p className="muted empty-state">No unresolved attempts.</p>}
          </section>
        </div>
        <section className="archived-incidents" aria-label="Archived incident records">
          <h4 className="recovery-subheading">Retained incident records</h4>
          {incidents.length ? <ul className="history-list">{incidents.map((incident, index) => <li key={`${incident.summary}-${index}`}><span>{incident.summary}</span>{incident.sourceReference && <small>Source capture reference · <span className="mono">{incident.sourceReference}</span></small>}</li>)}</ul> : <p className="muted empty-state">No incident records were recorded in this run.</p>}
          <p className="muted archive-health-note">Alarm and agent panels show live observations for the current run only; they are not presented as health for this archived run.</p>
        </section>
        <section className="archived-actions" aria-label="Archived actions">
          <h4 className="recovery-subheading">Action records</h4>
          {actionReferences.length ? <ul className="archived-action-list">{actionReferences.map((reference) => <li key={reference.id}><span>{reference.label}</span><button className="button button-secondary" type="button" onClick={() => void loadAction(reference.id)}>{reference.id}</button></li>)}</ul> : <p className="muted empty-state">No action references were recorded for this run.</p>}
          {selectedActionId && <div className="archived-action-detail" aria-live="polite">
            <div className="card-heading"><h5>Action {selectedActionId}</h5><span className="incident-badge badge-neutral">Read only</span></div>
            {actionLoading && <p className="muted" role="status">Loading action record…</p>}
            {actionError && <p className="action-error" role="alert">{actionError}</p>}
            {selectedAction && <>
              <p><strong>{selectedAction.kind.replaceAll("_", " ")} · {selectedAction.status}</strong></p>
              <dl className="archived-facts"><div><dt>Created</dt><dd>{formatTime(selectedAction.createdAt)}</dd></div><div><dt>Started / finished</dt><dd>{formatTime(selectedAction.startedAt)} · {formatTime(selectedAction.finishedAt)}</dd></div><div><dt>Requests</dt><dd>{selectedAction.requests.length} recorded</dd></div></dl>
              {selectedAction.reset && <dl className="archived-facts reset-action-facts"><div><dt>Fresh product version</dt><dd className="mono">{selectedAction.reset.productVersion}</dd></div><div><dt>Seed quantity</dt><dd>{selectedAction.reset.seedQuantity}</dd></div><div><dt>Run link</dt><dd className="mono">{selectedAction.reset.runId} ← {selectedAction.reset.previousRunId}</dd></div></dl>}
              {selectedAction.error && <p className="action-error" role="status">{selectedAction.error}</p>}
              {selectedAction.requests.length > 0 && <details className="request-details"><summary>Recorded requests</summary><ul className="record-list">{selectedAction.requests.map((request, index) => <li key={`${request.id}-${index}`}><span>{request.kind.replaceAll("_", " ")} · {request.outcome ?? "pending"}</span><strong>{request.durationMs === undefined ? "No duration recorded" : `${request.durationMs} ms`}</strong><small className="mono">{request.requestId ?? request.checkoutId ?? request.id}{request.errorCode ? ` · ${request.errorCode}` : ""}</small></li>)}</ul></details>}
            </>}
          </div>}
        </section>
      </>}
    </section>}
  </>;
}

export function App() {
  const [bearer, setBearer] = useState("");
  const [credentialInput, setCredentialInput] = useState("");
  const [state, setState] = useState<DashboardState>();
  const [alarm, setAlarm] = useState<AlarmResponse>();
  const [alarmReadFailed, setAlarmReadFailed] = useState(false);
  const [investigations, setInvestigations] = useState<InvestigationResponse>();
  const [investigationReadFailedAt, setInvestigationReadFailedAt] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const [lastObservedAt, setLastObservedAt] = useState<string>();
  const [pollFailure, setPollFailure] = useState<string>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [readinessConfirmed, setReadinessConfirmed] = useState(false);
  const [protectiveRestoreConfirmed, setProtectiveRestoreConfirmed] = useState(false);
  const [protectiveRecoveryConfirmed, setProtectiveRecoveryConfirmed] = useState(false);
  const [resetConfirmationOpen, setResetConfirmationOpen] = useState(false);
  const [resetQuietConfirmed, setResetQuietConfirmed] = useState(false);
  const [resetDataConfirmed, setResetDataConfirmed] = useState(false);
  const [resetCheckoutClosedConfirmed, setResetCheckoutClosedConfirmed] = useState(false);
  const [inventoryMemorySelection, setInventoryMemorySelection] = useState<number>();
  const [pendingCommand, setPendingCommand] = useState<PendingCommand>();
  const [pendingConfigurationCommand, setPendingConfigurationCommand] = useState<PendingCommand>();
  const [configurationSubmitting, setConfigurationSubmitting] = useState(false);
  const polling = useRef<number | undefined>(undefined);
  const alarmPolling = useRef<number | undefined>(undefined);
  const investigationPolling = useRef<number | undefined>(undefined);
  const resetPanelHeading = useRef<HTMLHeadingElement>(null);
  const resetStatusHeading = useRef<HTMLHeadingElement>(null);
  const resetTrigger = useRef<HTMLButtonElement>(null);
  const resetFocusTarget = useRef<HTMLInputElement>(null);
  const resetConfirmationWasOpen = useRef(false);
  const sessionEpoch = useRef(0);
  const requestEpoch = useRef(0);

  const loadState = useCallback(async () => {
    const epoch = sessionEpoch.current;
    if (!bearer || polling.current === epoch) return;
    polling.current = epoch;
    try {
      const response = await fetch("/api/state", { headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(8_000) });
      const body = await readDashboard(response);
      if (epoch === sessionEpoch.current) {
        setState(body);
        setLastObservedAt(body.observedAt);
        const visibleActionIds = [body.currentAction?.id, body.currentConfigurationAction?.id];
        setPendingCommand((pending) => pending && visibleActionIds.includes(pending.id) ? undefined : pending);
        setPendingConfigurationCommand((pending) => pending && visibleActionIds.includes(pending.id) ? undefined : pending);
        setPollFailure(undefined);
      }
    } catch (error) {
      if (epoch === sessionEpoch.current) setPollFailure(error instanceof Error ? error.message : "The controller could not be read");
    } finally {
      if (polling.current === epoch) polling.current = undefined;
    }
  }, [bearer]);

  const loadAlarm = useCallback(async () => {
    const epoch = sessionEpoch.current;
    if (!bearer || alarmPolling.current === epoch) return;
    alarmPolling.current = epoch;
    try {
      const response = await fetch("/api/alarm", { headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(8_000) });
      const body = await readAlarm(response);
      if (epoch === sessionEpoch.current) { setAlarm(body); setAlarmReadFailed(false); }
    } catch {
      if (epoch === sessionEpoch.current) setAlarmReadFailed(true);
    } finally {
      if (alarmPolling.current === epoch) alarmPolling.current = undefined;
    }
  }, [bearer]);

  const loadInvestigations = useCallback(async () => {
    const epoch = sessionEpoch.current;
    if (!bearer || investigationPolling.current === epoch) return;
    investigationPolling.current = epoch;
    try {
      const response = await fetch("/api/investigations", { headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(8_000) });
      const body = await readInvestigations(response);
      if (epoch === sessionEpoch.current) { setInvestigations(body); setInvestigationReadFailedAt(undefined); }
    } catch {
      if (epoch === sessionEpoch.current) setInvestigationReadFailedAt(new Date().toISOString());
    } finally {
      if (investigationPolling.current === epoch) investigationPolling.current = undefined;
    }
  }, [bearer]);

  const currentAction = state?.currentAction;
  const configurationAction = state?.currentConfigurationAction;
  const resetRequired = state?.resetRequired === true;
  const resetAction = currentAction?.kind === "reset" ? currentAction
    : configurationAction?.kind === "reset" ? configurationAction : undefined;
  const resetInProgress = Boolean(resetAction && activeStatuses.has(resetAction.status));
  const recoveryAction = configurationAction?.kind === "recover" ? configurationAction : undefined;
  const currentStatus = currentAction?.status ?? "idle";
  const trafficActive = currentAction?.kind === "traffic" && activeStatuses.has(currentStatus);
  const anyPendingCommand = Boolean(pendingCommand || pendingConfigurationCommand);
  const actionBusy = loading || !state || anyPendingCommand || Boolean(currentAction && activeStatuses.has(currentStatus)) || currentStatus === "incomplete";
  const configurationBusy = loading || anyPendingCommand || Boolean(configurationAction && activeStatuses.has(configurationAction.status)) || configurationAction?.status === "incomplete";
  const restoreBusy = configurationBusy || Boolean(currentAction && activeStatuses.has(currentStatus) && currentAction.kind !== "traffic");
  const nonTrafficActionBusy = Boolean(currentAction && currentAction.kind !== "traffic" &&
    (activeStatuses.has(currentStatus) || currentStatus === "incomplete"));
  const baseline = state?.baseline;
  const incident = state?.incident;
  const aliasIncident = incident?.mechanism === "lambda-alias" ? incident : undefined;
  const legacyIncident = incident && incident.mechanism !== "lambda-alias" ? incident : undefined;
  const checkpoint = configurationAction?.configurationCheckpoint ?? incident?.checkpoint;
  const baselineInventory = inventoryVersionObservation(baseline?.settings?.inventory);
  const baselineAlias: InventoryAliasObservation | undefined = baselineInventory ? {
    functionName: "IncidentTriageDemoInventory",
    aliasName: "live",
    aliasArn: baselineInventory.aliasArn,
    functionVersion: baselineInventory.version,
    revisionId: baselineInventory.aliasRevision ?? "unknown",
    routingWeighted: false,
    observedAt: baselineInventory.observedAt ?? baseline?.verifiedAt ?? "",
  } : undefined;
  const aliasUnknown = state?.inventoryAliasUnknown === true || aliasIncident?.active === "unknown";
  const inventoryDisplay = currentInventoryDisplay({ baselineAlias, baselineInventory, aliasIncident, recoveryAction, unknown: aliasUnknown });
  const { currentAlias, currentVariant, targetVariant } = inventoryDisplay;
  const currentAccess = inventoryDisplay.access;
  const currentAliasStatus = aliasStatus(currentAlias, currentVariant, Boolean(baseline), currentAccess);
  const currentMemoryMb = aliasUnknown ? undefined : currentVariant?.memoryMb ?? baselineInventory?.memory;
  const inventoryMemoryChoices = inventoryMemoryOptions(baseline?.settings?.inventoryVariantsManifest, baseline?.appRevision,
    baseline?.settings?.inventoryRoleArn, baseline?.settings?.inventoryDeniedRoleArn);
  const selectedMemoryMb = inventoryMemorySelection ?? currentMemoryMb;
  const incidentActive = Boolean(aliasIncident && aliasIncident.active !== "healthy");
  const baselineAccessObservation = isRecord(baseline?.settings?.inventoryAccessPolicy) ? baseline.settings.inventoryAccessPolicy : undefined;
  const policyObservation = aliasIncident?.policy ?? baselineAccessObservation;
  const inventoryRoleArn = currentAccess === "denied"
    ? display(aliasIncident?.target.roleArn ?? baselineInventory?.role, "Not observed")
    : currentAccess === "healthy" ? display(baselineInventory?.role ?? baseline?.settings.inventoryRoleArn, "Not observed") : "Unknown";
  const trafficStartAllowed = !incidentActive && !resetRequired && !resetInProgress;
  const restoreCheckpoint = configurationAction?.kind === "restore_inventory_access"
    ? configurationAction.configurationCheckpoint : aliasIncident?.checkpoint;
  const needsProtectiveRestore = restoreCheckpoint?.status === "unavailable" || restoreCheckpoint?.status === "incomplete";
  const recoveryCaptureGap = Boolean(recoveryAction && ["failed", "incomplete", "discarded"].includes(recoveryAction.status) &&
    ["unavailable", "incomplete"].includes(recoveryAction.configurationCheckpoint?.status ?? ""));
  const recoverDisabled = !state || resetRequired || configurationBusy || nonTrafficActionBusy ||
    !state.originalBaseline || !readinessConfirmed || (recoveryCaptureGap && !protectiveRecoveryConfirmed);
  const selectedMemoryIsPrepared = selectedMemoryMb !== undefined && inventoryMemoryChoices.includes(selectedMemoryMb);
  const memorySelectionUnavailable = !baseline ? "Check readiness to load verified Inventory memory choices."
    : aliasUnknown ? "Inventory memory is unknown until the alias is read back."
      : inventoryMemoryChoices.length === 0 ? "No verified Inventory memory choices are available for this release."
        : undefined;
  const memorySelectionDisabled = resetRequired || actionBusy || configurationBusy || Boolean(legacyIncident) || Boolean(memorySelectionUnavailable) ||
    currentMemoryMb === undefined || !selectedMemoryIsPrepared || (selectedMemoryMb !== undefined && selectedMemoryMb < currentMemoryMb);
  const incompleteAction = currentAction?.status === "incomplete" ? currentAction
    : configurationAction?.status === "incomplete" ? configurationAction : undefined;
  const incompleteActionMustBeDiscarded = Boolean(incompleteAction);
  const resetDisabled = loading || anyPendingCommand || configurationBusy || incompleteActionMustBeDiscarded ||
    Boolean(currentAction && currentAction.kind !== "traffic" && activeStatuses.has(currentAction.status));
  const resetAcknowledged = resetQuietConfirmed && resetDataConfirmed && resetCheckoutClosedConfirmed;
  const resetStatusText = resetAction?.status === "queued" ? "Reset accepted · waiting to start"
    : resetAction?.status === "draining" ? "Stopping traffic and draining accepted work"
      : resetAction?.status === "running" ? "Reset running"
        : resetAction?.status === "completed" ? "Reset completed"
          : resetAction?.status === "incomplete" ? "Reset incomplete"
            : resetAction?.status === "failed" ? "Reset failed"
              : resetAction?.status === "discarded" ? "Reset discarded · a new confirmation is required"
                : undefined;
  const resetPhaseText = resetAction?.reset?.phase ? ({
    stopping: "Stopping demo traffic",
    draining: "Draining accepted requests",
    validating: "Checking the current release",
    capturing: "Saving incident observations",
    restoring: "Restoring healthy settings",
    seeding: "Seeding the fresh product version",
    deleting: "Removing prior orders",
    verifying: "Verifying the new run",
    verified: "Fresh business verification recorded",
  } as const)[resetAction.reset.phase] : undefined;
  const dashboardAgeMs = lastObservedAt ? Date.now() - Date.parse(lastObservedAt) : Number.POSITIVE_INFINITY;
  const dashboardFreshness = pollFailure ? "Refresh failed" : !state ? "Loading cloud state"
    : !Number.isFinite(dashboardAgeMs) || dashboardAgeMs >= 15_000 ? "Stale cloud state" : "Cloud state current";
  const alarmObservation = alarm?.alarm;
  const selectedTransition = normalizedTime(alarmObservation?.stateTransitionedAt);
  const exactObservedAlarmRun = alarmObservation?.state === "ALARM" && alarmObservation.arn && selectedTransition
    ? investigations?.runs.find((run) => run.alarmArn === alarmObservation.arn && normalizedTime(run.transitionAt) === selectedTransition)
    : undefined;
  const investigationAgeMs = investigations ? Date.now() - Date.parse(investigations.observedAt) : Number.POSITIVE_INFINITY;
  const investigationFreshness = !investigations ? investigationReadFailedAt ? "Unavailable" : "Loading"
    : !Number.isFinite(investigationAgeMs) || investigationAgeMs >= 10_000 ? "Stale"
      : investigationReadFailedAt ? "Refresh failed · showing last observation" : "Fresh";
  const olderInvestigations = investigations?.runs.filter((run) => run !== exactObservedAlarmRun) ?? [];
  const endpointStateLabel = alarm?.agentEndpoint?.state === "ready" ? "Ready"
    : alarm?.agentEndpoint?.state === "not_ready" ? "Not ready"
      : alarm?.agentEndpoint?.state === "unavailable" ? "Unavailable"
        : alarm?.agentEndpoint?.state === "unconfigured" ? "Not configured" : "Unknown";
  const bindingStateLabel = alarm?.alarmBinding?.state === "bound" ? "Bound"
    : alarm?.alarmBinding?.state === "disabled" ? "Disabled"
    : alarm?.alarmBinding?.state === "missing" ? "Missing"
      : alarm?.alarmBinding?.state === "unexpected" ? "Unexpected action"
        : alarm?.alarmBinding?.state === "unavailable" ? "Unavailable"
          : alarm?.alarmBinding?.state === "unconfigured" ? "Not configured" : "Unknown";
  const retainedAlarm = aliasIncident?.checkpoint?.alarm ?? checkpoint?.alarm;
  const configurationObservation = currentConfigurationObservation(
    currentAction?.kind === "activate_inventory_denial" ? currentAction : undefined,
    configurationAction?.kind === "reset" ? undefined : configurationAction,
  );
  const deniedCheckout = currentAction?.kind === "activate_inventory_denial"
    ? currentAction.requests.find(({ kind, dependencyReason }) => kind === "checkout" && dependencyReason === "inventory_access_denied")
    : undefined;
  const requestImpact = configurationObservation
    ? configurationObservation.requests.reduce((summary, request) => {
      summary[request.kind] = (summary[request.kind] ?? 0) + 1;
      return summary;
    }, {} as Record<string, number>)
    : {};
  const switchObservation = configurationObservation?.inventorySwitch;
  const switchBefore = switchObservation?.before ?? aliasIncident?.aliasBefore;
  const switchAfter = switchObservation?.after ?? aliasIncident?.alias;
  const switchTarget = switchObservation?.target ?? aliasIncident?.target;

  const sendAction = useCallback(async (id: string, command: Command) => {
    const epoch = sessionEpoch.current;
    const callNumber = requestEpoch.current + 1;
    requestEpoch.current = callNumber;
    const isConfiguration = command.kind === "reset" || command.kind === "restore_inventory_access" || command.kind === "increase_memory" || command.kind === "recover";
    const setPending = isConfiguration ? setPendingConfigurationCommand : setPendingCommand;
    if (isConfiguration) setConfigurationSubmitting(true);
    else setLoading(true);
    setNotice(undefined);
    setMenuOpen(false);
    setPending({ id, command });
    try {
      const response = await fetch(`/api/actions/${id}`, { method: "PUT", headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(command), signal: AbortSignal.timeout(8_000) });
      const body = await readJson(response);
      const action = body.action as Action | undefined;
      if (!action || action.id !== id) throw new Error("The controller did not acknowledge this command");
      if (epoch === sessionEpoch.current && response.status === 202 && activeStatuses.has(action.status)) {
        setState((previous) => previous && (isConfiguration ? { ...previous, currentConfigurationAction: action } : { ...previous, currentAction: action }));
      }
      if (epoch === sessionEpoch.current) {
        setPending(undefined);
        if (command.kind === "readiness" || command.kind === "recover") setReadinessConfirmed(false);
        if (command.kind === "recover") setProtectiveRecoveryConfirmed(false);
        setNotice({ kind: "success", message: `${String(command.kind)} accepted` });
        setMenuOpen(false);
        await Promise.all([loadState(), loadAlarm()]);
      }
    } catch (error) {
      if (epoch === sessionEpoch.current) {
        if (error instanceof RequestError && error.status < 500) {
          setPending(undefined);
          setNotice({ kind: "error", message: error.message });
        } else setNotice({ kind: "error", message: isConfiguration
          ? "The configuration outcome is unknown. Retry with the same ID."
          : "The command outcome is unknown. Retry with the same ID." });
      }
    } finally {
      if (epoch === sessionEpoch.current && isConfiguration) setConfigurationSubmitting(false);
      if (epoch === sessionEpoch.current && !isConfiguration && requestEpoch.current === callNumber) setLoading(false);
    }
  }, [bearer, loadAlarm, loadState]);

  useEffect(() => { if (!bearer) return undefined; void loadState(); void loadAlarm(); void loadInvestigations(); const interval = window.setInterval(() => { void loadState(); void loadAlarm(); void loadInvestigations(); }, 5_000); return () => window.clearInterval(interval); }, [bearer, loadAlarm, loadInvestigations, loadState]);
  useEffect(() => { setInventoryMemorySelection(currentMemoryMb); }, [baseline?.appRevision, currentMemoryMb]);
  useEffect(() => {
    if (resetConfirmationOpen) {
      resetConfirmationWasOpen.current = true;
      resetFocusTarget.current?.focus();
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.preventDefault();
          setResetConfirmationOpen(false);
          setResetQuietConfirmed(false);
          setResetDataConfirmed(false);
          setResetCheckoutClosedConfirmed(false);
        }
      };
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }
    if (resetConfirmationWasOpen.current) {
      resetConfirmationWasOpen.current = false;
      if (resetTrigger.current?.disabled) {
        if (resetStatusHeading.current) resetStatusHeading.current.focus();
        else resetPanelHeading.current?.focus();
      }
      else resetTrigger.current?.focus();
    }
    return undefined;
  }, [resetConfirmationOpen]);

  const signIn = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const value = credentialInput.trim();
    if (!value || /\s/.test(value)) { setNotice({ kind: "error", message: "Enter the presenter credential to continue." }); return; }
    const epoch = sessionEpoch.current + 1;
    sessionEpoch.current = epoch;
    setLoading(true); setNotice(undefined);
    try {
      const response = await fetch("/api/state", { headers: { Authorization: `Bearer ${value}`, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(8_000) });
      const body = await readDashboard(response);
      if (sessionEpoch.current !== epoch) return;
      setBearer(value); setCredentialInput(""); setState(body); setLastObservedAt(body.observedAt);
    } catch (error) {
      if (sessionEpoch.current === epoch) setNotice({ kind: "error", message: error instanceof Error ? error.message : "The presenter credential was rejected." });
    } finally { if (sessionEpoch.current === epoch) setLoading(false); }
  };
  const signOut = () => { sessionEpoch.current += 1; setBearer(""); setState(undefined); setAlarm(undefined); setAlarmReadFailed(false); setInvestigations(undefined); setInvestigationReadFailedAt(undefined); setPendingCommand(undefined); setPendingConfigurationCommand(undefined); setConfigurationSubmitting(false); setInventoryMemorySelection(undefined); setReadinessConfirmed(false); setProtectiveRestoreConfirmed(false); setProtectiveRecoveryConfirmed(false); setResetConfirmationOpen(false); setResetQuietConfirmed(false); setResetDataConfirmed(false); setResetCheckoutClosedConfirmed(false); setLastObservedAt(undefined); setPollFailure(undefined); setNotice(undefined); setLoading(false); };
  const runReadiness = () => { if (!resetRequired && readinessConfirmed) void sendAction(crypto.randomUUID(), { kind: "readiness", confirmQuiet: true }); };
  const runTraffic = () => { if (!resetRequired && !resetInProgress && trafficStartAllowed) void sendAction(crypto.randomUUID(), { kind: "traffic" }); };
  const runActivation = () => { if (!resetRequired && readinessConfirmed) void sendAction(crypto.randomUUID(), { kind: "activate_inventory_denial" }); };
  const runRestore = () => { if (!resetRequired && aliasIncident && !restoreBusy && (!needsProtectiveRestore || protectiveRestoreConfirmed)) void sendAction(crypto.randomUUID(), needsProtectiveRestore ? { kind: "restore_inventory_access", restoreWithoutEvidence: true } : { kind: "restore_inventory_access" }); };
  const runRecovery = () => {
    if (recoverDisabled || !readinessConfirmed) return;
    void sendAction(crypto.randomUUID(), {
      kind: "recover",
      confirmQuiet: true,
      ...(recoveryCaptureGap && protectiveRecoveryConfirmed ? { recoverWithoutEvidence: true as const } : {}),
    });
  };
  const runMemorySelection = () => {
    if (!memorySelectionDisabled && selectedMemoryMb !== undefined) {
      void sendAction(crypto.randomUUID(), { kind: "increase_memory", function: "inventory", memoryMb: selectedMemoryMb });
    }
  };
  const openResetConfirmation = () => {
    if (resetDisabled) return;
    setResetQuietConfirmed(false);
    setResetDataConfirmed(false);
    setResetCheckoutClosedConfirmed(false);
    setResetConfirmationOpen(true);
  };
  const cancelResetConfirmation = () => {
    setResetConfirmationOpen(false);
    setResetQuietConfirmed(false);
    setResetDataConfirmed(false);
    setResetCheckoutClosedConfirmed(false);
  };
  const runReset = () => {
    if (resetDisabled || !resetAcknowledged) return;
    void sendAction(crypto.randomUUID(), {
      kind: "reset",
      confirmQuiet: true,
      confirmReset: true,
      confirmCheckoutClosed: true,
    });
    setResetConfirmationOpen(false);
    setResetQuietConfirmed(false);
    setResetDataConfirmed(false);
    setResetCheckoutClosedConfirmed(false);
  };
  const stopTraffic = () => currentAction && void sendAction(crypto.randomUUID(), { kind: "stop", targetActionId: currentAction.id });
  const discardAction = () => { const target = currentAction?.status === "incomplete" ? currentAction : configurationAction?.status === "incomplete" ? configurationAction : undefined; if (target) void sendAction(crypto.randomUUID(), { kind: "discard", targetActionId: target.id }); };
  const retryPending = (pending: PendingCommand) => void sendAction(pending.id, pending.command);
  const actionLabel = currentAction ? `${currentAction.kind} · ${currentAction.status}` : resetAction ? `${resetAction.kind} · ${resetAction.status}` : "No action running";

  if (!bearer) return (
    <main className="controller-shell controller-sign-in"><section className="sign-in-card" aria-labelledby="sign-in-title">
      <div className="brand-mark" aria-hidden="true">IT</div><p className="eyebrow">Incident triage demo</p><h1 id="sign-in-title">Failure controller</h1>
      <p className="muted">Sign in to inspect the shared cloud run and control healthy demo traffic.</p>
      <form onSubmit={signIn}><label htmlFor="controller-credential">Presenter credential</label><input id="controller-credential" type="password" value={credentialInput} onChange={(event) => setCredentialInput(event.target.value)} autoComplete="off" autoFocus /><button className="button button-primary" type="submit" disabled={loading}>{loading ? "Checking…" : "Sign in"}</button></form>
      {notice && <p className="notice notice-error" role="alert">{notice.message}</p>}
    </section></main>
  );

  return (
    <main className="controller-shell" aria-label="Incident triage failure controller">
      <header className="topbar"><div className="brand"><div className="brand-mark" aria-hidden="true">IT</div><div><p className="eyebrow">Incident triage demo</p><h1>Failure controller</h1></div></div><div className="top-actions"><span className={`connection-pill ${pollFailure || dashboardFreshness.includes("Stale") ? "connection-stale" : ""}`} role="status"><span className="status-dot" aria-hidden="true" /> {dashboardFreshness}</span><button className="button button-secondary" type="button" onClick={signOut}>Sign out</button></div></header>
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Current action</p><h2>{actionLabel}</h2>{currentAction && <p className="mono muted compact">{currentAction.id}</p>}
          <p className="muted">Last observation {formatTime(lastObservedAt)}{pollFailure ? ` · ${pollFailure}` : ""}</p>
          {currentAction?.startedAt && <p className="muted">Started {formatTime(currentAction.startedAt)}{currentAction.finishedAt ? ` · Ended ${formatTime(currentAction.finishedAt)}` : ""}</p>}
          {currentAction?.error && <p className="action-error" role="alert">{currentAction.error}</p>}
            {resetAction?.error && resetAction.id !== currentAction?.id && <p className="action-error" role="alert">{resetAction.error}</p>}
          {resetRequired && <p className="reset-required-message" role="alert">This run is not usable. Ordinary actions stay blocked until a new Reset completes; discarding an incomplete action does not clear this requirement.</p>}
          {resetStatusText && <div className={`reset-progress reset-progress-${resetAction?.status}`} role="status">
            <h3 ref={resetStatusHeading} tabIndex={-1}>Reset progress</h3>
            <strong>{resetStatusText}</strong>
            {resetPhaseText && <p>Current step: {resetPhaseText}.</p>}
            {resetAction?.status === "draining" && !resetPhaseText && <p>Traffic is stopping; accepted requests are being drained before business data changes.</p>}
            {resetAction?.status === "queued" && <p>The request is recorded. Reset is not complete while its status is pending.</p>}
            {resetAction?.status === "running" && <p>Reset is running. The run remains blocked until fresh business verification finishes.</p>}
            {resetAction?.status === "completed" && !resetRequired && <p>Run {display(state?.runId)} is ready. The verification checkout is part of this run; traffic remains stopped.</p>}
            {resetAction?.status === "completed" && resetRequired && <p>The action reports completion, but the current state still requires Reset. Ordinary actions remain blocked.</p>}
            {resetAction?.status === "incomplete" && <p>This Reset cannot resume. Wait for prior work to stop, discard this incomplete action, then confirm a new Reset with a fresh action ID.</p>}
            {resetAction?.status === "failed" && <p>Reset did not establish a usable run. Confirm a new Reset after prior work has stopped.</p>}
            {resetAction?.startedAt && <p>Reset started {formatTime(resetAction.startedAt)}{resetAction.finishedAt ? ` · ended ${formatTime(resetAction.finishedAt)}` : ""}</p>}
            {resetAction && <p className="mono">Action {resetAction.id}</p>}
            {resetAction?.reset && <p className="mono">Run {resetAction.reset.runId} · product version {resetAction.reset.productVersion} · seed {resetAction.reset.seedQuantity}</p>}
          </div>}
          {incompleteAction && <p className="muted">Discard available after {formatTime(new Date(incompleteAction.discardAfter).toISOString())}</p>}
          <label className="quiet-check"><input type="checkbox" checked={readinessConfirmed} onChange={(event) => setReadinessConfirmed(event.target.checked)} /> I confirm other checkout writers are paused.</label>
          {!state?.originalBaseline && <p className="muted recovery-readiness-hint" role="status">Check readiness to establish the original healthy settings before recovery.</p>}
          {recoveryCaptureGap && <label className="quiet-check recovery-protective-check">
            <input type="checkbox" checked={protectiveRecoveryConfirmed} onChange={(event) => setProtectiveRecoveryConfirmed(event.target.checked)} />
            The last Recover could not capture current settings. Allow a protective retry and keep the evidence gap visible.
          </label>}
        </div>
        <div className="action-controls">
          <button className="button button-primary" type="button" onClick={runReadiness} disabled={resetRequired || actionBusy || configurationBusy || !readinessConfirmed}>Check readiness</button>
          <button className="button button-secondary" type="button" onClick={runTraffic} disabled={resetRequired || actionBusy || !baseline || !trafficStartAllowed}>Start healthy traffic</button>
          {trafficActive && <button className="button button-stop" type="button" onClick={stopTraffic} disabled={loading || Boolean(pendingCommand) || currentStatus === "draining"}>Stop traffic</button>}
          {(currentAction?.status === "incomplete" || configurationAction?.status === "incomplete") && <button className="button button-secondary" type="button" onClick={discardAction} disabled={loading || anyPendingCommand || Date.now() < (currentAction?.status === "incomplete" ? currentAction.discardAfter : configurationAction!.discardAfter)}>Discard action</button>}
          <div className="menu-wrap">
            <button className="button button-secondary" type="button" aria-haspopup="true" aria-expanded={menuOpen} aria-controls="controller-actions" onClick={() => setMenuOpen((open) => !open)}>Actions <span className="chevron" aria-hidden="true" /></button>
            {menuOpen && <div className="actions-menu" id="controller-actions" role="group" aria-label="Controller actions">
              <button type="button" onClick={runReadiness} disabled={resetRequired || actionBusy || configurationBusy || !readinessConfirmed}>Check readiness</button>
              <button type="button" onClick={runTraffic} disabled={resetRequired || actionBusy || !baseline || !trafficStartAllowed}>Start healthy traffic</button>
              <button type="button" onClick={runRecovery} disabled={recoverDisabled}>Recover</button>
              <button type="button" onClick={runActivation} disabled={resetRequired || actionBusy || configurationBusy || incidentActive || !baseline || !readinessConfirmed}>Activate Inventory denial</button>
              {!legacyIncident && <button type="button" onClick={runRestore} disabled={resetRequired || !aliasIncident || restoreBusy || (needsProtectiveRestore && !protectiveRestoreConfirmed)}>Restore Inventory access</button>}
              <section className="memory-picker" aria-label="Inventory memory selection">
                <label htmlFor="inventory-memory-selection">Inventory memory</label>
                <select id="inventory-memory-selection" value={selectedMemoryMb ?? ""}
                  disabled={resetRequired || Boolean(memorySelectionUnavailable) || configurationBusy || actionBusy}
                  onChange={(event) => setInventoryMemorySelection(event.target.value ? Number(event.target.value) : undefined)}>
                  {inventoryMemoryChoices.length === 0
                    ? <option value="">No verified choices</option>
                    : inventoryMemoryChoices.map((memoryMb) => <option key={memoryMb} value={memoryMb}
                      disabled={currentMemoryMb !== undefined && memoryMb < currentMemoryMb}>
                      {memoryMb} MB{memoryMb === currentMemoryMb ? " · current" : ""}
                    </option>)}
                </select>
                <p className="muted" role="status">{memorySelectionUnavailable ??
                  `Current memory ${display(currentMemoryMb)} MB · verified for app revision ${display(baseline?.appRevision)} at ${formatTime(baseline?.verifiedAt)}.`}</p>
                <button className="memory-select-button" type="button" onClick={runMemorySelection} disabled={memorySelectionDisabled}>
                  Select memory
                </button>
              </section>
              <button type="button" onClick={stopTraffic} disabled={!trafficActive || loading || Boolean(pendingCommand) || currentStatus === "draining"}>Stop traffic</button>
            </div>}
          </div>
        </div>
      </section>
      {state && <RunHistoryPanel currentRunId={state.runId} previousRunId={state.previousRunId} currentResetRequired={resetRequired} bearer={bearer} />}
      <section className="card reset-card" aria-label="Reset demo data">
        <div className="card-heading">
          <div><p className="eyebrow">New demo session</p><h3 ref={resetPanelHeading} tabIndex={-1}>Reset business data</h3></div>
          <button ref={resetTrigger} className="button button-danger" type="button" onClick={openResetConfirmation} disabled={resetDisabled}>
            {resetRequired ? "Start a new Reset" : "Reset demo"}
          </button>
        </div>
        <p className="muted">Reset stops and drains scripted traffic, restores the current release’s healthy settings, replaces disposable orders, and verifies a fresh run. Prior session receipts and incident/source history remain available above.</p>
        {incompleteActionMustBeDiscarded && <p className="notice notice-warning" role="status">Discard the incomplete action after its drain window before starting another Reset. Discarding keeps Reset required; it does not make this run usable.</p>}
        {resetRequired && <p className="reset-required-message" role="status">The current run stays blocked until a newly confirmed Reset completes. A completed or discarded earlier action cannot clear this requirement.</p>}
        {resetAction?.status === "incomplete" && <p className="reset-required-message" role="status">Do not resume this Reset with its old action ID. After prior work has stopped and the action is discarded, confirm another Reset to create a fresh run and product version.</p>}
        {resetAction?.status === "completed" && !resetRequired && <p className="notice notice-success" role="status">Reset completed. The new run is usable with its verified baseline; scripted traffic remains stopped.</p>}
        {resetConfirmationOpen && <section className="reset-confirmation" aria-labelledby="reset-confirmation-title">
          <h4 id="reset-confirmation-title" tabIndex={-1}>Confirm destructive Reset</h4>
          <p>Reset will stop demo traffic, drain accepted work, seed the product at 1,000 units with a fresh version, delete prior Orders, and make one verification order that leaves 999 units. Close old checkout pages first so they cannot submit stale product versions.</p>
          <p className="muted">The previous run’s baseline, receipts, unresolved attempts, incident/source pointers, and action records are retained in read-only history.</p>
          <fieldset className="reset-acknowledgements">
            <legend>Confirm the required conditions</legend>
            <label><input ref={resetFocusTarget} type="checkbox" checked={resetQuietConfirmed} onChange={(event) => setResetQuietConfirmed(event.target.checked)} /> I have paused other checkout writers; Reset will stop demo traffic and drain accepted work.</label>
            <label><input type="checkbox" checked={resetDataConfirmed} onChange={(event) => setResetDataConfirmed(event.target.checked)} /> I understand Reset reseeds demo-widget to 1000 units under a fresh product version and deletes previous Orders. Its verification checkout leaves 999 units.</label>
            <label><input type="checkbox" checked={resetCheckoutClosedConfirmed} onChange={(event) => setResetCheckoutClosedConfirmed(event.target.checked)} /> I have closed old checkout pages so they cannot submit old product version.</label>
          </fieldset>
          <div className="reset-confirmation-actions">
            <button className="button button-danger" type="button" onClick={runReset} disabled={resetDisabled || !resetAcknowledged}>Confirm Reset</button>
            <button className="button button-secondary" type="button" onClick={cancelResetConfirmation}>Cancel</button>
          </div>
        </section>}
      </section>
      {notice && <p className={`notice notice-${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.message}</p>}
      {pendingCommand && !loading && <div className="notice notice-error" role="status">
        <span>Command outcome unknown. Retry with the original ID.</span>
        <button className="inline-action" type="button" onClick={() => retryPending(pendingCommand)} disabled={loading}>Retry {pendingCommand.command.kind}</button>
      </div>}
      {pendingConfigurationCommand && !configurationSubmitting && <div className="notice notice-error" role="status">
        <span>Configuration outcome unknown. Retry with the original ID.</span>
        <button className="inline-action" type="button" onClick={() => retryPending(pendingConfigurationCommand)} disabled={loading || configurationSubmitting}>Retry {pendingConfigurationCommand.command.kind}</button>
      </div>}
      {pollFailure && <p className="notice notice-error" role="alert">{pollFailure}. The last good cloud observation remains visible.</p>}
      {recoveryAction && state && <RecoveryPanel action={recoveryAction} state={state}
        trafficAction={currentAction?.kind === "traffic" ? currentAction : undefined}
        currentAlias={currentAlias} currentMemoryMb={currentMemoryMb} currentAccess={currentAccess} />}
      <section className="incident-controls card" aria-label="Inventory denial controls">
        <div className="card-heading">
          <div><p className="eyebrow">Prepared version control</p><h3>Inventory access state</h3></div>
          <span className={`incident-badge ${incidentActive ? "badge-warning" : "badge-neutral"}`}>
            {aliasIncident?.active === "unknown" ? "State unknown" : incidentActive ? "Denial active" : legacyIncident ? "Legacy record · read only" : aliasIncident ? "Access restored" : baseline ? "Ready" : "Unready"}
          </span>
        </div>
        <div className="incident-grid">
          <div>
            <span className="fact-label">Current alias</span>
            <strong>{display(currentAlias?.aliasName, "Unknown")}</strong>
            <small>{display(currentAlias?.functionName, "Inventory function")} · revision {display(currentAlias?.revisionId ?? baselineInventory?.aliasRevision, "unknown")} · {currentAliasStatus}</small>
          </div>
          <div>
            <span className="fact-label">Current version</span>
            <strong>{display(currentAlias?.functionVersion ?? baselineInventory?.version, "Unknown")}</strong>
            <small>{accessLabel(currentAccess)} · {display(currentAlias?.observedAt ?? baselineInventory?.observedAt, "No observation")}</small>
          </div>
          <div>
            <span className="fact-label">Role</span>
            <strong>{accessLabel(currentAccess)}</strong>
            <small className="mono">{inventoryRoleArn}</small>
          </div>
          <div>
            <span className="fact-label">Configuration result</span>
            <strong>{resultLabel(configurationObservation?.configurationOutcome)}</strong>
            <small>{configurationObservation?.id ?? "No alias action"}</small>
          </div>
        </div>
        <dl className="facts">
          <div><dt>Target version</dt><dd className="mono">{display(switchTarget?.version, "No target")}</dd></div>
          <div><dt>Target memory</dt><dd>{switchTarget ? `${display(switchTarget.memoryMb)} MB` : "No target"}</dd></div>
          <div><dt>Current memory</dt><dd>{aliasUnknown ? "Unknown" : currentMemoryMb === undefined ? "Not observed" : `${currentMemoryMb} MB`}</dd></div>
          <div><dt>Target access</dt><dd>{accessLabel(switchTarget?.access)}</dd></div>
          <div><dt>Target role ARN</dt><dd className="mono">{display(switchTarget?.roleArn, "No target")}</dd></div>
          <div><dt>Current alias ARN</dt><dd className="mono">{display(currentAlias?.aliasArn, "Not observed")}</dd></div>
          <div><dt>Checkpoint</dt><dd>{display(checkpoint?.status, "Not captured")}</dd></div>
          <div><dt>Request impact</dt><dd>{configurationObservation ? `${display(requestImpact.catalog, "0")} catalog · ${display(requestImpact.checkout, "0")} checkout` : "No configuration request"}</dd></div>
        </dl>
        {policyObservation && <dl className="facts readonly-policy">
          <div><dt>Prepared policy</dt><dd className="mono">{display(policyObservation.policyName, "Not observed")}</dd></div>
          <div><dt>Policy state</dt><dd>{display(policyObservation.state, "unknown")}</dd></div>
        </dl>}
        {configurationObservation && configurationObservation.kind !== "recover" && <div className="configuration-result" aria-label="Configuration result details">
          <p><strong>{resultLabel(configurationObservation.configurationOutcome)}</strong> · {configurationObservation.kind === "activate_inventory_denial" ? "Denial activation" : configurationObservation.kind === "increase_memory" ? "Memory selection" : "Access restore"} · {configurationObservation.status}</p>
          <p className="muted">Alias {display(switchBefore?.functionVersion, "unknown")} → {display(switchTarget?.version, "unknown")} {switchAfter ? `· read back ${switchAfter.functionVersion}` : "· awaiting readback"}; {configurationObservation.kind === "activate_inventory_denial" ? "bounded request observations are shown separately below" : configurationObservation.kind === "increase_memory" ? "memory selection sends no app probes" : "restore sends no app probes"}.</p>
        </div>}
        {legacyIncident && <p className="muted">This persisted {legacyIncident.mechanism === "iam-managed-policy" ? "IAM" : "DynamoDB table-policy"} incident remains visible for history only. Prepared-version controls do not mutate or restore it.</p>}
        {aliasIncident && incidentActive && needsProtectiveRestore && <label className="quiet-check protective-check">
          <input type="checkbox" checked={protectiveRestoreConfirmed} onChange={(event) => setProtectiveRestoreConfirmed(event.target.checked)} />
          Evidence capture is unavailable. Allow protective restore of the recorded alias state.
        </label>}
        {configurationAction?.kind !== "recover" && configurationAction?.error && <p className="action-error" role="alert">{configurationAction.error}</p>}
      </section>
      <section className="summary-grid" aria-label="Run summary"><article className="card"><p className="eyebrow">Last verified health</p><dl className="facts"><div><dt>App revision</dt><dd className="mono">{display(baseline?.appRevision, "Not verified")}</dd></div><div><dt>Product</dt><dd>{display(baseline?.sku, "Not verified")}</dd></div><div><dt>Product version</dt><dd className="mono">{display(baseline?.productVersion, "Not verified")}</dd></div></dl></article><article className="card stock-card"><p className="eyebrow">Inventory</p><strong className="stock-value">{resetRequired ? "—" : display(state?.latestStock ?? baseline?.stockAfter, "—")}</strong><p className="muted">{resetRequired ? "Current run is unusable; stock is not shown as verified." : `units · observed ${formatTime(state?.latestStockAt)}`}</p></article><article className="card"><p className="eyebrow">Readiness order</p><p className="mono compact">{display(baseline?.checkoutId, "No verification order")}</p><p className="muted">{resetRequired ? "Reset required; this run has no verified order." : baseline ? `${display(baseline.stockBefore)} → ${display(baseline.stockAfter)} units · verified ${formatTime(baseline.verifiedAt)}` : "A verified order will establish the baseline."}</p></article></section>
      <section className="traffic-grid" aria-label="Traffic progress">{(["catalog", "checkout"] as const).map((profile) => { const value = currentAction?.traffic?.[profile]; return <article className="card traffic-card" key={profile}><div className="card-heading"><div><p className="eyebrow">{profile} traffic</p><h3>{profile === "catalog" ? "Catalog reads" : "Checkout posts"}</h3></div></div><div className="metric-row">{([["submitted", "sent"], ["completed", "settled"], ["succeeded", "succeeded"], ["skipped", "skipped"], ["inFlight", "in flight"]] as const).map(([field, label]) => <div key={field}><strong>{display(value?.[field], "0")}</strong><span>{label}</span></div>)}</div></article>; })}</section>
      {currentAction?.requests.length ? <details className="card request-details"><summary>Recent requests for this action</summary><ul className="record-list">{currentAction.requests.slice(-10).reverse().map((request) => <li key={request.id}><span>{request.kind.replace("_", " ")} · {request.outcome ?? "pending"}</span><strong>{request.durationMs === undefined ? "In progress" : `${request.durationMs} ms`}</strong><small className="mono">{request.requestId ?? "No app request ID"}{request.errorCode ? ` · ${request.errorCode}` : ""}{request.dependencyReason ? ` · ${request.dependencyReason}` : ""}</small></li>)}</ul></details> : null}
      <section className="monitor-grid" aria-label="Monitoring observations">
        <article className="card alarm-card">
          <div className="card-heading">
            <div><p className="eyebrow">Native stage alarm</p><h3>{display(alarmObservation?.name, "IncidentTriageDemoAppStage5xx")}</h3></div>
            <span className={`alarm-state ${alarmTone(alarmObservation?.state)}`}>{display(alarmObservation?.state, "UNKNOWN")}</span>
          </div>
          <p className="alarm-reason">{display(alarmObservation?.reason, "No alarm state observed")}</p>
          <dl className="observation-facts">
            <div><dt>Transition</dt><dd>{formatTime(alarmObservation?.stateTransitionedAt)}</dd></div>
            <div><dt>State update</dt><dd>{formatTime(alarmObservation?.stateUpdatedAt)}</dd></div>
            <div><dt>Observed</dt><dd>{formatTime(alarmObservation?.observedAt)} · {freshness(alarmObservation?.observedAt)}</dd></div>
            <div><dt>Agent endpoint</dt><dd>{endpointStateLabel}{alarm?.agentEndpoint?.liveVersion ? ` · live v${alarm.agentEndpoint.liveVersion}` : ""}</dd></div>
            <div><dt>Alarm adapter</dt><dd>{bindingStateLabel}</dd></div>
          </dl>
          {alarm?.agentEndpoint?.failureReason && <p className="muted readiness-reason">{alarm.agentEndpoint.failureReason}</p>}
          {alarmReadFailed && <p className="muted" role="status">Alarm refresh failed. Showing the last observation if available.</p>}
          {retainedAlarm && <p className="retained-observation">
            Retained checkpoint alarm <strong>{retainedAlarm.state}</strong>
            {" · "}transition {formatTime(retainedAlarm.stateTransitionedAt)}
            {" · "}observed {formatTime(retainedAlarm.observedAt)}
          </p>}
        </article>
        <article className="card outcome-card">
          <div className="card-heading"><div><p className="eyebrow">Incident outcome</p><h3>Request observations</h3></div></div>
          <p>{deniedCheckout
            ? `Checkout returned HTTP ${display(deniedCheckout.statusCode, "unknown")} · ${display(deniedCheckout.dependencyReason, "Inventory dependency failure")}`
            : "No Inventory-denied checkout request observed in the current action"}</p>
          {deniedCheckout?.requestId && <p className="mono compact">{deniedCheckout.requestId}</p>}
          <p className="muted">{state?.unresolved?.length
            ? `${state.unresolved.length} unresolved checkout attempts`
            : "No unresolved checkout attempts"}</p>
        </article>
      </section>
      <section className="card investigation-panel" aria-label="Durable agent investigations">
        <div className="card-heading">
          <div><p className="eyebrow">Durable AgentCore runs</p><h3>Investigation history</h3></div>
          <span className="source-time" aria-live="polite">{investigationFreshness} · observed {formatTime(investigations?.observedAt)}</span>
        </div>
        {alarmObservation?.state === "ALARM" ? <section className="observed-alarm-run" aria-label="Run for the observed ALARM transition">
          <h4>Observed ALARM transition</h4>
          <p className="muted mono">{display(alarmObservation.arn, "Alarm ARN unavailable")} · {formatTime(selectedTransition)}</p>
          {exactObservedAlarmRun
            ? <InvestigationRecord run={exactObservedAlarmRun} />
            : investigationFreshness === "Unavailable" || investigationFreshness === "Stale"
              ? <p className="muted">The run matching this transition cannot be confirmed from the current run-table observation.</p>
              : <p className="muted">No run record matches this ALARM transition.</p>}
        </section> : null}
        {!investigations && investigationReadFailedAt
          ? <p className="muted" role="status">The durable run table is unavailable. No matching run can be inferred.</p>
          : null}
        {alarmObservation?.state !== "ALARM" && investigations?.runs.length === 0 && investigationFreshness !== "Unavailable"
          ? <p className="muted">No durable investigation runs are recorded for the configured alarm history.</p>
          : null}
        {olderInvestigations.length > 0 && <details className="investigation-history" open={alarmObservation?.state !== "ALARM"}>
          <summary>{alarmObservation?.state === "ALARM" ? `Other recent runs (${olderInvestigations.length})` : `Recent runs (${olderInvestigations.length})`}</summary>
          <div className="investigation-record-list">{olderInvestigations.map((run) => <InvestigationRecord key={`${run.alarmArn}-${run.transitionAt}`} run={run} />)}</div>
        </details>}
      </section>
      <section className="detail-grid"><article className="card"><div className="card-heading"><div><p className="eyebrow">Receipts</p><h3>Confirmed orders</h3></div><span className="source-time">Cloud state</span></div>{state?.receipts?.length ? <ul className="record-list">{state.receipts.map((receipt, index) => <li key={String(receipt.checkoutId ?? index)}><span className="mono">{display(receipt.checkoutId)}</span><strong>{display(receipt.quantity, "?")} units</strong><small>{formatTime(receipt.createdAt)}</small></li>)}</ul> : <p className="muted empty-state">No controller receipts recorded yet.</p>}</article><article className="card"><div className="card-heading"><div><p className="eyebrow">Follow-up</p><h3>Unresolved attempts</h3></div><span className="source-time">Cloud state</span></div>{state?.unresolved?.length ? <ul className="record-list">{state.unresolved.map((attempt, index) => <li key={String(attempt.checkoutId ?? index)}><span className="mono">{display(attempt.checkoutId)}</span><strong>{display(attempt.status, "unknown")}</strong><small>{formatTime(attempt.startedAt)}</small></li>)}</ul> : <p className="muted empty-state">No unresolved attempts.</p>}</article></section>
    </main>
  );
}
