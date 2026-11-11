#!/usr/bin/env bash
set -euo pipefail

stack="$PHASE0_APP_STACK"
bucket="$PHASE1_WEB_BUCKET"
web=.artifacts/app/web
assembly=.artifacts/app/cdk
description="$RUNNER_TEMP/app-change-set.json"
aws_error="$RUNNER_TEMP/app-deploy.error"
test -s "$assembly/manifest.json"
test -s "$web/index.html"

# CDK uses the original GitHub session to assume the deploy and file-publishing
# roles independently. Use the deploy-role session only for direct AWS calls.
credentials="$(aws sts assume-role --role-arn "$CDK_DEPLOY_ROLE_ARN" \
  --role-session-name "phase1-app-${GITHUB_RUN_ID}" --duration-seconds 3300 --query Credentials --output json)"
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

stack_status() {
  jq -r '.Stacks[0].StackStatus // "ABSENT"'
}

stack_output() {
  jq -r --arg key "$1" '.Stacks[0].Outputs[]? | select(.OutputKey == $key) | .OutputValue'
}

verify_aliases() {
  local name fn expected alias
  for name in Checkout Inventory; do
    fn="$(stack_output "${name}FunctionName" <<<"$stack_state")"
    expected="$(stack_output "${name}LiveVersion" <<<"$stack_state")"
    [[ "$expected" =~ ^[1-9][0-9]*$ && -n "$fn" ]]
    alias="$(deploy_aws lambda get-alias --function-name "$fn" --name live --output json)"
    jq -e --arg version "$expected" \
      '.Name == "live" and .FunctionVersion == $version and ((.RoutingConfig.AdditionalVersionWeights // {}) | length == 0)' \
      <<<"$alias" >/dev/null
    echo "Verified $fn:live -> version $expected"
  done
}

prepare_inventory_versions() {
  local function_name healthy_version healthy_role denied_role manifest_bucket manifest_key table_name supported_memory_mb
  function_name="$(stack_output InventoryFunctionName <<<"$stack_state")"
  healthy_version="$(stack_output InventoryLiveVersion <<<"$stack_state")"
  healthy_role="$(stack_output InventoryRoleArn <<<"$stack_state")"
  denied_role="$(stack_output InventoryDeniedRoleArn <<<"$stack_state")"
  manifest_bucket="$(stack_output InventoryVariantsManifestBucket <<<"$stack_state")"
  manifest_key="$(stack_output InventoryVariantsManifestKey <<<"$stack_state")"
  table_name="$(stack_output InventoryTableName <<<"$stack_state")"
  supported_memory_mb="$(stack_output InventorySupportedMemoryMb <<<"$stack_state")"
  [[ -n "$function_name" && "$healthy_version" =~ ^[1-9][0-9]*$ &&
     "$healthy_role" =~ ^arn:aws:iam::027224425948:role/IncidentTriageDemoAppInventoryRole$ &&
     "$denied_role" =~ ^arn:aws:iam::027224425948:role/IncidentTriageDemoAppInventoryDeniedRole$ &&
     "$manifest_bucket" == cdk-evaltalk-assets-027224425948-us-east-1 &&
     "$manifest_key" == "releases/app/$GITHUB_SHA/inventory-variants.json" &&
     "$table_name" == IncidentTriageDemoInventory &&
     "$supported_memory_mb" =~ ^[1-9][0-9]*(,[1-9][0-9]*)*$ ]]
  AWS_ACCESS_KEY_ID="$access_key" AWS_SECRET_ACCESS_KEY="$secret_key" AWS_SESSION_TOKEN="$session_token" \
    AWS_REGION="$AWS_REGION" AWS_ACCOUNT_ID="$AWS_ACCOUNT_ID" \
    node scripts/prepare-inventory-versions.mjs \
      --function-name "$function_name" \
      --source-revision "$GITHUB_SHA" \
      --healthy-version "$healthy_version" \
      --healthy-role-arn "$healthy_role" \
      --denied-role-arn "$denied_role" \
      --baseline-memory "$(stack_output InventoryMemorySize <<<"$stack_state")" \
      --supported-memory-mb "$supported_memory_mb" \
      --inventory-table-arn "arn:aws:dynamodb:$AWS_REGION:$AWS_ACCOUNT_ID:table/$table_name" \
      --manifest-bucket "$manifest_bucket" \
      --manifest-key "$manifest_key"
}

