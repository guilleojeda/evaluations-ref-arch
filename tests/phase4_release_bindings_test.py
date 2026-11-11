"""Exercise same-revision app/controller binding changes through their real scripts."""
from __future__ import annotations
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
ROOT = Path(__file__).parents[1]
SHA = "a" * 40
RUNTIME = "arn:aws:bedrock-agentcore:us-east-1:027224425948:runtime/IncidentTriageDemoAgent-abcdefghij"
ADAPTER = "arn:aws:lambda:us-east-1:027224425948:function:IncidentTriageDemoAlarmAdapter"
FAKE_AWS = '''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
args=sys.argv[1:]; root=Path(os.environ['FIXTURE_ROOT']); c=json.loads((root/'fixture.json').read_text()); log=root/'aws-calls.jsonl'
with log.open('a') as f:f.write(json.dumps(args)+'\\n')
service,op=args[:2]
if service=='sts' and op=='assume-role': print(json.dumps({'AccessKeyId':'fake','SecretAccessKey':'fake','SessionToken':'fake'}))
elif service=='sts': print('arn:aws:sts::027224425948:assumed-role/cdk-evaltalk-deploy-role-027224425948-us-east-1/fake')
elif service=='cloudformation' and op=='describe-stacks':
 if (root/'executed').exists():c['stack']['Parameters']=c['change']['Parameters']
 print(json.dumps({'Stacks':[c['stack']]}))
elif service=='cloudformation' and op=='describe-change-set':
 if not (root/'prepared').exists(): print('does not exist',file=sys.stderr);sys.exit(255)
 print(json.dumps(c['change']))
elif service=='cloudformation' and op=='get-template': print(json.dumps({'TemplateBody':c['template']}))
elif service=='cloudformation' and op=='execute-change-set': (root/'executed').write_text('yes');print('{}')
elif service=='lambda' and op=='get-alias': print(json.dumps({'Name':'live','FunctionVersion':'11','RoutingConfig':{}}))
elif service=='s3api' and op=='head-object': print(json.dumps({'Metadata':{'sourcerevision':c['sha']},'CacheControl':'no-cache,max-age=0,must-revalidate'}))
elif service=='s3api' and op=='put-object': print('{}')
else: print('Unexpected fake operation '+str(args),file=sys.stderr);sys.exit(2)
'''

