import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CloudFormationClient, DescribeStacksCommand, ListStackResourcesCommand } from "@aws-sdk/client-cloudformation";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetAliasCommand, GetFunctionConfigurationCommand, GetFunctionConcurrencyCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { readCurrentAlarm, readOriginatingAlarm } from "./alarm.js";
import {
  attachInventoryPolicy,
  detachInventoryPolicy,
  expectedInventoryTarget,
  isAttachConflict,
  isDetachConflict,
  isExactInventoryAccessPolicy,
  readInventoryAccessPolicy,
  readInventoryTablePolicy,
  sameInventoryPolicyVersion,
  type InventoryAccessPolicyRead,
  type InventoryPolicyTarget,
  type InventoryTablePolicyRead,
} from "./inventory-access.js";
import { changeAction, getRun } from "./store.js";
import type {
  Action,
  Baseline,
  CheckoutPayload,
  ConfigurationCheckpoint,
  IncidentState,
  InventoryAccessPolicyObservation,
  Profile,
  Receipt,
  RequestRecord,
  RunState,
} from "./types.js";

const account = "027224425948";
const region = "us-east-1";
const stackName = "IncidentTriageDemoApp";
const checkoutFunction = "IncidentTriageDemoCheckout";
const inventoryFunction = "IncidentTriageDemoInventory";
const inventoryTable = "IncidentTriageDemoInventory";
const requestTimeout = 7_000;
const tickLength = 1_000;
const ticks = 15;
const slots = { catalog: 1, checkout: 2 };
const profiles: Profile[] = ["catalog", "checkout"];
const denialProbeCount = 6;
const denialPropagationWindow = 50_000;
const iamReadbackDelays = [0, 500, 1_000, 1_500, 2_000, 2_500];
const providerTimeout = () => ({ abortSignal: AbortSignal.timeout(4_000) });
const clientOptions = { maxAttempts: 1, region };
const cloudformation = new CloudFormationClient(clientOptions);
const lambda = new LambdaClient(clientOptions);
const secrets = new SecretsManagerClient(clientOptions);
const evidenceEndpoint = process.env.AWS_ENDPOINT_URL_S3 ?? process.env.AWS_ENDPOINT_URL;
const s3 = new S3Client({ ...clientOptions, forcePathStyle: true, ...(evidenceEndpoint ? { endpoint: evidenceEndpoint } : {}) });

class ActionFailure extends Error {}
class IncompleteActionFailure extends ActionFailure {
  constructor(message: string, readonly checkpoint?: ConfigurationCheckpoint) { super(message); }
}

interface AppTarget {
  revision: string;
  api: string;
  sku: string;
  inventoryRoleArn: string;
  inventoryTableArn: string;
  outputs: Map<string, string>;
}

interface Product {
  productVersion: string;
  availableQuantity: number;
  observedAt: string;
}

interface AppResponse {
  status?: number;
  body?: Record<string, unknown>;
  requestId?: string;
  durationMs: number;
}

interface InventoryTargetSettings {
  version: string;
  codeSha256: string;
  memory: number;
  timeout: number;
  cap: number | "unreserved";
  role: string;
  observedAt: string;
}

interface IncidentContext {
  app: AppTarget;
  target: InventoryPolicyTarget;
  appRevision: string;
  checkout: InventoryTargetSettings;
  inventory: InventoryTargetSettings;
  tablePolicy: InventoryTablePolicyRead;
  policy: InventoryAccessPolicyRead;
  baseline: Baseline;
}

