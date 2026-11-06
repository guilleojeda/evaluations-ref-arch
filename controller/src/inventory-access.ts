import {
  DeleteResourcePolicyCommand,
  DynamoDBClient,
  GetResourcePolicyCommand,
  PutResourcePolicyCommand,
} from "@aws-sdk/client-dynamodb";
import type { InventoryPolicyObservation, PolicyState } from "./types.js";

const account = "027224425948";
const region = "us-east-1";
const inventoryTable = "IncidentTriageDemoInventory";
const client = new DynamoDBClient({ maxAttempts: 1, region });
const policyTimeout = () => ({ abortSignal: AbortSignal.timeout(4_000) });

export interface InventoryPolicyDocument {
  Version: "2012-10-17";
  Statement: InventoryPolicyStatement[];
}

export interface InventoryPolicyStatement {
  Sid?: string;
  Effect: "Allow" | "Deny";
  Principal?: unknown;
  Action?: unknown;
  Resource?: unknown;
  Condition?: unknown;
}

export interface InventoryPolicyRead {
  observation: InventoryPolicyObservation;
  document?: InventoryPolicyDocument;
}

export interface InventoryPolicyTarget {
  tableArn: string;
  roleArn: string;
}

export function inventoryTableArn(): string {
  return `arn:aws:dynamodb:${region}:${account}:table/${inventoryTable}`;
}

export function expectedInventoryTarget(tableArn = inventoryTableArn(), roleArn?: string): InventoryPolicyTarget {
  if (tableArn !== inventoryTableArn()) throw new Error("The Inventory table target is not the named demo table.");
  const targetRole = roleArn ?? `arn:aws:iam::${account}:role/IncidentTriageDemoAppInventoryRole`;
  if (targetRole !== `arn:aws:iam::${account}:role/IncidentTriageDemoAppInventoryRole`) {
    throw new Error("The Inventory execution role target is invalid.");
  }
  return { tableArn, roleArn: targetRole };
}

function providerError(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

function text(value: unknown, max = 512): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function stringOrList(value: unknown): unknown {
  if (typeof value === "string") return text(value, 1024);
  if (Array.isArray(value) && value.length <= 32) {
    const values = value.map((item) => text(item, 1024));
    return values.every((item) => item !== undefined) ? values : undefined;
  }
  return undefined;
}

function principal(value: unknown): unknown {
  if (typeof value === "string") return text(value, 1024);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, string | string[]> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(key)) return undefined;
    const safe = stringOrList(item);
    if (safe === undefined || (typeof safe !== "string" && !Array.isArray(safe))) return undefined;
    result[key] = safe;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function principalArnCondition(value: unknown): InventoryPolicyStatement["Condition"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const operators = Object.entries(value);
  if (operators.length !== 1 || operators[0][0] !== "ArnEquals") return undefined;
  const condition = operators[0][1];
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) return undefined;
  const entries = Object.entries(condition);
  const role = entries.length === 1 && entries[0][0] === "aws:PrincipalArn" ? text(entries[0][1]) : undefined;
  return role ? { ArnEquals: { "aws:PrincipalArn": role } } : undefined;
}

/** Keep only ordinary policy fields; raw SDK responses are never persisted in controller state. */
function sanitizedDocument(value: unknown): InventoryPolicyDocument | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some((key) => !["Version", "Statement"].includes(key))) return undefined;
  if (source.Version !== "2012-10-17" || !Array.isArray(source.Statement) || source.Statement.length > 64) return undefined;
  const statements: InventoryPolicyStatement[] = [];
  for (const item of source.Statement) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const sourceStatement = item as Record<string, unknown>;
    if (Object.keys(sourceStatement).some((key) => !["Sid", "Effect", "Principal", "Action", "Resource", "Condition"].includes(key))) return undefined;
    if (sourceStatement.Effect !== "Allow" && sourceStatement.Effect !== "Deny") return undefined;
    const statement: InventoryPolicyStatement = { Effect: sourceStatement.Effect };
    const sid = text(sourceStatement.Sid, 128);
    if (sourceStatement.Sid !== undefined && !sid) return undefined;
    if (sid) statement.Sid = sid;
    for (const key of ["Principal", "Action", "Resource", "Condition"] as const) {
      if (sourceStatement[key] === undefined) continue;
      const safe = key === "Principal" ? principal(sourceStatement[key])
        : key === "Condition" ? principalArnCondition(sourceStatement[key])
        : stringOrList(sourceStatement[key]);
      if (safe === undefined) return undefined;
      statement[key] = safe;
    }
    statements.push(statement);
  }
  return { Version: "2012-10-17", Statement: statements };
}

