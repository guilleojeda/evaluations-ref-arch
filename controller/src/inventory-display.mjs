function observationIsAtLeastAsFresh(candidate, current) {
  if (!current) return true;
  const candidateAt = Date.parse(candidate?.observedAt ?? "");
  const currentAt = Date.parse(current?.observedAt ?? "");
  if (!Number.isFinite(candidateAt) || !Number.isFinite(currentAt)) {
    return Boolean(candidate?.revisionId && candidate.revisionId === current?.revisionId);
  }
  if (candidateAt !== currentAt) return candidateAt > currentAt;
  return Boolean(candidate?.revisionId && candidate.revisionId === current?.revisionId);
}

export function currentInventoryDisplay({ baselineAlias, baselineInventory, aliasIncident, recoveryAction, unknown = false }) {
  const baselineSupersedesIncident = aliasIncident?.active === "healthy" && Boolean(baselineAlias) &&
    Date.parse(baselineAlias?.observedAt ?? "") > Date.parse(aliasIncident.alias.observedAt);
  const recoveryAlias = recoveryAction?.kind === "recover" ? recoveryAction.inventorySwitch?.after : undefined;
  const recoveryTarget = recoveryAction?.kind === "recover" ? recoveryAction.inventorySwitch?.target : undefined;
  const recoveryRevision = recoveryAction?.kind === "recover"
    ? recoveryAction.baseline?.appRevision ?? recoveryAction.configurationCheckpoint?.appRevision : undefined;
  const baselineRevision = baselineInventory?.sourceRevision;
  const recoveryMatchesCurrentRelease = !recoveryRevision || !baselineRevision || recoveryRevision === baselineRevision;
  const recoverySupersedes = Boolean(recoveryAlias && recoveryMatchesCurrentRelease &&
    observationIsAtLeastAsFresh(recoveryAlias, baselineAlias) &&
    observationIsAtLeastAsFresh(recoveryAlias, aliasIncident?.alias));
  const currentAlias = recoverySupersedes ? recoveryAlias
    : !aliasIncident || baselineSupersedesIncident ? baselineAlias : aliasIncident.alias ?? baselineAlias;
  const baselineVariant = baselineInventory ? {
    version: baselineInventory.version,
    roleArn: baselineInventory.role,
    memoryMb: baselineInventory.memory,
    access: baselineInventory.access,
  } : undefined;
  const targetVariant = recoverySupersedes ? recoveryTarget
    : !aliasIncident || baselineSupersedesIncident ? baselineVariant : aliasIncident.target ?? baselineVariant;
  const currentVariant = targetVariant && currentAlias && targetVariant.version === currentAlias.functionVersion
    ? targetVariant
    : baselineVariant && currentAlias && baselineVariant.version === currentAlias.functionVersion ? baselineVariant
      : aliasIncident?.target && currentAlias && aliasIncident.target.version === currentAlias.functionVersion ? aliasIncident.target : undefined;
  const access = unknown ? "unknown"
    : recoverySupersedes ? currentVariant?.access ?? "unknown"
      : baselineSupersedesIncident ? baselineInventory?.access ?? "unknown"
        : aliasIncident?.active ?? baselineInventory?.access ?? "unknown";
  return { currentAlias, access, targetVariant, currentVariant, baselineSupersedesIncident };
}

export function currentConfigurationObservation(activation, configuration) {
  if (activation?.kind !== "activate_inventory_denial") return configuration;
  if (!configuration || !["increase_memory", "restore_inventory_access", "recover"].includes(configuration.kind)) return activation;
  const activationAt = Date.parse(activation.createdAt ?? "");
  const configurationAt = Date.parse(configuration.createdAt ?? "");
  if (!Number.isFinite(configurationAt) || !Number.isFinite(activationAt)) return configuration;
  return configurationAt >= activationAt ? configuration : activation;
}

const recoveryProgressLabels = {
  stopping: "Stopping traffic",
  draining: "Draining accepted traffic",
  validating: "Validating the current release",
  capturing: "Capturing current settings",
  restoring: "Restoring and reading back settings",
  verifying: "Verifying fresh business behavior",
  verified: "Fresh business verification passed",
  verification_incomplete: "Business verification incomplete",
  verification_unknown: "Business verification outcome unknown",
};

export function recoveryProgressLabel(progress) {
  return recoveryProgressLabels[progress] ?? "Recovery progress not recorded";
}

export function capValueLabel(value) {
  if (value === "unreserved") return "Unreserved";
  if (value === "unknown") return "Unknown";
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "Not observed";
}

export function capOutcomeLabel(outcome) {
  switch (outcome) {
    case "pending": return "In progress";
    case "applied": return "Restored";
    case "no_change": return "Already at target";
    case "failed": return "Failed";
    case "unknown": return "Unknown";
    default: return "Not recorded";
  }
}

export function recoveryVerificationLabel(action) {
  if (!action) return "Not started.";
  switch (action?.recoveryProgress) {
    case "verified": return "Verified: the fresh order, saved receipt, and stock decrement were confirmed.";
    case "verification_incomplete": return "Incomplete: settings may be restored, but fresh business verification was not proven.";
    case "verification_unknown": return "Unknown: a submitted checkout could not be settled; no recovery health claim is available.";
    case "verifying": return "In progress: waiting for the fresh order, saved receipt, and stock readback.";
    default:
      if (action?.status === "failed") return "Not verified: the recovery action failed.";
      if (action?.status === "incomplete") return "Incomplete: recovery stopped before fresh business verification was proven.";
      if (["stopping", "draining", "validating", "capturing", "restoring"].includes(action?.recoveryProgress)) return "Not attempted yet.";
      return "Verification outcome not recorded.";
  }
}
