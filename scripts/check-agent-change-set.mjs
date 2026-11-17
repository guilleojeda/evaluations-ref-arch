import { readFileSync } from "node:fs";

const ACCOUNT_REGION = "us-east-1:027224425948";
const STACK_NAME = "IncidentTriageDemoAgent";
const STACK_ID = new RegExp(`^arn:aws:cloudformation:${ACCOUNT_REGION}:stack/${STACK_NAME}/[0-9a-f-]+$`, "i");
const CHANGE_SET_ID = new RegExp(`^arn:aws:cloudformation:${ACCOUNT_REGION}:changeSet/[^/]+/[0-9a-f-]+$`, "i");
const ENDPOINT_TYPE = "AWS::BedrockAgentCore::RuntimeEndpoint";
// This is the physical ID read from the live Phase19 stack before the one-time
// ownership transfer. It is intentionally data, not an ARN derived from the
// desired template: the cutover must prove that CloudFormation is removing the
// exact legacy resource it inspected.
const LEGACY_ENDPOINT = {
  logicalId: "FaultyEndpoint",
  physicalId: "arn:aws:bedrock-agentcore:us-east-1:027224425948:runtime/IncidentTriageDemoAgent-7VWTOWDIs4/runtime-endpoint/faulty",
  resourceType: ENDPOINT_TYPE,
};

let checkedTemplate;
const referenceCutover = process.argv[2] === "--reference-cutover";
const templatePath = referenceCutover ? process.argv[3] : process.argv[2];
try {
  if (!templatePath || (referenceCutover && process.argv.length !== 4) || (!referenceCutover && process.argv.length !== 3)) {
    throw new Error();
  }
  checkedTemplate = JSON.parse(readFileSync(templatePath, "utf8"));
  if (!checkedTemplate || typeof checkedTemplate !== "object" ||
      !checkedTemplate.Resources || typeof checkedTemplate.Resources !== "object") throw new Error();
} catch {
  console.error("Rejected agent change set: supply the exact checked template JSON");
  process.exit(1);
}

const resources = checkedTemplate.Resources;
if (Object.values(resources).some((resource) => resource?.Type === ENDPOINT_TYPE)) {
  console.error("Rejected agent change set: the checked post-cutover template must not own a RuntimeEndpoint");
  process.exit(1);
}

const imports = {};
for (const [name, type, property, physicalId] of [
  ["RunTable", "AWS::DynamoDB::Table", "TableName", "IncidentTriageDemoAgentRun"],
  [undefined, "AWS::Logs::LogGroup", "LogGroupName", "/aws/lambda/IncidentTriageDemoAlarmAdapter"],
]) {
  const matches = Object.entries(resources).filter(([id, resource]) =>
    (!name || id === name) && resource?.Type === type && resource.Properties?.[property] === physicalId,
  );
  if (matches.length !== 1 || matches[0][1].DeletionPolicy !== "Retain" || matches[0][1].UpdateReplacePolicy !== "Retain") {
    console.error("Rejected agent change set: checked template must retain the exact agent run table and adapter log group");
    process.exit(1);
  }
  imports[matches[0][0]] = { type, physicalId };
}

let description;
try {
  description = JSON.parse(readFileSync(0, "utf8"));
} catch {
  console.error("Rejected agent change set: CloudFormation response is not valid JSON");
  process.exit(1);
}

function reject(message) {
  console.error(`Rejected agent change set: ${message}`);
  process.exitCode = 1;
}

if (!description || typeof description !== "object" || Array.isArray(description)) {
  reject("the CloudFormation response must be an object");
} else {
  const {
    ChangeSetId: changeSetId,
    StackId: stackId,
    StackName: stackName,
    Status: status,
    ExecutionStatus: executionStatus,
    Changes: changes,
    NextToken: nextToken,
  } = description;

  if (typeof changeSetId !== "string" || !CHANGE_SET_ID.test(changeSetId)) reject("the response does not identify a change set in the approved account and Region");
  if (typeof stackId !== "string" || !STACK_ID.test(stackId)) reject(`the response does not identify the ${STACK_NAME} stack`);
  if (stackName !== STACK_NAME) reject(`unexpected stack name ${JSON.stringify(stackName)}`);
  if (!(status === "CREATE_COMPLETE" || status === "UPDATE_COMPLETE")) reject(`change set is not complete (status ${JSON.stringify(status)})`);
  if (executionStatus !== "AVAILABLE") reject(`change set is not available for execution (execution status ${JSON.stringify(executionStatus)})`);
  if (nextToken !== undefined && nextToken !== null && nextToken !== "") reject("the response is paginated; refusing to approve an incomplete change set");
  if (!Array.isArray(changes)) {
    reject("the response has no complete Changes array");
  } else {
    let legacyRemovals = 0;
    for (const entry of changes) {
      const resource = entry?.ResourceChange;
      if (!resource || typeof resource !== "object") {
        reject("a change does not contain a ResourceChange object");
        continue;
      }
      const logicalId = resource.LogicalResourceId;
      if (typeof logicalId !== "string" || logicalId.length === 0) {
        reject("a resource change has no logical ID");
        continue;
      }
      if (resource.Action === "Import") {
        const expected = imports[logicalId];
        if (!expected || resource.ResourceType !== expected.type || resource.PhysicalResourceId !== expected.physicalId) reject(`${logicalId} is not an approved retained resource import`);
        if (resource.Replacement !== undefined && resource.Replacement !== "False") reject(`${logicalId} import may replace a resource`);
        continue;
      }

      const action = resource.Action;
      if (resource.Replacement !== undefined && resource.Replacement !== "False") {
        reject(`${logicalId} may be replaced (replacement ${JSON.stringify(resource.Replacement)})`);
      }
      if (action === "Remove") {
        const exactLegacyRemoval = logicalId === LEGACY_ENDPOINT.logicalId &&
          resource.ResourceType === LEGACY_ENDPOINT.resourceType &&
          resource.PhysicalResourceId === LEGACY_ENDPOINT.physicalId &&
          resource.Replacement === undefined;
        if (!referenceCutover || !exactLegacyRemoval) reject(`${logicalId} removal is not an approved one-time legacy endpoint cutover`);
        else legacyRemovals += 1;
      } else if (logicalId === LEGACY_ENDPOINT.logicalId || resource.ResourceType === ENDPOINT_TYPE) {
        reject(`${logicalId} must not add, modify, or repin the publisher-owned endpoint`);
      }

      // Preserve the original retained-table safety rules. A table update
      // with an omitted replacement decision is not safe to execute.
      if (logicalId === "RunTable") {
        if (resource.ResourceType !== "AWS::DynamoDB::Table") {
          reject("RunTable is not an AWS::DynamoDB::Table resource");
        } else if (action === "Modify" && resource.Replacement !== "False") {
          reject("RunTable may be replaced or has an unknown replacement decision");
        } else if (action !== "Modify" && action !== "Add") {
          reject(`RunTable has an unexpected action ${JSON.stringify(action)}`);
        }
      }
    }
    if (legacyRemovals > 1) reject("the one-time reference cutover may remove at most one legacy endpoint");
  }
}

if (process.exitCode !== 1) {
  console.log(referenceCutover
    ? "Approved agent reference-cutover change set: only the exact legacy FaultyEndpoint may be removed"
    : "Approved ordinary agent change set: publisher-owned endpoint and retained resources are protected");
}
