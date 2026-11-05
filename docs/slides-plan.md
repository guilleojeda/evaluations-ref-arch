# Slides plan

This is the rebuilt storyboard for review. It replaces the earlier 16-slide plan; it does not describe the current PowerPoint draft. Use the AWS-supplied template when this storyboard is authored.

The sequence below contains **20 audience slides, 14 hidden reference slides, and five appendix slides**. These counts describe this proposal, not a fixed slide-count requirement. Preserved template originals are outside this sequence.

The [talk plan](talk-plan.md) owns the story, timing, and S0–S5 capability stages. The [demo cue sheet](demo-script.md) owns presenter actions and operating steps. The [evaluation approach](evaluations.md) owns cases, evidence, evaluators, measurements, and release policy. This document owns what each slide contributes to the audience's understanding and how slides connect to the actual screens.

## What the talk should achieve

The central question is: **What evidence would justify shipping this change to my agent?**

Attendees should leave able to:

1. Define acceptable behavior from a real failure and turn it into a reviewed, repeatable case.
2. Check whether their evaluations recognize that behavior, including the limits of code checks, model judges, calibration, holdouts, and repeated runs.
3. Use those evaluations to improve a candidate and stop unacceptable changes before deployment.

Cost, feedback time, and supported judge selection explain how to use this workflow in practice. The example carries the same reviewed expectation through case construction, evaluation, repair, and CI rejection. AgentCore and Strands enter when they solve a problem the audience can already identify.

Slides establish context, explain concepts, direct attention, and interpret observations. Live application screens provide observations; code shows the mechanism. Section names organize the schedule but do not automatically require a divider slide at the start of each section.

## Audience slides, hidden references, and appendix

- **Audience:** projected at the specified point in the talk.
- **Hidden reference:** interleaved where a live application, code, trace, or evaluation segment occurs. Set PowerPoint's native hidden-slide flag when authoring. These slides are for the presenter, reviewers, and reasoning about the flow. They are never projected to the audience, including during delays or fallbacks.
- **Appendix:** optional audience material for questions. These are distinct from the private hidden references.

A hidden reference should explain what happens, show the relevant code or implementation view, and explain what the observation establishes. A slide that only says “switch to code” is insufficient. Read the full sequence in PowerPoint's editing view to follow the session using the deck alone. The normal audience presentation skips the hidden references; the presenter switches to the actual screen at those points.

Hidden references represent activity already inside the scheduled blocks. They add no stage time. Conceptual explanations can be drafted now. Code excerpts, screenshots, trace details, and results must come from the actual implementation and runs; until available, identify the planned behavior and missing evidence explicitly.

For hidden references, the four questions describe the audience's understanding during the corresponding live segment. The private slide explains that segment to a reviewer; it does not become an audience screen.

## Sequence at a glance

Numbers are proposed positions in the rebuilt deck, including hidden references. Time ranges identify the existing talk block, not a separate duration allocated to each slide.

| # | Use | Time | Stage | Title / reference subject |
| --- | --- | --- | --- | --- |
| 01 | Audience | Before session | S0 | Ship Reliable AI Agents with Strands Evaluation and AgentCore Evaluations |
| 02 | Audience | 0–5 | S0 | What is an evaluation? |
| 03 | Audience | 0–5 | S0 | What can vary, and what must remain acceptable? |
| 04 | Audience | 5–11 | S0 | The application, agent, and operator |
| 05 | Audience | 5–11 | S0 | Does the recommendation actually fix the problem? |
| 06 | Hidden reference | 5–11 | S0 | Healthy application, new incident, and faulty recommendation |
| 07 | Hidden reference | 5–11 | S0 | Applying the recommendation and checking fresh requests |
| 08 | Audience | 11–15 | S0 | What did we actually establish? |
| 09 | Hidden reference | 11–15 | S0 | Initial agent code, audience testing question, and recovery |
| 10 | Audience | 15–18 | S0 | What did the agent actually do? |
| 11 | Hidden reference | 15–18 | S0 | Inspecting the matched execution in AgentCore Observability |
| 12 | Audience | 18–23 | S0 -> S1 | From failure to test case |
| 13 | Hidden reference | 18–23 | S1 | Constructing the complete reviewed case in code |
| 14 | Audience | 18–23 | S1 -> S2 | Code checks and model judgment |
| 15 | Hidden reference | 18–23 | S2 | Evaluator code, prepared dataset, and baseline launch |
| 16 | Audience | 23–28 | S2 | Would you accept this recommendation? |
| 17 | Audience | 23–28 | S2 | How do we test the judge? |
| 18 | Audience | 23–28 | S2 | What have we kept unseen? |
| 19 | Audience | 23–28 | S2 | What does repeating a run tell us? |
| 20 | Hidden reference | 28–30 | S2 | Baseline findings and their per-case evidence |
| 21 | Hidden reference | 30–31 | S2 -> S3 | Prompt repair and fresh candidate launch |
| 22 | Audience | 31–36 | S3 -> S4 | The developer experience of evals |
| 23 | Hidden reference | 31–36 | S4 | The Strands experiment in code |
| 24 | Audience | 36–39 | S4 | What evidence supports our confidence? |
| 25 | Audience | 36–39 | S4 | What does this cost to use? |
| 26 | Hidden reference | 39–40 | S4 | Candidate comparison, local release decision, and repair push |
| 27 | Audience | 40–44 | S4 -> S5 | What can reach deployment? |
| 28 | Hidden reference | 40–44 | S5 | The experiment and release policy in CI |
| 29 | Audience | 44–48 | S5 | Does the recommendation actually fix the problem? |
| 30 | Hidden reference | 44–48 | S5 | A new incident with the repaired deployed candidate |
| 31 | Hidden reference | 48–54 | S5 | Audience participant's prompt change and room prediction |
| 32 | Hidden reference | 48–54 | S5 | Genuine evaluation failure, blocked deployment, and callback |
| 33 | Audience | 54–55 | S5 | Closing |
| 34 | Audience | 55–60 | S5 | Code and resources |
| 35 | Appendix | Questions | — | A1 · Architecture and execution paths |
| 36 | Appendix | Questions | — | A2 · The complete reviewed case |
| 37 | Appendix | Questions | — | A3 · Judge selection and calibration |
| 38 | Appendix | Questions | — | A4 · Measurement and pricing basis |
| 39 | Appendix | Questions | — | A5 · Release policy and coverage |

