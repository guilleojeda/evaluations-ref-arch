# Talk plan

**Ship Reliable AI Agents with Strands Evaluation and AgentCore Evaluations** is a 60-minute Code Talk for engineers and architects building agents on AWS. Assume the room knows prompts, models, and tools. Give them a practical way to decide whether an agent change is safe to release.

The [demo cue sheet](demo-script.md) has the commands and screen changes. Use the [slides plan](slides-plan.md) for slide numbers and [demo progression](demo-progression.md) for the code at each stage. Give attendees the [guide to the incident and the rejected push](attendee-guide.md).

## Audience and intended outcome

Show the room how to:

1. Turn an observed failure into a reviewed, repeatable case.
2. Check actions and evidence separately from prose quality.
3. Use a release gate that protects a known-good candidate when a later prompt change regresses.

Opus 5.5 supplies the AgentCore judge’s verdict and reason. In S5, code checks the proposed remedy and a reviewer decides whether to publish the package.

## Incident story

Open with the Inventory access denial. The faulty agent recommends more memory. Apply the increase, then try one checkout from the storefront that’s already open. Show the dashboard reading 512 MB and checkout still returning 502. The role still lacks permission to read the table. No order was created and no stock was deducted.

After the failed checkout, ask once: **"Did the agent miss the clue, or did it see the clue and still recommend the wrong fix?"** Start Recover privately and open the matched original trace. Use the trace and preserved source evidence as the basis for a reviewed case.

Ask what the agent should have recommended. For this case, **Restore inventory access** means selecting the healthy Inventory version at the same memory. Later, contrast it with throttling, where raising the cap can help. For the live repair, select the repaired agent, wait for alarm OK and trigger a fresh denial. The recovered case uses an earlier alert after the service is healthy.

## Code transformation

Each checkpoint adds a way to test the same agent. If you skip to a later checkpoint, tell the audience which result came from the live edit and which came from a saved run.

| Stage | What changes | What stays fixed |
| --- | --- | --- |
| S0 - Instrumented agent | Read-only investigation, structured report, tracing, and source capture. No cases or scores. | The faulty recommendation rule and four tool contracts. |
| S1 - Reviewed cases | Captured evidence gets a reference time, reviewed expectations, and unacceptable behavior. | The faulty candidate and its original evidence. |
| S2 - Evaluated agent | Deterministic action/value checks plus one advisory semantic judge on the saved session. | Candidate, case meaning, and saved execution. No agent rerun. |
| S3 - Short development repair | Edit only the recommendation rule and run a fresh candidate against the same case and judge. | Model target, tools, permissions, evidence boundary, and report shape. |
| S4 - Developer experiment | Run the repaired development candidate through the native Strands experiment and compare cases. | Reviewed case meaning and the single advisory judge. |
| S5 - Release gate | Bind deterministic requirements and human semantic review to the exact candidate package before publication. | The qualified repaired serving package remains in place until replacement passes. |

S3 and S4 test the edit the audience saw. The repaired endpoint runs a version qualified before the talk. While S4 runs, have the participant push the S5 regression to `demo-deploy` by 35:00. Show that commit’s gate result at 50:00.

## Run of show

