import { CfnOutput, CfnParameter, Duration, RemovalPolicy, type StackProps } from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import { Construct } from "constructs";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DemoStack } from "../src/stacks.js";
const ACCOUNT = "027224425948";
const REGION = "us-east-1";
const RUNTIME_NAME = "IncidentTriageDemoAgent";
const ADAPTER_NAME = "IncidentTriageDemoAlarmAdapter";
const ALARM_ARN = `arn:aws:cloudwatch:${REGION}:${ACCOUNT}:alarm:IncidentTriageDemoAppStage5xx`;
const EVIDENCE_BUCKET = `incident-triage-demo-evidence-${ACCOUNT}-${REGION}`;
const MODEL_ID = "us.anthropic.claude-sonnet-4-6";
export class AgentStack extends DemoStack {
  constructor(scope: Construct, props: StackProps) {
    super(scope, "agent", props);
    const revision = new CfnParameter(this, "SourceRevisionInput", { type: "String", allowedPattern: "^[a-f0-9]{40}$" });
    revision.overrideLogicalId("SourceRevision");
    const apiId = new CfnParameter(this, "AppHttpApiId", { type: "String", allowedPattern: "^[a-z0-9]+$" });
    const runtimeZip = resolve(process.cwd(), ".artifacts/agent/runtime.zip");
    const adapterZip = resolve(process.cwd(), ".artifacts/agent/alarm-adapter.zip");
    for (const artifact of [runtimeZip, adapterZip]) {
      if (!existsSync(artifact)) throw new Error(`Agent bundle is missing: ${artifact}`);
    }
    const artifactSha256 = createHash("sha256").update(readFileSync(runtimeZip)).digest("hex");
    const runtimeAsset = new Asset(this, "RuntimeZip", { path: runtimeZip });
    const runs = new dynamodb.Table(this, "RunTable", {
      tableName: "IncidentTriageDemoAgentRun", billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      encryption: dynamodb.TableEncryption.AWS_MANAGED, removalPolicy: RemovalPolicy.RETAIN,
    });
    (runs.node.defaultChild as dynamodb.CfnTable).overrideLogicalId("RunTable");
    const runtimeArnPattern = `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT}:runtime/${RUNTIME_NAME}-*`;
    const runtimeRole = new iam.Role(this, "RuntimeRole", {
      roleName: "IncidentTriageDemoAgentRuntimeRole",
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", { conditions: { StringEquals: { "aws:SourceAccount": ACCOUNT }, ArnLike: { "aws:SourceArn": runtimeArnPattern } } }),
      permissionsBoundary: iam.ManagedPolicy.fromManagedPolicyArn(this, "RuntimeBoundary", `arn:aws:iam::${ACCOUNT}:policy/IncidentTriageDemoAgentRuntimeBoundary`),
    });
    const grant = (sid: string, actions: string[], resources: string[], conditions?: Record<string, Record<string, string>>) => runtimeRole.addToPolicy(new iam.PolicyStatement({ sid, actions, resources, conditions }));
    grant("SelectedModel", ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], [
      `arn:aws:bedrock:${REGION}:${ACCOUNT}:inference-profile/${MODEL_ID}`,
      ...["us-east-1", "us-east-2", "us-west-2"].map((region) => `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-sonnet-4-6`),
    ]);
    grant("OwnInvestigationRecords", ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"], [runs.tableArn]);
    grant("SanitizedSourceCapture", ["s3:PutObject"], [`arn:aws:s3:::${EVIDENCE_BUCKET}/agent-source/*`]);
    grant("AppLogs", ["logs:FilterLogEvents"], ["/aws/lambda/IncidentTriageDemoCheckout", "/aws/lambda/IncidentTriageDemoInventory", "/aws/apigateway/IncidentTriageDemoApp"].map((name) => `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:${name}:*`));
    grant("AppMetricReads", ["cloudwatch:GetMetricData", "cloudwatch:GetMetricStatistics"], ["*"], { StringEquals: { "aws:RequestedRegion": REGION } });
    grant("AppFunctionConfiguration", ["lambda:GetFunctionConfiguration", "lambda:GetAlias", "lambda:GetFunctionConcurrency"], ["Checkout", "Inventory"].flatMap((name) => [`arn:aws:lambda:${REGION}:${ACCOUNT}:function:IncidentTriageDemo${name}`, `arn:aws:lambda:${REGION}:${ACCOUNT}:function:IncidentTriageDemo${name}:*`]));
    grant("InventoryRoleState", ["iam:GetRole", "iam:ListAttachedRolePolicies", "iam:ListRolePolicies", "iam:GetRolePolicy"], ["IncidentTriageDemoAppInventoryRole", "IncidentTriageDemoAppInventoryDeniedRole"].map((name) => `arn:aws:iam::${ACCOUNT}:role/${name}`));
    grant("InventoryReadDenyPolicy", ["iam:GetPolicy", "iam:GetPolicyVersion"], [`arn:aws:iam::${ACCOUNT}:policy/IncidentTriageDemoInventoryReadDeny`]);
    grant("InventoryResourcePolicy", ["dynamodb:GetResourcePolicy"], [`arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/IncidentTriageDemoInventory`]);
    grant("OrdinaryManagementHistory", ["cloudtrail:LookupEvents"], ["*"], { StringEquals: { "aws:RequestedRegion": REGION } });
    const runtimeLog = `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/bedrock-agentcore/runtimes/${RUNTIME_NAME}-*`;
    grant("RuntimeLogGroups", ["logs:CreateLogGroup", "logs:DescribeLogStreams", "logs:PutResourcePolicy"], [runtimeLog]);
    grant("RuntimeLogStreams", ["logs:CreateLogStream", "logs:PutLogEvents"], [`${runtimeLog}:log-stream:*`]);
    grant("RuntimeLogDiscovery", ["logs:DescribeLogGroups"], [`arn:aws:logs:${REGION}:${ACCOUNT}:log-group:*`]);
    grant("NativeTraceExport", ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"], ["*"], { StringEquals: { "aws:RequestedRegion": REGION } });
    grant("RuntimeMetrics", ["cloudwatch:PutMetricData"], ["*"], { StringEquals: { "cloudwatch:namespace": "bedrock-agentcore" } });
    const runtime = new agentcore.CfnRuntime(this, "Runtime", {
      agentRuntimeName: RUNTIME_NAME, roleArn: runtimeRole.roleArn, tags: { Project: "IncidentTriageDemo", Component: "agent" },
      agentRuntimeArtifact: { codeConfiguration: { runtime: "PYTHON_3_13", entryPoint: ["opentelemetry-instrument", "main.py"], code: { s3: { bucket: runtimeAsset.s3BucketName, prefix: runtimeAsset.s3ObjectKey } } } },
      networkConfiguration: { networkMode: "PUBLIC" }, protocolConfiguration: "HTTP",
      lifecycleConfiguration: { idleRuntimeSessionTimeout: 300, maxLifetime: 600 },
      environmentVariables: {
        AGENT_RUN_TABLE: runs.tableName, AGENT_SOURCE_BUCKET: EVIDENCE_BUCKET, AGENT_SOURCE_PREFIX: "agent-source/",
        AGENT_ALARM_ARN: ALARM_ARN, AGENT_MODEL_ID: MODEL_ID, AGENT_ACCOUNT_ID: ACCOUNT, AGENT_REGION: REGION,
        AGENT_CANDIDATE_ID: "faulty", AGENT_SOURCE_REVISION: revision.valueAsString, AGENT_ARTIFACT_SHA256: artifactSha256,
        AGENT_ENDPOINT_NAME: "faulty", AGENT_APP_HTTP_API_ID: apiId.valueAsString,
        OTEL_TRACES_SAMPLER: "always_on", OTEL_SERVICE_NAME: RUNTIME_NAME,
        OTEL_PYTHON_DISTRO: "aws_distro", OTEL_PYTHON_CONFIGURATOR: "aws_configurator", OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
        AGENT_OBSERVABILITY_ENABLED: "true", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `https://xray.${REGION}.amazonaws.com/v1/traces`, OTEL_AWS_APPLICATION_SIGNALS_ENABLED: "false",
        OTEL_TRACES_EXPORTER: "otlp", OTEL_LOGS_EXPORTER: "none", OTEL_METRICS_EXPORTER: "none", AWS_GENAI_CONTENT_EXTRACTION_OPT_OUT: "true",
        UNIFIED_TRACES_DESTINATION_ENABLED: "true",
      },
    });
    runtime.node.addDependency(runtimeRole);
    const endpoint = new agentcore.CfnRuntimeEndpoint(this, "FaultyEndpoint", { agentRuntimeId: runtime.attrAgentRuntimeId, agentRuntimeVersion: runtime.attrAgentRuntimeVersion, name: "faulty" });
    const logGroup = new logs.LogGroup(this, "AdapterLogGroup", { logGroupName: `/aws/lambda/${ADAPTER_NAME}`, retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.RETAIN });
    const adapterRole = new iam.Role(this, "AdapterRole", { roleName: "IncidentTriageDemoAlarmAdapterRole", assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"), permissionsBoundary: iam.ManagedPolicy.fromManagedPolicyArn(this, "AdapterBoundary", `arn:aws:iam::${ACCOUNT}:policy/IncidentTriageDemoAlarmAdapterBoundary`) });
    logGroup.grantWrite(adapterRole);
    adapterRole.addToPolicy(new iam.PolicyStatement({ actions: ["bedrock-agentcore:InvokeAgentRuntime"], resources: [runtime.attrAgentRuntimeArn, endpoint.attrAgentRuntimeEndpointArn] }));
    const adapter = new lambda.Function(this, "AlarmAdapter", {
      functionName: ADAPTER_NAME, runtime: lambda.Runtime.PYTHON_3_13, architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset(adapterZip), handler: "alarm_adapter.handler", role: adapterRole,
      timeout: Duration.seconds(290), memorySize: 256, tracing: lambda.Tracing.ACTIVE, logGroup,
      // Native finalization supplies the version only after MMDSv2 pin/readback.
      environment: { AGENT_RUNTIME_ARN: runtime.attrAgentRuntimeArn, AGENT_ENDPOINT_NAME: "faulty", AGENT_RUNTIME_VERSION: "unverified", AGENT_ALARM_ARN: ALARM_ARN, AGENT_SOURCE_REVISION: revision.valueAsString, AGENT_ARTIFACT_SHA256: artifactSha256 },
    });
    new lambda.EventInvokeConfig(this, "AlarmAdapterRetries", { function: adapter, maxEventAge: Duration.minutes(10), retryAttempts: 2 });
    new lambda.CfnPermission(this, "NativeAlarmPermission", { action: "lambda:InvokeFunction", functionName: adapter.functionArn, principal: "lambda.alarms.cloudwatch.amazonaws.com", sourceAccount: ACCOUNT, sourceArn: ALARM_ARN });
    new CfnOutput(this, "SourceRevision", { value: revision.valueAsString });
    new CfnOutput(this, "RuntimeId", { value: runtime.attrAgentRuntimeId });
    new CfnOutput(this, "RuntimeArn", { value: runtime.attrAgentRuntimeArn });
    new CfnOutput(this, "CloudFormationRuntimeVersion", { value: runtime.attrAgentRuntimeVersion, description: "Initial CFN version; deploy-agent verifies final MMDSv2 endpoint version." });
    new CfnOutput(this, "FaultyEndpointArn", { value: endpoint.attrAgentRuntimeEndpointArn });
    new CfnOutput(this, "EndpointName", { value: "faulty" });
    new CfnOutput(this, "AlarmAdapterArn", { value: adapter.functionArn });
    new CfnOutput(this, "RunTableName", { value: runs.tableName });
    new CfnOutput(this, "RuntimeAssetObjectKey", { value: runtimeAsset.s3ObjectKey });
    new CfnOutput(this, "RuntimeArtifactSha256", { value: artifactSha256 });
    new CfnOutput(this, "SourceCapturePrefix", { value: `s3://${EVIDENCE_BUCKET}/agent-source/` });
  }
}
