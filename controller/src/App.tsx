import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Action, Command, DashboardState } from "./types";

type Notice = { kind: "error" | "success"; message: string } | undefined;
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
    isRecord(value.budgets.checkout) && isRecord(value.budgets.catalog) &&
    (value.baseline === null || isRecord(value.baseline)) &&
    (value.currentAction === undefined || isRecord(value.currentAction)) &&
    Array.isArray(value.receipts) && value.receipts.every(isRecord) &&
    Array.isArray(value.unresolved) && value.unresolved.every(isRecord);
}

async function readDashboard(response: Response): Promise<DashboardState> {
  const data = await readJson(response);
  if (!isDashboard(data)) throw new Error("The controller returned an invalid dashboard");
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
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const [lastObservedAt, setLastObservedAt] = useState<string>();
  const [pollFailure, setPollFailure] = useState<string>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [readinessConfirmed, setReadinessConfirmed] = useState(false);
  const [pendingCommand, setPendingCommand] = useState<{ id: string; command: Command }>();
  const polling = useRef<number | undefined>(undefined);
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
        setPendingCommand((pending) => pending?.id === body.currentAction?.id ? undefined : pending);
        setPollFailure(undefined);
      }
    } catch (error) {
      if (epoch === sessionEpoch.current) setPollFailure(error instanceof Error ? error.message : "The controller could not be read");
    } finally {
      if (polling.current === epoch) polling.current = undefined;
    }
  }, [bearer]);
  useEffect(() => { if (!bearer) return undefined; void loadState(); const interval = window.setInterval(() => void loadState(), 5_000); return () => window.clearInterval(interval); }, [bearer, loadState]);

  const currentAction = state?.currentAction;
  const currentStatus = currentAction?.status ?? "idle";
  const trafficActive = currentAction?.kind === "traffic" && activeStatuses.has(currentStatus);
  const actionBusy = loading || !state || Boolean(pendingCommand) || Boolean(currentAction && activeStatuses.has(currentStatus)) || currentStatus === "incomplete";
  const baseline = state?.baseline;
  const budgets = state?.budgets;

  const sendAction = useCallback(async (id: string, command: Command) => {
    const epoch = sessionEpoch.current;
    const callNumber = requestEpoch.current + 1;
    requestEpoch.current = callNumber;
    setLoading(true); setNotice(undefined);
    setPendingCommand({ id, command });
    try {
      const response = await fetch(`/api/actions/${id}`, { method: "PUT", headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(command), signal: AbortSignal.timeout(8_000) });
      const body = await readJson(response);
      const action = body.action as Action | undefined;
      if (!action || action.id !== id) throw new Error("The controller did not acknowledge this command");
      if (epoch === sessionEpoch.current && response.status === 202 && activeStatuses.has(action.status)) {
        setState((previous) => previous && { ...previous, currentAction: action });
      }
      if (epoch === sessionEpoch.current) {
        setPendingCommand(undefined);
        if (command.kind === "readiness") setReadinessConfirmed(false);
        setNotice({ kind: "success", message: `${String(command.kind)} accepted` });
        setMenuOpen(false);
        await loadState();
      }
    } catch (error) {
      if (epoch === sessionEpoch.current) {
        if (error instanceof RequestError && error.status < 500) {
          setPendingCommand(undefined);
          setNotice({ kind: "error", message: error.message });
        } else {
          setNotice({ kind: "error", message: "The command outcome is unknown. Retry with the same ID." });
        }
      }
    } finally {
      if (epoch === sessionEpoch.current && requestEpoch.current === callNumber) setLoading(false);
    }
  }, [bearer, loadState]);

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
  const signOut = () => { sessionEpoch.current += 1; setBearer(""); setState(undefined); setPendingCommand(undefined); setReadinessConfirmed(false); setLastObservedAt(undefined); setPollFailure(undefined); setNotice(undefined); setLoading(false); };
  const runReadiness = () => {
    if (readinessConfirmed) void sendAction(crypto.randomUUID(), { kind: "readiness", confirmQuiet: true });
  };
  const runTraffic = () => void sendAction(crypto.randomUUID(), { kind: "traffic" });
  const stopTraffic = () => currentAction && void sendAction(crypto.randomUUID(), { kind: "stop", targetActionId: currentAction.id });
  const discardAction = () => currentAction && void sendAction(crypto.randomUUID(), { kind: "discard", targetActionId: currentAction.id });
  const retryPending = () => pendingCommand && void sendAction(pendingCommand.id, pendingCommand.command);
  const actionLabel = useMemo(() => currentAction ? `${currentAction.kind} · ${currentAction.status}` : "No action running", [currentAction]);

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
          <p className="eyebrow">Current action</p>
          <h2>{actionLabel}</h2>
          <p className="muted">Last observation {formatTime(lastObservedAt)}{pollFailure ? ` · ${pollFailure}` : ""}</p>
          {currentAction?.error && <p className="action-error" role="alert">{currentAction.error}</p>}
          {currentAction?.discardAfter && currentStatus === "incomplete" && <p className="muted">Discard available after {formatTime(new Date(currentAction.discardAfter).toISOString())}</p>}
          <label className="quiet-check"><input type="checkbox" checked={readinessConfirmed} onChange={(event) => setReadinessConfirmed(event.target.checked)} /> I confirm other checkout writers are paused.</label>
        </div>
        <div className="action-controls">
          <button className="button button-primary" type="button" onClick={runReadiness} disabled={actionBusy || !readinessConfirmed}>Check readiness</button>
          <button className="button button-secondary" type="button" onClick={runTraffic} disabled={actionBusy || !baseline}>Start healthy traffic</button>
          {trafficActive && <button className="button button-stop" type="button" onClick={stopTraffic} disabled={loading || Boolean(pendingCommand) || currentStatus === "draining"}>Stop traffic</button>}
          {currentAction && currentStatus === "incomplete" && <button className="button button-secondary" type="button" onClick={discardAction} disabled={loading || Boolean(pendingCommand) || Date.now() < currentAction.discardAfter}>Discard action</button>}
          <div className="menu-wrap">
            <button className="button button-secondary" type="button" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>Actions <span className="chevron" aria-hidden="true" /></button>
            {menuOpen && <div className="actions-menu" role="menu">
              <button type="button" role="menuitem" onClick={runReadiness} disabled={actionBusy || !readinessConfirmed}>Check readiness</button>
              <button type="button" role="menuitem" onClick={runTraffic} disabled={actionBusy || !baseline}>Start healthy traffic</button>
              <button type="button" role="menuitem" onClick={stopTraffic} disabled={!trafficActive || loading || Boolean(pendingCommand) || currentStatus === "draining"}>Stop traffic</button>
            </div>}
          </div>
        </div>
      </section>
      {notice && <p className={`notice notice-${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.message}{pendingCommand && <button className="inline-action" type="button" onClick={retryPending} disabled={loading}>Retry same command</button>}</p>}
      {pollFailure && <p className="notice notice-error" role="alert">{pollFailure}. The last good cloud observation remains visible.</p>}
      <section className="summary-grid" aria-label="Run summary"><article className="card"><p className="eyebrow">Target baseline</p><dl className="facts"><div><dt>App revision</dt><dd className="mono">{display(baseline?.appRevision, "Not verified")}</dd></div><div><dt>Product</dt><dd>{display(baseline?.sku, "Not verified")}</dd></div><div><dt>Product version</dt><dd className="mono">{display(baseline?.productVersion, "Not verified")}</dd></div></dl></article><article className="card stock-card"><p className="eyebrow">Inventory</p><strong className="stock-value">{display(state?.latestStock ?? baseline?.stockAfter, "—")}</strong><p className="muted">units · observed {formatTime(state?.latestStockAt)}</p></article><article className="card"><p className="eyebrow">Readiness order</p><p className="mono compact">{display(baseline?.checkoutId, "No verification order")}</p><p className="muted">{baseline ? `${display(baseline.stockBefore)} → ${display(baseline.stockAfter)} units` : "A verified order will establish the baseline."}</p></article></section>
      <section className="traffic-grid" aria-label="Traffic progress">{(["catalog", "checkout"] as const).map((profile) => { const value = currentAction?.traffic?.[profile]; const remaining = profile === "catalog" ? budgets?.catalog?.remaining : budgets?.checkout?.generatorRemaining; return <article className="card traffic-card" key={profile}><div className="card-heading"><div><p className="eyebrow">{profile} traffic</p><h3>{profile === "catalog" ? "Catalog reads" : "Checkout posts"}</h3></div><span className="budget">{display(remaining)} remaining</span></div><div className="metric-row">{([["submitted", "sent"], ["completed", "settled"], ["succeeded", "succeeded"], ["skipped", "skipped"], ["inFlight", "in flight"]] as const).map(([field, label]) => <div key={field}><strong>{display(value?.[field], "0")}</strong><span>{label}</span></div>)}</div></article>; })}</section>
      <section className="detail-grid"><article className="card"><div className="card-heading"><div><p className="eyebrow">Receipts</p><h3>Confirmed orders</h3></div><span className="source-time">Cloud state</span></div>{state?.receipts?.length ? <ul className="record-list">{state.receipts.map((receipt, index) => <li key={String(receipt.checkoutId ?? index)}><span className="mono">{display(receipt.checkoutId)}</span><strong>{display(receipt.quantity, "?")} units</strong><small>{formatTime(receipt.createdAt)}</small></li>)}</ul> : <p className="muted empty-state">No controller receipts recorded yet.</p>}</article><article className="card"><div className="card-heading"><div><p className="eyebrow">Follow-up</p><h3>Unresolved attempts</h3></div><span className="source-time">Cloud state</span></div>{state?.unresolved?.length ? <ul className="record-list">{state.unresolved.map((attempt, index) => <li key={String(attempt.checkoutId ?? index)}><span className="mono">{display(attempt.checkoutId)}</span><strong>{display(attempt.status, "unknown")}</strong><small>{formatTime(attempt.startedAt)}</small></li>)}</ul> : <p className="muted empty-state">No unresolved attempts.</p>}</article></section>
    </main>
  );
}
