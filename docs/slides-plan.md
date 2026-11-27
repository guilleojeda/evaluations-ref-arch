# Slides plan

The [audience PDF](slides/audience.pdf) contains 19 projected pages. The
presenter deck has 42 physical pages, including hidden reference and
troubleshooting slides; the hidden native-dataset troubleshooting slide
replaces the older score backup. See the [talk plan](talk-plan.md) for timing,
the [cue sheet](demo-script.md) for the screen order, and the [attendee
guide](attendee-guide.md) for the public walkthrough.

## What the talk should achieve

The central question is: **What evidence would justify shipping this change to
my agent?** Follow the Inventory denial from a native trace to a reviewed
AgentCore dataset case, score the original report, repair the prompt in a
native Strands experiment, and apply CI policy to the exact package proposed
for release.

## Slide sequence

| Block | Audience message | Screen evidence |
| --- | --- | --- |
| Opening | An agent can find the right diagnosis and still choose the wrong action. | Store failure, alarm, and original report. |
| Trace | The agent actually saw the denied read and the two version configurations. | Native trace and configuration evidence. |
| Case | Expected behavior is reviewed separately from the prompt. | Fixed dataset scenario draft, expected response, and published version. |
| Original score | The exact structured recommendation is checked, then the evaluator scores the formal response against the written expectation. | Codespace `denial-case.json`, `score_denial.py`, and returned `Builtin.Correctness` label/value/explanation. |
| Development | The repair is tested against the current native case and four retained reviewed cases with bounded evidence. | S3 fresh run and S4 native Strands rows. |
| Release | CI evaluates the exact package, not a convenient neighboring trace. | S5 package identity, deterministic findings, advisory result, and review state. |
| Close | Evidence supports a bounded release decision, not a claim of universal accuracy. | Case, candidate, evaluator, package, and publication identities. |

## Screen and transition notes

### Trace to dataset

Show the Inventory `AccessDeniedException`, matching Checkout 502, and
configuration showing the denied version versus the healthy version at the
same observed baseline memory. Add the selected trace to a fixed dataset.
During creation leave expected response and expected trajectory disabled; then
edit `turns[0].expected_response` and the typed
`metadata.expected_recommendation` in the scenario draft, save both, and create
the published version. Make clear that a draft is not yet the frozen download.

### Dataset to Codespace

In the `live-denial` folder, use the maintained [download and score command](../examples/live-denial/README.md#download-the-published-case-in-codespaces)
with the full dataset ID and published version. It selects `examples[0]` and
uses the locked scorer.

Show the input, both reviewed fields, and source metadata in the downloaded case.
Then show the script loading the original report from recorded CloudWatch
spans and calling `Builtin.Correctness`. The script does not rerun the agent.
Read the returned label, value, and explanation. Do not promise that repeated
judge attempts will return the same label; the written formal recommendation
must still be compared with the structured recommendation.

### S3 and S4

Show the recommendation-only prompt edit. S3 runs a fresh candidate with the
current native case/evidence bridge. S4 runs native Strands with that case plus
the four retained reviewed cases. These rows are development feedback and
create fresh execution and trace identities. They are not the S2 original score
and do not qualify a Runtime ZIP.

The runnable [native case bridge](../scripts/native_case_bridge.py), using the
build command in the [adaptation walkthrough](adapt-evaluations.md#bridge-the-live-case-into-s3-s4),
binds the downloaded scenario and `original-trace.json` to the originating
RunTable row and S3 captures. Its `case.frozen.json` and `captured-bundle.json`
feed S3; its `suite.json` feeds S4. This is the same incident's normal task
projection and bounded evidence, not a new trace or an unreviewed native
expected-response string.

### S5

Show a participant prompt regression and the CI result for the exact ZIP it
proposes. The one participant commit contains the prompt edit and private
suite-pointer update. Presenter preparation has already appended the denial
case to the existing four-case reviewed roster and uploaded the five-case
archive privately. CI downloads/verifies all five and compares source-run
case/bundle identity with the candidate result.
Keep the qualification row distinct from a later live alarm/run row. A required
deterministic failure rejects publication; advisory semantic quality and human
review remain separate facts. A previously qualified serving package remains
in place while the proposed package is evaluated. This is not a guarantee of
pass or publication.

## Appendix guidance

- **Architecture:** show the alarm-to-runtime path, read-only tools, captured
  case path, and independent application action. Keep live and captured sources
  distinct.
- **Case:** show the reviewed prose and typed recommendation with source metadata without exposing
  private trace identifiers or credentials.
- **Judge:** show the evaluator ID, returned label/value, and explanation for
  the scoring attempt. A semantic judge is not a replacement for an action
  check.
- **Measurement:** state the case count, candidate, evaluator, region, and
  evidence boundary before discussing a result.
- **Release policy:** required checks, incomplete-result handling, human review,
  and exact-package identity.

Share the [audience slides](slides/audience.pdf) and [attendee guide](attendee-guide.md).
The public repository intentionally omits private trace IDs, account-specific
roles, credentials, and presenter operating runbooks.
