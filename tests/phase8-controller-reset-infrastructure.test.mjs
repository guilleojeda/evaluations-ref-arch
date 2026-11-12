import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const account = '027224425948';
const region = 'us-east-1';
const appTemplatePath = new URL('../.artifacts/app/cdk/IncidentTriageDemoApp.template.json', import.meta.url);
const controllerTemplatePath = new URL('../.artifacts/controller/cdk/IncidentTriageDemoController.template.json', import.meta.url);
const bootstrapPath = new URL('../infrastructure/bootstrap/phase0-cfn-execution-policy.yaml', import.meta.url);
const workerRoleName = 'IncidentTriageDemoControllerWorkerRole';
const httpRoleName = 'IncidentTriageDemoControllerHttpRole';
const workerBoundaryName = 'IncidentTriageDemoControllerWorkerRuntimeBoundary';

// Reuse the YAML parser shipped with the repository's pinned aws-cdk-lib dependency.
const require = createRequire(import.meta.url);
const cdkRequire = createRequire(require.resolve('aws-cdk-lib'));
const { parse: parseYaml } = cdkRequire('yaml');

function readJson(path, description) {
  assert.ok(existsSync(path), `${description} synthesized template is missing; run its pinned check/synth first`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readAppTemplate() {
  return readJson(appTemplatePath, 'app');
}

function readControllerTemplate() {
  return readJson(controllerTemplatePath, 'controller');
}

function readBootstrapTemplate() {
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

function tableNameFromOutput(template, outputName) {
  const tableRef = template.Outputs?.[outputName]?.Value?.Ref;
  assert.equal(typeof tableRef, 'string', `missing synthesized app table output ${outputName}`);
  const table = template.Resources?.[tableRef];
  assert.equal(table?.Type, 'AWS::DynamoDB::Table', `${outputName} must reference an app table`);
  const logicalIdOutput = outputName.replace(/Name$/, 'LogicalId');
  assert.equal(tableRef, template.Outputs[logicalIdOutput]?.Value,
    `${outputName} must agree with its logical ID output`);
  assert.equal(typeof table.Properties.TableName, 'string', `${outputName} must synthesize a named table`);
  return table.Properties.TableName;
}

function tableArn(name) {
  return `arn:aws:dynamodb:${region}:${account}:table/${name}`;
}

function tableNameFromStackOutput(template, outputName) {
  const tableRef = template.Outputs?.[outputName]?.Value?.Ref;
  assert.equal(typeof tableRef, 'string', `missing synthesized table output ${outputName}`);
  const table = template.Resources?.[tableRef];
  assert.equal(table?.Type, 'AWS::DynamoDB::Table', `${outputName} must reference a DynamoDB table`);
  return table.Properties.TableName;
}

function assertLeadingKey(statements, action, resource, sku, owner) {
  const grants = allowedStatements(statements).filter((statement) =>
    actionList(statement).some((pattern) => iamPatternMatches(pattern, action)) &&
    resourceList(statement).some((pattern) => iamPatternMatches(pattern, resource)));
  assert.equal(grants.length, 1, `${owner} must grant ${action} on the selected Inventory table once`);
  const leadingKeys = grants[0].Condition?.['ForAllValues:StringEquals']?.['dynamodb:LeadingKeys'];
  assert.deepEqual(Array.isArray(leadingKeys) ? leadingKeys : [leadingKeys], [sku],
    `${owner} ${action} must be limited to the seeded SKU partition key`);
}

function assertWorkerDynamoDbEnvelope(statements, tableNames, sku, owner) {
  const { orders, inventory, run } = tableNames;
  assert.deepEqual(grantedActionPatterns(statements, 'dynamodb:'), [
    'dynamodb:DeleteItem',
    'dynamodb:GetItem',
    'dynamodb:GetResourcePolicy',
    'dynamodb:PutItem',
    'dynamodb:Scan',
    'dynamodb:UpdateItem',
  ], `${owner} must retain only controller-state access, Inventory Reset access, and Orders cleanup access`);

  assert.deepEqual(grantedResources(statements, 'dynamodb:GetItem'), [inventory, run].sort(),
    `${owner} may read only controller state and the selected Inventory SKU`);
  assert.deepEqual(grantedResources(statements, 'dynamodb:PutItem'), [inventory, run].sort(),
    `${owner} may write controller state and reseed only the selected Inventory SKU`);
  assert.deepEqual(grantedResources(statements, 'dynamodb:UpdateItem'), [run],
    `${owner} must not update either business table`);
  assert.deepEqual(grantedResources(statements, 'dynamodb:GetResourcePolicy'), [inventory],
    `${owner} retains only the existing Inventory resource-policy read`);
  assert.deepEqual(grantedResources(statements, 'dynamodb:Scan'), [orders],
    `${owner} may scan only Orders to find records to remove`);
  assert.deepEqual(grantedResources(statements, 'dynamodb:DeleteItem'), [orders],
    `${owner} may delete only Orders records`);

  assertLeadingKey(statements, 'dynamodb:GetItem', inventory, sku, owner);
  assertLeadingKey(statements, 'dynamodb:PutItem', inventory, sku, owner);
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

test('worker Reset permissions are limited to the app output tables, selected SKU, and existing controller state', () => {
  const app = readAppTemplate();
  const controller = readControllerTemplate();
  const bootstrap = readBootstrapTemplate();
  const resources = controller.Resources;
  const runTableName = tableNameFromStackOutput(controller, 'RunTableName');
  assert.deepEqual(resourcesOf(resources, 'AWS::Lambda::Function')
    .map(([, resource]) => resource.Properties.FunctionName).sort(), [
    'IncidentTriageDemoControllerHttp',
    'IncidentTriageDemoControllerWorker',
  ], 'Reset must reuse the existing HTTP and worker functions');
  assert.equal(resourcesOf(resources, 'AWS::ApiGatewayV2::Api').length, 1,
    'Reset must reuse the existing controller API');
  assert.deepEqual(resourcesOf(resources, 'AWS::ApiGatewayV2::Route')
    .map(([, resource]) => resource.Properties.RouteKey).sort(), ['ANY /', 'ANY /{proxy+}'],
  'Reset must reuse the existing controller routes');
  assert.deepEqual(resourcesOf(resources, 'AWS::DynamoDB::Table')
    .map(([, resource]) => resource.Properties.TableName), [runTableName],
  'Reset must reuse the existing controller run record without a reset journal table');
  const [workerId] = namedRole(resources, workerRoleName);
  const tableNames = {
    orders: tableArn(tableNameFromOutput(app, 'OrdersTableName')),
    inventory: tableArn(tableNameFromOutput(app, 'InventoryTableName')),
    run: tableArn(runTableName),
  };
  const sku = app.Outputs?.ProductSku?.Value;
  assert.equal(typeof sku, 'string', 'missing synthesized app ProductSku output');

  // CDK may express this stack's own table ARN as GetAtt rather than a literal ARN.
  // Resolve only the exact output-bound table; other references remain unexpected resources.
  const runArnReference = JSON.stringify({ 'Fn::GetAtt': [controller.Outputs.RunTableName.Value.Ref, 'Arn'] });
  const workerStatements = allRoleStatements(resources, workerId).map((statement) => ({
    ...statement,
    Resource: resourceList(statement).map((resource) =>
      JSON.stringify(resource) === runArnReference ? tableNames.run : resource),
  }));
  assertWorkerDynamoDbEnvelope(workerStatements, tableNames, sku,
    `${workerRoleName}`);

  const workerBoundary = bootstrapPolicy(bootstrap.Resources, workerBoundaryName);
  assertWorkerDynamoDbEnvelope(workerBoundary, tableNames, sku, workerBoundaryName);
});

test('HTTP and Agent roles have no direct Orders or Inventory data access', () => {
  const app = readAppTemplate();
  const controller = readControllerTemplate();
  const bootstrap = readBootstrapTemplate();
  const [httpId] = namedRole(controller.Resources, httpRoleName);
  const ordersTable = tableArn(tableNameFromOutput(app, 'OrdersTableName'));
  const inventoryTable = tableArn(tableNameFromOutput(app, 'InventoryTableName'));
  const tableArns = [ordersTable, inventoryTable];
  const businessDataActions = [
    'dynamodb:BatchGetItem',
    'dynamodb:BatchWriteItem',
    'dynamodb:ConditionCheckItem',
    'dynamodb:DeleteItem',
    'dynamodb:GetItem',
    'dynamodb:PutItem',
    'dynamodb:Query',
    'dynamodb:Scan',
    'dynamodb:UpdateItem',
  ];
  assertNoGrant(allRoleStatements(controller.Resources, httpId), businessDataActions, tableArns,
    `${httpRoleName} must not access Orders or Inventory data`);

  const agentBoundary = bootstrapPolicy(bootstrap.Resources, 'IncidentTriageDemoAgentRuntimeBoundary');
  const agentExecution = bootstrapPolicy(bootstrap.Resources, 'IncidentTriageDemoAgentCfnExecution');
  const createRuntimeRole = policyStatement(agentExecution, 'CreateRuntimeWithBoundary');
  assert.deepEqual(resourceList(createRuntimeRole), [
    `arn:aws:iam::${account}:role/IncidentTriageDemoAgentRuntimeRole`,
  ], 'agent deployment must create only its runtime role with the business-data boundary');
  assert.equal(createRuntimeRole.Condition?.StringEquals?.['iam:PermissionsBoundary'],
    `arn:aws:iam::${account}:policy/IncidentTriageDemoAgentRuntimeBoundary`,
    'agent runtime creation must require the administrator-owned business-data boundary');
  assertNoGrant(agentBoundary, businessDataActions, tableArns,
    'Agent runtime boundary must not authorize Orders or Inventory data access');
  assert.deepEqual(grantedActionPatterns(agentBoundary, 'dynamodb:'), [
    'dynamodb:GetItem',
    'dynamodb:GetResourcePolicy',
    'dynamodb:PutItem',
    'dynamodb:UpdateItem',
  ], 'Agent runtime boundary must retain only its investigation-record operations and Inventory metadata read');
  const agentRunTables = grantedResources(agentBoundary, 'dynamodb:GetItem');
  assert.equal(agentRunTables.length, 1, 'Agent runtime boundary must use one separate investigation table');
  for (const action of ['dynamodb:PutItem', 'dynamodb:UpdateItem']) {
    assert.deepEqual(grantedResources(agentBoundary, action), agentRunTables,
      `Agent runtime boundary ${action} must remain limited to its investigation table`);
  }
  assert.deepEqual(grantedResources(agentBoundary, 'dynamodb:GetResourcePolicy'), [inventoryTable],
    'Agent runtime boundary resource-policy read must remain on the app Inventory table');
});