## Slide-by-slide reasoning

Every entry answers the same four questions: what the audience already knows, the specific idea or question being established, the visible explanation or evidence, and why the next screen follows.

### 01. Ship Reliable AI Agents with Strands Evaluation and AgentCore Evaluations

**Use:** Audience.

- **What does the audience already know?** They build agents and understand prompts, models, and tools. They have not yet seen our example or our evaluation workflow.
- **What idea or question does it establish?** This session will show how to build evidence for agent changes and release decisions.
- **What makes that understandable on screen?** The approved session title and presenter details: **Guille Ojeda — Principal Innovation Architect @ Caylent**. Keep the cover simple. Ask aloud: “How would you know if your latest prompt change made your agent unsafe to ship?” Keep the question in the notes and the introduction within 0–5.
- **Why does the next screen follow?** Before the example can demonstrate anything about evaluations, slide 02 establishes a shared definition.

### 02. What is an evaluation?

**Use:** Audience.

- **What does the audience already know?** They understand agent execution, but may use “evaluation” to mean a benchmark score, a judge call, or an informal demonstration.
- **What idea or question does it establish?** An evaluation assesses observed behavior against explicit expectations for a particular task and context.
- **What makes that understandable on screen?** A small worked diagram: task and context, observed behavior, reviewed expectations, assessment. Use the illustrative task “Summarize a supplied status report without adding causes.” Keep the actual incident and its cause undisclosed.
- **Why does the next screen follow?** Once expectations are explicit, slide 03 can show why different outputs can satisfy them and why exact-output matching alone is insufficient.

### 03. What can vary, and what must remain acceptable?

**Use:** Audience.

- **What does the audience already know?** An evaluation needs a task, observed behavior, and expectations.
- **What idea or question does it establish?** Wording and valid investigation paths can vary while requirements remain stable. Deterministic checks still establish useful facts; semantic assessment handles meaning and support.
- **What makes that understandable on screen?** Continue the clearly labeled illustrative example. Supplied fact: “Error rate has recovered; root cause is unknown.” Compare “Errors recovered; the cause is unknown” with “Errors are back to normal; there is not enough information to identify a cause.” Both preserve the fact. Contrast an unsupported answer, “The database caused the outage.” Explain that structure and required fields can be checked in code. Defer the actual agent's query-path details until its trace is introduced.
- **Why does the next screen follow?** The audience now has a testing model to apply. Slide 04 introduces the concrete system without asking them to infer what the recommendation or operator does.

### 04. The application, agent, and operator

**Use:** Audience.

- **What does the audience already know?** Variable output can be assessed against explicit criteria. They do not yet know our application or the agent's authority.
- **What idea or question does it establish?** The agent investigates and recommends; the operator independently chooses and applies an action. Application behavior needs its own observation.
- **What makes that understandable on screen?** A minimal map of application, alarm, read-only investigating agent, recommendation, and operator using the Failure Controller. Show only enough application context to follow the incident. Do not reveal the table-policy Deny or the agent's investigation.
- **Why does the next screen follow?** “Recommendation” now has a concrete meaning. Slide 05 gives the demonstration a question to answer.

### 05. Does the recommendation actually fix the problem?

**Use:** Audience.

- **What does the audience already know?** They know the system roles and that a plausible answer needs evidence.
- **What idea or question does it establish?** We will judge the recommendation by what happens when the operator independently applies it and checks the application.
- **What makes that understandable on screen?** The question alone, with the application context already established. Move directly to the live controller/application; do not announce the faulty action or incident cause on this slide.
- **Why does the next screen follow?** The live opening represented by hidden references 06–07 supplies the recommendation, action readback, and later request observations needed to answer the question.

### 06. Healthy application, new incident, and faulty recommendation

**Use:** Hidden reference. **Audience screen:** Application and Failure Controller.

