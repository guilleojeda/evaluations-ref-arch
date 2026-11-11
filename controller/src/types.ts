export type Command =
  | { kind: "readiness"; confirmQuiet: true }
  | { kind: "traffic" }
  | { kind: "increase_memory"; function: "inventory"; memoryMb: number }
  | { kind: "activate_inventory_denial" }
  | { kind: "restore_inventory_access"; restoreWithoutEvidence?: true }
  | { kind: "recover"; confirmQuiet: true; recoverWithoutEvidence?: true }
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

/** Read-only identity of one successfully deployed app generation and its checked release artifacts. */
export interface DeploymentIdentity {
  stackId: string;
  successfulAt: string;
  sourceRevision: string;
  api: string;
  sku: string;
  credentialGeneration: string;
  checkoutVersion: string;
  checkoutCodeSha256: string;
  checkoutMemoryMb: number;
  checkoutTimeoutSeconds: number;
  checkoutCap: number | "unreserved";
  inventoryVersion: string;
  inventoryCodeSha256: string;
  inventoryManifestSha256: string;
  inventoryMemoryMb: number;
  inventoryTimeoutSeconds: number;
  inventoryCap: number | "unreserved";
}

export interface Baseline {
  appRevision: string;
  deploymentIdentity?: DeploymentIdentity;
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

/** Read-only DynamoDB table resource-policy observation kept for the app invariant. */
export interface InventoryTablePolicyObservation {
  state: PolicyState;
  revision?: string;
  statementId?: string;
  tableArn?: string;
  roleArn?: string;
  observedAt: string;
}

/** Kept to read previously persisted table-policy incident records without changing their meaning. */
export type InventoryPolicyObservation = InventoryTablePolicyObservation;

export interface InventoryAccessPolicyObservation {
  state: PolicyState;
  policyArn: string;
  policyName: string;
  roleArn: string;
  defaultVersionId?: string;
  documentMatches: boolean;
  observedAt: string;
}

export type InventoryAccess = "healthy" | "denied";

export interface InventoryVariant {
  memoryMb: number;
  access: InventoryAccess;
  version: string;
  roleArn: string;
}

export interface InventoryVariantsManifest {
  schemaVersion: 1;
  sourceRevision: string;
  functionName: string;
  aliasName: string;
  baselineMemoryMb: number;
  codeSha256: string;
  variants: InventoryVariant[];
}

export interface InventoryAliasObservation {
  functionName: string;
  aliasName: string;
  aliasArn: string;
  functionVersion: string;
  revisionId: string;
  routingWeighted: boolean;
  observedAt: string;
}

export interface InventoryVersionObservation {
  version: string;
  aliasArn: string;
  memory: number;
  timeout: number;
  cap: number | "unreserved";
  codeSha256: string;
  role: string;
  aliasRevision: string;
  access: InventoryAccess;
  sourceRevision: string;
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
  inventoryAliasBefore: InventoryAliasObservation;
  inventoryAliasAtCapture: InventoryAliasObservation;
  tablePolicyBefore: InventoryTablePolicyObservation;
  inventoryPolicyBefore: InventoryAccessPolicyObservation;
  inventoryPolicyAtCapture: InventoryAccessPolicyObservation;
  alarm?: AlarmObservation;
  error?: string;
}

/** Shape of the table-resource-policy checkpoint written by earlier controller releases. */
export interface LegacyConfigurationCheckpoint {
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
  policyBefore: InventoryTablePolicyObservation;
  denial?: InventoryTablePolicyObservation;
  alarm?: AlarmObservation;
  error?: string;
}

export interface IncidentState {
  kind: "inventory_access_denied";
  mechanism: "lambda-alias";
  activationActionId: string;
  appRevision?: string;
  deploymentIdentity?: DeploymentIdentity;
  checkpoint?: ConfigurationCheckpoint;
  policyBefore: InventoryAccessPolicyObservation;
  policy: InventoryAccessPolicyObservation;
  aliasBefore: InventoryAliasObservation;
  alias: InventoryAliasObservation;
  target: InventoryVariant;
  active: "denied" | "healthy" | "unknown";
  aliasOutcome: "pending" | "acknowledged" | "ambiguous" | "conflict";
  restoreActionId?: string;
  updatedAt: string;
}

/** Existing inactive table-policy records remain readable and are archived intact on replacement. */
export interface LegacyIncidentState {
  kind: "inventory_access_denied";
  mechanism?: "iam-managed-policy" | "table-resource-policy";
  activationActionId: string;
  appRevision?: string;
  checkpoint?: LegacyConfigurationCheckpoint;
  policy?: InventoryTablePolicyObservation;
  restoreActionId?: string;
  updatedAt: string;
}

export type StoredIncidentState = IncidentState | LegacyIncidentState;

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
  configurationCheckpoint?: ConfigurationCheckpoint;
  inventorySwitch?: {
    before: InventoryAliasObservation;
    target: InventoryVariant;
    after?: InventoryAliasObservation;
  };
  configurationOutcome?: "applied" | "no_change" | "failed" | "unknown";
  recoveryProgress?: "stopping" | "draining" | "validating" | "capturing" | "restoring" | "verifying"
    | "verified" | "verification_incomplete" | "verification_unknown";
  capRestoration?: {
    checkout?: CapRestoration;
    inventory?: CapRestoration;
  };
  error?: string;
}

