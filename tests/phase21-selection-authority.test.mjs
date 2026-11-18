import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const account = '027224425948';
const region = 'us-east-1';
const runtimeName = 'IncidentTriageDemoAgent';
const runtimeArn = `arn:aws:bedrock-agentcore:${region}:${account}:runtime/${runtimeName}-7VWTOWDIs4`;
const endpointArn = (name) => `${runtimeArn}/runtime-endpoint/${name}`;
const controllerTableArn = `arn:aws:dynamodb:${region}:${account}:table/IncidentTriageDemoControllerRun`;
const agentTemplatePath = new URL('../.artifacts/agent/cdk/IncidentTriageDemoAgent.template.json', import.meta.url);
const controllerTemplatePath = new URL('../.artifacts/controller/cdk/IncidentTriageDemoController.template.json', import.meta.url);
const cfnExecutionPath = new URL('../infrastructure/bootstrap/phase0-cfn-execution-policy.yaml', import.meta.url);
const githubIamPath = new URL('../infrastructure/bootstrap/github-iam.yaml', import.meta.url);

// Reuse the YAML parser shipped with the repository's pinned aws-cdk-lib.
const require = createRequire(import.meta.url);
const cdkRequire = createRequire(require.resolve('aws-cdk-lib'));
const { parse: parseYaml } = cdkRequire('yaml');
const cloudFormationTags = [{ tag: '!Sub', resolve: (value) => ({ 'Fn::Sub': value }) }];

const selectedKey = 'AGENT_SELECTION';
const publicationKeys = ['AGENT_PUBLICATION#faulty', 'AGENT_PUBLICATION#repaired'];
const ordinaryControllerKeys = ['STATE', 'ACTION#00000000-0000-4000-8000-000000000000', 'RUN#00000000-0000-4000-8000-000000000000'];

// This is a deliberately bounded policy probe, not a replacement for IAM's
// evaluator. It models only the exact actions, ARNs, and DynamoDB leading keys
// exercised below. Unknown resource intrinsics and condition keys fail closed;
// native IAM simulation remains the authority for a live account.

