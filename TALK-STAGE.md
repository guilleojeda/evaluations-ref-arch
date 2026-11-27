# Talk stages

Open any of the six checkpoints below to inspect a capability boundary. These
are historical/reference source checkpoints, not the onstage sequence. The
current delivery path is one direct native Case from `denial-case.json` with
matching final chat input provenance in `original-trace.json`, one dedicated
hosted full investigation, and one same-case CI gate. The presenter authors the
expected recommendation and prompt repair; the audience watches, and the
participant performs the ordinary push (the presenter takes over only if
unavailable). The frozen READMEs and tags must not
be treated as current dataset, roster, or gate proof.

| Stage | Public source | Purpose |
| --- | --- | --- |
| S0 | [talk/v5/S0](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S0) | Inspect the instrumented faulty agent. |
| S1 | [talk/v5/S1](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S1) | Historical capability: review a case and author its expectation. |
| S2 | [talk/v5/S2](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S2) | Historical capability: score the recorded denial execution. |
| S3 | [talk/v5/S3](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S3) | Historical capability: inspect a prompt repair. |
| S4 | [talk/v5/S4](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S4) | Independent development experiment; not the live cue. |
| S5 | [frozen talk/v5/S5](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S5) | Reference CI gate; the current gate uses the saved Case/trace. |

For a performance, the S0-S4 workspaces start at the commits in the
[checkpoint map](talk/checkpoints.json). S5 is editable on `demo-deploy`. Its
starting commit must match the repaired package approved for that performance;
the frozen S5 tag and current qualified package can legitimately differ.

The presenter prepares the private cases, recordings and credentials separately. To set up another performance, [check the tags and the current release](docs/checkpoints.md).
