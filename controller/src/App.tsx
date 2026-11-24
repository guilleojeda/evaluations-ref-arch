import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Action,
  AgentCandidateId,
  AgentSelection,
  AlarmResponse,
  AlarmState,
  Command,
  DashboardState,
  InvestigationResponse,
  InventoryAliasObservation,
  InventoryVariant,
  InventoryVersionObservation,
  RunState,
} from "./types";
import { InvestigationRecord } from "./InvestigationRecord";
import { uiText } from "./ui-text";
import { TrafficSurgePanel } from "./TrafficSurgePanel";
import {
  capOutcomeLabel,
  capValueLabel,
  currentConfigurationObservation,
  currentInventoryDisplay,
  recoveryProgressLabel,
  recoveryVerificationLabel,
} from "./inventory-display.mjs";

type Notice = { kind: "error"; message: string } | undefined;
type PendingCommand = { id: string; command: Command };
type ControllerView = "incident" | "traffic" | "history";
const activeStatuses = new Set(["queued", "running", "draining"]);

function formatTime(value: unknown): string {
  if (typeof value !== "string") return "No observation yet";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleTimeString() : value;
}
function display(value: unknown, fallback = "-"): string { return value === undefined || value === null || value === "" ? fallback : String(value); }
function normalizedTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
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

  const settingsStatus = checkpoint?.status ?? (action.recoveryProgress === "capturing" ? "In progress" : "Not recorded");
  const businessStatus = recoveryVerificationLabel(action);
  return <section className="card recovery-panel" aria-label="Recovery progress">
    <div className="card-heading">
      <h3 aria-live="polite">Recovery</h3><strong>{recoveryProgressLabel(action.recoveryProgress)}</strong>
    </div>
    {checkpoint?.error && <p className="action-error" role="status">{uiText(checkpoint.error)}</p>}
    <details className="recovery-evidence">
      <summary>Release and verification evidence</summary>
      <p>Started {formatTime(action.startedAt)}{action.finishedAt ? ` / ended ${formatTime(action.finishedAt)}` : ""}</p>
      <dl className="facts">
        <div><dt>Traffic</dt><dd>{trafficLabel}</dd></div>
        <div><dt>Release validation</dt><dd>{recoveryValidationLabel(action)}</dd></div>
        <div><dt>Settings capture</dt><dd>{settingsStatus} / {formatTime(checkpoint?.createdAt)}</dd></div>
        <div><dt>Business verification</dt><dd>{businessStatus}</dd></div>
      </dl>
      <p className="recovery-evidence-id mono">Action {action.id}</p>
      <h4 className="recovery-subheading">Inventory target</h4>
      <dl className="recovery-facts">
        <div><dt>Original healthy target</dt><dd>{original ? `v${original.version} / ${original.memory} MB / ${accessLabel(original.access)} / ${roleLabel(original.role)}` : "Not established"}</dd></div>
        <div><dt>Before recovery</dt><dd>{aliasBefore ? `v${aliasBefore.functionVersion}` : display(currentAlias?.functionVersion, "Unknown")} / {beforeMemory === undefined ? "memory unknown" : `${beforeMemory} MB`} / {accessLabel(beforeAccess)} / {roleLabel(beforeRole)}</dd></div>
        <div><dt>Recovery target</dt><dd>{target ? `v${target.version} / ${target.memoryMb} MB / ${accessLabel(target.access)} / ${roleLabel(target.roleArn)}` : "Not recorded"}</dd></div>
        <div><dt>Alias readback</dt><dd>{aliasAfter ? `v${aliasAfter.functionVersion}${target?.version === aliasAfter.functionVersion ? ` / target ${target.memoryMb} MB ${accessLabel(target.access)} / ${roleLabel(target.roleArn)}` : ""} / ${formatTime(aliasAfter.observedAt)}` : action.recoveryProgress === "restoring" ? "Awaiting readback" : "Not observed"}</dd></div>
      </dl>

      <h4 className="recovery-subheading">Concurrency</h4>
      <div className="recovery-cap-grid">
        {capRows.map(([name, value]) => <article className="recovery-cap" key={name}>
          <strong>{name}</strong>
          {value ? <>
            <span>{capValueLabel(value.before)} to {capValueLabel(value.target)}</span>
            <span>Readback {value.readback === undefined ? (value.outcome === "pending" ? "Awaiting readback" : "Not observed") : capValueLabel(value.readback)}</span>
            <small>{capOutcomeLabel(value.outcome)}{value.observedAt ? ` / ${formatTime(value.observedAt)}` : ""}</small>
          </> : <span>Not observed</span>}
        </article>)}
      </div>

      <h4 className="recovery-subheading">Fresh business verification</h4>
      <p className="recovery-verification" role="status">{businessStatus}</p>
      <dl className="recovery-facts">
        <div><dt>Verification order</dt><dd className="mono">{display(verificationId, "Not sent")}</dd></div>
        <div><dt>Saved receipt</dt><dd>{display(verifiedBaseline?.receipt?.status ?? receipt?.status, verificationRequest?.outcome === "success" ? "Request succeeded; receipt readback pending" : "Not observed")}</dd></div>
        <div><dt>Stock check</dt><dd>{verifiedBaseline ? `${verifiedBaseline.stockBefore} to ${verifiedBaseline.stockAfter} units` : "Not verified"}</dd></div>
        <div><dt>Product version</dt><dd className="mono">{display(verifiedBaseline?.productVersion, "Not verified")}</dd></div>
      </dl>

      <h4 className="recovery-subheading">Last verified health</h4>
      {state.baseline
        ? <p className="recovery-last-health"><span className="mono">{state.baseline.checkoutId}</span> / {state.baseline.stockBefore} to {state.baseline.stockAfter} units / product {state.baseline.productVersion} / verified {formatTime(state.baseline.verifiedAt)}</p>
        : <p className="recovery-last-health">No successful business verification is recorded.</p>}
    </details>
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
function capacityValueLabel(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value)) return `${value} executions`;
  if (value === "unreserved" || value === "unknown") return capValueLabel(value);
  return "Not observed";
}
function capacityAcknowledgementLabel(value: "acknowledged" | "ambiguous" | "rejected" | undefined): string {
  return value === "acknowledged" ? "Acknowledged" : value === "ambiguous" ? "Ambiguous" : value === "rejected" ? "Rejected" : "Not recorded";
}
function actionStatusLabel(status: Action["status"]): string {
  return status === "queued" ? "Queued" : status === "running" || status === "draining" ? "In progress"
    : status === "completed" ? "Completed" : status === "incomplete" ? "Incomplete"
      : status === "failed" ? "Failed" : status === "discarded" ? "Discarded" : "Stopped";
}
function CapacityChangeResult({ action, archived = false }: { action: Action; archived?: boolean }) {
  const change = action.capacityChange;
  return <section className={`capacity-result${archived ? " capacity-result-archived" : ""}`} aria-label={archived ? "Archived capacity action result" : "Capacity action result"}>
    <div className="capacity-result-heading">
      <h4>{archived ? change ? "Recorded Inventory capacity change" : "Inventory capacity action record" : "Latest Inventory capacity action"}</h4>
      <span className={`incident-badge ${["failed", "incomplete", "discarded"].includes(action.status) || action.configurationOutcome === "failed" || action.configurationOutcome === "unknown" ? "badge-warning" : "badge-neutral"}`}>{actionStatusLabel(action.status)}</span>
    </div>
    <dl className="capacity-result-grid">
      <div><dt>Before to target</dt><dd>{change ? `${change.before} to ${change.target} executions` : "Not recorded"}</dd></div>
      <div><dt>Mutation acknowledgement</dt><dd>{capacityAcknowledgementLabel(change?.acknowledgement)}</dd></div>
      <div><dt>Setting readback</dt><dd>{!change ? "Not recorded" : change.readback === undefined ? activeStatuses.has(action.status) ? "Awaiting readback" : "Not observed" : capacityValueLabel(change.readback)}</dd></div>
      <div><dt>Readback time</dt><dd>{change?.observedAt ? formatTime(change.observedAt) : "No readback time recorded"}</dd></div>
      <div><dt>Configuration outcome</dt><dd>{action.configurationOutcome ? resultLabel(action.configurationOutcome) : activeStatuses.has(action.status) ? "Pending" : "Not recorded"}</dd></div>
      <div><dt>Action</dt><dd className="mono">{action.id}</dd></div>
    </dl>
    {action.error && <p className="action-error" role={action.status === "failed" ? "alert" : "status"}>{uiText(action.error)}</p>}
    <p className="capacity-result-note">{change
      ? "This records the Inventory setting change only. It sends no business request and does not verify business recovery."
      : activeStatuses.has(action.status)
        ? "Capacity checks are still running; details appear after their preconditions pass. This action sends no business request."
        : "No capacity-change details were recorded for this action. Review its status and error before deciding what to do next."}</p>
  </section>;
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

const agentCandidates = ["faulty", "repaired"] as const;
function agentSelectionLabel(candidateId: AgentCandidateId | undefined): string {
  return candidateId === "repaired" ? "Repaired" : candidateId === "faulty" ? "Faulty" : "No candidate selected";
}

function candidateId(value: unknown): value is AgentCandidateId {
  return value === "faulty" || value === "repaired";
}

function verifiedSelection(value: unknown): value is AgentSelection {
  return isRecord(value) && candidateId(value.candidateId) && typeof value.selectedAt === "string" &&
    typeof value.endpointName === "string" && typeof value.endpointArn === "string" &&
    typeof value.runtimeArn === "string" && typeof value.runtimeVersion === "string" &&
    typeof value.artifactSha256 === "string" && typeof value.sourceRevision === "string" &&
    typeof value.promptSha256 === "string" && typeof value.modelId === "string";
}

type AgentSelectionStatus = "verified" | "stale" | "unavailable" | "unconfigured" | "loading";

/** A selection is display-trusted only when the native read agrees with every routing identity. */
function verifiedAlarmSelection(value: AlarmResponse | undefined): AgentSelection | undefined {
  const selection = value && verifiedSelection(value.selectedAgent) ? value.selectedAgent : undefined;
  const endpoint = value?.agentEndpoint;
  if (!selection || !endpoint || endpoint.state !== "ready" || endpoint.name !== selection.endpointName ||
      endpoint.endpointArn !== selection.endpointArn || endpoint.runtimeArn !== selection.runtimeArn ||
      endpoint.liveVersion !== selection.runtimeVersion) return undefined;
  return selection;
}

function sameSelectionIdentity(left: AgentSelection | undefined, right: AgentSelection | undefined): boolean {
  return Boolean(left && right && left.candidateId === right.candidateId && left.endpointName === right.endpointName &&
    left.endpointArn === right.endpointArn && left.runtimeArn === right.runtimeArn && left.runtimeVersion === right.runtimeVersion &&
    left.artifactSha256 === right.artifactSha256 && left.sourceRevision === right.sourceRevision && left.promptSha256 === right.promptSha256);
}

function selectionDigest(value: AgentSelection | undefined, field: "artifactSha256" | "sourceRevision" | "promptSha256"): string {
  return value?.[field] ?? "Not recorded";
}

function AgentSelectionPanel({
  selection,
  observedAt,
  status,
  action,
  selectedChoice,
  disabled,
  disabledReason,
  onChoice,
  onSelect,
}: {
  selection?: AgentSelection;
  observedAt?: string;
  status: AgentSelectionStatus;
  action?: Action;
  selectedChoice: AgentCandidateId;
  disabled: boolean;
  disabledReason?: string;
  onChoice: (candidate: AgentCandidateId) => void;
  onSelect: () => void;
}) {
  const selectedObservationTime = observedAt ?? selection?.selectedAt;
  const changing = Boolean(action && activeStatuses.has(action.status));
  const trusted = selection && status === "verified";
  const selectionLabel = selection ? `${agentSelectionLabel(selection.candidateId)} v${selection.runtimeVersion}` : undefined;
  return <section className="agent-selection" aria-label="Prepared agent selection">
    <div className="card-heading"><h3>Next alarm</h3><strong>{trusted ? selectionLabel : selectionLabel ? `${selectionLabel} (last verified)` : status === "loading" ? "Loading..." : "Unverified"}</strong></div>
    <div className="memory-control">
      <label htmlFor="next-agent">Agent</label>
      <select id="next-agent" value={selectedChoice} onChange={(event) => { if (candidateId(event.target.value)) onChoice(event.target.value); }}>
        {agentCandidates.map((candidate) => <option key={candidate} value={candidate}>{agentSelectionLabel(candidate)}</option>)}
      </select>
      <button className="button button-secondary" type="button" onClick={onSelect} disabled={disabled || (trusted && selectedChoice === selection.candidateId)}>
        {changing ? "Verifying..." : "Apply agent"}
      </button>
    </div>
    {disabled && disabledReason && (!trusted || selectedChoice !== selection.candidateId) &&
      <p className="agent-selection-help" role="status">{uiText(disabledReason)}</p>}
    {selection && <>
      <details className="selection-identity">
        <summary>Publication identity</summary>
      <dl className="agent-selection-facts">
      <div><dt>Endpoint / Runtime version</dt><dd className="mono">{selection.endpointName} / {selection.endpointArn} / v{selection.runtimeVersion}</dd></div>
      <div><dt>Source revision</dt><dd className="mono">{selectionDigest(selection, "sourceRevision")}</dd></div>
      <div><dt>Package SHA-256</dt><dd className="mono">{selectionDigest(selection, "artifactSha256")}</dd></div>
      <div><dt>Prompt / model</dt><dd className="mono">{selectionDigest(selection, "promptSha256")} / {selection.modelId}</dd></div>
      <div><dt>Last successful observation</dt><dd>{formatTime(selectedObservationTime)} / selected {formatTime(selection.selectedAt)}</dd></div>
      {selection.candidateId === "repaired" && <div><dt>Qualification review</dt><dd>{selection.reviewEnvironment ?? "Qualified publication"} / run {display(selection.reviewRunId, "not recorded")} / reviewer {display(selection.reviewer, "not recorded")}</dd></div>}
      {selection.candidateId === "faulty" && <div><dt>Reference identity</dt><dd className="mono">{display(selection.sourceManifestSha256, "Source manifest not recorded")}</dd></div>}
      </dl>
      </details>
    </>}
  </section>;
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
    const updatedAt = typeof value.updatedAt === "string" ? ` / updated ${formatTime(value.updatedAt)}` : "";
    const checkpoint = isRecord(value.checkpoint) ? value.checkpoint : undefined;
    return [{ summary: `${mechanism} / ${state}${updatedAt}`, sourceReference: typeof checkpoint?.key === "string" ? checkpoint.key : undefined }];
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
    : archiveError ? selectedArchive ? "Refresh failed / last snapshot shown" : "Unavailable"
      : !selectedArchive ? "Not loaded"
        : !Number.isFinite(archiveAgeMs) || archiveAgeMs >= 60_000 ? "Stale / refresh available" : "Loaded";

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
        <div><p className="eyebrow">Session</p><h3>Current run</h3></div>
        <span className={`incident-badge ${currentResetRequired ? "badge-warning" : "badge-neutral"}`}>{currentResetRequired ? "Reset required" : "Current"}</span>
      </div>
      <details className="session-identity">
        <summary>Session identity</summary>
        <p className="mono session-run-id">{currentRunId}</p>
      </details>
      {previousRunId
        ? <button className="button button-secondary history-link" type="button" onClick={() => void loadRun(previousRunId)}>Open previous run</button>
        : <p className="muted empty-state">No previous run is recorded.</p>}
    </section>
    {archiveId && <section className="card archived-run" aria-label={`Archived run ${archiveId}`}>
      <div className="card-heading">
        <div><p className="eyebrow">Archived session / read only</p><h3>Archived run</h3></div>
        <div className="archived-heading-actions"><button className="button button-secondary" type="button" onClick={closeArchive}>Return to current run</button></div>
      </div>
      <p className="source-time" role="status">{archiveFreshness}{selectedArchive ? ` / loaded ${formatTime(selectedArchive.loadedAt)}` : ""}</p>
      {archiveError && <p className="notice notice-error" role="alert">{archiveMatchesSelection ? "Refresh failed; showing the last loaded snapshot. " : "Run history is unavailable. "}{uiText(archiveError)}</p>}
      {archiveLoading && !archiveMatchesSelection && <p className="muted" role="status">Loading archived run...</p>}
      {!archiveLoading && !archiveMatchesSelection && !archiveError && <p className="muted empty-state">No archived run is loaded.</p>}
      {run && <>
        <div className="archived-run-actions">
          <button className="button button-secondary" type="button" onClick={() => void loadRun(run.runId)} disabled={archiveLoading}>Refresh archived snapshot</button>
          {run.previousRunId && <button className="button button-secondary" type="button" onClick={() => void loadRun(run.previousRunId!)} disabled={archiveLoading}>Open earlier run</button>}
        </div>
        <p className="archived-run-summary">{run.resetRequired ? "Reset was still required" : "Run was usable"} / {run.receipts.length} receipts / {run.unresolved.length} unresolved / {actionReferences.length} actions</p>
        <details className="archived-evidence">
          <summary>Run evidence and retained data</summary>
          <dl className="archived-facts">
            <div><dt>Run identity</dt><dd className="mono">{run.runId}{run.previousRunId ? ` / previous ${run.previousRunId}` : ""}</dd></div>
            <div><dt>Last verified baseline</dt><dd>{run.baseline ? `${run.baseline.stockBefore} to ${run.baseline.stockAfter} units / product ${run.baseline.productVersion} / verified ${formatTime(run.baseline.verifiedAt)}` : "No verified baseline in this run"}</dd></div>
            {run.originalBaseline && <div><dt>Original healthy baseline</dt><dd>{`${run.originalBaseline.stockBefore} to ${run.originalBaseline.stockAfter} units / product ${run.originalBaseline.productVersion} / verified ${formatTime(run.originalBaseline.verifiedAt)}`}</dd></div>}
          </dl>
          <div className="archive-content-grid">
            <section aria-label="Archived receipts">
              <h4 className="recovery-subheading">Retained receipts</h4>
              {run.receipts.length ? <ul className="record-list">{run.receipts.map((receipt, index) => <li key={`${receipt.checkoutId}-${index}`}><span className="mono">{display(receipt.checkoutId)}</span><strong>{display(receipt.quantity, "?")} units</strong><small>{formatTime(receipt.createdAt)} / {display(receipt.status, "unknown")}</small></li>)}</ul> : <p className="muted empty-state">No receipts were recorded in this run.</p>}
            </section>
            <section aria-label="Archived unresolved attempts">
              <h4 className="recovery-subheading">Unresolved attempts</h4>
              {run.unresolved.length ? <ul className="record-list">{run.unresolved.map((attempt) => <li key={attempt.checkoutId}><span className="mono">{attempt.checkoutId}</span><strong>Outcome unknown</strong><small>Started {formatTime(attempt.startedAt)} / retained, not resolved by Reset</small></li>)}</ul> : <p className="muted empty-state">No unresolved attempts.</p>}
            </section>
          </div>
          <section className="archived-incidents" aria-label="Archived incident records">
            <h4 className="recovery-subheading">Retained incident records</h4>
            {incidents.length ? <ul className="history-list">{incidents.map((incident, index) => <li key={`${incident.summary}-${index}`}><span>{incident.summary}</span>{incident.sourceReference && <small>Source capture reference / <span className="mono">{incident.sourceReference}</span></small>}</li>)}</ul> : <p className="muted empty-state">No incident records were recorded in this run.</p>}
            <p className="muted archive-health-note">Alarm and agent panels show current run observations only.</p>
          </section>
        </details>
        <section className="archived-actions" aria-label="Archived actions">
          <h4 className="recovery-subheading">Action records</h4>
          {actionReferences.length ? <ul className="archived-action-list">{actionReferences.map((reference) => <li key={reference.id}><span>{reference.label}</span><button className="button button-secondary" type="button" title={reference.id} aria-label={`Open ${reference.label} ${reference.id}`} onClick={() => void loadAction(reference.id)}>Open record</button></li>)}</ul> : <p className="muted empty-state">No action references were recorded for this run.</p>}
          {selectedActionId && <div className="archived-action-detail" aria-live="polite">
            <div className="card-heading"><h5>Action {selectedActionId}</h5><span className="incident-badge badge-neutral">Read only</span></div>
            {actionLoading && <p className="muted" role="status">Loading action record...</p>}
            {actionError && <p className="action-error" role="alert">{uiText(actionError)}</p>}
            {selectedAction && <>
              <p><strong>{selectedAction.kind.replaceAll("_", " ")} / {selectedAction.status}</strong></p>
              <dl className="archived-facts"><div><dt>Created</dt><dd>{formatTime(selectedAction.createdAt)}</dd></div><div><dt>Started / finished</dt><dd>{formatTime(selectedAction.startedAt)} / {formatTime(selectedAction.finishedAt)}</dd></div><div><dt>Requests</dt><dd>{selectedAction.requests.length} recorded</dd></div></dl>
              {selectedAction.reset && <dl className="archived-facts reset-action-facts"><div><dt>Fresh product version</dt><dd className="mono">{selectedAction.reset.productVersion}</dd></div><div><dt>Seed quantity</dt><dd>{selectedAction.reset.seedQuantity}</dd></div><div><dt>Run link</dt><dd className="mono">{selectedAction.reset.runId} ← {selectedAction.reset.previousRunId}</dd></div></dl>}
              {selectedAction.capacityChange && <CapacityChangeResult action={selectedAction} archived />}
              {selectedAction.error && !selectedAction.capacityChange && <p className="action-error" role="status">{uiText(selectedAction.error)}</p>}
              {selectedAction.requests.length > 0 && <details className="request-details"><summary>Recorded requests</summary><ul className="record-list">{selectedAction.requests.map((request, index) => <li key={`${request.id}-${index}`}><span>{request.kind.replaceAll("_", " ")} / {request.outcome ?? "pending"}</span><strong>{request.durationMs === undefined ? "No duration recorded" : `${request.durationMs} ms`}</strong><small className="mono">{request.requestId ?? request.checkoutId ?? request.id}{request.errorCode ? ` / ${request.errorCode}` : ""}</small></li>)}</ul></details>}
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
  const [activeView, setActiveView] = useState<ControllerView>("incident");
  const [readinessConfirmed, setReadinessConfirmed] = useState(false);
  const [protectiveRestoreConfirmed, setProtectiveRestoreConfirmed] = useState(false);
  const [protectiveRecoveryConfirmed, setProtectiveRecoveryConfirmed] = useState(false);
  const [resetConfirmationOpen, setResetConfirmationOpen] = useState(false);
  const [resetQuietConfirmed, setResetQuietConfirmed] = useState(false);
  const [resetDataConfirmed, setResetDataConfirmed] = useState(false);
  const [resetCheckoutClosedConfirmed, setResetCheckoutClosedConfirmed] = useState(false);
  const [inventoryMemorySelection, setInventoryMemorySelection] = useState<number>();
  const [inventoryCapacityTarget, setInventoryCapacityTarget] = useState("32");
  const [agentSelectionChoice, setAgentSelectionChoice] = useState<AgentCandidateId>();
  const [lastVerifiedAgentSelection, setLastVerifiedAgentSelection] = useState<{ selection: AgentSelection; observedAt: string }>();
  const [pendingCommand, setPendingCommand] = useState<PendingCommand>();
  const [pendingConfigurationCommand, setPendingConfigurationCommand] = useState<PendingCommand>();
  const [configurationSubmitting, setConfigurationSubmitting] = useState(false);
  const polling = useRef<number | undefined>(undefined);
  const alarmPolling = useRef<number | undefined>(undefined);
  const alarmReadSequence = useRef(0);
  const investigationPolling = useRef<number | undefined>(undefined);
  const resetPanelHeading = useRef<HTMLHeadingElement>(null);
  const resetStatusHeading = useRef<HTMLParagraphElement>(null);
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
    const readSequence = alarmReadSequence.current + 1;
    alarmReadSequence.current = readSequence;
    alarmPolling.current = epoch;
    try {
      const response = await fetch("/api/alarm", { headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(8_000) });
      const body = await readAlarm(response);
      if (epoch === sessionEpoch.current && readSequence === alarmReadSequence.current) {
        setAlarm(body);
        const verified = verifiedAlarmSelection(body);
        if (verified) setLastVerifiedAgentSelection({ selection: verified, observedAt: body.observedAt });
        setAlarmReadFailed(false);
      }
    } catch {
      if (epoch === sessionEpoch.current && readSequence === alarmReadSequence.current) setAlarmReadFailed(true);
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
  const checkpoint = configurationAction?.kind === "increase_capacity" ? incident?.checkpoint
    : configurationAction?.configurationCheckpoint ?? incident?.checkpoint;
  const baselineInventory = inventoryVersionObservation(baseline?.settings?.inventory);
  const capacityAction = configurationAction?.kind === "increase_capacity" ? configurationAction : undefined;
  const releaseInventoryCap = baseline?.deploymentIdentity?.inventoryCap;
  const currentInventoryCap = typeof baselineInventory?.cap === "number" && Number.isSafeInteger(baselineInventory.cap)
    ? baselineInventory.cap : undefined;
  const capacityReleaseReady = Boolean(baseline?.deploymentIdentity && releaseInventoryCap === 16 &&
    baseline.deploymentIdentity.sourceRevision === baseline.appRevision && baselineInventory?.sourceRevision === baseline.appRevision);
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
  const { currentAlias, currentVariant } = inventoryDisplay;
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
  const proposedInventoryCapacity = inventoryCapacityTarget.trim() ? Number(inventoryCapacityTarget) : Number.NaN;
  const capacityInputValid = Number.isSafeInteger(proposedInventoryCapacity) && proposedInventoryCapacity >= 16 && proposedInventoryCapacity <= 64;
  const staleCloudObservation = !lastObservedAt || !Number.isFinite(Date.parse(lastObservedAt)) || Date.now() - Date.parse(lastObservedAt) >= 15_000;
  const capacityUnavailableReason = resetRequired ? "Reset is required before changing Inventory capacity."
    : !baseline ? "Check readiness to establish the current release settings."
      : !capacityReleaseReady ? "A verified Inventory release with baseline 16 is required."
        : currentInventoryCap === undefined || currentInventoryCap < 16 ? "The current Inventory cap is not confirmed."
          : aliasUnknown ? "Inventory configuration is unknown until it is read back."
            : incidentActive || Boolean(legacyIncident) ? "Restore the Inventory access state before changing capacity."
              : trafficActive ? "Stop traffic and wait for accepted requests to settle."
                : configurationBusy ? "Wait for the configuration action to finish; discard an incomplete action after its drain window."
                  : actionBusy ? "Wait for the current action to finish."
                    : pollFailure || staleCloudObservation ? "Cloud state is stale; wait for a successful refresh before changing capacity."
                      : undefined;
  const surgeUnavailableReason = resetRequired ? "Reset is required before starting a new traffic action."
    : !baseline ? "Check readiness to establish the current release and product version."
      : !capacityReleaseReady ? "A verified current release with Inventory baseline capacity 16 is required."
        : currentInventoryCap === undefined || currentInventoryCap < 16 ? "The current Inventory capacity is not confirmed."
          : aliasUnknown ? "Inventory settings are unknown until the alias is read back."
            : incidentActive || Boolean(legacyIncident) ? "Restore healthy Inventory access before starting the surge."
              : state?.unresolved.length ? "Resolve unknown checkout attempts before starting the surge."
                : configurationBusy ? "Wait for the configuration action to finish."
                  : actionBusy ? "Wait for the current action to finish."
                    : pollFailure || staleCloudObservation ? "Cloud state is stale; wait for a successful refresh before starting the surge."
                      : !trafficStartAllowed ? "The current run is not ready for traffic."
                        : undefined;
  const capacityTargetBelowCurrent = currentInventoryCap !== undefined && capacityInputValid && proposedInventoryCapacity < currentInventoryCap;
  const capacitySelectionDisabled = Boolean(capacityUnavailableReason) || !capacityInputValid || capacityTargetBelowCurrent;
  const incompleteAction = currentAction?.status === "incomplete" ? currentAction
    : configurationAction?.status === "incomplete" ? configurationAction : undefined;
  const incompleteActionMustBeDiscarded = Boolean(incompleteAction);
  const resetDisabled = loading || anyPendingCommand || configurationBusy || incompleteActionMustBeDiscarded ||
    Boolean(currentAction && currentAction.kind !== "traffic" && activeStatuses.has(currentAction.status));
  const resetAcknowledged = resetQuietConfirmed && resetDataConfirmed && resetCheckoutClosedConfirmed;
  const resetStatusText = resetAction?.status === "queued" ? "Reset accepted / waiting to start"
    : resetAction?.status === "draining" ? "Stopping traffic and draining accepted work"
      : resetAction?.status === "running" ? "Reset running"
        : resetAction?.status === "completed" ? "Reset completed"
          : resetAction?.status === "incomplete" ? "Reset incomplete"
            : resetAction?.status === "failed" ? "Reset failed"
              : resetAction?.status === "discarded" ? "Reset discarded / a new confirmation is required"
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
    : !Number.isFinite(dashboardAgeMs) || dashboardAgeMs >= 15_000 ? "Stale cloud state" : "Connected";
  const alarmObservation = alarm?.alarm;
  const selectedTransition = normalizedTime(alarmObservation?.stateTransitionedAt);
  const exactObservedAlarmRun = alarmObservation?.state === "ALARM" && alarmObservation.arn && selectedTransition
    ? investigations?.runs.find((run) => run.alarmArn === alarmObservation.arn && normalizedTime(run.transitionAt) === selectedTransition)
    : undefined;
  const investigationAgeMs = investigations ? Date.now() - Date.parse(investigations.observedAt) : Number.POSITIVE_INFINITY;
  const investigationFreshness = !investigations ? investigationReadFailedAt ? "Unavailable" : "Loading"
    : !Number.isFinite(investigationAgeMs) || investigationAgeMs >= 10_000 ? "Stale"
      : investigationReadFailedAt ? "Refresh failed / showing last observation" : "Fresh";
  const alarmActive = alarmObservation?.state === "ALARM";
  const visibleRun = alarmActive ? exactObservedAlarmRun : investigations?.runs[0];
  const lastActiveAlarm = useRef<{ arn: string; transition: string } | undefined>(undefined);
  useEffect(() => {
    if (!bearer) lastActiveAlarm.current = undefined;
    else if (alarmActive && alarmObservation?.arn && selectedTransition) {
      lastActiveAlarm.current = { arn: alarmObservation.arn, transition: selectedTransition };
    }
  }, [bearer, alarmActive, alarmObservation?.arn, selectedTransition]);
  const followedRun = visibleRun && lastActiveAlarm.current?.arn === visibleRun.alarmArn
    && lastActiveAlarm.current.transition === normalizedTime(visibleRun.transitionAt);
  const reportsStale = Boolean(investigationReadFailedAt) || investigationFreshness === "Stale";
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
    configurationAction?.kind === "reset" || configurationAction?.kind === "increase_capacity" ? undefined : configurationAction,
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
    const isConfiguration = command.kind === "reset" || command.kind === "restore_inventory_access" || command.kind === "increase_memory" || command.kind === "increase_capacity" || command.kind === "recover" || command.kind === "select_agent";
    const setPending = isConfiguration ? setPendingConfigurationCommand : setPendingCommand;
    if (isConfiguration) setConfigurationSubmitting(true);
    else setLoading(true);
    setNotice(undefined);
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
        if (isConfiguration) setPendingConfigurationCommand(undefined);
        else setPendingCommand(undefined);
        if (command.kind === "select_agent" && action.status === "completed" && verifiedSelection(action.agentSelection)) {
          alarmReadSequence.current += 1;
          setLastVerifiedAgentSelection({ selection: action.agentSelection, observedAt: action.agentSelection.selectedAt });
        }
        if (command.kind === "readiness" || command.kind === "recover") setReadinessConfirmed(false);
        if (command.kind === "recover") setProtectiveRecoveryConfirmed(false);
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
  useEffect(() => { setInventoryCapacityTarget("32"); }, [baseline?.appRevision]);
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
  const signOut = () => { sessionEpoch.current += 1; alarmReadSequence.current += 1; setBearer(""); setState(undefined); setAlarm(undefined); setAlarmReadFailed(false); setInvestigations(undefined); setInvestigationReadFailedAt(undefined); setPendingCommand(undefined); setPendingConfigurationCommand(undefined); setConfigurationSubmitting(false); setInventoryMemorySelection(undefined); setInventoryCapacityTarget("32"); setAgentSelectionChoice(undefined); setLastVerifiedAgentSelection(undefined); setReadinessConfirmed(false); setProtectiveRestoreConfirmed(false); setProtectiveRecoveryConfirmed(false); setResetConfirmationOpen(false); setResetQuietConfirmed(false); setResetDataConfirmed(false); setResetCheckoutClosedConfirmed(false); setLastObservedAt(undefined); setPollFailure(undefined); setNotice(undefined); setLoading(false); setActiveView("incident"); };
  const runReadiness = () => { if (!resetRequired && readinessConfirmed) void sendAction(crypto.randomUUID(), { kind: "readiness", confirmQuiet: true }); };
  const runTraffic = () => { if (!resetRequired && !resetInProgress && trafficStartAllowed) void sendAction(crypto.randomUUID(), { kind: "traffic" }); };
  const runInventorySurge = () => {
    if (!surgeUnavailableReason) void sendAction(crypto.randomUUID(), { kind: "traffic", profile: "inventory_surge" });
  };
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
  const runCapacityIncrease = () => {
    if (capacitySelectionDisabled || !capacityInputValid) return;
    void sendAction(crypto.randomUUID(), { kind: "increase_capacity", function: "inventory", reservedConcurrency: proposedInventoryCapacity });
  };
  const runAgentSelection = () => {
    const candidate = selectedAgentChoice;
    if (candidate && !agentSelectionDisabled) void sendAction(crypto.randomUUID(), { kind: "select_agent", candidateId: candidate });
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
  const actions = [currentAction, configurationAction].filter((action, index, both): action is Action =>
    Boolean(action) && both.findIndex((item) => item?.id === action?.id) === index);
  const latestAction = [...actions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  // Only this locally retained value is display-trusted. Dashboard rows can
  // carry a prior run's pointer, while the current alarm response can be HTTP
  // 200 with an unavailable or mismatched native observation.
  const selectedAgent = lastVerifiedAgentSelection?.selection;
  const selectedAgentChoice = agentSelectionChoice ?? selectedAgent?.candidateId ?? "faulty";
  const nativeAlarmSelection = verifiedAlarmSelection(alarm);
  const nativeSelectionUnavailable = alarmReadFailed || Boolean(alarm?.agentEndpoint &&
    alarm.agentEndpoint.state !== "ready" && alarm.agentEndpoint.state !== "unconfigured") ||
    Boolean(alarm?.agentEndpoint?.state === "ready" && (!nativeAlarmSelection ||
      (lastVerifiedAgentSelection && !sameSelectionIdentity(nativeAlarmSelection, lastVerifiedAgentSelection.selection))));
  const selectedAgentReadUnavailable = state?.selectedAgentObservation?.state === "unavailable";
  const selectionStatus: AgentSelectionStatus = !lastVerifiedAgentSelection
    ? alarm?.agentEndpoint?.state === "unconfigured" && !selectedAgentReadUnavailable ? "unconfigured"
      : nativeSelectionUnavailable || selectedAgentReadUnavailable || Boolean(pollFailure) ? "unavailable" : "loading"
    : Boolean(pollFailure) ? "stale"
      : nativeSelectionUnavailable || selectedAgentReadUnavailable || alarm?.agentEndpoint?.state === "unconfigured" ? "unavailable"
        : "verified";
  const selectionAction = configurationAction?.kind === "select_agent" ? configurationAction : undefined;
  const selectionBusy = Boolean(selectionAction && activeStatuses.has(selectionAction.status));
  // A stale/unready endpoint is not a reason to trap the presenter: an
  // explicit candidate selection can repair that binding, and the worker will
  // verify the requested target before writing AGENT_SELECTION. Other stale
  // controller reads still block mutation because settled state is unknown.
  const canRepairNativeSelection = !alarmReadFailed && alarmObservation?.state === "OK" && Boolean(alarm?.agentEndpoint) &&
    (alarm?.agentEndpoint?.state !== "ready" || Boolean(alarm?.agentEndpoint?.state === "ready" && !nativeAlarmSelection));
  const selectionReadUnavailable = selectionStatus === "stale" || (selectionStatus === "unavailable" && !canRepairNativeSelection);
  const agentSelectionDisabled = resetRequired || configurationBusy || actionBusy || selectionBusy || !baseline ||
    Boolean(state?.unresolved.length) || !alarmObservation || selectionReadUnavailable || alarmObservation.state !== "OK" ||
    freshness(alarmObservation.observedAt) === "Stale";
  const agentSelectionDisabledReason = resetRequired ? "Reset is required before selecting an agent."
    : !baseline ? "Check readiness before selecting a prepared agent."
      : state?.unresolved.length ? "Settle unresolved checkout attempts before switching the selected agent."
        : actionBusy || configurationBusy ? "Wait for current controller work to settle before switching candidates."
          : selectionStatus === "stale" ? "The last verified selection is stale. Refresh before switching candidates."
            : selectionStatus === "unavailable" ? "The selected publication could not be verified. Refresh before switching candidates."
            : !alarmObservation ? "Waiting for a native alarm observation."
              : alarmObservation.state !== "OK" ? `Wait for the alarm to return to OK.`
                : freshness(alarmObservation.observedAt) === "Stale" ? "The native alarm observation is stale; refresh before switching."
                  : undefined;

  const reportRecord = visibleRun ? <InvestigationRecord key={visibleRun.alarmArn + visibleRun.transitionAt}
    run={visibleRun} stale={reportsStale} observedAt={investigations?.observedAt} /> : undefined;

  if (!bearer) return (
    <main className="controller-shell controller-sign-in"><section className="sign-in-card" aria-labelledby="sign-in-title">
      <div className="brand-mark" aria-hidden="true">IT</div><h1 id="sign-in-title">Failure controller</h1>
      <form onSubmit={signIn}><label htmlFor="controller-credential">Presenter credential</label><input id="controller-credential" type="password" value={credentialInput} onChange={(event) => setCredentialInput(event.target.value)} autoComplete="off" autoFocus /><button className="button button-primary" type="submit" disabled={loading}>{loading ? "Checking..." : "Sign in"}</button></form>
      {notice && <p className="notice notice-error" role="alert">{uiText(notice.message)}</p>}
    </section></main>
  );

  return (
    <main className="controller-shell" aria-label="Incident triage failure controller">
      <header className="topbar"><div className="brand"><div className="brand-mark" aria-hidden="true">IT</div><div><h1>Failure controller</h1></div></div><div className="top-actions"><span className={`connection-pill ${pollFailure || dashboardFreshness.includes("Stale") ? "connection-stale" : ""}`} role="status"><span className="status-dot" aria-hidden="true" /> {dashboardFreshness}</span><button className="button button-secondary" type="button" onClick={signOut}>Sign out</button></div></header>
      <nav className="workflow-nav" aria-label="Controller sections">
        {(["incident", "traffic", "history"] as const).map((view) => <button key={view} type="button" className={activeView === view ? "is-active" : ""}
          aria-current={activeView === view ? "page" : undefined} disabled={resetConfirmationOpen && view !== "history"} onClick={() => setActiveView(view)}>
          {view === "incident" ? "Incident" : view === "traffic" ? "Traffic" : "History"}
        </button>)}
      </nav>
      <section className="action-strip" aria-label="Action status">
        {latestAction ? <details><summary><strong>{latestAction.kind.replaceAll("_", " ")}</strong> {actionStatusLabel(latestAction.status).toLowerCase()}</summary>
          <dl className="facts"><div><dt>Action ID</dt><dd className="mono">{latestAction.id}</dd></div>
            <div><dt>Updated</dt><dd>{formatTime(latestAction.updatedAt)}</dd></div>
            <div><dt>Last refresh</dt><dd>{formatTime(lastObservedAt)}</dd></div></dl></details> : <span>No recent action</span>}
        {trafficActive && <button className="button button-stop" type="button" onClick={stopTraffic} disabled={loading || Boolean(pendingCommand) || currentStatus === "draining"}>Stop traffic</button>}
        {incompleteAction && <button className="button button-secondary" type="button" onClick={discardAction} disabled={loading || anyPendingCommand || Date.now() < incompleteAction.discardAfter}>Discard action after {formatTime(new Date(incompleteAction.discardAfter).toISOString())}</button>}
      </section>
      {actions.map((action) => action.error && <p key={action.id} className="notice notice-error" role="alert">{uiText(action.error)}</p>)}
      {resetRequired && <p className="notice notice-warning" role="alert">Reset required. {activeView !== "history" && <button className="inline-action" onClick={() => setActiveView("history")}>Go to Reset</button>}</p>}
      {resetAction && resetStatusText && (activeView === "history" || resetInProgress) && <p ref={resetStatusHeading} tabIndex={-1} role="status">
        {resetStatusText}{resetInProgress && resetPhaseText ? ` - ${resetPhaseText}` : ""}
        {resetAction.status === "incomplete" ? ". Discard this action before starting a new Reset." : ""}
      </p>}
      {notice && !pendingCommand && !pendingConfigurationCommand && <p className="notice notice-error" role="alert">{uiText(notice.message)}</p>}
      {pendingCommand && !loading && <div className="notice notice-error" role="status">
        <span>Command outcome unknown. Retry with the original ID.</span>
        <button className="inline-action" type="button" onClick={() => retryPending(pendingCommand)} disabled={loading}>Retry {pendingCommand.command.kind}</button>
      </div>}
      {pendingConfigurationCommand && !configurationSubmitting && <div className="notice notice-error" role="status">
        <span>Configuration outcome unknown. Retry with the original ID.</span>
        <button className="inline-action" type="button" onClick={() => retryPending(pendingConfigurationCommand)} disabled={loading || configurationSubmitting}>Retry {pendingConfigurationCommand.command.kind}</button>
      </div>}
      {pollFailure && <p className="notice notice-error" role="alert">{uiText(pollFailure)}. Showing the last observation.</p>}
      {activeView === "incident" && <div className="incident-workspace">
        <section className="card incident-station" aria-label="Inventory controls">
          <div className="card-heading"><h2>Inventory</h2><span className={`incident-badge ${currentAccess === "healthy" ? "badge-neutral" : "badge-warning"}`}>
            {currentAccess === "healthy" ? "Access healthy" : currentAccess === "denied" ? "Access denied" : "Access unknown"}
          </span></div>
          <label className="quiet-check"><input type="checkbox" checked={readinessConfirmed} onChange={(event) => setReadinessConfirmed(event.target.checked)} /> Other checkout writers are paused</label>
          <div className="incident-buttons">
          <button className="button button-danger" type="button" onClick={runActivation}
            disabled={resetRequired || actionBusy || configurationBusy || incidentActive || !baseline || !readinessConfirmed}>
            Activate Inventory denial
          </button>
          {!legacyIncident && <button className="button button-secondary" type="button" onClick={runRestore}
            disabled={resetRequired || !aliasIncident || restoreBusy || (needsProtectiveRestore && !protectiveRestoreConfirmed)}>
            Restore Inventory access
          </button>}
          </div>
        {aliasIncident && incidentActive && needsProtectiveRestore && <label className="quiet-check protective-check">
          <input type="checkbox" checked={protectiveRestoreConfirmed} onChange={(event) => setProtectiveRestoreConfirmed(event.target.checked)} />
          Evidence capture is unavailable. Allow protective restore of the recorded alias state.
        </label>}
          <div className="memory-control">
          <label htmlFor="inventory-memory-selection-visible">Inventory memory</label>
          <select id="inventory-memory-selection-visible" value={selectedMemoryMb ?? ""}
            disabled={resetRequired || Boolean(memorySelectionUnavailable) || configurationBusy || actionBusy}
            onChange={(event) => setInventoryMemorySelection(event.target.value ? Number(event.target.value) : undefined)}>
            {inventoryMemoryChoices.length === 0
              ? <option value="">No verified choices</option>
              : inventoryMemoryChoices.map((memoryMb) => <option key={memoryMb} value={memoryMb}
                disabled={currentMemoryMb !== undefined && memoryMb < currentMemoryMb}>
                {memoryMb} MB{memoryMb === currentMemoryMb ? " (set)" : ""}
              </option>)}
          </select>
            <button className="button button-secondary" type="button" onClick={runMemorySelection} disabled={memorySelectionDisabled}>Select memory</button>
          </div>
          {memorySelectionUnavailable && <p className="muted" role="status">{memorySelectionUnavailable}</p>}
          {incidentActive && deniedCheckout && <p className="action-error">Checkout HTTP {display(deniedCheckout.statusCode)} / {display(deniedCheckout.dependencyReason)}
            {deniedCheckout.requestId && <small className="mono"> {deniedCheckout.requestId}</small>}</p>}
          {Boolean(state?.unresolved.length) && <button className="inline-action" onClick={() => setActiveView("history")}>{state?.unresolved.length} unresolved checkout attempts</button>}
          <div className="incident-buttons session-actions">
            <button className="button button-secondary" type="button" onClick={runReadiness} disabled={resetRequired || actionBusy || configurationBusy || !readinessConfirmed}>Check readiness</button>
            <button className="button action-recover" type="button" onClick={runRecovery} disabled={recoverDisabled}>Recover</button>
          </div>
          {recoveryCaptureGap && <label className="quiet-check"><input type="checkbox" checked={protectiveRecoveryConfirmed} onChange={(event) => setProtectiveRecoveryConfirmed(event.target.checked)} /> Allow recovery without a new settings capture.</label>}
        <details className="configuration-evidence">
          <summary>Inventory evidence</summary>
          {!incidentActive && deniedCheckout && <p className="muted">Previous checkout HTTP {display(deniedCheckout.statusCode)} / {display(deniedCheckout.dependencyReason)}
            {deniedCheckout.requestId && <small className="mono"> {deniedCheckout.requestId}</small>}</p>}
        <div className="incident-grid">
          <div>
            <span className="fact-label">Current alias</span>
            <strong>{display(currentAlias?.aliasName, "Unknown")}</strong>
            <small>{display(currentAlias?.functionName, "Inventory function")} / revision {display(currentAlias?.revisionId ?? baselineInventory?.aliasRevision, "unknown")} / {currentAliasStatus}</small>
          </div>
          <div>
            <span className="fact-label">Current version</span>
            <strong>{display(aliasUnknown ? undefined : currentAlias?.functionVersion, "Unknown")}</strong>
            <small>{accessLabel(currentAccess)} / {display(currentAlias?.observedAt ?? baselineInventory?.observedAt, "No observation")}</small>
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
          <div><dt>Request impact</dt><dd>{configurationObservation ? `${display(requestImpact.catalog, "0")} catalog / ${display(requestImpact.checkout, "0")} checkout` : "No configuration request"}</dd></div>
        </dl>
        {policyObservation && <dl className="facts readonly-policy">
          <div><dt>Prepared policy</dt><dd className="mono">{display(policyObservation.policyName, "Not observed")}</dd></div>
          <div><dt>Policy state</dt><dd>{display(policyObservation.state, "unknown")}</dd></div>
        </dl>}
        {configurationObservation && configurationObservation.kind !== "recover" && <div className="configuration-result" aria-label="Configuration result details">
          <p><strong>{resultLabel(configurationObservation.configurationOutcome)}</strong> / {configurationObservation.kind === "activate_inventory_denial" ? "Denial activation" : configurationObservation.kind === "increase_memory" ? "Memory selection" : "Access restore"} / {configurationObservation.status}</p>
          <p className="muted">Alias {display(switchBefore?.functionVersion, "unknown")} to {display(switchTarget?.version, "unknown")} {switchAfter ? ` / read back ${switchAfter.functionVersion}` : " / awaiting readback"}; {configurationObservation.kind === "activate_inventory_denial" ? "bounded request observations are shown separately below" : configurationObservation.kind === "increase_memory" ? "memory selection sends no app probes" : "restore sends no app probes"}.</p>
        </div>}
        {legacyIncident && <p className="muted">This persisted {legacyIncident.mechanism === "iam-managed-policy" ? "IAM" : "DynamoDB table-policy"} incident remains visible for history only. Prepared-version controls do not mutate or restore it.</p>}
        </details>
        </section>
        <section className="card incident-station alarm-card" aria-label="Alarm and investigation">
          <div className="card-heading"><h2>Store API alarm</h2><span className={`alarm-state ${alarmTone(alarmObservation?.state)}`}>{display(alarmObservation?.state, "UNKNOWN")}</span></div>
          {alarmReadFailed || freshness(alarmObservation?.observedAt) === "Stale" ? <p className="notice notice-warning" role="status">Alarm observation is out of date.</p> : null}
          {alarm?.alarmBinding && alarm.alarmBinding.state !== "bound" && <p className="action-error" role="alert">Alarm adapter: {bindingStateLabel}</p>}
          <section className="current-investigation" aria-label={alarmActive ? "Current investigation" : "Last investigation"}>
            {alarmActive ? <>
              <h3>Current investigation</h3>
              {reportRecord ?? <p className="muted" role="status">{reportsStale || investigationFreshness === "Unavailable"
                ? "Investigation unavailable." : "Waiting for this alarm's investigation."}</p>}
            </> : visibleRun ? <details className="last-investigation" open={Boolean(followedRun)} key={visibleRun.alarmArn + visibleRun.transitionAt}>
              <summary>Last investigation</summary>{reportRecord}
            </details> : <p className="muted" role="status">{reportsStale || investigationFreshness === "Unavailable"
              ? "Investigation unavailable." : investigations ? "No investigations yet." : "Loading investigations..."}</p>}
          </section>
          <AgentSelectionPanel
            selection={selectedAgent}
            observedAt={lastVerifiedAgentSelection?.observedAt}
            status={selectionStatus}
            action={selectionAction}
            selectedChoice={selectedAgentChoice}
            disabled={agentSelectionDisabled}
            disabledReason={agentSelectionDisabledReason}
            onChoice={setAgentSelectionChoice}
            onSelect={runAgentSelection}
          />
          <details className="configuration-evidence"><summary>Alarm evidence</summary>
            <p>{display(alarmObservation?.name, "Unknown alarm")}</p>
            <p className="mono">{alarmObservation?.arn}</p>
            <p>{uiText(alarmObservation?.reason ?? "No observation yet")}</p>
          <dl className="observation-facts">
            <div><dt>Transition</dt><dd>{formatTime(alarmObservation?.stateTransitionedAt)}</dd></div>
            <div><dt>State update</dt><dd>{formatTime(alarmObservation?.stateUpdatedAt)}</dd></div>
            <div><dt>Observed</dt><dd>{formatTime(alarmObservation?.observedAt)} / {freshness(alarmObservation?.observedAt)}</dd></div>
            <div><dt>Agent endpoint</dt><dd>{endpointStateLabel}{alarm?.agentEndpoint?.liveVersion ? ` / live v${alarm.agentEndpoint.liveVersion}` : ""}</dd></div>
            <div><dt>Alarm adapter</dt><dd>{bindingStateLabel}</dd></div>
          </dl>
            {alarm?.agentEndpoint?.failureReason && <p>{uiText(alarm.agentEndpoint.failureReason)}</p>}
          {retainedAlarm && <p className="retained-observation">
            Retained checkpoint alarm <strong>{retainedAlarm.state}</strong>
            {" / "}transition {formatTime(retainedAlarm.stateTransitionedAt)}
            {" / "}observed {formatTime(retainedAlarm.observedAt)}
          </p>}
          </details>
        </section>
      </div>}
      {(activeView === "history" || (activeView === "incident" && latestAction?.id === recoveryAction?.id)) && recoveryAction && state && <RecoveryPanel action={recoveryAction} state={state}
        trafficAction={currentAction?.kind === "traffic" ? currentAction : undefined}
        currentAlias={currentAlias} currentMemoryMb={currentMemoryMb} currentAccess={currentAccess} />}
      {activeView === "traffic" && <section className="card traffic-toolbar"><h2>Healthy traffic</h2>
        <button className="button button-secondary" type="button" onClick={runTraffic} disabled={resetRequired || actionBusy || !baseline || !trafficStartAllowed}>Start healthy traffic</button>
      </section>}
      {activeView === "traffic" && <TrafficSurgePanel bearer={bearer} currentAction={currentAction} latestSurgeActionId={state?.lastSurgeActionId}
        disabled={Boolean(surgeUnavailableReason)} disabledReason={surgeUnavailableReason} onStart={runInventorySurge} onRepeat={runInventorySurge} />}
      {activeView === "traffic" && <section className="card capacity-panel" aria-label="Inventory capacity">
        <div className="card-heading"><h2>Inventory capacity</h2><span>{currentInventoryCap === undefined ? "Cap unknown" : `Current cap: ${currentInventoryCap}`}</span></div>
        <form className="memory-control" onSubmit={(event) => { event.preventDefault(); runCapacityIncrease(); }}>
          <label htmlFor="inventory-capacity-target">Inventory reserved concurrency</label>
          <input id="inventory-capacity-target" type="number" min="16" max="64" step="1" value={inventoryCapacityTarget}
            disabled={Boolean(capacityUnavailableReason)} onChange={(event) => setInventoryCapacityTarget(event.target.value)} />
          <button className="button button-secondary" type="submit" disabled={capacitySelectionDisabled}>Increase Inventory capacity</button>
        </form>
        {(capacityUnavailableReason || !capacityInputValid || capacityTargetBelowCurrent) && <p role="status">{capacityUnavailableReason ??
          (capacityTargetBelowCurrent ? `Use at least the current cap of ${currentInventoryCap}.` : "Enter a whole number from 16 to 64.")}</p>}
        <details className="configuration-evidence"><summary>Capacity evidence</summary>
          <dl className="facts"><div><dt>Release baseline</dt><dd>{capacityValueLabel(releaseInventoryCap)}</dd></div>
          <div><dt>Observed cap</dt><dd>{capacityValueLabel(baselineInventory?.cap)} / {formatTime(baselineInventory?.observedAt)}</dd></div>
          <div><dt>Release</dt><dd className="mono">{display(baseline?.deploymentIdentity?.sourceRevision)}</dd></div></dl>
        </details>
        {capacityAction && <CapacityChangeResult action={capacityAction} />}
      </section>}
      {activeView === "traffic" && <details className="secondary-evidence" id="evidence">
        <summary>Release and traffic evidence</summary>
      <section className="summary-grid" aria-label="Run summary"><article className="card"><p className="eyebrow">Last verified health</p><dl className="facts"><div><dt>App revision</dt><dd className="mono">{display(baseline?.appRevision, "Not verified")}</dd></div><div><dt>Product</dt><dd>{display(baseline?.sku, "Not verified")}</dd></div><div><dt>Product version</dt><dd className="mono">{display(baseline?.productVersion, "Not verified")}</dd></div></dl></article><article className="card stock-card"><p className="eyebrow">Inventory</p><strong className="stock-value">{resetRequired ? "-" : display(state?.latestStock ?? baseline?.stockAfter, "-")}</strong><p className="muted">{resetRequired ? "Current run is unusable; stock is not shown as verified." : `Units / observed ${formatTime(state?.latestStockAt)}`}</p></article><article className="card"><p className="eyebrow">Readiness order</p><p className="mono compact">{display(baseline?.checkoutId, "No verification order")}</p><p className="muted">{resetRequired ? "Reset required; this run has no verified order." : baseline ? `${display(baseline.stockBefore)} to ${display(baseline.stockAfter)} units / verified ${formatTime(baseline.verifiedAt)}` : "A verified order will establish the baseline."}</p></article></section>
      <section className="traffic-grid" aria-label="Traffic progress">{(["catalog", "checkout"] as const).map((profile) => { const value = currentAction?.traffic?.[profile]; return <article className="card traffic-card" key={profile}><div className="card-heading"><div><p className="eyebrow">{profile} traffic</p><h3>{profile === "catalog" ? "Catalog reads" : "Checkout posts"}</h3></div></div><div className="metric-row">{([["submitted", "sent"], ["completed", "settled"], ["succeeded", "succeeded"], ["skipped", "skipped"], ["inFlight", "in flight"]] as const).map(([field, label]) => <div key={field}><strong>{display(value?.[field], "0")}</strong><span>{label}</span></div>)}</div></article>; })}</section>
      {currentAction?.requests.length ? <details className="card request-details"><summary>Recent requests for this action</summary><ul className="record-list">{currentAction.requests.slice(-10).reverse().map((request) => <li key={request.id}><span>{request.kind.replace("_", " ")} / {request.outcome ?? "pending"}</span><strong>{request.durationMs === undefined ? "In progress" : `${request.durationMs} ms`}</strong><small className="mono">{request.requestId ?? "No app request ID"}{request.errorCode ? ` / ${request.errorCode}` : ""}{request.dependencyReason ? ` / ${request.dependencyReason}` : ""}</small></li>)}</ul></details> : null}
      </details>}
      {activeView === "history" && <div id="session-history">
        {state && <RunHistoryPanel currentRunId={state.runId} previousRunId={state.previousRunId} currentResetRequired={resetRequired} bearer={bearer} />}
      </div>}
      {activeView === "history" && <section className="card reset-card" aria-label="Reset demo data">
        <div className="card-heading">
          <div><h3 ref={resetPanelHeading} tabIndex={-1}>Reset business data</h3></div>
          <button ref={resetTrigger} className="button button-danger" type="button" onClick={openResetConfirmation} disabled={resetDisabled}>
            Reset demo
          </button>
        </div>
        {incompleteActionMustBeDiscarded && <p className="notice notice-warning" role="status">Discard the incomplete action after its drain window.</p>}
        {resetConfirmationOpen && <section className="reset-confirmation" aria-labelledby="reset-confirmation-title">
          <h4 id="reset-confirmation-title" tabIndex={-1}>Reset this session?</h4>
          <p>Reset replaces all orders and restores healthy settings. One verification order leaves 999 of 1,000 units.</p>
          <fieldset className="reset-acknowledgements">
            <legend>Before resetting</legend>
            <label><input ref={resetFocusTarget} type="checkbox" checked={resetQuietConfirmed} onChange={(event) => setResetQuietConfirmed(event.target.checked)} /> Other checkout writers are paused.</label>
            <label><input type="checkbox" checked={resetDataConfirmed} onChange={(event) => setResetDataConfirmed(event.target.checked)} /> Delete existing orders and reseed Inventory.</label>
            <label><input type="checkbox" checked={resetCheckoutClosedConfirmed} onChange={(event) => setResetCheckoutClosedConfirmed(event.target.checked)} /> Old checkout pages are closed.</label>
          </fieldset>
          <div className="reset-confirmation-actions">
            <button className="button button-danger" type="button" onClick={runReset} disabled={resetDisabled || !resetAcknowledged}>Confirm Reset</button>
            <button className="button button-secondary" type="button" onClick={cancelResetConfirmation}>Cancel</button>
          </div>
        </section>}
      </section>}
      {activeView === "history" && <section className="card"><div className="card-heading"><h2>Investigations</h2></div>
        {reportsStale && <p role="status">Investigation history is out of date.</p>}
        {investigations?.runs.map((run) => <details className="history-run" key={run.alarmArn + run.transitionAt}>
          <summary>{new Date(run.transitionAt).toLocaleString()} / {run.status}</summary>
          <InvestigationRecord run={run} stale={reportsStale} observedAt={investigations.observedAt} /></details>)}
        {!investigations?.runs.length && <p>{!investigations ? investigationReadFailedAt ? "History unavailable." : "Loading..." : "No investigations yet."}</p>}
      </section>}
      {activeView === "history" && <details className="secondary-evidence">
        <summary>Receipts and unresolved attempts</summary>
      <section className="detail-grid"><article className="card"><div className="card-heading"><div><p className="eyebrow">Receipts</p><h3>Confirmed orders</h3></div><span className="source-time">Cloud state</span></div>{state?.receipts?.length ? <ul className="record-list">{state.receipts.map((receipt, index) => <li key={String(receipt.checkoutId ?? index)}><span className="mono">{display(receipt.checkoutId)}</span><strong>{display(receipt.quantity, "?")} units</strong><small>{formatTime(receipt.createdAt)}</small></li>)}</ul> : <p className="muted empty-state">No controller receipts recorded yet.</p>}</article><article className="card"><div className="card-heading"><div><p className="eyebrow">Follow-up</p><h3>Unresolved attempts</h3></div><span className="source-time">Cloud state</span></div>{state?.unresolved?.length ? <ul className="record-list">{state.unresolved.map((attempt, index) => <li key={String(attempt.checkoutId ?? index)}><span className="mono">{display(attempt.checkoutId)}</span><strong>{display(attempt.status, "unknown")}</strong><small>{formatTime(attempt.startedAt)}</small></li>)}</ul> : <p className="muted empty-state">No unresolved attempts.</p>}</article></section>
      </details>}
    </main>
  );
}
