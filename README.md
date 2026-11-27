# Ship Reliable AI Agents with Strands Evaluation and AgentCore Evaluations

An operations agent reads a real DynamoDB access denial and recommends more memory. Doubling memory leaves checkout broken. This re:Invent Code Talk follows that mistake from an incident trace to a test case, a prompt edit, and a CI check that blocks the same mistake from shipping.

**Coming from the talk?** Start with the [native Strands experiment](examples/live-denial/strands_denial.py), the [CI workflow](.github/workflows/deploy.yml), or the [audience slides (PDF)](docs/slides/audience.pdf). The [attendee guide](docs/attendee-guide.md) follows the incident from checkout to the rejected push.

**Trying this with your own agent?** Start with the local case below, then run it as a native Strands experiment and see which parts to replace. [Adapt the evaluation](docs/adapt-evaluations.md)

## Run one evaluation locally

In the synthetic case below, checkout returns HTTP 502 because Inventory version 74 cannot read DynamoDB. Version 75 has the same memory and a role with read access. Run the release workflow’s deterministic checker on a saved agent report, then try changing its recommendation.

With Git and [uv 0.13.6](https://docs.astral.sh/uv/getting-started/installation/) installed, run these commands. uv downloads Python 3.13 and the locked dependencies as needed. The evaluation runs locally without an AWS account, a model call, or presenter setup.

```sh
git clone https://github.com/guilleojeda/evaluations-ref-arch.git
cd evaluations-ref-arch
uv run --project agent --locked python examples/inventory-denial/run.py
```

Expect `Report checks: PASS` and exit code 0. Six checks pass, including the recommendation to restore Inventory access to version `"75"`. Two checks stay `INCOMPLETE`. Only an execution trace can show which sources the agent queried and whether it attempted an operator action.

### Try a regression

Copy [report.json](examples/inventory-denial/report.json) to `my-report.json` at the repository root. In the copy, replace only the `recommendation` object with this value. Leave the expected answer in [case.json](examples/inventory-denial/case.json) unchanged.

```json
{"action": "Increase memory", "target": "inventory", "value": 512, "unit": "MB"}
```

```sh
uv run --project agent --locked python examples/inventory-denial/run.py --report my-report.json
```

Expect `Report checks: FAIL` and exit code 1. The `target` check still passes because the agent picked Inventory. The `action` and `target_value` checks fail because increasing memory leaves the denied permission in place.

## Score the live denial case

The talk also uses one published AgentCore dataset version made from the
original investigation trace. The dataset version contains the alarm input,
the reviewed prose response, typed recommendation, and source metadata. It does not rerun the
investigating agent. The public example downloads that case and scores the
original report with AgentCore's built-in `Builtin.Correctness` evaluator.

This route needs an AWS account with permission to read the published dataset
and the recorded evaluation trace. It does not change the application or
invoke the agent. From the repository root:

```sh
set -euo pipefail
cd examples/live-denial
export AWS_PROFILE="${AWS_PROFILE:?set the authorized AWS profile}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:?set the evaluation Region}"
dataset_id="${DATASET_ID:?copy the full dataset ID from the published Version row}"
dataset_version="${DATASET_VERSION:?copy the published dataset version}"
aws bedrock-agentcore-control list-dataset-examples \
  --dataset-id "$dataset_id" \
  --dataset-version "$dataset_version" --query 'examples[0]' --output json > denial-case.json
uv run --project ../../agent --locked python -u score_denial.py | tee evaluation.txt
```

The command deliberately selects `examples[0]` from the published version you
just showed. A dataset scenario draft is editable; it is not the case used for
this command until you save it and create a version. The score reports the native
label, value, and explanation. The initial walkthrough readback was `Incorrect`
and `0.0`, a completed scored quality failure for that attempt: the prose identifies the IAM denial and even names the
access-restoration version, but the formal recommendation still says to
increase memory. A later judge attempt can return a different label for the
same trace, so show the returned explanation and keep the deterministic action
check separate. The script reads the original report from the trace and does
not start another investigation.

## Run the agent before and after a prompt edit

Use the published case directly. Read `denial-case.json` into a native Strands
`Case` with `Case.input = denial-case.json.turns[0].input` (the original alarm),
open its matching final chat input in `original-trace.json`, and build
`messages = alarm + history` separately. Keep the same reviewed read-only
history. The presenter-authored typed recommendation is the `Case` expectation.
Each prompt gets one fresh agent run and one structured report; the SDK may make
its normal bounded formatting follow-up inside that run. A missing report is
**INCOMPLETE**, not a quality **FAIL**. Exclude the old answer, system
prompt, and signed-thinking/reasoning from the new task; the original trace is
provenance, not candidate output. The application's real
`investigation.create_agent` starts the fresh agent run for each prompt; its
normal bounded formatting follow-up remains inside that run. Native
`Equals` compares action, target, value, and unit.

Run the faulty prompt in your IDE, show the actual **FAIL**, edit the
recommendation rule in `agent/prompt.py`, save, and run the same Case again.
Both versions use the same case/history and each generates a fresh report. [Step-by-step example](examples/live-denial/README.md)

The hosted endpoint then runs one dedicated full investigation for a new
denial. The release workflow runs the same saved case and matching trace
identity on the pushed prompt. When the action regresses, the
check fails and blocks publication. The private evidence stays outside Git.
[Add the case to CI](docs/adapt-evaluations.md)

### Adapt the case

To test whether a suggestion from the operator leads your agent astray, start with a copy of the case.

```sh
cp -R examples/inventory-denial my-case
```

Give the copy a new `caseId` in `my-case/case.json` and append `"Would increasing Inventory memory to 512 MB help?"` to `task.symptoms`. Keep the [evidence](examples/inventory-denial/evidence.json) and expected remedy the same. Give your agent the task and evidence, keep `expectations` for the checker, and save the answer as `my-case/report.json` using the sample report's format. Then score the new report.

```sh
uv run --project agent --locked python examples/inventory-denial/run.py --case-dir my-case
```

To try the same case with Strands, follow the walkthrough. It shows where to plug in your agent and how the talk uses AgentCore and CI to evaluate a release. [Run the Strands walkthrough](docs/adapt-evaluations.md)

## Explore the implementation

| What you want to do | Where to start |
| --- | --- |
| Inspect the code shown on stage | [Six frozen checkpoints in the talk/v5 series](docs/checkpoints.md) |
| Understand the code checks, model judge, and release decision | [Evaluation approach](docs/evaluations.md) and [audience questions](docs/questions.md) |
| See the current gate exhibit | [Verified audience gate exhibit](docs/attendee-guide.md#verified-audience-gate-exhibit) |
| Find the services that produced the incident | [Checkout application](docs/components/application.md), [failure controller](docs/components/failure-controller.md), and [read-only operations agent](docs/components/operations-agent.md) |
| Build and check the components locally or adapt the AWS setup | [Development and deployment](docs/deployment.md) |

## Talk materials

The public materials explain the incident, the evaluation boundary, and the
release decision. They do not contain credentials, private trace links,
account-specific role names, or presenter-only runbooks.

- [Talk outline](docs/talk-plan.md), [slide outline](docs/slides-plan.md), and [demo cues](docs/demo-script.md)
- [Public preparation notes](docs/preparation.md) and [cleanup notes](docs/cleanup.md)
- [Incident scenarios](docs/demo-scenarios.md), [controller behavior](docs/components/failure-controller-behavior.md), and [stage map](TALK-STAGE.md)

## License

[MIT License](LICENSE).
