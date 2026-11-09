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

finalize_outputs() {
  local runtime_id template_file
  [[ "$(stack_output SourceRevision <<<"$stack_state")" == "$GITHUB_SHA" &&
     "$(stack_output RunTableName <<<"$stack_state")" == IncidentTriageDemoAgentRun ]]
  runtime_id="$(stack_output RuntimeId <<<"$stack_state")"
  template_file="$(jq -er --arg stack "$stack" '.artifacts[$stack].properties.templateFile' "$assembly/manifest.json")"
  AWS_ACCESS_KEY_ID="$access_key" AWS_SECRET_ACCESS_KEY="$secret_key" AWS_SESSION_TOKEN="$session_token" \
    uv run --project agent --locked python scripts/finalize-agent.py \
      --runtime-id "$runtime_id" --revision "$GITHUB_SHA" --asset-bucket "$PHASE0_ASSET_BUCKET" \
      --asset-key "$(stack_output RuntimeAssetObjectKey <<<"$stack_state")" --api-id "$app_api_id" \
      --template "$assembly/$template_file" >"$RUNNER_TEMP/agent-final-release.json"
  cat "$RUNNER_TEMP/agent-final-release.json"
}
app_state="$(deploy_aws cloudformation describe-stacks --stack-name "$PHASE0_APP_STACK" --output json)"
app_api_id="$(jq -er '.Stacks[0].Outputs[] | select(.OutputKey == "ApiUrl") | .OutputValue | capture("https://(?<id>[a-z0-9]+)\\.execute-api\\.").id' <<<"$app_state")"

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

deployed_revision="$(stack_output SourceRevision <<<"$stack_state")"
if [[ "$deployed_revision" == "$GITHUB_SHA" ]]; then
  finalize_outputs
  exit 0
fi

parameter_args=(--parameters "$stack:SourceRevision=$GITHUB_SHA" --parameters "$stack:AppHttpApiId=$app_api_id")
if [[ "$status" != ABSENT && "$status" != REVIEW_IN_PROGRESS ]]; then
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
finalize_outputs
jq -r '.Stacks[0].Outputs[] | "- \(.OutputKey) — \(.OutputValue)"' <<<"$stack_state" >>"$GITHUB_STEP_SUMMARY"
