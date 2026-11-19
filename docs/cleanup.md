# Talk cleanup

Use this after every delivery or rehearsal, including an interrupted session.
Routine cleanup retains the cloud stacks, publisher-owned faulty reference,
qualified repaired publication, frozen tags and evidence. It repairs the source
branch after the S5 regression; it does not restore an old cloud snapshot or
tear down the demo. Run [preparation](preparation.md) only after this procedure
is complete or its remaining steps are explicitly recorded as incomplete.

Use implemented controller/workflow operations. Reset creates the next durable
controller run; the private session-index process and repaired
publication/selection remain separate from the Phase 19 reference fixture.
Failed or incomplete cleanup stays recorded as incomplete.

## 1. Stop activity and settle outcomes

- [ ] Stop both controller producers and unrelated browser writers. Close old
  checkout pages and let accepted work drain; closing a browser does not stop a
  worker.
- [ ] Inspect controller actions, local evaluations, scoring/telemetry waits and
  GitHub runs. Finish bounded work or explicitly stop it and preserve its actual
  status. Reconcile a partial publication before another mutation.
- [ ] Reconcile every unresolved checkout ID with its immutable input and a
  bounded status read. A timeout or one 404 is not proof that no write occurred.
- [ ] Record submitted, completed, skipped, unknown and in-flight counts and
  retain controller, browser and app request evidence separately.

## 2. Save the session before releasing the Codespace

Create an allowlisted private inventory from the Phase 22 session index. Include
the six workspace bases and saved differences, selected tracked deletions,
intentional untracked source, reviewed cases/captures, candidate/tooling
snapshots, experiment/report/score receipts, unfinished records and CI links.
Exclude credentials, Git metadata, `.venv`, `node_modules`, build caches and
unselected files.

Confirm the saved `sessionId` is the distinct `PHASE22_SESSION_ID` for this
performance. An unchanged prepared-asset hash may appear in another session;
the session index, inventory, results and archive identity must remain tied to
this performance.

Also preserve the durable controller run/action records and configuration
checkpoints, original and current-cap observations, immutable saved surge
profiles and action/window IDs, actual fetch starts/skips/outcomes, metric
windows, checkout effects and unresolved identities. Preserve the actual
audience-reviewed case separately from prepared cases, with its evidence
references and reference time. Keep candidate/tooling snapshots,
model/evaluator/policy versions, complete telemetry, raw findings, native
reports and pending/incomplete statuses.

Preserve the exact faulty-reference descriptor, archive/source/configuration
digests and S3 `VersionId`, setup workflow run ID, Runtime/endpoint/adapter
tuple and `AGENT_PUBLICATION#faulty` readback outside teardown scope. Preserve
the repaired publication, qualification/review tuple and `AGENT_SELECTION`
readback separately. Copy saved edits, ignored/local files, results and needed
GitHub artifacts/logs to durable private storage before the Codespace is
deleted; verify copies, digests and replacement-browser access. Remove
credentials from material intended for sharing and do not rewrite reports or
outcomes to match the intended story.

```sh
python3 scripts/talk-session.py status --directory "$session_root" --stage S3
python3 scripts/talk-session.py save \
  --directory "$session_root" \
  --archive "$private_archive" \
  --inventory "$private_inventory"
sha256sum "$private_archive"
```

