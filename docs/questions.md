# Audience questions

## Why does the talk run the same case twice?

The original score judged an already generated report. After calibration, the
same reviewed case is supplied as fixed input to a fresh native Strands
inference, so the audience can see what the edited agent generates. The new
live denial is behavior evidence only. The original scored case and matching
case/bundle hashes are registered once in the private CI suite. A required fast
check can block downstream qualification and publication; it cannot be replaced
by a recorded green result.

## Does Strands always need AgentCore?

No. In the IDE, Strands Evaluations runs the application agent with your edited prompt. Bedrock generates a fresh report, and the native Strands `Equals` evaluator compares its recommendation with the one you specified. The earlier on-demand AgentCore evaluation scores the original trace. The full release qualification also uses AgentCore for its calibrated advisory judge. [Try the experiment](adapt-evaluations.md)

## What counts as an action in this example?

The agent reads evidence and recommends a remedy. We use the trace to check which sources it queried and whether it attempted a write. We use the report to check what it recommended changing and to what value. The presenter applies the remedy through a separate controller. A new checkout shows what happened to the application. [Follow the denial](attendee-guide.md)

## Why can a judge agree with the diagnosis while the action check fails?

In the original trace, the report can explain that a database read was denied and still recommend increasing memory. The exact check compares the structured recommendation with the operator action we wrote in the dataset. AgentCore’s built-in Correctness evaluator compares the recorded trace with our written expectation and gives its own verdict and reason. We show both. The later release gate requires the action check to pass and uses a separately calibrated judge for evidence quality. [Score the original report](../examples/live-denial/README.md)

## Does creating the dataset run the agent again?

Creating the dataset saves a scenario from the investigation that already happened. You write the expectation and publish the version. Later, in the IDE, you run the report-writing decision again with the same alarm and the same recorded conversation. Each prompt generates its own answer. The hosted demo then triggers a new alarm to test the full investigation. [Follow the case from the console to the IDE](../examples/live-denial/README.md)

## Why use one judge call for diagnosis and grounding?

Both questions need the same report, reference time and source observations. One call reads that context once and returns one advisory verdict with a reason. If the judge rejects the report, you have to read its reason to see which claim failed. If the call fails, you lose both judgments for that attempt. Separate calls make sense when you need independent scores, examples, or retries for each requirement.

## How do you decide whether to trust the judge?

Assign incidents to calibration or holdout before tuning. Have reviewers label
varied reports against their source evidence, with an expected verdict and
reason. For example, a denied Inventory read does not support a report claiming
the service ran out of memory, so the human label is **UNSUPPORTED**. Compare
the custom Opus judge's reasons as well as verdicts with those labels; inspect
failures and adjust the custom rubric. Freeze it before unseen examples. If an
incident or report was seen or changed during tuning, replace it with a fresh
holdout. [Evaluation approach](evaluations.md)

## Why keep captured evidence when the live incident is over?

After recovery, the same query might now find a successful checkout. A capture with a cutoff lets two prompt versions investigate the same incident independently and choose their own queries. It also lets a reviewer check each report against what the agent could have known at the time. [Case construction](adapt-evaluations.md)

## What happens if an evaluation cannot finish?

A failed required check supplies evidence of a regression. An incomplete result means a necessary execution, observation, or score is missing. Either prevents publication. Once required checks pass and advisory scoring completes, a human reviews the reports against their sources before approving the exact package. [Release decisions](evaluations.md#release-decisions)