function readJson(path, description) {
  assert.ok(existsSync(path), `${description} synthesized template is missing; run the pinned component synth first`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readYaml(path) {
  return parseYaml(readFileSync(path, 'utf8'), { customTags: cloudFormationTags });
}

function resourcesOf(resources, type) {
  assert.ok(resources && typeof resources === 'object', 'missing CloudFormation Resources section');
  return Object.entries(resources).filter(([, resource]) => resource.Type === type);
}

function findOne(entries, predicate, message) {
  const matches = entries.filter(([id, resource]) => predicate(resource, id));
  assert.equal(matches.length, 1, message);
  return matches[0];
}

function functionRole(template, functionName, description) {
  const [, lambda] = findOne(resourcesOf(template.Resources, 'AWS::Lambda::Function'),
    (resource) => resource.Properties.FunctionName === functionName,
    `missing ${description} Lambda`);
  const role = findOne(resourcesOf(template.Resources, 'AWS::IAM::Role'),
    (_resource, id) => JSON.stringify(lambda.Properties.Role).includes(`"${id}"`),
    `${description} Lambda must use an IAM role`);
  return role;
}

function roleStatements(template, roleId) {
  const role = template.Resources[roleId];
  assert.equal(role?.Type, 'AWS::IAM::Role', `missing IAM role ${roleId}`);
  const inline = (role.Properties.Policies ?? []).map(({ PolicyDocument }) => PolicyDocument);
  const attached = resourcesOf(template.Resources, 'AWS::IAM::Policy')
    .filter(([, policy]) => policy.Properties.Roles?.some(({ Ref }) => Ref === roleId))
    .map(([, policy]) => policy.Properties.PolicyDocument);
  return [...inline, ...attached].flatMap(({ Statement }) => Statement ?? []);
}

function boundaryStatements(bootstrap, policyName) {
  const [, policy] = findOne(resourcesOf(bootstrap.Resources, 'AWS::IAM::ManagedPolicy'),
    (resource) => resource.Properties.ManagedPolicyName === policyName,
    `missing permissions boundary ${policyName}`);
  return policy.Properties.PolicyDocument.Statement ?? [];
}

function githubPolicy(bootstrap, policyName) {
  const [, policy] = findOne(resourcesOf(bootstrap.Resources, 'AWS::IAM::ManagedPolicy'),
    (resource) => resource.Properties.ManagedPolicyName === policyName,
    `missing publisher policy ${policyName}`);
  return policy.Properties.PolicyDocument.Statement ?? [];
}

function actionList(statement) {
  return [statement.Action].flat().filter((value) => typeof value === 'string');
}

function resourceList(statement) {
  return [statement.Resource].flat().filter((value) => value !== undefined);
}

function globMatches(pattern, value) {
  if (typeof pattern !== 'string') return false;
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*')
    .replaceAll('?', '.');
  return new RegExp(`^${expression}$`, 'i').test(value);
}

function actionMatches(pattern, action) {
  return globMatches(pattern, action);
}

function parameterEndpointNames(parameter) {
  const text = JSON.stringify(parameter ?? '').toLowerCase();
  return ['faulty', 'repaired'].filter((name) => text.includes(name));
}

function renderValues(value, template, seen = new Set()) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => renderValues(item, template, seen));
  if (!value || typeof value !== 'object') return [];

  if (Object.hasOwn(value, 'Ref')) {
    const ref = value.Ref;
    const resource = template.Resources?.[ref];
    if (resource?.Type === 'AWS::DynamoDB::Table') {
      return [`arn:aws:dynamodb:${region}:${account}:table/${resource.Properties.TableName}`];
    }
    const parameter = template.Parameters?.[ref];
    if (parameter) {
      const name = ref.toLowerCase();
      if (JSON.stringify(parameter).includes('IncidentTriageDemoControllerRun')) return [controllerTableArn];
      if (name.includes('runtime') && name.includes('arn')) return [runtimeArn];
      if (name.includes('endpoint') && name.includes('arn')) {
        return (parameterEndpointNames(parameter).length ? parameterEndpointNames(parameter) : ['faulty'])
          .map(endpointName => endpointArn(endpointName));
      }
      if (name.includes('controller') && name.includes('table')) return [controllerTableArn];
      if (parameter.Default === 'IncidentTriageDemoControllerRun') return [controllerTableArn];
    }
    if (ref === 'AWS::Region') return [region];
    if (ref === 'AWS::AccountId') return [account];
    return [];
  }

  if (Object.hasOwn(value, 'Fn::GetAtt')) {
    const [logicalId, attribute] = value['Fn::GetAtt'];
    const resource = template.Resources?.[logicalId];
    if (attribute === 'Arn' && resource?.Type === 'AWS::DynamoDB::Table') {
      return [`arn:aws:dynamodb:${region}:${account}:table/${resource.Properties.TableName}`];
    }
    if (attribute === 'AgentRuntimeArn' || resource?.Type === 'AWS::BedrockAgentCore::Runtime') return [runtimeArn];
    if (attribute === 'Arn' && resource?.Type === 'AWS::Lambda::Function') {
      return [`arn:aws:lambda:${region}:${account}:function:${resource.Properties.FunctionName}`];
    }
    return [];
  }

  if (Object.hasOwn(value, 'Fn::Join')) {
    const [separator, parts] = value['Fn::Join'];
    const rendered = parts.map((part) => renderValues(part, template, seen));
    if (rendered.some((values) => values.length === 0)) return [];
    let combinations = [''];
    for (const values of rendered) {
      combinations = combinations.flatMap((prefix) => values.map((valuePart) =>
        prefix ? `${prefix}${separator}${valuePart}` : valuePart));
    }
    return combinations;
  }

  if (Object.hasOwn(value, 'Fn::Sub')) {
    const source = Array.isArray(value['Fn::Sub']) ? value['Fn::Sub'][0] : value['Fn::Sub'];
    const mapping = Array.isArray(value['Fn::Sub']) ? value['Fn::Sub'][1] : {};
    let rendered = source;
    for (const [name, item] of Object.entries(mapping)) {
      rendered = rendered.replaceAll(`\${${name}}`, renderValues(item, template, seen)[0] ?? '');
    }
    rendered = rendered.replaceAll('${AWS::Region}', region).replaceAll('${AWS::AccountId}', account);
    if (rendered.includes('${')) return [];
    return [rendered];
  }

  return [];
}

