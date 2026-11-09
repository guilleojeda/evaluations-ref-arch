import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const account = '027224425948';
const region = 'us-east-1';
const alarmArn = `arn:aws:cloudwatch:${region}:${account}:alarm:IncidentTriageDemoAppStage5xx`;
const appTemplatePath = new URL('../.artifacts/app/cdk/IncidentTriageDemoApp.template.json', import.meta.url);
const agentTemplatePath = new URL('../.artifacts/agent/cdk/IncidentTriageDemoAgent.template.json', import.meta.url);
const controllerTemplatePath = new URL('../.artifacts/controller/cdk/IncidentTriageDemoController.template.json', import.meta.url);

function template(path, name) {
  assert.ok(existsSync(path), `${name} synthesized template is missing; run the normal component build/synth first`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function resourcesOf(resources, type) {
  assert.ok(resources && typeof resources === 'object',
    'the synthesized stack has no CloudFormation Resources section; the Phase 4 infrastructure is absent');
  return Object.entries(resources).filter(([, resource]) => resource.Type === type);
}

function findOne(resources, type, predicate, message) {
  const matches = resourcesOf(resources, type).filter(([, resource]) => predicate(resource));
  assert.equal(matches.length, 1, message);
  return matches[0];
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

function actionList(statement) {
  return [statement.Action].flat().filter((value) => typeof value === 'string');
}

function resourceList(statement) {
  return [statement.Resource].flat();
}

function references(value, logicalId) {
  return JSON.stringify(value).includes(`\"${logicalId}\"`);
}

function outputsReferencing(outputs, logicalId) {
  return Object.values(outputs ?? {}).filter(({ Value }) => references(Value, logicalId));
}

const noValue = Symbol('AWS::NoValue');

// Resolve only the condition and parameter intrinsics used by the optional alarm binding.
function resolveAlarmValue(value, { parameters, conditions, supplied }, activeConditions = new Set()) {
  if (Array.isArray(value)) {
    return value.map((item) => resolveAlarmValue(item, { parameters, conditions, supplied }, activeConditions))
      .filter((item) => item !== noValue);
  }
  if (!value || typeof value !== 'object') return value;
  if (Object.hasOwn(value, 'Ref')) {
    if (value.Ref === 'AWS::NoValue') return noValue;
    if (Object.hasOwn(supplied, value.Ref)) return supplied[value.Ref];
    assert.ok(parameters[value.Ref], `unexpected alarm binding reference ${value.Ref}`);
    assert.ok(Object.hasOwn(parameters[value.Ref], 'Default'),
      `alarm binding parameter ${value.Ref} needs a bootstrap default`);
    return parameters[value.Ref].Default;
  }
  if (Object.hasOwn(value, 'Fn::Equals')) {
    const [left, right] = value['Fn::Equals'];
    return resolveAlarmValue(left, { parameters, conditions, supplied }, activeConditions) ===
      resolveAlarmValue(right, { parameters, conditions, supplied }, activeConditions);
  }
  if (Object.hasOwn(value, 'Fn::Not')) {
    return !resolveAlarmValue(value['Fn::Not'][0], { parameters, conditions, supplied }, activeConditions);
  }
  if (Object.hasOwn(value, 'Fn::If')) {
    const [condition, whenTrue, whenFalse] = value['Fn::If'];
    let result;
    if (typeof condition === 'string') {
      assert.ok(conditions[condition], `missing alarm binding condition ${condition}`);
      assert.ok(!activeConditions.has(condition), `cyclic alarm binding condition ${condition}`);
      const nested = new Set(activeConditions);
      nested.add(condition);
      result = resolveAlarmValue(conditions[condition], { parameters, conditions, supplied }, nested);
    } else {
      result = resolveAlarmValue(condition, { parameters, conditions, supplied }, activeConditions);
    }
    return resolveAlarmValue(result ? whenTrue : whenFalse, { parameters, conditions, supplied }, activeConditions);
  }
  const resolved = {};
  for (const [key, item] of Object.entries(value)) {
    const next = resolveAlarmValue(item, { parameters, conditions, supplied }, activeConditions);
    if (next !== noValue) resolved[key] = next;
  }
  return resolved;
}

test('agent stack contains one Runtime, a version-pinned faulty endpoint, and its retained durable run table', () => {
  const { Resources, Outputs } = template(agentTemplatePath, 'agent');
  const [runtimeId, runtime] = findOne(
    Resources,
    'AWS::BedrockAgentCore::Runtime',
    () => true,
    'the agent stack must contain exactly one AgentCore Runtime',
  );
  const [endpointId, endpoint] = findOne(
    Resources,
    'AWS::BedrockAgentCore::RuntimeEndpoint',
    ({ Properties }) => /faulty/i.test(Properties.Name ?? ''),
    'the agent stack must contain one named faulty Runtime endpoint',
  );
  assert.ok(endpoint.Properties.AgentRuntimeVersion,
    'the faulty endpoint must be pinned to an explicit immutable Runtime version');
  assert.ok(references(endpoint.Properties.AgentRuntimeId, runtimeId),
    'the faulty endpoint must target the stack Runtime');
  assert.ok(outputsReferencing(Outputs, runtimeId).length,
    'the stack must expose the Runtime identity to dependent components');
  assert.ok(outputsReferencing(Outputs, endpointId).length,
    'the stack must expose the pinned faulty endpoint identity');

  const tables = resourcesOf(Resources, 'AWS::DynamoDB::Table');
  assert.equal(tables.length, 1, 'the agent stack must own one separate durable run table');
  const [, table] = tables[0];
  assert.equal(table.Properties.BillingMode, 'PAY_PER_REQUEST');
  assert.deepEqual(table.Properties.KeySchema, [
    { AttributeName: 'pk', KeyType: 'HASH' },
    { AttributeName: 'sk', KeyType: 'RANGE' },
  ], 'the base table must support strongly consistent exact and recent lookups');
  assert.equal(table.DeletionPolicy, 'Retain');
  assert.equal(table.UpdateReplacePolicy, 'Retain');
});

test('alarm wiring preserves the native stage alarm and grants only its alarm action permission', () => {
  const app = template(appTemplatePath, 'app');
  const agent = template(agentTemplatePath, 'agent');
  const [, alarmResource] = findOne(
    app.Resources,
    'AWS::CloudWatch::Alarm',
    ({ Properties }) => Properties.AlarmName === 'IncidentTriageDemoAppStage5xx',
    'the existing neutral stage alarm must remain the one wired alarm',
  );
  const { Properties: alarm } = alarmResource;
  const apiId = resourcesOf(app.Resources, 'AWS::ApiGatewayV2::Api')[0]?.[0];
  assert.ok(apiId, 'the native stage alarm must retain its HTTP API metric source');
  assert.equal(alarm.Namespace, 'AWS/ApiGateway');
  assert.equal(alarm.MetricName, '5xx');
  assert.equal(alarm.Statistic, 'Sum');
  assert.equal(alarm.Period, 60);
  assert.equal(alarm.Threshold, 1);
  assert.equal(alarm.EvaluationPeriods, 1);
  assert.equal(alarm.TreatMissingData, 'notBreaching');
  const dimensions = Object.fromEntries(alarm.Dimensions.map(({ Name, Value }) => [Name, Value]));
  assert.ok(references(dimensions.ApiId, apiId), 'the alarm must remain scoped to the existing HTTP API');
  assert.equal(dimensions.Stage, '$default');

  const adapter = findOne(
    agent.Resources,
    'AWS::Lambda::Function',
    ({ Properties }) => /alarm.*adapter|adapter.*alarm/i.test(`${Properties.FunctionName ?? ''} ${Properties.Handler ?? ''}`),
    'the agent stack must contain its dedicated alarm adapter Lambda',
  );
  const [adapterId, adapterResource] = adapter;
  assert.ok(outputsReferencing(agent.Outputs, adapterId).length,
    'the separately deployed adapter must expose its stable ARN for the app stack input');
  assert.equal(typeof adapterResource.Properties.FunctionName, 'string',
    'the adapter name must be stable so its cross-stack ARN remains stable');
  const adapterArn = `arn:aws:lambda:${region}:${account}:function:${adapterResource.Properties.FunctionName}`;

  const appParameters = Object.keys(app.Parameters ?? {}).filter((name) => /alarm.*adapter.*arn|adapter.*arn/i.test(name));
  assert.equal(appParameters.length, 1, 'app stack must retain its explicit cross-stack adapter ARN input');
  const evaluateActions = (supplied) => {
    const value = resolveAlarmValue(alarm.AlarmActions ?? [], {
      parameters: app.Parameters ?? {},
      conditions: app.Conditions ?? {},
      supplied,
    });
    return value === noValue ? [] : value;
  };
  assert.deepEqual(evaluateActions({}), [],
    'an empty adapter input keeps the phase bootstrap alarm unwired');
  assert.deepEqual(evaluateActions({ [appParameters[0]]: adapterArn }), [adapterArn],
    'a provided adapter input wires exactly that stable Lambda ARN as the alarm action');

  const permission = findOne(
    agent.Resources,
    'AWS::Lambda::Permission',
    ({ Properties }) => Properties.Principal === 'lambda.alarms.cloudwatch.amazonaws.com' &&
      references(Properties.FunctionName, adapterId),
    'the adapter must accept invocation only from the native CloudWatch alarm service',
  );
  assert.ok(JSON.stringify(permission[1].Properties.SourceArn).includes('StageAlarmArn') ||
    JSON.stringify(permission[1].Properties.SourceArn).includes('AlarmArn') ||
    JSON.stringify(permission[1].Properties.SourceArn).includes(alarmArn),
  'CloudWatch invocation must be scoped to the exact app alarm ARN');
  assert.equal(adapterResource.Properties.TracingConfig?.Mode, 'Active',
    'the real alarm-to-Runtime adapter path must propagate active Lambda tracing');
  assert.ok(Number.isInteger(adapterResource.Properties.Timeout) && adapterResource.Properties.Timeout > 0 &&
    adapterResource.Properties.Timeout < 900, 'the adapter invocation must have a finite Lambda deadline');

  const adapterRetries = resourcesOf(agent.Resources, 'AWS::Lambda::EventInvokeConfig')
    .filter(([, resource]) => references(resource.Properties.FunctionName, adapter[0]));
  assert.equal(adapterRetries.length, 1, 'asynchronous alarm delivery must have an explicit bounded retry policy');
  const retry = adapterRetries[0][1].Properties;
  assert.ok(Number.isInteger(retry.MaximumRetryAttempts) && retry.MaximumRetryAttempts >= 1 && retry.MaximumRetryAttempts <= 2);
  assert.ok(Number.isInteger(retry.MaximumEventAgeInSeconds) && retry.MaximumEventAgeInSeconds > 0 &&
    retry.MaximumEventAgeInSeconds <= 21600, 'late alarm deliveries must age out within Lambda’s documented finite window');
});

test('adapter only forwards to the selected endpoint; Runtime owns the run claim and read/write boundary', () => {
  const { Resources } = template(agentTemplatePath, 'agent');
  const [runtimeId, runtime] = findOne(
    Resources,
    'AWS::BedrockAgentCore::Runtime',
    () => true,
    'the agent stack must contain exactly one AgentCore Runtime',
  );
  const artifact = runtime.Properties.AgentRuntimeArtifact?.CodeConfiguration;
  assert.ok(artifact, 'the Runtime must use a direct Python ZIP deployment artifact');
  assert.equal(artifact.Runtime, 'PYTHON_3_13');
  assert.ok(artifact.EntryPoint?.includes('main.py'), 'the locked Python 3.13 entry point must be the packaged runtime');
  assert.ok(artifact.Code?.S3, 'the Runtime ZIP must come from its content-addressed S3 asset');
  const packageBuilder = readFileSync(new URL('../agent/package_runtime.py', import.meta.url), 'utf8');
  assert.match(packageBuilder, /--python-platform[\s\S]{0,100}aarch64-manylinux2014/,
    'the Python ZIP builder must install wheels for AgentCore’s ARM64 runtime');
  const lifecycle = runtime.Properties.LifecycleConfiguration;
  assert.ok(Number.isInteger(lifecycle?.IdleRuntimeSessionTimeout) && lifecycle.IdleRuntimeSessionTimeout >= 60 &&
    lifecycle.IdleRuntimeSessionTimeout <= 1209600, 'Runtime idle sessions must expire within the supported finite bounds');
  assert.ok(Number.isInteger(lifecycle?.MaxLifetime) && lifecycle.MaxLifetime >= 60 && lifecycle.MaxLifetime <= 1209600,
    'Runtime sessions must have a finite maximum lifetime');
  const [endpointId] = findOne(
    Resources,
    'AWS::BedrockAgentCore::RuntimeEndpoint',
    ({ Properties }) => /faulty/i.test(Properties.Name ?? ''),
    'the pinned faulty endpoint is required',
  );
  const tables = resourcesOf(Resources, 'AWS::DynamoDB::Table');
  assert.equal(tables.length, 1, 'the agent-owned run table is required');
  const [tableId, table] = tables[0];
  const [, adapter] = findOne(
    Resources,
    'AWS::Lambda::Function',
    ({ Properties }) => /alarm.*adapter|adapter.*alarm/i.test(`${Properties.FunctionName ?? ''} ${Properties.Handler ?? ''}`),
    'the alarm adapter Lambda is required',
  );
  const adapterRoleId = resourcesOf(Resources, 'AWS::IAM::Role')
    .find(([id]) => references(adapter.Properties.Role, id))?.[0];
  const runtimeRoleId = resourcesOf(Resources, 'AWS::IAM::Role')
    .find(([id]) => references(runtime.Properties.RoleArn, id))?.[0];
  assert.ok(adapterRoleId, 'adapter Lambda must use a dedicated role');
  assert.ok(runtimeRoleId, 'Runtime must use its dedicated role');

  const adapterStatements = roleStatements(Resources, adapterRoleId);
  const adapterAllows = adapterStatements.filter(({ Effect }) => Effect === 'Allow');
  assert.ok(adapterAllows.some((statement) => actionList(statement).includes('bedrock-agentcore:InvokeAgentRuntime') &&
    resourceList(statement).some((resource) => references(resource, endpointId) ||
      JSON.stringify(resource).includes('runtime-endpoint/'))),
  'adapter permission must target the pinned endpoint, not every Runtime');
  assert.ok(!adapterAllows.some((statement) => actionList(statement).some((action) => /^dynamodb:/.test(action))),
    'adapter cannot read or change run records; it only forwards the event');
  assert.ok(!adapterAllows.some((statement) => actionList(statement).some((action) => /^bedrock-agentcore:InvokeAgentRuntime$/.test(action)) &&
    resourceList(statement).some((resource) => JSON.stringify(resource) === '"*"')),
  'adapter may not invoke every Runtime');

  const runtimeStatements = roleStatements(Resources, runtimeRoleId);
  const runtimeAllows = runtimeStatements.filter(({ Effect }) => Effect === 'Allow');
  assert.ok(runtimeAllows.some((statement) => actionList(statement).includes('dynamodb:PutItem') &&
    resourceList(statement).some((resource) => references(resource, tableId))),
  'Runtime must be able to conditionally create its one running claim in the dedicated table');
  assert.ok(runtimeAllows.some((statement) => actionList(statement).includes('dynamodb:UpdateItem') &&
    resourceList(statement).some((resource) => references(resource, tableId))),
  'Runtime must be able to persist its own terminal result');
  const sourceWrites = runtimeAllows.filter(({ Action }) => actionList({ Action }).some((action) => action === 's3:PutObject'))
    .flatMap(resourceList).map((resource) => JSON.stringify(resource));
  assert.equal(sourceWrites.length, 1, 'Runtime must have one narrowly scoped source-capture destination');
  assert.match(sourceWrites[0], /agent-source\//i,
    'sanitized source captures must be written only under the separate private agent-source prefix');
  assert.ok(!runtimeAllows.some((statement) => actionList(statement).some((action) => /^s3:(?:GetObject|ListBucket|ListBucketVersions)$/.test(action))),
    'the model-facing Runtime cannot read captured evidence or controller checkpoint/journal data');
  assert.ok(!runtimeAllows.some((statement) => actionList(statement).some((action) => /^(?:lambda:(?:Update|AddPermission|Delete)|iam:(?:Attach|Detach|Put|Create|Delete)|cloudformation:)/.test(action))),
    'Runtime may inspect evidence but cannot change application or deployment resources');
  const modelGrants = runtimeAllows.filter((statement) => actionList(statement)
    .some((action) => ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'].includes(action)))
    .flatMap(resourceList).map((resource) => JSON.stringify(resource));
  for (const arn of [
    `arn:aws:bedrock:us-east-1:${account}:inference-profile/us.anthropic.claude-sonnet-4-6`,
    'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6',
    'arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-sonnet-4-6',
    'arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-6',
  ]) {
    assert.ok(modelGrants.some((resource) => resource.includes(arn)),
      `Runtime needs the approved profile and its cross-Region destination model grant: ${arn}`);
  }
  assert.ok(!modelGrants.some((resource) => resource === '"*"'),
    'model invocation must not use a wildcard resource grant');

  assert.ok(Object.hasOwn(runtime.Properties, 'AgentRuntimeArtifact'), 'the deployed Runtime must use a checked artifact');
});

test('controller can read investigation records without acquiring agent invocation or mutation authority', () => {
  const { Resources } = template(controllerTemplatePath, 'controller');
  const [, runTable] = findOne(
    Resources,
    'AWS::DynamoDB::Table',
    ({ Properties }) => Properties.TableName === 'IncidentTriageDemoControllerRun',
    'the existing controller action/run table must remain separate',
  );
  assert.equal(runTable.DeletionPolicy, 'Retain');
  assert.equal(runTable.UpdateReplacePolicy, 'Retain');
  const httpFunction = findOne(
    Resources,
    'AWS::Lambda::Function',
    ({ Properties }) => Properties.FunctionName === 'IncidentTriageDemoControllerHttp',
    'the existing public HTTP handler must remain the discovery entry point',
  );
  const roleId = resourcesOf(Resources, 'AWS::IAM::Role').find(([id]) => references(httpFunction[1].Properties.Role, id))?.[0];
  assert.ok(roleId, 'controller HTTP handler must use its existing scoped role');
  const statements = roleStatements(Resources, roleId);
  const allows = statements.filter(({ Effect }) => Effect === 'Allow');
  const runQueries = allows.filter((statement) => actionList(statement).includes('dynamodb:Query') &&
    resourceList(statement).some((resource) => /Agent.*Run|Run.*Agent/i.test(JSON.stringify(resource))));
  assert.equal(runQueries.length, 1, 'the read-only route needs Query access scoped to the agent run table');
  assert.ok(!allows.some((statement) => actionList(statement).some((action) => /^bedrock-agentcore:InvokeAgentRuntime$/.test(action))),
    'the HTTP route must not manually start an agent investigation');
  assert.ok(!allows.some((statement) => actionList(statement).some((action) => /^dynamodb:(?:PutItem|UpdateItem|DeleteItem|BatchWriteItem|TransactWriteItems)$/.test(action)) &&
    resourceList(statement).some((resource) => JSON.stringify(resource).includes('AgentRun'))),
  'controller discovery must not modify investigation records');
});

