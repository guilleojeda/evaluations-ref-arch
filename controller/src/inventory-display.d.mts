import type { Action, IncidentState, InventoryAliasObservation, InventoryVariant, InventoryVersionObservation } from "./types.js";

export function currentInventoryDisplay(input: {
  baselineAlias?: InventoryAliasObservation;
  baselineInventory?: InventoryVersionObservation;
  aliasIncident?: IncidentState;
  recoveryAction?: Action;
  unknown?: boolean;
}): {
  currentAlias?: InventoryAliasObservation;
  access: "healthy" | "denied" | "unknown";
  targetVariant?: InventoryVariant;
  currentVariant?: InventoryVariant;
  baselineSupersedesIncident: boolean;
};

export function currentConfigurationObservation(activation?: Action, configuration?: Action): Action | undefined;

export function recoveryProgressLabel(progress?: Action["recoveryProgress"]): string;
export function capValueLabel(value?: number | "unreserved" | "unknown"): string;
export function capOutcomeLabel(outcome?: "pending" | "applied" | "no_change" | "failed" | "unknown"): string;
export function recoveryVerificationLabel(action?: Action): string;
