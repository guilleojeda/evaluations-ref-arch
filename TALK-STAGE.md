# S4 — Run the native Strands experiment

This workspace is the Phase 22 S4 checkpoint. Its default candidate is the
exact repaired prompt used by the qualified Phase 20 publication. S4 adds the
native Strands experiment around the shared candidate runner and reviewed
suite. It is independent of S3 unless the presenter explicitly selects
`--source-run`.
`agent/prompt.py` has file SHA-256
`88b8b94f2da13263407aadc1301bc5b4c2345fcec3ac2bd148fead9835807bdd` and
semantic prompt SHA-256
`0f8d10ce6f46302a00dbe60cb29ebfeb4212627000c78b3529e6e0c7696ff425`.

Set `PHASE22_PRIVATE_ROOT` to the private handoff directory and export
`PHASE22_INPUT_INDEX` to its input index. The index is authoritative and must
resolve `PHASE18_SUITE`, `PHASE18_EVALUATOR`, `PHASE18_EXPERIMENTS`, and
`PHASE18_BASELINE_EXPERIMENTS` to private paths outside the checkout. A
continued run may additionally use `PHASE22_S3_RUN`; all paths remain private.

The carried reviewed denial pair has case identity
`cb1480066a46f258ee8d9e27355d50b9bd05f171ee9ef84a169989f72af5e18d` and bundle
SHA-256 `8880601278a059cbb7c792949e74785f6b8c1489dede8fa25f7b38299b8633a8`.
The private index chooses physical locations; no session directory is assumed
and files are never copied into this checkout.

For the portable session-a archive, resolve the complete native roster and
evaluator directly as follows. The repaired suite contains the three reviewed
case IDs; the faulty suite in the same archive is the matching recorded
baseline source if a saved fallback is needed:

```sh
export PHASE22_AUDIENCE_ARCHIVE="/private/path/phase22-session-a-audience-full.tar.gz"
printf '%s  %s\n' \
  87447304deb0f8617434d8dcd6c530e20e7425035024e8cefb7db9340402d032 \
  "$PHASE22_AUDIENCE_ARCHIVE" | sha256sum -c -
asset_extract="$(mktemp -d "$PHASE22_PRIVATE_ROOT/s4/archive.XXXXXX")"
tar -xzf "$PHASE22_AUDIENCE_ARCHIVE" -C "$asset_extract"
(cd "$asset_extract" && sha256sum -c SHA256SUMS)
export PHASE18_SUITE="$asset_extract/s4/full-suite/repaired/ec704bf1-a3c6-4b04-8ad2-0b32ebefc20e/suite.json"
export PHASE18_EVALUATOR="$asset_extract/s4/full-suite/repaired/ec704bf1-a3c6-4b04-8ad2-0b32ebefc20e/evaluator.json"
export PHASE18_EXPERIMENTS="$PHASE22_PRIVATE_ROOT/s4/experiments"
export PHASE18_BASELINE_EXPERIMENTS="$PHASE22_PRIVATE_ROOT/s4/baselines"
export PHASE22_S3_RUN="$asset_extract/s3/run/295cd070-07e8-4f69-b8ce-c588a74fab42"
```

```sh
uv sync --project agent --locked
uv sync --offline --project agent --locked
uv run --offline --project agent --locked python -m py_compile \
  agent/prompt.py agent/development_experiment.py agent/strands_evaluators.py
python -m json.tool talk/stage.json >/dev/null
```

For an online run, use the approved ADOT environment block in
[the S2 capture instructions](agent/README.md#run-and-score-the-captured-baseline-s2)
before invoking `opentelemetry-instrument`. It sets the trace destination and
identity checks required by the runner; no telemetry credentials belong in the
input index.

The repaired prompt is already present; do not apply the repair patch a second
time. To obtain a matching faulty baseline for this exact suite, use the
immutable helper below. It copies the current tooling to a temporary source
directory, replaces only `prompt.py` with the verified Phase 19 faulty bytes,
and invokes the same native `run_experiment` entry point. It does not create
another editable workspace or modify this folder, its inputs, or its edits:

```sh
uv run --project agent --locked python talk/run-faulty-experiment.py \
  --suite "$PHASE18_SUITE" --evaluator "$PHASE18_EVALUATOR" \
  --output-root "$PHASE18_BASELINE_EXPERIMENTS"
```

Use the printed experiment directory as `PHASE22_BASELINE_EXPERIMENT`. Its
candidate is `faulty`, and its suite/evaluator/tooling identities must match the
repaired run before comparison. The repaired source and experiment code are
snapshotted at launch.

## Run the native experiment

The suite must contain the three reviewed case IDs, their source bundles and
cutoffs, and the same pinned Sonnet 4.6 evaluator used by S2/S3. Preserve the
full suite file and its digest; do not silently replace it with a focused case.
Run the full suite from a clean stage workspace:

```sh
uv run --project agent --locked opentelemetry-instrument \
  python agent/development_experiment.py run \
  --suite "$PHASE18_SUITE" --candidate repaired \
  --evaluator "$PHASE18_EVALUATOR" --output-root "$PHASE18_EXPERIMENTS"
```

For a carried one-case rehearsal, select one case explicitly and use a separate
private output root. This is supplementary feedback, not a full-suite result;
the matching faulty helper accepts the same repeated `--case` option:

```sh
export PHASE18_FOCUSED_EXPERIMENTS="$PHASE22_PRIVATE_ROOT/s4-focused"
export PHASE22_CASE_ID="<one case ID from PHASE18_SUITE>"
uv run --project agent --locked python talk/run-faulty-experiment.py \
  --suite "$PHASE18_SUITE" --case "$PHASE22_CASE_ID" \
  --evaluator "$PHASE18_EVALUATOR" \
  --output-root "$PHASE18_FOCUSED_EXPERIMENTS"
uv run --project agent --locked opentelemetry-instrument \
  python agent/development_experiment.py run \
  --suite "$PHASE18_SUITE" --case "$PHASE22_CASE_ID" --candidate repaired \
  --evaluator "$PHASE18_EVALUATOR" --output-root "$PHASE18_FOCUSED_EXPERIMENTS"
```

Inspect and compare the saved native report offline:

```sh
uv run --offline --project agent --locked \
  python agent/development_experiment.py show --experiment "$PHASE22_EXPERIMENT"
uv run --offline --project agent --locked \
  python agent/development_experiment.py compare \
  --baseline "$PHASE22_BASELINE_EXPERIMENT" --candidate "$PHASE22_EXPERIMENT"
```

For the optional continuous path, pass the exact saved S3 run to a separate
output root:

```sh
uv run --project agent --locked opentelemetry-instrument \
  python agent/development_experiment.py run \
  --suite "$PHASE18_SUITE" --candidate repaired \
  --source-run "$PHASE22_S3_RUN" --evaluator "$PHASE18_EVALUATOR" \
  --output-root "$PHASE18_EXPERIMENTS"
```

A focused case is supplementary and cannot stand in for the full suite. The
semantic verdict is advisory feedback. A changed lock, replay clock, case,
model, evaluator, or policy creates a distinct candidate and cannot be bridged
by relaxing comparator checks. S4 does not qualify or publish the Runtime ZIP.