restore_previous_inventory_staging() {
  local previous_revision function_name healthy_version healthy_role denied_role table_name supported_memory_mb
  previous_revision="$(stack_output SourceRevision <<<"$stack_state")"
  denied_role="$(stack_output InventoryDeniedRoleArn <<<"$stack_state")"
  # Pre-Phase-3 app stacks have no denied-role output and cannot have left
  # prepared staging behind; skip recovery safely for the first app release.
  [[ -n "$denied_role" ]] || return 0
  function_name="$(stack_output InventoryFunctionName <<<"$stack_state")"
  healthy_version="$(stack_output InventoryLiveVersion <<<"$stack_state")"
  healthy_role="$(stack_output InventoryRoleArn <<<"$stack_state")"
  supported_memory_mb="$(stack_output InventorySupportedMemoryMb <<<"$stack_state")"
  # Older app stacks only published their baseline and cannot have staged a
  # higher-memory variant; retain the baseline-only recovery path for them.
  [[ -n "$supported_memory_mb" ]] || supported_memory_mb="$(stack_output InventoryMemorySize <<<"$stack_state")"
  table_name="$(stack_output InventoryTableName <<<"$stack_state")"
  [[ "$previous_revision" =~ ^[a-f0-9]{40}$ && "$function_name" == IncidentTriageDemoInventory &&
     "$healthy_version" =~ ^[1-9][0-9]*$ &&
     "$healthy_role" =~ ^arn:aws:iam::027224425948:role/IncidentTriageDemoAppInventoryRole$ &&
     "$denied_role" =~ ^arn:aws:iam::027224425948:role/IncidentTriageDemoAppInventoryDeniedRole$ &&
     "$table_name" == IncidentTriageDemoInventory &&
     "$supported_memory_mb" =~ ^[1-9][0-9]*(,[1-9][0-9]*)*$ ]]
  AWS_ACCESS_KEY_ID="$access_key" AWS_SECRET_ACCESS_KEY="$secret_key" AWS_SESSION_TOKEN="$session_token" \
    AWS_REGION="$AWS_REGION" AWS_ACCOUNT_ID="$AWS_ACCOUNT_ID" \
    node scripts/prepare-inventory-versions.mjs \
      --restore-staging-only true \
      --function-name "$function_name" \
      --source-revision "$previous_revision" \
      --healthy-version "$healthy_version" \
      --healthy-role-arn "$healthy_role" \
      --denied-role-arn "$denied_role" \
      --baseline-memory "$(stack_output InventoryMemorySize <<<"$stack_state")" \
      --supported-memory-mb "$supported_memory_mb" \
      --inventory-table-arn "arn:aws:dynamodb:$AWS_REGION:$AWS_ACCOUNT_ID:table/$table_name"
}

# Reconcile an earlier job that stopped while CloudFormation was still working.
reconcile_until=$((SECONDS + 720))
while :; do
  stack_state="$(read_stack)"
  status="$(stack_status <<<"$stack_state")"
  case "$status" in
    ABSENT|REVIEW_IN_PROGRESS|CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE) break ;;
    *_IN_PROGRESS|*_CLEANUP_IN_PROGRESS)
      (( SECONDS < reconcile_until )) || { echo "App stack is still $status" >&2; exit 1; }
      sleep 15 ;;
    *) echo "Reconcile terminal app stack status $status before release" >&2; exit 1 ;;
  esac
done

# Reconcile a prior release's recognized role-only staging before preparing a
# new CloudFormation change set. The helper uses the previous revision's
# healthy qualified version and a fresh $LATEST revision guard.
restore_previous_inventory_staging

