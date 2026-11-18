# S3 — Edit and run a repaired candidate

This workspace is the Phase 22 S3 checkpoint. Its default candidate is the
exact repaired prompt used by the qualified Phase 20 publication. S3 adds a
fresh editable execution and comparison while retaining the faulty baseline.
`agent/prompt.py` has file SHA-256
`88b8b94f2da13263407aadc1301bc5b4c2345fcec3ac2bd148fead9835807bdd` and
semantic prompt SHA-256
`0f8d10ce6f46302a00dbe60cb29ebfeb4212627000c78b3529e6e0c7696ff425`.

Set `PHASE22_PRIVATE_ROOT` outside this checkout and export
`PHASE22_INPUT_INDEX` to the private session input index. The index must resolve
`PHASE22_S2_RUN`, `PHASE22_REVIEWED_CASE`, `PHASE22_SOURCE_BUNDLE`,
`PHASE22_S3_RUN_ROOT`, and `PHASE18_EVALUATOR` to private paths outside the
checkout.

The presenter input index maps the reviewed denial pair to
`stage-assets-full/session-a/s2/case.frozen.json` and
`stage-assets-full/session-a/s2/bundle.json` (case SHA-256
`cb1480066a46f258ee8d9e27355d50b9bd05f171ee9ef84a169989f72af5e18d`, bundle
SHA-256 `8880601278a059cbb7c792949e74785f6b8c1489dede8fa25f7b38299b8633a8`).
The files remain private and are never copied into this checkout.

```sh
uv sync --offline --project agent --locked
uv run --offline --project agent --locked python -m py_compile \
  agent/prompt.py agent/evaluate_case.py agent/compare_executions.py
python -m json.tool talk/stage.json >/dev/null
```

The repaired prompt is already present; do not apply the repair patch a second
time. To show the faulty starting option in this same editable folder, first
ensure it is clean, verify the reverse patch, then apply it. If the folder is
dirty, stop and preserve the edit; never overwrite it:

```sh
git diff --quiet
git apply --reverse --check agent/prompts/s3-repair.patch
git apply --reverse agent/prompts/s3-repair.patch
python -m py_compile agent/prompt.py
```

Restore the repaired prompt only through an explicit editor action or by
discarding the private demonstration edit after recording it; do not use this
option while an S3 run is in flight. The run itself snapshots its launch-time
source.

## Run and compare

Run the repaired source against the same frozen case and bundle as S2, writing
to a unique private output root:

```sh
uv run --project agent --locked opentelemetry-instrument \
  python agent/evaluate_case.py run --candidate repaired \
  --case "$PHASE22_REVIEWED_CASE" --bundle "$PHASE22_SOURCE_BUNDLE" \
  --output-root "$PHASE22_S3_RUN_ROOT"
```

Inspect and score the result explicitly, then compare only matching identities:

```sh
uv run --offline --project agent --locked python agent/evaluate_case.py show \
  --run "$PHASE22_S3_RUN"
uv run --project agent --locked python agent/evaluate_case.py score \
  --run "$PHASE22_S3_RUN" --evaluator "$PHASE18_EVALUATOR" \
  --rubric single --wait-seconds 300
uv run --offline --project agent --locked python agent/evaluate_case.py compare \
  --baseline "$PHASE22_S2_RUN" --candidate "$PHASE22_S3_RUN"
```

The semantic verdict is advisory feedback. A changed lock, replay clock, case,
model, evaluator, or policy creates a distinct candidate and cannot be bridged
by relaxing comparator checks. This local result is not exact-package S5
qualification.