| Minutes | Stage | Audience-facing work |
| --- | --- | --- |
| 0-5 | S0 | Magic box and paper-plane opener. Define evaluation as observed behavior checked against task requirements. |
| 5-11 | S0 | Introduce the store, show the genuine alarm and faulty report, apply the memory recommendation, and make the one failed checkout. |
| 11-15 | S0 | Show the failed request and Server ID, ask the diagnostic question, Recover privately, and open the matched original trace. |
| 15-18 | S0 | Inspect the trace and source evidence. An optional Logs or configuration choice changes only the viewing order. |
| 18-23 | S1 | Review one complete case. Keep the accepted access-restoration expectation visible. |
| 23-28 | S2 | Introduce the deterministic action/target check and one advisory diagnosis check. Ask the single vote, show the actual action and judge verdict once, then show one clock-calibration pair. |
| 28-29 | S3 | Make the short prompt-only development edit and start the fresh candidate. |
| 29-35 | S4 and S5 | Start authenticated S4 as soon as the S3 source is ready, aiming for 30:00. Hand the participant the S5 terminal immediately. The participant edits, predicts, commits, and pushes by 35:00. |
| 35:05 | S4 and S5 | Read push and experiment status only. Do not wait for S4 before continuing. |
| 36-37 | S4 | Show the denial row first and throttling row second from the same experiment. Use the matching recorded pair by 37:00 if needed. |
| 35-40 | S4 and S5 | When the keyboard returns and health allows, privately select the qualified repaired endpoint, confirm fresh alarm OK, and trigger the new denial once. Protect the reveal at 40:00. |
| 40-46 | S5 | Reveal the new repaired incident, apply Restore inventory access independently, and show the settled successful checkout by 45:30. |
| 46-50 | S5 | Show the gate policy and workflow. Run the callback for the participant's exact commit and package at 50:00. |
| 50-53:15 | S5 | Show the actual decision and publication status. Use an exact recorded rejection only if the current result is still pending, with its identity visible. |
| 54-55 | S5 | Deliver the closing. |
| 55-60 | S5 | Questions and buffer. |

Treat the timeline as a handoff schedule, not a prerequisite chain. A late operation stays pending. A matching recorded result may fill the screen, but label it as recorded rather than a fresh execution.

## Audience participation

Use three bounded interactions:

- Define the access-restoration expectation in S1.
- Vote once on whether the logs support the diagnosis in S2.
- Have the prepared participant type only the prompt regression in S5, predict the gate result, and push it by 35:00.

The vote is discussion, not a calibration label or release authority. Normalize audience wording into the reviewed case. Do not insert it into the agent prompt or judge instructions. The participant's push is independent of S4 and does not wait for its result.

## Browser IDE and live evals

In the browser IDE, show the real source edit, Source Control diff, terminal receipt, and result identity. Make the case visible in S1. Score the saved session in S2 without rerunning the agent. Run a fresh development candidate in S3 and the native Strands experiment in S4. In S5, show the participant's one-file prompt diff and the exact callback for the pushed candidate.

When the screen changes, identify the run the audience is looking at. Name the edited prompt in S4, the alarm that reached the repaired endpoint, or the commit under review in CI. For the live repair, the successful checkout is what shows the store recovered.

## Capacity scenario

Run the capacity comparison as a separate presenter sequence, not a prompt repair. Start healthy at Inventory cap 16, run the current finite `inventory_surge` profile, stop and drain it, raise Inventory to 32, repeat the same saved profile, and Recover to 16. Compare actual starts, skipped waves, request arrivals, native throttle metrics, caller outcomes, and settled business effects. A configured profile is not delivered-demand evidence. An empty or incomplete metric series remains unknown.

Use the [scenario contracts](demo-scenarios.md) for the detailed invariants. Keep memory, code, aliases, access, and product version unchanged across the two capacity episodes. The capacity action changes configuration only. It does not start traffic or claim recovery.

## Reliability and recovery

Before each opening or new live incident, verify the current generation, healthy baseline, settled work, and native alarm OK. Match the genuine alarm transition to its durable agent run. Recover preserves business data. Reset is the separate whole-session operation that creates a new product version after work is stopped and settled. Never reuse an interrupted reset or restore an old baseline over a newer deployment.

If a live step is late, show a matching recorded run and say so. Keep the original status and provenance visible. Never fabricate an alarm, invoke the agent manually as a substitute for the alarm path, retry the audience checkout, or call a development result a release qualification.

For the live sequence, use [preparation](preparation.md), [cleanup](cleanup.md) and the [incident scenarios](demo-scenarios.md). For questions about judging or CI, use the [evaluation guide](evaluations.md) and the [attendee guide](attendee-guide.md).

## Closing

> Your agent is non-deterministic, but you can still test whether its behavior is acceptable. First define what good looks like. Then check whether your evaluations recognize it. Finally, use them to improve the agent and stop regressions before they ship.
>
> Evaluations passing does not mean the agent can never fail. But at least your release decision now has evidence behind it.
>
> Without that evidence, you are hoping nothing goes wrong. Hope is not a strategy. Do evals.
