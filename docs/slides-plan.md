# Slides plan

The [14-page audience PDF](slides/audience.pdf) contains the projected slides. The numbers below refer to the full presenter deck, including its hidden slides. See the [talk plan](talk-plan.md) for timing, the [cue sheet](demo-script.md) for commands and the [attendee guide](attendee-guide.md) for the public walkthrough.

The deck has 14 projected audience slides, 22 hidden reference or backup slides, and five appendix slides. Hidden slides use time already assigned to a live block. Do not project them during normal playback or use them as substitutes for matching live evidence.

## What the talk should achieve

The central question is: **What evidence would justify shipping this change to my agent?**

Follow the access denial. Capture what the agent saw, decide which remedy would be acceptable, edit the prompt and show CI catching a later regression. In v5, the Opus 5.5 judge assesses the diagnosis and its evidence. The code checks and human review in S5 decide what ships. Keep cost and historical model comparisons for the appendix or Q&A.

## Sequence at a glance

Time ranges identify the talk block. A hidden slide explains the live screen or code in that block. It does not add a new block.

| # | Use | Time | Stage | Title or reference |
| --- | --- | --- | --- | --- |
| 01 | Audience | 0-5 | S0 | Ship Reliable AI Agents with Strands Evaluation and AgentCore Evaluations |
| 02 | Audience | 0-5 | S0 | What counts as a good answer? |
| 03 | Hidden backup | 5-11 | S0 | A demo store with one product |
| 04 | Hidden backup | 5-11 | S0 | An agent that investigates application failures |
| 05 | Hidden backup | 5-11 | S0 | Does the recommendation actually fix the problem? |
| 06 | Hidden | 5-11 | S0 | Healthy application, new incident, and faulty recommendation |
| 07 | Hidden | 5-11 | S0 | Applying the recommendation and checking fresh requests |
| 08 | Audience | 11-15 | S0 | Checkout still failed at 512 MB |
| 09 | Hidden backup | 11-15 | S0 | Difference or constructor bridge |
| 10 | Hidden backup | 11-15 | S0 | Initial agent code |
| 11 | Audience backup | 15-18 | S0 | Did the agent miss the clue, or did it see the clue and still recommend the wrong fix? |
| 12 | Hidden | 15-18 | S0 | Inspecting the matched execution in AgentCore Observability |
| 13 | Audience | 18-23 | S0 -> S1 | From failure to test case |
| 14 | Hidden | 18-23 | S1 | Constructing the complete reviewed case |
| 15 | Audience | 18-23 | S1 -> S2 | Two checks for the same recommendation |
| 16 | Hidden | 18-23 | S2 | Evaluator code and saved-session launch |
| 17 | Audience | 23-28 | S2 | Do the logs support the diagnosis? |
| 18 | Audience | 23-28 | S2 | One clock-calibration pair |
| 19 | Hidden backup | 23-28 | S2 | Recorded native comparison |
| 20 | Hidden appendix | Questions | S2 | Scoring a saved trace and running a changed candidate |
| 21 | Hidden | 28-30 | S2 | Baseline findings and per-case evidence |
| 22 | Hidden | 28-29 | S2 -> S3 | Prompt repair and fresh candidate launch |
| 23 | Audience | 30-40 | S3 -> S4 | Comparing development candidates in Strands |
| 24 | Hidden | 30-37 | S4 | The Strands experiment in code |
| 25 | Hidden backup | 36-37 | S4 | Two cases and two mechanisms |
| 26 | Hidden appendix | Questions | S4 | Cost and turnaround |
| 27 | Hidden | 35-40 | S4 | Candidate comparison and prepared release evidence |
| 28 | Audience | 40-46 | S4 | Does the recommendation actually fix the problem? |
| 29 | Hidden | 40-46 | S4 | New incident with the repaired serving candidate |
| 30 | Hidden | 30-35 | S4 -> S5 | Prompt edit that brings back the memory recommendation |
| 31 | Audience | 47-53:15 | S5 | When does CI block deployment? |
| 32 | Hidden | 48-53:15 | S5 | Experiment and release policy in CI |
| 33 | Hidden | 50-53:15 | S5 | Gate callback, decision and publication status |
| 34 | Audience | 54-54:35 | S5 | From the first failure to the CI gate |
| 35 | Audience | 54:35-59:45 | S5 | Code and resources |
| 36 | Audience | 59:45 | S5 | Thank You |
| 37 | Appendix | Questions | - | A1 - Architecture and execution paths |
| 38 | Appendix | Questions | - | A2 - Complete reviewed case |
| 39 | Appendix | Questions | - | A3 - Judge selection and calibration |
| 40 | Appendix | Questions | - | A4 - Measurement and pricing basis |
| 41 | Appendix | Questions | - | A5 - Release policy and coverage |