function statementResourceMatches(statement, template, resource) {
  return resourceList(statement).some((candidate) =>
    renderValues(candidate, template).some((rendered) => globMatches(rendered, resource)));
}

function conditionValues(condition, key) {
  if (!condition || typeof condition !== 'object') return undefined;
  for (const [operator, valuesByKey] of Object.entries(condition)) {
    if (!operator.toLowerCase().includes('string') || !Object.hasOwn(valuesByKey ?? {}, key)) continue;
    const values = [valuesByKey[key]].flat().filter((value) => typeof value === 'string');
    return { operator: operator.toLowerCase(), values };
  }
  return undefined;
}

function conditionAllows(statement, key) {
  const condition = statement.Condition;
  if (!condition) return true;
  const supported = new Set(['dynamodb:LeadingKeys', 'aws:RequestedRegion', 'cloudwatch:namespace']);
  for (const [operator, valuesByKey] of Object.entries(condition)) {
    if (!valuesByKey || typeof valuesByKey !== 'object' ||
        Object.keys(valuesByKey).some((contextKey) => !supported.has(contextKey))) return false;
    for (const contextKey of Object.keys(valuesByKey)) {
      const entry = conditionValues({ [operator]: valuesByKey }, contextKey);
      if (!entry) return false;
      const requested = contextKey === 'dynamodb:LeadingKeys' ? [key]
        : contextKey === 'aws:RequestedRegion' ? [region] : ['bedrock-agentcore'];
      const [operatorBase, quantifier] = entry.operator.split(':').reverse();
      const isNegative = operatorBase.includes('not');
      const isLike = operatorBase.includes('like');
      const matches = (request, expected) => isLike ? globMatches(expected, request) : globMatches(expected, request);
      if (quantifier === 'forallvalues') {
        const result = requested.every((request) => entry.values.some((expected) => matches(request, expected)));
        if (isNegative ? result : !result) return false;
      } else if (quantifier === 'foranyvalue') {
        const result = requested.some((request) => entry.values.some((expected) => matches(request, expected)));
        if (isNegative ? result : !result) return false;
      } else {
        const result = requested.every((request) => entry.values.some((expected) => matches(request, expected)));
        if (isNegative ? result : !result) return false;
      }
    }
  }
  return true;
}

function statementMatches(statement, template, action, resource, key) {
  return actionList(statement).some((pattern) => actionMatches(pattern, action)) &&
    statementResourceMatches(statement, template, resource) && conditionAllows(statement, key);
}

function hasExplicitDeny(statements, template, action, resource, key) {
  return statements.some((statement) => statement.Effect === 'Deny' && statementMatches(statement, template, action, resource, key));
}

function effectiveAllows(role, boundary, template, action, resource, key = 'ordinary') {
  const roleAllows = role.some((statement) => statement.Effect === 'Allow' && statementMatches(statement, template, action, resource, key));
  const boundaryAllows = boundary.some((statement) => statement.Effect === 'Allow' && statementMatches(statement, template, action, resource, key));
  return roleAllows && boundaryAllows &&
    !hasExplicitDeny(role, template, action, resource, key) &&
    !hasExplicitDeny(boundary, template, action, resource, key);
}

function scopedRole(template, functionName, boundaryName, description) {
  const [roleId, role] = functionRole(template, functionName, description);
  assert.equal(role.Properties.PermissionsBoundary,
    `arn:aws:iam::${account}:policy/${boundaryName}`,
  `${description} role must retain its administrator-owned permissions boundary`);
  return { role, statements: roleStatements(template, roleId) };
}

function assertNoEndpointMutation(statements, template, owner) {
  for (const action of [
    'bedrock-agentcore:CreateAgentRuntimeEndpoint',
    'bedrock-agentcore:UpdateAgentRuntimeEndpoint',
    'bedrock-agentcore:DeleteAgentRuntimeEndpoint',
  ]) {
    assert.equal(statements.some((statement) => statement.Effect === 'Allow' &&
      actionList(statement).some((pattern) => actionMatches(pattern, action))), false,
    `${owner} must not pin or delete AgentCore endpoints`);
  }
}

function tableKeyAllowed(statements, template, action, key) {
  return statements.some((statement) => statement.Effect === 'Allow' &&
    statementMatches(statement, template, action, controllerTableArn, key));
}

