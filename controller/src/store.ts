import { DynamoDBClient, GetItemCommand, TransactWriteItemsCommand, type TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { setTimeout as delay } from "node:timers/promises";
import type { Action, Command, Counters, DashboardState, RunState } from "./types";

const dynamo = new DynamoDBClient({ maxAttempts: 1 });
const runKey = "STATE";
const actionKey = (id: string) => `ACTION#${id}`;
const timestamp = () => new Date().toISOString();
const active = new Set<Action["status"]>(["queued", "running", "draining"]);

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
    baseline: null,
    receipts: [],
    unresolved: [],
  };
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
  return (await read<RunState>(runKey))?.data ?? initialRun();
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
  if ("targetActionId" in a) return "targetActionId" in b && a.targetActionId === b.targetActionId;
  if ("targetActionId" in b) return false;
  if (a.kind === "restore_inventory_access" && b.kind === "restore_inventory_access") {
    return Boolean(a.restoreWithoutEvidence) === Boolean(b.restoreWithoutEvidence);
  }
  if (a.kind === "recover" && b.kind === "recover") {
    return a.confirmQuiet === b.confirmQuiet && Boolean(a.recoverWithoutEvidence) === Boolean(b.recoverWithoutEvidence);
  }
  if (a.kind === "increase_memory" && b.kind === "increase_memory") {
    return a.function === b.function && a.memoryMb === b.memoryMb;
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
    ...(command.kind === "recover" ? { recoveryProgress: "stopping" as const } : {}),
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
  if (action && active.has(action.status) && !(command.kind === "restore_inventory_access" && action.kind === "traffic") && !canRecoverTraffic) {
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
    const run = runRow?.data ?? initialRun();
    const [current, configuration] = await Promise.all([
      run.currentActionId ? read<Action>(actionKey(run.currentActionId)) : Promise.resolve(undefined),
      run.configurationActionId ? read<Action>(actionKey(run.configurationActionId)) : Promise.resolve(undefined),
    ]);
    if ((run.currentActionId && !current) || (run.configurationActionId && !configuration)) throw new Error("The current action record is unavailable");

    const now = Date.now();
    const action = newAction(id, command, now);
    let nextRun = run;
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
      if (command.kind === "restore_inventory_access" || command.kind === "increase_memory" || command.kind === "recover") {
        nextRun = { ...run, configurationActionId: id };
      } else if (command.kind === "readiness") {
        nextRun = { ...run, currentActionId: id };
      } else nextRun = { ...run, currentActionId: id };
    }
    writes.push(replace(runKey, runRow, nextRun), replace(actionKey(id), undefined, action));
    if (await commit(writes)) return { action, created: true };
    await delay(25 * (attempt + 1));
  }
  throw new CommandError(409, "ACTION_CHANGED", "The run changed while accepting this command. Read its state and retry the same command.");
}

export async function changeAction(actionId: string, mutate: (run: RunState, action: Action) => boolean): Promise<{ run: RunState; action: Action } | undefined> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const [runRow, actionRow] = await Promise.all([read<RunState>(runKey), read<Action>(actionKey(actionId))]);
    if (!runRow || !pointerFor(runRow.data, actionId) || !actionRow || !active.has(actionRow.data.status)) return;
    const run = structuredClone(runRow.data);
    const action = structuredClone(actionRow.data);
    if (!mutate(run, action)) return;
    action.updatedAt = timestamp();
    if (await commit([replace(runKey, runRow, run), replace(actionRow.pk, actionRow, action)])) return { run, action };
    await delay(25 * (attempt + 1));
  }
  throw new Error("The controller action changed before it could be recorded");
}
