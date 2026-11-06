import { DefaultStackSynthesizer, Stack, type StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { STACK_NAMES, type Component } from "./target.js";

export class DemoStack extends Stack {
  constructor(scope: Construct, component: Component, props: StackProps) {
    super(scope, STACK_NAMES[component], {
      ...props,
      synthesizer: new DefaultStackSynthesizer({ qualifier: "evaltalk" }),
    });
  }
}
