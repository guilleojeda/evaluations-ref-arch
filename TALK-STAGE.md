# S5 · Submit the regression

Open this folder as S5 on the long-lived `demo-deploy` branch. Its starting point is the source that produced the currently qualified repaired package. The frozen S5 tag records the first qualified checkpoint for this generation. Check the current binding from the operator checkout using the [preparation instructions](docs/preparation.md). Opening the folder does not deploy the prompt or change the controller's live selection.

## Enter directly

Use the verified private input index for this session. `agent/qualification-input.json` identifies the reviewed suite archive, case IDs, and evaluator digest used by CI. Direct entry retrieves those prepared inputs without an S1 review or an S3/S4 run. If using a new reviewed case, freeze it first and bind its exact case and evidence in a separate input commit before the participant's prompt edit. Verify the suite retains the known denial witness and the required capacity and recovery coverage. Keep those inputs, the evaluator and the policy fixed for the comparison.

```sh
git branch --show-current
git status --short
git rev-parse HEAD
git ls-remote origin refs/heads/demo-deploy
cat agent/qualification-input.json
```

The branch must be `demo-deploy`, clean, at the verified qualified revision. A different branch head or unqualified candidate needs the explicit [branch repair procedure](docs/cleanup.md). Never replace the branch with the frozen tag. From the operator folder use `python3 scripts/talk-session.py status --directory "$SESSION_ROOT" --stage S5` to inspect the recorded base and saved differences.

## Make the change and inspect the real gate

Edit `agent/prompt.py` in this workspace. Restore the rehearsed memory-first recommendation for denied Inventory reads. For a scripted rehearsal that needs the exact known change, start with a clean tracked prompt and restore only that path from the generation's frozen faulty S2 source. Verify that the maintained checkpoint map still resolves S2 to the exact frozen tag before changing the worktree:

```sh
checkpoint_map="${PHASE22_CHECKPOINTS:?set the maintained checkpoint map}"
faulty_s2_ref='refs/tags/talk/v1/S2'
expected_s2_commit="$(python3 -c 'import json,sys; source=json.load(open(sys.argv[1], encoding="utf-8"))["checkpoints"]["S2"]; assert source["tag"] == "talk/v1/S2"; print(source["commit"])' "$checkpoint_map")"
test "$(git rev-parse --verify "${faulty_s2_ref}^{commit}")" = "$expected_s2_commit" &&
  git cat-file -e "${faulty_s2_ref}^{commit}:agent/prompt.py" &&
  git diff --quiet --cached -- agent/prompt.py &&
  git diff --quiet -- agent/prompt.py &&
  git restore --source=refs/tags/talk/v1/S2 --worktree -- agent/prompt.py
```

The two quiet diff checks separately reject staged and unstaged prompt changes, including opposite changes whose net diff against `HEAD` is empty. `git restore --worktree` leaves the index untouched. The command does not replace the S5 branch, alter any other path, or rewrite the historical `agent/prompts/s3-repair.patch`, which remains the reviewed S3 input. Show the full prompt diff before committing. Confirm the suite pointer and all other inputs are unchanged. A push to this branch starts the real workflow.

```sh
git diff --name-only HEAD
git diff -- agent/prompt.py
git commit --only -m "Demonstrate the memory-first recommendation" -- agent/prompt.py
git push origin HEAD:refs/heads/demo-deploy
regression_commit="$(git rev-parse HEAD)"
gh run list --branch demo-deploy --workflow deploy.yml --commit "$regression_commit"
```

Record the pushed commit and Actions run. Inspect the tested ARM64 ZIP digest, the failed *required* finding for the denial case and the actual model-generated report. Check that publication was skipped and read the previously qualified repaired endpoint and original faulty endpoint again. A pending run, unavailable telemetry or failed infrastructure step cannot establish a quality rejection. Keep the failed commit and reports in the session record. The [cleanup instructions](docs/cleanup.md) cover the ordinary revert, its new package review, and the next performance.