interface RestoreContext {
  app: AppTarget;
  target: InventoryPolicyTarget;
  appRevision: string;
  checkout: InventoryTargetSettings;
  inventory: InventoryTargetSettings;
  tablePolicy: InventoryTablePolicyRead;
  policy: InventoryAccessPolicyRead;
  incident: IncidentState;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function appTarget(): Promise<AppTarget> {
  const { Stacks } = await cloudformation.send(new DescribeStacksCommand({ StackName: stackName }), providerTimeout());
  const stack = Stacks?.[0];
  if (!stack || Stacks?.length !== 1 || stack.StackName !== stackName ||
      !stack.StackId?.startsWith(`arn:aws:cloudformation:${region}:${account}:stack/${stackName}/`) ||
      !["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(stack.StackStatus ?? "")) {
    throw new ActionFailure("The named app stack has no verified successful release.");
  }
  const outputs = new Map(stack.Outputs?.map(({ OutputKey, OutputValue }) => [OutputKey ?? "", OutputValue ?? ""]));
  const revision = outputs.get("SourceRevision");
  const sku = outputs.get("ProductSku");
  const inventoryRoleArn = outputs.get("InventoryRoleArn");
  const expectedInventoryRoleArn = `arn:aws:iam::${account}:role/IncidentTriageDemoAppInventoryRole`;
  if (!revision || !/^[0-9a-f]{40}$/.test(revision) || !sku ||
      outputs.get("CheckoutFunctionName") !== checkoutFunction || outputs.get("InventoryFunctionName") !== inventoryFunction ||
      outputs.get("InventoryTableName") !== inventoryTable || inventoryRoleArn !== expectedInventoryRoleArn ||
      !outputs.get("PresenterCredentialGeneration")) {
    throw new ActionFailure("The app release outputs do not identify the expected target.");
  }
  const resources = await cloudformation.send(new ListStackResourcesCommand({ StackName: stack.StackId }), providerTimeout());
  const apis = resources.StackResourceSummaries?.filter((resource) => resource.ResourceType === "AWS::ApiGatewayV2::Api");
  const apiId = apis?.[0]?.PhysicalResourceId;
  if (resources.NextToken || apis?.length !== 1 || !apiId || !/^[a-z0-9]+$/.test(apiId)) {
    throw new ActionFailure("The deployed app HTTP API could not be identified.");
  }
  const api = `https://${apiId}.execute-api.${region}.amazonaws.com`;
  if (outputs.get("ApiUrl") !== api) throw new ActionFailure("The app API output does not match the deployed HTTP API.");
  return { revision, api, sku, inventoryRoleArn, inventoryTableArn: `arn:aws:dynamodb:${region}:${account}:table/${inventoryTable}`, outputs };
}

async function functionSettings(target: AppTarget, label: "Checkout" | "Inventory", functionName: string) {
  const expectedVersion = target.outputs.get(`${label}LiveVersion`);
  const expectedArn = `arn:aws:lambda:${region}:${account}:function:${functionName}:live`;
  const expectedRole = `arn:aws:iam::${account}:role/IncidentTriageDemoApp${label}Role`;
  const memory = Number(target.outputs.get(`${label}MemorySize`));
  const timeout = Number(target.outputs.get(`${label}TimeoutSeconds`));
  const expectedCap = target.outputs.get(`${label}ReservedConcurrency`);
  if (!expectedVersion || !/^[1-9]\d*$/.test(expectedVersion) || target.outputs.get(`${label}LiveAliasArn`) !== expectedArn ||
      !Number.isSafeInteger(memory) || memory < 1 || !Number.isSafeInteger(timeout) || timeout < 1 ||
      !expectedCap || (expectedCap !== "unreserved" && !/^[1-9]\d*$/.test(expectedCap))) {
    throw new ActionFailure(`${label} expected version or settings are missing.`);
  }
  const alias = await lambda.send(new GetAliasCommand({ FunctionName: functionName, Name: "live" }), providerTimeout());
  if (alias.FunctionVersion !== expectedVersion || Object.keys(alias.RoutingConfig?.AdditionalVersionWeights ?? {}).length) {
    throw new ActionFailure(`${label} live alias does not match its expected version.`);
  }
  const [config, concurrency] = await Promise.all([
    lambda.send(new GetFunctionConfigurationCommand({ FunctionName: functionName, Qualifier: expectedVersion }), providerTimeout()),
    lambda.send(new GetFunctionConcurrencyCommand({ FunctionName: functionName }), providerTimeout()),
  ]);
  if (config.State !== "Active" || config.Version !== expectedVersion || config.MemorySize !== memory ||
      config.Timeout !== timeout || !config.CodeSha256 || config.Role !== expectedRole) {
    throw new ActionFailure(`${label} qualified configuration does not match its expected settings.`);
  }
  const cap = concurrency.ReservedConcurrentExecutions;
  if (cap !== (expectedCap === "unreserved" ? undefined : Number(expectedCap))) {
    throw new ActionFailure(`${label} concurrency does not match its expected setting.`);
  }
  const effectiveCap: number | "unreserved" = cap ?? "unreserved";
  return { version: expectedVersion, aliasArn: expectedArn, memory, timeout, cap: effectiveCap, codeSha256: config.CodeSha256, role: expectedRole, observedAt: new Date().toISOString() };
}

async function settings(target: AppTarget): Promise<Baseline["settings"]> {
  if (target.outputs.get("InventoryResourcePolicy") !== "absent") {
    throw new ActionFailure("The app release does not declare the expected absent Inventory policy.");
  }
  const checkout = await functionSettings(target, "Checkout", checkoutFunction);
  const inventory = await functionSettings(target, "Inventory", inventoryFunction);
  const policyTarget = expectedInventoryTarget(target.inventoryTableArn, target.inventoryRoleArn);
  const [tablePolicy, accessPolicy] = await Promise.all([
    readInventoryTablePolicy(policyTarget),
    readInventoryAccessPolicy(policyTarget),
  ]);
  if (tablePolicy.observation.state !== "absent") throw new ActionFailure("The Inventory table policy does not match its expected absence.");
  if (!isExactInventoryAccessPolicy(accessPolicy.observation, policyTarget) || accessPolicy.observation.state !== "absent") {
    throw new ActionFailure("The named Inventory denial policy or its detached role state does not match the expected baseline.");
  }
  if (!accessPolicy.document) throw new ActionFailure("The exact Inventory policy document is unavailable.");
  return { account, region, api: target.api, credentialGeneration: target.outputs.get("PresenterCredentialGeneration"),
    checkout, inventory, inventoryPolicy: "absent", inventoryAccessPolicy: accessPolicy.observation,
    inventoryPolicyName: accessPolicy.observation.policyName, inventoryPolicyArn: accessPolicy.observation.policyArn,
    inventoryPolicyDefaultVersionId: accessPolicy.observation.defaultVersionId,
    inventoryTableArn: target.inventoryTableArn, inventoryRoleArn: target.inventoryRoleArn };
}

async function loadBearer(): Promise<string> {
  const arn = process.env.CONTROLLER_APP_SECRET_ARN;
  if (!arn) throw new ActionFailure("The worker checkout credential is unavailable.");
  const result = await secrets.send(new GetSecretValueCommand({ SecretId: arn }), providerTimeout());
  if (!result.SecretString || /\s/.test(result.SecretString)) throw new ActionFailure("The worker checkout credential is invalid.");
  return result.SecretString;
}

function baselineInventorySettings(baseline: Baseline): Record<string, unknown> {
  const settings = record(baseline.settings);
  const inventory = settings && record(settings.inventory);
  if (!settings || !inventory || settings.inventoryPolicy !== "absent" ||
      settings.inventoryTableArn !== `arn:aws:dynamodb:${region}:${account}:table/${inventoryTable}` ||
      typeof settings.inventoryRoleArn !== "string") {
    throw new ActionFailure("The readiness baseline does not contain the expected Inventory target.");
  }
  return inventory;
}

function sameInventorySettings(expected: Record<string, unknown>, actual: InventoryTargetSettings): boolean {
  return expected.version === actual.version && expected.codeSha256 === actual.codeSha256 &&
    expected.memory === actual.memory && expected.timeout === actual.timeout && expected.cap === actual.cap &&
    expected.role === actual.role;
}

async function incidentContext(): Promise<IncidentContext> {
  const target = await appTarget();
  const run = await getRun();
  const baseline = run.baseline;
  if (!baseline || baseline.appRevision !== target.revision || baseline.sku !== target.sku) {
    throw new ActionFailure("The verified readiness baseline is stale or unavailable.");
  }
  if (baseline.settings.inventoryRoleArn !== target.inventoryRoleArn ||
      baseline.settings.credentialGeneration !== target.outputs.get("PresenterCredentialGeneration")) {
    throw new ActionFailure("The readiness target or presenter credential generation changed.");
  }
  const expectedInventory = baselineInventorySettings(baseline);
  const baselineSettings = record(baseline.settings);
  const expectedCheckout = baselineSettings && record(baselineSettings.checkout);
  if (!expectedCheckout) throw new ActionFailure("The readiness baseline does not contain the expected Checkout target.");
  const checkout = await functionSettings(target, "Checkout", checkoutFunction);
  if (!sameInventorySettings(expectedCheckout, checkout)) {
    throw new ActionFailure("The deployed Checkout settings changed after readiness.");
  }
  const inventory = await functionSettings(target, "Inventory", inventoryFunction);
  if (!sameInventorySettings(expectedInventory, inventory)) {
    throw new ActionFailure("The deployed Inventory settings changed after readiness.");
  }
  const policyTarget = expectedInventoryTarget(target.inventoryTableArn, target.inventoryRoleArn);
  const [tablePolicy, policy] = await Promise.all([
    readInventoryTablePolicy(policyTarget),
    readInventoryAccessPolicy(policyTarget),
  ]);
  if (tablePolicy.observation.state !== "absent") throw new ActionFailure("The Inventory table resource policy no longer matches the app's expected absence.");
  if (!isExactInventoryAccessPolicy(policy.observation, policyTarget)) {
    throw new ActionFailure("The named Inventory denial policy has a different default version or document.");
  }
  if (policy.observation.state !== "absent") {
    throw new ActionFailure("The named Inventory denial policy is already attached to the Inventory role.");
  }
  const baselinePolicy = baselineSettings && record(baselineSettings.inventoryAccessPolicy);
  if (!baselinePolicy || baselinePolicy.state !== "absent" || baselinePolicy.documentMatches !== true ||
      baselinePolicy.policyArn !== policy.observation.policyArn || baselinePolicy.policyName !== policy.observation.policyName ||
      baselinePolicy.roleArn !== policy.observation.roleArn || !baselinePolicy.defaultVersionId ||
      !sameInventoryPolicyVersion(policy.observation, baselinePolicy as unknown as InventoryAccessPolicyObservation) ||
      baselineSettings?.inventoryPolicyArn !== policy.observation.policyArn ||
      baselineSettings?.inventoryPolicyName !== policy.observation.policyName ||
      baselineSettings?.inventoryPolicyDefaultVersionId !== policy.observation.defaultVersionId) {
    throw new ActionFailure("The named Inventory policy or its default version changed after readiness; check readiness again.");
  }
  return { app: target, target: policyTarget, appRevision: target.revision, checkout, inventory, tablePolicy, policy, baseline };
}

async function restoreContext(): Promise<RestoreContext> {
  const run = await getRun();
  const incident = incidentRecord(run);
  if (!incident || !incident.policy) throw new ActionFailure("The recorded Inventory denial is unavailable.");
  const appRevision = incident.appRevision;
  const { policyArn, roleArn } = incident.policy;
  if (!appRevision || !policyArn || !roleArn || policyArn !== `arn:aws:iam::${account}:policy/IncidentTriageDemoInventoryReadDeny`) {
    throw new ActionFailure("The recorded Inventory denial target is incomplete.");
  }
  const target = await appTarget();
  if (target.revision !== appRevision) throw new ActionFailure("The deployed app release changed after the denial; reconcile readiness before restoring.");
  const policyTarget = expectedInventoryTarget(target.inventoryTableArn, roleArn);
  if (policyTarget.tableArn !== target.inventoryTableArn || policyTarget.roleArn !== target.inventoryRoleArn) {
    throw new ActionFailure("The recorded Inventory denial target is not the named app resource.");
  }
  const checkout = await functionSettings(target, "Checkout", checkoutFunction);
  const inventory = await functionSettings(target, "Inventory", inventoryFunction);
  const [tablePolicy, policy] = await Promise.all([
    readInventoryTablePolicy(policyTarget),
    readInventoryAccessPolicy(policyTarget),
  ]);
  if (tablePolicy.observation.state !== "absent") throw new ActionFailure("The Inventory table resource policy changed during the denial.");
  return { app: target, target: policyTarget, appRevision, checkout, inventory, tablePolicy, policy, incident };
}

function incidentRecord(run: RunState): IncidentState | undefined {
  return run.incident?.kind === "inventory_access_denied" && run.incident.mechanism === "iam-managed-policy"
    ? run.incident : undefined;
}

function commandRestoreWithoutEvidence(action: Action): boolean {
  return action.command.kind === "restore_inventory_access" && action.command.restoreWithoutEvidence === true;
}

function ensureActionDeadline(action: Action, operation: string): void {
  if (Date.now() + requestTimeout >= action.deadlineAt) throw new IncompleteActionFailure(`The ${operation} deadline passed before the AWS mutation.`);
}

async function checkpoint(
  action: Action,
  context: Pick<IncidentContext, "target" | "appRevision" | "checkout" | "inventory" | "tablePolicy">,
  policyBefore: InventoryAccessPolicyObservation,
  capturedPolicy: InventoryAccessPolicyRead,
  incident?: IncidentState,
): Promise<ConfigurationCheckpoint> {
  if (!capturedPolicy.document || !capturedPolicy.observation.documentMatches || capturedPolicy.observation.state !== "present") {
    throw new IncompleteActionFailure("The exact attached Inventory policy could not be captured.");
  }
  const bucket = process.env.CONTROLLER_EVIDENCE_BUCKET;
  if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new IncompleteActionFailure("The incident evidence bucket is unavailable.");
  }
  const createdAt = new Date().toISOString();
  const key = `configuration/${incident?.activationActionId ?? action.id}/${action.id}-${randomUUID()}.json`;
  const partial: ConfigurationCheckpoint = {
    status: "pending",
    key,
    createdAt,
    appRevision: context.appRevision,
    inventoryTableArn: context.target.tableArn,
    inventoryRoleArn: context.target.roleArn,
    inventoryVersion: context.inventory.version,
    inventoryCodeSha256: context.inventory.codeSha256,
    inventoryMemory: context.inventory.memory,
    inventoryTimeout: context.inventory.timeout,
    inventoryCap: context.inventory.cap,
    tablePolicyBefore: context.tablePolicy.observation,
    inventoryPolicyBefore: policyBefore,
    inventoryPolicyAtCapture: capturedPolicy.observation,
  };
  try {
    if (incident) {
      try {
        const since = incident.policyBefore.observedAt ?? incident.updatedAt;
        const current = await readCurrentAlarm();
        partial.alarm = current.state === "ALARM" && current.stateTransitionedAt &&
          Date.parse(current.stateTransitionedAt) >= Date.parse(since)
          ? current : await readOriginatingAlarm(since, current);
      } catch {
        // Alarm evidence is independent of the configuration capture.
      }
    }
    const body = JSON.stringify({
      version: 1,
      kind: "configuration",
      actionId: action.id,
      createdAt,
      appRevision: context.appRevision,
      target: {
        inventoryTableArn: context.target.tableArn,
        inventoryRoleArn: context.target.roleArn,
      },
      code: {
        checkout: context.checkout.codeSha256,
        inventory: context.inventory.codeSha256,
      },
      settings: {
        checkout: context.checkout,
        inventory: context.inventory,
      },
      tablePolicyBefore: context.tablePolicy.observation,
      inventoryPolicyBefore: policyBefore,
      inventoryPolicyAtCapture: capturedPolicy.observation,
      policyDocument: capturedPolicy.document,
      ...(partial.alarm ? { alarm: partial.alarm } : {}),
    });
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "application/json",
      IfNoneMatch: "*",
    }), providerTimeout());
  } catch {
    partial.status = "unavailable";
    partial.error = "The checkpoint write failed.";
    throw new IncompleteActionFailure("The incident configuration checkpoint could not be stored.", partial);
  }
  partial.status = "stored";
  return partial;
}