function observation(state: PolicyState, target: InventoryPolicyTarget, revision?: string, statementId?: string): InventoryPolicyObservation {
  return {
    state,
    ...(revision ? { revision } : {}),
    ...(statementId ? { statementId } : {}),
    tableArn: target.tableArn,
    roleArn: target.roleArn,
    observedAt: new Date().toISOString(),
  };
}

export async function readInventoryPolicy(target = expectedInventoryTarget()): Promise<InventoryPolicyRead> {
  try {
    const result = await client.send(new GetResourcePolicyCommand({ ResourceArn: target.tableArn }), policyTimeout());
    if (!result.Policy) throw new Error("The Inventory table policy response is invalid.");
    const document = sanitizedDocument(JSON.parse(result.Policy));
    return { document, observation: observation("present", target, text(result.RevisionId, 256), document && statementId(document)) };
  } catch (error) {
    if (providerError(error, "PolicyNotFoundException")) return { observation: observation("absent", target) };
    if (error instanceof SyntaxError) throw new Error("The Inventory table policy response is invalid.");
    throw error;
  }
}

function statementId(document: InventoryPolicyDocument): string | undefined {
  if (document.Statement.length !== 1) return undefined;
  return text(document.Statement[0].Sid, 128);
}

function targetStatement(target: InventoryPolicyTarget, actionId: string): InventoryPolicyStatement {
  const compactActionId = actionId.replace(/-/g, "");
  return {
    Sid: `InventoryAccessDenied${compactActionId}`,
    Effect: "Deny",
    Principal: "*",
    Action: "dynamodb:GetItem",
    Resource: target.tableArn,
    Condition: { ArnEquals: { "aws:PrincipalArn": target.roleArn } },
  };
}

export function denialPolicy(target: InventoryPolicyTarget, actionId: string): InventoryPolicyDocument {
  if (!/^[0-9a-f-]{36}$/i.test(actionId)) throw new Error("The Inventory denial action ID is invalid.");
  return { Version: "2012-10-17", Statement: [targetStatement(target, actionId)] };
}

export function isOwnedDenial(document: InventoryPolicyDocument | undefined, target: InventoryPolicyTarget, actionId: string): boolean {
  const expected = denialPolicy(target, actionId).Statement[0];
  if (!document || document.Statement.length !== 1) return false;
  const actual = document.Statement[0];
  return actual.Sid === expected.Sid && actual.Effect === expected.Effect &&
    JSON.stringify(actual.Principal) === JSON.stringify(expected.Principal) &&
    JSON.stringify(actual.Action) === JSON.stringify(expected.Action) &&
    JSON.stringify(actual.Resource) === JSON.stringify(expected.Resource) &&
    JSON.stringify(actual.Condition) === JSON.stringify(expected.Condition);
}

export async function putInventoryDenial(target: InventoryPolicyTarget, actionId: string): Promise<string | undefined> {
  const result = await client.send(new PutResourcePolicyCommand({
    ResourceArn: target.tableArn,
    Policy: JSON.stringify(denialPolicy(target, actionId)),
    ExpectedRevisionId: "NO_POLICY",
  }), policyTimeout());
  return text(result.RevisionId, 256);
}

export async function deleteInventoryPolicy(target: InventoryPolicyTarget, revision: string): Promise<void> {
  if (!revision || revision.length > 256) throw new Error("The Inventory policy revision is missing.");
  await client.send(new DeleteResourcePolicyCommand({
    ResourceArn: target.tableArn,
    ExpectedRevisionId: revision,
  }), policyTimeout());
}

export function isConditionalConflict(error: unknown): boolean {
  return error instanceof Error && ["PolicyNotFoundException", "PolicyNotFound", "ResourceInUseException", "ConditionalCheckFailedException"].includes(error.name);
}
