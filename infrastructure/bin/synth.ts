import { App } from "aws-cdk-lib";
import { AgentStack } from "../agent/stack.js";
import { AppStack } from "../app/stack.js";
import { ControllerStack } from "../controller/stack.js";
import { ACCOUNT, REGION, STACK_NAMES, type Component } from "../src/target.js";

const component = process.argv[2] as Component | undefined;
if (!component || !(component in STACK_NAMES)) {
  throw new Error("Usage: synth.ts <app|controller|agent>");
}

const app = new App();
const props = {
  env: {
    account: ACCOUNT,
    region: REGION,
  },
};
if (component === "app") new AppStack(app, props);
if (component === "controller") new ControllerStack(app, props);
if (component === "agent") new AgentStack(app, props);
app.synth();
