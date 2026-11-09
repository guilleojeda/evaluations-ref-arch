import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  CfnOutput,
  CfnParameter,
  Duration,
  Fn,
  RemovalPolicy,
  Tags,
  type StackProps,
} from "aws-cdk-lib";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { AccessLogField, AccessLogFormat } from "aws-cdk-lib/aws-apigateway";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { DemoStack } from "../src/stacks.js";

const PRODUCT_SKU = "demo-widget";
const PRODUCT_CREDENTIAL_GENERATION = "initial";
const WEB_BUCKET_NAME = "incident-triage-demo-web-027224425948-us-east-1";
const CHECKOUT_FUNCTION_NAME = "IncidentTriageDemoCheckout";
const INVENTORY_FUNCTION_NAME = "IncidentTriageDemoInventory";
const CHECKOUT_ROLE_NAME = "IncidentTriageDemoAppCheckoutRole";
const INVENTORY_ROLE_NAME = "IncidentTriageDemoAppInventoryRole";
const INVENTORY_DENIED_ROLE_NAME = "IncidentTriageDemoAppInventoryDeniedRole";
const CHECKOUT_BOUNDARY_ARN = "arn:aws:iam::027224425948:policy/IncidentTriageDemoAppCheckoutRuntimeBoundary";
const INVENTORY_BOUNDARY_ARN = "arn:aws:iam::027224425948:policy/IncidentTriageDemoAppInventoryRuntimeBoundary";
const INVENTORY_READ_DENY_POLICY_ARN = "arn:aws:iam::027224425948:policy/IncidentTriageDemoInventoryReadDeny";
const INVENTORY_VARIANTS_MANIFEST_BUCKET = "cdk-evaltalk-assets-027224425948-us-east-1";
const ORDERS_TABLE_NAME = "IncidentTriageDemoOrders";
const INVENTORY_TABLE_NAME = "IncidentTriageDemoInventory";
const CHECKOUT_LOG_GROUP_NAME = `/aws/lambda/${CHECKOUT_FUNCTION_NAME}`;
const INVENTORY_LOG_GROUP_NAME = `/aws/lambda/${INVENTORY_FUNCTION_NAME}`;
const GATEWAY_LOG_GROUP_NAME = "/aws/apigateway/IncidentTriageDemoApp";
const BASELINE_MEMORY_MB = 256;
const CHECKOUT_TIMEOUT_SECONDS = 12;
const INVENTORY_TIMEOUT_SECONDS = 6;

/**
 * The product stack owns only the app's named resources. The workflow passes
 * SourceRevision on each release, while the digest is intentionally a required
 * NoEcho parameter on the first deployment and is retained by CloudFormation
 * on subsequent updates.
 */