- **What does the audience already know?** The agent investigates read-only and the operator applies actions. They are looking for evidence that a recommendation helps.
- **What idea or question does it establish?** We have a real incident and an actual alarm-triggered recommendation to examine.
- **What makes that understandable on screen?** The reference slide explains the sequence with actual captures when available: healthy application and alarm OK, induced access-denied incident, matched alarm/run, and faulty candidate recommending increased memory on INVENTORY. Retain originating event/run identity. The private reference can explain the known fault, but the audience sees output and application status; hold the cause and trace until 11.
- **Why does the next screen follow?** A recommendation is a proposal. Continue on the controller in 07 to independently apply it and observe whether it changes application behavior.

### 07. Applying the recommendation and checking fresh requests

**Use:** Hidden reference. **Audience screen:** Failure Controller and application.

- **What does the audience already know?** The faulty candidate proposes increasing Inventory memory during the incident.
- **What idea or question does it establish?** Completing the configuration change and resolving the application incident are separate observations.
- **What makes that understandable on screen?** Show the actual selected action, memory readback, and later fresh request failures as separate evidence. Explain privately that memory does not remove the table-policy Deny; do not reveal that diagnosis to the audience yet. The action generates no traffic. Preserve the source capture before recovery; a successful action status alone does not establish recovery.
- **Why does the next screen follow?** Slide 08 returns to the observations so the audience can state what was established before inspecting the code.

### 08. What did we actually establish?

**Use:** Audience.

- **What does the audience already know?** They have seen the recommendation applied and the application continue failing.
- **What idea or question does it establish?** A convincing recommendation and a completed configuration change did not establish that the agent handled the incident acceptably. What behavior should a test require?
- **What makes that understandable on screen?** Two actual observations: “Configuration changed” beside “Fresh requests still failed.” Include the relevant readback/request excerpts once captured. Avoid revealing the cause, repeating a full dashboard, or replacing observations with a generic score.
- **Why does the next screen follow?** The audience can now inspect how the agent is built and identify what could be checked. Hidden reference 09 explains that code walkthrough and the audience testing question.

### 09. Initial agent code, audience testing question, and recovery

**Use:** Hidden reference. **Audience screen:** Code editor.

- **What does the audience already know?** The failure demonstrates an agent-quality problem, and an action's configuration result does not answer the quality question.
- **What idea or question does it establish?** The initial implementation produces a structured proposal from a prompt and four read-only tools. Which parts should be checked in code, and which need evidence-based judgment?
- **What makes that understandable on screen?** Concise actual Python excerpts for the shared agent constructor, faulty prompt, tools, and structured report. Explain logs, metrics, configuration, and change history without touring infrastructure plumbing. Ask the testing question. The reference also records recovery during the walkthrough after source capture, with baseline restoration and alarm OK verified. Keep the combined example and walkthrough within its existing ten-minute block.
- **Why does the next screen follow?** Knowing the constructor and available tools does not tell us what this execution queried or observed. Slide 10 establishes the reason to inspect its actual trace.

### 10. What did the agent actually do?

**Use:** Audience.

- **What does the audience already know?** They have seen the faulty behavior and the code that constructs the agent.
- **What idea or question does it establish?** We need to connect this report to the actual tool calls, query windows, and returned evidence.
- **What makes that understandable on screen?** The framing question, followed by the actual AgentCore Observability view. Optionally ask “Logs or configuration—which would you inspect first?” The choice changes inspection order, not recorded agent execution.
- **Why does the next screen follow?** Hidden reference 11 explains the trace inspection that supplies the evidence needed to define a case.

### 11. Inspecting the matched execution in AgentCore Observability

**Use:** Hidden reference. **Audience screen:** AgentCore Observability.

- **What does the audience already know?** The agent has several read-only evidence tools and made a recommendation that did not resolve the incident.
- **What idea or question does it establish?** The recorded investigation and source evidence let us inspect whether diagnosis and recommendation follow from what was available.
- **What makes that understandable on screen?** Actual trace excerpts with matched alarm/run identity, selected tools, time windows, relevant returned evidence, and report. Cover the denied Inventory read and relevant policy-change evidence. Prepare Logs-first and Configuration-first routes to the same explanation. Distinguish captured source coverage from the narrower set of queries the original candidate happened to make.
- **Why does the next screen follow?** We now have evidence of a failure, but a trace does not supply reviewed expectations automatically. Slide 12 introduces the human review needed to turn that material into a repeatable case.

### 12. From failure to test case

**Use:** Audience.

- **What does the audience already know?** They know what the execution did and what evidence supports the denied-read diagnosis.
- **What idea or question does it establish?** A test case combines repeatable investigation context and evidence with a reviewed definition of acceptable behavior.
- **What makes that understandable on screen?** A concrete diagram: captured execution and source evidence, human review, repeatable case. Highlight where the expectation will be supplied. Ask “What should an acceptable recommendation do here?” Take one short action/target or sentence, check it against the evidence, then reveal the normalized accepted meaning: **Restore inventory access**.
- **Why does the next screen follow?** The expectation must become usable case data. Hidden reference 13 shows the complete case being constructed in code.

### 13. Constructing the complete reviewed case in code

**Use:** Hidden reference. **Audience screen:** Case code and captured evidence.