previous_adapter="$(jq -r '.Stacks[0].Parameters[]? | select(.ParameterKey == "AlarmAdapterArn") | .ParameterValue' <<<"$stack_state")"
desired_adapter="${APP_ALARM_ADAPTER_ARN:-$previous_adapter}"
[[ -z "$desired_adapter" || "$desired_adapter" == arn:aws:lambda:us-east-1:027224425948:function:IncidentTriageDemoAlarmAdapter ]] || { echo "Unexpected alarm adapter ARN" >&2; exit 1; }
binding_changed=false
[[ "$previous_adapter" == "$desired_adapter" ]] || binding_changed=true
binding_hash="$(printf '%s' "$desired_adapter" | sha256sum | cut -c1-12)"
change_set_name="phase1-app-${GITHUB_SHA}-${binding_hash}"
deployed_revision="$(stack_output SourceRevision <<<"$stack_state")"
if [[ "$deployed_revision" == "$GITHUB_SHA" && "$binding_changed" == false ]]; then
  verify_aliases
  prepare_inventory_versions
  if entry="$(deploy_aws s3api head-object --bucket "$bucket" --key index.html \
      --expected-bucket-owner "$AWS_ACCOUNT_ID" 2>"$aws_error")"; then
    if [[ "$(jq -r '.Metadata.sourcerevision // ""' <<<"$entry")" == "$GITHUB_SHA" ]]; then
      echo "App stack and entry page already serve $GITHUB_SHA"
      exit 0
    fi
  elif ! grep -Eq '404|NotFound|NoSuchKey' "$aws_error"; then
    cat "$aws_error" >&2
    exit 1
  fi
  echo "Completing static publication for $GITHUB_SHA"
else
  parameter_args=(--parameters "$stack:SourceRevision=$GITHUB_SHA" --parameters "$stack:AlarmAdapterArn=$desired_adapter")
  if [[ "$status" == ABSENT || "$status" == REVIEW_IN_PROGRESS ]]; then
    base="$PUSH_BASE"
    if [[ "$base" == 0000000000000000000000000000000000000000 ]]; then
      base="$(git rev-list --max-parents=0 "$GITHUB_SHA" | tail -n 1)"
    fi
    if [[ ! "${APP_PRESENTER_DIGEST:-}" =~ ^[a-fA-F0-9]{64}$ ]]; then
      echo "The first app release requires APP_PRESENTER_DIGEST" >&2
      exit 1
    fi
    parameter_args+=(--parameters "$stack:PresenterCredentialDigest=$APP_PRESENTER_DIGEST")
  else
    if [[ ! "$deployed_revision" =~ ^[a-f0-9]{40}$ ]] || ! git cat-file -e "$deployed_revision^{commit}"; then
      echo "App stack has no valid, known SourceRevision" >&2
      exit 1
    fi
    if [[ "$deployed_revision" != "$GITHUB_SHA" ]] && git merge-base --is-ancestor "$GITHUB_SHA" "$deployed_revision"; then
      echo "App release $GITHUB_SHA was superseded by $deployed_revision"
      exit 0
    fi
    git merge-base --is-ancestor "$deployed_revision" "$GITHUB_SHA" || {
      echo "Candidate and deployed app revisions diverged" >&2
      exit 1
    }
    base="$deployed_revision"
  fi
  components="$(node scripts/affected-stacks.mjs "$base" "$GITHUB_SHA")"
  if [[ "$binding_changed" == false ]] && ! jq -e 'index("app") != null' <<<"$components" >/dev/null; then
    echo "No app change from $base to $GITHUB_SHA"
    exit 0
  fi

  # Reuse an available change set when submission had already succeeded.
  prepared=false
  if deploy_aws cloudformation describe-change-set --stack-name "$stack" --change-set-name "$change_set_name" \
      --output json >"$description" 2>"$aws_error"; then
    case "$(jq -r '.Status + ":" + .ExecutionStatus' "$description")" in
      CREATE_COMPLETE:AVAILABLE) prepared=true ;;
      FAILED:*|*:OBSOLETE)
        deploy_aws cloudformation delete-change-set --stack-name "$stack" --change-set-name "$change_set_name" ;;
      *) echo "Previous change set is still in progress or unavailable" >&2; exit 1 ;;
    esac
  elif ! grep -Eqi 'does not exist|not found|ChangeSetNotFound' "$aws_error"; then
    cat "$aws_error" >&2
    exit 1
  fi

  if [[ "$prepared" == false ]]; then
    ./node_modules/.bin/cdk deploy "$stack" --app "$assembly" --exclusively \
      --method prepare-change-set --change-set-name "$change_set_name" --require-approval never \
      --previous-parameters "${parameter_args[@]}"
    deploy_aws cloudformation describe-change-set --stack-name "$stack" --change-set-name "$change_set_name" \
      --output json >"$description"
  fi
  unset APP_PRESENTER_DIGEST parameter_args
  node scripts/check-app-change-set.mjs <"$description"
  change_set_id="$(jq -er .ChangeSetId "$description")"
  jq -e --arg revision "$GITHUB_SHA" \
    '[.Parameters[] | select(.ParameterKey == "SourceRevision") | .ParameterValue] == [$revision]' \
    "$description" >/dev/null
  jq -e --arg adapter "$desired_adapter" '[.Parameters[] | select(.ParameterKey == "AlarmAdapterArn") | .ParameterValue] == [$adapter]' "$description" >/dev/null
  candidate_template="$(jq -er --arg stack "$stack" '.artifacts[$stack].properties.templateFile' "$assembly/manifest.json")"
  checked_hash="$(jq -cS . "$assembly/$candidate_template" | sha256sum | cut -d' ' -f1)"
  prepared_hash="$(deploy_aws cloudformation get-template --stack-name "$stack" --change-set-name "$change_set_id" \
    --template-stage Original --output json | jq -cS '.TemplateBody | if type == "string" then fromjson else . end' | sha256sum | cut -d' ' -f1)"
  [[ "$checked_hash" == "$prepared_hash" ]] || { echo "Change set template differs from the checked assembly" >&2; exit 1; }
  echo "Executing inspected app change set $change_set_id"
  deploy_aws cloudformation execute-change-set --stack-name "$stack" --change-set-name "$change_set_id"

  deploy_until=$((SECONDS + 1800))
  while :; do
    stack_state="$(read_stack)"
    status="$(stack_status <<<"$stack_state")"
    revision="$(stack_output SourceRevision <<<"$stack_state")"
    if [[ ( "$status" == CREATE_COMPLETE || "$status" == UPDATE_COMPLETE ) && "$revision" == "$GITHUB_SHA" ]] &&
       jq -e --arg adapter "$desired_adapter" '[.Stacks[0].Parameters[]? | select(.ParameterKey == "AlarmAdapterArn") | .ParameterValue] == [$adapter]' <<<"$stack_state" >/dev/null; then
      break
    fi
    if [[ "$status" == ROLLBACK_COMPLETE || "$status" == *_FAILED ]] || (( SECONDS >= deploy_until )); then
      echo "App stack did not complete revision $GITHUB_SHA ($status)" >&2
      deploy_aws cloudformation describe-stack-events --stack-name "$stack" --max-items 12 \
        --query 'StackEvents[:12].[LogicalResourceId,ResourceStatus,ResourceStatusReason]' --output text >&2 || true
      exit 1
    fi
    sleep 15
  done
  verify_aliases
