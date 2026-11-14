import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CloudFormationClient, DescribeStacksCommand, ListStackResourcesCommand } from "@aws-sdk/client-cloudformation";
import { DeleteItemCommand, DynamoDBClient, GetItemCommand, PutItemCommand, ScanCommand,
  type AttributeValue, type ScanCommandInput, type ScanCommandOutput } from "@aws-sdk/client-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DeleteFunctionConcurrencyCommand, GetAccountSettingsCommand, GetAliasCommand, GetFunctionConfigurationCommand, GetFunctionConcurrencyCommand,
  LambdaClient, PutFunctionConcurrencyCommand, UpdateAliasCommand } from "@aws-sdk/client-lambda";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { readCurrentAlarm, readOriginatingAlarm } from "./alarm.js";
import seedProduct from "../../scripts/app-product.json";
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
import { beginReset, changeAction, getAction, getRun } from "./store.js";
import type {
  Action,
  Baseline,
  CatalogBin,
  CatalogObservation,
  CatalogOutcome,
  CatalogOutcomes,
  CatalogSkip,
  CatalogSkips,
  CapRestoration,
  CapValue,
  CheckoutPayload,
  ConfigurationCheckpoint,
  Counters,
  DeploymentIdentity,
  IncidentState,
  InventoryAliasObservation,
  InventoryAccessPolicyObservation,
  InventoryVariant,
  InventoryVariantsManifest,
  Profile,
  Receipt,
  RequestRecord,
  RunState,
  StoredIncidentState,
  TrafficContext,
  TrafficProfileSnapshot,
  TrafficProfileV2,
  TrafficWindow,
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
const dynamo = new DynamoDBClient(clientOptions);

class ActionFailure extends Error {}
class IncompleteActionFailure extends ActionFailure {
  constructor(message: string, readonly checkpoint?: ConfigurationCheckpoint) { super(message); }
}

interface AppTarget {
  stackId: string;
  successfulAt: string;
  revision: string;
  api: string;
  sku: string;
  inventoryRoleArn: string;
  inventoryTableArn: string;
  outputs: Map<string, string>;
}

interface VerifiedSettings extends Record<string, unknown> {
  checkout: InventoryTargetSettings;
  inventory: InventoryContextSettings;
  inventoryAccessPolicy: InventoryAccessPolicyObservation;
  inventoryDeniedAccessPolicy: InventoryAccessPolicyObservation;
  inventoryVariantsManifest: InventoryVariantsManifest;
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
  sent?: boolean;
}

interface StatusCheck {
  submitted: boolean;
  receipt?: Receipt;
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

type InventoryCapExpectation = number | "unreserved";

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

interface RecoveryContext {
  app: AppTarget;
  target: InventoryPolicyTarget;
  appRevision: string;
  checkout: InventoryTargetSettings & { aliasRevision: string };
  inventory: InventoryContextSettings;
  inventoryAlias: InventoryAliasObservation;
  manifest: InventoryVariantsManifest;
  tablePolicy: InventoryTablePolicyRead;
  policy: InventoryAccessPolicyRead;
  healthyPolicy: InventoryAccessPolicyRead;
  deniedPolicy: InventoryAccessPolicyRead;
  deploymentIdentity: DeploymentIdentity;
  baseline: Baseline;
  targetVariant: InventoryVariant;
  targetInventory: InventoryContextSettings;
  targetCheckout: InventoryTargetSettings;
}

interface CurrentReleaseContext extends Omit<RecoveryContext, "baseline"> {}

interface CapacityContext extends CurrentReleaseContext {
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
  const successfulAt = stack.LastUpdatedTime ?? stack.CreationTime;
  if (!(successfulAt instanceof Date) || !Number.isFinite(successfulAt.getTime())) {
    throw new ActionFailure("The named app stack has no successful deployment timestamp.");
  }
  const outputs = new Map(stack.Outputs?.map(({ OutputKey, OutputValue }) => [OutputKey ?? "", OutputValue ?? ""]));
  const revision = outputs.get("SourceRevision");
  const sku = outputs.get("ProductSku");
  const inventoryRoleArn = outputs.get("InventoryRoleArn");
  const expectedInventoryRoleArn = `arn:aws:iam::${account}:role/IncidentTriageDemoAppInventoryRole`;
  if (!revision || !/^[0-9a-f]{40}$/.test(revision) || !sku ||
      outputs.get("CheckoutFunctionName") !== checkoutFunction || outputs.get("InventoryFunctionName") !== inventoryFunction ||
      outputs.get("OrdersTableName") !== "IncidentTriageDemoOrders" || outputs.get("InventoryTableName") !== inventoryTable || inventoryRoleArn !== expectedInventoryRoleArn ||
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
  return { stackId: stack.StackId, successfulAt: successfulAt.toISOString(), revision, api, sku, inventoryRoleArn,
    inventoryTableArn: `arn:aws:dynamodb:${region}:${account}:table/${inventoryTable}`, outputs };
}

async function functionSettings(target: AppTarget, label: "Checkout" | "Inventory", functionName: string,
  expectedVersionOverride?: string, expectedRoleOverride?: string, allowCapDrift = false,
  expectedEnvironment?: Record<string, string>): Promise<InventoryTargetSettings & { aliasRevision: string }> {
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
  if (expectedEnvironment) {
    const variables = config.Environment?.Variables;
    if (config.Architectures?.length !== 1 || config.Architectures[0] !== "x86_64" || !variables ||
        Object.keys(variables).sort().join(",") !== Object.keys(expectedEnvironment).sort().join(",") ||
        Object.entries(expectedEnvironment).some(([key, value]) => variables[key] !== value)) {
      throw new ActionFailure(`${label} qualified environment does not match the current app release.`);
    }
  }
  const cap = concurrency.ReservedConcurrentExecutions;
  if (!allowCapDrift && cap !== (expectedCap === "unreserved" ? undefined : Number(expectedCap))) {
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

function requiredCheckoutEnvironment(target: AppTarget, bearer: string): Record<string, string> {
  const credentialGeneration = target.outputs.get("PresenterCredentialGeneration");
  const ordersTable = target.outputs.get("OrdersTableName");
  const inventoryAliasArn = `arn:aws:lambda:${region}:${account}:function:${inventoryFunction}:live`;
  if (!credentialGeneration || ordersTable !== "IncidentTriageDemoOrders") {
    throw new ActionFailure("The app release does not identify its expected Checkout credential or Orders table.");
  }
  return {
    APP_ENVIRONMENT: "demo",
    SOURCE_REVISION: target.revision,
    PRESENTER_CREDENTIAL_DIGEST: createHash("sha256").update(bearer).digest("hex"),
    PRESENTER_CREDENTIAL_GENERATION: credentialGeneration,
    ORDERS_TABLE_NAME: ordersTable,
    INVENTORY_TABLE_NAME: inventoryTable,
    INVENTORY_FUNCTION_NAME: inventoryAliasArn,
    PRODUCT_SKU: target.sku,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = record(value);
  if (object) return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function expectedCap(target: AppTarget, label: "Checkout" | "Inventory"): number | "unreserved" {
  const value = target.outputs.get(`${label}ReservedConcurrency`);
  if (value === "unreserved") return value;
  if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ActionFailure(`${label} expected concurrency is missing or invalid.`);
  }
  return Number(value);
}

async function deploymentIdentity(target: AppTarget, manifest: InventoryVariantsManifest,
  checkout: InventoryTargetSettings, allowCapDrift = false): Promise<DeploymentIdentity> {
  const baselineMemory = Number(target.outputs.get("InventoryMemorySize"));
  const baselineVariant = manifestVariant(manifest, manifest.baselineMemoryMb, "healthy");
  if (baselineMemory !== manifest.baselineMemoryMb || baselineVariant.version !== target.outputs.get("InventoryLiveVersion") ||
      !checkout.codeSha256 || checkout.version !== target.outputs.get("CheckoutLiveVersion")) {
    throw new ActionFailure("The successful app release identity does not match its immutable baseline artifacts.");
  }
  await readInventoryVariantSettings(target, manifest, baselineVariant, allowCapDrift);
  return {
    stackId: target.stackId,
    successfulAt: target.successfulAt,
    sourceRevision: target.revision,
    api: target.api,
    sku: target.sku,
    credentialGeneration: target.outputs.get("PresenterCredentialGeneration") ?? "",
    checkoutVersion: checkout.version,
    checkoutCodeSha256: checkout.codeSha256,
    checkoutMemoryMb: Number(target.outputs.get("CheckoutMemorySize")),
    checkoutTimeoutSeconds: Number(target.outputs.get("CheckoutTimeoutSeconds")),
    checkoutCap: expectedCap(target, "Checkout"),
    inventoryVersion: baselineVariant.version,
    inventoryCodeSha256: manifest.codeSha256,
    inventoryManifestSha256: createHash("sha256").update(stableJson(manifest)).digest("hex"),
    inventoryMemoryMb: baselineMemory,
    inventoryTimeoutSeconds: Number(target.outputs.get("InventoryTimeoutSeconds")),
    inventoryCap: expectedCap(target, "Inventory"),
  };
}

function sameDeploymentIdentity(left: DeploymentIdentity | undefined, right: DeploymentIdentity): boolean {
  return Boolean(left) && stableJson(left) === stableJson(right);
}

function incidentMatchesDeployment(incident: StoredIncidentState | undefined, identity: DeploymentIdentity): boolean {
  if (!incident) return false;
  const known = "deploymentIdentity" in incident ? incident.deploymentIdentity : undefined;
  return known ? sameDeploymentIdentity(known, identity) : false;
}

async function readInventoryVariantSettings(target: AppTarget, manifest: InventoryVariantsManifest,
  variant: InventoryVariant, allowCapDrift = false,
  inventoryCapExpectation?: InventoryCapExpectation): Promise<InventoryContextSettings> {
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
  const expectedObservedCap = inventoryCapExpectation ?? (expectedCap === "unreserved" ? "unreserved" : Number(expectedCap));
  if (!allowCapDrift && cap !== (expectedObservedCap === "unreserved" ? undefined : expectedObservedCap)) {
    throw new ActionFailure("The Inventory concurrency does not match the app release settings.");
  }
  return { version: variant.version, aliasArn, memory: config.MemorySize, timeout: config.Timeout,
    cap: cap ?? "unreserved",
    codeSha256: config.CodeSha256, role: config.Role, aliasRevision: "", access: variant.access,
    sourceRevision: manifest.sourceRevision, observedAt: new Date().toISOString() };
}

async function settings(target: AppTarget, bearer: string,
  inventoryCapExpectation?: InventoryCapExpectation): Promise<VerifiedSettings> {
  if (target.outputs.get("InventoryResourcePolicy") !== "absent") {
    throw new ActionFailure("The app release does not declare the expected absent Inventory policy.");
  }
  const checkout = await functionSettings(target, "Checkout", checkoutFunction, undefined, undefined,
    false, requiredCheckoutEnvironment(target, bearer));
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
    readInventoryVariantSettings(target, manifest, healthy, false, inventoryCapExpectation),
    readInventoryVariantSettings(target, manifest, denied, false, inventoryCapExpectation),
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

function baselineInventoryCap(baseline: Baseline): InventoryCapExpectation {
  const cap = baselineInventorySettings(baseline).cap;
  if (cap === "unreserved") return cap;
  if (typeof cap === "number" && Number.isSafeInteger(cap) && cap > 0) return cap;
  throw new ActionFailure("The readiness baseline does not contain a valid positive Inventory cap.");
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

function sameInventoryVariantConfiguration(left: InventoryContextSettings, right: InventoryContextSettings): boolean {
  return left.version === right.version && left.memory === right.memory && left.timeout === right.timeout &&
    left.codeSha256 === right.codeSha256 && left.role === right.role &&
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
  const currentCap = baselineInventoryCap(baseline);
  const bearer = await loadBearer();
  const checkout = await functionSettings(target, "Checkout", checkoutFunction, undefined, undefined, false,
    requiredCheckoutEnvironment(target, bearer));
  if (!sameInventorySettings(expectedCheckout, checkout)) {
    throw new ActionFailure("The deployed Checkout settings changed after readiness.");
  }
  const deniedRoleArn = target.outputs.get("InventoryDeniedRoleArn");
  if (deniedRoleArn !== expectedInventoryDeniedRoleArn()) throw new ActionFailure("The Inventory release manifest outputs are unavailable.");
  const manifest = await readManifest(target);
  validateInventoryReleaseManifest(target, manifest);
  const identity = await deploymentIdentity(target, manifest, checkout, true);
  if ((baseline.deploymentIdentity && !sameDeploymentIdentity(baseline.deploymentIdentity, identity)) ||
      (run.originalBaseline?.deploymentIdentity && !sameDeploymentIdentity(run.originalBaseline.deploymentIdentity, identity))) {
    throw new ActionFailure("The current app generation does not match the trusted readiness identity.");
  }
  if (typeof expectedInventory.memory !== "number" || !Number.isSafeInteger(expectedInventory.memory)) {
    throw new ActionFailure("The readiness baseline does not contain a valid Inventory memory setting.");
  }
  const healthy = manifestVariant(manifest, expectedInventory.memory, "healthy");
  const denied = manifestVariant(manifest, expectedInventory.memory, "denied");
  const [inventory, deniedSettings, alias] = await Promise.all([
    readInventoryVariantSettings(target, manifest, healthy, false, currentCap),
    readInventoryVariantSettings(target, manifest, denied, false, currentCap),
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
  const currentCap = baselineInventoryCap(baseline);
  const baselineSettings = record(baseline.settings);
  const expectedCheckout = baselineSettings && record(baselineSettings.checkout);
  if (!expectedCheckout) throw new ActionFailure("The readiness baseline does not contain the expected Checkout target.");
  const bearer = await loadBearer();
  const checkout = await functionSettings(target, "Checkout", checkoutFunction, undefined, undefined, false,
    requiredCheckoutEnvironment(target, bearer));
  if (!sameInventorySettings(expectedCheckout, checkout)) throw new ActionFailure("The deployed Checkout settings changed after readiness.");
  const expectedInventory = baselineInventorySettings(baseline);
  if (typeof expectedInventory.memory !== "number" || !Number.isSafeInteger(expectedInventory.memory)) {
    throw new ActionFailure("The readiness baseline does not contain a valid Inventory memory setting.");
  }
  const deniedRoleArn = target.outputs.get("InventoryDeniedRoleArn");
  if (deniedRoleArn !== expectedInventoryDeniedRoleArn()) throw new ActionFailure("The Inventory release manifest outputs are unavailable.");
  const manifest = await readManifest(target);
  validateInventoryReleaseManifest(target, manifest);
  const identity = await deploymentIdentity(target, manifest, checkout, true);
  if ((baseline.deploymentIdentity && !sameDeploymentIdentity(baseline.deploymentIdentity, identity)) ||
      (run.originalBaseline?.deploymentIdentity && !sameDeploymentIdentity(run.originalBaseline.deploymentIdentity, identity))) {
    throw new ActionFailure("The current app generation does not match the trusted readiness identity.");
  }
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
  const healthyInventory = await readInventoryVariantSettings(target, manifest, healthy, false, currentCap);
  if (!sameInventorySettings(expectedInventory, healthyInventory)) {
    throw new ActionFailure("The healthy Inventory settings changed after readiness.");
  }
  const currentInventory = currentVariant.version === healthy.version
    ? healthyInventory : await readInventoryVariantSettings(target, manifest, currentVariant, false, currentCap);
  const deniedInventory = currentVariant.version === denied.version
    ? currentInventory : await readInventoryVariantSettings(target, manifest, denied, false, currentCap);
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
    targetHealthy.version === currentVariant.version ? currentInventory : readInventoryVariantSettings(target, manifest, targetHealthy, false, currentCap),
    targetDenied.version === currentVariant.version ? currentInventory : readInventoryVariantSettings(target, manifest, targetDenied, false, currentCap),
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
  const baseline = run.baseline;
  const incident = incidentRecord(run);
  if (!baseline || !incident || !incident.policy || !incident.alias) throw new ActionFailure("The recorded Inventory denial is unavailable.");
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
  const currentCap = baselineInventoryCap(baseline);
  const bearer = await loadBearer();
  const checkout = await functionSettings(target, "Checkout", checkoutFunction, undefined, undefined, false,
    requiredCheckoutEnvironment(target, bearer));
  const identity = await deploymentIdentity(target, manifest, checkout, true);
  if ((baseline.deploymentIdentity && !sameDeploymentIdentity(baseline.deploymentIdentity, identity)) ||
      (run.originalBaseline?.deploymentIdentity && !sameDeploymentIdentity(run.originalBaseline.deploymentIdentity, identity)) ||
      (incident.deploymentIdentity && !sameDeploymentIdentity(incident.deploymentIdentity, identity))) {
    throw new ActionFailure("The current app generation does not match the trusted readiness identity.");
  }
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
  const inventory = await readInventoryVariantSettings(target, manifest, currentVariant, false, currentCap);
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

async function currentReleaseContext(bearer: string, verifiedTarget?: AppTarget): Promise<CurrentReleaseContext> {
  const target = verifiedTarget ?? await appTarget();
  if (target.outputs.get("InventoryResourcePolicy") !== "absent" ||
      target.outputs.get("InventoryDeniedRoleArn") !== expectedInventoryDeniedRoleArn()) {
    throw new ActionFailure("The current app release does not identify the expected Inventory access configuration.");
  }
  const manifest = await readManifest(target);
  validateInventoryReleaseManifest(target, manifest);
  const checkout = await functionSettings(target, "Checkout", checkoutFunction, undefined, undefined, true,
    requiredCheckoutEnvironment(target, bearer));
  const alias = await inventoryAlias(target);
  const currentVariant = manifestVariantByVersion(manifest, alias.functionVersion);
  const targetVariant = manifestVariant(manifest, manifest.baselineMemoryMb, "healthy");
  const [inventory, targetInventory] = await Promise.all([
    readInventoryVariantSettings(target, manifest, currentVariant, true),
    readInventoryVariantSettings(target, manifest, targetVariant, true),
  ]);
  const targetCheckout = { ...checkout, cap: expectedCap(target, "Checkout") };
  const targetInventorySettings = { ...targetInventory, cap: expectedCap(target, "Inventory") };
  const identity = await deploymentIdentity(target, manifest, checkout, true);
  const healthyTarget = expectedInventoryTarget(target.inventoryTableArn, target.inventoryRoleArn);
  const deniedRoleArn = target.outputs.get("InventoryDeniedRoleArn") ?? "";
  const deniedTarget = expectedInventoryTarget(target.inventoryTableArn, deniedRoleArn);
  const [tablePolicy, healthyPolicy, deniedPolicy] = await Promise.all([
    readInventoryTablePolicy(healthyTarget),
    readInventoryAccessPolicy(healthyTarget),
    readInventoryAccessPolicy(deniedTarget),
  ]);
  if (tablePolicy.observation.state !== "absent" ||
      !isExactInventoryAccessPolicy(healthyPolicy.observation, healthyTarget) || healthyPolicy.observation.state !== "absent" ||
      !isExactInventoryAccessPolicy(deniedPolicy.observation, deniedTarget) || deniedPolicy.observation.state !== "present" ||
      !healthyPolicy.document || !deniedPolicy.document) {
    throw new ActionFailure("The current Inventory role or policy state is not the trusted healthy/denied release configuration.");
  }
  const policy = currentVariant.access === "healthy" ? healthyPolicy : deniedPolicy;
  return { app: target, target: healthyTarget, appRevision: target.revision, checkout, inventory, inventoryAlias: alias,
    manifest, tablePolicy, policy, healthyPolicy, deniedPolicy, deploymentIdentity: identity,
    targetVariant, targetInventory: targetInventorySettings, targetCheckout };
}

async function capacityContext(action: Action, bearer: string): Promise<CapacityContext> {
  const run = await getRun();
  const baseline = run.baseline;
  const original = run.originalBaseline;
  if (run.resetRequired || !baseline || !original || !baseline.deploymentIdentity || !original.deploymentIdentity) {
    throw new ActionFailure("Fresh readiness against the current successful app release is required before changing capacity.");
  }
  if (run.configurationActionId !== action.id || run.inventoryAliasUnknown || run.unresolved.length > 0) {
    throw new ActionFailure("Inventory capacity requires a settled run with a known alias and no unresolved checkout.");
  }
  const release = await currentReleaseContext(bearer);
  if (baseline.appRevision !== release.appRevision || original.appRevision !== release.appRevision ||
      baseline.sku !== release.app.sku || original.sku !== release.app.sku ||
      !sameDeploymentIdentity(baseline.deploymentIdentity, release.deploymentIdentity) ||
      !sameDeploymentIdentity(original.deploymentIdentity, release.deploymentIdentity)) {
    throw new ActionFailure("The current successful app release generation does not match the trusted readiness identity.");
  }
  const expectedInventory = baselineInventorySettings(baseline);
  const expectedOriginalInventory = baselineInventorySettings(original);
  const currentCap = baselineInventoryCap(baseline);
  const originalCheckout = record(record(original.settings)?.checkout);
  const currentCheckout = record(record(baseline.settings)?.checkout);
  const expectedHealthyVariant = typeof expectedInventory.memory === "number" && Number.isSafeInteger(expectedInventory.memory)
    ? manifestVariant(release.manifest, expectedInventory.memory, "healthy") : undefined;
  if (!currentCheckout || !originalCheckout || !sameInventorySettings(currentCheckout, release.checkout) ||
      !sameInventorySettings(originalCheckout, release.targetCheckout) ||
      !expectedHealthyVariant || expectedInventory.version !== expectedHealthyVariant.version ||
      expectedInventory.role !== expectedHealthyVariant.roleArn || expectedInventory.memory !== release.inventory.memory ||
      expectedInventory.timeout !== release.inventory.timeout || expectedInventory.codeSha256 !== release.inventory.codeSha256 ||
      !sameInventorySettings(expectedOriginalInventory, release.targetInventory)) {
    throw new ActionFailure("The saved current settings or original release target do not match the verified Inventory configuration.");
  }
  if (expectedInventory.cap !== currentCap || release.inventory.cap !== currentCap) {
    throw new ActionFailure("The observed Inventory concurrency cap changed from the controller-confirmed current value.");
  }
  const incident = incidentRecord(run);
  if (run.incident && !incident) {
    throw new ActionFailure("Reconcile the recorded Inventory access change before changing capacity.");
  }
  if (incident?.active === "unknown" || (incident && !incidentMatchesDeployment(incident, release.deploymentIdentity))) {
    throw new ActionFailure("Reconcile the recorded Inventory alias before changing capacity.");
  }
  if (incident?.active === "denied" && (release.inventory.access !== "denied" ||
      release.inventory.version !== incident.target.version)) {
    throw new ActionFailure("The Inventory alias no longer matches the recorded denied version.");
  }
  if ((incident?.active === "healthy" || !incident) && release.inventory.access !== "healthy") {
    throw new ActionFailure("The Inventory live alias is not in its recorded healthy state.");
  }
  return { ...release, baseline };
}

function trafficApiId(target: AppTarget): string {
  let hostname: string;
  try {
    hostname = new URL(target.api).hostname;
  } catch {
    throw new ActionFailure("The trusted app API URL is invalid.");
  }
  const match = hostname.match(/^([a-z0-9]+)\.execute-api\.us-east-1\.amazonaws\.com$/);
  if (!match) throw new ActionFailure("The trusted app API URL does not identify the expected regional HTTP API.");
  return match[1];
}

function trafficContextFromSettings(appRevision: string, productVersion: string,
  checkout: InventoryTargetSettings & { aliasRevision?: string }, inventory: InventoryContextSettings): TrafficContext {
  if (!checkout.version || !inventory.version || !Number.isSafeInteger(checkout.memory) || !Number.isSafeInteger(inventory.memory)) {
    throw new ActionFailure("The current app configuration is incomplete for traffic attribution.");
  }
  return {
    appRevision,
    productVersion,
    inventory: { cap: inventory.cap, aliasVersion: inventory.version, access: inventory.access, memoryMb: inventory.memory },
    checkout: { cap: checkout.cap, aliasVersion: checkout.version, memoryMb: checkout.memory },
  };
}

async function surgeTrafficContext(action: Action, target: AppTarget, bearer: string, run: RunState): Promise<TrafficContext> {
  const baseline = run.baseline;
  const original = run.originalBaseline;
  if (run.resetRequired || !baseline || !original || !baseline.deploymentIdentity || !original.deploymentIdentity ||
      baseline.appRevision !== target.revision || original.appRevision !== target.revision ||
      baseline.sku !== target.sku || original.sku !== target.sku ||
      typeof baseline.productVersion !== "string" || baseline.productVersion.length === 0) {
    throw new ActionFailure("A current verified readiness baseline is required before Inventory surge traffic.");
  }
  if (run.unresolved.length > 0) throw new ActionFailure("Settle unresolved checkout attempts before starting Inventory surge traffic.");
  const incident = incidentRecord(run);
  if ((run.incident && !incident) || (incident && incident.active !== "healthy")) {
    throw new ActionFailure("Resolve the recorded Inventory access state before starting Inventory surge traffic.");
  }
  if (run.configurationActionId) {
    const configuration = await getAction(run.configurationActionId);
    if (!configuration || ["queued", "running", "draining", "incomplete"].includes(configuration.status)) {
      throw new ActionFailure("Wait for the Inventory configuration action to settle before starting surge traffic.");
    }
  }
  const cap = baselineInventoryCap(baseline);
  const fresh = await settings(target, bearer, cap);
  if (fresh.inventory.access !== "healthy" || fresh.inventory.cap === "unreserved" ||
      !Number.isSafeInteger(fresh.inventory.cap) || fresh.inventory.cap <= 0) {
    throw new ActionFailure("Inventory surge requires a healthy alias and a positive, confirmed Inventory cap.");
  }
  const expectedInventory = baselineInventorySettings(baseline);
  const baselineSettings = record(baseline.settings);
  const expectedCheckout = baselineSettings && record(baselineSettings.checkout);
  if (!expectedCheckout || !sameInventorySettings(expectedCheckout, fresh.checkout) ||
      !sameInventorySettings(expectedInventory, fresh.inventory)) {
    throw new ActionFailure("The current Inventory or Checkout settings drifted from the confirmed readiness state.");
  }
  const identity = await deploymentIdentity(target, fresh.inventoryVariantsManifest, fresh.checkout, true);
  if (!sameDeploymentIdentity(baseline.deploymentIdentity, identity) ||
      !sameDeploymentIdentity(original.deploymentIdentity, identity)) {
    throw new ActionFailure("The current app generation does not match the saved readiness release.");
  }
  const currentProduct = await readInventorySeedRow(action, inventoryTable, baseline.sku);
  if (currentProduct.productVersion !== baseline.productVersion) {
    throw new ActionFailure("The current Inventory productVersion differs from the verified readiness baseline.");
  }
  return trafficContextFromSettings(target.revision, baseline.productVersion, fresh.checkout, fresh.inventory);
}

function sameCapacityContext(left: CapacityContext, right: CapacityContext): boolean {
  const samePolicy = (a: InventoryAccessPolicyObservation, b: InventoryAccessPolicyObservation) =>
    a.state === b.state && a.policyArn === b.policyArn && a.policyName === b.policyName && a.roleArn === b.roleArn &&
    a.defaultVersionId === b.defaultVersionId && a.documentMatches === b.documentMatches;
  return sameDeploymentIdentity(left.deploymentIdentity, right.deploymentIdentity) &&
    left.inventoryAlias.functionVersion === right.inventoryAlias.functionVersion &&
    left.inventoryAlias.revisionId === right.inventoryAlias.revisionId &&
    left.inventoryAlias.routingWeighted === right.inventoryAlias.routingWeighted &&
    left.checkout.aliasRevision === right.checkout.aliasRevision &&
    sameInventorySettings({ ...left.checkout }, right.checkout) &&
    sameInventoryContextSettings(left.inventory, right.inventory) &&
    samePolicy(left.policy.observation, right.policy.observation) &&
    left.tablePolicy.observation.state === right.tablePolicy.observation.state &&
    left.tablePolicy.observation.tableArn === right.tablePolicy.observation.tableArn &&
    left.tablePolicy.observation.revision === right.tablePolicy.observation.revision;
}

async function recoverContext(bearer: string): Promise<RecoveryContext> {
  const run = await getRun();
  const baseline = run.baseline;
  const original = run.originalBaseline;
  if (!original?.deploymentIdentity || !baseline?.deploymentIdentity) {
    throw new ActionFailure("Fresh readiness is required because the saved baseline has no verified deployment-generation identity.");
  }
  if (baseline.productVersion !== original.productVersion || baseline.sku !== original.sku) {
    throw new ActionFailure("The active and original readiness baselines do not describe the same preserved product generation.");
  }
  const current = await currentReleaseContext(bearer);
  const target = current.app;
  if (original.appRevision !== target.revision || baseline.appRevision !== target.revision || original.sku !== target.sku) {
    throw new ActionFailure("The saved readiness target is stale for the successfully deployed app release.");
  }
  const identity = current.deploymentIdentity;
  if (!sameDeploymentIdentity(original.deploymentIdentity, identity) ||
      !sameDeploymentIdentity(baseline.deploymentIdentity, identity)) {
    throw new ActionFailure("The current successful app generation does not match the trusted readiness baseline; run readiness to reconcile it.");
  }
  const originalSettings = record(original.settings);
  const originalCheckout = originalSettings && record(originalSettings.checkout);
  const originalInventory = originalSettings && record(originalSettings.inventory);
  const currentSettings = record(baseline.settings);
  if (!originalSettings || !originalCheckout || !originalInventory || !currentSettings ||
      originalSettings.credentialGeneration !== target.outputs.get("PresenterCredentialGeneration") ||
      originalSettings.inventoryRoleArn !== target.inventoryRoleArn || originalSettings.inventoryTableArn !== target.inventoryTableArn ||
      !sameInventorySettings(originalCheckout, current.targetCheckout) ||
      !sameInventorySettings(originalInventory, current.targetInventory) ||
      originalInventory.access !== "healthy" || originalInventory.sourceRevision !== target.revision ||
      originalInventory.memory !== current.manifest.baselineMemoryMb || originalInventory.version !== current.targetVariant.version ||
      currentSettings.credentialGeneration !== target.outputs.get("PresenterCredentialGeneration") ||
      !sameInventorySettings(record(currentSettings.checkout) ?? {}, current.targetCheckout)) {
    throw new ActionFailure("The original readiness baseline does not contain the trusted current-release settings.");
  }
  const baselineHealthyPolicy = originalSettings.inventoryAccessPolicy;
  const baselineDeniedPolicy = originalSettings.inventoryDeniedAccessPolicy;
  if (!record(baselineHealthyPolicy) || !record(baselineDeniedPolicy) ||
      !sameInventoryPolicyVersion(current.healthyPolicy.observation, baselineHealthyPolicy as InventoryAccessPolicyObservation) ||
      !sameInventoryPolicyVersion(current.deniedPolicy.observation, baselineDeniedPolicy as InventoryAccessPolicyObservation)) {
    throw new ActionFailure("The Inventory role policy changed after the trusted readiness baseline.");
  }
  return { ...current, baseline };
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
    deploymentIdentity: context.baseline.deploymentIdentity,
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
    if (current.kind === "reset") {
      current.configurationOutcome = outcome === "conflict" ? "failed" : "unknown";
      run.inventoryAliasUnknown = outcome !== "conflict";
      return true;
    }
    if (current.kind === "recover") {
      current.configurationOutcome = outcome === "conflict" ? "failed" : "unknown";
      run.inventoryAliasUnknown = outcome !== "conflict";
      if (incident) run.incident = { ...incident, aliasOutcome: outcome, updatedAt: new Date().toISOString() };
      return true;
    }
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
    if (current.kind === "reset") {
      if (current.inventorySwitch) current.inventorySwitch = { ...current.inventorySwitch, after: alias };
      if (active === "unknown") current.configurationOutcome = "unknown";
      run.inventoryAliasUnknown = active === "unknown";
      return true;
    }
    if (current.kind === "recover") {
      if (current.inventorySwitch) current.inventorySwitch = { ...current.inventorySwitch, after: alias };
      if (active === "unknown") current.configurationOutcome = "unknown";
      run.inventoryAliasUnknown = active === "unknown";
      if (incident) run.incident = { ...incident, alias, active,
        aliasOutcome: active === "unknown" ? "ambiguous" : "acknowledged", updatedAt: new Date().toISOString() };
      return true;
    }
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

async function setRecoveryProgress(actionId: string, progress: NonNullable<Action["recoveryProgress"]>): Promise<void> {
  const result = await changeAction(actionId, (_run, current) => {
    if (current.kind !== "recover") return false;
    current.recoveryProgress = progress;
    return true;
  });
  if (!result) throw new IncompleteActionFailure("The Recover progress could not be recorded.");
}

async function setResetPhase(actionId: string, phase: NonNullable<Action["reset"]>["phase"]): Promise<void> {
  const result = await changeAction(actionId, (_run, current) => {
    if (current.kind !== "reset" || !current.reset) return false;
    current.reset.phase = phase;
    return true;
  });
  if (!result) throw new IncompleteActionFailure("The Reset progress could not be recorded.");
}

async function stopAndDrainTraffic(action: Action): Promise<void> {
  const initialRun = await getRun();
  const trafficId = initialRun.currentActionId;
  if (trafficId) {
    const traffic = await getAction(trafficId);
    if (traffic?.kind === "traffic" && ["queued", "running", "draining"].includes(traffic.status)) {
      await changeAction(trafficId, (_run, current) => {
        if (current.kind !== "traffic" || !["queued", "running", "draining"].includes(current.status)) return false;
        current.stopRequested = true;
        if (current.status === "queued") {
          current.status = "stopped";
          current.finishedAt = new Date().toISOString();
        } else {
          current.status = "draining";
        }
        return true;
      });
    }
  }
  const activeTraffic = trafficId ? await getAction(trafficId) : undefined;
  if (activeTraffic?.kind !== "traffic" || !["queued", "running", "draining"].includes(activeTraffic.status)) {
    await setRecoveryProgress(action.id, "validating");
    return;
  }
  await setRecoveryProgress(action.id, "draining");
  while (Date.now() + 250 < action.deadlineAt) {
    const current = await getAction(trafficId!);
    if (!current || current.kind !== "traffic") throw new IncompleteActionFailure("The accepted traffic action could not be read while Recover was draining it.");
    if (current.status === "incomplete") throw new IncompleteActionFailure("The traffic action did not settle before its deadline; Recover left configuration and verification unchanged.");
    const inFlight = Boolean(current.traffic &&
      (current.traffic.catalog.inFlight > 0 || current.traffic.checkout.inFlight > 0));
    if (!inFlight && !["queued", "running", "draining"].includes(current.status)) {
      await setRecoveryProgress(action.id, "validating");
      return;
    }
    await delay(Math.min(100, Math.max(1, action.deadlineAt - Date.now() - 250)));
  }
  throw new IncompleteActionFailure("Recover reached its deadline while accepted traffic was still draining.");
}

async function linkRecoveryCheckpoint(actionId: string, checkpointValue: ConfigurationCheckpoint): Promise<void> {
  const result = await changeAction(actionId, (_run, current) => {
    if (current.kind !== "recover") return false;
    current.configurationCheckpoint = checkpointValue;
    return true;
  });
  if (!result) throw new IncompleteActionFailure("The Recover configuration checkpoint could not be linked to the action.");
}

async function recordRecoveryIntent(action: Action, context: RecoveryContext): Promise<void> {
  const result = await changeAction(action.id, (_run, current) => {
    if (current.kind !== "recover") return false;
    current.inventorySwitch = { before: context.inventoryAlias, target: context.targetVariant };
    current.capRestoration = {
      checkout: { before: context.checkout.cap, target: context.targetCheckout.cap, outcome: "pending" },
      inventory: { before: context.inventory.cap, target: context.targetInventory.cap, outcome: "pending" },
    };
    current.configurationOutcome = "unknown";
    return true;
  });
  if (!result) throw new IncompleteActionFailure("The Recover target settings could not be recorded before mutation.");
}

function sameRecoveryContext(left: RecoveryContext, right: RecoveryContext): boolean {
  return sameDeploymentIdentity(left.deploymentIdentity, right.deploymentIdentity) &&
    left.inventoryAlias.functionVersion === right.inventoryAlias.functionVersion &&
    left.inventoryAlias.revisionId === right.inventoryAlias.revisionId &&
    left.checkout.aliasRevision === right.checkout.aliasRevision &&
    sameInventorySettings({ ...left.checkout }, right.checkout) && sameInventoryContextSettings(left.inventory, right.inventory);
}

async function assertRecoveryBoundary(action: Action, before: RecoveryContext, bearer: string): Promise<RecoveryContext> {
  ensureActionDeadline(action, "Recover deployment validation");
  const currentBearer = await loadBearer();
  const initialSecretDigest = createHash("sha256").update(bearer).digest("hex");
  const currentSecretDigest = createHash("sha256").update(currentBearer).digest("hex");
  if (initialSecretDigest !== currentSecretDigest) {
    throw new ActionFailure("The Checkout credential changed after configuration capture; inspect the current app release before Recover can mutate it.");
  }
  const current = await recoverContext(currentBearer);
  if (!sameRecoveryContext(before, current)) {
    throw new ActionFailure("The app generation or observed settings changed after capture; inspect the release before Recover can mutate it.");
  }
  return current;
}

async function recordCapRestoration(actionId: string, name: "checkout" | "inventory", update: CapRestoration): Promise<void> {
  const result = await changeAction(actionId, (_run, current) => {
    if ((current.kind !== "recover" && current.kind !== "reset") || !current.capRestoration?.[name]) return false;
    current.capRestoration[name] = { ...current.capRestoration[name], ...update };
    return true;
  });
  if (!result) throw new IncompleteActionFailure(`The ${name} concurrency restoration result could not be recorded.`);
}

async function readFunctionCap(functionName: string): Promise<number | "unreserved"> {
  const result = await lambda.send(new GetFunctionConcurrencyCommand({ FunctionName: functionName }), providerTimeout());
  const cap = result.ReservedConcurrentExecutions;
  if (cap === undefined) return "unreserved";
  if (!Number.isSafeInteger(cap) || cap < 0) throw new ActionFailure("The observed Lambda concurrency value is invalid.");
  return cap;
}

const capReadbackDelays = [0, 250, 500, 1_000];
const minimumUnreservedConcurrency = 100;

async function requireCapacityHeadroom(before: number, target: number): Promise<void> {
  const settings = await lambda.send(new GetAccountSettingsCommand({}), providerTimeout());
  const quota = settings.AccountLimit?.ConcurrentExecutions;
  const unreserved = settings.AccountLimit?.UnreservedConcurrentExecutions;
  if (!Number.isSafeInteger(quota) || !Number.isSafeInteger(unreserved) ||
      Number(quota) < 1 || Number(unreserved) < 0 || Number(unreserved) > Number(quota)) {
    throw new ActionFailure("Fresh Lambda account concurrency headroom is unavailable or invalid.");
  }
  const needed = target - before + minimumUnreservedConcurrency;
  if (Number(unreserved) < needed) {
    throw new ActionFailure(`Insufficient Lambda account headroom: the increase needs ${needed} unreserved executions including the ${minimumUnreservedConcurrency}-unit floor.`);
  }
}

function definiteCapacityRejection(error: unknown): boolean {
  return error instanceof Error && ["AccessDeniedException", "InvalidParameterValueException", "ResourceNotFoundException"]
    .includes(error.name);
}

async function restoreFunctionCap(action: Action, label: "Checkout" | "Inventory", before: CapValue,
  target: CapValue): Promise<"applied" | "no_change"> {
  const name = label.toLowerCase() as "checkout" | "inventory";
  if (before === "unknown" || target === "unknown") throw new ActionFailure(`${label} concurrency target is unknown.`);
  const functionName = label === "Checkout" ? checkoutFunction : inventoryFunction;
  let observed: number | "unreserved";
  try {
    observed = await readFunctionCap(functionName);
  } catch {
    await recordCapRestoration(action.id, name, { before, target, outcome: "unknown" });
    throw new IncompleteActionFailure(`${label} concurrency could not be read before restoration.`);
  }
  if (observed === target) {
    await recordCapRestoration(action.id, name, { before, target, readback: observed, outcome: "no_change", observedAt: new Date().toISOString() });
    return "no_change";
  }
  if (observed !== before) {
    await recordCapRestoration(action.id, name, { before, target, readback: observed, outcome: "unknown", observedAt: new Date().toISOString() });
    throw new IncompleteActionFailure(`${label} concurrency changed after its checkpoint; Recover did not overwrite the conflicting value.`);
  }
  if (typeof target === "number" && (!Number.isSafeInteger(target) || target < 1)) {
    await recordCapRestoration(action.id, name, { before, target, readback: observed, outcome: "failed", observedAt: new Date().toISOString() });
    throw new ActionFailure(`${label} original positive concurrency target is invalid.`);
  }
  ensureActionDeadline(action, `${label} concurrency restoration`);
  let mutationError: unknown;
  try {
    if (target === "unreserved") {
      await lambda.send(new DeleteFunctionConcurrencyCommand({ FunctionName: functionName }), providerTimeout());
    } else {
      await lambda.send(new PutFunctionConcurrencyCommand({ FunctionName: functionName, ReservedConcurrentExecutions: target }), providerTimeout());
    }
  } catch (error) {
    mutationError = error;
  }
  let readback: number | "unreserved" | undefined;
  for (const wait of capReadbackDelays) {
    if (wait > 0) {
      if (Date.now() + wait + requestTimeout >= action.deadlineAt) break;
      await delay(wait);
    }
    if (Date.now() + requestTimeout >= action.deadlineAt) break;
    try {
      readback = await readFunctionCap(functionName);
    } catch {
      continue;
    }
    if (readback === target) break;
  }
  const observedAt = new Date().toISOString();
  if (readback === target) {
    await recordCapRestoration(action.id, name, { before, target, readback, outcome: "applied", observedAt });
    return "applied";
  }
  const definiteFailure = mutationError instanceof Error &&
    ["AccessDeniedException", "InvalidParameterValueException", "ResourceNotFoundException"].includes(mutationError.name);
  const outcome = definiteFailure && readback === before ? "failed" : "unknown";
  await recordCapRestoration(action.id, name, { before, target, readback: readback ?? "unknown", outcome, observedAt });
  const errorMessage = `${label} concurrency restoration could not be confirmed by readback.`;
  if (outcome === "failed") throw new ActionFailure(errorMessage);
  throw new IncompleteActionFailure(errorMessage);
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

async function recordCapacityIntent(action: Action, before: number, target: number): Promise<void> {
  const result = await changeAction(action.id, (_run, current) => {
    if (current.kind !== "increase_capacity") return false;
    current.capacityChange = { function: "inventory", before, target };
    current.configurationOutcome = "unknown";
    return true;
  });
  if (!result) throw new IncompleteActionFailure("The Inventory capacity intent could not be recorded before mutation.");
}

async function linkCapacityCheckpoint(actionId: string, value: ConfigurationCheckpoint): Promise<void> {
  const result = await changeAction(actionId, (_run, current) => {
    if (current.kind !== "increase_capacity") return false;
    current.configurationCheckpoint = value;
    return true;
  });
  if (!result) throw new IncompleteActionFailure("The Inventory capacity checkpoint could not be linked to its action.");
}

async function recordCapacityObservation(actionId: string, acknowledgement: NonNullable<Action["capacityChange"]>["acknowledgement"],
  readback: CapValue, observedAt: string, outcome: "failed" | "unknown"): Promise<void> {
  const result = await changeAction(actionId, (_run, current) => {
    if (current.kind !== "increase_capacity" || !current.capacityChange) return false;
    current.capacityChange = { ...current.capacityChange, acknowledgement, readback, observedAt };
    current.configurationOutcome = outcome;
    return true;
  });
  if (!result) throw new IncompleteActionFailure("The Inventory capacity acknowledgement and readback could not be recorded.");
}

async function completeCapacityChange(action: Action, context: CapacityContext, before: number, target: number,
  acknowledgement: NonNullable<Action["capacityChange"]>["acknowledgement"], readback: number,
  observedAt: string, outcome: "applied" | "no_change"): Promise<void> {
  const finishedAt = new Date().toISOString();
  const result = await changeAction(action.id, (run, current) => {
    const baseline = run.baseline;
    if (current.kind !== "increase_capacity" || !current.capacityChange || !baseline || !run.originalBaseline ||
        baseline.appRevision !== context.appRevision ||
        !sameDeploymentIdentity(baseline.deploymentIdentity, context.deploymentIdentity) ||
        !sameDeploymentIdentity(run.originalBaseline.deploymentIdentity, context.deploymentIdentity) ||
        baselineInventoryCap(baseline) !== before ||
        current.capacityChange.before !== before || current.capacityChange.target !== target ||
        readback !== target) return false;

    if (outcome === "applied") {
      const settings = record(baseline.settings);
      const inventory = settings && record(settings.inventory);
      if (!settings || !inventory) return false;
      const updatedBaseline: Baseline = { ...baseline, settings: {
        ...settings,
        inventory: { ...inventory, cap: target, observedAt },
      } };
      run.baseline = updatedBaseline;
      current.baseline = updatedBaseline;
    }
    current.capacityChange = { ...current.capacityChange, acknowledgement, readback, observedAt };
    current.configurationOutcome = outcome;
    current.status = "completed";
    current.finishedAt = finishedAt;
    return true;
  });
  if (!result) throw new IncompleteActionFailure("The confirmed Inventory capacity result could not be saved with the readiness baseline.");
}

async function increaseInventoryCapacity(action: Action): Promise<void> {
  if (action.command.kind !== "increase_capacity" || action.command.function !== "inventory") {
    throw new ActionFailure("The Inventory capacity command is invalid.");
  }
  const bearer = await loadBearer();
  const context = await capacityContext(action, bearer);
  const before = context.inventory.cap;
  if (typeof before !== "number" || !Number.isSafeInteger(before) || before < 1) {
    throw new ActionFailure("Inventory capacity can only increase from an existing positive reserved cap.");
  }
  const target = action.command.reservedConcurrency;
  await recordCapacityIntent(action, before, target);
  if (target < before) throw new ActionFailure("Inventory capacity can only increase to a value at least as large as its current cap.");
  if (target === before) {
    await completeCapacityChange(action, context, before, target, undefined, before, context.inventory.observedAt, "no_change");
    return;
  }

  ensureActionDeadline(action, "Inventory account headroom read");
  await requireCapacityHeadroom(before, target);
  ensureActionDeadline(action, "Inventory capacity checkpoint");
  let saved: ConfigurationCheckpoint;
  try {
    saved = await checkpoint(action, context, context.policy.observation, context.policy);
  } catch (error) {
    if (error instanceof IncompleteActionFailure && error.checkpoint) {
      await linkCapacityCheckpoint(action.id, error.checkpoint);
    }
    throw error;
  }
  await linkCapacityCheckpoint(action.id, saved);

  const currentBearer = await loadBearer();
  const initialCredential = createHash("sha256").update(bearer).digest("hex");
  const currentCredential = createHash("sha256").update(currentBearer).digest("hex");
  if (initialCredential !== currentCredential) {
    throw new ActionFailure("The Checkout credential changed after configuration capture; inspect the current app release before changing capacity.");
  }
  const current = await capacityContext(action, currentBearer);
  if (!sameCapacityContext(context, current) || current.inventory.cap !== before) {
    throw new ActionFailure("The app generation or Inventory settings changed after capture; inspect the current release before changing capacity.");
  }
  ensureActionDeadline(action, "Inventory account headroom recheck");
  await requireCapacityHeadroom(before, target);

  ensureActionDeadline(action, "Inventory capacity increase");
  let acknowledgement: "acknowledged" | "ambiguous" | "rejected";
  let mutationError: unknown;
  try {
    await lambda.send(new PutFunctionConcurrencyCommand({
      FunctionName: inventoryFunction,
      ReservedConcurrentExecutions: target,
    }), providerTimeout());
    acknowledgement = "acknowledged";
  } catch (error) {
    mutationError = error;
    acknowledgement = definiteCapacityRejection(error) ? "rejected" : "ambiguous";
  }

  let readback: number | "unreserved" | undefined;
  for (const wait of capReadbackDelays) {
    if (wait > 0) {
      if (Date.now() + wait + requestTimeout >= action.deadlineAt) break;
      await delay(wait);
    }
    if (Date.now() + requestTimeout >= action.deadlineAt) break;
    try {
      readback = await readFunctionCap(inventoryFunction);
    } catch {
      continue;
    }
    if (readback === target || (acknowledgement === "rejected" && readback === before)) break;
  }
  const observedAt = new Date().toISOString();
  if (readback === target && acknowledgement !== "rejected") {
    await completeCapacityChange(action, context, before, target, acknowledgement, target, observedAt, "applied");
    return;
  }
  if (acknowledgement === "rejected" && readback === before) {
    await recordCapacityObservation(action.id, acknowledgement, readback, observedAt, "failed");
    throw new ActionFailure("The Inventory capacity write was rejected and readback confirms the prior cap.");
  }
  await recordCapacityObservation(action.id, acknowledgement, readback ?? "unknown", observedAt, "unknown");
  const detail = mutationError instanceof Error ? ` ${mutationError.name}.` : "";
  throw new IncompleteActionFailure(`The Inventory capacity change could not be reconciled through readback.${detail}`);
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
  const selectedSettings = await readInventoryVariantSettings(context.app, context.manifest, target, false, context.inventory.cap);
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
  const deniedInventory = await readInventoryVariantSettings(context.app, context.manifest, targetVariant, false, context.inventory.cap);
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
    throw new IncompleteActionFailure("The Inventory denial was selected, but the action could not admit its verification checkout before it stopped or reached its deadline.");
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
  const restoredInventory = await readInventoryVariantSettings(context.app, context.manifest, healthy, false, context.inventory.cap);
  if (restoredInventory.memory !== context.inventory.memory || restoredInventory.timeout !== context.inventory.timeout ||
      restoredInventory.cap !== context.inventory.cap || restoredInventory.codeSha256 !== context.inventory.codeSha256 ||
      restoredInventory.sourceRevision !== context.manifest.sourceRevision) {
    throw new IncompleteActionFailure("The restored healthy Inventory variant did not match the confirmed current settings.");
  }
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

async function appRequest(target: AppTarget, bearer: string, request: RequestRecord, timeout = requestTimeout,
  beforeFetch?: () => boolean): Promise<AppResponse> {
  const path = request.kind === "catalog" ? "/api/products" : request.kind === "checkout" ? "/api/checkout" : `/api/orders/${request.checkoutId}`;
  const started = performance.now();
  try {
    if (beforeFetch && !beforeFetch()) return { durationMs: 0, sent: false };
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
  if (request.kind !== "order_status") {
    if (action.status !== "running" || action.stopRequested) return false;
    if (request.kind === "checkout") {
      if (!request.checkout) return false;
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

async function send(actionId: string, target: AppTarget, bearer: string, request: RequestRecord, payload?: CheckoutPayload,
  timeout?: number, beforeFetch?: () => boolean) {
  const response = await appRequest(target, bearer, request, timeout, beforeFetch);
  if (response.sent === false) return { response, observed: undefined, saved: undefined, outcome: undefined, sent: false };
  const observed = request.kind === "catalog" ? product(response, target.sku) : undefined;
  const saved = payload && (request.kind === "checkout" ? response.status === 201 || response.status === 200 : response.status === 200)
    ? receipt(response, payload) : undefined;
  const outcome = request.kind === "checkout" ? checkoutOutcome(response, saved)
    : observed || saved ? "success" : request.kind === "order_status" ? "unknown" : "failed";
  await settle(actionId, request, response, outcome, observed, saved);
  return { response, observed, saved, outcome, sent: true };
}

async function checkStatus(actionId: string, target: AppTarget, bearer: string, payload: CheckoutPayload): Promise<StatusCheck> {
  const request = newRequest("order_status", undefined, payload.checkoutId);
  if (!await changeAction(actionId, (run, action) => reserve(run, action, request))) return { submitted: false };
  return { submitted: true, receipt: (await send(actionId, target, bearer, request, payload)).saved };
}

async function readiness(action: Action): Promise<void> {
  const target = await appTarget();
  const bearer = await loadBearer();
  const manifest = await readManifest(target);
  validateInventoryReleaseManifest(target, manifest);
  const checkout = await functionSettings(target, "Checkout", checkoutFunction, undefined, undefined, false,
    requiredCheckoutEnvironment(target, bearer));
  const identity = await deploymentIdentity(target, manifest, checkout, true);
  const beforeRun = await getRun();
  const sameGeneration = sameDeploymentIdentity(beforeRun.originalBaseline?.deploymentIdentity, identity);
  if (sameGeneration && !sameDeploymentIdentity(beforeRun.baseline?.deploymentIdentity, identity)) {
    throw new ActionFailure("The active readiness baseline does not match its original deployment identity.");
  }
  const currentCap = sameGeneration && beforeRun.baseline
    ? baselineInventoryCap(beforeRun.baseline) : expectedCap(target, "Inventory");
  const expected = await settings(target, bearer, currentCap);
  const verifiedIdentity = await deploymentIdentity(target, expected.inventoryVariantsManifest, expected.checkout, true);
  if (!sameDeploymentIdentity(identity, verifiedIdentity)) {
    throw new ActionFailure("The successful app generation changed while Readiness was validating its settings.");
  }
  const verifiedManifest = expected.inventoryVariantsManifest;
  if (beforeRun.unresolved.length > 0) {
    throw new ActionFailure("Settle all previously submitted checkout attempts before readiness sends a new verification checkout.");
  }
  if (!sameGeneration && expected.inventory.memory !== verifiedManifest.baselineMemoryMb) {
    throw new ActionFailure(`Readiness cannot adopt this app generation from ${expected.inventory.memory} MB; its trusted original baseline is ${verifiedManifest.baselineMemoryMb} MB.`);
  }
  const currentIncident = incidentRecord(beforeRun);
  if (currentIncident && currentIncident.active !== "healthy" &&
      incidentMatchesDeployment(currentIncident, identity)) {
    throw new ActionFailure("Restore the current generation's recorded Inventory denial before establishing readiness.");
  }
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
  const statusCheck = await checkStatus(action.id, target, bearer, payload);
  if (!statusCheck.submitted) throw new IncompleteActionFailure("Readiness could not submit its order-status request before the action stopped or reached its deadline.");
  const confirmed = statusCheck.receipt;
  if (!confirmed) throw new ActionFailure("The readiness order could not be confirmed through order status.");
  const after = (await probe(newRequest("catalog"))).observed;
  if (!after || after.productVersion !== before.productVersion || after.availableQuantity !== before.availableQuantity - 1) {
    throw new ActionFailure("The readiness order did not show a same-version one-unit stock decrease.");
  }
  const baseline: Baseline = { appRevision: target.revision, deploymentIdentity: identity, sku: target.sku, checkoutId: payload.checkoutId,
    productVersion: payload.productVersion, stockBefore: before.availableQuantity, stockAfter: after.availableQuantity,
    verifiedAt: new Date().toISOString(), receipt: confirmed, settings: expected };
  await changeAction(action.id, (run, current) => {
    run.baseline = baseline;
    if (!sameDeploymentIdentity(run.originalBaseline?.deploymentIdentity, identity)) {
      run.originalBaseline = structuredClone(baseline);
    }
    if (run.incident && !incidentMatchesDeployment(run.incident, identity)) {
      run.incidentHistory ??= [];
      if (!run.incidentHistory.some((item) => item.activationActionId === run.incident?.activationActionId)) {
        run.incidentHistory.push(structuredClone(run.incident));
      }
      delete run.incident;
    }
    run.inventoryAliasUnknown = false;
    current.baseline = baseline;
    current.status = "completed";
    current.finishedAt = baseline.verifiedAt;
    return true;
  });
}

function recoveryWithoutEvidence(action: Action): boolean {
  return action.command.kind === "recover" && action.command.recoverWithoutEvidence === true;
}

async function recordRecoveredConfiguration(action: Action, context: RecoveryContext, alias: InventoryAliasObservation,
  changed: boolean): Promise<void> {
  const finishedAt = new Date().toISOString();
  const result = await changeAction(action.id, (run, current) => {
    if (current.kind !== "recover" || current.configurationOutcome === "failed") return false;
    const incident = incidentRecord(run);
    if (incident && incidentMatchesDeployment(incident, context.deploymentIdentity)) {
      run.incident = { ...incident, alias, active: "healthy", aliasOutcome: "acknowledged",
        restoreActionId: action.id, updatedAt: finishedAt };
    } else if (run.incident) {
      run.incidentHistory ??= [];
      if (!run.incidentHistory.some((item) => item.activationActionId === run.incident?.activationActionId)) {
        run.incidentHistory.push(structuredClone(run.incident));
      }
      delete run.incident;
    }
    run.inventoryAliasUnknown = false;
    current.inventorySwitch = { before: context.inventoryAlias, target: context.targetVariant, after: alias };
    current.configurationOutcome = changed ? "applied" : "no_change";
    current.recoveryProgress = "verifying";
    return true;
  });
  if (!result) throw new IncompleteActionFailure("The restored application settings could not be recorded.");
}

async function recoverySettings(context: CurrentReleaseContext, alias: InventoryAliasObservation): Promise<VerifiedSettings> {
  const inventory = { ...context.targetInventory, aliasRevision: alias.revisionId, access: "healthy" as const,
    sourceRevision: context.manifest.sourceRevision, cap: context.targetInventory.cap };
  return {
    account,
    region,
    api: context.app.api,
    credentialGeneration: context.app.outputs.get("PresenterCredentialGeneration"),
    checkout: context.targetCheckout,
    inventory,
    inventoryPolicy: "absent",
    inventoryAccessPolicy: context.healthyPolicy.observation,
    inventoryDeniedAccessPolicy: context.deniedPolicy.observation,
    inventoryPolicyName: context.healthyPolicy.observation.policyName,
    inventoryPolicyArn: context.healthyPolicy.observation.policyArn,
    inventoryPolicyDefaultVersionId: context.healthyPolicy.observation.defaultVersionId,
    inventoryTableArn: context.app.inventoryTableArn,
    inventoryRoleArn: context.app.inventoryRoleArn,
    inventoryDeniedRoleArn: context.app.outputs.get("InventoryDeniedRoleArn"),
    inventoryVariantsManifest: context.manifest,
  };
}

function sameCurrentReleaseContext(left: CurrentReleaseContext, right: CurrentReleaseContext): boolean {
  return sameDeploymentIdentity(left.deploymentIdentity, right.deploymentIdentity) &&
    left.app.stackId === right.app.stackId && left.app.successfulAt === right.app.successfulAt &&
    left.inventoryAlias.functionVersion === right.inventoryAlias.functionVersion &&
    left.inventoryAlias.revisionId === right.inventoryAlias.revisionId &&
    sameInventorySettings({ ...left.checkout }, right.checkout) &&
    sameInventoryContextSettings(left.inventory, right.inventory) &&
    sameInventoryPolicyVersion(left.healthyPolicy.observation, right.healthyPolicy.observation) &&
    sameInventoryPolicyVersion(left.deniedPolicy.observation, right.deniedPolicy.observation);
}

async function recordResetIntent(action: Action, context: CurrentReleaseContext): Promise<void> {
  const result = await changeAction(action.id, (_run, current) => {
    if (current.kind !== "reset" || !current.reset) return false;
    current.inventorySwitch = { before: context.inventoryAlias, target: context.targetVariant };
    current.capRestoration = {
      checkout: { before: context.checkout.cap, target: context.targetCheckout.cap, outcome: "pending" },
      inventory: { before: context.inventory.cap, target: context.targetInventory.cap, outcome: "pending" },
    };
    current.configurationOutcome = "unknown";
    return true;
  });
  if (!result) throw new IncompleteActionFailure("The Reset restoration targets could not be recorded before configuration changes.");
}

async function linkResetCheckpoint(actionId: string, value: ConfigurationCheckpoint): Promise<void> {
  const result = await changeAction(actionId, (_run, current) => {
    if (current.kind !== "reset") return false;
    current.configurationCheckpoint = value;
    return true;
  });
  if (!result) throw new IncompleteActionFailure("The Reset configuration checkpoint could not be linked to its action.");
}

async function finishRecoveryVerification(action: Action, context: RecoveryContext, bearer: string,
  alias: InventoryAliasObservation): Promise<void> {
  await setRecoveryProgress(action.id, "verifying");
  for (;;) {
    const run = await getRun();
    const unresolved = run.unresolved[0];
    if (!unresolved) break;
    const statusCheck = await checkStatus(action.id, context.app, bearer, unresolved);
    if (!statusCheck.submitted) {
      await setRecoveryProgress(action.id, "verification_incomplete");
      throw new IncompleteActionFailure("Recover restored configuration, but could not submit an order-status request for an earlier checkout before the action stopped or reached its deadline; the checkout remains unresolved.");
    }
    const afterStatus = await getRun();
    if (!statusCheck.receipt && afterStatus.unresolved.some((item) => item.checkoutId === unresolved.checkoutId)) {
      await setRecoveryProgress(action.id, "verification_unknown");
      throw new IncompleteActionFailure("Recover restored configuration, but an earlier checkout remains unknown after its status check; no new checkout was sent.");
    }
  }
  const ready = await getRun();
  if (ready.unresolved.length > 0) {
    await setRecoveryProgress(action.id, "verification_unknown");
    throw new IncompleteActionFailure("Recover restored configuration, but earlier checkout outcomes remain unresolved.");
  }
  const catalogRequest = async () => {
    const request = newRequest("catalog");
    if (!await changeAction(action.id, (run, current) => reserve(run, current, request))) {
      throw new IncompleteActionFailure("Recover restored configuration, but could not submit the next catalog verification read before the action stopped or reached its deadline.");
    }
    return send(action.id, context.app, bearer, request);
  };
  const before = (await catalogRequest()).observed;
  if (!before || before.availableQuantity < 1) {
    await setRecoveryProgress(action.id, "verification_incomplete");
    throw new IncompleteActionFailure("Recover restored configuration, but a fresh catalog read did not establish available stock.");
  }
  const currentRun = await getRun();
  const expectedProductVersion = currentRun.baseline?.productVersion;
  if (!expectedProductVersion || expectedProductVersion !== context.baseline.productVersion || before.productVersion !== expectedProductVersion) {
    await setRecoveryProgress(action.id, "verification_incomplete");
    throw new IncompleteActionFailure("Recover restored configuration, but the catalog productVersion does not match the preserved readiness baseline.");
  }
  const payload = checkoutPayload(context.baseline.sku, expectedProductVersion);
  const checkoutRequest = newRequest("checkout", payload);
  if (!await changeAction(action.id, (run, current) => reserve(run, current, checkoutRequest))) {
    await setRecoveryProgress(action.id, "verification_incomplete");
    throw new IncompleteActionFailure("Recover restored configuration, but the action stopped or reached its deadline before the fresh verification checkout could be submitted.");
  }
  const posted = await send(action.id, context.app, bearer, checkoutRequest, payload);
  if (posted.outcome === "rejected" || posted.outcome === "failed") {
    await setRecoveryProgress(action.id, "verification_incomplete");
    throw new IncompleteActionFailure("Recover restored configuration, but the fresh verification checkout was not accepted.");
  }
  const statusCheck = await checkStatus(action.id, context.app, bearer, payload);
  if (!statusCheck.submitted) {
    await setRecoveryProgress(action.id, "verification_incomplete");
    throw new IncompleteActionFailure("Recover restored configuration, but the action stopped or reached its deadline before the fresh checkout could be checked through order status.");
  }
  const confirmed = statusCheck.receipt;
  if (!confirmed) {
    await setRecoveryProgress(action.id, "verification_unknown");
    throw new IncompleteActionFailure("Recover restored configuration, but the fresh checkout receipt could not be confirmed by order status.");
  }
  if (confirmed.checkoutId !== payload.checkoutId || confirmed.sku !== payload.sku || confirmed.quantity !== 1) {
    await setRecoveryProgress(action.id, "verification_incomplete");
    throw new IncompleteActionFailure("Recover restored configuration, but the saved verification receipt does not match its immutable quantity-one checkout.");
  }
  const after = (await catalogRequest()).observed;
  if (!after || after.productVersion !== before.productVersion || after.availableQuantity !== before.availableQuantity - 1) {
    await setRecoveryProgress(action.id, "verification_incomplete");
    throw new IncompleteActionFailure("Recover restored configuration, but the fresh order did not produce an exact same-productVersion one-unit stock decrement.");
  }
  const verifiedAt = new Date().toISOString();
  const newBaseline: Baseline = { appRevision: context.appRevision, deploymentIdentity: context.deploymentIdentity,
    sku: payload.sku, checkoutId: payload.checkoutId, productVersion: payload.productVersion,
    stockBefore: before.availableQuantity, stockAfter: after.availableQuantity, verifiedAt, receipt: confirmed,
    settings: await recoverySettings(context, alias) };
  const completed = await changeAction(action.id, (run, current) => {
    if (current.kind !== "recover" || run.unresolved.length > 0) return false;
    run.baseline = newBaseline;
    run.latestStock = after.availableQuantity;
    run.latestStockAt = after.observedAt;
    run.inventoryAliasUnknown = false;
    current.baseline = newBaseline;
    current.recoveryProgress = "verified";
    current.status = "completed";
    current.finishedAt = verifiedAt;
    return true;
  });
  if (!completed) throw new IncompleteActionFailure("The verified Recover baseline could not be committed to the run.");
}

async function recover(action: Action): Promise<void> {
  if (action.command.kind !== "recover") throw new ActionFailure("The Recover command is invalid.");
  await stopAndDrainTraffic(action);
  const bearer = await loadBearer();
  const context = await recoverContext(bearer);
  await setRecoveryProgress(action.id, "capturing");
  let capture: ConfigurationCheckpoint;
  try {
    capture = await checkpoint(action, context, context.policy.observation, context.policy, undefined, context.inventoryAlias);
    await linkRecoveryCheckpoint(action.id, capture);
  } catch (error) {
    const unavailable = error instanceof IncompleteActionFailure && error.checkpoint;
    if (unavailable) await linkRecoveryCheckpoint(action.id, unavailable);
    if (!recoveryWithoutEvidence(action)) throw error;
    if (!unavailable) throw new IncompleteActionFailure("The configuration capture failed before Recover could establish a safe restoration target.");
  }
  const current = await assertRecoveryBoundary(action, context, bearer);
  await recordRecoveryIntent(action, current);
  await setRecoveryProgress(action.id, "restoring");
  const alias = await updateInventoryAlias(action, current.app, current.inventoryAlias, current.targetVariant, "healthy");
  if (alias.functionVersion !== current.targetVariant.version || alias.routingWeighted) {
    throw new IncompleteActionFailure("The Inventory alias readback did not confirm the trusted healthy baseline version.");
  }
  const selected = await readInventoryVariantSettings(current.app, current.manifest, current.targetVariant, true);
  if (!sameInventoryVariantConfiguration(current.targetInventory, selected)) {
    throw new IncompleteActionFailure("The restored Inventory baseline version did not match its qualified release configuration.");
  }
  const capResults: Array<"applied" | "no_change"> = [];
  capResults.push(await restoreFunctionCap(action, "Checkout", current.checkout.cap, current.targetCheckout.cap));
  capResults.push(await restoreFunctionCap(action, "Inventory", current.inventory.cap, current.targetInventory.cap));
  const changed = alias.functionVersion !== current.inventoryAlias.functionVersion || capResults.includes("applied");
  await recordRecoveredConfiguration(action, current, alias, changed);
  await finishRecoveryVerification(action, current, bearer, alias);
}

function itemString(item: Record<string, AttributeValue> | undefined, key: string): string | undefined {
  const value = item?.[key];
  return value && "S" in value && typeof value.S === "string" ? value.S : undefined;
}

function itemNumber(item: Record<string, AttributeValue> | undefined, key: string): number | undefined {
  const attribute = item?.[key];
  const raw = attribute && "N" in attribute && typeof attribute.N === "string" ? attribute.N : undefined;
  if (typeof raw !== "string") return undefined;
  const numeric = Number(raw);
  return Number.isSafeInteger(numeric) ? numeric : undefined;
}

interface InventorySeedRow {
  sku: string;
  productVersion: string;
  availableQuantity: number;
  item: Record<string, AttributeValue>;
}

async function readInventorySeedRow(action: Action, tableName: string, sku: string): Promise<InventorySeedRow> {
  ensureActionDeadline(action, "Inventory read");
  const result = await dynamo.send(new GetItemCommand({
    TableName: tableName,
    Key: { sku: { S: sku } },
    ConsistentRead: true,
  }), providerTimeout());
  const item = result.Item;
  const observed = {
    sku: itemString(item, "sku"),
    productVersion: itemString(item, "productVersion"),
    availableQuantity: itemNumber(item, "availableQuantity"),
  };
  if (!item || observed.sku !== sku || !observed.productVersion || observed.availableQuantity === undefined || observed.availableQuantity < 0) {
    throw new ActionFailure("The selected Inventory SKU has no valid, strongly read product version and quantity.");
  }
  return { sku, productVersion: observed.productVersion, availableQuantity: observed.availableQuantity, item };
}

function matchesSeed(row: Record<string, AttributeValue> | undefined, productVersion: string): boolean {
  return itemString(row, "sku") === seedProduct.sku &&
    itemString(row, "name") === seedProduct.name &&
    itemNumber(row, "unitPriceCents") === seedProduct.unitPriceCents &&
    itemString(row, "currency") === seedProduct.currency &&
    itemNumber(row, "availableQuantity") === seedProduct.availableQuantity &&
    itemString(row, "productVersion") === productVersion;
}

async function seedInventory(action: Action, context: CurrentReleaseContext): Promise<void> {
  const metadata = action.reset;
  if (action.kind !== "reset" || !metadata || metadata.seedQuantity !== seedProduct.availableQuantity ||
      context.app.sku !== seedProduct.sku || context.target.tableArn !== `arn:aws:dynamodb:${region}:${account}:table/${inventoryTable}`) {
    throw new ActionFailure("The current release does not match the canonical Reset product target.");
  }
  const before = await readInventorySeedRow(action, inventoryTable, seedProduct.sku);
  if (before.productVersion === metadata.productVersion) {
    throw new ActionFailure("The Reset productVersion is not fresh for the strongly read Inventory row.");
  }
  ensureActionDeadline(action, "Inventory seed");
  const updatedAt = new Date().toISOString();
  let writeError: unknown;
  try {
    await dynamo.send(new PutItemCommand({
      TableName: inventoryTable,
      Item: {
        sku: { S: seedProduct.sku },
        name: { S: seedProduct.name },
        unitPriceCents: { N: String(seedProduct.unitPriceCents) },
        currency: { S: seedProduct.currency },
        availableQuantity: { N: String(metadata.seedQuantity) },
        productVersion: { S: metadata.productVersion },
        updatedAt: { S: updatedAt },
      },
      ConditionExpression: "#productVersion = :previousVersion",
      ExpressionAttributeNames: { "#productVersion": "productVersion" },
      ExpressionAttributeValues: { ":previousVersion": { S: before.productVersion } },
    }), providerTimeout());
  } catch (error) {
    writeError = error;
  }

  let after: InventorySeedRow | undefined;
  try {
    after = await readInventorySeedRow(action, inventoryTable, seedProduct.sku);
  } catch (error) {
    throw new IncompleteActionFailure("Reset could not strongly read the Inventory seed after its conditional write.");
  }
  if (!matchesSeed(after.item, metadata.productVersion) || after.productVersion !== metadata.productVersion ||
      after.availableQuantity !== seedProduct.availableQuantity) {
    const detail = writeError instanceof Error && writeError.name === "ConditionalCheckFailedException"
      ? "The Inventory product changed during Reset."
      : "The conditional Inventory seed did not produce the requested product version and quantity.";
    throw new IncompleteActionFailure(detail);
  }
}

async function deleteAllOrders(action: Action, tableName: string): Promise<void> {
  let startKey: ScanCommandInput["ExclusiveStartKey"];
  do {
    ensureActionDeadline(action, "Orders scan");
    let page: ScanCommandOutput;
    try {
      page = await dynamo.send(new ScanCommand({
        TableName: tableName,
        ConsistentRead: true,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }), providerTimeout());
    } catch {
      throw new IncompleteActionFailure("Reset could not scan the Orders table before its deadline.");
    }
    for (const item of page.Items ?? []) {
      const orderId = itemString(item, "orderId");
      if (!orderId) throw new IncompleteActionFailure("Reset found an Orders row without its expected primary key.");
      ensureActionDeadline(action, "Orders deletion");
      try {
        await dynamo.send(new DeleteItemCommand({ TableName: tableName, Key: { orderId: { S: orderId } } }), providerTimeout());
      } catch {
        throw new IncompleteActionFailure("Reset could not delete every old Orders row.");
      }
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  startKey = undefined;
  do {
    ensureActionDeadline(action, "Orders verification scan");
    let page: ScanCommandOutput;
    try {
      page = await dynamo.send(new ScanCommand({
        TableName: tableName,
        ConsistentRead: true,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }), providerTimeout());
    } catch {
      throw new IncompleteActionFailure("Reset could not verify the Orders deletion before its deadline.");
    }
    if ((page.Items ?? []).length > 0) throw new IncompleteActionFailure("Reset could not verify that all prior Orders were deleted.");
    startKey = page.LastEvaluatedKey;
  } while (startKey);
}

async function stopAndDrainResetTraffic(action: Action): Promise<void> {
  const trafficId = action.reset?.trafficActionId;
  if (!trafficId) return;
  const traffic = await getAction(trafficId);
  if (!traffic || traffic.kind !== "traffic") {
    throw new IncompleteActionFailure("Reset could not read the traffic action it must drain.");
  }
  if (["queued", "running", "draining"].includes(traffic.status)) {
    const stopped = await changeAction(trafficId, (_run, current) => {
      if (current.kind !== "traffic" || !["queued", "running", "draining"].includes(current.status)) return false;
      current.stopRequested = true;
      if (current.status === "queued") {
        current.status = "stopped";
        current.finishedAt = new Date().toISOString();
      } else {
        current.status = "draining";
      }
      return true;
    });
    if (!stopped) throw new IncompleteActionFailure("Reset could not request the accepted traffic to stop.");
    await setResetPhase(action.id, "draining");
  }
  while (Date.now() + 250 < action.deadlineAt) {
    const current = await getAction(trafficId);
    if (!current || current.kind !== "traffic") {
      throw new IncompleteActionFailure("Reset could not read the accepted traffic while it was draining.");
    }
    if (current.status === "incomplete") {
      throw new IncompleteActionFailure("The accepted traffic action did not settle before its drain window ended.");
    }
    const inFlight = Boolean(current.traffic &&
      (current.traffic.catalog.inFlight > 0 || current.traffic.checkout.inFlight > 0));
    if (!inFlight && !["queued", "running", "draining"].includes(current.status)) return;
    await delay(Math.min(100, Math.max(1, action.deadlineAt - Date.now() - 250)));
  }
  throw new IncompleteActionFailure("Reset reached its deadline while accepted traffic was still draining.");
}

function savedCheckoutTimeout(baseline: Baseline | null | undefined): number | undefined {
  const settings = baseline && record(baseline.settings);
  const checkout = settings && record(settings.checkout);
  const timeout = checkout?.timeout;
  return typeof timeout === "number" && Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 900
    ? timeout : undefined;
}

async function waitForCheckoutExecutionWindow(action: Action, context: CurrentReleaseContext): Promise<void> {
  const run = await getRun();
  const timeoutSeconds = Math.max(context.checkout.timeout,
    savedCheckoutTimeout(run.baseline) ?? 0,
    savedCheckoutTimeout(run.originalBaseline) ?? 0);
  const actionIds = new Set([
    run.currentActionId,
    run.configurationActionId,
    action.reset?.previousCurrentActionId,
    action.reset?.previousConfigurationActionId,
    action.reset?.trafficActionId,
  ].filter((id): id is string => typeof id === "string"));
  const sourceActions = (await Promise.all([...actionIds].map(getAction))).filter((value): value is Action => Boolean(value));
  const attempts = [...run.unresolved.map(({ checkoutId, startedAt }) => ({ checkoutId, startedAt }))];
  for (const source of sourceActions) {
    for (const request of source.requests) {
      if (request.kind === "checkout" && request.checkout &&
          (request.outcome === "unknown" || !request.completedAt)) {
        attempts.push({ checkoutId: request.checkout.checkoutId, startedAt: request.startedAt });
      }
    }
  }
  const latestFence = attempts.reduce((latest, attempt) => {
    const startedAt = Date.parse(attempt.startedAt);
    if (!Number.isFinite(startedAt)) return Number.NaN;
    const requestFence = startedAt + timeoutSeconds * 1_000 + 30_000;
    const sourceFence = Math.max(0, ...sourceActions
      .filter((source) => source.requests.some((request) => request.kind === "checkout" &&
        request.checkout?.checkoutId === attempt.checkoutId))
      .map((source) => source.discardAfter));
    return Math.max(latest, requestFence, sourceFence);
  }, 0);
  if (!Number.isFinite(latestFence)) {
    throw new IncompleteActionFailure("Reset cannot establish when a prior Checkout execution left its server-side execution window.");
  }
  if (latestFence <= Date.now()) return;
  if (latestFence + requestTimeout >= action.deadlineAt) {
    throw new IncompleteActionFailure("Reset cannot cover the prior Checkout execution and drain window before its deadline; wait, discard this attempt, then start Reset again.");
  }
  await delay(latestFence - Date.now());
  ensureActionDeadline(action, "prior Checkout execution drain");
}

async function reset(action: Action): Promise<void> {
  if (action.kind !== "reset" || action.command.kind !== "reset" || !action.reset) {
    throw new ActionFailure("The Reset command is invalid.");
  }
  const metadata = action.reset;
  await stopAndDrainResetTraffic(action);
  await setResetPhase(action.id, "validating");
  const bearer = await loadBearer();
  const run = await getRun();
  if (run.runId !== metadata.previousRunId) throw new ActionFailure("The Reset session changed before validation could begin.");
  let context = await currentReleaseContext(bearer);
  if (context.app.sku !== seedProduct.sku || context.app.outputs.get("OrdersTableName") !== "IncidentTriageDemoOrders") {
    throw new ActionFailure("The current app release does not identify the approved demo product and Orders table.");
  }
  await waitForCheckoutExecutionWindow(action, context);
  const oldUnknowns = (await getRun()).unresolved;
  for (const unresolved of oldUnknowns) {
    ensureActionDeadline(action, "prior checkout reconciliation");
    const checked = await checkStatus(action.id, context.app, bearer, unresolved);
    if (!checked.submitted) throw new IncompleteActionFailure("Reset could not check the status of a prior checkout before its deadline.");
  }

  await setResetPhase(action.id, "capturing");
  try {
    const saved = await checkpoint(action, context, context.policy.observation, context.policy);
    await linkResetCheckpoint(action.id, saved);
  } catch (error) {
    if (error instanceof IncompleteActionFailure && error.checkpoint) await linkResetCheckpoint(action.id, error.checkpoint);
    throw error;
  }

  const freshBearer = await loadBearer();
  if (createHash("sha256").update(bearer).digest("hex") !== createHash("sha256").update(freshBearer).digest("hex")) {
    throw new ActionFailure("The Checkout credential changed after Reset captured the current release.");
  }
  const current = await currentReleaseContext(freshBearer);
  if (!sameCurrentReleaseContext(context, current)) {
    throw new ActionFailure("The app generation or observed settings changed after Reset capture; inspect the release before proceeding.");
  }
  context = current;
  const begun = await beginReset(action.id);
  if (!begun) throw new IncompleteActionFailure("Reset could not archive the quiescent prior session and persist its safety marker.");

  await setResetPhase(action.id, "restoring");
  await recordResetIntent(action, context);
  const healthyAlias = await updateInventoryAlias(action, context.app, context.inventoryAlias,
    context.targetVariant, "healthy");
  if (healthyAlias.functionVersion !== context.targetVariant.version || healthyAlias.routingWeighted) {
    throw new IncompleteActionFailure("Reset could not confirm the current release's healthy baseline Inventory alias.");
  }
  const capResults: Array<"applied" | "no_change"> = [];
  capResults.push(await restoreFunctionCap(action, "Checkout", context.checkout.cap, context.targetCheckout.cap));
  capResults.push(await restoreFunctionCap(action, "Inventory", context.inventory.cap, context.targetInventory.cap));
  const restored = await currentReleaseContext(freshBearer);
  if (!sameDeploymentIdentity(context.deploymentIdentity, restored.deploymentIdentity) ||
      restored.inventoryAlias.functionVersion !== context.targetVariant.version || restored.inventoryAlias.routingWeighted ||
      !sameInventorySettings({ ...context.targetCheckout }, restored.checkout) ||
      !sameInventoryVariantConfiguration(context.targetInventory, restored.inventory) ||
      restored.checkout.cap !== context.targetCheckout.cap || restored.inventory.cap !== context.targetInventory.cap) {
    throw new IncompleteActionFailure("Reset could not independently read back the current release's healthy baseline settings.");
  }
  const changed = healthyAlias.functionVersion !== context.inventoryAlias.functionVersion || capResults.includes("applied");
  await changeAction(action.id, (_run, currentAction) => {
    if (currentAction.kind !== "reset") return false;
    currentAction.configurationOutcome = changed ? "applied" : "no_change";
    return true;
  });

  await setResetPhase(action.id, "seeding");
  ensureActionDeadline(action, "Inventory seed");
  await seedInventory(action, context);
  await setResetPhase(action.id, "deleting");
  await deleteAllOrders(action, context.app.outputs.get("OrdersTableName") ?? "");

  await setResetPhase(action.id, "verifying");
  const catalog = async (): Promise<Product> => {
    const request = newRequest("catalog");
    if (!await changeAction(action.id, (currentRun, currentAction) => reserve(currentRun, currentAction, request))) {
      throw new IncompleteActionFailure("Reset reached its deadline before the next catalog verification request.");
    }
    const result = await send(action.id, context.app, freshBearer, request);
    if (!result.observed) throw new IncompleteActionFailure("Reset could not read the fresh product through the app API.");
    return result.observed;
  };
  const before = await catalog();
  if (before.productVersion !== metadata.productVersion || before.availableQuantity !== metadata.seedQuantity) {
    throw new IncompleteActionFailure("The fresh catalog did not show the Reset productVersion and seed quantity.");
  }
  const payload = checkoutPayload(context.app.sku, metadata.productVersion);
  const checkoutRequest = newRequest("checkout", payload);
  if (!await changeAction(action.id, (currentRun, currentAction) => reserve(currentRun, currentAction, checkoutRequest))) {
    throw new IncompleteActionFailure("Reset reached its deadline before the fresh verification checkout.");
  }
  const submitted = await send(action.id, context.app, freshBearer, checkoutRequest, payload);
  if (submitted.outcome === "rejected" || submitted.outcome === "failed") {
    throw new IncompleteActionFailure("Reset's fresh verification checkout was not accepted.");
  }
  const checked = await checkStatus(action.id, context.app, freshBearer, payload);
  if (!checked.submitted) throw new IncompleteActionFailure("Reset reached its deadline before checking the fresh order status.");
  const confirmed = checked.receipt;
  if (!confirmed || confirmed.checkoutId !== payload.checkoutId || confirmed.sku !== payload.sku || confirmed.quantity !== 1) {
    throw new IncompleteActionFailure("Reset could not confirm the fresh quantity-one checkout through order status.");
  }
  const after = await catalog();
  if (after.productVersion !== before.productVersion || after.availableQuantity !== before.availableQuantity - 1) {
    throw new IncompleteActionFailure("The fresh verification order did not produce an exact same-version one-unit stock decrement.");
  }
  const verifiedAt = new Date().toISOString();
  const baseline: Baseline = {
    appRevision: context.appRevision,
    deploymentIdentity: context.deploymentIdentity,
    sku: payload.sku,
    checkoutId: payload.checkoutId,
    productVersion: payload.productVersion,
    stockBefore: before.availableQuantity,
    stockAfter: after.availableQuantity,
    verifiedAt,
    receipt: confirmed,
    settings: await recoverySettings(restored, healthyAlias),
  };
  const completed = await changeAction(action.id, (currentRun, currentAction) => {
    if (currentAction.kind !== "reset" || !currentAction.reset || currentRun.runId !== currentAction.reset.runId ||
        !currentRun.resetRequired || currentRun.unresolved.length > 0) return false;
    currentRun.baseline = baseline;
    currentRun.originalBaseline = structuredClone(baseline);
    currentRun.latestStock = after.availableQuantity;
    currentRun.latestStockAt = after.observedAt;
    currentRun.inventoryAliasUnknown = false;
    currentRun.resetRequired = false;
    currentAction.baseline = baseline;
    currentAction.reset.phase = "verified";
    currentAction.status = "completed";
    currentAction.finishedAt = verifiedAt;
    return true;
  });
  if (!completed) throw new IncompleteActionFailure("The verified Reset baseline could not be committed to the current session.");
}

interface SurgeCatalogState {
  counters: Counters;
  peakInFlight: number;
  outcomes: CatalogOutcomes;
  skips: CatalogSkips;
  bins: CatalogBin[];
  firstSamples: RequestRecord[];
  lastSamples: RequestRecord[];
  failedSamples: RequestRecord[];
}

function emptyCatalogOutcomes(): CatalogOutcomes {
  return { success: 0, http4xx: 0, http5xx: 0, invalidResponse: 0, noResponse: 0 };
}

function emptyCatalogSkips(): CatalogSkips {
  return { late: 0, full: 0, checkpoint: 0 };
}

function newSurgeCatalogState(): SurgeCatalogState {
  return {
    counters: { submitted: 0, completed: 0, succeeded: 0, skipped: 0, inFlight: 0 },
    peakInFlight: 0,
    outcomes: emptyCatalogOutcomes(),
    skips: emptyCatalogSkips(),
    bins: Array.from({ length: 15 }, (_, index) => ({
      offsetMs: index * 1_000, durationMs: 1_000, observedDurationMs: 0,
      submitted: 0, completed: 0, succeeded: 0, skipped: 0, outcomes: emptyCatalogOutcomes(),
    })),
    firstSamples: [],
    lastSamples: [],
    failedSamples: [],
  };
}

function boundedText(value: unknown, maximum = 256): string | undefined {
  return typeof value === "string" ? value.slice(0, maximum) : undefined;
}

function catalogResultKind(response: AppResponse, observed?: Product): CatalogOutcome {
  if (observed) return "success";
  if (response.status === undefined) return "noResponse";
  if (response.status >= 400 && response.status < 500) return "http4xx";
  if (response.status >= 500 && response.status < 600) return "http5xx";
  return "invalidResponse";
}

function requestOutcome(kind: CatalogOutcome): RequestRecord["outcome"] {
  if (kind === "success") return "success";
  if (kind === "http4xx") return "rejected";
  if (kind === "noResponse") return "unknown";
  return "failed";
}

function catalogBinIndex(offsetMs: number): number {
  return Math.max(0, Math.min(14, Math.floor(Math.max(0, offsetMs) / 1_000)));
}

function recordCatalogSkip(state: SurgeCatalogState, ordinal: number, reason: CatalogSkip,
  intervalMs: number): void {
  state.counters.skipped++;
  state.skips[reason]++;
  const scheduledOffset = ordinal * intervalMs;
  state.bins[catalogBinIndex(scheduledOffset)].skipped++;
}

function catalogSamples(state: SurgeCatalogState): RequestRecord[] {
  const selected = new Map<string, RequestRecord>();
  for (const sample of [...state.firstSamples, ...state.lastSamples, ...state.failedSamples]) {
    selected.set(sample.id, sample);
  }
  return [...selected.values()];
}

function observationSnapshot(state: SurgeCatalogState, startMono: number, observedMono: number,
  producerStoppedMono: number | undefined, status: CatalogObservation["status"]): CatalogObservation {
  const activeThrough = producerStoppedMono ?? Math.min(observedMono, startMono + 15_000);
  const bins = state.bins.map((bin) => {
    const offsetStart = startMono + bin.offsetMs;
    const observedDurationMs = Math.max(0, Math.min(1_000, activeThrough - offsetStart));
    return { ...bin, observedDurationMs: Math.floor(observedDurationMs), outcomes: { ...bin.outcomes } };
  });
  const samples = catalogSamples(state).map((sample) => ({
    ...sample,
    id: sample.id.slice(0, 36),
    startedAt: sample.startedAt.slice(0, 256),
    ...(sample.completedAt ? { completedAt: sample.completedAt.slice(0, 256) } : {}),
    ...(sample.requestId ? { requestId: sample.requestId.slice(0, 256) } : {}),
    ...(sample.errorCode ? { errorCode: sample.errorCode.slice(0, 256) } : {}),
    ...(sample.dependencyReason ? { dependencyReason: sample.dependencyReason.slice(0, 256) } : {}),
  }));
  return {
    observedThrough: new Date().toISOString(), status, peakInFlight: state.peakInFlight,
    outcomes: { ...state.outcomes }, skips: { ...state.skips }, bins, samples,
    sampleRule: "first8_last8_first8_failed", samplesTruncated: state.counters.completed > samples.length,
  };
}

function recordCatalogStart(state: SurgeCatalogState, startMono: number, startedMono: number): void {
  state.counters.submitted++;
  state.counters.inFlight++;
  state.peakInFlight = Math.max(state.peakInFlight, state.counters.inFlight);
  state.bins[catalogBinIndex(startedMono - startMono)].submitted++;
}

function recordCatalogCompletion(state: SurgeCatalogState, startMono: number, startedAt: string,
  requestId: string, startedMono: number, response: AppResponse, observed?: Product): void {
  const kind = catalogResultKind(response, observed);
  const completedAt = new Date().toISOString();
  const bin = state.bins[catalogBinIndex(startedMono - startMono)];
  state.counters.completed++;
  state.counters.inFlight = Math.max(0, state.counters.inFlight - 1);
  state.outcomes[kind]++;
  bin.completed++;
  bin.outcomes[kind]++;
  if (kind === "success") {
    state.counters.succeeded++;
    bin.succeeded++;
  }
  const sample: RequestRecord = {
    id: requestId.slice(0, 36), kind: "catalog", startedAt, completedAt,
    durationMs: Math.max(0, Math.floor(response.durationMs)), statusCode: response.status,
    requestId: boundedText(response.requestId, 256),
    errorCode: boundedText(response.body?.code, 256), outcome: requestOutcome(kind),
  };
  if (state.firstSamples.length < 8) state.firstSamples.push(sample);
  state.lastSamples.push(sample);
  if (state.lastSamples.length > 8) state.lastSamples.shift();
  if (kind !== "success" && state.failedSamples.length < 8) state.failedSamples.push(sample);
}

function profileIsExact(profile: TrafficProfileSnapshot | undefined): profile is TrafficProfileSnapshot {
  if (!profile || profile.name !== "inventory_surge" || profile.durationMs !== 15_000 ||
      profile.checkout.intervalMs !== 1_000 || profile.checkout.maxAttempts !== 15 ||
      profile.checkout.requestTimeoutMs !== 7_000) return false;
  if (profile.version === 1) {
    return profile.checkout.maxInFlight === 2 && profile.catalog.ratePerSecond === 240 && profile.catalog.maxAttempts === 3_600 &&
      profile.catalog.maxInFlight === 128 && profile.catalog.requestTimeoutMs === 7_000;
  }
  return profile.version === 2 && profile.checkout.maxInFlight === 1 && profile.catalog.ratePerSecond === 60 && profile.catalog.batchSize === 30 &&
    profile.catalog.batchIntervalMs === 500 && profile.catalog.maxAttempts === 900 &&
    profile.catalog.maxInFlight === 30 && profile.catalog.requestTimeoutMs === 7_000;
}

async function persistTrafficContext(actionId: string, context: TrafficContext, apiId: string): Promise<boolean> {
  const result = await changeAction(actionId, (_run, current) => {
    if (current.kind !== "traffic" || current.status !== "running" || current.stopRequested) return false;
    current.trafficContext = context;
    current.trafficApiId = apiId;
    return true;
  });
  return Boolean(result);
}

async function persistCatalogObservation(actionId: string, state: SurgeCatalogState, startMono: number,
  producerStoppedMono: number | undefined, status: CatalogObservation["status"], window: TrafficWindow): Promise<void> {
  const result = await changeAction(actionId, (_run, current) => {
    if (current.kind !== "traffic" || !current.trafficProfile || !current.traffic ||
        !["running", "draining"].includes(current.status)) return false;
    const observedMono = performance.now();
    const catalogCounters = { ...state.counters };
    const observation = observationSnapshot(state, startMono, observedMono, producerStoppedMono, status);
    current.traffic.catalog = catalogCounters;
    current.catalogObservation = observation;
    current.trafficWindow ??= window;
    return true;
  });
  if (!result) throw new IncompleteActionFailure("A catalog observation could not be merged into the active traffic action.");
}

async function setSurgeLifecycle(actionId: string, window: TrafficWindow, values: Partial<TrafficWindow>,
  final?: { state: SurgeCatalogState; startMono: number; producerStoppedMono: number; observationStatus: CatalogObservation["status"];
    actionStatus: Action["status"]; error?: string }): Promise<void> {
  const result = await changeAction(actionId, (_run, current) => {
    if (current.kind !== "traffic" || !current.traffic ||
        !["running", "draining"].includes(current.status)) return false;
    current.trafficWindow = { ...(current.trafficWindow ?? window), ...values };
    if (final) {
      current.traffic.catalog = { ...final.state.counters };
      current.catalogObservation = observationSnapshot(final.state, final.startMono, performance.now(),
        final.producerStoppedMono, final.observationStatus);
      current.status = final.actionStatus;
      current.finishedAt = current.trafficWindow.settledAt ?? new Date().toISOString();
      current.error = final.error;
    }
    return true;
  });
  if (!result) throw new IncompleteActionFailure("The surge producer lifecycle could not be merged into the traffic action.");
}

async function finishIncompleteSurge(actionId: string, window: TrafficWindow, values: Partial<TrafficWindow>, error: string): Promise<void> {
  const result = await changeAction(actionId, (_run, current) => {
    if (current.kind !== "traffic" || !current.traffic ||
        !["running", "draining"].includes(current.status)) return false;
    current.trafficWindow = { ...(current.trafficWindow ?? window), ...values };
    current.status = "incomplete";
    current.finishedAt = current.trafficWindow.settledAt ?? new Date().toISOString();
    current.error = error;
    return true;
  });
  if (!result) throw new IncompleteActionFailure("The incomplete surge lifecycle could not be saved.");
}

async function skipCheckoutTick(actionId: string): Promise<void> {
  await changeAction(actionId, (_run, current) => {
    if (current.kind !== "traffic" || current.status !== "running" || current.stopRequested || !current.traffic) return false;
    current.traffic.checkout.skipped++;
    return true;
  });
}

async function reserveSurgeCheckout(actionId: string, request: RequestRecord, profile: TrafficProfileSnapshot): Promise<boolean> {
  const result = await changeAction(actionId, (run, current) => {
    if (current.kind !== "traffic" || current.status !== "running" || current.stopRequested || !current.traffic) return false;
    const progress = current.traffic.checkout;
    if (progress.inFlight >= profile.checkout.maxInFlight || progress.submitted >= profile.checkout.maxAttempts ||
        !reserve(run, current, request)) {
      progress.skipped++;
      return true;
    }
    return true;
  });
  return Boolean(result?.action.requests.some(({ id }) => id === request.id));
}

async function markSurgeCheckoutNotSent(actionId: string, request: RequestRecord, reason: string,
  window: TrafficWindow, stopObservedAt?: string): Promise<void> {
  const result = await changeAction(actionId, (run, current) => {
    if (current.kind !== "traffic" || !current.traffic) return false;
    const persisted = current.requests.find(({ id }) => id === request.id);
    if (!persisted || persisted.completedAt) return false;
    const now = new Date().toISOString();
    Object.assign(persisted, { completedAt: now, durationMs: 0, outcome: "not_sent" as const, errorCode: reason });
    current.traffic.checkout.submitted = Math.max(0, current.traffic.checkout.submitted - 1);
    current.traffic.checkout.inFlight = Math.max(0, current.traffic.checkout.inFlight - 1);
    current.traffic.checkout.skipped++;
    run.unresolved = run.unresolved.filter(({ checkoutId }) => checkoutId !== request.checkout?.checkoutId);
    current.trafficWindow ??= window;
    if (stopObservedAt && !current.trafficWindow.stopObservedAt) current.trafficWindow.stopObservedAt = stopObservedAt;
    return true;
  });
  if (!result) throw new IncompleteActionFailure("A durably reserved Checkout that was not sent could not be reconciled.");
}

async function ordinaryTraffic(action: Action, target: AppTarget, bearer: string, baseline: Baseline): Promise<void> {
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

async function surgeTraffic(action: Action, target: AppTarget, bearer: string, baseline: Baseline,
  profile: TrafficProfileSnapshot): Promise<void> {
  if (!profileIsExact(profile)) throw new ActionFailure("The saved Inventory surge profile is not the approved immutable version.");
  const deadlineNeed = profile.durationMs + profile.checkout.requestTimeoutMs + 1_000;
  if (Date.now() + deadlineNeed >= action.deadlineAt) {
    throw new ActionFailure("There is not enough action time remaining for the complete surge and bounded drain.");
  }
  const startWallMs = Date.now();
  const startMono = performance.now();
  const endMono = startMono + profile.durationMs;
  const v2AdmissionLatenessMs = 150;
  const window: TrafficWindow = {
    startedAt: new Date(startWallMs).toISOString(),
    scheduledEndAt: new Date(startWallMs + profile.durationMs).toISOString(),
  };
  const state = newSurgeCatalogState();
  const pending = new Set<Promise<void>>();
  const unknown: CheckoutPayload[] = [];
  let localStop = false;
  let admissionClosedMono: number | undefined;
  let admissionClosedAt: string | undefined;
  let closeReason: TrafficWindow["stopReason"] | undefined;
  let requestedStop = false;
  let stopObservedAt: string | undefined;
  let observationFailure = false;
  let observationWriteFailure = false;
  let deadlineReached = false;
  let producerStoppedMono: number | undefined;
  let monitorClosed = false;
  const checkpointPhaseMono = startMono + 1_250;
  let nextCheckpointMono = checkpointPhaseMono;
  let lastCheckpointInterval: { start: number; end: number } | undefined;
  let checkpointPending: Promise<void> | undefined;

  function closeAdmissions(reason: TrafficWindow["stopReason"], observedAt?: string): void {
    if (localStop) return;
    localStop = true;
    const nowMono = performance.now();
    if (nowMono >= endMono) {
      admissionClosedMono = endMono;
      admissionClosedAt = window.scheduledEndAt;
      closeReason = "duration";
    } else {
      admissionClosedMono = nowMono;
      admissionClosedAt = observedAt ?? new Date().toISOString();
      closeReason = reason;
    }
  }

  function observeStop(): void {
    requestedStop = true;
    stopObservedAt ??= new Date().toISOString();
    closeAdmissions("requested", stopObservedAt);
  }

  const stopMonitor = (async () => {
    while (!monitorClosed) {
      await delay(100);
      if (monitorClosed) return;
      let observed: Action | undefined;
      try {
        observed = await getAction(action.id);
        if (!observed || observed.kind !== "traffic") throw new Error("traffic action unreadable");
      } catch {
        observationFailure = true;
        closeAdmissions("observation_failure");
        return;
      }
      if (observed.stopRequested || observed.status === "draining") {
        observeStop();
        await changeAction(action.id, (_run, current) => {
          if (current.kind !== "traffic" || !current.traffic) return false;
          current.trafficWindow ??= window;
          if (current.trafficWindow.stopObservedAt) return false;
          current.trafficWindow.stopObservedAt = stopObservedAt;
          return true;
        }).catch(() => { observationFailure = true; closeAdmissions("observation_failure"); });
        return;
      }
      if (!["running", "queued"].includes(observed.status)) return;
    }
  })();

  async function waitFor(targetMono: number, maximumSliceMs: number): Promise<void> {
    while (!localStop) {
      const remaining = targetMono - performance.now();
      if (remaining <= 0) return;
      await delay(Math.max(1, Math.min(maximumSliceMs, remaining)));
    }
  }

  function skipCatalogWave(wave: number, batchSize: number, reason: CatalogSkip, catalogIntervalMs: number): void {
    const firstOrdinal = wave * batchSize;
    for (let offset = 0; offset < batchSize; offset++) {
      recordCatalogSkip(state, firstOrdinal + offset, reason, catalogIntervalMs);
    }
  }

  async function saveCheckpoint(): Promise<void> {
    const checkpointStart = performance.now();
    try {
      await persistCatalogObservation(action.id, state, startMono, producerStoppedMono, "partial", window);
    } catch {
      observationFailure = true;
      observationWriteFailure = true;
      closeAdmissions("observation_failure");
    } finally {
      const checkpointEnd = performance.now();
      lastCheckpointInterval = { start: checkpointStart, end: checkpointEnd };
      const nextAlignedSecond = checkpointPhaseMono + (Math.floor((checkpointEnd - checkpointPhaseMono) / 1_000) + 1) * 1_000;
      nextCheckpointMono = nextAlignedSecond;
    }
  }

  function startCheckpointIfDue(): void {
    if (checkpointPending || localStop || performance.now() < nextCheckpointMono) return;
    checkpointPending = saveCheckpoint().finally(() => { checkpointPending = undefined; });
  }

  function startCatalogRequest(requestOrdinal: number, catalogIntervalMs: number): void {
    const request: RequestRecord = { id: randomUUID(), kind: "catalog", startedAt: new Date().toISOString() };
    let requestStartMono = performance.now();
    let requestStartedAt = request.startedAt;
    const task = (async () => {
      const response = await appRequest(target, bearer, request, profile.catalog.requestTimeoutMs, () => {
        if (localStop || performance.now() >= endMono) return false;
        if (Date.now() + profile.catalog.requestTimeoutMs + 1_000 >= action.deadlineAt) {
          deadlineReached = true;
          closeAdmissions("deadline");
          return false;
        }
        requestStartMono = performance.now();
        requestStartedAt = new Date().toISOString();
        request.startedAt = requestStartedAt;
        recordCatalogStart(state, startMono, requestStartMono);
        return true;
      });
      if (response.sent === false) {
        recordCatalogSkip(state, requestOrdinal, "late", catalogIntervalMs);
        return;
      }
      const observed = product(response, target.sku);
      recordCatalogCompletion(state, startMono, requestStartedAt, request.id, requestStartMono, response, observed);
    })().catch(() => {
      observationFailure = true;
      closeAdmissions("observation_failure");
      if (state.counters.inFlight > 0) state.counters.inFlight--;
    }).finally(() => pending.delete(task));
    pending.add(task);
  }

  async function prepareWaveCheckout(due: number): Promise<RequestRecord | undefined> {
    if (localStop) return undefined;
    if (performance.now() > due + v2AdmissionLatenessMs) {
      await skipCheckoutTick(action.id).catch(() => { observationFailure = true; closeAdmissions("observation_failure"); });
      return undefined;
    }
    if (Date.now() + profile.checkout.requestTimeoutMs + 1_000 >= action.deadlineAt) {
      deadlineReached = true;
      closeAdmissions("deadline");
      return undefined;
    }
    const request = newRequest("checkout", checkoutPayload(baseline.sku, baseline.productVersion));
    const reserved = await reserveSurgeCheckout(action.id, request, profile).catch(() => {
      observationFailure = true;
      closeAdmissions("observation_failure");
      return false;
    });
    if (!reserved) {
      const current = await getAction(action.id).catch(() => undefined);
      if (!current) {
        observationFailure = true;
        closeAdmissions("observation_failure");
      } else if (current.stopRequested || current.status === "draining") {
        observeStop();
      } else if (current.status !== "running") {
        observationFailure = true;
        closeAdmissions("observation_failure");
      }
      return undefined;
    }

    let admitted = !localStop && performance.now() < endMono;
    if (admitted) {
      try {
        const current = await getAction(action.id);
        if (!current || current.kind !== "traffic") {
          observationFailure = true;
          closeAdmissions("observation_failure");
          admitted = false;
        } else if (current.stopRequested || current.status === "draining") {
          observeStop();
          admitted = false;
        } else if (current.status !== "running" || performance.now() >= endMono || localStop) {
          if (current.status !== "running") {
            observationFailure = true;
            closeAdmissions("observation_failure");
          }
          admitted = false;
        } else if (performance.now() > due + v2AdmissionLatenessMs) {
          admitted = false;
        }
      } catch {
        observationFailure = true;
        closeAdmissions("observation_failure");
        admitted = false;
      }
    }
    if (!admitted) {
      const reason = localStop ? "ADMISSION_CLOSED"
        : performance.now() > due + v2AdmissionLatenessMs && performance.now() < endMono
          ? "CHECKOUT_TICK_MISSED" : "PRODUCTION_WINDOW_CLOSED";
      await markSurgeCheckoutNotSent(action.id, request, reason, window, stopObservedAt)
        .catch(() => { observationFailure = true; closeAdmissions("observation_failure"); });
      return undefined;
    }
    return request;
  }

  function startWaveCheckout(request: RequestRecord, due: number): boolean {
    const payload = request.checkout;
    if (!payload) return false;
    let fetchStarted = false;
    const task = (async () => {
      const result = await send(action.id, target, bearer, request, payload, profile.checkout.requestTimeoutMs, () => {
        if (localStop || performance.now() >= endMono) return false;
        if (performance.now() > due + v2AdmissionLatenessMs) return false;
        if (Date.now() + profile.checkout.requestTimeoutMs + 1_000 >= action.deadlineAt) {
          deadlineReached = true;
          closeAdmissions("deadline");
          return false;
        }
        fetchStarted = true;
        return true;
      });
      if (!result.sent) {
        const reason = localStop ? "ADMISSION_CLOSED"
          : performance.now() > due + v2AdmissionLatenessMs && performance.now() < endMono
            ? "CHECKOUT_TICK_MISSED" : "PRODUCTION_WINDOW_CLOSED";
        await markSurgeCheckoutNotSent(action.id, request, reason, window, stopObservedAt);
      } else if (result.outcome === "unknown") unknown.push(payload);
    })().catch(() => {
      observationFailure = true;
      closeAdmissions("observation_failure");
    }).finally(() => pending.delete(task));
    pending.add(task);
    return fetchStarted;
  }

  async function runCatalogProducer(): Promise<void> {
    const catalogIntervalMs = 1_000 / profile.catalog.ratePerSecond;
    let ordinal = 0;
    while (ordinal < profile.catalog.maxAttempts && !localStop) {
      const now = performance.now();
      if (now >= nextCheckpointMono) {
        await saveCheckpoint();
        continue;
      }
      const due = startMono + ordinal * catalogIntervalMs;
      if (now < due) {
        await waitFor(Math.min(due, nextCheckpointMono), Math.max(1, Math.min(50, due - now)));
        continue;
      }
      if (localStop) break;
      const current = performance.now();
      if (current >= nextCheckpointMono) continue;
      if (current >= endMono) {
        while (ordinal < profile.catalog.maxAttempts && !localStop) {
          const scheduled = startMono + ordinal * catalogIntervalMs;
          const reason: CatalogSkip = lastCheckpointInterval && scheduled >= lastCheckpointInterval.start &&
            scheduled < lastCheckpointInterval.end ? "checkpoint" : "late";
          recordCatalogSkip(state, ordinal, reason, catalogIntervalMs);
          ordinal++;
        }
        break;
      }
      const missedUntil = current - catalogIntervalMs * 1.25;
      while (ordinal < profile.catalog.maxAttempts &&
        startMono + ordinal * catalogIntervalMs < missedUntil && !localStop) {
        const scheduled = startMono + ordinal * catalogIntervalMs;
        const reason: CatalogSkip = lastCheckpointInterval && scheduled >= lastCheckpointInterval.start &&
          scheduled < lastCheckpointInterval.end ? "checkpoint" : "late";
        recordCatalogSkip(state, ordinal, reason, catalogIntervalMs);
        ordinal++;
      }
      if (ordinal >= profile.catalog.maxAttempts || localStop) break;
      if (Date.now() + profile.catalog.requestTimeoutMs + 1_000 >= action.deadlineAt) {
        deadlineReached = true;
        closeAdmissions("deadline");
        break;
      }
      if (state.counters.inFlight >= profile.catalog.maxInFlight) {
        recordCatalogSkip(state, ordinal, "full", catalogIntervalMs);
        ordinal++;
        continue;
      }
      const requestOrdinal = ordinal;
      startCatalogRequest(requestOrdinal, catalogIntervalMs);
      ordinal++;
    }
    if (!localStop && performance.now() < endMono) await waitFor(endMono, 50);
  }

  async function runCatalogWaves(waveProfile: TrafficProfileV2): Promise<void> {
    const batchSize = waveProfile.catalog.batchSize;
    const batchIntervalMs = waveProfile.catalog.batchIntervalMs;
    const catalogIntervalMs = batchIntervalMs / batchSize;
    const waveCount = waveProfile.catalog.maxAttempts / batchSize;
    const lateAllowanceMs = v2AdmissionLatenessMs;
    let wave = 0;
    while (wave < waveCount && !localStop) {
      const now = performance.now();
      startCheckpointIfDue();
      const due = startMono + wave * batchIntervalMs;
      if (now < due) {
        const nextWake = checkpointPending ? due : Math.min(due, nextCheckpointMono);
        await waitFor(nextWake, Math.max(1, Math.min(50, nextWake - now)));
        continue;
      }
      if (localStop) break;
      const current = performance.now();
      if (current >= endMono) {
        const firstRemainingTick = Math.ceil(wave / 2);
        while (wave < waveCount && !localStop) {
          const scheduled = startMono + wave * batchIntervalMs;
          const reason: CatalogSkip = lastCheckpointInterval && scheduled >= lastCheckpointInterval.start &&
            scheduled < lastCheckpointInterval.end ? "checkpoint" : "late";
          skipCatalogWave(wave, batchSize, reason, catalogIntervalMs);
          wave++;
        }
        for (let tick = firstRemainingTick; tick < waveProfile.checkout.maxAttempts && !localStop; tick++) {
          if (startMono + tick * waveProfile.checkout.intervalMs < endMono) {
            await skipCheckoutTick(action.id).catch(() => { observationFailure = true; closeAdmissions("observation_failure"); });
          }
        }
        break;
      }

      const checkoutRequest = wave % 2 === 0 ? await prepareWaveCheckout(due) : undefined;
      if (localStop) {
        if (checkoutRequest) {
          await markSurgeCheckoutNotSent(action.id, checkoutRequest, "ADMISSION_CLOSED", window, stopObservedAt)
            .catch(() => { observationFailure = true; closeAdmissions("observation_failure"); });
        }
        break;
      }

      const dispatchAt = performance.now();
      const checkpointCovered = Boolean(checkpointPending || (lastCheckpointInterval && due >= lastCheckpointInterval.start &&
        due < lastCheckpointInterval.end));
      const late = dispatchAt - due > lateAllowanceMs;
      const full = state.counters.inFlight + batchSize > waveProfile.catalog.maxInFlight;
      const canDispatchCatalog = !checkpointCovered && !late && !full &&
        Date.now() + waveProfile.catalog.requestTimeoutMs + 1_000 < action.deadlineAt;
      if (Date.now() + waveProfile.catalog.requestTimeoutMs + 1_000 >= action.deadlineAt) {
        deadlineReached = true;
        closeAdmissions("deadline");
      }

      if (canDispatchCatalog) {
        if (wave % 2 === 0 && checkoutRequest) {
          for (let offset = 0; offset < 20; offset++) {
            startCatalogRequest(wave * batchSize + offset, catalogIntervalMs);
          }
          const checkoutStarted = startWaveCheckout(checkoutRequest, due);
          if (checkoutStarted) {
            for (let offset = 20; offset < batchSize; offset++) {
              startCatalogRequest(wave * batchSize + offset, catalogIntervalMs);
            }
          } else if (!localStop) {
            for (let offset = 20; offset < batchSize; offset++) {
              recordCatalogSkip(state, wave * batchSize + offset, "late", catalogIntervalMs);
            }
          }
        } else {
          for (let offset = 0; offset < batchSize; offset++) {
            startCatalogRequest(wave * batchSize + offset, catalogIntervalMs);
          }
          if (wave % 2 === 0 && checkoutRequest) startWaveCheckout(checkoutRequest, due);
        }
      } else {
        if (!localStop) {
          const reason: CatalogSkip = checkpointCovered ? "checkpoint" : full ? "full" : "late";
          skipCatalogWave(wave, batchSize, reason, catalogIntervalMs);
        }
        if (checkoutRequest) startWaveCheckout(checkoutRequest, due);
      }
      wave++;
      startCheckpointIfDue();
    }
    if (!localStop && performance.now() < endMono) await waitFor(endMono, 50);
  }

  async function runCheckoutProducer(): Promise<void> {
    if (profile.version === 2) return;
    for (let tick = 0; tick < profile.checkout.maxAttempts && !localStop; tick++) {
      const due = startMono + tick * profile.checkout.intervalMs;
      await waitFor(due, 100);
      if (localStop) break;
      const now = performance.now();
      if (now > due + 100) {
        await skipCheckoutTick(action.id).catch(() => { observationFailure = true; closeAdmissions("observation_failure"); });
        continue;
      }
      if (Date.now() + profile.checkout.requestTimeoutMs + 1_000 >= action.deadlineAt) {
        deadlineReached = true;
        closeAdmissions("deadline");
        break;
      }
      const request = newRequest("checkout", checkoutPayload(baseline.sku, baseline.productVersion));
      const reserved = await reserveSurgeCheckout(action.id, request, profile).catch(() => {
        observationFailure = true;
        closeAdmissions("observation_failure");
        return false;
      });
      if (!reserved) {
        const current = await getAction(action.id).catch(() => undefined);
        if (!current) {
          observationFailure = true;
          closeAdmissions("observation_failure");
        } else if (current.stopRequested || current.status === "draining") {
          observeStop();
        } else if (current.status !== "running") {
          observationFailure = true;
          closeAdmissions("observation_failure");
        }
        continue;
      }
      const payload = request.checkout;
      let admitted = !localStop && performance.now() < endMono;
      if (admitted) {
        try {
          const current = await getAction(action.id);
          if (!current || current.kind !== "traffic") {
            observationFailure = true;
            closeAdmissions("observation_failure");
            admitted = false;
          } else if (current.stopRequested || current.status === "draining") {
            observeStop();
            admitted = false;
          } else if (current.status !== "running" || performance.now() >= endMono || localStop) {
            if (current.status !== "running") {
              observationFailure = true;
              closeAdmissions("observation_failure");
            }
            admitted = false;
          }
        } catch {
          observationFailure = true;
          closeAdmissions("observation_failure");
          admitted = false;
        }
      }
      if (!admitted) {
        await markSurgeCheckoutNotSent(action.id, request,
          localStop ? "ADMISSION_CLOSED" : "PRODUCTION_WINDOW_CLOSED", window, stopObservedAt)
          .catch(() => { observationFailure = true; closeAdmissions("observation_failure"); });
        continue;
      }
      const task = (async () => {
        const result = await send(action.id, target, bearer, request, payload, profile.checkout.requestTimeoutMs, () => {
          if (localStop || performance.now() >= endMono) return false;
          if (Date.now() + profile.checkout.requestTimeoutMs + 1_000 >= action.deadlineAt) {
            deadlineReached = true;
            closeAdmissions("deadline");
            return false;
          }
          return true;
        });
        if (!result.sent) {
          await markSurgeCheckoutNotSent(action.id, request,
            localStop ? "ADMISSION_CLOSED" : "PRODUCTION_WINDOW_CLOSED", window, stopObservedAt);
        } else if (result.outcome === "unknown" && payload) unknown.push(payload);
      })().catch(() => {
        observationFailure = true;
        closeAdmissions("observation_failure");
      }).finally(() => pending.delete(task));
      pending.add(task);
    }
    if (!localStop && performance.now() < endMono) await waitFor(endMono, 100);
  }

  try {
    if (profile.version === 2) await runCatalogWaves(profile);
    else await Promise.all([runCatalogProducer(), runCheckoutProducer()]);
  } catch {
    observationFailure = true;
    closeAdmissions("observation_failure");
  }
  if (checkpointPending) await checkpointPending;
  if (!localStop) {
    localStop = true;
    admissionClosedMono = endMono;
    admissionClosedAt = window.scheduledEndAt;
    closeReason = "duration";
  }
  producerStoppedMono = admissionClosedMono ?? performance.now();
  const producerStoppedAt = admissionClosedAt ?? new Date().toISOString();
  const stopReason: TrafficWindow["stopReason"] = observationWriteFailure || observationFailure ? "observation_failure"
    : deadlineReached ? "deadline" : closeReason ?? "duration";
  try {
    await setSurgeLifecycle(action.id, window, { ...(stopObservedAt ? { stopObservedAt } : {}), producerStoppedAt, stopReason });
  } catch {
    observationFailure = true;
    observationWriteFailure = true;
  }

  await Promise.all([...pending]);
  for (const payload of unknown) {
    try {
      const status = await checkStatus(action.id, target, bearer, payload);
      if (!status.submitted) deadlineReached = true;
    } catch {
      observationFailure = true;
    }
  }
  const settledAt = new Date().toISOString();
  const incomplete = observationWriteFailure || observationFailure || deadlineReached;
  const finalStopReason = incomplete ? (deadlineReached && !observationFailure ? "deadline" : "observation_failure")
    : closeReason ?? "duration";

  try {
    if (observationWriteFailure) {
      await finishIncompleteSurge(action.id, window, { ...(stopObservedAt ? { stopObservedAt } : {}), producerStoppedAt,
        settledAt, stopReason: finalStopReason },
      "A catalog observation could not be saved; the last successful partial snapshot is retained.");
      return;
    }
    await setSurgeLifecycle(action.id, window, { ...(stopObservedAt ? { stopObservedAt } : {}), producerStoppedAt,
      settledAt, stopReason: finalStopReason }, { state, startMono, producerStoppedMono,
      observationStatus: incomplete ? "partial" : "complete",
      actionStatus: incomplete ? "incomplete" : requestedStop ? "stopped" : "completed",
      ...(incomplete ? { error: "Traffic stopped before all required observations and reconciliation completed." } : {}) });
  } finally {
    monitorClosed = true;
    await stopMonitor;
  }
}

async function traffic(action: Action): Promise<void> {
  const target = await appTarget();
  const run = await getRun();
  const baseline = run.baseline;
  if (!baseline || baseline.appRevision !== target.revision || baseline.sku !== target.sku) {
    throw new ActionFailure("The app release changed. Check readiness before starting traffic.");
  }
  const bearer = await loadBearer();
  const isSurge = action.command.kind === "traffic" && action.command.profile === "inventory_surge";
  let context: TrafficContext;
  if (isSurge) {
    context = await surgeTrafficContext(action, target, bearer, run);
  } else {
    const release = await currentReleaseContext(bearer, target);
    if (baseline.deploymentIdentity && !sameDeploymentIdentity(baseline.deploymentIdentity, release.deploymentIdentity)) {
      throw new ActionFailure("The app release changed. Check readiness before starting traffic.");
    }
    context = trafficContextFromSettings(target.revision, baseline.productVersion, release.checkout, release.inventory);
  }
  const apiId = trafficApiId(target);
  if (!await persistTrafficContext(action.id, context, apiId)) {
    const current = await getAction(action.id);
    if (current?.kind === "traffic" && current.stopRequested) {
      await changeAction(action.id, (_run, latest) => {
        if (latest.kind !== "traffic" || !latest.stopRequested) return false;
        latest.status = "stopped";
        latest.finishedAt = new Date().toISOString();
        return true;
      });
      return;
    }
    throw new IncompleteActionFailure("The worker-observed traffic context could not be saved before production.");
  }
  if (isSurge) {
    if (!action.trafficProfile) throw new ActionFailure("The accepted surge action is missing its immutable workload profile.");
    await surgeTraffic(action, target, bearer, baseline, action.trafficProfile);
  } else {
    await ordinaryTraffic(action, target, bearer, baseline);
  }
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
    if (claim.action.kind === "increase_capacity") await increaseInventoryCapacity(claim.action);
    if (claim.action.kind === "increase_memory") await increaseInventoryMemory(claim.action);
    if (claim.action.kind === "activate_inventory_denial") await activateInventoryDenial(claim.action);
    if (claim.action.kind === "restore_inventory_access") await restoreInventoryAccess(claim.action);
    if (claim.action.kind === "recover") await recover(claim.action);
    if (claim.action.kind === "reset") await reset(claim.action);
  } catch (error) {
    await changeAction(actionId, (run, current) => {
      const unrecorded = current.requests.some((request) => !request.completedAt);
      current.status = error instanceof IncompleteActionFailure || unrecorded || Date.now() >= current.deadlineAt
        ? "incomplete" : "failed";
      if (current.kind === "reset") run.resetRequired = true;
      if (current.kind === "restore_inventory_access") {
        current.configurationOutcome = current.status === "incomplete" ? "unknown" : "failed";
      } else if (current.kind === "increase_capacity") {
        current.configurationOutcome = current.status === "incomplete" ? "unknown" : "failed";
      } else if (current.kind === "increase_memory") {
        current.configurationOutcome = current.configurationOutcome === "unknown" || current.status === "incomplete"
          ? "unknown" : "failed";
      } else if (current.kind === "activate_inventory_denial") {
        const incident = run.incident?.mechanism === "lambda-alias" && run.incident.activationActionId === actionId
          ? run.incident : undefined;
        current.configurationOutcome = !incident ? "failed"
          : incident.active === "denied" ? "applied" : "unknown";
      } else if (current.kind === "recover" && current.configurationOutcome !== "applied" && current.configurationOutcome !== "no_change") {
        const knownFailure = current.capRestoration?.checkout?.outcome === "failed" ||
          current.capRestoration?.inventory?.outcome === "failed" ||
          (run.incident?.kind === "inventory_access_denied" && run.incident.mechanism === "lambda-alias" && run.incident.aliasOutcome === "conflict");
        current.configurationOutcome = knownFailure ? "failed"
          : current.configurationOutcome === "unknown" || current.status === "incomplete" ? "unknown" : "failed";
      }
      current.error = error instanceof ActionFailure ? error.message : "A required controller or app provider call failed.";
      current.finishedAt = new Date().toISOString();
      return true;
    });
  }
}
