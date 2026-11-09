# AI agent evaluation reference architecture

This repository is the main home for the re:Invent Code Talk **Ship Reliable AI Agents with Strands Evaluation and AgentCore Evaluations** and its public reference implementation. The talk follows an operations agent from a convincing demonstration to a repeatable evaluation workflow that supports release decisions.

The example has three components: a small application to operate, a controller that causes known incidents, and an agent that investigates those incidents. Application failures produce real operational evidence. Evaluations assess whether the agent uses that evidence correctly and proposes an appropriate response.

The repository contains the checkout application, cloud-hosted presenter controller, and independent app, controller, and agent deployment stacks. Phase 4 delivers the first live S0 investigation from a genuine CloudWatch alarm through AgentCore Runtime, with durable run discovery and trace/source evidence. Reviewed evaluation cases, scoring, release gates, and measured talk results remain in preparation.

## Components

| Component | Responsibility | Description |
| --- | --- | --- |
| Application | Save checkout orders, update inventory, and produce operational evidence | [Application design](docs/components/application.md) |
| Failure controller | Provide separate controls for scoped setting changes, observed status, bounded traffic, and recovery/reset | [Failure controller](docs/components/failure-controller.md) |
| Operations agent | Investigate an alert and recommend one supported action or Other, with evidence and a diagnosis | [Operations agent](docs/components/operations-agent.md) |

The evaluation workflow spans these components. An evaluation can pass while the application is broken if the agent handles the incident correctly. An application incident is a test input; an agent regression is a defect in the behavior under test.

## Talk and evaluation documents

- [Talk plan](docs/talk-plan.md): audience, narrative, live coding, participation, timing, and source material.
- [Slides plan](docs/slides-plan.md): the proposed audience sequence, hidden references for live/code segments, each slide's purpose and transition, appendix, and recorded backups.
- [Demo progression](docs/demo-progression.md): runnable talk checkpoints, from no evaluations to the complete scoped evaluation workflow.
- [Demo script](docs/demo-script.md): presenter preflight, operating steps for the two selected incidents and recovered/stale-alert condition, the timed talk skeleton, coding fill-in items, and fallback/reset instructions.
- [Scenario contracts](docs/demo-scenarios.md): activation, application effects, agent-visible evidence, expected investigation, and recovery for both selected incidents and the recovered/stale-alert condition.
- [Controller specification](docs/components/failure-controller-behavior.md): supported controls, action results, traffic bounds, observation sources, private records, and interruption handling.
- [Evaluation approach](docs/evaluations.md): cases, checks, Strands and AgentCore roles, release decisions, measurements, and important limits.
- [Deployment design](docs/deployment.md): the three independent development stacks and their GitHub Actions, Python package, and TypeScript CDK workflow.

The [agent component document](docs/components/operations-agent.md) owns its software contract and capabilities at S0–S5. The talk documents own the presentation sequence, live edits, and presenter actions. These stages are runnable software states for the talk, not development delivery phases. S0 has no evaluations; S1 reviews cases; S2 adds deterministic and semantic evaluation with AgentCore results around the initially defective candidate; S3 repairs only the prompt and compares a fresh candidate; S4 adds the complete local Strands experiment; and S5 adds the CI release gate. The defective candidate remains available for comparison: adding evaluations does not itself improve the agent.

The agent's supported recommendations are **Increase reserved concurrency**, **Increase memory**, **Restore inventory access**, and **Other**, with a grounded target and value or policy detail. The presenter chooses and executes controller actions; the agent cannot apply one. Phase 4's faulty candidate deliberately favors an Inventory memory increase for dependency failures, and its actual alarm-triggered report must be retained without rewriting it. Later demo stages prepare a higher-memory Inventory version to show that an allocation change does not remove the denied role's permanent `dynamodb:GetItem` Deny, then repair the prompt to recommend restoring access for that incident. The [demo script](docs/demo-script.md) records the audience sequence.

## Reference implementation scope

The intended public implementation includes the sample application, Python Strands operations agent on AgentCore Runtime, controlled incidents, evaluation cases and evaluators, a CI/CD release gate, reproducible measurement tooling, and instructions for running and resetting the demonstration. Slides and the demonstration script belong here alongside the implementation.

The example uses synthetic incidents and actual executions. Captured evidence and results must identify that provenance; the reference implementation does not establish coverage of all production incidents or guarantee agent safety.

