#!/usr/bin/env bash
set -euo pipefail

stack="$PHASE0_CONTROLLER_STACK"
assembly=.artifacts/controller/cdk
change_set_name="phase2-controller-${GITHUB_SHA}"
description="$RUNNER_TEMP/controller-change-set.json"
aws_error="$RUNNER_TEMP/controller-deploy.error"
test -s "$assembly/manifest.json"

credentials="$(aws sts assume-role --role-arn "$CDK_DEPLOY_ROLE_ARN" \
  --role-session-name "phase2-controller-${GITHUB_RUN_ID}" --duration-seconds 3300 --query Credentials --output json)"
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

verify_outputs() {
  local revision api_id site_url
  revision="$(stack_output SourceRevision <<<"$stack_state")"
  api_id="$(stack_output ApiId <<<"$stack_state")"
  site_url="$(stack_output SiteUrl <<<"$stack_state")"
  [[ "$revision" == "$GITHUB_SHA" && "$api_id" =~ ^[a-z0-9]+$ &&
     "$site_url" == "https://$api_id.execute-api.$AWS_REGION.amazonaws.com" ]]
  [[ "$(stack_output HttpFunctionName <<<"$stack_state")" == IncidentTriageDemoControllerHttp &&
     "$(stack_output WorkerFunctionName <<<"$stack_state")" == IncidentTriageDemoControllerWorker &&
     "$(stack_output RunTableName <<<"$stack_state")" == IncidentTriageDemoControllerRun ]]
  echo "Verified controller revision $revision, API $api_id, site $site_url"
}

reconcile_until=$((SECONDS + 720))
while :; do
  stack_state="$(read_stack)"
  status="$(stack_status <<<"$stack_state")"
  case "$status" in
    ABSENT|REVIEW_IN_PROGRESS|CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE) break ;;
    *_IN_PROGRESS|*_CLEANUP_IN_PROGRESS)
      (( SECONDS < reconcile_until )) || { echo "Controller stack is still $status" >&2; exit 1; }
      sleep 15 ;;
    *) echo "Reconcile terminal controller status $status before release" >&2; exit 1 ;;
  esac
done

deployed_revision="$(stack_output SourceRevision <<<"$stack_state")"
if [[ "$deployed_revision" == "$GITHUB_SHA" ]]; then
  verify_outputs
  exit 0
fi

parameter_args=(--parameters "$stack:SourceRevision=$GITHUB_SHA")
if [[ "$status" == ABSENT || "$status" == REVIEW_IN_PROGRESS ]]; then
  base="$PUSH_BASE"
  if [[ "$base" == 0000000000000000000000000000000000000000 ]]; then
    base="$(git rev-list --max-parents=0 "$GITHUB_SHA" | tail -n 1)"
  fi
  secret_prefix="arn:aws:secretsmanager:$AWS_REGION:$AWS_ACCOUNT_ID:secret:incident-triage-demo/controller"
  if [[ ! "${CONTROLLER_OPERATOR_SECRET_ARN:-}" =~ ^$secret_prefix/operator-digest-[A-Za-z0-9]{6}$ ||
        ! "${CONTROLLER_APP_SECRET_ARN:-}" =~ ^$secret_prefix/app-bearer-[A-Za-z0-9]{6}$ ]]; then
    echo "The first controller release requires both exact controller secret ARNs" >&2
    exit 1
  fi
  expected_operator_arn="$CONTROLLER_OPERATOR_SECRET_ARN"
  expected_app_arn="$CONTROLLER_APP_SECRET_ARN"
  first_create=true
  parameter_args+=(--parameters "$stack:ControllerOperatorSecretArn=$expected_operator_arn"
    --parameters "$stack:ControllerAppSecretArn=$expected_app_arn")
else
  if [[ ! "$deployed_revision" =~ ^[0-9a-f]{40}$ ]] || ! git cat-file -e "$deployed_revision^{commit}"; then
    echo "Controller stack has no valid, known SourceRevision" >&2
    exit 1
  fi
  if git merge-base --is-ancestor "$GITHUB_SHA" "$deployed_revision"; then
    echo "Controller release $GITHUB_SHA was superseded by $deployed_revision"
    exit 0
  fi
  git merge-base --is-ancestor "$deployed_revision" "$GITHUB_SHA" || {
    echo "Candidate and deployed controller revisions diverged" >&2
    exit 1
  }
  base="$deployed_revision"
  first_create=false
  expected_operator_arn="$(jq -er '.Stacks[0].Parameters[] | select(.ParameterKey == "ControllerOperatorSecretArn") | .ParameterValue' <<<"$stack_state")"
  expected_app_arn="$(jq -er '.Stacks[0].Parameters[] | select(.ParameterKey == "ControllerAppSecretArn") | .ParameterValue' <<<"$stack_state")"
