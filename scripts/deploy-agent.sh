#!/usr/bin/env bash
set -euo pipefail

stack="$PHASE0_AGENT_STACK"
assembly=.artifacts/agent/cdk
change_set_name="phase4-agent-${GITHUB_SHA}"
description="$RUNNER_TEMP/agent-change-set.json"
aws_error="$RUNNER_TEMP/agent-deploy.error"
infrastructure_only="${PHASE20_AGENT_INFRASTRUCTURE_ONLY:-false}"
fixed_bootstrap="${PHASE20_FIXED_BOOTSTRAP:-false}"
test -s "$assembly/manifest.json"
candidate_template="$(jq -er --arg stack "$stack" '.artifacts[$stack].properties.templateFile' "$assembly/manifest.json")"

if [[ "$fixed_bootstrap" == true ]]; then
  [[ "$infrastructure_only" == true ]] || {
    echo "Fixed reference setup must use the infrastructure-only bootstrap path" >&2
    exit 1
  }
  reviewed_revision="${PHASE20_FIXED_SOURCE_REVISION:-}"
  [[ -n "$reviewed_revision" ]] || {
    echo "Fixed bootstrap source revision is missing" >&2
    exit 1
  }
  git cat-file -e "$reviewed_revision^{commit}" || {
    echo "Fixed reference setup cannot verify the reviewed adapter source revision" >&2
    exit 1
  }
  git diff --quiet "$reviewed_revision" -- agent/alarm_adapter.py || {
    echo "Fixed reference setup requires the reviewed alarm adapter source" >&2
    exit 1
  }