fi

if [[ "$deployed_revision" != "$GITHUB_SHA" || "$binding_changed" == true ]]; then
  prepare_inventory_versions
fi

[[ "$(stack_output WebBucketName <<<"$stack_state")" == "$bucket" ]]
shopt -s nullglob
assets=("$web"/assets/*)
(( ${#assets[@]} > 0 )) || { echo "No checked hashed web assets" >&2; exit 1; }
for asset in "${assets[@]}"; do
  case "$asset" in
    *.js|*.mjs) type=application/javascript ;;
    *.css) type=text/css ;;
    *) echo "Unknown checked web asset type ${asset##*/}" >&2; exit 1 ;;
  esac
  key="${asset#"$web/"}"
  deploy_aws s3api put-object --bucket "$bucket" --key "$key" --body "$asset" \
    --content-type "$type" --cache-control 'public,max-age=31536000,immutable' \
    --expected-bucket-owner "$AWS_ACCOUNT_ID" >/dev/null
  echo "Published $key ($(sha256sum "$asset" | cut -d' ' -f1))"
done

deploy_aws s3api put-object --bucket "$bucket" --key index.html --body "$web/index.html" \
  --content-type 'text/html; charset=utf-8' --cache-control 'no-cache,max-age=0,must-revalidate' \
  --metadata "SourceRevision=$GITHUB_SHA" --expected-bucket-owner "$AWS_ACCOUNT_ID" >/dev/null
entry="$(deploy_aws s3api head-object --bucket "$bucket" --key index.html --expected-bucket-owner "$AWS_ACCOUNT_ID")"
jq -e --arg revision "$GITHUB_SHA" \
  '.Metadata.sourcerevision == $revision and .CacheControl == "no-cache,max-age=0,must-revalidate"' <<<"$entry" >/dev/null
{
  echo 'Published the checked app assembly and web entry'
  jq -r '.Stacks[0].Outputs[] | "- \(.OutputKey) — \(.OutputValue)"' <<<"$stack_state"
} >>"$GITHUB_STEP_SUMMARY"
