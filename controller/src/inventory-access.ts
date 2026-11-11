import {
  GetPolicyCommand,
  GetPolicyVersionCommand,
  ListAttachedRolePoliciesCommand,
  IAMClient,
} from "@aws-sdk/client-iam";
import {
  DynamoDBClient,
  GetResourcePolicyCommand,
} from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type {
  InventoryAccessPolicyObservation,
  InventoryVariantsManifest,
  InventoryTablePolicyObservation,
  PolicyState,
} from "./types.js";
const account = "027224425948";
const region = "us-east-1";
const inventoryTable = "IncidentTriageDemoInventory";
const inventoryRoleName = "IncidentTriageDemoAppInventoryRole";
const inventoryDeniedRoleName = "IncidentTriageDemoAppInventoryDeniedRole";
const inventoryPolicyName = "IncidentTriageDemoInventoryReadDeny";
const inventoryRoleArn = `arn:aws:iam::${account}:role/${inventoryRoleName}`;
const inventoryDeniedRoleArn = `arn:aws:iam::${account}:role/${inventoryDeniedRoleName}`;
const inventoryPolicyArn = `arn:aws:iam::${account}:policy/${inventoryPolicyName}`;
const inventoryTableArn = `arn:aws:dynamodb:${region}:${account}:table/${inventoryTable}`;
const clientOptions = { maxAttempts: 1, region };
const iam = new IAMClient(clientOptions);
const dynamo = new DynamoDBClient(clientOptions);
const manifestEndpoint = process.env.AWS_ENDPOINT_URL_S3 ?? process.env.AWS_ENDPOINT_URL;
const s3 = new S3Client({ ...clientOptions, forcePathStyle: true, ...(manifestEndpoint ? { endpoint: manifestEndpoint } : {}) });
const providerTimeout = () => ({ abortSignal: AbortSignal.timeout(4_000) });

export interface InventoryPolicyTarget {
  tableArn: string;
  roleArn: string;
}

export interface InventoryPolicyDocument {
  Version: "2012-10-17";
  Statement: [{ Sid?: "DenyInventoryGetItem"; Effect: "Deny"; Action: "dynamodb:GetItem"; Resource: string }];
}

export interface InventoryTablePolicyRead {
  observation: InventoryTablePolicyObservation;
}

export interface InventoryAccessPolicyRead {
  observation: InventoryAccessPolicyObservation;
  document?: InventoryPolicyDocument;
}

export function expectedInventoryTarget(tableArn = inventoryTableArn, roleArn = inventoryRoleArn): InventoryPolicyTarget {
  if (tableArn !== inventoryTableArn) throw new Error("The Inventory table target is not the named demo table.");
  if (roleArn !== inventoryRoleArn && roleArn !== inventoryDeniedRoleArn) throw new Error("The Inventory execution role target is invalid.");
  return { tableArn, roleArn };
}

export function expectedInventoryRoleArn(): string { return inventoryRoleArn; }
export function expectedInventoryDeniedRoleArn(): string { return inventoryDeniedRoleArn; }
export function expectedInventoryManifestBucket(): string {
  return "cdk-evaltalk-assets-027224425948-us-east-1";
}

