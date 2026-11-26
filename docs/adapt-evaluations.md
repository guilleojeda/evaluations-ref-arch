# Adapt the evaluation to your agent

Start with a behavior you care about and an example that distinguishes a correct response from a plausible mistake. In this case, Inventory needs read access. A report can name the right function and still recommend more memory.

## Run the native Strands example

From the repository root, score the saved report that recommends restoring access. Git and the pinned version of uv are the only prerequisites. The first run installs dependencies. Scoring happens locally.

```sh
uv run --project agent --locked python examples/inventory-denial/native.py
```

Expect six passing report checks and `Native result: PASS` (exit 0). Then score the synthetic memory-first response against the same case.

```sh
uv run --project agent --locked python examples/inventory-denial/native.py \
  --report examples/inventory-denial/report-memory-regression.json
```

The second command exits 1. Look for these three rows in the output. Both runs also show `source_scope` and `operator_boundary` as incomplete because a saved report has no record of tool calls.

| Report check | Restore access | Increase memory |
| --- | --- | --- |
| `target` | Pass | Pass |
| `action` | Pass | Fail |
| `target_value` | Pass | Fail |

## Where your agent fits

The example creates one native Strands `Case` with the public task as input. Its task function returns the selected saved report. `InventoryReportEvaluator` receives that output and uses the reviewed expectations to grade it. `Experiment.run_evaluations(task)` runs both pieces and returns the detailed findings. [Native example](../examples/inventory-denial/native.py) and [reviewed case](../examples/inventory-denial/case.json)

To run your agent on the same task, replace the saved-report task with your invocation. Supply the same [evidence](../examples/inventory-denial/evidence.json) through your read tools and return your agent's real report. Give only the evaluator the expected answer. If your agent accepts the case input and returns a report dictionary, the task can be this short.

```python
def task(case):
    return {"output": investigate(case.input)}
```

For a different task, decide what the agent gets to see and how you will judge the result.

| Decision | Inventory example | What to change |
| --- | --- | --- |
| What does the agent know? | Alarm, symptoms, allowed resources and evidence available by the cutoff | Supply a task and source snapshot from your own workflow. [Case inputs](../agent/reviewed_cases.py) |
| What can the agent do? | Read operational data and recommend a remedy | Connect its real tools and define the output or action arguments you need to observe. [Report and tool contract](../agent/investigation.py) |
| What can code decide? | Whether the proposed action, target and value form an allowed remedy | Write checks for behavior with an unambiguous pass condition. [Deterministic checks](../agent/deterministic_checks.py) |
| What requires judgment? | Whether the diagnosis and factual claims are supported | Choose a rubric, label examples with human reviewers, and check the judge on held-back cases. [AgentCore evaluator](../agent/agentcore_evaluation.py) |
| What should block shipping? | A required failure rejects the package. Missing evidence blocks publication. Completed advisory results go to a human reviewer. | Choose blocking checks and review requirements that reflect the consequences of errors in your use case. [Release policy](../agent/release_gate.py) |

## From a local task to a cloud-scored execution

The developer workflow runs the candidate on captured evidence, records what tools it actually called, and exports telemetry for that execution. Its Strands evaluator calls AgentCore with the matching session and reviewed source references. The judge returns one advisory verdict covering diagnosis and grounding. This requires Bedrock model access, telemetry export, permission to read the session, and a configured evaluator. [Full Strands experiment](../agent/development_experiment.py), [AgentCore adapter](../agent/strands_evaluators.py), and [AWS evaluation prerequisites](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/ondemand-evaluations-prereqs.html)

In the IDE you can rerun the experiment as you edit the prompt. In CI the experiment runs against the ZIP you intend to publish. A reviewer approves that same ZIP before deployment. For an example of a change that stopped at the gate, see the [rejected denial case](attendee-guide.md#the-rejected-push).
