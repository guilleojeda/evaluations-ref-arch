import { randomUUID } from "node:crypto";
import { DynamoDBClient, GetItemCommand, TransactWriteItemsCommand, type TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { setTimeout as delay } from "node:timers/promises";
import type { Action, Command, Counters, DashboardState, RunState, TrafficProfileSnapshot } from "./types";

const dynamo = new DynamoDBClient({ maxAttempts: 1 });
const runKey = "STATE";
const actionKey = (id: string) => `ACTION#${id}`;
const timestamp = () => new Date().toISOString();
const active = new Set<Action["status"]>(["queued", "running", "draining"]);

const inventorySurgeProfile: TrafficProfileSnapshot = {
  name: "inventory_surge",
  version: 2,
  durationMs: 15_000,
  catalog: { ratePerSecond: 60, batchSize: 30, batchIntervalMs: 500, maxAttempts: 900, maxInFlight: 30, requestTimeoutMs: 7_000 },
  checkout: { intervalMs: 1_000, maxAttempts: 15, maxInFlight: 1, requestTimeoutMs: 7_000 },
};

interface Row<T> {
  pk: string;
  revision: number;
  data: T;
}

export class CommandError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

function table(): string {
  const name = process.env.CONTROLLER_RUN_TABLE;
  if (!name) throw new Error("Controller table is unavailable");
  return name;
}

function initialRun(): RunState {
  return {
    runId: "legacy",
    resetRequired: false,
    baseline: null,
    receipts: [],
    unresolved: [],
  };
}

function normalizeRun(run: RunState | undefined): RunState {
  if (!run) return initialRun();
  return { ...run, runId: run.runId ?? "legacy", resetRequired: run.resetRequired ?? false };
}

async function read<T>(pk: string): Promise<Row<T> | undefined> {
  const result = await dynamo.send(new GetItemCommand({
    TableName: table(), Key: { pk: { S: pk } }, ConsistentRead: true,
  }), { abortSignal: AbortSignal.timeout(3_000) });
  // The controller owns this table and writes each record through replace().
  return result.Item ? unmarshall(result.Item) as Row<T> : undefined;
}

function replace<T>(pk: string, previous: Row<T> | undefined, data: T): TransactWriteItem {
  return {
    Put: {
      TableName: table(),
      Item: marshall({ pk, revision: (previous?.revision ?? 0) + 1, data }, { removeUndefinedValues: true }),
      ConditionExpression: previous ? "#revision = :previous" : "attribute_not_exists(pk)",
      ...(previous ? {
        ExpressionAttributeNames: { "#revision": "revision" },
        ExpressionAttributeValues: { ":previous": { N: String(previous.revision) } },
      } : {}),
    },
  };
}

async function commit(writes: TransactWriteItem[]): Promise<boolean> {
  try {
    await dynamo.send(new TransactWriteItemsCommand({ TransactItems: writes }), {
      abortSignal: AbortSignal.timeout(3_000),
    });
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionConflictException") return false;
    if (error instanceof Error && error.name === "TransactionCanceledException" && "CancellationReasons" in error) {
      const reasons = error.CancellationReasons;
      if (Array.isArray(reasons) && reasons.some(({ Code }) => ["ConditionalCheckFailed", "TransactionConflict"].includes(Code)) &&
          reasons.every(({ Code }) => [undefined, "None", "ConditionalCheckFailed", "TransactionConflict"].includes(Code))) {
        return false;
      }
    }
    throw error;
  }
}

function visible(action: Action, now = Date.now()): Action {
  const expired = action.status === "queued" ? now >= action.claimBy : now >= action.deadlineAt;
  if (!active.has(action.status) || !expired) return action;
  return { ...action, status: "incomplete", error: "The action passed its deadline. Inspect any unresolved requests before discarding it." };
}

export async function getRun(): Promise<RunState> {
  return normalizeRun((await read<RunState>(runKey))?.data);
}

export async function getRunById(id: string): Promise<RunState | undefined> {
  const current = await read<RunState>(runKey);
  if (normalizeRun(current?.data).runId === id) return normalizeRun(current?.data);
  const archived = await read<RunState>(`RUN#${id}`);
  if (!archived) return undefined;
  return normalizeRun(archived.data);
}

export async function getAction(id: string): Promise<Action | undefined> {
  const row = await read<Action>(actionKey(id));
  return row && visible(row.data);
}

export async function getDashboard(): Promise<DashboardState> {
  const run = await getRun();
  const currentAction = run.currentActionId && await getAction(run.currentActionId);
  const currentConfigurationAction = run.configurationActionId && await getAction(run.configurationActionId);
  return { ...run, currentAction: currentAction || undefined, currentConfigurationAction: currentConfigurationAction || undefined, observedAt: timestamp() };
}

function sameCommand(a: Command, b: Command): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "traffic" && b.kind === "traffic") return (a.profile ?? undefined) === (b.profile ?? undefined);
  if ("targetActionId" in a) return "targetActionId" in b && a.targetActionId === b.targetActionId;
  if ("targetActionId" in b) return false;
  if (a.kind === "restore_inventory_access" && b.kind === "restore_inventory_access") {
    return Boolean(a.restoreWithoutEvidence) === Boolean(b.restoreWithoutEvidence);
  }
  if (a.kind === "recover" && b.kind === "recover") {
    return a.confirmQuiet === b.confirmQuiet && Boolean(a.recoverWithoutEvidence) === Boolean(b.recoverWithoutEvidence);
  }
  if (a.kind === "reset" && b.kind === "reset") {
    return a.confirmQuiet === b.confirmQuiet && a.confirmReset === b.confirmReset &&
      a.confirmCheckoutClosed === b.confirmCheckoutClosed;
  }
  if (a.kind === "increase_memory" && b.kind === "increase_memory") {
    return a.function === b.function && a.memoryMb === b.memoryMb;
  }
  if (a.kind === "increase_capacity" && b.kind === "increase_capacity") {
    return a.function === b.function && a.reservedConcurrency === b.reservedConcurrency;
  }
  return true;
}