The application is a checkout example that saves an order and updates inventory atomically. A read-only inventory lookup provides the controlled dependency. Presenter-controlled faults produce real incidents for alert-triggered triage, with proposed remediation when warranted. The complete API, data, access, evidence, and reset design is in [the application document](docs/components/application.md).

## Application technology and access

The application uses TypeScript and React/Vite, hosted through private S3/CloudFront, with API Gateway HTTP API, two Node.js 24 Lambda functions, and DynamoDB Orders/Inventory tables. CDK v2 in TypeScript defines deployment in `us-east-1`.

Operating access is presenter-only through a generated shared password validated by the checkout handler on every business route and every published variant. The static frontend contains no credential. The presenter web controller uses the same protected API for traffic; fault activation and reset require separate privileged AWS permissions. The operations agent remains read-only.

The operations agent and evaluation code use **Python** and Strands. The live agent runs on AgentCore Runtime in `us-east-1`, using the pinned `us.anthropic.claude-sonnet-4-6` profile, one fresh session per alarm transition, and four bounded read-only tools. It returns a structured report and has no follow-up conversation or AgentCore Memory. AgentCore tracing records actual model/tool/report activity, while a separate private capture records sanitized source evidence. S0 has no reviewed evaluation cases, scores, or release gate. S1 introduces reviewed cases, S2 adds deterministic and semantic evaluation with AgentCore results, S3 repairs and compares a fresh prompt candidate, S4 connects the local Strands experiment, and S5 runs that experiment and policy in CI before deployment. The detailed contract is in the [operations agent document](docs/components/operations-agent.md).

## Operations and deployment design

The failure controller is a cloud-hosted presenter web app with a React interface, authenticated TypeScript Lambda API, and durable controller state. It discovers agent runs directly from the separate agent run table, independent of current alarm state, and links to the actual CloudWatch trace. A genuine CloudWatch transition invokes a forward-only Lambda adapter; AgentCore Runtime conditionally creates the sole `running` record keyed by alarm ARN and the normalized originating transition time. The controller polls run discovery independently of the alarm observation and retains reports after the alarm returns to OK or the presenter reconnects from another browser. A run that misses its deadline remains overdue/incomplete; it is not converted into a report or reclaimed for another investigation. See the [controller specification](docs/components/failure-controller-behavior.md) and [agent contract](docs/components/operations-agent.md).

The [controller specification](docs/components/failure-controller-behavior.md) defines presenter actions, interruption handling, observation sources, and private records. The [application alarm](docs/components/application.md#application-alarm) uses native HTTP API stage `5xx`, `Sum >= 1` over 60 seconds, 1-of-1, and missing data `notBreaching`. The alarm is neutral: it signals a stage failure, while the agent determines the affected operation from evidence. The app, controller, and agent deploy as three independent stacks. GitHub Actions checks pull requests and deploys relevant `main` changes; the presenter sequences dependent releases outside a live run. See the [deployment design](docs/deployment.md). Capacity/load tuning and the faulty-candidate witness still require rehearsal. Strands supports repeatable regression experiments; AgentCore Evaluations assesses actual deployed-agent traces. The design does not require every check in both or claim automatic evaluator-format interchange; reviewed case meaning and criteria are retained across paths.

Schedule releases outside active demo runs. Deploy dependent stacks in order, verify each checked release and its outputs, and confirm the controller baseline before resuming traffic. Deployment does not run incident activation, probes, recovery, or reset. Routine releases preserve business data and durable run records. See the [deployment procedure](docs/deployment.md#deployment-and-controller-baseline).

Developer and CI regression experiments execute each candidate against versioned, queryable captured evidence at an explicit case reference time. All four investigation tools use that captured view, and candidates choose their own queries and order. At S4, the developer experiment and reviewed policy qualify the repaired artifact before deployment. At S5, CI runs that same experiment and policy and blocks failed or incomplete required results. See the [evaluation contract](docs/evaluations.md).

Dataset preparation starts from captured actual runs and reviewed expectations. S0 retains actual AgentCore traces and sanitized source observations without creating an evaluation case or verdict; review and case creation begin at S1. Preserve the source and time contract when extracting evidence for later cases.

## Event dates

The talk runs for 60 minutes and is scheduled for **December 1 and December 3, 2026**. Slides are due **November 6, 2026**. AWS has supplied slide templates; detailed Code Talk timing and Q&A guidance has not been supplied.

## License

See [LICENSE](LICENSE).