async function recordActivationIntent(action: Action, context: IncidentContext): Promise<void> {
  const intent: IncidentState = {
    kind: "inventory_access_denied",
    mechanism: "iam-managed-policy",
    activationActionId: action.id,
    policyBefore: context.policy.observation,
    policy: { ...context.policy.observation, state: "unknown" },
    attachOutcome: "pending",
    attachmentOwnership: "unknown",
    appRevision: context.appRevision,
    updatedAt: new Date().toISOString(),
  };
  const result = await changeAction(action.id, (run) => {
    if (run.incident) {
      const prior = run.incident;
      const inactive = prior.mechanism === "iam-managed-policy"
        ? prior.policy.state === "absent" && prior.policy.documentMatches && prior.attachmentOwnership === "controller"
        : prior.policy?.state === "absent";
      if (!inactive) return false;
      run.incidentHistory ??= [];
      if (!run.incidentHistory.some((item) => item.activationActionId === prior.activationActionId)) {
        run.incidentHistory.push(structuredClone(prior));
      }
    }
    run.incident = intent;
    return true;
  });
  if (!result) throw new IncompleteActionFailure("The Inventory denial intent could not be recorded.");
}

async function recordCheckpoint(actionId: string, checkpointValue: ConfigurationCheckpoint, policy: InventoryAccessPolicyObservation): Promise<void> {
  const result = await changeAction(actionId, (run, current) => {
    const incident = incidentRecord(run);
    if (!incident || incident.activationActionId !== actionId) return false;
    run.incident = { ...incident, checkpoint: checkpointValue, policy, updatedAt: new Date().toISOString() };
    return true;
  });
  if (!result) throw new IncompleteActionFailure("The incident checkpoint could not be linked to the run.");
}

