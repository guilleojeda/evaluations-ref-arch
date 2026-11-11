import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CloudFormationClient, DescribeStacksCommand, ListStackResourcesCommand } from "@aws-sdk/client-cloudformation";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetAliasCommand, GetFunctionConfigurationCommand, GetFunctionConcurrencyCommand, LambdaClient, UpdateAliasCommand } from "@aws-sdk/client-lambda";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { readCurrentAlarm, readOriginatingAlarm } from "./alarm.js";
import {
  expectedInventoryTarget,
  expectedInventoryDeniedRoleArn,
  expectedInventoryRoleArn,
  readInventoryVariantsManifest,
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
  InventoryAliasObservation,
  InventoryAccessPolicyObservation,
  InventoryVariant,
  InventoryVariantsManifest,
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
const aliasReadbackDelays = [0, 250, 500, 1_000, 2_000];
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
  aliasArn: string;
  codeSha256: string;
  memory: number;
  timeout: number;
  cap: number | "unreserved";
  role: string;
  observedAt: string;
}

interface InventoryContextSettings extends InventoryTargetSettings {
  aliasRevision: string;
  access: "healthy" | "denied";
  sourceRevision: string;
}

interface IncidentContext {
  app: AppTarget;
  target: InventoryPolicyTarget;
  appRevision: string;
  checkout: InventoryTargetSettings;
  inventory: InventoryTargetSettings;
  inventoryAlias: InventoryAliasObservation;
  manifest: InventoryVariantsManifest;
  healthyPolicy: InventoryAccessPolicyRead;
  deniedPolicy: InventoryAccessPolicyRead;
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
  inventoryAlias: InventoryAliasObservation;
  manifest: InventoryVariantsManifest;
  healthyPolicy: InventoryAccessPolicyRead;
  deniedPolicy: InventoryAccessPolicyRead;
  tablePolicy: InventoryTablePolicyRead;
  policy: InventoryAccessPolicyRead;
  incident: IncidentState;
}

