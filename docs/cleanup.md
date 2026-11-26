# Talk cleanup

After each performance or interrupted rehearsal, stop traffic, reconcile outstanding checkouts, archive the session and revert the participant's S5 regression. Keep the stacks, both published endpoints, frozen tags and evidence for the next performance. Routine cleanup leaves the orders in place. Running the public local example needs none of these steps.

If you stop partway through cleanup, note the last confirmed step and every unresolved action in the private session record before starting [preparation](preparation.md). Keep the repaired publication and controller selection with the session record. Keep the archived faulty reference intact.

## 1. Stop activity and settle outcomes

- [ ] Stop both controller producers and unrelated browser writers. Close old
  checkout pages and let accepted work drain. Closing a browser does not stop a
  worker.
- [ ] Inspect controller actions, local evaluations, scoring and telemetry
  waits, and GitHub runs. Finish bounded work or explicitly stop it. Preserve
  each actual status. Reconcile a partial publication before another mutation.
- [ ] Reconcile every unresolved checkout ID with its immutable input and a
  bounded status read. A timeout or one 404 does not prove that no write
  occurred.
- [ ] Record submitted, completed, skipped, unknown, and in-flight counts.
  Retain controller, browser, and app request evidence separately.

## 2. Save the session before releasing the Codespace

Create an allowlisted private inventory from the session index. Include the six
workspace bases and saved differences, selected tracked deletions, intentional
untracked source, reviewed cases and captures, candidate and tooling snapshots,
experiment, report, and score receipts, unfinished records, and CI links.
Exclude credentials, Git metadata, `.venv`, `node_modules`, build caches, and
unselected files.

Confirm that the saved `sessionId` is this performance's distinct
`PHASE22_SESSION_ID`. An unchanged prepared-asset hash may appear in another
session. Keep the session index, inventory, results, and archive identity tied
to this performance.

Preserve the durable controller run and action records, configuration
checkpoints, original and current-cap observations, immutable surge profiles,
action and window IDs, actual fetch starts, skips and outcomes, metric windows,
checkout effects, and unresolved identities. Preserve the audience-reviewed
case separately from prepared cases with its evidence references and reference
time. Keep candidate and tooling snapshots, model, evaluator and policy
versions, complete telemetry, raw findings, native reports, and
pending or incomplete statuses.

Preserve the exact faulty-reference descriptor, archive, source, and
configuration digests, S3 `VersionId`, setup workflow run ID,
Runtime/endpoint/adapter tuple, and `AGENT_PUBLICATION#faulty` readback outside
teardown scope. Preserve the repaired publication, qualification and review
tuple, and `AGENT_SELECTION` readback separately. Before deleting the
Codespace, copy saved edits, ignored and local files, results, and required
GitHub artifacts and logs to durable private storage. Verify the copies,
digests, and replacement-browser access. Remove credentials from material for
sharing. Do not rewrite reports or outcomes to match the intended story.

