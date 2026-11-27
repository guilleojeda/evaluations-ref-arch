# Audience questions

## Does Strands always need AgentCore?

No. A native Strands experiment can run a task and a Python evaluator locally. The public example uses a saved report and needs no AWS account. In the full talk workflow the task calls Bedrock, and a Strands evaluator sends the actual session evidence to AgentCore for semantic scoring. [Try the local experiment](adapt-evaluations.md)

## What counts as an action in this example?

The agent reads evidence and recommends a remedy. We use the trace to check which sources it queried and whether it attempted a write. We use the report to check what it recommended changing and to what value. The presenter applies the remedy through a separate controller. A new checkout shows what happened to the application. [Follow the denial](attendee-guide.md)

## Why can a judge agree with the diagnosis while the action check fails?

In the original trace, the report can explain that a database read was denied and still recommend increasing memory. The exact check compares the structured recommendation with the operator action we wrote in the dataset. AgentCore’s built-in Correctness evaluator compares the recorded trace with our written expectation and gives its own verdict and reason. We show both. The later release gate requires the action check to pass and uses a separately calibrated judge for evidence quality. [Score the original report](../examples/live-denial/README.md)

## Does creating the dataset run the agent again?

Adding the trace creates a draft from the investigation that already happened. You review the alarm input, write the answer you would accept and publish a version. Scoring the original reads its recorded spans. Editing the prompt and running the new candidate later creates a fresh investigation trace against the captured incident. [Follow the case from the console to the IDE](../examples/live-denial/README.md)

## Why use one judge call for diagnosis and grounding?

Both questions need the same report, reference time and source observations. One call reads that context once and returns one advisory verdict with a reason. If the judge rejects the report, you have to read its reason to see which claim failed. If the call fails, you lose both judgments for that attempt. Separate calls make sense when you need independent scores, examples, or retries for each requirement.

## How do you decide whether to trust the judge?

Have reviewers label reports against their source evidence first. Include a plausible error, such as citing a metric bucket's start as the time its value was observed, alongside a correctly cited report. Compare the judge's reasons as well as its verdicts with those labels. Test the chosen rubric on fresh cases held back from tuning. Recheck that calibration after a model or rubric change. [Evaluation approach](evaluations.md)

## Why keep captured evidence when the live incident is over?

After recovery, the same query might now find a successful checkout. A capture with a cutoff lets two prompt versions investigate the same incident independently and choose their own queries. It also lets a reviewer check each report against what the agent could have known at the time. [Case construction](adapt-evaluations.md)

## What happens if an evaluation cannot finish?

A failed required check supplies evidence of a regression. An incomplete result means a necessary execution, observation, or score is missing. Either prevents publication. Once required checks pass and advisory scoring completes, a human reviews the reports against their sources before approving the exact package. [Release decisions](evaluations.md#release-decisions)