fi

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
  local publication_state publication_item
  publication_state="$(deploy_aws dynamodb get-item \
    --table-name IncidentTriageDemoControllerRun \
    --key '{"pk":{"S":"AGENT_PUBLICATION#faulty"}}' \
    --consistent-read --output json)"
  publication_item="$(jq -c '.Item // {}' <<<"$publication_state")"
  if [[ "$publication_item" == "{}" ]]; then
    echo "No fixed AGENT_PUBLICATION#faulty record exists; run the explicit reference setup before an ordinary agent release" >&2
    return 1
  fi

  local publication_candidate publication_status publication_runtime publication_version
  local publication_endpoint_name publication_endpoint publication_revision publication_digest
  local publication_adapter publication_adapter_revision publication_adapter_code
  publication_candidate="$(jq -r '.Item.candidateId.S // empty' <<<"$publication_state")"
  publication_status="$(jq -r '.Item.status.S // empty' <<<"$publication_state")"
  publication_runtime="$(jq -r '.Item.runtimeArn.S // empty' <<<"$publication_state")"
  publication_version="$(jq -r '.Item.runtimeVersion.S // empty' <<<"$publication_state")"
  publication_endpoint_name="$(jq -r '.Item.endpointName.S // empty' <<<"$publication_state")"
  publication_endpoint="$(jq -r '.Item.endpointArn.S // empty' <<<"$publication_state")"
  publication_revision="$(jq -r '.Item.sourceRevision.S // empty' <<<"$publication_state")"
  publication_digest="$(jq -r '.Item.artifactSha256.S // empty' <<<"$publication_state")"
  publication_adapter="$(jq -r '.Item.adapterArn.S // empty' <<<"$publication_state")"
  publication_adapter_revision="$(jq -r '.Item.adapterRevisionId.S // empty' <<<"$publication_state")"
  publication_adapter_code="$(jq -r '.Item.adapterCodeSha256.S // empty' <<<"$publication_state")"
  local runtime_arn runtime_id expected_endpoint
  runtime_arn="$(stack_output RuntimeArn <<<"$stack_state")"
  runtime_id="$(stack_output RuntimeId <<<"$stack_state")"
  expected_endpoint="$runtime_arn/runtime-endpoint/faulty"
  local adapter_code_authority
  adapter_code_authority="$(stack_output AlarmAdapterCodeSha256 <<<"$stack_state")"
  if [[ -z "$adapter_code_authority" ]]; then
    if ! adapter_code_authority="$(jq -er '.adapter.codeSha256 // empty' scripts/faulty-reference.json)"; then
      echo "Agent stack has no adapter-code authority and the fixed initial descriptor is unavailable" >&2
      return 1
    fi
  fi
  [[ "$adapter_code_authority" =~ ^[a-f0-9]{64}$ ]] || {
    echo "Agent stack adapter-code authority is malformed" >&2
    return 1
  }
  [[ "$publication_candidate" == faulty && "$publication_status" == reference &&
     "$publication_runtime" == "$runtime_arn" && "$publication_version" =~ ^[1-9][0-9]*$ &&
     "$publication_endpoint_name" == faulty && "$publication_endpoint" == "$expected_endpoint" &&
     "$publication_revision" =~ ^[a-f0-9]{40}$ && "$publication_digest" =~ ^[a-f0-9]{64}$ &&
     "$publication_adapter" == arn:aws:lambda:us-east-1:027224425948:function:IncidentTriageDemoAlarmAdapter &&
     "$publication_adapter_revision" != "" && "$publication_adapter_code" =~ ^[a-f0-9]{64}$ ]] || {
    echo "Fixed AGENT_PUBLICATION#faulty record is absent, partial, or bound to an unexpected Runtime/adapter" >&2
    return 1
  }

  local adapter_state adapter_env adapter_function adapter_revision adapter_code_sha adapter_code_digest
  adapter_state="$(deploy_aws lambda get-function-configuration --function-name IncidentTriageDemoAlarmAdapter --output json)"
  adapter_env="$(jq -er '.Environment.Variables // empty' <<<"$adapter_state")"
  [[ -n "$adapter_env" ]] || { echo "Agent adapter has no readable environment" >&2; return 1; }
  adapter_function="$(jq -r '.FunctionArn // empty' <<<"$adapter_state")"
  adapter_revision="$(jq -r '.RevisionId // empty' <<<"$adapter_state")"
  adapter_code_sha="$(jq -r '.CodeSha256 // empty' <<<"$adapter_state")"
  if ! adapter_code_digest="$(printf '%s' "$adapter_code_sha" | base64 --decode 2>/dev/null | xxd -p -c 256)"; then
    echo "Agent adapter code hash is unreadable; run the explicit publisher maintenance operation" >&2
    return 1
  fi
  local adapter_runtime adapter_endpoint adapter_version adapter_source adapter_digest
  adapter_runtime="$(jq -r '.AGENT_RUNTIME_ARN // empty' <<<"$adapter_env")"
  adapter_endpoint="$(jq -r '.AGENT_ENDPOINT_NAME // empty' <<<"$adapter_env")"
  adapter_version="$(jq -r '.AGENT_RUNTIME_VERSION // empty' <<<"$adapter_env")"
  adapter_source="$(jq -r '.AGENT_SOURCE_REVISION // empty' <<<"$adapter_env")"
  adapter_digest="$(jq -r '.AGENT_ARTIFACT_SHA256 // empty' <<<"$adapter_env")"
  if [[ "$adapter_code_digest" != "$adapter_code_authority" ]]; then
    echo "Deployed alarm adapter code does not match the checked adapter-code authority" >&2
    return 1
  fi
  [[ "$adapter_function" == "$publication_adapter" &&
     "$adapter_runtime" == "$publication_runtime" && "$adapter_endpoint" == "$publication_endpoint_name" &&
     "$adapter_version" == "$publication_version" && "$adapter_source" == "$publication_revision" &&
     "$adapter_digest" == "$publication_digest" ]] || {
    echo "Agent adapter does not match the strongly read AGENT_PUBLICATION#faulty tuple; run the explicit publisher maintenance operation" >&2
    return 1
  }
  local endpoint_state endpoint_runtime endpoint_arn endpoint_status endpoint_live endpoint_target
  endpoint_state="$(deploy_aws bedrock-agentcore-control get-agent-runtime-endpoint \
    --agent-runtime-id "$runtime_id" --endpoint-name faulty --output json)"
  endpoint_runtime="$(jq -r '.agentRuntimeArn // empty' <<<"$endpoint_state")"
  endpoint_arn="$(jq -r '.agentRuntimeEndpointArn // empty' <<<"$endpoint_state")"
  endpoint_status="$(jq -r '.status // empty' <<<"$endpoint_state")"
  endpoint_live="$(jq -r '.liveVersion // empty' <<<"$endpoint_state")"
  endpoint_target="$(jq -r '.targetVersion // .liveVersion // empty' <<<"$endpoint_state")"
  [[ "$endpoint_runtime" == "$publication_runtime" && "$endpoint_arn" == "$publication_endpoint" &&
     "$endpoint_status" == READY && "$endpoint_live" == "$publication_version" &&
     "$endpoint_target" == "$publication_version" ]] || {
    echo "Native faulty endpoint does not match the strongly read AGENT_PUBLICATION#faulty tuple" >&2
    return 1
  }
  # The publisher row retains the historical adapter code/revision metadata.
  # Independent ordinary adapter releases may change both; the current stack
  # output is the authoritative checked code hash, while the Runtime endpoint
  # and publication environment tuple above remain publisher-owned identity.
  # Lambda RevisionId drift is therefore safe to observe and retry.
  if [[ -n "$adapter_revision" && "$adapter_revision" != "$publication_adapter_revision" ]]; then
    echo "Adapter RevisionId changed during ordinary reconciliation; retaining the verified publisher tuple" >&2
  fi
  published_version="$publication_version"
  published_code_revision="$publication_revision"
  published_artifact_digest="$publication_digest"
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