function counters(): Counters {
  return { submitted: 0, completed: 0, succeeded: 0, skipped: 0, inFlight: 0 };
}

function newAction(id: string, command: Command, now: number): Action {
  const time = new Date(now).toISOString();
  return {
    id, kind: command.kind, command, status: "queued", createdAt: time, updatedAt: time,
    claimBy: now + 30_000, deadlineAt: now + 75_000, discardAfter: now + 105_000,
    requests: [],
    ...(command.kind === "traffic" ? { traffic: { catalog: counters(), checkout: counters() } } : {}),
    ...(command.kind === "traffic" && command.profile === "inventory_surge"
      ? { trafficProfile: structuredClone(inventorySurgeProfile) } : {}),
    ...(command.kind === "recover" ? { recoveryProgress: "stopping" as const } : {}),
    ...(command.kind === "reset" ? { reset: {
      runId: id,
      previousRunId: "legacy",
      productVersion: randomUUID(),
      seedQuantity: 1000 as const,
      phase: "stopping" as const,
    } } : {}),
  };
}

function inventoryDenialOutstanding(run: RunState): boolean {
  const incident = run.incident;
  if (!incident || incident.kind !== "inventory_access_denied") return false;
  if (incident.mechanism === "lambda-alias") return incident.active !== "healthy";
  return !incident.policy || incident.policy.state !== "absent";
}

