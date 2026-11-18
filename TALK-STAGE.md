# S1 — Review and freeze a case

This workspace is the Phase 22 S1 checkpoint. It keeps the faulty candidate
unchanged and adds reviewed-case validation, freezing, and a public candidate
projection. The default candidate remains `faulty`; S1 does not run S0, trigger
an alarm, invoke a model, or score a case. The imported Phase 14 manifest has
SHA-256 `222c63de2a2acc30060a7807a2d1cf17e6bfa0b921eebe4410a9557b12739ae1`.

Set `PHASE22_PRIVATE_ROOT` outside this checkout and export
`PHASE22_INPUT_INDEX` to the private session index. Set
`PHASE22_AUDIENCE_ARCHIVE` to the verified portable
`phase22-session-a-audience-full.tar.gz`, then extract it into a new private S1
directory. Its root contains `SHA256SUMS`, `audience/denial-session-draft.json`,
and the matching `prepared/denial.json` bundle. Private case/trace bytes stay
outside the editable worktree.

```sh
uv sync --project agent --locked
uv sync --offline --project agent --locked
mkdir -p "$PHASE22_PRIVATE_ROOT/s1/edit" "$PHASE22_PRIVATE_ROOT/s1/frozen"
asset_extract="$(mktemp -d "$PHASE22_PRIVATE_ROOT/s1/archive.XXXXXX")"
tar -xzf "$PHASE22_AUDIENCE_ARCHIVE" -C "$asset_extract"
(cd "$asset_extract" && sha256sum -c SHA256SUMS)
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
