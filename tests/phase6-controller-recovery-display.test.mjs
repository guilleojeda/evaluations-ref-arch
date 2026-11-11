import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  capOutcomeLabel,
  capValueLabel,
  currentConfigurationObservation,
  currentInventoryDisplay,
  recoveryProgressLabel,
  recoveryVerificationLabel,
} from '../controller/src/inventory-display.mjs';

test('recovery display uses the recorded phase and keeps incomplete or unknown proof distinct', () => {
  assert.equal(recoveryProgressLabel('stopping'), 'Stopping traffic');
  assert.equal(recoveryProgressLabel('draining'), 'Draining accepted traffic');
  assert.equal(recoveryProgressLabel('validating'), 'Validating the current release');
  assert.equal(recoveryProgressLabel('capturing'), 'Capturing current settings');
  assert.equal(recoveryProgressLabel('restoring'), 'Restoring and reading back settings');
  assert.equal(recoveryProgressLabel('verifying'), 'Verifying fresh business behavior');
  assert.equal(recoveryProgressLabel('verified'), 'Fresh business verification passed');
  assert.equal(recoveryProgressLabel('verification_incomplete'), 'Business verification incomplete');
  assert.equal(recoveryProgressLabel('verification_unknown'), 'Business verification outcome unknown');
  assert.equal(recoveryProgressLabel('future-phase'), 'Recovery progress not recorded');

  assert.match(recoveryVerificationLabel({ recoveryProgress: 'verified' }), /fresh order, saved receipt, and stock decrement were confirmed/);
  assert.match(recoveryVerificationLabel({ recoveryProgress: 'verification_incomplete' }), /settings may be restored.*not proven/i);
  assert.match(recoveryVerificationLabel({ recoveryProgress: 'verification_unknown' }), /checkout could not be settled/i);
  assert.match(recoveryVerificationLabel({ status: 'failed' }), /Not verified.*failed/i);
  assert.match(recoveryVerificationLabel({ status: 'incomplete' }), /Incomplete.*before fresh business verification/i);
  assert.equal(recoveryVerificationLabel({ status: 'running', recoveryProgress: 'restoring' }), 'Not attempted yet.');
  assert.equal(recoveryVerificationLabel({ status: 'running', recoveryProgress: 'future-phase' }), 'Verification outcome not recorded.');
});

test('cap restoration display distinguishes numeric, unreserved, unknown, and absent observations', () => {
  assert.equal(capValueLabel(0), '0');
  assert.equal(capValueLabel(45), '45');
  assert.equal(capValueLabel('unreserved'), 'Unreserved');
  assert.equal(capValueLabel('unknown'), 'Unknown');
  assert.equal(capValueLabel(undefined), 'Not observed');
  assert.equal(capOutcomeLabel('pending'), 'In progress');
  assert.equal(capOutcomeLabel('applied'), 'Restored');
  assert.equal(capOutcomeLabel('no_change'), 'Already at target');
  assert.equal(capOutcomeLabel('failed'), 'Failed');
  assert.equal(capOutcomeLabel('unknown'), 'Unknown');
  assert.equal(capOutcomeLabel(undefined), 'Not recorded');
});

test('the current configuration display selects a newer Recover action over its denial activation', () => {
  const activation = { kind: 'activate_inventory_denial', createdAt: '2026-11-11T12:00:00.000Z' };
  const recovery = { kind: 'recover', createdAt: '2026-11-11T12:01:00.000Z' };
  const olderRecovery = { kind: 'recover', createdAt: '2026-11-11T11:59:00.000Z' };
  assert.equal(currentConfigurationObservation(activation, recovery), recovery);
  assert.equal(currentConfigurationObservation(activation, olderRecovery), activation);
  assert.equal(currentConfigurationObservation(activation, undefined), activation);
});

test('a later same-release denial takes over the current alias while the prior Recover remains inspectable', () => {
  const healthyRole = 'arn:aws:iam::027224425948:role/InventoryHealthy';
  const deniedRole = 'arn:aws:iam::027224425948:role/InventoryDenied';
  const alias = (version, at) => ({ functionName: 'Inventory', aliasName: 'live', aliasArn: 'arn:alias',
    functionVersion: version, revisionId: `r-${version}`, routingWeighted: false, observedAt: at });
  const baselineInventory = { version: '31', aliasArn: 'arn:alias', memory: 256, timeout: 8, cap: 'unreserved',
    codeSha256: 'digest', role: healthyRole, aliasRevision: 'r-31', access: 'healthy', sourceRevision: 'release-1',
    observedAt: '2026-11-11T12:02:10.000Z' };
  const recovery = { kind: 'recover', status: 'completed', createdAt: '2026-11-11T12:01:00.000Z',
    configurationCheckpoint: { appRevision: 'release-1' }, inventorySwitch: {
      before: alias('34', '2026-11-11T12:00:00.000Z'),
      target: { version: '31', memoryMb: 256, access: 'healthy', roleArn: healthyRole },
      after: alias('31', '2026-11-11T12:02:00.000Z'),
    } };
  const newerActivation = { kind: 'activate_inventory_denial', createdAt: '2026-11-11T12:03:00.000Z',
    inventorySwitch: { before: alias('31', '2026-11-11T12:02:00.000Z'),
      target: { version: '32', memoryMb: 256, access: 'denied', roleArn: deniedRole },
      after: alias('32', '2026-11-11T12:03:00.000Z') } };
  const incident = { kind: 'inventory_access_denied', mechanism: 'lambda-alias', activationActionId: 'new-activation',
    policyBefore: {}, policy: {}, aliasBefore: newerActivation.inventorySwitch.before,
    alias: newerActivation.inventorySwitch.after, target: newerActivation.inventorySwitch.target,
    active: 'denied', aliasOutcome: 'acknowledged', updatedAt: '2026-11-11T12:03:05.000Z' };
  const current = currentInventoryDisplay({ baselineAlias: alias('31', '2026-11-11T12:02:10.000Z'),
    baselineInventory, aliasIncident: incident, recoveryAction: recovery });

  assert.equal(current.currentAlias?.functionVersion, '32');
  assert.equal(current.currentVariant?.version, '32');
  assert.equal(current.access, 'denied');
  assert.equal(current.targetVariant?.version, '32');
  assert.equal(recovery.inventorySwitch.after.functionVersion, '31', 'the earlier Recover readback remains intact for its own record');
  assert.equal(currentConfigurationObservation(newerActivation, recovery), newerActivation,
    'the newer primary action is displayed as the current configuration outcome');
});