function canStart(run: RunState, action: Action | undefined, configuration: Action | undefined, command: Command): void {
  const canRecoverTraffic = command.kind === "recover" && action?.kind === "traffic";
  const canResetTraffic = command.kind === "reset" && action?.kind === "traffic";
  if (run.resetRequired && command.kind !== "reset") {
    throw new CommandError(409, "RESET_REQUIRED", "Start a new confirmed Reset before using the incomplete session.");
  }
  if (action && active.has(action.status) && !(command.kind === "restore_inventory_access" && action.kind === "traffic") &&
      !canRecoverTraffic && !canResetTraffic) {
    throw new CommandError(409, "ACTION_IN_PROGRESS", "Wait for the current action or stop its traffic.");
  }
  if (action?.status === "incomplete") {
    throw new CommandError(409, "ACTION_INCOMPLETE", "Inspect and discard the incomplete action before starting another.");
  }
  if (configuration?.status === "incomplete") {
    throw new CommandError(409, "ACTION_INCOMPLETE", "Inspect and discard the incomplete configuration action before continuing.");
  }
  if (configuration && active.has(configuration.status)) {
    throw new CommandError(409, "CONFIGURATION_IN_PROGRESS", "Wait for the current configuration action to settle.");
  }
  if (command.kind === "traffic") {
    if (!run.baseline) throw new CommandError(409, "READINESS_REQUIRED", "Check readiness before starting traffic.");
    if (run.inventoryAliasUnknown) throw new CommandError(409, "INVENTORY_ALIAS_UNKNOWN", "Verify the Inventory alias with readiness before starting traffic.");
    const incident = run.incident;
    const confirmedDenial = incident?.mechanism === "lambda-alias" && incident.active === "denied";
    if (inventoryDenialOutstanding(run) && !confirmedDenial) {
      throw new CommandError(409, "INVENTORY_DENIAL_UNRESOLVED", "Reconcile the recorded Inventory access change before starting traffic.");
    }
  }
  if (command.kind === "reset" && configuration && active.has(configuration.status)) {
    throw new CommandError(409, "CONFIGURATION_IN_PROGRESS", "Wait for the current configuration action to settle before Reset.");
  }
  if (command.kind === "activate_inventory_denial") {
    if (!run.baseline) throw new CommandError(409, "READINESS_REQUIRED", "Check readiness before activating an Inventory denial.");
    if (run.inventoryAliasUnknown) throw new CommandError(409, "INVENTORY_ALIAS_UNKNOWN", "Verify the Inventory alias with readiness before activating an Inventory denial.");
    if (run.unresolved.length > 0) throw new CommandError(409, "UNRESOLVED_REQUESTS", "Settle unresolved checkout attempts before activating a denial.");
    if (inventoryDenialOutstanding(run)) throw new CommandError(409, "INCIDENT_ALREADY_ACTIVE", "Restore the recorded Inventory access change before activating another denial.");
    if (configuration && active.has(configuration.status)) throw new CommandError(409, "CONFIGURATION_IN_PROGRESS", "Wait for the current configuration action to settle.");
    if (action?.kind === "traffic" && active.has(action.status)) throw new CommandError(409, "TRAFFIC_ACTIVE", "Stop traffic before activating an Inventory denial.");
    if (action?.traffic && Object.values(action.traffic).some((value) => value.inFlight > 0)) throw new CommandError(409, "TRAFFIC_DRAINING", "Wait for accepted traffic to settle before activating an Inventory denial.");
  }
  if (command.kind === "restore_inventory_access") {
    if (run.incident?.mechanism !== "lambda-alias") throw new CommandError(409, "NO_INVENTORY_DENIAL", "There is no recorded Inventory alias denial to restore.");
    if (action && active.has(action.status) && action.kind !== "traffic") throw new CommandError(409, "ACTION_IN_PROGRESS", "Wait for the current primary action to settle before restoring access.");
  }
  if (command.kind === "increase_memory") {
    if (run.inventoryAliasUnknown) throw new CommandError(409, "INVENTORY_ALIAS_UNKNOWN", "Verify the Inventory alias with readiness before changing memory.");
    if (!run.baseline) throw new CommandError(409, "READINESS_REQUIRED", "Check readiness before changing Inventory memory.");
    if (run.unresolved.length > 0) throw new CommandError(409, "UNRESOLVED_REQUESTS", "Settle unresolved checkout attempts before changing Inventory memory.");
    if (run.incident && run.incident.mechanism !== "lambda-alias") {
      throw new CommandError(409, "INVENTORY_DENIAL_UNRESOLVED", "Reconcile the recorded Inventory access change before changing memory.");
    }
    if (run.incident?.mechanism === "lambda-alias" && run.incident.active === "unknown") {
      throw new CommandError(409, "INVENTORY_DENIAL_UNRESOLVED", "Reconcile the recorded Inventory alias before changing memory.");
    }
  }
  if (command.kind === "increase_capacity") {
    if (!run.baseline?.deploymentIdentity || !run.originalBaseline?.deploymentIdentity) {
      throw new CommandError(409, "READINESS_REQUIRED", "Check readiness against the current app release before changing capacity.");
    }
    if (run.inventoryAliasUnknown) {
      throw new CommandError(409, "INVENTORY_ALIAS_UNKNOWN", "Verify the Inventory alias with readiness before changing capacity.");
    }
    if (run.unresolved.length > 0) {
      throw new CommandError(409, "UNRESOLVED_REQUESTS", "Settle unresolved checkout attempts before changing capacity.");
    }
    if (run.incident && run.incident.mechanism !== "lambda-alias") {
      throw new CommandError(409, "INVENTORY_DENIAL_UNRESOLVED", "Reconcile the recorded Inventory access change before changing capacity.");
    }
    if (run.incident?.mechanism === "lambda-alias" && run.incident.active === "unknown") {
      throw new CommandError(409, "INVENTORY_DENIAL_UNRESOLVED", "Reconcile the recorded Inventory alias before changing capacity.");
    }
  }
}