fi
components="$(node scripts/affected-stacks.mjs "$base" "$GITHUB_SHA")"
if ! jq -e 'index("controller") != null' <<<"$components" >/dev/null; then
  echo "No controller change from $base to $GITHUB_SHA"
  exit 0
fi

verify_bindings() {
  jq -e --arg op "$expected_operator_arn" --arg app "$expected_app_arn" --argjson first "$first_create" '
    def valid($key; $value):
      [.Parameters[] | select(.ParameterKey == $key)] as $matches |
      ($matches | length) == 1 and
      ($matches[0].ParameterValue == $value or ($first == false and $matches[0].UsePreviousValue == true));
    valid("ControllerOperatorSecretArn"; $op) and valid("ControllerAppSecretArn"; $app)
  ' "$description" >/dev/null
}

prepared=false
if deploy_aws cloudformation describe-change-set --stack-name "$stack" --change-set-name "$change_set_name" \
    --output json >"$description" 2>"$aws_error"; then
  case "$(jq -r '.Status + ":" + .ExecutionStatus' "$description")" in
    CREATE_COMPLETE:AVAILABLE)
      node scripts/check-controller-change-set.mjs <"$description"
      if verify_bindings; then
        prepared=true
      else
        echo "Recreating the controller change set with the expected credential references"
        deploy_aws cloudformation delete-change-set --stack-name "$stack" --change-set-name "$change_set_name"
      fi ;;
    FAILED:*|*:OBSOLETE) deploy_aws cloudformation delete-change-set --stack-name "$stack" --change-set-name "$change_set_name" ;;
    *) echo "Previous controller change set is still in progress or unavailable" >&2; exit 1 ;;
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
node scripts/check-controller-change-set.mjs <"$description"
verify_bindings || { echo "Controller change set has unexpected credential references" >&2; exit 1; }
change_set_id="$(jq -er .ChangeSetId "$description")"
jq -e --arg revision "$GITHUB_SHA" \
  '[.Parameters[] | select(.ParameterKey == "SourceRevision") | .ParameterValue] == [$revision]' \
  "$description" >/dev/null
candidate_template="$(jq -er --arg stack "$stack" '.artifacts[$stack].properties.templateFile' "$assembly/manifest.json")"
checked_hash="$(jq -cS . "$assembly/$candidate_template" | sha256sum | cut -d' ' -f1)"
prepared_hash="$(deploy_aws cloudformation get-template --stack-name "$stack" --change-set-name "$change_set_id" \
  --template-stage Original --output json | jq -cS '.TemplateBody | if type == "string" then fromjson else . end' | sha256sum | cut -d' ' -f1)"
[[ "$checked_hash" == "$prepared_hash" ]] || { echo "Controller change set differs from checked assembly" >&2; exit 1; }
echo "Executing inspected controller change set $change_set_id"
deploy_aws cloudformation execute-change-set --stack-name "$stack" --change-set-name "$change_set_id"

deploy_until=$((SECONDS + 1800))
while :; do
  stack_state="$(read_stack)"
  status="$(stack_status <<<"$stack_state")"
  revision="$(stack_output SourceRevision <<<"$stack_state")"
  if [[ ( "$status" == CREATE_COMPLETE || "$status" == UPDATE_COMPLETE ) && "$revision" == "$GITHUB_SHA" ]]; then break; fi
  if [[ "$status" == *ROLLBACK_COMPLETE || "$status" == *_FAILED ]] || (( SECONDS >= deploy_until )); then
    echo "Controller stack did not complete revision $GITHUB_SHA ($status)" >&2
    deploy_aws cloudformation describe-stack-events --stack-name "$stack" --max-items 12 \
      --query 'StackEvents[:12].[LogicalResourceId,ResourceStatus,ResourceStatusReason]' --output text >&2 || true
    exit 1
  fi
  sleep 15
done
verify_outputs
jq -r '.Stacks[0].Outputs[] | "- \(.OutputKey) — \(.OutputValue)"' <<<"$stack_state" >>"$GITHUB_STEP_SUMMARY"
