export type Command =
  | { kind: "readiness"; confirmQuiet: true }
  | { kind: "traffic" }
  | { kind: "activate_inventory_denial" }
  | { kind: "restore_inventory_access"; restoreWithoutEvidence?: true }
  | { kind: "stop" | "discard"; targetActionId: string };

export type ActionStatus =
  | "queued"
  | "running"
  | "draining"
  | "completed"
  | "stopped"
  | "failed"
  | "incomplete"
  | "discarded";
export type Profile = "catalog" | "checkout";

export interface Counters {
  submitted: number;
  completed: number;
  succeeded: number;
  skipped: number;
  inFlight: number;
}

export interface CheckoutPayload {
  checkoutId: string;
  sku: string;
  quantity: 1;
  productVersion: string;
}

export interface Receipt {
  checkoutId: string;
  sku: string;
  quantity: number;
  unitPriceCents: number;
  totalPriceCents: number;
  currency: string;
  createdAt: string;
  status: "placed";
}

export interface Baseline {
  appRevision: string;
  checkoutId: string;
  sku: string;
  productVersion: string;
  stockBefore: number;
  stockAfter: number;
  verifiedAt: string;
  receipt: Receipt;
  settings: Record<string, unknown>;
}

export interface RequestRecord {
  id: string;
  kind: "catalog" | "checkout" | "order_status";
  startedAt: string;
  checkout?: CheckoutPayload;
  checkoutId?: string;
  completedAt?: string;
  durationMs?: number;
  statusCode?: number;
  requestId?: string;
  errorCode?: string;
  dependencyReason?: string;
  outcome?: "success" | "rejected" | "failed" | "unknown";
}

export type PolicyState = "absent" | "present" | "unknown";

export interface InventoryPolicyObservation {
  state: PolicyState;
  revision?: string;
  statementId?: string;
  tableArn?: string;
  roleArn?: string;
  observedAt: string;
}

export type CheckpointStatus =
  | "pending"
  | "stored"
  | "unavailable"
  | "incomplete";

export interface ConfigurationCheckpoint {
  status: CheckpointStatus;
  key?: string;
  createdAt: string;
  appRevision: string;
  inventoryTableArn: string;
  inventoryRoleArn: string;
  inventoryVersion: string;
  inventoryCodeSha256: string;
  inventoryMemory: number;
  inventoryTimeout: number;
  inventoryCap: number | "unreserved";
  policyBefore: InventoryPolicyObservation;
  denial?: InventoryPolicyObservation;
  alarm?: AlarmObservation;
  error?: string;
}

export interface IncidentState {
  kind: "inventory_access_denied";
  activationActionId: string;
  appRevision?: string;
  checkpoint?: ConfigurationCheckpoint;
  policy?: InventoryPolicyObservation;
  restoreActionId?: string;
  updatedAt: string;
}

export interface Action {
  id: string;
  kind: Command["kind"];
  command: Command;
  status: ActionStatus;
  createdAt: string;
  updatedAt: string;
  claimBy: number;
  deadlineAt: number;
  discardAfter: number;
  startedAt?: string;
  finishedAt?: string;
  stopRequested?: boolean;
  traffic?: Record<Profile, Counters>;
  requests: RequestRecord[];
  baseline?: Baseline;
  configurationOutcome?: "applied" | "no_change" | "failed" | "unknown";
  error?: string;
}

export interface RunState {
  currentActionId?: string;
  /** The configuration lane is independent from the primary traffic/readiness lane. */
  configurationActionId?: string;
  baseline: Baseline | null;
  budgets: {
    checkout: { generatorRemaining: number; verificationRemaining: number };
    catalog: { remaining: number };
    orderStatus: { remaining: number };
  };
  latestStock?: number;
  latestStockAt?: string;
  receipts: Receipt[];
  unresolved: Array<CheckoutPayload & { startedAt: string; status: "unknown" }>;
  incident?: IncidentState;
}

export type AlarmState = "OK" | "ALARM" | "INSUFFICIENT_DATA" | "UNKNOWN";

export interface AlarmObservation {
  name: string;
  arn?: string;
  state: AlarmState;
  reason?: string;
  stateUpdatedAt?: string;
  stateTransitionedAt?: string;
  actionsEnabled?: boolean;
  observedAt: string;
  stale?: boolean;
  error?: string;
}

export interface AlarmResponse {
  alarm: AlarmObservation | null;
  observedAt: string;
}

export interface DashboardState extends RunState {
  currentAction?: Action;
  currentConfigurationAction?: Action;
  observedAt: string;
}