- **What does the audience already know?** The accepted expectation is evidence-supported restoration of Inventory access.
- **What idea or question does it establish?** We can make this failure reproducible without giving the candidate the expected answer.
- **What makes that understandable on screen?** One complete actual case when implemented: alarm context, incident window, effective investigation reference time, versioned evidence references/provenance, acceptable behavior, and unacceptable behavior. Show correct Inventory table-policy restoration as the expected action/target. Keep expectations and private scenario cause outside candidate input and tools. All four captured providers use the coherent case reference time and allow the candidate to choose its own queries, with no live fallback. Normalize reviewed audience wording into prepared fields; do not execute it or use it as judge instructions.
- **Why does the next screen follow?** The case states what good means. Slide 14 explains how different assessments can recognize or reject that behavior.

### 14. Code checks and model judgment

**Use:** Audience.

- **What does the audience already know?** They have a case with reviewed expectations and the evidence supporting them.
- **What idea or question does it establish?** Recommendation correctness and evidence-supported reasoning are distinct findings. A correct service name does not make an action correct.
- **What makes that understandable on screen?** Annotate the worked faulty recommendation: INVENTORY matches the service, increasing memory fails the required action, and semantic assessment asks whether the diagnosis and proposal follow from the denied read and policy evidence. Include the actual resource/restoration target in correctness checks. A lucky correct action still needs grounding.
- **Why does the next screen follow?** Hidden reference 15 shows these criteria implemented, loads the other prepared cases, and launches the baseline evaluation before the judge explanation.

### 15. Evaluator code, prepared dataset, and baseline launch

**Use:** Hidden reference. **Audience screen:** Evaluator code, dataset, and AgentCore evaluation launch.

- **What does the audience already know?** The case and the distinct correctness/grounding requirements are explicit. The agent is still the faulty candidate.
- **What idea or question does it establish?** Those requirements can produce inspectable findings over actual executions, beyond the single manually constructed case.
- **What makes that understandable on screen?** Actual code for a recommendation check and a semantic judge criterion, the prepared evaluator configuration, and the separately prepared reviewed dataset. Show how source execution data and evaluator-only references enter AgentCore evaluation. Launch the baseline over captured actual faulty-candidate executions after case review is complete. State the actual dataset size when known; “50” is not a requirement. Judge preparation happens before the session; the upcoming audience vote does not configure it.
- **Why does the next screen follow?** The baseline operation takes time. Slide 16 lets the audience experience the judgment problem, then slides 17–19 prepare them to interpret the findings.

### 16. Would you accept this recommendation?

**Use:** Audience.

- **What does the audience already know?** They know the incident evidence and the reviewed criteria; an evaluation is running.
- **What idea or question does it establish?** Acceptability requires an evidence-based judgment that we can compare with the human reference and automated judge.
- **What makes that understandable on screen?** One actual prepared report that recommends the correct Inventory policy restoration but gives a plausible diagnosis unsupported by the evidence. Show the report and the relevant evidence excerpt together. Keep the criteria from 12–14 visible. Take a show of hands and one explanation, then reveal the reviewed verdict and actual model-judge finding. Show why the action passes its code check and why the diagnosis still needs grounding. Keep the report and findings pending until prepared.
- **Why does the next screen follow?** Agreement or disagreement raises a practical question about trusting the automated assessment. Slide 17 explains calibration. The audience response remains discussion material, with no changes to labels, rubric, holdouts, or policy.

### 17. How do we test the judge?

**Use:** Audience.

- **What does the audience already know?** They have made a judgment and compared it with a reviewed reference and judge result.
- **What idea or question does it establish?** Judge quality must be checked against independent human-reviewed examples. A false pass and a false failure have different consequences.
- **What makes that understandable on screen?** Use the exercise to compare human decisions with actual judge findings and explain false passes, false failures, and rubric ambiguity. Label unobserved teaching examples illustrative. Use one sentence for model selection: “AgentCore built-in judges have fixed models, and where you can choose a judge model separately from your agent, use the least expensive supported model that meets your quality requirements on human-reviewed examples.” Details belong in 37.
- **Why does the next screen follow?** Improving a judge against examples does not establish how it handles examples that did not guide the changes. Slide 18 introduces that distinction for both judge and agent.

### 18. What have we kept unseen?

**Use:** Audience.

- **What does the audience already know?** The judge and rubric need review, and the worked failure will inform a prompt repair.
- **What idea or question does it establish?** Judge holdout and agent holdout answer different questions; examples used to make changes cannot support an unseen-example claim.
- **What makes that understandable on screen?** A compact diagram separating judge-development examples from judge holdout, and agent-repair cases from agent holdout. Mark the worked denied-read case as development/regression data. Keep related captures and near-duplicate incident variants together when separating development from final checks. Show no invented split counts.
- **Why does the next screen follow?** Unseen examples address generalization. Slide 19 addresses the separate problem of variation across executions and judgments.

### 19. What does repeating a run tell us?

**Use:** Audience.

- **What does the audience already know?** Holdouts keep final-check examples outside tuning. A single run still provides only one observation of behavior.
- **What idea or question does it establish?** Fresh agent execution and rejudging a fixed trace measure different variation; rejudging cannot test a changed prompt.
- **What makes that understandable on screen?** Two simple flows: fresh candidate execution followed by scoring, and repeated scoring of one unchanged captured execution. Identify where agent and judge variation can enter. Use actual repeated results only when measured, with settings fixed and counts visible.
- **Why does the next screen follow?** The audience can now interpret baseline findings without treating one score as complete proof. Hidden reference 20 returns to actual results, and 21 then changes and executes the candidate.

