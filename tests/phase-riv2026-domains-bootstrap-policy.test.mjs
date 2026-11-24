import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const account = '027224425948';
const region = 'us-east-1';
const zoneArn = 'arn:aws:route53:::hostedzone/Z02003753BQ2Y0J10MTK1';
const certificateArn = `arn:aws:acm:${region}:${account}:certificate/*`;
const changeArn = 'arn:aws:route53:::change/*';

const require = createRequire(import.meta.url);
const cdkRequire = createRequire(require.resolve('aws-cdk-lib'));
const { parse: parseYaml } = cdkRequire('yaml');
const template = parseYaml(
  readFileSync(new URL('../infrastructure/bootstrap/phase0-cfn-execution-policy.yaml', import.meta.url), 'utf8'),
  { customTags: [{ tag: '!Sub', resolve: (value) => ({ 'Fn::Sub': value }) }] },
);

function policy(name) {
  const resource = Object.values(template.Resources).find(
    ({ Type, Properties }) => Type === 'AWS::IAM::ManagedPolicy' && Properties.ManagedPolicyName === name,
  );
  assert.ok(resource, `missing managed policy ${name}`);
  return resource.Properties.PolicyDocument.Statement;
}

function statement(statements, sid) {
  const found = statements.find((candidate) => candidate.Sid === sid);
  assert.ok(found, `missing ${sid}`);
  return found;
}

function actions(candidate) {
  return new Set([candidate.Action].flat());
}

test('Riv2026 app bootstrap grants stay on the storefront certificate and delegated records', () => {
  const statements = policy('IncidentTriageDemoAppCustomDomainCfnExecution');
  const request = statement(statements, 'RequestAppCustomDomainCertificate');
  assert.deepEqual(request.Resource, '*');
  assert.deepEqual(actions(request), new Set(['acm:RequestCertificate']));
  assert.deepEqual(request.Condition.StringEquals, {
    'aws:RequestedRegion': region,
    'acm:ValidationMethod': 'DNS',
  });
  assert.deepEqual(request.Condition['ForAllValues:StringEquals']['acm:DomainNames'], [
    'store.riv2026.guilleojeda.com',
  ]);

  const tagCertificate = statement(statements, 'TagAppCustomDomainCertificate');
  assert.deepEqual(tagCertificate.Resource, certificateArn);
  assert.deepEqual(actions(tagCertificate), new Set(['acm:AddTagsToCertificate']));
  assert.deepEqual(tagCertificate.Condition.StringEquals, {
    'aws:RequestTag/Project': 'IncidentTriageDemo',
    'aws:RequestTag/Component': 'app',
  });
  const readCertificate = statement(statements, 'ReadAppCustomDomainCertificateTags');
  assert.deepEqual(readCertificate.Resource, certificateArn);
  assert.deepEqual(actions(readCertificate), new Set([
    'acm:DescribeCertificate',
    'acm:ListTagsForCertificate',
  ]));
  assert.equal(readCertificate.Condition, undefined, 'certificate metadata reads must work before ownership tags exist');
  const certificate = statement(statements, 'ManageAppCustomDomainCertificate');
  assert.deepEqual(certificate.Resource, certificateArn);
  assert.deepEqual(actions(certificate), new Set(['acm:DeleteCertificate']));
  assert.deepEqual(certificate.Condition.StringEquals, {
    'aws:ResourceTag/Project': 'IncidentTriageDemo',
    'aws:ResourceTag/Component': 'app',
  });

  const readZone = statement(statements, 'ReadAppCustomDomainZone');
  assert.deepEqual(readZone.Resource, zoneArn);
  assert.deepEqual(actions(readZone), new Set([
    'route53:GetHostedZone',
    'route53:ListResourceRecordSets',
  ]));

  const changeRecords = statement(statements, 'ChangeAppCustomDomainRecords');
  assert.deepEqual(changeRecords.Resource, zoneArn);
  assert.deepEqual(actions(changeRecords), new Set(['route53:ChangeResourceRecordSets']));
  assert.deepEqual(changeRecords.Condition['ForAllValues:StringLike']['route53:ChangeResourceRecordSetsNormalizedRecordNames'], [
    'store.riv2026.guilleojeda.com',
    '_*.store.riv2026.guilleojeda.com',
  ]);
  assert.deepEqual(changeRecords.Condition['ForAllValues:StringEquals']['route53:ChangeResourceRecordSetsRecordTypes'], [
    'A', 'AAAA', 'CNAME',
  ]);
  assert.deepEqual(changeRecords.Condition['ForAllValues:StringEquals']['route53:ChangeResourceRecordSetsActions'], [
    'CREATE', 'UPSERT', 'DELETE',
  ]);
  assert.deepEqual(statement(statements, 'ReadAppCustomDomainChanges').Resource, changeArn);

});

