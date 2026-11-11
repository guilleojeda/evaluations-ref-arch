export function currentInventoryDisplay({ baselineAlias, baselineInventory, aliasIncident, unknown = false }) {
  const baselineSupersedesIncident = aliasIncident?.active === "healthy" && Boolean(baselineAlias) &&
    Date.parse(baselineAlias?.observedAt ?? "") > Date.parse(aliasIncident.alias.observedAt);
  const currentAlias = !aliasIncident || baselineSupersedesIncident ? baselineAlias : aliasIncident.alias ?? baselineAlias;
  const access = unknown ? "unknown"
    : baselineSupersedesIncident ? baselineInventory?.access ?? "unknown"
      : aliasIncident?.active ?? baselineInventory?.access ?? "unknown";
  const baselineVariant = baselineInventory ? {
    version: baselineInventory.version,
    roleArn: baselineInventory.role,
    memoryMb: baselineInventory.memory,
    access: baselineInventory.access,
  } : undefined;
  const targetVariant = !aliasIncident || baselineSupersedesIncident ? baselineVariant : aliasIncident.target ?? baselineVariant;
  const currentVariant = targetVariant && currentAlias && targetVariant.version === currentAlias.functionVersion
    ? targetVariant : baselineVariant;
  return { currentAlias, access, targetVariant, currentVariant, baselineSupersedesIncident };
}

export function currentConfigurationObservation(activation, configuration) {
  if (activation?.kind !== "activate_inventory_denial") return configuration;
  if (!configuration || !["increase_memory", "restore_inventory_access"].includes(configuration.kind)) return activation;
  const activationAt = Date.parse(activation.createdAt ?? "");
  const configurationAt = Date.parse(configuration.createdAt ?? "");
  if (!Number.isFinite(configurationAt) || !Number.isFinite(activationAt)) return configuration;
  return configurationAt >= activationAt ? configuration : activation;
}
