import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const account = '027224425948';
const region = 'us-east-1';
const controllerTemplatePath = new URL('../.artifacts/controller/cdk/IncidentTriageDemoController.template.json', import.meta.url);
const cfnExecutionPath = new URL('../infrastructure/bootstrap/phase0-cfn-execution-policy.yaml', import.meta.url);
const githubBootstrapPath = new URL('../infrastructure/bootstrap/github-iam.yaml', import.meta.url);
const workerRoleName = 'IncidentTriageDemoControllerWorkerRole';
const httpRoleName = 'IncidentTriageDemoControllerHttpRole';
const workerBoundaryName = 'IncidentTriageDemoControllerWorkerRuntimeBoundary';
const httpBoundaryName = 'IncidentTriageDemoControllerHttpRuntimeBoundary';
const functions = ['IncidentTriageDemoCheckout', 'IncidentTriageDemoInventory'];
const functionArns = functions.map((name) => `arn:aws:lambda:${region}:${account}:function:${name}`);
const inventoryFunctionArn = functionArns[1];
const businessTables = [
  `arn:aws:dynamodb:${region}:${account}:table/IncidentTriageDemoOrders`,
  `arn:aws:dynamodb:${region}:${account}:table/IncidentTriageDemoInventory`,
];

// Reuse the YAML parser shipped with the repository's pinned aws-cdk-lib dependency.
const require = createRequire(import.meta.url);
const cdkRequire = createRequire(require.resolve('aws-cdk-lib'));
const { parse: parseYaml } = cdkRequire('yaml');
const cloudFormationTags = [{ tag: '!Sub', resolve: (value) => ({ 'Fn::Sub': value }) }];

function template() {
  assert.ok(existsSync(controllerTemplatePath),
    'controller synthesized template is missing; run the pinned controller check/synth first');
  return JSON.parse(readFileSync(controllerTemplatePath, 'utf8'));
}

