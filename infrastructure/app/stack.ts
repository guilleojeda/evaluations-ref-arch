import type { StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { DemoStack } from "../src/stacks.js";

export class AppStack extends DemoStack {
  constructor(scope: Construct, props: StackProps) {
    super(scope, "app", props);
  }
}
