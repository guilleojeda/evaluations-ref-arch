import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Action,
  AlarmResponse,
  AlarmState,
  Command,
  DashboardState,
  InventoryAliasObservation,
  InventoryVariant,
  InventoryVersionObservation,
} from "./types";

type Notice = { kind: "error" | "success"; message: string } | undefined;
type PendingCommand = { id: string; command: Command };
const activeStatuses = new Set(["queued", "running", "draining"]);

function formatTime(value: unknown): string {
  if (typeof value !== "string") return "No observation yet";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleTimeString() : value;
}
function display(value: unknown, fallback = "—"): string { return value === undefined || value === null || value === "" ? fallback : String(value); }
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
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const [lastObservedAt, setLastObservedAt] = useState<string>();
  const [pollFailure, setPollFailure] = useState<string>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [readinessConfirmed, setReadinessConfirmed] = useState(false);
  const [protectiveRestoreConfirmed, setProtectiveRestoreConfirmed] = useState(false);
  const [pendingCommand, setPendingCommand] = useState<PendingCommand>();
  const [pendingRestoreCommand, setPendingRestoreCommand] = useState<PendingCommand>();
  const [restoreSubmitting, setRestoreSubmitting] = useState(false);
  const polling = useRef<number | undefined>(undefined);
  const alarmPolling = useRef<number | undefined>(undefined);
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
        setPendingRestoreCommand((pending) => pending && body.currentConfigurationAction?.id === pending.id ? undefined : pending);
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

  const currentAction = state?.currentAction;
  const configurationAction = state?.currentConfigurationAction;
  const currentStatus = currentAction?.status ?? "idle";
  const trafficActive = currentAction?.kind === "traffic" && activeStatuses.has(currentStatus);
  const anyPendingCommand = Boolean(pendingCommand || pendingRestoreCommand);
  const actionBusy = loading || !state || anyPendingCommand || Boolean(currentAction && activeStatuses.has(currentStatus)) || currentStatus === "incomplete";
  const configurationBusy = loading || anyPendingCommand || Boolean(configurationAction && activeStatuses.has(configurationAction.status)) || configurationAction?.status === "incomplete";
  const restoreBusy = configurationBusy || Boolean(currentAction && activeStatuses.has(currentStatus) && currentAction.kind !== "traffic");
  const baseline = state?.baseline;
  const budgets = state?.budgets;
  const incident = state?.incident;
  const aliasIncident = incident?.mechanism === "lambda-alias" ? incident : undefined;
  const legacyIncident = incident && incident.mechanism !== "lambda-alias" ? incident : undefined;
  const checkpoint = incident?.checkpoint;
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
  const currentAlias = aliasIncident?.alias ?? baselineAlias;
  const currentAccess = aliasIncident?.active ?? baselineInventory?.access ?? "unknown";
  const targetVariant = aliasIncident?.target ?? (baselineInventory ? {
    version: baselineInventory.version,
    roleArn: baselineInventory.role,
    memoryMb: baselineInventory.memory,
    access: baselineInventory.access,
  } : undefined);
  const currentVariant = targetVariant && currentAlias && targetVariant.version === currentAlias.functionVersion
    ? targetVariant
    : baselineInventory ? { version: baselineInventory.version, roleArn: baselineInventory.role, memoryMb: baselineInventory.memory, access: baselineInventory.access } : undefined;
  const currentAliasStatus = aliasStatus(currentAlias, currentVariant, Boolean(baseline), currentAccess);
  const incidentActive = Boolean(aliasIncident && aliasIncident.active !== "healthy");
  const baselineAccessObservation = isRecord(baseline?.settings?.inventoryAccessPolicy) ? baseline.settings.inventoryAccessPolicy : undefined;
  const policyObservation = aliasIncident?.policy ?? baselineAccessObservation;
  const inventoryRoleArn = currentAccess === "denied"
    ? display(aliasIncident?.target.roleArn ?? baselineInventory?.role, "Not observed")
    : currentAccess === "healthy" ? display(baselineInventory?.role ?? baseline?.settings.inventoryRoleArn, "Not observed") : "Unknown";
  const trafficStartAllowed = !incidentActive;
  const needsProtectiveRestore = checkpoint?.status === "unavailable" || checkpoint?.status === "incomplete";
  const alarmObservation = alarm?.alarm;
  const retainedAlarm = checkpoint?.alarm;
  const configurationObservation = currentAction?.kind === "activate_inventory_denial" ? currentAction : configurationAction;
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
    const isRestore = command.kind === "restore_inventory_access";
    const setPending = isRestore ? setPendingRestoreCommand : setPendingCommand;
    if (isRestore) setRestoreSubmitting(true);
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
        setState((previous) => previous && (command.kind === "restore_inventory_access" ? { ...previous, currentConfigurationAction: action } : { ...previous, currentAction: action }));
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
        } else setNotice({ kind: "error", message: "The command outcome is unknown. Retry with the same ID." });
      }
    } finally {
      if (epoch === sessionEpoch.current && isRestore) setRestoreSubmitting(false);
      if (epoch === sessionEpoch.current && !isRestore && requestEpoch.current === callNumber) setLoading(false);
    }
  }, [bearer, loadAlarm, loadState]);

  useEffect(() => { if (!bearer) return undefined; void loadState(); void loadAlarm(); const interval = window.setInterval(() => { void loadState(); void loadAlarm(); }, 5_000); return () => window.clearInterval(interval); }, [bearer, loadAlarm, loadState]);

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
  const signOut = () => { sessionEpoch.current += 1; setBearer(""); setState(undefined); setAlarm(undefined); setAlarmReadFailed(false); setPendingCommand(undefined); setPendingRestoreCommand(undefined); setRestoreSubmitting(false); setReadinessConfirmed(false); setProtectiveRestoreConfirmed(false); setLastObservedAt(undefined); setPollFailure(undefined); setNotice(undefined); setLoading(false); };
  const runReadiness = () => { if (readinessConfirmed) void sendAction(crypto.randomUUID(), { kind: "readiness", confirmQuiet: true }); };
  const runTraffic = () => void sendAction(crypto.randomUUID(), { kind: "traffic" });
  const runActivation = () => { if (readinessConfirmed) void sendAction(crypto.randomUUID(), { kind: "activate_inventory_denial" }); };
  const runRestore = () => { if (aliasIncident && !restoreBusy && (!needsProtectiveRestore || protectiveRestoreConfirmed)) void sendAction(crypto.randomUUID(), needsProtectiveRestore ? { kind: "restore_inventory_access", restoreWithoutEvidence: true } : { kind: "restore_inventory_access" }); };
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
            <button className="button button-secondary" type="button" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>Actions <span className="chevron" aria-hidden="true" /></button>
            {menuOpen && <div className="actions-menu" role="menu">
              <button type="button" role="menuitem" onClick={runReadiness} disabled={actionBusy || configurationBusy || incidentActive || !readinessConfirmed}>Check readiness</button>
              <button type="button" role="menuitem" onClick={runTraffic} disabled={actionBusy || !baseline || !trafficStartAllowed}>Start healthy traffic</button>
              <button type="button" role="menuitem" onClick={runActivation} disabled={actionBusy || configurationBusy || incidentActive || !baseline || !readinessConfirmed}>Activate Inventory denial</button>
              {!legacyIncident && <button type="button" role="menuitem" onClick={runRestore} disabled={!aliasIncident || restoreBusy || (needsProtectiveRestore && !protectiveRestoreConfirmed)}>Restore Inventory access</button>}
              <button type="button" role="menuitem" onClick={stopTraffic} disabled={!trafficActive || loading || Boolean(pendingCommand) || currentStatus === "draining"}>Stop traffic</button>
            </div>}
          </div>
        </div>
      </section>
      {notice && <p className={`notice notice-${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.message}</p>}
      {pendingCommand && !loading && <div className="notice notice-error" role="status">
        <span>Command outcome unknown. Retry with the original ID.</span>
        <button className="inline-action" type="button" onClick={() => retryPending(pendingCommand)} disabled={loading}>Retry {pendingCommand.command.kind}</button>
      </div>}
      {pendingRestoreCommand && !restoreSubmitting && <div className="notice notice-error" role="status">
        <span>Restore outcome unknown. Retry with the original ID.</span>
        <button className="inline-action" type="button" onClick={() => retryPending(pendingRestoreCommand)} disabled={loading || restoreSubmitting}>Retry restore_inventory_access</button>
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
          <p><strong>{resultLabel(configurationObservation.configurationOutcome)}</strong> · {configurationObservation.kind === "activate_inventory_denial" ? "Activation" : "Restore"} completed as a configuration action.</p>
          <p className="muted">Alias {display(switchBefore?.functionVersion, "unknown")} → {display(switchTarget?.version, "unknown")} {switchAfter ? `· read back ${switchAfter.functionVersion}` : "· awaiting readback"}; {configurationObservation.kind === "activate_inventory_denial" ? "bounded request observations are shown separately below" : "restore submits no app probes"}.</p>
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
          </dl>
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
      <section className="detail-grid"><article className="card"><div className="card-heading"><div><p className="eyebrow">Receipts</p><h3>Confirmed orders</h3></div><span className="source-time">Cloud state</span></div>{state?.receipts?.length ? <ul className="record-list">{state.receipts.map((receipt, index) => <li key={String(receipt.checkoutId ?? index)}><span className="mono">{display(receipt.checkoutId)}</span><strong>{display(receipt.quantity, "?")} units</strong><small>{formatTime(receipt.createdAt)}</small></li>)}</ul> : <p className="muted empty-state">No controller receipts recorded yet.</p>}</article><article className="card"><div className="card-heading"><div><p className="eyebrow">Follow-up</p><h3>Unresolved attempts</h3></div><span className="source-time">Cloud state</span></div>{state?.unresolved?.length ? <ul className="record-list">{state.unresolved.map((attempt, index) => <li key={String(attempt.checkoutId ?? index)}><span className="mono">{display(attempt.checkoutId)}</span><strong>{display(attempt.status, "unknown")}</strong><small>{formatTime(attempt.startedAt)}</small></li>)}</ul> : <p className="muted empty-state">No unresolved attempts.</p>}</article></section>
    </main>
  );
}