function controlled(target: Action, command: Extract<Command, { targetActionId: string }>, now: number): Action {
  const time = new Date(now).toISOString();
  const observed = visible(target, now);
  if (command.kind === "discard") {
    if (observed.status !== "incomplete" || now < target.discardAfter) throw new CommandError(409, "ACTION_NOT_DISCARDABLE", "Wait for the action's execution and drain window to end.");
    return { ...target, status: "discarded", finishedAt: time, updatedAt: time };
  }
  if (target.kind !== "traffic" || !active.has(observed.status)) throw new CommandError(409, "TRAFFIC_NOT_ACTIVE", "The current action has no active traffic to stop.");
  const neverStarted = target.status === "queued";
  return { ...target, status: neverStarted ? "stopped" : "draining", stopRequested: true, updatedAt: time, ...(neverStarted ? { finishedAt: time } : {}) };
}

function pointerFor(run: RunState, actionId: string): "currentActionId" | "configurationActionId" | undefined {
  if (run.currentActionId === actionId) return "currentActionId";
  if (run.configurationActionId === actionId) return "configurationActionId";
  return undefined;
}

export async function applyCommand(id: string, command: Command): Promise<{ action: Action; created: boolean }> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const [prior, runRow] = await Promise.all([read<Action>(actionKey(id)), read<RunState>(runKey)]);
    if (prior) {
      if (!sameCommand(prior.data.command, command)) throw new CommandError(409, "ACTION_ID_CONFLICT", "This action ID is already used by a different command.");
      return { action: visible(prior.data), created: false };
    }
    const run = normalizeRun(runRow?.data);
    const storedRun = runRow?.data;
    const [current, configuration] = await Promise.all([
      run.currentActionId ? read<Action>(actionKey(run.currentActionId)) : Promise.resolve(undefined),
      run.configurationActionId ? read<Action>(actionKey(run.configurationActionId)) : Promise.resolve(undefined),
    ]);
    if ((run.currentActionId && !current) || (run.configurationActionId && !configuration)) throw new Error("The current action record is unavailable");
    const inheritedTrafficId = current?.data.kind === "traffic" ? current.data.id
      : current?.data.kind === "reset" ? current.data.reset?.trafficActionId : undefined;
    const linkedTraffic = inheritedTrafficId && inheritedTrafficId !== current?.data.id
      ? await read<Action>(actionKey(inheritedTrafficId))
      : current;

    const now = Date.now();
    const action = newAction(id, command, now);
    if (command.kind === "reset") {
      action.reset = {
        ...action.reset!,
        previousRunId: run.runId,
        ...(run.currentActionId ? { previousCurrentActionId: run.currentActionId } : {}),
        ...(run.configurationActionId ? { previousConfigurationActionId: run.configurationActionId } : {}),
        ...(linkedTraffic?.data.kind === "traffic" && active.has(visible(linkedTraffic.data, now).status)
          ? { trafficActionId: linkedTraffic.data.id } : {}),
      };
    }
    let nextRun = storedRun ?? initialRun();
    if (command.kind === "traffic" && command.profile === "inventory_surge") {
      action.previousSurgeActionId = run.lastSurgeActionId;
      nextRun = { ...nextRun, lastSurgeActionId: id };
    }
    const writes: TransactWriteItem[] = [];
    if ("targetActionId" in command) {
      const target = (current?.data.id === command.targetActionId ? current : undefined) ?? (configuration?.data.id === command.targetActionId ? configuration : undefined);
      if (!target || !pointerFor(run, command.targetActionId)) throw new CommandError(409, "ACTION_NOT_CURRENT", "This command must target the current action.");
      writes.push(replace(target.pk, target, controlled(target.data, command, now)));
      action.status = "completed";
      action.finishedAt = action.createdAt;
    } else {
      canStart(run, current && visible(current.data, now), configuration && visible(configuration.data, now), command);
      if (command.kind === "recover" && current?.data.kind === "traffic" && active.has(visible(current.data, now).status)) {
        writes.push(replace(current.pk, current, controlled(current.data,
          { kind: "stop", targetActionId: current.data.id }, now)));
      }
      if (command.kind === "reset" || command.kind === "restore_inventory_access" || command.kind === "increase_memory" ||
          command.kind === "increase_capacity" || command.kind === "recover") {
        nextRun = { ...nextRun, configurationActionId: id };
      } else if (command.kind === "readiness") {
        nextRun = { ...nextRun, currentActionId: id };
      } else nextRun = { ...nextRun, currentActionId: id };
    }
    writes.push(replace(runKey, runRow, nextRun), replace(actionKey(id), undefined, action));
    if (await commit(writes)) return { action, created: true };
    await delay(25 * (attempt + 1));
  }
  throw new CommandError(409, "ACTION_CHANGED", "The run changed while accepting this command. Read its state and retry the same command.");
}