test('adapter effective permissions read only AGENT_SELECTION and invoke only the named endpoint pair on its Runtime', () => {
  const agent = readJson(agentTemplatePath, 'agent');
  const bootstrap = readYaml(cfnExecutionPath);
  const { role, statements } = scopedRole(agent, 'IncidentTriageDemoAlarmAdapter',
    'IncidentTriageDemoAlarmAdapterBoundary', 'alarm adapter');
  const boundary = boundaryStatements(bootstrap, 'IncidentTriageDemoAlarmAdapterBoundary');

  for (const key of [selectedKey, ...publicationKeys, 'STATE', 'AGENT_SELECTION#other']) {
    const expected = key === selectedKey;
    assert.equal(effectiveAllows(statements, boundary, agent, 'dynamodb:GetItem', controllerTableArn, key), expected,
      `adapter GetItem on ${key} must be ${expected ? 'allowed' : 'denied'} by the effective role boundary`);
  }
  for (const action of ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:TransactWriteItems']) {
    assert.equal(effectiveAllows(statements, boundary, agent, action, controllerTableArn, selectedKey), false,
      `adapter must not mutate the controller table through ${action}`);
  }

  for (const resource of [runtimeArn, endpointArn('faulty'), endpointArn('repaired')]) {
    assert.equal(effectiveAllows(statements, boundary, agent, 'bedrock-agentcore:InvokeAgentRuntime', resource), true,
      `adapter must retain InvokeAgentRuntime for the approved same-Runtime resource ${resource}`);
  }
  for (const resource of [endpointArn('other'), endpointArn('DEFAULT'), `${runtimeArn}/runtime-endpoint/*`,
    `arn:aws:bedrock-agentcore:${region}:${account}:runtime/OtherAgent-7VWTOWDIs4`,
    `arn:aws:bedrock-agentcore:${region}:${account}:runtime/OtherAgent-7VWTOWDIs4/runtime-endpoint/faulty`, '*']) {
    assert.equal(effectiveAllows(statements, boundary, agent, 'bedrock-agentcore:InvokeAgentRuntime', resource), false,
      `adapter must deny InvokeAgentRuntime for an unapproved resource ${resource}`);
  }
  assert.equal(role.Properties.RoleName, 'IncidentTriageDemoAlarmAdapterRole',
    'the existing adapter workload identity remains the owner of the selected invocation path');
});

test('HTTP effective permissions read both publication/native bindings, avoid selector/publication writes, and retain ordinary state access', () => {
  const controller = readJson(controllerTemplatePath, 'controller');
  const bootstrap = readYaml(cfnExecutionPath);
  const { statements } = scopedRole(controller, 'IncidentTriageDemoControllerHttp',
    'IncidentTriageDemoControllerHttpRuntimeBoundary', 'controller HTTP');
  const boundary = boundaryStatements(bootstrap, 'IncidentTriageDemoControllerHttpRuntimeBoundary');

  for (const key of [selectedKey, ...publicationKeys]) {
    assert.equal(effectiveAllows(statements, boundary, controller, 'dynamodb:GetItem', controllerTableArn, key), true,
      `HTTP role must read ${key} from the controller table`);
  }
  for (const key of ordinaryControllerKeys) {
    for (const action of ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:TransactWriteItems']) {
      assert.equal(effectiveAllows(statements, boundary, controller, action, controllerTableArn, key), true,
        `ordinary controller state must retain ${action} on ${key}`);
    }
  }
  for (const key of [selectedKey, ...publicationKeys]) {
    for (const action of ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:TransactWriteItems']) {
      assert.equal(effectiveAllows(statements, boundary, controller, action, controllerTableArn, key), false,
        `HTTP role must not mutate ${key} through ${action}`);
    }
  }

  assert.equal(effectiveAllows(statements, boundary, controller, 'bedrock-agentcore:GetAgentRuntime', runtimeArn), true,
    'HTTP readiness must read the numbered Runtime identity');
  for (const name of ['faulty', 'repaired']) {
    assert.equal(effectiveAllows(statements, boundary, controller, 'bedrock-agentcore:GetAgentRuntimeEndpoint', endpointArn(name)), true,
      `HTTP readiness must read the native ${name} endpoint`);
  }
  for (const resource of [endpointArn('other'), endpointArn('DEFAULT'),
    `arn:aws:bedrock-agentcore:${region}:${account}:runtime/OtherAgent-7VWTOWDIs4`,
    `arn:aws:bedrock-agentcore:${region}:${account}:runtime/OtherAgent-7VWTOWDIs4/runtime-endpoint/faulty`, '*']) {
    assert.equal(effectiveAllows(statements, boundary, controller, 'bedrock-agentcore:GetAgentRuntimeEndpoint', resource), false,
      `HTTP readiness must deny an unapproved native endpoint ${resource}`);
  }
  for (const action of [
    'bedrock-agentcore:InvokeAgentRuntime',
    'bedrock-agentcore:CreateAgentRuntimeEndpoint',
    'bedrock-agentcore:UpdateAgentRuntimeEndpoint',
    'bedrock-agentcore:DeleteAgentRuntimeEndpoint',
  ]) {
    assert.equal(effectiveAllows(statements, boundary, controller, action, endpointArn('faulty')), false,
      `HTTP role must not acquire ${action} authority`);
  }
});

