import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
const deployAgent = readFileSync(new URL('../scripts/deploy-agent.sh', import.meta.url), 'utf8');
const appTemplatePath = new URL('../.artifacts/app/cdk/IncidentTriageDemoApp.template.json', import.meta.url);
const agentTemplatePath = new URL('../.artifacts/agent/cdk/IncidentTriageDemoAgent.template.json', import.meta.url);

const account = '027224425948';
const region = 'us-east-1';
const releaseRef = 'refs/heads/demo-deploy';
const mainRef = 'refs/heads/main';
const alarmArn = `arn:aws:cloudwatch:${region}:${account}:alarm:IncidentTriageDemoAppStage5xx`;

function job(name) {
  const match = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+: *$|(?![\\s\\S]))`, 'm'));
  assert.ok(match, `workflow is missing the ${name} job`);
  return match[1];
}

function workflowDispatch() {
  const match = workflow.match(/^  workflow_dispatch:\n([\s\S]*?)\n  push:/m);
  assert.ok(match, 'workflow must retain a workflow_dispatch trigger');
  return match[1];
}

function routeScript() {
  const match = workflow.match(/      - name: Select changed components\n[\s\S]*?\n        run: \|\n([\s\S]*?)(?=^      - name:)/m);
  assert.ok(match, 'workflow must expose the route shell used by the dispatch tests');
  return match[1].replace(/^ {10}/gm, '');
}

function deployStepContaining(pattern, description) {
  const expression = new RegExp(
    `^      - name:[^\\n]+\\n(?:(?!^      - name:)[\\s\\S])*?${pattern.source}(?:(?!^      - name:)[\\s\\S])*(?=^      - name:|(?![\\s\\S]))`,
    'mi',
  );
  const match = job('deploy').match(expression);
  assert.ok(match, `deploy job is missing the ${description} step`);
  return match[0];
}

function template(path, name) {
  assert.ok(existsSync(path), `${name} synthesized template is missing; run the normal component build/synth first`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function resourcesOf(resources, type) {
  return Object.entries(resources ?? {}).filter(([, resource]) => resource.Type === type);
}

function references(value, logicalId) {
  return JSON.stringify(value).includes(`"${logicalId}"`);
}

function oneResource(resources, type, predicate, message) {
  const matches = resourcesOf(resources, type).filter(([, resource]) => predicate(resource));
  assert.equal(matches.length, 1, message);
  return matches[0];
}

function requireMatch(value, pattern, message) {
  assert.match(value, pattern, message);
}

function requireAbsent(value, pattern, message) {
  const text = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  assert.doesNotMatch(text, pattern, message);
}

test('ordinary push, check, and manual component routing remains on the existing release contract', () => {
  const trigger = workflow.match(/^on:\n([\s\S]*?)\n^env:/m)?.[1] ?? '';
  const push = trigger.match(/  push:\n([\s\S]*)/m)?.[1] ?? '';
  assert.deepEqual(new Set([...push.matchAll(/^\s+- (main|demo-deploy)\s*$/gm)].map((match) => match[1])),
    new Set(['main', 'demo-deploy']),
    'normal checks must still run on main and demo-deploy pushes');

  const check = job('check');
  const deploy = job('deploy');
  requireMatch(check, /github\.event_name\s*==\s*['"]pull_request['"]/, 'pull requests remain check-only');
  requireMatch(check, /github\.ref\s*==\s*['"]refs\/heads\/main['"]/, 'main remains checkable');
  requireMatch(check, /github\.ref\s*==\s*['"]refs\/heads\/demo-deploy['"]/, 'demo-deploy remains checkable');
  requireMatch(deploy, /github\.event_name\s*==\s*['"]push['"]\s*\|\|\s*github\.event_name\s*==\s*['"]workflow_dispatch['"]/, 'only push/manual events may publish');
  requireMatch(deploy, /github\.ref\s*==\s*['"]refs\/heads\/demo-deploy['"]/, 'publishing is pinned to demo-deploy');
  requireAbsent(deploy, /refs\/heads\/main/, 'main must never publish cloud stacks');
  requireAbsent(deploy, /fallback|use[-_ ]reference|reference[-_]setup.*failed/i,
    'a failed candidate must not be silently replaced by a reference artifact');

  const dispatch = workflowDispatch();
  for (const component of ['app', 'controller', 'agent']) {
    requireMatch(dispatch, new RegExp(`- ${component}\\b`), `${component} must remain independently dispatchable`);
  }
  requireMatch(dispatch, /reference-setup/, 'the fixed reference-setup operation must be explicit in the dispatch contract');
});

test('the route shell accepts only the fixed reference-setup operation on trusted demo-deploy', (t) => {
  const script = routeScript();
  const directory = mkdtempSync(join(tmpdir(), 'phase19-route-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const outputFor = (eventName, ref, component, rotationFrom = '', rotationTo = '') => {
    const output = join(directory, `${eventName}-${ref.endsWith('main') ? 'main' : 'demo'}-${component}`);
    const rendered = script
      .replaceAll('${{ github.event_name }}', eventName)
      .replaceAll('${{ github.ref }}', ref)
      .replaceAll('${{ github.sha }}', 'a'.repeat(40));
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', rendered], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        DISPATCH_COMPONENT: component,
        DISPATCH_ROTATION_FROM: rotationFrom,
        DISPATCH_ROTATION_TO: rotationTo,
      },
    });
    return { output, result };
  };

  const ordinary = outputFor('workflow_dispatch', releaseRef, 'agent');
  assert.equal(ordinary.result.status, 0, ordinary.result.stderr);
  assert.match(readFileSync(ordinary.output, 'utf8'), /components=\["agent"\]/);

  const reference = outputFor('workflow_dispatch', releaseRef, 'reference-setup');
  assert.equal(reference.result.status, 0, reference.result.stderr);
  assert.match(readFileSync(reference.output, 'utf8'), /components=\["agent"\]/,
    'reference setup must run the agent check/publish lane, not an arbitrary component');

  const wrongBranch = outputFor('workflow_dispatch', mainRef, 'reference-setup');
  assert.notEqual(wrongBranch.result.status, 0,
    'reference setup must be rejected before any main-branch cloud path is selected');

  const invalid = outputFor('workflow_dispatch', releaseRef, 'reference-setup-with-extra-input');
  assert.notEqual(invalid.result.status, 0,
    'reference setup must not accept a caller-selected or decorated operation name');

  const rotatedReference = outputFor('workflow_dispatch', releaseRef, 'reference-setup', 'old-generation', 'new-generation');
  assert.notEqual(rotatedReference.result.status, 0,
    'reference setup must reject app-only credential rotation inputs');
});

test('normal agent publication is structurally separate from the one-time reference setup', () => {
  const deploy = job('deploy');
  const normal = deployStepContaining(/bash scripts\/deploy-agent\.sh/, 'ordinary agent publication');
  const setup = deployStepContaining(/scripts\/[A-Za-z0-9_-]*reference[A-Za-z0-9_-]*\.(?:py|mjs|sh)/i, 'reference setup');

  requireMatch(normal, /if:[\s\S]*?matrix\.component\s*==\s*['"]agent['"]/,
    'normal agent publication retains its component guard');
  requireMatch(normal,
    /(?:needs\.route\.outputs\.(?:mode|operation)\s*!=\s*['"]reference-setup['"]|needs\.route\.outputs\.reference_setup\s*!=\s*['"]true['"]|inputs\.component\s*!=\s*['"]reference-setup['"])/,
    'normal agent publication must explicitly exclude reference setup with a negative operation guard');
  requireAbsent(normal, /scripts\/[A-Za-z0-9_-]*reference[A-Za-z0-9_-]*\.(?:py|mjs|sh)|--(?:candidate|endpoint|runtime|sha|uri)|\$\{\{\s*inputs\./i,
    'normal publication must not invoke the reference setup implementation');
  requireMatch(normal, /bash scripts\/deploy-agent\.sh/, 'normal agent publication must use the checked release shell');

  requireMatch(setup, /if:[\s\S]*?matrix\.component\s*==\s*['"]agent['"]/,
    'reference setup must retain its agent component guard');
  requireMatch(setup,
    /(?:needs\.route\.outputs\.(?:mode|operation)\s*==\s*['"]reference-setup['"]|needs\.route\.outputs\.reference_setup\s*==\s*['"]true['"]|inputs\.component\s*==\s*['"]reference-setup['"])/,
    'reference setup must require the positive fixed operation guard');
  const stepTrusted = /github\.event_name\s*==\s*['"]workflow_dispatch['"]/.test(setup) &&
    /github\.ref\s*==\s*['"]refs\/heads\/demo-deploy['"]/.test(setup);
  const jobTrusted = /github\.event_name\s*==\s*['"]push['"]\s*\|\|\s*github\.event_name\s*==\s*['"]workflow_dispatch['"]/.test(deploy) &&
    /github\.ref\s*==\s*['"]refs\/heads\/demo-deploy['"]/.test(deploy);
  assert.ok(stepTrusted || jobTrusted,
    'reference setup must be guarded by workflow_dispatch/demo-deploy directly or by the verified deploy-job trust boundary');
  requireMatch(setup, /if: .*reference[-_]setup/, 'reference setup must have an explicit dispatch-mode guard');
  requireMatch(setup, /scripts\/[A-Za-z0-9_-]*reference[A-Za-z0-9_-]*\.(?:py|mjs|sh)/i,
    'reference setup must use a dedicated fixed-reference helper');
  requireAbsent(setup, /github\.sha|inputs\.(?:component|rotation_from_generation|rotation_to_generation)|rotation_(?:from|to)|--(?:candidate|endpoint|runtime|sha|uri)/i,
    'reference setup must use fixed reviewed inputs without candidate or rotation arguments');

  requireAbsent(deployAgent, /reference[-_]setup|setup-agent-reference|setup-reference|REFERENCE_(?:SETUP|ARCHIVE)/i,
    'the ordinary deploy shell must never enter the reference path');
  requireAbsent(deployAgent, /(?:update|create|delete)_agent_runtime_endpoint/,
    'ordinary releases must never repin, create, or delete the fixed endpoint');
});

test('synthesized agent CFN relinquishes endpoint ownership while preserving stable outputs and protected resources', () => {
  const agent = template(agentTemplatePath, 'agent');
  const { Resources, Outputs } = agent;
  assert.equal(resourcesOf(Resources, 'AWS::BedrockAgentCore::RuntimeEndpoint').length, 0,
    'the normal agent stack must no longer own a RuntimeEndpoint');
  const [runtimeId, runtime] = oneResource(Resources, 'AWS::BedrockAgentCore::Runtime', () => true,
    'the agent stack must retain exactly one Runtime');
  assert.equal(runtime.Properties.AgentRuntimeName, 'IncidentTriageDemoAgent');
  const [tableId, table] = oneResource(Resources, 'AWS::DynamoDB::Table',
    ({ Properties }) => Properties.TableName === 'IncidentTriageDemoAgentRun',
    'the agent stack must retain its durable run table');
  assert.equal(table.DeletionPolicy, 'Retain');
  assert.equal(table.UpdateReplacePolicy, 'Retain');

  assert.equal(Outputs?.EndpointName?.Value, 'faulty', 'the stable endpoint name output must remain faulty');
  const endpointOutput = Outputs?.FaultyEndpointArn?.Value;
  assert.ok(endpointOutput, 'the stack must continue exposing the stable endpoint ARN');
  assert.match(JSON.stringify(endpointOutput), /runtime-endpoint\/faulty/,
    'the endpoint ARN must be derived from the stable Runtime ARN and fixed endpoint name');
  assert.ok(references(endpointOutput, runtimeId),
    'the endpoint output must reference the retained Runtime, not a removed CFN endpoint');
  requireAbsent(JSON.stringify(endpointOutput), /FaultyEndpoint/,
    'the stable endpoint output must not depend on the removed CFN logical resource');
  assert.ok(references(Outputs.RuntimeArn?.Value, runtimeId), 'RuntimeArn output must remain available');
  assert.ok(references(Outputs.RuntimeId?.Value, runtimeId), 'RuntimeId output must remain available');
  assert.ok(references(Outputs.RunTableName?.Value, tableId), 'run table output must remain available');

  const [adapterId, adapter] = oneResource(Resources, 'AWS::Lambda::Function',
    ({ Properties }) => Properties.FunctionName === 'IncidentTriageDemoAlarmAdapter',
    'the adapter Lambda identity must remain stable');
  assert.equal(adapter.Properties.FunctionName, 'IncidentTriageDemoAlarmAdapter');
  const vars = adapter.Properties.Environment?.Variables ?? {};
  if (Object.hasOwn(vars, 'AGENT_ENDPOINT_NAME')) {
    assert.equal(vars.AGENT_ENDPOINT_NAME, 'faulty');
  } else {
    assert.match(JSON.stringify({ Parameters: agent.Parameters, Outputs }), /faulty/,
      'publisher-owned adapter bindings must remain represented by stable stack parameters/outputs');
  }
  if (Object.hasOwn(vars, 'AGENT_RUNTIME_ARN')) {
    assert.ok(references(vars.AGENT_RUNTIME_ARN, runtimeId), 'adapter must retain the Runtime identity');
  } else {
    assert.ok(references(Outputs.RuntimeArn?.Value, runtimeId),
      'publisher-owned adapter bindings must retain the Runtime identity through a stable output');
  }
  requireAbsent(JSON.stringify(vars.AGENT_SOURCE_REVISION), /SourceRevision/,
    'normal releases must not rewrite the publisher-owned adapter environment to the checked revision');
  requireAbsent(JSON.stringify(vars.AGENT_RUNTIME_ARN), /FaultyEndpoint/,
    'adapter must not reference the removed CFN endpoint logical resource');
  assert.ok(resourcesOf(Resources, 'AWS::Logs::LogGroup').some(([, resource]) =>
    resource.Properties.LogGroupName === '/aws/lambda/IncidentTriageDemoAlarmAdapter' &&
    resource.DeletionPolicy === 'Retain' && resource.UpdateReplacePolicy === 'Retain'),
  'adapter logs must remain protected while endpoint ownership changes');

  const endpointResourceValues = JSON.stringify(Resources);
  const endpointOutputValues = JSON.stringify(Object.values(Outputs ?? {}));
  requireAbsent(endpointResourceValues, /FaultyEndpoint/, 'no CFN resource may reference the removed endpoint');
  requireAbsent(endpointOutputValues, /FaultyEndpoint/, 'no CFN output value may reference the removed endpoint');
});

test('normal template releases preserve native alarm routing to the stable adapter ARN', () => {
  const app = template(appTemplatePath, 'app');
  const agent = template(agentTemplatePath, 'agent');
  const [, alarm] = oneResource(app.Resources, 'AWS::CloudWatch::Alarm',
    ({ Properties }) => Properties.AlarmName === 'IncidentTriageDemoAppStage5xx',
    'the existing native stage alarm must remain');
  assert.equal(alarm.Properties.Namespace, 'AWS/ApiGateway');
  assert.equal(alarm.Properties.MetricName, '5xx');
  assert.equal(alarm.Properties.Period, 60);
  assert.deepEqual(alarm.Properties.Dimensions?.find(({ Name }) => Name === 'Stage'),
    { Name: 'Stage', Value: '$default' });

  const [adapterId, adapter] = oneResource(agent.Resources, 'AWS::Lambda::Function',
    ({ Properties }) => Properties.FunctionName === 'IncidentTriageDemoAlarmAdapter',
    'the stable adapter function must remain present');
  const permission = oneResource(agent.Resources, 'AWS::Lambda::Permission',
    ({ Properties }) => Properties.Principal === 'lambda.alarms.cloudwatch.amazonaws.com' &&
      references(Properties.FunctionName, adapterId),
    'the native alarm service must retain permission to invoke the stable adapter');
  assert.equal(permission[1].Properties.SourceArn, alarmArn,
    'alarm invocation must remain scoped to the exact existing stage alarm');

  const adapterParameter = Object.keys(app.Parameters ?? {})
    .find((key) => /alarm.*adapter.*arn|adapter.*arn/i.test(key));
  assert.ok(adapterParameter, 'app must retain the explicit cross-stack adapter ARN input');
  assert.ok(JSON.stringify(app.Resources).includes(adapterParameter),
    'the alarm action must still consume the adapter ARN input');
});
