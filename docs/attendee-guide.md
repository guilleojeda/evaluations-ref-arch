# Follow the Inventory denial from incident to CI

[Audience slides (PDF, 14 pages)](slides/audience.pdf) | [Stage checkpoints](checkpoints.md) | [Audience questions](questions.md)

A customer tries to place an order. Checkout returns HTTP 502. The operations agent finds the denied Inventory read and recommends increasing memory. The presenter switches Inventory to 512 MB and tries one fresh checkout. It still returns 502. The larger function runs with the same denied permission.

**Did the agent miss the clue, or did it see the clue and still recommend the wrong fix?** Open the investigation trace. Its log query returned the DynamoDB `GetItem` denial. That gives us a requirement we can test on the next prompt edit.

> When the evidence shows an ongoing Inventory read denial, recommend restoring access to the healthy Inventory version identified in that evidence.

## How the requirement becomes a test

| Stage | What happens | Code you can open |
| --- | --- | --- |
| S0 | A CloudWatch alarm starts the agent. Its trace records the queries, results and report. A presenter applies the proposed change and observes checkout separately. | [Agent and read tools](https://github.com/guilleojeda/evaluations-ref-arch/tree/7d559ffcb9a9224458f52bceab33b5bb0b45c417/agent) |
| S1 | Reviewers capture the evidence available by the investigation cutoff and record acceptable behavior. The candidate gets the task and can query the evidence. The expected remedy stays with the evaluator. | [Reviewed case and candidate input](https://github.com/guilleojeda/evaluations-ref-arch/blob/2db0797ed6c51f79aa66679b460b6f47e98e79fa/agent/reviewed_cases.py) |
| S2 | Score the faulty report. Picking Inventory is correct. Choosing a memory increase fails the action check. A separate AgentCore verdict assesses whether the diagnosis and factual claims are supported. | [Required checks](https://github.com/guilleojeda/evaluations-ref-arch/blob/53167e225b87fe1993ee45c657ad40a00b59a403/agent/deterministic_checks.py) and [judge rubric](https://github.com/guilleojeda/evaluations-ref-arch/blob/53167e225b87fe1993ee45c657ad40a00b59a403/agent/agentcore_evaluation.py) |
| S3 | Edit the prompt in the IDE and run a fresh investigation against the same captured incident. Compare the recommended action with the faulty run while keeping the expected answer fixed. | [Development prompt](https://github.com/guilleojeda/evaluations-ref-arch/blob/9fc1a230c5d40252c54111f1045d8ab85c96be6b/agent/prompt.py) |
| S4 | Read the denial row first in the native Strands experiment. Inspect the proposed remedy and check whether the same edit still handles throttling, where a capacity increase can be appropriate. | [Strands experiment](https://github.com/guilleojeda/evaluations-ref-arch/blob/1f67f305104e9d9c74a7919cf0f968622d1d0c01/agent/development_experiment.py) |
| S5 | A participant pushes the memory-first prompt to the release branch. CI runs the candidate package against the reviewed suite. Which check will stop the push from reaching the repaired endpoint? | [Release decision](https://github.com/guilleojeda/evaluations-ref-arch/blob/ee87d88276bad79647eafc48d43f681c5b99f846/agent/release_gate.py) |

The IDE run gives feedback on the short development edit. During the talk, the controller switches the next alarm to a previously published repaired agent. That agent has its own prompt and qualified ZIP. Publishing a new repaired version requires the exact candidate ZIP to pass the required checks, complete the advisory evaluation, and receive human approval.

## The rejected push

In rehearsal run **45315435813**, the participant's regression recommended **Increase memory, Inventory, 512 MB** on both denial cases. Here is the result for the audience-authored denial case, transcribed from that run.

| Check | Result | What it means |
| --- | --- | --- |
| `target` | Pass | The report identified Inventory. |
| `action` | Fail | The case requires restoring access. |
| `target_value` | Fail | A 512 MB allocation does not identify the healthy version to restore. This check evaluates the action, target, value and unit together. |
| Semantic quality, advisory | Pass | The judge accepted the diagnosis and grounding. Recommendation correctness has its own required check. |

The qualification job rejected the ZIP, and GitHub skipped protected publication. The previously qualified repaired endpoint continued serving. You can inspect the public run without access to the private case archive. [Regression commit](https://github.com/guilleojeda/evaluations-ref-arch/commit/e534e8bfe8fcd52104ec2430226eb67731d898c0) and [GitHub Actions run](https://github.com/guilleojeda/evaluations-ref-arch/actions/runs/45315435813)

To reproduce those two failed checks yourself, change the saved report in the public synthetic case. Its two Inventory versions have the same memory and different read permissions. [Run the local case](../README.md#try-a-regression) or [run it with Strands](adapt-evaluations.md).