test('action worker owns selection writes while retaining ordinary controller state and fresh native readiness reads', () => {
  const controller = readJson(controllerTemplatePath, 'controller');
  const bootstrap = readYaml(cfnExecutionPath);
  const { statements } = scopedRole(controller, 'IncidentTriageDemoControllerWorker',
    'IncidentTriageDemoControllerWorkerRuntimeBoundary', 'controller worker');
  const boundary = boundaryStatements(bootstrap, 'IncidentTriageDemoControllerWorkerRuntimeBoundary');

  for (const key of [selectedKey, ...publicationKeys]) {
    assert.equal(effectiveAllows(statements, boundary, controller, 'dynamodb:GetItem', controllerTableArn, key), true,
      `worker must read ${key} before selecting or reconciling a publication`);
  }
  assert.equal(['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:TransactWriteItems'].some((action) =>
    effectiveAllows(statements, boundary, controller, action, controllerTableArn, selectedKey)), true,
  'only the action worker may persist the selected publication tuple through its bounded write path');
  for (const key of publicationKeys) {
    for (const action of ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:TransactWriteItems']) {
      assert.equal(effectiveAllows(statements, boundary, controller, action, controllerTableArn, key), false,
        `worker must not mutate publisher-owned ${key} through ${action}`);
    }
  }
  for (const key of ordinaryControllerKeys) {
    for (const action of ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:TransactWriteItems']) {
      assert.equal(effectiveAllows(statements, boundary, controller, action, controllerTableArn, key), true,
        `ordinary controller state must retain worker ${action} on ${key}`);
    }
  }

  const stageAlarmArn = `arn:aws:cloudwatch:${region}:${account}:alarm:IncidentTriageDemoAppStage5xx`;
  for (const action of ['cloudwatch:DescribeAlarms', 'cloudwatch:DescribeAlarmHistory']) {
    assert.equal(effectiveAllows(statements, boundary, controller, action, stageAlarmArn), true,
      `worker must retain fresh ${action} access for readiness`);
  }
  for (const functionName of ['IncidentTriageDemoCheckout', 'IncidentTriageDemoInventory']) {
    const functionArn = `arn:aws:lambda:${region}:${account}:function:${functionName}`;
    for (const action of ['lambda:GetAlias', 'lambda:GetFunctionConfiguration', 'lambda:GetFunctionConcurrency']) {
      assert.equal(effectiveAllows(statements, boundary, controller, action, functionArn), true,
        `worker must retain ${action} for current application configuration`);
    }
  }
  const faultyConfiguration = `arn:aws:s3:::cdk-evaltalk-assets-${account}-${region}/agent-reference/7febe979fa1365360983d886f9d1dc78b55d9bde91a6fe7357e5f9fd97d2d7a7.json`;
  const repairedConfiguration = `arn:aws:s3:::incident-triage-demo-evidence-${account}-${region}/agent-evaluation/phase20/1f8e45fedee78cc9cc60c8b777c2b3ef51eee53ac00909a3bbf499c78de28cf7/runtime-configuration.json`;
  for (const resource of [faultyConfiguration, repairedConfiguration]) {
    assert.equal(effectiveAllows(statements, boundary, controller, 's3:GetObject', resource), true,
      `worker must read the exact candidate-bound runtime configuration object ${resource}`);
  }
  for (const resource of [
    `arn:aws:s3:::cdk-evaltalk-assets-${account}-${region}/agent-reference/e5ac2ee20d8f3947eb95ceb74094e882a3d8a4a010f2a8e7bf96700dd5906b33.zip`,
    `arn:aws:s3:::incident-triage-demo-evidence-${account}-${region}/agent-evaluation/phase20/1f8e45fedee78cc9cc60c8b777c2b3ef51eee53ac00909a3bbf499c78de28cf7/runtime.zip`,
    `arn:aws:s3:::incident-triage-demo-evidence-${account}-${region}/agent-evaluation/phase20/1f8e45fedee78cc9cc60c8b777c2b3ef51eee53ac00909a3bbf499c78de28cf7/qualification.json`,
    `arn:aws:s3:::cdk-evaltalk-assets-${account}-${region}/agent-reference/DEFAULT.json`,
    `arn:aws:s3:::incident-triage-demo-evidence-${account}-${region}/agent-evaluation/phase20/DEFAULT/runtime-configuration.json`,
  ]) {
    assert.equal(effectiveAllows(statements, boundary, controller, 's3:GetObject', resource), false,
      `worker must not read reports, ZIPs, DEFAULT, or another non-source object ${resource}`);
  }
  assert.equal(effectiveAllows(statements, boundary, controller, 'bedrock-agentcore:GetAgentRuntime', runtimeArn), true,
    'worker readiness must read the numbered Runtime identity');
  for (const name of ['faulty', 'repaired']) {
    assert.equal(effectiveAllows(statements, boundary, controller, 'bedrock-agentcore:GetAgentRuntimeEndpoint', endpointArn(name)), true,
      `worker readiness must read the native ${name} endpoint`);
  }
  assert.equal(effectiveAllows(statements, boundary, controller,
    'bedrock-agentcore:GetAgentRuntimeEndpoint', endpointArn('DEFAULT')), false,
  'worker readiness must deny the DEFAULT presentation endpoint');
  assert.equal(effectiveAllows(statements, boundary, controller,
    'bedrock-agentcore:GetAgentRuntimeEndpoint', endpointArn('other')), false,
  'worker readiness must deny an unapproved endpoint name');
  for (const action of [
    'bedrock-agentcore:InvokeAgentRuntime',
    'bedrock-agentcore:CreateAgentRuntimeEndpoint',
    'bedrock-agentcore:UpdateAgentRuntimeEndpoint',
    'bedrock-agentcore:DeleteAgentRuntimeEndpoint',
  ]) {
    assert.equal(effectiveAllows(statements, boundary, controller, action, endpointArn('faulty')), false,
      `worker must not acquire ${action} authority`);
  }
});