### 20. Baseline findings and their per-case evidence

**Use:** Hidden reference. **Audience screen:** Actual baseline evaluation report.

- **What does the audience already know?** They understand the case, evaluators, and limits of judge decisions and repeated runs.
- **What idea or question does it establish?** Evaluations expose the current agent's defect; they have not repaired it.
- **What makes that understandable on screen?** Actual baseline findings tied to candidate/case/evaluator/run provenance. Show the denied-read action check failing for increased Inventory memory, the separately inspectable target finding, and actual semantic findings with evidence. Do not let an aggregate score conceal required failures or conflate evaluator-execution errors with agent-quality errors.
- **Why does the next screen follow?** A specific failed behavior gives the prompt edit a purpose. Hidden reference 21 shows the candidate change and a fresh execution, rather than jumping from a new prompt to a claim of improvement.

### 21. Prompt repair and fresh candidate launch

**Use:** Hidden reference. **Audience screen:** Prompt diff and candidate runner.

- **What does the audience already know?** The baseline fails reviewed requirements, and rescoring its existing trace cannot assess a new prompt.
- **What idea or question does it establish?** A prompt repair creates a candidate whose effectiveness must be tested under the same reviewed conditions.
- **What makes that understandable on screen?** The actual rehearsed prompt-only diff: choose an action that addresses the supported failure mechanism and handle uncertainty/recovery appropriately. Keep model, tools, permissions, report schema, cases, and criteria fixed. Execute the shared agent with captured providers and a new candidate/session identity, then collect its matching telemetry for AgentCore semantic evaluation and apply the inspectable correctness checks. Preserve the faulty candidate for comparison. No deployment occurs here.
- **Why does the next screen follow?** The changed candidate is running, with results pending. Slide 22 introduces the developer workflow that makes this edit/execute/inspect/compare loop repeatable. Keep the 30–31 block focused on the rehearsed edit and launch.

### 22. The developer experience of evals

**Use:** Audience.

- **What does the audience already know?** They have defined cases, used evaluators, found a defect, and launched a changed candidate.
- **What idea or question does it establish?** These pieces form a repeatable experiment workflow for development.
- **What makes that understandable on screen?** Ask “How do we run these same checks after the next edit?” Connect the unchanged reviewed cases and criteria to fresh candidate execution, evaluators, individual findings, and candidate comparison in Strands. Keep the pending candidate's status visible; introducing the workflow does not imply it has passed.
- **Why does the next screen follow?** Hidden reference 23 demonstrates the actual code behind the map and the developer experience it creates.

### 23. The Strands experiment in code

**Use:** Hidden reference. **Audience screen:** Python experiment code and actual report views.

- **What does the audience already know?** They understand each part of the experiment and want to see how to use it while developing.
- **What idea or question does it establish?** The shared agent construction, case loader, execution task, evaluators, report, and comparison can be connected in one local workflow.
- **What makes that understandable on screen?** Show the actual local Strands command, the matching experiment report, and one failed case with its evidence. Connect that report to the code and shared release-policy entry point. Runtime uses live sources; regression uses the coherent captured providers while preserving independent query choices. Show required case/reference mapping explicitly. Dashboard publication does not mean AgentCore performed scoring, and the S4/S5 semantic backend remains an implementation choice.
- **Why does the next screen follow?** While waiting for the candidate comparison, use 24–25 for prepared evidence, limits, and cost. As soon as the comparison is ready, switch to the actual result at 26 before continuing the cost discussion. A passing S4 local experiment must be available for the push; a diagram or S3 result alone does not establish that.

### 24. What evidence supports our confidence?

**Use:** Audience.

- **What does the audience already know?** They know what judge calibration, holdouts, repeated runs, and the experiment workflow are meant to establish.
- **What idea or question does it establish?** Our confidence must follow from actual scoped measurements and retain a concrete limitation.
- **What makes that understandable on screen?** Selected prepared evidence for judge agreement/errors and repeated-run behavior, with workload, sample/repetition counts, and configuration. Include one actual observed limitation or missed defect. Each finding should answer a question already raised, rather than becoming a catalogue of metrics. These prepared measurements are not the currently pending candidate's results.
- **Why does the next screen follow?** Evidence has a collection and iteration cost. Slide 25 explains what running this workflow means for development and CI.

### 25. What does this cost to use?

**Use:** Audience.

- **What does the audience already know?** The workflow can provide useful but bounded evidence, and obtaining it involves executions and scoring.
- **What idea or question does it establish?** Cost and feedback time depend on the measured workload, repetition, evaluator choices, and run frequency. Focused development runs and the required release suite serve different needs.
- **What makes that understandable on screen?** Measured costs for one complete experiment and one required CI run, the workload and dated pricing basis, and feedback time. Briefly identify what the bill includes. Count built-in AgentCore judge usage once; separate custom judge inference, applicable telemetry/compute/CI charges, and human preparation effort. Separate execution/scoring from ingestion waits. Keep detailed accounting in 38.
- **Why does the next screen follow?** Switch to the actual candidate comparison as soon as it is ready. Leave any remaining cost detail for the CI segment or questions. Hidden reference 26 explains the comparison and the local policy decision required before pushing.