test('a recorded Recover alias readback overrides the older verified settings without changing their health record', () => {
  const healthyRole = 'arn:aws:iam::027224425948:role/InventoryHealthy';
  const deniedRole = 'arn:aws:iam::027224425948:role/InventoryDenied';
  const alias = (version, at) => ({ functionName: 'Inventory', aliasName: 'live', aliasArn: 'arn:alias',
    functionVersion: version, revisionId: `r-${version}`, routingWeighted: false, observedAt: at });
  const inventory = { version: '33', aliasArn: 'arn:alias', memory: 512, timeout: 8, cap: 'unreserved',
    codeSha256: 'digest', role: healthyRole, aliasRevision: 'r-33', access: 'healthy',
    sourceRevision: 'release-1', observedAt: '2026-11-11T12:00:00.000Z' };
  const incident = { kind: 'inventory_access_denied', mechanism: 'lambda-alias', activationActionId: 'activation',
    policyBefore: {}, policy: {}, aliasBefore: alias('33', '2026-11-11T12:00:00.000Z'),
    alias: alias('34', '2026-11-11T12:01:00.000Z'),
    target: { version: '34', memoryMb: 512, access: 'denied', roleArn: deniedRole },
    active: 'denied', aliasOutcome: 'acknowledged', updatedAt: '2026-11-11T12:01:00.000Z' };
  const recovery = { kind: 'recover', status: 'incomplete', configurationCheckpoint: { appRevision: 'release-1' },
    inventorySwitch: { before: alias('34', '2026-11-11T12:01:00.000Z'),
      target: { version: '31', memoryMb: 256, access: 'healthy', roleArn: healthyRole },
      after: alias('31', '2026-11-11T12:02:00.000Z') } };
  const shown = currentInventoryDisplay({
    baselineAlias: alias('33', '2026-11-11T12:00:00.000Z'),
    baselineInventory: inventory,
    aliasIncident: incident,
    recoveryAction: recovery,
  });
  assert.equal(shown.currentAlias?.functionVersion, '31');
  assert.equal(shown.currentVariant?.version, '31');
  assert.equal(shown.currentVariant?.memoryMb, 256);
  assert.equal(shown.access, 'healthy');
  assert.equal(shown.targetVariant?.version, '31');

  const denialAtDifferentMemory = currentInventoryDisplay({
    baselineAlias: alias('33', '2026-11-11T12:00:00.000Z'),
    baselineInventory: inventory,
    aliasIncident: { ...incident, target: { ...incident.target, version: '32', memoryMb: 256 } },
  });
  assert.equal(denialAtDifferentMemory.access, 'denied', 'preserve the confirmed denial label when its incident target differs from the current memory version');

  const sameRecoveredAlias = currentInventoryDisplay({
    baselineAlias: alias('33', '2026-11-11T12:00:00.000Z'),
    baselineInventory: inventory,
    aliasIncident: { ...incident, alias: alias('31', '2026-11-11T12:02:00.000Z'), active: 'healthy',
      updatedAt: '2026-11-11T12:02:30.000Z', target: { version: '34', memoryMb: 512, access: 'denied', roleArn: deniedRole } },
    recoveryAction: recovery,
  });
  assert.equal(sameRecoveredAlias.currentAlias?.functionVersion, '31',
    'the Recover alias readback remains usable when the incident record is updated afterward for that same alias');

  const activatedAgain = currentInventoryDisplay({
    baselineAlias: alias('33', '2026-11-11T12:00:00.000Z'),
    baselineInventory: inventory,
    aliasIncident: { ...incident, aliasBefore: alias('31', '2026-11-11T12:02:00.000Z'),
      alias: alias('32', '2026-11-11T12:03:00.000Z'),
      target: { version: '32', memoryMb: 256, access: 'denied', roleArn: deniedRole },
      active: 'denied', updatedAt: '2026-11-11T12:03:05.000Z' },
    recoveryAction: recovery,
  });
  assert.equal(activatedAgain.currentAlias?.functionVersion, '32');
  assert.equal(activatedAgain.currentVariant?.version, '32');
  assert.equal(activatedAgain.access, 'denied', 'a newer same-release denial supersedes the historical Recover readback');
  assert.equal(activatedAgain.targetVariant?.version, '32', 'the prior recovery remains available as history without becoming current');
});