test('publisher policies write prepared publication keys but never AGENT_SELECTION', () => {
  const github = readYaml(githubIamPath);
  const policies = [
    ['IncidentTriageDemoPhase19Publisher', ['AGENT_PUBLICATION#faulty'], ['AGENT_PUBLICATION#faulty']],
    ['IncidentTriageDemoGitHubRepairedPublisher', publicationKeys, ['AGENT_PUBLICATION#repaired']],
  ];
  for (const [policyName, readableKeys, writableKeys] of policies) {
    const statements = githubPolicy(github, policyName);
    const tableStatements = statements.filter((statement) =>
      statement.Effect === 'Allow' && statementResourceMatches(statement, {}, controllerTableArn) &&
      actionList(statement).some((pattern) => /^dynamodb:/.test(pattern)));
    assert.ok(tableStatements.length > 0, `${policyName} must retain scoped controller publication access`);
    for (const key of [selectedKey, ...publicationKeys, 'STATE', 'ACTION#not-publisher']) {
      const readable = tableStatements.some((statement) =>
        statementMatches(statement, {}, 'dynamodb:GetItem', controllerTableArn, key));
      const writable = tableStatements.some((statement) =>
        statementMatches(statement, {}, 'dynamodb:PutItem', controllerTableArn, key));
      if (key === selectedKey || key === 'STATE' || key === 'ACTION#not-publisher') {
        assert.equal(readable, false, `${policyName} must not read non-publication key ${key}`);
        assert.equal(writable, false, `${policyName} must not write non-publication key ${key}`);
      } else {
        assert.equal(readable, readableKeys.includes(key), `${policyName} publication read scope must match ${key}`);
        assert.equal(writable, writableKeys.includes(key), `${policyName} publication write scope must match ${key}`);
      }
    }
    assert.equal(tableStatements.some((statement) => JSON.stringify(statement).includes(selectedKey)), false,
      `${policyName} must not mention or grant the live selection record`);
  }
});

