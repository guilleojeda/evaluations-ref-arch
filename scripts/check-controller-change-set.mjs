import { checkRetainedChangeSet } from "./check-retained-change-set.mjs";

checkRetainedChangeSet({
  component: "controller",
  stackName: "IncidentTriageDemoController",
  tableIds: ["RunTable"],
  success: "Approved controller change set: RunTable is retained",
});
