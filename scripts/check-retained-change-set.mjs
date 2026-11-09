import { readFileSync } from "node:fs";

const CHANGE_SET_ID = /^arn:aws:cloudformation:us-east-1:027224425948:changeSet\/[^/]+\/[0-9a-f-]+$/i;
const ALLOWED_STATUSES = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE"]);

export function checkRetainedChangeSet({ component, stackName: expectedStackName, tableIds, imports = {}, success }) {
  const stackIdPattern = new RegExp(`^arn:aws:cloudformation:us-east-1:027224425948:stack/${expectedStackName}/[0-9a-f-]+$`, "i");
  function fail(message) {
    console.error(`Rejected ${component} change set: ${message}`);
    process.exitCode = 1;
  }

  let description;
  let parsed = true;
  try {
    description = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    parsed = false;
    fail("stdin is not valid JSON");
  }

  if (!parsed) {
    // The parse error above is intentionally generic so input is never echoed.
  } else if (!description || typeof description !== "object" || Array.isArray(description)) {
    fail("the CloudFormation response must be an object");
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

    if (typeof changeSetId !== "string" || !CHANGE_SET_ID.test(changeSetId)) {
      fail("the response does not identify a change set in the approved account and Region");
    }
    if (typeof stackId !== "string" || !stackIdPattern.test(stackId)) {
      fail(`the response does not identify the ${expectedStackName} stack`);
    }
    if (stackName !== expectedStackName) fail(`unexpected stack name ${JSON.stringify(stackName)}`);
    if (!ALLOWED_STATUSES.has(status)) fail(`change set is not complete (status ${JSON.stringify(status)})`);
    if (executionStatus !== "AVAILABLE") {
      fail(`change set is not available for execution (execution status ${JSON.stringify(executionStatus)})`);
    }
    if (nextToken !== undefined && nextToken !== null && nextToken !== "") {
      fail("the response is paginated; refusing to approve an incomplete change set");
    }
    if (!Array.isArray(changes)) {
      fail("the response has no complete Changes array");
    } else {
      for (const entry of changes) {
        const resource = entry?.ResourceChange;
        if (!resource || typeof resource !== "object") {
          fail("a change does not contain a ResourceChange object");
          continue;
        }
        const logicalId = resource.LogicalResourceId;
        if (typeof logicalId !== "string" || logicalId.length === 0) {
          fail("a resource change has no logical ID");
          continue;
        }
        if (resource.Action === "Import") {
          const expected = imports[logicalId];
          if (!expected || resource.ResourceType !== expected.type || resource.PhysicalResourceId !== expected.physicalId) {
            fail(`${logicalId} is not an approved retained resource import`);
          }
          if (resource.Replacement !== undefined && resource.Replacement !== "False") {
            fail(`${logicalId} import may replace a resource`);
          }
          continue;
        }
        if (!tableIds.includes(logicalId)) continue;

        const action = resource.Action;
        if (typeof action !== "string" || action.length === 0) {
          fail(`${logicalId} has no action`);
          continue;
        }
        if (resource.ResourceType !== "AWS::DynamoDB::Table") {
          fail(`${logicalId} is not an AWS::DynamoDB::Table resource`);
          continue;
        }
        if (action === "Add") {
          if (resource.Replacement !== undefined && resource.Replacement !== "False") {
            fail(`${logicalId} may be replaced (replacement ${JSON.stringify(resource.Replacement)})`);
          }
          continue;
        }
        if (action !== "Modify") {
          fail(`${logicalId} has an unexpected action ${JSON.stringify(action)}`);
          continue;
        }
        if (resource.Replacement !== "False") {
          fail(`${logicalId} may be replaced (replacement ${JSON.stringify(resource.Replacement)})`);
        }
      }
    }
  }

  if (process.exitCode !== 1) {
    console.log(success);
  }
}
