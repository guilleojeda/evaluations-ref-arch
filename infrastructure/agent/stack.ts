import { CfnOutput, type StackProps } from "aws-cdk-lib";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import { Construct } from "constructs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DemoStack } from "../src/stacks.js";

export class AgentStack extends DemoStack {
  constructor(scope: Construct, props: StackProps) {
    super(scope, "agent", props);

    const runtimeZip = resolve(process.cwd(), ".artifacts/agent/runtime.zip");
    if (!existsSync(runtimeZip)) {
      throw new Error(`Agent runtime bundle is missing: ${runtimeZip}`);
    }
    const runtimeAsset = new Asset(this, "RuntimeZip", {
      path: runtimeZip,
    });
    new CfnOutput(this, "RuntimeAssetObjectKey", {
      value: runtimeAsset.s3ObjectKey,
      description: "Content-addressed AgentCore runtime ZIP asset",
    });
  }
}
