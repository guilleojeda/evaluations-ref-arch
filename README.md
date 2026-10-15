# AI agent evaluation reference architecture

This repository is the main home for the re:Invent Code Talk **Ship Reliable AI Agents with Strands Evaluation and AgentCore Evaluations** and its public reference implementation. The talk follows an operations agent from a convincing demonstration to a repeatable evaluation workflow that supports release decisions.

The example has three components: a small application to operate, a controller that causes known incidents, and an agent that investigates those incidents. Application failures produce real operational evidence. Evaluations assess whether the agent uses that evidence correctly and proposes an appropriate response.

The repository currently contains planning and intended behavior documentation. The application, controller, agent, evaluation code, slides, and measured results have not been implemented yet.

## Components

| Component | Responsibility | Description |
| --- | --- | --- |
| Application | Save checkout orders, update inventory, and produce operational evidence | [Application design](docs/components/application.md) |
| Failure controller | Provide separate controls for scoped setting changes, observed status, bounded traffic, and recovery/reset | [Failure controller](docs/components/failure-controller.md) |
| Operations agent | Investigate an alert and recommend one supported action or Other, with evidence and a diagnosis | [Operations agent](docs/components/operations-agent.md) |

The evaluation workflow spans these components. An evaluation can pass while the application is broken if the agent handles the incident correctly. An application incident is a test input; an agent regression is a defect in the behavior under test.

## Talk and evaluation documents

- [Talk plan](docs/talk-plan.md): audience, narrative, live coding, slide storyboard, timing, and source material.
- [Demo progression](docs/demo-progression.md): runnable talk checkpoints, from no evaluations to the complete scoped evaluation workflow.
- [Demo script](docs/demo-script.md): presenter preflight, operating steps for the two selected incidents and recovered/stale-alert condition, the timed talk skeleton, coding fill-in items, and fallback/reset instructions.
- [Scenario contracts](docs/demo-scenarios.md): activation, application effects, agent-visible evidence, expected investigation, and recovery for both selected incidents and the recovered/stale-alert condition.
- [Controller specification](docs/components/failure-controller-behavior.md): supported controls, action results, traffic bounds, observation sources, private records, and interruption handling.
- [Evaluation approach](docs/evaluations.md): cases, checks, Strands and AgentCore roles, release decisions, measurements, and important limits.
- [Deployment design](docs/deployment.md): the single development environment and its GitHub Actions, Python package, and TypeScript CDK workflow.

The [agent component document](docs/components/operations-agent.md) owns its software contract and capabilities at S0–S5. The talk documents own the presentation sequence, live edits, and presenter actions. These stages are runnable software states for the talk, not development delivery phases. S0 has no evaluations; S1 reviews cases; S2 adds deterministic and semantic evaluation with AgentCore results around the initially defective candidate; S3 repairs only the prompt and compares a fresh candidate; S4 adds the complete local Strands experiment; and S5 adds the CI release gate. The defective candidate remains available for comparison: adding evaluations does not itself improve the agent.

The agent recommends **Increase reserved concurrency**, **Increase memory**, **Restore inventory access**, or **Other**, with the relevant target/value and explanation. The controller exposes the three configuration actions independently; the presenter chooses and executes them. The initial candidate recommends increasing inventory memory for an inventory-access-denied incident. The allocation really changes, but fresh requests still encounter the table-policy denial. The corrected candidate recommends restoring inventory access for that incident and increasing inventory reserved concurrency for the capacity incident. The [demo script](docs/demo-script.md) records how the audience sees those outcomes.

## Reference implementation scope

The intended public implementation includes the sample application, Python Strands operations agent on AgentCore Runtime, controlled incidents, evaluation cases and evaluators, a CI/CD release gate, reproducible measurement tooling, and instructions for running and resetting the demonstration. Slides and the demonstration script belong here alongside the implementation.

The example uses synthetic incidents and actual executions. Captured evidence and results must identify that provenance; the reference implementation does not establish coverage of all production incidents or guarantee agent safety.

The application is a checkout example that saves an order and updates inventory atomically. A read-only inventory lookup provides the controlled dependency. Presenter-controlled faults produce real incidents for alert-triggered triage, with proposed remediation when warranted. The complete API, data, access, evidence, and reset design is in [the application document](docs/components/application.md).

## Application technology and access

The application uses TypeScript and React/Vite, hosted through S3/CloudFront, with API Gateway HTTP API, two Node.js 24 Lambda functions, and DynamoDB Orders/Inventory tables. CDK v2 in TypeScript defines deployment in us-east-1. These are design decisions; no application resources or code exist yet.

