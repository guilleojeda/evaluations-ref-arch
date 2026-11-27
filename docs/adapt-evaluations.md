# Test a prompt change before deployment

Start with one decision you want your agent to get right. In this example, the agent identified an Inventory access denial but recommended more memory. The developer wanted it to recommend restoring access to the healthy Inventory version at the same memory.

## Score the answer you already have

In AgentCore, open the investigation trace and create a Fixed scenario. Write the expected response in `turns[0].expected_response`. Also write the exact expected action, target, value and unit in `metadata.expected_recommendation`. Read the healthy version from this incident's configuration. Publish the dataset version, then download your scenario into `denial-case.json`.

Run `score_denial.py` in the same folder. It fetches the trace identified by the scenario, saves it as `original-trace.json`, and submits the recorded interaction to AgentCore's `Builtin.Correctness`. Open the scored recommendation and compare it with the expected one. [Download and score your case](../examples/live-denial/README.md#prepare-the-two-inputs)

## Generate a new answer from the same inputs

Open `examples/live-denial/strands_denial.py`. The published scenario maps directly to a native Strands Evaluations case.

```python
case = Case(
    name=scenario["scenario_id"],
    input=scenario["turns"][0]["input"],
    expected_output=scenario["metadata"]["expected_recommendation"],
)
```

The alarm text is the case input. The agent had also seen evidence when it made its original decision. To give both prompts that evidence, the example selects the last `chat` span for the scenario's trace, checks its session and confirms that this call produced the original structured report. It reads the preceding assistant messages and returned observations in order. The saved answer is the separate `gen_ai.choice` event. The code leaves out that event, the original system prompt and the provider-signed reasoning blocks.

Read `generate_recommendation` in the same file. It calls `investigation.create_agent`, the constructor used by the deployed application. That constructor reads the current `SYSTEM_PROMPT` and sets the model and report schema. The test gives the agent the alarm and recorded conversation through `agent(messages, ...)`. Because the investigation has reached its report-writing step, the test gives it zero new data sources. It returns the newly generated `recommendation` as the experiment output. The expected recommendation goes only to the evaluator. [Native Strands example](../examples/live-denial/strands_denial.py) and [application constructor](../agent/investigation.py)

From a repository checkout with your authorized Bedrock credentials, run the file from the directory containing both inputs.

```bash
cd examples/live-denial
PYTHONPATH="$(cd ../../agent && pwd)" uv run --project ../../agent --locked python -u strands_denial.py
```

Read the expected action and the fresh actual action. Edit the recommendation rule in `agent/prompt.py`, save, and run the identical command again. Strands' native `Equals()` compares the resulting action dictionary, including the target version. A completed wrong recommendation returns exit 1; a correct action returns exit 0; a missing input or missing report is incomplete and returns exit 2. Fresh model runs are observations, not guaranteed outcomes: the recorded opening trace and earlier local/CI runs showed 512 MB/FAIL, while a later fresh named Codespace run with the unchanged prompt returned the reviewed version/PASS. The three-sentence repair passed all observed contexts, but one pair that passes on both prompts does not establish improvement.

In the talk the presenter makes that edit. The later hosted demonstration triggers a new alarm, so you can see the deployed agent conduct a whole investigation after testing the prompt change in the IDE.

## Run the same test on the next push

The CI job needs the same scenario and trace bytes as the IDE. In this project those two files stay private. Git stores the archive location and its digests in `agent/audience-input.json`. The file hashes let you verify that the job read the incident you selected.

From the repository root, prepare the two-file archive. Set the two input paths to the files you scored. The example below uses the ordinary repository location.

```bash
case_dir=examples/live-denial
gate_dir="$(mktemp -d)"
bucket="$(jq -er .bucket agent/audience-input.json)"
python3 scripts/prepare_audience_gate.py prepare \
  --scenario "$case_dir/denial-case.json" --trace "$case_dir/original-trace.json" \
  --bucket "$bucket" --output-dir "$gate_dir"
tar -tzf "$gate_dir/staging.tar.gz"
jq '{scenarioSha256, traceSha256}' "$gate_dir/audience-input.json"
python3 scripts/prepare_audience_gate.py verify \
  --archive "$gate_dir/staging.tar.gz" --pointer "$gate_dir/audience-input.json"
```

The archive contains the two original files, a manifest and their checksums. For this project's authorized presenter, the following command prints the exact S3 upload. Inspect and execute the printed command, then copy the pointer into the checkout that will be pushed.

```bash
python3 scripts/prepare_audience_gate.py publish-command \
  --archive "$gate_dir/staging.tar.gz" --pointer "$gate_dir/audience-input.json" \
  --profile reinvent-2026-talk --region us-east-1 | jq -r .publishCommand
```

```bash
cp "$gate_dir/audience-input.json" agent/audience-input.json
git diff -- agent/prompt.py agent/audience-input.json
```

In the demo, the participant pushes the prompt regression and the selected pointer to `demo-deploy`. Open the **Gate audience case (fast exact action)** job for that commit. It downloads and verifies the private archive, runs the same Python example on the checked-out agent, and shows the fresh expected/actual row. A wrong action or an incomplete run blocks publication; a passing result allows the checked Runtime ZIP to proceed through its standing four-case qualification and protected review. Read the participant run as it actually resolves. If it passes or remains pending, show the earlier verified CI rejection as earlier evidence, not as the current run. [Deployment workflow](../.github/workflows/deploy.yml)

## Try an example without AWS access

The repository also includes a synthetic Inventory case you can run offline. From its root:

```bash
uv run --project agent --locked python examples/inventory-denial/native.py
uv run --project agent --locked python examples/inventory-denial/native.py \
  --report examples/inventory-denial/report-memory-regression.json
```

The first report passes the six report checks. In the second, the target is still Inventory, but the action and target value fail. These commands let you inspect how the evaluator works on saved reports. The live example above invokes the agent. [Offline example](../examples/inventory-denial/native.py)
