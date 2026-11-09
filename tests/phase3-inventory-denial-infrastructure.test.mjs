import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const account = '027224425948';
const region = 'us-east-1';
const alarmName = 'IncidentTriageDemoAppStage5xx';
const inventoryArn = `arn:aws:dynamodb:${region}:${account}:table/IncidentTriageDemoInventory`;
const inventoryRoleArn = `arn:aws:iam::${account}:role/IncidentTriageDemoAppInventoryRole`;
const inventoryDeniedRoleName = 'IncidentTriageDemoAppInventoryDeniedRole';
const inventoryDeniedRoleArn = `arn:aws:iam::${account}:role/${inventoryDeniedRoleName}`;
const inventoryPolicyArn = `arn:aws:iam::${account}:policy/IncidentTriageDemoInventoryReadDeny`;
const assetBucketArn = `arn:aws:s3:::cdk-evaltalk-assets-${account}-${region}`;
const evidenceName = `incident-triage-demo-evidence-${account}-${region}`;

function template(component, name) {
  return JSON.parse(readFileSync(new URL(`../.artifacts/${component}/cdk/${name}.template.json`, import.meta.url)));
}

function resourcesOf(resources, type) {
  return Object.entries(resources).filter(([, resource]) => resource.Type === type);
}

function roleStatements(resources, roleName) {
  const entry = resourcesOf(resources, 'AWS::IAM::Role')
    .find(([, role]) => role.Properties.RoleName === roleName);
  assert.ok(entry, `missing runtime role ${roleName}`);
  const [logicalId, role] = entry;
  const inline = (role.Properties.Policies ?? []).map((policy) => policy.PolicyDocument);
  const attached = resourcesOf(resources, 'AWS::IAM::Policy')
    .filter(([, policy]) => policy.Properties.Roles.some((ref) => ref.Ref === logicalId))
    .map(([, policy]) => policy.Properties.PolicyDocument);
  return [...inline, ...attached].flatMap(({ Statement }) => Statement)
    .filter(({ Effect }) => Effect === 'Allow');
}

function allRoleStatements(resources, roleName) {
  const entry = resourcesOf(resources, 'AWS::IAM::Role')
    .find(([, role]) => role.Properties.RoleName === roleName);
  assert.ok(entry, `missing runtime role ${roleName}`);
  const [logicalId, role] = entry;
  const inline = (role.Properties.Policies ?? []).map((policy) => policy.PolicyDocument);
  const attached = resourcesOf(resources, 'AWS::IAM::Policy')
    .filter(([, policy]) => policy.Properties.Roles.some((ref) => ref.Ref === logicalId))
    .map(([, policy]) => policy.Properties.PolicyDocument);
  return [...inline, ...attached].flatMap(({ Statement }) => Statement);
}

function grants(statements, action) {
  return statements.filter(({ Action }) => [Action].flat().some((pattern) => {
    const escaped = pattern.split('*').map((part) => RegExp.escape(part)).join('.*');
    return new RegExp(`^${escaped}$`, 'i').test(action);
  }))
    .flatMap(({ Resource }) => [Resource].flat());
}

