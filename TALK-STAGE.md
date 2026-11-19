# S1 — Review and freeze a case

This workspace is the Phase 22 S1 checkpoint. It keeps the faulty candidate
unchanged and adds reviewed-case validation, freezing, and a public candidate
projection. The default candidate remains `faulty`; S1 does not run S0, trigger
an alarm, invoke a model, or score a case. Maintained preparation verifies the
selected private asset and exports its digest as `PHASE22_ASSET_SHA256` from
the receipt named by `PHASE22_ASSET_RECEIPT` before any case edit.

Set `PHASE22_PRIVATE_ROOT` outside this checkout and export
`PHASE22_INPUT_INDEX` to the private session index. Set
`asset_extract` to the already verified asset extraction,
`PHASE22_ASSET_RECEIPT` to its private receipt,
`PHASE22_ASSET_SESSION_ID` to the roster's session ID, and
`PHASE22_ASSET_SHA256` to the receipt's archive digest. The extraction contains
`audience/denial-session-draft.json` and the matching `prepared/denial.json`
bundle. Private case/trace bytes stay outside the editable worktree.

```sh
uv sync --project agent --locked
uv sync --offline --project agent --locked
mkdir -p "$PHASE22_PRIVATE_ROOT/s1/edit" "$PHASE22_PRIVATE_ROOT/s1/frozen"
: "${asset_extract:?run maintained asset preparation first}"
: "${PHASE22_ASSET_RECEIPT:?set the verified private asset receipt path}"
: "${PHASE22_ASSET_SESSION_ID:?set the session ID from session-roster.json}"
: "${PHASE22_ASSET_SHA256:?read from PHASE22_ASSET_RECEIPT}"
test -d "$asset_extract" && test -s "$asset_extract/audience/denial-session-draft.json"
test -s "$asset_extract/prepared/denial.json"
printf 'Using verified Phase 22 asset %s\n' "$PHASE22_ASSET_SHA256"
cp "$asset_extract/audience/denial-session-draft.json" \
  "$PHASE22_PRIVATE_ROOT/s1/edit/denial.reviewed.json"
export PHASE22_REVIEWED_CASE="$PHASE22_PRIVATE_ROOT/s1/edit/denial.reviewed.json"
export PHASE22_SOURCE_BUNDLE="$asset_extract/prepared/denial.json"
printf '%s  %s\n' \
  8880601278a059cbb7c792949e74785f6b8c1489dede8fa25f7b38299b8633a8 \
  "$PHASE22_SOURCE_BUNDLE" | sha256sum -c -
uv run --offline --project agent --locked python -m py_compile \
  agent/reviewed_cases.py agent/captured_evidence.py
python -m json.tool talk/stage.json >/dev/null
```

Open the imported trace pointer and case draft in the browser editor. Complete
the expected action, target, value, and unit from matched captured evidence;
do not copy evaluator-only fields into the candidate projection. Validate the
edited review against the same bundle and freeze it to a new private path:

```sh
uv run --offline --project agent --locked python agent/reviewed_cases.py validate \
  --case "$PHASE22_REVIEWED_CASE" --bundle "$PHASE22_SOURCE_BUNDLE"
uv run --offline --project agent --locked python agent/reviewed_cases.py freeze \
  --case "$PHASE22_REVIEWED_CASE" --bundle "$PHASE22_SOURCE_BUNDLE" \
  --output "$PHASE22_PRIVATE_ROOT/s1/frozen/denial.frozen.json"
uv run --offline --project agent --locked python agent/reviewed_cases.py candidate-input \
  --case "$PHASE22_PRIVATE_ROOT/s1/frozen/denial.frozen.json" \
  --bundle "$PHASE22_SOURCE_BUNDLE" > \
  "$PHASE22_PRIVATE_ROOT/s1/denial.candidate-task.json"
```

Inspect the public projection and its identity against the saved edits. S1
review produces no score and no agent execution. A missing or mismatched
archive remains incomplete; do not substitute a live query or another case.
