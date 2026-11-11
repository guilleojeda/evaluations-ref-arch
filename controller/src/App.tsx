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
} from "./types";
import { currentConfigurationObservation, currentInventoryDisplay } from "./inventory-display.mjs";

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

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDashboard(value: Record<string, unknown>): value is Record<string, unknown> & DashboardState {
  return typeof value.observedAt === "string" && isRecord(value.budgets) &&
    isRecord(value.budgets.checkout) && isRecord(value.budgets.catalog) && isRecord(value.budgets.orderStatus) &&
    (value.baseline === null || isRecord(value.baseline)) &&
    (value.currentAction === undefined || isRecord(value.currentAction)) &&
    (value.currentConfigurationAction === undefined || isRecord(value.currentConfigurationAction)) &&
    Array.isArray(value.receipts) && value.receipts.every(isRecord) &&
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
  const [inventoryMemorySelection, setInventoryMemorySelection] = useState<number>();
  const [pendingCommand, setPendingCommand] = useState<PendingCommand>();
  const [pendingConfigurationCommand, setPendingConfigurationCommand] = useState<PendingCommand>();
  const [configurationSubmitting, setConfigurationSubmitting] = useState(false);
  const polling = useRef<number | undefined>(undefined);
  const alarmPolling = useRef<number | undefined>(undefined);
  const investigationPolling = useRef<number | undefined>(undefined);
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
        setPendingCommand((pending) => pending && body.currentAction?.id === pending.id ? undefined : pending);
        setPendingConfigurationCommand((pending) => pending && body.currentConfigurationAction?.id === pending.id ? undefined : pending);
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
  const currentStatus = currentAction?.status ?? "idle";
  const trafficActive = currentAction?.kind === "traffic" && activeStatuses.has(currentStatus);
  const anyPendingCommand = Boolean(pendingCommand || pendingConfigurationCommand);
  const actionBusy = loading || !state || anyPendingCommand || Boolean(currentAction && activeStatuses.has(currentStatus)) || currentStatus === "incomplete";
  const configurationBusy = loading || anyPendingCommand || Boolean(configurationAction && activeStatuses.has(configurationAction.status)) || configurationAction?.status === "incomplete";
  const restoreBusy = configurationBusy || Boolean(currentAction && activeStatuses.has(currentStatus) && currentAction.kind !== "traffic");
  const baseline = state?.baseline;
  const budgets = state?.budgets;
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
  const inventoryDisplay = currentInventoryDisplay({ baselineAlias, baselineInventory, aliasIncident, unknown: aliasUnknown });
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
  const trafficStartAllowed = !incidentActive;
  const needsProtectiveRestore = checkpoint?.status === "unavailable" || checkpoint?.status === "incomplete";
  const selectedMemoryIsPrepared = selectedMemoryMb !== undefined && inventoryMemoryChoices.includes(selectedMemoryMb);
  const memorySelectionUnavailable = !baseline ? "Check readiness to load verified Inventory memory choices."
    : aliasUnknown ? "Inventory memory is unknown until the alias is read back."
      : inventoryMemoryChoices.length === 0 ? "No verified Inventory memory choices are available for this release."
        : undefined;
  const memorySelectionDisabled = actionBusy || configurationBusy || Boolean(legacyIncident) || Boolean(memorySelectionUnavailable) ||
    currentMemoryMb === undefined || !selectedMemoryIsPrepared || (selectedMemoryMb !== undefined && selectedMemoryMb < currentMemoryMb);
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
  const retainedAlarm = checkpoint?.alarm;
  const configurationObservation = currentConfigurationObservation(
    currentAction?.kind === "activate_inventory_denial" ? currentAction : undefined,
    configurationAction,
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
    const isConfiguration = command.kind === "restore_inventory_access" || command.kind === "increase_memory";
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
        if (command.kind === "readiness") setReadinessConfirmed(false);
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
  const signOut = () => { sessionEpoch.current += 1; setBearer(""); setState(undefined); setAlarm(undefined); setAlarmReadFailed(false); setInvestigations(undefined); setInvestigationReadFailedAt(undefined); setPendingCommand(undefined); setPendingConfigurationCommand(undefined); setConfigurationSubmitting(false); setInventoryMemorySelection(undefined); setReadinessConfirmed(false); setProtectiveRestoreConfirmed(false); setLastObservedAt(undefined); setPollFailure(undefined); setNotice(undefined); setLoading(false); };
  const runReadiness = () => { if (readinessConfirmed) void sendAction(crypto.randomUUID(), { kind: "readiness", confirmQuiet: true }); };
  const runTraffic = () => void sendAction(crypto.randomUUID(), { kind: "traffic" });
  const runActivation = () => { if (readinessConfirmed) void sendAction(crypto.randomUUID(), { kind: "activate_inventory_denial" }); };
  const runRestore = () => { if (aliasIncident && !restoreBusy && (!needsProtectiveRestore || protectiveRestoreConfirmed)) void sendAction(crypto.randomUUID(), needsProtectiveRestore ? { kind: "restore_inventory_access", restoreWithoutEvidence: true } : { kind: "restore_inventory_access" }); };
  const runMemorySelection = () => {
    if (!memorySelectionDisabled && selectedMemoryMb !== undefined) {
      void sendAction(crypto.randomUUID(), { kind: "increase_memory", function: "inventory", memoryMb: selectedMemoryMb });
    }
  };
  const stopTraffic = () => currentAction && void sendAction(crypto.randomUUID(), { kind: "stop", targetActionId: currentAction.id });
  const discardAction = () => { const target = currentAction?.status === "incomplete" ? currentAction : configurationAction?.status === "incomplete" ? configurationAction : undefined; if (target) void sendAction(crypto.randomUUID(), { kind: "discard", targetActionId: target.id }); };
  const retryPending = (pending: PendingCommand) => void sendAction(pending.id, pending.command);
  const actionLabel = currentAction ? `${currentAction.kind} · ${currentAction.status}` : "No action running";

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
      <header className="topbar"><div className="brand"><div className="brand-mark" aria-hidden="true">IT</div><div><p className="eyebrow">Incident triage demo</p><h1>Failure controller</h1></div></div><div className="top-actions"><span className="connection-pill"><span className="status-dot" aria-hidden="true" /> Cloud state</span><button className="button button-secondary" type="button" onClick={signOut}>Sign out</button></div></header>
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Current action</p><h2>{actionLabel}</h2>{currentAction && <p className="mono muted compact">{currentAction.id}</p>}
          <p className="muted">Last observation {formatTime(lastObservedAt)}{pollFailure ? ` · ${pollFailure}` : ""}</p>
          {currentAction?.startedAt && <p className="muted">Started {formatTime(currentAction.startedAt)}{currentAction.finishedAt ? ` · Ended ${formatTime(currentAction.finishedAt)}` : ""}</p>}
          {currentAction?.error && <p className="action-error" role="alert">{currentAction.error}</p>}
          {currentAction?.discardAfter && currentStatus === "incomplete" && <p className="muted">Discard available after {formatTime(new Date(currentAction.discardAfter).toISOString())}</p>}
          <label className="quiet-check"><input type="checkbox" checked={readinessConfirmed} onChange={(event) => setReadinessConfirmed(event.target.checked)} /> I confirm other checkout writers are paused.</label>
        </div>
        <div className="action-controls">
          <button className="button button-primary" type="button" onClick={runReadiness} disabled={actionBusy || configurationBusy || incidentActive || !readinessConfirmed}>Check readiness</button>
          <button className="button button-secondary" type="button" onClick={runTraffic} disabled={actionBusy || !baseline || !trafficStartAllowed}>Start healthy traffic</button>
          {trafficActive && <button className="button button-stop" type="button" onClick={stopTraffic} disabled={loading || Boolean(pendingCommand) || currentStatus === "draining"}>Stop traffic</button>}
          {(currentAction?.status === "incomplete" || configurationAction?.status === "incomplete") && <button className="button button-secondary" type="button" onClick={discardAction} disabled={loading || anyPendingCommand || Date.now() < (currentAction?.status === "incomplete" ? currentAction.discardAfter : configurationAction!.discardAfter)}>Discard action</button>}
          <div className="menu-wrap">
            <button className="button button-secondary" type="button" aria-haspopup="true" aria-expanded={menuOpen} aria-controls="controller-actions" onClick={() => setMenuOpen((open) => !open)}>Actions <span className="chevron" aria-hidden="true" /></button>
            {menuOpen && <div className="actions-menu" id="controller-actions" role="group" aria-label="Controller actions">
              <button type="button" onClick={runReadiness} disabled={actionBusy || configurationBusy || incidentActive || !readinessConfirmed}>Check readiness</button>
              <button type="button" onClick={runTraffic} disabled={actionBusy || !baseline || !trafficStartAllowed}>Start healthy traffic</button>
              <button type="button" onClick={runActivation} disabled={actionBusy || configurationBusy || incidentActive || !baseline || !readinessConfirmed}>Activate Inventory denial</button>
              {!legacyIncident && <button type="button" onClick={runRestore} disabled={!aliasIncident || restoreBusy || (needsProtectiveRestore && !protectiveRestoreConfirmed)}>Restore Inventory access</button>}
              <section className="memory-picker" aria-label="Inventory memory selection">
                <label htmlFor="inventory-memory-selection">Inventory memory</label>
                <select id="inventory-memory-selection" value={selectedMemoryMb ?? ""}
                  disabled={Boolean(memorySelectionUnavailable) || configurationBusy || actionBusy}
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
        {configurationObservation && <div className="configuration-result" aria-label="Configuration result details">
          <p><strong>{resultLabel(configurationObservation.configurationOutcome)}</strong> · {configurationObservation.kind === "activate_inventory_denial" ? "Denial activation" : configurationObservation.kind === "increase_memory" ? "Memory selection" : "Access restore"} · {configurationObservation.status}</p>
          <p className="muted">Alias {display(switchBefore?.functionVersion, "unknown")} → {display(switchTarget?.version, "unknown")} {switchAfter ? `· read back ${switchAfter.functionVersion}` : "· awaiting readback"}; {configurationObservation.kind === "activate_inventory_denial" ? "bounded request observations are shown separately below" : configurationObservation.kind === "increase_memory" ? "memory selection sends no app probes" : "restore sends no app probes"}.</p>
        </div>}
        {legacyIncident && <p className="muted">This persisted {legacyIncident.mechanism === "iam-managed-policy" ? "IAM" : "DynamoDB table-policy"} incident remains visible for history only. Prepared-version controls do not mutate or restore it.</p>}
        {aliasIncident && incidentActive && needsProtectiveRestore && <label className="quiet-check protective-check">
          <input type="checkbox" checked={protectiveRestoreConfirmed} onChange={(event) => setProtectiveRestoreConfirmed(event.target.checked)} />
          Evidence capture is unavailable. Allow protective restore of the recorded alias state.
        </label>}
        {configurationAction?.error && <p className="action-error" role="alert">{configurationAction.error}</p>}
      </section>
      <section className="summary-grid" aria-label="Run summary"><article className="card"><p className="eyebrow">Target baseline</p><dl className="facts"><div><dt>App revision</dt><dd className="mono">{display(baseline?.appRevision, "Not verified")}</dd></div><div><dt>Product</dt><dd>{display(baseline?.sku, "Not verified")}</dd></div><div><dt>Product version</dt><dd className="mono">{display(baseline?.productVersion, "Not verified")}</dd></div></dl></article><article className="card stock-card"><p className="eyebrow">Inventory</p><strong className="stock-value">{display(state?.latestStock ?? baseline?.stockAfter, "—")}</strong><p className="muted">units · observed {formatTime(state?.latestStockAt)}</p></article><article className="card"><p className="eyebrow">Readiness order</p><p className="mono compact">{display(baseline?.checkoutId, "No verification order")}</p><p className="muted">{baseline ? `${display(baseline.stockBefore)} → ${display(baseline.stockAfter)} units` : "A verified order will establish the baseline."}</p></article></section>
      <section className="traffic-grid" aria-label="Traffic progress">{(["catalog", "checkout"] as const).map((profile) => { const value = currentAction?.traffic?.[profile]; const remaining = profile === "catalog" ? budgets?.catalog?.remaining : budgets?.checkout?.generatorRemaining; return <article className="card traffic-card" key={profile}><div className="card-heading"><div><p className="eyebrow">{profile} traffic</p><h3>{profile === "catalog" ? "Catalog reads" : "Checkout posts"}</h3></div><span className="budget">{display(remaining)} remaining</span></div><div className="metric-row">{([["submitted", "sent"], ["completed", "settled"], ["succeeded", "succeeded"], ["skipped", "skipped"], ["inFlight", "in flight"]] as const).map(([field, label]) => <div key={field}><strong>{display(value?.[field], "0")}</strong><span>{label}</span></div>)}</div></article>; })}</section><p className="muted allowance-summary" aria-label="Verification allowances">Verification checkouts {display(budgets?.checkout.verificationRemaining)} remaining · Order-status reads {display(budgets?.orderStatus.remaining)} remaining</p>
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