export type CapValue = number | "unreserved" | "unknown";

export interface CapRestoration {
  before: CapValue;
  target: CapValue;
  readback?: CapValue;
  outcome: "pending" | "applied" | "no_change" | "failed" | "unknown";
  observedAt?: string;
}

export interface RunState {
  currentActionId?: string;
  /** The configuration lane is independent from the primary traffic/readiness lane. */
  configurationActionId?: string;
  baseline: Baseline | null;
  originalBaseline?: Baseline;
  inventoryAliasUnknown?: boolean;
  budgets: {
    checkout: { generatorRemaining: number; verificationRemaining: number };
    catalog: { remaining: number };
    orderStatus: { remaining: number };
  };
  latestStock?: number;
  latestStockAt?: string;
  receipts: Receipt[];
  unresolved: Array<CheckoutPayload & { startedAt: string; status: "unknown" }>;
  incident?: StoredIncidentState;
  incidentHistory?: StoredIncidentState[];
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
  agentEndpoint?: AgentEndpointObservation;
  alarmBinding?: AlarmBindingObservation;
}

export type AgentEndpointState = "ready" | "not_ready" | "unavailable" | "unconfigured";

export interface AgentEndpointObservation {
  state: AgentEndpointState;
  name?: string;
  runtimeArn?: string;
  endpointArn?: string;
  liveVersion?: string;
  targetVersion?: string;
  failureReason?: string;
  observedAt: string;
}

export type AlarmBindingState = "bound" | "disabled" | "missing" | "unexpected" | "unavailable" | "unconfigured";

export interface AlarmBindingObservation {
  state: AlarmBindingState;
  observedAt: string;
}

export type InvestigationStatus = "running" | "complete" | "failed";
export type InvestigationAssessment = "ongoing" | "recovered" | "unknown";

export interface InvestigationCitation {
  source: string;
  resource: string;
  windowStart: string;
  windowEnd: string;
  observedAt: string;
  finding: string;
}

export interface InvestigationRecommendation {
  action: string;
  target?: string | null;
  value?: string | number | null;
  unit?: string | null;
  explanation?: string;
  policy?: string;
  policyDetail?: string;
}

export interface InvestigationReport {
  assessment: InvestigationAssessment;
  summary: string;
  recommendation: InvestigationRecommendation;
  evidence: InvestigationCitation[];
  uncertainties: string[];
  alternatives: string[];
}

export interface InvestigationFailure {
  code: string;
  message: string;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface InvestigationRun {
  alarmArn: string;
  transitionAt: string;
  runId: string;
  runtimeSessionId: string;
  candidateId: string;
  sourceRevision: string;
  artifactSha256?: string;
  promptSha256: string;
  modelId: string;
  runtimeArn: string;
  runtimeVersion: string;
  endpointName: string;
  status: InvestigationStatus;
  startedAt: string;
  deadlineAt: string;
  finishedAt?: string;
  report?: InvestigationReport;
  failure?: InvestigationFailure;
  traceRef?: { [key: string]: JsonValue };
  captureRef?: { [key: string]: JsonValue };
}

export interface InvestigationResponse {
  observedAt: string;
  runs: InvestigationRun[];
}

export interface DashboardState extends RunState {
  currentAction?: Action;
  currentConfigurationAction?: Action;
  observedAt: string;
}