test('endpoint pinning remains publisher-only and each publisher is limited to its named endpoint on the shared Runtime', () => {
  const github = readYaml(githubIamPath);
  const agent = readJson(agentTemplatePath, 'agent');
  const controller = readJson(controllerTemplatePath, 'controller');
  const bootstrap = readYaml(cfnExecutionPath);
  const adapter = scopedRole(agent, 'IncidentTriageDemoAlarmAdapter',
    'IncidentTriageDemoAlarmAdapterBoundary', 'alarm adapter');
  const adapterBoundary = boundaryStatements(bootstrap, 'IncidentTriageDemoAlarmAdapterBoundary');
  const http = scopedRole(controller, 'IncidentTriageDemoControllerHttp',
    'IncidentTriageDemoControllerHttpRuntimeBoundary', 'controller HTTP');
  const httpBoundary = boundaryStatements(bootstrap, 'IncidentTriageDemoControllerHttpRuntimeBoundary');
  const worker = scopedRole(controller, 'IncidentTriageDemoControllerWorker',
    'IncidentTriageDemoControllerWorkerRuntimeBoundary', 'controller worker');
  const workerBoundary = boundaryStatements(bootstrap, 'IncidentTriageDemoControllerWorkerRuntimeBoundary');
  assertNoEndpointMutation(adapter.statements, agent, 'alarm adapter');
  assertNoEndpointMutation(http.statements, controller, 'controller HTTP');
  assertNoEndpointMutation(worker.statements, controller, 'controller worker');
  assert.equal(effectiveAllows(adapter.statements, adapterBoundary, agent,
    'bedrock-agentcore:UpdateAgentRuntimeEndpoint', endpointArn('faulty')), false,
  'adapter boundary must keep endpoint ownership out of the product workload');
  assert.equal(effectiveAllows(http.statements, httpBoundary, controller,
    'bedrock-agentcore:UpdateAgentRuntimeEndpoint', endpointArn('repaired')), false,
  'HTTP boundary must keep endpoint ownership out of the controller workload');
  assert.equal(effectiveAllows(worker.statements, workerBoundary, controller,
    'bedrock-agentcore:UpdateAgentRuntimeEndpoint', endpointArn('repaired')), false,
  'worker boundary must keep endpoint ownership out of the controller workload');

  for (const [policyName, writeEndpoint] of [
    ['IncidentTriageDemoPhase19Publisher', 'faulty'],
    ['IncidentTriageDemoGitHubRepairedPublisher', 'repaired'],
  ]) {
    const statements = githubPolicy(github, policyName);
    const endpointWrites = statements.filter((statement) => statement.Effect === 'Allow' &&
      actionList(statement).some((pattern) => actionMatches(pattern, 'bedrock-agentcore:UpdateAgentRuntimeEndpoint')));
    assert.ok(endpointWrites.length > 0, `${policyName} must own its endpoint pin update`);
    assert.equal(endpointWrites.some((statement) => statementResourceMatches(statement, {}, endpointArn(writeEndpoint))), true,
      `${policyName} must update only its named ${writeEndpoint} endpoint on the approved Runtime`);
    for (const resource of [endpointArn(writeEndpoint === 'faulty' ? 'repaired' : 'faulty'), endpointArn('other'), endpointArn('DEFAULT'),
      `arn:aws:bedrock-agentcore:${region}:${account}:runtime/OtherAgent-7VWTOWDIs4/runtime-endpoint/${writeEndpoint}`, '*']) {
      assert.equal(endpointWrites.some((statement) => statementResourceMatches(statement, {}, resource)), false,
        `${policyName} must not pin an unapproved endpoint ${resource}`);
    }
    assert.equal(statements.some((statement) => statement.Effect === 'Allow' &&
      actionList(statement).some((pattern) => actionMatches(pattern, 'bedrock-agentcore:DeleteAgentRuntimeEndpoint'))), false,
    `${policyName} must not acquire endpoint deletion authority`);
  }
});