export async function readInventoryVariantsManifest(bucket: string, key: string): Promise<InventoryVariantsManifest> {
  if (bucket !== expectedInventoryManifestBucket() || !/^releases\/app\/[0-9a-f]{40}\/inventory-variants\.json$/.test(key)) {
    throw new Error("The Inventory variants manifest location is invalid.");
  }
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }), providerTimeout());
  let raw: string | undefined;
  if (result.Body) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of result.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
    raw = Buffer.concat(chunks).toString("utf8");
  }
  if (!raw || raw.length > 64_000) throw new Error("The Inventory variants manifest is unavailable.");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("The Inventory variants manifest is invalid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The Inventory variants manifest is invalid.");
  const input = value as Record<string, unknown>;
  const sourceRevision = typeof input.sourceRevision === "string" && /^[0-9a-f]{40}$/.test(input.sourceRevision) ? input.sourceRevision : undefined;
  const codeSha256 = typeof input.codeSha256 === "string" && input.codeSha256.length > 0 && input.codeSha256.length <= 256 ? input.codeSha256 : undefined;
  const baselineMemoryMb = typeof input.baselineMemoryMb === "number" && Number.isSafeInteger(input.baselineMemoryMb) &&
    input.baselineMemoryMb >= 128 && input.baselineMemoryMb <= 10_240 ? input.baselineMemoryMb : undefined;
  if (input.schemaVersion !== 1 || !sourceRevision || input.functionName !== "IncidentTriageDemoInventory" ||
      input.aliasName !== "live" || baselineMemoryMb === undefined || !codeSha256 || !Array.isArray(input.variants) ||
      input.variants.length < 2 || input.variants.length > 32) {
    throw new Error("The Inventory variants manifest schema is invalid.");
  }
  const variants: InventoryVariantsManifest["variants"] = [];
  const memories = new Set<number>();
  const versions = new Set<string>();
  const pairs = new Set<string>();
  for (const entry of input.variants) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("The Inventory variants manifest contains an invalid variant.");
    }
    const item = entry as Record<string, unknown>;
    const access = item.access === "healthy" || item.access === "denied" ? item.access : undefined;
    const version = typeof item.version === "string" && /^[1-9]\d*$/.test(item.version) ? item.version : undefined;
    const roleArn = item.roleArn === inventoryRoleArn || item.roleArn === inventoryDeniedRoleArn ? item.roleArn : undefined;
    const memoryMb = typeof item.memoryMb === "number" && Number.isSafeInteger(item.memoryMb) &&
      item.memoryMb >= 128 && item.memoryMb <= 10_240 ? item.memoryMb : undefined;
    if (!access || memoryMb === undefined || !version || !roleArn || versions.has(version)) {
      throw new Error("The Inventory variants manifest contains an invalid variant.");
    }
    const expectedRole = access === "healthy" ? inventoryRoleArn : inventoryDeniedRoleArn;
    const pair = `${memoryMb}:${access}`;
    if (roleArn !== expectedRole || pairs.has(pair)) {
      throw new Error("The Inventory variants manifest contains a duplicated or mismatched access variant.");
    }
    versions.add(version);
    memories.add(memoryMb);
    pairs.add(pair);
    variants.push({ memoryMb, access, version, roleArn });
  }
  if (!memories.has(baselineMemoryMb) || [...memories].some((memoryMb) =>
    !pairs.has(`${memoryMb}:healthy`) || !pairs.has(`${memoryMb}:denied`))) {
    throw new Error("The Inventory variants manifest must contain a healthy and denied version for every memory size.");
  }
  return { schemaVersion: 1, sourceRevision, functionName: "IncidentTriageDemoInventory", aliasName: "live",
    baselineMemoryMb, codeSha256, variants };
}

export function expectedInventoryPolicyArn(): string {
  return inventoryPolicyArn;
}

export function expectedInventoryPolicyName(): string {
  return inventoryPolicyName;
}

function text(value: unknown, max = 512): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function timestamp(): string {
  return new Date().toISOString();
}

function tableObservation(state: PolicyState, target: InventoryPolicyTarget, revision?: string, statementId?: string): InventoryTablePolicyObservation {
  return {
    state,
    ...(revision ? { revision } : {}),
    ...(statementId ? { statementId } : {}),
    tableArn: target.tableArn,
    roleArn: target.roleArn,
    observedAt: timestamp(),
  };
}

/** The table resource policy remains a read-only app invariant. */
export async function readInventoryTablePolicy(target = expectedInventoryTarget()): Promise<InventoryTablePolicyRead> {
  try {
    const result = await dynamo.send(new GetResourcePolicyCommand({ ResourceArn: target.tableArn }), providerTimeout());
    if (!result.Policy) throw new Error("The Inventory table policy response is invalid.");
    let statementId: string | undefined;
    try {
      const policy = JSON.parse(result.Policy) as { Statement?: unknown };
      const statements = Array.isArray(policy.Statement) ? policy.Statement : [policy.Statement];
      if (statements.length === 1 && statements[0] && typeof statements[0] === "object") {
        statementId = text((statements[0] as Record<string, unknown>).Sid, 128);
      }
    } catch {
      throw new Error("The Inventory table policy response is invalid.");
    }
    return { observation: tableObservation("present", target, text(result.RevisionId, 256), statementId) };
  } catch (error) {
    if (error instanceof Error && error.name === "PolicyNotFoundException") {
      return { observation: tableObservation("absent", target) };
    }
    throw error;
  }
}