/** Archives the quiescent session and makes the new unusable-until-verified session durable. */
export async function beginReset(actionId: string): Promise<{ run: RunState; action: Action } | undefined> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const [runRow, actionRow] = await Promise.all([read<RunState>(runKey), read<Action>(actionKey(actionId))]);
    if (!actionRow || actionRow.data.kind !== "reset" || actionRow.data.status !== "running" || !actionRow.data.reset ||
        !runRow || runRow.data.configurationActionId !== actionId) return;

    const currentRun = normalizeRun(runRow.data);
    const action = structuredClone(actionRow.data);
    const metadata = action.reset!;
    if (metadata.runId !== actionId || metadata.previousRunId !== currentRun.runId || currentRun.runId === actionId) return;
    const archived = structuredClone(runRow.data);
    archived.runId = metadata.previousRunId;
    archived.resetRequired = currentRun.resetRequired;
    if (archived.currentActionId === actionId) {
      if (metadata.previousCurrentActionId) archived.currentActionId = metadata.previousCurrentActionId;
      else delete archived.currentActionId;
    }
    if (metadata.previousConfigurationActionId) archived.configurationActionId = metadata.previousConfigurationActionId;
    else delete archived.configurationActionId;
    const archiveRow = await read<RunState>(`RUN#${metadata.previousRunId}`);
    if (archiveRow) throw new Error("The previous controller session is already archived");

    const nextRun: RunState = {
      runId: metadata.runId,
      previousRunId: metadata.previousRunId,
      resetRequired: true,
      currentActionId: actionId,
      baseline: null,
      receipts: [],
      unresolved: [],
    };
    metadata.phase = "validating";
    action.updatedAt = timestamp();
    const writes = [
      replace(`RUN#${metadata.previousRunId}`, undefined, archived),
      replace(runKey, runRow, nextRun),
      replace(actionKey(actionId), actionRow, action),
    ];
    if (await commit(writes)) return { run: nextRun, action };
    await delay(25 * (attempt + 1));
  }
  throw new CommandError(409, "ACTION_CHANGED", "The run changed before Reset could archive it. Read its state and retry with a new confirmed Reset.");
}

export async function changeAction(actionId: string, mutate: (run: RunState, action: Action) => boolean): Promise<{ run: RunState; action: Action } | undefined> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const [runRow, actionRow] = await Promise.all([read<RunState>(runKey), read<Action>(actionKey(actionId))]);
    if (!runRow || !actionRow || !active.has(actionRow.data.status)) return;
    if (!pointerFor(runRow.data, actionId)) return;
    const run = structuredClone(runRow.data);
    const action = structuredClone(actionRow.data);
    if (!mutate(run, action)) return;
    action.updatedAt = timestamp();
    if (await commit([replace(runKey, runRow, run), replace(actionRow.pk, actionRow, action)])) return { run, action };
    await delay(25 * (attempt + 1));
  }
  throw new Error("The controller action changed before it could be recorded");
}
