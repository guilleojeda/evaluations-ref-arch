import { checkRetainedChangeSet } from "./check-retained-change-set.mjs";

checkRetainedChangeSet({
  component: "app",
  stackName: "IncidentTriageDemoApp",
  tableIds: ["Inventory", "Orders"],
  success: "Approved app change set: business tables are retained",
});