### 26. Candidate comparison, local release decision, and repair push

**Use:** Hidden reference. **Audience screen:** Actual candidate comparison and local policy result, then repository push/deployment status.

- **What does the audience already know?** The prompt changed, the cases and criteria stayed fixed, and prepared measurements do not establish the pending candidate's outcome.
- **What idea or question does it establish?** Improvement and permission to deploy require actual candidate evidence and a passing reviewed local policy.
- **What makes that understandable on screen?** Pair the actual repaired-candidate findings: denied reads support restoring the Inventory table policy, and throttling under a reserved-concurrency cap supports increasing that Inventory cap. Compare them with the faulty candidate to show how the repair selects an action that addresses each supported mechanism. Include relevant controls. Label saved runs recorded and keep recommendation findings separate from remedy outcomes. Preserve comparable evaluator setup and artifact provenance. Show the actual passing S4 local Strands experiment and reviewed policy result bound to the candidate before pushing it.
- **Why does the next screen follow?** If the comparison is ready while the local policy result is pending, show the comparison and leave the release decision pending. If a required result is late, use only a matching actual recorded result, labeled accordingly. After the local policy passes and the repair is pushed, slide 27 explains how to automate the same release decision for future changes while deployment proceeds.

### 27. What can reach deployment?

**Use:** Audience.

- **What does the audience already know?** A local experiment and reviewed policy supported the repaired candidate's release decision.
- **What idea or question does it establish?** Release policy turns individual findings and their risks into a deployment decision; failed or incomplete required results block release.
- **What makes that understandable on screen?** Reuse the experiment map inside CI, adding the required policy before deployment. Distinguish required failures, incomplete evidence, and findings requiring review under the selected policy. Do not replace this with one generic score or invent numerical thresholds.
- **Why does the next screen follow?** Hidden reference 28 shows the actual CI configuration enforcing the policy. This gives the later audience prompt change an existing gate to test.

### 28. The experiment and release policy in CI

**Use:** Hidden reference. **Audience screen:** CI configuration and release-policy code.

- **What does the audience already know?** The experiment works locally, and release decisions depend on required behavior and complete evidence.
- **What idea or question does it establish?** CI invokes the same experiment and policy before deployment; the essential change is automatic enforcement.
- **What makes that understandable on screen?** Actual workflow/configuration excerpts showing experiment invocation, required result/policy handling, and deployment's dependency on a permitted outcome. Preserve the same reviewed cases, captured-evidence contract, and policy used locally. Explain the cost per required run and run frequency from measured evidence, without substituting a local subset for the release suite.
- **Why does the next screen follow?** Once the repaired deployment and new baseline are ready, slide 29 returns to the opening question. The gate controls release, but a live application effect still needs its own observation.

### 29. Does the recommendation actually fix the problem?

**Use:** Audience. Reuse the visual question from 05 at this later position.

- **What does the audience already know?** The repaired candidate passed the reviewed local policy, the deployment has completed, and CI enforcement has been introduced.
- **What idea or question does it establish?** We will now check the repaired deployed candidate against a newly induced instance of the opening incident.
- **What makes that understandable on screen?** The same question as 05, now identifying the repaired candidate. Do not label the live application recovered before observing it. The repeated question deliberately reconnects this demonstration with the original failure.
- **Why does the next screen follow?** Hidden reference 30 represents the new alarm/run, independent corrective action, and fresh requests that answer it.

### 30. A new incident with the repaired deployed candidate

**Use:** Hidden reference. **Audience screen:** Application and Failure Controller.

- **What does the audience already know?** Evaluation evidence supported the repaired candidate, but the live remedy has not yet been observed.
- **What idea or question does it establish?** The repaired candidate can handle this demonstrated incident appropriately, with action completion and application recovery checked independently.
- **What makes that understandable on screen?** Actual captures of the reconciled new deployment baseline and alarm OK, the same failure induced anew, its new matching alarm/run, the Restore inventory access recommendation, the operator's independent policy restoration/readback, and subsequent successful fresh requests. Keep event/run identities distinct from the opening and regression executions. Present success only when observed; this known development case does not establish unseen-incident generalization.
- **Why does the next screen follow?** One successful repair does not protect later prompt edits. Hidden reference 31 introduces another candidate through the prepared audience interaction and asks whether it should be allowed to deploy.

### 31. Audience participant's prompt change and room prediction

**Use:** Hidden reference. **Audience screen:** Actual prompt editor/diff and CI launch.

- **What does the audience already know?** The demonstrated repair works for the reviewed incident, and CI already enforces the same case and release policy.
- **What idea or question does it establish?** A later prompt change can reintroduce the defect; the existing evaluation should detect it without changing the test.
- **What makes that understandable on screen?** The prepared participant types the rehearsed memory-first regression. Show the actual diff, then ask “What happens if I push?” Take a quick prediction and push the candidate through the gate. Keep cases, evaluators, holdouts, and policy fixed. The private reference explains that the participant/edit is prepared; candidate execution and the CI decision must be genuine. If the participant is unavailable, the presenter types the same edit.
- **Why does the next screen follow?** A prediction is not evidence of enforcement. Hidden reference 32 follows the actual candidate evaluation and release decision. While pending, inspect the diff, unchanged expectation/policy, and status; optional callbacks use audience slides 12, 14, or 27, never this hidden reference.

