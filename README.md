# Ship Reliable AI Agents with Strands Evaluation and AgentCore Evaluations

An operations agent reads a real DynamoDB access denial and recommends more memory. Doubling memory leaves checkout broken. This re:Invent Code Talk follows that mistake from an incident trace to a test case, a prompt edit, and a CI check that blocks the same mistake from shipping.

**Coming from the talk?** Follow the denial through all six stages and see the result of the participant's push. [Attendee guide](docs/attendee-guide.md) and [audience slides (PDF)](docs/slides/audience.pdf)

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
| See what a rejected release looks like | [Denial result and GitHub run](docs/attendee-guide.md#the-rejected-push) |
| Find the services that produced the incident | [Checkout application](docs/components/application.md), [failure controller](docs/components/failure-controller.md), and [read-only operations agent](docs/components/operations-agent.md) |
| Build and check the components locally or adapt the AWS setup | [Development and deployment](docs/deployment.md) |

## Presenter operations

The hosted storefront and controller require presenter access. Running the full cloud demonstration also requires the prepared case archive, an AWS evaluator and the release identities for the talk account. The public examples above work without those resources.

- [Talk outline](docs/talk-plan.md), [slide outline](docs/slides-plan.md), and [demo cues](docs/demo-script.md)
- [Session preparation](docs/preparation.md) and [post-talk cleanup](docs/cleanup.md)
- [Incident scenarios](docs/demo-scenarios.md), [controller behavior](docs/components/failure-controller-behavior.md), and [talk-account bootstrap](infrastructure/bootstrap/README.md)

## License

[MIT License](LICENSE).