verify_publisher_parameters() {
  [[ "$(stack_parameter PublishedVersion <<<"$stack_state")" == "$published_version" &&
     "$(stack_parameter PublishedCodeRevision <<<"$stack_state")" == "$published_code_revision" &&
     "$(stack_parameter PublishedArtifactDigest <<<"$stack_state")" == "$published_artifact_digest" &&
     "$(stack_parameter PublishedRuntimeAssetBucket <<<"$stack_state")" == "$bootstrap_runtime_asset_bucket" &&
     "$(stack_parameter PublishedRuntimeAssetKey <<<"$stack_state")" == "$bootstrap_runtime_asset_key" &&
     "$(stack_parameter PublishedRuntimeCodeRevision <<<"$stack_state")" == "$bootstrap_runtime_code_revision" &&
     "$(stack_parameter PublishedRuntimeArtifactDigest <<<"$stack_state")" == "$bootstrap_runtime_artifact_digest" &&
     "$(stack_parameter PublishedRuntimeBootstrapEnabled <<<"$stack_state")" == true ]] || {
    echo "Agent stack parameters do not preserve the freshly verified publisher/bootstrap tuples" >&2
    return 1
  }
}

verify_adapter_code_output() {
  local expected adapter_state adapter_code_sha adapter_code_digest
  expected="$(stack_output AlarmAdapterCodeSha256 <<<"$stack_state")"
  if [[ -z "$expected" ]]; then
    expected="$(jq -er '.adapter.codeSha256 // empty' scripts/faulty-reference.json)" || {
      echo "Agent stack has no adapter-code authority and the fixed initial descriptor is unavailable" >&2
      return 1
    }
  fi
  [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || {
    echo "Agent stack adapter-code authority is malformed" >&2
    return 1
  }
  adapter_state="$(deploy_aws lambda get-function-configuration --function-name IncidentTriageDemoAlarmAdapter --output json)"
  adapter_code_sha="$(jq -r '.CodeSha256 // empty' <<<"$adapter_state")"
  if ! adapter_code_digest="$(printf '%s' "$adapter_code_sha" | base64 --decode 2>/dev/null | xxd -p -c 256)"; then
    echo "Agent adapter code hash is unreadable; run the explicit publisher maintenance operation" >&2
    return 1
  fi
  [[ "$adapter_code_digest" == "$expected" ]] || {
    echo "Deployed alarm adapter code does not match the checked adapter-code authority" >&2
    return 1
  }
}

verify_prepared_publisher_parameters() {
  local prepared_description="$1"
  jq -e \
    --arg version "$published_version" \
    --arg revision "$published_code_revision" \
    --arg digest "$published_artifact_digest" \
    --arg bucket "$bootstrap_runtime_asset_bucket" \
    --arg key "$bootstrap_runtime_asset_key" \
    --arg runtime_revision "$bootstrap_runtime_code_revision" \
    --arg runtime_digest "$bootstrap_runtime_artifact_digest" \
    'def value($name): [.Parameters[]? | select(.ParameterKey == $name) | .ParameterValue];
     value("PublishedVersion") == [$version] and
     value("PublishedCodeRevision") == [$revision] and
     value("PublishedArtifactDigest") == [$digest] and
     value("PublishedRuntimeAssetBucket") == [$bucket] and
     value("PublishedRuntimeAssetKey") == [$key] and
     value("PublishedRuntimeCodeRevision") == [$runtime_revision] and
     value("PublishedRuntimeArtifactDigest") == [$runtime_digest] and
     value("PublishedRuntimeBootstrapEnabled") == ["true"]' \
    "$prepared_description" >/dev/null
}

fresh_stack=false
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
if [[ "$status" == ABSENT || "$status" == REVIEW_IN_PROGRESS ]]; then
  fresh_stack=true
fi

if [[ "$fixed_bootstrap" == true && "$fresh_stack" == false ]]; then
  echo "Fixed reference stack already exists; native reference maintenance owns its verified Runtime/endpoint reconciliation"
  exit 0
fi

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

if [[ "$infrastructure_only" == true ]]; then
  # Stack/adapter-only reconciliation may carry the existing published
  # Runtime/bootstrap tuple, but it cannot create a fresh stack or package a
  # new unchecked Runtime ZIP. The explicit fixed reference setup owns the
  # first stack and initial Runtime asset. Legacy endpoint ownership is
  # handled by the deferred branch above, preserving its fixed setup order.
  [[ "$fresh_stack" == false || "$fixed_bootstrap" == true ]] || {
    echo "Agent infrastructure-only release requires the fixed reference setup on a fresh stack" >&2
    exit 1
  }
  if [[ "$fresh_stack" == false ]]; then
    [[ "$(stack_parameter PublishedRuntimeBootstrapEnabled <<<"$stack_state")" == true ]] || {
    echo "Agent infrastructure-only release requires a publisher-owned Runtime bootstrap tuple" >&2
    exit 1
    }
  fi
  infra_assembly="$RUNNER_TEMP/agent-infrastructure-cdk"
  cp -R "$assembly" "$infra_assembly"
  assets_manifest="$infra_assembly/${stack}.assets.json"
  runtime_asset_id="$(jq -er '.files | to_entries[] | select(.value.displayName == "RuntimeZip") | .key' "$assets_manifest")"
  jq --arg asset_id "$runtime_asset_id" 'del(.files[$asset_id])' "$assets_manifest" > "$assets_manifest.tmp"
  mv "$assets_manifest.tmp" "$assets_manifest"
  assembly="$infra_assembly"
  candidate_template="$(jq -er --arg stack "$stack" '.artifacts[$stack].properties.templateFile' "$assembly/manifest.json")"
  echo "Prepared infrastructure-only agent assembly; the existing published Runtime asset remains the sole bootstrap source"
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
    if verify_publisher_parameters; then
      verify_outputs
      exit 0
    fi
    echo "Same-revision agent stack parameters are stale; continuing with ordinary reconciliation" >&2
  fi
fi

parameter_args=(--parameters "$stack:SourceRevision=$GITHUB_SHA" --parameters "$stack:AppHttpApiId=$app_api_id")
if [[ "$fixed_bootstrap" == true ]]; then
  fixed_bucket="${PHASE20_FIXED_RUNTIME_BUCKET:?}"
  fixed_key="${PHASE20_FIXED_RUNTIME_KEY:?}"
  fixed_revision="${PHASE20_FIXED_RUNTIME_REVISION:?}"
  fixed_digest="${PHASE20_FIXED_RUNTIME_SHA256:?}"
  parameter_args+=(--parameters "$stack:PublishedRuntimeAssetBucket=$fixed_bucket"
    --parameters "$stack:PublishedRuntimeAssetKey=$fixed_key"
    --parameters "$stack:PublishedRuntimeCodeRevision=$fixed_revision"
    --parameters "$stack:PublishedRuntimeArtifactDigest=$fixed_digest"
    --parameters "$stack:PublishedRuntimeBootstrapEnabled=true")
fi
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
  if [[ "$deployed_revision" != "$GITHUB_SHA" ]] && git merge-base --is-ancestor "$GITHUB_SHA" "$deployed_revision"; then
    echo "Agent release superseded by $deployed_revision"
    exit 0
  fi
  git merge-base --is-ancestor "$deployed_revision" "$GITHUB_SHA" || { echo "Agent revisions diverged" >&2; exit 1; }
fi

prepared=false
if deploy_aws cloudformation describe-change-set --stack-name "$stack" --change-set-name "$change_set_name" \
    --include-property-values --output json >"$description" 2>"$aws_error"; then
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

if [[ "$fresh_stack" == false && "$prepared" == true ]] && ! verify_prepared_publisher_parameters "$description"; then
  echo "Prepared agent change set carries a stale or incomplete publisher/bootstrap tuple; discarding it for re-preparation" >&2
  deploy_aws cloudformation delete-change-set --stack-name "$stack" --change-set-name "$change_set_name"
  prepared=false
fi

if [[ "$prepared" == false ]]; then
  # A failed first create can leave these two retained resources unmanaged.
  # Native auto-import preserves them; the checked-template guard below rejects
  # adoption of every other resource and still inspects the complete change set.
  ./node_modules/.bin/cdk deploy "$stack" --app "$assembly" --exclusively \
    --import-existing-resources --method prepare-change-set --change-set-name "$change_set_name" --require-approval never \
    --previous-parameters "${parameter_args[@]}"
  deploy_aws cloudformation describe-change-set --stack-name "$stack" --change-set-name "$change_set_name" \
    --include-property-values --output json >"$description"
fi
node scripts/check-agent-change-set.mjs "$assembly/$candidate_template" <"$description"
if [[ "$fresh_stack" == false ]]; then
  verify_prepared_publisher_parameters "$description" || {
    echo "Agent change set does not carry the freshly verified publisher/bootstrap tuple" >&2
    exit 1
  }
fi

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
if [[ "$fresh_stack" == true ]]; then
  echo "Verified fresh agent stack; no fixed publisher record is required until reference setup"
  verify_adapter_code_output
else
  read_published_binding
  read_bootstrap_binding
  verify_publisher_parameters
fi
verify_outputs
jq -r '.Stacks[0].Outputs[] | "- \(.OutputKey) — \(.OutputValue)"' <<<"$stack_state" >>"$GITHUB_STEP_SUMMARY"
