export type Command =
  | { kind: "readiness"; confirmQuiet: true }
  | { kind: "traffic" }
  | { kind: "stop" | "discard"; targetActionId: string };

export type ActionStatus = "queued" | "running" | "draining" | "completed" | "stopped" | "failed" | "incomplete" | "discarded";
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
  outcome?: "success" | "rejected" | "failed" | "unknown";
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
  error?: string;
}

export interface RunState {
  currentActionId?: string;
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
}

export interface DashboardState extends RunState {
  currentAction?: Action;
  observedAt: string;
}