async function recordAttachOutcome(actionId: string, outcome: IncidentState["attachOutcome"]): Promise<void> {
  const result = await changeAction(actionId, (run) => {
    const incident = incidentRecord(run);
    if (!incident || incident.activationActionId !== actionId) return false;
    run.incident = { ...incident, attachOutcome: outcome, updatedAt: new Date().toISOString() };
    return true;
  });
  if (!result) throw new IncompleteActionFailure("The Inventory attachment outcome could not be recorded.");
}

async function recordPolicyObservation(
  actionId: string,
  activationActionId: string,
  observed: InventoryAccessPolicyObservation,
  ownership: IncidentState["attachmentOwnership"],
): Promise<void> {
  const result = await changeAction(actionId, (run) => {
    const incident = incidentRecord(run);
    if (!incident || incident.activationActionId !== activationActionId) return false;
    run.incident = { ...incident, policy: observed, attachmentOwnership: ownership, updatedAt: new Date().toISOString() };
    return true;
  });
  if (!result) throw new IncompleteActionFailure("The Inventory policy observation could not be recorded.");
}

function deniedResponse(response: AppResponse): boolean {
  return response.status === 502 && response.body?.code === "INVENTORY_LOOKUP_FAILED" &&
    response.body?.dependencyReason === "inventory_access_denied" && Boolean(response.requestId);
}

function deniedCheckoutResponse(response: AppResponse, payload: CheckoutPayload): boolean {
  return deniedResponse(response) && response.body?.checkoutId === payload.checkoutId && Boolean(response.requestId);
}

async function waitForOwnedAttachment(
  action: Action,
  target: InventoryPolicyTarget,
  expectedVersion: InventoryAccessPolicyObservation,
  conflict: boolean,
): Promise<InventoryAccessPolicyRead> {
  let last: InventoryAccessPolicyRead | undefined;
  if (conflict) {
    try { last = await readInventoryAccessPolicy(target); } catch { /* Preserve the durable unknown intent. */ }
    const observation = last?.observation.state === "present"
      ? last.observation
      : { ...expectedVersion, state: "unknown" as const, observedAt: new Date().toISOString() };
    await recordPolicyObservation(action.id, action.id, observation, "unknown");
    throw new ActionFailure("The named Inventory policy attachment changed before the controller could attach it.");
  }
  for (const wait of iamReadbackDelays) {
    if (wait > 0) {
      if (Date.now() + wait + requestTimeout >= action.deadlineAt) break;
      await delay(wait);
    }
    if (Date.now() + requestTimeout >= action.deadlineAt) break;
    try {
      last = await readInventoryAccessPolicy(target);
    } catch {
      // An IAM read failure leaves the attachment outcome unresolved.
      continue;
    }
    if (last.observation.state !== "present") continue;
    if (!isExactInventoryAccessPolicy(last.observation, target) || !sameInventoryPolicyVersion(last.observation, expectedVersion)) {
      await recordPolicyObservation(action.id, action.id, last.observation, "unknown");
      throw new IncompleteActionFailure("The attached Inventory policy version or document drifted during activation.");
    }
    await recordPolicyObservation(action.id, action.id, last.observation, "controller");
    return last;
  }
  const unresolved = {
    ...(last?.observation ?? expectedVersion),
    state: "unknown" as const,
    observedAt: new Date().toISOString(),
  };
  await recordPolicyObservation(action.id, action.id, unresolved, "unknown");
  throw new IncompleteActionFailure("The single Inventory attachment could not be reconciled; readiness and another activation remain blocked.");
}

async function linkUnavailableCheckpoint(actionId: string, checkpointValue: ConfigurationCheckpoint): Promise<void> {
  const linked = await changeAction(actionId, (run) => {
    const incident = incidentRecord(run);
    if (!incident) return false;
    run.incident = { ...incident, checkpoint: checkpointValue, updatedAt: new Date().toISOString() };
    return true;
  });
  if (!linked) throw new IncompleteActionFailure("The unavailable incident checkpoint could not be recorded.");
}