## Screen and transition notes

### 01-02: evaluation frame

Keep the title slide up for the magic box and two visibly different paper planes. Use slide 02 to compare "Make me a paper plane" with "Get me to Las Vegas" and define evaluation as checking observed behavior against task requirements. While slide 02 remains up, start the private opening activation and then move to the already-open storefront.

### 03-12: opening incident and trace

Show the store, alarm, report, configuration readback and failed checkout. Keep the private controller setup off screen. Keep the one checkout's POST status, error and Server ID separate from its business-state card. Slide 08 states the result: the memory change completed, but the fresh request still failed. After the diagnostic question, run Recover privately and move to the matched original trace. Slides 09-10 are optional backups. Slide 11 is an optional question card.

### 13-22: case, checks and current judge

Use slide 13 to ask what acceptable behavior should do. Slide 14 shows the complete case with reference time and evidence provenance. Slide 15 introduces the deterministic action/target check and one advisory semantic check. Ask once on slide 17, "Do the logs support the diagnosis?" Slide 18 shows one clock-calibration pair: bucket-start citation fails, source-observation citation passes. Show the matching actual action and current judge verdict once, then move to the prompt edit. Score the saved faulty session once and never rerun the agent.

### 23-27: development edit and experiment

Use slide 23 to introduce the short S3/S4 development edit. The fresh candidate uses the same reviewed case and current calibrated judge, with advisory results. Slide 24 shows the native Strands experiment. Slide 25 keeps the denial row first and the throttling row second. Slide 27 distinguishes those development results from the exact package qualified before the talk. Start S4 around 30:00, hand the S5 terminal to the participant immediately, and push by 35:00 while S4 continues.

### 28-30: repaired serving incident and regression

Use slide 28 to repeat the opening question for the repaired serving candidate. After the participant returns the keyboard, verify the qualified endpoint and fresh alarm OK privately, then trigger the new denial once. Slide 29 shows the new alarm/run, independent access restoration, and settled successful checkout. Slide 30 is the participant's prompt-only regression. Its edit and gate are independent of S4.

### 31-36: gate and close

Use slide 31 to explain when CI blocks publication. Slide 32 shows the same experiment and policy in CI. Slide 33 shows the exact callback at 50:00: commit, candidate package, reviewed case, deterministic findings, human review state, and publication status. A failed deterministic requirement rejects automatically and leaves the qualified repaired package serving. Slide 34 summarizes the path, slide 35 gives the public repository and documentation entry point, and slide 36 is Thank You. Use a recorded rejection only as an exact, labeled fallback if the current callback is still pending at 53:15.

## Appendix guidance

- **A1 - Architecture:** show the alarm-to-runtime path, four read-only tools, captured-evidence regression path, and independent presenter actions. Keep live and captured sources distinct.
- **A2 - Case:** show the reference time, evidence references, expected healthy role-backed version, unacceptable memory or concurrency actions, and deterministic and semantic checks.
- **A3 - Judge:** explain that one calibrated judge is fixed for the current comparison. A judge or rubric change changes the measurement and requires recalibration.
- **A4 - Measurement:** show only a measurement with its workload, candidate, case count, judge, region, pricing basis and included costs. Do not use stale numbers or an unmeasured duration in the normal path.
- **A5 - Release policy:** show required behavior, incomplete-result handling, human review, and coverage limits. Passing this scoped gate does not establish general production accuracy.

## Authoring and evidence rules

Label diagrams as diagrams. When showing a recording, name the case, candidate and run. Keep the evidence, judge and package references available for questions. If the live run is pending, say so before switching to the recording.

Share the [audience slides](slides/audience.pdf) and [attendee guide](attendee-guide.md). For technical questions, use the [evaluation guide](evaluations.md) and [demo scenarios](demo-scenarios.md). Keep the [preparation](preparation.md) and [cleanup](cleanup.md) commands on the private display, along with credentials and private run links.
