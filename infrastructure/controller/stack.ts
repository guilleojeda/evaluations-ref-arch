import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CfnOutput, CfnParameter, Duration, RemovalPolicy, Tags, type StackProps } from "aws-cdk-lib";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { AccessLogField, AccessLogFormat } from "aws-cdk-lib/aws-apigateway";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { DemoStack } from "../src/stacks.js";

const ACCOUNT = "027224425948";
const REGION = "us-east-1";
const HTTP_FUNCTION_NAME = "IncidentTriageDemoControllerHttp";
const WORKER_FUNCTION_NAME = "IncidentTriageDemoControllerWorker";
const HTTP_ROLE_NAME = "IncidentTriageDemoControllerHttpRole";
const WORKER_ROLE_NAME = "IncidentTriageDemoControllerWorkerRole";
const HTTP_BOUNDARY_ARN = `arn:aws:iam::${ACCOUNT}:policy/IncidentTriageDemoControllerHttpRuntimeBoundary`;
const WORKER_BOUNDARY_ARN = `arn:aws:iam::${ACCOUNT}:policy/IncidentTriageDemoControllerWorkerRuntimeBoundary`;
const RUN_TABLE_NAME = "IncidentTriageDemoControllerRun";
const HTTP_LOG_GROUP_NAME = `/aws/lambda/${HTTP_FUNCTION_NAME}`;
const WORKER_LOG_GROUP_NAME = `/aws/lambda/${WORKER_FUNCTION_NAME}`;
const GATEWAY_LOG_GROUP_NAME = "/aws/apigateway/IncidentTriageDemoController";
const APP_STACK_NAME = "IncidentTriageDemoApp";
const INVENTORY_TABLE_NAME = "IncidentTriageDemoInventory";
const INVENTORY_ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/IncidentTriageDemoAppInventoryRole`;
const INVENTORY_READ_DENY_POLICY_ARN = `arn:aws:iam::${ACCOUNT}:policy/IncidentTriageDemoInventoryReadDeny`;
const EVIDENCE_BUCKET_NAME = `incident-triage-demo-evidence-${ACCOUNT}-${REGION}`;
const STAGE_ALARM_NAME = "IncidentTriageDemoAppStage5xx";
const STAGE_ALARM_ARN = `arn:aws:cloudwatch:${REGION}:${ACCOUNT}:alarm:${STAGE_ALARM_NAME}`;

export class ControllerStack extends DemoStack {
  constructor(scope: Construct, props: StackProps) {
    super(scope, "controller", props);
    const sourceRevision = new CfnParameter(this, "SourceRevisionInput", { type: "String", minLength: 1, maxLength: 256, description: "Exact checked CI revision used for this controller deployment." });
    sourceRevision.overrideLogicalId("SourceRevision");
    const operatorSecretArn = new CfnParameter(this, "ControllerOperatorSecretArnInput", { type: "String", allowedPattern: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:incident-triage-demo/controller/operator-digest-[A-Za-z0-9]{6}`, description: "Secrets Manager ARN containing the SHA-256 operator bearer digest." });
    operatorSecretArn.overrideLogicalId("ControllerOperatorSecretArn");
    const appSecretArn = new CfnParameter(this, "ControllerAppSecretArnInput", { type: "String", allowedPattern: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:incident-triage-demo/controller/app-bearer-[A-Za-z0-9]{6}`, description: "Secrets Manager ARN containing the checkout bearer." });
    appSecretArn.overrideLogicalId("ControllerAppSecretArn");
    const runTable = new dynamodb.Table(this, "RunTable", { tableName: RUN_TABLE_NAME, billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING }, encryption: dynamodb.TableEncryption.AWS_MANAGED, removalPolicy: RemovalPolicy.RETAIN });
    (runTable.node.defaultChild as dynamodb.CfnTable).overrideLogicalId("RunTable");
    const httpLogGroup = new logs.LogGroup(this, "HttpLogGroup", { logGroupName: HTTP_LOG_GROUP_NAME, retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.RETAIN });
    const workerLogGroup = new logs.LogGroup(this, "WorkerLogGroup", { logGroupName: WORKER_LOG_GROUP_NAME, retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.RETAIN });
    const gatewayLogGroup = new logs.LogGroup(this, "GatewayLogGroup", { logGroupName: GATEWAY_LOG_GROUP_NAME, retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.RETAIN });
    const evidenceBucket = new s3.Bucket(this, "EvidenceBucket", {
      bucketName: EVIDENCE_BUCKET_NAME,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    const httpRole = new iam.Role(this, "HttpRole", { roleName: HTTP_ROLE_NAME, assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"), permissionsBoundary: iam.ManagedPolicy.fromManagedPolicyArn(this, "HttpBoundary", HTTP_BOUNDARY_ARN), description: "HTTP API role for the Incident Triage controller." });
    httpLogGroup.grantWrite(httpRole);
    httpRole.addToPolicy(new iam.PolicyStatement({ sid: "ControllerRunTable", actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"], resources: [runTable.tableArn] }));
    httpRole.addToPolicy(new iam.PolicyStatement({ sid: "ReadOperatorSecret", actions: ["secretsmanager:GetSecretValue"], resources: [operatorSecretArn.valueAsString] }));
    httpRole.addToPolicy(new iam.PolicyStatement({ sid: "ReadStageAlarm", actions: ["cloudwatch:DescribeAlarms"], resources: [STAGE_ALARM_ARN] }));
    const workerRole = new iam.Role(this, "WorkerRole", { roleName: WORKER_ROLE_NAME, assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"), permissionsBoundary: iam.ManagedPolicy.fromManagedPolicyArn(this, "WorkerBoundary", WORKER_BOUNDARY_ARN), description: "Action worker role for the Incident Triage controller." });
    workerLogGroup.grantWrite(workerRole);
    workerRole.addToPolicy(new iam.PolicyStatement({ sid: "ControllerRunTable", actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"], resources: [runTable.tableArn] }));
    workerRole.addToPolicy(new iam.PolicyStatement({ sid: "ReadCheckoutSecret", actions: ["secretsmanager:GetSecretValue"], resources: [appSecretArn.valueAsString] }));
    workerRole.addToPolicy(new iam.PolicyStatement({ sid: "ReadAppRelease", actions: ["cloudformation:DescribeStacks", "cloudformation:ListStackResources"], resources: [`arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${APP_STACK_NAME}/*`] }));
    workerRole.addToPolicy(new iam.PolicyStatement({ sid: "ReadAppFunctionSettings", actions: ["lambda:GetAlias", "lambda:GetFunctionConfiguration", "lambda:GetFunctionConcurrency"], resources: [`arn:aws:lambda:${REGION}:${ACCOUNT}:function:IncidentTriageDemoCheckout`, `arn:aws:lambda:${REGION}:${ACCOUNT}:function:IncidentTriageDemoCheckout:*`, `arn:aws:lambda:${REGION}:${ACCOUNT}:function:IncidentTriageDemoInventory`, `arn:aws:lambda:${REGION}:${ACCOUNT}:function:IncidentTriageDemoInventory:*`] }));
    workerRole.addToPolicy(new iam.PolicyStatement({ sid: "ReadInventoryPolicy", actions: ["dynamodb:GetResourcePolicy"], resources: [`arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${INVENTORY_TABLE_NAME}`] }));
    workerRole.addToPolicy(new iam.PolicyStatement({ sid: "ReadInventoryRolePolicyAttachments", actions: ["iam:ListAttachedRolePolicies"], resources: [INVENTORY_ROLE_ARN] }));
    workerRole.addToPolicy(new iam.PolicyStatement({ sid: "ReadInventoryReadDenyPolicy", actions: ["iam:GetPolicy", "iam:GetPolicyVersion"], resources: [INVENTORY_READ_DENY_POLICY_ARN] }));
    workerRole.addToPolicy(new iam.PolicyStatement({ sid: "ManageInventoryReadDenyAttachment", actions: ["iam:AttachRolePolicy", "iam:DetachRolePolicy"], resources: [INVENTORY_ROLE_ARN], conditions: { StringEquals: { "iam:PolicyARN": INVENTORY_READ_DENY_POLICY_ARN } } }));
    workerRole.addToPolicy(new iam.PolicyStatement({ sid: "ReadStageAlarm", actions: ["cloudwatch:DescribeAlarms", "cloudwatch:DescribeAlarmHistory"], resources: [STAGE_ALARM_ARN] }));
    workerRole.addToPolicy(new iam.PolicyStatement({ sid: "WriteConfigurationCheckpoint", actions: ["s3:PutObject"], resources: [evidenceBucket.arnForObjects("configuration/*")] }));

    const backendDirectory = resolve(process.cwd(), ".artifacts/controller/backend");
    for (const artifact of ["index.mjs", "worker.mjs"]) {
      if (!existsSync(resolve(backendDirectory, artifact))) throw new Error(`Controller backend artifact is missing: ${resolve(backendDirectory, artifact)}`);
    }
    const httpRuntime = lambda.Code.fromAsset(backendDirectory, { exclude: ["worker.mjs"] });
    const workerRuntime = lambda.Code.fromAsset(backendDirectory, { exclude: ["index.mjs", "web", "web/**"] });
    const worker = new lambda.Function(this, "WorkerFunction", { functionName: WORKER_FUNCTION_NAME, description: "Finite controller action worker.", runtime: lambda.Runtime.NODEJS_24_X, architecture: lambda.Architecture.X86_64, code: workerRuntime, handler: "worker.handler", role: workerRole, timeout: Duration.seconds(90), memorySize: 256, logGroup: workerLogGroup, environment: { CONTROLLER_RUN_TABLE: runTable.tableName, CONTROLLER_APP_SECRET_ARN: appSecretArn.valueAsString, CONTROLLER_SOURCE_REVISION: sourceRevision.valueAsString, CONTROLLER_EVIDENCE_BUCKET: evidenceBucket.bucketName } });
    new lambda.EventInvokeConfig(this, "WorkerInvokeConfig", { function: worker, maxEventAge: Duration.seconds(60), retryAttempts: 0 });
    const http = new lambda.Function(this, "HttpFunction", { functionName: HTTP_FUNCTION_NAME, description: "Authenticated controller API and dashboard.", runtime: lambda.Runtime.NODEJS_24_X, architecture: lambda.Architecture.X86_64, code: httpRuntime, handler: "index.handler", role: httpRole, timeout: Duration.seconds(10), memorySize: 256, logGroup: httpLogGroup, environment: { CONTROLLER_RUN_TABLE: runTable.tableName, CONTROLLER_OPERATOR_SECRET_ARN: operatorSecretArn.valueAsString, CONTROLLER_WORKER_NAME: worker.functionName, CONTROLLER_SOURCE_REVISION: sourceRevision.valueAsString } });
    httpRole.addToPolicy(new iam.PolicyStatement({ sid: "InvokeControllerWorker", actions: ["lambda:InvokeFunction"], resources: [worker.functionArn] }));

    const api = new apigatewayv2.HttpApi(this, "HttpApi", { apiName: "IncidentTriageDemoController", createDefaultStage: false });
    Tags.of(api).add("Name", "IncidentTriageDemoController", { includeResourceTypes: ["AWS::ApiGatewayV2::Api"] });
    const integration = new integrations.HttpLambdaIntegration("HttpIntegration", http, { payloadFormatVersion: apigatewayv2.PayloadFormatVersion.VERSION_2_0 });
    api.addRoutes({ path: "/{proxy+}", methods: [apigatewayv2.HttpMethod.ANY], integration });
    api.addRoutes({ path: "/", methods: [apigatewayv2.HttpMethod.ANY], integration });
    const stage = api.addStage("DefaultStage", { stageName: "$default", autoDeploy: true, accessLogSettings: { destination: new apigatewayv2.LogGroupLogDestination(gatewayLogGroup), format: AccessLogFormat.custom(JSON.stringify({ requestId: AccessLogField.contextRequestId(), routeKey: AccessLogField.contextRouteKey(), status: AccessLogField.contextStatus(), responseLatency: AccessLogField.contextResponseLatency(), integrationLatency: AccessLogField.contextIntegrationLatency(), integrationStatus: AccessLogField.contextIntegrationStatus(), integrationError: AccessLogField.contextIntegrationErrorMessage() })) } });

    new CfnOutput(this, "SourceRevision", { value: sourceRevision.valueAsString });
    new CfnOutput(this, "SiteUrl", { value: api.apiEndpoint });
    new CfnOutput(this, "ApiId", { value: api.httpApiId });
    new CfnOutput(this, "HttpFunctionName", { value: http.functionName });
    new CfnOutput(this, "WorkerFunctionName", { value: worker.functionName });
    new CfnOutput(this, "RunTableName", { value: runTable.tableName });
    new CfnOutput(this, "HttpLogGroupName", { value: httpLogGroup.logGroupName });
    new CfnOutput(this, "WorkerLogGroupName", { value: workerLogGroup.logGroupName });
    new CfnOutput(this, "GatewayLogGroupName", { value: gatewayLogGroup.logGroupName });
    new CfnOutput(this, "EvidenceBucketName", { value: evidenceBucket.bucketName });
  }
}
