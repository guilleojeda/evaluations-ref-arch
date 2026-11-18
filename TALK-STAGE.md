# S3 — Edit and run a repaired candidate

This workspace is the Phase 22 S3 checkpoint. Its default candidate is the
exact repaired prompt used by the qualified Phase 20 publication. S3 adds a
fresh editable execution and comparison while retaining a matching faulty
baseline. `agent/prompt.py` has file SHA-256
`88b8b94f2da13263407aadc1301bc5b4c2345fcec3ac2bd148fead9835807bdd` and
semantic prompt SHA-256
`0f8d10ce6f46302a00dbe60cb29ebfeb4212627000c78b3529e6e0c7696ff425`.

Set `PHASE22_PRIVATE_ROOT` to the private handoff directory and
`PHASE22_INPUT_INDEX` to its input index. The index is authoritative: it
resolves the variables below to files outside this checkout. Do not hardcode a
session directory or copy private inputs into Git.

For a carried S2 case, retain the reviewed case, source bundle, and S2 run
together. For a new fixed case, update all three entries in the private index
to the new case/bundle/run before starting S3; do not compare a new case with
an old S2 run. A missing or mismatched private asset is incomplete.

The private handoff must resolve:

- `PHASE22_REVIEWED_CASE`
- `PHASE22_SOURCE_BUNDLE`
- `PHASE22_S2_RUN` (the carried faulty run, used for provenance)
- `PHASE22_S3_RUN_ROOT`
- `PHASE22_S3_BASELINE_ROOT`
- `PHASE18_EVALUATOR`

The reviewed denial pair has case identity
`cb1480066a46f258ee8d9e27355d50b9bd05f171ee9ef84a169989f72af5e18d` and bundle
SHA-256 `8880601278a059cbb7c792949e74785f6b8c1489dede8fa25f7b38299b8633a8`.
The files remain private and their physical locations are selected by the
index.

For the portable session-a archive, the same values can be resolved directly
without an internal session-directory assumption:

```sh
export PHASE22_AUDIENCE_ARCHIVE="/private/path/phase22-session-a-audience-full.tar.gz"
printf '%s  %s\n' \
  87447304deb0f8617434d8dcd6c530e20e7425035024e8cefb7db9340402d032 \
  "$PHASE22_AUDIENCE_ARCHIVE" | sha256sum -c -
asset_extract="$(mktemp -d "$PHASE22_PRIVATE_ROOT/s3/archive.XXXXXX")"
tar -xzf "$PHASE22_AUDIENCE_ARCHIVE" -C "$asset_extract"
(cd "$asset_extract" && sha256sum -c SHA256SUMS)
export PHASE22_S2_RUN="$asset_extract/s2/run/e3f934af-6af9-42aa-ac78-b315133e1571"
export PHASE22_REVIEWED_CASE="$asset_extract/prepared/denial.frozen.json"
export PHASE22_SOURCE_BUNDLE="$asset_extract/prepared/denial.json"
export PHASE18_EVALUATOR="$asset_extract/s2/evaluator.json"
```

## Install and verify

A cold cache may fetch the locked dependencies; a warmed cache can use the
offline form:

```sh
uv sync --project agent --locked
uv sync --offline --project agent --locked
uv run --offline --project agent --locked python -m py_compile \
  agent/prompt.py agent/evaluate_case.py agent/compare_executions.py
python -m json.tool talk/stage.json >/dev/null
```

For an online run, use the approved ADOT environment block in
[the S2 capture instructions](agent/README.md#run-and-score-the-captured-baseline-s2)
before invoking `opentelemetry-instrument`. It sets the trace destination and
identity checks required by the runner; no telemetry credentials belong in the
input index.

The repaired prompt is already present; do not apply the repair patch a second
time. To demonstrate the faulty starting option in this same editable folder,
first ensure it is clean, verify the reverse patch, then apply it. If the folder
is dirty, stop and preserve the edit; never overwrite it:

```sh
git diff --quiet
git apply --reverse --check agent/prompts/s3-repair.patch
git apply --reverse agent/prompts/s3-repair.patch
python -m py_compile agent/prompt.py
```

Restore the repaired prompt only through an explicit editor action or by
discarding the private demonstration edit after recording it; do not use this
option while an S3 run is in flight. The run snapshots its launch-time source.

## Run a matching faulty baseline

The normal `--candidate faulty` flag labels the current source; it does not
change a repaired prompt into the faulty prompt. Produce the actual matching
baseline with the helper, which replaces only `prompt.py` in an immutable
temporary source snapshot and uses the same case, bundle, lock, model and
capture runner:

```sh
uv run --project agent --locked python talk/run-faulty-baseline.py \
  --case "$PHASE22_REVIEWED_CASE" --bundle "$PHASE22_SOURCE_BUNDLE" \
  --output-root "$PHASE22_S3_BASELINE_ROOT"
```

Record the helper's printed directory as `PHASE22_BASELINE_RUN`. It is the
baseline for the S3 comparison; the carried S2 run remains provenance only.

## Run and compare

Run the repaired source against the selected case and bundle, writing to a
different unique private output root:

```sh
uv run --project agent --locked opentelemetry-instrument \
  python agent/evaluate_case.py run --candidate repaired \
  --case "$PHASE22_REVIEWED_CASE" --bundle "$PHASE22_SOURCE_BUNDLE" \
  --output-root "$PHASE22_S3_RUN_ROOT"
```

Inspect and score the repaired result, then compare it only with the matching
baseline produced above:

```sh
uv run --offline --project agent --locked python agent/evaluate_case.py show \
  --run "$PHASE22_S3_RUN"
uv run --project agent --locked python agent/evaluate_case.py score \
  --run "$PHASE22_S3_RUN" --evaluator "$PHASE18_EVALUATOR" \
  --rubric single --wait-seconds 300
uv run --offline --project agent --locked python agent/evaluate_case.py compare \
  --baseline "$PHASE22_BASELINE_RUN" --candidate "$PHASE22_S3_RUN"
```

The semantic verdict is advisory feedback. A changed lock, replay clock, case,
model, evaluator, or policy creates a distinct candidate and cannot be bridged
by relaxing comparator checks. This local result is not exact-package S5
qualification.
