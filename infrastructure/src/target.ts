export const ACCOUNT = "027224425948";
export const REGION = "us-east-1";

export type Component = "app" | "controller" | "agent";

export const STACK_NAMES: Record<Component, string> = {
  app: "IncidentTriageDemoApp",
  controller: "IncidentTriageDemoController",
  agent: "IncidentTriageDemoAgent",
};
