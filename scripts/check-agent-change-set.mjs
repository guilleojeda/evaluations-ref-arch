import { readFileSync } from "node:fs";
import { checkRetainedChangeSet } from "./check-retained-change-set.mjs";

// Auto-import is only for the two retained, named resources from this checked
// assembly. It cannot adopt other tables, logs or unrelated named resources.
let resources;
try {
  if (process.argv.length !== 3) throw new Error();
  resources = JSON.parse(readFileSync(process.argv[2], "utf8")).Resources;
  if (!resources || typeof resources !== "object") throw new Error();
} catch {
  console.error("Rejected agent change set: supply the exact checked template JSON");
  process.exit(1);
}

const imports = {};
for (const [name, type, property, physicalId] of [
  ["RunTable", "AWS::DynamoDB::Table", "TableName", "IncidentTriageDemoAgentRun"],
  [undefined, "AWS::Logs::LogGroup", "LogGroupName", "/aws/lambda/IncidentTriageDemoAlarmAdapter"],
]) {
  const matches = Object.entries(resources).filter(([id, resource]) =>
    (!name || id === name) && resource.Type === type && resource.Properties?.[property] === physicalId,
  );
  if (matches.length !== 1 || matches[0][1].DeletionPolicy !== "Retain" || matches[0][1].UpdateReplacePolicy !== "Retain") {
    console.error("Rejected agent change set: checked template must retain the exact agent run table and adapter log group");
    process.exit(1);
  }
  imports[matches[0][0]] = { type, physicalId };
}

checkRetainedChangeSet({
  component: "agent",
  stackName: "IncidentTriageDemoAgent",
  tableIds: ["RunTable"],
  imports,
  success: "Approved agent change set: RunTable is retained and imports match the checked agent resources",
});
