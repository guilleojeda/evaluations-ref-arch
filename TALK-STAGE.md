# Talk stages

This repository publishes six source checkpoints for the incident response talk.
The active generation is `talk/v5`; its map records the six annotated tags and
peeled commits in [talk/checkpoints.json](talk/checkpoints.json). These public
links are read-only source references from maintained `main`. Private session
inputs, captures, evaluations and credentials are prepared separately.

| Stage | Public source | Purpose |
| --- | --- | --- |
| S0 | [talk/v5/S0](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S0) | Inspect the instrumented faulty agent. |
| S1 | [talk/v5/S1](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S1) | Review and freeze the incident case. |
| S2 | [talk/v5/S2](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S2) | Run deterministic checks against the recorded denial execution. |
| S3 | [talk/v5/S3](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S3) | Inspect and run the captured prompt repair. |
| S4 | [talk/v5/S4](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S4) | Run the native Strands development experiment. |
| S5 | [frozen talk/v5/S5](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S5); [dated verified demo-deploy example at `52dbc79`](https://github.com/guilleojeda/evaluations-ref-arch/commit/52dbc79ea249b92c43490390a769f73a035fcdae) | Compare the frozen source checkpoint with the separately qualified repaired serving source. |

S0-S4 start at their mapped tag commits. S5 has two deliberate identities:

- The frozen `talk/v5/S5` tag is the public source checkpoint at commit
  `ee87d88276bad79647eafc48d43f681c5b99f846`.
- A dated verified example bound the repaired package separately to `demo-deploy`
  at commit `52dbc79ea249b92c43490390a769f73a035fcdae` on 2026-11-25.

The qualified serving source can be newer than the frozen S5 tag. A source
checkpoint does not prove a live qualification, and a live qualification does
not move or replace the frozen tag. The private per-performance readback is the
authority for the current qualification; the `52dbc79` link is a dated verified
example, not a permanent branch guarantee. Use the [checkpoint workflow](docs/checkpoints.md)
for provenance, preparation and verification. Any live rehearsal or regression
is an operator-owned activity covered by private session instructions; this
public page remains a read-only guide from `main`.
