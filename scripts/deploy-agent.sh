#!/usr/bin/env bash
set -euo pipefail

stack="$PHASE0_AGENT_STACK"
assembly=.artifacts/agent/cdk
change_set_name="phase4-agent-${GITHUB_SHA}"
description="$RUNNER_TEMP/agent-change-set.json"
aws_error="$RUNNER_TEMP/agent-deploy.error"
test -s "$assembly/manifest.json"
candidate_template="$(jq -er --arg stack "$stack" '.artifacts[$stack].properties.templateFile' "$assembly/manifest.json")"

credentials="$(aws sts assume-role --role-arn "$CDK_DEPLOY_ROLE_ARN" \
  --role-session-name "phase4-agent-${GITHUB_RUN_ID}" --duration-seconds 3300 --query Credentials --output json)"
access_key="$(jq -er .AccessKeyId <<<"$credentials")"
secret_key="$(jq -er .SecretAccessKey <<<"$credentials")"
session_token="$(jq -er .SessionToken <<<"$credentials")"
unset credentials

deploy_aws() {
  AWS_ACCESS_KEY_ID="$access_key" AWS_SECRET_ACCESS_KEY="$secret_key" AWS_SESSION_TOKEN="$session_token" aws "$@"
}

caller="$(deploy_aws sts get-caller-identity --query Arn --output text)"
[[ "$caller" == arn:aws:sts::027224425948:assumed-role/cdk-evaltalk-deploy-role-027224425948-us-east-1/* ]]

read_stack() {
  if deploy_aws cloudformation describe-stacks --stack-name "$stack" --output json 2>"$aws_error"; then
    return
  fi
  if grep -q 'does not exist' "$aws_error"; then
    printf '%s\n' '{"Stacks":[]}'
  else
    cat "$aws_error" >&2
    return 1
  fi
}

stack_status() { jq -r '.Stacks[0].StackStatus // "ABSENT"'; }
stack_output() { jq -r --arg key "$1" '.Stacks[0].Outputs[]? | select(.OutputKey == $key) | .OutputValue'; }
stack_parameter() { jq -r --arg key "$1" '.Stacks[0].Parameters[]? | select(.ParameterKey == $key) | .ParameterValue // empty'; }
stack_has_parameter() { jq -e --arg key "$1" '[.Stacks[0].Parameters[]? | select(.ParameterKey == $key)] | length == 1' <<<"$stack_state" >/dev/null; }

read_published_binding() {
  local adapter_state adapter_env parameter_version parameter_revision parameter_digest
  parameter_version="$(stack_parameter PublishedVersion <<<"$stack_state")"
  parameter_revision="$(stack_parameter PublishedCodeRevision <<<"$stack_state")"
  parameter_digest="$(stack_parameter PublishedArtifactDigest <<<"$stack_state")"
  adapter_state="$(deploy_aws lambda get-function-configuration --function-name IncidentTriageDemoAlarmAdapter --output json)"
  adapter_env="$(jq -er '.Environment.Variables // empty' <<<"$adapter_state")"
  [[ -n "$adapter_env" ]] || { echo "Agent adapter has no readable environment" >&2; return 1; }
  local adapter_runtime adapter_endpoint adapter_version adapter_revision adapter_digest
  adapter_runtime="$(jq -r '.AGENT_RUNTIME_ARN // empty' <<<"$adapter_env")"
  adapter_endpoint="$(jq -r '.AGENT_ENDPOINT_NAME // empty' <<<"$adapter_env")"
  adapter_version="$(jq -r '.AGENT_RUNTIME_VERSION // empty' <<<"$adapter_env")"
  adapter_revision="$(jq -r '.AGENT_SOURCE_REVISION // empty' <<<"$adapter_env")"
  adapter_digest="$(jq -r '.AGENT_ARTIFACT_SHA256 // empty' <<<"$adapter_env")"
  if [[ -z "$parameter_version$parameter_revision$parameter_digest" &&
        -z "$adapter_version$adapter_revision$adapter_digest" ]]; then
    published_version=""
    published_code_revision=""
    published_artifact_digest=""
    return 0
  fi
  [[ "$adapter_runtime" == "$(stack_output RuntimeArn <<<"$stack_state")" &&
     "$adapter_endpoint" == faulty && "$adapter_version" =~ ^[1-9][0-9]*$ &&
     "$adapter_revision" =~ ^[a-f0-9]{40}$ && "$adapter_digest" =~ ^[a-f0-9]{64}$ ]] || {
    echo "Agent adapter does not expose a verified publisher tuple; run the explicit publisher maintenance operation" >&2
    return 1
  }
  # Lambda readback is the publisher's current attestation. If an older stack
  # update left retained parameters behind, the next ordinary change carries
  # this verified tuple forward and reconciles those parameters.
  published_version="$adapter_version"
  published_code_revision="$adapter_revision"
  published_artifact_digest="$adapter_digest"
}

read_bootstrap_binding() {
  local parameter_enabled parameter_bucket parameter_key parameter_revision parameter_digest
  parameter_enabled="$(stack_parameter PublishedRuntimeBootstrapEnabled <<<"$stack_state")"
  parameter_bucket="$(stack_parameter PublishedRuntimeAssetBucket <<<"$stack_state")"
  parameter_key="$(stack_parameter PublishedRuntimeAssetKey <<<"$stack_state")"
  parameter_revision="$(stack_parameter PublishedRuntimeCodeRevision <<<"$stack_state")"
  parameter_digest="$(stack_parameter PublishedRuntimeArtifactDigest <<<"$stack_state")"
  if [[ "$parameter_enabled" == true &&
        -n "$parameter_bucket$parameter_key$parameter_revision$parameter_digest" ]]; then
    bootstrap_runtime_enabled=true
    bootstrap_runtime_asset_bucket="$parameter_bucket"
    bootstrap_runtime_asset_key="$parameter_key"
    bootstrap_runtime_code_revision="$parameter_revision"
    bootstrap_runtime_artifact_digest="$parameter_digest"
    return 0
  fi
  # Before the first ordinary post-cutover update, these parameters do not
  # exist on the legacy stack. Its outputs are the read-back of the deployed
  # Runtime bootstrap artifact and are safe to carry into the new parameters.
  bootstrap_runtime_asset_bucket="${PHASE0_ASSET_BUCKET:-}"
  bootstrap_runtime_asset_key="$(stack_output RuntimeAssetObjectKey <<<"$stack_state")"
  bootstrap_runtime_code_revision="$(stack_output SourceRevision <<<"$stack_state")"
  bootstrap_runtime_artifact_digest="$(stack_output RuntimeArtifactSha256 <<<"$stack_state")"
  [[ "$bootstrap_runtime_asset_bucket" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ &&
     "$bootstrap_runtime_asset_key" != *[[:space:]]* &&
     "$bootstrap_runtime_code_revision" =~ ^[a-f0-9]{40}$ &&
     "$bootstrap_runtime_artifact_digest" =~ ^[a-f0-9]{64}$ ]] || {
    echo "Agent stack does not expose a complete deployed Runtime bootstrap tuple" >&2
    return 1
  }
  bootstrap_runtime_enabled=true
}

verify_outputs() {
  [[ "$(stack_output SourceRevision <<<"$stack_state")" == "$GITHUB_SHA" &&
     "$(stack_output RunTableName <<<"$stack_state")" == IncidentTriageDemoAgentRun ]]
  [[ "$(stack_output EndpointName <<<"$stack_state")" == faulty ]]
  [[ "$(stack_output FaultyEndpointArn <<<"$stack_state")" == "$(stack_output RuntimeArn <<<"$stack_state")/runtime-endpoint/faulty" ]]
  if [[ -n "${bootstrap_runtime_asset_key:-}" ]]; then
    [[ "$(stack_output RuntimeAssetObjectKey <<<"$stack_state")" == "$bootstrap_runtime_asset_key" &&
       "$(stack_output RuntimeArtifactSha256 <<<"$stack_state")" == "$bootstrap_runtime_artifact_digest" ]]
  fi
  echo "Verified ordinary agent release $GITHUB_SHA; publisher tuple unchanged at version $published_version"
}

reconcile_until=$((SECONDS + 720))
while :; do
  stack_state="$(read_stack)"
  status="$(stack_status <<<"$stack_state")"
  case "$status" in
    ABSENT|REVIEW_IN_PROGRESS|CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE) break ;;
    *_IN_PROGRESS|*_CLEANUP_IN_PROGRESS)
      (( SECONDS < reconcile_until )) || { echo "Agent stack is still $status" >&2; exit 1; }
      sleep 15 ;;
    *) echo "Reconcile terminal agent status $status before release" >&2; exit 1 ;;
  esac
done

# The first ordinary post-cutover source push must not execute the endpoint
# removal. It leaves the serving publication untouched and succeeds as a
# visible deferral; the explicit maintenance lane performs the inspected
# one-time change set later.
if [[ "$status" != ABSENT && "$status" != REVIEW_IN_PROGRESS ]]; then
  legacy_resources_error="$RUNNER_TEMP/agent-resources.error"
  if ! legacy_resources="$(deploy_aws cloudformation list-stack-resources --stack-name "$stack" --output json 2>"$legacy_resources_error")"; then
    cat "$legacy_resources_error" >&2
    exit 1
  fi
  legacy_physical_id="$(jq -r '.StackResourceSummaries[]? | select(.LogicalResourceId == "FaultyEndpoint" and .ResourceType == "AWS::BedrockAgentCore::RuntimeEndpoint") | .PhysicalResourceId' <<<"$legacy_resources")"
  if [[ -n "$legacy_physical_id" ]]; then
    jq -cn --arg stack "$stack" --arg physicalId "$legacy_physical_id" \
      '{status:"deferred",reason:"legacy_endpoint_managed",stack:$stack,logicalResourceId:"FaultyEndpoint",physicalResourceId:$physicalId}'
    exit 0
  fi
fi

app_state="$(deploy_aws cloudformation describe-stacks --stack-name "$PHASE0_APP_STACK" --output json)"
app_api_id="$(jq -er '.Stacks[0].Outputs[] | select(.OutputKey == "ApiUrl") | .OutputValue | capture("https://(?<id>[a-z0-9]+)\\.execute-api\\.").id' <<<"$app_state")"

published_version=""
published_code_revision=""
published_artifact_digest=""
if [[ "$status" != ABSENT && "$status" != REVIEW_IN_PROGRESS ]]; then
  read_published_binding
  read_bootstrap_binding
fi

deployed_revision="$(stack_output SourceRevision <<<"$stack_state")"
if [[ "$deployed_revision" == "$GITHUB_SHA" ]]; then
  if stack_has_parameter PublishedVersion && stack_has_parameter PublishedRuntimeBootstrapEnabled; then
    verify_outputs
    exit 0
  fi
fi

parameter_args=(--parameters "$stack:SourceRevision=$GITHUB_SHA" --parameters "$stack:AppHttpApiId=$app_api_id")
if [[ "$status" != ABSENT && "$status" != REVIEW_IN_PROGRESS ]]; then
  parameter_args+=(--parameters "$stack:PublishedVersion=$published_version"
    --parameters "$stack:PublishedCodeRevision=$published_code_revision"
    --parameters "$stack:PublishedArtifactDigest=$published_artifact_digest")
  parameter_args+=(--parameters "$stack:PublishedRuntimeAssetBucket=$bootstrap_runtime_asset_bucket"
    --parameters "$stack:PublishedRuntimeAssetKey=$bootstrap_runtime_asset_key"
    --parameters "$stack:PublishedRuntimeCodeRevision=$bootstrap_runtime_code_revision"
    --parameters "$stack:PublishedRuntimeArtifactDigest=$bootstrap_runtime_artifact_digest"
    --parameters "$stack:PublishedRuntimeBootstrapEnabled=true")
  [[ "$deployed_revision" =~ ^[a-f0-9]{40}$ ]] && git cat-file -e "$deployed_revision^{commit}" || { echo "Invalid deployed agent revision" >&2; exit 1; }
  if git merge-base --is-ancestor "$GITHUB_SHA" "$deployed_revision"; then
    echo "Agent release superseded by $deployed_revision"
    exit 0
  fi
  git merge-base --is-ancestor "$deployed_revision" "$GITHUB_SHA" || { echo "Agent revisions diverged" >&2; exit 1; }
fi

prepared=false
if deploy_aws cloudformation describe-change-set --stack-name "$stack" --change-set-name "$change_set_name" \
    --output json >"$description" 2>"$aws_error"; then
  case "$(jq -r '.Status + ":" + .ExecutionStatus' "$description")" in
    CREATE_COMPLETE:AVAILABLE)
      node scripts/check-agent-change-set.mjs "$assembly/$candidate_template" <"$description"
      prepared=true ;;
    FAILED:*|*:OBSOLETE) deploy_aws cloudformation delete-change-set --stack-name "$stack" --change-set-name "$change_set_name" ;;
    *) echo "Previous agent change set is still in progress or unavailable" >&2; exit 1 ;;
  esac
elif ! grep -Eqi 'does not exist|not found|ChangeSetNotFound' "$aws_error"; then
  cat "$aws_error" >&2
  exit 1
fi

if [[ "$prepared" == false ]]; then
  # A failed first create can leave these two retained resources unmanaged.
  # Native auto-import preserves them; the checked-template guard below rejects
  # adoption of every other resource and still inspects the complete change set.
  ./node_modules/.bin/cdk deploy "$stack" --app "$assembly" --exclusively \
    --import-existing-resources --method prepare-change-set --change-set-name "$change_set_name" --require-approval never \
    --previous-parameters "${parameter_args[@]}"
  deploy_aws cloudformation describe-change-set --stack-name "$stack" --change-set-name "$change_set_name" \
    --output json >"$description"
fi
node scripts/check-agent-change-set.mjs "$assembly/$candidate_template" <"$description"

change_set_id="$(jq -er .ChangeSetId "$description")"
jq -e --arg revision "$GITHUB_SHA" \
  '[.Parameters[] | select(.ParameterKey == "SourceRevision") | .ParameterValue] == [$revision]' \
  "$description" >/dev/null
checked_hash="$(jq -cS . "$assembly/$candidate_template" | sha256sum | cut -d' ' -f1)"
prepared_hash="$(deploy_aws cloudformation get-template --stack-name "$stack" --change-set-name "$change_set_id" \
  --template-stage Original --output json | jq -cS '.TemplateBody | if type == "string" then fromjson else . end' | sha256sum | cut -d' ' -f1)"
[[ "$checked_hash" == "$prepared_hash" ]] || { echo "Agent change set differs from checked assembly" >&2; exit 1; }
echo "Executing inspected agent change set $change_set_id"
deploy_aws cloudformation execute-change-set --stack-name "$stack" --change-set-name "$change_set_id"

deploy_until=$((SECONDS + 1800))
while :; do
  stack_state="$(read_stack)"
  status="$(stack_status <<<"$stack_state")"
  revision="$(stack_output SourceRevision <<<"$stack_state")"
  if [[ ( "$status" == CREATE_COMPLETE || "$status" == UPDATE_COMPLETE ) && "$revision" == "$GITHUB_SHA" ]]; then break; fi
  if [[ "$status" == *ROLLBACK_COMPLETE || "$status" == *_FAILED ]] || (( SECONDS >= deploy_until )); then
    echo "Agent stack did not complete revision $GITHUB_SHA ($status)" >&2
    deploy_aws cloudformation describe-stack-events --stack-name "$stack" --max-items 12 \
      --query 'StackEvents[:12].[LogicalResourceId,ResourceStatus,ResourceStatusReason]' --output text >&2 || true
    exit 1
  fi
  sleep 15
done
read_published_binding
read_bootstrap_binding
verify_outputs
jq -r '.Stacks[0].Outputs[] | "- \(.OutputKey) — \(.OutputValue)"' <<<"$stack_state" >>"$GITHUB_STEP_SUMMARY"
