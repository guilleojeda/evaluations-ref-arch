# Talk preparation

Use this checklist before each rehearsal or delivery. Run [cleanup](cleanup.md)
afterward, including after an interruption. The [demo script](demo-script.md)
contains onstage cues. This runbook covers software, workspaces, identity,
and replacement-browser readiness.

The public page preserves stage, evidence, and recovery mechanics without
publishing credentials, trace exports, account-specific role names, or private
session locators. Keep those values in the maintainer's separate session
record.

## Current normal-route rehearsal

Prepare one clean qualified S5 and verify the source file
the prepared `before/faulty-prompt.py` reference is available. Before the IDE
cue, copy it into the active `S5/agent/prompt.py`; keep the case input, expected output, fixed captured
tools, and exact evaluator ready to show. The rehearsal must record the actual
faulty FAIL, then use this exact rule for the fresh run:

```text
When Inventory reads are still denied, recommend restoring access. Identify the healthy version at the same memory from the configuration evidence. If access has already recovered, recommend no change.
```

Show the pre-qualified endpoint's new denial recommendation as behavior
evidence only. Register the original scored case and matching case/bundle
hashes once. Restore the original prompt before the local FAIL and ordinary push.
The fast `audience-case-gate` is required and runs beside ordinary checks; a
failure/incomplete result blocks/skips `evaluate-agent` and publication. Never
replace a missing result with a recording or claim a skipped qualification ran.

