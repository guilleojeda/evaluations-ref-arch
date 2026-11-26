# Talk preparation

Use this checklist before a rehearsal or delivery, and use [cleanup](cleanup.md)
afterward, including after an interrupted session. The [demo script](demo-script.md)
owns onstage cues; this document owns the software, workspace, identity, and
replacement-browser preflight.

This is a presenter-only runbook; the public build and local evaluation use the
repository's local path instead.

Phase 22 opens any one of six editable stage workspaces. It does not run a
model, send application traffic, select a live endpoint, deploy, or reset data
as a side effect of preparation. The one-case IDE smoke is not a substitute for
the S3/S4 runners or the S5 gate and is not installed by the maintained
devcontainer.

The [checkpoint map](checkpoints.md) is maintained separately from a private
session index. The map identifies six source tags and peeled commits; it does
not qualify S5 or prove that tags have been published. The session index
identifies the selected case, candidate, publication and result for this
performance. Keep the session index and all private inputs outside credential
material and retain their digests in the private session record.

## 1. Create the session record

Give every rehearsal or delivery its own performance identity and private
session index. Record the date, intended starting stage, and whether the full
live sequence or selected stages will run. Record app/controller URLs, AWS
account and Region, deployed source revisions, app version manifest, controller
run ID, alarm identity, the two prepared publication tuples, six workspace
bases, case/evidence/reference-time identities, evaluator and policy versions,
commands, and unique input/result locations. Keep credentials in separate
presenter-only storage.

The prepared asset hashes are deliberately reusable, but the performance
identity is not. Set a new non-empty `PHASE22_SESSION_ID` for every rehearsal
or delivery (for example, `talk-2026-11-18-rehearsal-b`). The importer records
that value as `sessionId` and preserves the roster's `sourceAssetSessionId` and
all input hashes, so session B can reuse unchanged prepared assets without
being confused with session A:

```sh
# Replace this with a new unique ID for every rehearsal or delivery.
export PHASE22_SESSION_ID="talk-2026-11-18-rehearsal-b"
```

Keep the session index, inputs, saved source/tooling snapshots and results in
durable private storage accessible from a replacement browser. Git alone does
not preserve ignored evidence, uncommitted edits, environments or processes.

## 2. Finish software and release preparation

