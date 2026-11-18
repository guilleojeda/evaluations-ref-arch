# S2 — Evaluate the faulty candidate

This workspace is the Phase 22 S2 checkpoint. It keeps the faulty candidate
unchanged and adds deterministic checks plus the pinned native AgentCore
Sonnet 4.6 advisory score. The default candidate remains `faulty`.

The prepared saved execution is
`e3f934af-6af9-42aa-ac78-b315133e1571`; its approved score configuration has
SHA-256 `35bc9bb6f79d8f15b870e8629f686cb388e1400675d0a2416bec3212ac44912c`.
The score attempt is `ce3e3a4a-ac3d-42a5-bcad-e7125a21127d`.

Set `PHASE22_PRIVATE_ROOT` outside this checkout and export
`PHASE22_INPUT_INDEX` to the private session index. Set
`PHASE22_AUDIENCE_ARCHIVE` to the verified portable
`phase22-session-a-audience-full.tar.gz`. The archive root contains the
matching S2 run, case, bundle, evaluator, capture receipt, and `SHA256SUMS`;
no internal session path is assumed.

```sh
uv sync --project agent --locked
uv sync --offline --project agent --locked
mkdir -p "$PHASE22_PRIVATE_ROOT/s2"
asset_extract="$(mktemp -d "$PHASE22_PRIVATE_ROOT/s2/archive.XXXXXX")"
tar -xzf "$PHASE22_AUDIENCE_ARCHIVE" -C "$asset_extract"
(cd "$asset_extract" && sha256sum -c SHA256SUMS)
export PHASE22_S2_RUN="$asset_extract/s2/run/e3f934af-6af9-42aa-ac78-b315133e1571"
export PHASE22_S2_CAPTURE_RECEIPT="$asset_extract/s2/capture-receipt.json"
export PHASE22_REVIEWED_CASE="$asset_extract/prepared/denial.frozen.json"
export PHASE22_SOURCE_BUNDLE="$asset_extract/prepared/denial.json"
export PHASE18_EVALUATOR="$asset_extract/s2/evaluator.json"
printf '%s  %s\n' \
  8880601278a059cbb7c792949e74785f6b8c1489dede8fa25f7b38299b8633a8 \
  "$PHASE22_SOURCE_BUNDLE" | sha256sum -c -
uv run --offline --project agent --locked python -m py_compile \
  agent/evaluate_case.py agent/deterministic_checks.py agent/agentcore_evaluation.py
python -m json.tool talk/stage.json >/dev/null
```

The capture receipt is provenance only. The JSON `--record` interface is not
used for this captured execution; `show` reopens the saved run directly.

## Inspect the saved run

Open the saved S2 run and inspect its report, source, trace, and deterministic
findings. Ordinary reopen must not rerun it. Use the same frozen case, bundle,
cutoff, model, runtime/tool source, evaluator, and policy identities:

```sh
uv run --offline --project agent --locked python agent/evaluate_case.py show \
  --run "$PHASE22_S2_RUN"
```

`show` calls the supported captured `load_execution` path. It authenticates
the saved case, bundle, native spans, report, ledger and source digests, then
recomputes the deterministic findings offline. The denied-read case must expose
the wrong memory recommendation: the Inventory target passes, while the action,
tuple/value, and cutoff findings fail. A missing or mismatched
case/bundle/report/trace remains incomplete; do not substitute a live query or
another saved run.

## Optional explicit score

Only after the saved identity checks pass, score the exact run with the pinned
Sonnet 4.6 evaluator. This is an explicit AWS operation and produces an
advisory verdict; it does not rerun the agent or authorize a release:

```sh
uv run --project agent --locked python agent/evaluate_case.py score \
  --run "$PHASE22_S2_RUN" --evaluator "$PHASE18_EVALUATOR" \
  --rubric single --wait-seconds 300
```