Operating access is presenter-only through a generated shared password validated by the checkout handler on every business route and every published variant. The static frontend contains no credential. The presenter web controller uses the same protected API for traffic; fault activation and reset require separate privileged AWS permissions. The operations agent remains read-only.

The operations agent and evaluation code use **Python** and Strands. The agent runs on AgentCore Runtime in us-east-1. Runtime and evaluation reuse one agent constructor with approved live or captured providers. Each alarm investigation uses a fresh session, four direct read-only AWS tools, and a structured report, with no follow-up conversation or AgentCore Memory; S0 has no evaluation cases, scores, or gate. AgentCore observability captures actual calls, query windows, reports, and run/event correlation from S0. S2 introduces deterministic checks, semantic diagnosis/grounding criteria, judge configuration, and AgentCore evaluation results; S4 connects the local Strands experiment; S5 runs the same experiment and policy in CI before deployment. The detailed contract is in the [operations agent document](docs/components/operations-agent.md).

## Operations and deployment design

The failure controller runs as a local presenter web app with a local backend. Its accepted UI direction uses a compact Actions menu, persistent action progress, large status cards, and additional details below the overview. CloudWatch alarms invoke a small Lambda adapter directly; the adapter normalizes and deduplicates alarm events before creating a run record, then invokes the Runtime agent. The adapter and controller identify a live event by alarm ARN and normalized originating ALARM-transition timestamp, independently of current alarm state or poll time. The local backend polls every five seconds, retains that identity after the alarm returns to OK, and discovers recorded runs after missed polls or restart. An overdue run remains unknown until the wrapper records a terminal outcome. The event/run schema, lookup implementation, and IAM identities remain open.

The [controller specification](docs/components/failure-controller-behavior.md) defines the complete presenter run, action outcomes, interruption handling, observation sources, and private record contents. The selected conditions are traffic-driven inventory capacity overload, denied inventory-table reads, and recovery observed against an older alert. The [application alarm](docs/components/application.md#application-alarm) uses native HTTP API stage `5xx`, Sum >=1 over 60 seconds, 1-of-1, missing data `notBreaching`, for both incidents. These are specifications, not implemented behavior. GitHub Actions builds and checks changes in pull requests; pushes to `main` that change relevant cloud code automatically build the Python ZIP artifact and deploy the single development environment through TypeScript CDK. See the [deployment design](docs/deployment.md). The exact Bedrock model/profile, tool budgets, wire schemas, trace IDs, IAM identities, judge models/rubrics, and release thresholds remain open. Workload bounds, capacity values, memory targets, and the initial candidate's repeatability require implementation and rehearsal. Strands supports repeatable regression experiments; AgentCore Evaluations assesses actual deployed-agent traces. The design does not require every check in both, and does not claim automatic evaluator-format interchange; the same reviewed case meaning and criteria are retained across paths.

Automatic deployment takes priority over controller work: stop new submissions/mutations, settle accepted work before cloud changes, and keep the controller suspended through deployment. Baselines are tied to trusted deployment generations. After deployment, the presenter reconciles and verifies a new baseline before resuming; old baselines cannot restore previous deployed versions. Deployment preserves business data, prior run records, and consumed controller budgets and does not run recovery/reset or generate probes. See the [deployment handoff](docs/deployment.md#deployment-and-controller-baseline).

Local and CI regression experiments execute each candidate against versioned, queryable captured evidence at an explicit case reference time. All four investigation tools use that coherent captured view; they do not mix historical failures with current AWS configuration. Candidates still choose their own queries and order. Rejudging an old trace does not establish that a changed candidate was executed. At S4, the local experiment and reviewed policy establish evidence before the first deployment; at S5, CI runs that same experiment and policy and blocks failed or incomplete required results. See the [evaluation contract](docs/evaluations.md).

Dataset preparation starts from captured actual runs and reviewed expectations. Capture of source evidence is available from S0 without creating an evaluation case or verdict; review and case creation begin at S1. The planned AgentCore observability experience can replace the extraction step when its capabilities are clear, while preserving the captured evidence and time contract.

## Event dates

The talk runs for 60 minutes and is scheduled for **December 1 and December 3, 2026**. Slides are due **November 6, 2026**. AWS has supplied slide templates; detailed Code Talk timing and Q&A guidance has not been supplied.

## License

See [LICENSE](LICENSE).