To run just the public example, start in the [README](../README.md#run-one-evaluation-locally). You can do that without presenter access.

The stage-workspace setup opens one or all six editable workspaces. That setup
does not run a model, send application traffic, select a live endpoint, deploy,
or reset data. The hosted pre-talk setup later in this runbook can perform the
explicit controller recovery, Reset, and readiness actions listed in its
section. Follow those actions only when establishing the live baseline.

The [checkpoint map](checkpoints.md) and private session index serve different
purposes. The map identifies six source tags and peeled commits. It does not
qualify S5 or prove that tags are published. The session index identifies the
case, candidate, publication, and result for this performance. Store the index
and private inputs in a directory that contains no credentials. Record their
digests in the private session record.

## 1. Create the session record

Create a private session index for every rehearsal or delivery. Record the
date, starting stage, and whether the full sequence or selected stages will
run. Also record app and controller URLs, AWS account and Region, deployed
source revisions, the app version manifest, controller run ID, alarm identity,
the two prepared publication tuples, six workspace bases, case,
evidence and reference-time identities, evaluator and policy versions,
commands, and unique input and result locations. Store credentials separately
in presenter-only storage.

Prepared asset hashes may be reused. The performance identity may not. Set a
new non-empty `PHASE22_SESSION_ID` for every rehearsal or delivery. The
importer records it as `sessionId` and
preserves the roster's `sourceAssetSessionId` and input hashes. This lets a new
performance reuse unchanged assets without confusing it with an earlier one:

```sh
# Replace this with a new unique ID for every rehearsal or delivery.
export PHASE22_SESSION_ID="${PHASE22_SESSION_ID:?set a unique per-performance ID}"
```

Keep the session index, inputs, source and tooling snapshots, and results in
durable private storage that a replacement browser can access. Git does not
preserve ignored evidence, uncommitted edits, environments, or processes.

## 2. Finish software and release preparation

Use current qualified publication and branch readbacks. Before the next
rehearsal, inspect the exact repaired ZIP, source, prompt, and configuration
identities, Runtime/version/endpoint tuple, qualification receipt, and
protected approval. If `demo-deploy` still contains a prompt regression, run
[cleanup](cleanup.md#3-repair-demo-deploy-after-the-regression) before preparing
another full session.

- [ ] Verify the app, controller, and agent as three independent cloud stacks
  with the expected settings. Finish dependent releases in binding order
  outside active demo runs. Reconcile partial deployments.
- [ ] Verify that `demo-deploy` is the sole publishing branch and retains
  deployed ancestry. Merge maintained `main` only when needed. Never recreate
  or rewind the branch from an old checkpoint.
- [ ] For changed software, complete build, offline, infrastructure, and
  affected runtime checks. Confirm that the quality gate uses the exact agent
  package, all required results, and source-backed human approval of that ZIP,
  the frozen cases, and their actual reports and traces.
- [ ] Verify that `faulty` remains pinned and `repaired` has exact-package
  qualification. Reuse intact publications. Qualify a missing or rebuilt
  publication normally.
- [ ] In the hosted controller, open **Incident** after the baseline is healthy,
  actions are settled, and the alarm is freshly **OK**. Under **Agent**, choose
  **Faulty** or **Repaired**, then click **Apply agent**. Use **Check readiness**,
  **Activate Inventory denial**, **Inventory memory**, **Select memory**,
  **Restore Inventory access**, and **Recover** on **Incident**. Under **Current
  investigation**, find **Recommendation**, **Open native CloudWatch trace**,
  and **View full report**. If the alarm has cleared, expand **Last
  investigation** and check its transition time. In **Traffic**, use **Start
  healthy traffic**, **Start surge**, **Stop traffic**, and **Increase Inventory
  capacity** as needed. Use **History** for **Reset demo** and previous runs.
  Verify the strong readback. Selection sends no traffic or inference and never
  falls back automatically.
- [ ] Verify tracing, complete-session telemetry, sanitized source capture,
  captured providers, evaluation permissions, and reference times. Leave
  missing evidence visible.
- [ ] Pin reviewed cases, deterministic checks, and the single advisory verdict
  with their actual identities. Verify that the retained S2 result opens
  offline from the replacement browser.
- [ ] When rediscovering a qualification from the browser IDE, list the exact
  branch runs with `gh run list --branch demo-deploy --workflow deploy.yml
  --limit 10`, then open the selected run with `gh run view <run-id> --web`.

Repeat affected checks after relevant changes. Do not redeploy unchanged
software only because another performance is scheduled.

## 3. Verify browser access and the development environment

Create or reopen a Codespace from the maintained checkout. A cold or replacement
Codespace must install its own tools and dependencies. Do not copy a local
credential cache, `.venv`, `node_modules`, or binaries from an older Codespace.
The committed `.devcontainer/` installs the pinned AWS CLI, Node.js, and `uv`.
The repository pins Python 3.13, Node.js 24.22.2, and the locked agent
dependencies.

```sh
# Keep Python from writing bytecode caches into frozen source while reopening runs.
export PYTHONDONTWRITEBYTECODE=1
node --version                  # v24.22.2
npm --version
python3 --version               # Python 3.13.x
uv --version                    # 0.13.6
aws --version
gh --version
jq --version
npm ci
uv sync --locked --project agent
```

For a cold browser, use a clean clone and fetch the maintained map. Put the
clone, browser receipt, and private session paths in different directories.
Keep credential storage outside all three:

```sh
replacement_root="${PHASE22_REPLACEMENT_ROOT:?set a new private directory}"
repository_url="${REPOSITORY_URL:?set the repository URL}"
umask 077
mkdir -p "$replacement_root"
git clone "$repository_url" "$replacement_root/repository"
git -C "$replacement_root/repository" fetch origin main
git -C "$replacement_root/repository" switch --detach FETCH_HEAD
cd "$replacement_root/repository"
git -C "$replacement_root/repository" status --short
```

The container has no AWS credentials. Sign in through a named operator profile
and verify the account before opening private evidence. Keep the profile name
and Region in environment variables so the commands work in another Codespace:

```sh
aws configure list-profiles
operator_profile="${PHASE22_AWS_PROFILE:?set the short-lived operator profile}"
export AWS_PROFILE="$operator_profile"
export AWS_REGION="${PHASE22_AWS_REGION:?set the demo region}"
export AWS_DEFAULT_REGION="$AWS_REGION"
# Run once in a new Codespace when the profile is absent. Use the operator's
# private IAM Identity Center values at the prompts; do not save credentials in
# the repository or copy a credential cache from another browser.
aws configure sso --profile "$operator_profile" --no-browser
aws sso login --profile "$operator_profile" --use-device-code --no-browser
aws sts get-caller-identity --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  --query '{Account:Account,Arn:Arn}' --output json
```

If the terminal cannot open a browser, run
`aws sso login --profile "$operator_profile" --use-device-code --no-browser`
and enter the displayed URL and code in the operator's browser. Do not use a
default profile, paste long-lived keys, or save credentials in a worktree.

If this AWS CLI build does not expose `--use-device-code` on `configure sso`,
run `aws configure sso --profile "$operator_profile" --no-browser`, then use
`aws sso login --profile "$operator_profile" --use-device-code --no-browser`.
The profile contains only non-secret SSO configuration. Evaluation commands use
the separately scoped, short-lived evaluation role through the documented role
chain. Do not reuse the app/controller bearer or deployment credentials.

For hosted pages, retrieve app and controller bearers through the existing
private AWS paths in [deployment](deployment.md#rotate-presenter-credentials).
Close credential views before sharing the screen. The agent and evaluation
role is separate from the app and controller operator role.

The publication verifier uses the GitHub CLI for read-only calls to repository
contents, workflow runs, the protected environment, and run approvals. Check
its login and API compatibility before full S5 preparation:

```sh
gh auth status
# If the fresh Codespace has no GitHub login, complete the browser flow once:
# gh auth login --hostname github.com --git-protocol https --web
gh api 'repos/guilleojeda/evaluations-ref-arch/actions/runs?per_page=1' \
  --jq '.workflow_runs[0] | {id,head_sha,status,conclusion}'
```

The verifier looks up the exact protected run from `reviewRunId` in the native
publication readback (`actions/runs/<reviewRunId>` and
`actions/runs/<reviewRunId>/approvals`). It then reads the qualification pointer
at the verified `demo-deploy` tip. Do not substitute an arbitrary successful run
or hand-author an approval. If GitHub is available only in a browser, inspect
the same run, its `repaired-publication` environment approval, the
`demo-deploy` commit, and the pointer in the GitHub UI. Restore `gh` in the
maintained Codespace and rerun the verifier. The UI review does not replace its
machine-readable binding.

### Verify the source and prepared release

Before preparing a full session, fetch the reviewed source and inspect the
checkpoint map from maintained `main`. Check the map and tag identities in
[checkpoints](checkpoints.md). The checkpoint maintainer owns tag creation and
ruleset changes. Do not make those changes while preparing a session.

```sh
git status --short
git fetch origin main demo-deploy
git log --oneline -8
sed -n '1,220p' docs/checkpoints.md
```

From a clean operator checkout on maintained `main`, fetch the release ref
directly into the local `demo-deploy` branch. This creates or fast-forwards the
local branch and leaves it available for the S5 worktree. If another worktree
owns the branch, settle and archive it with the cleanup procedure. Inspect
divergence before continuing.

```sh
git branch --show-current
git fetch origin refs/heads/demo-deploy:refs/heads/demo-deploy
git rev-parse --verify refs/heads/demo-deploy
```

Keep these values distinct when preparing S5. The map's S5 commit is the frozen
source checkpoint. The production verifier's
`demoDeploy.qualifiedCommit` is the current repaired source served by the
publication. Compare both with their recorded evidence. Do not change a tag or
move `demo-deploy` to make them match:

```sh
checkpoint_map="${PHASE22_CHECKPOINTS:?set the maintained checkpoint map}"
s5_tag="$(jq -er '.checkpoints.S5.tag' "$checkpoint_map")"
s5_tag_commit="$(jq -er '.checkpoints.S5.commit' "$checkpoint_map")"
printf 'frozen S5 source: %s -> %s\n' "$s5_tag" "$s5_tag_commit"
git rev-parse --verify "refs/tags/$s5_tag^{commit}" 2>/dev/null || \
  printf '%s\n' 'S5 tag is not published in this checkout; do not create it here.'
```

For a full session, import the prepared assets before running the read-only
verifier for the qualified source, `faulty` and `repaired` publication tuples,
and immutable Runtime and package readbacks. If S5 leaves a prompt regression,
the qualified artifact continues serving while source is regressed. Run
[cleanup](cleanup.md#3-repair-demo-deploy-after-the-regression) before preparing
another full session. A source checkpoint is not a qualified publication.

## 4. Prepare six independent editable workspaces

- [ ] Settle and archive the prior performance before creating fresh editing
  copies. Do not overwrite dirty files or folders used by active processes. Keep
  frozen S0-S5 tags and their expected commit mapping unchanged.
- [ ] Prepare S0-S4 from verified frozen tags. Prepare S5 on long-lived
  `demo-deploy` at the current qualified repaired source, which may differ from
  the frozen S5 tag. Keep that branch checked out in one worktree only. Release
  the old session's branch association after preserving and settling its work.
- [ ] In each workspace, show its stage, base tag/commit, saved differences,
  candidate/input identity, entry command and result location. A missing runner
  or asset leaves that stage unready.

Do not prepare from a private path on the presenter's Mac or hand-write a
session input. Download the maintained, versioned session asset archive into a
new private directory. Verify its recorded S3 `VersionId` and SHA-256. Let the
maintained importer select the stock or audience-carried gate. The archive
contains `session-roster.json` and the selected prepared files. Extract it as
one directory and pass its in-archive roster to the importer. If the roster
points to a private source-tree path, request a refreshed portable archive from
the stage-assets maintainer. Do not rearrange files to satisfy an old roster.

The downloaded prepared-input/session archive is a versioned private object in
the asset bucket under `talk-sessions/`. Its nested `gate/staging.tar.gz` is a
content-addressed evaluation object in the evidence bucket. The importer checks
that pointer and SHA from the roster. Do not assign the content-addressed
object a fabricated S3 version. Keep the downloaded archive, roster, and
generated input outside the checkout.

The replacement-browser receipt is a pinned, versioned S3 object. Keep the
locator JSON private. Fetch its recorded object version and verify the locator
digest before deriving the archive key, version, and digest. Follow the same
procedure in a cold or replacement Codespace. Do not copy an old download or
infer a new key from a prior session:

```sh
asset_root="${PHASE22_ASSET_ROOT:?set a new private directory outside the checkout}"
receipt_locator="${PHASE22_ASSET_RECEIPT_LOCATOR:?path to the private pinned browser receipt locator}"
umask 077
mkdir -p "$asset_root"
chmod 700 "$asset_root"
receipt_bucket="$(jq -er '.bucket' "$receipt_locator")"
receipt_key="$(jq -er '.key' "$receipt_locator")"
receipt_version_id="$(jq -er '.versionId' "$receipt_locator")"
receipt_sha256="$(jq -er '.sha256' "$receipt_locator")"
receipt="$asset_root/inputs.json"
aws s3api get-object --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  --bucket "$receipt_bucket" --key "$receipt_key" \
  --version-id "$receipt_version_id" "$receipt" >/dev/null
printf '%s  %s\n' "$receipt_sha256" "$receipt" | sha256sum -c -
# Stage runbooks consume this verified downloaded receipt, not the locator JSON.
export PHASE22_ASSET_RECEIPT="$receipt"
export PHASE22_ASSET_BUCKET="$(jq -er '.archive.bucket' "$receipt")"
export PHASE22_ASSET_KEY="$(jq -er '.archive.key' "$receipt")"
export PHASE22_ASSET_VERSION_ID="$(jq -er '.archive.versionId' "$receipt")"
export PHASE22_ASSET_SHA256="$(jq -er '.archive.sha256' "$receipt")"
```

Download the archive with the IDs from that receipt. Do not use a mutable latest
object:

```sh
asset_bucket="${PHASE22_ASSET_BUCKET:?set the exact versioned asset bucket from the receipt}"
asset_key="${PHASE22_ASSET_KEY:?set the exact versioned talk-sessions key from the private receipt}"
asset_version_id="${PHASE22_ASSET_VERSION_ID:?set the recorded S3 VersionId}"
asset_sha256="${PHASE22_ASSET_SHA256:?set the recorded archive SHA-256}"
asset_root="${PHASE22_ASSET_ROOT:?set a new private directory outside the checkout}"
archive="$asset_root/session.tar.gz"
asset_extract="$asset_root/prepared-inputs"
umask 077
mkdir -p "$asset_root"
chmod 700 "$asset_root"
aws s3api head-object --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  --bucket "$asset_bucket" --key "$asset_key" \
  --version-id "$asset_version_id" \
  --query '{VersionId:VersionId,Size:ContentLength,Metadata:Metadata}' --output json
aws s3api get-object --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  --bucket "$asset_bucket" --key "$asset_key" \
  --version-id "$asset_version_id" "$archive" > "$asset_root/get-object.json"
printf '%s  %s\n' "$asset_sha256" "$archive" | sha256sum -c -
mkdir -p "$asset_extract"
tar -xzf "$archive" -C "$asset_extract"
roster="$asset_extract/session-roster.json"
jq -e '.schemaVersion == 1 and .assetRoot == "." and ((.stages | keys) == ["S0","S1","S2","S3","S4","S5"])' \
  "$roster" >/dev/null
performance_id="${PHASE22_SESSION_ID:?set the unique per-performance ID above}"
export PHASE22_ASSET_SESSION_ID="$(jq -er '.sessionId | select(type == "string" and length > 0)' "$roster")"
test "$PHASE22_ASSET_SESSION_ID" != "$performance_id" || {
  printf '%s\n' 'asset session ID must differ from the performance session ID' >&2
  exit 2
}
```

The importer is local and deterministic. It authenticates the selected private
bytes and writes the small `talk-session.py` input. It does not copy
credentials, query AWS, run a model, invoke an agent, change a Git ref, or
publish a release. Its supported interface is `build` with `--roster`,
`--output`, `--session-id`, `--suite stock|carried`, and optional `--stage S3`
or `--live-release-binding`. Roster entries may be files or selected run
directories. The importer verifies recorded digests recursively and rejects
symlinks or missing content:

```sh
suite="${PHASE22_SUITE:?set stock or carried to match the verified qualification pointer}"
phase22_s3_session="$asset_root/session-input-s3.json"
python3 scripts/talk-inputs.py build \
  --roster "$roster" \
  --session-id "$performance_id" \
  --suite "$suite" --stage S3 --output "$phase22_s3_session"
```

`stock` selects the preserved three-case gate and its stock pointer.
`carried` selects the four-case gate with the reviewed audience case. For a
full S0-S5 session, set `PHASE22_SUITE` to the mode named by the verified
qualification pointer. The current carried qualification is not interchangeable
with stock. Direct S3 entry may explicitly use stock and requires no S5
binding.

For a full S0-S5 session, verify the production publication binding after
importing assets and before writing the final all-stage input. This read-only
verifier joins the native repaired tuple, current remote and GitHub
`demo-deploy` tip, protected approval, immutable qualification receipt and review
manifest, and `agent/qualification-input.json`. It never selects, publishes,
invokes, or mutates a resource:

```sh
runtime_arn="${CONTROLLER_AGENT_RUNTIME_ARN:?set the verified Runtime ARN}"
live_release_binding="$asset_root/live_release_binding.json"
node --import tsx scripts/verify-talk-publication.ts \
  --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  --runtime-arn "$runtime_arn" --output "$live_release_binding"

phase22_session="$asset_root/session-input.json"
python3 scripts/talk-inputs.py build \
  --roster "$roster" \
  --session-id "$performance_id" \
  --suite "$suite" --live-release-binding "$live_release_binding" \
  --output "$phase22_session"
export PHASE22_SESSION="$phase22_session"
```

The verifier output must have `schemaVersion: 1` and
`kind: "phase22-s5-qualification-binding"`. The importer checks that exact
production schema and rejects a hand-written or older binding.

The final input has `schemaVersion: 1`, per-stage candidate and input
identities, and the verified `demoDeploy` tuple for S5. Keep it private. If the
binding or any immutable readback mismatches, stop. Do not edit the JSON to
make the import pass. For S3-only entry, use the first generated input directly:

```sh
export PHASE22_S3_SESSION="$phase22_s3_session"
```

### Prepare all stages, or enter one stage directly

Before creating any worktree, the operator CLI validates the schema, tag peel,
private stage inputs, and qualified `demo-deploy` branch. It writes one
`session-index.json` under the requested directory. You can retry after fixing
an input. An occupied or dirty path is reported and never replaced.

Set all paths to private files outside the checkout. The checkpoint map must
have `schemaVersion: 1` and a `checkpoints` object with `S0`-`S5` entries that
contain `tag` and a 40-character peeled `commit`. The session input must have
`schemaVersion: 1`, `sessionId`, per-stage `candidateId` and `inputId`, and,
for a full session, `demoDeploy` with `branch: "demo-deploy"`, the qualified
commit, `candidateId: "repaired"`, and `publicationId`.

```sh
checkpoint_map="${PHASE22_CHECKPOINTS:?set the maintained checkpoint map}"
session_input="${PHASE22_SESSION:?set the generated private session input}"
session_root="${PHASE22_SESSION_ROOT:?set a new or settled session directory}"

python3 scripts/talk-session.py prepare \
  --checkpoints "$checkpoint_map" \
  --session "$session_input" \
  --directory "$session_root"
```

The command returns JSON for each workspace with its tag or branch base,
commit, candidate and input identity, and initial clean state. S0-S4 use the
peeled tag commit. S5 alone owns the current qualified `demo-deploy` branch,
which may be newer than the frozen S5 tag. Switching stages moves no ref and
changes no cloud resource.

For direct entry, pass only the selected checkpoint map and that stage's private
session input. S3 does not require S5 qualification or an earlier S0-S2 run.
A stage-only input is sufficient. It does not need the all-stage
`PHASE22_SESSION` created by the S5 binding route:

```sh
checkpoint_map="${PHASE22_CHECKPOINTS:?set the maintained checkpoint map}"
session_root="${PHASE22_SESSION_ROOT:?set a new private session directory}"
python3 scripts/talk-session.py prepare \
  --checkpoints "$checkpoint_map" \
  --session "$PHASE22_S3_SESSION" \
  --directory "$session_root" \
  --stage S3
python3 scripts/talk-session.py status \
  --directory "$session_root" --stage S3
```

To continue an independently prepared S3 performance into S4, build S4's own
stage-only input from the same roster, assets, suite, and performance ID. Use
the same session root to preserve the existing S3 workspace. Inspect S4 before
editing. Pass the current immutable S3 run directory printed by the S3 runner.
Opening S4 does not relaunch S3:

```sh
s3_run_directory="${PHASE22_S3_RUN_DIRECTORY:?set the current fresh S3 run directory printed by the runner}"
export PHASE22_S3_RUN="$s3_run_directory"
test -s "$PHASE22_S3_RUN/execution.json"
phase22_s4_session="$PHASE22_ASSET_ROOT/session-input-s4.json"
python3 scripts/talk-inputs.py build \
  --roster "$roster" \
  --session-id "$performance_id" \
  --suite "$suite" --stage S4 --output "$phase22_s4_session"
export PHASE22_S4_SESSION="$phase22_s4_session"
python3 scripts/talk-session.py prepare \
  --checkpoints "$checkpoint_map" \
  --session "$PHASE22_S4_SESSION" \
  --directory "$session_root" \
  --stage S4
python3 scripts/talk-session.py status \
  --directory "$session_root" --stage S4
```

Status is read-only. Use it before switching or editing and after reconnecting
from another browser. It reports the current commit, dirty state, and saved
differences. It does not relaunch an execution or replace an edit.

### Public live-denial case

The public S1/S2 walkthrough uses the native trace and AgentCore dataset path,
not a hand-written case file. Select the trace, create a fixed dataset with
expected response and expected trajectory disabled, edit
`turns[0].expected_response` and `metadata.expected_recommendation` in the
resulting scenario draft, save it, and choose **Create version**. For an
ongoing denial use `Restore inventory access` with the healthy version,
`inventory`, and `version`; for recovered evidence use `Other` with null target
and unit plus a separate free explanation. Only the published version is
frozen. From a Codespace terminal in `examples/live-denial`, use the
maintained [download and score command](../examples/live-denial/README.md#download-the-published-case-in-codespaces)
to select its single example and score the original report.

The scorer reads the case, fetches the original trace with its session,
log-group, and start-time fields, extracts `incident.report`, and calls
`Builtin.Correctness`. It does not rerun the agent. Keep the returned label,
value, explanation, and scoring-attempt identity together. The private
captured-evidence S1/S2 commands below remain valid for the independently
prepared stage route; they are not the public dataset download.

## 5. Rehearse the experience and fallbacks

Use the prepared workspaces for the rehearsal. Label every recorded fallback
with its input and execution identity:

- [ ] Rehearse the opening denial. Load the signed-in storefront and wait for
  the catalog/product view before triggering a genuine new alarm transition.
  Wait for the completed faulty report, read **target `INVENTORY`** and
  **value `512 MB`**, and only then apply the higher-memory action while
  preserving denial. Wait for **Denied + 512 MB** before making one visible
  checkout. A configuration readback alone does not prove a business outcome.
- [ ] Rehearse selecting repaired with endpoint, version, and artifact
  readback. Then trigger a new incident after native alarm **OK**. Match the
  new event and run. Do not relabel an old report or clear deduplication
  records.
- [ ] Reopen the controller from a replacement authenticated browser. Start on
  **Incident** and read the selected tuple and prior investigation identities.
  Use **View full report** for detailed evidence. Interrupt one later
  state or alarm refresh. Confirm that the UI marks the last successful
  selection stale or unavailable, preserves its earlier observation time, and
  leaves the candidate unchanged until explicit selection succeeds.
- [ ] For the capacity rehearsal, use the **Traffic** tab and its **Inventory
  surge**, **Start surge**, **Stop traffic**, **Start healthy traffic**, and
  **Increase Inventory capacity** controls. Use the approved finite profile.
  Compare actual starts, skips, native arrivals,
  caller outcomes, metric windows, and checkout effects. Preserve app code,
  memory, aliases, access, `productVersion`, and prior data across the pair.
  Use the [capacity cue](demo-script.md#capacity-comparison)
  for acceptance evidence and fallback.
- [ ] Verify recovered and stale-alert examples have a later reference time and
  captured post-recovery evidence. Do not judge a pre-recovery report by later
  outcomes.
- [ ] Rehearse the audience interactions. Review the case, judge the report,
  and enter the bounded prompt regression. Reveal reviewed verdicts and actual
  judge findings after the audience vote without changing the rubric. Brief the
  participant on the exact file and edit, timing, and presenter takeover.
- [ ] Time execution, ingestion, scoring, and CI. Set switch cutoffs that leave
  time for results and closing. Label reports, traces, comparisons, and CI
  rejection evidence **recorded** with their identities. A pending live run
  remains pending.
- [ ] Verify numeric slide claims against retained measurements and dated
  pricing. Distinguish agent inference, judging, retries, telemetry, CI, and
  feedback waits. Review [audience questions](questions.md).
- [ ] Rehearse the 60-minute [cue sheet](demo-script.md#working-run-of-show),
  screen switches and approved closing. After the final rehearsal, execute
  cleanup before establishing the delivery baseline.

### Historical stage-entry map (fallback only)

The current normal rehearsal is the short route in section 3: one clean S5,
one native IDE case, one identical live endpoint, original scored case
registration, restored local FAIL, ordinary push, and the fast gate. The hosted
denial is behavior evidence only, not a CI input. Use the stage map below only for
independent entry, preparation, or an actual outage; label its results
prepared/recorded and do not imply that the current audience edit ran.

Open the requested stage directory and use its private input paths. At launch,
each run must snapshot its candidate, tooling, lockfile, case or bundle,
evaluator, and configuration. Write to a unique private result directory. Keep
the command output and identity in the session record.

For the S3 to S4 continuation, pass the directory printed by the current S3 run
to `--source-run`. Do not substitute a historical run whose saved prompt,
source, or tooling identity does not match. Keep each recorded result under its
original identity.

| Stage | Entry and required evidence |
| --- | --- |
| S0 | Open and edit the faulty source. Use the hosted controller and [S0 operating instructions](demo-script.md) for a genuine alarm. Retain the actual report, trace, and sanitized capture. Source editing does not change the served publication. |
| S1 | Create the fixed dataset from the selected trace, review the prose and typed recommendation in the draft, and publish the version. Captured-evidence stages may additionally use the offline review commands. |
| S2 | Download `examples[0]` from the published version, show the exact structured recommendation check, and score the original report with `Builtin.Correctness`; do not rerun the agent. Captured-evidence stages may score their matching saved run. |
| S3 | Edit only the prompt in the S3 worktree. Run `evaluate_case.py run --candidate repaired` against the same selected case/evidence, inspect with `show`, and score the fresh execution. See [agent README](../agent/README.md#run-score-and-compare-the-repaired-candidate-s3). |
| S4 | Run the native `development_experiment.py run` launcher for the current native denial case plus the four retained reviewed cases, each with its bounded case/evidence bridge. You may pass an explicitly selected immutable `--source-run`. Inspect with `show` and compare the saved experiment offline. A focused run cannot qualify a release. See [agent README](../agent/README.md#run-the-native-strands-development-experiment-s4). |
| S5 (historical fallback) | Presenter preparation may append a denial case to the four retained reviewed cases and upload the five-case archive privately. Use this only for independent preparation or an outage; it is not the current audience push. Record the exact commit/package, case roster, source-run case/bundle identity, and unchanged repaired serving tuple. |

You may switch from S3 to S4 while S3 is running only after confirming that
each run owns immutable launch-time inputs and a unique output directory.
Opening S4 must not read mutable files from S3 or relaunch S3. A deliberately
missing or incompatible case fails visibly. Do not replace it silently.

## 6. Establish the final live baseline

<a id="save-and-recover-a-session"></a>

### Save and recover a session

After stopping and draining work, build a private inventory from the session
index, Git bases and differences, selected untracked files, reviewed
inputs and captures, result records, and CI references. Do not archive a whole
worktree, Git metadata, credentials, virtual environments, `node_modules`, or
build caches. The archive command checks selected content digests, preserves
unfinished records as unfinished, and never relaunches work. The inventory and
archive are both required restore inputs. An archive digest alone is not a
portable session receipt.

The command below always includes the private session index. Add each reviewed
evidence file with a repeated `--include-path`, such as
`evidence/s5/push.json`. Select a reviewed untracked file with
`--selected-untracked`, such as
`S0/talk/presenter/s0-intentional-untracked-note.md`. Omit either option when
the session has no matching file. `PHASE22_REVIEWED_RUN_DIR` is optional for a
session interrupted before a model run. When set, it must name a non-empty
reviewed directory or the command stops. Never pass a whole worktree to either
selection option.

```bash
private_root="${PHASE22_PRIVATE_ROOT:?set a private directory outside the checkout}"
session_id="${PHASE22_SESSION_ID:?set the distinct performance session ID}"
private_inventory="${PHASE22_PRIVATE_INVENTORY:-$private_root/session.inventory.json}"
private_archive="${PHASE22_PRIVATE_ARCHIVE:-$private_root/session.tar.gz}"
# Select only reviewed paths from the session allowlist; never pass a whole tree.
# The session index is always included. When a reviewed run directory exists,
# add each regular file below it; this keeps source/tool snapshots and scores
# together without transcribing a large path list. Do not select caches,
# credentials, or symlinks. Add --selected-untracked separately for a reviewed
# untracked file when one exists; omit it when the session has no such file.
umask 077
mkdir -p "$private_root"
chmod 700 "$private_root"

include_args=(--include-path session-index.json)
if test -n "${PHASE22_REVIEWED_RUN_DIR:-}"; then
  reviewed_run="$PHASE22_REVIEWED_RUN_DIR"
  case "$reviewed_run" in
    /*|../*|*/../*)
      printf '%s\n' 'reviewed run directory must be session-relative; stop.' >&2
      exit 2
      ;;
  esac
  test -d "$session_root/$reviewed_run" &&
    test ! -L "$session_root/$reviewed_run" || {
    printf '%s\n' 'reviewed run directory is unavailable; stop.' >&2
    exit 2
  }
  while IFS= read -r -d '' file; do
    relative="${file#"$session_root"/}"
    include_args+=(--include-path "$relative")
  done < <(
    find "$session_root/$reviewed_run" -type f \
      ! -path '*/.venv/*' ! -path '*/node_modules/*' \
      ! -path '*/__pycache__/*' ! -path '*/.cache/*' \
      ! -path '*/.pytest_cache/*' ! -path '*/.mypy_cache/*' \
      ! -path '*/build/*' ! -path '*/dist/*' -print0
  )
  test "${#include_args[@]}" -gt 2 || {
    printf '%s\n' 'reviewed run directory has no regular files; stop.' >&2
    exit 2
  }
fi
python3 scripts/talk-session.py inventory \
  --directory "$session_root" --session-id "$session_id" \
  --output "$private_inventory" "${include_args[@]}"
python3 scripts/talk-session.py save \
  --directory "$session_root" \
  --archive "$private_archive" \
  --inventory "$private_inventory"
archive_sha256="$(sha256sum "$private_archive" | awk '{print $1}')"
inventory_sha256="$(sha256sum "$private_inventory" | awk '{print $1}')"
# save writes the required archive sidecar; inventory is checked directly
# against its retained SHA-256 in the upload receipt.
(cd "$(dirname "$private_archive")" && \
  sha256sum -c "$(basename "$private_archive").sha256")
```

Restore only into verified clean stage bases that were prepared first. Preserve
unrelated or conflicting destination edits and stop on a digest mismatch.
After restore, check each stage's Git diff and commit, and each restored run
record. When the inventory records stage-local commits, `restore` imports their
Git bundles and checks the exact saved HEAD before applying the selected file
overlay. Do not cherry-pick the commit again. Reopening a session shows saved
status. It does not start an evaluation, checkout, alarm, deployment, or reset.

For durable storage, use the existing versioned private asset bucket from the
operator's receipt under a unique `talk-sessions/<session-id>/` prefix. Upload
the two restore inputs after local save has passed. Retain each object version
and trusted hash. Do not use an unpinned latest object:

```sh
archive_sha256="$(sha256sum "$private_archive" | awk '{print $1}')"
inventory_sha256="$(sha256sum "$private_inventory" | awk '{print $1}')"
asset_bucket="${PHASE22_ASSET_BUCKET:?set the versioned asset bucket}"
archive_key="talk-sessions/${session_id}/$(basename "$private_archive")"
inventory_key="talk-sessions/${session_id}/$(basename "$private_inventory")"
aws s3api put-object --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  --bucket "$asset_bucket" \
  --key "$archive_key" --body "$private_archive" \
  --metadata "sha256=$archive_sha256,session-id=$session_id"
aws s3api put-object --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  --bucket "$asset_bucket" \
  --key "$inventory_key" --body "$private_inventory" \
  --metadata "sha256=$inventory_sha256,session-id=$session_id"
archive_head="$private_root/archive-head.json"
inventory_head="$private_root/inventory-head.json"
aws s3api head-object --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  --bucket "$asset_bucket" --key "$archive_key" \
  --query '{VersionId:VersionId,Size:ContentLength,Metadata:Metadata,LastModified:LastModified}' \
  --output json > "$archive_head"
aws s3api head-object --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  --bucket "$asset_bucket" --key "$inventory_key" \
  --query '{VersionId:VersionId,Size:ContentLength,Metadata:Metadata,LastModified:LastModified}' \
  --output json > "$inventory_head"
archive_version_id="$(jq -er '.VersionId' "$archive_head")"
inventory_version_id="$(jq -er '.VersionId' "$inventory_head")"
private_receipt="${PHASE22_SESSION_S3_RECEIPT:-$private_root/session.s3-receipt.json}"
jq -n \
  --arg session_id "$session_id" --arg bucket "$asset_bucket" \
  --arg archive_key "$archive_key" --arg archive_version "$archive_version_id" \
  --arg archive_sha256 "$archive_sha256" \
  --arg inventory_key "$inventory_key" --arg inventory_version "$inventory_version_id" \
  --arg inventory_sha256 "$inventory_sha256" \
  '{schemaVersion: 1, sessionId: $session_id, bucket: $bucket,
    archive: {key: $archive_key, versionId: $archive_version, sha256: $archive_sha256},
    inventory: {key: $inventory_key, versionId: $inventory_version, sha256: $inventory_sha256}}' \
  > "$private_receipt"
chmod 600 "$private_receipt"
```

Record both returned VersionId values, both SHA-256 values, object keys, UTC
time, and the `aws sts get-caller-identity` result in the private receipt. In a
replacement Codespace, read that receipt, download both exact object versions,
and verify each trusted hash before writing and checking the archive sidecar or
restoring:

```sh
replacement_root="${PHASE22_SESSION_REPLACEMENT_ROOT:?set a new private directory}"
replacement_assets="$replacement_root/assets"
receipt="${PHASE22_SESSION_S3_RECEIPT:?path to the retained private S3 receipt}"
asset_bucket="$(jq -er '.bucket' "$receipt")"
archive_key="$(jq -er '.archive.key' "$receipt")"
archive_version_id="$(jq -er '.archive.versionId' "$receipt")"
archive_sha256="$(jq -er '.archive.sha256' "$receipt")"
inventory_key="$(jq -er '.inventory.key' "$receipt")"
inventory_version_id="$(jq -er '.inventory.versionId' "$receipt")"
inventory_sha256="$(jq -er '.inventory.sha256' "$receipt")"
mkdir -p "$replacement_assets"
replacement_archive="$replacement_assets/$(basename "$archive_key")"
replacement_inventory="$replacement_assets/$(basename "$inventory_key")"
aws s3api get-object --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  --bucket "$asset_bucket" --key "$archive_key" \
  --version-id "$archive_version_id" "$replacement_archive" >/dev/null
aws s3api get-object --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  --bucket "$asset_bucket" --key "$inventory_key" \
  --version-id "$inventory_version_id" "$replacement_inventory" >/dev/null
test "$(sha256sum "$replacement_archive" | awk '{print $1}')" = "$archive_sha256"
test "$(sha256sum "$replacement_inventory" | awk '{print $1}')" = "$inventory_sha256"
printf '%s  %s\n' "$archive_sha256" "$(basename "$replacement_archive")" \
  > "$replacement_archive.sha256"
(cd "$replacement_assets" && sha256sum -c "$(basename "$replacement_archive").sha256")
```

After the exact-version readbacks and archive-sidecar check pass, use a fresh
reviewed clone to prepare every detached A base, including S5, from the
inventory. Then restore the selected files. A must never attach or move the
current `demo-deploy` branch:

```sh
A_CLONE="${PHASE22_SESSION_REPLACEMENT_REPOSITORY:?path to the reviewed clean replacement clone}"
A_ROOT="${PHASE22_SESSION_REPLACEMENT_STAGES:?new directory for detached A stage worktrees}"
test -d "$A_CLONE" || { printf '%s\n' 'replacement clone is unavailable; stop.' >&2; exit 2; }
git -C "$A_CLONE" fetch --tags origin
test -z "$(git -C "$A_CLONE" status --porcelain)" || {
  printf '%s\n' 'replacement clone is dirty; stop before preparing A.' >&2
  exit 2
}
mkdir -p "$A_ROOT"
for stage in S0 S1 S2 S3 S4 S5; do
  stage_base="$(jq -er --arg stage "$stage" \
    '.sourceBase.commits[$stage]' "$replacement_inventory")"
  git -C "$A_CLONE" worktree add --detach "$A_ROOT/$stage" "$stage_base"
done
test -z "$(git -C "$A_ROOT/S5" branch --show-current)"
(
  cd "$A_CLONE"
  python3 scripts/talk-session.py restore \
    --directory "$A_ROOT" \
    --archive "$replacement_archive" \
    --inventory "$replacement_inventory"
)
```

Historical A is for evidence recovery only. Do not present it as the currently
qualified release or use it to overwrite a newer `demo-deploy`. Keep all six A
worktrees detached. After A's restore and inspection are complete, session B
may check out and own the current qualified `demo-deploy` branch. Verify its
new tip.

Use the browser console or CLI only with the scoped operator profile. Keep the
private archive, version receipts, and credentials out of the public repo.

### Final live readiness

Before a full performance, stop and drain producers. Reconcile unresolved
checkout identities on the **Storefront** and close old checkout pages. Verify
the current app and controller release. Confirm that the fresh native alarm is
**OK**, the intended candidate tuple is read back, and no action can submit
traffic. Use the controller's **History** tab. For a whole-talk restart, use
**Reset demo** once with a fresh `productVersion` after prior work is settled.
Captured-only direct entry does not need a business reset. Keep traffic stopped
until the scripted start.

Record account and Region, app and controller URLs, current source and
manifest, controller run, endpoint and artifact tuples, six workspace bases,
private input and result identities, and any incomplete or recorded fallback.
Do not call a recorded result a fresh execution or a source edit a qualified
publication.

Before declaring the baseline ready:

- [ ] Stop producers and other browser writers. Drain accepted work, reconcile
  checkout IDs and receipts, close old checkout pages, and keep traffic stopped.
- [ ] For a whole-talk restart, use the controller's normal Reset once with a
  fresh `productVersion` after prior work is settled. Captured-only direct entry
  does not need a business reset. Do not manipulate controller records.
- [ ] Verify the current app and controller release, trusted settings, healthy
  alias and version, Inventory cap **16**, unreserved Checkout, native alarm
  **OK**, exact adapter binding, and ready endpoint. A stale or missing read is
  not fresh incident readiness.
- [ ] Select retained **faulty** for the opening only after its prepared tuple
  and the native alarm are read back. Keep repaired deployed and qualified for
  later selection.
- [ ] Record stock, verification order, selection, alarm observation time,
  session and run ID, and actual request counts and outcomes. Captured-only entry
  needs its assets and services, not a business Reset.

## 7. Before the room opens

- [ ] Open the final deck, notes and timer, app, controller, live report,
  Codespace, native reports, AgentCore Observability, and GitHub Actions.
  Preselect relevant resources and stages without executing them.
- [ ] Set browser, terminal, and editor zoom. Arrange readable views. Confirm
  display, presenter notes, network, and power. Close credential pages and
  unrelated notifications.
- [ ] Set out the magic box and two visibly different paper planes. Confirm the
  participant and fallback/takeover cues.
- [ ] Recheck authentication, branch and workspace identity, stopped traffic,
  settled actions, baseline, timing plan, faulty selection, native alarm **OK**,
  and recorded fallbacks. Avoid new deployments and unverified input changes.
- [ ] Mark a stage ready only after verifying its actual commands and inputs. If
  a live path is unavailable, explicitly choose the rehearsed recorded or skip
  route. Prepared evidence cannot establish fresh execution of an edited
  candidate.