function parsePolicyDocument(value: unknown): InventoryPolicyDocument | undefined {
  if (typeof value !== "string" || value.length > 16_384) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    try {
      // IAM returns policy documents URL-encoded according to RFC 3986.
      parsed = JSON.parse(decodeURIComponent(value));
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const document = parsed as Record<string, unknown>;
  if (document.Version !== "2012-10-17" || !Array.isArray(document.Statement) || document.Statement.length !== 1) return undefined;
  const statement = document.Statement[0];
  if (!statement || typeof statement !== "object" || Array.isArray(statement)) return undefined;
  const fields = statement as Record<string, unknown>;
  const sid = fields.Sid;
  const action = typeof fields.Action === "string" ? fields.Action
    : Array.isArray(fields.Action) && fields.Action.length === 1 ? fields.Action[0] : undefined;
  const resource = typeof fields.Resource === "string" ? fields.Resource
    : Array.isArray(fields.Resource) && fields.Resource.length === 1 ? fields.Resource[0] : undefined;
  const expectedFields = sid === undefined ? "Action,Effect,Resource" : "Action,Effect,Resource,Sid";
  if (Object.keys(document).sort().join(",") !== "Statement,Version" ||
      Object.keys(fields).sort().join(",") !== expectedFields ||
      (sid !== undefined && sid !== "DenyInventoryGetItem") ||
      fields.Effect !== "Deny" || action !== "dynamodb:GetItem" || typeof resource !== "string") return undefined;
  return {
    Version: "2012-10-17",
    Statement: [{ ...(sid ? { Sid: "DenyInventoryGetItem" as const } : {}), Effect: "Deny", Action: "dynamodb:GetItem", Resource: resource }],
  };
}

export function denialPolicyDocument(target = expectedInventoryTarget()): InventoryPolicyDocument {
  return { Version: "2012-10-17", Statement: [{ Effect: "Deny", Action: "dynamodb:GetItem", Resource: target.tableArn }] };
}

export function isExactInventoryPolicyDocument(document: InventoryPolicyDocument | undefined, target = expectedInventoryTarget()): boolean {
  const expected = denialPolicyDocument(target);
  return Boolean(document && document.Version === expected.Version && document.Statement.length === 1 &&
    (!document.Statement[0].Sid || document.Statement[0].Sid === "DenyInventoryGetItem") &&
    document.Statement[0].Effect === "Deny" && document.Statement[0].Action === "dynamodb:GetItem" &&
    document.Statement[0].Resource === target.tableArn);
}

async function attachedToInventoryRole(roleArn: string): Promise<boolean> {
  const roleName = roleArn === inventoryRoleArn ? inventoryRoleName : roleArn === inventoryDeniedRoleArn ? inventoryDeniedRoleName : undefined;
  if (!roleName) throw new Error("The Inventory role target is invalid.");
  let marker: string | undefined;
  const seenMarkers = new Set<string>();
  for (let page = 0; page < 10; page++) {
    const response = await iam.send(new ListAttachedRolePoliciesCommand({
      RoleName: roleName,
      MaxItems: 100,
      ...(marker ? { Marker: marker } : {}),
    }), providerTimeout());
    const attached = response.AttachedPolicies?.some((policy) => policy.PolicyArn === inventoryPolicyArn) ?? false;
    if (attached) return true;
    if (!response.IsTruncated) return false;
    const next = text(response.Marker, 512);
    if (!next || seenMarkers.has(next)) throw new Error("The Inventory role attachment list did not advance its pagination marker.");
    seenMarkers.add(next);
    marker = next;
  }
  throw new Error("The Inventory role attachment list exceeded its bounded page limit.");
}

/** Read the named managed policy, its exact default document, and all role attachments. */
export async function readInventoryAccessPolicy(target = expectedInventoryTarget()): Promise<InventoryAccessPolicyRead> {
  const [policyResult, attached] = await Promise.all([
    iam.send(new GetPolicyCommand({ PolicyArn: inventoryPolicyArn }), providerTimeout()),
    attachedToInventoryRole(target.roleArn),
  ]);
  const policy = policyResult.Policy;
  if (!policy || policy.Arn !== inventoryPolicyArn || policy.PolicyName !== inventoryPolicyName) {
    throw new Error("The pre-created Inventory denial policy identity is invalid.");
  }
  const defaultVersionId = text(policy.DefaultVersionId, 128);
  let document: InventoryPolicyDocument | undefined;
  let documentMatches = false;
  if (defaultVersionId && /^v[1-9]\d*$/.test(defaultVersionId)) {
    const version = await iam.send(new GetPolicyVersionCommand({ PolicyArn: inventoryPolicyArn, VersionId: defaultVersionId }), providerTimeout());
    if (version.PolicyVersion?.VersionId === defaultVersionId && version.PolicyVersion.IsDefaultVersion === true) {
      document = parsePolicyDocument(version.PolicyVersion.Document);
      documentMatches = isExactInventoryPolicyDocument(document, target);
    }
  }
  return {
    observation: {
      state: attached ? "present" : "absent",
      policyArn: inventoryPolicyArn,
      policyName: inventoryPolicyName,
      roleArn: target.roleArn,
      ...(defaultVersionId ? { defaultVersionId } : {}),
      documentMatches,
      observedAt: timestamp(),
    },
    ...(document ? { document } : {}),
  };
}

export function isExactInventoryAccessPolicy(observation: InventoryAccessPolicyObservation, target = expectedInventoryTarget()): boolean {
  return observation.policyArn === inventoryPolicyArn && observation.policyName === inventoryPolicyName &&
    observation.roleArn === target.roleArn && Boolean(observation.defaultVersionId) && observation.documentMatches;
}

export function sameInventoryPolicyVersion(actual: InventoryAccessPolicyObservation, expected: InventoryAccessPolicyObservation): boolean {
  return actual.policyArn === expected.policyArn && actual.policyName === expected.policyName &&
    actual.roleArn === expected.roleArn && actual.defaultVersionId === expected.defaultVersionId &&
    actual.documentMatches === true;
}
