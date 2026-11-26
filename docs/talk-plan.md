# Talk plan

**Ship Reliable AI Agents with Strands Evaluation and AgentCore Evaluations** is a 60-minute Code Talk for engineers and architects building agents on AWS. The audience knows prompts, models, and tools. They need a practical way to decide whether an agent change is safe to release.

The [attendee guide](attendee-guide.md) is the canonical public denial-to-CI account. This plan owns the narrative and timing; [demo progression](demo-progression.md) owns the capability checkpoints, [demo script](demo-script.md) owns presenter actions, and [slides plan](slides-plan.md) owns the slide storyboard.

## Audience and intended outcome

Attendees should leave able to:

1. Turn an observed failure into a reviewed, repeatable case.
2. Check actions and evidence separately from prose quality.
3. Use a release gate that protects a known-good candidate when a later prompt change regresses.

The active v5 rehearsal uses one calibrated native AgentCore semantic judge with US Opus 5.5 for advisory feedback. The judge returns one semantic verdict with a reason. Older model results are historical. They are not relabeled or used as current release evidence. S5 uses deterministic requirements and human semantic review against the exact package being proposed.

## Incident story

The opening incident is a real Inventory access denial. The faulty candidate recommends increasing Inventory memory. The presenter applies that action independently, then submits one fresh checkout from the already-open signed-in storefront. The memory readback succeeds, but the denied role and exact-table Deny remain, so the checkout fails before an order or stock write. This separates a configuration result from an application result.

After the failed checkout, ask once: **"Did the agent miss the clue, or did it see the clue and still recommend the wrong fix?"** Start Recover privately and open the matched original trace. Do not add a mandatory constructor tour. The trace and preserved source evidence become the basis for a reviewed case.

The case expectation is **Restore inventory access** by selecting the healthy role-backed Inventory version at the current memory. A capacity case remains useful as the second mechanism: observed Inventory throttling supports a higher Inventory cap. The live flow shows a new access-denied incident after the repaired endpoint is selected and the alarm is confirmed OK. The recovered/stale-alert condition is a temporal control case, not a third injected incident.

## Code transformation

The six checkpoints add evaluation capability around a mostly stable agent. They do not imply that a result is complete merely because the next checkpoint is open.

| Stage | What changes | What stays fixed |
| --- | --- | --- |
| S0 - Instrumented agent | Read-only investigation, structured report, tracing, and source capture. No cases or scores. | The faulty recommendation rule and four tool contracts. |
| S1 - Reviewed cases | Captured evidence gets a reference time, reviewed expectations, and unacceptable behavior. | The faulty candidate and its original evidence. |
| S2 - Evaluated agent | Deterministic action/value checks plus one advisory semantic judge on the saved session. | Candidate, case meaning, and saved execution. No agent rerun. |
| S3 - Short development repair | Edit only the recommendation rule and run a fresh candidate against the same case and judge. | Model target, tools, permissions, evidence boundary, and report shape. |
| S4 - Developer experiment | Run the repaired development candidate through the native Strands experiment and compare cases. | Reviewed case meaning and the single advisory judge. |
| S5 - Release gate | Bind deterministic requirements and human semantic review to the exact candidate package before publication. | The qualified repaired serving package remains in place until replacement passes. |

The S3/S4 development edit is intentionally separate from the exact v5 package qualified for serving and used for the repaired live incident. The participant's S5 prompt-only regression is another candidate. It is pushed to `demo-deploy` by 35:00 while S4 continues, and the current gate callback is shown at 50:00. There is no S6.

## Run of show

| Minutes | Stage | Audience-facing work |
| --- | --- | --- |
| 0-5 | S0 | Magic box and paper-plane opener. Define evaluation as observed behavior checked against task requirements. |
| 5-11 | S0 | Introduce the store, show the genuine alarm and faulty report, apply the memory recommendation, and make the one failed checkout. |
| 11-15 | S0 | Show the failed request and Server ID, ask the diagnostic question, Recover privately, and open the matched original trace. |
| 15-18 | S0 | Inspect the trace and source evidence. An optional Logs or configuration choice changes only the viewing order. |
| 18-23 | S1 | Review one complete case with the audience. Keep the accepted access-restoration expectation visible. |
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

The timeline is a handoff schedule, not a prerequisite chain. A late operation stays pending; a matching recorded result may fill the screen without being presented as a fresh execution.

## Audience participation

Use three bounded interactions:

- Define the access-restoration expectation in S1.
- Vote once on whether the logs support the diagnosis in S2.
- Have the prepared participant type only the prompt regression in S5, predict the gate result, and push it by 35:00.

The vote is discussion, not a calibration label or release authority. Audience wording is normalized into the reviewed case; it is not inserted into the agent prompt or judge instructions. The participant's push is independent of S4 and does not wait for its result.

## Browser IDE and live evals

The browser IDE shows a real source edit, Source Control diff, terminal receipt, and result identity. S1 makes the case visible. S2 scores the saved session without rerunning the agent. S3 runs a fresh development candidate. S4 runs the native Strands experiment. S5 shows the participant's one-file prompt diff and the exact callback for the pushed candidate.

Keep the short S3/S4 development result, the separately qualified exact serving package, the live alarm/run, and the S5 gate result as separate identities. A saved trace cannot prove that an edited candidate ran. A judge verdict cannot authorize publication. A deployment or configuration readback cannot prove application recovery.

## Capacity scenario

The capacity comparison is a separate presenter sequence, not a prompt repair. Start healthy at Inventory cap 16, run the current finite `inventory_surge` profile, stop and drain it, raise Inventory to 32, repeat the same saved profile, and Recover to 16. Compare actual starts, skipped waves, request arrivals, native throttle metrics, caller outcomes, and settled business effects. The configured profile is not delivered-demand evidence. An empty or incomplete metric series remains unknown.

The [scenario contracts](demo-scenarios.md) own the detailed invariants. Keep memory, code, aliases, access, and product version unchanged across the two capacity episodes. The capacity action changes configuration only; it does not start traffic or claim recovery.

## Reliability and recovery

Before each opening or new live incident, verify the current generation, healthy baseline, settled work, and native alarm OK. Match the genuine alarm transition to its durable agent run. Recover preserves business data; Reset is the separate whole-session operation that creates a new product version after work is stopped and settled. Never reuse an interrupted reset or restore an old baseline over a newer deployment.

If a live step is late, show a matching recorded run and say so. Keep the original status and provenance visible. Never fabricate an alarm, invoke the agent manually as a substitute for the alarm path, retry the audience checkout, or call a development result a release qualification.

See the [attendee guide](attendee-guide.md), [evaluation contract](evaluations.md), [preparation](preparation.md), [cleanup](cleanup.md), and [scenario contracts](demo-scenarios.md) for public maintainer and reference-run material.

## Closing

> Your agent is non-deterministic, but you can still test whether its behavior is acceptable. First define what good looks like. Then check whether your evaluations recognize it. Finally, use them to improve the agent and stop regressions before they ship.
>
> Evaluations passing does not mean the agent can never fail. But at least your release decision now has evidence behind it.
>
> Without that evidence, you are hoping nothing goes wrong. Hope is not a strategy. Do evals.