async function activateInventoryDenial(action: Action): Promise<void> {
  const context = await incidentContext();
  await recordActivationIntent(action, context);

  ensureActionDeadline(action, "Inventory denial");
  let conflict = false;
  try {
    await attachInventoryPolicy(context.target);
    await recordAttachOutcome(action.id, "acknowledged");
  } catch (error) {
    conflict = isAttachConflict(error);
    await recordAttachOutcome(action.id, conflict ? "conflict" : "ambiguous");
  }
  const observed = await waitForOwnedAttachment(action, context.target, context.policy.observation, conflict);
  let stored: ConfigurationCheckpoint;
  try {
    stored = await checkpoint(action, context, context.policy.observation, observed);
  } catch (error) {
    const unavailable = error instanceof IncompleteActionFailure ? error.checkpoint : undefined;
    if (unavailable) await linkUnavailableCheckpoint(action.id, unavailable);
    throw error;
  }
  await recordCheckpoint(action.id, stored, observed.observation);

  const bearer = await loadBearer();
  const startedAt = Date.now();
  const roomForCatalogAndCheckout = requestTimeout * 2 + 500;
  const propagationWindow = Math.min(denialPropagationWindow, action.deadlineAt - startedAt - roomForCatalogAndCheckout);
  if (propagationWindow < 0) throw new IncompleteActionFailure("The Inventory propagation window leaves no time for the verification checkout.");
  const offsets = Array.from({ length: denialProbeCount }, (_, index) => Math.round(propagationWindow * index / (denialProbeCount - 1)));
  let denied = false;
  for (const offset of offsets) {
    const wait = startedAt + offset - Date.now();
    if (wait > 0) await delay(wait);
    if (Date.now() + requestTimeout * 2 >= action.deadlineAt) break;
    const request = newRequest("catalog");
    const reserved = await changeAction(action.id, (run, current) =>
      Date.now() + requestTimeout * 2 < current.deadlineAt && reserve(run, current, request));
    if (!reserved) break;
    const remaining = Math.min(requestTimeout, Math.max(1, action.deadlineAt - Date.now() - requestTimeout));
    const response = await send(action.id, context.app, bearer, request, undefined, remaining);
    denied = deniedResponse(response.response);
    if (denied) break;
  }
  if (!denied) throw new ActionFailure("The Inventory denial did not produce the specific dependency failure within the bounded window.");

  ensureActionDeadline(action, "Inventory denial verification checkout");
  const payload = checkoutPayload(context.baseline.sku, context.baseline.productVersion);
  const request = newRequest("checkout", payload);
  if (!await changeAction(action.id, (run, current) => reserve(run, current, request))) {
    throw new ActionFailure("The activation verification checkout allowance is exhausted.");
  }
  const response = await send(action.id, context.app, bearer, request, payload);
  if (!deniedCheckoutResponse(response.response, payload)) {
    if (response.outcome === "unknown") await checkStatus(action.id, context.app, bearer, payload);
    throw new ActionFailure("The activation checkout did not confirm the specific Inventory access denial.");
  }
  const finishedAt = new Date().toISOString();
  const done = await changeAction(action.id, (run, current) => {
    const incident = incidentRecord(run);
    if (!incident || incident.activationActionId !== action.id) return false;
    run.incident = { ...incident, updatedAt: finishedAt };
    current.status = "completed";
    current.configurationOutcome = "applied";
    current.finishedAt = finishedAt;
    return true;
  });
  if (!done) throw new IncompleteActionFailure("The completed Inventory denial could not be recorded.");
}

function incompleteCheckpoint(
  context: Pick<IncidentContext, "target" | "appRevision" | "inventory" | "tablePolicy">,
  policyBefore: InventoryAccessPolicyObservation,
  policyAtCapture: InventoryAccessPolicyObservation,
  error: string,
  status: "unavailable" | "incomplete" = "incomplete",
): ConfigurationCheckpoint {
  return {
    status,
    createdAt: new Date().toISOString(),
    appRevision: context.appRevision,
    inventoryTableArn: context.target.tableArn,
    inventoryRoleArn: context.target.roleArn,
    inventoryVersion: context.inventory.version,
    inventoryCodeSha256: context.inventory.codeSha256,
    inventoryMemory: context.inventory.memory,
    inventoryTimeout: context.inventory.timeout,
    inventoryCap: context.inventory.cap,
    tablePolicyBefore: context.tablePolicy.observation,
    inventoryPolicyBefore: policyBefore,
    inventoryPolicyAtCapture: policyAtCapture,
    error,
  };
}

async function recordRestoreIntent(action: Action, activationActionId: string, policy: InventoryAccessPolicyObservation): Promise<void> {
  const result = await changeAction(action.id, (run, current) => {
    const incident = incidentRecord(run);
    if (!incident || incident.activationActionId !== activationActionId) return false;
    run.incident = {
      ...incident,
      restoreActionId: action.id,
      policy: { ...policy, state: "unknown" },
      attachmentOwnership: "controller",
      updatedAt: new Date().toISOString(),
    };
    current.configurationOutcome = "unknown";
    return true;
  });
  if (!result) throw new IncompleteActionFailure("The Inventory restore intent could not be recorded.");
}

async function waitForPolicyAbsence(
  action: Action,
  activationActionId: string,
  target: InventoryPolicyTarget,
  expected: InventoryAccessPolicyObservation,
): Promise<InventoryAccessPolicyRead> {
  const delays = [0, 1_000, 2_000, 3_000, 4_000, 5_000];
  const deadline = Math.min(action.deadlineAt, Date.now() + 20_000);
  let last: InventoryAccessPolicyRead | undefined;
  for (const wait of delays) {
    if (wait > 0) {
      if (Date.now() + wait + requestTimeout >= deadline) break;
      await delay(wait);
    }
    if (Date.now() + requestTimeout >= deadline) break;
    try {
      last = await readInventoryAccessPolicy(target);
    } catch {
      // A failed read after DetachRolePolicy leaves the outcome unknown.
      continue;
    }
    if (!sameInventoryPolicyVersion(last.observation, expected)) {
      await recordPolicyObservation(action.id, activationActionId,
        { ...last.observation, state: "unknown", observedAt: new Date().toISOString() }, "unknown");
      throw new IncompleteActionFailure("The Inventory policy version or document changed during detach readback; reconcile the recorded restore intent.");
    }
    if (last.observation.state === "absent") {
      await recordPolicyObservation(action.id, activationActionId, last.observation, "controller");
      return last;
    }
  }
  const unresolved = { ...(last?.observation ?? expected), state: "unknown" as const, observedAt: new Date().toISOString() };
  await recordPolicyObservation(action.id, activationActionId, unresolved, "controller");
  throw new IncompleteActionFailure("The single Inventory detach could not be reconciled; readiness remains blocked.");
}

async function completeRestore(
  action: Action,
  activationActionId: string,
  policy: InventoryAccessPolicyObservation,
  checkpointValue: ConfigurationCheckpoint | undefined,
  outcome: "applied" | "no_change",
): Promise<void> {
  const finishedAt = new Date().toISOString();
  const done = await changeAction(action.id, (run, current) => {
    const incident = incidentRecord(run);
    if (!incident || incident.activationActionId !== activationActionId) return false;
    run.incident = {
      ...incident,
      restoreActionId: action.id,
      policy,
      attachmentOwnership: "controller",
      ...(checkpointValue ? { checkpoint: checkpointValue } : {}),
      updatedAt: finishedAt,
    };
    current.status = "completed";
    current.configurationOutcome = outcome;
    current.finishedAt = finishedAt;
    return true;
  });
  if (!done) throw new IncompleteActionFailure("The completed Inventory restore could not be recorded.");
}