test('Riv2026 controller bootstrap grants map only its API custom domain', () => {
  const statements = policy('IncidentTriageDemoControllerCustomDomainCfnExecution');
  const create = statement(statements, 'CreateControllerCustomDomain');
  assert.deepEqual(create.Resource, `arn:aws:apigateway:${region}::/domainnames`);
  assert.deepEqual(actions(create), new Set(['apigateway:POST']));
  assert.equal(create.Condition, undefined, 'observed V2 CloudFormation create supplies no request condition or tag context');

  const manage = statement(statements, 'ManageControllerCustomDomain');
  assert.deepEqual(manage.Resource, [
    `arn:aws:apigateway:${region}::/domainnames/controller.riv2026.guilleojeda.com`,
    `arn:aws:apigateway:${region}::/domainnames/controller.riv2026.guilleojeda.com/apimappings`,
    `arn:aws:apigateway:${region}::/domainnames/controller.riv2026.guilleojeda.com/apimappings/*`,
  ]);
  assert.deepEqual(actions(manage), new Set([
    'apigateway:DELETE',
    'apigateway:GET',
    'apigateway:PATCH',
    'apigateway:POST',
    'apigateway:PUT',
  ]));

  const request = statement(statements, 'RequestControllerCustomDomainCertificate');
  assert.deepEqual(request.Condition['ForAllValues:StringEquals']['acm:DomainNames'], [
    'controller.riv2026.guilleojeda.com',
  ]);
  const tagCertificate = statement(statements, 'TagControllerCustomDomainCertificate');
  assert.deepEqual(tagCertificate.Resource, certificateArn);
  assert.deepEqual(tagCertificate.Condition.StringEquals, {
    'aws:RequestTag/Project': 'IncidentTriageDemo',
    'aws:RequestTag/Component': 'controller',
  });
  const readCertificate = statement(statements, 'ReadControllerCustomDomainCertificateTags');
  assert.deepEqual(readCertificate.Resource, certificateArn);
  assert.deepEqual(actions(readCertificate), new Set([
    'acm:DescribeCertificate',
    'acm:ListTagsForCertificate',
  ]));
  assert.equal(readCertificate.Condition, undefined, 'certificate metadata reads must work before ownership tags exist');
  const certificate = statement(statements, 'ManageControllerCustomDomainCertificate');
  assert.deepEqual(certificate.Condition.StringEquals, {
    'aws:ResourceTag/Project': 'IncidentTriageDemo',
    'aws:ResourceTag/Component': 'controller',
  });
  assert.deepEqual(certificate.Resource, certificateArn);
  assert.deepEqual(actions(certificate), new Set(['acm:DeleteCertificate']));

  const readZone = statement(statements, 'ReadControllerCustomDomainZone');
  assert.deepEqual(readZone.Resource, zoneArn);
  assert.deepEqual(actions(readZone), new Set([
    'route53:GetHostedZone',
    'route53:ListResourceRecordSets',
  ]));
  const changeRecords = statement(statements, 'ChangeControllerCustomDomainRecords');
  assert.deepEqual(changeRecords.Resource, zoneArn);
  assert.deepEqual(changeRecords.Condition['ForAllValues:StringLike']['route53:ChangeResourceRecordSetsNormalizedRecordNames'], [
    'controller.riv2026.guilleojeda.com',
    '_*.controller.riv2026.guilleojeda.com',
  ]);
  assert.deepEqual(changeRecords.Condition['ForAllValues:StringEquals']['route53:ChangeResourceRecordSetsRecordTypes'], [
    'A', 'CNAME',
  ]);
  assert.deepEqual(statement(statements, 'ReadControllerCustomDomainChanges').Resource, changeArn);
});

test('custom-domain bootstrap policies do not create or delete DNS zones', () => {
  for (const name of [
    'IncidentTriageDemoAppCustomDomainCfnExecution',
    'IncidentTriageDemoControllerCustomDomainCfnExecution',
    'IncidentTriageDemoControllerCfnExecution',
  ]) {
    const statements = policy(name);
    for (const candidate of statements) {
      for (const action of [candidate.Action].flat()) {
        assert.notEqual(action, 'route53:CreateHostedZone', `${name} must not create hosted zones`);
        assert.notEqual(action, 'route53:DeleteHostedZone', `${name} must not delete hosted zones`);
      }
    }
  }
});
