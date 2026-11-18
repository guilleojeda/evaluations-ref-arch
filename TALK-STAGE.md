# S0 — Investigate the faulty candidate

This workspace is the Phase 22 S0 checkpoint. Its default candidate is the
historical faulty prompt, not the repaired prompt and not a live endpoint
selection. The semantic prompt identity is `faulty-phase19`; the descriptor
records source revision `bd6f77d`, runtime artifact
`e5ac2ee20d8f3947eb95ceb74094e882a3d8a4a010f2a8e7bf96700dd5906b33`, and lock
`887c9bcf91ec028fe3b0939aac00a7d4c3dfbc68b2287e4469a15f3798651831`.

Set `PHASE22_PRIVATE_ROOT` outside this checkout and export
`PHASE22_INPUT_INDEX` to the private session index. Opening this workspace is
metadata-only: it must not start a model, send application traffic, switch a
live target, publish, or reset the controller.

```sh
uv sync --project agent --locked
uv sync --offline --project agent --locked
uv run --offline --project agent --locked python -m py_compile \
  agent/prompt.py agent/main.py agent/investigation.py
uv run --offline --project agent --locked python agent/package_runtime.py
python -m json.tool talk/stage.json >/dev/null
```

For the live demonstration, establish native alarm **OK** and the healthy
business baseline, select and verify `faulty`, trigger one genuine denied
Inventory request, and match its new alarm to the actual Runtime run, report,
trace, and source capture. Show the faulty memory recommendation, apply the
prepared higher-memory choice through the normal operator path, prove a fresh
request still fails, then restore access and verify a fresh success and native
**OK**. If the live path is unavailable, reopen only a matching saved
investigation and label it **recorded**; it is not fresh execution.

S0 has no reviewed case, scorer, evaluator, or release gate.