Use the current qualified publication and branch readbacks, not a historical
version example. Before the next rehearsal, inspect the exact repaired ZIP,
source/prompt/configuration identities, Runtime/version/endpoint tuple,
qualification receipt and protected approval. If `demo-deploy` still contains
a prompt regression, use the [cleanup procedure](cleanup.md#3-repair-demo-deploy-after-the-regression)
before preparing another full session.

- [ ] Verify the app, controller and agent as three independent cloud stacks
  with expected settings; finish dependent releases in binding order outside
  active demo runs and reconcile partial deployments.
- [ ] Verify `demo-deploy` is the sole publishing branch and preserves deployed
  ancestry. Merge maintained `main` only when needed; never recreate or rewind
  the branch from an old checkpoint.
- [ ] For changed software, complete build, offline, infrastructure and affected
  runtime checks. Confirm the quality gate uses the exact agent package,
  complete required results and source-backed human approval of that ZIP, the
  frozen cases, and their actual reports and traces.
- [ ] Verify `faulty` remains pinned and `repaired` has an exact-package
  qualification. Reuse intact publications; qualify a missing or rebuilt
  publication normally.
- [ ] In the hosted controller's **Incident** tab, after the baseline is healthy,
  actions are settled and the alarm is freshly **OK**, choose **Faulty**
  or **Repaired** under **Agent** and click **Apply agent**. Use **Check readiness**, **Activate Inventory
  denial**, **Inventory memory**, **Select memory**, **Restore Inventory access**
  and **Recover** on Incident. Find **Recommendation**, **Open native
  CloudWatch trace** and **View full report** under **Current investigation**.
  If the alarm has cleared, expand **Last investigation** and check its transition time. Use **Traffic** for
  healthy traffic, surge and capacity, and **History** for **Reset demo** and
  previous runs. Verify the strong readback; selection sends no traffic or
  inference and never falls back automatically.
- [ ] Verify tracing, complete-session telemetry, sanitized source capture,
  captured providers, evaluation permissions and reference times. Missing
  evidence remains visible.
- [ ] Pin reviewed cases, deterministic checks and the single advisory verdict
  with their actual identities, and verify the retained S2 result opens
  offline from the replacement browser.
- [ ] When rediscovering a qualification from the browser IDE, list the exact
  branch runs with `gh run list --branch demo-deploy --workflow deploy.yml
  --limit 10`, then open the selected run with `gh run view <run-id> --web`.

Repeat affected checks after relevant changes. Do not redeploy unchanged
software merely because another performance is scheduled.

## 3. Verify browser access and the development environment

Create or reopen a Codespace from the maintained checkout. A cold or replacement
Codespace must install its own tools and dependencies; do not copy a local
credential cache, `.venv`, `node_modules`, or binaries from an older Codespace.
The committed `.devcontainer/` installs the pinned AWS CLI, Node.js and `uv`,
while the repository pins Python 3.13, Node.js 24.22.2 and the locked agent
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

For a cold browser, use a clean clone and fetch the maintained map. The clone
and all private session paths are separate from the browser receipt and from
credential storage:

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

The container has no AWS credentials. Sign in only through a named operator
profile and verify the account before opening private evidence. Keep the
profile name and region in environment variables so the same commands work in
another Codespace:

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

If the terminal cannot open a browser, use
`aws sso login --profile "$operator_profile" --use-device-code --no-browser`
and enter the displayed URL and code in the operator's browser. Do not use a
default profile, paste long-lived keys, or save credentials in a worktree.

If this AWS CLI build does not expose `--use-device-code` on `configure sso`,
run `aws configure sso --profile "$operator_profile" --no-browser` and use
`aws sso login --profile "$operator_profile" --use-device-code --no-browser`.
The profile contains only non-secret SSO configuration. Evaluation commands use
the separately scoped, short-lived evaluation role through the documented role
chain; do not reuse the app/controller bearer or deployment credentials.

For hosted pages, retrieve the app and controller bearers through the existing
private AWS paths in [deployment](deployment.md#rotate-presenter-credentials),
then close credential views before sharing the screen. The agent/evaluation
role is separate from the app/controller operator role.

The publication verifier uses the GitHub CLI for read-only calls to the
repository contents, workflow run, protected environment and run approvals.
Check its login and API compatibility before a full S5 preparation:

```sh
gh auth status
# If the fresh Codespace has no GitHub login, complete the browser flow once:
# gh auth login --hostname github.com --git-protocol https --web
gh api 'repos/guilleojeda/evaluations-ref-arch/actions/runs?per_page=1' \
  --jq '.workflow_runs[0] | {id,head_sha,status,conclusion}'
```

The verifier then looks up the exact protected run by the `reviewRunId` in the
native publication readback (`actions/runs/<reviewRunId>` and
`actions/runs/<reviewRunId>/approvals`) and reads the qualification pointer at
the verified `demo-deploy` tip. Do not substitute an arbitrary successful run
or hand-author an approval. If a browser is the only available GitHub access,
inspect the same run, its `repaired-publication` environment approval, the
`demo-deploy` commit and pointer in the GitHub UI, then restore `gh` in the
maintained Codespace and rerun the verifier; the UI review is not a replacement
for its machine-readable binding.

### Verify the source and prepared release

Before preparing a full session, fetch the reviewed source and inspect the
checkpoint map from maintained `main`. Check the map and tag identities in
[checkpoints](checkpoints.md); tag creation and ruleset changes belong to the
checkpoint maintainer, not to a presenter preparing a session.

```sh
git status --short
git fetch origin main demo-deploy
git log --oneline -8
sed -n '1,220p' docs/checkpoints.md
```

From the clean operator checkout on maintained `main`, fetch the release ref
directly into the local `demo-deploy` branch. This creates or fast-forwards
the local branch while leaving it available for the S5 worktree. If a previous
worktree owns the branch, settle and archive it using the cleanup procedure.
Inspect divergence before continuing.

```sh
git branch --show-current
git fetch origin refs/heads/demo-deploy:refs/heads/demo-deploy
git rev-parse --verify refs/heads/demo-deploy
```

Keep the identities separate when preparing S5. The map's S5 commit is the
frozen source checkpoint; the production verifier's `demoDeploy.qualifiedCommit`
is the current repaired source that the publication actually serves. Compare
both to their recorded evidence, but do not change a tag or move `demo-deploy`
to make them match:

```sh
checkpoint_map="${PHASE22_CHECKPOINTS:?set the maintained checkpoint map}"
s5_tag="$(jq -er '.checkpoints.S5.tag' "$checkpoint_map")"
s5_tag_commit="$(jq -er '.checkpoints.S5.commit' "$checkpoint_map")"
printf 'frozen S5 source: %s -> %s\n' "$s5_tag" "$s5_tag_commit"
git rev-parse --verify "refs/tags/$s5_tag^{commit}" 2>/dev/null || \
  printf '%s\n' 'S5 tag is not published in this checkout; do not create it here.'
```

For a full session, defer the qualified source, `faulty`/`repaired` publication
tuples and immutable Runtime/package readbacks to the read-only verifier in the
next step, after the prepared assets have been imported. A failed S5 regression
leaves source regressed while the qualified artifact continues serving; follow
[cleanup](cleanup.md#3-repair-demo-deploy-after-the-regression) before preparing another full
session. Do not claim that a source checkpoint is a qualified publication.

## 4. Prepare six independent editable workspaces

- [ ] Settle and archive the prior performance before creating fresh editing
  copies. Do not overwrite dirty files or folders used by active processes. Keep
  frozen S0-S5 tags and their expected commit mapping unchanged.
- [ ] Prepare S0-S4 from verified frozen tags. Prepare S5 on long-lived
  `demo-deploy` at the current qualified repaired source, which may differ from
  the frozen S5 tag. Only one worktree may check out that branch; release the
  old session's branch association after preserving and settling its work.
- [ ] In each workspace, show its stage, base tag/commit, saved differences,
  candidate/input identity, entry command and result location. A missing runner
  or asset leaves that stage unready.

Do not prepare from a private path that happens to exist on the presenter's Mac,
and do not hand-write a session input. Download the maintained, versioned
session asset archive into a new private directory, verify both its recorded
S3 `VersionId` and SHA-256, and let the maintained importer select the stock or
audience-carried gate. The archive contains the generated `session-roster.json`
and the selected prepared files. The maintained archive is self-contained:
extract it as one directory and pass its in-archive roster directly to the
importer. Do not use an older archive whose roster points to a private
source-tree path or rearrange files to satisfy it; request the refreshed
portable archive from the stage-assets maintainer.

The downloaded prepared-input/session archive is a versioned private object in
the asset bucket under `talk-sessions/`. Its nested `gate/staging.tar.gz` is a
content-addressed evaluation object in the evidence bucket. That pointer and
SHA are checked from the roster; the content-addressed object does not acquire
a fabricated S3 version. Keep the downloaded archive, roster and generated
input outside the checkout.

The replacement-browser receipt is itself a pinned, versioned S3 object. Keep
the locator JSON private, fetch exactly its recorded object version, and verify
the locator digest before deriving the archive key/version/digest. This is the
same procedure on a cold or replacement Codespace; do not copy an old download
or infer a new key from a prior session:

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

The archive download uses the IDs from that receipt, not a mutable latest
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

The importer is intentionally local and deterministic: it authenticates the
selected private bytes and writes the small `talk-session.py` input; it does
not copy credentials, query AWS, run a model, invoke an agent, change a Git
ref, or publish a release. Its supported interface is `build` (the default
command), with `--roster`, `--output`, `--session-id`, `--suite stock|carried`,
and optional `--stage S3` or `--live-release-binding`. Roster entries may be files or
selected run directories; the importer verifies their recorded digest
recursively and rejects symlinks or missing content:

```sh
suite="${PHASE22_SUITE:?set stock or carried to match the verified qualification pointer}"
phase22_s3_session="$asset_root/session-input-s3.json"
python3 scripts/talk-inputs.py build \
  --roster "$roster" \
  --session-id "$performance_id" \
  --suite "$suite" --stage S3 --output "$phase22_s3_session"
```

`stock` selects the preserved three-case gate and its stock pointer;
`carried` selects the four-case gate with the reviewed audience case. For a
full S0-S5 session, set `PHASE22_SUITE` to the mode named by the verified
qualification pointer; the current carried qualification is not interchangeable
with stock. Direct S3 entry may explicitly use stock and requires no S5
binding.

For a full S0-S5 session, verify the production publication binding after the
asset import and before writing the final all-stage input. This read-only
verifier joins the native repaired tuple, current remote/GitHub
`demo-deploy` tip, protected approval, immutable Phase 20 receipt/review
manifest and `agent/qualification-input.json`; it never selects, publishes,
invokes or mutates a resource:

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
`kind: "phase22-s5-qualification-binding"`; the importer checks that exact
production schema and rejects a hand-written or older binding.

The final input has `schemaVersion: 1`, per-stage candidate/input identities
and, for S5, the verified `demoDeploy` tuple. Keep it private. If the binding
or any immutable readback mismatches, stop; do not edit the JSON to make the
import pass. For S3-only entry, use the first generated input directly:

```sh
export PHASE22_S3_SESSION="$phase22_s3_session"
```

### Prepare all stages, or enter one stage directly

The operator CLI validates the schema, tag peel, private stage inputs and the
qualified `demo-deploy` branch before creating any worktree. It writes one
`session-index.json` under the requested directory. Preparation can be retried
after an input correction; an occupied or dirty path is reported and is never
replaced.

Set paths to private files outside the checkout. The checkpoint map must have
`schemaVersion: 1` and a `checkpoints` object with `S0`-`S5` entries containing
`tag` and a 40-character peeled `commit`. The session input must have
`schemaVersion: 1`, `sessionId`, per-stage `candidateId`/`inputId`, and, for a
full session, `demoDeploy` with `branch: "demo-deploy"`, the qualified commit,
`candidateId: "repaired"`, and `publicationId`.

```sh
checkpoint_map="${PHASE22_CHECKPOINTS:?set the maintained checkpoint map}"
session_input="${PHASE22_SESSION:?set the generated private session input}"
session_root="${PHASE22_SESSION_ROOT:?set a new or settled session directory}"

python3 scripts/talk-session.py prepare \
  --checkpoints "$checkpoint_map" \
  --session "$session_input" \
  --directory "$session_root"
```

The result is JSON describing each workspace, its tag/branch base, commit,
candidate/input identity, and initial clean state. S0-S4 use the peeled tag
commit. S5 alone owns the current qualified `demo-deploy` branch, which may be
newer than the frozen S5 tag. No stage switch moves a ref or changes a cloud
resource.

For direct entry, pass only the selected checkpoint map and that stage's private
session input. S3, for example, does not require S5 qualification or an earlier
S0-S2 run. A stage-only input is sufficient; it does not need the all-stage
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
stage-only input from the same roster, assets, suite and performance ID. Use the
same session root so the existing S3 workspace is preserved, then inspect S4
before editing. The S3-to-S4 handoff still consumes the current immutable S3 run
directory printed by the S3 runner; opening S4 does not relaunch S3:

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
from another browser. It reports the current commit, dirty state and saved
differences; it does not relaunch an execution or replace an edit.

## 5. Rehearse the experience and fallbacks

Use the prepared workspaces for the actual rehearsal, and keep every recorded
fallback labeled with its input and execution identity:

- [ ] Rehearse the opening denial: a genuine new alarm transition, matching
  faulty investigation and wrong memory recommendation, higher-memory switch
  preserving denial, separate fresh failed requests, then actual access
  restoration and recovery. A configuration readback alone proves no business
  outcome.
- [ ] Rehearse selecting repaired with endpoint/version/artifact readback, then
  a new incident after native alarm **OK**. Match the new event/run; do not
  relabel an old report or clear deduplication records.
- [ ] Reopen the controller from a replacement authenticated browser. Start on
  **Incident**, read the same selected tuple and prior investigation identities,
  and use **View full report** when detailed evidence is needed. Interrupt one
  later state/alarm refresh during rehearsal: confirm the UI marks the last
  successful selection stale/unavailable, preserves its earlier observation
  time, and leaves the candidate unchanged until explicit selection succeeds.
- [ ] For the capacity rehearsal, use the **Traffic** tab and its **Inventory
  surge**, **Stop traffic**, healthy traffic and capacity controls. Use the
  approved finite profile and compare
  actual starts, skips, native arrivals, caller outcomes, metric windows and
  checkout effects. Preserve app code, memory, aliases, access, productVersion
  and prior data across the pair. Use the [capacity cue](demo-script.md#phase-10-capacity-overload-and-separate-remedy-observation)
  for acceptance evidence and fallback.
- [ ] Verify recovered/stale-alert examples have a later reference time and
  captured post-recovery evidence. Do not judge a pre-recovery report as though
  it knew later outcomes.
- [ ] Rehearse the audience interactions: review the case, judge the report and
  enter the bounded prompt regression. Reveal reviewed verdicts and actual judge
  findings after the audience vote without changing the rubric. Brief the
  participant on the exact file/edit, timing and presenter takeover.
- [ ] Time execution, ingestion, scoring and CI. Set switch cutoffs leaving time
  for results and closing. Label recorded reports, traces, comparisons and CI
  rejection evidence **recorded** with their identities; a pending live run
  remains pending.
- [ ] Verify numeric slide claims against retained measurements and dated
  pricing. Distinguish agent inference, judging, retries, telemetry, CI and
  feedback waits. Review [audience questions](questions.md).
- [ ] Rehearse the 60-minute [cue sheet](demo-script.md#working-run-of-show),
  screen switches and approved closing. After the final rehearsal, execute
  cleanup before establishing the delivery baseline.

### Run a stage from its prepared workspace

Open the requested stage directory and use its private input paths. Each run
must snapshot its candidate, tooling, lockfile, case/bundle, evaluator and
configuration at launch and write to a unique private result directory. Keep
the command output and identity in the session record.

For the S3 → S4 handoff, pass the directory printed by the current S3 run to
`--source-run` when continuing from that execution. Do not substitute a
historical run whose saved prompt, source, or tooling identity does not match;
keep any recorded result under its original identity.

| Stage | Entry and required evidence |
| --- | --- |
| S0 | Open/edit the faulty source. Use the hosted controller and [S0 operating instructions](demo-script.md) for a genuine alarm; retain the actual report, trace, and sanitized capture. Source editing does not change the served publication. |
| S1 | From the S1 worktree root, copy the portable `audience/denial-session-draft.json` to the session edit directory. Review it against `prepared/denial.json`, then run `validate`, `freeze` and `candidate-input`. Review produces no score. See [agent README](../agent/README.md#review-and-freeze-a-case-s1). |
| S2 | Open the identified saved run with `evaluate_case.py show`, then score only that matching execution with the pinned evaluator. Keep the original execution identity and advisory result. See [agent README](../agent/README.md#run-and-score-the-captured-baseline-s2). |
| S3 | Edit only the prompt in the S3 worktree. Run `evaluate_case.py run --candidate repaired`, inspect with `show`, score the fresh execution with the same evaluator, and compare only after the matching S2 and S3 scores complete. See [agent README](../agent/README.md#run-score-and-compare-the-repaired-candidate-s3). |
| S4 | Run the native `development_experiment.py run` launcher with the prepared suite/evaluator, optionally using an explicitly selected immutable `--source-run`; inspect with `show` and compare the saved experiment offline. A focused run cannot qualify a release. See [agent README](../agent/README.md#run-the-native-strands-development-experiment-s4). |
| S5 | In the only `demo-deploy` worktree, make the reviewed prompt-only regression commit and push through the normal workflow. Record the rejected gate, exact commit/package, frozen case roster, and unchanged repaired serving tuple. Repair the branch through the normal gate before the next full session. |

Switching from S3 to S4 while S3 is running is allowed only after confirming
that each run owns immutable launch-time inputs and a unique output directory.
Opening S4 must not read mutable files from S3 or relaunch S3. A deliberately
missing or incompatible case fails visibly; it is not silently replaced.

## 6. Establish the final live baseline

<a id="save-and-recover-a-session"></a>

### Save and recover a session

After stopping/draining work, build a private inventory from the session index,
Git bases/differences, selected untracked files, reviewed inputs/captures,
result records and CI references. Do not archive a whole worktree, Git
metadata, credentials, virtual environments, `node_modules`, or build caches.
The archive command checks selected content digests and preserves unfinished
records as unfinished; it never relaunches work. The inventory and archive are
both required restore inputs: an archive digest by itself is not a portable
session receipt.

The session index is included as a private file by the command below. Add each
reviewed evidence file with a repeated `--include-path`; for example,
`evidence/s5/push.json` is one possible record. A reviewed untracked file such
as `S0/talk/presenter/s0-intentional-untracked-note.md` may be selected with
`--selected-untracked`, but neither example is mandatory; omit it when the
session has no such file. `PHASE22_REVIEWED_RUN_DIR` is also optional for a
session interrupted before a model run; when set, it must name a non-empty
reviewed directory or the command stops. Never broaden `--selected-untracked`
or `--include-path` to a whole worktree.

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

Restore only into verified clean stage bases prepared first. Preserve unrelated
or conflicting destination edits and stop on a digest mismatch. Check each
stage's Git diff/commit and each restored run record after restore. When the
inventory records stage-local commits, `restore` imports their Git bundles and
checks the exact saved HEAD before applying the selected file overlay; do not
cherry-pick the commit again. Reopening a session shows saved status; it does
not start an evaluation, checkout, alarm, deployment, or reset.

For durable storage, use the existing versioned private asset bucket from the
operator's receipt under a unique `talk-sessions/<session-id>/` prefix.
Upload/download is an operator action after local save/restore has passed, not
part of preparation. Upload both restore inputs, retain separate object
versions and trusted hashes, and do not use an unpinned latest object:

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

Record the two returned VersionId values, both SHA-256 values, object keys,
UTC time and aws sts get-caller-identity result in the private receipt. On a
replacement Codespace, read that retained receipt, download both exact object
versions, and verify each against its trusted hash before writing/verifying the
archive sidecar and restoring:

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

Only after those exact-version readbacks and archive-sidecar check pass, use a
fresh reviewed clone to prepare every detached A base - including S5 - from the
inventory, then restore the selected files. A must never attach or move the
current demo-deploy branch:

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

Historical A is evidence recovery only and must not be presented as the
currently qualified release or used to overwrite a newer live demo-deploy.
Keep all six A worktrees detached. Only after A's restore and inspection are
complete may separate session B preparation check out and own the current
qualified demo-deploy branch and verify its new tip.

Use the browser console or the CLI only with the scoped operator profile. Keep
the private archive, version receipts and credentials off the public repo.

### Final live readiness

Before a full performance, stop and drain producers, reconcile unresolved
checkout identities on the **Storefront**, close old checkout pages, and verify
the current app and controller release. Confirm the fresh native alarm is
**OK**, the intended
candidate tuple is read back, and no action can still submit traffic. Use the
controller's **History** tab and use **Reset demo** once with a fresh
`productVersion` only for a whole-talk restart after prior work is settled;
captured-only direct entry does not
need a business reset. Keep traffic stopped until the scripted start.

Record account/region, app/controller URLs, current source and manifest,
controller run, endpoint/artifact tuples, six workspace bases, private input and
result identities, and any incomplete or recorded fallback. Do not call a
recorded result a fresh execution or a source edit a qualified publication.

Before declaring the baseline ready:

- [ ] Stop producers and other browser writers, drain accepted work, reconcile
  checkout IDs and receipts, close old checkout pages, and keep traffic stopped.
- [ ] For a whole-talk restart only, use the controller's normal Reset once with
  a fresh `productVersion` after prior work is settled. Captured-only direct
  entry does not need a business reset. Do not manipulate controller records.
- [ ] Verify the current app/controller release, trusted settings, healthy
  alias/version, Inventory cap **16**, unreserved Checkout, native alarm **OK**,
  exact adapter binding and ready endpoint. A stale or missing read is not fresh
  incident readiness.
- [ ] Select retained **faulty** for the opening only after its prepared tuple
  and the native alarm are read back. Keep repaired deployed and qualified for
  later selection.
- [ ] Record stock, verification order, selection, alarm observation time,
  session/run ID and actual request counts/outcomes. Captured-evidence-only
  entry needs its assets/services, not an unnecessary business Reset.

## 7. Before the room opens

- [ ] Open the final deck, notes/timer, app, controller, live report, Codespace,
  native reports, AgentCore Observability and GitHub Actions. Preselect relevant
  resources/stages without executing them.
- [ ] Set browser/terminal/editor zoom and arrange readable views. Confirm
  display, presenter notes, network and power. Close credential pages and
  unrelated notifications.
- [ ] Set out the magic box and two visibly different paper planes. Confirm the
  participant and fallback/takeover cues.
- [ ] Recheck authentication, branch/workspace identity, stopped traffic,
  settled actions, baseline, timing plan, faulty selection, native alarm OK and
  recorded fallbacks. Avoid new deployments or unverified input changes.
- [ ] Mark selected stages ready only when their actual commands and inputs have
  been verified. If a live path is unavailable, explicitly choose the rehearsed
  recorded/skip route; prepared evidence cannot establish fresh execution of an
  edited candidate.