async function restoreInventoryAccess(action: Action): Promise<void> {
  const context = await restoreContext();
  const incident = context.incident;
  if (incident.activationActionId === action.id) throw new ActionFailure("The recorded Inventory denial is unavailable.");
  if (incident.policyBefore.state !== "absent" || !incident.policyBefore.defaultVersionId) {
    throw new ActionFailure("The recorded Inventory policy version changed after activation; restore will not detach it.");
  }
  if (!isExactInventoryAccessPolicy(context.policy.observation, context.target) ||
      !sameInventoryPolicyVersion(context.policy.observation, incident.policyBefore)) {
    await recordPolicyObservation(action.id, incident.activationActionId,
      { ...context.policy.observation, state: "unknown", observedAt: new Date().toISOString() }, "unknown");
    throw new ActionFailure("The current Inventory policy version or document differs from the recorded denial.");
  }
  if (incident.restoreActionId && context.policy.observation.state === "present") {
    // A prior durable detach intent may have reached IAM. Reconcile it, but never send Detach again.
    const restored = await waitForPolicyAbsence(action, incident.activationActionId, context.target, incident.policyBefore);
    await completeRestore(action, incident.activationActionId, restored.observation, incident.checkpoint, "applied");
    return;
  }
  const withoutEvidence = commandRestoreWithoutEvidence(action);
  if (withoutEvidence && incident.checkpoint?.status === "stored" && incident.checkpoint.key) {
    throw new ActionFailure("restoreWithoutEvidence is only allowed when the ordinary configuration capture is unavailable.");
  }
  const priorCaptureUnavailable = incident.checkpoint?.status === "unavailable" || incident.checkpoint?.status === "incomplete";
  if (priorCaptureUnavailable && !withoutEvidence && context.policy.observation.state === "present") {
    throw new ActionFailure("The incident configuration checkpoint is unavailable; confirm restoreWithoutEvidence to protectively restore the known policy.");
  }
  if (context.policy.observation.state === "absent") {
    if ((!incident.restoreActionId && incident.attachmentOwnership !== "controller") ||
        (!incident.restoreActionId && incident.policy.state !== "present")) {
      throw new IncompleteActionFailure("The attachment outcome is unresolved; IAM list absence alone cannot clear an uncertain activation.");
    }
    await completeRestore(action, incident.activationActionId, context.policy.observation, incident.checkpoint,
      incident.restoreActionId && incident.policy.state === "unknown" ? "applied" : "no_change");
    return;
  }
  if (context.policy.observation.state !== "present") {
    throw new IncompleteActionFailure("The Inventory attachment state is unresolved.");
  }
  if (incident.attachmentOwnership !== "controller" && !["acknowledged", "ambiguous"].includes(incident.attachOutcome)) {
    throw new ActionFailure("The Inventory policy attachment is not known to belong to this controller action.");
  }
  let evidenceIncomplete = false;
  let freshCheckpoint: ConfigurationCheckpoint | undefined;
  if (priorCaptureUnavailable && withoutEvidence) evidenceIncomplete = true;
  try {
    if (!priorCaptureUnavailable || !withoutEvidence) {
      freshCheckpoint = await checkpoint(action, context, incident.policyBefore, context.policy, incident);
    }
  } catch (error) {
    const unavailable = error instanceof IncompleteActionFailure && error.checkpoint
      ? error.checkpoint
      : incompleteCheckpoint(context, incident.policyBefore, context.policy.observation,
        "The fresh pre-restore checkpoint could not be stored.", "unavailable");
    const linked = await changeAction(action.id, (nextRun) => {
      const currentIncident = incidentRecord(nextRun);
      if (!currentIncident || currentIncident.activationActionId !== incident.activationActionId) return false;
      nextRun.incident = { ...currentIncident, checkpoint: unavailable, updatedAt: new Date().toISOString() };
      return true;
    });
    if (!linked) throw new IncompleteActionFailure("The unavailable restore checkpoint could not be recorded.");
    // No configuration mutation has happened yet; keep ordinary restore retryable while
    // preserving the unavailable capture in the run incident.
    if (!withoutEvidence) throw new ActionFailure(error instanceof Error ? error.message : "The pre-restore checkpoint is unavailable.");
    evidenceIncomplete = true;
  }
  if (freshCheckpoint) {
    const linked = await changeAction(action.id, (nextRun, current) => {
      const currentIncident = incidentRecord(nextRun);
      if (!currentIncident || currentIncident.activationActionId !== incident.activationActionId) return false;
      nextRun.incident = { ...currentIncident, checkpoint: freshCheckpoint, updatedAt: new Date().toISOString() };
      return true;
    });
    if (!linked) throw new IncompleteActionFailure("The pre-restore configuration checkpoint could not be linked to the run.");
  }
  if (incident.attachmentOwnership !== "controller") {
    // The ambiguous Attach is reconciled only after the exact attached state has been checkpointed.
    await recordPolicyObservation(action.id, incident.activationActionId, context.policy.observation, "controller");
  }
  const preDetach = await readInventoryAccessPolicy(context.target);
  if (!isExactInventoryAccessPolicy(preDetach.observation, context.target) ||
      !sameInventoryPolicyVersion(preDetach.observation, incident.policyBefore)) {
    await recordPolicyObservation(action.id, incident.activationActionId,
      { ...preDetach.observation, state: "unknown", observedAt: new Date().toISOString() }, "unknown");
    throw new ActionFailure("The Inventory policy version or document changed before detach.");
  }
  if (preDetach.observation.state === "absent") {
    await recordPolicyObservation(action.id, incident.activationActionId, preDetach.observation, "controller");
    await completeRestore(action, incident.activationActionId, preDetach.observation, freshCheckpoint ?? incident.checkpoint, "no_change");
    return;
  }
  ensureActionDeadline(action, "Inventory restore");
  await recordRestoreIntent(action, incident.activationActionId, preDetach.observation);
  try {
    await detachInventoryPolicy(context.target);
  } catch (error) {
    if (isDetachConflict(error)) {
      // Readback can confirm a detach made by an earlier attempt; never send a second Detach.
    } else {
      // Reconcile a possible lost acknowledgement without retrying the mutation.
    }
  }
  const restored = await waitForPolicyAbsence(action, incident.activationActionId, context.target, incident.policyBefore);
  const checkpointResult = evidenceIncomplete
    ? incompleteCheckpoint(context, incident.policyBefore, preDetach.observation,
      "Restored only through explicit restoreWithoutEvidence; durable pre-change capture was unavailable.")
    : freshCheckpoint ?? incident.checkpoint;
  await completeRestore(action, incident.activationActionId, restored.observation, checkpointResult, "applied");
}

