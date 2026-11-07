import {
  GetPolicyCommand,
  GetPolicyVersionCommand,
  ListAttachedRolePoliciesCommand,
  AttachRolePolicyCommand,
  DetachRolePolicyCommand,
  IAMClient,
} from "@aws-sdk/client-iam";
import {
  DynamoDBClient,
  GetResourcePolicyCommand,
} from "@aws-sdk/client-dynamodb";
import type {
  InventoryAccessPolicyObservation,
  InventoryTablePolicyObservation,
  PolicyState,
} from "./types.js";

const account = "027224425948";
const region = "us-east-1";
const inventoryTable = "IncidentTriageDemoInventory";
const inventoryRoleName = "IncidentTriageDemoAppInventoryRole";
const inventoryPolicyName = "IncidentTriageDemoInventoryReadDeny";
const inventoryRoleArn = `arn:aws:iam::${account}:role/${inventoryRoleName}`;
const inventoryPolicyArn = `arn:aws:iam::${account}:policy/${inventoryPolicyName}`;
const inventoryTableArn = `arn:aws:dynamodb:${region}:${account}:table/${inventoryTable}`;
const clientOptions = { maxAttempts: 1, region };
const iam = new IAMClient(clientOptions);
const dynamo = new DynamoDBClient(clientOptions);
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
  if (roleArn !== inventoryRoleArn) throw new Error("The Inventory execution role target is invalid.");
  return { tableArn, roleArn };
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

async function attachedToInventoryRole(): Promise<boolean> {
  let marker: string | undefined;
  const seenMarkers = new Set<string>();
  for (let page = 0; page < 10; page++) {
    const response = await iam.send(new ListAttachedRolePoliciesCommand({
      RoleName: inventoryRoleName,
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
    attachedToInventoryRole(),
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

export async function attachInventoryPolicy(target = expectedInventoryTarget()): Promise<void> {
  await iam.send(new AttachRolePolicyCommand({ RoleName: inventoryRoleName, PolicyArn: inventoryPolicyArn }), providerTimeout());
}

export async function detachInventoryPolicy(target = expectedInventoryTarget()): Promise<void> {
  await iam.send(new DetachRolePolicyCommand({ RoleName: inventoryRoleName, PolicyArn: inventoryPolicyArn }), providerTimeout());
}

export function isAttachConflict(error: unknown): boolean {
  return error instanceof Error && ["EntityAlreadyExists", "EntityAlreadyExistsException", "InvalidInput"].includes(error.name);
}

export function isDetachConflict(error: unknown): boolean {
  return error instanceof Error && ["NoSuchEntity", "NoSuchEntityException"].includes(error.name);
}
