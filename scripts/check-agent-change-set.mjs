import { checkRetainedChangeSet } from "./check-retained-change-set.mjs";

checkRetainedChangeSet({
  component: "agent",
  stackName: "IncidentTriageDemoAgent",
  tableIds: ["RunTable"],
  success: "Approved agent change set: RunTable is retained",
});