### 32. Genuine evaluation failure, blocked deployment, and callback

**Use:** Hidden reference. **Audience screen:** Actual per-case result, CI decision, and deployed candidate identity.

- **What does the audience already know?** The prompt regressed, the reviewed expectation stayed fixed, and the gate is evaluating the changed candidate.
- **What idea or question does it establish?** The behavior the audience helped require can stop a regression before deployment.
- **What makes that understandable on screen?** The fresh regressed candidate's denied-read action check fails for the memory recommendation; show the failure reason, genuine blocked deployment, and evidence that the repaired candidate remains deployed. Distinguish this from an unrelated build error or an evaluator that failed to execute. Repeat the unchanged audience-contributed expectation: “This is the behavior you said we should require.” Use actual recorded rejection only as a clearly labeled matching fallback.
- **Why does the next screen follow?** The complete path from failure to reviewed expectation to release enforcement has now been demonstrated. Slide 33 turns it into the method attendees should retain, with its limits intact.

### 33. Closing

**Use:** Audience.

- **What does the audience already know?** They have seen an agent fail, a reviewed evaluation expose the defect, a candidate improve, and the gate reject a later regression.
- **What idea or question does it establish?** Define good behavior, check whether evaluations recognize it, and use them to improve the agent and prevent regressions. Passing evaluations provide scoped release evidence, not a guarantee that the agent can never fail.
- **What makes that understandable on screen?** The three takeaways and “Hope is not a strategy. Do evals.” Deliver the full approved speech below verbally; keep it in speaker notes rather than filling the slide.
- **Why does the next screen follow?** Slide 34 gives attendees a practical next step while questions and buffer use the final block.

Speaker notes retain the approved closing verbatim:

> Your agent is non-deterministic, but you can still test whether its behavior is acceptable. First define what good looks like. Then check whether your evaluations recognize it. Finally, use them to improve the agent and stop regressions before they ship.
>
> Evaluations passing doesn’t mean the agent can never fail. But at least your release decision now has evidence behind it.
>
> Without that evidence, you’re hoping nothing goes wrong. Hope is not a strategy. Do evals.

### 34. Code and resources

**Use:** Audience.

