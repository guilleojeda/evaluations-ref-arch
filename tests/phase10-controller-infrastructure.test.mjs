import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const region = 'us-east-1';
const appTemplatePath = new URL('../.artifacts/app/cdk/IncidentTriageDemoApp.template.json', import.meta.url);
const controllerTemplatePath = new URL('../.artifacts/controller/cdk/IncidentTriageDemoController.template.json', import.meta.url);
const bootstrapPath = new URL('../infrastructure/bootstrap/phase0-cfn-execution-policy.yaml', import.meta.url);
const httpRoleName = 'IncidentTriageDemoControllerHttpRole';
const workerRoleName = 'IncidentTriageDemoControllerWorkerRole';
const httpBoundaryName = 'IncidentTriageDemoControllerHttpRuntimeBoundary';
const workerBoundaryName = 'IncidentTriageDemoControllerWorkerRuntimeBoundary';

// Reuse the YAML parser shipped with the repository's pinned aws-cdk-lib dependency.
const require = createRequire(import.meta.url);
const cdkRequire = createRequire(require.resolve('aws-cdk-lib'));
const { parse: parseYaml } = cdkRequire('yaml');

function readJson(path, description) {
  assert.ok(existsSync(path), `${description} synthesized template is missing; run its pinned check/synth first`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function controllerTemplate() {
  return readJson(controllerTemplatePath, 'controller');
}

function appTemplate() {
  return readJson(appTemplatePath, 'app');
}

function bootstrapTemplate() {
  return parseYaml(readFileSync(bootstrapPath, 'utf8'), {
    customTags: [{ tag: '!Sub', resolve: (value) => ({ 'Fn::Sub': value }) }],
  });
}

function resourcesOf(resources, type) {
  assert.ok(resources && typeof resources === 'object', 'missing CloudFormation Resources section');
  return Object.entries(resources).filter(([, resource]) => resource.Type === type);
}

function findOne(entries, predicate, message) {
  const matches = entries.filter(([, resource]) => predicate(resource));
  assert.equal(matches.length, 1, message);
  return matches[0];
}

function namedRole(resources, roleName) {
  return findOne(resourcesOf(resources, 'AWS::IAM::Role'),
    (resource) => resource.Properties.RoleName === roleName,
    `missing ${roleName}`);
}

function roleStatements(resources, roleId) {
  const role = resources[roleId];
  assert.equal(role?.Type, 'AWS::IAM::Role', `missing IAM role ${roleId}`);
  const inline = (role.Properties.Policies ?? []).map(({ PolicyDocument }) => PolicyDocument);
  const attached = resourcesOf(resources, 'AWS::IAM::Policy')
    .filter(([, policy]) => policy.Properties.Roles?.some(({ Ref }) => Ref === roleId))
    .map(([, policy]) => policy.Properties.PolicyDocument);
  return [...inline, ...attached].flatMap(({ Statement }) => Statement ?? []);
}

function boundaryStatements(resources, boundaryName) {
  const [, policy] = findOne(resourcesOf(resources, 'AWS::IAM::ManagedPolicy'),
    (resource) => resource.Properties.ManagedPolicyName === boundaryName,
    `missing bootstrap boundary ${boundaryName}`);
  return policy.Properties.PolicyDocument.Statement;
}

function actionList(statement) {
  return [statement.Action].flat().filter((value) => typeof value === 'string');
}

function resourceList(statement) {
  return [statement.Resource].flat().filter((value) => value !== undefined);
}

function actionMatches(pattern, action) {
  if (typeof pattern !== 'string') return false;
  const escaped = pattern.split('*').map((part) => RegExp.escape(part)).join('.*');
  return new RegExp(`^${escaped}$`, 'i').test(action);
}

function allowed(statements) {
  return statements.filter(({ Effect }) => Effect === 'Allow');
}

function allowsAction(statements, action) {
  return allowed(statements).some((statement) =>
    actionList(statement).some((pattern) => actionMatches(pattern, action)));
}

function assertNoAllowedActions(statements, actions, message) {
  for (const action of actions) {
    assert.equal(allowsAction(statements, action), false, `${message}: ${action}`);
  }
}

function assertRegionalMetricRead(statements, owner) {
  const grants = allowed(statements).filter((statement) =>
    actionList(statement).some((pattern) => actionMatches(pattern, 'cloudwatch:GetMetricData')));
  assert.equal(grants.length, 1, `${owner} needs one CloudWatch GetMetricData grant`);
  assert.deepEqual(actionList(grants[0]), ['cloudwatch:GetMetricData'],
    `${owner} must grant only the native metric read action`);
  assert.deepEqual(resourceList(grants[0]), ['*'],
    `${owner} must use Resource * because GetMetricData does not support per-metric resource ARNs`);
  assert.equal(grants[0].Condition?.StringEquals?.['aws:RequestedRegion'], region,
    `${owner} must limit metric reads to ${region}`);
}

function secretReadStatements(statements) {
  return allowed(statements).filter((statement) =>
    actionList(statement).some((pattern) => actionMatches(pattern, 'secretsmanager:GetSecretValue')));
}

test('HTTP role and its boundary grant only regional native metric reads; worker gains no metric grant', () => {
  const controller = controllerTemplate();
  const [httpId] = namedRole(controller.Resources, httpRoleName);
  const [workerId] = namedRole(controller.Resources, workerRoleName);
  const bootstrap = bootstrapTemplate();
  const httpStatements = roleStatements(controller.Resources, httpId);
  const workerStatements = roleStatements(controller.Resources, workerId);
  const httpBoundary = boundaryStatements(bootstrap.Resources, httpBoundaryName);
  const workerBoundary = boundaryStatements(bootstrap.Resources, workerBoundaryName);

  assertRegionalMetricRead(httpStatements, httpRoleName);
  assertRegionalMetricRead(httpBoundary, httpBoundaryName);
  assertNoAllowedActions(workerStatements, ['cloudwatch:GetMetricData'],
    `${workerRoleName} already owns the finite workload and needs no native metric access`);
  assertNoAllowedActions(workerBoundary, ['cloudwatch:GetMetricData'],
    `${workerBoundaryName} must not add native metric access`);
  for (const [owner, statements] of [
    [httpRoleName, httpStatements],
    [httpBoundaryName, httpBoundary],
  ]) {
    assertNoAllowedActions(statements, ['cloudwatch:PutMetricData'],
      `${owner} observes native metrics and cannot publish metrics`);
  }
});

test('HTTP observation retains secret, IAM, and AgentCore isolation', () => {
  const controller = controllerTemplate();
  const [httpId] = namedRole(controller.Resources, httpRoleName);
  const [workerId] = namedRole(controller.Resources, workerRoleName);
  const bootstrap = bootstrapTemplate();
  const httpStatements = roleStatements(controller.Resources, httpId);
  const workerStatements = roleStatements(controller.Resources, workerId);
  const httpBoundary = boundaryStatements(bootstrap.Resources, httpBoundaryName);
  const workerBoundary = boundaryStatements(bootstrap.Resources, workerBoundaryName);

  for (const [owner, statements] of [
    [httpRoleName, httpStatements],
    [httpBoundaryName, httpBoundary],
  ]) {
    const secretReads = secretReadStatements(statements);
    assert.equal(secretReads.length, 1, `${owner} retains only its operator credential read`);
    const secretResources = JSON.stringify(secretReads.map(resourceList));
    assert.match(secretResources, /operator-digest|ControllerOperatorSecretArn/,
      `${owner} must keep the operator digest secret available`);
    assert.doesNotMatch(secretResources, /app-bearer|ControllerAppSecretArn/,
      `${owner} must not read the checkout bearer secret`);
  }

  for (const [owner, statements] of [
    [workerRoleName, workerStatements],
    [workerBoundaryName, workerBoundary],
  ]) {
    const secretReads = secretReadStatements(statements);
    assert.equal(secretReads.length, 1, `${owner} retains only its checkout credential read`);
    const secretResources = JSON.stringify(secretReads.map(resourceList));
    assert.match(secretResources, /app-bearer|ControllerAppSecretArn/,
      `${owner} must retain the checkout bearer secret for business traffic`);
    assert.doesNotMatch(secretResources, /operator-digest|ControllerOperatorSecretArn/,
      `${owner} must not read the operator credential secret`);
  }

  const iamWrites = [
    'iam:AttachRolePolicy', 'iam:CreatePolicy', 'iam:CreatePolicyVersion', 'iam:CreateRole',
    'iam:DeletePolicy', 'iam:DeletePolicyVersion', 'iam:DeleteRole', 'iam:DeleteRolePolicy',
    'iam:DetachRolePolicy', 'iam:PassRole', 'iam:PutRolePolicy', 'iam:PutRolePermissionsBoundary',
    'iam:SetDefaultPolicyVersion', 'iam:TagRole', 'iam:UntagRole', 'iam:UpdateAssumeRolePolicy',
    'iam:UpdateRole',
  ];
  const httpFunctionMutations = [
    'lambda:DeleteFunctionConcurrency', 'lambda:PublishVersion', 'lambda:PutFunctionConcurrency',
    'lambda:UpdateAlias', 'lambda:UpdateFunctionCode', 'lambda:UpdateFunctionConfiguration',
    'lambda:UpdateFunctionEventInvokeConfig',
  ];
  const prohibitedHttpActions = [
    ...iamWrites,
    ...httpFunctionMutations,
    'bedrock-agentcore:InvokeAgentRuntime',
    'cloudwatch:PutMetricData',
  ];
  for (const [owner, statements] of [
    [httpRoleName, httpStatements],
    [httpBoundaryName, httpBoundary],
  ]) {
    assertNoAllowedActions(statements, prohibitedHttpActions,
      `${owner} remains an authenticated observation path without app/IAM/agent/metric mutations`);
  }
});

test('controller keeps its existing finite worker and resource footprint', () => {
  const controller = controllerTemplate();
  const resources = controller.Resources;
  const functions = resourcesOf(resources, 'AWS::Lambda::Function');
  assert.deepEqual(functions.map(([, resource]) => resource.Properties.FunctionName).sort(), [
    'IncidentTriageDemoControllerHttp',
    'IncidentTriageDemoControllerWorker',
  ], 'surge observation reuses the existing HTTP and finite worker functions');
  assert.equal(resourcesOf(resources, 'AWS::ApiGatewayV2::Api').length, 1,
    'surge observation reuses the existing controller API');
  assert.deepEqual(resourcesOf(resources, 'AWS::DynamoDB::Table')
    .map(([, resource]) => resource.Properties.TableName), ['IncidentTriageDemoControllerRun'],
  'surge observation reuses the existing controller run table');
  for (const type of [
    'AWS::SQS::Queue',
    'AWS::Events::Rule',
    'AWS::Lambda::EventSourceMapping',
    'AWS::ECS::Service',
    'AWS::ECS::TaskDefinition',
    'AWS::StepFunctions::StateMachine',
  ]) {
    assert.equal(resourcesOf(resources, type).length, 0,
      `surge observation must not add a queue, scheduled producer, or continuous worker (${type})`);
  }

  const [workerId, worker] = findOne(functions,
    (resource) => resource.Properties.FunctionName === 'IncidentTriageDemoControllerWorker',
    'missing the existing finite controller worker');
  assert.ok(Number.isInteger(worker.Properties.Timeout) && worker.Properties.Timeout > 0 &&
    worker.Properties.Timeout <= 90,
  'the existing worker remains finite and bounded to at most 90 seconds');
  const invokeConfigs = resourcesOf(resources, 'AWS::Lambda::EventInvokeConfig')
    .filter(([, config]) => config.Properties.FunctionName?.Ref === workerId);
  assert.equal(invokeConfigs.length, 1, 'the existing worker keeps its asynchronous invoke configuration');
  assert.equal(invokeConfigs[0][1].Properties.DestinationConfig, undefined,
    'finite worker execution does not add a persistent event destination');
  assert.equal(invokeConfigs[0][1].Properties.MaximumRetryAttempts, 0,
    'finite worker delivery remains non-retrying');
});

test('released application keeps Inventory reservation 16 and Checkout unreserved', () => {
  const app = appTemplate();
  const [, inventory] = findOne(resourcesOf(app.Resources, 'AWS::Lambda::Function'),
    (resource) => resource.Properties.FunctionName === 'IncidentTriageDemoInventory',
    'missing the released Inventory function');
  assert.equal(inventory.Properties.ReservedConcurrentExecutions, 16,
    'the release-owned Inventory baseline remains 16');
  assert.equal(String(app.Outputs.InventoryReservedConcurrency.Value), '16',
    'the release output remains the Inventory reservation 16');

  const [, checkout] = findOne(resourcesOf(app.Resources, 'AWS::Lambda::Function'),
    (resource) => resource.Properties.FunctionName === 'IncidentTriageDemoCheckout',
    'missing the released Checkout function');
  assert.equal(checkout.Properties.ReservedConcurrentExecutions, undefined,
    'surge capacity remains Inventory-only');
  assert.equal(app.Outputs.CheckoutReservedConcurrency.Value, 'unreserved',
    'Checkout remains unreserved in the release output');
});

test('store binds its friendly hostname to CloudFront with A and AAAA aliases', () => {
  const app = appTemplate();
  const zoneId = 'Z02003753BQ2Y0J10MTK1';
  const domain = 'store.riv2026.guilleojeda.com';
  const [certificateId, certificate] = findOne(
    resourcesOf(app.Resources, 'AWS::CertificateManager::Certificate'),
    (resource) => resource.Properties.DomainName === domain,
    'app needs one exact-name ACM certificate',
  );
  assert.equal(certificate.Properties.ValidationMethod, 'DNS');
  assert.deepEqual(certificate.Properties.DomainValidationOptions, [{
    DomainName: domain,
    HostedZoneId: zoneId,
  }]);
  assert.deepEqual([...certificate.Properties.Tags].sort((left, right) => left.Key.localeCompare(right.Key)), [
    { Key: 'Project', Value: 'IncidentTriageDemo' },
    { Key: 'Component', Value: 'app' },
  ].sort((left, right) => left.Key.localeCompare(right.Key)));

  const [, distribution] = findOne(
    resourcesOf(app.Resources, 'AWS::CloudFront::Distribution'),
    (resource) => resource.Properties.DistributionConfig?.Aliases?.includes(domain),
    'app CloudFront distribution must include the store hostname',
  );
  const config = distribution.Properties.DistributionConfig;
  assert.deepEqual(config.Aliases, [domain]);
  assert.deepEqual(config.ViewerCertificate, {
    AcmCertificateArn: { Ref: certificateId },
    MinimumProtocolVersion: 'TLSv1.2_2021',
    SslSupportMethod: 'sni-only',
  });

  const records = resourcesOf(app.Resources, 'AWS::Route53::RecordSet')
    .map(([, resource]) => resource.Properties)
    .filter(({ Name }) => Name === domain);
  assert.deepEqual(records.map(({ Type }) => Type).sort(), ['A', 'AAAA']);
  for (const record of records) {
    assert.equal(record.HostedZoneId, zoneId);
    assert.equal(record.AliasTarget.HostedZoneId, 'Z2FDTNDATAQYW2');
    assert.equal(record.AliasTarget.EvaluateTargetHealth, false);
  }

  assert.ok(app.Outputs.SiteUrl, 'app must retain its raw SiteUrl output');
  assert.ok(app.Outputs.ApiUrl, 'app must retain its raw ApiUrl output');
  assert.equal(app.Outputs.FriendlySiteUrl.Value, `https://${domain}`);
});

test('controller maps its friendly hostname to the existing regional IPv4 API at root', () => {
  const controller = controllerTemplate();
  const zoneId = 'Z02003753BQ2Y0J10MTK1';
  const domain = 'controller.riv2026.guilleojeda.com';
  const [certificateId, certificate] = findOne(
    resourcesOf(controller.Resources, 'AWS::CertificateManager::Certificate'),
    (resource) => resource.Properties.DomainName === domain,
    'controller needs one exact-name ACM certificate',
  );
  assert.equal(certificate.Properties.ValidationMethod, 'DNS');
  assert.deepEqual(certificate.Properties.DomainValidationOptions, [{
    DomainName: domain,
    HostedZoneId: zoneId,
  }]);
  assert.deepEqual([...certificate.Properties.Tags].sort((left, right) => left.Key.localeCompare(right.Key)), [
    { Key: 'Project', Value: 'IncidentTriageDemo' },
    { Key: 'Component', Value: 'controller' },
  ].sort((left, right) => left.Key.localeCompare(right.Key)));

  const [, friendlyDomain] = findOne(
    resourcesOf(controller.Resources, 'AWS::ApiGatewayV2::DomainName'),
    (resource) => resource.Properties.DomainName === domain,
    'controller needs a custom API domain',
  );
  assert.deepEqual(friendlyDomain.Properties.DomainNameConfigurations, [{
    CertificateArn: { Ref: certificateId },
    EndpointType: 'REGIONAL',
    IpAddressType: 'ipv4',
    SecurityPolicy: 'TLS_1_2',
  }]);

  const [, mapping] = findOne(
    resourcesOf(controller.Resources, 'AWS::ApiGatewayV2::ApiMapping'),
    (resource) => resource.Properties.DomainName?.Ref === 'FriendlyDomain',
    'controller must map the friendly hostname',
  );
  assert.equal(mapping.Properties.ApiMappingKey, undefined,
    'controller mapping must stay at the hostname root');
  assert.equal(mapping.Properties.Stage, '$default');

  const records = resourcesOf(controller.Resources, 'AWS::Route53::RecordSet')
    .map(([, resource]) => resource.Properties)
    .filter(({ Name }) => Name === domain);
  assert.deepEqual(records.map(({ Type }) => Type), ['A']);
  assert.equal(records[0].HostedZoneId, zoneId);
  assert.deepEqual(records[0].AliasTarget, {
    DNSName: { 'Fn::GetAtt': ['FriendlyDomain', 'RegionalDomainName'] },
    EvaluateTargetHealth: false,
    HostedZoneId: { 'Fn::GetAtt': ['FriendlyDomain', 'RegionalHostedZoneId'] },
  });

  assert.ok(controller.Outputs.SiteUrl, 'controller must retain its raw SiteUrl output');
  assert.equal(controller.Outputs.FriendlySiteUrl.Value, `https://${domain}`);
});