class BindingReleaseTests(unittest.TestCase):
    def run_script(self, component, change_binding, already_bound=False):
        with tempfile.TemporaryDirectory(prefix="phase4-bindings-") as directory:
            root = Path(directory)
            (root/'bin').mkdir(); (root/'scripts').mkdir(); (root/'node_modules/.bin').mkdir(parents=True)
            for name in ['check-retained-change-set.mjs', f'check-{component}-change-set.mjs']:
                shutil.copy(ROOT/'scripts'/name, root/'scripts'/name)
            (root/'scripts/affected-stacks.mjs').write_text("console.log('[]');\n")
            (root/'scripts/prepare-inventory-versions.mjs').write_text("""import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(`${process.env.FIXTURE_ROOT}/preparer-args.jsonl`, `${JSON.stringify(args)}\\n`);
const memoryIndex = args.indexOf('--supported-memory-mb');
if (memoryIndex < 0 || args[memoryIndex + 1] !== '256,512') process.exitCode = 1;
""")
            for name, content in [('aws',FAKE_AWS),('git','#!/bin/sh\nexit 0\n')]:
                p=root/'bin'/name;p.write_text(content);p.chmod(0o755)
            cdk=root/'node_modules/.bin/cdk';cdk.write_text('#!/bin/sh\ntouch "$FIXTURE_ROOT/prepared"\n');cdk.chmod(0o755)
            assembly=root/f'.artifacts/{component}/cdk';assembly.mkdir(parents=True)
            stack_name='IncidentTriageDemo'+component.title()
            template={'Resources':{}}
            (assembly/'template.json').write_text(json.dumps(template))
            (assembly/'manifest.json').write_text(json.dumps({'artifacts':{stack_name:{'properties':{'templateFile':'template.json'}}}}))
            outputs={'SourceRevision':SHA,'ApiId':'api123','SiteUrl':'https://api123.execute-api.us-east-1.amazonaws.com','HttpFunctionName':'IncidentTriageDemoControllerHttp','WorkerFunctionName':'IncidentTriageDemoControllerWorker','RunTableName':'IncidentTriageDemoControllerRun','WebBucketName':'web','CheckoutFunctionName':'IncidentTriageDemoCheckout','InventoryFunctionName':'IncidentTriageDemoInventory','CheckoutLiveVersion':'11','InventoryLiveVersion':'11','InventoryRoleArn':'arn:aws:iam::027224425948:role/IncidentTriageDemoAppInventoryRole','InventoryDeniedRoleArn':'arn:aws:iam::027224425948:role/IncidentTriageDemoAppInventoryDeniedRole','InventoryVariantsManifestBucket':'cdk-evaltalk-assets-027224425948-us-east-1','InventoryVariantsManifestKey':f'releases/app/{SHA}/inventory-variants.json','InventoryTableName':'IncidentTriageDemoInventory','InventoryMemorySize':'256','InventorySupportedMemoryMb':'256,512'}
            params={'SourceRevision':SHA,'AlarmAdapterArn':'','AgentRuntimeArn':'','AgentEndpointArn':'','AgentAlarmAdapterArn':'','ControllerOperatorSecretArn':'arn:aws:secretsmanager:us-east-1:027224425948:secret:incident-triage-demo/controller/operator-digest-abcdef','ControllerAppSecretArn':'arn:aws:secretsmanager:us-east-1:027224425948:secret:incident-triage-demo/controller/app-bearer-abcdef'}
            if already_bound: params.update(AlarmAdapterArn=ADAPTER, AgentRuntimeArn=RUNTIME, AgentEndpointArn=RUNTIME+'/runtime-endpoint/faulty', AgentAlarmAdapterArn=ADAPTER)
            desired = {**params, 'AlarmAdapterArn':ADAPTER,'AgentRuntimeArn':RUNTIME,'AgentEndpointArn':RUNTIME+'/runtime-endpoint/faulty','AgentAlarmAdapterArn':ADAPTER}
            change={'StackName':stack_name,'StackId':f'arn:aws:cloudformation:us-east-1:027224425948:stack/{stack_name}/11111111-1111-4111-8111-111111111111','ChangeSetId':'arn:aws:cloudformation:us-east-1:027224425948:changeSet/bind/22222222-2222-4222-8222-222222222222','Status':'CREATE_COMPLETE','ExecutionStatus':'AVAILABLE','Changes':[],'Parameters':[{'ParameterKey':k,'ParameterValue':v} for k,v in desired.items()]}
            fixture={'sha':SHA,'template':template,'stack':{'StackStatus':'UPDATE_COMPLETE','Outputs':[{'OutputKey':k,'OutputValue':v} for k,v in outputs.items()],'Parameters':[{'ParameterKey':k,'ParameterValue':v} for k,v in params.items()]},'change':change}
            (root/'fixture.json').write_text(json.dumps(fixture))
            web=root/'.artifacts/app/web';(web/'assets').mkdir(parents=True);(web/'assets/main.js').write_text('// checked');(web/'index.html').write_text('<html>checked</html>')
            env={**os.environ,'PATH':str(root/'bin')+os.pathsep+os.environ['PATH'],'FIXTURE_ROOT':str(root),'RUNNER_TEMP':str(root),'GITHUB_STEP_SUMMARY':str(root/'summary'),'GITHUB_SHA':SHA,'GITHUB_RUN_ID':'123','PUSH_BASE':SHA,'AWS_REGION':'us-east-1','AWS_ACCOUNT_ID':'027224425948','PHASE0_APP_STACK':'IncidentTriageDemoApp','PHASE0_CONTROLLER_STACK':'IncidentTriageDemoController','PHASE1_WEB_BUCKET':'web','CDK_DEPLOY_ROLE_ARN':'arn:aws:iam::027224425948:role/cdk-evaltalk-deploy-role-027224425948-us-east-1','APP_ALARM_ADAPTER_ARN':ADAPTER if change_binding else '', 'CONTROLLER_AGENT_RUNTIME_ARN':RUNTIME if change_binding else '', 'CONTROLLER_AGENT_ENDPOINT_ARN':RUNTIME+'/runtime-endpoint/faulty' if change_binding else '', 'CONTROLLER_AGENT_ALARM_ADAPTER_ARN':ADAPTER if change_binding else ''}
            result=subprocess.run(['bash',str(ROOT/f'scripts/deploy-{component}.sh')],cwd=root,env=env,text=True,capture_output=True,timeout=15)
            self.assertEqual(0,result.returncode,result.stdout+result.stderr)
            calls=[json.loads(line) for line in (root/'aws-calls.jsonl').read_text().splitlines()]
            executions=[call for call in calls if call[:2]==['cloudformation','execute-change-set']]
            self.assertEqual(1 if change_binding else 0,len(executions),calls)
            if component == 'app':
                preparer_calls=[json.loads(line) for line in (root/'preparer-args.jsonl').read_text().splitlines()]
                self.assertEqual(2,len(preparer_calls),"staging recovery and app preparation must both run")
                for arguments in preparer_calls:
                    memory_index=arguments.index('--supported-memory-mb')
                    self.assertEqual('256,512',arguments[memory_index+1],arguments)
            return result.stdout
    def test_same_sha_wires_app_when_explicit_binding_changes(self): self.run_script('app',True)
    def test_same_sha_wires_controller_when_explicit_binding_changes(self): self.run_script('controller',True)
    def test_empty_app_binding_preserves_previous_wiring(self): self.run_script('app',False,True)
    def test_empty_controller_bindings_preserve_previous_readiness_inputs(self): self.run_script('controller',False,True)
    def test_same_sha_unchanged_app_reuses_release_without_stack_execution(self): self.run_script('app',False)
    def test_same_sha_unchanged_controller_reuses_release_without_stack_execution(self): self.run_script('controller',False)

if __name__=='__main__': unittest.main()