interface InventoryMemoryContext {
  app: AppTarget;
  target: InventoryPolicyTarget;
  appRevision: string;
  checkout: InventoryTargetSettings;
  inventory: InventoryContextSettings;
  inventoryAlias: InventoryAliasObservation;
  manifest: InventoryVariantsManifest;
  tablePolicy: InventoryTablePolicyRead;
  policy: InventoryAccessPolicyRead;
  healthyInventory: InventoryContextSettings;
  targetSettings: InventoryContextSettings;
  targetHealthySettings: InventoryContextSettings;
  targetVariant: InventoryVariant;
  incident?: IncidentState;
  baseline: Baseline;
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

async function functionSettings(target: AppTarget, label: "Checkout" | "Inventory", functionName: string,
  expectedVersionOverride?: string, expectedRoleOverride?: string): Promise<InventoryTargetSettings & { aliasRevision: string }> {
  const expectedVersion = expectedVersionOverride ?? target.outputs.get(`${label}LiveVersion`);
  const expectedArn = `arn:aws:lambda:${region}:${account}:function:${functionName}:live`;
  const expectedRole = expectedRoleOverride ?? `arn:aws:iam::${account}:role/IncidentTriageDemoApp${label}Role`;
  const memory = Number(target.outputs.get(`${label}MemorySize`));
  const timeout = Number(target.outputs.get(`${label}TimeoutSeconds`));
  const expectedCap = target.outputs.get(`${label}ReservedConcurrency`);
  if (!expectedVersion || !/^[1-9]\d*$/.test(expectedVersion) || target.outputs.get(`${label}LiveAliasArn`) !== expectedArn ||
      !Number.isSafeInteger(memory) || memory < 1 || !Number.isSafeInteger(timeout) || timeout < 1 ||
      !expectedCap || (expectedCap !== "unreserved" && !/^[1-9]\d*$/.test(expectedCap))) {
    throw new ActionFailure(`${label} expected version or settings are missing.`);
  }
  const alias = await lambda.send(new GetAliasCommand({ FunctionName: functionName, Name: "live" }), providerTimeout());
  if (!alias.FunctionVersion || !alias.RevisionId || (expectedVersion && alias.FunctionVersion !== expectedVersion) || Object.keys(alias.RoutingConfig?.AdditionalVersionWeights ?? {}).length) {
    throw new ActionFailure(`${label} live alias does not match its expected version.`);
  }
  const [config, concurrency] = await Promise.all([
    lambda.send(new GetFunctionConfigurationCommand({ FunctionName: functionName, Qualifier: expectedVersion }), providerTimeout()),
    lambda.send(new GetFunctionConcurrencyCommand({ FunctionName: functionName }), providerTimeout()),
  ]);
  if (config.State !== "Active" || config.Version !== alias.FunctionVersion || config.MemorySize !== memory ||
      config.Timeout !== timeout || !config.CodeSha256 || config.Role !== expectedRole) {
    throw new ActionFailure(`${label} qualified configuration does not match its expected settings.`);
  }
  const cap = concurrency.ReservedConcurrentExecutions;
  if (cap !== (expectedCap === "unreserved" ? undefined : Number(expectedCap))) {
    throw new ActionFailure(`${label} concurrency does not match its expected setting.`);
  }
  const effectiveCap: number | "unreserved" = cap ?? "unreserved";
  return { version: alias.FunctionVersion, aliasArn: expectedArn, memory, timeout, cap: effectiveCap, codeSha256: config.CodeSha256, role: expectedRole, aliasRevision: alias.RevisionId, observedAt: new Date().toISOString() };
}

async function inventoryAlias(target: AppTarget): Promise<InventoryAliasObservation> {
  const aliasArn = `arn:aws:lambda:${region}:${account}:function:${inventoryFunction}:live`;
  const alias = await lambda.send(new GetAliasCommand({ FunctionName: inventoryFunction, Name: "live" }), providerTimeout());
  if (!alias.FunctionVersion || !alias.RevisionId || Object.keys(alias.RoutingConfig?.AdditionalVersionWeights ?? {}).length) {
    throw new ActionFailure("The Inventory live alias is missing a revision or has weighted routing.");
  }
  return { functionName: inventoryFunction, aliasName: "live", aliasArn, functionVersion: alias.FunctionVersion,
    revisionId: alias.RevisionId, routingWeighted: false, observedAt: new Date().toISOString() };
}

function manifestVariant(manifest: InventoryVariantsManifest, memoryMb: number, access: "healthy" | "denied"): InventoryVariant {
  const variant = manifest.variants.find((entry) => entry.memoryMb === memoryMb && entry.access === access);
  if (!variant) throw new ActionFailure(`The Inventory ${access} variant at ${memoryMb} MB is missing from the current release manifest.`);
  return variant;
}

function manifestVariantByVersion(manifest: InventoryVariantsManifest, version: string): InventoryVariant {
  const variant = manifest.variants.find((entry) => entry.version === version);
  if (!variant) throw new ActionFailure("The Inventory live alias points to a version outside the current release manifest.");
  return variant;
}

async function readManifest(target: AppTarget): Promise<InventoryVariantsManifest> {
  const bucket = target.outputs.get("InventoryVariantsManifestBucket");
  const key = target.outputs.get("InventoryVariantsManifestKey");
  if (!bucket || !key) throw new ActionFailure("The app release does not identify the Inventory variants manifest.");
  try {
    return await readInventoryVariantsManifest(bucket, key);
  } catch (error) {
    const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
    throw new ActionFailure(`The Inventory variants manifest is unavailable${detail}`);
  }
}

function validateInventoryReleaseManifest(target: AppTarget, manifest: InventoryVariantsManifest): void {
  const baselineMemory = Number(target.outputs.get("InventoryMemorySize"));
  const supportedSetting = target.outputs.get("InventorySupportedMemoryMb");
  if (manifest.sourceRevision !== target.revision || manifest.functionName !== inventoryFunction || manifest.aliasName !== "live" ||
      manifest.baselineMemoryMb !== baselineMemory || !supportedSetting) {
    throw new ActionFailure("The Inventory variants manifest does not match the current app release.");
  }
  const configuredMemories: number[] = [];
  for (const value of supportedSetting.split(",")) {
    if (!/^[1-9]\d*$/.test(value)) throw new ActionFailure("The Inventory supported memory output is invalid.");
    const memoryMb = Number(value);
    if (!Number.isSafeInteger(memoryMb) || memoryMb < 128 || memoryMb > 10_240) {
      throw new ActionFailure("The Inventory supported memory output is invalid.");
    }
    configuredMemories.push(memoryMb);
  }
  const manifestMemories = [...new Set(manifest.variants.map(({ memoryMb }) => memoryMb))].sort((a, b) => a - b);
  if (configuredMemories.length === 0 || new Set(configuredMemories).size !== configuredMemories.length ||
      JSON.stringify([...configuredMemories].sort((a, b) => a - b)) !== JSON.stringify(manifestMemories) ||
      !manifestMemories.includes(baselineMemory)) {
    throw new ActionFailure("The Inventory supported memory outputs do not match the release manifest.");
  }
  const baselineHealthy = manifestVariant(manifest, manifest.baselineMemoryMb, "healthy");
  if (baselineHealthy.version !== target.outputs.get("InventoryLiveVersion") || baselineHealthy.roleArn !== expectedInventoryRoleArn()) {
    throw new ActionFailure("The healthy baseline variant does not match the app release output.");
  }
}

function requiredInventoryEnvironment(target: AppTarget): Record<string, string> {
  return { APP_ENVIRONMENT: "demo", SOURCE_REVISION: target.revision,
    INVENTORY_TABLE_NAME: target.inventoryTableArn, PRODUCT_SKU: target.sku };
}

async function readInventoryVariantSettings(target: AppTarget, manifest: InventoryVariantsManifest,
  variant: InventoryVariant): Promise<InventoryContextSettings> {
  const config = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: inventoryFunction, Qualifier: variant.version }), providerTimeout());
  const aliasArn = `arn:aws:lambda:${region}:${account}:function:${inventoryFunction}:live`;
  const expectedCap = target.outputs.get("InventoryReservedConcurrency");
  if (config.State !== "Active" || config.Version !== variant.version || config.MemorySize !== variant.memoryMb ||
      config.Timeout !== Number(target.outputs.get("InventoryTimeoutSeconds")) || config.CodeSha256 !== manifest.codeSha256 ||
      config.Role !== variant.roleArn || config.Architectures?.length !== 1 || config.Architectures[0] !== "x86_64" ||
      !expectedCap || (expectedCap !== "unreserved" && !/^[1-9]\d*$/.test(expectedCap))) {
    throw new ActionFailure(`The Inventory ${variant.access} variant configuration does not match the release manifest.`);
  }
  const variables = config.Environment?.Variables;
  const expected = requiredInventoryEnvironment(target);
  if (!variables || Object.keys(variables).sort().join(",") !== Object.keys(expected).sort().join(",") ||
      Object.entries(expected).some(([key, value]) => variables[key] !== value)) {
    throw new ActionFailure(`The Inventory ${variant.access} variant environment does not match the current release.`);
  }
  const concurrency = await lambda.send(new GetFunctionConcurrencyCommand({ FunctionName: inventoryFunction }), providerTimeout());
  const cap = concurrency.ReservedConcurrentExecutions;
  if (cap !== (expectedCap === "unreserved" ? undefined : Number(expectedCap))) {
    throw new ActionFailure("The Inventory concurrency does not match the app release settings.");
  }
  return { version: variant.version, aliasArn, memory: config.MemorySize, timeout: config.Timeout,
    cap: cap ?? "unreserved",
    codeSha256: config.CodeSha256, role: config.Role, aliasRevision: "", access: variant.access,
    sourceRevision: manifest.sourceRevision, observedAt: new Date().toISOString() };
}