Before releasing the Codespace, run the complete [save and recover
sequence](preparation.md#save-and-recover-a-session). It uses the normal
inventory CLI with only reviewed allowlisted session-index, selected-untracked,
and record files. It saves both the inventory and archive and verifies the
archive sidecar. Verify the inventory directly against its retained SHA-256.
Do not add a second required sidecar. Both the inventory and archive are
required restore inputs. Do not replace this sequence with an archive-only save
or an archive digest.

Upload both files through the versioned private asset bucket and
`talk-sessions/<session-id>/` prefix named by the operator's receipt. Record an
S3 VersionId and SHA-256 and metadata for each object, plus UTC time and
operator identity. The upload and download receipt is separate from the
content-addressed evaluation inputs in the evidence bucket. Use the exact
versioned readback commands in
[preparation](preparation.md#save-and-recover-a-session).

In a replacement Codespace, read the retained receipt and use the exact archive
and inventory object versions. Verify each downloaded file against its trusted
receipt hash. Write and verify the expected archive sidecar. Before restoring,
prepare all six clean A bases, including detached S5, from
`inventory.sourceBase.commits`:

```sh
replacement_repository="${PHASE22_SESSION_REPLACEMENT_REPOSITORY:?path to the reviewed replacement clone}"
(
  cd "$replacement_repository"
  python3 scripts/talk-session.py restore \
    --directory "$replacement_session_root" \
    --archive "$replacement_archive" \
    --inventory "$replacement_inventory"
  python3 scripts/talk-session.py status \
    --directory "$replacement_session_root" --stage S3
)
```

Verify the restored files' original digests, each stage's base commit and diff,
the two run identities, and that an unfinished run remains unfinished. Do not
silently rerun work during restore. Preserve dirty or conflicting destination
edits and stop rather than overwriting them. Keep every A worktree detached.
Only a separate session B may later own the current qualified `demo-deploy`
branch.

## 3. Repair `demo-deploy` after the regression

Run this section only when S5 actually committed the prompt regression. A
failed gate leaves regressed source on `demo-deploy` while the previously
qualified repaired artifact continues serving. Reverting source creates a new
package identity. The earlier pass does not qualify it.

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

Preserve the recorded regression SHA. Inspect the commit and confirm that it is
prompt-only. Revert that exact commit in the S5 worktree. Do not reset, rebase,
amend, force-push, move a frozen tag, or replace newer source with an old
checkpoint.

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

Wait for the normal full gate. Before publication, inspect the exact new ZIP,
source, prompt, and configuration identities, frozen cases, deterministic
findings, real reports and traces, and source-backed human approval. Verify the
new repaired publication and selection tuple. Verify that the faulty
publication is unchanged. If the run fails, remains pending, or the response
is lost, preserve the old verified serving tuple and mark preparation
incomplete. Do not repin an endpoint by hand.

Before pushing a later repair, stop traffic and settle accepted work. Proceed
only with a clean S5 worktree on `demo-deploy` that contains the regression and
deployed ancestry. If another session already repaired it, verify that
publication instead of reverting twice. If history diverged, the revert
conflicts, or the diff changes more than the intended regression, stop and
resolve deliberately. Do not use `main` for this repair. Open the Actions run
for the exact pushed repair commit. Complete source-backed human review of the
exact repaired ZIP, frozen cases, and actual reports and traces. Record the
repair commit, workflow run, qualification, and publication. The normal
history is **repaired passes/publishes - regression fails - repair
passes/publishes**.

## 4. Leave the application and selection healthy

- [ ] Confirm successful current app and controller releases and trusted
  settings. Reconcile partial releases before recovery or reset.
- [ ] With producers stopped and work settled, use the controller's normal
  **Recover**. Return Inventory to cap **16**, Checkout to unreserved, the
  intended baseline, and a healthy role-backed alias. Preserve the denied role
  and policy for the next incident.
- [ ] Observe configuration readback separately from fresh authenticated
  catalog and checkout verification. Preserve the receipt, stock effect, and
  unknown outcomes in the session record.
- [ ] Wait for native alarm **OK**. Verify the adapter and endpoint binding.
  Explicitly select **faulty** for the next opening only after strongly reading
  back the selected tuple. Keep traffic stopped.

Do not run Reset during routine cleanup. For the next whole-talk restart,
[preparation](preparation.md#final-live-readiness) must reconcile the current
successful release, restore Inventory cap **16** and unreserved Checkout with
trusted healthy settings, replace the canonical SKU at stock 1,000 under a
fresh `productVersion`, delete prior Orders, and verify the new baseline. It
then runs the controller's confirmed **Reset** once. Reset archives the old run
and its cap observations, then creates the linked controller run and session.
Do not create another run or manipulate controller records directly. If a later
readiness check is needed, record its separate checkout in the actual request
counts. A captured-evidence-only entry needs its assets and services, not a
business Reset.

If Reset is interrupted, leave it unusable. Wait for its execution and drain
window, preserve unknown effects, and explicitly start one new confirmed Reset
with a new action UUID and `productVersion`.

## 5. Close the session without destructive cleanup

- [ ] Verify that the six worktrees are archived before releasing them. Keep
  frozen tags and `talk/checkpoints.json` unchanged.
- [ ] Release the old S5 `demo-deploy` worktree association only after
  preserving its commits, diffs, and archive. Prepare the next S5 from the
  newly qualified repaired branch, never from the frozen S5 tag.
- [ ] Close credential pages, sign out of shared computers, stop unused
  Codespaces and local processes, and verify that no traffic, evaluation,
  workflow, or temporary schedule remains active unintentionally.
- [ ] Do not use `git clean`, recursive deletion, or broad resource deletion to
  make a session look clean. Remove only explicitly selected temporary files
  after ownership and archive checks.
- [ ] Mark cleanup complete with branch and serving identities, health
  observation, archive key, version and digest, request records, and unresolved
  items.

## After the final delivery

Routine cleanup does not delete the three stacks, retained tables, logs, private
evidence, prepared publications, or frozen checkpoints. If retiring the demo,
inventory and export evidence first. Use a separately reviewed teardown
procedure for the configured account and Region. Stack deletion does not remove
every retained resource.
