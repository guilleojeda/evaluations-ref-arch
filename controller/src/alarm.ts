import {
  CloudWatchClient,
  DescribeAlarmHistoryCommand,
  DescribeAlarmsCommand,
  type AlarmHistoryItem,
  type MetricAlarm,
} from "@aws-sdk/client-cloudwatch";
import type {
  AlarmBindingObservation,
  AlarmObservation,
  AlarmResponse,
  AlarmState,
} from "./types";
import { readAgentEndpoint } from "./agent-readiness.js";

const client = new CloudWatchClient({ maxAttempts: 1 });
const defaultAlarmName = "IncidentTriageDemoAppStage5xx";
const timeout = () => ({ abortSignal: AbortSignal.timeout(3_000) });

export class AlarmReadError extends Error {
  constructor(
    message = "The configured application alarm could not be observed",
  ) {
    super(message);
    this.name = "AlarmReadError";
  }
}

function alarmName(): string {
  const value = process.env.CONTROLLER_ALARM_NAME?.trim() || defaultAlarmName;
  if (!/^[A-Za-z0-9_.:-]{1,255}$/.test(value)) throw new AlarmReadError();
  return value;
}

function iso(value: Date | string | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function state(value: string | undefined): AlarmState {
  if (value === "OK" || value === "ALARM" || value === "INSUFFICIENT_DATA")
    return value;
  return "UNKNOWN";
}

function current(value: MetricAlarm, observedAt: string): AlarmObservation {
  return {
    name: value.AlarmName ?? alarmName(),
    arn: value.AlarmArn,
    state: state(value.StateValue),
    reason: value.StateReason,
    stateUpdatedAt: iso(value.StateUpdatedTimestamp),
    stateTransitionedAt: iso(value.StateTransitionedTimestamp),
    actionsEnabled: value.ActionsEnabled,
    observedAt,
  };
}

async function historyItems(limit: number): Promise<AlarmHistoryItem[]> {
  let response;
  try {
    response = await client.send(
      new DescribeAlarmHistoryCommand({
        AlarmName: alarmName(),
        HistoryItemType: "StateUpdate",
        MaxRecords: Math.max(1, Math.min(20, Math.floor(limit))),
      }),
      timeout(),
    );
  } catch {
    throw new AlarmReadError();
  }
  return response.AlarmHistoryItems ?? [];
}

async function currentAlarmDetails(): Promise<{ alarm: AlarmObservation; actions: string[] }> {
  const observedAt = new Date().toISOString();
  let response;
  try {
    response = await client.send(
      new DescribeAlarmsCommand({ AlarmNames: [alarmName()], MaxRecords: 1 }),
      timeout(),
    );
  } catch {
    throw new AlarmReadError();
  }
  const alarm = response.MetricAlarms?.[0];
  if (!alarm || alarm.AlarmName !== alarmName())
    throw new AlarmReadError("The configured application alarm was not found");
  return { alarm: current(alarm, observedAt), actions: alarm.AlarmActions ?? [] };
}

/** Read the selected native stage alarm. This is shared by HTTP observation and worker checkpoints. */
export async function readCurrentAlarm(): Promise<AlarmObservation> {
  return (await currentAlarmDetails()).alarm;
}

/** Find the first genuine ALARM transition after an activation/effect timestamp. */
export async function readOriginatingAlarm(
  since: string, current: AlarmObservation,
): Promise<AlarmObservation | undefined> {
  const cutoff = Date.parse(since);
  if (!Number.isFinite(cutoff)) throw new AlarmReadError("The alarm transition cutoff is invalid");
  const candidates = (await historyItems(20)).flatMap((item) => {
    if (!item.HistoryData) return [];
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(item.HistoryData);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
      data = parsed as Record<string, unknown>;
    } catch {
      return [];
    }
    const next = data.newState;
    if (!next || typeof next !== "object" || Array.isArray(next)) return [];
    const newState = next as Record<string, unknown>;
    if (newState.stateValue !== "ALARM") return [];
    const transitioned = typeof newState.stateTimestamp === "string"
      ? newState.stateTimestamp
      : item.Timestamp?.toISOString();
    const timestamp = transitioned ? Date.parse(transitioned) : Number.NaN;
    if (!Number.isFinite(timestamp) || timestamp < cutoff) return [];
    return [{
      timestamp,
      stateUpdatedAt: typeof newState.stateUpdatedTimestamp === "string" ? newState.stateUpdatedTimestamp : transitioned,
      reason: typeof newState.stateReason === "string" ? newState.stateReason : undefined,
    }];
  }).sort((a, b) => a.timestamp - b.timestamp)[0];
  if (!candidates) return undefined;
  return {
    name: current.name,
    arn: current.arn,
    state: "ALARM",
    reason: candidates.reason,
    stateUpdatedAt: candidates.stateUpdatedAt,
    stateTransitionedAt: new Date(candidates.timestamp).toISOString(),
    actionsEnabled: current.actionsEnabled,
    observedAt: new Date().toISOString(),
  };
}

export async function readAlarm(): Promise<AlarmResponse> {
  const [{ alarm, actions }, agentEndpoint] = await Promise.all([
    currentAlarmDetails(),
    readAgentEndpoint(),
  ]);
  const observedAt = alarm.observedAt;
  const adapterArn = process.env.CONTROLLER_AGENT_ALARM_ADAPTER_ARN?.trim();
  let alarmBinding: AlarmBindingObservation;
  if (!adapterArn) alarmBinding = { state: "unconfigured", observedAt };
  else if (actions.length === 0) alarmBinding = { state: "missing", observedAt };
  else if (actions.length === 1 && actions[0] === adapterArn) {
    const state = alarm.actionsEnabled === true ? "bound" : alarm.actionsEnabled === false ? "disabled" : "unavailable";
    alarmBinding = { state, observedAt };
  }
  else alarmBinding = { state: "unexpected", observedAt };
  return { alarm, observedAt, agentEndpoint, alarmBinding };
}
