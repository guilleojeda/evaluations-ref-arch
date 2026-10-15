# Deployment

**Status: designed; not implemented.** GitHub Actions automatically deploys cloud code and infrastructure changes during development. CDK defines the AWS resources; the workflow builds the artifacts and runs CDK. This is part of the development workflow from S0, independently of the presentation.

## Workflow

Use one GitHub Actions workflow and one development environment in us-east-1.

| Event | Behavior |
| --- | --- |
| Pull request | Run the relevant build and ordinary code checks. |
| Push to `main` affecting deployed code, infrastructure, dependencies, or deployment configuration | Build, check, and automatically deploy the application and agent to the development environment. |
| Documentation-only change | No cloud deployment. |

The deployment job packages the TypeScript application, web assets, and Python agent with their dependencies, then deploys the applicable CDK resources. The agent uses AgentCore Runtime's Python ZIP deployment. Record the source commit and deployed artifact/version identities so investigations and evaluations can identify the code actually running. The failure controller remains a local application; its code is checked in CI and run locally.

Serialize deployment jobs for the shared environment. A failed build, required check, or deployment remains a failed workflow; it does not become a successful release. Normal development deployments require no manual approval or separate release action.

## AWS access and initial setup

Use GitHub OIDC to obtain short-lived AWS credentials for a deployment role restricted to this repository's deployment workflow and branch. The role can deploy the intended CDK resources; application and agent runtime roles retain their separate permissions. [GitHub OIDC for AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws), [CDK deployment](https://docs.aws.amazon.com/cdk/v2/guide/deploy.html)

Initial account setup establishes OIDC trust, the deployment role, and CDK bootstrap resources. Account/role identifiers and exact workflow commands will be set during implementation. Subsequent code changes deploy through GitHub Actions.

The deployment workflow does not activate incidents, generate traffic, call controller Recover, or reset Orders/Inventory. Normal CDK updates may replace a setting affected by an incident while applying the intended deployment; this is not a separate incident-restoration action or proof of application recovery. Initial data setup and presenter-operated reset retain the [application contract](components/application.md#deployment-development-and-reset); routine updates preserve existing business data.

## Deployment and controller baseline

**Automatic deployment takes priority over a controller run.** After the build and required checks pass, the workflow requests exclusive deployment ownership of the shared target. The controller stops new catalog/checkout submissions and refuses new configuration actions or reset work. Accepted requests and AWS changes must settle or be reconciled before deployment starts changing cloud resources; a stop request does not cancel them. Deployment serialization and the controller's local lock alone do not provide this cross-process handoff. Use an explicit shared coordination protocol; its storage, fencing, and bounded wait settings remain implementation details. An absent backend is not proof that earlier submitted work settled. If a safe handoff cannot be established, the workflow fails or remains incomplete rather than proceeding concurrently.

The controller remains suspended while deployment owns the target. Record the deployment attempt and the trusted successfully deployed generation, including source/artifact identities and expected healthy application versions, memory/cap settings, and Inventory policy or its absence. Keep these expected settings separate from observed settings and from private incident/remedy changes. Once deployment begins cloud mutations, the previous baseline cannot authorize Recover/Reset to restore older aliases or settings. A failed or partial deployment leaves the target requiring reconciliation; it does not establish a new healthy baseline or permit a blind rollback by the controller.

After successful deployment, the controller observes the new generation and the presenter explicitly reconciles before resuming operation:

1. Establish the actual deployed settings and outstanding outcomes against the new generation's trusted expected settings. Preserve Orders/Inventory, the existing controller run/journal, previous agent records, and consumed POST/read allowances.
2. Reconcile known controller changes under the new generation's expectations and revision/conflict guards. A surviving Deny or increased cap is not a new healthy baseline. Readiness checks do not silently repair it, and no operation restores an old generation's aliases or overwrites unrelated drift.
3. Explicitly verify and adopt a new configuration/business baseline, including any verification checkout's actual order/stock effect. Verification uses the current run's remaining allowances; deployment and baseline adoption do not start a new run or renew budgets. Insufficient allowance leaves readiness incomplete. A separately requested destructive Reset may establish the next run only after safe new-generation configuration reconciliation and quiescence, following its existing next-run verification budget.

The automatic workflow performs no recovery, reset, or application probes as part of this handoff. Deployment completion and controller readiness are separate outcomes. Normal traffic resumes only by explicit presenter action after reconciliation and verification. The [controller specification](components/failure-controller-behavior.md) owns the operating controls and restart behavior; these generation rules also apply after backend restart.

## Evaluation stages

S0 has automatic deployment and ordinary software checks, with no agent evaluation suite or evaluation release gate. S1 introduces reviewed cases; S2 and S3 introduce their evaluation capabilities. At S4, the selected evaluation release policy becomes a required pre-deployment check in the same workflow. Local and CI decisions use the same policy, and missing required evaluation evidence cannot pass. See [evaluation approach](evaluations.md#release-decisions).

The S4 gate executes the pending candidate through the local Python/Strands regression path against versioned captured evidence before changing the shared environment. It uses the candidate's agent construction, prompt, tool contracts, and report behavior, with captured evidence providers in place of live AWS reads. Retain the evaluated source commit, agent artifact/prompt/dependency identity, case/evidence versions, evaluator/model settings, and policy result. Deploy that evaluated candidate; a substituted candidate or relevant artifact change requires new evaluation. An old deployed-agent trace cannot substitute for execution of the pending candidate. Genuine AgentCore trace evaluations retain their own provenance and selected role. This does not require a second environment or running every evaluator twice.

The [agent component](components/operations-agent.md) owns runtime behavior; the [talk documents](demo-progression.md) own how the stages are presented. One shared development environment and one automatic deployment workflow are the baseline.