async function appRequest(target: AppTarget, bearer: string, request: RequestRecord, timeout = requestTimeout): Promise<AppResponse> {
  const path = request.kind === "catalog" ? "/api/products" : request.kind === "checkout" ? "/api/checkout" : `/api/orders/${request.checkoutId}`;
  const started = performance.now();
  try {
    const response = await fetch(`${target.api}${path}`, {
      method: request.kind === "checkout" ? "POST" : "GET",
      headers: { authorization: `Bearer ${bearer}`, accept: "application/json", "content-type": "application/json" },
      body: request.checkout && JSON.stringify(request.checkout),
      redirect: "error", signal: AbortSignal.timeout(timeout),
    });
    const body = record(await response.json().catch(() => undefined));
    const requestId = body?.requestId ?? response.headers.get("x-amzn-requestid");
    return { status: response.status, body, durationMs: Math.round(performance.now() - started),
      requestId: typeof requestId === "string" && /^[A-Za-z0-9+/=_.:-]{1,120}$/.test(requestId) ? requestId : undefined };
  } catch {
    return { durationMs: Math.round(performance.now() - started) };
  }
}

function product(response: AppResponse, sku: string): Product | undefined {
  const products = response.body?.products;
  const observedAt = response.body?.observedAt;
  if (response.status !== 200 || !Array.isArray(products) || typeof observedAt !== "string" || !Number.isFinite(Date.parse(observedAt))) return;
  const item = products.map(record).find((value) => value?.sku === sku);
  if (!item || typeof item.productVersion !== "string" || !item.productVersion ||
      !Number.isSafeInteger(item.availableQuantity) || Number(item.availableQuantity) < 0) return;
  return { productVersion: item.productVersion, availableQuantity: Number(item.availableQuantity), observedAt };
}

function receipt(response: AppResponse, payload: CheckoutPayload): Receipt | undefined {
  const item = record(response.body?.order);
  if (!item || item.checkoutId !== payload.checkoutId || item.sku !== payload.sku || item.quantity !== payload.quantity ||
      typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt)) || item.status !== "placed" ||
      typeof item.currency !== "string" || !Number.isSafeInteger(item.unitPriceCents) || Number(item.unitPriceCents) < 0 ||
      item.totalPriceCents !== Number(item.unitPriceCents) * payload.quantity) return;
  return { checkoutId: payload.checkoutId, sku: payload.sku, quantity: payload.quantity, createdAt: item.createdAt,
    status: "placed", currency: item.currency, unitPriceCents: Number(item.unitPriceCents), totalPriceCents: Number(item.totalPriceCents) };
}

function newRequest(kind: RequestRecord["kind"], checkout?: CheckoutPayload, checkoutId?: string): RequestRecord {
  return { id: randomUUID(), kind, startedAt: new Date().toISOString(), checkout, checkoutId: checkout?.checkoutId ?? checkoutId };
}

function checkoutPayload(sku: string, productVersion: string): CheckoutPayload {
  return { checkoutId: randomUUID(), sku, quantity: 1, productVersion };
}

function reserve(run: RunState, action: Action, request: RequestRecord): boolean {
  if (Date.now() + requestTimeout >= action.deadlineAt) return false;
  if (request.kind === "order_status") {
    if (run.budgets.orderStatus.remaining < 1) return false;
    run.budgets.orderStatus.remaining--;
  } else {
    if (action.status !== "running" || action.stopRequested) return false;
    if (request.kind === "catalog") {
      if (run.budgets.catalog.remaining < 1) return false;
      run.budgets.catalog.remaining--;
    } else {
      const budget = action.kind === "readiness" || action.kind === "activate_inventory_denial"
        ? "verificationRemaining" : "generatorRemaining";
      if (run.budgets.checkout[budget] < 1 || !request.checkout) return false;
      run.budgets.checkout[budget]--;
      run.unresolved.push({ ...request.checkout, startedAt: request.startedAt, status: "unknown" });
    }
    const progress = action.traffic?.[request.kind];
    if (progress) {
      progress.submitted++;
      progress.inFlight++;
    }
  }
  action.requests.push(request);
  return true;
}

const beforeWrite = new Set([
  "APPLICATION_CONFIGURATION_ERROR", "ORDER_READ_FAILED", "INVENTORY_LOOKUP_FAILED", "INVENTORY_INVALID_PAYLOAD",
  "INVENTORY_DEADLINE_EXCEEDED", "CHECKOUT_DEADLINE_EXCEEDED",
]);

function checkoutOutcome(response: AppResponse, saved?: Receipt): RequestRecord["outcome"] {
  if (saved) return "success";
  if (response.status !== undefined && response.status >= 400 && response.status < 500) return "rejected";
  if (typeof response.body?.code === "string" && beforeWrite.has(response.body.code)) return "failed";
  return "unknown";
}

async function settle(actionId: string, request: RequestRecord, response: AppResponse, outcome: RequestRecord["outcome"],
                      observed?: Product, saved?: Receipt): Promise<void> {
  const result = await changeAction(actionId, (run, action) => {
    const persisted = action.requests.find((item) => item.id === request.id);
    if (!persisted || persisted.completedAt) return false;
    Object.assign(persisted, { completedAt: new Date().toISOString(), durationMs: response.durationMs,
      statusCode: response.status, requestId: response.requestId, outcome,
      errorCode: typeof response.body?.code === "string" ? response.body.code : undefined,
      dependencyReason: typeof response.body?.dependencyReason === "string" ? response.body.dependencyReason : undefined });
    if (request.kind !== "order_status") {
      const progress = action.traffic?.[request.kind];
      if (progress) {
        progress.completed++;
        progress.inFlight--;
        if (outcome === "success") progress.succeeded++;
      }
    }
    if (observed) {
      run.latestStock = observed.availableQuantity;
      run.latestStockAt = observed.observedAt;
    }
    if (saved && !run.receipts.some((item) => item.checkoutId === saved.checkoutId)) run.receipts.push(saved);
    if (saved || (request.kind === "checkout" && outcome !== "unknown")) {
      run.unresolved = run.unresolved.filter((item) => item.checkoutId !== request.checkoutId);
    }
    return true;
  });
  if (!result) throw new ActionFailure("A completed app request could not be recorded.");
}