- **What does the audience already know?** They understand the method and have seen how it connects to the AWS example.
- **What idea or question does it establish?** They have a concrete starting point for applying and inspecting the workflow after the session.
- **What makes that understandable on screen?** QR code and link to the [repository](https://github.com/guilleojeda/evaluations-ref-arch), README status/setup/run instructions as available, and relevant evaluation documentation. Keep the entry point obvious. Do not describe unimplemented instructions or pending evidence as complete.
- **Why does the next screen follow?** Keep this slide visible for questions. Navigate to 35–39 only when they answer a question, then return here. Do not automatically continue into preserved template originals.

## Appendix reasoning

Appendix entries answer the same four questions. They are selected by the audience's question, not presented as five more sequential teaching slides.

### 35. A1 · Architecture and execution paths

**Use:** Appendix.

- **What does the audience already know?** They have seen the minimal system and local/CI experiment, and are asking where the parts actually run.
- **What idea or question does it establish?** The live alarm-driven path and captured-evidence regression path share agent construction while preserving different source and execution boundaries.
- **What makes that understandable on screen?** Verified implemented architecture when available: application, alarm-to-Lambda-to-AgentCore Runtime path, four read-only tools, source capture, local/CI captured providers, and independent controller actions/requests. Retain the explicit case reference time and no-live-fallback boundary. Label planned architecture as planned until implementation is verified.
- **Why does the next screen follow?** Return to resources at 34 once the deployment/execution question is answered. Open 36 only if the question moves to the concrete case and its evidence.

### 36. A2 · The complete reviewed case

**Use:** Appendix.

- **What does the audience already know?** They have seen the worked expectation and may want the exact case, source references, or rubric.
- **What idea or question does it establish?** Acceptable behavior is specified precisely enough to inspect, reproduce, and distinguish from superficially similar wrong recommendations.
- **What makes that understandable on screen?** A concise complete actual case with input/reference time, evidence references/provenance, expected Inventory policy restoration and correct target, unacceptable memory/concurrency actions, deterministic checks, and semantic diagnosis/grounding rubric. Show the candidate/evaluator input boundary. Reference the source bundle rather than cramming raw telemetry onto the slide; identify missing capture/serialization explicitly until prepared.
- **Why does the next screen follow?** Return to 34 when the case question is answered. Use 37 for judge reliability or 39 for how this case affects release.

### 37. A3 · Judge selection and calibration

**Use:** Appendix.

- **What does the audience already know?** They understand the judge's role and are asking about supported model choices, configuration, or calibration evidence.
- **What idea or question does it establish?** Judge selection is conditional on reviewed quality needs, and judge/model/rubric changes affect the measurement used to compare agents.
- **What makes that understandable on screen?** Actual supported evaluator/model configuration, rubric/settings, human-reviewed examples, disagreements, false-pass/false-failure analysis, and separate judge-holdout findings when available. Distinguish fixed AgentCore built-ins from configurable custom/Strands options. Keep selected settings fixed for candidate comparisons and recheck calibration after changes. Use source references maintained in evaluations.md; final selections and findings remain pending until established.
- **Why does the next screen follow?** Return to 34 after the judge question. Use 38 if the question becomes cost, workload, or latency rather than judge quality.

### 38. A4 · Measurement and pricing basis

**Use:** Appendix.

- **What does the audience already know?** They have seen prepared findings and experiment/CI costs and want to know what the numbers include.
- **What idea or question does it establish?** Every measurement has an identified workload, configuration, scope, and accounting basis.
- **What makes that understandable on screen?** Actual case/candidate/repetition counts, retries, versions, agent/judge usage, sample details, region/provider, pricing date, included charges, and latency components. Built-in AgentCore judge usage is counted once; custom inference and applicable CloudWatch, Lambda, and CI costs are separate. Report human preparation effort separately. Explain recurring cost using measured per-run cost and frequency; label estimates and cite dated pricing.
- **Why does the next screen follow?** Return to 34 once the quantitative question is answered. Use 39 if the follow-up concerns what the measurements justify releasing.

### 39. A5 · Release policy and coverage

**Use:** Appendix.

- **What does the audience already know?** They saw a regression blocked and want to know which findings block, which require review, and what remains outside the evidence.
- **What idea or question does it establish?** Release permission depends on required behavior and complete evidence for the selected scope; passing does not establish every production behavior.
- **What makes that understandable on screen?** Actual reviewed policy and required suite, hard correctness/operator-boundary failures, warning/review rules, incomplete-result handling, and coverage gaps. Show the two incident families and relevant recovery/insufficient-evidence controls: denied reads require policy restoration, capacity overload requires an evidence-supported Inventory cap increase, and appropriate Other responses can express recovery or uncertainty. A stale alert is a temporal control, not a third injected fault. Keep unselected thresholds and policy details marked pending.
- **Why does the next screen follow?** Return to 34 for the repository entry point and remaining questions. If a concrete finding needs inspection, open its actual evidence or the matching case in 36 rather than broadening the release claim.

## Operation waits and continuity

Expected waits are operation durations and may extend beyond the block that starts them. Hidden references document those operations; they are not waiting slides.

| Operation | Starts in reference | Expected wait |
| --- | --- | --- |
| Opening alarm and agent report | 06 | About 2–3 min |
| Opening configuration action | 07 | About 1 min |
| Opening telemetry ingestion for later trace inspection | 06–07 | 2–5 min |
| Application recovery during code walkthrough | 09 | About 1–2 min |
| Baseline evaluation | 15 | About 5 min |
| Changed-candidate execution and evaluation, including telemetry | 21 | About 8 min |
| Repair deployment after local policy passes | 26 | About 4 min |
| New alarm and repaired-agent report | 30 | About 2–3 min |
| Corrective action in the new incident | 30 | About 1 min |
| Regression CI evaluation | 31 | About 5 min |

The telemetry ingestion range is documented by AWS in the [on-demand prerequisites](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/ondemand-evaluations-prereqs.html). Other durations remain provisional rehearsal estimates.

Use 16–19 during the baseline operation, 22–25 during the changed-candidate operation, and 27 plus actual CI code during deployment. Show the candidate comparison as soon as it is ready and defer remaining cost detail to the CI segment or questions. During regression evaluation, inspect the actual diff, unchanged case/policy, and status; revisit audience case/policy slides if useful. The teaching sequence prepares the audience for the next result, and adds no audience waiting or countdown slide.

If an operation runs late, use an actual matching recorded execution or result with recorded status and provenance visible. Hidden references are explanatory material for private review, never an audience fallback. Preserve the recorded fallback paths for opening failure, trace inspection, baseline findings, repaired-candidate results, repaired live incident, and CI rejection. Rehearse the repaired incident and CI switches to protect the rejection callback and closing. Leave any unfinished live result pending.

## Evidence and authoring dependencies

Conceptual diagrams and explicitly illustrative teaching examples can be authored from the approved contracts. They must not masquerade as captured executions or measured results.

Actual code, reports, traces, screenshots, judge decisions, calibration findings, costs, workload/repetition counts, limitations, and recorded fallbacks depend on the prepared implementation and runs. Do not invent trace IDs, evidence excerpts, dataset splits, budgets, model selections, scores, thresholds, or service durations. Retain source, candidate/artifact, case, evidence, evaluator, model, and run provenance. Until the evidence exists, describe the planned demonstration and its pending status so the review deck remains honest and understandable.

Two flow details need particular care when preparing the actual artifacts:

- **Judge exercise:** the audience already knows the case criteria from 12–14. Withhold the prepared verdict and judge finding at 16, not the expectation they helped define.
- **Local release evidence:** 26 needs an actual passing S4 Strands experiment and reviewed policy result for the candidate being pushed. The S3 operation at 21 and a walkthrough at 23 do not establish that by themselves. Rehearse how that result is available within the existing schedule; use a matching actual recorded S4 run, visibly labeled, if needed. No additional S4 wait has been measured or assumed.

Speaker notes identify actual screen changes, code edits, audience prompts, background operations, expected waits, and recovery cues. The hidden references make those otherwise slide-free segments understandable when following the deck alone; detailed operating steps remain in the demo cue sheet.
