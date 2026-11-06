import type { StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { DemoStack } from "../src/stacks.js";

export class ControllerStack extends DemoStack {
  constructor(scope: Construct, props: StackProps) {
    super(scope, "controller", props);
  }
}