test('app alarm watches the real HTTP API stage and publishes the target for the controller', () => {
  const { Resources, Outputs } = template('app', 'IncidentTriageDemoApp');
  const [[apiId]] = resourcesOf(Resources, 'AWS::ApiGatewayV2::Api');
  const alarms = resourcesOf(Resources, 'AWS::CloudWatch::Alarm');
  assert.equal(alarms.length, 1, 'the app needs one neutral stage alarm');
  const [[, { Properties: alarm }]] = alarms;
  assert.equal(alarm.AlarmName, alarmName);
  assert.equal(alarm.Namespace, 'AWS/ApiGateway');
  assert.equal(alarm.MetricName, '5xx');
  assert.equal(alarm.Statistic, 'Sum');
  assert.equal(alarm.Period, 60);
  assert.equal(alarm.Threshold, 1);
  assert.equal(alarm.ComparisonOperator, 'GreaterThanOrEqualToThreshold');
  assert.equal(alarm.EvaluationPeriods, 1);
  assert.equal(alarm.DatapointsToAlarm ?? alarm.EvaluationPeriods, 1);
  assert.equal(alarm.TreatMissingData, 'notBreaching');
  assert.deepEqual(Object.fromEntries(alarm.Dimensions.map(({ Name, Value }) => [Name, Value])),
    { ApiId: { Ref: apiId }, Stage: '$default' });
  assert.deepEqual(alarm.AlarmActions ?? [], []);
  assert.ok(Outputs.StageAlarmName?.Value && Outputs.StageAlarmArn?.Value && Outputs.InventoryRoleArn?.Value);
  assert.equal(Outputs.InventoryVariantsManifestBucket?.Value, `cdk-evaltalk-assets-${account}-${region}`);
  assert.match(Outputs.InventoryVariantsManifestKey?.Value ?? '', /releases\/app\//);
  assert.ok(Outputs.InventoryDeniedRoleArn?.Value);
});

test('app publishes a static denied role with the existing exact-table policy', () => {
  const { Resources } = template('app', 'IncidentTriageDemoApp');
  const role = resourcesOf(Resources, 'AWS::IAM::Role')
    .find(([, resource]) => resource.Properties.RoleName === inventoryDeniedRoleName);
  assert.ok(role, `missing ${inventoryDeniedRoleName}`);
  const [, roleResource] = role;
  assert.deepEqual(roleResource.Properties.ManagedPolicyArns, [inventoryPolicyArn]);
  assert.equal(roleResource.Properties.PermissionsBoundary,
    `arn:aws:iam::${account}:policy/IncidentTriageDemoAppInventoryRuntimeBoundary`);

  const healthy = resourcesOf(Resources, 'AWS::IAM::Role')
    .find(([, resource]) => resource.Properties.RoleName === 'IncidentTriageDemoAppInventoryRole');
  assert.ok(healthy, 'missing healthy Inventory role');
  assert.ok(!(healthy[1].Properties.ManagedPolicyArns ?? []).includes(inventoryPolicyArn),
    'healthy role must not carry the denial policy');
  assert.equal(resourcesOf(Resources, 'AWS::S3::Bucket').length, 1,
    'the manifest uses the existing CDK asset bucket, not a new bucket');
});

test('controller evidence is private and the worker can only read the prepared pair and update its alias', () => {
  const { Resources } = template('controller', 'IncidentTriageDemoController');
  const bucket = resourcesOf(Resources, 'AWS::S3::Bucket')
    .find(([, resource]) => resource.Properties.BucketName === evidenceName);
  assert.ok(bucket, 'missing the private controller evidence bucket');
  const [bucketId, { Properties: props, DeletionPolicy, UpdateReplacePolicy }] = bucket;
  for (const key of ['BlockPublicAcls', 'BlockPublicPolicy', 'IgnorePublicAcls', 'RestrictPublicBuckets']) {
    assert.equal(props.PublicAccessBlockConfiguration?.[key], true, key);
  }
  assert.equal(DeletionPolicy, 'Retain');
  assert.equal(UpdateReplacePolicy, 'Retain');

  const http = roleStatements(Resources, 'IncidentTriageDemoControllerHttpRole');
  const worker = roleStatements(Resources, 'IncidentTriageDemoControllerWorkerRole');
  const workerAll = allRoleStatements(Resources, 'IncidentTriageDemoControllerWorkerRole');
  const httpAll = allRoleStatements(Resources, 'IncidentTriageDemoControllerHttpRole');
  assert.deepEqual(grants(worker, 'dynamodb:GetResourcePolicy'), [inventoryArn],
    'read-only table-policy observation remains available for configuration evidence');
  assert.deepEqual(grants(http, 'dynamodb:GetResourcePolicy'), []);
  assert.deepEqual(grants(worker, 'dynamodb:PutResourcePolicy'), [], 'old table-policy mutation must be removed');
  assert.deepEqual(grants(worker, 'dynamodb:DeleteResourcePolicy'), [], 'old table-policy mutation must be removed');

  const iam = (action) => workerAll.filter(({ Action }) => [Action].flat().includes(action));
  assert.deepEqual(iam('iam:ListAttachedRolePolicies').map(({ Resource }) => [Resource].flat()).flat(),
    [inventoryRoleArn, inventoryDeniedRoleArn]);
  assert.deepEqual(iam('iam:GetPolicy').map(({ Resource }) => [Resource].flat()).flat(), [inventoryPolicyArn]);
  assert.deepEqual(iam('iam:GetPolicyVersion').map(({ Resource }) => [Resource].flat()).flat(), [inventoryPolicyArn]);
  assert.deepEqual(iam('iam:GetRole').map(({ Resource }) => [Resource].flat()).flat(),
    [inventoryRoleArn, inventoryDeniedRoleArn]);
  for (const action of ['iam:AttachRolePolicy', 'iam:DetachRolePolicy']) {
    assert.deepEqual(iam(action), [], `${action} must be retired from the runtime worker`);
  }
  assert.deepEqual(httpAll.filter(({ Action }) => [Action].flat().some((value) => /^iam:(?:Attach|Detach)RolePolicy$/.test(value))), []);
  const aliasUpdate = grants(worker, 'lambda:UpdateAlias');
  assert.deepEqual(aliasUpdate, [`arn:aws:lambda:${region}:${account}:function:IncidentTriageDemoInventory`]);
  const manifestReads = grants(worker, 's3:GetObject');
  assert.equal(manifestReads.length, 1);
  assert.equal(manifestReads[0], `${assetBucketArn}/releases/app/*/inventory-variants.json`);
  const checkpoint = grants(worker, 's3:PutObject');
  assert.equal(checkpoint.length, 1);
  const destination = JSON.stringify(checkpoint[0]);
  assert.match(destination, /\/configuration\/\*/);
  assert.ok(destination.includes(bucketId) || destination.includes(evidenceName));
  assert.deepEqual(grants(http, 's3:PutObject'), []);
  assert.deepEqual(grants(worker, 's3:DeleteObject'), []);
  assert.deepEqual(grants(http, 'cloudwatch:DescribeAlarms'),
    [`arn:aws:cloudwatch:${region}:${account}:alarm:${alarmName}`]);
});
