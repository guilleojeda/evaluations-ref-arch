import type { Action, IncidentState, InventoryAliasObservation, InventoryVariant, InventoryVersionObservation } from "./types.js";

export function currentInventoryDisplay(input: {
  baselineAlias?: InventoryAliasObservation;
  baselineInventory?: InventoryVersionObservation;
  aliasIncident?: IncidentState;
  unknown?: boolean;
}): {
  currentAlias?: InventoryAliasObservation;
  access: "healthy" | "denied" | "unknown";
  targetVariant?: InventoryVariant;
  currentVariant?: InventoryVariant;
  baselineSupersedesIncident: boolean;
};

export function currentConfigurationObservation(activation?: Action, configuration?: Action): Action | undefined;