async function send(actionId: string, target: AppTarget, bearer: string, request: RequestRecord, payload?: CheckoutPayload, timeout?: number) {
  const response = await appRequest(target, bearer, request, timeout);
  const observed = request.kind === "catalog" ? product(response, target.sku) : undefined;
  const saved = payload && (request.kind === "checkout" ? response.status === 201 || response.status === 200 : response.status === 200)
    ? receipt(response, payload) : undefined;
  const outcome = request.kind === "checkout" ? checkoutOutcome(response, saved)
    : observed || saved ? "success" : request.kind === "order_status" ? "unknown" : "failed";
  await settle(actionId, request, response, outcome, observed, saved);
  return { response, observed, saved, outcome };
}

async function checkStatus(actionId: string, target: AppTarget, bearer: string, payload: CheckoutPayload) {
  const request = newRequest("order_status", undefined, payload.checkoutId);
  if (!await changeAction(actionId, (run, action) => reserve(run, action, request))) return;
  return (await send(actionId, target, bearer, request, payload)).saved;
}

async function readiness(action: Action): Promise<void> {
  const target = await appTarget();
  const expected = await settings(target);
  const bearer = await loadBearer();
  async function probe(request: RequestRecord, payload?: CheckoutPayload) {
    if (!await changeAction(action.id, (run, current) => reserve(run, current, request))) {
      throw new ActionFailure("Readiness could not reserve its next app request.");
    }
    return send(action.id, target, bearer, request, payload);
  }
  const before = (await probe(newRequest("catalog"))).observed;
  if (!before || before.availableQuantity < 1) throw new ActionFailure("Readiness requires a healthy catalog with available stock.");
  const payload = checkoutPayload(target.sku, before.productVersion);
  const purchase = await probe(newRequest("checkout", payload), payload);
  if (!purchase.saved && purchase.outcome !== "unknown") throw new ActionFailure("The readiness checkout was rejected.");
  const confirmed = await checkStatus(action.id, target, bearer, payload);
  if (!confirmed) throw new ActionFailure("The readiness order could not be confirmed through order status.");
  const after = (await probe(newRequest("catalog"))).observed;
  if (!after || after.productVersion !== before.productVersion || after.availableQuantity !== before.availableQuantity - 1) {
    throw new ActionFailure("The readiness order did not show a same-version one-unit stock decrease.");
  }
  const baseline: Baseline = { appRevision: target.revision, sku: target.sku, checkoutId: payload.checkoutId,
    productVersion: payload.productVersion, stockBefore: before.availableQuantity, stockAfter: after.availableQuantity,
    verifiedAt: new Date().toISOString(), receipt: confirmed, settings: expected };
  await changeAction(action.id, (run, current) => {
    run.baseline = baseline;
    current.baseline = baseline;
    current.status = "completed";
    current.finishedAt = baseline.verifiedAt;
    return true;
  });
}

async function traffic(action: Action): Promise<void> {
  const target = await appTarget();
  const { baseline } = await getRun();
  if (!baseline || baseline.appRevision !== target.revision || baseline.sku !== target.sku) {
    throw new ActionFailure("The app release changed. Check readiness before starting traffic.");
  }
  const bearer = await loadBearer();
  const start = performance.now();
  const pending = new Set<Promise<void>>();
  const unknown: CheckoutPayload[] = [];
  let writeFailed = false;
  try {
    for (let tick = 0; tick < ticks && !writeFailed; tick++) {
      const tickStart = start + tick * tickLength;
      const wait = tickStart - performance.now();
      if (wait > 0) await delay(wait);
      const candidates = { catalog: newRequest("catalog"),
        checkout: newRequest("checkout", checkoutPayload(baseline.sku, baseline.productVersion)) };
      const result = await changeAction(action.id, (run, current) => {
        if (current.status !== "running" || current.stopRequested || !current.traffic) return false;
        for (const profile of profiles) {
          const progress = current.traffic[profile];
          if (performance.now() >= tickStart + tickLength || progress.inFlight >= slots[profile] ||
              !reserve(run, current, candidates[profile])) progress.skipped++;
        }
        return true;
      });
      if (!result) break;
      for (const candidate of Object.values(candidates)) {
        if (!result.action.requests.some(({ id }) => id === candidate.id)) continue;
        const task = send(action.id, target, bearer, candidate, candidate.checkout).then(({ outcome }) => {
          if (outcome === "unknown" && candidate.checkout) unknown.push(candidate.checkout);
        }).catch(() => { writeFailed = true; }).finally(() => pending.delete(task));
        pending.add(task);
      }
    }
  } finally {
    await Promise.all(pending);
  }
  if (writeFailed) throw new ActionFailure("An app result could not be recorded. Inspect unresolved requests before continuing.");
  for (const payload of unknown) await checkStatus(action.id, target, bearer, payload);
  await changeAction(action.id, (_run, current) => {
    current.status = current.stopRequested ? "stopped" : "completed";
    current.finishedAt = new Date().toISOString();
    return true;
  });
}

export async function handler(event: { actionId?: string } = {}): Promise<void> {
  const { actionId } = event;
  if (!actionId || !/^[0-9a-f-]{36}$/i.test(actionId)) return;
  const claim = await changeAction(actionId, (_run, action) => {
    if (action.status !== "queued" || Date.now() >= action.claimBy) return false;
    action.status = "running";
    action.startedAt = new Date().toISOString();
    return true;
  });
  if (!claim) return;
  try {
    if (claim.action.kind === "readiness") await readiness(claim.action);
    if (claim.action.kind === "traffic") await traffic(claim.action);
    if (claim.action.kind === "activate_inventory_denial") await activateInventoryDenial(claim.action);
    if (claim.action.kind === "restore_inventory_access") await restoreInventoryAccess(claim.action);
  } catch (error) {
    await changeAction(actionId, (run, current) => {
      const unrecorded = current.requests.some((request) => !request.completedAt);
      current.status = error instanceof IncompleteActionFailure || unrecorded || Date.now() >= current.deadlineAt
        ? "incomplete" : "failed";
      if (current.kind === "restore_inventory_access") {
        current.configurationOutcome = current.status === "incomplete" ? "unknown" : "failed";
      } else if (current.kind === "activate_inventory_denial") {
        const incident = run.incident?.mechanism === "iam-managed-policy" && run.incident.activationActionId === actionId
          ? run.incident : undefined;
        current.configurationOutcome = !incident ? "failed"
          : incident.policy.state === "present" && incident.attachmentOwnership === "controller" ? "applied" : "unknown";
      }
      current.error = error instanceof ActionFailure ? error.message : "A required controller or app provider call failed.";
      current.finishedAt = new Date().toISOString();
      return true;
    });
  }
}