export class AppStack extends DemoStack {
  constructor(scope: Construct, props: StackProps) {
    super(scope, "app", props);

    const sourceRevision = new CfnParameter(this, "SourceRevisionInput", {
      type: "String",
      description: "Exact checked CI revision that produced this app assembly.",
      minLength: 1,
      maxLength: 256,
    });
    sourceRevision.overrideLogicalId("SourceRevision");
    const presenterCredentialDigest = new CfnParameter(this, "PresenterCredentialDigestInput", {
      type: "String",
      description: "SHA-256 digest of the presenter bearer credential.",
      noEcho: true,
      minLength: 64,
      maxLength: 64,
      allowedPattern: "^[A-Fa-f0-9]{64}$",
    });
    presenterCredentialDigest.overrideLogicalId("PresenterCredentialDigest");
    const presenterCredentialGeneration = new CfnParameter(this, "PresenterCredentialGenerationInput", {
      type: "String",
      description: "Opaque credential generation used to bind this published checkout version.",
      default: PRODUCT_CREDENTIAL_GENERATION,
      minLength: 1,
      maxLength: 128,
      allowedPattern: "^[A-Za-z0-9._-]+$",
    });
    presenterCredentialGeneration.overrideLogicalId("PresenterCredentialGeneration");

    const webBucket = new s3.Bucket(this, "WebBucket", {
      bucketName: WEB_BUCKET_NAME,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      versioned: true,
    });

    const ordersTable = new dynamodb.Table(this, "OrdersTable", {
      tableName: ORDERS_TABLE_NAME,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: "orderId", type: dynamodb.AttributeType.STRING },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const inventoryTable = new dynamodb.Table(this, "InventoryTable", {
      tableName: INVENTORY_TABLE_NAME,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: "sku", type: dynamodb.AttributeType.STRING },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const checkoutLogGroup = new logs.LogGroup(this, "CheckoutLogGroup", {
      logGroupName: CHECKOUT_LOG_GROUP_NAME,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const inventoryLogGroup = new logs.LogGroup(this, "InventoryLogGroup", {
      logGroupName: INVENTORY_LOG_GROUP_NAME,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const gatewayLogGroup = new logs.LogGroup(this, "GatewayLogGroup", {
      logGroupName: GATEWAY_LOG_GROUP_NAME,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const checkoutRole = new iam.Role(this, "CheckoutRole", {
      roleName: CHECKOUT_ROLE_NAME,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      permissionsBoundary: iam.ManagedPolicy.fromManagedPolicyArn(this, "CheckoutRuntimeBoundary", CHECKOUT_BOUNDARY_ARN),
      description: "Runtime role for the Incident Triage checkout Lambda.",
    });
    checkoutLogGroup.grantWrite(checkoutRole);
    checkoutRole.addToPolicy(new iam.PolicyStatement({
      sid: "ReadOrdersForIdempotency",
      actions: ["dynamodb:GetItem"],
      resources: [ordersTable.tableArn],
    }));
    checkoutRole.addToPolicy(new iam.PolicyStatement({
      sid: "PutOrderInsideTransaction",
      actions: ["dynamodb:PutItem"],
      resources: [ordersTable.tableArn],
      conditions: { StringEquals: { "dynamodb:EnclosingOperation": "TransactWriteItems" } },
    }));
    checkoutRole.addToPolicy(new iam.PolicyStatement({
      sid: "UpdateStockInsideTransaction",
      actions: ["dynamodb:UpdateItem"],
      resources: [inventoryTable.tableArn],
      conditions: { StringEquals: { "dynamodb:EnclosingOperation": "TransactWriteItems" } },
    }));

    /*
     * The checkout function invokes the qualified Inventory live alias. This
     * statement is added after the alias is created below, because its ARN is
     * the boundary that prevents invoking any other function or qualifier.
     */

    const inventoryRole = new iam.Role(this, "InventoryRole", {
      roleName: INVENTORY_ROLE_NAME,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      permissionsBoundary: iam.ManagedPolicy.fromManagedPolicyArn(this, "InventoryRuntimeBoundary", INVENTORY_BOUNDARY_ARN),
      description: "Read-only runtime role for the Incident Triage inventory Lambda.",
    });
    inventoryLogGroup.grantWrite(inventoryRole);
    inventoryRole.addToPolicy(new iam.PolicyStatement({
      sid: "ReadSeededProduct",
      actions: ["dynamodb:GetItem"],
      resources: [inventoryTable.tableArn],
    }));
    const inventoryDeniedRole = new iam.Role(this, "InventoryDeniedRole", {
      roleName: INVENTORY_DENIED_ROLE_NAME,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      permissionsBoundary: iam.ManagedPolicy.fromManagedPolicyArn(this, "InventoryDeniedRuntimeBoundary", INVENTORY_BOUNDARY_ARN),
      description: "Prepared denied read role for the Incident Triage inventory Lambda.",
    });
    inventoryLogGroup.grantWrite(inventoryDeniedRole);
    inventoryDeniedRole.addToPolicy(new iam.PolicyStatement({
      sid: "ReadSeededProduct",
      actions: ["dynamodb:GetItem"],
      resources: [inventoryTable.tableArn],
    }));
    inventoryDeniedRole.addManagedPolicy(
      iam.ManagedPolicy.fromManagedPolicyArn(this, "InventoryReadDenyPolicy", INVENTORY_READ_DENY_POLICY_ARN),
    );

    const backendDirectory = resolve(process.cwd(), ".artifacts/app/backend");
    for (const artifact of ["index.mjs", "inventory.mjs"]) {
      if (!existsSync(resolve(backendDirectory, artifact))) {
        throw new Error(`App backend artifact is missing: ${resolve(backendDirectory, artifact)}`);
      }
    }

    const inventoryFunction = new lambda.Function(this, "InventoryFunction", {
      functionName: INVENTORY_FUNCTION_NAME,
      description: "Read-only seeded product lookup for the Incident Triage checkout.",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.X86_64,
      code: lambda.Code.fromAsset(backendDirectory),
      handler: "inventory.handler",
      role: inventoryRole,
      memorySize: BASELINE_MEMORY_MB,
      timeout: Duration.seconds(INVENTORY_TIMEOUT_SECONDS),
      environment: {
        APP_ENVIRONMENT: "demo",
        SOURCE_REVISION: sourceRevision.valueAsString,
        INVENTORY_TABLE_NAME: inventoryTable.tableArn,
        PRODUCT_SKU,
      },
      logGroup: inventoryLogGroup,
    });
    const inventoryVersion = inventoryFunction.currentVersion;
    // CurrentVersion's synthesized hash does not necessarily include a
    // parameter token. A version description makes every checked release,
    // including a frontend-only release, replace the numeric version so logs
    // and the SourceRevision output cannot disagree.
    (inventoryVersion.node.defaultChild as lambda.CfnVersion).description = sourceRevision.valueAsString;
    const inventoryLive = new lambda.Alias(this, "InventoryLiveAlias", {
      aliasName: "live",
      description: "Stable single-target alias for the healthy Inventory release.",
      version: inventoryVersion,
    });
    checkoutRole.addToPolicy(new iam.PolicyStatement({
      sid: "InvokeInventoryLiveAlias",
      actions: ["lambda:InvokeFunction"],
      resources: [inventoryLive.functionArn],
    }));

    const checkoutFunction = new lambda.Function(this, "CheckoutFunction", {
      functionName: CHECKOUT_FUNCTION_NAME,
      description: "Authenticated checkout API for the Incident Triage demo.",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.X86_64,
      code: lambda.Code.fromAsset(backendDirectory),
      handler: "index.handler",
      role: checkoutRole,
      memorySize: BASELINE_MEMORY_MB,
      timeout: Duration.seconds(CHECKOUT_TIMEOUT_SECONDS),
      environment: {
        APP_ENVIRONMENT: "demo",
        SOURCE_REVISION: sourceRevision.valueAsString,
        PRESENTER_CREDENTIAL_DIGEST: presenterCredentialDigest.valueAsString,
        PRESENTER_CREDENTIAL_GENERATION: presenterCredentialGeneration.valueAsString,
        ORDERS_TABLE_NAME: ordersTable.tableName,
        INVENTORY_TABLE_NAME: inventoryTable.tableName,
        INVENTORY_FUNCTION_NAME: inventoryLive.functionArn,
        PRODUCT_SKU,
      },
      logGroup: checkoutLogGroup,
    });
    const checkoutVersion = checkoutFunction.currentVersion;
    (checkoutVersion.node.defaultChild as lambda.CfnVersion).description = Fn.join(" ", [
      sourceRevision.valueAsString,
      presenterCredentialGeneration.valueAsString,
    ]);
    const checkoutLive = new lambda.Alias(this, "CheckoutLiveAlias", {
      aliasName: "live",
      description: "Stable single-target alias for the healthy Checkout release.",
      version: checkoutVersion,
    });

    // The HTTP API has no implicit catch-all: these are the three business routes.
    const api = new apigatewayv2.HttpApi(this, "HttpApi", {
      apiName: "IncidentTriageDemoApp",
      createDefaultStage: false,
    });
    Tags.of(api).add("Name", "IncidentTriageDemoApp", {
      includeResourceTypes: ["AWS::ApiGatewayV2::Api"],
    });
    const checkoutIntegration = new integrations.HttpLambdaIntegration(
      "CheckoutIntegration",
      checkoutLive,
      { payloadFormatVersion: apigatewayv2.PayloadFormatVersion.VERSION_2_0 },
    );
    api.addRoutes({ path: "/api/products", methods: [apigatewayv2.HttpMethod.GET], integration: checkoutIntegration });
    api.addRoutes({ path: "/api/checkout", methods: [apigatewayv2.HttpMethod.POST], integration: checkoutIntegration });
    api.addRoutes({ path: "/api/orders/{checkoutId}", methods: [apigatewayv2.HttpMethod.GET], integration: checkoutIntegration });
    const defaultStage = api.addStage("DefaultStage", {
      stageName: "$default",
      autoDeploy: true,
      accessLogSettings: {
        destination: new apigatewayv2.LogGroupLogDestination(gatewayLogGroup),
        format: AccessLogFormat.custom(JSON.stringify({
          requestId: AccessLogField.contextRequestId(),
          routeKey: AccessLogField.contextRouteKey(),
          status: AccessLogField.contextStatus(),
          responseLatency: AccessLogField.contextResponseLatency(),
          integrationLatency: AccessLogField.contextIntegrationLatency(),
          integrationStatus: AccessLogField.contextIntegrationStatus(),
          integrationError: AccessLogField.contextIntegrationErrorMessage(),
        })),
      },
    });
    const stageAlarm = new cloudwatch.CfnAlarm(this, "Stage5xxAlarm", {
      alarmName: "IncidentTriageDemoAppStage5xx",
      namespace: "AWS/ApiGateway",
      metricName: "5xx",
      dimensions: [
        { name: "ApiId", value: api.apiId },
        { name: "Stage", value: "$default" },
      ],
      statistic: "Sum",
      period: 60,
      threshold: 1,
      comparisonOperator: "GreaterThanOrEqualToThreshold",
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: "notBreaching",
      actionsEnabled: false,
    });

    const webOrigin = origins.S3BucketOrigin.withOriginAccessControl(webBucket);
    const apiDomain = Fn.select(2, Fn.split("/", api.apiEndpoint));
    const apiOrigin = new origins.HttpOrigin(apiDomain, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
    });
    const distribution = new cloudfront.Distribution(this, "WebDistribution", {
      comment: "Incident Triage Demo private S3 site and uncached API origin",
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: webOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        compress: true,
      },
      additionalBehaviors: {
        "assets/*": {
          origin: webOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          compress: true,
        },
        "api/*": {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          compress: false,
        },
      },
      errorResponses: [404, 500, 502, 503, 504].map((httpStatus) => ({
        httpStatus,
        ttl: Duration.seconds(0),
      })),
    });

    // CI publishes hashed assets first, then index.html with revalidation
    // headers. The bucket is versioned and never pruned so older pages remain
    // usable while a distribution is converging.
    (ordersTable.node.defaultChild as dynamodb.CfnTable).overrideLogicalId("Orders");
    (inventoryTable.node.defaultChild as dynamodb.CfnTable).overrideLogicalId("Inventory");
    const inventoryTableLogicalId = (inventoryTable.node.defaultChild as dynamodb.CfnTable).logicalId;
    const ordersTableLogicalId = (ordersTable.node.defaultChild as dynamodb.CfnTable).logicalId;
    new CfnOutput(this, "SourceRevision", {
      value: sourceRevision.valueAsString,
      description: "Exact checked CI revision used for this app deployment.",
    });
    new CfnOutput(this, "PresenterCredentialGeneration", {
      value: presenterCredentialGeneration.valueAsString,
      description: "Opaque presenter credential generation bound to the active release.",
    });
    new CfnOutput(this, "WebBucketName", { value: webBucket.bucketName });
    new CfnOutput(this, "DistributionId", { value: distribution.distributionId });
    new CfnOutput(this, "SiteUrl", { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, "ApiUrl", { value: api.apiEndpoint });
    new CfnOutput(this, "CheckoutFunctionName", { value: checkoutFunction.functionName });
    new CfnOutput(this, "InventoryFunctionName", { value: inventoryFunction.functionName });
    new CfnOutput(this, "CheckoutLiveAliasArn", { value: checkoutLive.functionArn });
    new CfnOutput(this, "InventoryLiveAliasArn", { value: inventoryLive.functionArn });
    new CfnOutput(this, "CheckoutLiveVersion", { value: checkoutVersion.version });
    new CfnOutput(this, "InventoryLiveVersion", { value: inventoryVersion.version });
    new CfnOutput(this, "OrdersTableName", { value: ordersTable.tableName });
    new CfnOutput(this, "InventoryTableName", { value: inventoryTable.tableName });
    new CfnOutput(this, "OrdersTableLogicalId", { value: ordersTableLogicalId });
    new CfnOutput(this, "InventoryTableLogicalId", { value: inventoryTableLogicalId });
    new CfnOutput(this, "ProductSku", { value: PRODUCT_SKU });
    new CfnOutput(this, "CheckoutLogGroupName", { value: checkoutLogGroup.logGroupName });
    new CfnOutput(this, "InventoryLogGroupName", { value: inventoryLogGroup.logGroupName });
    new CfnOutput(this, "GatewayLogGroupName", { value: gatewayLogGroup.logGroupName });
    new CfnOutput(this, "CheckoutMemorySize", { value: String(BASELINE_MEMORY_MB) });
    new CfnOutput(this, "InventoryMemorySize", { value: String(BASELINE_MEMORY_MB) });
    new CfnOutput(this, "CheckoutTimeoutSeconds", { value: String(CHECKOUT_TIMEOUT_SECONDS) });
    new CfnOutput(this, "InventoryTimeoutSeconds", { value: String(INVENTORY_TIMEOUT_SECONDS) });
    new CfnOutput(this, "CheckoutReservedConcurrency", { value: "unreserved" });
    new CfnOutput(this, "InventoryReservedConcurrency", { value: "unreserved" });
    new CfnOutput(this, "InventoryResourcePolicy", { value: "absent" });
    new CfnOutput(this, "StageAlarmName", { value: stageAlarm.ref });
    new CfnOutput(this, "StageAlarmArn", { value: stageAlarm.attrArn });
    new CfnOutput(this, "InventoryRoleArn", { value: inventoryRole.roleArn });
    new CfnOutput(this, "InventoryDeniedRoleArn", { value: inventoryDeniedRole.roleArn });
    new CfnOutput(this, "InventoryVariantsManifestBucket", { value: INVENTORY_VARIANTS_MANIFEST_BUCKET });
    new CfnOutput(this, "InventoryVariantsManifestKey", {
      value: Fn.join("", ["releases/app/", sourceRevision.valueAsString, "/inventory-variants.json"]),
    });

    distribution.node.addDependency(defaultStage);
  }
}