Upload the resulting archive only through the versioned private asset bucket
and `talk-sessions/<session-id>/` prefix named by the operator's receipt.
Record the returned S3 `VersionId`, object SHA-256/metadata, key, UTC time and
operator identity. The upload/download receipt is separate from the
content-addressed evaluation inputs in the evidence bucket. See the
[versioned readback commands](preparation.md#6-save-and-recover-a-session).

On a replacement Codespace, prepare clean stage bases first and then restore
the recorded archive version:

```sh
python3 scripts/talk-session.py restore \
  --directory "$replacement_session_root" \
  --archive "$private_archive" \
  --inventory "$private_inventory"
python3 scripts/talk-session.py status \
  --directory "$replacement_session_root" --stage S3
```

Verify the restored files' original digests, each stage's base commit and diff,
the two run identities and the fact that an unfinished run remains unfinished.
Do not silently rerun work during restore. Keep dirty or conflicting destination
edits and stop rather than overwriting them.

## 3. Repair `demo-deploy` after the regression

Do this only when S5 actually committed the prompt regression. A failed gate
leaves regressed source on `demo-deploy` while the previously qualified repaired
artifact continues serving. Reverting source creates a new package identity;
the earlier pass does not qualify it.

```sh
s5_root="${PHASE22_S5_ROOT:?path to the only demo-deploy worktree}"
test -d "$s5_root" || { printf '%s\n' "S5 worktree is unavailable: $s5_root" >&2; exit 2; }
s5_branch="$(git -C "$s5_root" branch --show-current)"
test "$s5_branch" = demo-deploy || {
  printf 'S5 worktree must be on demo-deploy (found %s)\n' "${s5_branch:-detached}" >&2
  exit 2
}
test -z "$(git -C "$s5_root" status --porcelain)" || {
  printf '%s\n' 'S5 worktree is dirty; preserve its edits before continuing.' >&2
  exit 2
}
git -C "$s5_root" fetch origin demo-deploy || {
  printf '%s\n' 'Unable to refresh origin/demo-deploy; stop without changing S5.' >&2
  exit 2
}
local_commit="$(git -C "$s5_root" rev-parse HEAD)"
remote_commit="$(git -C "$s5_root" rev-parse --verify origin/demo-deploy 2>/dev/null)" || {
  printf '%s\n' 'origin/demo-deploy is unavailable; stop without changing S5.' >&2
  exit 2
}
if test "$local_commit" != "$remote_commit"; then
  git -C "$s5_root" merge-base --is-ancestor "$local_commit" "$remote_commit" || {
    printf '%s\n' 'S5 diverged from origin/demo-deploy; stop and inspect.' >&2
    exit 2
  }
  git -C "$s5_root" merge --ff-only "$remote_commit"
fi
git -C "$s5_root" status --short
git -C "$s5_root" log --oneline -8
```

Preserve the recorded regression SHA, inspect that it is prompt-only, and
revert that exact commit in the S5 worktree. Do not reset, rebase, amend,
force-push, move a frozen tag, or replace newer source with an old checkpoint.

```sh
s5_root="${PHASE22_S5_ROOT:?path to the only demo-deploy worktree}"
regression_commit="${REGRESSION_COMMIT:?set the recorded S5 regression SHA}"
s5_branch="$(git -C "$s5_root" branch --show-current)"
test "$s5_branch" = demo-deploy || {
  printf 'S5 worktree must be on demo-deploy (found %s)\n' "${s5_branch:-detached}" >&2
  exit 2
}
test -z "$(git -C "$s5_root" status --porcelain)" || {
  printf '%s\n' 'S5 worktree is dirty; preserve its edits before reverting.' >&2
  exit 2
}
git -C "$s5_root" status --short
git -C "$s5_root" show --stat "$regression_commit"
git -C "$s5_root" revert "$regression_commit"
git -C "$s5_root" show --stat --oneline HEAD
git -C "$s5_root" diff HEAD^ HEAD
git -C "$s5_root" push origin HEAD:demo-deploy
```

Wait for the normal full gate. Inspect the exact new ZIP, source/prompt/config
identities, frozen cases, deterministic findings, real reports/traces and
source-backed human approval before publication. Verify the new repaired
publication and selection tuple, and verify that the faulty publication is
unchanged. If the run fails, remains pending or the response is lost, preserve
the old verified serving tuple and mark preparation incomplete; do not repin an
endpoint by hand.

Before pushing a later repair, stop traffic and settle accepted work. Proceed
only with a clean S5 worktree on `demo-deploy` containing the regression and
deployed ancestry; if another session already repaired it, verify that
publication rather than reverting twice. If history diverged, the revert
conflicts, or the diff changes more than the intended regression, stop and
resolve deliberately. Do not use `main` for this repair. Open the Actions run
for the exact pushed repair commit, complete source-backed human review of the
exact repaired ZIP, frozen cases and actual reports/traces, and record the
repair commit, workflow run, qualification and publication. The normal history
is **repaired passes/publishes → regression fails → repair passes/publishes**.

## 4. Leave the application and selection healthy

- [ ] Confirm successful current app/controller releases and trusted settings;
  reconcile partial releases before any recovery or reset.
- [ ] With producers stopped and work settled, use the controller's normal
  **Recover** to return Inventory to cap **16**, Checkout unreserved, the
  intended baseline and a healthy role-backed alias. Preserve the denied role
  and policy for the next incident.
- [ ] Observe configuration readback separately from fresh authenticated
  catalog/checkout verification. Preserve receipt, stock effect and unknown
  outcomes in the session record.
- [ ] Wait for native alarm **OK**, verify the adapter/endpoint binding and
  explicitly select **faulty** for the next opening only after the selected tuple
  is strongly read back. Keep traffic stopped.

For the next whole-talk restart, reconcile the current successful release,
restore Inventory cap **16** and unreserved Checkout with trusted healthy
settings, replace the canonical SKU at stock 1,000 under a fresh
`productVersion`, delete prior Orders and verify the new baseline. Reset itself
archives the old run and its actual cap observations, then creates the linked
new controller run/session; do not create another run separately or manipulate
controller records. If a later readiness check is needed, record its separate
checkout in the actual request counts. A captured-evidence-only entry needs its
assets/services, not an unnecessary business Reset.

For a whole-talk restart, preparation may run the existing confirmed **Reset**
once after this cleanup with a fresh `productVersion`; it archives the prior
controller run and creates the linked next run. Do not create or edit controller
records directly. If Reset is interrupted, leave it unusable, wait for its
execution/drain window, preserve unknown effects, and explicitly start one new
confirmed Reset with a new action UUID/productVersion.

## 5. Close the session without destructive cleanup

- [ ] Verify the six worktrees have been archived before releasing them. Keep
  frozen tags and `talk/checkpoints.json` unchanged.
- [ ] Release the old S5 `demo-deploy` worktree association only after its
  commits, diffs and archive are preserved. Prepare the next S5 from the newly
  qualified repaired branch, never from the frozen S5 tag.
- [ ] Restore the separate one-case IDE smoke prompt to `RESTORE_ACCESS` if it
  was edited. Keep its results distinct from the real S3/S4 experiment and S5
  gate.
- [ ] Close credential pages, sign out of shared computers, stop unused
  Codespaces and local processes, and verify no traffic, evaluation, workflow or
  temporary schedule remains active unintentionally.
- [ ] Do not use `git clean`, recursive deletion, or broad resource deletion to
  make a session look clean. Remove only explicitly selected temporary files
  after ownership and archive checks.
- [ ] Mark cleanup complete with branch/serving identities, health observation,
  archive key/version/digest, request records and unresolved items.

## After the final delivery

Routine cleanup does not delete the three stacks, retained tables, logs,
private evidence, prepared publications or frozen checkpoints. If retiring the
demo, inventory and export evidence first and use a separately reviewed teardown
procedure for the configured account and region; stack deletion does not remove
every retained resource.