function bootstrapTemplate(path) {
  return parseYaml(readFileSync(path, 'utf8'), { customTags: cloudFormationTags });
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

function allRoleStatements(resources, roleId) {
  const role = resources[roleId];
  assert.equal(role?.Type, 'AWS::IAM::Role', `missing IAM role ${roleId}`);
  const inline = (role.Properties.Policies ?? []).map(({ PolicyDocument }) => PolicyDocument);
  const attached = resourcesOf(resources, 'AWS::IAM::Policy')
    .filter(([, policy]) => policy.Properties.Roles?.some(({ Ref }) => Ref === roleId))
    .map(([, policy]) => policy.Properties.PolicyDocument);
  return [...inline, ...attached].flatMap(({ Statement }) => Statement ?? []);
}

function actionList(statement) {
  return [statement.Action].flat().filter((value) => typeof value === 'string');
}

function resourceList(statement) {
  return [statement.Resource].flat().filter((value) => value !== undefined);
}

function iamPatternMatches(pattern, value) {
  if (typeof pattern !== 'string') return false;
  const escaped = pattern.split('*').map((part) => RegExp.escape(part)).join('.*');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

function allowedStatements(statements) {
  return statements.filter(({ Effect }) => Effect === 'Allow');
}

function grantedActionPatterns(statements, prefix) {
  return [...new Set(allowedStatements(statements)
    .flatMap(actionList)
    .filter((action) => action.toLowerCase().startsWith(prefix.toLowerCase())))].sort();
}

function grantedResources(statements, action) {
  return allowedStatements(statements)
    .filter((statement) => actionList(statement).some((pattern) => iamPatternMatches(pattern, action)))
    .flatMap(resourceList)
    .map((resource) => typeof resource === 'string' ? resource : JSON.stringify(resource))
    .sort();
}

function allows(statements, action, resource) {
  return allowedStatements(statements).some((statement) =>
    actionList(statement).some((pattern) => iamPatternMatches(pattern, action)) &&
    resourceList(statement).some((pattern) => iamPatternMatches(pattern, resource)));
}

function assertNoGrant(statements, actions, resources, message) {
  for (const action of actions) {
    for (const resource of resources) {
      assert.equal(allows(statements, action, resource), false, `${message}: ${action} on ${resource}`);
    }
  }
}

function assertNoActionGrant(statements, actions, message) {
  for (const action of actions) {
    assert.deepEqual(grantedResources(statements, action), [], `${message}: ${action}`);
  }
}

function bootstrapPolicy(resources, policyName) {
  return findOne(resourcesOf(resources, 'AWS::IAM::ManagedPolicy'),
    (resource) => resource.Properties.ManagedPolicyName === policyName,
    `missing bootstrap managed policy ${policyName}`)[1].Properties.PolicyDocument.Statement;
}

function policyStatement(statements, sid) {
  return findOne(statements.map((statement, index) => [String(index), statement]),
    (statement) => statement.Sid === sid,
    `missing policy statement ${sid}`)[1];
}

test('worker role scopes concurrency mutation to the two application functions and retains only Inventory alias control', () => {
  const { Resources } = template();
  const [workerId, worker] = namedRole(Resources, workerRoleName);
  const [httpId] = namedRole(Resources, httpRoleName);
  const workerStatements = allRoleStatements(Resources, workerId);
  const httpStatements = allRoleStatements(Resources, httpId);
  const expectedReadScopes = [...functionArns, ...functionArns.map((arn) => `${arn}:*`)].sort();

  assert.equal(worker.Properties.PermissionsBoundary,
    `arn:aws:iam::${account}:policy/${workerBoundaryName}`);
  assert.deepEqual(grantedResources(workerStatements, 'lambda:GetFunctionConcurrency'), expectedReadScopes,
    'concurrency readback must remain limited to Checkout and Inventory and their qualified configurations');
  for (const action of ['lambda:PutFunctionConcurrency', 'lambda:DeleteFunctionConcurrency']) {
    assert.deepEqual(grantedResources(workerStatements, action), [...functionArns].sort(),
      `${action} may change only the exact unqualified Checkout and Inventory functions`);
  }
  assert.deepEqual(grantedResources(workerStatements, 'lambda:UpdateAlias'), [inventoryFunctionArn],
    'only the already supported Inventory function retains alias control');

  const forbiddenFunctionActions = [
    'lambda:AddPermission',
    'lambda:CreateAlias',
    'lambda:CreateFunction',
    'lambda:DeleteAlias',
    'lambda:DeleteFunction',
    'lambda:PublishVersion',
    'lambda:RemovePermission',
    'lambda:UpdateFunctionCode',
    'lambda:UpdateFunctionConfiguration',
    'lambda:UpdateFunctionEventInvokeConfig',
  ];
  assertNoActionGrant(workerStatements, forbiddenFunctionActions,
    'recovery must not publish versions or change function code/configuration');
  assertNoActionGrant(httpStatements, [
    'lambda:PutFunctionConcurrency',
    'lambda:DeleteFunctionConcurrency',
    'lambda:UpdateAlias',
    ...forbiddenFunctionActions,
  ], 'HTTP role must not mutate application Lambda functions');
});

test('worker role cannot write business DynamoDB tables, mutate IAM, pass roles, or operate AgentCore', () => {
  const { Resources } = template();
  const [workerId] = namedRole(Resources, workerRoleName);
  const workerStatements = allRoleStatements(Resources, workerId);
  const businessWriteActions = [
    'dynamodb:BatchWriteItem',
    'dynamodb:CreateTable',
    'dynamodb:DeleteItem',
    'dynamodb:DeleteResourcePolicy',
    'dynamodb:DeleteTable',
    'dynamodb:PutItem',
    'dynamodb:PutResourcePolicy',
    'dynamodb:TransactWriteItems',
    'dynamodb:UpdateItem',
    'dynamodb:UpdateTable',
  ];
  assertNoGrant(workerStatements, businessWriteActions, businessTables,
    'recovery may not reset, delete, or write business data');

  assert.deepEqual(grantedActionPatterns(workerStatements, 'iam:'), [
    'iam:GetPolicy',
    'iam:GetPolicyVersion',
    'iam:GetRole',
    'iam:ListAttachedRolePolicies',
  ], 'runtime worker may observe the existing Inventory role/policy state but has no IAM mutation or PassRole authority');

  const agentCoreActions = [
    'bedrock-agentcore:CreateAgentRuntime',
    'bedrock-agentcore:CreateAgentRuntimeEndpoint',
    'bedrock-agentcore:DeleteAgentRuntime',
    'bedrock-agentcore:DeleteAgentRuntimeEndpoint',
    'bedrock-agentcore:InvokeAgentRuntime',
    'bedrock-agentcore:UpdateAgentRuntime',
    'bedrock-agentcore:UpdateAgentRuntimeEndpoint',
  ];
  assertNoActionGrant(workerStatements, agentCoreActions,
    'runtime worker must have no AgentCore invoke or deployment authority');
});

test('HTTP role and WorkerRuntimeBoundary preserve the same recovery permission boundary', () => {
  const { Resources } = template();
  const [httpId] = namedRole(Resources, httpRoleName);
  const [workerId] = namedRole(Resources, workerRoleName);
  const httpStatements = allRoleStatements(Resources, httpId);
  const workerStatements = allRoleStatements(Resources, workerId);
  const bootstrap = bootstrapTemplate(cfnExecutionPath);
  const httpBoundary = bootstrapPolicy(bootstrap.Resources, httpBoundaryName);
  const workerBoundary = bootstrapPolicy(bootstrap.Resources, workerBoundaryName);
  const expectedReadScopes = [...functionArns, ...functionArns.map((arn) => `${arn}:*`)].sort();

  assert.deepEqual(grantedResources(workerBoundary, 'lambda:GetFunctionConcurrency'), expectedReadScopes);
  for (const action of ['lambda:PutFunctionConcurrency', 'lambda:DeleteFunctionConcurrency']) {
    assert.deepEqual(grantedResources(workerBoundary, action), [...functionArns].sort(),
      `${workerBoundaryName} must permit ${action} on exactly Checkout and Inventory`);
    assert.deepEqual(grantedResources(workerStatements, action), grantedResources(workerBoundary, action),
      `role and permissions boundary must agree on ${action}`);
  }
  assert.deepEqual(grantedResources(workerBoundary, 'lambda:UpdateAlias'), [inventoryFunctionArn]);
  assert.deepEqual(grantedResources(workerStatements, 'lambda:UpdateAlias'),
    grantedResources(workerBoundary, 'lambda:UpdateAlias'),
    'role and permissions boundary must preserve the established Inventory alias grant');

  const forbiddenFunctionActions = [
    'lambda:PutFunctionConcurrency', 'lambda:DeleteFunctionConcurrency', 'lambda:UpdateAlias',
    'lambda:PublishVersion', 'lambda:UpdateFunctionCode', 'lambda:UpdateFunctionConfiguration',
  ];
  assertNoActionGrant(httpBoundary, forbiddenFunctionActions,
    `${httpBoundaryName} must keep application function mutation unavailable`);
  assertNoActionGrant(httpStatements, forbiddenFunctionActions,
    `${httpRoleName} must keep application function mutation unavailable`);
});

test('bootstrap lets CloudFormation install only boundary-protected controller roles and denies direct recovery mutation to GitHub deploy', () => {
  const bootstrap = bootstrapTemplate(cfnExecutionPath);
  const controllerExecution = bootstrapPolicy(bootstrap.Resources, 'IncidentTriageDemoControllerCfnExecution');
  const workerRoleArn = `arn:aws:iam::${account}:role/${workerRoleName}`;
  const httpRoleArn = `arn:aws:iam::${account}:role/${httpRoleName}`;
  const workerBoundaryArn = `arn:aws:iam::${account}:policy/${workerBoundaryName}`;
  const manageRoles = policyStatement(controllerExecution, 'ManageControllerRuntimeRoles');
  assert.ok(actionList(manageRoles).some((pattern) => iamPatternMatches(pattern, 'iam:PutRolePolicy')),
    'controller CloudFormation execution must be able to install the worker policy');
  assert.deepEqual(resourceList(manageRoles).sort(), [httpRoleArn, workerRoleArn].sort(),
    'runtime-role policy management must remain limited to the two controller roles');

  const createWorker = policyStatement(controllerExecution, 'CreateControllerWorkerRoleWithBoundary');
  assert.deepEqual(resourceList(createWorker), [workerRoleArn]);
  assert.equal(createWorker.Condition?.StringEquals?.['iam:PermissionsBoundary'], workerBoundaryArn,
    'CloudFormation must create the worker with the established administrator-owned boundary');
  const passRoles = policyStatement(controllerExecution, 'PassControllerRuntimeRolesToLambda');
  assert.deepEqual(resourceList(passRoles).sort(), [httpRoleArn, workerRoleArn].sort());
  assert.equal(passRoles.Condition?.StringEquals?.['iam:PassedToService'], 'lambda.amazonaws.com');
  assertNoGrant(controllerExecution, [
    'lambda:PutFunctionConcurrency', 'lambda:DeleteFunctionConcurrency', 'lambda:UpdateAlias',
  ], functionArns, 'controller CloudFormation execution must not directly mutate app functions');

  const github = bootstrapTemplate(githubBootstrapPath);
  const [deployRoleId] = namedRole(github.Resources, 'IncidentTriageDemoGitHubDeploy');
  const deployStatements = allRoleStatements(github.Resources, deployRoleId);
  const deployAllows = allowedStatements(deployStatements);
  assertNoActionGrant(deployAllows, [
    'lambda:PutFunctionConcurrency', 'lambda:DeleteFunctionConcurrency', 'lambda:UpdateAlias',
  ], 'GitHub deployment must not directly perform controller recovery mutations');
  const guard = policyStatement(github.Resources.DedicatedCdkDeployRolePhase0Guard.Properties.PolicyDocument.Statement,
    'DenyNonAppDeploymentActions');
  assert.equal(guard.Effect, 'Deny');
  assert.equal(guard.Resource, '*');
  for (const action of ['lambda:PutFunctionConcurrency', 'lambda:DeleteFunctionConcurrency', 'lambda:UpdateAlias']) {
    assert.ok(!(guard.NotAction ?? []).some((pattern) => iamPatternMatches(pattern, action)),
      `${action} must remain covered by the GitHub deployment role's non-app action deny`);
  }
});
