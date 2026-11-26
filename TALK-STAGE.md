# Talk stages

Open any of the six checkpoints below to see the code at that point in the talk. The frozen READMEs describe an earlier plan in which the release gate was still future work and are reference-only; do not treat frozen-tag code or results as current dataset, roster, or gate proof. In the current talk, S4 runs the development experiment and S5 checks the ZIP proposed for release.

| Stage | Public source | Purpose |
| --- | --- | --- |
| S0 | [talk/v5/S0](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S0) | Inspect the instrumented faulty agent. |
| S1 | [talk/v5/S1](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S1) | Review and freeze the incident case. |
| S2 | [talk/v5/S2](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S2) | Run deterministic checks against the recorded denial execution. |
| S3 | [talk/v5/S3](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S3) | Inspect and run the captured prompt repair. |
| S4 | [talk/v5/S4](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S4) | Run the native Strands development experiment. |
| S5 | [frozen talk/v5/S5](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S5) | Inspect the CI gate that checks the proposed release. |

For a performance, the S0-S4 workspaces start at the commits in the
[checkpoint map](talk/checkpoints.json). S5 is editable on `demo-deploy`. Its
starting commit must match the repaired package approved for that performance;
the frozen S5 tag and current qualified package can legitimately differ.

The presenter prepares the private cases, recordings and credentials separately. To set up another performance, [check the tags and the current release](docs/checkpoints.md).