async function settings(target: AppTarget): Promise<Baseline["settings"]> {
  if (target.outputs.get("InventoryResourcePolicy") !== "absent") {
    throw new ActionFailure("The app release does not declare the expected absent Inventory policy.");
  }
  const checkout = await functionSettings(target, "Checkout", checkoutFunction);
  const deniedRoleArn = target.outputs.get("InventoryDeniedRoleArn");
  if (deniedRoleArn !== expectedInventoryDeniedRoleArn()) {
    throw new ActionFailure("The app release does not identify the Inventory variants manifest and denied role.");
  }
  const manifest = await readManifest(target);
  validateInventoryReleaseManifest(target, manifest);
  const aliasObservation = await inventoryAlias(target);
  const activeVariant = manifestVariantByVersion(manifest, aliasObservation.functionVersion);
  if (activeVariant.access !== "healthy") throw new ActionFailure("Readiness requires the Inventory live alias to select a healthy release variant.");
  const healthy = activeVariant;
  const denied = manifestVariant(manifest, healthy.memoryMb, "denied");
  const [inventory, deniedSettings] = await Promise.all([
    readInventoryVariantSettings(target, manifest, healthy),
    readInventoryVariantSettings(target, manifest, denied),
  ]);
  if (deniedSettings.memory !== inventory.memory || deniedSettings.timeout !== inventory.timeout ||
      deniedSettings.cap !== inventory.cap || deniedSettings.codeSha256 !== inventory.codeSha256 ||
      deniedSettings.sourceRevision !== inventory.sourceRevision) {
    throw new ActionFailure("The denied Inventory variant differs from the healthy release beyond its execution role.");
  }
  const policyTarget = expectedInventoryTarget(target.inventoryTableArn, target.inventoryRoleArn);
  const deniedPolicyTarget = expectedInventoryTarget(target.inventoryTableArn, deniedRoleArn);
  const [tablePolicy, accessPolicy, deniedAccessPolicy] = await Promise.all([
    readInventoryTablePolicy(policyTarget),
    readInventoryAccessPolicy(policyTarget),
    readInventoryAccessPolicy(deniedPolicyTarget),
  ]);
  if (tablePolicy.observation.state !== "absent") throw new ActionFailure("The Inventory table policy does not match its expected absence.");
  if (!isExactInventoryAccessPolicy(accessPolicy.observation, policyTarget) || accessPolicy.observation.state !== "absent" ||
      !isExactInventoryAccessPolicy(deniedAccessPolicy.observation, deniedPolicyTarget) || deniedAccessPolicy.observation.state !== "present") {
    throw new ActionFailure("The Inventory denial policy or its static role attachment state does not match the expected baseline.");
  }
  if (!accessPolicy.document || !deniedAccessPolicy.document) throw new ActionFailure("The exact Inventory policy document is unavailable.");
  return { account, region, api: target.api, credentialGeneration: target.outputs.get("PresenterCredentialGeneration"),
    checkout, inventory: { ...inventory, aliasRevision: aliasObservation.revisionId, access: "healthy", sourceRevision: target.revision },
    inventoryPolicy: "absent", inventoryAccessPolicy: accessPolicy.observation, inventoryDeniedAccessPolicy: deniedAccessPolicy.observation,
    inventoryPolicyName: accessPolicy.observation.policyName, inventoryPolicyArn: accessPolicy.observation.policyArn,
    inventoryPolicyDefaultVersionId: accessPolicy.observation.defaultVersionId,
    inventoryTableArn: target.inventoryTableArn, inventoryRoleArn: target.inventoryRoleArn,
    inventoryDeniedRoleArn: deniedRoleArn, inventoryVariantsManifest: manifest };
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

function sameInventoryVariantSettings(left: InventoryContextSettings, right: InventoryContextSettings): boolean {
  return left.access === right.access && left.role === right.role && sameInventoryReleaseSettings(left, right);
}

function sameInventoryContextSettings(left: InventoryContextSettings, right: InventoryContextSettings): boolean {
  return left.version === right.version && left.memory === right.memory && left.timeout === right.timeout &&
    left.cap === right.cap && left.codeSha256 === right.codeSha256 && left.role === right.role &&
    left.access === right.access && left.sourceRevision === right.sourceRevision;
}

function sameInventoryReleaseSettings(left: InventoryContextSettings, right: InventoryContextSettings): boolean {
  return left.timeout === right.timeout &&
    left.cap === right.cap && left.codeSha256 === right.codeSha256 && left.sourceRevision === right.sourceRevision;
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
  const deniedRoleArn = target.outputs.get("InventoryDeniedRoleArn");
  if (deniedRoleArn !== expectedInventoryDeniedRoleArn()) throw new ActionFailure("The Inventory release manifest outputs are unavailable.");
  const manifest = await readManifest(target);
  validateInventoryReleaseManifest(target, manifest);
  if (typeof expectedInventory.memory !== "number" || !Number.isSafeInteger(expectedInventory.memory)) {
    throw new ActionFailure("The readiness baseline does not contain a valid Inventory memory setting.");
  }
  const healthy = manifestVariant(manifest, expectedInventory.memory, "healthy");
  const denied = manifestVariant(manifest, expectedInventory.memory, "denied");
  const [inventory, deniedSettings, alias] = await Promise.all([
    readInventoryVariantSettings(target, manifest, healthy),
    readInventoryVariantSettings(target, manifest, denied),
    inventoryAlias(target),
  ]);
  if (!sameInventorySettings(expectedInventory, inventory)) {
    throw new ActionFailure("The deployed Inventory settings changed after readiness.");
  }
  if (deniedSettings.memory !== inventory.memory || deniedSettings.timeout !== inventory.timeout || deniedSettings.cap !== inventory.cap ||
      deniedSettings.codeSha256 !== inventory.codeSha256) {
    throw new ActionFailure("The denied Inventory variant differs from the healthy release beyond its execution role.");
  }
  if (alias.functionVersion !== healthy.version || alias.routingWeighted) throw new ActionFailure("The Inventory live alias changed after readiness.");
  const policyTarget = expectedInventoryTarget(target.inventoryTableArn, target.inventoryRoleArn);
  const deniedPolicyTarget = expectedInventoryTarget(target.inventoryTableArn, deniedRoleArn);
  const [tablePolicy, policy, deniedPolicy] = await Promise.all([
    readInventoryTablePolicy(policyTarget),
    readInventoryAccessPolicy(policyTarget),
    readInventoryAccessPolicy(deniedPolicyTarget),
  ]);
  if (tablePolicy.observation.state !== "absent") throw new ActionFailure("The Inventory table resource policy no longer matches the app's expected absence.");
  if (!isExactInventoryAccessPolicy(policy.observation, policyTarget) || !isExactInventoryAccessPolicy(deniedPolicy.observation, deniedPolicyTarget)) {
    throw new ActionFailure("The named Inventory denial policy has a different default version, document or role target.");
  }
  if (policy.observation.state !== "absent" || deniedPolicy.observation.state !== "present") {
    throw new ActionFailure("The static Inventory role attachment state changed after readiness.");
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
  return { app: target, target: policyTarget, appRevision: target.revision, checkout, inventory, inventoryAlias: alias,
    manifest, tablePolicy, policy: deniedPolicy, healthyPolicy: policy, deniedPolicy, baseline };
}

async function inventoryMemoryContext(action: Action): Promise<InventoryMemoryContext> {
  if (action.command.kind !== "increase_memory") throw new ActionFailure("The Inventory memory command is invalid.");
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
  const baselineSettings = record(baseline.settings);
  const expectedCheckout = baselineSettings && record(baselineSettings.checkout);
  if (!expectedCheckout) throw new ActionFailure("The readiness baseline does not contain the expected Checkout target.");
  const checkout = await functionSettings(target, "Checkout", checkoutFunction);
  if (!sameInventorySettings(expectedCheckout, checkout)) throw new ActionFailure("The deployed Checkout settings changed after readiness.");
  const expectedInventory = baselineInventorySettings(baseline);
  if (typeof expectedInventory.memory !== "number" || !Number.isSafeInteger(expectedInventory.memory)) {
    throw new ActionFailure("The readiness baseline does not contain a valid Inventory memory setting.");
  }
  const deniedRoleArn = target.outputs.get("InventoryDeniedRoleArn");
  if (deniedRoleArn !== expectedInventoryDeniedRoleArn()) throw new ActionFailure("The Inventory release manifest outputs are unavailable.");
  const manifest = await readManifest(target);
  validateInventoryReleaseManifest(target, manifest);
  const baselineManifest = record(baselineSettings.inventoryVariantsManifest);
  if (!baselineManifest || baselineManifest.sourceRevision !== manifest.sourceRevision || baselineManifest.codeSha256 !== manifest.codeSha256) {
    throw new ActionFailure("The verified readiness baseline does not match the current Inventory release manifest.");
  }
  const healthy = manifestVariant(manifest, expectedInventory.memory, "healthy");
  const denied = manifestVariant(manifest, expectedInventory.memory, "denied");
  const alias = await inventoryAlias(target);
  const currentVariant = manifestVariantByVersion(manifest, alias.functionVersion);
  if (currentVariant.memoryMb !== expectedInventory.memory) {
    throw new ActionFailure("The Inventory live alias memory differs from the verified readiness baseline.");
  }
  const incident = incidentRecord(run);
  if (run.incident && !incident) throw new ActionFailure("A legacy Inventory incident cannot be changed by the memory selector.");
  if (incident?.active === "unknown") throw new ActionFailure("The recorded Inventory alias state is unknown; reconcile it before changing memory.");
  if (incident?.active === "denied" && (currentVariant.access !== "denied" || currentVariant.version !== incident.target.version)) {
    throw new ActionFailure("The Inventory alias no longer matches the recorded denied version.");
  }
  if (incident?.active === "healthy" && currentVariant.access !== "healthy") {
    throw new ActionFailure("The Inventory alias no longer matches the recorded healthy version.");
  }
  if (!incident && currentVariant.access !== "healthy") {
    throw new ActionFailure("The Inventory live alias is denied without a matching incident record.");
  }
  const healthyInventory = await readInventoryVariantSettings(target, manifest, healthy);
  if (!sameInventorySettings(expectedInventory, healthyInventory)) {
    throw new ActionFailure("The healthy Inventory settings changed after readiness.");
  }
  const currentInventory = currentVariant.version === healthy.version
    ? healthyInventory : await readInventoryVariantSettings(target, manifest, currentVariant);
  const deniedInventory = currentVariant.version === denied.version
    ? currentInventory : await readInventoryVariantSettings(target, manifest, denied);
  if (deniedInventory.memory !== healthyInventory.memory || deniedInventory.timeout !== healthyInventory.timeout ||
      deniedInventory.cap !== healthyInventory.cap || deniedInventory.codeSha256 !== healthyInventory.codeSha256 ||
      deniedInventory.sourceRevision !== healthyInventory.sourceRevision) {
    throw new ActionFailure("The denied Inventory variant differs from the healthy release beyond its execution role.");
  }
  const requestedMemory = action.command.memoryMb;
  if (requestedMemory < currentVariant.memoryMb) throw new ActionFailure("Inventory memory can only be increased through this action.");
  const targetVariant = requestedMemory === currentVariant.memoryMb
    ? currentVariant : manifestVariant(manifest, requestedMemory, currentVariant.access);
  const targetHealthy = manifestVariant(manifest, requestedMemory, "healthy");
  const targetDenied = manifestVariant(manifest, requestedMemory, "denied");
  const [targetHealthyInventory, targetDeniedInventory] = await Promise.all([
    targetHealthy.version === currentVariant.version ? currentInventory : readInventoryVariantSettings(target, manifest, targetHealthy),
    targetDenied.version === currentVariant.version ? currentInventory : readInventoryVariantSettings(target, manifest, targetDenied),
  ]);
  if (!sameInventoryReleaseSettings(targetHealthyInventory, targetDeniedInventory)) {
    throw new ActionFailure("The prepared Inventory access variants differ beyond their execution role.");
  }
  const targetInventory = currentVariant.access === "healthy" ? targetHealthyInventory : targetDeniedInventory;
  if (!sameInventoryVariantSettings(currentInventory, targetInventory)) {
    throw new ActionFailure("The requested Inventory variant does not preserve the current release settings and access state.");
  }
  const tablePolicyTarget = expectedInventoryTarget(target.inventoryTableArn, target.inventoryRoleArn);
  const deniedPolicyTarget = expectedInventoryTarget(target.inventoryTableArn, deniedRoleArn);
  const [tablePolicy, healthyPolicy, deniedPolicy] = await Promise.all([
    readInventoryTablePolicy(tablePolicyTarget),
    readInventoryAccessPolicy(tablePolicyTarget),
    readInventoryAccessPolicy(deniedPolicyTarget),
  ]);
  if (tablePolicy.observation.state !== "absent" ||
      !isExactInventoryAccessPolicy(healthyPolicy.observation, tablePolicyTarget) || healthyPolicy.observation.state !== "absent" ||
      !isExactInventoryAccessPolicy(deniedPolicy.observation, deniedPolicyTarget) || deniedPolicy.observation.state !== "present" ||
      !healthyPolicy.document || !deniedPolicy.document) {
    throw new ActionFailure("The Inventory roles no longer match the verified healthy/denied access states.");
  }
  const baselineHealthyPolicy = baselineSettings.inventoryAccessPolicy;
  const baselineDeniedPolicy = baselineSettings.inventoryDeniedAccessPolicy;
  if (!record(baselineHealthyPolicy) || !record(baselineDeniedPolicy) ||
      !sameInventoryPolicyVersion(healthyPolicy.observation, baselineHealthyPolicy as InventoryAccessPolicyObservation) ||
      !sameInventoryPolicyVersion(deniedPolicy.observation, baselineDeniedPolicy as InventoryAccessPolicyObservation)) {
    throw new ActionFailure("The Inventory role policy changed after readiness.");
  }
  const currentPolicy = currentVariant.access === "healthy" ? healthyPolicy : deniedPolicy;
  const currentInventoryWithAlias: InventoryContextSettings = { ...currentInventory, aliasRevision: alias.revisionId };
  return { app: target, target: tablePolicyTarget, appRevision: target.revision, checkout, inventory: currentInventoryWithAlias,
    inventoryAlias: alias, manifest, tablePolicy, policy: currentPolicy, healthyInventory,
    targetSettings: targetInventory, targetHealthySettings: targetHealthyInventory, targetVariant, incident, baseline };
}

async function restoreContext(): Promise<RestoreContext> {
  const run = await getRun();
  const incident = incidentRecord(run);
  if (!incident || !incident.policy || !incident.alias) throw new ActionFailure("The recorded Inventory denial is unavailable.");
  const appRevision = incident.appRevision;
  const { policyArn } = incident.policy;
  if (!appRevision || !policyArn || policyArn !== `arn:aws:iam::${account}:policy/IncidentTriageDemoInventoryReadDeny`) {
    throw new ActionFailure("The recorded Inventory denial target is incomplete.");
  }
  const target = await appTarget();
  if (target.revision !== appRevision) throw new ActionFailure("The deployed app release changed after the denial; reconcile readiness before restoring.");
  const deniedRoleArn = target.outputs.get("InventoryDeniedRoleArn");
  if (deniedRoleArn !== expectedInventoryDeniedRoleArn()) throw new ActionFailure("The Inventory release manifest outputs are unavailable.");
  const manifest = await readManifest(target);
  validateInventoryReleaseManifest(target, manifest);
  if (manifest.sourceRevision !== appRevision) throw new ActionFailure("The Inventory variants manifest is stale after the denial.");
  const checkout = await functionSettings(target, "Checkout", checkoutFunction);
  const alias = await inventoryAlias(target);
  const currentVariant = manifestVariantByVersion(manifest, alias.functionVersion);
  const recordedTarget = manifestVariantByVersion(manifest, incident.target.version);
  if (recordedTarget.access !== "denied" || recordedTarget.roleArn !== incident.target.roleArn) {
    throw new ActionFailure("The recorded denied Inventory target is not a denied variant of the current release.");
  }
  const healthy = manifestVariant(manifest, currentVariant.memoryMb, "healthy");
  const denied = manifestVariant(manifest, currentVariant.memoryMb, "denied");
  if (incident.active === "denied" && currentVariant.access === "denied" && currentVariant.version !== incident.target.version) {
    throw new ActionFailure("The Inventory alias changed away from the recorded denied version.");
  }
  if (incident.active === "healthy" && currentVariant.access !== "healthy") {
    throw new ActionFailure("The Inventory alias changed away from the recorded healthy variant.");
  }
  const inventory = await readInventoryVariantSettings(target, manifest, currentVariant);
  const policyTarget = expectedInventoryTarget(target.inventoryTableArn, target.inventoryRoleArn);
  const deniedPolicyTarget = expectedInventoryTarget(target.inventoryTableArn, deniedRoleArn);
  const [tablePolicy, policy, deniedPolicy] = await Promise.all([
    readInventoryTablePolicy(policyTarget), readInventoryAccessPolicy(policyTarget), readInventoryAccessPolicy(deniedPolicyTarget),
  ]);
  if (tablePolicy.observation.state !== "absent") throw new ActionFailure("The Inventory table resource policy changed during the denial.");
  if (!isExactInventoryAccessPolicy(policy.observation, policyTarget) || policy.observation.state !== "absent" ||
      !isExactInventoryAccessPolicy(deniedPolicy.observation, deniedPolicyTarget) || deniedPolicy.observation.state !== "present") {
    throw new ActionFailure("The Inventory static role policy state changed during the denial.");
  }
  return { app: target, target: policyTarget, appRevision, checkout, inventory, inventoryAlias: alias,
    manifest, tablePolicy, policy: deniedPolicy, healthyPolicy: policy, deniedPolicy, incident };
}

function incidentRecord(run: RunState): IncidentState | undefined {
  return run.incident?.kind === "inventory_access_denied" && run.incident.mechanism === "lambda-alias"
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
  context: Pick<IncidentContext, "target" | "appRevision" | "checkout" | "inventory" | "inventoryAlias" | "tablePolicy">,
  policyBefore: InventoryAccessPolicyObservation,
  capturedPolicy: InventoryAccessPolicyRead,
  incident?: IncidentState,
  aliasBefore: InventoryAliasObservation = context.inventoryAlias,
): Promise<ConfigurationCheckpoint> {
  if (!capturedPolicy.document || !capturedPolicy.observation.documentMatches || capturedPolicy.observation.state === "unknown") {
    throw new IncompleteActionFailure("The exact Inventory policy state could not be captured.");
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
    inventoryRoleArn: context.inventory.role,
    inventoryVersion: context.inventory.version,
    inventoryCodeSha256: context.inventory.codeSha256,
    inventoryMemory: context.inventory.memory,
    inventoryTimeout: context.inventory.timeout,
    inventoryCap: context.inventory.cap,
    inventoryAliasBefore: aliasBefore,
    inventoryAliasAtCapture: context.inventoryAlias,
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
        inventoryRoleArn: context.inventory.role,
      },
      code: {
        checkout: context.checkout.codeSha256,
        inventory: context.inventory.codeSha256,
      },
      settings: {
        checkout: context.checkout,
        inventory: context.inventory,
      },
      inventoryAliasBefore: aliasBefore,
      inventoryAliasAtCapture: context.inventoryAlias,
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
    mechanism: "lambda-alias",
    activationActionId: action.id,
    policyBefore: context.policy.observation,
    policy: { ...context.policy.observation, state: "present" },
    aliasBefore: context.inventoryAlias,
    alias: context.inventoryAlias,
    target: manifestVariant(context.manifest, context.inventory.memory, "denied"),
    active: "unknown",
    aliasOutcome: "pending",
    appRevision: context.appRevision,
    updatedAt: new Date().toISOString(),
  };
  const result = await changeAction(action.id, (run, current) => {
    if (run.incident) {
      const prior = run.incident;
      const inactive = prior.mechanism === "lambda-alias" ? prior.active === "healthy" : prior.policy?.state === "absent";
      if (!inactive) return false;
      run.incidentHistory ??= [];
      if (!run.incidentHistory.some((item) => item.activationActionId === prior.activationActionId)) {
        run.incidentHistory.push(structuredClone(prior));
      }
    }
    run.incident = intent;
    current.inventorySwitch = { before: context.inventoryAlias, target: intent.target };
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

async function recordAliasOutcome(actionId: string, outcome: IncidentState["aliasOutcome"]): Promise<void> {
  const result = await changeAction(actionId, (run, current) => {
    const incident = incidentRecord(run);
    if (current.kind === "increase_memory") {
      current.configurationOutcome = outcome === "conflict" ? "failed" : "unknown";
      run.inventoryAliasUnknown = outcome !== "conflict";
      if (incident) run.incident = { ...incident, aliasOutcome: outcome, updatedAt: new Date().toISOString() };
      return true;
    }
    if (!incident || (incident.activationActionId !== actionId && incident.restoreActionId !== actionId)) return false;
    run.incident = { ...incident, aliasOutcome: outcome, updatedAt: new Date().toISOString() };
    return true;
  });
  if (!result) throw new IncompleteActionFailure("The Inventory alias outcome could not be recorded.");
}

function deniedResponse(response: AppResponse): boolean {
  return response.status === 502 && response.body?.code === "INVENTORY_LOOKUP_FAILED" &&
    response.body?.dependencyReason === "inventory_access_denied" && Boolean(response.requestId);
}

function deniedCheckoutResponse(response: AppResponse, payload: CheckoutPayload): boolean {
  return deniedResponse(response) && response.body?.checkoutId === payload.checkoutId && Boolean(response.requestId);
}

async function recordAliasReadback(actionId: string, alias: InventoryAliasObservation, active: IncidentState["active"]): Promise<void> {
  const result = await changeAction(actionId, (run, current) => {
    const incident = incidentRecord(run);
    if (current.kind === "increase_memory") {
      if (!current.inventorySwitch) return false;
      current.inventorySwitch = { ...current.inventorySwitch, after: alias };
      if (active === "unknown") current.configurationOutcome = "unknown";
      run.inventoryAliasUnknown = active === "unknown";
      if (incident) run.incident = { ...incident, alias, active,
        ...(active === "denied" ? { target: current.inventorySwitch.target } : {}),
        aliasOutcome: active === "unknown" ? "ambiguous" : "acknowledged", updatedAt: new Date().toISOString() };
      return true;
    }
    if (!incident) return false;
    run.incident = { ...incident, alias, active, updatedAt: new Date().toISOString() };
    if (current.inventorySwitch) current.inventorySwitch = { ...current.inventorySwitch, after: alias };
    return true;
  });
  if (!result) throw new IncompleteActionFailure("The Inventory alias readback could not be recorded.");
}

async function waitForAliasTarget(action: Action, target: AppTarget, targetVersion: string, expectedRevision: string,
  active: IncidentState["active"], allowConflict: boolean): Promise<InventoryAliasObservation> {
  let last: InventoryAliasObservation | undefined;
  for (const wait of aliasReadbackDelays) {
    if (wait > 0) {
      if (Date.now() + wait + requestTimeout >= action.deadlineAt) break;
      await delay(wait);
    }
    if (Date.now() + requestTimeout >= action.deadlineAt) break;
    try { last = await inventoryAlias(target); }
    catch { continue; }
    if (last.functionVersion !== targetVersion || last.routingWeighted) continue;
    await recordAliasReadback(action.id, last, active);
    return last;
  }
  const message = allowConflict ? "The Inventory alias revision changed before the controller could confirm its target." : "The Inventory alias update could not be reconciled through readback.";
  throw new IncompleteActionFailure(message);
}

async function updateInventoryAlias(action: Action, target: AppTarget, before: InventoryAliasObservation,
  variant: InventoryVariant, active: IncidentState["active"]): Promise<InventoryAliasObservation> {
  if (before.functionVersion === variant.version && !before.routingWeighted) {
    await recordAliasReadback(action.id, before, active);
    return before;
  }
  ensureActionDeadline(action, "Inventory alias update");
  let acknowledged = false;
  try {
    await lambda.send(new UpdateAliasCommand({ FunctionName: inventoryFunction, Name: "live", FunctionVersion: variant.version, RevisionId: before.revisionId }), providerTimeout());
    acknowledged = true;
    await recordAliasOutcome(action.id, "acknowledged");
  } catch (error) {
    const conflict = error instanceof Error && ["PreconditionFailedException", "ResourceConflictException"].includes(error.name);
    await recordAliasOutcome(action.id, conflict ? "conflict" : "ambiguous");
    if (conflict) {
      const observed = await inventoryAlias(target);
      if (observed.functionVersion !== before.functionVersion || observed.revisionId !== before.revisionId) {
        await recordAliasReadback(action.id, observed, "unknown");
      }
      throw new ActionFailure("The Inventory alias revision changed before the controller could update it.");
    }
  }
  const observed = await waitForAliasTarget(action, target, variant.version, before.revisionId, active, !acknowledged);
  return observed;
}

async function recordInventoryMemoryIntent(action: Action, before: InventoryAliasObservation, target: InventoryVariant): Promise<void> {
  const result = await changeAction(action.id, (_run, current) => {
    if (current.kind !== "increase_memory") return false;
    current.inventorySwitch = { before, target };
    current.configurationOutcome = "unknown";
    return true;
  });
  if (!result) throw new IncompleteActionFailure("The Inventory memory intent could not be recorded.");
}

async function linkInventoryMemoryCheckpoint(actionId: string, value: ConfigurationCheckpoint): Promise<void> {
  const result = await changeAction(actionId, (_run, current) => {
    if (current.kind !== "increase_memory") return false;
    current.configurationCheckpoint = value;
    return true;
  });
  if (!result) throw new IncompleteActionFailure("The Inventory memory checkpoint could not be linked to its action.");
}

async function completeInventoryMemorySelection(action: Action, context: InventoryMemoryContext,
  alias: InventoryAliasObservation, outcome: "applied" | "no_change"): Promise<void> {
  const finishedAt = new Date().toISOString();
  const done = await changeAction(action.id, (run, current) => {
    if (current.kind !== "increase_memory" || !run.baseline || run.baseline.appRevision !== context.appRevision) return false;
    if (!run.originalBaseline || run.originalBaseline.appRevision !== run.baseline.appRevision) {
      run.originalBaseline = structuredClone(run.baseline);
    }
    const baselineSettings = record(run.baseline.settings);
    if (!baselineSettings) return false;
    const inventory = { ...context.targetHealthySettings, aliasRevision: alias.revisionId,
      access: "healthy" as const, sourceRevision: context.manifest.sourceRevision };
    const updatedBaseline: Baseline = { ...run.baseline, settings: {
      ...baselineSettings,
      inventory,
      inventoryVariantsManifest: context.manifest,
    } };
    run.baseline = updatedBaseline;
    run.inventoryAliasUnknown = false;
    current.baseline = updatedBaseline;
    current.inventorySwitch = { before: context.inventoryAlias, target: context.targetVariant, after: alias };
    current.configurationOutcome = outcome;
    current.status = "completed";
    current.finishedAt = finishedAt;
    const incident = incidentRecord(run);
    if (incident) {
      run.incident = { ...incident, alias, active: context.targetVariant.access,
        ...(context.targetVariant.access === "denied" ? { target: context.targetVariant } : {}),
        aliasOutcome: "acknowledged", updatedAt: finishedAt };
    }
    return true;
  });
  if (!done) throw new IncompleteActionFailure("The Inventory memory result could not be recorded.");
}

async function increaseInventoryMemory(action: Action): Promise<void> {
  const context = await inventoryMemoryContext(action);
  const before = context.inventoryAlias;
  const target = context.targetVariant;
  await recordInventoryMemoryIntent(action, before, target);
  if (target.version === before.functionVersion) {
    await completeInventoryMemorySelection(action, context, before, "no_change");
    return;
  }
  ensureActionDeadline(action, "Inventory memory checkpoint");
  let saved: ConfigurationCheckpoint;
  try {
    saved = await checkpoint(action, context, context.policy.observation, context.policy, undefined, before);
  } catch (error) {
    if (error instanceof IncompleteActionFailure && error.checkpoint) {
      await linkInventoryMemoryCheckpoint(action.id, error.checkpoint);
    }
    throw error;
  }
  await linkInventoryMemoryCheckpoint(action.id, saved);
  const selectedAlias = await updateInventoryAlias(action, context.app, before, target, target.access);
  const selectedSettings = await readInventoryVariantSettings(context.app, context.manifest, target);
  if (!sameInventoryContextSettings(context.targetSettings, selectedSettings)) {
    throw new IncompleteActionFailure("The selected Inventory version did not match its qualified configuration readback.");
  }
  if (selectedAlias.functionVersion !== target.version || selectedAlias.routingWeighted) {
    throw new IncompleteActionFailure("The Inventory alias readback did not confirm the selected version.");
  }
  await completeInventoryMemorySelection(action, context, selectedAlias, "applied");
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
  const targetVariant = manifestVariant(context.manifest, context.inventory.memory, "denied");
  const alias = await updateInventoryAlias(action, context.app, context.inventoryAlias, targetVariant, "denied");
  await changeAction(action.id, (run, current) => {
    const incident = incidentRecord(run);
    if (!incident) return false;
    run.incident = { ...incident, alias, active: "denied", aliasOutcome: "acknowledged", updatedAt: new Date().toISOString() };
    current.inventorySwitch = { before: context.inventoryAlias, target: targetVariant, after: alias };
    return true;
  });
  const deniedInventory = await readInventoryVariantSettings(context.app, context.manifest, targetVariant);
  const deniedContext: IncidentContext = { ...context, inventory: deniedInventory, inventoryAlias: alias };
  let stored: ConfigurationCheckpoint;
  try {
    stored = await checkpoint(action, deniedContext, context.policy.observation, context.policy, undefined, context.inventoryAlias);
  } catch (error) {
    const unavailable = error instanceof IncompleteActionFailure ? error.checkpoint : undefined;
    if (unavailable) await linkUnavailableCheckpoint(action.id, unavailable);
    throw error;
  }
  await recordCheckpoint(action.id, stored, context.policy.observation);

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
  context: Pick<IncidentContext, "target" | "appRevision" | "inventory" | "inventoryAlias" | "tablePolicy">,
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
    inventoryRoleArn: context.inventory.role,
    inventoryVersion: context.inventory.version,
    inventoryCodeSha256: context.inventory.codeSha256,
    inventoryMemory: context.inventory.memory,
    inventoryTimeout: context.inventory.timeout,
    inventoryCap: context.inventory.cap,
    inventoryAliasBefore: context.inventoryAlias,
    inventoryAliasAtCapture: context.inventoryAlias,
    tablePolicyBefore: context.tablePolicy.observation,
    inventoryPolicyBefore: policyBefore,
    inventoryPolicyAtCapture: policyAtCapture,
    error,
  };
}

async function recordRestoreIntent(action: Action, activationActionId: string, policy: InventoryAccessPolicyObservation,
  before: InventoryAliasObservation, target: InventoryVariant): Promise<void> {
  const result = await changeAction(action.id, (run, current) => {
    const incident = incidentRecord(run);
    if (!incident || incident.activationActionId !== activationActionId) return false;
    run.incident = {
      ...incident,
      restoreActionId: action.id,
      policy,
      active: "unknown",
      aliasOutcome: "pending",
      updatedAt: new Date().toISOString(),
    };
    current.inventorySwitch = { before, target };
    current.configurationOutcome = "unknown";
    return true;
  });
  if (!result) throw new IncompleteActionFailure("The Inventory restore intent could not be recorded.");
}


async function restoreInventoryAccess(action: Action): Promise<void> {
  const context = await restoreContext();
  const incident = context.incident;
  if (incident.activationActionId === action.id) throw new ActionFailure("The recorded Inventory denial is unavailable.");
  const currentVariant = manifestVariantByVersion(context.manifest, context.inventoryAlias.functionVersion);
  const healthy = manifestVariant(context.manifest, currentVariant.memoryMb, "healthy");
  if (currentVariant.access === "healthy") {
    const finishedAt = new Date().toISOString();
    const done = await changeAction(action.id, (run, current) => {
      const currentIncident = incidentRecord(run);
      if (!currentIncident || currentIncident.activationActionId !== incident.activationActionId) return false;
      run.incident = { ...currentIncident, alias: context.inventoryAlias, active: "healthy", aliasOutcome: "acknowledged",
        restoreActionId: action.id, updatedAt: finishedAt };
      run.inventoryAliasUnknown = false;
      current.inventorySwitch = { before: context.inventoryAlias, target: healthy, after: context.inventoryAlias };
      current.status = "completed";
      current.configurationOutcome = "no_change";
      current.finishedAt = finishedAt;
      return true;
    });
    if (!done) throw new IncompleteActionFailure("The completed Inventory restore could not be recorded.");
    return;
  }
  const withoutEvidence = commandRestoreWithoutEvidence(action);
  if (withoutEvidence && incident.checkpoint?.status === "stored" && incident.checkpoint.key) {
    throw new ActionFailure("restoreWithoutEvidence is only allowed when the ordinary configuration capture is unavailable.");
  }
  const priorCaptureUnavailable = incident.checkpoint?.status === "unavailable" || incident.checkpoint?.status === "incomplete";
  if (priorCaptureUnavailable && !withoutEvidence) {
    throw new ActionFailure("The incident configuration checkpoint is unavailable; confirm restoreWithoutEvidence to protectively restore the known alias.");
  }
  let checkpointValue = incident.checkpoint;
  let evidenceIncomplete = false;
  try {
    if (!priorCaptureUnavailable || !withoutEvidence) {
      checkpointValue = await checkpoint(action, context, incident.policyBefore, context.policy, incident);
      const linked = await changeAction(action.id, (run) => {
        const currentIncident = incidentRecord(run);
        if (!currentIncident || currentIncident.activationActionId !== incident.activationActionId) return false;
        run.incident = { ...currentIncident, checkpoint: checkpointValue, updatedAt: new Date().toISOString() };
        return true;
      });
      if (!linked) throw new IncompleteActionFailure("The pre-restore configuration checkpoint could not be linked to the run.");
    } else {
      evidenceIncomplete = true;
    }
  } catch (error) {
    const unavailable = error instanceof IncompleteActionFailure && error.checkpoint
      ? error.checkpoint
      : incompleteCheckpoint(context, incident.policyBefore, context.policy.observation,
        "The fresh pre-restore checkpoint could not be stored.", "unavailable");
    const linked = await changeAction(action.id, (run) => {
      const currentIncident = incidentRecord(run);
      if (!currentIncident || currentIncident.activationActionId !== incident.activationActionId) return false;
      run.incident = { ...currentIncident, checkpoint: unavailable, updatedAt: new Date().toISOString() };
      return true;
    });
    if (!linked) throw new IncompleteActionFailure("The unavailable restore checkpoint could not be recorded.");
    if (!withoutEvidence) throw new ActionFailure(error instanceof Error ? error.message : "The pre-restore checkpoint is unavailable.");
    evidenceIncomplete = true;
  }
  const before = context.inventoryAlias;
  await recordRestoreIntent(action, incident.activationActionId, context.policy.observation, before, healthy);
  const restored = await updateInventoryAlias(action, context.app, before, healthy, "healthy");
  const finishedAt = new Date().toISOString();
  const done = await changeAction(action.id, (run, current) => {
    const currentIncident = incidentRecord(run);
    if (!currentIncident || currentIncident.activationActionId !== incident.activationActionId) return false;
    run.incident = { ...currentIncident, alias: restored, active: "healthy", aliasOutcome: "acknowledged",
      restoreActionId: action.id,
      ...(evidenceIncomplete ? { checkpoint: incompleteCheckpoint(context, incident.policyBefore, context.policy.observation,
        "Restored only through explicit restoreWithoutEvidence; durable pre-change capture was unavailable.") } : {}),
      updatedAt: finishedAt };
    run.inventoryAliasUnknown = false;
    current.inventorySwitch = { before, target: healthy, after: restored };
    current.status = "completed";
    current.configurationOutcome = "applied";
    current.finishedAt = finishedAt;
    return true;
  });
  if (!done) throw new IncompleteActionFailure("The completed Inventory restore could not be recorded.");
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
    if (!run.originalBaseline || run.originalBaseline.appRevision !== baseline.appRevision) {
      run.originalBaseline = structuredClone(baseline);
    }
    run.inventoryAliasUnknown = false;
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
    if (claim.action.kind === "increase_memory") await increaseInventoryMemory(claim.action);
    if (claim.action.kind === "activate_inventory_denial") await activateInventoryDenial(claim.action);
    if (claim.action.kind === "restore_inventory_access") await restoreInventoryAccess(claim.action);
  } catch (error) {
    await changeAction(actionId, (run, current) => {
      const unrecorded = current.requests.some((request) => !request.completedAt);
      current.status = error instanceof IncompleteActionFailure || unrecorded || Date.now() >= current.deadlineAt
        ? "incomplete" : "failed";
      if (current.kind === "restore_inventory_access") {
        current.configurationOutcome = current.status === "incomplete" ? "unknown" : "failed";
      } else if (current.kind === "increase_memory") {
        current.configurationOutcome = current.configurationOutcome === "unknown" || current.status === "incomplete"
          ? "unknown" : "failed";
      } else if (current.kind === "activate_inventory_denial") {
        const incident = run.incident?.mechanism === "lambda-alias" && run.incident.activationActionId === actionId
          ? run.incident : undefined;
        current.configurationOutcome = !incident ? "failed"
          : incident.active === "denied" ? "applied" : "unknown";
      }
      current.error = error instanceof ActionFailure ? error.message : "A required controller or app provider call failed.";
      current.finishedAt = new Date().toISOString();
      return true;
    });
  }
}
